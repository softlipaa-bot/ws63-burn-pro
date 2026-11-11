/**
 * 关键任务门禁（W06）。
 *
 * 烧录/监听等关键串口操作运行期间：
 * - 不允许安装更新（返回 TASKS_RUNNING，并可排队到“任务结束后安装”）；
 * - 不允许直接退出应用（先停止任务并等待资源收尾，再真正退出）。
 *
 * 活动状态由 ipc 层注册的 probe 提供（flashJobs + 串口监听所有权注册表），
 * 这里只做统一的判定、排队与日志，避免各处重复判断。
 */

/** @type {() => {busy: boolean, reasons: string[]}} */
let busyProbe = () => ({ busy: false, reasons: [] });

/** @type {Array<{fn: () => void, label: string}>} */
const pendingWhenIdle = [];

export class TaskBusyError extends Error {
  constructor(reasons, actionLabel = "该操作") {
    super(
      `${actionLabel}被阻止：${reasons.length ? reasons.join("；") : "有烧录/串口任务运行中"}`,
    );
    this.name = "TaskBusyError";
    this.code = "TASKS_RUNNING";
    this.reasons = reasons;
  }
}

export function registerBusyProbe(fn) {
  busyProbe = typeof fn === "function" ? fn : () => ({ busy: false, reasons: [] });
}

export function getBusyState() {
  try {
    const state = busyProbe() ?? {};
    const reasons = Array.isArray(state.reasons) ? state.reasons.filter(Boolean) : [];
    return { busy: Boolean(state.busy) || reasons.length > 0, reasons };
  } catch {
    return { busy: false, reasons: [] };
  }
}

export function isBusy() {
  return getBusyState().busy;
}

export function assertIdle(actionLabel) {
  const state = getBusyState();
  if (state.busy) throw new TaskBusyError(state.reasons, actionLabel);
  return state;
}

/**
 * 任务结束（或已经空闲）后执行一次；返回取消函数。
 */
export function whenIdle(fn, label = "任务结束后执行") {
  const item = { fn, label };
  pendingWhenIdle.push(item);
  notifyActivityChanged();
  return () => {
    const idx = pendingWhenIdle.indexOf(item);
    if (idx >= 0) pendingWhenIdle.splice(idx, 1);
  };
}

export function pendingCount() {
  return pendingWhenIdle.length;
}

/** 任一任务状态变化后调用；空闲时把排队的动作全部执行。 */
export function notifyActivityChanged() {
  if (!pendingWhenIdle.length) return;
  if (isBusy()) return;
  const items = pendingWhenIdle.splice(0, pendingWhenIdle.length);
  for (const item of items) {
    try {
      item.fn();
    } catch {
      /* 排队动作失败不应影响主流程 */
    }
  }
}

/**
 * 轮询等待空闲（用于退出流程），超时后返回 false。
 */
export async function waitIdle({ timeoutMs = 15000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isBusy()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return !isBusy();
}

export function resetGate() {
  pendingWhenIdle.length = 0;
  busyProbe = () => ({ busy: false, reasons: [] });
}
