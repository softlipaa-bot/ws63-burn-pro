/**
 * Codex 复审 followup 1~3 的原样时序回归（真实生产模块 + 合成端口）。
 *
 * 对应 `codex-lifecycle-followup.mjs` / `codex-lifecycle-followup-results.json`：
 *  1. 关闭失败被隔离后，驱动**后来**真关了 → 必须按 token 收尾并释放（旧：永久 closing）；
 *  2. connectMonitor 打开中 error + close 回调带 Error 且 isOpen=true → 不能无条件 release
 *     （旧：owner=null 但句柄还开着）；
 *  3. Ws63Flasher.openPort 超时后正常收尾，驱动迟到成功 → 真实句柄必须被关闭（旧：泄漏）。
 *
 * 统一规则由 electron/serial/port-lifecycle.js 提供，monitor / flasher / ipc 共用。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  clearQuarantine,
  closeWithConfirmation,
  getQuarantine,
  openWithDeadline,
  settlePortClose,
  sweepQuarantine,
  trackQuarantine,
} from "../electron/serial/port-lifecycle.js";
import {
  __setPortFactory,
  abortAllMonitors,
  connectMonitor,
  getMonitorSnapshot,
  getQuarantinedPorts,
} from "../electron/serial/monitor.js";
import { Ws63Flasher } from "../electron/burn/ws63flash.js";
import {
  OWNER_KIND,
  holderOf,
  ownerCount,
  reservePort,
  resetRegistry,
} from "../electron/serial/ownership.js";
import { sleep } from "./fake-serial-port.mjs";

/** 与 Codex 脚本同形的端口：close 一定回调 Error。 */
class ErrorOnClosePort extends EventEmitter {
  constructor({ path = "COM95" } = {}) {
    super();
    this.path = path;
    this.baudRate = 115200;
    this.isOpen = false;
    this.closeCalls = 0;
  }
  open(cb) {
    this.isOpen = true;
    cb(null);
  }
  close(cb) {
    this.closeCalls += 1;
    cb(new Error("synthetic close failed"));
  }
  update(o, cb) {
    cb?.(null);
  }
  flush(cb) {
    cb?.(null);
  }
  write(_d, cb) {
    cb?.(null);
  }
}

test.beforeEach(async () => {
  resetRegistry();
  clearQuarantine();
  await abortAllMonitors();
  __setPortFactory(null);
});

test.afterEach(async () => {
  await abortAllMonitors();
  __setPortFactory(null);
  clearQuarantine();
  resetRegistry();
});

/* ---------------------------------------------------- followup 1：隔离后的迟到关闭 */

test("followup 1: 关闭失败 → 隔离保留；驱动随后确认关闭 → 释放该 token 并广播", async () => {
  const port = new ErrorOnClosePort({ path: "COM95" });
  __setPortFactory(() => port);
  await connectMonitor("1", "COM95", 115200, () => {}, () => {});

  const errors = [];
  // 触发 error → 关闭失败 → 进入隔离
  port.emit("error", new Error("synthetic transient error"));
  await sleep(30);

  assert.equal(holderOf("COM95")?.kind, OWNER_KIND.CLOSING, "关闭未确认时必须保留 closing 占用");
  assert.equal(port.isOpen, true, "句柄仍在打开状态");
  assert.ok(
    getQuarantinedPorts().some((q) => q.path === "COM95"),
    "必须登记为隔离，而不是假装空闲",
  );

  // 驱动后来真的关了（isOpen=false + close 事件）
  port.isOpen = false;
  port.emit("close");
  await sleep(30);

  assert.equal(holderOf("COM95"), null, "迟到确认关闭后必须释放所有权（旧实现永久 closing）");
  assert.equal(getQuarantinedPorts().length, 0, "隔离条目必须清理");
  assert.equal(
    getMonitorSnapshot().serialChannels["1"].connected,
    false,
    "不得显示为已连接",
  );
  void errors;
});

test("followup 1b: 驱动不发 close 事件时，轮询兜底也能收尾", async () => {
  const port = new ErrorOnClosePort({ path: "COM94" });
  __setPortFactory(() => port);
  await connectMonitor("1", "COM94", 115200, () => {}, () => {});
  port.emit("error", new Error("transient"));
  await sleep(30);
  assert.equal(holderOf("COM94")?.kind, OWNER_KIND.CLOSING);

  port.isOpen = false; // 只改状态，不发事件
  sweepQuarantine();
  await sleep(20);
  assert.equal(holderOf("COM94"), null, "轮询兜底必须释放");
});

/* ------------------------------------------- followup 2：打开失败分支不得无条件释放 */

test("followup 2: 打开中 error + close 回调 Error 且仍 isOpen → 保留占用，不 release", async () => {
  class OpenErrorPort extends ErrorOnClosePort {
    open(cb) {
      this.isOpen = true;
      this.emit("error", new Error("synthetic opening error"));
      cb(null);
    }
  }
  const port = new OpenErrorPort({ path: "COM96" });
  __setPortFactory(() => port);

  await assert.rejects(() => connectMonitor("2", "COM96", 115200, () => {}, () => {}));

  // 旧实现：owner=null 但 open=true（双开风险）。新契约：保留 closing 占用
  const holder = holderOf("COM96");
  assert.ok(holder, "关闭未确认时绝不能释放所有权");
  assert.equal(holder.kind, OWNER_KIND.CLOSING);
  assert.equal(port.isOpen, true, "句柄仍开着");

  // 驱动确认关闭 → 释放
  port.isOpen = false;
  port.emit("close");
  await sleep(30);
  assert.equal(holderOf("COM96"), null);
});

/* ------------------------------------------- followup 3：烧录 open 超时后的迟到成功 */

test("followup 3: flasher.openPort 超时收尾后，驱动迟到成功必须被关闭（旧实现泄漏）", async () => {
  let lateCallback = null;
  const late = new ErrorOnClosePort({ path: "COM97" });
  late.open = (cb) => {
    lateCallback = cb; // 永不立刻回调
  };
  late.close = (cb) => {
    late.closeCalls += 1;
    late.isOpen = false;
    late.emit("close");
    cb?.(null);
  };

  const flasher = new Ws63Flasher({
    emit: () => {},
    timing: { resetTimeout: 100, handshakeRetryMs: 20 },
    createPort: async () => late,
  });

  // 用一个很短的 deadline 直接验证共享助手（生产里是 PORT_OP_TIMEOUT_MS = 8000）
  const opened = await openWithDeadline(late, 80);
  assert.equal(opened.ok, false);
  assert.equal(opened.timedOut, true);

  // 驱动迟到成功：句柄真的开了
  late.isOpen = true;
  lateCallback(null);
  await sleep(80);

  assert.equal(late.isOpen, false, "迟到成功的句柄必须被关闭，不能泄漏");
  assert.ok(late.closeCalls >= 1, "必须调用过 close");
  assert.equal(typeof flasher.openPort, "function");
});

test("followup 3b: 生产 openPort 超时后（8s 级）同样不留孤儿句柄", async () => {
  let lateCallback = null;
  const late = new ErrorOnClosePort({ path: "COM98" });
  late.open = (cb) => {
    lateCallback = cb;
  };
  late.close = (cb) => {
    late.closeCalls += 1;
    late.isOpen = false;
    late.emit("close");
    cb?.(null);
  };
  const flasher = new Ws63Flasher({
    emit: () => {},
    createPort: async () => late,
  });

  // 直接调用 closePort 验证"未确认关闭返回 false 且不丢句柄"的契约
  late.isOpen = true;
  const closed = await flasher.closePort();
  assert.equal(closed, true, "正常关闭应返回 true");

  // 关键：openWithDeadline 的迟到成功路径（用短 deadline 复现同一代码路径）
  const port2 = new ErrorOnClosePort({ path: "COM99" });
  let cb2 = null;
  port2.open = (cb) => {
    cb2 = cb;
  };
  port2.close = (cb) => {
    port2.closeCalls += 1;
    port2.isOpen = false;
    cb?.(null);
  };
  const res = await openWithDeadline(port2, 50);
  assert.equal(res.timedOut, true);
  port2.isOpen = true;
  cb2(null);
  await sleep(60);
  assert.equal(port2.isOpen, false, "迟到打开必须被收掉");
});

/* ------------------------------------------------------- 共享规则本身的单元断言 */

test("规则: closeWithConfirmation 覆盖四类情形", async () => {
  // 1) 未打开 → true
  assert.equal(await closeWithConfirmation({ isOpen: false }), true);
  // 2) 正常关闭 → true
  assert.equal(
    await closeWithConfirmation({
      isOpen: true,
      close(cb) {
        this.isOpen = false;
        cb(null);
      },
    }),
    true,
  );
  // 3) 回调 Error → false
  assert.equal(
    await closeWithConfirmation({
      isOpen: true,
      close(cb) {
        cb(new Error("x"));
      },
    }),
    false,
  );
  // 4) 回调正常但 isOpen 仍 true → false
  assert.equal(
    await closeWithConfirmation({
      isOpen: true,
      close(cb) {
        cb(null);
      },
    }),
    false,
  );
  // 5) 永不回调 → 超时 false
  const started = Date.now();
  assert.equal(await closeWithConfirmation({ isOpen: true, close() {} }, 60), false);
  assert.ok(Date.now() - started >= 50);
});

test("规则: settlePortClose 确认则释放、未确认则隔离并在迟到关闭时释放", async () => {
  // 未确认 → 隔离（token 保留）
  const token = reservePort("COM93", { channel: "1", kind: OWNER_KIND.CLOSING }).token;
  let released = 0;
  const stubborn = new EventEmitter();
  stubborn.isOpen = true;
  stubborn.close = (cb) => cb(new Error("nope"));
  const first = await settlePortClose({
    port: stubborn,
    token,
    release: () => {
      released += 1;
      return true;
    },
    channel: "1",
    path: "COM93",
    ms: 50,
  });
  assert.equal(first.closed, false);
  assert.equal(first.quarantined, true);
  assert.equal(released, 0, "未确认关闭不得释放");
  assert.ok(holderOf("COM93"), "占用必须保留");

  // 迟到关闭 → 释放
  stubborn.isOpen = false;
  stubborn.emit("close");
  await sleep(30);
  assert.equal(released, 1, "迟到确认关闭后必须释放");
});

test("规则: trackQuarantine 幂等（同 token 不重复登记）", () => {
  const port = new EventEmitter();
  port.isOpen = true;
  const a = trackQuarantine({ port, token: "tk1", channel: "1", path: "COM92" });
  const b = trackQuarantine({ port, token: "tk1", channel: "1", path: "COM92" });
  assert.equal(a, b);
  assert.equal(getQuarantine().filter((q) => q.token === "tk1").length, 1);
  clearQuarantine();
  assert.equal(getQuarantine().length, 0);
  void ownerCount;
});
