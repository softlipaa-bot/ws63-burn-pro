#!/usr/bin/env node
/*
 * 归档的开发工具（禁止用于正式发布）。
 *
 * 历史问题见同目录 README.md：曾直接把写死的配置覆盖到 app\package.json，
 * 并使用与其他配置不一致的 dist-electron-fix 输出目录。
 *
 * 现在它：
 *  - 永不写 app\package.json（正式配置是唯一权威来源）；
 *  - 只输出到 package.legacy.json，供排查历史构建差异；
 *  - 输出目录固定为 dist-electron-legacy，避免和正式产物混淆。
 *
 * 用法：node app/tools/archive/write-pkg-legacy.cjs [--dry-run]
 */
const fs = require("fs");
const path = require("path");

const appDir = path.resolve(__dirname, "..", "..");
const target = path.join(appDir, "package.legacy.json");
const dryRun = process.argv.includes("--dry-run");

const pkg = {
  name: "ws63-burn-pro",
  version: "1.1.1",
  description: "WS63 Burn Pro - Electron + Nuxt UI (LEGACY GENERATOR)",
  main: "electron/main.js",
  type: "module",
  scripts: {
    dev: 'concurrently -k "vite" "wait-on http://127.0.0.1:5173 && electron ."',
    build: "vite build",
    "electron:pack": "npm run build && electron-builder --win --x64 --publish never",
  },
  build: {
    appId: "com.ws63.burnpro",
    productName: "WS63BurnPro",
    directories: { output: "dist-electron-legacy", buildResources: "build" },
    icon: "build/icon.ico",
    files: ["package.json", "dist/**/*", "electron/**/*"],
    asar: true,
    asarUnpack: [
      "**/*.node",
      "electron/preload.cjs",
      "**/node_modules/serialport/**",
      "**/node_modules/@serialport/**",
    ],
    win: { target: ["dir"], icon: "build/icon.ico" },
    npmRebuild: true,
  },
};

if (dryRun) {
  console.log("DRY RUN: 将写入", target);
  console.log(JSON.stringify(pkg, null, 2));
  process.exit(0);
}

fs.writeFileSync(target, `${JSON.stringify(pkg, null, 2)}\n`);
console.log("已写入（归档用途，非正式配置）:", target);
