import { app, net } from "electron";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

import { assertIdle, getBusyState, whenIdle } from "../app-gate.js";
import { DownloadCancelledError, downloadToFile } from "./download.js";
import {
  APP_PACKAGE_NAME,
  EXE_NAME,
  OtaPolicyError,
  classifyAssetName,
  compareSemver,
  describeSignature,
  findPackageRoot,
  normalizeVersion,
  pickAsset,
  resolveInstallMode,
  sanitizeAssetFileName,
  verifyStagedPackage,
} from "./policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DOWNLOAD_DEADLINE_MS = 10 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 90000;

/** @typedef {{ owner: string, repo: string, assetName: string, autoCheck: boolean, token: string, requireSignature: boolean }} OtaConfig */

/**
 * 内部状态。
 * 注意（W05）：assetName / assetType / downloadPath 是**内部事实**，
 * 在 getStatus() 的公开投影里隐藏，但不允许被清空——旧实现把 assetName 设成 ""，
 * 导致下载落到 update.bin 并被安装阶段拒绝。
 * @typedef {{
 *  currentVersion: string, config: OtaConfig,
 *  status: 'idle'|'checking'|'available'|'up_to_date'|'downloading'|'ready'|'error',
 *  latestVersion: string, releaseName: string, assetName: string, assetType: 'zip'|'installer'|'unknown',
 *  assetSize: number, assetApiUrl: string, assetBrowserUrl: string, downloadPath: string,
 *  progress: number, message: string, packaged: boolean, installQueued: boolean, installPlanMode: string,
 * }} OtaState */

/** @type {OtaState} */
let state = createInitialState();
let mainWindow = null;
/** @type {AbortController|null} */
let downloadAbort = null;
let cancelInstallQueued = null;

function createInitialState() {
  const config = loadConfig();
  return {
    currentVersion: app.getVersion(),
    config,
    status: "idle",
    latestVersion: "",
    releaseName: "",
    assetName: "",
    assetType: "unknown",
    assetSize: 0,
    assetApiUrl: "",
    assetBrowserUrl: "",
    downloadPath: "",
    progress: 0,
    message: "",
    packaged: app.isPackaged,
    installQueued: false,
    installPlanMode: "",
  };
}

function configPath() {
  return path.join(app.getPath("userData"), "ota-config.json");
}

function healthPath() {
  return path.join(app.getPath("userData"), "boot-health.json");
}

function readDefaultConfig() {
  const p = path.join(__dirname, "default-config.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {
      owner: "",
      repo: "",
      assetName: "WS63BurnPro-win-x64.zip",
      autoCheck: true,
      token: "",
      requireSignature: false,
    };
  }
}

export function loadConfig() {
  const defaults = readDefaultConfig();
  try {
    if (fs.existsSync(configPath())) {
      const saved = JSON.parse(fs.readFileSync(configPath(), "utf8"));
      return {
        owner: String(saved.owner ?? defaults.owner ?? "").trim(),
        repo: String(saved.repo ?? defaults.repo ?? "").trim(),
        assetName: String(saved.assetName ?? defaults.assetName ?? "WS63BurnPro-win-x64.zip").trim(),
        autoCheck: saved.autoCheck !== false,
        token: String(saved.token ?? "").trim(),
        requireSignature: saved.requireSignature === true,
      };
    }
  } catch {
    /* use defaults */
  }
  return { ...defaults, token: "" };
}

export function saveConfig(partial = {}) {
  const prev = loadConfig();
  const next = { ...prev };
  if (typeof partial.owner === "string") next.owner = partial.owner.trim();
  if (typeof partial.repo === "string") next.repo = partial.repo.trim();
  if (typeof partial.assetName === "string") {
    next.assetName = partial.assetName.trim() || "WS63BurnPro-win-x64.zip";
  }
  if (typeof partial.autoCheck === "boolean") next.autoCheck = partial.autoCheck;
  if (typeof partial.requireSignature === "boolean") {
    next.requireSignature = partial.requireSignature;
  }
  if (partial.clearToken) next.token = "";
  else if (typeof partial.token === "string" && partial.token.trim()) {
    next.token = partial.token.trim();
  }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf8");
  state.config = next;
  return getPublicConfig();
}

function getPublicConfig() {
  // 公开投影：不暴露 owner/repo/assetName/token 明文
  return {
    owner: "",
    repo: "",
    assetName: "",
    autoCheck: state.config.autoCheck !== false,
    hasToken: Boolean(state.config.token),
    requireSignature: state.config.requireSignature === true,
    ready: Boolean(state.config.owner && state.config.repo),
  };
}

export function setWindow(win) {
  mainWindow = win;
}

function emit(patch = {}) {
  Object.assign(state, patch);
  try {
    mainWindow?.webContents.send("ws63:event", {
      type: "ota_state",
      ...getStatus(),
    });
  } catch {
    /* window gone */
  }
}

/** 对外投影：隐藏内部资源名/下载路径/发布地址，但**不清空内部事实**。 */
export function getStatus() {
  return {
    currentVersion: state.currentVersion,
    config: getPublicConfig(),
    status: state.status,
    latestVersion: state.latestVersion,
    releaseName: state.releaseName,
    releaseNotes: "",
    releaseUrl: "",
    assetName: "",
    assetSize: state.assetSize,
    downloadPath: "",
    progress: state.progress,
    message: state.message,
    packaged: state.packaged,
    installQueued: state.installQueued,
    busyBlocked: getBusyState().busy,
  };
}

/** 仅供测试/诊断：内部状态快照（不经过公开投影）。 */
export function _internalState() {
  return { ...state };
}

function githubHeaders() {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": `WS63BurnPro/${app.getVersion()}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (state.config.token) {
    headers.Authorization = `Bearer ${state.config.token}`;
  }
  return headers;
}

async function githubJson(url) {
  const res = await net.fetch(url, { headers: githubHeaders() });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    const msg = data?.message || `GitHub API ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export async function checkForUpdates() {
  state.config = loadConfig();
  const { owner, repo } = state.config;
  if (!owner || !repo) {
    emit({ status: "error", message: "更新源未配置" });
    throw new Error("更新源未配置");
  }

  emit({ status: "checking", message: "正在检查更新…", progress: 0 });

  try {
    const release = await githubJson(
      `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
    );
    const latestVersion = normalizeVersion(release.tag_name || release.name || "");
    if (!latestVersion) throw new Error("未获取到有效版本号");

    const asset = pickAsset(release.assets, state.config.assetName);
    if (!asset?.browser_download_url) throw new Error("未找到可用的更新包");

    const classified = classifyAssetName(asset.name);
    if (classified.type === "unknown") {
      throw new OtaPolicyError("OTA_UNKNOWN_ASSET", "发布资源类型不受支持（需要 .zip 或 Setup.exe）");
    }

    const newer = compareSemver(latestVersion, state.currentVersion) > 0;
    // 内部保存已验证的资源名/类型（公开投影另行隐藏）
    emit({
      latestVersion,
      releaseName: release.name || latestVersion,
      assetName: classified.name,
      assetType: classified.type,
      assetSize: Number(asset.size || 0),
      assetApiUrl: asset.url || "",
      assetBrowserUrl: asset.browser_download_url,
      downloadPath: "",
      progress: 0,
      status: newer ? "available" : "up_to_date",
      message: newer
        ? `发现新版本 ${latestVersion}（${classified.type === "zip" ? "ZIP 更新包" : "安装程序"}）`
        : `已是最新版本（${state.currentVersion}）`,
    });

    return getStatus();
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message =
      raw
        .replace(/https?:\/\/\S+/gi, "")
        .replace(/\bgithub\.com\S*/gi, "")
        .trim() || "检查更新失败";
    emit({ status: "error", message });
    throw err;
  }
}

function otaTempDir() {
  return path.join(app.getPath("temp"), "ws63-burn-pro-ota");
}

export async function downloadUpdate() {
  if (state.status === "downloading") {
    throw new Error("正在下载中");
  }
  if (!state.latestVersion) {
    await checkForUpdates();
  }
  if (compareSemver(state.latestVersion, state.currentVersion) <= 0) {
    throw new Error("当前没有可下载的新版本");
  }
  if (!state.assetBrowserUrl && !state.assetApiUrl) {
    throw new Error("缺少下载地址，请先检查更新");
  }

  const url = state.config.token
    ? state.assetApiUrl || state.assetBrowserUrl
    : state.assetBrowserUrl || state.assetApiUrl;
  if (!url) throw new Error("缺少下载地址");

  if (!state.assetName || state.assetType === "unknown") {
    throw new OtaPolicyError("OTA_UNKNOWN_ASSET", "更新资源名未验证，拒绝下载");
  }

  downloadAbort = new AbortController();
  const tmpDir = otaTempDir();
  const safeName = sanitizeAssetFileName(state.assetName, `update.${state.assetType}`);
  const dest = path.join(tmpDir, safeName);

  emit({
    status: "downloading",
    message: `正在下载 ${safeName} ...`,
    progress: 0,
    downloadPath: "",
  });

  try {
    const result = await downloadToFile({
      fetchImpl: net.fetch,
      url,
      destPath: dest,
      headers: { ...githubHeaders(), Accept: "application/octet-stream" },
      signal: downloadAbort.signal,
      deadlineMs: DOWNLOAD_DEADLINE_MS,
      onProgress: (progress) => {
        emit({
          status: "downloading",
          progress,
          message: `正在下载 ${safeName}（${progress}%）`,
        });
      },
    });

    if (state.assetSize > 0 && result.size !== state.assetSize) {
      throw new Error(
        `下载大小与发布信息不符（${result.size} != ${state.assetSize}），已删除不完整文件`,
      );
    }

    state.downloadPath = result.path;
    emit({
      status: "ready",
      progress: 100,
      downloadPath: result.path,
      message: "下载完成，可以安装并重启",
    });
    return getStatus();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.downloadPath = "";
    emit({
      status: err instanceof DownloadCancelledError ? "available" : "error",
      message,
      progress: 0,
      downloadPath: "",
    });
    throw err;
  } finally {
    downloadAbort = null;
  }
}

function appInstallDir() {
  return path.dirname(process.execPath);
}

async function describeExeSignature(exePath) {
  return new Promise((resolve) => {
    try {
      const ps = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `$s = Get-AuthenticodeSignature -LiteralPath '${String(exePath).replace(/'/g, "''")}'; ` +
            `@{Status=[string]$s.Status; SignerCertificate=@{Subject=[string]$s.SignerCertificate.Subject}} | ConvertTo-Json -Compress`,
        ],
        { windowsHide: true },
      );
      let out = "";
      ps.stdout.on("data", (d) => {
        out += String(d);
      });
      ps.on("error", () => resolve(describeSignature(null)));
      ps.on("close", () => {
        try {
          resolve(describeSignature(JSON.parse(out.trim() || "{}")));
        } catch {
          resolve(describeSignature(null));
        }
      });
    } catch {
      resolve(describeSignature(null));
    }
  });
}

async function extractZip(zipPath, destDir) {
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const ps = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      { windowsHide: true },
    );
    let err = "";
    ps.stderr.on("data", (d) => {
      err += String(d);
    });
    ps.on("error", reject);
    ps.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err || `解压失败 (exit ${code})`));
    });
  });
}

/**
 * 应用脚本：等待旧进程退出 → 备份 → 复制 → 启动 → 健康确认 → 失败回滚。
 * 用 PowerShell 写，逻辑比批处理可读；脚本自身删除。
 */
function writeApplyScript({ appDir, srcDir, exePath, version, healthFile }) {
  const scriptPath = path.join(app.getPath("temp"), "ws63-burn-pro-apply-update.ps1");
  const bakDir = `${appDir}.bak-${Date.now()}`;
  const logFile = path.join(app.getPath("temp"), "ws63-burn-pro-update.log");
  const q = (s) => String(s).replace(/'/g, "''");
  const content = `$ErrorActionPreference = 'Stop'
$AppDir = '${q(appDir)}'
$Src = '${q(srcDir)}'
$Exe = '${q(exePath)}'
$Bak = '${q(bakDir)}'
$Health = '${q(healthFile)}'
$Log = '${q(logFile)}'
$ExpectedVersion = '${q(version)}'
function Log([string]$m) { Add-Content -LiteralPath $Log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8 }
Log "开始应用更新 -> $ExpectedVersion"
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Process -Name WS63BurnPro -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
Start-Sleep -Milliseconds 800
try {
  if (Test-Path -LiteralPath $Bak) { Remove-Item -LiteralPath $Bak -Recurse -Force }
  Copy-Item -LiteralPath $AppDir -Destination $Bak -Recurse -Force
  Log "已备份旧版本 -> $Bak"
  if (Test-Path -LiteralPath $Health) { Remove-Item -LiteralPath $Health -Force }
  robocopy $Src $AppDir /E /NFL /NDL /NJH /NJS /R:2 /W:1 | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "robocopy 失败 ($LASTEXITCODE)" }
  Log "已切换到新版本，等待首次启动健康确认"
  Start-Process -FilePath $Exe
  $healthDeadline = (Get-Date).AddSeconds(${Math.round(HEALTH_TIMEOUT_MS / 1000)})
  $healthy = $false
  while ((Get-Date) -lt $healthDeadline) {
    if (Test-Path -LiteralPath $Health) {
      try {
        $h = Get-Content -LiteralPath $Health -Raw | ConvertFrom-Json
        if ($h.ok -eq $true) { $healthy = $true; break }
      } catch { }
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $healthy) {
    Log "健康确认失败，回滚"
    Get-Process -Name WS63BurnPro -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    robocopy $Bak $AppDir /E /NFL /NDL /NJH /NJS /R:2 /W:1 | Out-Null
    Start-Process -FilePath $Exe
    Log "已回滚到旧版本"
  } else {
    Log "更新完成并通过健康确认"
    if (Test-Path -LiteralPath $Bak) { Remove-Item -LiteralPath $Bak -Recurse -Force -ErrorAction SilentlyContinue }
  }
} catch {
  Log ("更新失败: " + $_.Exception.Message)
  if (Test-Path -LiteralPath $Bak) {
    robocopy $Bak $AppDir /E /NFL /NDL /NJH /NJS /R:2 /W:1 | Out-Null
    Start-Process -FilePath $Exe
    Log "异常回滚完成"
  }
} finally {
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;
  fs.writeFileSync(scriptPath, content, "utf8");
  return scriptPath;
}

async function prepareZipInstall(file) {
  const extractDir = path.join(otaTempDir(), `staging-${Date.now()}`);
  emit({ message: "正在解压并校验更新包…", progress: 100 });
  await extractZip(file, extractDir);
  const root = findPackageRoot(extractDir);
  const verify = verifyStagedPackage({ root, expectedVersion: state.latestVersion });
  if (!verify.ok) {
    throw new OtaPolicyError(
      "OTA_PACKAGE_INVALID",
      `更新包校验未通过：${verify.problems.join("；")}`,
    );
  }
  const signature = await describeExeSignature(verify.exePath);
  if (state.config.requireSignature && !signature.signed) {
    throw new OtaPolicyError(
      "OTA_SIGNATURE_INVALID",
      "更新包签名无效（策略要求签名），已拒绝安装",
    );
  }
  return { root, verify, signature };
}

/**
 * 安装并重启。W06：烧录/串口任务运行期间必须阻止；
 * afterTasks=true 时改为“任务结束后安装”。
 * @param {{afterTasks?: boolean, dryRun?: boolean}} opts
 */
export async function installUpdateAndRestart(opts = {}) {
  const { afterTasks = false, dryRun = false } = opts;
  const guarded = getBusyState();
  if (guarded.busy) {
    if (!afterTasks) {
      // 明确告诉 UI 被阻止的原因
      emit({ installQueued: false });
      throw new Error(
        `烧录/串口任务运行中，暂不安装更新（${guarded.reasons.join("；") || "任务进行中"}）。可选择“任务结束后安装”。`,
      );
    }
    if (cancelInstallQueued) cancelInstallQueued();
    state.installQueued = true;
    emit({ installQueued: true, message: "已排队：当前任务结束后自动安装更新" });
    cancelInstallQueued = whenIdle(() => {
      cancelInstallQueued = null;
      state.installQueued = false;
      void installUpdateAndRestart({ dryRun }).catch((err) => {
        emit({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
          installQueued: false,
        });
      });
    }, "任务结束后安装更新");
    return { ok: true, queued: true };
  }

  const plan = resolveInstallMode({
    assetType: state.assetType,
    downloadPath: state.downloadPath,
    packaged: app.isPackaged,
  });
  if (state.status !== "ready" || !state.downloadPath || !fs.existsSync(state.downloadPath)) {
    throw new OtaPolicyError("OTA_NOT_DOWNLOADED", "请先下载更新包");
  }
  state.installPlanMode = plan.mode;

  if (plan.mode === "installer") {
    // 安装程序同样做签名事实检查（策略要求签名时拒绝未签名安装包）
    const signature = await describeExeSignature(state.downloadPath);
    if (state.config.requireSignature && !signature.signed) {
      throw new OtaPolicyError(
        "OTA_SIGNATURE_INVALID",
        "安装程序签名无效（策略要求签名），已拒绝安装",
      );
    }
    if (dryRun) return { ok: true, mode: "installer", dryRun: true, signature };
    emit({ status: "ready", message: "正在启动安装程序..." });
    spawn(state.downloadPath, [], { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => app.quit(), 500);
    return { ok: true, mode: "installer", signature };
  }

  const { root, verify, signature } = await prepareZipInstall(state.downloadPath);
  if (dryRun) {
    return {
      ok: true,
      mode: "zip",
      dryRun: true,
      root,
      version: verify.version,
      product: verify.name,
      signature,
    };
  }

  const appDir = appInstallDir();
  const exePath = path.join(appDir, EXE_NAME);
  const script = writeApplyScript({
    appDir,
    srcDir: root,
    exePath,
    version: verify.version || state.latestVersion,
    healthFile: healthPath(),
  });

  spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();

  emit({ message: "即将退出并应用更新（失败会自动回滚）..." });
  setTimeout(() => app.quit(), 600);
  return { ok: true, mode: "zip", version: verify.version, signature };
}

/** 首次启动健康标记：由更新脚本在切换后检查，失败则自动回滚。 */
export function markBootHealthy() {
  if (!app.isPackaged) return;
  try {
    fs.mkdirSync(path.dirname(healthPath()), { recursive: true });
    fs.writeFileSync(
      healthPath(),
      JSON.stringify({ ok: true, version: app.getVersion(), ts: Date.now(), pid: process.pid }),
      "utf8",
    );
  } catch {
    /* ignore */
  }
}

export async function openReleasePage() {
  return { ok: false };
}

export function cancelDownload() {
  try {
    downloadAbort?.abort();
  } catch {
    /* ignore */
  }
  downloadAbort = null;
  emit({
    status: state.latestVersion ? "available" : "idle",
    message: "已取消下载",
    progress: 0,
    downloadPath: "",
  });
  return getStatus();
}

export async function maybeAutoCheck() {
  state.config = loadConfig();
  if (!app.isPackaged) return null;
  if (!state.config.autoCheck) return null;
  if (!state.config.owner || !state.config.repo) return null;
  try {
    return await checkForUpdates();
  } catch {
    return null;
  }
}

export { assertIdle, APP_PACKAGE_NAME };
