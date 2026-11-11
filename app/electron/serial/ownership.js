/**
 * 串口所有权注册表（W04）。
 *
 * 旧实现是“先检查占用，再 await 关闭监听，再登记 running”，中间任何 await 都可能让两个
 * 启动流程都通过检查。这里把占用权做成**同步原子保留**：
 *
 *   reserve(port, owner) -> token            // 同一 tick 内完成，await 之前
 *   transfer(token, newOwner) -> token       // 烧录 → 监听接管，所有权不断档
 *   release(token)                           // finally 释放
 *
 * 所有权种类：opening / flashing / handoff / monitoring。
 * 只有 monitoring 允许被烧录任务接管（接管时旧 token 立即失效，避免双重释放）。
 */

const KIND = Object.freeze({
  OPENING: "opening",
  FLASHING: "flashing",
  HANDOFF: "handoff",
  MONITORING: "monitoring",
  /**
   * 正在关闭（R4）：句柄还没确认关闭时必须继续占住端口。
   * 旧实现先释放 token 再异步 close，等于在“句柄还开着”的时候就把端口让给别人。
   * closing 不可被接管（reservePort 只允许接管 monitoring）。
   */
  CLOSING: "closing",
});

export const OWNER_KIND = KIND;

export class PortBusyError extends Error {
  constructor(port, holder) {
    super(
      `串口 ${port} 已被${holder?.channel ? ` ${holder.channel} 路` : ""}${holder?.kindLabel ?? "其他任务"}占用`,
    );
    this.name = "PortBusyError";
    this.code = "PORT_BUSY";
    this.port = port;
    this.holder = holder ?? null;
  }
}

const KIND_LABEL = {
  opening: "正在打开",
  flashing: "烧录任务",
  handoff: "接管串口",
  monitoring: "串口监听",
  closing: "正在关闭",
};

let tokenSeq = 0;

/** @type {Map<string, {token: string, port: string, channel: string|null, kind: string, since: number}>} */
const owners = new Map();

export function normalizePort(port) {
  return String(port ?? "")
    .trim()
    .toUpperCase()
    .replace(/^\\\\[.?]\\/, "");
}

function makeToken() {
  tokenSeq += 1;
  return `p${tokenSeq}_${Date.now().toString(36)}`;
}

export function holderOf(port) {
  const entry = owners.get(normalizePort(port));
  if (!entry) return null;
  return { ...entry, kindLabel: KIND_LABEL[entry.kind] ?? entry.kind };
}

/**
 * 原子保留端口。allowTakeoverMonitoring=true 时，若当前持有者是监听，
 * 直接把所有权转给新 owner（旧 token 立即失效），由调用方 await 关闭旧监听。
 * @returns {{token: string, port: string, tookOver: {channel: string|null, token: string}|null}}
 */
export function reservePort(port, owner = {}, { allowTakeoverMonitoring = false } = {}) {
  const normalized = normalizePort(port);
  if (!normalized) throw new Error("串口名为空");
  const current = owners.get(normalized);
  if (current) {
    if (allowTakeoverMonitoring && current.kind === KIND.MONITORING) {
      const tookOver = { channel: current.channel ?? null, token: current.token, kind: current.kind };
      const token = makeToken();
      owners.set(normalized, {
        token,
        port: normalized,
        channel: owner.channel ?? null,
        kind: owner.kind ?? KIND.FLASHING,
        since: Date.now(),
      });
      return { token, port: normalized, tookOver };
    }
    throw new PortBusyError(normalized, holderOf(normalized));
  }
  const token = makeToken();
  owners.set(normalized, {
    token,
    port: normalized,
    channel: owner.channel ?? null,
    kind: owner.kind ?? KIND.FLASHING,
    since: Date.now(),
  });
  return { token, port: normalized, tookOver: null };
}

/** 同端口所有权交接（烧录结束 → 监听接管）。token 不变，owner 更新。 */
export function transferPort(token, owner = {}) {
  for (const [port, entry] of owners) {
    if (entry.token !== token) continue;
    const next = {
      ...entry,
      channel: owner.channel ?? entry.channel,
      kind: owner.kind ?? entry.kind,
      since: Date.now(),
    };
    owners.set(port, next);
    return { token, port };
  }
  return null;
}

/** 释放；token 不匹配（已被接管）时是幂等空操作。 */
export function releasePort(token) {
  if (!token) return false;
  for (const [port, entry] of owners) {
    if (entry.token !== token) continue;
    owners.delete(port);
    return true;
  }
  return false;
}

export function releaseByChannel(channel) {
  let released = 0;
  for (const [port, entry] of [...owners]) {
    if (entry.channel !== channel) continue;
    owners.delete(port);
    released += 1;
  }
  return released;
}

export function snapshot() {
  const out = {};
  for (const [port, entry] of owners) {
    out[port] = { ...entry, kindLabel: KIND_LABEL[entry.kind] ?? entry.kind };
  }
  return out;
}

export function ownerCount() {
  return owners.size;
}

/** 仅用于测试与诊断重置。 */
export function resetRegistry() {
  owners.clear();
}
