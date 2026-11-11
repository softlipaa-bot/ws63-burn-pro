/**
 * 烧录进度合并。
 *
 * 同一通道在一帧里只保留最后一次进度。
 * seal() 之后（flash_done）拒绝新的进度，并丢掉已经排队、尚未画上的旧值。
 * 下一次 begin() 才重新接收。
 */

export function createProgressGuard() {
  /** @type {Map<string, number>} */
  const epoch = new Map();
  /** @type {Set<string>} */
  const sealed = new Set();
  /** @type {Map<string, number>} 主进程 generation，本地 epoch 不能代替它 */
  const sealedGeneration = new Map();
  /** @type {Map<string, { progress: number, partName?: string, generation: number, mainGeneration?: number }>} */
  const pending = new Map();

  function begin(channel) {
    const id = String(channel);
    sealed.delete(id);
    pending.delete(id);
    epoch.set(id, (epoch.get(id) ?? 0) + 1);
  }

  function seal(channel, generation) {
    const id = String(channel);
    sealed.add(id);
    const main = Number(generation);
    if (Number.isFinite(main)) sealedGeneration.set(id, main);
    pending.delete(id);
    epoch.set(id, (epoch.get(id) ?? 0) + 1);
  }

  function offer(channel, progress, partName, generation) {
    const id = String(channel);
    const main = Number(generation);
    const prev = pending.get(id);
    if (Number.isFinite(main)) {
      const sealedAt = sealedGeneration.get(id);
      if (sealedAt != null && main <= sealedAt) return { accepted: false, reason: "sealed" };
      if (prev && Number.isFinite(prev.mainGeneration) && main < prev.mainGeneration) {
        return { accepted: false, reason: "stale" };
      }
      pending.set(id, {
        progress: Number(progress) || 0,
        partName: partName != null ? String(partName) : prev?.partName,
        generation: epoch.get(id) ?? 0,
        mainGeneration: main,
      });
      return { accepted: true, generation: main };
    }
    if (sealed.has(id)) return { accepted: false, reason: "sealed" };
    const local = epoch.get(id) ?? 0;
    pending.set(id, {
      progress: Number(progress) || 0,
      partName: partName != null ? String(partName) : prev?.partName,
      generation: local,
    });
    return { accepted: true, generation: local };
  }

  function drain() {
    const applied = [];
    const dropped = [];
    for (const [channel, patch] of pending) {
      pending.delete(channel);
      if (Number.isFinite(patch.mainGeneration)) {
        const sealedAt = sealedGeneration.get(channel);
        if (sealedAt != null && patch.mainGeneration <= sealedAt) {
          dropped.push(channel);
          continue;
        }
      } else if (sealed.has(channel) || patch.generation !== (epoch.get(channel) ?? 0)) {
        dropped.push(channel);
        continue;
      }
      applied.push({
        channel,
        progress: patch.progress,
        partName: patch.partName,
        mainGeneration: patch.mainGeneration,
      });
    }
    return { applied, dropped };
  }

  return {
    begin,
    seal,
    offer,
    drain,
    isSealed: (channel) => sealed.has(String(channel)),
    pendingCount: () => pending.size,
  };
}

/**
 * 终态已经画上之后，快照可以更新状态，但不能把进度和阶段文案改回去。
 * 仍显示“正在烧录”的迟到快照整段丢掉。
 */
export function mergeSealedChannel(local, incoming, sealed) {
  const next = { ...(incoming ?? {}), bootVerified: false };
  if (!sealed) return next;
  if (next.running || next.status === "running") {
    return { ...(local ?? {}), bootVerified: false };
  }
  return {
    ...next,
    progress: local?.progress ?? next.progress,
    stageLabel: local?.stageLabel || next.stageLabel,
  };
}
