import test from "node:test";
import assert from "node:assert/strict";

import {
  OWNER_KIND,
  PortBusyError,
  holderOf,
  normalizePort,
  ownerCount,
  releasePort,
  reservePort,
  resetRegistry,
  snapshot,
  transferPort,
} from "../electron/serial/ownership.js";

test("W04: 端口名规范化（大小写/空白/前缀）", () => {
  assert.equal(normalizePort(" com3 "), "COM3");
  assert.equal(normalizePort("\\\\.\\COM7"), "COM7");
  assert.equal(normalizePort(undefined), "");
});

test("W04: 同一端口的第二次保留立即失败（原子保留，无 await 窗口）", () => {
  resetRegistry();
  const a = reservePort("COM3", { channel: "1", kind: OWNER_KIND.FLASHING });
  assert.ok(a.token);
  assert.throws(
    () => reservePort("COM3", { channel: "2", kind: OWNER_KIND.FLASHING }),
    (err) => {
      assert.ok(err instanceof PortBusyError);
      assert.equal(err.code, "PORT_BUSY");
      assert.equal(err.holder.channel, "1");
      return true;
    },
  );
  // 大小写不同也是同一个端口
  assert.throws(() => reservePort("com3", { channel: "3", kind: OWNER_KIND.MONITORING }), PortBusyError);
  releasePort(a.token);
  assert.equal(ownerCount(), 0);
});

test("W04: 烧录可接管监听所有权，旧 token 释放是幂等空操作", () => {
  resetRegistry();
  const mon = reservePort("COM4", { channel: "1", kind: OWNER_KIND.MONITORING });
  const flash = reservePort(
    "COM4",
    { channel: "2", kind: OWNER_KIND.FLASHING },
    { allowTakeoverMonitoring: true },
  );
  assert.equal(flash.tookOver.channel, "1");
  assert.ok(flash.tookOver.token);

  // 旧监听的 release 不能把烧录的所有权删掉
  assert.equal(releasePort(mon.token), false);
  assert.equal(holderOf("COM4").channel, "2");

  // 烧录→监听：token 不变，所有权不断档
  const transferred = transferPort(flash.token, { channel: "2", kind: OWNER_KIND.MONITORING });
  assert.ok(transferred);
  assert.equal(holderOf("COM4").kind, OWNER_KIND.MONITORING);
  assert.equal(holderOf("COM4").token, flash.token);

  releasePort(flash.token);
  assert.equal(ownerCount(), 0);
});

test("W04: 正在打开/烧录/接管中的端口不允许被接管", () => {
  resetRegistry();
  const opening = reservePort("COM5", { channel: "1", kind: OWNER_KIND.OPENING });
  assert.throws(
    () =>
      reservePort("COM5", { channel: "2", kind: OWNER_KIND.FLASHING }, { allowTakeoverMonitoring: true }),
    PortBusyError,
  );
  releasePort(opening.token);
});

test("W04: 10 个通道并发抢同一端口，只有 1 个成功", () => {
  resetRegistry();
  const results = [];
  for (let i = 0; i < 10; i += 1) {
    try {
      results.push(reservePort("COM6", { channel: String(i + 1), kind: OWNER_KIND.FLASHING }));
    } catch (err) {
      results.push(err);
    }
  }
  assert.equal(results.filter((r) => r.token).length, 1);
  assert.equal(results.filter((r) => r instanceof PortBusyError).length, 9);
  const snap = snapshot();
  assert.equal(Object.keys(snap).length, 1);
  resetRegistry();
});
