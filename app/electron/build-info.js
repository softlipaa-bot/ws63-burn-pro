/**
 * 构建/运行身份信息（W29-01）。
 *
 * 现场问题的根源不是“有没有打包”，而是**桌面快捷方式指向的包和最新修复不在同一个目录**：
 * release\ 里是 1.1.1，而 1.1.2 只存在于 app\dist-electron-release\win-unpacked。
 * 所以 UI 必须能显示“当前运行的到底是哪个版本、从哪个路径启动、包内源码摘要是什么”。
 *
 * 本模块刻意不 import electron：只接受调用方传入的路径，便于离线单测。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** manifest 由 scripts/build-manifest.mjs 在打包前写入 app/dist/，随 dist/** 进入 asar。 */
export const MANIFEST_RELATIVE_CANDIDATES = Object.freeze([
  path.join("dist", "build-manifest.json"),
  path.join("..", "dist", "build-manifest.json"),
  "build-manifest.json",
]);

export const CRITICAL_MODULES = Object.freeze([
  "electron/main.js",
  "electron/burn/ws63flash.js",
  "electron/burn/serial-session.js",
  "electron/burn/frame-parser.js",
  "electron/burn/ymodem.js",
  "electron/burn/fwpkg.js",
  "electron/burn/ipc.js",
  "electron/burn/firmware-registry.js",
  "electron/burn/flash-outcome.js",
  "electron/serial/monitor.js",
  "electron/serial/ownership.js",
  "electron/ipc-guard.js",
  "electron/preload.cjs",
  "package.json",
]);

function findManifest(searchDirs) {
  for (const dir of searchDirs) {
    for (const rel of MANIFEST_RELATIVE_CANDIDATES) {
      const candidate = path.join(dir, rel);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* 忽略不可读路径 */
      }
    }
  }
  return null;
}

function readPackageVersion(appPath) {
  const candidates = [
    appPath ? path.join(appPath, "package.json") : null,
    path.join(__dirname, "..", "package.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      if (pkg?.version) return { version: String(pkg.version), source: file };
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return { version: "unknown", source: "" };
}

/**
 * 读取构建身份。任何缺失都以显式字段报告，不猜测。
 * @param {{packaged?: boolean, appPath?: string, execPath?: string, resourcesPath?: string, searchDirs?: string[]}} ctx
 */
export function readBuildInfo(ctx = {}) {
  const appPath = ctx.appPath ?? path.join(__dirname, "..");
  // 只在本应用自己的路径里找清单：多搜一层父目录是为了兼容
  // “appPath 指向 electron/ 子目录”的开发场景。
  // 绝不扫 build-info.js 所在的固定目录，否则开发机上会读到仓库里的清单，
  // 把“包里没有清单”误判成“清单一致”。
  const searchDirs = ctx.searchDirs ?? [appPath, path.join(appPath, "..")];

  const pkgVersion = readPackageVersion(appPath);
  const manifestPath = findManifest(searchDirs);
  let manifest = null;
  let manifestError = "";
  if (manifestPath) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
      manifestError = err instanceof Error ? err.message : String(err);
    }
  }

  const version = manifest?.version ?? pkgVersion.version;
  const manifestMatchesPackage = Boolean(
    manifest?.version && pkgVersion.version && manifest.version === pkgVersion.version,
  );

  return {
    version,
    product: manifest?.product ?? "WS63BurnPro",
    versionSource: manifest?.version ? "build-manifest" : pkgVersion.source || "unknown",
    packageVersion: pkgVersion.version,
    builtAt: manifest?.builtAt ?? "",
    sourceDigest: manifest?.sourceDigest ?? "",
    manifest: {
      found: Boolean(manifest),
      path: manifestPath ?? "",
      matchesPackageVersion: manifestMatchesPackage,
      error: manifestError,
    },
    criticalModules: manifest?.criticalModules ?? [],
    runtime: {
      packaged: Boolean(ctx.packaged),
      execPath: ctx.execPath ?? process.execPath,
      appPath,
      resourcesPath: ctx.resourcesPath ?? "",
      // 从 asar 内运行时路径里会带 app.asar；开发模式不会
      fromAsar: String(appPath).includes("app.asar"),
    },
    // 发布一致性提示：UI 可直接展示，避免“以为在用新版”
    warnings: buildWarnings({ version, manifest, pkgVersion, manifestMatchesPackage }),
  };
}

function buildWarnings({ version, manifest, pkgVersion, manifestMatchesPackage }) {
  const warnings = [];
  if (!manifest) {
    warnings.push("缺少 build-manifest.json：无法核对包内源码摘要，可能是旧构建或开发模式");
  }
  if (manifest && !manifestMatchesPackage && pkgVersion.version) {
    warnings.push(
      `构建清单版本(${manifest.version}) 与 package.json(${pkgVersion.version}) 不一致`,
    );
  }
  if (manifest?.checksumMismatch?.length) {
    warnings.push(`包内源码摘要与清单不一致：${manifest.checksumMismatch.join(",")}`);
  }
  if (!version || version === "unknown") warnings.push("无法确定版本号");
  return warnings;
}

/** 供 UI 用的一行身份文本。 */
export function formatBuildIdentity(info) {
  const parts = [`v${info.version}`];
  if (info.runtime.packaged) parts.push("安装版");
  else parts.push("开发模式");
  if (info.runtime.execPath) parts.push(path.basename(info.runtime.execPath));
  return parts.join(" · ");
}
