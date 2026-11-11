/**
 * 构建清单与包内容一致性核对（W29-01）。
 *
 * 背景（已核实证据）：桌面快捷方式启动的是 release\WS63BurnPro.exe（包内 1.1.1，
 * ws63flash.js 无 FrameParser），而 10-24 修复后的 1.1.2 只存在于
 * app\dist-electron-release\win-unpacked。也就是说“已经打包”≠“用户在用新版”。
 *
 * 本模块提供三件可独立单测的事：
 *   1. computeManifest()       —— 对源码树计算确定性的清单（版本 + 每个关键文件摘要 + 汇总摘要）
 *   2. collectFromAsar()       —— 从 app.asar 里读出同名文件的摘要（用 @electron/asar）
 *   3. compareTarget()         —— 清单 vs 目标包，逐项报告缺失/不一致/版本不符
 *
 * 刻意不 import electron，也不启动任何进程。
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

/** 清单里必须逐字节核对的文件（源码与包内必须一致）。 */
export const MANIFEST_FILE_PATTERNS = Object.freeze([
  "package.json",
  "electron/**/*.js",
  "electron/**/*.cjs",
  "electron/**/*.json",
  "dist/**/*",
]);

export const EXCLUDED_FROM_MANIFEST = Object.freeze([
  "dist/build-manifest.json",
  "electron/build-manifest.json",
]);

function toPosix(p) {
  return String(p).split(path.sep).join("/");
}

function walk(root, dir = "", out = []) {
  const abs = path.join(root, dir);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = dir ? path.join(dir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(root, rel, out);
    } else if (entry.isFile()) {
      out.push(toPosix(rel));
    }
  }
  return out;
}

function matchesPattern(rel, pattern) {
  // 极简 glob：支持 ** 与 *，足以覆盖本项目固定的目录结构
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(`^${escaped}$`).test(rel);
}

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * electron-builder 会**重写** asar 内的 package.json：裁掉 `scripts` / `build` /
 * `devDependencies` 等构建期字段，只留运行时需要的部分。
 * 因此 package.json 不能用“逐字节相等”判定，只能用**语义投影**比较：
 * 字段集合固定、依赖按键排序，保证同一语义得到同一指纹。
 */
export const PACKAGE_JSON_FIELDS = Object.freeze([
  "name",
  "version",
  "description",
  "main",
  "type",
  "dependencies",
  "optionalDependencies",
]);

export function packageFingerprint(input) {
  let pkg;
  if (Buffer.isBuffer(input)) {
    try {
      pkg = JSON.parse(input.toString("utf8"));
    } catch {
      return "";
    }
  } else {
    pkg = input;
  }
  if (!pkg || typeof pkg !== "object") return "";
  const proj = {};
  for (const key of PACKAGE_JSON_FIELDS) {
    if (pkg[key] === undefined) continue;
    const value = pkg[key];
    proj[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]))
        : value;
  }
  return sha256(Buffer.from(JSON.stringify(proj), "utf8"));
}

/**
 * 对源码树计算确定性清单。
 * @param {{root: string, version: string, product?: string, builtAt?: string, patterns?: string[]}} opts
 */
export function computeManifest(opts) {
  const root = opts.root;
  const patterns = opts.patterns ?? MANIFEST_FILE_PATTERNS;
  const all = walk(root).filter((rel) => !EXCLUDED_FROM_MANIFEST.includes(rel));
  const files = {};
  for (const rel of [...all].sort()) {
    if (!patterns.some((p) => matchesPattern(rel, p))) continue;
    const abs = path.join(root, rel);
    files[rel] = sha256(fs.readFileSync(abs));
  }
  const sortedKeys = Object.keys(files).sort();
  const digestInput = sortedKeys.map((k) => `${k}:${files[k]}`).join("\n");
  let pkgFingerprint = "";
  try {
    pkgFingerprint = packageFingerprint(fs.readFileSync(path.join(root, "package.json")));
  } catch {
    pkgFingerprint = "";
  }
  return {
    schema: 1,
    product: opts.product ?? "WS63BurnPro",
    version: opts.version,
    builtAt: opts.builtAt ?? new Date().toISOString(),
    fileCount: sortedKeys.length,
    sourceDigest: sha256(Buffer.from(digestInput, "utf8")),
    packageFingerprint: pkgFingerprint,
    files,
  };
}

/**
 * 从 asar 收集文件摘要。asar 条目键使用反斜杠前缀（\electron\main.js）。
 * @param {string} asarPath
 * @param {{listPackage: Function, extractFile: Function}} asarImpl
 * @param {{only?: string[]}} [opts]
 */
export function collectFromAsar(asarPath, asarImpl, opts = {}) {
  const entries = new Set(
    asarImpl.listPackage(asarPath).map((name) => toPosix(String(name).replace(/^[\\/]+/, ""))),
  );
  const wanted = opts.only ?? [...entries].filter((rel) => !EXCLUDED_FROM_MANIFEST.includes(rel));
  const files = {};
  const fingerprints = {};
  const missing = [];
  for (const rel of wanted) {
    if (!entries.has(rel)) {
      missing.push(rel);
      continue;
    }
    try {
      const buf = asarImpl.extractFile(asarPath, rel.replace(/\//g, path.sep));
      files[rel] = sha256(buf);
      if (rel === "package.json") fingerprints[rel] = packageFingerprint(buf);
    } catch {
      missing.push(rel);
    }
  }
  return { files, fingerprints, missing, entryCount: entries.size };
}

/** 从解包目录收集文件摘要（win-unpacked/resources/app.asar.unpacked 之外的源码用 asar）。 */
export function collectFromDir(dir, only) {
  const files = {};
  const missing = [];
  for (const rel of only) {
    const abs = path.join(dir, rel.split("/").join(path.sep));
    try {
      if (!fs.existsSync(abs)) {
        missing.push(rel);
        continue;
      }
      files[rel] = sha256(fs.readFileSync(abs));
    } catch {
      missing.push(rel);
    }
  }
  return { files, missing, entryCount: only.length };
}

/**
 * 对比清单与目标包。
 * @param {{files: Record<string,string>}} manifest
 * @param {{files: Record<string,string>, missing: string[]}} collected
 * @param {{label?: string, packageVersion?: string}} [meta]
 */
export function compareTarget(manifest, collected, meta = {}) {
  const problems = [];
  const changed = [];
  const missing = [];
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const actual = collected.files[rel];
    if (actual === undefined) {
      missing.push(rel);
      continue;
    }
    if (rel === "package.json") {
      // electron-builder 重写 package.json（裁掉 build/scripts/devDependencies），
      // 逐字节比较必然不等；这里比较语义指纹。
      const expectedFp = manifest.packageFingerprint ?? "";
      const actualFp = collected.fingerprints?.[rel] ?? packageFingerprint(rel);
      if (expectedFp && actualFp !== expectedFp) changed.push(rel);
      continue;
    }
    if (actual !== expected) changed.push(rel);
  }
  if (missing.length) problems.push(`缺少 ${missing.length} 个文件（如 ${missing.slice(0, 3).join(", ")}）`);
  if (changed.length) {
    const note = changed.includes("package.json") ? "（package.json 按语义指纹比较）" : "";
    problems.push(
      `${changed.length} 个文件内容不一致（如 ${changed.slice(0, 3).join(", ")}）${note}`,
    );
  }
  if (meta.packageVersion && meta.packageVersion !== manifest.version) {
    problems.push(`包内版本 ${meta.packageVersion} ≠ 清单版本 ${manifest.version}`);
  }
  return {
    label: meta.label ?? "",
    packageVersion: meta.packageVersion ?? "",
    ok: problems.length === 0,
    problems,
    missing,
    changed,
    checkedCount: Object.keys(manifest.files).length,
  };
}

/** 从 asar 里读 package.json 的版本（不依赖清单）。 */
export function readAsarPackageVersion(asarPath, asarImpl) {
  try {
    const buf = asarImpl.extractFile(asarPath, `package.json`);
    const pkg = JSON.parse(buf.toString("utf8"));
    return String(pkg.version ?? "");
  } catch {
    return "";
  }
}
