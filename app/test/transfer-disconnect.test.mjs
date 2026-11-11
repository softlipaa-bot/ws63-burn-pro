/**
 * W29-03 补充证据（Codex）：只修 readFrame 不足以覆盖传输阶段断线。
 *
 * 已核实的事实（baseline 复现，见 Implementation-Status.md §8）：
 *   先 close 再读 → baseline readByte(70) 要 ~77ms 才报“串口读取超时”，
 *   readFrame(160) 要 ~170ms 才返回 TIMEOUT，断线根本没被识别。
 *
 * 这里用**真实 SerialSession + FakeSerialPort**跑完整 flash()：
 * 握手成功 → 换波特率 → YMODEM 阶段断线，要求
 *   1) 立刻失败（远小于各阶段超时预算）
 *   2) 失败码是 PORT_CLOSED / IO_ERROR，而不是 NO_C / ACK_TIMEOUT / TIMEOUT
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SerialSession } from "../electron/burn/serial-session.js";
import { Ws63Flasher } from "../electron/burn/ws63flash.js";
import { buildDeviceFrame, makeValidPackage } from "./fixtures.mjs";
import { FakeSerialPort, sleep } from "./fake-serial-port.mjs";

const ACK = Buffer.from(buildDeviceFrame(0xe1, [0, 0, 0, 0]));

const TIMING = {
  resetTimeout: 400,
  handshakeRetryMs: 60,
  handshakeFrameMinGapMs: 1,
  settleAfterHandshakeMs: 1,
  settleAfterBaudMs: 1,
  commandAckTimeout: 1500,
  loaderConfirmTimeout: 1500,
  resetConfirmTimeout: 1500,
  ymodem: {
    cTimeout: 1500, // 故意给足预算：断线必须比它快得多
    ackTimeout: 1500,
    xmitTimeout: 5000,
    eotTimeout: 1500,
    maxBlockRetries: 5,
  },
};

/**
 * 设备行为：握手命令回 ACK；YMODEM 阶段由 ymodemBehavior 决定。
 */
function makeFlasher({ ymodemBehavior, onPortReady }) {
  let port;
  const logs = [];
  const events = [];
  const flasher = new Ws63Flasher({
    emit: (ev) => {
      events.push(ev);
      if (ev.type === "log") logs.push(ev.message);
    },
    timing: TIMING,
    createPort: async (options) => {
      port = new FakeSerialPort({
        path: options?.path ?? "COM9",
        onWrite: (data) => {
          const isCmd = data.length > 7 && data.toString("hex", 0, 4) === "efbeadde";
          if (isCmd && data[6] === 0xf0) {
            setTimeout(() => port.emitData(ACK), 0);
            return;
          }
          if (isCmd) return; // 擦除/结束命令：本用例不关心
          ymodemBehavior?.(data, port);
        },
      });
      onPortReady?.(port);
      return port;
    },
  });
  return { flasher, logs, events, getPort: () => port };
}

test("W29-03【核心】: YMODEM 等 'C' 阶段断线 → 立刻 PORT_CLOSED，不是 NO_C", async () => {
  const { flasher, getPort, logs } = makeFlasher({
    ymodemBehavior: (data, port) => {
      // 收到第一个数据块/信息块后就拔线
      if (data[0] === 0x01 || data[0] === 0x02) {
        setTimeout(() => port.unplug(), 5);
      }
    },
  });
  await flasher.openPort("COM9", 921600);
  assert.ok(flasher.session instanceof SerialSession);

  const started = Date.now();
  // 设备先发一个 'C' 让流程进入信息块，然后在第一个块后断线
  const feeder = setInterval(() => {
    const p = getPort();
    if (p?.isOpen) p.emitData(Buffer.from([0x43]));
  }, 10);

  try {
    await assert.rejects(
      () => flasher.flash(makeValidPackage()),
      (err) => {
        assert.ok(
          err.code === "PORT_CLOSED" || err.code === "IO_ERROR",
          `断线必须映射为 PORT_CLOSED/IO_ERROR，实际 ${err.code}（${err.message}）`,
        );
        assert.notEqual(err.code, "NO_C", "不能把断线说成“设备没进入接收状态”");
        return true;
      },
    );
  } finally {
    clearInterval(feeder);
  }
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < TIMING.ymodem.cTimeout + TIMING.ymodem.ackTimeout,
    `断线必须早于超时预算，实际 ${elapsed}ms`,
  );
  assert.ok(logs.length > 0);
});

test("W29-03【核心】: 传输中途 close（无 error）→ PORT_CLOSED，不等满 ACK 超时", async () => {
  let blockCount = 0;
  const { flasher, getPort } = makeFlasher({
    ymodemBehavior: (data, port) => {
      if (data[0] === 0x01 || data[0] === 0x02) {
        blockCount += 1;
        // 第 1 块是信息块 → ACK；第 2 块（第一个数据块）时断线
        if (blockCount === 1) {
          setTimeout(() => port.emitData(Buffer.from([0x06])), 0);
          return;
        }
        setTimeout(() => port.emit("close"), 5);
        return;
      }
    },
  });
  await flasher.openPort("COM9", 921600);

  // 设备持续发 'C'（真实 YMODEM 等待期行为），直到进入数据块
  const feeder = setInterval(() => {
    const p = getPort();
    if (p?.isOpen && blockCount === 0) p.emitData(Buffer.from([0x43]));
  }, 10);

  const started = Date.now();
  try {
    await assert.rejects(
      () => flasher.flash(makeValidPackage()),
      (err) => {
        assert.ok(
          err.code === "PORT_CLOSED" || err.code === "IO_ERROR",
          `传输中断线应为 PORT_CLOSED/IO_ERROR，实际 ${err.code}`,
        );
        return true;
      },
    );
  } finally {
    clearInterval(feeder);
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < TIMING.ymodem.ackTimeout * TIMING.ymodem.maxBlockRetries, `实际 ${elapsed}ms`);
  assert.ok(blockCount >= 2, `应当已经进入数据块阶段并断线，实际块数 ${blockCount}`);
});

test("W29-03: 断线后 flash() 不返回“成功”，且没有任何成功日志", async () => {
  const { flasher, logs } = makeFlasher({
    ymodemBehavior: (data, port) => {
      if (data[0] === 0x01 || data[0] === 0x02) setTimeout(() => port.unplug(), 5);
    },
  });
  await flasher.openPort("COM9", 921600);
  const feeder = setInterval(() => {
    const p = flasher.port;
    if (p?.isOpen) p.emitData(Buffer.from([0x43]));
  }, 10);
  try {
    await assert.rejects(() => flasher.flash(makeValidPackage()));
  } finally {
    clearInterval(feeder);
  }
  assert.equal(
    logs.some((l) => l.includes("文件传输完成") || l.includes("烧录协议完成")),
    false,
    "断线时绝不能出现“传输完成/协议完成”日志",
  );
});

test("W29-03: 取消（stopSignal）在 YMODEM 等 'C' 阶段立刻结束", async () => {
  const controller = new AbortController();
  const { flasher } = makeFlasher({ ymodemBehavior: () => {} });
  flasher.stopSignal = controller.signal;
  await flasher.openPort("COM9", 921600);
  const started = Date.now();
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(
    () => flasher.flash(makeValidPackage()),
    (err) => {
      assert.equal(err.code, "STOPPED");
      return true;
    },
  );
  assert.ok(Date.now() - started < 1200, "取消必须快速生效");
});

test("W29-03: close 之后再读是立刻 PORT_CLOSED（复现 Codex 的 77ms/170ms 场景）", async () => {
  const port = new FakeSerialPort({ path: "COM9", autoOpen: true });
  const session = new SerialSession(port);
  session.markOpen();
  port.emit("close"); // 先断线
  await sleep(5);

  const t1 = Date.now();
  await assert.rejects(
    () => session.readByte(70),
    (err) => {
      assert.equal(err.code, "PORT_CLOSED");
      return true;
    },
  );
  const readByteMs = Date.now() - t1;
  assert.ok(readByteMs < 20, `close 后 readByte 必须立即失败，实际 ${readByteMs}ms`);

  const { FrameParser, readFrame } = await import("../electron/burn/frame-parser.js");
  const t2 = Date.now();
  const res = await readFrame(session, new FrameParser(), { timeoutMs: 160 });
  const readFrameMs = Date.now() - t2;
  assert.equal(res.code, "PORT_CLOSED", "断线不能被报成 TIMEOUT");
  assert.ok(readFrameMs < 20, `close 后 readFrame 必须立即返回，实际 ${readFrameMs}ms`);
});
