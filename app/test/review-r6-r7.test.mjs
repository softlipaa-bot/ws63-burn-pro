/**
 * Codex 复审 R6（IPC 生命周期）与 R7（发布校验）的断言回归。
 *
 * R6：通过**真实 registerBurnIpc handler** 驱动 start_flash/stop_flash，
 *     只把 Electron 与 ota/updater 换成桩（用 node:module registerHooks），
 *     并替换 Ws63Flasher 的端口 IO，用来断言"取消后绝不再开串口"。
 * R7：通过 CLI 级（子进程）断言空目标/缺失便携版/摘要不符/一致四种情形。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeValidPackage } from "./fixtures.mjs";
import { sleep } from "./fake-serial-port.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");

/* ---------------------------------------------------------------- R6 工具 */

let hook = null;
let ipcModule = null;
let monitorModule = null;
/** registerBurnIpc 有 ipcRegistered 幂等保护，因此 handler 只注册一次、跨用例复用。 */
let registeredHandler = null;

async function getHandler() {
  installElectronStub();
  const ipc = ipcModule ?? (ipcModule = await import("../electron/burn/ipc.js"));
  if (!registeredHandler) {
    ipc.registerBurnIpc({
      handle(_name, fn) {
        registeredHandler = fn;
      },
    });
    ipc.setWindow(null);
    // W29-14 后生产来源必须是"已加载页面目录"内的 file:// 文档
    ipc.setTrustedPageRoot("C:/synthetic-review-root");
  }
  return { handler: registeredHandler, ipc };
}

function installElectronStub() {
  if (hook) return;
  hook = registerHooks({
    resolve(spec, ctx, next) {
      if (spec === "electron") {
        return {
          url: "data:text/javascript,export const app={isPackaged:true,getAppPath:()=>process.cwd(),isReady:()=>true};export const dialog={showOpenDialog:async()=>({canceled:true,filePaths:[]})};export const ipcMain={};",
          shortCircuit: true,
        };
      }
      if (spec === "../ota/updater.js" && ctx.parentURL?.endsWith("/burn/ipc.js")) {
        return {
          url: "data:text/javascript,export const unused=true;export function setWindow(){};export function getStatus(){return {};};export function saveConfig(){};export async function checkForUpdates(){return {};};export async function downloadUpdate(){return {};};export async function installUpdateAndRestart(){return {};};export async function cancelDownload(){return {};};export async function openReleasePage(){return {};};export function maybeAutoCheck(){};export function markBootHealthy(){};",
          shortCircuit: true,
        };
      }
      return next(spec, ctx);
    },
  });
}

class CloseControlledPort extends EventEmitter {
  constructor({ path = "COM93" } = {}) {
    super();
    this.path = path;
    this.baudRate = 115200;
    this.isOpen = false;
    this.closeCb = null;
  }
  open(cb) {
    this.isOpen = true;
    cb(null);
  }
  close(cb) {
    this.closeCb = cb; // 阻塞，模拟"关闭很慢"的监听
  }
  finishClose() {
    this.isOpen = false;
    this.closeCb?.(null);
  }
  update(o, cb) {
    cb?.(null);
  }
  flush(cb) {
    cb?.(null);
  }
  write(_d, cb) {
    cb?.(null);
  }
}

test("R6: pending 接管期间 stop_flash 必须真正取消，之后不得再打开串口", async () => {
  const { handler } = await getHandler();
  const monitor = monitorModule ?? (monitorModule = await import("../electron/serial/monitor.js"));
  const { Ws63Flasher } = await import("../electron/burn/ws63flash.js");

  const { resetRegistry } = await import("../electron/serial/ownership.js");
  resetRegistry();
  await monitor.abortAllMonitors();

  // 一个"已连接监听、关闭很慢"的端口，用于制造 pending 窗口
  const occupied = new CloseControlledPort({ path: "COM93" });
  monitor.__setPortFactory(() => occupied);
  await monitor.connectMonitor("1", "COM93", 115200, () => {}, () => {});

  const event = { senderFrame: { url: "file:///C:/synthetic-review-root/index.html", parent: null }, sender: null };

  // 只替换端口 IO 与 flash 主体；Flasher 的编排/取消逻辑仍是真实实现
  const saved = {
    openPort: Ws63Flasher.prototype.openPort,
    flash: Ws63Flasher.prototype.flash,
    closePort: Ws63Flasher.prototype.closePort,
  };
  let openAttempts = 0;
  let flashCalls = 0;
  Ws63Flasher.prototype.openPort = async () => {
    openAttempts += 1;
  };
  Ws63Flasher.prototype.flash = async function () {
    flashCalls += 1;
    throw new Error("synthetic review exit");
  };
  Ws63Flasher.prototype.closePort = async () => {};

  const file = makeValidPackage();
  try {
    const starting = handler(event, "start_flash", {
      channel: "1",
      port: "COM93",
      filePath: file,
    });
    // 等它进入 pending（等 disconnectMonitor 完成）
    await sleep(50);
    const stopped = await handler(event, "stop_flash", { channel: "1" });
    assert.equal(stopped.ok, true);

    occupied.finishClose(); // 让 pending 的 await 返回
    await assert.rejects(() => starting, /取消/);

    await sleep(50);
    assert.equal(openAttempts, 0, "取消后绝不能再去打开串口");
    assert.equal(flashCalls, 0, "取消后绝不能进入烧录");
  } finally {
    Object.assign(Ws63Flasher.prototype, saved);
    await monitor.abortAllMonitors();
    monitor.__setPortFactory(null);
    resetRegistry();
  }
});

test("R6: stop_flash 在空闲/已取消状态幂等，且不残留 running/pending", async () => {
  const { handler } = await getHandler();
  const monitor = monitorModule ?? (monitorModule = await import("../electron/serial/monitor.js"));
  const { resetRegistry } = await import("../electron/serial/ownership.js");
  resetRegistry();
  await monitor.abortAllMonitors();

  const event = { senderFrame: { url: "file:///C:/synthetic-review-root/index.html", parent: null }, sender: null };

  // 没有监听占用 → 直接进入 pending→running 的路径很短；这里断言 stop 后状态回到 idle
  const stopped = await handler(event, "stop_flash", {});
  assert.equal(stopped.ok, true);
  const state = await handler(event, "get_state", {});
  assert.equal(state.flashRunning, false);
  for (const ch of Object.values(state.channels)) {
    assert.equal(ch.running, false);
    assert.equal(ch.pending, false);
  }
  await monitor.abortAllMonitors();
});

/* ---------------------------------------------------------------- R7 CLI */

const CLI = path.join(appRoot, "scripts", "package-consistency.mjs");

function runCli(args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: appRoot });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws63-r7-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel.split("/").join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

test("R7: 无任何目标 → 用法错误 exit 2（旧实现 exit 0 且宣布“发布一致”）", () => {
  const r = runCli([]);
  assert.equal(r.status, 2, `应 exit 2，实际 ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /用法/);
});

test("R7: 指定的便携版不存在 → 必须失败（旧实现 ok:true）", async () => {
  const { computeManifest } = await import("../scripts/lib/manifest.mjs");
  const src = makeTree({ "package.json": JSON.stringify({ name: "x", version: "1.1.4", main: "a.js" }), "a.js": "1" });
  const manifestPath = path.join(src, "m.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(computeManifest({ root: src, version: "1.1.4", builtAt: "2026-01-01T00:00:00.000Z" })),
  );
  const r = runCli([`--manifest=${manifestPath}`, "--portable=does-not-exist.exe", "--json"]);
  assert.equal(r.status, 1, `应 exit 1，实际 ${r.status}`);
  const json = JSON.parse(r.stdout);
  assert.equal(json.ok, false);
  assert.equal(json.fullReleaseVerified, false);
  assert.equal(json.coverage, "partial");
  assert.equal(json.portable.missing, true);
});

test("R7: 便携版可离线展开并与清单逐文件核对（成功路径 + 摘要不符失败路径）", async () => {
  const asar = (await import("@electron/asar")).default;
  const { computeManifest } = await import("../scripts/lib/manifest.mjs");

  const files = {
    "package.json": JSON.stringify({ name: "ws63-burn-pro", version: "9.9.9", main: "electron/main.js" }),
    "electron/main.js": "export const x = 1;\n",
    "dist/index.html": "<html></html>",
  };
  const src = makeTree(files);
  const manifest = computeManifest({ root: src, version: "9.9.9", builtAt: "2026-01-01T00:00:00.000Z" });
  const manifestPath = path.join(src, "build-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  // 1) 造一个"目录版"与一个可被 7zip 展开的"便携版"
  const appDir = makeTree(files);
  const asarPath = path.join(appDir, "app.asar");
  await asar.createPackage(appDir, asarPath);

  const targetDir = path.join(appDir, "win-unpacked", "resources");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(asarPath, path.join(targetDir, "app.asar"));

  const portableRoot = makeTree({});
  fs.mkdirSync(path.join(portableRoot, "resources"), { recursive: true });
  fs.copyFileSync(asarPath, path.join(portableRoot, "resources", "app.asar"));
  const portableExe = path.join(portableRoot, "Fake-Portable.exe");
  const sevenZip = path.join(appRoot, "node_modules", "7zip-bin", "win", "x64", "7za.exe");
  const zipped = spawnSync(sevenZip, ["a", "-t7z", portableExe, "resources/app.asar"], {
    cwd: portableRoot,
    encoding: "utf8",
  });
  assert.equal(zipped.status, 0, `7zip 打包失败：${zipped.stderr}`);

  const ok = runCli([
    `--manifest=${manifestPath}`,
    `--target=dist=${path.join(appDir, "win-unpacked")}`,
    `--portable=${portableExe}`,
    "--json",
  ]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const okJson = JSON.parse(ok.stdout);
  assert.equal(okJson.ok, true);
  assert.equal(okJson.portableChecked, true, "必须真的展开了便携版");
  assert.equal(okJson.portable.contentChecked, true);
  assert.equal(okJson.fullReleaseVerified, true);
  assert.equal(okJson.coverage, "all");

  // 2) 让便携版内容与清单不一致（改一个字节）→ 必须失败
  const tampered = Buffer.from(fs.readFileSync(path.join(portableRoot, "resources", "app.asar")));
  tampered[tampered.length - 1] ^= 0xff;
  fs.writeFileSync(path.join(portableRoot, "resources", "app.asar"), tampered);
  const portable2 = path.join(portableRoot, "Fake-Portable-2.exe");
  spawnSync(sevenZip, ["a", "-t7z", portable2, "resources/app.asar"], {
    cwd: portableRoot,
    encoding: "utf8",
  });
  const bad = runCli([`--manifest=${manifestPath}`, `--portable=${portable2}`, "--json"]);
  assert.equal(bad.status, 1, "摘要不符必须 exit 1");
  const badJson = JSON.parse(bad.stdout);
  assert.equal(badJson.portable.ok, false);
  assert.equal(badJson.fullReleaseVerified, false);
});

test("R7: 只给部分目标时明确标注“部分目标已核对”，不宣称全部一致", async () => {
  const asar = (await import("@electron/asar")).default;
  const { computeManifest } = await import("../scripts/lib/manifest.mjs");
  const files = {
    "package.json": JSON.stringify({ name: "ws63-burn-pro", version: "1.1.4", main: "electron/main.js" }),
    "electron/main.js": "export const x = 1;\\n",
  };
  const src = makeTree(files);
  const manifestPath = path.join(src, "m.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(computeManifest({ root: src, version: "1.1.4", builtAt: "2026-01-01T00:00:00.000Z" })),
  );
  const asarPath = path.join(src, "app.asar");
  await asar.createPackage(src, asarPath);
  const dist = makeTree(files);
  fs.mkdirSync(path.join(dist, "win-unpacked", "resources"), { recursive: true });
  fs.copyFileSync(asarPath, path.join(dist, "win-unpacked", "resources", "app.asar"));

  const r = runCli([`--manifest=${manifestPath}`, `--target=dist=${path.join(dist, "win-unpacked")}`, "--json"]);
  const json = JSON.parse(r.stdout);
  assert.equal(json.portable, null);
  assert.equal(json.portableChecked, false);
  assert.equal(json.fullReleaseVerified, false, "没核对便携版就不能说全部一致");
  assert.equal(json.coverage, "partial");
});
