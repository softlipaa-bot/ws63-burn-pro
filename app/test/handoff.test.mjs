/**
 * W29-05：端口交接 / 通道并发 / 迟到回调。
 *
 * 复现的缺陷：
 * - cleanupMonitor 默认 closePort=false：错误清理释放了所有权却可能留下打开句柄；
 * - close 回调只清理未广播状态 → UI 一直显示“已连接”；
 * - adoptMonitor 先 transfer 再 attach，且 flush() 把首段启动日志冲掉；
 * - 迟到回调可能释放**新任务**的所有权。
 *
 * 这里用 monitor.js 的真实实现 + 注入的端口工厂（不走真实串口）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MonitorClosedError,
  __setPortFactory,
  abortAllMonitors,
  connectMonitor,
  disconnectMonitor,
  getMonitorSnapshot,
  adoptMonitor,
} from "../electron/serial/monitor.js";
import {
  OWNER_KIND,
  holderOf,
  ownerCount,
  releasePort,
  reservePort,
  resetRegistry,
} from "../electron/serial/ownership.js";
import { FakeSerialPort, sleep } from "./fake-serial-port.mjs";

function installFactory() {
  const created = [];
  __setPortFactory((opts) => {
    const port = new FakeSerialPort({ ...opts, autoOpen: false });
    created.push(port);
    return port;
  });
  return created;
}

test.beforeEach(async () => {
  resetRegistry();
  await abortAllMonitors();
  __setPortFactory(null);
});

test.afterEach(async () => {
  await abortAllMonitors();
  __setPortFactory(null);
  resetRegistry();
});

test("W29-05: connectMonitor 成功后有 MONITORING 所有权，断开后所有权归零", async () => {
  installFactory();
  const lines = [];
  await connectMonitor("1", "COM3", 115200, (t) => lines.push(t), () => {});
  assert.equal(getMonitorSnapshot().serialChannels["1"].connected, true);
  const holder = holderOf("COM3");
  assert.ok(holder);
  assert.equal(holder.kind, OWNER_KIND.MONITORING);

  await disconnectMonitor("1");
  assert.equal(ownerCount(), 0, "断开监听必须释放所有权");
  assert.equal(getMonitorSnapshot().serialChannels["1"].connected, false);
});

test("W29-05: 打开失败时必须释放预留的所有权（不能留下 opening 僵尸）", async () => {
  __setPortFactory((opts) =>
    new FakeSerialPort({ ...opts, autoOpen: false, openError: new Error("Access denied") }),
  );
  await assert.rejects(
    () => connectMonitor("1", "COM4", 115200, () => {}, () => {}),
    /Access denied/,
  );
  assert.equal(ownerCount(), 0, "open 失败后不能残留所有权");
});

test("W29-05: 端口 close（拔线）→ 清理并广播错误，UI 不会一直显示已连接", async () => {
  const created = installFactory();
  const errors = [];
  await connectMonitor("1", "COM5", 115200, () => {}, (err) => errors.push(err));
  assert.equal(getMonitorSnapshot().serialChannels["1"].connected, true);

  created[0].emit("close");
  await sleep(20);
  assert.equal(errors.length, 1, "close 必须广播，而不是静默清理");
  assert.ok(errors[0] instanceof MonitorClosedError);
  assert.equal(errors[0].code, "PORT_CLOSED");
  assert.equal(getMonitorSnapshot().serialChannels["1"].connected, false);
  assert.equal(ownerCount(), 0);
});

test("W29-05: 端口 error → 关掉句柄并广播（旧实现释放所有权却留下打开句柄）", async () => {
  const created = installFactory();
  const errors = [];
  await connectMonitor("1", "COM6", 115200, () => {}, (err) => errors.push(err));
  const port = created[0];

  port.emit("error", new Error("USB 断开"));
  await sleep(30);
  assert.equal(errors.length, 1);
  assert.equal(port.closeCalls >= 1, true, "错误路径必须真正关闭端口");
  assert.equal(port.isOpen, false);
  assert.equal(ownerCount(), 0);
});

test("W29-05【核心】: 迟到的旧端口回调不得释放新任务的所有权", async () => {
  const created = installFactory();
  await connectMonitor("1", "COM7", 115200, () => {}, () => {});
  const oldPort = created[0];
  const oldToken = holderOf("COM7").token;

  // 断开后立刻重新连接（新 token）
  await disconnectMonitor("1");
  await connectMonitor("1", "COM8", 115200, () => {}, () => {});
  const newToken = holderOf("COM8").token;
  assert.ok(newToken && newToken !== oldToken);

  // 旧端口的迟到 error / close 回调
  oldPort.emit("error", new Error("late error"));
  oldPort.emit("close");
  await sleep(30);

  assert.ok(holderOf("COM8"), "新监听的所有权不能被迟到回调删掉");
  assert.equal(holderOf("COM8").token, newToken);
  assert.equal(getMonitorSnapshot().serialChannels["1"].connected, true);
});

test("W29-05【核心】: adoptMonitor 不再 flush 端口，首段启动日志不会丢", async () => {
  const created = installFactory();
  const flasherPort = new FakeSerialPort({ path: "COM9", baudRate: 921600, autoOpen: true });
  created.push(flasherPort);

  // 烧录阶段已经收到、但还没被消费的启动日志（设备在复位后立刻输出）
  const firstBanner = "BOOT: WS63 v1.2.3 ready\n";

  const token = reservePort("COM9", { channel: "1", kind: OWNER_KIND.FLASHING }).token;
  const lines = [];
  const adopted = await adoptMonitor(
    "1",
    flasherPort,
    "COM9",
    115200,
    (text) => lines.push(text),
    () => {},
    { token },
  );
  assert.ok(adopted);

  // adoptMonitor 过程中不允许调用 flush（那会丢弃 OS 缓冲区里的首段字节）
  assert.equal(
    flasherPort.flushCalls ?? 0,
    0,
    "adoptMonitor 不应调用 port.flush()：会丢掉设备已经发出的首段日志",
  );

  flasherPort.emitData(Buffer.from(firstBanner));
  await sleep(150); // 等 splitter/flush 定时器
  assert.ok(
    lines.join("").includes("BOOT: WS63 v1.2.3 ready"),
    `首段启动日志必须送达，实际收到 ${JSON.stringify(lines)}`,
  );

  // 交接期间所有权连续：同一 token 从 HANDOFF/MONITORING 走下来
  assert.equal(holderOf("COM9").kind, OWNER_KIND.MONITORING);
  assert.equal(holderOf("COM9").token, token);
  await disconnectMonitor("1");
});

test("W29-05: adoptMonitor 遇到被别的任务持有的端口 → PORT_BUSY，且不抢所有权", async () => {
  const port = new FakeSerialPort({ path: "COM11", autoOpen: true });
  const other = reservePort("COM11", { channel: "2", kind: OWNER_KIND.FLASHING });
  await assert.rejects(
    () => adoptMonitor("1", port, "COM11", 115200, () => {}, () => {}),
    (err) => {
      assert.equal(err.code, "PORT_BUSY");
      return true;
    },
  );
  assert.equal(holderOf("COM11").token, other.token, "别人的所有权不能被改掉");
  releasePort(other.token);
});

test("W29-05: 同通道并发 connect 只有一个成功（所有权原子保留）", async () => {
  installFactory();
  const results = await Promise.allSettled([
    connectMonitor("1", "COM12", 115200, () => {}, () => {}),
    connectMonitor("1", "COM13", 115200, () => {}, () => {}),
  ]);
  const okCount = results.filter((r) => r.status === "fulfilled").length;
  assert.equal(okCount, 1, `同一通道只允许一个监听，实际成功 ${okCount}`);
  const rejected = results.find((r) => r.status === "rejected");
  assert.ok(rejected);
  assert.match(String(rejected.reason?.message ?? rejected.reason), /已连接|占用|正在连接/);
  await abortAllMonitors();
});
