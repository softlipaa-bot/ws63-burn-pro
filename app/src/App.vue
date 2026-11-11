<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import AppearancePicker from "@/components/flclash/AppearancePicker.vue";
import NavCapsule from "@/components/flclash/NavCapsule.vue";
import ThemeQuickToggle from "@/components/flclash/ThemeQuickToggle.vue";
import FlashActionCard from "@/components/flash-action/FlashActionCard.vue";
import "@/components/flclash/flclash-layout.css";
import {
  api,
  CHANNEL_COUNT_OPTIONS,
  defaultChannels,
  defaultSerialChannels,
  emptyChannelBauds,
  emptyChannelStrings,
  firmwareBasename,
  FLASH_CHANNEL_IDS,
  FLASH_CHANNEL_META,
  isFlashChannelId,
  type AppState,
  type BuildInfo,
  type FlashChannelId,
  type FlashChannelState,
  type FlashChannelStatus,
  type PortInfo,
  type SerialChannelState,
} from "@/lib/api";
import { describeFailure, hintForErrorCode } from "@/lib/error-hint.js";
import { escapeStopsFlash } from "@/lib/keyboard-nav.js";
import { anyTaskActive, canStopChannel, createGenerationGate } from "@/lib/task-generation";
import { createLogQueue } from "@/lib/log-queue.js";
import { createProgressGuard, mergeSealedChannel } from "@/lib/progress-guard.js";
import { runDiagnosticExport, runUserRetry, selectRetryChannels } from "@/lib/retry-action.js";
import { shouldPopLeavingSlot, slotAnimDuration } from "@/lib/slot-motion.js";
import { flashPhase, globalPhase, monitorPhase, progressCaption } from "@/lib/station-phase.js";
type Section = "flash" | "monitor" | "about";

const activeSection = ref<Section>("flash");
const bridgeError = ref("");
const busy = ref(false);
const flashSlotCount = ref(1);
const monitorSlotCount = ref(1);

type OtaStatus =
  | "idle"
  | "checking"
  | "available"
  | "up_to_date"
  | "downloading"
  | "ready"
  | "error";

type OtaState = {
  currentVersion: string;
  config: {
    owner: string;
    repo: string;
    assetName: string;
    autoCheck: boolean;
    hasToken: boolean;
  };
  status: OtaStatus;
  latestVersion: string;
  releaseName: string;
  releaseNotes: string;
  releaseUrl: string;
  assetName: string;
  assetSize: number;
  downloadPath: string;
  progress: number;
  message: string;
  packaged: boolean;
};

function defaultOtaState(): OtaState {
  return {
    currentVersion: "—",
    config: {
      owner: "",
      repo: "",
      assetName: "",
      autoCheck: true,
      hasToken: false,
    },
    status: "idle",
    latestVersion: "",
    releaseName: "",
    releaseNotes: "",
    releaseUrl: "",
    assetName: "",
    assetSize: 0,
    downloadPath: "",
    progress: 0,
    message: "",
    packaged: false,
  };
}

const ota = ref(defaultOtaState());
const otaAutoCheck = ref(true);
const otaBusy = ref(false);

/** 烧录成功后是否无缝进入串口监听（WS63 仍需手动按 RST） */
const openMonitorAfterFlash = ref(false);

const PREFS_KEY = "ws63-burn-pro-prefs-v1";
let prefsReady = false;

/** Slot-count TransitionGroup anim token */
const slotAnimToken = ref(0);
let slotAnimTimer: ReturnType<typeof setTimeout> | null = null;
const slotAnimating = computed(() => slotAnimToken.value > 0);
const flashSlotStageRef = ref<HTMLElement | null>(null);
const monitorSlotStageRef = ref<HTMLElement | null>(null);
/** 首次切换前先热一下合成层，避免冷启动 + 毛玻璃同帧卡顿 */
let slotCompositorWarmed = false;
const reducedMotion = ref(false);
let motionMedia: MediaQueryList | null = null;

function syncReducedMotion() {
  reducedMotion.value = Boolean(motionMedia?.matches);
}

function bumpSlotAnim() {
  if (!prefsReady) return;
  warmSlotCompositor();
  slotAnimToken.value += 1;
  const token = slotAnimToken.value;
  if (slotAnimTimer) clearTimeout(slotAnimTimer);
  slotAnimTimer = setTimeout(() => {
    if (slotAnimToken.value === token) slotAnimToken.value = 0;
    slotAnimTimer = null;
  }, slotAnimDuration(reducedMotion.value));
}

/** 预热 transform 层；不改路数，避免误播动画。减少动效时不升 will-change。 */
function warmSlotCompositor() {
  if (slotCompositorWarmed) return;
  slotCompositorWarmed = true;
  if (reducedMotion.value) return;
  const roots = [flashSlotStageRef.value, monitorSlotStageRef.value].filter(
    (el): el is HTMLElement => !!el,
  );
  for (const root of roots) {
    root.querySelectorAll(".slot-list-item").forEach((el) => {
      const node = el as HTMLElement;
      node.style.willChange = "transform, opacity";
      node.style.transform = "translateZ(0)";
    });
  }
  // 强制一次合成
  for (const root of roots) void root.offsetHeight;
  for (const root of roots) {
    root.querySelectorAll(".slot-list-item").forEach((el) => {
      const node = el as HTMLElement;
      node.style.willChange = "";
      node.style.transform = "";
    });
  }
}

function onSlotBeforeLeave(el: Element) {
  if (!shouldPopLeavingSlot(reducedMotion.value)) return;
  const node = el as HTMLElement;
  const parent = node.parentElement;
  if (!parent) return;
  const parentRect = parent.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  // Motion-style popLayout: pop out of flow, exit in place
  node.style.position = "absolute";
  node.style.width = `${rect.width}px`;
  node.style.height = `${rect.height}px`;
  node.style.left = `${rect.left - parentRect.left + parent.scrollLeft}px`;
  node.style.top = `${rect.top - parentRect.top + parent.scrollTop}px`;
  node.style.margin = "0";
  node.style.zIndex = "5";
  node.style.boxSizing = "border-box";
  node.style.transformOrigin = "center center";
  node.style.pointerEvents = "none";
}

function onSlotAfterLeave(el: Element) {
  const node = el as HTMLElement;
  node.style.position = "";
  node.style.width = "";
  node.style.height = "";
  node.style.left = "";
  node.style.top = "";
  node.style.margin = "";
  node.style.zIndex = "";
  node.style.boxSizing = "";
  node.style.transformOrigin = "";
  node.style.pointerEvents = "";
}


const ports = ref<PortInfo[]>([]);
const firmwarePaths = reactive(emptyChannelStrings());
/** 主进程签发的固件能力令牌（会话内有效，不落 localStorage） */
const firmwareTokens = reactive(emptyChannelStrings());
const flashBaud = ref("921600");
const channelPorts = reactive(emptyChannelStrings());
const channels = ref(defaultChannels());

/** 构建身份（W29-01）：版本 + 运行路径 + 清单一致性，供界面可见 */
const buildInfo = ref<{
  version: string;
  product: string;
  builtAt: string;
  sourceDigest: string;
  packageVersion: string;
  manifest: { found: boolean; path: string; matchesPackageVersion: boolean };
  runtime: { packaged: boolean; execPath: string; appPath: string; fromAsar: boolean };
  warnings: string[];
} | null>(null);
const buildInfoError = ref("");

/** 握手实时信息（W29-02）：阶段 / 已等待 / 尝试次数 / 已收字节 */
const handshakeInfo = reactive<
  Record<FlashChannelId, { phase: string; attempts: number; elapsedMs: number; rxBytes: number; lastCode: string }>
>(Object.fromEntries(
  FLASH_CHANNEL_IDS.map((id) => [
    id,
    { phase: "", attempts: 0, elapsedMs: 0, rxBytes: 0, lastCode: "" },
  ]),
) as Record<FlashChannelId, { phase: string; attempts: number; elapsedMs: number; rxBytes: number; lastCode: string }>);


const serialPorts = reactive(emptyChannelStrings());
const serialBauds = reactive(emptyChannelBauds("115200"));
const serialChannels = ref(defaultSerialChannels());
const sendTexts = reactive(emptyChannelStrings());

const logsByChannel = reactive(emptyChannelStrings());
const logPanelRefs = ref<Partial<Record<FlashChannelId, HTMLElement | null>>>({});
const logStickToBottom = reactive(
  Object.fromEntries(FLASH_CHANNEL_IDS.map((id) => [id, true])) as Record<FlashChannelId, boolean>,
);
const channelOutcome = reactive(
  Object.fromEntries(FLASH_CHANNEL_IDS.map((id) => [id, ""])) as Record<FlashChannelId, string>,
);
const channelErrorCode = reactive(
  Object.fromEntries(FLASH_CHANNEL_IDS.map((id) => [id, ""])) as Record<FlashChannelId, string>,
);
const actionNotice = ref("");
const actionTone = ref<"info" | "success" | "error">("info");
const retryGate = { current: false };
const exportGate = { current: false };
const retryHeld = ref(false);
const exportHeld = ref(false);

function notify(message: string, tone: "info" | "success" | "error" = "info") {
  actionNotice.value = message;
  actionTone.value = tone;
}

const baudOptions = [
  "115200", "230400", "460800", "500000", "576000",
  "921600", "1000000", "1152000", "1500000", "2000000",
];

const navItems: { id: Section; label: string; icon: string }[] = [
  { id: "flash", label: "固件烧录", icon: "i-lucide-flame" },
  { id: "monitor", label: "串口与日志", icon: "i-lucide-terminal" },
  { id: "about", label: "关于与更新", icon: "i-lucide-cloud-download" },
];

/** ≤999px：底部 Dock 为主导航；侧栏退出交互树，避免重复 section-tab-* id */
const narrowLayout = ref(false);
let narrowMedia: MediaQueryList | null = null;

function syncNarrowLayout() {
  narrowLayout.value = Boolean(narrowMedia?.matches);
}

const activeFlashChannels = computed(() =>
  FLASH_CHANNEL_META.slice(0, flashSlotCount.value),
);
const activeMonitorChannels = computed(() =>
  FLASH_CHANNEL_META.slice(0, monitorSlotCount.value),
);
const multiFlash = computed(() => flashSlotCount.value > 1);

const flashRunning = computed(() =>
  FLASH_CHANNEL_IDS.some((id) => canStopChannel(channelTaskState(id))),
);
/** 通道的"可停止"视图：running / pending / 本地启动在飞（C2） */
function channelTaskState(id: FlashChannelId) {
  return {
    running: Boolean(channels.value[id]?.running),
    pending: Boolean(channels.value[id]?.pending),
    startInFlight: Boolean(startInFlight.value[id]),
  };
}
/** 是否存在任何需要停止入口的任务（Esc 与顶栏停止按钮都据此判定） */
const anyFlashTaskActive = computed(() =>
  anyTaskActive(FLASH_CHANNEL_IDS.map((id) => channelTaskState(id))),
);

const flashSuccessCount = computed(() =>
  activeFlashChannels.value.filter((m) => channels.value[m.id].status === "success").length,
);
const flashErrorCount = computed(() =>
  activeFlashChannels.value.filter((m) => channels.value[m.id].status === "error").length,
);
const serialConnectedCount = computed(
  () => FLASH_CHANNEL_IDS.filter((id) => serialChannels.value[id].connected).length,
);
const anySerialConnected = computed(() => serialConnectedCount.value > 0);
/** 烧录或串口监听进行中：主进程会阻止安装更新与退出 */
const tasksActive = computed(() => flashRunning.value || anySerialConnected.value);

const configuredFlashChannels = computed(() =>
  activeFlashChannels.value.filter(
    (meta) => firmwarePaths[meta.id] && channelPorts[meta.id],
  ),
);

const canParallelFlash = computed(() => {
  if (!multiFlash.value || flashRunning.value) return false;
  const ready = configuredFlashChannels.value;
  if (ready.length < 2) return false;
  const used = new Set<string>();
  for (const meta of ready) {
    const port = channelPorts[meta.id];
    if (used.has(port)) return false;
    used.add(port);
  }
  return true;
});

const portItems = computed(() =>
  ports.value.map((p) => ({ label: p.label, value: p.path })),
);

const MAX_LOG_CHARS = 80_000;
/** 按通道的任务代际闸门（主进程权威分配 generation；见 lib/task-generation.ts） */
const taskGate = createGenerationGate();
/** 本地"启动请求已发出、响应未回"的通道：此阶段也要能停止（Codex P1） */
const startInFlight = ref<Partial<Record<FlashChannelId, boolean>>>({});
/** 每次提交烧录的请求身份。旧请求的 finally 不能清掉更新的一次。 */
const flightToken = ref<Partial<Record<FlashChannelId, number>>>({});
let nextFlight = 1;
const progressGuard = createProgressGuard();
let progressFrame = 0;

function beginFlight(channel: FlashChannelId) {
  const token = nextFlight++;
  flightToken.value[channel] = token;
  startInFlight.value[channel] = true;
  noteFlashStarted(channel);
  return token;
}

function endFlight(channel: FlashChannelId, token: number) {
  if (flightToken.value[channel] !== token) return;
  startInFlight.value[channel] = false;
}

function trimLog(text: string) {
  if (text.length <= MAX_LOG_CHARS) return text;
  const start = text.length - MAX_LOG_CHARS;
  const cut = text.indexOf("\n", start);
  return text.slice(cut === -1 ? start : cut + 1);
}

function stripChannelTag(text: string, channel: FlashChannelId | null) {
  if (!channel) return text;
  const label = FLASH_CHANNEL_META.find((m) => m.id === channel)?.label;
  if (!label) return text;
  return text.replaceAll(`[${label}] `, "");
}

function normalizeLogChunk(text: string, channel: FlashChannelId | null = null) {
  const normalized = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  return stripChannelTag(normalized, channel);
}

function scheduleProgressApply() {
  if (progressFrame) return;
  progressFrame = requestAnimationFrame(() => {
    progressFrame = 0;
    const { applied } = progressGuard.drain();
    for (const patch of applied) {
      if (!isFlashChannelId(patch.channel) || !channels.value[patch.channel]) continue;
      const gen = Number(patch.mainGeneration);
      if (Number.isFinite(gen)) {
        if (taskGate.isDone(patch.channel, gen)) continue;
        if (taskGate.applied(patch.channel) > gen) continue;
      } else if (progressGuard.isSealed(patch.channel)) {
        continue;
      }
      channels.value[patch.channel].progress = patch.progress;
      if (patch.partName != null) channels.value[patch.channel].partName = patch.partName;
    }
  });
}

function noteFlashStarted(channel: FlashChannelId) {
  progressGuard.begin(channel);
  channelOutcome[channel] = "";
  channelErrorCode[channel] = "";
  if (progressFrame) {
    cancelAnimationFrame(progressFrame);
    progressFrame = 0;
  }
}

function noteFlashFinished(channel: FlashChannelId, generation?: number) {
  progressGuard.seal(channel, generation);
  if (progressFrame) {
    cancelAnimationFrame(progressFrame);
    progressFrame = 0;
  }
}

function offerProgress(
  channel: FlashChannelId,
  progress: number,
  partName?: string | null,
  generation?: number,
) {
  const gen = Number(generation);
  if (!Number.isFinite(gen)) return;
  if (!taskGate.acceptEvent(channel, gen)) return;
  const result = progressGuard.offer(channel, progress, partName, gen);
  if (result.accepted) scheduleProgressApply();
}

const statusMeta = computed(() => {
  const phases = FLASH_CHANNEL_IDS.map((id) => flashPhase(channels.value[id], channelOutcome[id]));
  const summary = globalPhase({ phases, listening: serialConnectedCount.value });
  return {
    label: summary.label,
    color: summary.tone as "warning" | "success" | "error" | "neutral" | "primary",
  };
});

const flashGridClass = "slot-flash-grid";
const monitorGridClass = "slot-monitor-grid";

const primaryFlashPhase = computed(() => {
  if (anyFlashTaskActive.value) {
    const active = FLASH_CHANNEL_IDS.filter((id) => canStopChannel(channelTaskState(id)));
    const phases = active.map((id) => phaseOf(id));
    for (const id of ["wait_reset", "handshake", "handshake_ok", "flashing", "prepare", "pending"]) {
      const phase = phases.find((item) => item.id === id);
      if (phase) return { state: phase.id, label: phase.label };
    }
    // A local request may be in flight before the first backend state arrives.
    return { state: "pending", label: "正在准备" };
  }
  const phases = activeFlashChannels.value.map((meta) => phaseOf(meta.id));
  if (phases.some((phase) => phase.id === "error" || phase.id === "partial")) return { state: "error", label: "有通道烧录失败" };
  if (phases.some((phase) => phase.id === "unverified")) return { state: "unverified", label: "协议完成 · 启动未验证" };
  if (phases.some((phase) => phase.id === "cancelled")) return { state: "cancelled", label: "烧录已取消" };
  if (multiFlash.value && configuredFlashChannels.value.length < 2) return { state: "idle", label: "请配置至少两路" };
  if (multiFlash.value && !canParallelFlash.value) return { state: "idle", label: "检查串口配置" };
  return { state: "idle", label: configuredFlashChannels.value.length ? "准备就绪" : "等待配置" };
});
const primaryFlashCanStart = computed(() => !busy.value && !flashRunning.value && (
  multiFlash.value ? canParallelFlash.value : Boolean(firmwarePaths["1"] && channelPorts["1"])
));
const primaryFlashLabel = computed(() => multiFlash.value ? `同时烧录 ${configuredFlashChannels.value.length} 路` : "开始烧录");
const primaryFlashDetail = computed(() => {
  const ids = multiFlash.value ? configuredFlashChannels.value.map((meta) => meta.id) : ["1" as FlashChannelId];
  const names = [...new Set(ids.map((id) => firmwareBasename(firmwarePaths[id])).filter(Boolean))];
  const selectedPorts = ids.map((id) => channelPorts[id]).filter(Boolean);
  return `${selectedPorts.join("、") || "未选择串口"} · ${names.length === 1 ? names[0] : names.length ? `${names.length} 份固件` : "未选择固件"}`;
});
const primaryFlashProgress = computed(() => {
  // Parallel channels can be in different stages; their own cards show exact progress.
  if (multiFlash.value) return null;
  const active = activeFlashChannels.value.filter((meta) => channels.value[meta.id].running && phaseOf(meta.id).id === "flashing");
  if (!active.length) return null;
  return Math.round(active.reduce((sum, meta) => sum + Math.max(0, Math.min(100, Number(channels.value[meta.id].progress) || 0)), 0) / active.length);
});
async function activatePrimaryFlash() {
  try {
    // Recheck live state here: two clicks in one frame must not reuse stale child props.
    if (anyFlashTaskActive.value) { await stopFlash(); return; }
    if (!primaryFlashCanStart.value) return;
    if (multiFlash.value) await startParallelFlash();
    else await startChannelFlash("1");
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), "error");
  }
}

function phaseOf(id: FlashChannelId) {
  return flashPhase(channels.value[id], channelOutcome[id]);
}

function flashStatusLabel(id: FlashChannelId): string {
  return phaseOf(id).label;
}

function flashProgressLabel(id: FlashChannelId): string {
  return progressCaption(channels.value[id], channelOutcome[id]);
}

function flashStatusColor(id: FlashChannelId): "warning" | "success" | "error" | "neutral" | "primary" {
  return phaseOf(id).tone as "warning" | "success" | "error" | "neutral" | "primary";
}

function monitorStatus(id: FlashChannelId) {
  return monitorPhase({
    connected: serialChannels.value[id].connected,
    portSelected: Boolean(serialPorts[id]),
  });
}

function errorHint(id: FlashChannelId): string {
  return hintForErrorCode(channelErrorCode[id]);
}

/**
 * 握手/等待复位期间的实时提示（W29-02）。
 * 明确告诉用户“现在该按板上 RST”，并展示已等待时间、尝试次数、已收字节，
 * 以及当前失败原因的中文说明；不提示任何自动拨 RTS/DTR 的动作。
 */
function handshakeHint(id: FlashChannelId): string {
  const h = handshakeInfo[id];
  const waited = Math.max(0, Math.round(h.elapsedMs / 1000));
  const phase = h.phase === "wait_reset" ? "等待串口就绪" : "等待握手应答";
  const codeText =
    h.lastCode === "BAD_FRAME"
      ? "（收到坏帧）"
      : h.lastCode === "UNEXPECTED_FRAME"
        ? "（收到非预期应答）"
        : "";
  return `${phase}：现在请按板上 RST｜已等 ${waited}s｜尝试 ${h.attempts} 次｜已收 ${h.rxBytes} 字节${codeText}`;
}

/**
 * 固件选择的唯一写入口（W29-06）。
 * 路径与能力令牌必须**原子**更新：旧实现里 `applyFirmwareToAll` 只复制路径、
 * 拖拽只改路径不清令牌，而后端有令牌时优先用令牌里的 path，于是出现
 * “界面显示 B、实际烧 A”。
 */
function setFirmware(channel: FlashChannelId, path: string, token = "") {
  firmwarePaths[channel] = path;
  firmwareTokens[channel] = token;
  if (!path) firmwareTokens[channel] = "";
}

async function applyFirmwareToAll(from: FlashChannelId = "1") {
  const srcPath = firmwarePaths[from];
  if (!srcPath) return;
  const srcToken = firmwareTokens[from] || "";
  for (const meta of activeFlashChannels.value) {
    setFirmware(meta.id, srcPath, srcToken);
  }
  appendLocalLog(
    `已把 ${firmwareBasename(srcPath)} 应用到 ${activeFlashChannels.value.length} 路`,
    "信息",
    from,
  );
}

function isLogNearBottom(el: HTMLElement | null, threshold = 48) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function onLogScroll(id?: FlashChannelId) {
  const target = id ?? activeMonitorChannels.value[0]?.id;
  if (!target) return;
  const el = logPanelRefs.value[target];
  if (el) logStickToBottom[target] = isLogNearBottom(el);
}

function setLogPanelRef(id: FlashChannelId, el: unknown) {
  logPanelRefs.value[id] = (el as HTMLElement | null) ?? null;
}

async function scrollLogPanels() {
  await nextTick();
  for (const meta of activeMonitorChannels.value) {
    if (!logStickToBottom[meta.id]) continue;
    const el = logPanelRefs.value[meta.id];
    if (el) el.scrollTop = el.scrollHeight;
  }
}

const logQueue = createLogQueue({
  onFlush(items, meta) {
    const extra: Partial<Record<FlashChannelId, string>> = {};
    for (const item of items) {
      const ch = (isFlashChannelId(item.channel) ? item.channel : null)
        ?? activeMonitorChannels.value[0]?.id
        ?? "1";
      extra[ch] = (extra[ch] ?? "") + item.text;
    }
    for (const id of Object.keys(extra) as FlashChannelId[]) {
      logsByChannel[id] = trimLog(logsByChannel[id] + (extra[id] ?? ""));
    }
    if (meta.dropped > 0) {
      const first = activeMonitorChannels.value[0]?.id ?? "1";
      const note = `[提示] 渲染端日志队列已丢弃 ${meta.dropped} 段（条数或字节上限，日志不完整）\n`;
      logsByChannel[first] = trimLog(logsByChannel[first] + note);
    }
    void scrollLogPanels();
  },
  onResume() {
    void scrollLogPanels();
  },
});

function dropPendingLogs() {
  logQueue.clear();
}

function formatLocalClock(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function appendLocalLog(
  message: string,
  level: "信息" | "成功" | "错误" | "串口" | "发送" = "信息",
  channel: FlashChannelId | null = null,
) {
  const body = String(message ?? "").replace(/\r/g, "");
  const line = `[${formatLocalClock()}] [${level}] ${body}\n`;
  appendSerialLog(line, channel);
}

function appendSerialLog(text: string, channel: FlashChannelId | null = null) {
  if (!text) return;
  const chunk = normalizeLogChunk(text, channel);
  if (!chunk) return;
  const piece = chunk.endsWith("\n") ? chunk : `${chunk}\n`;
  logQueue.enqueue(piece, channel);
}

function applyChannelSnapshot(snapshot: Record<FlashChannelId, FlashChannelState>) {
  const base = defaultChannels();
  const next = { ...base };
  for (const id of FLASH_CHANNEL_IDS) {
    const incoming = snapshot?.[id] ?? base[id];
    const sealed = progressGuard.isSealed(id);
    const merged = mergeSealedChannel(channels.value[id], incoming, sealed) as FlashChannelState;
    merged.bootVerified = false;
    if (!sealed && (merged.running || merged.status === "running")) {
      channelOutcome[id] = "";
      channelErrorCode[id] = "";
    }
    next[id] = merged;
  }
  channels.value = next;
}

function applySerialSnapshot(snapshot: Record<FlashChannelId, SerialChannelState>) {
  serialChannels.value = { ...defaultSerialChannels(), ...snapshot };
}

async function refreshPorts() {
  const res = await api<{ ports: PortInfo[] }>("list_ports");
  ports.value = res.ports;
  const paths = ports.value.map((p) => p.path);
  for (let i = 0; i < FLASH_CHANNEL_IDS.length; i += 1) {
    const id = FLASH_CHANNEL_IDS[i];
    if (!channelPorts[id] && paths[i]) channelPorts[id] = paths[i];
    if (!serialPorts[id] && paths[i]) serialPorts[id] = paths[i];
  }
}

function routeLogLine(buckets: Record<FlashChannelId, string>, line: string) {
  const text = line.endsWith("\n") ? line : `${line}\n`;
  for (const meta of [...activeMonitorChannels.value].reverse()) {
    if (line.includes(`[${meta.label}]`)) {
      buckets[meta.id] += text;
      return;
    }
  }
  const first = activeMonitorChannels.value[0]?.id ?? "1";
  buckets[first] += text;
}

async function refreshState() {
  const s = await api<AppState>("get_state");
  logQueue.clear();
  const buckets = emptyChannelStrings();
  for (const line of s.logs) routeLogLine(buckets, line);
  for (const id of FLASH_CHANNEL_IDS) logsByChannel[id] = trimLog(buckets[id]);
  applyChannelSnapshot(s.channels ?? defaultChannels());
  applySerialSnapshot(s.serialChannels ?? defaultSerialChannels());
  void scrollLogPanels();
}

async function pickFirmware(channel: FlashChannelId) {
  try {
    const res = await api<{
      path: string;
      token?: string;
      size?: number;
      sha256?: string;
      lines?: string[];
    }>("pick_firmware");
    if (!res.path) return;
    // 路径与令牌一起写；令牌由主进程签发，烧录时仍会重新校验摘要
    setFirmware(channel, res.path, res.token ?? "");
    const digest = res.sha256 ? ` SHA256 ${res.sha256.slice(0, 12)}…` : "";
    appendLocalLog(
      `已选择固件 ${firmwareBasename(res.path)}（${formatBytes(res.size ?? 0)}${digest}）`,
      "信息",
      channel,
    );
  } catch (e) {
    // 选择失败必须清空令牌，避免继续用上一个文件的授权
    setFirmware(channel, firmwarePaths[channel], "");
    appendLocalLog(e instanceof Error ? e.message : String(e), "错误", channel);
  }
}

function onFirmwareDrop(channel: FlashChannelId, event: DragEvent) {
  event.preventDefault();
  if (channels.value[channel].running) return;
  const file = event.dataTransfer?.files?.[0] as File | undefined;
  if (!file) return;
  const name = file.name.toLowerCase();
  if (!name.endsWith(".fwpkg")) {
    appendLocalLog("请拖入 .fwpkg 固件文件", "错误", channel);
    return;
  }
  // Electron 34 已移除 File.path：只能通过 preload 暴露的 webUtils.getPathForFile 取路径
  const path =
    window.ws63?.getPathForFile?.(file) ??
    ((file as File & { path?: string }).path || "");
  if (!path) {
    appendLocalLog("无法读取固件路径，请改用“选择文件”按钮", "错误", channel);
    return;
  }
  // 拖拽不签发能力令牌 → 令牌必须清空，否则后端会用旧令牌的路径（烧错文件）
  setFirmware(channel, path, "");
  appendLocalLog(`已拖入固件 ${firmwareBasename(path)}（烧录时重新校验）`, "信息", channel);
}

async function enterMonitor(channel: FlashChannelId) {
  const port = channelPorts[channel] || serialPorts[channel];
  if (!port) {
    appendLocalLog("请先选择串口", "错误", channel);
    return;
  }
  if (Number(flashSlotCount.value) > Number(monitorSlotCount.value)) {
    monitorSlotCount.value = flashSlotCount.value;
  }
  serialPorts[channel] = port;
  busy.value = true;
  try {
    if (serialChannels.value[channel].connected) {
      await api("serial_disconnect", { channel });
    }
    await api("serial_connect", {
      channel,
      port,
      baudRate: Number(serialBauds[channel]) || 115200,
    });
    serialChannels.value[channel].connected = true;
    activeSection.value = "monitor";
    appendLocalLog(
      `已进入监听 ${port}（WS63 请手动按 RST 查看启动日志）`,
      "成功",
      channel,
    );
  } catch (e) {
    appendLocalLog(e instanceof Error ? e.message : String(e), "错误", channel);
  } finally {
    busy.value = false;
  }
}

function flashOpts() {
  return {
    handoffMonitor: openMonitorAfterFlash.value,
    monitorBaud: Number(serialBauds["1"]) || 115200,
  };
}

function rememberTokens(tokens: unknown) {
  if (!tokens || typeof tokens !== "object") return;
  for (const id of FLASH_CHANNEL_IDS) {
    const value = (tokens as Record<string, unknown>)[id];
    if (typeof value === "string" && value) firmwareTokens[id] = value;
  }
}

function showChannelFailure(channel: FlashChannelId, error: unknown) {
  const info = describeFailure(error);
  if (info.hidden) {
    appendLocalLog(info.message, "错误", channel);
    return;
  }
  channelErrorCode[channel] = info.code;
  channels.value[channel].status = "error";
  channels.value[channel].running = false;
  channels.value[channel].errorMessage = info.message;
  appendLocalLog(info.message, "错误", channel);
}

async function startChannelFlash(channel: FlashChannelId) {
  const port = channelPorts[channel];
  const filePath = firmwarePaths[channel];
  if (!filePath || !port || busy.value) return;
  if (openMonitorAfterFlash.value && flashSlotCount.value > monitorSlotCount.value) {
    monitorSlotCount.value = flashSlotCount.value;
  }
  const flight = beginFlight(channel);
  busy.value = true;
  try {
    const res = await api<{
      ok?: boolean;
      token?: string;
      generations?: Record<string, number>;
    }>("start_flash", {
      channel,
      port,
      baudRate: Number(flashBaud.value),
      filePath,
      token: firmwareTokens[channel] || undefined,
      ...flashOpts(),
      monitorBaud: Number(serialBauds[channel]) || 115200,
    });
    if (typeof res?.token === "string" && res.token) firmwareTokens[channel] = res.token;
    // C1：启动响应可能晚于 flash_done（例如准备阶段就失败）。只有当该通道的代际
    // 不比响应旧、且这一代尚未终态时，才允许把界面置为运行中。
    const gen = Number(res?.generations?.[channel] ?? Number.NaN);
    if (taskGate.acceptStart(channel, gen)) {
      channels.value[channel].running = true;
      channels.value[channel].status = "running";
      channels.value[channel].errorMessage = "";
      channelErrorCode[channel] = "";
    }
  } catch (e) {
    noteFlashFinished(channel);
    showChannelFailure(channel, e);
  } finally {
    endFlight(channel, flight);
    busy.value = false;
  }
}

async function startParallelFlash() {
  if (!canParallelFlash.value) return;
  if (openMonitorAfterFlash.value && flashSlotCount.value > monitorSlotCount.value) {
    monitorSlotCount.value = flashSlotCount.value;
  }
  busy.value = true;
  const configs = configuredFlashChannels.value.map((meta) => ({
    channel: meta.id,
    port: channelPorts[meta.id],
    filePath: firmwarePaths[meta.id],
    token: firmwareTokens[meta.id] || undefined,
    monitorBaud: Number(serialBauds[meta.id]) || 115200,
  }));
  const flights = configs.map((cfg) => ({ channel: cfg.channel, token: beginFlight(cfg.channel) }));
  try {
    const res = await api<{
      started?: FlashChannelId[];
      notStarted?: { channel: string; reason: string }[];
      tokens?: Record<string, string>;
      generations?: Record<string, number>;
    }>("start_flash_parallel", {
      baudRate: Number(flashBaud.value),
      channels: configs,
      handoffMonitor: openMonitorAfterFlash.value,
    });
    rememberTokens(res.tokens);
    const started = new Set(res.started ?? []);
    for (const cfg of configs) {
      const flight = flights.find((item) => item.channel === cfg.channel);
      if (!started.has(cfg.channel)) {
        if (flight) endFlight(cfg.channel, flight.token);
        noteFlashFinished(cfg.channel);
        continue;
      }
      const tk = res.tokens?.[cfg.channel];
      if (typeof tk === "string" && tk) firmwareTokens[cfg.channel] = tk;
      if (!taskGate.acceptStart(cfg.channel, Number(res.generations?.[cfg.channel] ?? Number.NaN))) {
        if (flight) endFlight(cfg.channel, flight.token);
        continue;
      }
      channels.value[cfg.channel].running = true;
      channels.value[cfg.channel].status = "running";
      channels.value[cfg.channel].errorMessage = "";
      channelErrorCode[cfg.channel] = "";
    }
    for (const item of res.notStarted ?? []) {
      if (!isFlashChannelId(item.channel)) continue;
      showChannelFailure(item.channel, { message: item.reason });
    }
  } catch (e) {
    for (const flight of flights) {
      endFlight(flight.channel, flight.token);
      noteFlashFinished(flight.channel);
    }
    const first = configuredFlashChannels.value[0]?.id ?? "1";
    showChannelFailure(first, e);
  } finally {
    for (const flight of flights) endFlight(flight.channel, flight.token);
    busy.value = false;
  }
}

/**
 * 失败通道重试（用户已授权功能 2）。
 *
 * 契约：
 * - 只重试**明确的失败通道**（成功通道原样保留）；
 * - 每次点击只尝试一次，绝不自动循环重试；
 * - 主进程会重新校验固件（路径/令牌一致 + 内容摘要）并为每次重试建立新任务 identity；
 * - 部分完成不算成功（由 outcome 决定）。
 */
async function retryFailedFlash() {
  if (retryGate.current || busy.value) {
    notify("重试已在进行，请等待这一次结束", "info");
    return;
  }
  const rows = activeFlashChannels.value.map((meta) => ({
    id: meta.id,
    status: channels.value[meta.id].status,
    running: channels.value[meta.id].running,
    pending: Boolean(channels.value[meta.id].pending),
    firmwarePath: firmwarePaths[meta.id],
    port: channelPorts[meta.id],
  }));
  const decision = selectRetryChannels(rows);
  if (!decision.selected.length) {
    const reason = "没有可重试的失败通道（需要已选固件和串口，且当前是失败）";
    notify(reason, "info");
    appendLocalLog(reason, "信息");
    return;
  }
  const flights = decision.selected.flatMap((row) => (
    isFlashChannelId(row.id) ? [{ channel: row.id, token: beginFlight(row.id) }] : []
  ));
  retryHeld.value = true;
  busy.value = true;
  try {
    const result = await runUserRetry({
      rows: decision.selected,
      gate: retryGate,
      invoke: (chosen) =>
        api<{
          ok?: boolean;
          started?: string[];
          skipped?: { channel: string; reason: string }[];
          reason?: string;
          tokens?: Record<string, string>;
          generations?: Record<string, number>;
        }>("retry_failed_channels", {
          channels: chosen.map((row) => ({
            channel: row.id,
            port: row.port,
            filePath: row.firmwarePath,
            token: isFlashChannelId(row.id) ? firmwareTokens[row.id] || undefined : undefined,
            monitorBaud: isFlashChannelId(row.id) ? Number(serialBauds[row.id]) || 115200 : 115200,
          })),
          baudRate: Number(flashBaud.value),
          handoffMonitor: openMonitorAfterFlash.value,
        }),
    });
    rememberTokens(result.tokens);
    const started = new Set(result.started);
    let applied = 0;
    for (const row of decision.selected) {
      if (!isFlashChannelId(row.id)) continue;
      const flight = flights.find((item) => item.channel === row.id);
      if (!started.has(row.id)) {
        if (flight) endFlight(row.id, flight.token);
        noteFlashFinished(row.id);
        continue;
      }
      const gen = Number(result.generations?.[row.id] ?? Number.NaN);
      if (!taskGate.acceptStart(row.id, gen)) {
        if (flight) endFlight(row.id, flight.token);
        continue;
      }
      applied += 1;
      channels.value[row.id].running = true;
      channels.value[row.id].status = "running";
      channels.value[row.id].errorMessage = "";
      channelErrorCode[row.id] = "";
      channelOutcome[row.id] = "";
    }
    for (const item of result.skipped) {
      if (!isFlashChannelId(item.channel)) continue;
      appendLocalLog(`未重试：${item.reason}`, "错误", item.channel);
    }
    const message = applied
      ? `已开始重试 ${applied} 路失败通道。只此一次，不会自动再烧。`
      : (result.reason || "没有通道开始重试");
    notify(message, applied ? "success" : "error");
    appendLocalLog(message, result.started.length ? "信息" : "错误");
  } catch (e) {
    for (const flight of flights) {
      endFlight(flight.channel, flight.token);
      noteFlashFinished(flight.channel);
    }
    const info = describeFailure(e);
    notify(info.hidden ? "重试没有开始" : info.message, "error");
    if (!info.hidden) appendLocalLog(info.message, "错误");
  } finally {
    for (const flight of flights) endFlight(flight.channel, flight.token);
    retryHeld.value = false;
    busy.value = false;
  }
}

/** 诊断导出：脱敏后由用户选择保存路径。不把保存路径写进界面，避免再露一次用户目录。 */
async function exportDiagnostics() {
  if (exportGate.current || busy.value) {
    notify("导出已在进行", "info");
    return;
  }
  exportHeld.value = true;
  busy.value = true;
  try {
    const result = await runDiagnosticExport({
      gate: exportGate,
      invoke: () =>
        api<{ ok?: boolean; bytes?: number; cancelled?: boolean }>("export_diagnostics"),
    });
    if (result.cancelled) {
      notify("已取消导出诊断", "info");
      appendLocalLog("已取消导出诊断信息", "信息");
      return;
    }
    if (!result.ok) {
      notify(`导出诊断失败：${result.reason}`, "error");
      appendLocalLog(`导出诊断失败：${result.reason}`, "错误");
      return;
    }
    const message = `诊断已导出（已脱敏，约 ${formatBytes(result.bytes)}）`;
    notify(message, "success");
    appendLocalLog(`${message}。不含固件内容、令牌和用户目录。`, "成功");
  } finally {
    exportHeld.value = false;
    busy.value = false;
  }
}

/** 复制错误信息（便于反馈）。 */
async function copyError(channel: FlashChannelId) {
  const msg = channels.value[channel].errorMessage || "";
  if (!msg) return;
  const hint = errorHint(channel);
  const code = channelErrorCode[channel];
  const text = [code, msg, hint].filter(Boolean).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    notify("错误信息已复制", "info");
    appendLocalLog("错误信息已复制到剪贴板", "信息", channel);
  } catch {
    notify("复制失败：剪贴板不可用", "error");
    appendLocalLog("复制失败：剪贴板不可用", "错误", channel);
  }
}

function exportLogs(target: FlashChannelId) {
  const text = logsByChannel[target] || "";
  if (!text.trim()) {
    appendLocalLog("当前没有可导出的日志", "信息", target);
    return;
  }
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href = url;
  a.download = `ws63-log-${target}-${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.flashSlotCount === "number") {
      flashSlotCount.value = Math.min(10, Math.max(1, p.flashSlotCount));
    }
    if (typeof p.monitorSlotCount === "number") {
      monitorSlotCount.value = Math.min(10, Math.max(1, p.monitorSlotCount));
    }
    if (typeof p.flashBaud === "string") flashBaud.value = p.flashBaud;
    if (typeof p.openMonitorAfterFlash === "boolean") {
      openMonitorAfterFlash.value = p.openMonitorAfterFlash;
    }
    const copyMap = (src: unknown, dest: Record<string, string>) => {
      if (!src || typeof src !== "object") return;
      for (const id of FLASH_CHANNEL_IDS) {
        const v = (src as Record<string, unknown>)[id];
        if (typeof v === "string") dest[id] = v;
      }
    };
    copyMap(p.firmwarePaths, firmwarePaths);
    copyMap(p.channelPorts, channelPorts);
    copyMap(p.serialPorts, serialPorts);
    copyMap(p.serialBauds, serialBauds);
  } catch {
    /* ignore */
  }
}

let prefsSaveTimer: ReturnType<typeof setTimeout> | null = null;

function savePrefs() {
  if (!prefsReady) return;
  if (prefsSaveTimer) clearTimeout(prefsSaveTimer);
  prefsSaveTimer = setTimeout(() => {
    prefsSaveTimer = null;
    const payload = {
      flashSlotCount: flashSlotCount.value,
      monitorSlotCount: monitorSlotCount.value,
      flashBaud: flashBaud.value,
      openMonitorAfterFlash: openMonitorAfterFlash.value,
      firmwarePaths: { ...firmwarePaths },
      channelPorts: { ...channelPorts },
      serialPorts: { ...serialPorts },
      serialBauds: { ...serialBauds },
    };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }, 200);
}

async function stopFlash(channel?: FlashChannelId) {
  await api("stop_flash", channel ? { channel } : {});
}

async function onFlashSlotCountChange(next: unknown) {
  const raw = typeof next === "object" && next && "value" in next
    ? (next as { value: unknown }).value
    : next;
  const n = Math.min(10, Math.max(1, Number(raw) || 1));
  if (n === flashSlotCount.value) return;
  if (n < flashSlotCount.value) {
    for (const meta of FLASH_CHANNEL_META.slice(n)) {
      if (channels.value[meta.id].running) await stopFlash(meta.id);
    }
  }
  // 紧挨赋值前打 is-animating，避免 await 期间动画标记已过期
  bumpSlotAnim();
  flashSlotCount.value = n;
}

async function onMonitorSlotCountChange(next: unknown) {
  const raw = typeof next === "object" && next && "value" in next
    ? (next as { value: unknown }).value
    : next;
  const n = Math.min(10, Math.max(1, Number(raw) || 1));
  if (n === monitorSlotCount.value) return;
  if (n < monitorSlotCount.value) {
    for (const meta of FLASH_CHANNEL_META.slice(n)) {
      if (serialChannels.value[meta.id].connected) {
        await api("serial_disconnect", { channel: meta.id });
        serialChannels.value[meta.id].connected = false;
      }
    }
  }
  bumpSlotAnim();
  monitorSlotCount.value = n;
}

async function toggleSerial(channel: FlashChannelId) {
  busy.value = true;
  try {
    if (serialChannels.value[channel].connected) {
      await api("serial_disconnect", { channel });
      serialChannels.value[channel].connected = false;
    } else {
      await api("serial_connect", {
        channel,
        port: serialPorts[channel],
        baudRate: Number(serialBauds[channel]),
      });
      serialChannels.value[channel].connected = true;
    }
  } catch (e) {
    appendLocalLog(e instanceof Error ? e.message : String(e), "错误", channel);
  } finally {
    busy.value = false;
  }
}

async function sendSerial(channel: FlashChannelId) {
  const text = sendTexts[channel].trim();
  if (!text) return;
  try {
    await api("serial_send", { channel, text });
    sendTexts[channel] = "";
  } catch (e) {
    appendLocalLog(e instanceof Error ? e.message : String(e), "错误", channel);
  }
}

async function disconnectAllSerial() {
  await api("serial_disconnect", {});
  applySerialSnapshot(defaultSerialChannels());
}

function clearLogs(target: "all" | FlashChannelId = "all") {
  dropPendingLogs();
  if (target === "all") {
    for (const id of FLASH_CHANNEL_IDS) {
      logsByChannel[id] = "";
      logStickToBottom[id] = true;
    }
    return;
  }
  if (isFlashChannelId(target)) {
    logsByChannel[target] = "";
    logStickToBottom[target] = true;
  }
}

async function waitForBridge(maxMs = 12000) {
  for (let t = 0; t < maxMs; t += 100) {
    if (window.ws63?.call) {
      try {
        await window.ws63.call("get_state");
        return true;
      } catch {
        /* backend not registered yet */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function applyOtaState(s: Partial<OtaState>) {
  ota.value = {
    ...ota.value,
    ...s,
    config: {
      ...ota.value.config,
      ...(s.config || {}),
      owner: "",
      repo: "",
      assetName: "",
    },
    releaseUrl: "",
    releaseNotes: "",
    assetName: "",
  };
  if (s.config && typeof s.config.autoCheck === "boolean") {
    otaAutoCheck.value = s.config.autoCheck;
  }
}

async function refreshOta() {
  const s = await api<OtaState>("ota_status");
  applyOtaState(s);
}

async function saveOtaAutoCheck() {
  try {
    const s = await api<OtaState>("ota_set_config", { autoCheck: otaAutoCheck.value });
    applyOtaState(s);
  } catch {
    /* ignore */
  }
}

async function checkOta() {
  otaBusy.value = true;
  try {
    const s = await api<OtaState>("ota_check");
    applyOtaState(s);
  } catch (e) {
    applyOtaState({
      status: "error",
      message: sanitizeOtaMessage(e instanceof Error ? e.message : String(e)),
    });
  } finally {
    otaBusy.value = false;
  }
}

async function downloadOta() {
  otaBusy.value = true;
  try {
    const s = await api<OtaState>("ota_download");
    applyOtaState(s);
  } catch (e) {
    applyOtaState({
      status: "error",
      message: sanitizeOtaMessage(e instanceof Error ? e.message : String(e)),
    });
  } finally {
    otaBusy.value = false;
  }
}

async function installOta() {
  otaBusy.value = true;
  try {
    await api("ota_install");
  } catch (e) {
    applyOtaState({
      status: "error",
      message: sanitizeOtaMessage(e instanceof Error ? e.message : String(e)),
    });
    otaBusy.value = false;
  }
}

/** 烧录/监听运行期间：排队到任务结束后再安装更新 */
async function queueInstallAfterTasks() {
  otaBusy.value = true;
  try {
    const s = await api<OtaState>("ota_install", { afterTasks: true });
    applyOtaState(s);
  } catch (e) {
    applyOtaState({
      status: "error",
      message: sanitizeOtaMessage(e instanceof Error ? e.message : String(e)),
    });
  } finally {
    otaBusy.value = false;
  }
}

function formatBytes(n: number) {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function sanitizeOtaMessage(msg: string) {
  return String(msg || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\bgithub\.com\b/gi, "")
    .replace(/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const otaStatusLabel = computed(() => {
  switch (ota.value.status) {
    case "checking":
      return "检查中";
    case "available":
      return "有新版本";
    case "up_to_date":
      return "已是最新";
    case "downloading":
      return "下载中";
    case "ready":
      return "可安装";
    case "error":
      return "出错";
    default:
      return "就绪";
  }
});

const otaStatusColor = computed(() => {
  switch (ota.value.status) {
    case "available":
    case "ready":
      return "primary" as const;
    case "up_to_date":
      return "success" as const;
    case "error":
      return "error" as const;
    case "checking":
    case "downloading":
      return "warning" as const;
    default:
      return "neutral" as const;
  }
});

let offEvent: (() => void) | null = null;

/** 水印延后，避免和水印以外的首屏抢主线程 */
const wmReady = ref(false);

/** Vue 首帧在隐藏窗口里画完后再通知主进程 show，避免「开窗瞬间」卡一下 */
async function signalUiReady() {
  await nextTick();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  try {
    await Promise.race([
      document.fonts?.ready ?? Promise.resolve(),
      new Promise((r) => setTimeout(r, 250)),
    ]);
  } catch {
    /* ignore */
  }
  warmSlotCompositor();
  window.ws63?.notifyUiReady?.();
}

function onVisibility() {
  logQueue.setBackground(document.visibilityState === "hidden");
}

function onWindowFocus() {
  logQueue.setBackground(false);
}

function onShellKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const inPopup = Boolean(document.querySelector("[role='listbox'], [role='menu']"));
  if (!escapeStopsFlash({
    flashing: flashRunning.value,
    key: event.key,
    repeat: event.repeat,
    defaultPrevented: event.defaultPrevented,
    targetTag: target?.tagName ?? "",
    editable: Boolean(target?.isContentEditable),
    inPopup,
  })) return;
  event.preventDefault();
  void stopFlash();
}

onMounted(async () => {
  loadPrefs();
  prefsReady = true;
  motionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
  syncReducedMotion();
  motionMedia.addEventListener("change", syncReducedMotion);
  narrowMedia = window.matchMedia("(max-width: 999px)");
  syncNarrowLayout();
  narrowMedia.addEventListener("change", syncNarrowLayout);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("keydown", onShellKeydown);
  onVisibility();

  void signalUiReady();

  setTimeout(() => {
    wmReady.value = true;
  }, 1200);

  if (!(await waitForBridge())) {
    bridgeError.value =
      "无法连接 Electron 后端。请从 release 目录运行 WS63BurnPro.exe。";
    return;
  }

  // W29-01：尽早拿到构建身份，让用户一眼看到“当前跑的到底是哪个版本/哪个路径”
  void (async () => {
    try {
      buildInfo.value = await api<BuildInfo>("get_build_info");
    } catch (e) {
      buildInfoError.value = e instanceof Error ? e.message : String(e);
    }
  })();

  offEvent = window.ws63!.onEvent((ev) => {
    if (ev.type === "log") {
      const ch = isFlashChannelId(ev.channel) ? ev.channel : null;
      const line = String((ev as { text?: string }).text ?? ev.message ?? "");
      appendSerialLog(line, ch);
    }
    if (ev.type === "flash_state" && ev.channels) {
      // 快照按通道代际过滤：旧任务代际更小的条目不得覆盖新任务
      const incoming = ev.channels as Record<FlashChannelId, FlashChannelState>;
      const filtered: Record<string, FlashChannelState> = {};
      for (const [id, state] of Object.entries(incoming)) {
        if (!isFlashChannelId(id)) continue;
        const rawGen = (state as { generation?: number }).generation;
        if (rawGen == null || !Number.isFinite(Number(rawGen))) {
          if (taskGate.applied(id) > 0) continue;
          filtered[id] = state;
          continue;
        }
        if (!taskGate.acceptEvent(id, Number(rawGen))) continue;
        filtered[id] = state;
      }
      if (Object.keys(filtered).length) {
        applyChannelSnapshot(filtered as Record<FlashChannelId, FlashChannelState>);
      }
    }
    if (ev.type === "flash_stage") {
      const ch = ev.channel;
      if (isFlashChannelId(ch) && channels.value[ch]) {
        // 阶段事件同样按代际过滤（旧任务的迟到阶段不得覆盖新任务）
        if (taskGate.acceptEvent(ch, Number(ev.generation ?? 0))) {
          channels.value[ch].stage = String(ev.stage ?? "");
          channels.value[ch].stageLabel = String(ev.stageLabel ?? "");
        }
      }
    }
    if (ev.type === "flash_done") {
      const ch = ev.channel;
      // 终态事件：旧代际不得覆盖新任务；同代重复终态只处理一次
      if (isFlashChannelId(ch) && !taskGate.acceptEvent(ch, Number(ev.generation ?? 0), true)) {
        // 旧代际的终态不能清掉新请求的 in-flight，也不能改当前画面
      } else if (isFlashChannelId(ch) && channels.value[ch]) {
        noteFlashFinished(ch, Number(ev.generation ?? Number.NaN));
        const outcome = String(ev.outcome ?? (ev.ok ? "success" : "failed"));
        const isSuccess = outcome === "success" && ev.ok === true;
        channelOutcome[ch] = outcome;
        channels.value[ch].running = false;
        channels.value[ch].pending = false;
        channels.value[ch].progress = isSuccess ? 100 : 0;
        channels.value[ch].status = (
          isSuccess ? "success" : outcome === "cancelled" ? "idle" : "error"
        ) as FlashChannelStatus;
        channels.value[ch].transferComplete = Boolean(ev.transferComplete);
        channels.value[ch].protocolConfirmed = Boolean(ev.protocolConfirmed);
        channels.value[ch].bootVerified = false;
        if (ev.ackPolicyLabel) channels.value[ch].ackPolicyLabel = String(ev.ackPolicyLabel);
        if (isSuccess) {
          channelErrorCode[ch] = "";
          channels.value[ch].errorMessage = "";
          channels.value[ch].stageLabel = "协议完成（启动未验证）";
          appendLocalLog(
            "协议完成（启动未验证）。请手动按 RST，从串口确认有没有启动日志。",
            "信息",
            ch,
          );
          if (ev.ackPolicyLabel) {
            appendLocalLog(
              `应答判定：${String(ev.ackPolicyLabel)}。这个策略没有验证应答命令字的含义。`,
              "信息",
              ch,
            );
          }
        } else if (outcome === "cancelled") {
          channelErrorCode[ch] = "";
          channels.value[ch].errorMessage = "";
          channels.value[ch].stageLabel = "已取消";
          appendLocalLog("已取消（不算成功）", "信息", ch);
        } else {
          const code = typeof ev.code === "string" ? ev.code : "";
          channelErrorCode[ch] = code === "IPC_UNTRUSTED_SENDER" ? "" : code;
          channels.value[ch].stageLabel = outcome === "partial" ? "未完全成功" : "失败";
          channels.value[ch].errorMessage = String(
            ev.message ?? (outcome === "partial" ? "文件已传完，但设备应答不完整" : "烧录失败"),
          );
          if (ev.stage && !channels.value[ch].errorMessage.includes(String(ev.stage))) {
            channels.value[ch].errorMessage =
              `${channels.value[ch].errorMessage}（阶段：${String(ev.stage)}）`;
          }
          appendLocalLog(channels.value[ch].errorMessage, "错误", ch);
        }
        if (isSuccess && ev.handoff) {
          serialPorts[ch] = channelPorts[ch] || serialPorts[ch];
          serialChannels.value[ch] = {
            ...serialChannels.value[ch],
            connected: true,
            port: serialPorts[ch],
            baudRate: Number(serialBauds[ch]) || 115200,
          };
          if (!flashRunning.value) activeSection.value = "monitor";
        }
      }
    }
    if (ev.type === "handshake_progress") {
      const ch = ev.channel;
      if (isFlashChannelId(ch) && !taskGate.acceptEvent(ch, Number(ev.generation ?? 0))) {
        // 旧代际的握手进度：丢弃（不得覆盖新任务的握手信息）
      } else if (isFlashChannelId(ch) && handshakeInfo[ch]) {
        handshakeInfo[ch] = {
          phase: String(ev.phase ?? ""),
          attempts: Number(ev.attempts ?? 0),
          elapsedMs: Number(ev.elapsedMs ?? 0),
          rxBytes: Number(ev.rxBytes ?? 0),
          lastCode: String(ev.lastCode ?? ""),
        };
      }
    }
    if (ev.type === "progress") {
      const ch = ev.channel;
      if (isFlashChannelId(ch) && channels.value[ch]) {
        offerProgress(
          ch,
          Number(ev.progress ?? 0),
          ev.partName != null ? String(ev.partName) : null,
          Number(ev.generation),
        );
      }
    }
    if (ev.type === "serial_state" && ev.serialChannels) {
      applySerialSnapshot(ev.serialChannels as Record<FlashChannelId, SerialChannelState>);
    }
    if (ev.type === "ota_state") {
      applyOtaState(ev as unknown as OtaState);
    }
  });

  // After window is visible; main process already warms SerialPort ~700ms.
  setTimeout(() => {
    void (async () => {
      try {
        await refreshPorts();
        await refreshState();
      } catch (e) {
        appendLocalLog(e instanceof Error ? e.message : String(e), "错误");
      }
    })();
  }, 1200);

  setTimeout(() => {
    void refreshOta().catch(() => {});
  }, 2500);
});

onUnmounted(() => {
  offEvent?.();
  if (slotAnimTimer) clearTimeout(slotAnimTimer);
  if (prefsSaveTimer) clearTimeout(prefsSaveTimer);
  if (progressFrame) cancelAnimationFrame(progressFrame);
  motionMedia?.removeEventListener("change", syncReducedMotion);
  narrowMedia?.removeEventListener("change", syncNarrowLayout);
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("focus", onWindowFocus);
  window.removeEventListener("keydown", onShellKeydown);
  logQueue.dispose();
});

watch(
  [
    flashSlotCount,
    monitorSlotCount,
    flashBaud,
    openMonitorAfterFlash,
    firmwarePaths,
    channelPorts,
    serialPorts,
    serialBauds,
  ],
  () => savePrefs(),
  { deep: true },
);

watch(flashSlotCount, () => {
  // onFlashSlotCountChange 已 bump；此处兜底 prefs / 其它赋值
  if (!slotAnimating.value) bumpSlotAnim();
});
watch(monitorSlotCount, () => {
  if (!slotAnimating.value) bumpSlotAnim();
});

watch(activeSection, async () => {
  // 串口页首进时卡片才挂载，需要再热一次
  slotCompositorWarmed = false;
  await nextTick();
  requestAnimationFrame(() => warmSlotCompositor());
});
</script>

<template>
  <UApp>
    <div
      class="ws-app"
      :class="{ 'is-flashing': flashRunning }"
    >
      <aside class="ws-sidebar" aria-label="主导航">
        <div class="ws-brand">
          <div class="ws-brand-title">WS63 烧录工作站 Pro</div>
          <div class="ws-brand-sub">固件烧录 · 串口监听 · 更新</div>
        </div>
        <div class="ws-sidebar-nav">
          <NavCapsule
            v-model="activeSection"
            :items="navItems"
            variant="rail"
            :primary="!narrowLayout"
          />
        </div>
        <div class="ws-sidebar-foot">
          <span class="chrome-status" aria-live="polite">
            <UBadge :color="statusMeta.color" variant="subtle" size="sm">
              {{ statusMeta.label }}
            </UBadge>
          </span>
          <ThemeQuickToggle />
        </div>
      </aside>

      <div class="ws-main-column">
        <header class="ws-topbar">
          <div class="min-w-0">
            <div class="ws-brand-title truncate">
              {{ navItems.find((n) => n.id === activeSection)?.label }}
            </div>
          </div>
          <div class="ws-topbar-meta">
            <span class="chrome-status" aria-live="polite">
              <UBadge :color="statusMeta.color" variant="subtle" size="sm">
                {{ statusMeta.label }}
              </UBadge>
            </span>
            <!-- W29-01：版本 + 运行来源必须一眼可见（防止“以为在用新版”） -->
            <UBadge
              v-if="buildInfo"
              :color="buildInfo.manifest.matchesPackageVersion ? 'neutral' : 'warning'"
              variant="outline"
              size="sm"
              :title="buildInfo.runtime.execPath"
            >
              v{{ buildInfo.version }} · {{ buildInfo.runtime.packaged ? "安装版" : "开发" }}
            </UBadge>
            <div v-if="narrowLayout" class="ws-topbar-actions">
              <ThemeQuickToggle />
            </div>
          </div>
        </header>

        <main class="ws-content">
        <UAlert
          v-if="bridgeError"
          class="m-4 shrink-0"
          color="error"
          variant="subtle"
          icon="i-lucide-plug-zap"
          :title="bridgeError"
        />

        <Transition name="section-fade" mode="out-in">
        <!-- 固件烧录 -->
        <div
          v-if="activeSection === 'flash'"
          id="section-panel-flash"
          key="flash"
          role="tabpanel"
          aria-labelledby="section-tab-flash"
          class="section-pane section-pad flash-workspace"
        >
          <FlashActionCard
            :state="primaryFlashPhase.state"
            :status-label="primaryFlashPhase.label"
            :detail="primaryFlashDetail"
            :target-label="multiFlash ? `${configuredFlashChannels.length} / ${flashSlotCount} 路已配置` : '单设备烧录'"
            :action-label="primaryFlashLabel"
            :active="anyFlashTaskActive"
            :can-start="primaryFlashCanStart"
            :progress="primaryFlashProgress"
            @activate="activatePrimaryFlash"
          />
          <div class="shrink-0 flex flex-col gap-3">
            <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
              <div class="min-w-0">
                <h1 class="text-xl font-semibold">烧录设置</h1>
                <p class="text-sm text-muted mt-1">
                  {{ multiFlash ? `${flashSlotCount} 路同屏` : "单设备烧录" }}
                  <span v-if="flashRunning" class="text-orange-600 font-medium"> · 烧录中</span>
                  <span v-if="flashSuccessCount" class="text-amber-700"> · 启动未验证 {{ flashSuccessCount }}</span>
                  <span v-if="flashErrorCount" class="text-red-600"> · 失败 {{ flashErrorCount }}</span>
                </p>
              </div>
              <!-- 主控件固定一组，路数变化时不左右挪位 -->
              <div class="command-bar">
                <div class="flex flex-col gap-1">
                  <span class="text-xs text-muted">完成后</span>
                  <div class="glass-seg">
                    <button
                      type="button"
                      :class="{ 'is-on': !openMonitorAfterFlash }"
                      :aria-pressed="!openMonitorAfterFlash"
                      :disabled="flashRunning"
                      @click="openMonitorAfterFlash = false"
                    >
                      仅烧录
                    </button>
                    <button
                      type="button"
                      :class="{ 'is-on': openMonitorAfterFlash }"
                      :aria-pressed="openMonitorAfterFlash"
                      :disabled="flashRunning"
                      @click="openMonitorAfterFlash = true"
                    >
                      进入监听
                    </button>
                  </div>
                </div>
                <UFormField label="设备数量" class="w-28 shrink-0">
                  <USelect
                    :model-value="flashSlotCount"
                    :items="CHANNEL_COUNT_OPTIONS"
                    value-key="value"
                    :disabled="flashRunning"
                    @update:model-value="onFlashSlotCountChange"
                  />
                </UFormField>
                <UFormField label="波特率" class="w-36 shrink-0">
                  <USelect v-model="flashBaud" :items="baudOptions" :disabled="flashRunning" />
                </UFormField>
                <UButton
                  class="shrink-0"
                  variant="outline"
                  color="neutral"
                  icon="i-lucide-refresh-cw"
                  @click="refreshPorts"
                >
                  刷新串口
                </UButton>
              </div>
            </div>
            <div class="command-bar">
              <UButton
                v-if="multiFlash"
                variant="soft"
                color="warning"
                icon="i-lucide-copy"
                :disabled="flashRunning || busy || !firmwarePaths['1']"
                @click="applyFirmwareToAll('1')"
              >
                固件同步到全部
              </UButton>
              <UButton
                v-if="flashErrorCount && !flashRunning"
                variant="soft"
                color="error"
                icon="i-lucide-rotate-cw"
                :loading="retryHeld"
                :disabled="busy"
                title="只重试当前失败的通道，不会自动开始"
                @click="retryFailedFlash"
              >
                重试失败（{{ flashErrorCount }}）
              </UButton>
              <UButton
                variant="outline"
                color="neutral"
                icon="i-lucide-file-down"
                :loading="exportHeld"
                :disabled="busy"
                title="导出脱敏诊断信息（不含固件内容、令牌、用户目录）"
                @click="exportDiagnostics"
              >
                导出诊断
              </UButton>
              <UButton
                v-if="flashRunning"
                color="error"
                icon="i-lucide-octagon-x"
                title="Esc 停止烧录"
                @click="stopFlash()"
              >
                停止烧录
              </UButton>
            </div>
            <p
              v-if="actionNotice"
              class="action-notice"
              :class="`is-${actionTone}`"
              role="status"
              aria-live="polite"
            >
              {{ actionNotice }}
            </p>
          </div>

          <Transition name="section-fade">
            <p
              v-if="openMonitorAfterFlash"
              key="handoff-tip"
              class="glass-tip shrink-0 text-xs rounded-2xl px-3.5 py-2.5"
            >
              烧录成功后将无缝进入串口监听。WS63 需手动按下板载 RST 才会看到启动日志；监听波特率使用「串口与日志」页各路设置。
            </p>
          </Transition>

            <div
              ref="flashSlotStageRef"
              class="flex-1 min-h-0 overflow-y-auto slot-stage pb-2"
            >
              <TransitionGroup
                name="slot-list"
                tag="div"
                :class="[
                  flashGridClass,
                  'slot-list-grid',
                  slotAnimating ? 'is-animating' : '',
                ]"
                @before-leave="onSlotBeforeLeave"
                @after-leave="onSlotAfterLeave"
              >
                <div
                  v-for="(meta, index) in activeFlashChannels"
                  :key="meta.id"
                  class="flash-card-compact rounded-2xl min-w-0 flex flex-col slot-list-item p-3.5 gap-2.5"
                  :style="{ '--i': String(index) }"
                  :class="[
                    channels[meta.id].running ? 'is-running' : '',
                    phaseOf(meta.id).id === 'unverified' ? 'is-unverified' : '',
                    channels[meta.id].status === 'error' ? 'is-error' : '',
                  ]"
                  @dragover.prevent
                  @drop="onFirmwareDrop(meta.id, $event)"
                >
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-1.5 min-w-0">
                  <UIcon
                    name="i-lucide-microchip"
                    class="size-4 shrink-0"
                    :class="channels[meta.id].running ? 'text-orange-500' : 'text-primary'"
                  />
                  <span class="font-semibold text-sm truncate">{{ meta.label }}</span>
                </div>
                <UBadge :color="flashStatusColor(meta.id)" variant="subtle" size="sm">
                  {{ flashStatusLabel(meta.id) }}
                </UBadge>
              </div>
              <p v-if="channelPorts[meta.id]" class="channel-meta">
                {{ channelPorts[meta.id] }} · {{ flashBaud }}
              </p>

              <div class="flex gap-1.5">
                <UInput
                  :model-value="firmwareBasename(firmwarePaths[meta.id])"
                  :placeholder="'拖入或选择 .fwpkg'"
                  class="flex-1 min-w-0"
                  size="sm"
                  readonly
                />
                <UButton
                  variant="outline"
                  color="neutral"
                  size="sm"
                  icon="i-lucide-folder-open"
                  :disabled="channels[meta.id].running"
                  aria-label="选择固件"
                  @click="pickFirmware(meta.id)"
                />
              </div>

              <USelect
                v-model="channelPorts[meta.id]"
                :items="portItems"
                placeholder="串口"
                size="sm"
                :disabled="channels[meta.id].running"
              />

              <div class="space-y-1">
                <div class="flex justify-between text-xs">
                  <span class="text-muted truncate">{{ flashProgressLabel(meta.id) }}</span>
                  <span class="font-mono tabular-nums">{{ channels[meta.id].progress }}%</span>
                </div>
                <UProgress
                  class="flash-progress"
                  :model-value="channels[meta.id].progress"
                  :color="channels[meta.id].status === 'error' ? 'error' : phaseOf(meta.id).id === 'idle' ? 'primary' : flashStatusColor(meta.id)"
                  :animation="false"
                  size="sm"
                />
                <!-- W29-02：等待按 RST 期间必须看得到阶段/已等待/尝试次数/已收字节 -->
                <p
                  v-if="channels[meta.id].running && (channels[meta.id].stage === 'wait_reset' || channels[meta.id].stage === 'handshake')"
                  class="text-xs text-amber-700 tabular-nums"
                >
                  {{ handshakeHint(meta.id) }}
                </p>
              </div>

              <div
                v-if="channels[meta.id].status === 'error' && channels[meta.id].errorMessage"
                class="channel-error"
                tabindex="0"
                :aria-label="`${meta.label}的错误`"
              >
                <p v-if="channelErrorCode[meta.id]" class="channel-error-code">{{ channelErrorCode[meta.id] }}</p>
                <p class="channel-error-text">{{ channels[meta.id].errorMessage }}</p>
                <p v-if="errorHint(meta.id)" class="channel-error-hint">{{ errorHint(meta.id) }}</p>
                <UButton
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  icon="i-lucide-copy"
                  :aria-label="`复制${meta.label}的错误`"
                  @click="copyError(meta.id)"
                >
                  复制错误
                </UButton>
              </div>

              <UButton
                v-if="canStopChannel(channelTaskState(meta.id))"
                block
                size="sm"
                color="error"
                variant="soft"
                icon="i-lucide-square"
                :aria-label="`停止${meta.label}`"
                @click="stopFlash(meta.id)"
              >
                停止
              </UButton>
              <div v-else class="flex gap-1.5">
                <UButton
                  block
                  class="flex-1"
                  size="sm"
                  :color="flashRunning ? 'warning' : 'primary'"
                  icon="i-lucide-upload"
                  :loading="busy"
                  :disabled="!firmwarePaths[meta.id] || !channelPorts[meta.id]"
                  @click="startChannelFlash(meta.id)"
                >
                  开始
                </UButton>
                <UButton
                  v-if="channels[meta.id].status === 'success'"
                  size="sm"
                  color="success"
                  variant="soft"
                  icon="i-lucide-terminal"
                  :loading="busy"
                  :disabled="!channelPorts[meta.id]"
                  @click="enterMonitor(meta.id)"
                >
                  监听
                </UButton>
              </div>
            </div>
              </TransitionGroup>
          </div>

          <div
            v-if="multiFlash"
            class="glass-footer shrink-0 relative z-10 w-full flex gap-2 pt-3 mt-1"
          >
            <UButton
              block
              class="flex-1"
              size="lg"
              color="warning"
              icon="i-lucide-play"
              :loading="busy"
              :disabled="!canParallelFlash"
              @click="startParallelFlash"
            >
              同时烧录已配置（{{ configuredFlashChannels.length }}）
            </UButton>
            <UButton
              v-if="flashRunning"
              block
              class="w-40"
              size="lg"
              color="error"
              variant="outline"
              icon="i-lucide-octagon-x"
              @click="stopFlash()"
            >
              停止全部
            </UButton>
          </div>
        </div>

        <!-- 串口与日志 -->
        <div
          v-else-if="activeSection === 'monitor'"
          id="section-panel-monitor"
          key="monitor"
          role="tabpanel"
          aria-labelledby="section-tab-monitor"
          class="section-pane section-pad"
        >
          <div class="shrink-0 flex flex-col gap-3">
            <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
              <div class="min-w-0">
                <h1 class="text-xl font-semibold">串口与日志</h1>
                <p class="text-sm text-muted mt-1">
                  {{ monitorSlotCount }} 路独立监听
                </p>
              </div>
              <div class="command-bar">
                <UFormField label="监听路数" class="w-28 shrink-0">
                  <USelect
                    :model-value="monitorSlotCount"
                    :items="CHANNEL_COUNT_OPTIONS"
                    value-key="value"
                    @update:model-value="onMonitorSlotCountChange"
                  />
                </UFormField>
              </div>
            </div>
            <div v-if="anySerialConnected" class="flex gap-2 flex-wrap">
              <UButton
                variant="outline"
                color="neutral"
                icon="i-lucide-unplug"
                @click="disconnectAllSerial"
              >
                全部断开
              </UButton>
            </div>
          </div>

          <div ref="monitorSlotStageRef" class="flex-1 min-h-0 overflow-y-auto slot-stage">
            <TransitionGroup
              name="slot-list"
              tag="div"
              :class="[
                monitorGridClass,
                'slot-list-grid',
                slotAnimating ? 'is-animating' : '',
              ]"
              @before-leave="onSlotBeforeLeave"
              @after-leave="onSlotAfterLeave"
            >
              <div
                v-for="(meta, index) in activeMonitorChannels"
                :key="meta.id"
                class="flash-card-compact flex flex-col min-h-[240px] min-w-0 gap-2.5 rounded-2xl p-3.5 slot-list-item"
                :style="{ '--i': String(index) }"
              >
                <div class="flex items-center justify-between gap-2 shrink-0">
                  <span class="font-semibold text-sm">{{ meta.label }}</span>
                  <UBadge
                    :color="monitorStatus(meta.id).tone === 'success' ? 'success' : 'neutral'"
                    variant="subtle"
                    size="sm"
                  >
                    {{ monitorStatus(meta.id).label }}
                  </UBadge>
                </div>
                <p v-if="serialPorts[meta.id]" class="channel-meta">
                  {{ serialPorts[meta.id] }}
                  <template v-if="serialChannels[meta.id].connected"> · {{ serialBauds[meta.id] }}</template>
                </p>
                <p
                  v-if="(serialChannels[meta.id].truncatedSegments ?? 0) > 0 || (serialChannels[meta.id].droppedChars ?? 0) > 0"
                  class="text-[11px] text-amber-600 leading-tight"
                >
                  输出过快：超长行已分段 {{ serialChannels[meta.id].truncatedSegments ?? 0 }} 次
                  <template v-if="(serialChannels[meta.id].droppedChars ?? 0) > 0">
                    ，显示队列已丢弃 {{ serialChannels[meta.id].droppedChars }} 字符
                  </template>
                  （日志可能不完整）
                </p>
                <div class="grid grid-cols-[minmax(0,1fr)_6.75rem] gap-2 shrink-0">
                  <USelect
                    v-model="serialPorts[meta.id]"
                    :items="portItems"
                    placeholder="串口"
                    size="sm"
                    :disabled="serialChannels[meta.id].connected"
                  />
                  <USelect
                    v-model="serialBauds[meta.id]"
                    :items="baudOptions"
                    size="sm"
                    :disabled="serialChannels[meta.id].connected"
                  />
                </div>
                <div class="flex gap-1.5 shrink-0">
                  <UButton
                    size="sm"
                    class="w-[4.75rem] shrink-0"
                    :color="serialChannels[meta.id].connected ? 'neutral' : 'primary'"
                    :variant="serialChannels[meta.id].connected ? 'outline' : 'solid'"
                    :icon="serialChannels[meta.id].connected ? 'i-lucide-unplug' : 'i-lucide-plug-zap'"
                    :loading="busy"
                    :disabled="channels[meta.id].running"
                    @click="toggleSerial(meta.id)"
                  >
                    {{ serialChannels[meta.id].connected ? "断开" : "连接" }}
                  </UButton>
                  <UInput
                    v-model="sendTexts[meta.id]"
                    placeholder="发送..."
                    size="sm"
                    class="min-w-0 flex-1"
                    :disabled="!serialChannels[meta.id].connected"
                    @keyup.enter="sendSerial(meta.id)"
                  />
                  <UButton
                    size="sm"
                    class="shrink-0"
                    variant="soft"
                    icon="i-lucide-send"
                    :disabled="!serialChannels[meta.id].connected || !sendTexts[meta.id].trim()"
                    @click="sendSerial(meta.id)"
                  />
                </div>
                <div class="flex-1 min-h-[120px] rounded-xl border border-slate-100/80 bg-white/55 flex flex-col overflow-hidden">
                  <div class="flex items-center justify-between px-2 py-1 border-b border-slate-100/80 shrink-0">
                    <span class="text-[11px] text-muted">日志</span>
                    <div class="flex items-center gap-0.5">
                      <UButton
                        variant="ghost"
                        color="neutral"
                        size="xs"
                        icon="i-lucide-download"
                        @click="exportLogs(meta.id)"
                      />
                      <UButton
                        variant="ghost"
                        color="neutral"
                        size="xs"
                        icon="i-lucide-trash-2"
                        @click="clearLogs(meta.id)"
                      />
                    </div>
                  </div>
                  <div
                    :ref="(el) => setLogPanelRef(meta.id, el)"
                    class="log-scroll-area flex-1 min-h-0 p-2 overflow-y-auto"
                    @scroll="onLogScroll(meta.id)"
                  >
                    <pre
                      v-if="logsByChannel[meta.id]"
                      class="log-text font-mono text-[11px] leading-[1.55] whitespace-pre text-slate-700"
                    >{{ logsByChannel[meta.id] }}</pre>
                    <p v-else class="text-[11px] text-muted py-4 text-center">暂无输出</p>
                  </div>
                </div>
              </div>
            </TransitionGroup>
          </div>
        </div>

        <!-- 关于与更新 -->
        <div
          v-else-if="activeSection === 'about'"
          id="section-panel-about"
          key="about"
          role="tabpanel"
          aria-labelledby="section-tab-about"
          class="section-pane section-pad overflow-y-auto"
        >
          <div>
            <h1 class="text-xl font-semibold">关于与更新</h1>
            <p class="text-sm text-muted mt-1">检查并安装软件更新</p>
          </div>

          <UCard variant="subtle">
            <div class="flex flex-wrap items-center gap-3 justify-between">
              <div>
                <p class="text-sm text-muted">当前版本</p>
                <p class="text-lg font-semibold font-mono">v{{ ota.currentVersion }}</p>
              </div>
              <UBadge :color="otaStatusColor" variant="subtle">
                {{ otaStatusLabel }}
              </UBadge>
            </div>
            <p v-if="ota.message" class="text-sm text-muted mt-3">{{ sanitizeOtaMessage(ota.message) }}</p>
            <p v-if="ota.latestVersion && ota.status === 'available'" class="text-sm mt-2">
              可更新至 <span class="font-mono">v{{ ota.latestVersion }}</span>
              <span v-if="ota.assetSize" class="text-muted">（{{ formatBytes(ota.assetSize) }}）</span>
            </p>
            <label class="flex items-center gap-2 text-sm mt-4">
              <input v-model="otaAutoCheck" type="checkbox" class="rounded border-slate-300" @change="saveOtaAutoCheck" />
              启动时自动检查更新
            </label>
          </UCard>

          <!-- W29-01：用户必须能看到“手里这份包到底是哪来的” -->
          <UCard variant="subtle">
            <p class="text-sm text-muted mb-2">本次运行的程序包</p>
            <div v-if="buildInfo" class="space-y-1 text-xs font-mono break-all">
              <p>版本：v{{ buildInfo.version }}（package.json v{{ buildInfo.packageVersion }}）</p>
              <p>模式：{{ buildInfo.runtime.packaged ? "安装/目录版" : "开发模式" }}</p>
              <p>可执行：{{ buildInfo.runtime.execPath }}</p>
              <p>应用目录：{{ buildInfo.runtime.appPath }}</p>
              <p v-if="buildInfo.builtAt">构建时间：{{ buildInfo.builtAt }}</p>
              <p v-if="buildInfo.sourceDigest">
                源码摘要：{{ buildInfo.sourceDigest.slice(0, 24) }}…
              </p>
              <p>
                构建清单：
                {{ buildInfo.manifest.found ? buildInfo.manifest.path : "未找到（旧构建或开发模式）" }}
              </p>
            </div>
            <p v-else class="text-xs text-muted">
              {{ buildInfoError || "读取中…" }}
            </p>
            <p
              v-for="w in buildInfo?.warnings ?? []"
              :key="w"
              class="text-xs text-amber-700 mt-1"
            >
              ⚠ {{ w }}
            </p>
          </UCard>

          <div v-if="ota.status === 'downloading'" class="space-y-2 max-w-2xl">
            <div class="flex justify-between text-sm">
              <span class="text-muted">下载进度</span>
              <span class="font-mono">{{ ota.progress }}%</span>
            </div>
            <UProgress :value="ota.progress" />
          </div>

          <div class="flex flex-col sm:flex-row gap-2 max-w-2xl">
            <UButton
              block
              size="lg"
              icon="i-lucide-refresh-cw"
              :loading="otaBusy && ota.status === 'checking'"
              :disabled="otaBusy && ota.status === 'downloading'"
              @click="checkOta"
            >
              检查更新
            </UButton>
            <UButton
              block
              size="lg"
              color="primary"
              variant="soft"
              icon="i-lucide-download"
              :loading="otaBusy && ota.status === 'downloading'"
              :disabled="ota.status !== 'available' && ota.status !== 'ready'"
              @click="downloadOta"
            >
              下载更新
            </UButton>
            <UButton
              block
              size="lg"
              color="primary"
              icon="i-lucide-rocket"
              :loading="otaBusy && ota.status === 'ready'"
              :disabled="ota.status !== 'ready' || !ota.packaged || tasksActive"
              @click="installOta"
            >
              安装并重启
            </UButton>
          </div>

          <div v-if="tasksActive" class="max-w-2xl space-y-2">
            <UAlert
              color="warning"
              variant="subtle"
              title="烧录或串口监听进行中，已阻止安装与退出"
              description="安装更新会重启应用并中断当前任务。可先结束任务，或选择“任务结束后安装”。"
              icon="i-lucide-shield-alert"
            />
            <UButton
              block
              size="md"
              color="warning"
              variant="soft"
              icon="i-lucide-clock"
              :loading="otaBusy"
              :disabled="ota.status !== 'ready' || !ota.packaged"
              @click="queueInstallAfterTasks"
            >
              任务结束后安装
            </UButton>
          </div>

          <AppearancePicker />

          <p class="text-xs text-slate-400">版权归 Softlipaaa 所有 · 最多支持 10 路设备</p>
        </div>
        </Transition>
        </main>
      </div>

      <nav class="ws-dock" aria-label="移动导航">
        <NavCapsule
          v-model="activeSection"
          :items="navItems"
          variant="dock"
          :primary="narrowLayout"
        />
      </nav>
    </div>
      <div v-if="wmReady" class="wm-layer" aria-hidden="true">
        <div class="wm-diagonal">
          <span v-for="n in 24" :key="n">版权归 Softlipaaa 所有</span>
        </div>
        <div class="wm-corner">版权归 Softlipaaa 所有</div>
      </div>
  </UApp>
</template>
