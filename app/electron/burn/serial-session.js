/**
 * 串口读取会话（W29-03 / W29-08）。
 *
 * 旧实现的问题（本次修复）：
 * 1. `closed` 只写不读：拔线后 `read()` 仍傻等到超时，上层空转满 60s。
 * 2. `_onError` 没有终止态：一次 IO 错误之后会话看起来仍然可用。
 * 3. `detach()` 不清等待者与 timer：等待者永远挂着。
 * 4. 上限只约束“旧数据 + 新块”，单个 1 MiB chunk 可以突破 262144 上限（已复现），
 *    且溢出被静默吞掉 —— 上层仍然声称“可靠”。
 *
 * 现在的契约：
 * - 失败一律是带 `code` 的 SerialError：
 *   READ_TIMEOUT / PORT_CLOSED / IO_ERROR / ABORTED / RX_OVERFLOW。
 * - 关闭或出错之后，`read()` / `write()` **立即**失败，不再等到超时。
 * - 溢出必然被计数（`stats.overflowEvents` / `overflowBytes`），协议层可以据此
 *   明确判失败，而不是“丢字节后继续说成功”。
 * - `markBoundary()` / `discardBefore()` 给“换波特率”这类阶段切换提供精确的字节归属，
 *   不再无条件 `drain()` 把已经到达的新波特率字节（例如 YMODEM 的 'C'）一起清掉。
 */

/** 默认接收队列上限（字节）。 */
export const MAX_RX_QUEUE = 256 * 1024;

/** 默认单次写入的有限等待（毫秒）。驱动回调丢失时不能无限挂起（R2）。 */
export const DEFAULT_WRITE_TIMEOUT_MS = 5000;

export const SERIAL_ERROR_CODE = Object.freeze({
  READ_TIMEOUT: "READ_TIMEOUT",
  WRITE_TIMEOUT: "WRITE_TIMEOUT",
  PORT_CLOSED: "PORT_CLOSED",
  IO_ERROR: "IO_ERROR",
  ABORTED: "ABORTED",
  RX_OVERFLOW: "RX_OVERFLOW",
});

export class SerialError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{cause?: unknown}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = "SerialError";
    this.code = code;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/** 会话状态：created（已绑定但未打开）→ open → closed / error。 */
const STATE = Object.freeze({
  CREATED: "created",
  OPEN: "open",
  CLOSED: "closed",
  ERROR: "error",
});

export class SerialSession {
  /**
   * @param {any} port serialport 实例或兼容对象（EventEmitter + write）
   * @param {{maxQueue?: number}} [opts]
   */
  constructor(port, opts = {}) {
    this.port = port;
    this.maxQueue = Math.max(1024, Number(opts.maxQueue) || MAX_RX_QUEUE);
    this.maxWriteTimeoutMs = Math.max(1, Number(opts.writeTimeoutMs) || DEFAULT_WRITE_TIMEOUT_MS);
    this.queue = Buffer.alloc(0);
    /** @type {Array<{count: number, resolve: Function, reject: Function, timer: any}>} */
    this.waiters = [];
    /**
     * 未完成的写入（R2）。必须和读等待者一样能被终止态统一收尾：
     * 驱动 callback 丢失时，取消/断线要能立刻结束 await write()。
     * @type {Set<{settle: (err: Error|null) => void, timer: any, onAbort: Function|null}>}
     */
    this.pendingWrites = new Set();
    this.state = STATE.CREATED;
    this.closed = false;
    this.lastError = null;
    this.stats = {
      bytesIn: 0,
      overflowEvents: 0,
      overflowBytes: 0,
      reads: 0,
      timeouts: 0,
    };
    this._paused = false;

    this._onData = (chunk) => {
      if (!chunk?.length) return;
      this.stats.bytesIn += chunk.length;
      this._append(chunk);
      this._flushWaiters();
    };
    this._onClose = () => {
      this._terminate(STATE.CLOSED, new SerialError(SERIAL_ERROR_CODE.PORT_CLOSED, "串口已关闭"));
    };
    this._onError = (err) => {
      this.lastError = err ?? null;
      this._terminate(
        STATE.ERROR,
        new SerialError(SERIAL_ERROR_CODE.IO_ERROR, `串口 IO 错误：${describe(err)}`, { cause: err }),
      );
    };

    port.on("data", this._onData);
    port.on("close", this._onClose);
    port.on("error", this._onError);
  }

  /** 打开成功后由调用方标记（也让 open 之前到达的字节不算“已关闭”）。 */
  markOpen() {
    if (this.state === STATE.CREATED) this.state = STATE.OPEN;
  }

  get overflow() {
    return { events: this.stats.overflowEvents, bytes: this.stats.overflowBytes };
  }

  get pendingBytes() {
    return this.queue.length;
  }

  _append(chunk) {
    let incoming = chunk;
    // 单个 chunk 就可能超过上限（已复现 1 MiB）：先裁自身，再裁旧数据。
    if (incoming.length > this.maxQueue) {
      const dropped = incoming.length - this.maxQueue;
      this._noteOverflow(dropped);
      incoming = incoming.subarray(dropped);
    }
    const combined = this.queue.length + incoming.length;
    if (combined > this.maxQueue) {
      const dropFromQueue = combined - this.maxQueue;
      this._noteOverflow(dropFromQueue);
      this.queue =
        dropFromQueue >= this.queue.length
          ? Buffer.alloc(0)
          : this.queue.subarray(dropFromQueue);
    }
    if (!incoming.length) return;
    // Buffer.from 复制一份，避免 subarray 把超大 chunk 的父缓冲一直留在内存里。
    this.queue = this.queue.length
      ? Buffer.concat([this.queue, incoming])
      : Buffer.from(incoming);
  }

  _noteOverflow(bytes) {
    this.stats.overflowEvents += 1;
    this.stats.overflowBytes += Math.max(0, bytes);
    this._pauseBriefly();
  }

  /** 噪声对端不能把主进程拖垮：溢出时短暂 pause。 */
  _pauseBriefly() {
    if (this._paused) return;
    if (typeof this.port?.pause !== "function" || !this.port?.isOpen) return;
    this._paused = true;
    try {
      this.port.pause();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      this._paused = false;
      try {
        if (this.port?.isOpen) this.port.resume();
      } catch {
        /* ignore */
      }
    }, 20);
  }

  _rejectAll(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    // 写等待同样必须结束（R2）：否则取消/断线后仍卡在 await write()
    for (const write of [...this.pendingWrites]) {
      write.settle(error);
    }
  }

  _terminate(state, error) {
    // 只降级：closed 之后再来 error 不应把状态改回 error。
    if (this.state === STATE.CLOSED || this.state === STATE.ERROR) {
      this._rejectAll(error);
      return;
    }
    this.state = state;
    this.closed = true;
    this._rejectAll(error);
  }

  /** 主动结束会话（取消/超时收尾）：等待者以 ABORTED 结束，不再挂死。 */
  abort(reason = "会话已取消") {
    this._terminate(STATE.CLOSED, new SerialError(SERIAL_ERROR_CODE.ABORTED, reason));
  }

  detach() {
    if (!this.port) {
      this._rejectAll(new SerialError(SERIAL_ERROR_CODE.ABORTED, "会话已分离"));
      return;
    }
    try {
      this.port.off("data", this._onData);
      this.port.off("close", this._onClose);
      this.port.off("error", this._onError);
    } catch {
      /* ignore */
    }
    this._rejectAll(new SerialError(SERIAL_ERROR_CODE.ABORTED, "会话已分离"));
    this.port = null;
  }

  /** 当前失败状态（null = 可用）。 */
  _fatalError() {
    if (this.state === STATE.ERROR) {
      return (
        this.lastError instanceof SerialError
          ? this.lastError
          : new SerialError(SERIAL_ERROR_CODE.IO_ERROR, "串口 IO 错误", { cause: this.lastError })
      );
    }
    if (this.state === STATE.CLOSED || this.closed) {
      return new SerialError(SERIAL_ERROR_CODE.PORT_CLOSED, "串口已关闭");
    }
    return null;
  }

  _flushWaiters() {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      if (this.queue.length < waiter.count) return;
      const data = this.queue.subarray(0, waiter.count);
      this.queue = this.queue.subarray(waiter.count);
      this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(data);
    }
  }

  /**
   * 读固定字节数。关闭/IO 错误立即失败（不等超时）。
   * @param {number} count
   * @param {number} timeoutMs
   */
  read(count, timeoutMs = 5000) {
    const want = Math.max(1, Number(count) || 1);
    if (this.queue.length >= want) {
      this.stats.reads += 1;
      const data = this.queue.subarray(0, want);
      this.queue = this.queue.subarray(want);
      return Promise.resolve(data);
    }
    const fatal = this._fatalError();
    if (fatal) return Promise.reject(fatal);

    return new Promise((resolve, reject) => {
      const waiter = { count: want, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        this.stats.timeouts += 1;
        reject(new SerialError(SERIAL_ERROR_CODE.READ_TIMEOUT, "串口读取超时"));
      }, Math.max(1, Number(timeoutMs) || 1));
      this.waiters.push(waiter);
    });
  }

  readByte(timeoutMs = 5000) {
    return this.read(1, timeoutMs).then((buf) => buf[0]);
  }

  /** 丢弃全部已缓冲字节（仅在明确知道字节无效时使用）。 */
  drain() {
    this.queue = Buffer.alloc(0);
  }

  /**
   * 阶段切换用的字节边界标记。
   * 返回当前已缓冲长度；之后用 `discardBefore(marker)` 只丢掉“切换前就在队列里”的字节，
   * 保留切换后新到达的字节（例如换波特率后立刻到达的 YMODEM 'C'）。
   */
  markBoundary() {
    return this.queue.length;
  }

  discardBefore(marker) {
    if (!Number.isInteger(marker) || marker <= 0) return 0;
    const drop = Math.min(marker, this.queue.length);
    this.queue = this.queue.subarray(drop);
    return drop;
  }

  /**
   * 写数据（R2）。
   *
   * 旧实现只等驱动 callback：callback 一旦丢失（驱动 bug、USB 拔线瞬间、某些虚拟串口），
   * `await write()` 会永远挂着，后面的 60s 超时检查、停止信号、断线检测全部执行不到。
   *
   * 现在：
   * - 有界等待（默认 `writeTimeoutMs`，可每次覆盖）→ WRITE_TIMEOUT；
   * - 登记到 `pendingWrites`，由 `abort()` / close / error 统一以 ABORTED / PORT_CLOSED /
   *   IO_ERROR 结束；
   * - 可选绑定任务 AbortSignal，取消立刻结束；
   * - 只能完成一次：取消后到达的晚 callback 不会改变已结束状态。
   *
   * @param {Buffer|Uint8Array} data
   * @param {{timeoutMs?: number, stopSignal?: AbortSignal}} [opts]
   */
  write(data, opts = {}) {
    const fatal = this._fatalError();
    if (fatal) return Promise.reject(fatal);
    const port = this.port;
    if (!port) {
      return Promise.reject(new SerialError(SERIAL_ERROR_CODE.PORT_CLOSED, "串口已关闭"));
    }
    const stopSignal = opts.stopSignal;
    if (stopSignal?.aborted) {
      return Promise.reject(new SerialError(SERIAL_ERROR_CODE.ABORTED, "操作已取消"));
    }
    const timeoutMs = Math.max(
      1,
      Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : this.maxWriteTimeoutMs,
    );

    return new Promise((resolve, reject) => {
      let settled = false;
      /** @type {{settle: Function, timer: any, onAbort: Function|null}} */
      const entry = { settle: () => {}, timer: null, onAbort: null };

      const settle = (err) => {
        if (settled) return; // 晚 callback / 重复终止：只能完成一次
        settled = true;
        clearTimeout(entry.timer);
        this.pendingWrites.delete(entry);
        if (entry.onAbort && stopSignal) {
          try {
            stopSignal.removeEventListener("abort", entry.onAbort);
          } catch {
            /* ignore */
          }
        }
        if (err) reject(err);
        else resolve();
      };
      entry.settle = settle;

      entry.timer = setTimeout(() => {
        settle(
          new SerialError(
            SERIAL_ERROR_CODE.WRITE_TIMEOUT,
            `串口写入超时（${timeoutMs}ms 未收到驱动回调）`,
          ),
        );
      }, timeoutMs);

      if (stopSignal) {
        entry.onAbort = () =>
          settle(new SerialError(SERIAL_ERROR_CODE.ABORTED, "操作已取消"));
        try {
          stopSignal.addEventListener("abort", entry.onAbort, { once: true });
        } catch {
          entry.onAbort = null;
        }
      }

      this.pendingWrites.add(entry);

      try {
        port.write(data, (err) => {
          if (err) {
            settle(
              new SerialError(SERIAL_ERROR_CODE.IO_ERROR, `串口写入失败：${describe(err)}`, {
                cause: err,
              }),
            );
            return;
          }
          settle(null);
        });
      } catch (err) {
        settle(
          new SerialError(SERIAL_ERROR_CODE.IO_ERROR, `串口写入失败：${describe(err)}`, {
            cause: err,
          }),
        );
      }
    });
  }

  readAllPending() {
    const data = this.queue;
    this.queue = Buffer.alloc(0);
    return data;
  }

  /** 诊断快照（不消耗数据）。 */
  snapshot() {
    return {
      state: this.state,
      pendingBytes: this.queue.length,
      waiters: this.waiters.length,
      ...this.stats,
    };
  }
}

function describe(err) {
  if (!err) return "未知错误";
  return err instanceof Error ? err.message : String(err);
}

/**
 * 把一次读取异常分类（W29-03）：
 * - "timeout"  这一片没等到字节，继续等（不是失败）
 * - "PORT_CLOSED" / "IO_ERROR" / "ABORTED"  必须立即结束，上层不能空转到超时
 *
 * 兼容旧式/Fake 会话抛出的纯文本超时（如 "串口读取超时"）：只有明确是超时语义
 * 才继续等，其余无码异常一律按 IO 故障处理，避免真断线被当成“暂时没数据”。
 */
export function classifyReadError(err) {
  const code = err?.code;
  if (code === SERIAL_ERROR_CODE.READ_TIMEOUT) return "timeout";
  if (code === SERIAL_ERROR_CODE.ABORTED) return "ABORTED";
  if (code === SERIAL_ERROR_CODE.PORT_CLOSED) return "PORT_CLOSED";
  if (code === SERIAL_ERROR_CODE.IO_ERROR) return "IO_ERROR";
  if (code === SERIAL_ERROR_CODE.RX_OVERFLOW) return "RX_OVERFLOW";
  if (err instanceof Error && /读取超时|read\s*timeout/i.test(err.message)) return "timeout";
  return "IO_ERROR";
}
