/**
 * WS63 bootrom 应答帧的增量解析器（W02 / W29-04 / W29-08）。
 *
 * 设备应答帧：EF BE AD DE | len(u16 LE) | cmd | ~cmd | data... | crc16(u16 LE)
 * - len 覆盖整个帧（从 magic 到 crc）。
 * - 物理最小帧长 = magic(4) + len(2) + cmd(1) + ~cmd(1) + crc(2) = **10**。
 *   旧实现写 8，等于允许“CRC 字段和 cmd/~cmd 重叠”的帧通过长度门槛，
 *   属于协议真伪问题（本次修正为 10）。
 * - 解析器跨 read 保留“半帧”，因此跨分片到达的 ACK 不会丢。
 * - 帧结构坏（长度越界 / cmd 反码不匹配 / CRC 不符）就丢一个字节重新同步，
 *   并累计 badFrames，供上层判断“设备回了东西但都是坏帧”。
 * - 缓冲一旦溢出必须计数（`overflowBytes`），`readFrame` 会据此判 RX_OVERFLOW，
 *   不允许“丢字节后继续声称可靠”。
 * - `takePending()` 把未消费字节交还上层，用于阶段切换时不丢失已到达的后续字节。
 */

import { calcCrc16 } from "./crc.js";
import { SERIAL_ERROR_CODE, classifyReadError } from "./serial-session.js";

export { classifyReadError };

const MAGIC = [0xef, 0xbe, 0xad, 0xde];
const MAGIC_BUF = Buffer.from(MAGIC);
/** magic + len + cmd + ~cmd + crc */
export const MIN_FRAME = 10;
export const MAX_FRAME = 2048;
export const MAX_BUFFER = MAX_FRAME * 4;

export class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.badFrames = 0;
    this.skippedBytes = 0;
    this.framesSeen = 0;
    /** 缓冲溢出字节数（>0 表示有字节被丢弃，协议不能再声称可靠）。 */
    this.overflowBytes = 0;
  }

  push(chunk) {
    if (chunk == null) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from([chunk]);
    if (!bytes.length) return;

    // 单个 chunk 就可能超过上限（已复现 1 MiB）：先裁自身，再裁旧数据。
    let incoming = bytes;
    if (incoming.length > MAX_BUFFER) {
      const dropped = incoming.length - MAX_BUFFER;
      this.overflowBytes += dropped;
      this.skippedBytes += dropped;
      incoming = incoming.subarray(dropped);
    }
    if (this.buf.length + incoming.length > MAX_BUFFER) {
      const keep = Math.max(0, MAX_BUFFER - incoming.length);
      const dropped = this.buf.length - keep;
      if (dropped > 0) {
        this.overflowBytes += dropped;
        this.skippedBytes += dropped;
      }
      this.buf = keep
        ? Buffer.concat([this.buf.subarray(this.buf.length - keep), incoming])
        : Buffer.from(incoming);
      return;
    }
    this.buf = this.buf.length
      ? Buffer.concat([this.buf, incoming])
      : Buffer.from(incoming);
  }

  pushByte(byte) {
    this.push(Buffer.from([byte & 0xff]));
  }

  /**
   * 交还尚未消费的缓冲（复制一份，避免调用方与解析器共享同一块内存）。
   * 用于阶段之间的字节归属移交，防止“解析成功后的剩余字节随局部变量丢失”。
   */
  takePending() {
    if (!this.buf.length) return Buffer.alloc(0);
    const out = Buffer.from(this.buf);
    this.buf = Buffer.alloc(0);
    return out;
  }

  /** 把统计并入上层累计器（长运行不丢计数、不出现负数）。 */
  mergeStatsInto(target) {
    if (!target) return target;
    target.badFrames += this.badFrames;
    target.skippedBytes += this.skippedBytes;
    target.framesSeen += this.framesSeen;
    target.overflowBytes += this.overflowBytes;
    return target;
  }

  /** 取出下一个完整且校验通过的帧；没有则返回 null（半帧被保留）。 */
  next() {
    for (;;) {
      if (this.buf.length < MAGIC.length) return null;
      const idx = this.buf.indexOf(MAGIC_BUF);
      if (idx < 0) {
        // 保留末尾可能是 magic 前缀的 1-3 字节
        const keep = Math.min(MAGIC.length - 1, this.buf.length);
        this.skippedBytes += this.buf.length - keep;
        this.buf = this.buf.subarray(this.buf.length - keep);
        return null;
      }
      if (idx > 0) {
        this.skippedBytes += idx;
        this.buf = this.buf.subarray(idx);
      }
      if (this.buf.length < 6) return null;

      const len = this.buf.readUInt16LE(4);
      if (len < MIN_FRAME || len > MAX_FRAME) {
        this.badFrames += 1;
        this.skippedBytes += 1;
        this.buf = this.buf.subarray(1);
        continue;
      }
      if (this.buf.length < len) return null; // 半帧：等更多字节

      const frameBuf = this.buf.subarray(0, len);
      const crcReceived = frameBuf.readUInt16LE(len - 2);
      const crcCalculated = calcCrc16(frameBuf.subarray(0, len - 2));
      if (crcReceived !== crcCalculated) {
        this.badFrames += 1;
        this.skippedBytes += 1;
        this.buf = this.buf.subarray(1);
        continue;
      }
      const cmd = frameBuf[6];
      const cmdCheck = frameBuf[7];
      if ((cmd ^ 0xff) !== cmdCheck) {
        this.badFrames += 1;
        this.skippedBytes += 1;
        this.buf = this.buf.subarray(1);
        continue;
      }

      this.framesSeen += 1;
      this.buf = this.buf.subarray(len);
      return {
        cmd,
        cmdCheck,
        len,
        payload: Buffer.from(frameBuf.subarray(6, len - 2)),
        raw: Buffer.from(frameBuf),
      };
    }
  }

  get pendingBytes() {
    return this.buf.length;
  }
}

/**
 * 把读取异常分类成协议层能区分的结果（W29-03）。
 * 实现在 serial-session.js，这里重新导出以保持历史引用可用。
 */

function overflowCode(session, parser) {
  const sessionOverflow = session?.overflow?.events ?? 0;
  const parserOverflow = parser?.overflowBytes ?? 0;
  if (sessionOverflow > 0 || parserOverflow > 0) {
    return {
      ok: false,
      code: "RX_OVERFLOW",
      overflow: {
        sessionEvents: sessionOverflow,
        sessionBytes: session?.overflow?.bytes ?? 0,
        parserBytes: parserOverflow,
      },
    };
  }
  return null;
}

/**
 * 从 session 读字节直到命中可接受的完整帧，或超时/停止。
 * @param {{readByte(timeoutMs: number): Promise<number>, overflow?: {events: number, bytes: number}}} session
 * @param {FrameParser} parser
 * @param {{timeoutMs: number, stopSignal?: AbortSignal, accept?: (frame: any) => boolean}} opts
 * @returns {Promise<{ok: boolean, code: string, frame?: any, rejected?: number[]}>}
 */
export async function readFrame(session, parser, opts) {
  const { timeoutMs, stopSignal, accept } = opts;
  const deadline = Date.now() + timeoutMs;
  const rejected = [];
  let badFramesAtStart = parser?.badFrames ?? 0;

  for (;;) {
    // 先把已缓冲的完整帧消费掉
    for (;;) {
      const frame = parser.next();
      if (!frame) break;
      if (!accept || accept(frame)) return { ok: true, code: "OK", frame };
      rejected.push(frame.cmd);
    }

    const over = overflowCode(session, parser);
    if (over) return { ...over, rejected, badFrames: parser.badFrames, pendingBytes: parser.pendingBytes };

    if (stopSignal?.aborted) return { ok: false, code: "STOPPED", rejected };
    const remain = deadline - Date.now();
    if (remain <= 0) {
      const totalBad = (parser?.badFrames ?? 0) - badFramesAtStart;
      return {
        ok: false,
        code: rejected.length ? "UNEXPECTED_FRAME" : totalBad > 0 ? "BAD_FRAME" : "TIMEOUT",
        rejected,
        badFrames: parser.badFrames,
        pendingBytes: parser.pendingBytes,
      };
    }
    try {
      const byte = await session.readByte(Math.max(20, Math.min(200, remain)));
      parser.pushByte(byte);
    } catch (err) {
      const kind = classifyReadError(err);
      if (kind === "timeout") continue;
      if (kind === "ABORTED") return { ok: false, code: "STOPPED", rejected, error: err };
      if (kind === "PORT_CLOSED") {
        return { ok: false, code: "PORT_CLOSED", rejected, error: err };
      }
      return { ok: false, code: "IO_ERROR", rejected, error: err };
    }
  }
}
