/**
 * 失败通道重试与诊断导出。
 *
 * 只接受当前就是失败、且不在运行中的通道。
 * 调用进行中时第二次直接返回，不会再向桥接发一次烧录。
 * 这里不发起烧录，也不会在无人调用时自己启动。
 */

export function selectRetryChannels(rows) {
  const selected = [];
  const skipped = [];
  for (const row of rows ?? []) {
    const id = String(row?.id ?? "");
    if (row?.status !== "error") {
      skipped.push({ channel: id, reason: "不是失败状态，未重试" });
      continue;
    }
    if (row.running || row.pending) {
      skipped.push({ channel: id, reason: "该通道仍在运行，未重试" });
      continue;
    }
    if (!row.firmwarePath || !row.port) {
      skipped.push({ channel: id, reason: "缺少固件或串口，未重试" });
      continue;
    }
    selected.push(row);
  }
  return { selected, skipped };
}

export async function runUserRetry({ rows, gate, invoke }) {
  if (!gate || gate.current) {
    return {
      ok: false,
      started: [],
      skipped: [],
      reason: "重试已在进行，请等待这一次结束",
      inFlight: true,
    };
  }
  const decision = selectRetryChannels(rows);
  if (!decision.selected.length) {
    return {
      ok: false,
      started: [],
      skipped: decision.skipped,
      reason: "没有可重试的失败通道",
      inFlight: false,
    };
  }
  gate.current = true;
  try {
    const res = await invoke(decision.selected);
    const started = Array.isArray(res?.started) ? res.started.map(String) : [];
    const skipped = decision.skipped.concat(Array.isArray(res?.skipped) ? res.skipped : []);
    return {
      ok: started.length > 0 && res?.ok !== false,
      started,
      skipped,
      reason: res?.reason ? String(res.reason) : "",
      inFlight: false,
      tokens: res?.tokens && typeof res.tokens === "object" ? res.tokens : null,
      generations: res?.generations && typeof res.generations === "object" ? res.generations : null,
    };
  } finally {
    gate.current = false;
  }
}

export async function runDiagnosticExport({ gate, invoke }) {
  if (!gate || gate.current) {
    return { ok: false, inFlight: true, cancelled: false, bytes: 0, reason: "导出已在进行" };
  }
  gate.current = true;
  try {
    const res = await invoke();
    if (res?.cancelled || res?.ok === false) {
      return {
        ok: false,
        inFlight: false,
        cancelled: Boolean(res?.cancelled),
        bytes: 0,
        reason: String(res?.reason || (res?.cancelled ? "已取消导出诊断信息" : "导出失败")),
      };
    }
    return {
      ok: true,
      inFlight: false,
      cancelled: false,
      bytes: Number(res?.bytes ?? 0),
      reason: "",
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err ?? "导出失败");
    return { ok: false, inFlight: false, cancelled: false, bytes: 0, reason };
  } finally {
    gate.current = false;
  }
}
