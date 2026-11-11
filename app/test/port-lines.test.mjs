/**
 * W29-02 硬件安全：控制线策略。
 *
 * 依据（本机 @serialport/stream@13.0.0 dist/index.js）：
 *   const defaultSetFlags = { brk:false, cts:false, dtr:true, rts:true };
 *   set(options){ const settings = { ...defaultSetFlags, ...options }; ... }
 *
 * 所以旧实现的 `set({ rts:false })` 实际会下发 dtr:true。
 * 未知电路上拨 DTR 可能复位设备 —— 产品规则明令禁止“自动复位硬件”。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PORT_LINES_MODE,
  PORT_LINES_MODE,
  SERIALPORT_SET_DEFAULTS,
  buildSetFlags,
  describePortLines,
  normalizePortLinesMode,
} from "../electron/serial/port-lines.js";
import { Ws63Flasher } from "../electron/burn/ws63flash.js";
import { FakeSerialPort } from "./fake-serial-port.mjs";

function makeFlasher(opts = {}) {
  let port;
  const logs = [];
  const flasher = new Ws63Flasher({
    emit: (ev) => {
      if (ev.type === "log") logs.push({ message: ev.message, level: ev.level });
    },
    timing: { resetTimeout: 50, handshakeRetryMs: 10, handshakeFrameMinGapMs: 1 },
    createPort: async () => {
      port = new FakeSerialPort({ path: "COM9" });
      return port;
    },
    ...opts,
  });
  return { flasher, logs, getPort: () => port };
}

test("W29-02: 默认策略是 none（不调用 set，绝不主动拨线）", () => {
  assert.equal(DEFAULT_PORT_LINES_MODE, PORT_LINES_MODE.NONE);
  const flags = buildSetFlags(DEFAULT_PORT_LINES_MODE);
  assert.equal(flags.flags, null);
  assert.equal(flags.dtrAsserted, false);
  assert.match(describePortLines(DEFAULT_PORT_LINES_MODE), /不调用 set\(\)/);
});

test("W29-02【核心】: rts-low 会同时把 DTR 置 1 —— 必须显式暴露这个事实并报警", () => {
  const flags = buildSetFlags(PORT_LINES_MODE.RTS_LOW);
  assert.deepEqual(flags.flags, { brk: false, cts: false, dtr: true, rts: false });
  assert.equal(flags.dtrAsserted, true, "rts-low 下 DTR 一定是 1");
  assert.match(flags.warning, /DTR 置为 1/);
  assert.match(flags.warning, /可能复位设备/);
  // 与 serialport 实际默认合并结果一致
  assert.equal(SERIALPORT_SET_DEFAULTS.dtr, true);
  assert.equal(SERIALPORT_SET_DEFAULTS.rts, true);
});

test("W29-02: rts-low-dtr-low 是唯一不把 DTR 拉高的主动模式，但仍需电路依据", () => {
  const flags = buildSetFlags(PORT_LINES_MODE.RTS_LOW_DTR_LOW);
  assert.deepEqual(flags.flags, { brk: false, cts: false, dtr: false, rts: false });
  assert.equal(flags.dtrAsserted, false);
  assert.match(flags.warning, /确认 DTR 不接 RESET/);
});

test("W29-02: 未知取值一律回落到 none（不因为拼错就拨线）", () => {
  assert.equal(normalizePortLinesMode("rts-high"), PORT_LINES_MODE.NONE);
  assert.equal(normalizePortLinesMode(undefined), PORT_LINES_MODE.NONE);
  assert.equal(normalizePortLinesMode(""), PORT_LINES_MODE.NONE);
  assert.equal(buildSetFlags("garbage").flags, null);
});

test("W29-02【核心】: 默认模式下打开串口从不调用 port.set()", async () => {
  const { flasher, logs, getPort } = makeFlasher();
  await flasher.openPort("COM9", 921600);
  assert.equal(getPort().sets.length, 0, "默认策略下不允许出现任何 set() 调用");
  assert.equal(flasher.portLineInfo.applied, false);
  assert.equal(flasher.portLineInfo.flags, null);
  assert.ok(
    logs.some((l) => l.message.includes("不主动拨 RTS/DTR")),
    "必须留下“未拨线”的日志，便于现场核对",
  );
});

test("W29-02: 显式 rts-low 时下发的标志是四位完整集合，并记录 DTR 风险", async () => {
  const { flasher, logs, getPort } = makeFlasher({ portLines: PORT_LINES_MODE.RTS_LOW });
  await flasher.openPort("COM9", 921600);
  assert.equal(getPort().sets.length, 1);
  assert.deepEqual(getPort().sets[0], { brk: false, cts: false, dtr: true, rts: false });
  assert.equal(flasher.portLineInfo.applied, true);
  assert.equal(flasher.portLineInfo.dtrAsserted, true);
  assert.ok(
    logs.some((l) => l.level === "error" && l.message.includes("DTR")),
    "把 DTR 拉高必须用 error 级别提示",
  );
});

test("W29-02: set() 失败不致命（握手仍靠手动 RST），但会留下可见日志", async () => {
  const { flasher, logs, getPort } = makeFlasher({
    portLines: PORT_LINES_MODE.RTS_LOW_DTR_LOW,
  });
  getPort(); // 端口在 openPort 内部创建
  const original = flasher.createPort;
  flasher.createPort = async () => new FakeSerialPort({ path: "COM9", setError: new Error("set failed") });
  await flasher.openPort("COM9", 921600);
  assert.equal(flasher.portLineInfo.applied, false);
  assert.ok(logs.some((l) => l.message.includes("控制线设置未生效")));
  assert.equal(typeof original, "function");
});

test("W29-02: 控制线模式可通过环境变量配置，但默认仍是 none", async () => {
  const saved = process.env.WS63_PORT_LINES;
  try {
    delete process.env.WS63_PORT_LINES;
    const dflt = new Ws63Flasher({ emit: () => {} });
    assert.equal(dflt.portLinesMode, PORT_LINES_MODE.NONE);

    process.env.WS63_PORT_LINES = "rts-low";
    const viaEnv = new Ws63Flasher({ emit: () => {} });
    assert.equal(viaEnv.portLinesMode, PORT_LINES_MODE.RTS_LOW);

    // 构造参数优先于环境变量
    const explicit = new Ws63Flasher({ emit: () => {}, portLines: PORT_LINES_MODE.NONE });
    assert.equal(explicit.portLinesMode, PORT_LINES_MODE.NONE);
  } finally {
    if (saved === undefined) delete process.env.WS63_PORT_LINES;
    else process.env.WS63_PORT_LINES = saved;
  }
});
