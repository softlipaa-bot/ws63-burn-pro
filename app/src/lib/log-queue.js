/**
 * 渲染端日志队列。
 *
 * 条数和字节同时封顶；每次只刷一批，避免一次拼接整段积压。
 * 窗口隐藏时 rAF 可能不跑，用定时器继续刷；回到前台时把剩下的排进下一帧。
 */

export const DEFAULT_MAX_PENDING_LOG_PARTS = 2000;
/**
 * C6：上限按 **UTF-8 字节** 计量。
 * 旧实现只数 JS `string.length`（UTF-16 码元），261,000 个汉字实际是 783,000 字节，
 * 标称 256 KiB 等于没有生效。字符数仍然作为观测指标保留在 stats()。
 */
export const DEFAULT_MAX_PENDING_LOG_BYTES = 256 * 1024;
/**
 * @deprecated 旧名字，保留导出只为兼容既有调用/测试。
 * 值现在表示**字节**上限（256 KiB），不再是字符数 —— 见 C6。
 */
export const DEFAULT_MAX_PENDING_LOG_CHARS = DEFAULT_MAX_PENDING_LOG_BYTES;
export const DEFAULT_BATCH_PARTS = 80;
export const DEFAULT_BATCH_BYTES = 32 * 1024;
export const DEFAULT_BACKSTOP_MS = 200;

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

/** 字符串的 UTF-8 字节数（浏览器与 Node 一致）。 */
export function utf8Bytes(text) {
  const s = String(text ?? "");
  if (encoder) return encoder.encode(s).length;
  // 兜底（极老环境）：按码点估算，不用于精确预算
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function createLogQueue(options = {}) {
  const maxParts = options.maxParts ?? DEFAULT_MAX_PENDING_LOG_PARTS;
  // 主预算是字节；maxChars 作为可选的**附加**字符上限（缺省不生效），仅为兼容旧调用
  const maxBytes = options.maxBytes ?? options.maxChars ?? DEFAULT_MAX_PENDING_LOG_BYTES;
  const maxChars = options.maxBytes != null ? (options.maxChars ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
  const batchParts = options.batchParts ?? DEFAULT_BATCH_PARTS;
  const batchBytes = options.batchBytes ?? options.batchChars ?? DEFAULT_BATCH_BYTES;
  const batchChars = options.batchBytes != null ? (options.batchChars ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
  const backstopMs = options.backstopMs ?? DEFAULT_BACKSTOP_MS;
  const scheduleFrame = options.scheduleFrame ?? ((cb) => requestAnimationFrame(cb));
  const cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
  const scheduleTimer = options.scheduleTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const cancelTimer = options.cancelTimer ?? ((id) => clearTimeout(id));
  const onFlush = options.onFlush ?? (() => {});
  const onResume = options.onResume ?? (() => {});

  /** @type {{ text: string, channel: string | null }[]} */
  let parts = [];
  let head = 0;
  let pendingChars = 0;
  let pendingBytes = 0;
  let dropped = 0;
  let reported = 0;
  let hidden = false;
  let frameId = 0;
  let frameToken = 0;
  let timerId = 0;
  let disposed = false;

  function length() {
    return parts.length - head;
  }

  function compact() {
    if (head > 512 && head * 2 > parts.length) {
      parts = parts.slice(head);
      head = 0;
    }
  }

  function shift() {
    const item = parts[head];
    head += 1;
    compact();
    return item;
  }

  function cancelScheduledFrame() {
    if (!frameId) return;
    cancelFrame(frameId);
    frameId = 0;
    frameToken += 1;
  }

  function cancelScheduledTimer() {
    if (!timerId) return;
    cancelTimer(timerId);
    timerId = 0;
  }

  function armTimer() {
    if (disposed || timerId || length() === 0) return;
    timerId = scheduleTimer(() => {
      timerId = 0;
      if (disposed) return;
      cancelScheduledFrame();
      const more = flushBatch();
      if (more) hidden ? armTimer() : scheduleVisibleFrame();
    }, backstopMs);
  }

  function scheduleVisibleFrame() {
    if (disposed || hidden || frameId || length() === 0) return;
    const token = ++frameToken;
    frameId = scheduleFrame(() => {
      if (token !== frameToken) return;
      frameId = 0;
      if (disposed) return;
      const more = flushBatch();
      if (!more) return;
      if (hidden) armTimer();
      else scheduleVisibleFrame();
    });
  }

  function flushBatch() {
    if (length() === 0) return false;
    const items = [];
    let chars = 0;
    let bytesInBatch = 0;
    while (length() > 0 && items.length < batchParts) {
      const next = parts[head];
      const nextBytes = utf8Bytes(next.text);
      // 至少放一条，避免单条超预算时永远刷不出去
      if (items.length > 0 && chars + next.text.length > batchChars) break;
      if (items.length > 0 && bytesInBatch + nextBytes > batchBytes) break;
      const item = shift();
      pendingChars -= item.text.length;
      pendingBytes -= utf8Bytes(item.text);
      items.push(item);
      chars += item.text.length;
      bytesInBatch += nextBytes;
    }
    if (pendingChars < 0) pendingChars = 0;
    if (pendingBytes < 0) pendingBytes = 0;
    const droppedNow = dropped - reported;
    reported = dropped;
    onFlush(items, { dropped: droppedNow });
    return length() > 0;
  }

  function enqueue(text, channel = null) {
    if (disposed) return;
    const piece = String(text ?? "");
    if (!piece) return;
    const pieceBytes = utf8Bytes(piece);
    if (pieceBytes > maxBytes || piece.length > maxChars) {
      dropped += 1;
      const droppedNow = dropped - reported;
      reported = dropped;
      if (droppedNow > 0) onFlush([], { dropped: droppedNow });
      return;
    }
    while (
      length() > 0
      && (length() >= maxParts
        || pendingBytes + pieceBytes > maxBytes
        || pendingChars + piece.length > maxChars)
    ) {
      const old = shift();
      pendingChars -= old.text.length;
      pendingBytes -= utf8Bytes(old.text);
      dropped += 1;
    }
    if (pendingChars < 0) pendingChars = 0;
    if (pendingBytes < 0) pendingBytes = 0;
    parts.push({ text: piece, channel: channel == null ? null : String(channel) });
    pendingChars += piece.length;
    pendingBytes += pieceBytes;
    armTimer();
    scheduleVisibleFrame();
  }

  function clear() {
    parts = [];
    head = 0;
    pendingChars = 0;
    pendingBytes = 0;
    dropped = 0;
    reported = 0;
    cancelScheduledFrame();
    cancelScheduledTimer();
  }

  function setBackground(next) {
    if (disposed) return;
    const wasHidden = hidden;
    hidden = Boolean(next);
    if (hidden) {
      cancelScheduledFrame();
      if (length() > 0) armTimer();
      return;
    }
    cancelScheduledTimer();
    if (length() > 0) scheduleVisibleFrame();
    if (wasHidden) onResume();
  }

  function stats() {
    return {
      parts: length(),
      chars: pendingChars,
      bytes: pendingBytes,
      dropped,
      hidden,
    };
  }

  function dispose() {
    disposed = true;
    clear();
  }

  return {
    enqueue,
    flushBatch,
    clear,
    setBackground,
    stats,
    hasPending: () => length() > 0,
    dispose,
  };
}
