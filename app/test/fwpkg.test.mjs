import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

import {
  MAX_PACKAGE_BYTES,
  describeFwpkg,
  inspectFwpkg,
  openFirmwareReader,
  parseFwpkg,
  validateFwpkgMeta,
} from "../electron/burn/fwpkg.js";
import { buildFwpkgBytes, makeValidPackage, writeTempFile } from "./fixtures.mjs";

function expectCode(fn, code) {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, `期望抛出 ${code}，实际没有抛错`);
  assert.equal(thrown.code, code, `期望 ${code}，实际 ${thrown.code}（${thrown.message}）`);
  return thrown;
}

test("W01: 有效包仍可解析（loaderboot + application）", () => {
  const file = makeValidPackage();
  const snapshot = inspectFwpkg(file);
  assert.equal(snapshot.meta.cnt, 2);
  assert.equal(snapshot.meta.binInfos.length, 2);
  assert.equal(snapshot.meta.binInfos[0].type, 0);
  assert.match(snapshot.sha256, /^[0-9a-f]{64}$/);
  assert.ok(describeFwpkg(snapshot.meta).some((line) => line.includes("BOOT")));
  // 兼容旧 API
  assert.equal(parseFwpkg(file).cnt, 2);
});

test("W01: 分区区间越界（offset=4096 length=1024 的 64 字节包）在设备操作前被拒", () => {
  // 复现审查报告里的最小坏包：头部 CRC 正确，但分区数据根本不在文件里
  const bytes = buildFwpkgBytes({
    cnt: 1,
    parts: [
      { name: "loaderboot", type: 0, offset: 4096, length: 1024, data: Buffer.alloc(0), burn_addr: 0x100000 },
    ],
    totalLength: 64,
    totalBytes: 64,
  });
  const file = writeTempFile(bytes);
  const err = expectCode(() => inspectFwpkg(file), "FWPKG_OUT_OF_RANGE");
  assert.match(err.message, /超出固件包/);
});

test("W01: 截断包（声明总长 > 实际文件长度）被拒", () => {
  const full = buildFwpkgBytes();
  const file = writeTempFile(full.subarray(0, full.length - 512));
  expectCode(() => inspectFwpkg(file), "FWPKG_TRUNCATED");
});

test("W01: 头部 CRC 错误被拒", () => {
  const file = writeTempFile(buildFwpkgBytes({ corruptHeaderCrc: true }));
  expectCode(() => inspectFwpkg(file), "FWPKG_BAD_CRC");
});

test("W01: 魔数错误被拒", () => {
  const file = writeTempFile(buildFwpkgBytes({ magic: 0x12345678 }));
  expectCode(() => inspectFwpkg(file), "FWPKG_BAD_MAGIC");
});

test("W01: 缺少 loaderboot 分区被拒（必要分区校验）", () => {
  const file = writeTempFile(
    buildFwpkgBytes({
      parts: [{ name: "application", type: 1, data: Buffer.alloc(2048, 0x11), burn_addr: 0x200000 }],
    }),
  );
  expectCode(() => inspectFwpkg(file), "FWPKG_NO_LOADER");
});

test("W01: 重复 loaderboot 分区被拒", () => {
  const file = writeTempFile(
    buildFwpkgBytes({
      parts: [
        { name: "loaderboot", type: 0, data: Buffer.alloc(512, 1), burn_addr: 0x100000 },
        { name: "loaderboot2", type: 0, data: Buffer.alloc(512, 2), burn_addr: 0x300000 },
      ],
    }),
  );
  expectCode(() => inspectFwpkg(file), "FWPKG_DUP_LOADER");
});

test("W01: 分区文件区间重叠被拒", () => {
  const file = writeTempFile(
    buildFwpkgBytes({
      parts: [
        // headerSize = 12 + 2*52 = 116；loaderboot 占 116..1140，application 从 512 开始 → 重叠
        { name: "loaderboot", type: 0, data: Buffer.alloc(1024, 1), offset: 116, burn_addr: 0x100000 },
        { name: "application", type: 1, data: Buffer.alloc(1024, 2), offset: 512, burn_addr: 0x200000 },
      ],
      totalBytes: 4096,
    }),
  );
  expectCode(() => inspectFwpkg(file), "FWPKG_OVERLAP");
});

test("W01: 烧录地址区间重叠被拒", () => {
  const file = writeTempFile(
    buildFwpkgBytes({
      parts: [
        { name: "loaderboot", type: 0, data: Buffer.alloc(1024, 1), burn_addr: 0x100000 },
        { name: "application", type: 1, data: Buffer.alloc(1024, 2), burn_addr: 0x100100 },
      ],
    }),
  );
  expectCode(() => inspectFwpkg(file), "FWPKG_BURN_OVERLAP");
});

test("W01: 长度为 0 的分区被拒", () => {
  const file = writeTempFile(
    buildFwpkgBytes({
      parts: [{ name: "loaderboot", type: 0, data: Buffer.alloc(0), length: 0, burn_addr: 0x100000 }],
      totalBytes: 512,
    }),
  );
  expectCode(() => inspectFwpkg(file), "FWPKG_BAD_PART_LENGTH");
});

test("W01: 未知分区类型被拒（旧实现会静默跳过）", () => {
  const bytes = buildFwpkgBytes({
    parts: [
      { name: "loaderboot", type: 0, data: Buffer.alloc(512, 1), burn_addr: 0x100000 },
      { name: "weird", type: 7, data: Buffer.alloc(512, 2), burn_addr: 0x200000 },
    ],
  });
  const file = writeTempFile(bytes);
  expectCode(() => inspectFwpkg(file), "FWPKG_UNSUPPORTED_TYPE");
});

test("W01: 分区名占满 32 字节（无 NUL）被拒（否则会写坏 ymodem 信息块）", () => {
  const bytes = buildFwpkgBytes({
    parts: [
      {
        // 32 字节名域被填满 → 长度字段会被 ymodem 信息块吞掉
        name: "exactly_32_byte_partition_name!!",
        type: 0,
        data: Buffer.alloc(128, 1),
        burn_addr: 0x100000,
      },
    ],
  });
  const file = writeTempFile(bytes);
  expectCode(() => inspectFwpkg(file), "FWPKG_BAD_PART_NAME");
});

test("W01: 超大包被拒", () => {
  const file = makeValidPackage();
  // 不真的写 64MB+：直接构造超限的 meta 走跨段校验
  const snapshot = inspectFwpkg(file);
  const meta = { ...snapshot.meta, fileSize: MAX_PACKAGE_BYTES + 1 };
  expectCode(() => validateFwpkgMeta(meta), "FWPKG_TOO_LARGE");
});

test("W01: 预览后文件变化 → 快照身份不符被拒（TOCTOU）", () => {
  const file = makeValidPackage();
  const snapshot = inspectFwpkg(file);
  const reader = openFirmwareReader(snapshot);
  reader.close();

  // 换掉内容（大小不同）
  fs.writeFileSync(file, buildFwpkgBytes({ parts: [{ name: "loaderboot", type: 0, data: Buffer.alloc(3000, 9), burn_addr: 0x100000 }] }));
  expectCode(() => openFirmwareReader(snapshot), "FWPKG_CHANGED");
});

test("W01: 读取越界不再补零，直接失败", () => {
  const file = makeValidPackage();
  const snapshot = inspectFwpkg(file);
  const reader = openFirmwareReader(snapshot);
  try {
    expectCode(() => reader.read(snapshot.size - 10, 100), "FWPKG_OUT_OF_RANGE");
    const ok = reader.read(0, 16);
    assert.equal(ok.length, 16);
  } finally {
    reader.close();
  }
});

test("W01/W08: 相同文件复用不可变校验结果（缓存）", () => {
  const file = makeValidPackage();
  const a = inspectFwpkg(file);
  const b = inspectFwpkg(file);
  assert.equal(a, b, "同一 (路径,大小,mtime) 应返回同一个冻结对象");
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(a.meta));
});

test("W01: 不存在 / 非 fwpkg 路径给出明确错误码", () => {
  expectCode(() => inspectFwpkg(path.join(path.dirname(makeValidPackage()), "nope.fwpkg")), "FWPKG_NOT_FOUND");
  expectCode(() => inspectFwpkg(""), "FWPKG_BAD_PATH");
});
