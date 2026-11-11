/**
 * 诊断脱敏反例。用生产 diagnostics.js，不读真实固件，不写用户目录。
 * 凭证必须整段消失；只留前 12 位不算删掉。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_DIAGNOSTIC_BYTES,
  buildDiagnosticReport,
  redactObject,
  redactText,
  serializeDiagnosticReport,
} from "../electron/diagnostics.js";

const TOKEN = "deadbeef".repeat(8);

test("赋值、请求头、URL 查询里的凭证整段删除，不保留前缀", () => {
  const notes = new Set();
  const text = redactText(
    [
      `token=${TOKEN} 已签发`,
      "Authorization: Bearer abc.def.ghi",
      "Cookie: session=supersecret; theme=dark",
      "https://alice:s3cret@updates.example/fw?access_token=short-token&arch=ws63",
      `password=hunter2`,
    ].join("\n"),
    notes,
  );
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes(TOKEN.slice(0, 12)), false);
  assert.equal(text.includes("deadbeef"), false);
  assert.equal(text.includes("abc.def.ghi"), false);
  assert.equal(text.includes("supersecret"), false);
  assert.equal(text.includes("alice"), false);
  assert.equal(text.includes("s3cret"), false);
  assert.equal(text.includes("short-token"), false);
  assert.equal(text.includes("hunter2"), false);
  assert.match(text, /arch=ws63/);
  assert.match(text, /<REDACTED>/);
});

test("嵌套对象的大小写键、JSON 字符串和能力令牌不会漏出", () => {
  const notes = new Set();
  const value = redactObject({
    ok: true,
    Password: "Hunter",
    headers: {
      Authorization: "Bearer capability-token",
      "Set-Cookie": "sid=session-value",
    },
    nested: {
      firmwareToken: TOKEN,
      access_token: "access-value",
      note: `see ${TOKEN}`,
      url: "https://example.test/dl?token=query-secret&file=demo.fwpkg",
    },
    list: [{ cookie: "a=b", port: "COM7" }],
    message: `{"password":"from-json","port":"COM8"}`,
  }, notes);
  const text = JSON.stringify(value);
  for (const secret of ["Hunter", "capability-token", "session-value", TOKEN, "deadbeef", "access-value", "query-secret", "from-json"]) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.equal(value.ok, true);
  assert.equal(value.list[0].port, "COM7");
  assert.match(text, /COM8/);
  assert.equal("Password" in value, false);
  assert.equal("Authorization" in value.headers, false);
  assert.equal("firmwareToken" in value.nested, false);
});

test("Windows、UNC、用户目录和环境变量路径不保留用户名或服务器名", () => {
  const notes = new Set();
  const text = redactText(
    [
      String.raw`C:\Users\alice\Desktop\fw\demo.fwpkg`,
      "C:/Users/dave/x/c.bin",
      String.raw`\\fileserver\share\Users\carol\b.bin`,
      "//fileserver/share/secret.bin",
      "%USERPROFILE%\\secrets\\d.bin",
      String.raw`C:\Users\alice`,
    ].join(" "),
    notes,
  );
  for (const leak of ["alice", "dave", "carol", "fileserver", "USERPROFILE", "secrets"]) {
    assert.equal(text.toLowerCase().includes(leak.toLowerCase()), false, leak);
  }
  assert.match(text, /<PATH>\/demo\.fwpkg/);
  assert.match(text, /<PATH>\/c\.bin/);
  assert.match(text, /<PATH>\/b\.bin/);
  assert.match(text, /<PATH>\/d\.bin/);
  assert.match(text, /<PATH>(?!\/)/);
});

test("固件字节、Buffer 和长转储不能进入报告，报告有大小上限", () => {
  const payload = Buffer.from(`BEGINFIRMWARE${"Z".repeat(300)}`).toString("base64");
  const report = buildDiagnosticReport({
    now: Date.parse("2026-10-29T12:00:00.000Z"),
    logs: [
      payload,
      "ab ".repeat(80),
      ...Array.from({ length: 300 }, (_, i) => `password=hunter2 ${"测".repeat(4000)} #${i}`),
    ],
    runtime: {
      keep: "COM3",
      firmwareBytes: Array.from({ length: 64 }, (_, i) => i),
      blob: { type: "Buffer", data: [9, 8, 7, 6, 5, 4, 3] },
      image: "raw-image-should-not-appear",
    },
    flashSnapshot: {
      channels: {
        1: { status: "error", stage: "handshake", port: "COM3", errorMessage: `token=${TOKEN}` },
      },
    },
  });
  const text = serializeDiagnosticReport(report);
  assert.ok(text.length <= MAX_DIAGNOSTIC_BYTES, `报告 ${text.length} 超过 ${MAX_DIAGNOSTIC_BYTES}`);
  assert.equal(report.redaction.truncated, true);
  assert.equal(text.includes(payload.slice(0, 48)), false);
  assert.equal(text.includes("BEGINFIRMWARE"), false);
  assert.equal(text.includes("hunter2"), false);
  assert.equal(text.includes(TOKEN.slice(0, 8)), false);
  assert.equal(text.includes("raw-image-should-not-appear"), false);
  assert.equal(text.includes("0,1,2,3,4,5,6,7"), false);
  assert.match(text, /COM3/);
  assert.match(text, /<BINARY/);
  assert.equal(report.flash.channels[0].port, "COM3");
  assert.equal(report.flash.channels[0].stage, "handshake");
});

test("明确标成 SHA256 的摘要仍只留 12 位，整段裸摘要也按这个契约截断", () => {
  const digest = "ab".repeat(32);
  const labeled = redactText(`固件摘要 SHA256 ${digest}`);
  assert.match(labeled, /SHA256 [0-9a-f]{12}…/i);
  assert.equal(labeled.includes(digest), false);
  assert.equal(redactText(digest), `${digest.slice(0, 12)}…`);
});
