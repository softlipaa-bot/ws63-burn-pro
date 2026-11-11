import path from "path";

/**
 * IPC 边界校验（W08）。
 *
 * - 只接受来自本应用主窗口主框架的调用（senderFrame + webContents 双重校验）。
 * - 每个方法有显式的参数 schema；未知方法、多余/缺失/类型错误的参数一律拒绝。
 * - renderer 传来的文件路径按“策略”校验：绝对路径 + .fwpkg 扩展名 + 长度上限 + 无 NUL，
 *   再配合 fwpkg 的“存在/是普通文件/尺寸上限/摘要快照”检查；不做任意路径放行。
 */

export class IpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IpcError";
    this.code = code;
  }
}

export const MAX_PATH_LEN = 4096;
export const MAX_LOG_TEXT_LEN = 4096;
export const MAX_BAUD = 12000000;

export function normalizePortName(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim();
}

export function isPlausiblePort(raw) {
  const port = normalizePortName(raw);
  if (!port || port.length > 64) return false;
  if (/[^\w.\\:\-\/]/.test(port)) return false;
  return true;
}

export function isPlausibleBaud(raw) {
  const baud = Number(raw);
  return Number.isFinite(baud) && baud >= 1200 && baud <= MAX_BAUD;
}

/**
 * renderer 提供的固件路径策略校验（不含文件系统检查）。
 * @returns {string} 规范化后的绝对路径
 */
export function assertFirmwarePathPolicy(raw, { label = "固件" } = {}) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new IpcError("IPC_BAD_PARAMS", `${label}路径为空`);
  }
  if (raw.length > MAX_PATH_LEN) {
    throw new IpcError("IPC_BAD_PARAMS", `${label}路径过长`);
  }
  if (raw.includes("\0")) {
    throw new IpcError("IPC_BAD_PARAMS", `${label}路径包含非法字符`);
  }
  if (!path.isAbsolute(raw)) {
    throw new IpcError("IPC_BAD_PARAMS", `${label}路径必须是绝对路径`);
  }
  if (path.extname(raw).toLowerCase() !== ".fwpkg") {
    throw new IpcError("IPC_BAD_PARAMS", `${label}必须是 .fwpkg 文件`);
  }
  return path.normalize(raw);
}

/**
 * senderFrame 校验（W29-14：精确来源，不用前缀匹配）。
 *
 * 旧实现：
 * - 生产：`url.startsWith("file://")` —— 任意本地文件都算可信；
 * - 开发：`url.startsWith("http://127.0.0.1:5173")` —— 前缀可被 `127.0.0.1:51730` 之类混淆。
 *
 * 现在：开发只认精确 origin + 精确路径；生产只认**实际加载的那个 index.html**
 * （或其目录内的文档），并且必须来自本应用的主窗口主框架。
 *
 * @param {{senderFrame?: any, sender?: any}} event
 * @param {{webContents?: any, isDev: boolean, devUrl?: string,
 *          appRoot?: string, allowedFilePrefix?: string}} ctx
 */
export function assertTrustedSender(event, ctx) {
  const frame = event?.senderFrame ?? null;
  const expected = ctx?.webContents ?? null;
  const isDev = Boolean(ctx?.isDev);
  const devUrl = ctx?.devUrl ?? "http://127.0.0.1:5173";

  if (!frame) {
    throw new IpcError("IPC_UNTRUSTED_SENDER", "IPC 调用缺少 senderFrame");
  }
  if (expected && event.sender !== expected) {
    throw new IpcError("IPC_UNTRUSTED_SENDER", "IPC 调用来源窗口不匹配");
  }
  if (frame.parent) {
    throw new IpcError("IPC_UNTRUSTED_SENDER", "IPC 调用必须来自主框架");
  }

  const url = String(frame.url ?? "");
  if (isDev) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new IpcError("IPC_UNTRUSTED_SENDER", "IPC 调用来源无法解析");
    }
    let devOrigin;
    try {
      devOrigin = new URL(devUrl);
    } catch {
      throw new IpcError("IPC_UNTRUSTED_SENDER", "开发地址配置无效");
    }
    if (parsed.protocol !== devOrigin.protocol || parsed.origin !== devOrigin.origin) {
      throw new IpcError("IPC_UNTRUSTED_SENDER", "IPC 调用来源 origin 不被信任");
    }
    return true;
  }

  // 生产：必须是 file:// 且位于应用实际加载目录内
  if (!url.toLowerCase().startsWith("file://")) {
    throw new IpcError("IPC_UNTRUSTED_SENDER", "IPC 调用来源不被信任");
  }
  let filePath;
  try {
    const parsed = new URL(url);
    filePath = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new IpcError("IPC_UNTRUSTED_SENDER", "IPC 调用来源无法解析");
  }
  const prefix = ctx?.allowedFilePrefix ? String(ctx.allowedFilePrefix) : "";
  if (!prefix) {
    throw new IpcError("IPC_UNTRUSTED_SENDER", "未配置可信页面目录，拒绝 IPC");
  }
  const normalizedPrefix = prefix.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = filePath.replace(/\\/g, "/");
  if (
    normalizedPath !== normalizedPrefix &&
    !normalizedPath.startsWith(`${normalizedPrefix}/`)
  ) {
    throw new IpcError("IPC_UNTRUSTED_SENDER", "IPC 调用来源不在已加载页面目录内");
  }
  return true;
}

export function assertPlainParams(params) {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new IpcError("IPC_BAD_PARAMS", "参数必须是对象");
  }
  return params;
}

export function requireChannelId(channel, allowedIds) {
  const id = typeof channel === "number" ? String(channel) : channel;
  if (typeof id !== "string" || !allowedIds.includes(id)) {
    throw new IpcError("IPC_BAD_PARAMS", "无效的通道号");
  }
  return id;
}

export function requirePort(value, label = "串口") {
  if (!isPlausiblePort(value)) {
    throw new IpcError("IPC_BAD_PARAMS", `无效的${label}`);
  }
  return normalizePortName(value);
}

export function requireBaud(value, fallback = 115200) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!isPlausibleBaud(value)) {
    throw new IpcError("IPC_BAD_PARAMS", "无效的波特率");
  }
  return Number(value);
}

export function optionalBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new IpcError("IPC_BAD_PARAMS", "布尔参数类型错误");
  }
  return value;
}

export function sanitizeSerialText(raw) {
  if (typeof raw !== "string") {
    throw new IpcError("IPC_BAD_PARAMS", "发送内容必须是字符串");
  }
  if (raw.length > MAX_LOG_TEXT_LEN) {
    throw new IpcError("IPC_BAD_PARAMS", `发送内容超过 ${MAX_LOG_TEXT_LEN} 字符上限`);
  }
  return raw;
}
