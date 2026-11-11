import fs from "fs";
import path from "path";
import crypto from "crypto";
import { calcCrc16 } from "./crc.js";

/**
 * fwpkg 解析 + 校验 + 文件快照。
 *
 * 设计要点（W01/W08）：
 * - 校验全部在“打开串口之前”完成：包头/信息区/CRC、总长、每段 range、长度合法性、
 *   必要分区、分区文件区间重叠、烧录区间重叠、格式约束、最大包尺寸。
 * - 只读取包头做解析（不再整包 readFileSync 全量常驻）；整体摘要用流式读分块计算。
 * - 同一 (路径, 大小, mtime) 的校验结果与摘要被缓存并冻结，10 路复用同一份不可变结果。
 * - 烧录时用 openFirmwareReader() 打开句柄并校验快照身份（fstat 大小/mtime），
 *   避免“预览后被替换”的 TOCTOU。
 */

/** 单个固件包上限：超过直接拒绝，避免任意大文件进主进程。 */
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
/** 单个分区数据上限。 */
export const MAX_PARTITION_BYTES = 32 * 1024 * 1024;
/** 信息区最大分区数（格式约束）。 */
export const MAX_PARTITION_CNT = 16;

const BIN_INFO_SIZE = 32 + 5 * 4;
const HEAD_HEADER_SIZE = 12;
const PART_NAME_FIELD = 32; // 含结尾 NUL
const MAX_PART_NAME_LEN = PART_NAME_FIELD - 1;
const TYPE_LOADER = 0;
const TYPE_APP = 1;
const KNOWN_TYPES = new Set([TYPE_LOADER, TYPE_APP]);
const DIGEST_CHUNK = 1024 * 1024;
const CACHE_LIMIT = 16;

export class FwPkgError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "FwPkgError";
    this.code = code;
    this.detail = detail;
  }
}

/** @type {Map<string, {path: string, size: number, mtimeMs: number, sha256: string, meta: any, warnings: string[]}>} */
const inspectCache = new Map();

function cacheKey(realPath, size, mtimeMs, ctimeMs = 0) {
  // ctime 也进键：同大小同 mtime 的替换至少会让 ctime 变，能多挡一层陈旧缓存。
  // 但真正的内容身份保证在 stable-snapshot.js，不依赖这个键。
  return `${realPath}|${size}|${mtimeMs}|${ctimeMs}`;
}

function cachePut(key, value) {
  if (inspectCache.size >= CACHE_LIMIT) {
    const first = inspectCache.keys().next();
    if (!first.done) inspectCache.delete(first.value);
  }
  inspectCache.set(key, value);
}

export function clearFwpkgCache() {
  inspectCache.clear();
}

function readExact(fd, buffer, position) {
  let done = 0;
  while (done < buffer.length) {
    const n = fs.readSync(fd, buffer, done, buffer.length - done, position + done);
    if (n <= 0) {
      throw new FwPkgError("FWPKG_SHORT_READ", "固件包头读取不完整");
    }
    done += n;
  }
  return buffer;
}

function hashFd(fd, size) {
  const hash = crypto.createHash("sha256");
  const chunk = Buffer.alloc(Math.min(DIGEST_CHUNK, Math.max(size, 1)));
  let pos = 0;
  while (pos < size) {
    const want = Math.min(chunk.length, size - pos);
    let done = 0;
    while (done < want) {
      const n = fs.readSync(fd, chunk, done, want - done, pos + done);
      if (n <= 0) throw new FwPkgError("FWPKG_SHORT_READ", "固件读取提前结束");
      done += n;
    }
    hash.update(chunk.subarray(0, want));
    pos += want;
  }
  return hash.digest("hex");
}

function decodeName(raw) {
  const nul = raw.indexOf(0);
  const slice = nul >= 0 ? raw.subarray(0, nul) : raw;
  // 名称字段必须是可打印 ASCII；出现非可打印字节说明偏移/格式已错位。
  for (const byte of slice) {
    if (byte < 0x20 || byte > 0x7e) {
      throw new FwPkgError("FWPKG_BAD_PART_NAME", "分区名包含不可打印字符");
    }
  }
  const name = slice.toString("latin1").trim();
  if (!name) throw new FwPkgError("FWPKG_EMPTY_PART_NAME", "分区名为空");
  if (name.length > MAX_PART_NAME_LEN) {
    // ymodem 信息块固定 32 字节名域，超长会把长度字段写坏
    throw new FwPkgError("FWPKG_BAD_PART_NAME", `分区名超过 ${MAX_PART_NAME_LEN} 字节: ${name}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new FwPkgError("FWPKG_BAD_PART_NAME", `分区名含非法字符: ${name}`);
  }
  return name;
}

/**
 * 只读取包头 + 信息区并做基础解析（不做跨段校验）。
 * @param {number} fd
 * @param {number} fileSize
 */
function parseHeaderFromFd(fd, fileSize) {
  if (fileSize < HEAD_HEADER_SIZE) {
    throw new FwPkgError("FWPKG_TRUNCATED", "固件包头不完整");
  }
  const head = readExact(fd, Buffer.alloc(HEAD_HEADER_SIZE), 0);
  const magic = head.readUInt32LE(0);
  if (magic !== 0xefbeaddf) {
    throw new FwPkgError("FWPKG_BAD_MAGIC", "无效的 fwpkg 魔数");
  }
  const crc = head.readUInt16LE(4);
  const cnt = head.readUInt16LE(6);
  const length = head.readUInt32LE(8);

  if (cnt <= 0) throw new FwPkgError("FWPKG_NO_PARTITION", "固件包没有分区信息");
  if (cnt > MAX_PARTITION_CNT) throw new FwPkgError("FWPKG_TOO_MANY_PARTITIONS", "分区数量超出上限");

  const headerSize = HEAD_HEADER_SIZE + cnt * BIN_INFO_SIZE;
  if (fileSize < headerSize) {
    throw new FwPkgError("FWPKG_TRUNCATED", "固件包信息区不完整");
  }

  const body = readExact(fd, Buffer.alloc(headerSize - 6), 6);
  const crcCheck = calcCrc16(body);
  if (crcCheck !== crc) {
    throw new FwPkgError("FWPKG_BAD_CRC", "固件包 CRC 校验失败");
  }

  const binInfos = [];
  let offset = HEAD_HEADER_SIZE;
  for (let i = 0; i < cnt; i += 1) {
    const name = decodeName(body.subarray(offset - 6, offset - 6 + PART_NAME_FIELD));
    const partOffset = body.readUInt32LE(offset - 6 + 32);
    const partLength = body.readUInt32LE(offset - 6 + 36);
    const burnAddr = body.readUInt32LE(offset - 6 + 40);
    const burnSize = body.readUInt32LE(offset - 6 + 44);
    const type = body.readUInt32LE(offset - 6 + 48);
    binInfos.push({
      name,
      offset: partOffset,
      length: partLength,
      burn_addr: burnAddr,
      burn_size: burnSize,
      type,
    });
    offset += BIN_INFO_SIZE;
  }

  return {
    magic,
    crc,
    cnt,
    length,
    headerSize,
    fileSize,
    binInfos,
  };
}

function add32(a, b) {
  const sum = a + b;
  if (sum > 0xffffffff) {
    throw new FwPkgError("FWPKG_RANGE_OVERFLOW", "分区地址/长度溢出 32 位");
  }
  return sum;
}

/**
 * 跨段校验：总长、每段范围、长度合法性、必要分区、重叠、格式约束。
 * 只做“确实能判定为坏包”的检查；不猜测目标固件地址白名单。
 */
export function validateFwpkgMeta(meta) {
  const warnings = [];
  const { fileSize, headerSize, binInfos } = meta;

  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new FwPkgError("FWPKG_EMPTY", "固件文件为空");
  }
  if (fileSize > MAX_PACKAGE_BYTES) {
    throw new FwPkgError(
      "FWPKG_TOO_LARGE",
      `固件包过大（${fileSize} 字节，上限 ${MAX_PACKAGE_BYTES}）`,
    );
  }

  // 头部声明总长：大于实际文件长度 = 被截断；小于信息区 = 明显错误。
  let container = fileSize;
  if (meta.length !== 0) {
    if (meta.length > fileSize) {
      throw new FwPkgError(
        "FWPKG_TRUNCATED",
        `固件包被截断：声明长度 ${meta.length} 字节，实际 ${fileSize} 字节`,
      );
    }
    if (meta.length < headerSize) {
      throw new FwPkgError("FWPKG_BAD_TOTAL_LENGTH", "固件包声明总长小于信息区长度");
    }
    if (meta.length < fileSize) {
      warnings.push(`声明总长 ${meta.length} 小于文件长度 ${fileSize}，按声明总长校验分区`);
      container = meta.length;
    }
  } else {
    warnings.push("固件包未声明总长，按实际文件长度校验分区");
  }

  let loaderCount = 0;
  let appCount = 0;
  let totalPartBytes = 0;
  const seenNames = new Set();

  for (const part of binInfos) {
    if (!KNOWN_TYPES.has(part.type)) {
      throw new FwPkgError(
        "FWPKG_UNSUPPORTED_TYPE",
        `分区 ${part.name} 的类型 ${part.type} 不受支持（仅支持 0=loaderboot / 1=应用）`,
      );
    }
    if (part.type === TYPE_LOADER) loaderCount += 1;
    else appCount += 1;

    if (!Number.isInteger(part.length) || part.length <= 0) {
      throw new FwPkgError("FWPKG_BAD_PART_LENGTH", `分区 ${part.name} 长度为 0`);
    }
    if (part.length > MAX_PARTITION_BYTES) {
      throw new FwPkgError(
        "FWPKG_PART_TOO_LARGE",
        `分区 ${part.name} 过大（${part.length} 字节，上限 ${MAX_PARTITION_BYTES}）`,
      );
    }
    if (part.offset < headerSize) {
      throw new FwPkgError(
        "FWPKG_BAD_PART_OFFSET",
        `分区 ${part.name} 偏移 ${part.offset} 落在包头/信息区内`,
      );
    }
    const end = add32(part.offset, part.length);
    if (end > container) {
      throw new FwPkgError(
        "FWPKG_OUT_OF_RANGE",
        `分区 ${part.name} 数据区间 ${part.offset}..${end} 超出固件包（${container} 字节）`,
      );
    }
    add32(part.burn_addr, Math.max(part.burn_size, part.length));

    if (part.burn_size !== 0 && part.burn_size < part.length) {
      warnings.push(
        `分区 ${part.name} 的 burn_size(${part.burn_size}) 小于数据长度(${part.length})`,
      );
    }
    if (seenNames.has(part.name)) {
      warnings.push(`分区名重复: ${part.name}`);
    }
    seenNames.add(part.name);
    totalPartBytes += part.length;
  }

  if (loaderCount === 0) {
    throw new FwPkgError("FWPKG_NO_LOADER", "固件包中未找到 loaderboot 分区（type=0）");
  }
  if (loaderCount > 1) {
    throw new FwPkgError("FWPKG_DUP_LOADER", "固件包中存在多个 loaderboot 分区（type=0）");
  }
  if (appCount === 0) {
    warnings.push("固件包中只有 loaderboot 分区，没有应用分区");
  }
  if (totalPartBytes > MAX_PACKAGE_BYTES) {
    throw new FwPkgError("FWPKG_TOO_LARGE", "分区数据总量超出上限");
  }

  // 文件数据区间重叠：一定是坏包。
  const byFileRange = [...binInfos].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < byFileRange.length; i += 1) {
    const prev = byFileRange[i - 1];
    const cur = byFileRange[i];
    if (prev.offset + prev.length > cur.offset) {
      throw new FwPkgError(
        "FWPKG_OVERLAP",
        `分区 ${prev.name} 与 ${cur.name} 的文件数据区间重叠`,
      );
    }
  }

  // 烧录地址区间重叠（只在能确定的情况下判定：按数据长度比较）。
  const byBurn = [...binInfos].sort((a, b) => a.burn_addr - b.burn_addr);
  for (let i = 1; i < byBurn.length; i += 1) {
    const prev = byBurn[i - 1];
    const cur = byBurn[i];
    if (prev.burn_addr + prev.length > cur.burn_addr) {
      throw new FwPkgError(
        "FWPKG_BURN_OVERLAP",
        `分区 ${prev.name} 与 ${cur.name} 的烧录地址区间重叠`,
      );
    }
  }

  return warnings;
}

/**
 * 兼容旧签名：解析并校验，返回 meta（含 warnings）。
 * @param {string} filePath
 */
export function parseFwpkg(filePath) {
  return inspectFwpkg(filePath).meta;
}

/**
 * 从已打开的文件句柄构建冻结快照（解析包头 + 跨段校验）。
 * `sha256` 由调用方给出——它必须是对**同一句柄**算出来的摘要
 * （stable-snapshot.js 在复制的同时计算，避免"校验的文件"与"读取的文件"不是同一份字节）。
 *
 * @param {number} fd
 * @param {{path: string, size: number, mtimeMs?: number, sha256: string}} opts
 */
export function buildSnapshotFromFd(fd, opts) {
  const { path: filePath, size, mtimeMs = 0, sha256 } = opts;
  const meta = parseHeaderFromFd(fd, size);
  const warnings = validateFwpkgMeta(meta);
  /** @type {any} */
  const result = {
    path: filePath,
    size,
    mtimeMs,
    sha256,
    meta: {
      magic: meta.magic,
      crc: meta.crc,
      cnt: meta.cnt,
      length: meta.length,
      headerSize: meta.headerSize,
      fileSize: meta.fileSize,
      binInfos: meta.binInfos.map((p) => Object.freeze({ ...p })),
      warnings: Object.freeze([...warnings]),
    },
    warnings: Object.freeze([...warnings]),
  };
  Object.freeze(result.meta);
  Object.freeze(result);
  return result;
}

/**
 * 校验 + 摘要，带 (路径, 大小, mtime, ctime) 缓存；返回值已冻结，可跨 10 路复用。
 *
 * 注意边界：**这个缓存只用于预览/展示**。真正的烧录前内容身份校验在
 * `stable-snapshot.js`（对实际使用的句柄流式算摘要 + 复制出不可变副本），
 * 所以同大小同 mtime 的替换不会让烧录用到旧摘要。
 * @param {string} filePath
 */
export function inspectFwpkg(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new FwPkgError("FWPKG_BAD_PATH", "固件路径无效");
  }
  const abs = path.resolve(filePath);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new FwPkgError("FWPKG_NOT_FOUND", "固件文件不存在或不可读");
  }
  if (!stat.isFile()) {
    throw new FwPkgError("FWPKG_NOT_FILE", "固件路径不是普通文件");
  }
  if (stat.size <= 0) {
    throw new FwPkgError("FWPKG_EMPTY", "固件文件为空");
  }
  if (stat.size > MAX_PACKAGE_BYTES) {
    throw new FwPkgError(
      "FWPKG_TOO_LARGE",
      `固件包过大（${stat.size} 字节，上限 ${MAX_PACKAGE_BYTES}）`,
    );
  }

  const key = cacheKey(abs, stat.size, stat.mtimeMs, stat.ctimeMs);
  const cached = inspectCache.get(key);
  if (cached) return cached;

  const fd = fs.openSync(abs, "r");
  try {
    const sha256 = hashFd(fd, stat.size);
    const result = buildSnapshotFromFd(fd, {
      path: abs,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256,
    });
    cachePut(key, result);
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 打开与快照绑定一致的读取句柄；大小/mtime 不一致即拒绝（防预览后被替换）。
 * @param {{path: string, size: number, mtimeMs: number, sha256: string}} snapshot
 */
export function openFirmwareReader(snapshot) {
  if (!snapshot?.path) throw new FwPkgError("FWPKG_BAD_PATH", "固件快照无效");
  const fd = fs.openSync(snapshot.path, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size !== snapshot.size || Math.abs(stat.mtimeMs - snapshot.mtimeMs) > 1) {
      throw new FwPkgError(
        "FWPKG_CHANGED",
        "固件文件在预览后被修改，请重新选择固件",
      );
    }
    // R5：size/mtime 相同不代表内容相同。这里对**实际打开句柄**重算摘要并比对，
    // 否则「同大小同 mtime 替换」会让我们返回旧摘要却读取新字节。
    // 注意：这是同步整文件哈希，会占用调用线程；烧录主路径用 stable-snapshot.js
    // 的异步复制版本，避免阻塞主进程（W29-11）。
    if (typeof snapshot.sha256 === "string" && snapshot.sha256) {
      const actual = hashFd(fd, stat.size);
      if (actual !== snapshot.sha256) {
        throw new FwPkgError(
          "FWPKG_CHANGED",
          "固件文件内容与预览摘要不一致（文件被替换或修改），请重新选择固件",
        );
      }
    }
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }

  let closed = false;
  return {
    fd,
    size: snapshot.size,
    sha256: snapshot.sha256,
    /** 读取指定区间；读不满直接抛错（绝不补零）。 */
    read(offset, length) {
      if (closed) throw new FwPkgError("FWPKG_READER_CLOSED", "固件句柄已关闭");
      if (!Number.isInteger(offset) || !Number.isInteger(length) || length <= 0) {
        throw new FwPkgError("FWPKG_BAD_READ", "固件读取参数非法");
      }
      if (offset < 0 || offset + length > snapshot.size) {
        throw new FwPkgError(
          "FWPKG_OUT_OF_RANGE",
          `固件读取越界: ${offset}+${length} > ${snapshot.size}`,
        );
      }
      const buf = Buffer.alloc(length);
      readExact(fd, buf, offset);
      return buf;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    },
  };
}

export function describeFwpkg(meta) {
  const lines = [
    `分区数量: ${meta.cnt}`,
    `包总长度: 0x${meta.length.toString(16).toUpperCase().padStart(8, "0")}`,
    "-".repeat(72),
    `${"类型".padEnd(6)} ${"名称".padEnd(24)} ${"大小".padEnd(12)} 烧录地址`,
    "-".repeat(72),
  ];
  for (const part of meta.binInfos) {
    const flag = part.type === 0 ? "BOOT" : "APP ";
    lines.push(
      `${flag.padEnd(6)} ${part.name.padEnd(24)} 0x${part.length
        .toString(16)
        .toUpperCase()
        .padStart(8, "0")}  0x${part.burn_addr
        .toString(16)
        .toUpperCase()
        .padStart(8, "0")}`,
    );
  }
  for (const warning of meta.warnings ?? []) {
    lines.push(`警告: ${warning}`);
  }
  return lines;
}
