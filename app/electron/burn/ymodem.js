import { calcCrc16 } from "./crc.js";

/**
 * YMODEM 发送端（WS63 bootrom 载荷协议）。
 *
 * 关键约束（W01/W02/W29-03）：
 * - 数据来源是 fwpkg 快照句柄（reader.read 保证读满），读不满/读越界直接失败，
 *   绝不再用零填充把短读“补成”一帧发出去。
 * - 没有收到 'C' 不得发送信息块；等待 'C' 有明确上限，失败返回结构化失败码。
 * - 每个阶段（信息块 / 数据块 / EOT / 结束块）都有独立成功条件、超时与重试上限。
 * - **读取异常不再一律吞掉**：只有“这一片超时”才继续等；端口关闭 / IO 故障 /
 *   取消 / 接收缓冲溢出必须立刻结束（旧实现会让拔线后的流程空转满整段超时）。
 * - 返回 { ok, code, stage, message }，不再用裸 boolean 丢失失败原因。
 */

const SOH = 0x01;
const STX = 0x02;
const EOT = 0x04;
const ACK = 0x06;
const NAK = 0x15;
const CAN = 0x18;
const C = "C".charCodeAt(0);

export const DEFAULT_YM_TIMING = Object.freeze({
  cTimeout: 5000,
  ackTimeout: 1500,
  xmitTimeout: 30000,
  eotTimeout: 15000,
  cWaitAfterInfo: 1200,
  maxBlockRetries: 10,
  /** 单次写入的有限等待（R2）。 */
  writeTimeout: 5000,
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 统一的“读一个字节”封装：区分超时（继续等）与硬失败（立刻返回）。
 * @returns {Promise<{kind: 'byte'|'timeout'|'stop'|'PORT_CLOSED'|'IO_ERROR'|'RX_OVERFLOW'|'ABORTED', byte?: number, error?: any}>}
 */
async function readByteStep(session, timeoutMs, stopSignal) {
  if (stopSignal?.aborted) return { kind: "stop" };
  if ((session?.overflow?.events ?? 0) > 0) return { kind: "RX_OVERFLOW" };
  try {
    const byte = await session.readByte(Math.max(20, Math.min(200, timeoutMs)));
    return { kind: "byte", byte };
  } catch (err) {
    const code = err?.code;
    if (code === "PORT_CLOSED") return { kind: "PORT_CLOSED", error: err };
    if (code === "IO_ERROR") return { kind: "IO_ERROR", error: err };
    if (code === "ABORTED") return { kind: "stop", error: err };
    if (code === "READ_TIMEOUT") return { kind: "timeout", error: err };
    // 兼容旧式/Fake 会话的纯文本超时；其它无码异常按 IO 故障处理
    if (err instanceof Error && /读取超时|read\s*timeout/i.test(err.message)) {
      return { kind: "timeout", error: err };
    }
    return { kind: "IO_ERROR", error: err };
  }
}

function fatalCode(kind) {
  if (kind === "PORT_CLOSED") return "PORT_CLOSED";
  if (kind === "IO_ERROR") return "IO_ERROR";
  if (kind === "RX_OVERFLOW") return "RX_OVERFLOW";
  return "STOPPED";
}

/** @returns {Promise<'ack'|'nak'|'cancelled'|'timeout'|'c'|'stop'|'PORT_CLOSED'|'IO_ERROR'|'RX_OVERFLOW'>} */
async function waitByte(session, wanted, timeoutMs, stopSignal) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const step = await readByteStep(session, timeoutMs, stopSignal);
    if (step.kind === "timeout") continue;
    if (step.kind === "byte") {
      const byte = step.byte;
      if (byte === ACK) return "ack";
      if (byte === NAK) return "nak";
      if (byte === CAN) return "cancelled";
      if (byte === C && wanted === "c") return "c";
      continue;
    }
    if (step.kind === "stop") return "stop";
    return step.kind;
  }
  return "timeout";
}

/** 只等 'C'，忽略其它字节（对端可能先回 ACK/垃圾字节）。 */
async function waitForC(session, timeoutMs, stopSignal) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const step = await readByteStep(session, timeoutMs, stopSignal);
    if (step.kind === "timeout") continue;
    if (step.kind === "byte") {
      if (step.byte === C) return "c";
      if (step.byte === CAN) return "cancelled";
      continue;
    }
    if (step.kind === "stop") return "stop";
    return step.kind;
  }
  return "timeout";
}

/** 把非 ACK 的等待结果映射成结构化失败（含新增的硬失败码）。 */
function waitFailure(res, stage) {
  if (res === "stop") return { ok: false, code: "STOPPED", stage };
  if (res === "cancelled") return { ok: false, code: "PEER_CANCEL", stage };
  if (res === "PORT_CLOSED" || res === "IO_ERROR" || res === "RX_OVERFLOW") {
    return { ok: false, code: fatalCode(res), stage };
  }
  return null;
}

/**
 * 有界、可取消的写入（R2）：驱动 callback 丢失时不能把传输挂死。
 * @returns {Promise<{ok: boolean, code?: string, error?: any}>}
 */
async function writeStep(session, data, timing, stopSignal, stage) {
  if (stopSignal?.aborted) return { ok: false, code: "STOPPED", stage };
  try {
    await session.write(data, {
      timeoutMs: timing.writeTimeout,
      stopSignal,
    });
    return { ok: true };
  } catch (err) {
    const code = err?.code;
    if (code === "ABORTED") return { ok: false, code: "STOPPED", stage, error: err };
    if (code === "PORT_CLOSED") return { ok: false, code: "PORT_CLOSED", stage, error: err };
    if (code === "WRITE_TIMEOUT") return { ok: false, code: "WRITE_TIMEOUT", stage, error: err };
    return { ok: false, code: "IO_ERROR", stage, error: err };
  }
}

async function xmitBlock(session, block, timing, stopSignal, stage) {
  for (let attempt = 0; attempt < timing.maxBlockRetries; attempt += 1) {
    if (stopSignal?.aborted) return { ok: false, code: "STOPPED", stage };
    const written = await writeStep(session, block, timing, stopSignal, stage);
    if (!written.ok) return written;
    const res = await waitByte(session, "ack", timing.ackTimeout, stopSignal);
    if (res === "ack") return { ok: true };
    const failure = waitFailure(res, stage);
    if (failure) return failure;
    if (res === "nak") continue;
    // timeout: 重发（受 maxBlockRetries 约束）
  }
  return { ok: false, code: "ACK_TIMEOUT", stage };
}

function buildInfoBlock(fileName, fileSize) {
  const infoBlock = Buffer.alloc(133);
  infoBlock[0] = SOH;
  infoBlock[1] = 0x00;
  infoBlock[2] = 0xff;
  const nameBuf = Buffer.from(fileName, "latin1");
  if (nameBuf.length > 31) throw new Error("分区名过长，无法写入 YMODEM 信息块");
  nameBuf.copy(infoBlock, 3);
  Buffer.from(String(fileSize), "latin1").copy(infoBlock, 3 + nameBuf.length + 1);
  const infoCrc = calcCrc16(infoBlock.subarray(3, 131));
  infoBlock.writeUInt16BE(infoCrc, 131);
  return infoBlock;
}

/**
 * @param {{ read(offset: number, length: number): Buffer }} source 固件快照读取器
 * @param {{name: string, offset: number, length: number}} part
 * @param {(current: number, total: number, name: string) => void} [onProgress]
 * @param {AbortSignal} [stopSignal]
 * @param {Partial<typeof DEFAULT_YM_TIMING>} [timing]
 */
export async function ymodemXfer(session, source, part, onProgress, stopSignal, timingInput) {
  const timing = { ...DEFAULT_YM_TIMING, ...(timingInput || {}) };
  const fileSize = part.length;
  const fileName = part.name;
  const offset = part.offset;

  if (!Number.isInteger(fileSize) || fileSize <= 0) {
    return { ok: false, code: "BAD_PART", stage: "info", message: "分区长度为 0" };
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return { ok: false, code: "BAD_PART", stage: "info", message: "分区偏移非法" };
  }

  // 阶段 1：必须有 'C' 才发信息块（没有 C = 对端没准备好，明确失败）
  const cWait = await waitForC(session, timing.cTimeout, stopSignal);
  if (cWait === "stop") return { ok: false, code: "STOPPED", stage: "wait_c" };
  if (cWait === "cancelled") return { ok: false, code: "PEER_CANCEL", stage: "wait_c" };
  if (cWait === "PORT_CLOSED" || cWait === "IO_ERROR" || cWait === "RX_OVERFLOW") {
    return {
      ok: false,
      code: fatalCode(cWait),
      stage: "wait_c",
      message: cWait === "RX_OVERFLOW" ? "等待 'C' 期间接收缓冲溢出" : "等待 'C' 期间串口连接中断",
    };
  }
  if (cWait !== "c") {
    return {
      ok: false,
      code: "NO_C",
      stage: "wait_c",
      message: `等待设备 'C' 超时（${timing.cTimeout}ms），设备未进入接收状态`,
    };
  }

  // 阶段 2：信息块
  const infoRes = await xmitBlock(
    session,
    buildInfoBlock(fileName, fileSize),
    timing,
    stopSignal,
    "info",
  );
  if (!infoRes.ok) {
    return { ...infoRes, message: `信息块未被确认（${infoRes.code}）` };
  }

  // 阶段 3：数据块。对端若在信息块 ACK 后再次发 'C' 会被后续 ACK 等待自然吞掉，
  // 这里不额外阻塞（保持原有对时延的要求）。
  const totalBlk = Math.ceil(fileSize / 1024);

  for (let iBlk = 1; iBlk <= totalBlk; iBlk += 1) {
    if (stopSignal?.aborted) return { ok: false, code: "STOPPED", stage: "data" };

    const rlen = iBlk === totalBlk ? fileSize - (iBlk - 1) * 1024 : 1024;
    let chunk;
    try {
      // 读不满 / 越界直接抛错，不再零填充
      chunk = source.read(offset + (iBlk - 1) * 1024, rlen);
    } catch (err) {
      return {
        ok: false,
        code: err?.code || "SHORT_READ",
        stage: "data",
        message: `固件读取失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!chunk || chunk.length !== rlen) {
      return {
        ok: false,
        code: "SHORT_READ",
        stage: "data",
        message: `固件读取不足：期望 ${rlen} 字节，实际 ${chunk?.length ?? 0}`,
      };
    }

    const block = Buffer.alloc(3 + 1024 + 2);
    block[0] = STX;
    block[1] = iBlk & 0xff;
    block[2] = 0xff - block[1];
    chunk.copy(block, 3);
    const crc = calcCrc16(block.subarray(3, 3 + 1024));
    block.writeUInt16BE(crc, 3 + 1024);

    const res = await xmitBlock(session, block, timing, stopSignal, "data");
    if (!res.ok) {
      return { ...res, message: `块 ${iBlk}/${totalBlk} 未被确认（${res.code}）` };
    }
    if (onProgress) onProgress(iBlk, totalBlk, fileName);
  }

  // 阶段 4：EOT（对端可能回 NAK 再回 ACK，属于标准行为）
  const eotDeadline = Date.now() + timing.eotTimeout;
  let eotAcked = false;
  while (Date.now() < eotDeadline) {
    if (stopSignal?.aborted) return { ok: false, code: "STOPPED", stage: "eot" };
    const written = await writeStep(session, Buffer.from([EOT]), timing, stopSignal, "eot");
    if (!written.ok) return written;
    const res = await waitByte(session, "ack", Math.min(2000, timing.ackTimeout), stopSignal);
    if (res === "ack") {
      eotAcked = true;
      break;
    }
    const failure = waitFailure(res, "eot");
    if (failure) return failure;
  }
  if (!eotAcked) {
    return { ok: false, code: "EOT_TIMEOUT", stage: "eot", message: "结束符未被确认" };
  }

  // 阶段 5：结束块（空文件名）
  await sleep(20);
  const finishBlock = Buffer.alloc(133);
  finishBlock[0] = SOH;
  finishBlock[1] = 0x00;
  finishBlock[2] = 0xff;
  const finishCrc = calcCrc16(finishBlock.subarray(3, 131));
  finishBlock.writeUInt16BE(finishCrc, 131);
  const finishRes = await xmitBlock(session, finishBlock, timing, stopSignal, "finish");
  if (!finishRes.ok) {
    return { ...finishRes, message: `结束块未被确认（${finishRes.code}）` };
  }

  return { ok: true, code: "OK", stage: "done", blocks: totalBlk, bytes: fileSize };
}
