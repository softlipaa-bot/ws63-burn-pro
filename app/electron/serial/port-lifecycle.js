/**
 * 端口生命周期的一致性规则（Codex 复审 followup 1~3 的共同根因）。
 *
 * 之前 monitor 与 flasher 各自实现"打开/关闭"，规则不一致，于是出现三类泄漏：
 *  1. 关闭失败被隔离后，驱动**后来**真的关了（发 close / isOpen=false），但没有清理路径
 *     → ownership 永久停在 closing，用户只能重启；
 *  2. 打开过程中出错，catch 里无条件 releasePort，即使 close 失败、句柄还开着；
 *  3. 烧录 openPort 超时后正常收尾，驱动**迟到成功** → 真实打开的句柄没人关。
 *
 * 统一规则（本模块实现，monitor / flasher / ipc 共用）：
 *  - **打开**：有界等待；超时后仍保留回调，若驱动迟到成功则立刻关闭该句柄（不留孤儿）。
 *  - **关闭**：必须确认（回调无错 **且** isOpen 为 false）才算关闭。
 *  - **确认关闭 → 释放所有权；未确认 → 保留 closing 占用并隔离**。
 *  - **隔离的句柄**挂一个按 token 校验的 late-close 监听：驱动后来真关了，
 *    就按原 token 收尾（释放 + 广播），不需要重启。
 *
 * 本模块不依赖 electron，也不做任何泛化重构：只把这三条规则集中实现一次。
 */

import { installErrorSink } from "./port-safety.js";

export const PORT_OPEN_TIMEOUT_MS = 8000;
export const PORT_CLOSE_TIMEOUT_MS = 3000;
/** 隔离期间轮询 isOpen 的兜底间隔（有些驱动不发 close 事件）。 */
const QUARANTINE_SWEEP_MS = 500;

/**
 * @typedef {{
 *   token: string, channel: string|null, path: string, port: any, since: number,
 *   watcher: Function|null, sweep: any, onResolved: Function|null,
 * }} QuarantineEntry
 */

/** @type {Map<string, QuarantineEntry>} token → 隔离条目 */
const quarantine = new Map();

/**
 * 有界打开。超时后若驱动**迟到成功**，必须立刻关闭真实打开的句柄。
 * @param {any} port
 * @param {number} [ms]
 * @param {{onLateOpen?: (port: any) => void}} [opts]
 * @returns {Promise<{ok: boolean, timedOut: boolean, error: Error|null, lateOpenClosed?: boolean}>}
 */
export function openWithDeadline(port, ms = PORT_OPEN_TIMEOUT_MS, opts = {}) {
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timedOut = true;
      resolve({ ok: false, timedOut: true, error: null });
    }, Math.max(1, ms));

    const done = (err) => {
      if (timedOut) {
        // 迟到成功：句柄真的开了 → 尝试关闭，但**确认结果必须如实上报**，
        // 否则上层会在"其实还开着"的情况下释放所有权（Codex 复现的第二个泄漏）。
        void (async () => {
          let closed = false;
          try {
            closed = await closeWithConfirmation(port, PORT_CLOSE_TIMEOUT_MS);
          } catch {
            closed = false;
          }
          try {
            opts.onLateOpen?.(port, { closed, lateError: err ?? null });
          } catch {
            /* ignore */
          }
        })();
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: !err, timedOut: false, error: err ?? null });
    };

    try {
      port.open(done);
    } catch (err) {
      done(err);
    }
  });
}

/**
 * 有界关闭，返回 true **仅当确认句柄已不在打开状态**。
 * 覆盖：close 回调带 Error、回调正常但 isOpen 仍为 true、超时、同步抛错。
 * @param {any} port
 * @param {number} [ms]
 * @returns {Promise<boolean>}
 */
export function closeWithConfirmation(port, ms = PORT_CLOSE_TIMEOUT_MS, options = {}) {
  // treatNotOpenAsClosed=false 用于"打开尚未决"的句柄：此刻 isOpen===false 不代表安全，
  // 因为驱动可能迟到打开，所以不能当作已确认关闭。
  const treatNotOpenAsClosed = options.treatNotOpenAsClosed !== false;
  return new Promise((resolve) => {
    if (!port) {
      resolve(true);
      return;
    }
    if (!port.isOpen) {
      resolve(treatNotOpenAsClosed);
      return;
    }
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(closed);
    };
    const timer = setTimeout(() => finish(false), Math.max(1, ms));
    try {
      port.close((err) => {
        if (err) {
          finish(false); // 关闭报错：状态不确定，交给调用方隔离
          return;
        }
        finish(!port.isOpen);
      });
    } catch {
      finish(false);
    }
  });
}

/**
 * 把"关闭未确认"的句柄登记为隔离，并挂 late-close 监听（按 token 校验）。
 * 驱动后来真关闭时：释放该 token + 回调通知上层（可广播），并自动清理条目。
 *
 * @param {{
 *   port: any, token: string, channel?: string|null, path?: string,
 *   onResolved?: (info: {token: string, channel: string|null, path: string}) => void,
 * }} input
 */
export function trackQuarantine(input) {
  const { port, token, channel = null, path: portPath = "", onResolved = null, pendingOpen = false } = input;
  if (!token || !port) return null;
  const existing = quarantine.get(token);
  if (existing) {
    // Codex 复现：先由 flasher 登记"仅清 pendingOpenHandle"的回调，随后 settlePortClose
    // 带着 releasePort 再登记同一 token，旧实现直接 return existing → **释放回调丢失**，
    // 驱动真正关闭后 token 永久停在 closing。这里必须合并/升级。
    if (typeof onResolved === "function") {
      const prev = existing.onResolved;
      existing.onResolved = prev && prev !== onResolved
        ? (info) => {
            try {
              prev(info);
            } catch {
              /* ignore */
            }
            onResolved(info);
          }
        : onResolved;
    }
    if (pendingOpen) {
      // 注意：合并时**不能**把 openLanded 重置为 false。
      // settlePortClose 会在 flasher 之后合并登记同一个"未决打开"，
      // 一旦重置就会永远等不到"落地"，造成 token 永久停在 closing（Codex 复现）。
      existing.pendingOpen = true;
    }
    if (portPath && !existing.path) existing.path = portPath;
    return existing;
  }

  installErrorSink(port);

  /** @type {QuarantineEntry} */
  const entry = {
    token,
    channel,
    path: portPath,
    port,
    since: Date.now(),
    watcher: null,
    sweep: null,
    onResolved,
    // 打开未决（open 还没回调）：此时 isOpen===false 表示"尚未打开"，不是"已关闭"。
    // 只有确认 open 已落地（成功或报错）之后，isOpen===false 才能作为关闭依据。
    pendingOpen: Boolean(pendingOpen),
    openLanded: !pendingOpen,
  };

  const resolveNow = () => {
    if (port.isOpen) return false; // 还没真关，继续等
    // 打开尚未落地：不能把"还没打开"误判为"已关闭"（旧 500ms sweep 会提前删条目）
    if (entry.pendingOpen && entry.openLanded === false) return false;
    if (!quarantine.delete(token)) return true;
    try {
      port.off?.("close", entry.watcher);
    } catch {
      /* ignore */
    }
    if (entry.sweep) clearInterval(entry.sweep);
    try {
      entry.onResolved?.({ token, channel, path: portPath });
    } catch {
      /* ignore */
    }
    return true;
  };

  entry.watcher = () => {
    resolveNow();
  };
  try {
    port.on?.("close", entry.watcher);
  } catch {
    /* ignore */
  }
  // 有些驱动不发 close 事件：轮询兜底
  entry.sweep = setInterval(() => {
    resolveNow();
  }, QUARANTINE_SWEEP_MS);
  entry.sweep.unref?.();

  quarantine.set(token, entry);
  return entry;
}

/**
 * 标记某个 token 的"打开已落地"（open 回调已触发：成功或失败）。
 * 调用后若句柄已不在打开状态，隔离条目会按规则收尾（释放原 token）。
 */
export function markQuarantineOpenLanded(token) {
  const entry = quarantine.get(String(token));
  if (!entry) return false;
  entry.openLanded = true;
  // 落地后立刻尝试一次收尾（例如 open 回调报错且句柄未真正打开）
  try {
    entry.watcher?.();
  } catch {
    /* ignore */
  }
  return true;
}

/** 诊断/测试：当前隔离条目。 */
export function getQuarantine() {
  return [...quarantine.values()].map((e) => ({
    token: e.token,
    channel: e.channel,
    path: e.path,
    since: e.since,
    isOpen: Boolean(e.port?.isOpen),
  }));
}

/** 立即检查一次隔离条目（驱动不发 close 时也能收尾）。 */
export function sweepQuarantine() {
  for (const entry of [...quarantine.values()]) {
    if (!entry.port?.isOpen) {
      // 复用 watcher 逻辑
      try {
        entry.watcher?.();
      } catch {
        /* ignore */
      }
    }
  }
  return getQuarantine().length;
}

/** 仅测试用。 */
export function clearQuarantine() {
  for (const entry of quarantine.values()) {
    if (entry.sweep) clearInterval(entry.sweep);
  }
  quarantine.clear();
}

/**
 * 统一的收尾入口：关闭 → 确认则释放所有权；未确认则隔离保留占用。
 *
 * @param {{
 *   port: any, token: string, release: (token: string) => boolean,
 *   channel?: string|null, path?: string, ms?: number,
 *   onResolved?: (info: {token: string, channel: string|null, path: string}) => void,
 * }} input
 * @returns {Promise<{closed: boolean, released: boolean, quarantined: boolean}>}
 */
export async function settlePortClose(input) {
  const { port, token, release, channel = null, path: portPath = "", ms, onResolved, pendingOpen = false } = input;
  const closed = await closeWithConfirmation(port, ms, { treatNotOpenAsClosed: !pendingOpen });
  if (closed) {
    const released = release(token);
    return { closed: true, released, quarantined: false };
  }
  if (token) {
    trackQuarantine({
      port,
      token,
      channel,
      path: portPath,
      // 未决 open 时必须带 pendingOpen：否则 500ms sweep 会因 isOpen===false 提前删条目
      pendingOpen: Boolean(pendingOpen),
      onResolved: (info) => {
        release(info.token);
        onResolved?.(info);
      },
    });
  }
  return { closed: false, released: false, quarantined: Boolean(token) };
}
