#!/usr/bin/env node
/**
 * 生成 build-manifest.json（W29-01）。
 *
 * 用途：在 `vite build` 之后、`electron-builder` 之前运行，把“这次构建用的源码摘要”
 * 固化进 dist/，随 `dist/**` 进入 app.asar。运行时 build-info.js 读它，
 * 发布校验脚本用它逐字节核对包内容。
 *
 * 用法：
 *   node scripts/build-manifest.mjs                       # 写到 dist/build-manifest.json
 *   node scripts/build-manifest.mjs --out <file>          # 指定输出
 *   node scripts/build-manifest.mjs --check               # 只校验现有清单是否与源码一致
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { computeManifest, MANIFEST_FILE_PATTERNS } from "./lib/manifest.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
const outPath = String(arg("out", path.join(appRoot, "dist", "build-manifest.json")));
const checkOnly = Boolean(arg("check", false));

const manifest = computeManifest({
  root: appRoot,
  version: pkg.version,
  product: pkg.build?.productName ?? pkg.name,
  patterns: MANIFEST_FILE_PATTERNS,
});

// 关键模块摘要单独抽出来，UI/诊断可以直接展示，避免前端自己解析整表
manifest.criticalModules = Object.entries(manifest.files)
  .filter(([rel]) => rel.startsWith("electron/") || rel === "package.json")
  .map(([rel, sha]) => ({ path: rel, sha256: sha }));

if (checkOnly) {
  if (!fs.existsSync(outPath)) {
    console.error(`[manifest] 缺少 ${outPath}`);
    process.exitCode = 1;
  } else {
    const existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const sameDigest = existing.sourceDigest === manifest.sourceDigest;
    console.log(
      `[manifest] check: version=${existing.version} digestMatch=${sameDigest} files=${manifest.fileCount}`,
    );
    if (!sameDigest || existing.version !== manifest.version) process.exitCode = 1;
  }
} else {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(
    `[manifest] wrote ${outPath}\n  version=${manifest.version} files=${manifest.fileCount} sourceDigest=${manifest.sourceDigest}`,
  );
}
