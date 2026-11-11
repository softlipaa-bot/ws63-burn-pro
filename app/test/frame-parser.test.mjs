import test from "node:test";
import assert from "node:assert/strict";

import { FrameParser, readFrame } from "../electron/burn/frame-parser.js";
import { calcCrc16 } from "../electron/burn/crc.js";
import { buildDeviceFrame } from "./fixtures.mjs";

test("W02: 完整 ACK 帧被识别（cmd/长度/CRC 都校验）", () => {
  const parser = new FrameParser();
  parser.push(buildDeviceFrame(0xe1, [0, 0, 0, 0]));
  const frame = parser.next();
  assert.ok(frame);
  assert.equal(frame.cmd, 0xe1);
  assert.equal(frame.len, 12);
  assert.equal(frame.raw[7], 0xe1 ^ 0xff);
});

test("W02: 跨分片（逐字节）到达的半帧被保留，最终仍能解析", () => {
  const parser = new FrameParser();
  const bytes = buildDeviceFrame(0xe1, [1, 2, 3, 4]);
  for (let i = 0; i < bytes.length - 1; i += 1) {
    parser.pushByte(bytes[i]);
    assert.equal(parser.next(), null, `第 ${i + 1} 字节时不应产出帧`);
  }
  parser.pushByte(bytes[bytes.length - 1]);
  const frame = parser.next();
  assert.ok(frame, "最后一片到达后应产出完整帧");
  assert.equal(parser.pendingBytes, 0);
});

test("W02: 坏 CRC 帧被丢弃并计数，坏帧之后的好帧仍可解析", () => {
  const parser = new FrameParser();
  parser.push(buildDeviceFrame(0xe1, [0, 0, 0, 0], { corruptCrc: true }));
  assert.equal(parser.next(), null);
  assert.equal(parser.badFrames, 1);

  parser.push(buildDeviceFrame(0xe1, [9, 9, 9, 9]));
  const frame = parser.next();
  assert.ok(frame);
  assert.equal(frame.cmd, 0xe1);
});

test("W02: cmd 反码不匹配的帧被拒绝", () => {
  const parser = new FrameParser();
  const bytes = buildDeviceFrame(0xe1, [0, 0, 0, 0]);
  bytes[7] = 0x00; // 破坏反码
  // 重新计算 CRC，使“只有反码错”这一条被单独验证
  bytes.writeUInt16LE(calcCrc16(bytes.subarray(0, bytes.length - 2)), bytes.length - 2);
  parser.push(bytes);
  assert.equal(parser.next(), null);
  assert.equal(parser.badFrames, 1);
});

test("W02: 长度字段非法（<8 / >2048）不导致无限等待", () => {
  const parser = new FrameParser();
  const bad = buildDeviceFrame(0xe1, [0, 0, 0, 0]);
  bad.writeUInt16LE(2, 4); // 非法长度
  parser.push(bad);
  assert.equal(parser.next(), null);
  assert.ok(parser.badFrames >= 1);
  parser.push(buildDeviceFrame(0xe1, [0, 0, 0, 0]));
  assert.ok(parser.next(), "重同步后应仍能拿到好帧");
});

test("W02: 垃圾字节流不会让解析器缓冲无限增长", () => {
  const parser = new FrameParser();
  for (let i = 0; i < 200; i += 1) parser.push(Buffer.alloc(1000, 0x55));
  assert.ok(parser.pendingBytes <= 2048 * 4 + 1000, `缓冲应有限，实际 ${parser.pendingBytes}`);
  assert.equal(parser.next(), null);
});

test("W02: readFrame 超时返回 TIMEOUT，坏帧返回 BAD_FRAME", async () => {
  const session = {
    async readByte() {
      await new Promise((r) => setImmediate(r));
      throw new Error("串口读取超时");
    },
  };
  const res = await readFrame(session, new FrameParser(), { timeoutMs: 30 });
  assert.equal(res.ok, false);
  assert.equal(res.code, "TIMEOUT");

  const badSession = (() => {
    const bytes = [...buildDeviceFrame(0xe1, [0, 0, 0, 0], { corruptCrc: true })];
    return {
      async readByte() {
        await new Promise((r) => setImmediate(r));
        if (bytes.length) return bytes.shift();
        throw new Error("串口读取超时");
      },
    };
  })();
  const res2 = await readFrame(badSession, new FrameParser(), { timeoutMs: 60 });
  assert.equal(res2.ok, false);
  assert.equal(res2.code, "BAD_FRAME");
});

test("W02: readFrame 命中期望 cmd 时返回帧，命令字不符则继续/失败", async () => {
  const bytes = [
    ...buildDeviceFrame(0x55, [0, 0]),
    ...buildDeviceFrame(0xe1, [0, 0, 0, 0]),
  ];
  const session = {
    async readByte() {
      await new Promise((r) => setImmediate(r));
      if (bytes.length) return bytes.shift();
      throw new Error("串口读取超时");
    },
  };
  const res = await readFrame(session, new FrameParser(), {
    timeoutMs: 200,
    accept: (frame) => frame.cmd === 0xe1,
  });
  assert.equal(res.ok, true);
  assert.equal(res.frame.cmd, 0xe1);
});
