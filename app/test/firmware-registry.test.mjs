/**
 * W29-06：固件路径 / 能力令牌一致性。
 *
 * 复现的缺陷：`App.vue` 的 applyFirmwareToAll 只复制路径、拖拽只改路径不清令牌，
 * 而后端有令牌时优先用 token.path —— UI 显示 B，实际烧 A。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

import {
  MAX_FIRMWARE_TOKENS,
  TOKEN_TTL_MS,
  issueFirmwareToken,
  lookupFirmwareToken,
  resetFirmwareTokens,
  resolveFirmware,
  sameFirmwarePath,
  tokenCount,
} from "../electron/burn/firmware-registry.js";
import { inspectFwpkg } from "../electron/burn/fwpkg.js";
import { buildFwpkgBytes, makeValidPackage, writeTempFile } from "./fixtures.mjs";

function freshFile(seedByte = 0xa1) {
  return writeTempFile(
    buildFwpkgBytes({
      parts: [
        { name: "loaderboot", type: 0, data: Buffer.alloc(1024, seedByte), burn_addr: 0x100000 },
      ],
    }),
  );
}

test.beforeEach(() => resetFirmwareTokens());

test("W29-06: 仅路径 → 正常解析并签发令牌", () => {
  const file = freshFile();
  const { snapshot, token } = resolveFirmware({ filePath: file });
  assert.equal(snapshot.path, file);
  assert.ok(token);
  assert.ok(lookupFirmwareToken(token), "令牌必须可用");
});

test("W29-06: 仅令牌 → 用令牌指向的文件解析", () => {
  const file = freshFile();
  const first = resolveFirmware({ filePath: file });
  const { snapshot } = resolveFirmware({ token: first.token });
  assert.equal(snapshot.path, file);
});

test("W29-06: 同一文件的路径 + 令牌 → 通过（大小写/斜杠差异不影响）", () => {
  const file = freshFile();
  const { token } = resolveFirmware({ filePath: file });
  const sameUpper = file.toUpperCase();
  if (sameFirmwarePath(file, sameUpper)) {
    assert.doesNotThrow(() => resolveFirmware({ filePath: sameUpper, token }));
  } else {
    assert.doesNotThrow(() => resolveFirmware({ filePath: file, token }));
  }
});

test("W29-06【核心】: 令牌指向 A、路径给 B → 必须拒绝（旧实现会静默烧 A）", () => {
  const fileA = freshFile(0xa1);
  const fileB = freshFile(0xb2);
  const { token: tokenA } = resolveFirmware({ filePath: fileA });

  assert.throws(
    () => resolveFirmware({ filePath: fileB, token: tokenA }),
    (err) => {
      assert.equal(err.code, "FWPKG_TOKEN_MISMATCH");
      assert.match(err.message, /路径与授权令牌不一致/);
      assert.match(err.message, /重新选择固件/);
      return true;
    },
  );
});

test("W29-06: 覆盖选择 A→B 后，用 B 的路径 + B 的令牌成功，不会退回 A", () => {
  const fileA = freshFile(0xa1);
  const fileB = freshFile(0xb2);
  const a = resolveFirmware({ filePath: fileA });
  const b = resolveFirmware({ filePath: fileB });
  const again = resolveFirmware({ filePath: fileB, token: b.token });
  assert.equal(again.snapshot.path, fileB);
  assert.notEqual(a.token, b.token);
});

test("W29-06: 过期令牌被拒绝（并要求重新选择）", () => {
  const file = freshFile();
  const { token } = resolveFirmware({ filePath: file });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + TOKEN_TTL_MS + 1000;
    assert.equal(lookupFirmwareToken(token), null);
    assert.throws(
      () => resolveFirmware({ token }),
      (err) => {
        assert.equal(err.code, "IPC_BAD_PARAMS");
        assert.match(err.message, /令牌无效或已过期/);
        return true;
      },
    );
  } finally {
    Date.now = realNow;
  }
});

test("W29-06: 令牌有效但文件内容被换掉 → FWPKG_CHANGED", () => {
  const file = freshFile(0xa1);
  const { token } = resolveFirmware({ filePath: file });
  // 换成另一个内容不同、但同样合法的包
  fs.writeFileSync(
    file,
    buildFwpkgBytes({
      parts: [
        { name: "loaderboot", type: 0, data: Buffer.alloc(4096, 0x77), burn_addr: 0x100000 },
      ],
    }),
  );
  assert.throws(
    () => resolveFirmware({ token }),
    (err) => {
      assert.equal(err.code, "FWPKG_CHANGED");
      return true;
    },
  );
});

test("W29-06: 非 .fwpkg / 相对路径 / 空路径都被策略拒绝", () => {
  const file = makeValidPackage();
  assert.throws(() => resolveFirmware({ filePath: "relative/path.fwpkg" }), /绝对路径/);
  assert.throws(() => resolveFirmware({ filePath: file.replace(/\.fwpkg$/, ".bin") }), /\.fwpkg/);
  assert.throws(() => resolveFirmware({}), /路径为空/);
});

test("W29-06: 令牌表有容量上限，超出后淘汰最旧（W29-14 的容量部分）", () => {
  const file = freshFile();
  const snapshot = inspectFwpkg(file);
  const tokens = [];
  for (let i = 0; i < MAX_FIRMWARE_TOKENS + 5; i += 1) {
    tokens.push(issueFirmwareToken(snapshot));
  }
  assert.ok(tokenCount() <= MAX_FIRMWARE_TOKENS, `令牌数必须受上限约束，实际 ${tokenCount()}`);
  assert.equal(lookupFirmwareToken(tokens[0]), null, "最旧的令牌应被淘汰");
  assert.ok(lookupFirmwareToken(tokens[tokens.length - 1]), "最新令牌必须仍有效");
});

test("W29-06: sameFirmwarePath 归一化（大小写 / 斜杠 / 末尾斜杠）", () => {
  assert.equal(sameFirmwarePath("C:\\a\\b.fwpkg", "c:/a/b.fwpkg"), true);
  assert.equal(sameFirmwarePath("C:\\a\\b.fwpkg", "C:\\a\\b.fwpkg\\"), true);
  assert.equal(sameFirmwarePath("C:\\a\\b.fwpkg", "C:\\a\\c.fwpkg"), false);
  assert.equal(sameFirmwarePath(null, "x"), false);
});
