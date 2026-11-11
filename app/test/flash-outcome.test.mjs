/**
 * W29-07：成功 / 取消语义。
 *
 * 复现的缺陷：
 * - runFlashBody 只要 flasher.flash() 返回就 ok=true（即使 protocolConfirmed=false）；
 * - App.vue 只看 ev.ok 显示成功；
 * - 取消既不能显示成功，也不能被当成普通失败。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CANCELLATION_CODES,
  FLASH_OUTCOME,
  classifyFlashError,
  classifyFlashResult,
  isCancellation,
} from "../electron/burn/flash-outcome.js";
import { FlashError } from "../electron/burn/ws63flash.js";

test("W29-07: 传输完成 + 协议确认 = 唯一允许的成功组合", () => {
  const v = classifyFlashResult({ transferComplete: true, protocolConfirmed: true });
  assert.equal(v.outcome, FLASH_OUTCOME.SUCCESS);
  assert.equal(v.ok, true);
  assert.equal(v.status, "success");
  assert.equal(v.bootVerified, false, "没有启动确认协议，恒为未验证");
});

test("W29-07【核心】: 文件传完但协议未确认 → PARTIAL，不得是成功（旧实现 ok=true）", () => {
  const v = classifyFlashResult({
    transferComplete: true,
    protocolConfirmed: false,
    protocolGaps: [{ stage: "finish", code: "FINISH_ACK_TIMEOUT" }],
  });
  assert.equal(v.outcome, FLASH_OUTCOME.PARTIAL);
  assert.equal(v.ok, false, "缺应答不能算成功");
  assert.equal(v.status, "error");
  assert.match(v.message, /不算烧录成功/);
  assert.match(v.message, /finish:FINISH_ACK_TIMEOUT/);
  assert.equal(v.retryable, true);
});

test("W29-07: 传输未完成 → FAILED", () => {
  const v = classifyFlashResult({ transferComplete: false, protocolConfirmed: false });
  assert.equal(v.outcome, FLASH_OUTCOME.FAILED);
  assert.equal(v.ok, false);
});

test("W29-07: 取消 → CANCELLED，既不是成功也不是普通失败", () => {
  const v = classifyFlashResult({ transferComplete: false, protocolConfirmed: false, cancelled: true });
  assert.equal(v.outcome, FLASH_OUTCOME.CANCELLED);
  assert.equal(v.ok, false);
  assert.equal(v.cancelled, true);
  assert.equal(v.status, "idle");
  assert.match(v.message, /已取消/);
});

test("W29-07: 任何结果的 bootVerified 都不允许为 true", () => {
  const combos = [
    { transferComplete: true, protocolConfirmed: true },
    { transferComplete: true, protocolConfirmed: false },
    { transferComplete: false, protocolConfirmed: false },
    { transferComplete: false, protocolConfirmed: false, cancelled: true },
    { transferComplete: true, protocolConfirmed: true, bootVerified: true }, // 即使上游乱传
  ];
  for (const c of combos) {
    assert.equal(classifyFlashResult(c).bootVerified, false);
  }
});

test("W29-07: STOPPED 异常 → CANCELLED（不是失败）", () => {
  const err = new FlashError("STOPPED", "reset", "烧录已取消");
  assert.equal(isCancellation(err), true);
  const v = classifyFlashError(err);
  assert.equal(v.outcome, FLASH_OUTCOME.CANCELLED);
  assert.equal(v.ok, false);
  assert.equal(v.cancelled, true);
  assert.equal(v.stage, "reset");
});

test("W29-07: 复位阶段的 STOPPED 必须取消到底，不能继续 DONE", () => {
  // 该用例的行为层验证在 ws63flash 的复位阶段；这里锁定分类语义
  const err = new FlashError("STOPPED", "reset", "烧录已取消");
  const v = classifyFlashError(err, { stage: "reset" });
  assert.equal(v.stage, "reset");
  assert.equal(v.outcome, FLASH_OUTCOME.CANCELLED);
});

test("W29-07: 普通失败保留原因与阶段，可重试", () => {
  const err = new FlashError("HANDSHAKE_TIMEOUT", "handshake", "等待设备复位进入下载模式超时");
  const v = classifyFlashError(err);
  assert.equal(v.outcome, FLASH_OUTCOME.FAILED);
  assert.equal(v.status, "error");
  assert.equal(v.code, "HANDSHAKE_TIMEOUT");
  assert.equal(v.stage, "handshake");
  assert.match(v.message, /等待设备复位/);
  assert.equal(v.retryable, true);
});

test("W29-07: 非 Error 抛出也被规范化，且不会变成成功", () => {
  const v = classifyFlashError("boom");
  assert.equal(v.ok, false);
  assert.equal(v.outcome, FLASH_OUTCOME.FAILED);
  assert.equal(v.message, "boom");
});

/* Codex 复审补充：取消码必须被识别为取消，不能算设备失败（不依赖中文文本） */

test("取消码: ABORTED（串口写入/读取被取消）→ CANCELLED，不是失败", () => {
  const err = Object.assign(new Error("操作已取消"), { code: "ABORTED" });
  assert.equal(isCancellation(err), true);
  const v = classifyFlashError(err);
  assert.equal(v.outcome, FLASH_OUTCOME.CANCELLED);
  assert.equal(v.cancelled, true);
  assert.equal(v.status, "idle");
  assert.equal(v.ok, false);
});

test("取消码: FWPKG_ABORTED（固件校验被取消）→ CANCELLED", () => {
  const err = Object.assign(new Error("固件校验已取消"), { code: "FWPKG_ABORTED" });
  assert.equal(isCancellation(err), true);
  const v = classifyFlashError(err);
  assert.equal(v.outcome, FLASH_OUTCOME.CANCELLED);
  assert.equal(v.cancelled, true);
});

test("取消码: 英文文案也要识别（证明不靠中文匹配）", () => {
  const err = Object.assign(new Error("operation aborted by caller"), { code: "ABORTED" });
  assert.equal(isCancellation(err), true);
});

test("取消码: 有错误码时不回退到文案匹配（避免把设备失败误判成取消）", () => {
  const err = Object.assign(new Error("烧录已取消（但这是设备报错）"), { code: "HANDSHAKE_TIMEOUT" });
  assert.equal(isCancellation(err), false);
  assert.equal(classifyFlashError(err).outcome, FLASH_OUTCOME.FAILED);
});
