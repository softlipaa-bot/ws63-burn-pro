/**
 * 烧录结果语义（W29-07）。
 *
 * 旧实现的两个“假成功”：
 * 1. `runFlashBody` 只要 `flasher.flash()` 返回就 `ok = true`，即使
 *    `protocolConfirmed === false`（宽松模式缺应答、复位未确认都算“成功”）；
 * 2. `App.vue` 的 `flash_done` 只看 `ev.ok` 就渲染成功。
 *
 * 这里把三件事分开表达，不再合成一个布尔：
 * - transferComplete  文件字节是否真的发完（YMODEM 全部 ACK）
 * - protocolConfirmed 设备的命令/帧应答是否齐（缺一个就不算）
 * - bootVerified      设备启动是否被验证（当前协议没有启动确认协议，恒为 false）
 *
 * 只有 SUCCESS 允许让 UI 显示“成功”；取消永远不是成功。
 */

export const FLASH_OUTCOME = Object.freeze({
  SUCCESS: "success",
  /** 字节发完了，但设备应答不完整 → 不能算成功，可重试。 */
  PARTIAL: "partial",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const OUTCOME_TEXT = Object.freeze({
  success: "烧录完成（协议已确认；设备启动未验证）",
  partial: "文件已传完，但设备应答不完整 —— 不算烧录成功，建议重试",
  failed: "烧录失败",
  cancelled: "已取消",
});

/**
 * 由 flasher 的返回结果判定整次结果。
 * @param {{transferComplete?: boolean, protocolConfirmed?: boolean, bootVerified?: boolean, cancelled?: boolean}} result
 */
export function classifyFlashResult(result) {
  const transferComplete = Boolean(result?.transferComplete);
  const protocolConfirmed = Boolean(result?.protocolConfirmed);
  const bootVerified = false; // 协议未定义启动确认，永远保持未验证
  const base = {
    transferComplete,
    protocolConfirmed,
    bootVerified,
    cancelled: Boolean(result?.cancelled),
    retryable: false,
  };

  if (base.cancelled) {
    return {
      ...base,
      outcome: FLASH_OUTCOME.CANCELLED,
      // 结构化错误码：UI 据此分支，不依赖中文文案
      code: "STOPPED",
      ok: false,
      status: "idle",
      message: OUTCOME_TEXT.cancelled,
      retryable: true,
    };
  }
  if (transferComplete && protocolConfirmed) {
    return {
      ...base,
      outcome: FLASH_OUTCOME.SUCCESS,
      code: "OK",
      ok: true,
      status: "success",
      message: OUTCOME_TEXT.success,
      retryable: false,
    };
  }
  if (transferComplete && !protocolConfirmed) {
    const gaps = Array.isArray(result?.protocolGaps)
      ? result.protocolGaps.map((g) => `${g.stage}:${g.code}`).join(",")
      : "";
    return {
      ...base,
      outcome: FLASH_OUTCOME.PARTIAL,
      code: "PROTOCOL_INCOMPLETE",
      ok: false,
      status: "error",
      message: `${OUTCOME_TEXT.partial}${gaps ? `（缺口 ${gaps}）` : ""}`,
      retryable: true,
    };
  }
  return {
    ...base,
    outcome: FLASH_OUTCOME.FAILED,
    code: (typeof result?.code === "string" && result.code) || "TRANSFER_FAILED",
    ok: false,
    status: "error",
    message: OUTCOME_TEXT.failed,
    retryable: true,
  };
}

/**
 * 一律视为"用户/流程取消"的错误码（Codex 复审发现 ABORTED / FWPKG_ABORTED 未被识别）。
 *
 * - STOPPED       协议层主动停止
 * - ABORTED       串口会话被取消（写入/读取的 AbortSignal）
 * - FWPKG_ABORTED 固件校验/复制快照时取消
 *
 * 这些都**不是设备失败**：UI 应显示"已取消"，不得计作烧录失败。
 */
export const CANCELLATION_CODES = Object.freeze([
  "STOPPED",
  "ABORTED",
  "FWPKG_ABORTED",
]);

const CANCELLATION_CODE_SET = new Set(CANCELLATION_CODES);

/** 取消的判定：优先看错误码，**不依赖中文文案匹配**。 */
export function isCancellation(err) {
  if (!err) return false;
  const code = typeof err === "object" ? err.code : undefined;
  if (typeof code === "string" && CANCELLATION_CODE_SET.has(code)) return true;
  // 兜底：老代码可能只抛纯文本（仅在没有 code 时使用）
  if (code) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return msg === "烧录已取消" || msg.includes("烧录已取消") || msg.includes("操作已取消");
}

/**
 * 由异常判定整次结果：取消必须表现为 CANCELLED（不是失败，更不是成功）。
 * @param {any} err
 * @param {{stage?: string}} [meta]
 */
export function classifyFlashError(err, meta = {}) {
  const cancelled = isCancellation(err);
  const message = err instanceof Error ? err.message : String(err ?? "未知错误");
  const stage = meta.stage ?? (err && typeof err === "object" ? err.stage : "") ?? "";
  const code = (err && typeof err === "object" && err.code) || (cancelled ? "STOPPED" : "FLASH_FAILED");
  return {
    outcome: cancelled ? FLASH_OUTCOME.CANCELLED : FLASH_OUTCOME.FAILED,
    ok: false,
    status: cancelled ? "idle" : "error",
    cancelled,
    retryable: true,
    stage,
    code,
    message: cancelled ? OUTCOME_TEXT.cancelled : message,
    transferComplete: false,
    protocolConfirmed: false,
    bootVerified: false,
  };
}
