/**
 * 传输层测试夹具（W29-02 / W29-03）。
 *
 * 刻意**不改动** test/fixtures.mjs 里的 FakeDevice：那台“设备”的协议行为是既有约定，
 * 不允许为了让新实现通过测试而调整它。这里只提供一个新的**端口**层替身：
 * 一个真实的 EventEmitter，接口与 serialport 一致，用来驱动**真实 SerialSession**。
 */

import { EventEmitter } from "node:events";

/**
 * serialport 兼容的假端口。
 * - `on/off/emit` 来自 EventEmitter，因此 SerialSession 的监听是真的。
 * - 所有回调式 API 都异步回调（nextTick），贴近真实串口行为。
 * - `open` 可以在打开过程中就发数据（复现“打开时即到数据”的窗口）。
 */
export class FakeSerialPort extends EventEmitter {
  /**
   * @param {{
   *   path?: string, baudRate?: number, autoOpen?: boolean,
   *   onOpen?: (port: FakeSerialPort) => void,
   *   onSet?: (opts: any, port: FakeSerialPort) => void,
   *   onUpdate?: (opts: any, port: FakeSerialPort) => void,
   *   onWrite?: (data: Buffer, port: FakeSerialPort) => void,
   *   openError?: Error | null,
   *   setError?: Error | null,
   *   updateError?: Error | null,
   *   writeError?: Error | null,
   *   hangOpen?: boolean, hangSet?: boolean, hangUpdate?: boolean, hangClose?: boolean,
   * }} opts
   */
  constructor(opts = {}) {
    super();
    this.path = opts.path ?? "COM9";
    this.baudRate = opts.baudRate ?? 115200;
    this.isOpen = Boolean(opts.autoOpen);
    this.opts = opts;
    this.paused = false;
    this.writes = [];
    this.updates = [];
    this.sets = [];
    this.closeCalls = 0;
    this.openCalls = 0;
  }

  open(cb) {
    this.openCalls += 1;
    if (this.opts.hangOpen) return; // 故意不回调，测试 deadline
    queueMicrotask(() => {
      if (this.opts.openError) {
        cb?.(this.opts.openError);
        return;
      }
      this.isOpen = true;
      // 打开过程中设备就可能已经发了字节
      this.opts.onOpen?.(this);
      cb?.(null);
    });
  }

  set(opts, cb) {
    this.sets.push(opts);
    if (this.opts.hangSet) return;
    queueMicrotask(() => {
      if (this.opts.onSet) this.opts.onSet(opts, this);
      cb?.(this.opts.setError ?? null);
    });
  }

  update(opts, cb) {
    this.updates.push(opts);
    if (this.opts.hangUpdate) return;
    queueMicrotask(() => {
      if (!this.opts.updateError && opts?.baudRate) this.baudRate = opts.baudRate;
      this.opts.onUpdate?.(opts, this);
      cb?.(this.opts.updateError ?? null);
    });
  }

  close(cb) {
    this.closeCalls += 1;
    if (this.opts.hangClose) return;
    queueMicrotask(() => {
      this.isOpen = false;
      this.emit("close");
      cb?.(null);
    });
  }

  flush(cb) {
    cb?.(null);
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  write(data, cb) {
    const buf = Buffer.from(data);
    this.writes.push(buf);
    queueMicrotask(() => {
      if (this.opts.writeError) {
        cb?.(this.opts.writeError);
        return;
      }
      this.opts.onWrite?.(buf, this);
      cb?.(null);
    });
  }

  /** 从“设备”往主机推字节（可任意切分）。 */
  emitData(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!buf.length) return;
    this.emit("data", buf);
  }

  /** 模拟 USB 被拔出：先发 error 再发 close。 */
  unplug(error = new Error("device disconnected")) {
    this.emit("error", error);
    queueMicrotask(() => {
      this.isOpen = false;
      this.emit("close");
    });
  }
}

/**
 * 按给定切分点把一个 Buffer 切成多片，用于覆盖“每一个切分边界”。
 * @param {Buffer} buf
 * @param {number[]} points 递增的切分位置（0 < p < len）
 */
export function splitAt(buf, points) {
  const sorted = [...new Set(points)].filter((p) => p > 0 && p < buf.length).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of sorted) {
    out.push(buf.subarray(prev, p));
    prev = p;
  }
  out.push(buf.subarray(prev));
  return out;
}

/** 在下一个 macrotask 里推入这些分片（模拟跨 read 分片到达）。 */
export function emitChunksLater(port, chunks, { gapMs = 0 } = {}) {
  let delay = gapMs;
  for (const chunk of chunks) {
    setTimeout(() => port.emitData(chunk), delay);
    delay += gapMs;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
