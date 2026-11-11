import { app, dialog } from "electron";
import fs from "fs";
import os from "os";
import path from "path";
import { describeFwpkg } from "../burn/fwpkg.js";
import {
  ACK_POLICY,
  ACK_POLICY_LABEL,
  DEFAULT_ACK_POLICY,
  FLASH_STAGES,
  FlashError,
  Ws63Flasher,
} from "../burn/ws63flash.js";
import {
  issueFirmwareToken,
  pinFirmwareToken,
  resolveFirmware as resolveFirmwareEntry,
  unpinFirmwareToken,
} from "./firmware-registry.js";
import { classifyFlashError, classifyFlashResult } from "./flash-outcome.js";
import { openImmutableFwpkgSnapshot } from "./stable-snapshot.js";
import { settlePortClose } from "../serial/port-lifecycle.js";
import {
  buildDiagnosticReport,
  serializeDiagnosticReport,
  suggestDiagnosticFileName,
} from "../diagnostics.js";
import { readBuildInfo } from "../build-info.js";
import { FLASH_CHANNEL_IDS, FLASH_CHANNELS } from "./channels.js";
import * as gate from "../app-gate.js";
import * as guard from "../ipc-guard.js";
import {
  OWNER_KIND,
  PortBusyError,
  holderOf,
  normalizePort,
  releasePort,
  reservePort,
  snapshot as ownerSnapshot,
  transferPort,
} from "../serial/ownership.js";
import {
  adoptMonitor,
  closeMonitorForTakeover,
  connectMonitor,
  disconnectMonitor,
  getQuarantinedPorts,
  getMonitorSnapshot,
  listPorts,
  portUsedByMonitor,
  sendMonitor,
} from "../serial/monitor.js";
import * as ota from "../ota/updater.js";
export { FLASH_CHANNELS };

const logs = [];
const MAX_LOGS = 400;
const PROGRESS_EMIT_MS = 100;
/** @type {Map<string, number>} */
const lastProgressEmit = new Map();

/**
 * @type {Map<string, {
 *   abort: AbortController|null, running: boolean, pending: boolean, port: string, progress: number,
 *   partName: string, stage: string, stageLabel: string, status: string, errorMessage: string,
 *   result: any, generation: number,
 * }>}
 */
const flashJobs = new Map();

/** 每通道的世代号：迟到的回调不得修改/释放新任务的状态（W29-03/W29-05）。 */
let jobGeneration = 0;

let mainWindow = null;
/** 启动里程碑提供者（由 main.js 注入，用于诊断导出）。 */
let bootMarksProvider = null;
/** 实际加载页面的目录（生产 = dist 绝对路径），用于精确的 IPC 来源校验。 */
let trustedPageRoot = "";

export function setTrustedPageRoot(dir) {
  trustedPageRoot = typeof dir === "string" ? dir : "";
}

export function getTrustedPageRoot() {
  return trustedPageRoot;
}

export function setBootMarksProvider(fn) {
  bootMarksProvider = typeof fn === "function" ? fn : null;
}

function mainBootMarks() {
  try {
    return bootMarksProvider?.() ?? {};
  } catch {
    return {};
  }
}

export function setWindow(win) {
  mainWindow = win;
  ota.setWindow(win);
}

function channelLabel(channel) {
  return FLASH_CHANNELS[channel]?.label ?? channel;
}

function isAnyFlashRunning() {
  for (const job of flashJobs.values()) {
    if (job.running || job.pending) return true;
  }
  return false;
}

function getChannelState(channel) {
  const job = flashJobs.get(channel);
  return {
    /**
     * 任务代际（**主进程权威分配**）。
     *
     * 前端必须按通道消费它：上一轮的事件如果在下一轮开始之后才到达，
     * 其 generation 更小，必须被丢弃，不能覆盖新任务的状态。
     * 每轮四个动作（启动/重试/停止/失败）都带同一个代际，事件先于 IPC 响应到达也按代际取舍。
     */
    generation: job?.generation ?? 0,
    running: Boolean(job?.running),
    pending: Boolean(job?.pending),
    port: job?.port ?? "",
    progress: job?.progress ?? 0,
    partName: job?.partName ?? "",
    stage: job?.stage ?? "",
    stageLabel: job?.stageLabel ?? "",
    status: job?.status ?? "idle",
    errorMessage: job?.errorMessage ?? "",
    transferComplete: job?.result?.transferComplete ?? false,
    protocolConfirmed: job?.result?.protocolConfirmed ?? false,
    bootVerified: Boolean(job?.result?.bootVerified),
    // 证据边界：本轮应答判定策略与其未验证事项，UI 如实展示
    ackPolicy: job?.result?.ackPolicy ?? "",
    ackPolicyLabel: job?.result?.ackPolicyLabel ?? "",
    /** 控制线策略：默认 none 表示从未调用 set()，即没有拨动 RTS/DTR */
    portLines: job?.result?.portLines?.mode ?? "",
    handshakeAttempts: job?.result?.handshake?.attempts ?? 0,
    handshakeRxBytes: job?.result?.handshake?.rxBytes ?? 0,
    retryCount: job?.retryCount ?? 0,
  };
}

/** 取某通道当前代际（事件统一带上，供前端过滤）。 */
function channelGeneration(channel) {
  return flashJobs.get(channel)?.generation ?? 0;
}

function getFlashSnapshot() {
  const channels = {};
  for (const id of Object.keys(FLASH_CHANNELS)) {
    channels[id] = getChannelState(id);
  }
  return { channels, flashRunning: isAnyFlashRunning() };
}

function portUsedByFlash(port, exceptChannel = null) {
  const target = normalizePort(port);
  for (const [ch, job] of flashJobs) {
    if (ch === exceptChannel) continue;
    if (job.running && normalizePort(job.port) === target) return channelLabel(ch);
  }
  return null;
}

function formatClock(ts) {
  const d = new Date(ts || Date.now());
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function levelLabel(level) {
  switch (level) {
    case "serial":
      return "串口";
    case "send":
      return "发送";
    case "success":
      return "成功";
    case "error":
      return "错误";
    default:
      return "信息";
  }
}

function formatLogLine(entry) {
  const time = formatClock(entry.ts);
  const level = levelLabel(entry.level);
  const body = String(entry.message ?? "")
    .replace(/\r/g, "")
    .replace(/^\[[^\]]*设备[^\]]*\]\s*/u, "")
    .replace(/^>>>\s*/, "");
  const ch = entry.channel ? channelLabel(entry.channel) : "";
  if (ch) return `[${time}] [${ch}] [${level}] ${body}\n`;
  return `[${time}] [${level}] ${body}\n`;
}

function pushLog(message, level = "info", channel = null) {
  const normalized = String(message ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const lines = normalized.split("\n").filter((line) => line.length > 0);
  if (!lines.length) return;

  const ts = Date.now();
  for (const line of lines) {
    const entry = { message: line, level, ts, channel };
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    const text = formatLogLine(entry);
    emit({ type: "log", ...entry, text });
  }
}

function emit(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("ws63:event", event);
  } catch {
    /* window gone mid-send */
  }
}

function updateJob(channel, patch) {
  const prev = flashJobs.get(channel) ?? {
    abort: null,
    running: false,
    port: "",
    progress: 0,
    partName: "",
    stage: "",
    stageLabel: "",
    status: "idle",
    errorMessage: "",
    result: null,
  };
  flashJobs.set(channel, { ...prev, ...patch });
}

// --------------------------------------------------------------- 固件令牌/策略

/**
 * renderer 只能提供“路径（按策略校验）”或“能力令牌”；两者都要重新做完整校验与摘要绑定。
 * 路径与令牌同时存在时必须指向同一文件（否则就是“界面显示 B、实际烧 A”）。
 * 具体仲裁在 firmware-registry.js（可独立单测，不依赖 electron）。
 */
function resolveFirmware(params, label = "固件") {
  return resolveFirmwareEntry(params, { label });
}

// ------------------------------------------------------------------ 烧录任务

/**
 * 创建烧录器。
 *
 * **关键（Codex 复审）**：`generation` 必须由调用方按"这个任务自己的代际"传入并**捕获**，
 * 事件里带的是捕获值。绝不能在 emit 时读 `channelGeneration(channel)` —— 那样一个旧 flasher
 * 的迟到事件会被盖上新代际，冒充成新任务的事件。
 * 同时每个回调先做 `isCurrentGeneration(channel, generation)` 检查，非当前任务不得改 job。
 *
 * @param {string} channel
 * @param {AbortController} abort
 * @param {number} generation 本任务代际（捕获，不可变）
 */
function createFlasher(channel, abort, generation) {
  const isCurrent = () => isCurrentGeneration(channel, generation);
  return new Ws63Flasher({
    stopSignal: abort.signal,
    ackPolicy: DEFAULT_ACK_POLICY,
    emit: (ev) => {
      if (ev.type === "log") {
        pushLog(String(ev.message ?? ""), ev.level || "info", channel);
        return;
      }
      if (ev.type === "stage") {
        if (!isCurrent()) return; // 旧任务的迟到事件：不改状态、不发事件
        updateJob(channel, { stage: ev.stage, stageLabel: ev.label });
        emit({
          type: "flash_stage",
          generation,
          channel,
          stage: ev.stage,
          stageLabel: ev.label,
        });
        return;
      }
      if (ev.type === "handshake_progress") {
        if (!isCurrent()) return;
        // W29-02：把“正在等 RST / 已试几次 / 已等多久 / 收到多少字节”如实送到 UI
        emit({
          type: "handshake_progress",
          generation,
          channel,
          phase: ev.phase,
          attempts: ev.attempts,
          elapsedMs: ev.elapsedMs,
          rxBytes: ev.rxBytes,
          lastCode: ev.lastCode ?? "",
          resetTimeoutMs: ev.resetTimeoutMs ?? 0,
        });
        return;
      }
      if (ev.type === "progress") {
        if (!isCurrent()) return;
        const progress = Math.min(
          99,
          Math.round((ev.current / Math.max(ev.total, 1)) * 100),
        );
        const prev = flashJobs.get(channel)?.progress ?? 0;
        const next = Math.max(prev, progress);
        const partName = ev.name ?? "";
        updateJob(channel, { progress: next, partName });
        const now = Date.now();
        const last = lastProgressEmit.get(channel) ?? 0;
        if (next < 99 && now - last < PROGRESS_EMIT_MS) return;
        lastProgressEmit.set(channel, now);
        emit({ type: "progress", channel, generation, progress: next, partName });
      }
    },
  });
}

/**
 * 原子开始一个烧录任务：先在所有权注册表保留端口（同步），再 await 关闭冲突监听。
 * @returns {{token: string}}
 */
async function beginFlashJob(spec) {
  const { channel, port } = spec;
  if (flashJobs.get(channel)?.running || flashJobs.get(channel)?.pending) {
    throw new Error(`${channelLabel(channel)} 正在烧录中`);
  }
  const conflict = portUsedByFlash(port, channel);
  if (conflict) {
    throw new Error(`串口 ${port} 已被 ${conflict} 占用`);
  }

  // C4：先**确认旧监听句柄关闭**，再占端口/开串口。
  // 旧实现 reservePort 先把占用换成新 token，随后即便关闭未确认也继续 open ——
  // 结果是同一个 COM 上有两个打开句柄，而旧句柄已经没有任何可仲裁的占用。
  //
  // 注意顺序（R6）：接管关闭必须**在 pending 窗口内**做，先同步建立 generation + abort + pending，
  // 否则这段 await 期间 stop_flash 无处可取消，取消又会变成"停止返回成功、实际继续开串口"。
  const monitorOwner = holderOf(port);
  const hasMonitor =
    (monitorOwner && monitorOwner.kind === OWNER_KIND.MONITORING) ||
    Boolean(portUsedByMonitor(port, channel));

  // **同步**占位通道门禁（W29-05）+ **同步**建立任务身份与取消控制器（R6）。
  jobGeneration += 1;
  const generation = jobGeneration;
  const abort = new AbortController();
  updateJob(channel, {
    abort,
    pending: true,
    running: false,
    generation,
    retryCount: Number(spec.retryCount) || 0,
    port,
    progress: 0,
    partName: "",
    stage: "",
    stageLabel: "",
    status: "running",
    errorMessage: "",
    result: null,
  });

  let reserved = null;
  let takeoverToken = null;

  try {
    if (hasMonitor) {
      const takeover = await closeMonitorForTakeover(port, {});
      emit({ type: "serial_state", ...getMonitorSnapshot() });
      if (abort.signal.aborted || !isCurrentGeneration(channel, generation)) {
        throw new Error("烧录已取消");
      }
      if (!takeover.closed) {
        // 关闭未确认：让原 token 继续以 closing 占用（可能已隔离），绝不 open
        throw new Error(
          `串口 ${port} 的监听窗口关闭未确认，已保留占用并等待驱动确认；请拔插重试，未确认前不会打开该串口`,
        );
      }
      if (takeover.hadMonitor && takeover.channel) {
        pushLog(`已断开 ${channelLabel(takeover.channel)} 监听以开始烧录`, "info", channel);
      }
      // 复用原 token：所有权全程不断档（不签发新 token）
      if (takeover.token && transferPort(takeover.token, { channel, kind: OWNER_KIND.FLASHING })) {
        takeoverToken = takeover.token;
      }
    }

    if (abort.signal.aborted || !isCurrentGeneration(channel, generation)) {
      throw new Error("烧录已取消");
    }

    // 同步原子保留：失败即端口已被别人持有
    try {
      reserved = takeoverToken
        ? { token: takeoverToken, port, tookOver: null }
        : reservePort(port, { channel, kind: OWNER_KIND.FLASHING }, { allowTakeoverMonitoring: false });
    } catch (err) {
      if (err instanceof PortBusyError) {
        throw new Error(err.message);
      }
      throw err;
    }
  } catch (err) {
    // 接管失败/取消：把已经拿到手的 token 也按统一规则收尾，别把占用漏在 closing 上
    if (takeoverToken) {
      releasePort(takeoverToken);
      takeoverToken = null;
    }
    if (flashJobs.get(channel)?.generation === generation) {
      updateJob(channel, {
        abort: null,
        running: false,
        pending: false,
        status: "idle",
        errorMessage: abort.signal.aborted ? "" : err instanceof Error ? err.message : String(err),
      });
    }
    emit({ type: "flash_state", ...getFlashSnapshot() });
    gate.notifyActivityChanged();
    throw err;
  }

  // 保留成功后才 await；失败/取消时释放
  try {
    if (reserved.tookOver) {
      // 兼容分支：仅当仍然发生 monitoring 接管时才走到（正常路径已在上面处理）
      pushLog(
        `已断开 ${channelLabel(reserved.tookOver.channel)} 监听以开始烧录`,
        "info",
        channel,
      );
      const confirmed = await disconnectMonitor(reserved.tookOver.channel);
      emit({ type: "serial_state", ...getMonitorSnapshot() });
      if (confirmed === false) {
        throw new Error(
          `串口 ${port} 的监听关闭未确认，已保留占用；未确认前不会打开该串口（请拔插重试）`,
        );
      }
    }

    // 每个 await 之后都要校验：被取消或被新任务顶替 ⇒ 不得继续 open/write（R6）
    if (abort.signal.aborted || !isCurrentGeneration(channel, generation)) {
      throw new Error("烧录已取消");
    }

    updateJob(channel, {
      running: true,
      pending: false,
    });
    emit({ type: "flash_state", ...getFlashSnapshot() });

    const flasher = createFlasher(channel, abort, generation);
    void runFlashBody(flasher, channel, spec, abort, reserved.token, generation);
    return { token: reserved.token };
  } catch (err) {
    if (flashJobs.get(channel)?.generation === generation) {
      updateJob(channel, {
        abort: null,
        running: false,
        pending: false,
        status: "idle",
        errorMessage: abort.signal.aborted ? "" : err instanceof Error ? err.message : String(err),
      });
    }
    releasePort(reserved.token);
    emit({ type: "flash_state", ...getFlashSnapshot() });
    gate.notifyActivityChanged();
    throw err;
  }
}

/** 只有当前世代才有权改写该通道状态（迟到的错误/关闭回调不得污染新任务）。 */
function isCurrentGeneration(channel, generation) {
  const job = flashJobs.get(channel);
  if (!job) return true;
  if (generation === undefined || generation === null) return true;
  return job.generation === generation;
}

async function runFlashBody(flasher, channel, spec, abort, token, generation) {
  const { port, baudRate, snapshot, handoffMonitor, monitorBaud, firmwareToken } = spec;
  const current = () => isCurrentGeneration(channel, generation);
  let handedOff = false;
  let outcome = null;
  /** @type {{close: () => Promise<void>} | null} */
  let immutable = null;
  // R1：任务运行期间钉住令牌，容量淘汰不能删掉它
  if (firmwareToken) pinFirmwareToken(firmwareToken);
  try {
    // R6：开串口之前再校验一次取消，被取消的任务不得 open/write
    if (abort.signal.aborted) {
      throw new FlashError("STOPPED", FLASH_STAGES.PREPARE, "烧录已取消");
    }

    // R5 + Codex 复审：**先**完成固件验证与不可变快照，**再**占串口。
    // 大包复制期间不应该占用串口、也不应该让用户以为"该按 RST 了"却错过窗口。
    // 进度跨 IPC 需要节流（每 1 MiB 一块会刷爆 UI）。
    let lastEmit = 0;
    let lastPct = -1;
    immutable = await openImmutableFwpkgSnapshot(snapshot.path, {
      expectedSha256: snapshot.sha256,
      stopSignal: abort.signal,
      onProgress: (done, total) => {
        if (!current() || total <= 0) return;
        const pct = Math.min(2, Math.round((done / total) * 2));
        const now = Date.now();
        if (pct === lastPct && now - lastEmit < 250) return;
        lastPct = pct;
        lastEmit = now;
        emit({
          type: "progress",
          channel,
          generation,
          progress: pct,
          partName: "校验固件中…",
        });
      },
    });
    if (abort.signal.aborted) {
      throw new FlashError("STOPPED", FLASH_STAGES.PREPARE, "烧录已取消");
    }
    pushLog(`固件已验证并锁定快照 SHA256 ${immutable.sha256.slice(0, 16)}…`, "info", channel);

    await flasher.openPort(port, baudRate, { token, channel });
    if (abort.signal.aborted) {
      throw new FlashError("STOPPED", FLASH_STAGES.PREPARE, "烧录已取消");
    }
    const result = await flasher.flash(immutable);
    // W29-07：成功 = 传输完成 **且** 协议确认；任何“缺应答”都不得显示成功。
    const verdict = classifyFlashResult(result);
    outcome = verdict;
    if (current()) {
      updateJob(channel, {
        progress: verdict.outcome === "success" ? 100 : 0,
        status: verdict.status,
        errorMessage: verdict.ok ? "" : verdict.message,
        result: {
          ...result,
          transferComplete: verdict.transferComplete,
          protocolConfirmed: verdict.protocolConfirmed,
          bootVerified: verdict.bootVerified,
          outcome: verdict.outcome,
          ackPolicy: result?.ackPolicy ?? DEFAULT_ACK_POLICY,
          ackPolicyLabel: result?.ackPolicyLabel ?? ACK_POLICY_LABEL[DEFAULT_ACK_POLICY],
        },
      });
      emit({
        type: "progress",
        channel,
        generation,
        progress: verdict.ok ? 100 : 0,
      });
    }
    if (verdict.outcome === "partial") {
      pushLog(verdict.message, "error", channel);
    }

    if (handoffMonitor) {
      const livePort = flasher.releasePort();
      if (livePort) {
        // 所有权从“烧录”直接转成“监听”，同一 token 不断档
        transferPort(token, { channel, kind: OWNER_KIND.HANDOFF });
        try {
          await adoptMonitor(
            channel,
            livePort,
            port,
            monitorBaud,
            (line) => pushLog(line, "serial", channel),
            (err) => {
              // 串口错误/USB 断开：立即广播状态，而不是只写日志
              pushLog(String(err.message || err), "error", channel);
              emit({ type: "serial_state", ...getMonitorSnapshot() });
            },
            { token },
          );
          handedOff = true;
          pushLog(
            `烧录完成，已进入监听 ${port} @ ${monitorBaud}（请手动按 RST 查看启动日志）`,
            "success",
            channel,
          );
          emit({ type: "serial_state", ...getMonitorSnapshot() });
        } catch (handErr) {
          // 接管失败：显式关闭已转交的 livePort 并释放所有权
          releasePort(token);
          try {
            if (livePort.isOpen) livePort.close(() => {});
          } catch {
            /* ignore */
          }
          pushLog(
            `进入监听失败：${handErr instanceof Error ? handErr.message : String(handErr)}`,
            "error",
            channel,
          );
        }
      }
    }

    emit({
      type: "flash_done",
      channel,
      generation,
      // 结构化错误码：classifyFlashResult 已算出，之前没带出来
      code: verdict.code ?? "",
      ok: verdict.ok,
      outcome: verdict.outcome,
      handoff: handedOff,
      transferComplete: verdict.transferComplete,
      protocolConfirmed: verdict.protocolConfirmed,
      bootVerified: false, // 协议未定义启动确认，恒为未验证
      ackPolicy: result?.ackPolicy ?? DEFAULT_ACK_POLICY,
      ackPolicyLabel: result?.ackPolicyLabel ?? ACK_POLICY_LABEL[DEFAULT_ACK_POLICY],
      ackNotes: result?.ackNotes ?? [],
      message: verdict.ok ? "" : verdict.message,
      elapsedMs: result?.elapsedMs ?? 0,
    });
  } catch (err) {
    // W29-07：取消必须表现为 cancelled，且绝不能出现“成功”
    const verdict = classifyFlashError(err, { stage: err instanceof FlashError ? err.stage : "" });
    outcome = verdict;
    if (current()) {
      updateJob(channel, {
        progress: 0,
        status: verdict.status,
        errorMessage: verdict.cancelled ? "" : verdict.message,
        stage: verdict.stage,
        result: {
          transferComplete: false,
          protocolConfirmed: false,
          bootVerified: false,
          outcome: verdict.outcome,
        },
      });
    }
    emit({
      type: "flash_done",
      channel,
      generation,
      // 取消/失败同样带结构化错误码（STOPPED/ABORTED/FWPKG_ABORTED/HANDSHAKE_TIMEOUT…）
      code: verdict.code ?? "",
      ok: false,
      outcome: verdict.outcome,
      message: verdict.message,
      stage: verdict.stage,
      handoff: false,
      cancelled: verdict.cancelled,
      transferComplete: false,
      protocolConfirmed: false,
      bootVerified: false,
    });
  } finally {
    // 不可变快照与令牌占用必须无条件收尾（即使中途抛错/取消）
    if (immutable) {
      await immutable.close().catch(() => {});
      immutable = null;
    }
    if (firmwareToken) unpinFirmwareToken(firmwareToken);
    if (!handedOff) {
      // 与 monitor 一致的收尾规则（Codex followup 3）：
      // 旧实现先 releasePort 再 closePort，且 closePort 忽略回调 err ——
      // 关闭未确认就释放所有权，等于允许别人立刻打开同一个 COM。
      const pendingOpen = Boolean(flasher.hasPendingOpen?.());
      const handle = flasher.detachForClose?.() ?? null;
      if (!handle) {
        releasePort(token);
      } else {
        transferPort(token, { channel, kind: OWNER_KIND.CLOSING });
        const settled = await settlePortClose({
          port: handle,
          token,
          release: releasePort,
          channel,
          path: handle.path ?? "",
          ms: 3000,
          // 打开未决（超时/回调报错但句柄可能仍开）时，isOpen===false 不能算"已确认关闭"
          pendingOpen,
          onResolved: (info) => {
            pushLog(`串口 ${info.path} 已在稍后确认关闭，占用已释放`, "info", channel);
            emit({ type: "flash_state", ...getFlashSnapshot() });
          },
        });
        if (!settled.closed) {
          pushLog(
            "串口关闭未确认，已保留占用并等待驱动确认（不会被重复打开）",
            "error",
            channel,
          );
        }
      }
    }
    // 只有当前世代才能清掉 running，迟到回调不得解锁新任务（W29-03）
    if (current()) {
      updateJob(channel, { running: false, pending: false, abort: null });
    }
    emit({ type: "flash_state", ...getFlashSnapshot() });
    gate.notifyActivityChanged();
  }
  return outcome ?? { ok: false, outcome: "failed" };
}

// ------------------------------------------------------------------ 门禁 probe

function registerGateProbe() {
  gate.registerBusyProbe(() => {
    const reasons = [];
    for (const [ch, job] of flashJobs) {
      if (job.running || job.pending) reasons.push(`${channelLabel(ch)} 正在烧录`);
    }
    const monitorSnapshot = getMonitorSnapshot();
    for (const [ch, info] of Object.entries(monitorSnapshot.serialChannels)) {
      if (info.connected) reasons.push(`${channelLabel(ch)} 串口监听中`);
    }
    for (const [port, owner] of Object.entries(ownerSnapshot())) {
      if (owner.kind === OWNER_KIND.MONITORING) continue; // 已在上面的监听列表中体现
      reasons.push(`串口 ${port} ${owner.kindLabel}`);
    }
    return { busy: reasons.length > 0, reasons };
  });
}

/** 退出/安装前主动收尾：停止烧录并断开监听。 */
export async function stopAllTasks({ reason = "应用退出" } = {}) {
  for (const id of Object.keys(FLASH_CHANNELS)) {
    flashJobs.get(id)?.abort?.abort();
  }
  await new Promise((r) => setTimeout(r, 50));
  try {
    await disconnectMonitor();
  } catch {
    /* ignore */
  }
  pushLog(`已停止全部任务（${reason}）`);
  gate.notifyActivityChanged();
  return gate.getBusyState();
}

let ipcRegistered = false;

export function registerBurnIpc(ipcMain) {
  if (ipcRegistered) return;
  ipcRegistered = true;
  registerGateProbe();

  ipcMain.handle("ws63:call", async (event, method, rawParams) => {
    guard.assertTrustedSender(event, {
      webContents: mainWindow?.webContents ?? null,
      isDev: !app.isPackaged,
      // W29-14：只信任实际加载的页面目录（由 main.js 注入）
      allowedFilePrefix: trustedPageRoot || "",
    });
    if (typeof method !== "string") {
      throw new guard.IpcError("IPC_BAD_PARAMS", "方法名必须是字符串");
    }
    const params = guard.assertPlainParams(rawParams);

    switch (method) {
      case "get_state":
        return {
          logs: logs.slice(-400).map((l) => formatLogLine(l)),
          ...getFlashSnapshot(),
          ...getMonitorSnapshot(),
          busy: gate.getBusyState(),
        };

      case "get_build_info":
        // W29-01：版本 + 运行路径 + 构建清单摘要，供 UI 显示“用户手里到底是哪个包”
        return readBuildInfo({
          packaged: app.isPackaged,
          appPath: app.getAppPath(),
          execPath: process.execPath,
          resourcesPath: process.resourcesPath ?? "",
        });

      case "get_ack_policy":
        return {
          policy: DEFAULT_ACK_POLICY,
          label: ACK_POLICY_LABEL[DEFAULT_ACK_POLICY],
          options: [ACK_POLICY.STRUCTURAL, ACK_POLICY.ECHO].map((id) => ({
            id,
            label: ACK_POLICY_LABEL[id],
            default: id === DEFAULT_ACK_POLICY,
          })),
          // 证据边界：echo 策略是未验证假设，默认不启用
          echoRequiresEvidence: true,
        };

      case "export_diagnostics": {
        // 用户已授权的功能：导出脱敏诊断包，保存路径由用户选择
        const buildInfo = readBuildInfo({
          packaged: app.isPackaged,
          appPath: app.getAppPath(),
          execPath: process.execPath,
          resourcesPath: process.resourcesPath ?? "",
        });
        // renderer 侧队列/丢弃统计：有界校验后进入报告（不信任渲染端数值）
        const bounded = (v, max) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) return 0;
          return Math.min(Math.floor(n), max);
        };
        const rendererStats = params?.renderer && typeof params.renderer === "object"
          ? {
              droppedLogParts: bounded(params.renderer.droppedLogParts, 1e6),
              pendingLogChars: bounded(params.renderer.pendingLogChars, 64 * 1024 * 1024),
              pendingLogBytes: bounded(params.renderer.pendingLogBytes, 64 * 1024 * 1024),
              queueParts: bounded(params.renderer.queueParts, 1e6),
              queueChars: bounded(params.renderer.queueChars, 64 * 1024 * 1024),
              queueBytes: bounded(params.renderer.queueBytes, 64 * 1024 * 1024),
            }
          : null;
        const report = buildDiagnosticReport({
          buildInfo,
          ...(rendererStats ? { renderer: rendererStats } : {}),
          flashSnapshot: getFlashSnapshot(),
          monitorSnapshot: getMonitorSnapshot(),
          busy: gate.getBusyState(),
          logs: logs.map((l) => formatLogLine(l)),
          ackPolicy: { policy: DEFAULT_ACK_POLICY, label: ACK_POLICY_LABEL[DEFAULT_ACK_POLICY] },
          portLines: { mode: process.env.WS63_PORT_LINES ?? "none" },
          bootMarks: mainBootMarks(),
          runtime: {
            platform: process.platform,
            arch: process.arch,
            electron: process.versions?.electron ?? "",
            node: process.versions?.node ?? "",
            quarantineCount: getQuarantinedPorts().length,
          },
        });
        const suggested = suggestDiagnosticFileName(report);
        if (params.auto === true) {
          // 仅测试/命令行用：不弹对话框，写到临时目录
          const target = path.join(os.tmpdir(), suggested);
          fs.writeFileSync(target, serializeDiagnosticReport(report), "utf8");
          return { ok: true, path: target, bytes: fs.statSync(target).size };
        }
        const picked = await dialog.showSaveDialog(mainWindow, {
          title: "导出诊断信息",
          defaultPath: suggested,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
        fs.writeFileSync(picked.filePath, serializeDiagnosticReport(report), "utf8");
        pushLog(`已导出诊断信息（已脱敏）到用户选择的路径`, "info");
        return { ok: true, path: picked.filePath, bytes: fs.statSync(picked.filePath).size };
      }

      case "retry_failed_channels": {
        // 用户已授权的功能：只重试用户明确选择的失败通道，一次点击只尝试一次
        const channels = Array.isArray(params.channels) ? params.channels : [];
        if (!channels.length) {
          throw new guard.IpcError("IPC_BAD_PARAMS", "请选择要重试的失败通道");
        }
        const baudRate = guard.requireBaud(params.baudRate, 921600);
        const handoffMonitor = guard.optionalBoolean(params.handoffMonitor, false);
        const startedChannels = [];
        const skipped = [];
        /** 每通道能力令牌：前端要保存，否则连续烧录/重试仍握着旧令牌 */
        const tokens = {};
        for (const cfg of channels) {
          const channel = guard.requireChannelId(cfg?.channel, FLASH_CHANNEL_IDS);
          const job = flashJobs.get(channel);
          // 只在"确实失败且空闲"的通道上重试；成功通道一律不动
          if (!job || job.status !== "error") {
            skipped.push({ channel, reason: "该通道不是失败状态，未重试" });
            continue;
          }
          if (job.running || job.pending) {
            skipped.push({ channel, reason: "该通道仍在运行" });
            continue;
          }
          try {
            const port = guard.requirePort(cfg?.port);
            // 重新校验固件（路径/令牌一致 + 内容摘要 + 新任务 identity）
            const { snapshot, token: firmwareToken } = resolveFirmware(
              cfg,
              `${channelLabel(channel)} 固件`,
            );
            const retryCount = (job.retryCount ?? 0) + 1;
            await beginFlashJob({
              channel,
              port,
              baudRate,
              snapshot,
              firmwareToken,
              handoffMonitor,
              monitorBaud: guard.requireBaud(cfg?.monitorBaud ?? params.monitorBaud, 115200),
              retryCount,
            });
            startedChannels.push(channel);
            tokens[channel] = firmwareToken;
            pushLog(`第 ${retryCount} 次重试启动（用户手动触发）`, "info", channel);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            skipped.push({ channel, reason });
            pushLog(`重试未启动：${reason}`, "error", channel);
          }
        }
        if (!startedChannels.length) {
          return { ok: false, started: [], skipped, tokens, generations: {}, reason: "没有可重试的通道" };
        }
        const generations = {};
        for (const ch of startedChannels) generations[ch] = channelGeneration(ch);
        return { ok: true, started: startedChannels, skipped, tokens, generations };
      }

      case "list_ports": {
        const ports = await listPorts();
        return { ports };
      }

      case "pick_firmware": {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: "选择 WS63 固件",
          filters: [
            { name: "FWPKG", extensions: ["fwpkg"] },
            { name: "All", extensions: ["*"] },
          ],
          properties: ["openFile"],
        });
        if (result.canceled || !result.filePaths.length) return { path: "", token: "" };
        const picked = guard.assertFirmwarePathPolicy(result.filePaths[0]);
        const { snapshot, token } = resolveFirmware({ filePath: picked });
        return {
          path: snapshot.path,
          token,
          size: snapshot.size,
          sha256: snapshot.sha256,
          lines: describeFwpkg(snapshot.meta),
        };
      }

      case "parse_firmware": {
        const { snapshot, token } = resolveFirmware(params);
        return {
          lines: describeFwpkg(snapshot.meta),
          meta: snapshot.meta,
          token,
          path: snapshot.path,
          size: snapshot.size,
          sha256: snapshot.sha256,
        };
      }

      case "start_flash": {
        const channel = guard.requireChannelId(params.channel, FLASH_CHANNEL_IDS);
        const port = guard.requirePort(params.port);
        const baudRate = guard.requireBaud(params.baudRate, 921600);
        const { snapshot, token: firmwareToken } = resolveFirmware(params);
        await beginFlashJob({
          channel,
          port,
          baudRate,
          snapshot,
          // R1：把实际使用的令牌带进任务并钉住，避免被容量淘汰
          firmwareToken,
          handoffMonitor: guard.optionalBoolean(params.handoffMonitor, false),
          monitorBaud: guard.requireBaud(params.monitorBaud, 115200),
        });
        // 回传令牌：UI 始终持有当前有效令牌（旧实现丢弃新 token 导致 64 次后失效）
        return {
          ok: true,
          started: true,
          channel,
          token: firmwareToken,
          // 代际：UI 用它与事件比较，避免"启动响应晚于 flash_done"把终态改回运行中
          generations: { [channel]: channelGeneration(channel) },
        };
      }

      case "start_flash_parallel": {
        const baudRate = guard.requireBaud(params.baudRate, 921600);
        const handoffMonitor = guard.optionalBoolean(params.handoffMonitor, false);
        if (!Array.isArray(params.channels) || params.channels.length === 0) {
          throw new guard.IpcError("IPC_BAD_PARAMS", "请至少配置一个烧录通道");
        }
        if (params.channels.length > FLASH_CHANNEL_IDS.length) {
          throw new guard.IpcError("IPC_BAD_PARAMS", "通道数量超过上限");
        }

        const seenChannels = new Set();
        const seenPorts = new Set();
        const started = [];
        const notStarted = [];
        /** 每通道能力令牌：前端必须保存，否则后续停止/重试会拿着旧令牌 */
        const tokens = {};

        for (const cfg of params.channels) {
          let channel = null;
          try {
            channel = guard.requireChannelId(cfg?.channel, FLASH_CHANNEL_IDS);
            if (seenChannels.has(channel)) {
              throw new guard.IpcError("IPC_BAD_PARAMS", `${channelLabel(channel)} 重复配置`);
            }
            const port = guard.requirePort(cfg?.port);
            const portKey = normalizePort(port);
            if (seenPorts.has(portKey)) {
              throw new guard.IpcError("IPC_BAD_PARAMS", `串口 ${port} 在本批次中重复`);
            }
            if (flashJobs.get(channel)?.running || flashJobs.get(channel)?.pending) {
              throw new Error(`${channelLabel(channel)} 正在烧录中`);
            }
            const { snapshot, token: firmwareToken } = resolveFirmware(
              cfg,
              `${channelLabel(channel)} 固件`,
            );
            seenChannels.add(channel);
            seenPorts.add(portKey);
            await beginFlashJob({
              channel,
              port,
              baudRate,
              snapshot,
              firmwareToken,
              handoffMonitor,
              monitorBaud: guard.requireBaud(cfg?.monitorBaud ?? params.monitorBaud, 115200),
            });
            started.push(channel);
            tokens[channel] = firmwareToken;
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            notStarted.push({ channel: channel ?? String(cfg?.channel ?? ""), reason });
            pushLog(`${channel ? channelLabel(channel) : "通道"} 未启动：${reason}`, "error", channel);
          }
        }

        if (!started.length) {
          const detail = notStarted.map((x) => `${x.channel}: ${x.reason}`).join("；");
          throw new guard.IpcError("IPC_BAD_PARAMS", `没有通道可以启动（${detail}）`);
        }
        const generations = {};
        for (const ch of started) generations[ch] = channelGeneration(ch);
        return { ok: true, started, notStarted, count: started.length, tokens, generations };
      }

      case "stop_flash": {
        const { channel } = params;
        if (channel) {
          const id = guard.requireChannelId(channel, FLASH_CHANNEL_IDS);
          flashJobs.get(id)?.abort?.abort();
        } else {
          for (const id of Object.keys(FLASH_CHANNELS)) {
            flashJobs.get(id)?.abort?.abort();
          }
        }
        return { ok: true };
      }

      case "serial_connect": {
        const channel = guard.requireChannelId(params.channel, FLASH_CHANNEL_IDS);
        const port = guard.requirePort(params.port);
        const baudRate = guard.requireBaud(params.baudRate, 115200);
        if (portUsedByFlash(port)) {
          throw new Error(`串口 ${port} 正在被烧录任务使用`);
        }
        await connectMonitor(
          channel,
          port,
          baudRate,
          (line) => pushLog(line, "serial", channel),
          (err) => {
              // 串口错误/USB 断开：立即广播状态，而不是只写日志
              pushLog(String(err.message || err), "error", channel);
              emit({ type: "serial_state", ...getMonitorSnapshot() });
            },
        );
        pushLog(`已连接 ${port} @ ${baudRate}`, "success", channel);
        emit({ type: "serial_state", ...getMonitorSnapshot() });
        gate.notifyActivityChanged();
        return { ok: true };
      }

      case "serial_disconnect": {
        const channel = params.channel
          ? guard.requireChannelId(params.channel, FLASH_CHANNEL_IDS)
          : undefined;
        await disconnectMonitor(channel || undefined);
        if (channel) {
          pushLog("串口已断开", "info", channel);
        } else {
          pushLog("全部串口已断开", "info");
        }
        emit({ type: "serial_state", ...getMonitorSnapshot() });
        gate.notifyActivityChanged();
        return { ok: true };
      }

      case "serial_send": {
        const channel = guard.requireChannelId(params.channel, FLASH_CHANNEL_IDS);
        const text = guard.sanitizeSerialText(params.text ?? "");
        await sendMonitor(channel, text);
        pushLog(text, "send", channel);
        return { ok: true };
      }

      case "ota_status":
        return ota.getStatus();

      case "ota_set_config": {
        ota.saveConfig({
          autoCheck: guard.optionalBoolean(params.autoCheck, undefined),
          requireSignature:
            params.requireSignature === undefined
              ? undefined
              : guard.optionalBoolean(params.requireSignature, false),
        });
        return ota.getStatus();
      }

      case "ota_check":
        return ota.checkForUpdates();

      case "ota_download":
        return ota.downloadUpdate();

      case "ota_install":
        return ota.installUpdateAndRestart({
          afterTasks: guard.optionalBoolean(params.afterTasks, false),
          dryRun: guard.optionalBoolean(params.dryRun, false),
        });

      case "ota_cancel_download":
        return ota.cancelDownload();

      case "ota_open_release":
        return ota.openReleasePage();

      default: {
        throw new guard.IpcError("IPC_UNKNOWN_METHOD", "未知方法");
      }
    }
  });
}

export function abortAllFlashJobs() {
  for (const id of Object.keys(FLASH_CHANNELS)) {
    flashJobs.get(id)?.abort?.abort();
  }
}
