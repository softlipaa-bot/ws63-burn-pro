/**
 * W29-14：退出/OTA 门禁回归。
 *
 * 目标：烧录或串口任务运行期间**绝不能**安装更新并重启进程 ——
 * 否则进程中途被杀，设备会停在 loader 模式、串口句柄留在一个已死的进程里。
 * 既有实现位于 electron/ota/updater.js 的 installUpdateAndRestart()（busy → 拒绝或排队），
 * 这里把它钉成回归，避免以后被"简化"掉。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  assertIdle,
  getBusyState,
  isBusy,
  notifyActivityChanged,
  pendingCount,
  registerBusyProbe,
  resetGate,
  whenIdle,
} from "../electron/app-gate.js";

test("门禁: busy 时 assertIdle 抛错并带上原因；空闲时通过", () => {
  resetGate();
  let busy = true;
  let reasons = ["1 路 烧录中"];
  registerBusyProbe(() => ({ busy, reasons }));

  assert.equal(isBusy(), true);
  assert.equal(getBusyState().busy, true);
  assert.throws(() => assertIdle("安装更新"), (err) => {
    // 实际文案：「安装更新被阻止：<原因>」，必须带上原因而不是只说不允许
    assert.match(err.message, /安装更新被阻止/);
    assert.match(err.message, /烧录中/);
    return true;
  });

  busy = false;
  reasons = [];
  assert.equal(isBusy(), false);
  // assertIdle 成功时返回当时的门禁状态（不抛错即可放行）
  const idleState = assertIdle("安装更新");
  assert.equal(idleState.busy, false);
  assert.deepEqual(idleState.reasons, []);
});

test("门禁: whenIdle 在忙时不执行，空闲后才执行", async () => {
  resetGate();
  let busy = true;
  registerBusyProbe(() => ({ busy, reasons: busy ? ["串口监听中"] : [] }));

  let ran = 0;
  const cancel = whenIdle(() => {
    ran += 1;
  }, "任务结束后安装更新");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran, 0, "忙的时候不得执行");
  assert.equal(pendingCount(), 1, "忙时应处于排队状态");
  assert.equal(typeof cancel, "function", "whenIdle 必须返回取消函数");

  // 实现是事件驱动（notifyActivityChanged），不是轮询：不通知就永远不执行
  busy = false;
  notifyActivityChanged();
  assert.equal(ran, 1, "空闲并通知后必须执行恰好一次");
  assert.equal(pendingCount(), 0);
  resetGate();
});

test("门禁: 取消排队后即使空闲也不再执行", async () => {
  resetGate();
  let busy = true;
  registerBusyProbe(() => ({ busy, reasons: busy ? ["烧录中"] : [] }));

  let ran = 0;
  const cancel = whenIdle(() => {
    ran += 1;
  }, "任务结束后安装更新");
  cancel?.();
  busy = false;
  notifyActivityChanged();
  assert.equal(ran, 0, "取消后即使空闲也不得执行");
  assert.equal(pendingCount(), 0);
  resetGate();
});
