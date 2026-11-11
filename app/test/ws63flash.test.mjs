import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

import { FLASH_STAGES, FlashError, STAGE_SPEC, Ws63Flasher } from "../electron/burn/ws63flash.js";
import { inspectFwpkg } from "../electron/burn/fwpkg.js";
import { FakeDevice, FakePort, FakeSession, buildFwpkgBytes, makeValidPackage, writeTempFile } from "./fixtures.mjs";

const FAST_TIMING = {
  resetTimeout: 200,
  handshakeRetryMs: 20,
  handshakeFrameMinGapMs: 1,
  settleAfterHandshakeMs: 1,
  settleAfterBaudMs: 1,
  commandAckTimeout: 60,
  loaderConfirmTimeout: 60,
  resetConfirmTimeout: 60,
  ymodem: {
    cTimeout: 40,
    ackTimeout: 30,
    xmitTimeout: 300,
    eotTimeout: 120,
    maxBlockRetries: 2,
  },
};

function makeFlasher({ device, timing = FAST_TIMING, logs = [] }) {
  const session = new FakeSession(device);
  const port = new FakePort();
  const flasher = new Ws63Flasher({
    emit: (ev) => {
      if (ev.type === "log") logs.push(ev.message);
    },
    stopSignal: new AbortController().signal,
    createPort: async () => port,
    timing,
  });
  return { flasher, session, port, logs };
}

async function bindSession(flasher, session, port, path = "COM9") {
  flasher.port = port;
  flasher.session = session;
  flasher.targetBaud = 921600;
  port.isOpen = true;
}

test("W02: 正常设备应报告成功，且三个阶段结论都被记录", async () => {
  const device = new FakeDevice({ variant: "happy" });
  const { flasher, session, port } = makeFlasher({ device });
  await flasher.openPort("COM9", 921600);
  flasher.session = session; // 注入假会话（真实 SerialSession 依赖真端口数据）
  const result = await flasher.flash(makeValidPackage());

  assert.equal(result.transferComplete, true);
  assert.equal(result.protocolConfirmed, true);
  assert.equal(result.bootVerified, false, "没有启动确认协议就必须是未验证");
  assert.ok(result.messages.some((m) => m.includes("启动未验证")));
  const stages = flasher.stages.map((s) => s.stage);
  assert.ok(stages.includes("handshake"));
  assert.ok(stages.includes("partition_transfer"));
  assert.ok(stages.includes("finish"));
  assert.equal(device.negotiatedBaud, 921600);
  assert.equal(port.closed, false);
});

test("W02: 设备永不回 ACK → 握手阶段超时失败（不会报告成功）", async () => {
  const device = new FakeDevice({ variant: "happy" });
  // 让所有命令帧都不产生应答
  device.onWrite = (bytes) => {
    device.writes.push(Buffer.from(bytes));
  };
  const { flasher, session, port } = makeFlasher({ device });
  flasher.port = port;
  flasher.session = session;
  port.isOpen = true;
  flasher.targetBaud = 921600;

  await assert.rejects(
    () => flasher.flash(makeValidPackage()),
    (err) => {
      assert.ok(err instanceof FlashError);
      assert.equal(err.code, "HANDSHAKE_TIMEOUT");
      assert.equal(err.stage, "handshake");
      return true;
    },
  );
});

test("W02: 握手应答 CRC 始终坏 → BAD_FRAME 超时失败", async () => {
  const device = new FakeDevice({ variant: "bad-handshake-crc" });
  const { flasher, session, port } = makeFlasher({ device });
  flasher.port = port;
  flasher.session = session;
  port.isOpen = true;
  flasher.targetBaud = 921600;

  await assert.rejects(
    () => flasher.flash(makeValidPackage()),
    (err) => {
      assert.equal(err.code, "HANDSHAKE_TIMEOUT");
      assert.match(err.message, /HANDSHAKE|等待设备复位/);
      return true;
    },
  );
});

test("W02: YMODEM 无 'C' → 传输阶段明确失败（NO_C）", async () => {
  const device = new FakeDevice({ variant: "no-c" });
  const { flasher, session, port, logs } = makeFlasher({ device });
  flasher.port = port;
  flasher.session = session;
  port.isOpen = true;
  flasher.targetBaud = 921600;

  await assert.rejects(
    () => flasher.flash(makeValidPackage()),
    (err) => {
      assert.ok(err instanceof FlashError);
      assert.equal(err.code, "NO_C");
      assert.equal(err.stage, "partition_transfer");
      return true;
    },
  );
  assert.equal(
    logs.some((l) => l.includes("烧录完成")),
    false,
    "失败时必须没有成功日志",
  );
});

test("W02: 一直 NAK → 传输失败，整体不成功", async () => {
  const device = new FakeDevice({ variant: "nak-all" });
  const { flasher, session, port } = makeFlasher({ device });
  flasher.port = port;
  flasher.session = session;
  port.isOpen = true;
  flasher.targetBaud = 921600;

  await assert.rejects(
    () => flasher.flash(makeValidPackage()),
    (err) => {
      assert.ok(err instanceof FlashError);
      assert.equal(err.code, "ACK_TIMEOUT");
      return true;
    },
  );
});

test("W02: 擦除命令无应答 → ERASE_ACK_TIMEOUT（旧实现会忽略 0/-1 继续烧）", async () => {
  const device = new FakeDevice({ variant: "no-erase-ack" });
  const { flasher, session, port } = makeFlasher({ device });
  flasher.port = port;
  flasher.session = session;
  port.isOpen = true;
  flasher.targetBaud = 921600;

  await assert.rejects(
    () => flasher.flash(makeValidPackage()),
    (err) => {
      assert.ok(err instanceof FlashError);
      assert.equal(err.code, "ERASE_ACK_TIMEOUT");
      assert.equal(err.stage, "erase");
      return true;
    },
  );
  // 擦除应答缺失后不应继续把应用分区数据发出去
  const eraseCmdIndex = device.writes.findIndex((w) => w.toString("hex").startsWith("efbeadde") && w[6] === 0xd2);
  const blocksAfterErase = device.writes.filter(
    (w, idx) => idx > eraseCmdIndex && w[0] === 0x02,
  );
  assert.ok(eraseCmdIndex >= 0, "应已下发擦除命令");
  assert.equal(blocksAfterErase.length, 0, "擦除未被确认后不得继续传输应用数据");
});

test("W02: 结束命令无应答 → FINISH_ACK_TIMEOUT，不报告协议确认", async () => {
  const device = new FakeDevice({ variant: "no-finish-ack" });
  const { flasher, session, port } = makeFlasher({ device });
  flasher.port = port;
  flasher.session = session;
  port.isOpen = true;
  flasher.targetBaud = 921600;

  await assert.rejects(
    () => flasher.flash(makeValidPackage()),
    (err) => {
      assert.ok(err instanceof FlashError);
      assert.equal(err.code, "FINISH_ACK_TIMEOUT");
      return true;
    },
  );
});

test("W02: loaderboot 后无确认帧 → LOADER_CONFIRM_TIMEOUT", async () => {
  const device = new FakeDevice({ variant: "no-loader-ack" });
  const { flasher, session, port } = makeFlasher({ device });
  flasher.port = port;
  flasher.session = session;
  port.isOpen = true;
  flasher.targetBaud = 921600;

  await assert.rejects(
    () => flasher.flash(makeValidPackage()),
    (err) => {
      assert.equal(err.code, "LOADER_CONFIRM_TIMEOUT");
      return true;
    },
  );
});

test("W02: 停止信号能中断等待（可响应停止）", async () => {
  const device = new FakeDevice({ variant: "happy" });
  device.onWrite = () => {}; // 永不回应答
  const controller = new AbortController();
  const flasher = new Ws63Flasher({
    emit: () => {},
    stopSignal: controller.signal,
    createPort: async () => new FakePort(),
    timing: { ...FAST_TIMING, resetTimeout: 5000 },
  });
  flasher.port = new FakePort();
  flasher.session = new FakeSession(device);
  flasher.port.isOpen = true;
  setTimeout(() => controller.abort(), 30);
  const started = Date.now();
  await assert.rejects(
    () => flasher.flash(makeValidPackage()),
    (err) => {
      assert.equal(err.code, "STOPPED");
      return true;
    },
  );
  assert.ok(Date.now() - started < 3000, "停止应在 1s 内生效");
});

test("W01/W02: 坏包在打开串口前就被拒（createPort 从未被调用）", async () => {
  const badBytes = buildFwpkgBytes({
    cnt: 1,
    parts: [
      { name: "loaderboot", type: 0, offset: 4096, length: 1024, data: Buffer.alloc(0), burn_addr: 0x100000 },
    ],
    totalLength: 64,
    totalBytes: 64,
  });
  const badFile = writeTempFile(badBytes);

  let portCreated = false;
  const flasher = new Ws63Flasher({
    emit: () => {},
    stopSignal: new AbortController().signal,
    createPort: async () => {
      portCreated = true;
      return new FakePort();
    },
    timing: FAST_TIMING,
  });

  await assert.rejects(
    () => flasher.flash(badFile),
    (err) => {
      assert.equal(err.code, "FWPKG_OUT_OF_RANGE");
      assert.equal(err.stage, "prepare");
      return true;
    },
  );
  assert.equal(portCreated, false, "坏包不应产生任何串口打开动作");
  assert.equal(flasher.port, null);
});

test("W01: 传入快照时启动前再次确认文件未被替换", async () => {
  const file = makeValidPackage();
  const snapshot = inspectFwpkg(file);
  fs.writeFileSync(
    file,
    buildFwpkgBytes({
      parts: [{ name: "loaderboot", type: 0, data: Buffer.alloc(777, 3), burn_addr: 0x100000 }],
    }),
  );
  const flasher = new Ws63Flasher({
    emit: () => {},
    stopSignal: new AbortController().signal,
    createPort: async () => new FakePort(),
    timing: FAST_TIMING,
  });
  await assert.rejects(
    () => flasher.flash(snapshot),
    (err) => {
      assert.equal(err.code, "FWPKG_CHANGED");
      return true;
    },
  );
});

test("W02: 宽松模式（WS63_STRICT_PROTOCOL=0）只记录缺口，且协议仍不算确认", async () => {
  const device = new FakeDevice({ variant: "no-finish-ack" });
  const session = new FakeSession(device);
  const port = new FakePort();
  const flasher = new Ws63Flasher({
    emit: () => {},
    stopSignal: new AbortController().signal,
    createPort: async () => port,
    timing: FAST_TIMING,
    strictProtocol: false,
  });
  flasher.port = port;
  flasher.session = session;
  port.isOpen = true;
  flasher.targetBaud = 921600;

  const result = await flasher.flash(makeValidPackage());
  assert.equal(result.transferComplete, true, "文件确实传完了");
  assert.equal(result.protocolConfirmed, false, "缺应答就不能算协议确认");
  assert.equal(result.bootVerified, false);
  assert.ok(result.protocolGaps.length >= 1);
});

test("W02: 每个阶段都有成功条件/失败码/超时声明", () => {
  for (const stage of [
    FLASH_STAGES.PREPARE,
    FLASH_STAGES.HANDSHAKE,
    FLASH_STAGES.LOADER_TRANSFER,
    FLASH_STAGES.ERASE,
    FLASH_STAGES.FINISH,
    FLASH_STAGES.BOOT_VERIFY,
  ]) {
    const spec = STAGE_SPEC[stage];
    assert.ok(spec, `阶段 ${stage} 缺少规格声明`);
    assert.ok(spec.success, `阶段 ${stage} 缺少成功条件`);
    assert.ok(Array.isArray(spec.failCodes) && spec.failCodes.length, `阶段 ${stage} 缺少失败码`);
    assert.equal(typeof spec.retryable, "boolean");
    assert.ok("timeoutMs" in spec);
  }
});
