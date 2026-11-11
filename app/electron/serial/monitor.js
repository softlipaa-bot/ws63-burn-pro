import { FLASH_CHANNEL_IDS } from "../burn/channels.js";
import { LineSplitter } from "./line-splitter.js";
import { installErrorSink } from "./port-safety.js";
import {
  PORT_CLOSE_TIMEOUT_MS,
  PORT_OPEN_TIMEOUT_MS,
  closeWithConfirmation,
  getQuarantine,
  openWithDeadline,
  settlePortClose,
  trackQuarantine,
} from "./port-lifecycle.js";
import {
  OWNER_KIND,
  PortBusyError,
  holderOf,
  normalizePort,
  releasePort,
  reservePort,
  transferPort,
} from "./ownership.js";

/**
 * 串口监听（日志）通道（W03/W04）。
 *
 * W03：不再用 ReadlineParser 把“没有换行的流”无限累积；原始字节直接进入 LineSplitter，
 *      单行/单片有上限，超长行分段输出并计数，UI 可看到截断/丢弃次数。
 * W04：打开端口前先在所有权注册表里原子保留端口，open 失败/关闭时 finally 释放；
 *      只有 open 成功后才写 monitors，因此“检查通过但还没登记”的窗口不再存在。
 */

/**
 * @typedef {{
 *   port: any, path: string, baudRate: number, token: string, splitter: LineSplitter,
 *   onData: (text: string) => void, onError: (err: any) => void,
 *   lastDataAt: number, flushTimer: ReturnType<typeof setTimeout>|null,
 *   queue: string[], queueChars: number, stats: {truncated: number, droppedChars: number, droppedChunks: number, bytesIn: number},
 *   warnAt: number,
 * }} MonitorEntry
 */

/** @type {Map<string, MonitorEntry>} */
const monitors = new Map();

/**
 * 进行中的监听操作（R3）：opening / adopting。
 *
 * 旧实现只用一个 `connectingChannels` Set 记"某通道正在连"，既不能取消，也没有 deadline，
 * 而且 error/close 监听要等 open 成功后才装。结果是：
 * - `disconnectMonitor()` 对未来会连上的 open 直接返回；open 晚到后照旧 attach；
 * - open 永久不回调 ⇒ 该通道永远处于"正在连接"，且没有上限。
 *
 * @type {Map<string, {
 *   generation: number, kind: 'opening'|'adopting', cancelled: boolean,
 *   port: any|null, earlyData: Buffer[], earlyError: Error|null, handlers: any
 * }>}
 */
const operations = new Map();
let operationSeq = 0;

/** 打开/关闭的有限等待（R3/R4）。 */
export const MONITOR_OPEN_TIMEOUT_MS = PORT_OPEN_TIMEOUT_MS;
export const MONITOR_CLOSE_TIMEOUT_MS = PORT_CLOSE_TIMEOUT_MS;

/**
 * 关闭超时后句柄状态不确定的端口（R4）：保留占用并隔离，绝不假装空闲。
 * @type {Map<string, {channel: string, path: string, port: any, since: number}>}
 */
const quarantined = new Map();

export function getQuarantinedPorts() {
  return getQuarantine();
}

const SERIAL_FLUSH_MS = 80;
const MAX_LINE_CHARS = 4 * 1024;
const MAX_BUFFER_CHARS = 32 * 1024;
const WARN_INTERVAL_MS = 5000;

/**
 * 可注入的串口工厂（W29-05 测试需要“真实模块路径 + 假 port”）。
 * 生产环境为 null = 动态 import("serialport")。
 * @type {null | ((opts: any) => any)}
 */
let portFactory = null;

/** 仅测试用：注入/清除 port 工厂。 */
export function __setPortFactory(factory) {
  portFactory = typeof factory === "function" ? factory : null;
}

export class MonitorClosedError extends Error {
  constructor(path) {
    super(`串口 ${path} 已关闭（设备可能被拔出）`);
    this.name = "MonitorClosedError";
    this.code = "PORT_CLOSED";
    this.path = path;
  }
}

/** 端口枚举去重（W29-09）：主进程预热与 UI 刷新共用同一次 SerialPort.list()。 */
const PORT_LIST_TTL_MS = 1500;
let portListCache = { at: 0, value: null };
let portListInflight = null;

export async function listPorts() {
  const now = Date.now();
  if (portListCache.value && now - portListCache.at < PORT_LIST_TTL_MS) {
    return portListCache.value;
  }
  if (portListInflight) return portListInflight;
  portListInflight = (async () => {
    try {
      const { SerialPort } = await import("serialport");
      const ports = await SerialPort.list();
      const mapped = ports.map((p) => ({
        path: p.path,
        label: `${p.path}${p.manufacturer ? ` · ${p.manufacturer}` : ""}`,
      }));
      portListCache = { at: Date.now(), value: mapped };
      return mapped;
    } finally {
      portListInflight = null;
    }
  })();
  return portListInflight;
}

/** 启动预热：只是把枚举结果放进缓存，UI 稍后刷新时直接命中，不重复枚举。 */
export async function warmPortEnumeration() {
  try {
    return await listPorts();
  } catch {
    return [];
  }
}

/** 仅测试用：清空端口枚举缓存。 */
export function __resetPortListCache() {
  portListCache = { at: 0, value: null };
  portListInflight = null;
}

export function isMonitorConnected(channel) {
  if (channel) return Boolean(monitors.get(channel)?.port?.isOpen);
  for (const m of monitors.values()) {
    if (m.port?.isOpen) return true;
  }
  return false;
}

export function getMonitorSnapshot() {
  const serialChannels = {};
  for (const ch of FLASH_CHANNEL_IDS) {
    const m = monitors.get(ch);
    serialChannels[ch] = {
      connected: Boolean(m?.port?.isOpen),
      port: m?.path ?? "",
      baudRate: m?.baudRate ?? 115200,
      truncatedSegments: m?.stats.truncated ?? 0,
      droppedChars: m?.stats.droppedChars ?? 0,
      pendingChars: m?.splitter.pendingChars ?? 0,
    };
  }
  return {
    serialChannels,
    serialConnected: isMonitorConnected(),
  };
}

function flushQueue(channel) {
  const m = monitors.get(channel);
  if (!m || !m.queue.length) return;
  const text = m.queue.join("");
  m.queue = [];
  m.queueChars = 0;
  if (text) m.onData(text);
}

function scheduleFlush(channel) {
  const m = monitors.get(channel);
  if (!m || m.flushTimer) return;
  m.flushTimer = setTimeout(() => {
    const entry = monitors.get(channel);
    if (!entry) return;
    entry.flushTimer = null;
    tickFlush(channel);
  }, SERIAL_FLUSH_MS);
}

function tickFlush(channel) {
  const m = monitors.get(channel);
  if (!m) return;
  if (m.splitter.pendingChars > 0) {
    if (Date.now() - m.lastDataAt >= SERIAL_FLUSH_MS) m.splitter.flush();
    else scheduleFlush(channel);
  }
  flushQueue(channel);
}

function enqueueLine(channel, text) {
  const m = monitors.get(channel);
  if (!m || !text) return;
  const chunk = `${text}\n`;
  let dropped = 0;
  while (m.queueChars + chunk.length > MAX_BUFFER_CHARS && m.queue.length) {
    const head = m.queue.shift();
    m.queueChars -= head.length;
    dropped += head.length;
  }
  if (dropped > 0) {
    m.stats.droppedChars += dropped;
    m.stats.droppedChunks += 1;
  }
  if (chunk.length > MAX_BUFFER_CHARS) {
    // 极端情况：单片就超过队列上限，直接截断并计数
    const keep = chunk.slice(0, MAX_BUFFER_CHARS);
    m.stats.droppedChars += chunk.length - keep.length;
    m.queue.push(keep);
    m.queueChars += keep.length;
  } else {
    m.queue.push(chunk);
    m.queueChars += chunk.length;
  }
  if (m.queue.length + m.queueChars > 0) scheduleFlush(channel);
  maybeWarnOverflow(channel);
}

function maybeWarnOverflow(channel) {
  const m = monitors.get(channel);
  if (!m) return;
  const { truncated, droppedChars } = m.stats;
  if (!truncated && !droppedChars) return;
  const now = Date.now();
  if (now - m.warnAt < WARN_INTERVAL_MS) return;
  m.warnAt = now;
  const parts = [];
  if (truncated) parts.push(`超长行已分段 ${truncated} 次`);
  if (droppedChars) parts.push(`显示队列已丢弃 ${droppedChars} 字符`);
  m.onData(`[监听提示] 串口输出过快：${parts.join("，")}（日志不完整，请降低输出速率）\n`);
}

function attachPort(channel, port, path, baudRate, token, onData, onError) {
  // 防御：绝不覆盖一个仍然打开的条目（那会泄漏旧句柄和它的所有权）
  const existing = monitors.get(channel);
  if (existing?.port?.isOpen && existing.port !== port) {
    throw new Error(`${channel} 路串口已连接，请先断开`);
  }
  installErrorSink(port);
  const entry = {
    channel,
    port,
    path,
    baudRate,
    token,
    onData,
    onError,
    lastDataAt: Date.now(),
    flushTimer: null,
    queue: [],
    queueChars: 0,
    stats: { truncated: 0, droppedChars: 0, droppedChunks: 0, bytesIn: 0 },
    warnAt: 0,
    splitter: null,
  };
  entry.splitter = new LineSplitter({
    maxLineChars: MAX_LINE_CHARS,
    onLine: (text, info) => {
      if (info.truncated) entry.stats.truncated += 1;
      enqueueLine(channel, text);
    },
  });
  entry.onChunk = (chunk) => {
    entry.lastDataAt = Date.now();
    entry.stats.bytesIn += chunk?.byteLength ?? 0;
    entry.splitter.push(chunk);
    scheduleFlush(channel);
  };
  entry.onClose = () => {
    // 端口被外部关闭（拔线/另一方 close）：必须清理**并广播**，
    // 旧实现只清理不广播，UI 会一直显示“已连接”。
    const current = monitors.get(channel);
    if (!current || current.token !== entry.token) return; // 迟到回调，别动新任务
    void cleanupMonitor(channel, { closePort: false, expectToken: entry.token });
    try {
      onError(new MonitorClosedError(path));
    } catch {
      /* ignore */
    }
  };
  entry.onErr = (err) => {
    // USB 断开/串口错误：R4 要求先把句柄关掉（closing 占位）再释放所有权
    void cleanupMonitor(channel, { closePort: true, expectToken: entry.token });
    try {
      onError(err);
    } catch {
      /* ignore */
    }
  };

  port.on("data", entry.onChunk);
  port.on("error", entry.onErr);
  port.on("close", entry.onClose);
  monitors.set(channel, entry);
  return {
    channel,
    path,
    baudRate,
    token,
    /** 打开阶段缓存的首字节，attach 后补投（R3） */
    __pushEarly(chunk) {
      try {
        entry.onChunk(chunk);
      } catch {
        /* ignore */
      }
    },
  };
}

function detachEntry(channel, entry) {
  entry.splitter?.flush?.();
  flushQueue(channel);
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
  }
  try {
    entry.port?.off?.("data", entry.onChunk);
    entry.port?.off?.("error", entry.onErr);
    entry.port?.off?.("close", entry.onClose);
  } catch {
    /* ignore */
  }
  // 摘掉自己的 error 监听后，驱动仍可能补发 error；没有监听者时 EventEmitter 会抛出
  // 未捕获异常把主进程带崩，这里留一个静默 sink 兜住。
  installErrorSink(entry.port);
}

/**
 * 清理一个监听条目。
 *
 * R4：**先确认句柄关闭，再释放所有权**。
 * 旧实现先删条目、先 releasePort，然后才异步 close —— 关闭期间端口在注册表里是"空闲"的，
 * 别的通道/任务可以立刻打开同一个 COM，现实驱动就会报占用或产生并发操作。
 * 现在关闭期间把所有权标成 `closing`（不可被接管），确认关闭后才释放；
 * 关闭超时则隔离保留，绝不假装空闲。
 *
 * @param {string} channel
 * @param {{closePort?: boolean, expectToken?: string|null}} [opts]
 * @returns {Promise<boolean>} 是否真的清理了该条目
 */
async function cleanupMonitor(channel, { closePort = false, expectToken = null, notify = null } = {}) {
  const m = monitors.get(channel);
  if (!m) return false;
  if (expectToken && m.token !== expectToken) return false;
  monitors.delete(channel);
  detachEntry(channel, m);

  const port = m.port;
  if (!closePort || !port || !port.isOpen) {
    releasePort(m.token);
    return true;
  }

  // 关闭期间继续占住端口（closing 不可接管）
  transferPort(m.token, { channel, kind: OWNER_KIND.CLOSING });
  // 统一规则：确认关闭 → 释放；未确认 → 隔离并挂 late-close 监听（驱动后来真关了要收尾）
  const settled = await settlePortClose({
    port,
    token: m.token,
    release: releasePort,
    channel,
    path: m.path,
    ms: MONITOR_CLOSE_TIMEOUT_MS,
    onResolved: (info) => {
      // 驱动迟到关闭 → 所有权已释放，这里补一次广播，让 UI 不再显示占用
      const cb = notify ?? m.onError;
      try {
        cb?.(
          Object.assign(new Error(`串口 ${info.path} 已在稍后确认关闭，占用已释放`), {
            code: "PORT_CLOSED",
          }),
        );
      } catch {
        /* ignore */
      }
    },
  });
  if (!settled.closed) {
    try {
      m.onError?.(
        new Error(
          `串口 ${m.path} 关闭未确认（${MONITOR_CLOSE_TIMEOUT_MS}ms），已保留占用并等待驱动确认，期间不会被重复打开`,
        ),
      );
    } catch {
      /* ignore */
    }
  }
  // 只有确认关闭才算清理成功：调用方（尤其是烧录接管）必须据此决定能否 open
  return Boolean(settled.closed);
}

/** 薄封装：指向共享生命周期实现（规则只实现一次，见 port-lifecycle.js）。 */
const closePortWithTimeout = (port, ms = MONITOR_CLOSE_TIMEOUT_MS) =>
  closeWithConfirmation(port, ms);
const openPortWithTimeout = (port, ms = MONITOR_OPEN_TIMEOUT_MS) => openWithDeadline(port, ms);

/**
 * 创建但**不打开**端口；打开交给 openPortWithTimeout，便于"打开前就装好监听"（R3）。
 */
async function createSerialPort(path, baudRate) {
  if (portFactory) {
    return portFactory({ path, baudRate, autoOpen: false, highWaterMark: 64 * 1024 });
  }
  const { SerialPort } = await import("serialport");
  return new SerialPort({
    path,
    baudRate,
    autoOpen: false,
    highWaterMark: 64 * 1024,
  });
}

/**
 * 打开之前就装好 data/error/close（R3）：这段窗口里的首字节与错误不能丢。
 * 句柄上的标记让 attachPort 知道要先摘掉这组临时监听。
 */
function installPreOpenHandlers(port, op) {
  const handlers = {
    onData: (chunk) => {
      if (!chunk?.length) return;
      // 打开阶段到达的字节先缓存，attach 后按原样喂给 splitter
      if (op.earlyData.length < 64) op.earlyData.push(Buffer.from(chunk));
    },
    onError: (err) => {
      op.earlyError = err instanceof Error ? err : new Error(String(err));
    },
    onClose: () => {
      op.earlyClosed = true;
    },
  };
  op.handlers = handlers;
  try {
    port.on("data", handlers.onData);
    port.on("error", handlers.onError);
    port.on("close", handlers.onClose);
  } catch {
    /* 某些替身端口不支持预装监听 */
  }
  return handlers;
}

function removePreOpenHandlers(port, op) {
  const handlers = op?.handlers;
  if (!port || !handlers) return;
  try {
    port.off("data", handlers.onData);
    port.off("error", handlers.onError);
    port.off("close", handlers.onClose);
  } catch {
    /* ignore */
  }
  op.handlers = null;
}

/**
 * 把某端口上的监听**交给烧录**（Codex 复审：接管仲裁缺陷）。
 *
 * 旧路径的问题：`reservePort(..., { allowTakeoverMonitoring: true })` 在**关闭旧句柄之前**
 * 就把占用替换成新 token。于是旧句柄关闭失败时已没有任何可仲裁的占用，
 * `cleanupMonitor` 按旧 token 做的 transferring/release 全是空操作且仍返回成功，
 * `disconnectMonitor` 不传播"关闭未确认"，`beginFlashJob` 继续打开同一个 COM。
 *
 * 新顺序（所有权全程不断档）：
 *   1. 摘掉监听条目与监听器（UI 不再显示"正在监听"）；
 *   2. 把**原 token** 转成 `closing`（不签发新 token）；
 *   3. 等待"确认关闭"；
 *   4. 确认闭合 → 返回原 token（调用方转成 flashing 继续用）；
 *      未确认 → 登记隔离（保留该 token 的占用）并返回 closed:false，调用方**不得 open**。
 *
 * @param {string} port
 * @param {{expectChannel?: string|null}} [opts]
 * @returns {Promise<{closed: boolean, token: string|null, channel: string|null, quarantined: boolean, hadMonitor: boolean}>}
 */
export async function closeMonitorForTakeover(port, opts = {}) {
  const target = normalizePort(port);
  const expectChannel = opts.expectChannel ?? null;
  let found = null;
  for (const [ch, m] of monitors) {
    if (normalizePort(m.path) === target) {
      if (expectChannel && ch !== expectChannel) continue;
      found = [ch, m];
      break;
    }
  }
  if (!found) {
    return { closed: true, token: null, channel: null, quarantined: false, hadMonitor: false };
  }

  const [channel, entry] = found;
  const token = entry.token;
  monitors.delete(channel);
  detachEntry(channel, entry);

  const livePort = entry.port;
  if (!livePort?.isOpen) {
    // 句柄本来就关着：所有权仍交给调用方（token 不变）
    return { closed: true, token, channel, quarantined: false, hadMonitor: true };
  }

  // 原 token 进入 closing（不可被接管），所有权不断档
  transferPort(token, { channel, kind: OWNER_KIND.CLOSING });

  const settled = await settlePortClose({
    port: livePort,
    token,
    // settlePortClose 只在"确认关闭"时调用 release；接管路径由调用方转成 flashing，
    // 因此这里传入的 release 只在确认关闭后执行一次，随后调用方用原 token 继续持有。
    release: () => false,
    channel,
    path: entry.path,
    ms: MONITOR_CLOSE_TIMEOUT_MS,
    onResolved: (info) => {
      try {
        entry.onError?.(
          Object.assign(new Error(`串口 ${info.path} 已在稍后确认关闭`), { code: "PORT_CLOSED" }),
        );
      } catch {
        /* ignore */
      }
    },
  });

  return {
    closed: Boolean(settled.closed),
    token,
    channel,
    quarantined: Boolean(settled.quarantined),
    hadMonitor: true,
  };
}

/**
 * 打开监听。端口在 await 之前已被原子保留，并且建立可取消的 operation（R3）。
 */
export async function connectMonitor(channel, path, baudRate, onData, onError) {
  if (monitors.get(channel)?.port?.isOpen) {
    throw new Error(`${channel} 路串口已连接，请先断开`);
  }
  if (operations.has(channel)) {
    throw new Error(`${channel} 路串口正在连接中，请稍候`);
  }

  // 同步建立 operation：disconnectMonitor 之后能取消它（R3）
  const op = {
    generation: (operationSeq += 1),
    kind: "opening",
    cancelled: false,
    port: null,
    earlyData: [],
    earlyError: null,
    earlyClosed: false,
    handlers: null,
  };
  operations.set(channel, op);

  let token = null;
  let port = null;
  let attachedOk = false;
  try {
    // 先清掉本通道的陈旧记录（已关闭的端口），只清它自己的 token
    const stale = monitors.get(channel);
    if (stale) await cleanupMonitor(channel, { expectToken: stale.token, closePort: true });

    token = reservePort(path, { channel, kind: OWNER_KIND.OPENING }).token;
    // 取消可能发生在 createSerialPort 的 await 前后，两处都要检查（Codex 复审要点）
    if (op.cancelled || operations.get(channel) !== op) throw new Error("连接已被取消");
    port = await createSerialPort(path, baudRate);
    op.port = port;
    if (op.cancelled || operations.get(channel) !== op) throw new Error("连接已被取消");
    // 打开前就装好 data/error/close（R3）：这段窗口的首字节与错误不能丢
    installPreOpenHandlers(port, op);

    const opened = await openPortWithTimeout(port, MONITOR_OPEN_TIMEOUT_MS);
    if (!opened.ok) {
      throw opened.timedOut
        ? new Error(`打开串口 ${path} 超时（${MONITOR_OPEN_TIMEOUT_MS}ms 未回调）`)
        : opened.error;
    }

    // 晚成功：已被取消或被新任务顶替 ⇒ 自己关掉，绝不 attach、绝不污染新任务
    if (op.cancelled || operations.get(channel) !== op) throw new Error("连接已被取消");
    if (op.earlyError) throw op.earlyError;

    removePreOpenHandlers(port, op);
    const attached = attachPort(channel, port, path, baudRate, token, onData, onError);
    attachedOk = true;
    transferPort(token, { channel, kind: OWNER_KIND.MONITORING });
    // 打开阶段到达的首字节补投给 splitter
    for (const chunk of op.earlyData) attached.__pushEarly?.(chunk);
    op.earlyData = [];
    return attached;
  } catch (err) {
    if (port) removePreOpenHandlers(port, op);
    if (token) {
      // D2：失败/取消分支同样遵守"确认关闭→释放 / 未确认→隔离"规则。
      // 旧实现无条件 releasePort，即使 close 失败、句柄还开着。
      if (!port || !port.isOpen) {
        releasePort(token);
      } else {
        transferPort(token, { channel, kind: OWNER_KIND.CLOSING });
        const settled = await settlePortClose({
          port,
          token,
          release: releasePort,
          channel,
          path,
          ms: MONITOR_CLOSE_TIMEOUT_MS,
          onResolved: (info) => {
            try {
              onError?.(
                Object.assign(new Error(`串口 ${info.path} 已在稍后确认关闭，占用已释放`), {
                  code: "PORT_CLOSED",
                }),
              );
            } catch {
              /* ignore */
            }
          },
        });
        if (!settled.closed) {
          try {
            onError?.(
              new Error(
                `串口 ${path} 关闭未确认，已保留占用并等待驱动确认（不会被重复打开）`,
              ),
            );
          } catch {
            /* ignore */
          }
        }
      }
    }
    throw err;
  } finally {
    if (operations.get(channel) === op) operations.delete(channel);
  }
}

/**
 * 接管一个已经打开的 SerialPort（烧录 → 监听，无关闭/重开空窗）。
 * 所有权由调用方通过 token 交接下来（transferPort），这里只负责在失败时释放。
 */
export async function adoptMonitor(channel, port, path, baudRate, onData, onError, opts = {}) {
  if (!port) throw new Error("无可用串口句柄");
  if (monitors.get(channel)?.port?.isOpen) {
    throw new Error(`${channel} 路串口已连接，请先断开`);
  }
  const other = holderOf(path);
  if (other && (!opts.token || other.token !== opts.token)) {
    throw new PortBusyError(normalizePort(path), other);
  }

  const op = {
    generation: (operationSeq += 1),
    kind: "adopting",
    cancelled: false,
    port,
    earlyData: [],
    earlyError: null,
    earlyClosed: false,
    handlers: null,
  };
  const previousOp = operations.get(channel);
  if (previousOp) previousOp.cancelled = true;
  operations.set(channel, op);

  let token = opts.token;
  try {
    if (!token) {
      token = reservePort(path, { channel, kind: OWNER_KIND.HANDOFF }).token;
    } else {
      transferPort(token, { channel, kind: OWNER_KIND.HANDOFF });
    }
    if (op.cancelled || operations.get(channel) !== op) throw new Error("接管已被取消");

    // 只清理本通道的**陈旧**条目：带上旧 token，避免迟到的清理把新任务的所有权删掉。
    const stale = monitors.get(channel);
    if (stale) await cleanupMonitor(channel, { expectToken: stale.token, closePort: true });

    const targetBaud = Number(baudRate) || 115200;
    if (port.isOpen && port.baudRate !== targetBaud) {
      const updated = await withPortDeadline(
        (done) => port.update({ baudRate: targetBaud }, (err) => done(err)),
        MONITOR_OPEN_TIMEOUT_MS,
      );
      if (!updated.ok) {
        throw updated.timedOut
          ? new Error(`切换监听波特率超时（${MONITOR_OPEN_TIMEOUT_MS}ms 未回调）`)
          : updated.error;
      }
    }

    if (op.cancelled || operations.get(channel) !== op) {
      throw new Error("接管已被取消");
    }

    // 先挂监听，再切到 MONITORING（旧实现在 attach 前 flush，会冲掉首段启动日志）
    const attached = attachPort(channel, port, path, targetBaud, token, onData, onError);
    transferPort(token, { channel, kind: OWNER_KIND.MONITORING });
    return attached;
  } catch (err) {
    if (token) releasePort(token);
    throw err;
  } finally {
    if (operations.get(channel) === op) operations.delete(channel);
  }
}

/** 有界等待一个回调式端口操作（update 等）。 */
function withPortDeadline(executor, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, timedOut: true, error: null });
    }, Math.max(1, ms));
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: !err, timedOut: false, error: err ?? null });
    };
    try {
      executor(finish);
    } catch (err) {
      finish(err);
    }
  });
}

/**
 * 断开监听。**必须先取消仍在 opening/adopting 的操作**（R3），
 * 否则 open 晚到后照旧 attach，断开形同虚设。
 */
export async function disconnectMonitor(channel) {
  if (channel) {
    const op = operations.get(channel);
    if (op) {
      op.cancelled = true;
      // 已经拿到句柄且已打开：立刻关它；还没打开的由它自己晚成功时关闭
      if (op.port?.isOpen) {
        await closePortWithTimeout(op.port, MONITOR_CLOSE_TIMEOUT_MS);
      }
    }
    const m = monitors.get(channel);
    if (!m) return;
    await cleanupMonitor(channel, { expectToken: m.token, closePort: true });
    return;
  }

  for (const [ch, op] of [...operations]) {
    op.cancelled = true;
    if (op.port?.isOpen) await closePortWithTimeout(op.port, MONITOR_CLOSE_TIMEOUT_MS);
    operations.delete(ch);
  }
  for (const ch of [...monitors.keys()]) {
    const m = monitors.get(ch);
    if (!m) continue;
    await cleanupMonitor(ch, { expectToken: m.token, closePort: true });
  }
}

export async function sendMonitor(channel, text) {
  const m = monitors.get(channel);
  if (!m?.port?.isOpen) throw new Error("串口未连接");
  const payload = text.endsWith("\n") ? text : `${text}\n`;
  await new Promise((resolve, reject) => {
    m.port.write(payload, (err) => (err ? reject(err) : resolve()));
  });
}

export function portUsedByMonitor(port, exceptChannel = null) {
  const target = normalizePort(port);
  if (!target) return null;
  for (const [ch, m] of monitors) {
    if (ch === exceptChannel) continue;
    if (m.port?.isOpen && normalizePort(m.path) === target) return ch;
  }
  const holder = holderOf(target);
  if (holder && holder.channel && holder.channel !== exceptChannel) return holder.channel;
  return null;
}

/**
 * 退出前强制收尾：取消进行中的 open/adopt，并按 R4 顺序关闭（先占 closing 再释放）。
 */
export async function abortAllMonitors() {
  for (const [ch, op] of [...operations]) {
    op.cancelled = true;
    if (op.port?.isOpen) await closePortWithTimeout(op.port, MONITOR_CLOSE_TIMEOUT_MS);
    operations.delete(ch);
  }
  for (const ch of [...monitors.keys()]) {
    const m = monitors.get(ch);
    if (!m) continue;
    await cleanupMonitor(ch, { expectToken: m.token, closePort: true });
  }
}

/** 诊断用：给测试/UI 看的每路缓冲状态。 */
export function getMonitorBufferStats() {
  const out = {};
  for (const [ch, m] of monitors) {
    out[ch] = {
      pendingChars: m.splitter.pendingChars,
      queueChars: m.queueChars,
      bytesIn: m.stats.bytesIn,
      truncated: m.stats.truncated,
      droppedChars: m.stats.droppedChars,
    };
  }
  return out;
}
