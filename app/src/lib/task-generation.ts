/**
 * 按通道的任务代际闸门（Codex 复审：跨任务乱序事件）。
 *
 * 主进程权威分配 generation；每个 `progress / flash_stage / handshake_progress / flash_done`
 * 事件都带**该任务自己的**代际。渲染端必须按通道实际应用它，否则会出现两类真实故障：
 *
 *  1. 上一轮 task 的迟到事件（旧代际）到达时，把新一轮已经推进的状态改回去；
 *  2. 启动 IPC 响应晚于 `flash_done` 到达时，把已经失败/取消的通道重新显示成"正在烧录"。
 *
 * 规则（按通道独立）：
 *  - 事件代际 < 已应用代际 → 丢弃（迟到）；
 *  - 事件代际 > 已应用代际 → 采纳（新任务；这也覆盖"事件先于 IPC 响应到达"）；
 *  - 同代际下，一旦该代已进入终态（flash_done），后续 progress/stage 一律丢弃；
 *  - 启动响应只有在代际不旧、且该代尚未终态时才允许把通道置为运行中。
 *
 * 纯函数/纯状态，便于离线复现跨任务乱序。
 */

export type FlashChannelIdLike = string;

export interface GenerationGate {
  /** 已应用的代际（诊断/测试用） */
  applied(channel: FlashChannelIdLike): number;
  /** 记录该代已终态（flash_done） */
  markDone(channel: FlashChannelIdLike, generation: number): void;
  /** 该代是否已终态 */
  isDone(channel: FlashChannelIdLike, generation: number): boolean;
  /**
   * 事件是否应当被应用。
   * @param terminal 该事件是否为终态事件（flash_done）
   */
  acceptEvent(channel: FlashChannelIdLike, generation: number, terminal?: boolean): boolean;
  /**
   * 启动 IPC 响应到达时，是否仍应把该通道置为"运行中"。
   * @param generation 该通道在响应里的代际（缺省视为未知）
   */
  acceptStart(channel: FlashChannelIdLike, generation?: number): boolean;
  /** 新一轮任务开始时（本地发起）登记期望代际，用于"事件先于响应"的取舍 */
  expectFrom(channel: FlashChannelIdLike, generation?: number): void;
  reset(): void;
}

export function createGenerationGate(): GenerationGate {
  /** channel → 已应用的最大代际 */
  const applied = new Map<string, number>();
  /** channel → 已终态的代际集合 */
  const done = new Map<string, Set<number>>();

  const isOld = (have: number | undefined, gen: number) =>
    Number.isFinite(have) && Number.isFinite(gen) && gen < (have as number);

  return {
    applied(channel) {
      return applied.get(String(channel)) ?? 0;
    },

    markDone(channel, generation) {
      const ch = String(channel);
      if (Number.isFinite(generation)) {
        const set = done.get(ch) ?? new Set<number>();
        set.add(generation);
        done.set(ch, set);
        const have = applied.get(ch) ?? 0;
        if (generation > have) applied.set(ch, generation);
      }
    },

    isDone(channel, generation) {
      const set = done.get(String(channel));
      return Boolean(set && Number.isFinite(generation) && set.has(generation));
    },

    acceptEvent(channel, generation, terminal = false) {
      const ch = String(channel);
      // 没有代际（老主进程/非任务事件）：保守放行，但不更新代际状态
      if (!Number.isFinite(generation)) return !terminal ? true : true;

      const have = applied.get(ch);
      if (isOld(have, generation)) return false; // 迟到事件：丢弃
      // 同代已终态：终态事件不再重复应用，非终态事件一律丢弃
      if (this.isDone(ch, generation)) return false;
      const next = Math.max(have ?? generation, generation);
      applied.set(ch, next);
      if (terminal) this.markDone(ch, generation);
      return true;
    },

    acceptStart(channel, generation) {
      const ch = String(channel);
      if (!Number.isFinite(Number(generation))) {
        // 未知代际：只有在本地没有更新代际时才接受
        const have = applied.get(ch);
        return have === undefined;
      }
      const gen = Number(generation);
      const have = applied.get(ch);
      if (isOld(have, gen)) return false; // 已经跑起更新的任务了
      if (this.isDone(ch, gen)) return false; // 该代已终态（失败/取消）→ 不得改回运行中
      applied.set(ch, Math.max(have ?? gen, gen));
      return true;
    },

    expectFrom(channel, generation) {
      const ch = String(channel);
      if (Number.isFinite(generation)) {
        const have = applied.get(ch) ?? 0;
        if (Number(generation) > have) applied.set(ch, Number(generation));
      }
    },

    reset() {
      applied.clear();
      done.clear();
    },
  };
}

/**
 * 通道是否应显示"停止"。
 * Codex 复现：pending=true / running=false 的准备阶段没有停止入口，Esc 也取消不了
 * （旧 `flashRunning` 只看 running）。
 */
export function canStopChannel(state: {
  running?: boolean;
  pending?: boolean;
  startInFlight?: boolean;
}): boolean {
  return Boolean(state?.running || state?.pending || state?.startInFlight);
}

/** 是否存在任何"可停止/进行中"的任务（用于全局 Esc 与按钮禁用）。 */
export function anyTaskActive(states: Iterable<{ running?: boolean; pending?: boolean; startInFlight?: boolean }>): boolean {
  for (const s of states) {
    if (canStopChannel(s)) return true;
  }
  return false;
}
