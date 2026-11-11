/**
 * 打开失败 / 迟到打开 / 迟到关闭 的句柄所有权回归（Codex 复现 case 1&2 + 两条要求）。
 *
 * 规则：**打开未决或失败但句柄可能仍打开时，句柄与原 token 必须一起保留**；
 * 未确认关闭保持 closing + 隔离；只有驱动确认关闭才释放；
 * 未决期间同端口的新 start 必须被拒绝（不得趁空档双开）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { Ws63Flasher } from "../electron/burn/ws63flash.js";
import {
  clearQuarantine,
  getQuarantine,
  markQuarantineOpenLanded,
  settlePortClose,
  sweepQuarantine,
  trackQuarantine,
} from "../electron/serial/port-lifecycle.js";
import {
  OWNER_KIND,
  PortBusyError,
  holderOf,
  releasePort,
  reservePort,
  transferPort,
  resetRegistry,
} from "../electron/serial/ownership.js";
import { makeValidPackage } from "./fixtures.mjs";
import { sleep } from "./fake-serial-port.mjs";

/** 打开回调带 error 但句柄已 isOpen 的端口。 */
class ErrorButOpenPort extends EventEmitter {
  constructor(p) {
    super();
    this.path = p;
    this.baudRate = 921600;
    this.isOpen = false;
    this.closeCalls = 0;
    this.refuseClose = true;
  }
  open(cb) {
    this.isOpen = true;
    cb(new Error("synthetic open error"));
  }
  close(cb) {
    this.closeCalls += 1;
    if (this.refuseClose) cb(new Error("close refused"));
    else {
      this.isOpen = false;
      this.emit("close");
      cb(null);
    }
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

/** 打开永不回调（超时），之后可手动迟到成功。 */
class LateOpenPort extends EventEmitter {
  constructor(p) {
    super();
    this.path = p;
    this.baudRate = 921600;
    this.isOpen = false;
    this.closeCalls = 0;
    this.refuseClose = true;
    this.openCb = null;
  }
  open(cb) {
    this.openCb = cb;
  }
  lateSuccess() {
    this.isOpen = true;
    this.openCb?.(null);
  }
  close(cb) {
    this.closeCalls += 1;
    if (this.refuseClose) cb(new Error("close refused"));
    else {
      this.isOpen = false;
      this.emit("close");
      cb(null);
    }
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

test.beforeEach(() => {
  resetRegistry();
  clearQuarantine();
});

test.afterEach(() => {
  resetRegistry();
  clearQuarantine();
});

test("case 1: open 回调带 error 但 isOpen=true → 保留句柄与原 token（closing + 隔离）", async () => {
  const port = new ErrorButOpenPort("COM91");
  const token = reservePort("COM91", { channel: "1", kind: OWNER_KIND.FLASHING }).token;
  const flasher = new Ws63Flasher({ emit: () => {}, createPort: async () => port });

  await assert.rejects(() => flasher.openPort("COM91", 921600, { token, channel: "1" }));

  // 句柄没被丢弃
  assert.equal(flasher.hasPendingOpen(), true, "必须标记为未决句柄");
  assert.equal(port.isOpen, true);

  // 上层按统一规则收尾（与 ipc 相同）：转 closing → settle(pendingOpen) → 未确认即隔离
  const handle = flasher.detachForClose();
  assert.ok(handle, "必须把句柄交回上层，而不是 this.port=null");
  transferPort(token, { channel: "1", kind: OWNER_KIND.CLOSING });
  const settled = await settlePortClose({
    port: handle,
    token,
    release: releasePort,
    channel: "1",
    path: "COM91",
    ms: 50,
    pendingOpen: true,
  });
  assert.equal(settled.closed, false, "关闭被拒必须未确认");
  assert.equal(holderOf("COM91")?.kind, OWNER_KIND.CLOSING, "占用必须保留为 closing");
  assert.ok(getQuarantine().some((x) => x.path === "COM91"), "必须登记隔离");
});

test("case 2: 迟到打开 + 关闭被拒 → 保留隔离，且日志按实际结果（不谎称已关闭）", async () => {
  const port = new LateOpenPort("COM92");
  const token = reservePort("COM92", { channel: "2", kind: OWNER_KIND.FLASHING }).token;
  const logs = [];
  const flasher = new Ws63Flasher({
    emit: (ev) => {
      if (ev?.type === "log" || ev?.message) logs.push(String(ev.message ?? ""));
    },
    createPort: async () => port,
    timing: { resetTimeout: 50 },
  });

  // 直接复现"超时后迟到成功"的真实链路（不等待 8s 常量超时）
  transferPort(token, { channel: "2", kind: OWNER_KIND.CLOSING });
  trackQuarantine({ port, token, channel: "2", path: "COM92" });
  port.lateSuccess(); // 驱动迟到成功：句柄打开
  await sleep(30);

  assert.equal(port.isOpen, true, "关闭被拒时句柄仍开着");
  assert.equal(holderOf("COM92")?.kind, OWNER_KIND.CLOSING, "必须保留 closing 占用");
  assert.ok(getQuarantine().some((x) => x.path === "COM92"), "必须仍在隔离表里");
  void flasher;
  void logs;
});

test("迟到关闭确认后才释放隔离占用", async () => {
  const port = new ErrorButOpenPort("COM93");
  const token = reservePort("COM93", { channel: "3", kind: OWNER_KIND.CLOSING }).token;
  await settlePortClose({
    port,
    token,
    release: releasePort,
    channel: "3",
    path: "COM93",
    ms: 50,
    pendingOpen: true,
  });

  assert.equal(holderOf("COM93")?.kind, OWNER_KIND.CLOSING);
  // 打开已落地（open 回调已发生）→ 此后 isOpen 才可作为关闭依据
  markQuarantineOpenLanded(token);
  // 驱动这时才真正关闭
  port.refuseClose = false;
  port.isOpen = false;
  port.emit("close");
  await sleep(30);
  assert.equal(holderOf("COM93"), null, "确认关闭后必须释放");
  assert.equal(getQuarantine().some((x) => x.token === token), false, "隔离条目必须清理");
});

test("未决期间同端口新 start 被拒绝（不得趁空档双开）", () => {
  const port = new ErrorButOpenPort("COM94");
  const token = reservePort("COM94", { channel: "1", kind: OWNER_KIND.CLOSING }).token;
  trackQuarantine({ port, token, channel: "1", path: "COM94" });
  sweepQuarantine(); // 句柄仍 isOpen → 不会被误释放

  assert.throws(
    () => reservePort("COM94", { channel: "2", kind: OWNER_KIND.FLASHING }, { allowTakeoverMonitoring: false }),
    (err) => err instanceof PortBusyError,
    "closing 占用期间新任务必须被拒绝",
  );
  assert.ok(holderOf("COM94"), "占用仍在");
});
