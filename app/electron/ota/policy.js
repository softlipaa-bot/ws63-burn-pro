import fs from "fs";
import path from "path";

/**
 * OTA 策略与校验（W05/W06），纯逻辑、不依赖 electron，便于离线测试。
 *
 * - 资源类型由“发布资源名”决定（zip / setup exe），安装分支只认这个已验证类型，
 *   不看本地临时文件后缀（旧实现因为内部资源名被清空而落到 update.bin）。
 * - 更新包暂存后做结构与产品/版本校验（读 asar 内的 package.json），
 *   通过后才允许切换；切换前留备份，供首次启动健康确认失败时回滚。
 */

export const PRODUCT_NAME = "WS63BurnPro";
export const APP_PACKAGE_NAME = "ws63-burn-pro";
export const EXE_NAME = "WS63BurnPro.exe";

export class OtaPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OtaPolicyError";
    this.code = code;
  }
}

export function normalizeVersion(raw) {
  return String(raw || "")
    .trim()
    .replace(/^v/i, "");
}

export function compareSemver(a, b) {
  const pa = normalizeVersion(a)
    .split(".")
    .map((x) => parseInt(x, 10) || 0);
  const pb = normalizeVersion(b)
    .split(".")
    .map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

/** 由发布资源名判定安装方式；未知类型一律拒绝，不做“猜后缀”。 */
export function classifyAssetName(name) {
  const base = path.basename(String(name || ""));
  const lower = base.toLowerCase();
  if (lower.endsWith(".zip")) return { type: "zip", name: base };
  if (lower.endsWith(".exe")) return { type: "installer", name: base };
  return { type: "unknown", name: base };
}

/** 只保留安全文件名（不含目录分隔符、控制字符），用于临时落盘。 */
export function sanitizeAssetFileName(name, fallback = "update.bin") {
  const base = path.basename(String(name || "").replace(/\\/g, "/"));
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned.slice(0, 128);
}

export function pickAsset(assets, preferredName) {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const prefer = String(preferredName || "").toLowerCase();
  if (prefer) {
    const exact = assets.find((a) => String(a.name || "").toLowerCase() === prefer);
    if (exact) return exact;
  }
  const zipNamed = assets.find((a) => /^WS63BurnPro.*\.zip$/i.test(String(a.name || "")));
  if (zipNamed) return zipNamed;
  const anyZip = assets.find((a) => /\.zip$/i.test(String(a.name || "")));
  if (anyZip) return anyZip;
  const setup = assets.find(
    (a) =>
      /Setup.*\.exe$/i.test(String(a.name || "")) ||
      /^WS63BurnPro.*\.exe$/i.test(String(a.name || "")),
  );
  return setup || null;
}

/**
 * 读取 asar 内的 package.json（asar 头是 pickle 包装的 JSON 目录）。
 * 返回 null 表示无法解析（不作为失败依据，只作为“做不了校验”的事实）。
 */
export function readAsarManifest(asarPath) {
  let fd = null;
  try {
    fd = fs.openSync(asarPath, "r");
    const stat = fs.fstatSync(fd);
    const sizeBuf = Buffer.alloc(8);
    if (fs.readSync(fd, sizeBuf, 0, 8, 0) !== 8) return null;
    const headerSize = sizeBuf.readUInt32LE(4);
    if (!headerSize || headerSize < 8 || headerSize > sizeBuf.length + stat.size) return null;
    const headerBuf = Buffer.alloc(headerSize);
    if (fs.readSync(fd, headerBuf, 0, headerSize, 8) !== headerSize) return null;

    // pickle: [payloadSize u32][stringLen u32][json...]
    let jsonText = headerBuf.subarray(8).toString("utf8");
    const brace = jsonText.indexOf("{");
    if (brace < 0) return null;
    jsonText = jsonText.slice(brace).replace(/\u0000+$/g, "").trim();
    let header = null;
    try {
      header = JSON.parse(jsonText);
    } catch {
      // 末尾可能有 NUL 之外的垃圾，按最后一个 '}' 截断重试
      const lastBrace = jsonText.lastIndexOf("}");
      if (lastBrace < 0) return null;
      header = JSON.parse(jsonText.slice(0, lastBrace + 1));
    }

    const entry = header?.files?.["package.json"];
    if (!entry || typeof entry.offset !== "string" || typeof entry.size !== "number") return null;

    const dataBase = 8 + headerSize;
    const offset = Number(entry.offset);
    const len = Number(entry.size);
    if (!Number.isFinite(offset) || !Number.isFinite(len) || len <= 0) return null;
    if (dataBase + offset + len > stat.size) return null;

    const buf = Buffer.alloc(len);
    if (fs.readSync(fd, buf, 0, len, dataBase + offset) !== len) return null;
    const pkg = JSON.parse(buf.toString("utf8"));
    return {
      name: String(pkg.name ?? ""),
      version: String(pkg.version ?? ""),
      productName: String(pkg.build?.productName ?? pkg.productName ?? ""),
      raw: pkg,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function findPackageRoot(dir) {
  const direct = path.join(dir, EXE_NAME);
  if (fs.existsSync(direct)) return dir;
  let kids = [];
  try {
    kids = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const kid of kids) {
    if (!kid.isDirectory()) continue;
    const nested = path.join(dir, kid.name, EXE_NAME);
    if (fs.existsSync(nested)) return path.join(dir, kid.name);
  }
  return null;
}

function hasNativeSerialBinding(unpackedRoot) {
  const bases = [
    path.join(unpackedRoot, "node_modules", "@serialport"),
    path.join(unpackedRoot, "node_modules", "serialport"),
  ];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    const stack = [base];
    let seen = 0;
    while (stack.length && seen < 2000) {
      const cur = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        seen += 1;
        const full = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name.endsWith(".node")) return full;
      }
    }
  }
  return null;
}

/**
 * 暂存目录的结构 / 产品 / 版本校验。返回 problems 为空才算通过。
 * @param {{root: string, expectedVersion?: string}} opts
 */
export function verifyStagedPackage({ root, expectedVersion } = {}) {
  const problems = [];
  if (!root) {
    return { ok: false, problems: ["未找到解压后的程序目录"], version: "", name: "" };
  }
  const exePath = path.join(root, EXE_NAME);
  if (!fs.existsSync(exePath)) problems.push(`缺少 ${EXE_NAME}`);

  const asarPath = path.join(root, "resources", "app.asar");
  if (!fs.existsSync(asarPath)) problems.push("缺少 resources/app.asar");

  const preloadPath = path.join(root, "resources", "app.asar.unpacked", "electron", "preload.cjs");
  if (!fs.existsSync(preloadPath)) problems.push("缺少 asar 解包后的 preload.cjs");

  const nativePath = hasNativeSerialBinding(
    path.join(root, "resources", "app.asar.unpacked"),
  );
  if (!nativePath) problems.push("缺少串口原生模块（.node）");

  let manifest = null;
  if (fs.existsSync(asarPath)) {
    manifest = readAsarManifest(asarPath);
    if (!manifest) {
      problems.push("无法解析 app.asar 内的 package.json（版本/产品校验不可用）");
    } else {
      if (manifest.name && manifest.name !== APP_PACKAGE_NAME) {
        problems.push(`产品不匹配：包内 name=${manifest.name}，期望 ${APP_PACKAGE_NAME}`);
      }
      if (
        manifest.productName &&
        manifest.productName !== PRODUCT_NAME &&
        manifest.productName !== APP_PACKAGE_NAME
      ) {
        problems.push(`产品名不匹配：包内 productName=${manifest.productName}`);
      }
      if (expectedVersion && manifest.version && compareSemver(manifest.version, expectedVersion) !== 0) {
        problems.push(
          `版本不匹配：包内版本 ${manifest.version}，发布声明 ${normalizeVersion(expectedVersion)}`,
        );
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    version: manifest?.version ?? "",
    name: manifest?.name ?? "",
    exePath,
    asarPath,
  };
}

/**
 * 更新包签名/来源校验结果（Windows Authenticode）。
 * 只返回事实；是否强依赖签名由配置 requireSignature 决定。
 */
export function describeSignature(powershellResult) {
  const status = String(powershellResult?.Status ?? "");
  return {
    status,
    signed: status === "Valid",
    signer: String(powershellResult?.SignerCertificate?.Subject ?? ""),
  };
}

/**
 * 安装方式只由“已验证的资源类型”决定，不看本地临时文件后缀。
 * @param {{assetType: string, downloadPath: string, packaged: boolean}} input
 */
export function resolveInstallMode(input) {
  const { assetType, downloadPath, packaged } = input || {};
  if (!packaged) {
    throw new OtaPolicyError("OTA_DEV_MODE", "开发模式不支持安装更新，请使用 release 目录中的正式版");
  }
  if (!downloadPath) throw new OtaPolicyError("OTA_NOT_DOWNLOADED", "请先下载更新包");
  if (assetType === "zip") return { mode: "zip" };
  if (assetType === "installer") return { mode: "installer" };
  throw new OtaPolicyError("OTA_UNKNOWN_ASSET", "更新包类型未经验证，拒绝安装");
}

