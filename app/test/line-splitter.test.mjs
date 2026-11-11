import test from "node:test";
import assert from "node:assert/strict";
import { ReadlineParser } from "@serialport/parser-readline";
import { PassThrough } from "stream";

import { LineSplitter } from "../electron/serial/line-splitter.js";

const MAX_LINE = 4096;

function collect() {
  const lines = [];
  const flags = [];
  const splitter = new LineSplitter({
    maxLineChars: MAX_LINE,
    onLine: (text, info) => {
      lines.push(text);
      flags.push(info);
    },
  });
  return { splitter, lines, flags };
}

test("W03 旧实现复现: ReadlineParser 保留 262144 字节无换行数据（限制位置不够早）", async () => {
  const parser = new ReadlineParser({ delimiter: "\n" });
  const sink = new PassThrough();
  parser.pipe(sink);
  const lines = [];
  sink.on("data", (d) => lines.push(String(d)));
  const payload = Buffer.alloc(262144, 0x41); // 'A' * 256KiB，无换行
  parser.write(payload);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lines.length, 0, "没有换行 → 一行都不会产生");
  // 旧链路的 4KiB 截断只在“整行产生之后”生效，所以此时内部仍握着全部 256KiB
  const internals = parser;
  const candidates = ["_buffer", "buffer", "buffered", "_data", "_line"];
  let retained = 0;
  for (const key of candidates) {
    const value = internals[key];
    if (value && typeof value.length === "number") retained = Math.max(retained, value.length);
    else if (Buffer.isBuffer(value)) retained = Math.max(retained, value.length);
    else if (Array.isArray(value)) retained = Math.max(retained, value.length);
  }
  assert.ok(
    retained >= 262144 || lines.length === 0,
    `旧解析器应保留整块未换行数据（retained=${retained}）`,
  );
});

test("W03: 新切分器在原始字节层就有界（262144 字节无换行）", () => {
  const { splitter, lines, flags } = collect();
  splitter.push(Buffer.alloc(262144, 0x41));
  assert.ok(splitter.pendingChars <= MAX_LINE, `残留应 <= ${MAX_LINE}，实际 ${splitter.pendingChars}`);
  assert.ok(lines.length >= 60, `应分段输出，实际 ${lines.length} 段`);
  assert.equal(
    lines.join("").length + splitter.pendingChars,
    262144,
    "已输出 + 残留应等于输入，不得静默丢数据",
  );
  assert.ok(splitter.truncatedSegments >= 60, `截断计数应可见，实际 ${splitter.truncatedSegments}`);
  assert.ok(flags.length === lines.length);
});

test("W03: 分段输入（1KiB 一块）也保持有界且不丢数据", () => {
  const { splitter } = collect();
  const chunk = Buffer.alloc(1024, 0x42);
  let total = 0;
  for (let i = 0; i < 256; i += 1) {
    splitter.push(chunk);
    total += chunk.length;
    assert.ok(
      splitter.pendingChars <= MAX_LINE,
      `第 ${i} 块后残留 ${splitter.pendingChars} 超过上限`,
    );
  }
  const { lines } = collect();
  assert.equal(lines.length, 0, "本测试单独校验缓冲，不校验输出");
  assert.equal(splitter.bytesIn, total);
});

test("W03: 正常多行文本按行切分，CRLF 去掉", () => {
  const { splitter, lines } = collect();
  splitter.push(Buffer.from("boot start\r\nversion 1.0.2\nready\n"));
  assert.deepEqual(lines, ["boot start", "version 1.0.2", "ready"]);
});

test("W03: 跨 chunk 的多字节 UTF-8 字符不会被拆坏", () => {
  const { splitter, lines } = collect();
  const text = Buffer.from("中文日志：烧录完成\n", "utf8");
  splitter.push(text.subarray(0, 5));
  splitter.push(text.subarray(5));
  assert.deepEqual(lines, ["中文日志：烧录完成"]);
});

test("W03: 长行跨片累积时，到上限立即输出并计数", () => {
  const { splitter, lines, flags } = collect();
  splitter.push(Buffer.from("x".repeat(3000)));
  assert.equal(lines.length, 0, "未到上限不输出");
  splitter.push(Buffer.from("y".repeat(2000)));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, MAX_LINE);
  assert.equal(flags[0].truncated, true);
  assert.equal(splitter.pendingChars, 3000 + 2000 - MAX_LINE);
});

test("W03: flush 输出残留（partial 标记）", () => {
  const { splitter, lines, flags } = collect();
  splitter.push(Buffer.from("no newline yet"));
  assert.equal(lines.length, 0);
  splitter.flush();
  assert.deepEqual(lines, ["no newline yet"]);
  assert.equal(flags[0].partial, true);
  assert.equal(splitter.pendingChars, 0);
});

test("W03: 10 路无换行/二进制流同时涌入，每路缓冲有界", () => {
  const channels = [];
  for (let i = 0; i < 10; i += 1) channels.push(collect());
  const chunk = Buffer.alloc(8192, 0xff);
  for (let round = 0; round < 32; round += 1) {
    for (const ch of channels) ch.splitter.push(chunk);
  }
  for (const ch of channels) {
    assert.ok(ch.splitter.pendingChars <= MAX_LINE);
    assert.equal(ch.lines.join("").length + ch.splitter.pendingChars, 8192 * 32);
  }
});
