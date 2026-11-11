import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_RX_QUEUE,
  SERIAL_ERROR_CODE,
  SerialError,
  SerialSession,
} from "../electron/burn/serial-session.js";
import { FakeSerialPort, sleep } from "./fake-serial-port.mjs";

function makeSession(opts) {
  const port = new FakeSerialPort({ autoOpen: true, ...opts });
  const session = new SerialSession(port);
  session.markOpen();
  return { port, session };
}

/* ------------------------------------------------------------- 终态与失败码（W29-03） */

test("W29-03: 读超时是 READ_TIMEOUT（可区分的失败码，不是笼统 Error）", async () => {
  const { session } = makeSession();
  await assert.rejects(
    () => session.read(4, 20),
    (err) => {
      assert.ok(err instanceof SerialError);
      assert.equal(err.code, SERIAL_ERROR_CODE.READ_TIMEOUT);
      return true;
    },
  );
  assert.equal(session.stats.timeouts, 1);
});

test("W29-03: 端口 close 后挂着的读立即以 PORT_CLOSED 结束（旧实现要等满超时）", async () => {
  const { port, session } = makeSession();
  const started = Date.now();
  const pending = session.read(8, 5000);
  await sleep(5);
  port.emit("close");
  await assert.rejects(
    () => pending,
    (err) => {
      assert.equal(err.code, SERIAL_ERROR_CODE.PORT_CLOSED);
      return true;
    },
  );
  assert.ok(Date.now() - started < 1000, "关闭必须立刻结束等待，不能等满 5s");
  assert.equal(session.closed, true);
});

test("W29-03: 端口错误后是 IO_ERROR，且后续 read/write 立即失败（不再空转）", async () => {
  const { port, session } = makeSession();
  port.emit("error", new Error("boom"));
  await assert.rejects(
    () => session.read(1, 5000),
    (err) => {
      assert.equal(err.code, SERIAL_ERROR_CODE.IO_ERROR);
      return true;
    },
  );
  await assert.rejects(
    () => session.write(Buffer.from([1])),
    (err) => {
      assert.equal(err.code, SERIAL_ERROR_CODE.IO_ERROR);
      return true;
    },
  );
  // 状态不会被后来的 close 覆盖成 closed 而丢原因
  port.emit("close");
  await assert.rejects(
    () => session.read(1, 5000),
    (err) => {
      assert.equal(err.code, SERIAL_ERROR_CODE.IO_ERROR);
      return true;
    },
  );
});

test("W29-03: detach 会清掉等待者与 timer（不留下悬挂 Promise）", async () => {
  const { port, session } = makeSession();
  const pending = session.read(4, 5000);
  await sleep(5);
  assert.equal(session.waiters.length, 1);
  session.detach();
  await assert.rejects(
    () => pending,
    (err) => {
      assert.equal(err.code, SERIAL_ERROR_CODE.ABORTED);
      return true;
    },
  );
  assert.equal(session.waiters.length, 0);
  // detach 之后不该再收到 data 事件
  const before = session.stats.bytesIn;
  port.emitData(Buffer.from([1, 2, 3]));
  assert.equal(session.stats.bytesIn, before);
});

test("W29-03: abort() 让等待者立刻以 ABORTED 结束", async () => {
  const { session } = makeSession();
  const pending = session.read(4, 5000);
  await sleep(5);
  session.abort("用户取消");
  await assert.rejects(
    () => pending,
    (err) => {
      assert.equal(err.code, SERIAL_ERROR_CODE.ABORTED);
      return true;
    },
  );
});

test("W29-03: 已缓冲的数据在关闭后仍可读出（不丢已经收到的字节）", async () => {
  const { port, session } = makeSession();
  port.emitData(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]));
  port.emit("close");
  const data = await session.read(4, 100);
  assert.equal(data.toString("hex"), "aabbccdd");
});

/* ----------------------------------------------------------------- 分包（W29-02 基础） */

test("W29-02: 任意切分边界到达的字节都能被 read() 正确拼接", async () => {
  const payload = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  for (let cut = 1; cut < payload.length; cut += 1) {
    const { port, session } = makeSession();
    const pending = session.read(payload.length, 200);
    await sleep(1);
    port.emitData(payload.subarray(0, cut));
    port.emitData(payload.subarray(cut));
    const got = await pending;
    assert.equal(got.toString("hex"), payload.toString("hex"), `切分点 ${cut} 读到的字节必须完整`);
  }
});

test("W29-02: 逐字节到达（最坏分包）也能读满", async () => {
  const payload = Buffer.from([9, 8, 7, 6, 5, 4]);
  const { port, session } = makeSession();
  const pending = session.read(payload.length, 300);
  for (const byte of payload) {
    await sleep(1);
    port.emitData(Buffer.from([byte]));
  }
  const got = await pending;
  assert.equal(got.toString("hex"), payload.toString("hex"));
});

/* ------------------------------------------------------------ 缓冲上限（W29-08 已复现） */

test("W29-08: 单个 1 MiB chunk 不能突破队列上限（旧实现队列会到 1048576）", () => {
  const { port, session } = makeSession();
  port.emitData(Buffer.alloc(1024 * 1024, 0x11));
  assert.ok(
    session.queue.length <= MAX_RX_QUEUE,
    `队列必须 <= ${MAX_RX_QUEUE}，实际 ${session.queue.length}`,
  );
  assert.equal(session.queue.length, MAX_RX_QUEUE);
  assert.ok(session.overflow.events >= 1, "溢出必须被计数，不能静默丢字节");
  assert.equal(session.overflow.bytes, 1024 * 1024 - MAX_RX_QUEUE);
});

test("W29-08: 连续溢出不产生负数统计，且保留最新字节", () => {
  const { port, session } = makeSession();
  port.emitData(Buffer.alloc(MAX_RX_QUEUE, 0x01));
  port.emitData(Buffer.alloc(MAX_RX_QUEUE, 0x02));
  port.emitData(Buffer.alloc(10 * MAX_RX_QUEUE, 0x03));
  assert.ok(session.queue.length <= MAX_RX_QUEUE);
  assert.ok(session.stats.bytesIn > 0);
  assert.ok(session.stats.overflowBytes > 0);
  assert.ok(Number.isFinite(session.stats.overflowBytes) && session.stats.overflowBytes >= 0);
  // 保留的是最新数据（0x03 一片）
  assert.equal(session.queue[session.queue.length - 1], 0x03);
});

/* ------------------------------------------------------------------ 波特率边界（W29-04） */

test("W29-04: markBoundary/discardBefore 只丢切换前的字节，保留切换后到达的 'C'", () => {
  const { port, session } = makeSession();
  port.emitData(Buffer.from([0x00, 0xff])); // 切换前缓冲的旧波特率垃圾
  const marker = session.markBoundary();
  assert.equal(marker, 2);
  // 切换后立刻到达的 YMODEM 'C'
  port.emitData(Buffer.from([0x43]));
  const dropped = session.discardBefore(marker);
  assert.equal(dropped, 2);
  assert.equal(session.pendingBytes, 1);
  assert.equal(session.queue[0], 0x43, "换波特率后到达的 'C' 不能被清掉");
});

test("W29-04: readAllPending 取走全部字节且不动统计", () => {
  const { port, session } = makeSession();
  port.emitData(Buffer.from([1, 2, 3]));
  const all = session.readAllPending();
  assert.equal(all.toString("hex"), "010203");
  assert.equal(session.pendingBytes, 0);
});

/* -------------------------------------------------------------------- 写路径（W29-03） */

test("W29-03: 写入错误映射为 IO_ERROR 且带原因", async () => {
  const { session } = makeSession({ writeError: new Error("write EPIPE") });
  await assert.rejects(
    () => session.write(Buffer.from([1, 2])),
    (err) => {
      assert.equal(err.code, SERIAL_ERROR_CODE.IO_ERROR);
      assert.match(err.message, /EPIPE/);
      return true;
    },
  );
});
