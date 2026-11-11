/**
 * W29-02：握手真实链路测试。
 *
 * 关键点（与旧测试的区别）：这里注入的是**真实 SerialSession**，
 * 端口是真实的 EventEmitter（FakeSerialPort），因此
 *   open → 绑监听 → data/error/close → 队列 → FrameParser → readFrame
 * 整条链路都被覆盖，而不是用 FakeSession 直接喂字节。
 *
 * 设备侧的字节仍然来自既有 fixtures.mjs 的 buildDeviceFrame()，
 * 没有为了让新实现通过而修改设备协议行为。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { FLASH_STAGES, Ws63Flasher, buildHandshakeTimeoutMessage } from "../electron/burn/ws63flash.js";
import { SerialSession } from "../electron/burn/serial-session.js";
import { FrameParser, readFrame } from "../electron/burn/frame-parser.js";
import { buildDeviceFrame } from "./fixtures.mjs";
import { FakeSerialPort, splitAt, sleep } from "./fake-serial-port.mjs";

const ACK = Buffer.from(buildDeviceFrame(0xe1, [0, 0, 0, 0]));

const FAST = {
  resetTimeout: 300,
  handshakeRetryMs: 60,
  handshakeFrameMinGapMs: 1,
  settleAfterHandshakeMs: 1,
  settleAfterBaudMs: 1,
  commandAckTimeout: 60,
  loaderConfirmTimeout: 60,
  resetConfirmTimeout: 60,
};

/**
 * 建立“真实 SerialSession + 假端口”的 flasher，并让设备在收到握手命令后按
 * chunks 推送 ACK（可指定分片与延迟）。
 */
function makeRealFlasher({
  timing = FAST,
  ackChunks = null,
  ackDelayMs = 0,
  onAckWrite = null,
  ackPolicy,
  stopSignal,
  portOpts = {},
} = {}) {
  const events = [];
  const logs = [];
  let port;
  const flasher = new Ws63Flasher({
    emit: (ev) => {
      events.push(ev);
      if (ev.type === "log") logs.push(ev.message);
    },
    stopSignal: stopSignal ?? new AbortController().signal,
    timing,
    ackPolicy,
    createPort: async (options) => {
      port = new FakeSerialPort({
        ...portOpts,
        path: options?.path ?? "COM9",
        onWrite: (data) => {
          const isHandshake = data.length > 4 && data.toString("hex", 0, 4) === "efbeadde" && data[6] === 0xf0;
          if (!isHandshake) return;
          if (onAckWrite) {
            onAckWrite(data, port);
            return;
          }
          const chunks = ackChunks ?? [ACK];
          setTimeout(() => {
            for (const chunk of chunks) port.emitData(chunk);
          }, ackDelayMs);
        },
      });
      return port;
    },
  });
  return {
    flasher,
    events,
    logs,
    getPort: () => port,
  };
}

/* ------------------------------------------------------------------ 成功路径 */

test("W29-02: ACK 在每一个切分边界到达都必须握手成功（旧实现 readAllPending+includes 会丢跨批次帧）", async () => {
  for (let cut = 1; cut < ACK.length; cut += 1) {
    const { flasher, getPort } = makeRealFlasher({ ackChunks: splitAt(ACK, [cut]) });
    await flasher.openPort("COM9", 921600);
    assert.ok(flasher.session instanceof SerialSession, "真实链路必须使用 SerialSession");
    const res = await flasher.stageHandshake();
    assert.equal(res.attempts, 1, `切分点 ${cut}：第一帧完整 ACK 就该成功`);
    assert.equal(res.frame.cmd, 0xe1);
    assert.ok(getPort().updates.length === 0);
  }
});

test("W29-02: 逐字节到达 ACK（8+ 片）也必须成功", async () => {
  const chunks = Array.from(ACK, (b) => Buffer.from([b]));
  const { flasher } = makeRealFlasher({ ackChunks: chunks });
  await flasher.openPort("COM9", 921600);
  const res = await flasher.stageHandshake();
  assert.equal(res.attempts, 1);
  assert.equal(res.frame.cmd, 0xe1);
});

test("W29-02: ACK 在重试窗口之后才到达 → 下一次尝试仍能拿到（不会把已到达的半帧丢掉）", async () => {
  const { flasher } = makeRealFlasher({
    timing: { ...FAST, resetTimeout: 800, handshakeRetryMs: 20 },
    ackDelayMs: 40, // 超过单次 readFrame 的窗口
  });
  await flasher.openPort("COM9", 921600);
  const res = await flasher.stageHandshake();
  assert.ok(res.attempts >= 1, "迟到的 ACK 应被后续尝试消费");
  assert.equal(res.frame.cmd, 0xe1);
});

test("W29-02: 噪声 + 坏 CRC 帧之后到达的正确 ACK 仍能握手成功", async () => {
  const noise = Buffer.from([0x00, 0x11, 0x22, 0xef, 0xbe]); // 含半个 magic 前缀
  const badCrc = Buffer.from(buildDeviceFrame(0xe1, [0, 0, 0, 0], { corruptCrc: true }));
  const { flasher, logs } = makeRealFlasher({ ackChunks: [noise, badCrc, ACK] });
  await flasher.openPort("COM9", 921600);
  const res = await flasher.stageHandshake();
  assert.equal(res.frame.cmd, 0xe1);
  assert.ok(logs.some((l) => l.includes("CRC")), "坏帧必须留下可见日志");
});

test("W29-02: 复位时机偏移（命令后很久才按 RST）在 60s 产品超时内仍能成功", async () => {
  const { flasher } = makeRealFlasher({
    timing: { ...FAST, resetTimeout: 400, handshakeRetryMs: 50, handshakeFrameMinGapMs: 5 },
    ackDelayMs: 150,
  });
  await flasher.openPort("COM9", 921600);
  const res = await flasher.stageHandshake();
  assert.equal(res.frame.cmd, 0xe1);
  assert.ok(res.attempts >= 1);
});

test("W29-02: 打开端口期间就到达的 ACK 不能被漏掉（open→set 的收包空窗）", async () => {
  const { flasher } = makeRealFlasher({
    portOpts: {
      onOpen: (port) => {
        // 端口刚打开、串口控制线还没设置时，设备就把 ACK 推上来了
        port.emitData(ACK);
      },
    },
  });
  await flasher.openPort("COM9", 921600);
  // 此时 ACK 应该已经在 session 缓冲里，握手第一次尝试即命中
  const res = await flasher.stageHandshake();
  assert.equal(res.attempts, 1, "打开阶段到达的 ACK 必须被保留");
  assert.equal(res.frame.cmd, 0xe1);
});

test("W29-02: 握手成功会回报尝试次数与接收字节（供 UI 展示）", async () => {
  const { flasher, events } = makeRealFlasher({ ackChunks: splitAt(ACK, [5, 8]) });
  await flasher.openPort("COM9", 921600);
  const res = await flasher.stageHandshake();
  assert.equal(res.attempts, 1);
  assert.ok(res.rxBytes >= ACK.length, `应统计到已收字节，实际 ${res.rxBytes}`);
  assert.ok(res.elapsedMs >= 0);
  const progress = events.filter((e) => e.type === "handshake_progress");
  assert.ok(progress.length >= 1, "必须发出 handshake_progress 事件供 UI 显示阶段/等待时间");
  assert.ok("attempts" in progress[0] && "rxBytes" in progress[0] && "resetTimeoutMs" in progress[0]);
});

/* ------------------------------------------------------------------ 失败路径 */

test("W29-02: 完全没收到字节 → HANDSHAKE_TIMEOUT，文案指向手动按 RST 而不是自动拨 RTS", async () => {
  const { flasher } = makeRealFlasher({ onAckWrite: () => {} });
  await flasher.openPort("COM9", 921600);
  await assert.rejects(
    () => flasher.stageHandshake(),
    (err) => {
      assert.equal(err.code, "HANDSHAKE_TIMEOUT");
      assert.match(err.message, /没有收到任何字节/);
      assert.match(err.message, /手动按一次复位键/);
      assert.match(err.message, /不会自动拨动 RTS\/DTR/);
      assert.equal(err.detail.rxBytes, 0);
      return true;
    },
  );
});

test("W29-02: 只收到坏帧 → 文案指出坏帧数与“按 RST 时机/波特率”原因", async () => {
  const bad = Buffer.from(buildDeviceFrame(0xe1, [0, 0, 0, 0], { corruptCrc: true }));
  const { flasher } = makeRealFlasher({ ackChunks: [bad] });
  await flasher.openPort("COM9", 921600);
  await assert.rejects(
    () => flasher.stageHandshake(),
    (err) => {
      assert.equal(err.code, "HANDSHAKE_TIMEOUT");
      assert.match(err.message, /坏帧/);
      assert.ok(err.detail.badFrames >= 1);
      return true;
    },
  );
});

test("W29-02: 收到非 0xE1 的应答 → 最后原因为 UNEXPECTED_FRAME，提示设备可能处于其它模式", async () => {
  const other = Buffer.from(buildDeviceFrame(0x55, [0, 0]));
  const { flasher } = makeRealFlasher({ ackChunks: [other] });
  await flasher.openPort("COM9", 921600);
  await assert.rejects(
    () => flasher.stageHandshake(),
    (err) => {
      assert.equal(err.code, "HANDSHAKE_TIMEOUT");
      assert.equal(err.detail.lastCode, "UNEXPECTED_FRAME");
      assert.match(err.message, /非 0xE1/);
      return true;
    },
  );
});

test("W29-03: 握手期间收到 USB error（拔线典型序列 error→close）→ HANDSHAKE_IO_ERROR，立刻结束", async () => {
  const { flasher, getPort } = makeRealFlasher({ onAckWrite: () => {} });
  await flasher.openPort("COM9", 921600);
  const started = Date.now();
  const pending = flasher.stageHandshake();
  await sleep(10);
  getPort().unplug();
  await assert.rejects(
    () => pending,
    (err) => {
      assert.equal(err.code, "HANDSHAKE_IO_ERROR");
      assert.match(err.message, /串口在握手期间中断/);
      assert.match(err.message, /未自动复位硬件/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 2000, "断线必须立刻结束握手");
});

test("W29-03: 握手期间端口仅 close（无 error）→ HANDSHAKE_PORT_CLOSED", async () => {
  const { flasher, getPort } = makeRealFlasher({ onAckWrite: () => {} });
  await flasher.openPort("COM9", 921600);
  const started = Date.now();
  const pending = flasher.stageHandshake();
  await sleep(10);
  getPort().emit("close");
  await assert.rejects(
    () => pending,
    (err) => {
      assert.equal(err.code, "HANDSHAKE_PORT_CLOSED");
      return true;
    },
  );
  assert.ok(Date.now() - started < 2000, "关闭必须立刻结束握手，而不是等满 resetTimeout");
});

test("W29-03: 握手期间串口 IO 错误 → HANDSHAKE_IO_ERROR", async () => {
  const { flasher, getPort } = makeRealFlasher({ onAckWrite: () => {} });
  await flasher.openPort("COM9", 921600);
  const pending = flasher.stageHandshake();
  await sleep(10);
  getPort().emit("error", new Error("read EIO"));
  await assert.rejects(
    () => pending,
    (err) => {
      assert.equal(err.code, "HANDSHAKE_IO_ERROR");
      return true;
    },
  );
});

test("W29-02: 取消握手 → STOPPED（可响应取消，且不报告成功）", async () => {
  const controller = new AbortController();
  const { flasher } = makeRealFlasher({
    stopSignal: controller.signal,
    timing: { ...FAST, resetTimeout: 5000 },
    onAckWrite: () => {},
  });
  await flasher.openPort("COM9", 921600);
  setTimeout(() => controller.abort(), 30);
  const started = Date.now();
  await assert.rejects(
    () => flasher.stageHandshake(),
    (err) => {
      assert.equal(err.code, "STOPPED");
      return true;
    },
  );
  assert.ok(Date.now() - started < 1500);
});

test("W29-08: 握手期间接收缓冲溢出 → RX_OVERFLOW（明确失败，不假装可靠）", async () => {
  const { flasher, getPort } = makeRealFlasher({ onAckWrite: () => {} });
  await flasher.openPort("COM9", 921600);
  const pending = flasher.stageHandshake();
  await sleep(10);
  getPort().emitData(Buffer.alloc(1024 * 1024, 0x00)); // 单块超上限
  await assert.rejects(
    () => pending,
    (err) => {
      assert.equal(err.code, "RX_OVERFLOW");
      return true;
    },
  );
});

/* ------------------------------------------------------- 打开失败的分类（W29-03） */

test("W29-03: 串口打开失败 → PORT_OPEN_FAILED，且文案区分“被占用”与“端口不存在”", async () => {
  const busy = makeRealFlasher({ portOpts: { openError: new Error("Access denied") } });
  await assert.rejects(
    () => busy.flasher.openPort("COM9", 921600),
    (err) => {
      assert.equal(err.code, "PORT_OPEN_FAILED");
      assert.match(err.message, /被占用或权限不足/);
      return true;
    },
  );
  assert.equal(busy.flasher.session, null, "打开失败必须解绑会话，不能留下半开状态");

  const missing = makeRealFlasher({ portOpts: { openError: new Error("File not found") } });
  await assert.rejects(
    () => missing.flasher.openPort("COM10", 921600),
    (err) => {
      assert.equal(err.code, "PORT_OPEN_FAILED");
      assert.match(err.message, /端口不存在或已拔出/);
      return true;
    },
  );
});

test("W29-03: 打开串口卡住 → 有 deadline，不会无限期挂住", async () => {
  const { flasher } = makeRealFlasher({ portOpts: { hangOpen: true } });
  const started = Date.now();
  await assert.rejects(
    () => flasher.openPort("COM9", 921600),
    (err) => {
      assert.equal(err.code, "PORT_OPEN_FAILED");
      assert.match(err.message, /打开串口超时/);
      return true;
    },
  );
  assert.ok(Date.now() - started >= 7000, "必须是有限 deadline（8s）而不是立刻失败");
});

/* --------------------------------------------------------- 文案与策略（证据边界） */

test("W29-02: 握手超时文案按原因区分，且不宣称自动化复位动作", () => {
  const noBytes = buildHandshakeTimeoutMessage({
    resetTimeoutMs: 60000,
    attempts: 240,
    rxBytes: 0,
    lastCode: "TIMEOUT",
    badFrames: 0,
  });
  assert.match(noBytes, /60s/);
  assert.match(noBytes, /尝试 240 次/);
  assert.match(noBytes, /没有收到任何字节/);
  assert.match(noBytes, /不会自动拨动 RTS\/DTR/);

  const badFrame = buildHandshakeTimeoutMessage({
    resetTimeoutMs: 60000,
    attempts: 3,
    rxBytes: 48,
    lastCode: "BAD_FRAME",
    badFrames: 4,
  });
  assert.match(badFrame, /坏帧/);
  assert.equal(/请检查 RTS 是否连接 RESET/.test(badFrame), false, "不得把 RTS 接线当作唯一原因");
});

test("W29-04: 默认应答策略保留原语义并显式标注语义未验证（不把未验证假设当规则）", async () => {
  const { Ws63Flasher: F, ACK_POLICY, DEFAULT_ACK_POLICY } = await import(
    "../electron/burn/ws63flash.js"
  );
  assert.equal(DEFAULT_ACK_POLICY, ACK_POLICY.STRUCTURAL);

  const flasher = new F({ emit: () => {}, timing: FAST });
  assert.equal(flasher.ackPolicy, ACK_POLICY.STRUCTURAL);
  const acceptor = flasher.ackAcceptor(0xd2, FLASH_STAGES.ERASE);
  assert.equal(acceptor, null, "structural 策略不额外限制命令字");
  assert.ok(flasher.ackNotes.some((n) => n.code === "ACK_CMD_UNVERIFIED"));
  assert.match(flasher.ackNotes[0].note, /语义/);
});

test("W29-04: echo 策略是可选项，且只接受命令字相同的应答（未验证假设，默认关闭）", async () => {
  const { Ws63Flasher: F, ACK_POLICY } = await import("../electron/burn/ws63flash.js");
  const flasher = new F({ emit: () => {}, timing: FAST, ackPolicy: ACK_POLICY.ECHO });
  const acceptor = flasher.ackAcceptor(0xd2, FLASH_STAGES.ERASE);
  assert.equal(typeof acceptor, "function");
  assert.equal(acceptor({ cmd: 0xd2 }), true);
  assert.equal(acceptor({ cmd: 0xe1 }), false);
  // 没有可对照的命令字时（例如 loaderboot 自主应答）不得排除任何命令字
  const autonomous = flasher.ackAcceptor(undefined, FLASH_STAGES.LOADER_CONFIRM);
  assert.equal(autonomous, null);
});

/* --------------------------------------------- 残留字节归属（W29-04，真实链路） */

test("W29-04: 握手 ACK 与后续 'C' 同批到达时，'C' 必须保留给 YMODEM 阶段", async () => {
  const withC = Buffer.concat([ACK, Buffer.from([0x43])]);
  const { flasher } = makeRealFlasher({ ackChunks: [withC] });
  await flasher.openPort("COM9", 921600);
  await flasher.stageHandshake();
  const leftover = flasher.session.readAllPending();
  const parserLeft = flasher.parser?.pendingBytes ?? 0;
  const total = leftover.length + parserLeft;
  assert.equal(total, 1, `ACK 之后同一批到达的 'C' 必须保留，实际剩余 ${total} 字节`);
  const byte = leftover.length ? leftover[0] : flasher.parser.takePending()[0];
  assert.equal(byte, 0x43);
});

test("W29-04: freshParser 会把上一解析器的残余字节带过去（不再随局部变量丢失）", async () => {
  const { flasher } = makeRealFlasher({ onAckWrite: () => {} });
  await flasher.openPort("COM9", 921600);
  const parser1 = flasher.freshParser();
  parser1.push(Buffer.concat([ACK, Buffer.from([0xaa, 0xbb])]));
  const frame = parser1.next();
  assert.ok(frame, "第一帧应解析成功");
  assert.equal(parser1.pendingBytes, 2);

  const parser2 = flasher.freshParser();
  assert.equal(parser2.pendingBytes, 2, "残余 2 字节必须被带到新解析器");
  const carried = parser2.takePending();
  assert.equal(carried.toString("hex"), "aabb");
});
