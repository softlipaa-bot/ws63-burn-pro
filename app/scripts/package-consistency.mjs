#!/usr/bin/env node
/**
 * 发布一致性核对（W29-01 / R7）。
 *
 * 核对“桌面入口 / 目录版 / 便携版”到底跑的是不是同一个包：
 *   - 每个目标读 app.asar 的 package.json 版本；
 *   - 每个目标与 build-manifest.json 逐文件核对摘要；
 *   - 目标之间互相核对版本 + asar 自身摘要；
 *   - **便携版离线展开核对**：用项目自带的 7zip 取出 `resources/app.asar` 再比对
 *     （Codex 已证实自解压 EXE 可离线展开；旧实现的“无法展开”注释不成立）。
 *
 * R7 修的两个假阳性：
 *   1. `reports.every(...)` 在空数组上为 true → 现在**至少要有一个目标**，否则用法错误退出；
 *   2. 指定的便携版缺失/展开失败不进入失败条件 → 现在必须失败。
 * 另外显式报告覆盖范围：`fullReleaseVerified` 只在“目标全部通过 **且** 便携版也已核对”时为真，
 * 避免把“部分目标已核对”说成“全部产物一致”。
 *
 * 用法：
 *   node scripts/package-consistency.mjs \
 *     --target "release=../release" \
 *     --target "dist=dist-electron-release/win-unpacked" \
 *     --portable "../WS63BurnPro-Portable.exe" \
 *     [--manifest dist/build-manifest.json] [--json] [--keep-extract]
 *
 * 退出码：0 已核对项全部一致；1 发现不一致/缺失；2 用法或环境错误。
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

import asar from "@electron/asar";

import {
  collectFromAsar,
  compareTarget,
  readAsarPackageVersion,
  sha256,
} from "./lib/manifest.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `用法: node scripts/package-consistency.mjs --target "label=path" [--target ...] [--portable <exe>]
  至少需要一个 --target 或 --portable；只给部分目标时结论会标注“部分目标已核对”。`;

function collectArgs() {
  const targets = [];
  const out = {
    targets,
    portable: null,
    manifest: path.join(appRoot, "dist", "build-manifest.json"),
    json: false,
    keepExtract: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a === "--keep-extract") {
      out.keepExtract = true;
      continue;
    }
    const m = /^--(target|portable|manifest)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const value = m[2] ?? argv[++i] ?? "";
    if (m[1] === "target") {
      const eq = value.indexOf("=");
      if (eq < 0) targets.push({ label: value, path: value });
      else targets.push({ label: value.slice(0, eq), path: value.slice(eq + 1) });
    } else if (m[1] === "portable") out.portable = value;
    else out.manifest = value;
  }
  return out;
}

function resolveAsarPath(p) {
  if (!p) return { asarPath: "", error: "路径为空" };
  const abs = path.resolve(appRoot, p);
  if (abs.toLowerCase().endsWith(".asar")) {
    if (!fs.existsSync(abs)) return { asarPath: "", error: `不存在 ${abs}` };
    return { asarPath: abs, error: "" };
  }
  const candidate = path.join(abs, "resources", "app.asar");
  if (!fs.existsSync(candidate)) return { asarPath: "", error: `未找到 ${candidate}` };
  return { asarPath: candidate, error: "" };
}

function find7za() {
  const candidates = [
    path.join(appRoot, "node_modules", "7zip-bin", "win", "x64", "7za.exe"),
    path.join(appRoot, "node_modules", "7zip-bin", "win", "ia32", "7za.exe"),
    path.join(appRoot, "node_modules", "7zip-bin", "linux", "x64", "7za"),
    path.join(appRoot, "node_modules", "7zip-bin", "mac", "7za"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "7za"; // 交给 PATH；找不到就是环境错误，必须显式失败
}

/**
 * 离线展开便携版 EXE，取出 resources/app.asar。
 * @returns {{ok: boolean, asarPath?: string, error?: string, extractDir?: string}}
 */
function extractPortableAsar(exePath) {
  const sevenZip = find7za();
  if (sevenZip !== "7za" && !fs.existsSync(sevenZip)) {
    return { ok: false, error: `找不到 7zip：${sevenZip}` };
  }
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws63-portable-"));
  const res = spawnSync(
    sevenZip,
    ["x", "-y", `-o${extractDir}`, exePath, "resources/app.asar"],
    { encoding: "utf8" },
  );
  if (res.error) {
    return { ok: false, error: `展开失败：${res.error.message}`, extractDir };
  }
  const extracted = path.join(extractDir, "resources", "app.asar");
  if (!fs.existsSync(extracted)) {
    return {
      ok: false,
      error: `展开后未找到 resources/app.asar（7zip exit=${res.status}）`,
      extractDir,
    };
  }
  return { ok: true, asarPath: extracted, extractDir };
}

function verifyAsar({ label, asarPath, manifest }) {
  const collected = collectFromAsar(asarPath, asar, { only: Object.keys(manifest.files) });
  const packageVersion = readAsarPackageVersion(asarPath, asar);
  const cmp = compareTarget(manifest, collected, { label, packageVersion });
  return {
    ...cmp,
    asarPath,
    asarSha256: sha256(fs.readFileSync(asarPath)),
    asarBytes: fs.statSync(asarPath).size,
    manifestMismatchCount: collected.missing.length + cmp.changed.length,
  };
}

function main() {
  const args = collectArgs();

  if (!args.targets.length && !args.portable) {
    console.error(USAGE);
    process.exitCode = 2;
    return null;
  }
  if (!fs.existsSync(args.manifest)) {
    console.error(`[consistency] 缺少清单 ${args.manifest}（先运行 node scripts/build-manifest.mjs）`);
    process.exitCode = 2;
    return null;
  }
  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));

  const reports = [];
  for (const target of args.targets) {
    const { asarPath, error } = resolveAsarPath(target.path);
    if (error) {
      reports.push({ label: target.label, path: target.path, ok: false, problems: [error], asarPath: "" });
      continue;
    }
    reports.push({ path: target.path, ...verifyAsar({ label: target.label, asarPath, manifest }) });
  }

  // ---- 便携版：离线展开后与清单逐文件核对（不再只是“记录摘要”）
  let portable = null;
  let portableExtractDir = "";
  if (args.portable) {
    const abs = path.resolve(appRoot, args.portable);
    if (!fs.existsSync(abs)) {
      portable = { path: abs, ok: false, missing: true, problems: [`便携版不存在：${abs}`] };
    } else {
      const extracted = extractPortableAsar(abs);
      portableExtractDir = extracted.extractDir ?? "";
      if (!extracted.ok) {
        portable = {
          path: abs,
          ok: false,
          bytes: fs.statSync(abs).size,
          sha256: sha256(fs.readFileSync(abs)),
          problems: [extracted.error ?? "便携版展开失败"],
        };
      } else {
        const verified = verifyAsar({ label: "portable", asarPath: extracted.asarPath, manifest });
        portable = {
          ...verified,
          path: abs,
          bytes: fs.statSync(abs).size,
          sha256: sha256(fs.readFileSync(abs)),
          contentChecked: true,
          note: "已用 7zip 离线展开 resources/app.asar 并与清单逐文件核对",
        };
      }
    }
    if (!args.keepExtract && portableExtractDir) {
      try {
        fs.rmSync(portableExtractDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  // ---- 目标之间互相核对
  const comparable = reports.filter((r) => r.asarSha256);
  if (portable?.asarSha256) comparable.push({ label: "portable", ...portable });
  const crossProblems = [];
  if (comparable.length > 1) {
    const versions = new Set(comparable.map((r) => r.packageVersion));
    if (versions.size > 1) {
      crossProblems.push(
        `目标之间版本不一致：${comparable.map((r) => `${r.label}=${r.packageVersion}`).join(", ")}`,
      );
    }
    const digests = new Set(comparable.map((r) => r.asarSha256));
    if (digests.size > 1) {
      crossProblems.push(`目标之间 app.asar 摘要不一致（${digests.size} 种），说明跑的不是同一个包`);
    }
  }

  const targetsOk = reports.length > 0 && reports.every((r) => r.ok);
  const portableOk = portable ? portable.ok === true : false;
  const allProvidedOk = targetsOk && (portable ? portableOk : true) && crossProblems.length === 0;
  const fullReleaseVerified = reports.length > 0 && portableOk && crossProblems.length === 0 && targetsOk;

  const summary = {
    manifest: {
      path: args.manifest,
      version: manifest.version,
      sourceDigest: manifest.sourceDigest,
      fileCount: manifest.fileCount,
    },
    targetsChecked: reports.length,
    portableChecked: Boolean(portable?.contentChecked),
    targets: reports,
    portable,
    crossTarget: { ok: crossProblems.length === 0, problems: crossProblems },
    /** 已要求的项是否全部通过 */
    ok: allProvidedOk,
    /** 是否“全部产物（目录版 + 桌面入口 + 便携版）都核对过且一致” */
    fullReleaseVerified,
    coverage: fullReleaseVerified ? "all" : "partial",
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `清单 ${manifest.version} (${manifest.fileCount} 文件, ${manifest.sourceDigest.slice(0, 16)}…)`,
    );
    console.log(`已核对目标数：${reports.length}${portable ? " + 便携版" : "（未提供便携版）"}`);
    for (const r of reports) {
      const status = r.ok ? "OK  " : "FAIL";
      console.log(
        `[${status}] ${r.label}: 版本=${r.packageVersion || "?"} asar=${(r.asarSha256 || "").slice(0, 16)}…`,
      );
      for (const p of r.problems ?? []) console.log(`       - ${p}`);
    }
    if (portable) {
      const status = portable.ok ? "OK  " : "FAIL";
      console.log(
        portable.missing
          ? `[FAIL] portable: ${portable.problems?.[0]}`
          : `[${status}] portable: 版本=${portable.packageVersion || "?"} asar=${(portable.asarSha256 || "").slice(0, 16)}… ${portable.bytes} 字节`,
      );
      for (const p of portable.problems ?? []) console.log(`       - ${p}`);
      if (portable.note) console.log(`       ${portable.note}`);
    }
    console.log(summary.crossTarget.ok ? "[OK  ] 目标之间一致" : "[FAIL] 目标之间不一致：");
    for (const p of crossProblems) console.log(`       - ${p}`);
    if (fullReleaseVerified) {
      console.log("结论：全部产物（目标 + 便携版）一致");
    } else if (allProvidedOk) {
      console.log("结论：已核对项一致，但覆盖不完整（部分目标已核对，不能当作全部产物一致）");
    } else {
      console.log("结论：发布不一致或有缺失，不允许声称用户已用上新版");
    }
  }

  if (!summary.ok) process.exitCode = 1;
  return summary;
}

const result = main();
export default result;
