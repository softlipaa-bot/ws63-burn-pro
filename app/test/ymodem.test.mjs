import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

import { ymodemXfer } from "../electron/burn/ymodem.js";
import { makeValidPackage } from "./fixtures.mjs";

const FAST = {
  cTimeout: 60,
  ackTimeout: 60,
  xmitTimeout: 400,
  eotTimeout: 200,
  maxBlockRetries: 2,
};

function makeSession(script) {
  const queue = [];
  const writes = [];
  return {
    writes,
    queue,
    push(bytes) {
      for (const b of bytes) queue.push(b);
    },
    async readByte(timeoutMs = 100) {
      if (queue.length) return queue.shift();
      const wait = Math.max(1, Math.min(timeoutMs, 2));
      await new Promise((r) => setTimeout(r, wait));
      if (queue.length) return queue.shift();
      throw new Error("串口读取超时");
    },
    async write(bytes) {
      const buf = Buffer.from(bytes);
      writes.push(buf);
      script?.(buf, this);
    },
    readAllPending() {
      return Buffer.from(queue.splice(0, queue.length));
    },
    drain() {
      queue.length = 0;
    },
  };
}

/** 读取器：模拟“读不满”的固件源 */
function makeShortReader(available) {
  return {
    read(offset, length) {
      if (offset + length > available) {
        const err = new Error(`读取不足: 只有 ${available} 字节`);
        err.code = "SHORT_READ";
        throw err;
      }
      return Buffer.alloc(length, 0x7f);
    },
  };
}

test("W01: 没有 'C' 时不发信息块，明确失败（NO_C）", async () => {
  const session = makeSession();
  const res = await ymodemXfer(
    session,
    makeShortReader(4096),
    { name: "loaderboot", offset: 0, length: 1024 },
    null,
    null,
    FAST,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "NO_C");
  assert.equal(res.stage, "wait_c");
  assert.equal(session.writes.length, 0, "没有 C 就不应写任何信息块");
});

test("W01: 短读直接失败，绝不补零发送", async () => {
  // 文件里只有 1024 字节，但分区声明 3000 字节
  const session = makeSession((buf, self) => {
    if (buf[0] === 0x01) self.push([0x06]); // 信息块 ACK
    if (buf[0] === 0x02) self.push([0x06]); // 数据块 ACK
    if (buf[0] === 0x04) self.push([0x06]); // EOT ACK
    self.push([0x43]); // 下个阶段要的 'C'（不会用到）
  });
  session.push([0x43]); // 初始 'C'
  const res = await ymodemXfer(
    session,
    makeShortReader(1024),
    { name: "application", offset: 0, length: 3000 },
    null,
    null,
    FAST,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "SHORT_READ");
  // 只应发出：信息块 + 第 1 个数据块（1024 字节），第 2 块读取失败后停止
  const dataBlocks = session.writes.filter((w) => w[0] === 0x02);
  assert.equal(dataBlocks.length, 1, `不应零填充多发数据块，实际 ${dataBlocks.length}`);
  const lastBlock = dataBlocks[0];
  assert.equal(
    lastBlock.subarray(3, 3 + 1024).some((b) => b === 0),
    false,
    "数据块不应包含补零内容",
  );
});

test("W01/W02: 全程 ACK 时返回 ok，且数据块数量正确", async () => {
  const session = makeSession((buf, self) => {
    if (buf[0] === 0x04) self.push([0x06]);
    else self.push([0x06]);
    self.push([0x43]);
  });
  session.push([0x43]);
  const res = await ymodemXfer(
    session,
    makeShortReader(10000),
    { name: "application", offset: 0, length: 2048 },
    null,
    null,
    FAST,
  );
  assert.equal(res.ok, true);
  assert.equal(res.code, "OK");
  assert.equal(res.blocks, 2);
  assert.equal(session.writes.filter((w) => w[0] === 0x02).length, 2);
});

test("W02: 对端一直 NAK → 有界重试后失败（不会假装成功）", async () => {
  const session = makeSession((buf, self) => {
    self.push([0x15]);
  });
  session.push([0x43]);
  const res = await ymodemXfer(
    session,
    makeShortReader(4096),
    { name: "loaderboot", offset: 0, length: 1024 },
    null,
    null,
    { ...FAST, ackTimeout: 5, maxBlockRetries: 3 },
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "ACK_TIMEOUT");
  const infoWrites = session.writes.filter((w) => w[0] === 0x01);
  assert.equal(infoWrites.length, 3, `重试次数应受 maxBlockRetries 限制，实际 ${infoWrites.length}`);
});

test("W02: 停止信号在传输中生效", async () => {
  const controller = new AbortController();
  const session = makeSession((buf, self) => {
    self.push([0x06]);
    controller.abort();
  });
  session.push([0x43]);
  const res = await ymodemXfer(
    session,
    makeShortReader(4096),
    { name: "loaderboot", offset: 0, length: 4096 },
    null,
    controller.signal,
    FAST,
  );
  assert.equal(res.ok, false);
  assert.ok(["STOPPED", "ACK_TIMEOUT"].includes(res.code), res.code);
});

test("W01: 固件文件读不满（真实文件截断）也会失败", async () => {
  const file = makeValidPackage();
  const stat = fs.statSync(file);
  const source = {
    read(offset, length) {
      if (offset + length > stat.size) {
        const err = new Error("固件读取越界");
        err.code = "FWPKG_OUT_OF_RANGE";
        throw err;
      }
      return Buffer.alloc(length, 0x33);
    },
  };
  const session = makeSession((buf, self) => {
    self.push([0x06]);
    self.push([0x43]);
  });
  session.push([0x43]);
  const res = await ymodemXfer(
    session,
    source,
    { name: "application", offset: stat.size - 100, length: 1024 },
    null,
    null,
    FAST,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "FWPKG_OUT_OF_RANGE");
});
