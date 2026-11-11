/**
 * Codex 复审 R1~R5 的断言回归（真实生产模块路径）。
 *
 * 这些用例对应 `Codex复审-1.1.3-退回修正.md` 的 R1/R2/R3/R4/R5，
 * 以及 `codex-review-probe-results.json` 里记录的缺陷现象。
 * 全部使用真实 SerialSession / monitor.js / firmware-registry.js / stable-snapshot.js，
 * 只把串口端口替身为 EventEmitter；**没有修改 test/fixtures.mjs 的设备协议行为**。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import crypto from "node:crypto";

import { SerialSession } from "../electron/burn/serial-session.js";
import {
  MAX_FIRMWARE_TOKENS,
  issueFirmwareToken,
  lookupFirmwareToken,
  pinFirmwareToken,
  resetFirmwareTokens,
  resolveFirmware,
  tokenCount,
  unpinFirmwareToken,
} from "../electron/burn/firmware-registry.js";
import { openImmutableFwpkgSnapshot } from "../electron/burn/stable-snapshot.js";
import { inspectFwpkg } from "../electron/burn/fwpkg.js";
import {
  __setPortFactory,
  abortAllMonitors,
  connectMonitor,
  disconnectMonitor,
  getMonitorSnapshot,
  getQuarantinedPorts,
} from "../electron/serial/monitor.js";
import {
  OWNER_KIND,
  holderOf,
  ownerCount,
  resetRegistry,
} from "../electron/serial/ownership.js";
import { buildFwpkgBytes, makeValidPackage, writeTempFile } from "./fixtures.mjs";
import { sleep } from "./fake-serial-port.mjs";

/* --------------------------------------------------------------------- 工具 */

/** 可精确控制 open/close 的端口替身。 */
class ControlledPort extends EventEmitter {
  constructor({ path = "COM90", baudRate = 115200 } = {}) {
    super();
    this.path = path;
    this.baudRate = baudRate;
    this.isOpen = false;
    this.openCb = null;
    this.closeCb = null;
    this.closeCalls = 0;
    this.opens = 0;
  }

  open(cb) {
    this.opens += 1;
    this.openCb = cb; // 由测试决定何时完成
  }

  completeOpen(err = null) {
    this.isOpen = !err;
    this.openCb?.(err);
  }

  close(cb) {
    this.closeCalls += 1;
    this.closeCb = cb; // 由测试决定何时完成
  }

  completeClose({ err = null, stillOpen = false } = {}) {
    this.isOpen = stillOpen;
    this.closeCb?.(err);
    // 真实 serialport 关闭成功后会 emit("close")；隔离条目的 late-close 监听依赖它
    if (!err && !stillOpen) this.emit("close");
  }

  update(opts, cb) {
    if (opts?.baudRate) this.baudRate = opts.baudRate;
    cb?.(null);
  }

  flush(cb) {
    cb?.(null);
  }

  write(_d, cb) {
    cb?.(null);
  }
}

function freshFile(seed = 0xa1) {
  return writeTempFile(
    buildFwpkgBytes({
      parts: [
        { name: "loaderboot", type: 0, data: Buffer.alloc(1024, seed), burn_addr: 0x100000 },
      ],
    }),
  );
}

test.beforeEach(async () => {
  resetRegistry();
  resetFirmwareTokens();
  await abortAllMonitors();
  __setPortFactory(null);
});

test.afterEach(async () => {
  await abortAllMonitors();
  __setPortFactory(null);
  resetRegistry();
  resetFirmwareTokens();
});

/* ------------------------------------------------------------------- R1 令牌 */

test("R1: 连续 70 次用同一令牌解析全部成功，表不膨胀（旧实现第 65 次失效）", () => {
  const file = freshFile();
  const chosen = resolveFirmware({ filePath: file });
  let ok = 0;
  for (let i = 0; i < 70; i += 1) {
    const res = resolveFirmware({ filePath: file, token: chosen.token });
    assert.equal(res.token, chosen.token, "必须复用同一令牌，而不是每次签发新的");
    assert.equal(res.reusedToken, true);
    ok += 1;
  }
  assert.equal(ok, 70);
  assert.equal(tokenCount(), 1, `令牌表应只有 1 条，实际 ${tokenCount()}`);
  assert.ok(lookupFirmwareToken(chosen.token), "UI 手里的令牌必须仍然有效");
});

test("R1: 被运行中任务钉住的令牌不会被容量淘汰", () => {
  const file = freshFile();
  const active = resolveFirmware({ filePath: file });
  pinFirmwareToken(active.token);
  try {
    // 制造大量未被钉住的令牌（模拟反复拖拽选择）
    for (let i = 0; i < MAX_FIRMWARE_TOKENS + 10; i += 1) issueFirmwareToken({ path: file, sha256: `x${i}`, size: 1 });
    assert.ok(lookupFirmwareToken(active.token), "钉住的令牌不能被淘汰");
    assert.ok(tokenCount() <= MAX_FIRMWARE_TOKENS + 1, "其余令牌仍受容量约束");
  } finally {
    unpinFirmwareToken(active.token);
  }
});

test("R1: 取消/失败后解钉，令牌可被正常淘汰", () => {
  const file = freshFile();
  const active = resolveFirmware({ filePath: file });
  pinFirmwareToken(active.token);
  unpinFirmwareToken(active.token);
  for (let i = 0; i < MAX_FIRMWARE_TOKENS + 10; i += 1) issueFirmwareToken({ path: file, sha256: `y${i}`, size: 1 });
  assert.ok(tokenCount() <= MAX_FIRMWARE_TOKENS);
});

test("R1: 令牌仍保留路径一致性与内容变更拒绝", () => {
  const a = freshFile(0xa1);
  const b = freshFile(0xb2);
  const ta = resolveFirmware({ filePath: a }).token;
  assert.throws(() => resolveFirmware({ filePath: b, token: ta }), /令牌不一致|不一致/);
  // 内容变化
  const before = resolveFirmware({ filePath: a });
  fs.writeFileSync(a, buildFwpkgBytes({ parts: [{ name: "loaderboot", type: 0, data: Buffer.alloc(2048, 0x33), burn_addr: 0x100000 }] }));
  assert.throws(() => resolveFirmware({ filePath: a, token: before.token }), /已变化/);
});

/* ------------------------------------------------------------------- R2 写入 */

function makeWriteSession() {
  const port = new EventEmitter();
  port.isOpen = true;
  port.write = () => {}; // 驱动永不回调
  const session = new SerialSession(port);
  session.markOpen();
  return { port, session };
}

test("R2: 写入中 abort 立刻以 ABORTED 结束（旧实现永远 STILL_PENDING）", async () => {
  const { session } = makeWriteSession();
  const pending = session.write(Buffer.from([1]));
  session.abort();
  await assert.rejects(pending, (e) => e.code === "ABORTED");
});

test("R2: 写入中 close 以 PORT_CLOSED 结束", async () => {
  const { port, session } = makeWriteSession();
  const pending = session.write(Buffer.from([1]));
  port.emit("close");
  await assert.rejects(pending, (e) => e.code === "PORT_CLOSED");
});

test("R2: 写入中 error 以 IO_ERROR 结束", async () => {
  const { port, session } = makeWriteSession();
  const pending = session.write(Buffer.from([1]));
  port.emit("error", new Error("unplug"));
  await assert.rejects(pending, (e) => e.code === "IO_ERROR");
});

test("R2: 驱动回调丢失时有界超时（WRITE_TIMEOUT），不会无限挂起", async () => {
  const { session } = makeWriteSession();
  const started = Date.now();
  await assert.rejects(
    () => session.write(Buffer.from([1]), { timeoutMs: 60 }),
    (e) => e.code === "WRITE_TIMEOUT",
  );
  assert.ok(Date.now() - started < 1000);
});

test("R2: 取消后到达的晚 callback 不改变已结束状态", async () => {
  const port = new EventEmitter();
  port.isOpen = true;
  let lateCb;
  port.write = (_d, cb) => {
    lateCb = cb;
  };
  const session = new SerialSession(port);
  session.markOpen();
  const pending = session.write(Buffer.from([1]));
  session.abort();
  await assert.rejects(pending, (e) => e.code === "ABORTED");
  assert.doesNotThrow(() => lateCb?.(null));
  assert.equal(session.pendingWrites.size, 0, "晚 callback 后不应残留待写项");
});

test("R2: 任务 AbortSignal 能直接结束写入（真实 YMODEM/握手路径所用形态）", async () => {
  const { session } = makeWriteSession();
  const controller = new AbortController();
  const pending = session.write(Buffer.from([1]), { stopSignal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e) => e.code === "ABORTED");
});

test("R2: 写入 callback 缺失时 flash() 会失败退出，而不是挂死", async () => {
  const { Ws63Flasher } = await import("../electron/burn/ws63flash.js");
  const { FakeSerialPort } = await import("./fake-serial-port.mjs");
  const flasher = new Ws63Flasher({
    emit: () => {},
    timing: { resetTimeout: 200, handshakeRetryMs: 30, writeTimeout: 80, handshakeFrameMinGapMs: 1 },
    createPort: async () => {
      const p = new FakeSerialPort({ path: "COM9" });
      // 让写永远不回调：模拟驱动丢 callback
      p.write = () => {};
      return p;
    },
  });
  await flasher.openPort("COM9", 921600);
  const started = Date.now();
  await assert.rejects(
    () => flasher.flash(makeValidPackage()),
    (err) => {
      assert.ok(
        err.code === "WRITE_TIMEOUT" || err.code === "STOPPED" || err.code === "HANDSHAKE_TIMEOUT",
        `写入丢回调必须结构化失败，实际 ${err.code}`,
      );
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000, "不能挂死");
});

/* --------------------------------------------------------------- R3 打开可取消 */

test("R3: 打开过程中 disconnect 必须取消它，晚成功不得 attach（旧实现会连上）", async () => {
  const port = new ControlledPort({ path: "COM91" });
  __setPortFactory(() => port);

  const opening = connectMonitor("1", "COM91", 115200, () => {}, () => {});
  await sleep(10);
  assert.equal(port.opens, 1, "应当已开始打开");

  const disconnecting = disconnectMonitor("1");
  port.completeOpen(null); // 晚到成功
  await assert.rejects(opening, /取消/);
  await disconnecting;

  assert.equal(getMonitorSnapshot().serialChannels["1"].connected, false, "断开后不得处于已连接");
  assert.ok(port.closeCalls >= 1, "晚成功的句柄必须被关掉，不能泄漏");
  // 新契约：关闭未确认前必须继续占用（closing），不能假装空闲
  const holder = holderOf("COM91");
  assert.ok(holder, "未确认关闭前必须保留占用");
  assert.equal(holder.kind, OWNER_KIND.CLOSING);
  // 驱动确认关闭后 → 释放
  port.completeClose({ err: null, stillOpen: false });
  await sleep(50);
  assert.equal(holderOf("COM91"), null, "确认关闭后必须释放所有权");
});

test("R3: 打开永久不回调时有 deadline，不会让通道永久卡在正在连接", async () => {
  const { MONITOR_OPEN_TIMEOUT_MS } = await import("../electron/serial/monitor.js");
  const port = new ControlledPort({ path: "COM94" });
  __setPortFactory(() => port);
  const started = Date.now();
  await assert.rejects(
    () => connectMonitor("1", "COM94", 115200, () => {}, () => {}),
    /超时/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= MONITOR_OPEN_TIMEOUT_MS - 500, `应等待 deadline，实际 ${elapsed}ms`);
  assert.equal(ownerCount(), 0, "超时后必须释放所有权");
});

test("R3: 打开期间收到 error → 连接失败，关闭未确认时保留占用", async () => {
  const port = new ControlledPort({ path: "COM95" });
  __setPortFactory(() => port);
  const opening = connectMonitor("1", "COM95", 115200, () => {}, () => {});
  await sleep(10);
  port.emit("error", new Error("early error"));
  port.completeOpen(null);
  await assert.rejects(opening);
  assert.equal(getMonitorSnapshot().serialChannels["1"].connected, false);
  // 新契约：close 未确认 → 保留 closing（不能 release 后留下打开句柄）
  const holder = holderOf("COM95");
  assert.ok(holder, "关闭未确认时必须保留占用");
  assert.equal(holder.kind, OWNER_KIND.CLOSING);
  port.completeClose({ err: null, stillOpen: false });
  await sleep(50);
  assert.equal(holderOf("COM95"), null, "确认关闭后释放");
});

test("R3: 打开失败后晚成功不会把句柄留在外面", async () => {
  const port = new ControlledPort({ path: "COM96" });
  __setPortFactory(() => port);
  const opening = connectMonitor("1", "COM96", 115200, () => {}, () => {});
  await sleep(10);
  port.completeOpen(new Error("open failed"));
  await assert.rejects(opening, /open failed/);
  assert.equal(ownerCount(), 0);
});

/* --------------------------------------------------------- R4 关闭顺序与占用 */

test("R4: 关闭期间端口仍被占用（closing），第二个通道不能插队打开同一 COM", async () => {
  const first = new ControlledPort({ path: "COM92" });
  __setPortFactory(() => first);
  const opening = connectMonitor("1", "COM92", 115200, () => {}, () => {});
  await sleep(5);
  first.completeOpen(null);
  await opening;
  assert.equal(holderOf("COM92").kind, OWNER_KIND.MONITORING);

  // 触发 error → 进入关闭流程（close 不回调）
  first.emit("error", new Error("transient"));
  await sleep(20);
  const holder = holderOf("COM92");
  assert.ok(holder, "关闭未确认前必须仍然占住端口");
  assert.equal(holder.kind, OWNER_KIND.CLOSING, `关闭期间应为 closing，实际 ${holder.kind}`);
  assert.equal(first.isOpen, true, "句柄尚未关闭");

  // 另一个通道抢同一 COM：必须被拒绝
  const second = new ControlledPort({ path: "COM92" });
  __setPortFactory(() => second);
  await assert.rejects(() => connectMonitor("2", "COM92", 115200, () => {}, () => {}), /占用/);
});

test("R4: close 回调带 Error 且 isOpen 仍为 true → 保留占用并隔离，绝不 release", async () => {
  const port = new ControlledPort({ path: "COM97" });
  __setPortFactory(() => port);
  const opening = connectMonitor("1", "COM97", 115200, () => {}, () => {});
  await sleep(5);
  port.completeOpen(null);
  await opening;

  port.emit("error", new Error("io error"));
  await sleep(20);
  // 关闭报错且句柄仍开
  port.completeClose({ err: new Error("close failed"), stillOpen: true });
  await sleep(30);

  const holder = holderOf("COM97");
  assert.ok(holder, "关闭失败后必须继续占用（不能假装空闲）");
  assert.equal(holder.kind, OWNER_KIND.CLOSING);
  const q = getQuarantinedPorts();
  assert.ok(q.some((x) => x.path === "COM97"), `应被隔离记录，实际 ${JSON.stringify(q)}`);
});

test("R4: 确认关闭后才释放所有权", async () => {
  const port = new ControlledPort({ path: "COM98" });
  __setPortFactory(() => port);
  const opening = connectMonitor("1", "COM98", 115200, () => {}, () => {});
  await sleep(5);
  port.completeOpen(null);
  await opening;

  port.emit("error", new Error("io error"));
  await sleep(20);
  assert.equal(holderOf("COM98")?.kind, OWNER_KIND.CLOSING);
  port.completeClose({ err: null, stillOpen: false });
  await sleep(30);
  assert.equal(holderOf("COM98"), null, "确认关闭后必须释放");
});

/* ------------------------------------------------- R5 内容身份与不可变快照 */

test("R5: 同大小同 mtime 替换后，resolveFirmware 不再返回旧摘要", () => {
  const file = freshFile();
  const stamp = new Date("2026-01-01T00:00:00.000Z");
  fs.utimesSync(file, stamp, stamp);
  const before = resolveFirmware({ filePath: file });

  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, stamp, stamp);

  // 预览缓存可能命中旧键（ctime 已改，通常不会），因此两种结果都接受，
  // 关键是**烧录路径**必须拒绝（见下一条用例）
  let stale = false;
  try {
    const after = resolveFirmware({ filePath: file });
    stale = after.snapshot.sha256 === before.snapshot.sha256;
  } catch {
    stale = false;
  }
  assert.equal(stale, false, "resolveFirmware 不能把旧摘要当成新内容");
});

test("R5【核心】: 预览后替换固件 → 不可变快照以 FWPKG_CHANGED 拒绝，不烧入不同字节", async () => {
  const file = freshFile();
  const stamp = new Date("2026-01-01T00:00:00.000Z");
  fs.utimesSync(file, stamp, stamp);
  const preview = inspectFwpkg(file);

  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, stamp, stamp);

  await assert.rejects(
    () => openImmutableFwpkgSnapshot(file, { expectedSha256: preview.sha256 }),
    (err) => {
      assert.equal(err.code, "FWPKG_CHANGED");
      return true;
    },
  );
});

test("R5: 快照摘要来自实际复制的字节；开好后源文件再改也不影响快照", async () => {
  const file = freshFile();
  const snap = await openImmutableFwpkgSnapshot(file);
  const originalBytes = fs.readFileSync(file);
  const expected = crypto.createHash("sha256").update(originalBytes).digest("hex");
  assert.equal(snap.sha256, expected, "摘要必须等于真实文件内容");

  const bytes = fs.readFileSync(file);
  bytes[20] ^= 0xff;
  fs.writeFileSync(file, bytes);

  const snapshotBytes = fs.readFileSync(snap.path);
  assert.equal(
    crypto.createHash("sha256").update(snapshotBytes).digest("hex"),
    snap.sha256,
    "快照内容必须保持不变（不可变）",
  );
  // 读取接口也返回原始字节
  assert.equal(snap.read(0, 4).toString("hex"), originalBytes.subarray(0, 4).toString("hex"));
  await snap.close();
  assert.equal(fs.existsSync(snap.path), false, "close 后临时副本必须删除");
});
