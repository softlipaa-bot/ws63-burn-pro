/**
 * 诊断导出（用户已明确授权）。
 *
 * 硬约束：
 * - 不读、不写固件原始字节；长 base64 / 十六进制转储 / Buffer 变成 `<BINARY>`
 * - 密码、Cookie、Authorization、能力令牌、URL 用户信息与查询凭证整段删除。
 *   保留前 12 位不算删除。
 * - 整段且只有 ≤128 位十六进制时，仍按摘要截成前 12 位（构建 SHA256 契约）。
 *   这只适用于“整段就是摘要”，不适用于 token= / Bearer / 查询串里的凭证。
 * - Windows、UNC、用户目录路径变成 `<PATH>/文件名`，用户名和服务器名不保留。
 * - 序列化后的报告有字节上限。
 *
 * 本模块不 import electron，便于离线单测。
 */

export const DIAGNOSTIC_SCHEMA = 1;
export const MAX_DIAGNOSTIC_LOG_LINES = 400;
export const MAX_DIAGNOSTIC_LINE_CHARS = 1500;
export const MAX_DIAGNOSTIC_BYTES = 256 * 1024;

const SENSITIVE_EXACT = new Set([
  "password", "passwd", "pwd", "secret", "token", "cookie", "cookies",
  "authorization", "proxyauthorization", "apikey", "xapikey", "accesstoken",
  "refreshtoken", "idtoken", "session", "sessionid", "sessiontoken",
  "credential", "credentials", "bearer", "firmwaretoken", "firmwaretokens",
  "capabilitytoken", "setcookie", "privatekey", "clientsecret", "authtoken",
  "secretkey", "auth",
]);

function normKey(key) {
  return String(key ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key) {
  const norm = normKey(key);
  if (!norm) return false;
  if (SENSITIVE_EXACT.has(norm)) return true;
  return /(password|passwd|secret|token|cookie|authorization|apikey|credential)/.test(norm);
}

function isPathKey(key) {
  return /^(filepath|sourcepath|firmwarepath|execpath|apppath|resourcespath|downloadpath|userprofile|homepath)$/.test(normKey(key));
}

function isBinaryKey(key) {
  const norm = normKey(key);
  return /^(firmware|firmwarebytes|filebytes|image|raw|fwpkg|filecontent|payload|buffer|rawbytes)$/.test(norm)
    || /(firmware|fwpkg|filebytes|rawbytes)/.test(norm);
}

function clip(text, notes) {
  if (text.length <= MAX_DIAGNOSTIC_LINE_CHARS) return text;
  notes?.add("line-truncated");
  return text.slice(0, MAX_DIAGNOSTIC_LINE_CHARS);
}

function pathBase(raw, notes, kind) {
  notes?.add(kind);
  const parts = String(raw).split(/[\\/]/).filter(Boolean);
  const usersIdx = parts.findIndex((part) => /^users$/i.test(part) || /^home$/i.test(part));
  if (usersIdx >= 0) {
    const afterUser = parts.slice(usersIdx + 2);
    if (!afterUser.length) return "<PATH>";
    const base = afterUser[afterUser.length - 1].replace(/[),.;:]+$/g, "");
    if (!base || base === "." || base === "..") return "<PATH>";
    return `<PATH>/${base}`;
  }
  const file = (parts[parts.length - 1] || "").replace(/[),.;:]+$/g, "");
  if (!file || /^[a-z]:$/i.test(file) || /^%.*%$/.test(file)) return "<PATH>";
  return `<PATH>/${file}`;
}

function redactHeaders(text, notes) {
  let out = text;
  const before = out;
  out = out.replace(/\b((?:proxy-)?authorization)\s*:\s*[^\r\n]+/gi, (_m, name) => {
    notes?.add("authorization-redacted");
    return `${name}: <REDACTED>`;
  });
  out = out.replace(/\b(set-cookie|cookie)\s*:\s*[^\r\n]+/gi, (_m, name) => {
    notes?.add("cookie-redacted");
    return `${name}: <REDACTED>`;
  });
  out = out.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, () => {
    notes?.add("bearer-redacted");
    return "Bearer <REDACTED>";
  });
  if (out !== before && !notes) return out;
  return out;
}

function redactAssignments(text, notes) {
  return text.replace(
    /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|session(?:id)?|credential|bearer|firmware[_-]?token|capability[_-]?token)\b(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s&;,]+)/gi,
    (_m, key, sep) => {
      notes?.add("assignment-redacted");
      return `${key}${sep}<REDACTED>`;
    },
  );
}

/**
 * 把 URL 百分号编码（以及 `+` 表示的空格）还原，用于**判断键名**是否敏感。
 * Codex 复现：`?%74oken=SECRET` 直接比对字面量会漏掉（`%74` = `t`）。
 */
function decodeQueryKey(key) {
  const raw = String(key ?? "");
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/**
 * JSON 字符串里的 `\uXXXX` 转义也要还原后再判断键名。
 * Codex 复现：`{"pass\u0077ord":"SECRET"}` 的字面键名不是 password，直接比对会漏。
 */
function decodeJsonKey(key) {
  const raw = String(key ?? "");
  if (!raw.includes("\\")) return raw;
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

function redactUrls(text, notes) {
  let out = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@]+)@/gi, (_m, scheme) => {
    notes?.add("url-userinfo-redacted");
    return `${scheme}<REDACTED>@`;
  });
  out = out.replace(/([?&#])([^=&#\s]+)=([^&#\s]*)/g, (match, sep, key) => {
    // 键名先解码再判定：`%74oken` / `to+ken` 都要被识别
    if (!isSensitiveKey(key) && !isSensitiveKey(decodeQueryKey(key))) return match;
    notes?.add("url-query-redacted");
    return `${sep}${key}=<REDACTED>`;
  });
  return out;
}

function redactInlineJsonSecrets(text, notes) {
  return text.replace(
    /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    (match, key) => {
      if (!isSensitiveKey(key) && !isSensitiveKey(decodeJsonKey(key))) return match;
      notes?.add("json-field-redacted");
      return `"${key}":"<REDACTED>"`;
    },
  );
}

function redactPaths(text, notes) {
  let out = text;
  out = out.replace(/\\\\(?:\?\\)?[^\s\\]+\\[^\s\\]+(?:\\[^\s\\]+)*/g, (match) => pathBase(match, notes, "unc-path"));
  // 用户目录优先处理，且**允许用户名里有空格**（Windows 常见 "Alice Smith"）。
  // Codex 复现：旧规则按 \s 断开，只吃掉 "C:\Users\Alice"，把 "Smith\Desktop\demo.fwpkg" 留在报告里。
  // 结构：根 + 用户名（可含空格，但不含反斜杠） + 若干"不含空格的中间段" + 文件名。
  // 文件名段要求带扩展名，避免把 "C:\Users\a\b" 这类整段吞掉。
  out = out.replace(
    /([A-Za-z]:[\\/](?:Users|home)[\\/][^\\\r\n\s][^\\\r\n]*?)((?:[\\/][^\s\\/]+)*[\\/][^\s\\/]*\.[A-Za-z0-9]{1,10})/g,
    (match, _head, tail) => {
      const base = String(tail).split(/[\\/]/).filter(Boolean).pop() ?? "";
      notes?.add("user-path-redacted");
      return `<PATH>/${base}`;
    },
  );
  out = out.replace(/(?<![A-Za-z])([A-Za-z]:[\\/](?:[^\s\\/:*?"<>|\r\n]+[\\/])*[^\s\\/:*?"<>|\r\n]*)/g, (match) => pathBase(match, notes, "absolute-windows-path"));
  out = out.replace(/(?<!:)\/\/[^\s/]+\/[^\s?#]+/g, (match) => pathBase(match, notes, "unc-path"));
  out = out.replace(/\/(?:Users|home)\/[^\s/?#]+(?:\/[^\s?#]*)?/g, (match) => pathBase(match, notes, "absolute-posix-path"));
  out = out.replace(/%(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH|HOMEDRIVE|ALLUSERSPROFILE)%(?:[\\/][^\s\\/:*?"<>|]+)*/gi, (match) => pathBase(match, notes, "env-user-path"));
  out = out.replace(/~[\\/][^\s?#]+/g, (match) => pathBase(match, notes, "tilde-path"));
  return out;
}

function redactLabeledDigests(text, notes) {
  return text.replace(/\b(SHA-?256)\b(\s*[:=]?\s*)([a-f0-9]{32,128})\b/gi, (_m, label, sep, hex) => {
    notes?.add("digest-truncated");
    return `${label}${sep}${hex.slice(0, 12)}…`;
  });
}

function redactLooseSecrets(text, notes) {
  const trimmed = text.trim();
  if (/^(?:[a-f0-9]{2}[\s:]+){16,}[a-f0-9]{2}\s*$/i.test(trimmed)) {
    notes?.add("binary-hex-dropped");
    return "<BINARY>";
  }
  if (trimmed.length >= 160 && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    notes?.add("binary-text-dropped");
    return "<BINARY>";
  }
  return text.replace(/\b[a-f0-9]{32,}\b/gi, (match, offset, whole) => {
    if (offset === 0 && match.length === whole.length && match.length <= 128) {
      notes?.add("long-hex-truncated");
      return `${match.slice(0, 12)}…`;
    }
    if (match.length > 256) {
      notes?.add("binary-hex-dropped");
      return "<BINARY>";
    }
    notes?.add("long-hex-redacted");
    return "<REDACTED>";
  });
}

function redactPlain(text, notes) {
  let out = text;
  out = redactHeaders(out, notes);
  out = redactAssignments(out, notes);
  out = redactUrls(out, notes);
  out = redactInlineJsonSecrets(out, notes);
  out = redactPaths(out, notes);
  out = redactLabeledDigests(out, notes);
  out = redactLooseSecrets(out, notes);
  return out;
}

export function redactText(text, notes = null) {
  if (typeof text !== "string") return text == null ? "" : redactText(String(text), notes);
  if (!text) return "";
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
    || (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        notes?.add("json-string-redacted");
        return clip(JSON.stringify(redactObject(parsed, notes)), notes);
      }
    } catch {
      /* 不是 JSON，按普通文本处理 */
    }
  }
  return clip(redactPlain(text, notes), notes);
}

function isByteArray(value) {
  return value.length >= 16 && value.every((item) => typeof item === "number" && item >= 0 && item <= 255 && Number.isInteger(item));
}

export function redactObject(value, notes = null, depth = 0) {
  if (depth > 6) return "<DEPTH_LIMIT>";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value, notes);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(value)) {
    notes?.add("buffer-dropped");
    return "<BINARY>";
  }
  if (ArrayBuffer.isView(value)) {
    notes?.add("buffer-dropped");
    return "<BINARY>";
  }
  if (Array.isArray(value)) {
    if (isByteArray(value)) {
      notes?.add("binary-array-dropped");
      return `<BINARY ${value.length} bytes>`;
    }
    return value.slice(0, 40).map((item) => redactObject(item, notes, depth + 1));
  }
  if (typeof value === "object") {
    if (value.type === "Buffer" && Array.isArray(value.data)) {
      notes?.add("buffer-dropped");
      return "<BINARY>";
    }
    const out = {};
    let count = 0;
    for (const [key, inner] of Object.entries(value)) {
      if (++count > 40) {
        notes?.add("object-keys-truncated");
        break;
      }
      if (isSensitiveKey(key) || isPathKey(key)) {
        notes?.add(`dropped-key:${key}`);
        continue;
      }
      if (isBinaryKey(key)) {
        notes?.add("binary-key-dropped");
        out[key] = "<BINARY>";
        continue;
      }
      out[key] = redactObject(inner, notes, depth + 1);
    }
    return out;
  }
  return redactText(String(value), notes);
}

function truncateHash(sha) {
  if (typeof sha !== "string" || !sha) return "";
  return `${sha.slice(0, 12)}…`;
}

function capLine(line, notes) {
  if (line && typeof line === "object") {
    return clip(JSON.stringify(redactObject(line, notes)), notes);
  }
  return redactText(String(line ?? ""), notes);
}

/**
 * 预算必须按 **UTF-8 字节** 计算。
 *
 * Codex 复现：旧实现用 `serialize(...).length`（UTF-16 码元数）。中文日志下
 * 226,288 字符 = 673,464 UTF-8 字节，远超 256 KiB —— 等于预算形同虚设。
 */
function byteLength(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

/** 当前报告序列化后的 UTF-8 字节数。 */
function reportBytes(report) {
  return byteLength(serializeDiagnosticReport(report));
}

function fitBudget(report) {
  const limit = MAX_DIAGNOSTIC_BYTES;
  let guard = 0;
  // 1) 先按行减半日志，直到进入预算
  while (reportBytes(report) > limit && report.logs.length > 0 && guard < 32) {
    const drop = Math.max(1, Math.ceil(report.logs.length / 2));
    report.logs.splice(0, drop);
    report.redaction.truncated = true;
    report.redaction.droppedLogLines += drop;
    guard += 1;
  }
  // 2) 日志清空后仍超预算：逐步收缩其余可变字段（**所有字段最终都受同一预算兜底**）
  if (reportBytes(report) > limit) {
    report.logs = [];
    report.redaction.truncated = true;
    report.runtime = { note: "<TRUNCATED>" };
  }
  if (reportBytes(report) > limit) {
    // 通道明细按条数收敛
    for (const key of ["flash", "serial"]) {
      const list = report[key]?.channels;
      if (Array.isArray(list)) {
        while (reportBytes(report) > limit && list.length > 0) {
          list.pop();
          report.redaction.truncated = true;
        }
      }
    }
  }
  if (reportBytes(report) > limit) {
    // 最后手段：把 bootMarks / busy / warnings 等剩余可变结构清掉
    report.bootMarks = {};
    report.busy = {};
    if (report.app && Array.isArray(report.app.warnings)) report.app.warnings = [];
    report.redaction.truncated = true;
  }
  if (reportBytes(report) > limit) {
    // 仍超预算（理论上只剩固定字段）：把日志上限降到 0 并标注，绝不放宽上限
    report.logs = [];
    report.redaction.logLineLimit = 0;
    report.redaction.truncated = true;
  }
  return report;
}

/**
 * @param {{
 *   buildInfo?: any,
 *   flashSnapshot?: {channels?: Record<string, any>},
 *   monitorSnapshot?: {serialChannels?: Record<string, any>},
 *   busy?: any,
 *   logs?: any[],
 *   ackPolicy?: {policy: string, label: string},
 *   portLines?: {mode: string, dts?: any},
 *   bootMarks?: Record<string, number>,
 *   runtime?: Record<string, any>,
 *   renderer?: { droppedLogParts?: number, pendingLogChars?: number, queueParts?: number, queueChars?: number },
 *   now?: number,
 * }} input
 */
export function buildDiagnosticReport(input = {}) {
  const notes = new Set();
  const now = input.now ?? Date.now();

  const channels = Object.entries(input.flashSnapshot?.channels ?? {}).map(([id, ch]) => ({
    id,
    status: ch?.status ?? "",
    running: Boolean(ch?.running),
    pending: Boolean(ch?.pending),
    stage: ch?.stage ?? "",
    stageLabel: ch?.stageLabel ?? "",
    partName: ch?.partName ?? "",
    progress: Number(ch?.progress ?? 0),
    port: typeof ch?.port === "string" ? ch.port : "",
    errorMessage: redactText(String(ch?.errorMessage ?? ""), notes),
    transferComplete: Boolean(ch?.transferComplete),
    protocolConfirmed: Boolean(ch?.protocolConfirmed),
    bootVerified: Boolean(ch?.bootVerified),
    ackPolicy: ch?.ackPolicy ?? "",
    handshakeAttempts: Number(ch?.handshakeAttempts ?? 0),
    handshakeRxBytes: Number(ch?.handshakeRxBytes ?? 0),
    retryCount: Number(ch?.retryCount ?? 0),
  }));

  const serialChannels = Object.entries(input.monitorSnapshot?.serialChannels ?? {}).map(
    ([id, s]) => ({
      id,
      connected: Boolean(s?.connected),
      port: typeof s?.port === "string" ? s.port : "",
      baudRate: Number(s?.baudRate ?? 0),
      truncatedSegments: Number(s?.truncatedSegments ?? 0),
      droppedChars: Number(s?.droppedChars ?? 0),
      pendingChars: Number(s?.pendingChars ?? 0),
    }),
  );

  const logs = (input.logs ?? [])
    .slice(-MAX_DIAGNOSTIC_LOG_LINES)
    .map((line) => capLine(line, notes));

  const build = input.buildInfo ?? {};
  const renderer = input.renderer && typeof input.renderer === "object"
    ? {
        droppedLogParts: Number(input.renderer.droppedLogParts ?? 0),
        pendingLogChars: Number(input.renderer.pendingLogChars ?? 0),
        queueParts: Number(input.renderer.queueParts ?? 0),
        queueChars: Number(input.renderer.queueChars ?? 0),
      }
    : undefined;

  const report = {
    schema: DIAGNOSTIC_SCHEMA,
    kind: "ws63-diagnostic",
    generatedAt: new Date(now).toISOString(),
    app: {
      version: build.version ?? "",
      product: build.product ?? "",
      packaged: Boolean(build.runtime?.packaged),
      execName: build.runtime?.execPath ? String(build.runtime.execPath).split(/[\\/]/).pop() : "",
      builtAt: build.builtAt ?? "",
      sourceDigest: truncateHash(build.sourceDigest),
      manifestFound: Boolean(build.manifest?.found),
      manifestMatchesPackageVersion: Boolean(build.manifest?.matchesPackageVersion),
      warnings: (build.warnings ?? []).map((item) => redactText(String(item), notes)),
    },
    runtime: redactObject(input.runtime ?? {}, notes),
    bootMarks: input.bootMarks ?? {},
    protocol: {
      ackPolicy: input.ackPolicy?.policy ?? "",
      ackPolicyLabel: input.ackPolicy?.label ?? "",
      portLinesMode: input.portLines?.mode ?? "",
    },
    flash: { channels },
    serial: { channels: serialChannels, connected: Boolean(input.monitorSnapshot?.serialConnected) },
    busy: redactObject(input.busy ?? {}, notes),
    ...(renderer ? { renderer } : {}),
    logs,
    redaction: {
      droppedKeys: [...notes].filter((item) => item.startsWith("dropped-key:")).map((item) => item.slice("dropped-key:".length)),
      actions: [...notes].filter((item) => !item.startsWith("dropped-key:")),
      excludedByDesign: [
        "固件原始字节（从不读取；转储与 Buffer 记为 <BINARY>）",
        "固件能力令牌 / 认证令牌（整段删除，不保留前缀）",
        "密码、Cookie、Authorization、URL 查询凭证",
        "用户主目录、Windows/UNC 绝对路径（改为 <PATH>/文件名，不保留用户名）",
        "完整 SHA256（仅明确的摘要截断为前 12 位）",
      ],
      logLineLimit: MAX_DIAGNOSTIC_LOG_LINES,
      byteLimit: MAX_DIAGNOSTIC_BYTES,
      truncated: false,
      droppedLogLines: 0,
    },
  };
  fitBudget(report);
  return report;
}

export function suggestDiagnosticFileName(report, prefix = "ws63-diagnostic") {
  const version = report?.app?.version || "unknown";
  const stamp = String(report?.generatedAt ?? new Date().toISOString())
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  return `${prefix}-${version}-${stamp}.json`;
}

export function serializeDiagnosticReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}
