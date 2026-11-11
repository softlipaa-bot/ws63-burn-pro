import test from "node:test";
import assert from "node:assert/strict";

import {
  TaskBusyError,
  assertIdle,
  getBusyState,
  notifyActivityChanged,
  pendingCount,
  registerBusyProbe,
  resetGate,
  waitIdle,
  whenIdle,
} from "../electron/app-gate.js";

test("W06: 烧录中安装更新被阻止，并给出原因", () => {
  resetGate();
  registerBusyProbe(() => ({ busy: true, reasons: ["设备 1 正在烧录"] }));
  assert.equal(getBusyState().busy, true);
  assert.throws(
    () => assertIdle("安装更新"),
    (err) => {
      assert.ok(err instanceof TaskBusyError);
      assert.equal(err.code, "TASKS_RUNNING");
      assert.match(err.message, /设备 1 正在烧录/);
      return true;
    },
  );
  resetGate();
});

test("W06: 忙碌时选择“任务结束后安装”会被排队，空闲后自动执行", async () => {
  resetGate();
  let busy = true;
  registerBusyProbe(() => ({ busy, reasons: busy ? ["设备 2 正在烧录"] : [] }));

  let executed = 0;
  whenIdle(() => {
    executed += 1;
  }, "任务结束后安装更新");
  assert.equal(pendingCount(), 1);
  assert.equal(executed, 0, "忙碌时不应立即执行");

  busy = false;
  notifyActivityChanged();
  assert.equal(executed, 1);
  assert.equal(pendingCount(), 0);
  resetGate();
});

test("W06: waitIdle 在任务结束后返回 true，超时返回 false", async () => {
  resetGate();
  let busy = true;
  registerBusyProbe(() => ({ busy, reasons: busy ? ["监听中"] : [] }));
  setTimeout(() => {
    busy = false;
  }, 80);
  assert.equal(await waitIdle({ timeoutMs: 2000, pollMs: 20 }), true);

  registerBusyProbe(() => ({ busy: true, reasons: ["一直忙"] }));
  assert.equal(await waitIdle({ timeoutMs: 120, pollMs: 20 }), false);
  resetGate();
});

test("W06: 排队动作可以被取消", () => {
  resetGate();
  registerBusyProbe(() => ({ busy: true, reasons: ["忙"] }));
  let executed = 0;
  const cancel = whenIdle(() => {
    executed += 1;
  });
  cancel();
  assert.equal(pendingCount(), 0);
  registerBusyProbe(() => ({ busy: false, reasons: [] }));
  notifyActivityChanged();
  assert.equal(executed, 0);
  resetGate();
});

test("W06: probe 抛错时按空闲处理（不阻塞退出）", () => {
  resetGate();
  registerBusyProbe(() => {
    throw new Error("probe boom");
  });
  assert.equal(getBusyState().busy, false);
  resetGate();
});
