import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { applyRuntimeOptions, computeRuntimeOptions } from "./runtime-options.js";
import * as gate from "./app-gate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// W08：GPU/heap/sandbox 改为可诊断、可回退的开关（默认 auto）
const runtime = computeRuntimeOptions({ env: process.env, argv: process.argv.slice(1) });
const runtimeSummary = applyRuntimeOptions(app, runtime);
const DEV_URL = "http://127.0.0.1:5173";

if (!isDev) {
  process.chdir(path.dirname(process.execPath));
}

let mainWindow = null;
let windowShown = false;
let quitting = false;
/** W29-09：后端 IPC 就绪 promise，任何调用都先等它，不再靠固定延时猜测。 */
let backendReady = null;
let backendError = null;
/** 启动各里程碑（用于日志与性能测量）。 */
const bootMarks = { processStart: Date.now() };

function markBoot(name, extra = "") {
  bootMarks[name] = Date.now();
  const line = `[ws63] boot ${name} at +${bootMarks[name] - bootMarks.processStart}ms${extra ? ` ${extra}` : ""}`;
  console.log(line);
}

export function getBootMarks() {
  return { ...bootMarks };
}

function resolveDistDir() {
  const candidates = [
    path.join(__dirname, "../dist"),
    path.join(process.resourcesPath, "dist"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return path.join(__dirname, "../dist");
}

function resolvePreloadPath() {
  const names = ["preload.cjs", "preload.js"];
  const bases = [__dirname];
  if (!isDev && process.resourcesPath) {
    bases.push(
      path.join(process.resourcesPath, "app.asar.unpacked", "electron"),
      path.join(process.resourcesPath, "electron"),
    );
  }
  for (const base of bases) {
    for (const name of names) {
      const p = path.join(base, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return path.join(__dirname, "preload.cjs");
}

function showMainWindow(reason = "") {
  if (windowShown || !mainWindow || mainWindow.isDestroyed()) return;
  windowShown = true;
  markBoot("windowShown", reason ? `(${reason})` : "");
  // WS63_NO_SHOW=1：仅用于"不抢焦点"的启动测量（后台就绪时间）。
  // 正常启动不设置该变量，行为与之前完全一致。
  if (process.env.WS63_NO_SHOW === "1") {
    markBoot("showSkippedByEnv");
    return;
  }
  mainWindow.show();
  mainWindow.focus();
  // W29-09：不再在 UI 首次枚举之外再做一次并行枚举（去重在 monitor.listPorts 内）
  setTimeout(() => {
    void import("./serial/monitor.js")
      .then((m) => m.warmPortEnumeration?.())
      .catch(() => {});
  }, 700);
}

/**
 * W29-14：导航白名单收紧到**实际加载的 index.html**（及其目录内的资源），
 * 不再是任意 file://。dev 下限定精确 origin。
 */
let allowedFileRoot = "";
function computeAllowedFileRoot() {
  if (isDev) return "";
  const distDir = resolveDistDir();
  allowedFileRoot = path.resolve(distDir);
  return allowedFileRoot;
}

function isAllowedNavigation(url) {
  const raw = String(url ?? "");
  if (isDev) {
    // 精确 origin，不允许 ev il.example 之类前缀混淆
    try {
      const u = new URL(raw);
      return u.origin === DEV_URL && u.protocol === "http:";
    } catch {
      return false;
    }
  }
  if (!raw.toLowerCase().startsWith("file://")) return false;
  try {
    const u = new URL(raw);
    const target = path.resolve(decodeURIComponent(u.pathname.replace(/^\//, "")));
    const root = allowedFileRoot || computeAllowedFileRoot();
    const rel = path.relative(root, target);
    // 必须是 index.html 本身或其目录内资源，不能越出 dist 目录
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: "WS63 烧录工作站 Pro",
    backgroundColor: "#d9e4f2",
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: runtime.sandbox,
      spellcheck: false,
      backgroundThrottling: false,
      enableWebSQL: false,
      v8CacheOptions: "code",
      webviewTag: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  wc.on("will-attach-webview", (event) => event.preventDefault());

  mainWindow.once("ready-to-show", () => {
    markBoot("readyToShow");
    // W29-09：兜底从 4500ms 降到 1500ms，且只作为“前端没发 ui-ready”的保险；
    // 正常路径由前端 ui-ready 立即触发，不再把隐藏窗口的等待当成性能优化。
    setTimeout(() => showMainWindow("ready-to-show fallback"), 1500);
  });
  mainWindow.webContents.once("did-finish-load", () => markBoot("didFinishLoad"));
}

function loadApp() {
  if (!mainWindow) return;
  if (isDev) {
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(path.join(resolveDistDir(), "index.html"));
  }
}

/**
 * W29-09：先同步注册一个“后端尚未就绪”的占位 handler，随后替换为真实 handler。
 * 这样 renderer 在启动早期调用 IPC 不会撞到“No handler registered”的窗口。
 *
 * 注意：Electron 的 `ipcMain.handle` 对同一 channel **不允许注册两次**，
 * 因此真实注册前必须先 removeHandler（两者在同一个同步块内完成，不存在可观察的空窗）。
 */
function installBackendPlaceholder() {
  ipcMain.removeHandler?.("ws63:call");
  ipcMain.handle("ws63:call", async () => {
    await (backendReady ?? Promise.resolve()).catch(() => {});
    if (backendError) throw new Error(backendError);
    throw new Error("后端尚未就绪，请稍后重试");
  });
}

async function bootBackend() {
  installBackendPlaceholder();
  backendReady = (async () => {
    const ipc = await import("./burn/ipc.js");
    // 占位 handler 必须显式移除，否则 ipcMain.handle 会因重复注册抛错
    ipcMain.removeHandler?.("ws63:call");
    ipc.registerBurnIpc(ipcMain);
    ipc.setWindow(mainWindow);
    ipc.setBootMarksProvider?.(getBootMarks);
    // W29-14：把实际加载目录告诉 IPC 守卫（dev 下是 origin 校验，这里只对生产生效）
    if (!isDev) ipc.setTrustedPageRoot?.(computeAllowedFileRoot());
    markBoot("backendReady");
    setTimeout(() => {
      void import("./ota/updater.js").then((ota) => ota.maybeAutoCheck());
    }, 12000);
    return true;
  })().catch((err) => {
    backendError = err instanceof Error ? err.message : String(err);
    markBoot("backendError", backendError);
    throw err;
  });
  return backendReady;
}

ipcMain.on("ws63:ui-ready", () => {
  showMainWindow("ui-ready");
});

/** 退出：先停任务、等资源收尾，再真正退出（不发起异步清理后立刻终止进程）。 */
async function gracefulQuit(reason) {
  if (quitting) return;
  quitting = true;
  try {
    const ipc = await import("./burn/ipc.js");
    const monitor = await import("./serial/monitor.js");
    ipc.abortAllFlashJobs?.();
    await monitor.abortAllMonitors?.();
    await ipc.stopAllTasks?.({ reason });
    await gate.waitIdle({ timeoutMs: 8000 });
  } catch {
    /* ignore */
  }
  app.quit();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      windowShown = false;
      createWindow();
      void bootBackend();
      loadApp();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    mainWindow.moveTop();
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
    }, 300);
  });

  app.whenReady().then(async () => {
    // 运行时决策写进日志，便于现场诊断“为什么黑屏/为什么没加速”
    console.log(`[ws63] runtime: ${JSON.stringify(runtimeSummary)}`);
    createWindow();
    void bootBackend();
    loadApp();
    void import("./ota/updater.js")
      .then((ota) => ota.markBootHealthy?.())
      .catch(() => {});
  });

  app.on("before-quit", (event) => {
    // 第一次：拦下退出，先停任务并等待资源收尾；收尾完成后 app.quit() 会再次进入这里并放行。
    if (quitting) return;
    event.preventDefault();
    void gracefulQuit("应用退出");
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

export { mainWindow, runtimeSummary };
