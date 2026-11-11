import test from "node:test";
import assert from "node:assert/strict";

import {
  IpcError,
  assertFirmwarePathPolicy,
  assertPlainParams,
  assertTrustedSender,
  isPlausibleBaud,
  isPlausiblePort,
  optionalBoolean,
  requireBaud,
  requireChannelId,
  requirePort,
  sanitizeSerialText,
} from "../electron/ipc-guard.js";
import { computeRuntimeOptions } from "../electron/runtime-options.js";

const CHANNELS = Array.from({ length: 10 }, (_, i) => String(i + 1));

function fakeFrame(url, { parent = null } = {}) {
  return { url, parent };
}

test("W08: 拒绝缺失/子框架/不可信来源的 senderFrame", () => {
  const ROOT = "C:/app/resources/app.asar/dist";
  const ctx = { webContents: {}, isDev: false, allowedFilePrefix: ROOT };
  assert.throws(() => assertTrustedSender({ senderFrame: null, sender: {} }, ctx), IpcError);
  assert.throws(
    () => assertTrustedSender({ senderFrame: fakeFrame("file:///x/index.html", { parent: {} }), sender: ctx.webContents }, ctx),
    (err) => err.code === "IPC_UNTRUSTED_SENDER",
  );
  assert.throws(
    () =>
      assertTrustedSender(
        { senderFrame: fakeFrame("https://evil.example/x.html"), sender: ctx.webContents },
        ctx,
      ),
    (err) => err.code === "IPC_UNTRUSTED_SENDER",
  );
  // 正式版：实际加载目录内的主框架通过
  assert.equal(
    assertTrustedSender(
      { senderFrame: fakeFrame("file:///C:/app/resources/app.asar/dist/index.html"), sender: ctx.webContents },
      ctx,
    ),
    true,
  );
  // 开发版：只允许本机 dev server 的精确 origin
  const devCtx = { webContents: {}, isDev: true };
  assert.equal(
    assertTrustedSender(
      { senderFrame: fakeFrame("http://127.0.0.1:5173/index.html"), sender: devCtx.webContents },
      devCtx,
    ),
    true,
  );
  assert.throws(
    () =>
      assertTrustedSender(
        { senderFrame: fakeFrame("http://localhost:9999/"), sender: devCtx.webContents },
        devCtx,
      ),
    IpcError,
  );
});

test("W29-14: 生产来源收紧到已加载页面目录（不再任何 file:// 都可信）", () => {
  const ROOT = "C:/app/resources/app.asar/dist";
  const ctx = { webContents: {}, isDev: false, allowedFilePrefix: ROOT };

  // 目录内的页面/资源：允许
  assert.equal(
    assertTrustedSender(
      { senderFrame: fakeFrame("file:///C:/app/resources/app.asar/dist/index.html"), sender: ctx.webContents },
      ctx,
    ),
    true,
  );
  // 目录**外**的本地文件：旧实现因 startsWith("file://") 而放行 → 现在必须拒绝
  for (const url of [
    "file:///C:/Users/someone/Desktop/evil.html",
    "file:///C:/app/resources/app.asar/dist-evil/index.html",
    "file:///C:/app/resources/app.asar/dist/../../secret.html",
  ]) {
    assert.throws(
      () => assertTrustedSender({ senderFrame: fakeFrame(url), sender: ctx.webContents }, ctx),
      (err) => err.code === "IPC_UNTRUSTED_SENDER",
      `应拒绝 ${url}`,
    );
  }
  // 未配置可信目录时一律拒绝（失败关闭）
  assert.throws(
    () =>
      assertTrustedSender(
        { senderFrame: fakeFrame("file:///C:/app/resources/app.asar/dist/index.html"), sender: {} },
        { webContents: {}, isDev: false },
      ),
    (err) => err.code === "IPC_UNTRUSTED_SENDER",
  );
  // 开发模式拒绝端口前缀混淆
  const devCtx = { webContents: {}, isDev: true };
  for (const url of ["http://127.0.0.1:51730/index.html", "http://127.0.0.1:5173.evil.com/"]) {
    assert.throws(
      () => assertTrustedSender({ senderFrame: fakeFrame(url), sender: devCtx.webContents }, devCtx),
      (err) => err.code === "IPC_UNTRUSTED_SENDER",
      `应拒绝 ${url}`,
    );
  }
});

test("W08: 窗口不匹配时拒绝（防止其他 webContents 调用）", () => {
  const main = { id: 1 };
  const other = { id: 2 };
  assert.throws(
    () =>
      assertTrustedSender(
        { senderFrame: fakeFrame("file:///x/index.html"), sender: other },
        { webContents: main, isDev: false },
      ),
    (err) => err.code === "IPC_UNTRUSTED_SENDER",
  );
});

test("W08: 固件路径策略（绝对路径 + .fwpkg + 长度/字符限制）", () => {
  assert.equal(
    assertFirmwarePathPolicy("C:\\fw\\a.fwpkg"),
    "C:\\fw\\a.fwpkg",
  );
  for (const bad of ["relative/a.fwpkg", "C:\\fw\\a.bin", "C:\\fw\\a.fwpkg\u0000x", "", null, "C:/" + "a".repeat(5000) + ".fwpkg"]) {
    assert.throws(() => assertFirmwarePathPolicy(bad), IpcError, `应拒绝 ${String(bad).slice(0, 20)}`);
  }
});

test("W08: 参数 schema：通道/端口/波特率/布尔/文本", () => {
  assert.equal(requireChannelId("3", CHANNELS), "3");
  assert.throws(() => requireChannelId("11", CHANNELS), IpcError);
  assert.throws(() => requireChannelId(null, CHANNELS), IpcError);
  assert.equal(requirePort(" COM7 "), "COM7");
  assert.throws(() => requirePort(""), IpcError);
  assert.throws(() => requirePort("C O M"), IpcError);
  assert.ok(isPlausiblePort("COM12"));
  assert.equal(isPlausibleBaud(921600), true);
  assert.equal(requireBaud(undefined, 921600), 921600);
  assert.throws(() => requireBaud(0), IpcError);
  assert.throws(() => optionalBoolean("yes"), IpcError);
  assert.equal(optionalBoolean(undefined, false), false);
  assert.throws(() => assertPlainParams([]), IpcError);
  assert.deepEqual(assertPlainParams(undefined), {});
  assert.equal(sanitizeSerialText("AT+RST"), "AT+RST");
  assert.throws(() => sanitizeSerialText("x".repeat(5000)), IpcError);
});

test("W08: GPU/heap/sandbox 是可诊断开关（默认不再强制忽略 GPU 黑名单）", () => {
  const auto = computeRuntimeOptions({ env: {}, argv: [] });
  const names = auto.switches.map(([n]) => n);
  assert.equal(auto.gpuMode, "auto");
  assert.equal(auto.sandbox, true);
  assert.equal(names.includes("ignore-gpu-blocklist"), false, "默认不应强制忽略 GPU 黑名单");
  assert.ok(auto.describe().switches.length > 0);

  const forced = computeRuntimeOptions({ env: { WS63_GPU_MODE: "force" }, argv: [] });
  assert.ok(forced.switches.map(([n]) => n).includes("ignore-gpu-blocklist"));
  assert.ok(forced.switches.some(([n, v]) => n === "enable-features" && v.includes("CanvasOopRasterization")));

  const disabled = computeRuntimeOptions({ argv: ["--ws63-gpu=disable"] });
  assert.ok(disabled.switches.map(([n]) => n).includes("disable-gpu"));

  const heap = computeRuntimeOptions({ env: { WS63_HEAP_MB: "2048" } });
  assert.equal(heap.heapMb, 2048);
  assert.ok(heap.switches.some(([n, v]) => n === "js-flags" && v.includes("2048")));

  const noSandbox = computeRuntimeOptions({ env: { WS63_SANDBOX: "0" } });
  assert.equal(noSandbox.sandbox, false);
});
