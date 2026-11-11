/**
 * W29-08：帧解析边界与资源上限。
 *
 * 已复现：向 FrameParser 推入一个 1 MiB chunk，缓冲达到 1048576（声明上限 8192），
 * 且溢出被静默吞掉，上层仍宣称“可靠”。
 * 另：物理最小帧 = magic(4)+len(2)+cmd(1)+~cmd(1)+crc(2) = 10，旧实现写 8。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FrameParser,
  MAX_BUFFER,
  MAX_FRAME,
  MIN_FRAME,
  readFrame,
} from "../electron/burn/frame-parser.js";
import { buildDeviceFrame } from "./fixtures.mjs";

test("W29-08: 最小帧长常量就是 10（magic+len+cmd+~cmd+crc），不再是 8", () => {
  assert.equal(MIN_FRAME, 10);
});

test("W29-08: len=8 / len=9 的“帧”必须被拒绝（CRC 字段与 cmd/~cmd 重叠属于协议伪影）", () => {
  for (const len of [8, 9]) {
    const parser = new FrameParser();
    const buf = Buffer.alloc(len);
    buf[0] = 0xef;
    buf[1] = 0xbe;
    buf[2] = 0xad;
    buf[3] = 0xde;
    buf.writeUInt16LE(len, 4);
    // 让“CRC”正好等于 cmd/~cmd，模拟重叠字段恰好自洽的极端情况
    buf[len - 2] = 0xb3;
    buf[len - 1] = 0x4c;
    buf[6] = 0xb3;
    if (len > 7) buf[7] = 0x4c;
    parser.push(buf);
    assert.equal(parser.next(), null, `len=${len} 不得被当成有效帧`);
    assert.ok(parser.badFrames >= 1);
  }
});

test("W29-08【已复现】: 单个 1 MiB chunk 不能突破 MAX_BUFFER，且溢出必须计数", () => {
  const parser = new FrameParser();
  parser.push(Buffer.alloc(1024 * 1024, 0x55));
  assert.ok(
    parser.buf.length <= MAX_BUFFER,
    `缓冲必须 <= ${MAX_BUFFER}，实际 ${parser.buf.length}`,
  );
  assert.equal(parser.overflowBytes, 1024 * 1024 - MAX_BUFFER);
});

test("W29-08: 反复溢出后统计只增不减、不为负", () => {
  const parser = new FrameParser();
  let last = 0;
  for (let i = 0; i < 50; i += 1) {
    parser.push(Buffer.alloc(100_000, i & 0xff));
    assert.ok(parser.overflowBytes >= last, "溢出计数不能倒退");
    last = parser.overflowBytes;
    parser.next();
  }
  assert.ok(parser.badFrames >= 0);
  assert.ok(parser.skippedBytes >= 0);
  assert.ok(parser.pendingBytes <= MAX_BUFFER);
});

test("W29-08: 半帧（截断的帧）被保留，补齐后可解析", () => {
  const frame = buildDeviceFrame(0xe1, [1, 2, 3, 4]);
  const parser = new FrameParser();
  parser.push(frame.subarray(0, frame.length - 3));
  assert.equal(parser.next(), null);
  assert.equal(parser.pendingBytes, frame.length - 3, "半帧必须完整保留");
  parser.push(frame.subarray(frame.length - 3));
  const got = parser.next();
  assert.ok(got);
  assert.equal(got.cmd, 0xe1);
});

test("W29-08: 完全没有魔数的长字节流不会无限增长，也不会误报帧", () => {
  const parser = new FrameParser();
  for (let i = 0; i < 200; i += 1) parser.push(Buffer.alloc(1000, 0x5a));
  assert.ok(parser.pendingBytes <= MAX_BUFFER);
  assert.equal(parser.next(), null);
  assert.ok(parser.skippedBytes > 0);
});

test("W29-08: 超长 len 字段（> MAX_FRAME）不会导致无限等待", () => {
  const parser = new FrameParser();
  const bad = buildDeviceFrame(0xe1, [0, 0, 0, 0]);
  bad.writeUInt16LE(MAX_FRAME + 1, 4);
  parser.push(bad);
  assert.equal(parser.next(), null);
  assert.ok(parser.badFrames >= 1);
  // 之后仍能重同步出好帧
  parser.push(buildDeviceFrame(0xe1, [0, 0, 0, 0]));
  const good = parser.next();
  assert.ok(good, "坏长度之后必须能重新同步");
  assert.equal(good.cmd, 0xe1);
});

test("W29-04: takePending 交还残余字节并清空缓冲（不复制同一块内存）", () => {
  const parser = new FrameParser();
  const frame = buildDeviceFrame(0xe1, [0, 0, 0, 0]);
  parser.push(Buffer.concat([frame, Buffer.from([0x43, 0x44])]));
  assert.ok(parser.next());
  assert.equal(parser.pendingBytes, 2);
  const rest = parser.takePending();
  assert.equal(rest.toString("hex"), "4344");
  assert.equal(parser.pendingBytes, 0);
});

test("W29-08: readFrame 遇到解析器溢出返回 RX_OVERFLOW（不假装拿到了帧）", async () => {
  const parser = new FrameParser();
  parser.push(Buffer.alloc(MAX_BUFFER * 2, 0x00));
  const session = { async readByte() { throw new Error("串口读取超时"); }, overflow: { events: 0, bytes: 0 } };
  const res = await readFrame(session, parser, { timeoutMs: 50 });
  assert.equal(res.ok, false);
  assert.equal(res.code, "RX_OVERFLOW");
});

test("W29-08: readFrame 把会话关闭/IO 故障区分开（不再一律当超时）", async () => {
  const closed = {
    async readByte() {
      const e = new Error("串口已关闭");
      e.code = "PORT_CLOSED";
      throw e;
    },
    overflow: { events: 0, bytes: 0 },
  };
  const res1 = await readFrame(closed, new FrameParser(), { timeoutMs: 100 });
  assert.equal(res1.code, "PORT_CLOSED");

  const io = {
    async readByte() {
      const e = new Error("boom");
      e.code = "IO_ERROR";
      throw e;
    },
    overflow: { events: 0, bytes: 0 },
  };
  const res2 = await readFrame(io, new FrameParser(), { timeoutMs: 100 });
  assert.equal(res2.code, "IO_ERROR");
});

test("W29-08: 长时间运行后错误统计保持单调（跨 readFrame 调用不重置）", async () => {
  const parser = new FrameParser();
  const session = {
    async readByte() {
      await new Promise((r) => setImmediate(r));
      throw new Error("串口读取超时");
    },
    overflow: { events: 0, bytes: 0 },
  };
  let prevBad = 0;
  for (let round = 0; round < 5; round += 1) {
    parser.push(buildDeviceFrame(0xe1, [0, 0, 0, 0], { corruptCrc: true }));
    const res = await readFrame(session, parser, { timeoutMs: 20 });
    assert.equal(res.ok, false);
    assert.ok(parser.badFrames >= prevBad, "坏帧计数不能倒退");
    prevBad = parser.badFrames;
  }
  assert.ok(parser.badFrames >= 5);
});
