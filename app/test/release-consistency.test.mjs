/**
 * W29-01：构建清单与发布一致性。
 *
 * 这些测试不依赖真实 release 目录（那是“当前机器状态”，不是产品不变量），
 * 而是在临时目录里合成一个“源码树 + asar”，验证：
 *   - 清单是确定性的
 *   - 内容一致时判定通过
 *   - 改一个文件 / 改版本就必定被判不一致
 * 桌面快捷方式到底指向哪个包，由 scripts/package-consistency.mjs 现场核对。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import asar from "@electron/asar";

import {
  collectFromAsar,
  compareTarget,
  computeManifest,
  readAsarPackageVersion,
} from "../scripts/lib/manifest.mjs";
import { readBuildInfo } from "../electron/build-info.js";

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws63-manifest-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel.split("/").join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const BASE_FILES = {
  "package.json": JSON.stringify({ name: "ws63-burn-pro", version: "1.1.3", main: "electron/main.js" }),
  "electron/main.js": "export const main = 1;\n",
  "electron/burn/ws63flash.js": "export const flasher = 1;\n",
  "dist/index.html": "<!doctype html><title>ws63</title>",
  "dist/assets/app.js": "console.log(1);\n",
};

test("W29-01: 清单是确定性的（同一棵树两次计算结果一样）", () => {
  const root = makeTree(BASE_FILES);
  const a = computeManifest({ root, version: "1.1.3", builtAt: "2026-10-29T00:00:00.000Z" });
  const b = computeManifest({ root, version: "1.1.3", builtAt: "2026-10-29T00:00:00.000Z" });
  assert.equal(a.sourceDigest, b.sourceDigest);
  assert.deepEqual(a.files, b.files);
  assert.equal(a.fileCount, 5);
  assert.ok(!("dist/build-manifest.json" in a.files), "清单文件本身不能进清单");
});

test("W29-01: 内容变化会改变 sourceDigest 与对应文件摘要", () => {
  const root = makeTree(BASE_FILES);
  const before = computeManifest({ root, version: "1.1.3" });
  fs.writeFileSync(
    path.join(root, "electron", "burn", "ws63flash.js"),
    "export const flasher = 2;\n",
  );
  const after = computeManifest({ root, version: "1.1.3" });
  assert.notEqual(before.files["electron/burn/ws63flash.js"], after.files["electron/burn/ws63flash.js"]);
  assert.notEqual(before.sourceDigest, after.sourceDigest);
  assert.equal(before.files["electron/main.js"], after.files["electron/main.js"]);
});

test("W29-01: 包内容与清单一致时判定通过", async () => {
  const root = makeTree(BASE_FILES);
  const manifest = computeManifest({ root, version: "1.1.3" });
  const asarPath = path.join(root, "app.asar");
  await asar.createPackage(root, asarPath);

  const collected = collectFromAsar(asarPath, asar, { only: Object.keys(manifest.files) });
  const report = compareTarget(manifest, collected, {
    label: "synthetic",
    packageVersion: readAsarPackageVersion(asarPath, asar),
  });
  assert.equal(report.ok, true, report.problems.join("; "));
  assert.equal(report.changed.length, 0);
  assert.equal(report.missing.length, 0);
  assert.equal(report.packageVersion, "1.1.3");
});

test("W29-01【核心】: 包内文件被改（等价于 release 里是旧代码）→ 必须判不一致", async () => {
  const root = makeTree(BASE_FILES);
  const manifest = computeManifest({ root, version: "1.1.3" });

  // 模拟“旧包”：先做一些修改再打包
  const staleRoot = makeTree(BASE_FILES);
  fs.writeFileSync(
    path.join(staleRoot, "electron", "burn", "ws63flash.js"),
    "export const flasher = 'OLD-no-frame-parser';\n",
  );
  const asarPath = path.join(staleRoot, "app.asar");
  await asar.createPackage(staleRoot, asarPath);

  const collected = collectFromAsar(asarPath, asar, { only: Object.keys(manifest.files) });
  const report = compareTarget(manifest, collected, {
    label: "stale",
    packageVersion: readAsarPackageVersion(asarPath, asar),
  });
  assert.equal(report.ok, false);
  assert.ok(report.changed.includes("electron/burn/ws63flash.js"));
  assert.ok(report.problems.some((p) => p.includes("内容不一致")));
});

test("W29-01: 包内缺文件（如旧包没有 frame-parser.js）→ 必须判缺失", async () => {
  const full = makeTree({
    ...BASE_FILES,
    "electron/burn/frame-parser.js": "export class FrameParser {}\n",
  });
  const manifest = computeManifest({ root: full, version: "1.1.3" });

  const oldRoot = makeTree(BASE_FILES); // 故意不含 frame-parser.js
  const asarPath = path.join(oldRoot, "app.asar");
  await asar.createPackage(oldRoot, asarPath);

  const collected = collectFromAsar(asarPath, asar, { only: Object.keys(manifest.files) });
  const report = compareTarget(manifest, collected, { label: "old" });
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, ["electron/burn/frame-parser.js"]);
  assert.ok(report.problems.some((p) => p.includes("缺少")));
});

test("W29-01: 包内版本与清单版本不符 → 单独报告（复现 release=1.1.1 / 源码=1.1.3）", async () => {
  const root = makeTree(BASE_FILES);
  const manifest = computeManifest({ root, version: "1.1.3" });
  const asarPath = path.join(root, "app.asar");
  await asar.createPackage(root, asarPath);

  const collected = collectFromAsar(asarPath, asar, { only: Object.keys(manifest.files) });
  const report = compareTarget(manifest, collected, {
    label: "release",
    packageVersion: "1.1.1", // 桌面快捷方式指向的旧包
  });
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((p) => p.includes("包内版本 1.1.1")));
});

test("W29-01: electron-builder 重写 package.json（裁 build/scripts/devDependencies）不算不一致", async () => {
  // 真实源码树里有 build / scripts / devDependencies
  const sourceRoot = makeTree({
    ...BASE_FILES,
    "package.json": JSON.stringify({
      name: "ws63-burn-pro",
      version: "1.1.3",
      description: "WS63 Burn Pro - Electron + Nuxt UI",
      main: "electron/main.js",
      type: "module",
      scripts: { test: "node --test" },
      build: { appId: "com.ws63.burnpro", productName: "WS63BurnPro" },
      dependencies: { serialport: "^13.0.0", "@serialport/parser-readline": "^13.0.0" },
      devDependencies: { vite: "^6.0.11" },
    }),
    "dist/assets/app.js": "console.log(1);\n",
  });
  const manifest = computeManifest({ root: sourceRoot, version: "1.1.3" });

  // electron-builder 打包后的形态：保留运行时字段，裁掉构建期字段
  const packedRoot = makeTree({
    ...BASE_FILES,
    "package.json": JSON.stringify({
      name: "ws63-burn-pro",
      version: "1.1.3",
      description: "WS63 Burn Pro - Electron + Nuxt UI",
      main: "electron/main.js",
      type: "module",
      dependencies: { "@serialport/parser-readline": "^13.0.0", serialport: "^13.0.0" },
    }),
    "dist/assets/app.js": "console.log(1);\n",
  });
  const asarPath = path.join(packedRoot, "app.asar");
  await asar.createPackage(packedRoot, asarPath);

  const collected = collectFromAsar(asarPath, asar, { only: Object.keys(manifest.files) });
  const report = compareTarget(manifest, collected, {
    label: "packed",
    packageVersion: readAsarPackageVersion(asarPath, asar),
  });
  assert.equal(report.ok, true, `打包重写 package.json 不应误报：${report.problems.join("; ")}`);
});

test("W29-01: 但运行时字段（version/dependencies）被改仍必须判不一致", async () => {
  const sourceRoot = makeTree(BASE_FILES);
  const manifest = computeManifest({ root: sourceRoot, version: "1.1.3" });
  const packedRoot = makeTree({
    ...BASE_FILES,
    "package.json": JSON.stringify({
      name: "ws63-burn-pro",
      version: "1.1.3",
      main: "electron/main.js",
      type: "module",
      dependencies: { serialport: "^12.0.0" }, // 运行时依赖被改
    }),
  });
  const asarPath = path.join(packedRoot, "app.asar");
  await asar.createPackage(packedRoot, asarPath);
  const collected = collectFromAsar(asarPath, asar, { only: Object.keys(manifest.files) });
  const report = compareTarget(manifest, collected, { label: "packed" });
  assert.equal(report.ok, false);
  assert.ok(report.changed.includes("package.json"));
});

/* ------------------------------------------------------ 运行时构建身份（build-info） */

test("W29-01: readBuildInfo 能从 dist/build-manifest.json 读出身份与摘要", () => {
  const root = makeTree({
    ...BASE_FILES,
    "dist/build-manifest.json": JSON.stringify({
      schema: 1,
      product: "WS63BurnPro",
      version: "1.1.3",
      builtAt: "2026-10-29T00:00:00.000Z",
      sourceDigest: "deadbeef",
      files: {},
      criticalModules: [{ path: "electron/main.js", sha256: "x" }],
    }),
  });
  const info = readBuildInfo({ packaged: true, appPath: root, execPath: "C:\\app\\WS63BurnPro.exe" });
  assert.equal(info.version, "1.1.3");
  assert.equal(info.manifest.found, true);
  assert.equal(info.manifest.matchesPackageVersion, true);
  assert.equal(info.sourceDigest, "deadbeef");
  assert.equal(info.runtime.packaged, true);
  assert.equal(info.warnings.length, 0);
});

test("W29-01: 缺清单时明确警告，而不是假装一致", () => {
  const root = makeTree({ "package.json": BASE_FILES["package.json"] });
  const info = readBuildInfo({ packaged: true, appPath: root });
  assert.equal(info.manifest.found, false);
  assert.equal(info.version, "1.1.3", "退回到 package.json 的版本");
  assert.ok(info.warnings.some((w) => w.includes("缺少 build-manifest.json")));
});

test("W29-01: 清单版本与 package.json 不一致时给出警告", () => {
  const root = makeTree({
    ...BASE_FILES,
    "dist/build-manifest.json": JSON.stringify({ version: "1.1.2", files: {} }),
  });
  const info = readBuildInfo({ packaged: true, appPath: root });
  assert.equal(info.manifest.matchesPackageVersion, false);
  assert.ok(info.warnings.some((w) => w.includes("不一致")));
});
