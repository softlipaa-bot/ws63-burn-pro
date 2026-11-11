/**
 * 诊断导出（用户已授权功能 1）与失败通道重试（功能 2）的契约回归。
 *
 * 诊断导出的红线：不得含固件原始内容、密码、令牌、用户目录。
 * 重试的红线：只重试明确的失败通道、一次点击只尝试一次、不把部分完成当成功。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

import {
  MAX_DIAGNOSTIC_LOG_LINES,
  buildDiagnosticReport,
  redactObject,
  redactText,
  serializeDiagnosticReport,
  suggestDiagnosticFileName,
} from "../electron/diagnostics.js";

function sampleInput() {
  return {
    now: Date.parse("2026-10-29T12:00:00.000Z"),
    buildInfo: {
      version: "1.1.4",
      product: "WS63BurnPro",
      builtAt: "2026-10-29T11:00:00.000Z",
      sourceDigest: "afa1501d2e3aaf1505de4428d7f4826da05a01cd9e6f854c66a81fd40f914ff7",
      runtime: { packaged: true, execPath: "C:\\Users\\alice\\AppData\\Local\\WS63\\WS63BurnPro.exe" },
      manifest: { found: true, matchesPackageVersion: true },
      warnings: [],
    },
    flashSnapshot: {
      channels: {
        1: {
          status: "error",
          running: false,
          pending: false,
          stage: "handshake",
          stageLabel: "握手",
          partName: "",
          progress: 0,
          port: "COM7",
          errorMessage: "等待设备复位进入下载模式超时（60s）",
          transferComplete: false,
          protocolConfirmed: false,
          bootVerified: false,
          ackPolicy: "structural",
          handshakeAttempts: 240,
          handshakeRxBytes: 0,
          retryCount: 2,
        },
      },
    },
    monitorSnapshot: {
      serialConnected: false,
      serialChannels: {
        1: { connected: false, port: "COM7", baudRate: 115200, truncatedSegments: 0, droppedChars: 3, pendingChars: 0 },
      },
    },
    busy: { busy: false, reasons: [] },
    logs: [
      "[12:00:00.000] [信息] 固件摘要 SHA256 afa1501d2e3aaf1505de4428d7f4826da05a01cd9e6f854c66a81fd40f914ff7",
      "[12:00:01.000] [错误] 打开 C:\\Users\\alice\\Desktop\\fw\\demo.fwpkg 失败",
      "[12:00:02.000] [信息] token=deadbeefdeadbeefdeadbeefdeadbeef 已签发",
    ],
    ackPolicy: { policy: "structural", label: "仅结构校验（应答命令字语义未验证）" },
    portLines: { mode: "none" },
    bootMarks: { processStart: 0, windowShown: 757 },
    runtime: {
      platform: "win32",
      arch: "x64",
      electron: "34.5.8",
      node: "24.19.0",
      quarantineCount: 0,
      // 故意塞入敏感字段，验证会被剔除
      token: "should-be-dropped",
      filePath: "C:\\Users\\alice\\Desktop\\fw\\demo.fwpkg",
    },
  };
}

test("诊断导出: 不含用户主目录与完整绝对路径", () => {
  const report = buildDiagnosticReport(sampleInput());
  const text = serializeDiagnosticReport(report);
  assert.equal(/alice/i.test(text), false, "不得出现用户名/主目录");
  assert.equal(/C:\\\\Users/i.test(text), false, "不得出现完整用户路径");
  assert.match(text, /<PATH>\//, "路径应被替换为 <PATH>/文件名");
});

test("诊断导出: 不含令牌与超长十六进制（摘要截断）", () => {
  const report = buildDiagnosticReport(sampleInput());
  const text = serializeDiagnosticReport(report);
  assert.equal(text.includes("deadbeefdeadbeef"), false, "令牌不得出现");
  assert.equal(text.includes("should-be-dropped"), false, "runtime.token 必须被整条剔除");
  // 64 位摘要应被截断为前 12 位 + …
  assert.match(report.app.sourceDigest, /^[a-f0-9]{12}…$/);
  assert.equal(/[a-f0-9]{64}/.test(text), false, "不应出现完整 64 位摘要");
});

test("诊断导出: 不含固件原始内容（只保留摘要与元信息）", () => {
  const report = buildDiagnosticReport(sampleInput());
  const text = serializeDiagnosticReport(report);
  // 固件内容从不出现在报告中：不应出现大段 base64/hex 数据块
  assert.equal(/[A-Za-z0-9+/]{200,}/.test(text), false, "不应包含大块二进制/base64");
  // 注意：redaction.droppedKeys 会**记录**被剔除的键名（这是审计信息），
  // 因此这里断言的是"通道里没有固件路径字段"，而不是文本里不出现该单词。
  for (const ch of report.flash.channels) {
    assert.equal("filePath" in ch, false);
    assert.equal("token" in ch, false);
  }
  assert.equal(report.runtime.filePath, undefined, "runtime.filePath 必须被剔除");
  assert.equal(report.runtime.token, undefined, "runtime.token 必须被剔除");
});

test("诊断导出: 保留排查所需字段（阶段/错误码/COM/波特率/计数/时间/版本）", () => {
  const report = buildDiagnosticReport(sampleInput());
  const ch = report.flash.channels[0];
  assert.equal(ch.stage, "handshake");
  assert.equal(ch.port, "COM7");
  assert.equal(ch.ackPolicy, "structural");
  assert.equal(ch.handshakeAttempts, 240);
  assert.equal(ch.retryCount, 2);
  assert.equal(report.serial.channels[0].baudRate, 115200);
  assert.equal(report.app.version, "1.1.4");
  assert.equal(report.app.packaged, true);
  assert.equal(report.generatedAt, "2026-10-29T12:00:00.000Z");
  assert.ok(report.bootMarks.windowShown === 757);
  assert.equal(report.protocol.portLinesMode, "none");
});

test("诊断导出: 显式声明脱敏动作与排除项，便于审核", () => {
  const report = buildDiagnosticReport(sampleInput());
  assert.ok(report.redaction.excludedByDesign.length >= 4);
  assert.ok(report.redaction.excludedByDesign.some((x) => x.includes("固件原始字节")));
  assert.ok(report.redaction.droppedKeys.includes("token"));
  assert.equal(report.redaction.logLineLimit, MAX_DIAGNOSTIC_LOG_LINES);
});

test("诊断导出: 日志行数受上限约束", () => {
  const input = sampleInput();
  input.logs = Array.from({ length: MAX_DIAGNOSTIC_LOG_LINES + 50 }, (_, i) => `line-${i}`);
  const report = buildDiagnosticReport(input);
  assert.equal(report.logs.length, MAX_DIAGNOSTIC_LOG_LINES);
  assert.equal(report.logs[report.logs.length - 1], `line-${MAX_DIAGNOSTIC_LOG_LINES + 49}`, "保留最近的行");
});

test("诊断导出: 文件名带版本与时间戳，不含路径", () => {
  const report = buildDiagnosticReport(sampleInput());
  const name = suggestDiagnosticFileName(report);
  assert.match(name, /^ws63-diagnostic-1\.1\.4-/);
  assert.match(name, /\.json$/);
  assert.equal(/[\\/]/.test(name), false);
});

test("脱敏工具: redactText/redactObject 的行为可直接断言", () => {
  const notes = new Set();
  assert.equal(redactText("C:\\Users\\bob\\x\\a.bin", notes), "<PATH>/a.bin");
  assert.equal(redactText("/home/bob/data/a.bin", notes), "<PATH>/a.bin");
  assert.equal(redactText("a".repeat(64), notes), `${"a".repeat(12)}…`);
  const obj = redactObject({ password: "p", token: "t", keep: "v", nested: { secret: "s" } }, notes);
  assert.equal("password" in obj, false);
  assert.equal("token" in obj, false);
  assert.equal(obj.keep, "v");
  assert.equal("secret" in obj.nested, false);
});

/* ------------------------------------------------ 失败通道重试的契约（IPC 层） */

let hookInstalled = false;
let cachedHandler = null;
async function getHandler() {
  if (!hookInstalled) {
    registerHooks({
      resolve(spec, ctx, next) {
        if (spec === "electron") {
          return {
            url: "data:text/javascript,export const app={isPackaged:true,getAppPath:()=>process.cwd()};export const dialog={showSaveDialog:async()=>({canceled:true})};",
            shortCircuit: true,
          };
        }
        if (spec === "../ota/updater.js" && ctx.parentURL?.endsWith("/burn/ipc.js")) {
          return { url: "data:text/javascript,export const unused=true;export function setWindow(){};", shortCircuit: true };
        }
        return next(spec, ctx);
      },
    });
    hookInstalled = true;
  }
  const ipc = await import("../electron/burn/ipc.js");
  if (!cachedHandler) {
    ipc.registerBurnIpc({ handle(_n, fn) { cachedHandler = fn; } });
  }
  const handler = cachedHandler;
  ipc.setWindow(null);
  ipc.setTrustedPageRoot("C:/synthetic-review-root");
  return handler;
}

const EVENT = { senderFrame: { url: "file:///C:/synthetic-review-root/index.html", parent: null }, sender: null };

test("重试: 空通道列表被拒绝（不允许“一键全量重试”式误用）", async () => {
  const handler = await getHandler();
  await assert.rejects(
    () => handler(EVENT, "retry_failed_channels", { channels: [] }),
    /请选择要重试的失败通道/,
  );
});

test("重试: 非失败状态的通道不会被重试（成功通道必须保留）", async () => {
  const handler = await getHandler();
  const res = await handler(EVENT, "retry_failed_channels", {
    channels: [{ channel: "3", port: "COM3" }],
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.started, []);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /不是失败状态/);
});

test("重试: 未提供固件的失败通道会被逐条报告原因，而不是静默丢弃", async () => {
  const handler = await getHandler();
  const res = await handler(EVENT, "retry_failed_channels", {
    channels: [{ channel: "2", port: "COM2" }],
  });
  assert.equal(res.ok, false);
  assert.ok(Array.isArray(res.skipped));
  assert.equal(res.started.length, 0);
});
