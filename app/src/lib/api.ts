export const MAX_FLASH_CHANNELS = 10;

export const FLASH_CHANNEL_IDS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
] as const;

export type FlashChannelId = (typeof FLASH_CHANNEL_IDS)[number];

export type FlashChannelStatus = "idle" | "running" | "success" | "error";

export type FlashChannelState = {
  running: boolean;
  /** 已同步占位但尚未真正开始烧录（W29-05 的通道门禁阶段） */
  pending?: boolean;
  port: string;
  progress: number;
  partName: string;
  /** 协议阶段（wait_reset / handshake / erase / partition_transfer / finish / reset ...） */
  stage?: string;
  stageLabel?: string;
  status: FlashChannelStatus;
  errorMessage: string;
  /** 文件传输完成 / 协议确认完成 / 设备启动验证（无启动协议时恒为 false） */
  transferComplete?: boolean;
  protocolConfirmed?: boolean;
  bootVerified?: boolean;
  /** 本轮应答判定策略及其标签（证据边界：语义是否已由协议证据确认） */
  ackPolicy?: string;
  ackPolicyLabel?: string;
  /** 控制线策略：默认 none = 从未调用 set()，没有拨动 RTS/DTR */
  portLines?: string;
  handshakeAttempts?: number;
  handshakeRxBytes?: number;
};

/** 烧录结论（W29-07）：成功 / 部分（传完但应答不全）/ 失败 / 取消 */
export type FlashOutcome = "success" | "partial" | "failed" | "cancelled";

export type BuildInfo = {
  version: string;
  product: string;
  packageVersion: string;
  builtAt: string;
  sourceDigest: string;
  manifest: {
    found: boolean;
    path: string;
    matchesPackageVersion: boolean;
    error?: string;
  };
  runtime: {
    packaged: boolean;
    execPath: string;
    appPath: string;
    resourcesPath: string;
    fromAsar: boolean;
  };
  warnings: string[];
};

export type SerialChannelState = {
  connected: boolean;
  port: string;
  baudRate: number;
  /** 超长行被分段输出的次数（W03：有限缓冲，不静默吞数据） */
  truncatedSegments?: number;
  /** 显示队列丢弃的字符数 */
  droppedChars?: number;
  pendingChars?: number;
};

export type AppState = {
  logs: string[];
  flashRunning: boolean;
  channels: Record<FlashChannelId, FlashChannelState>;
  serialConnected: boolean;
  serialChannels: Record<FlashChannelId, SerialChannelState>;
};

export type PortInfo = {
  path: string;
  label: string;
};

declare global {
  interface Window {
    ws63?: {
      call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
      notifyUiReady?: () => void;
      /** Electron 34 拖拽取路径（preload 内 webUtils.getPathForFile） */
      getPathForFile?: (file: File) => string;
      onEvent(cb: (payload: Record<string, unknown>) => void): () => void;
    };
  }
}

export async function api<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  if (!window.ws63?.call) {
    throw new Error("无法连接 Electron 后端，请从 release 目录运行 WS63BurnPro.exe");
  }
  return window.ws63.call<T>(method, params);
}

export const FLASH_CHANNEL_META: { id: FlashChannelId; label: string }[] =
  FLASH_CHANNEL_IDS.map((id) => ({ id, label: `设备 ${id}` }));

export const CHANNEL_COUNT_OPTIONS = Array.from({ length: MAX_FLASH_CHANNELS }, (_, i) => {
  const n = i + 1;
  return { label: `${n} 路`, value: n };
});

export function defaultChannelState(): FlashChannelState {
  return {
    running: false,
    port: "",
    progress: 0,
    partName: "",
    stage: "",
    stageLabel: "",
    status: "idle",
    errorMessage: "",
    transferComplete: false,
    protocolConfirmed: false,
    bootVerified: false,
  };
}

export function defaultChannels(): Record<FlashChannelId, FlashChannelState> {
  return Object.fromEntries(
    FLASH_CHANNEL_IDS.map((id) => [id, defaultChannelState()]),
  ) as Record<FlashChannelId, FlashChannelState>;
}

export function defaultSerialChannels(): Record<FlashChannelId, SerialChannelState> {
  return Object.fromEntries(
    FLASH_CHANNEL_IDS.map((id) => [
      id,
      { connected: false, port: "", baudRate: 115200, truncatedSegments: 0, droppedChars: 0 },
    ]),
  ) as Record<FlashChannelId, SerialChannelState>;
}

export function emptyChannelStrings(): Record<FlashChannelId, string> {
  return Object.fromEntries(FLASH_CHANNEL_IDS.map((id) => [id, ""])) as Record<
    FlashChannelId,
    string
  >;
}

export function emptyChannelBauds(defaultBaud = "115200"): Record<FlashChannelId, string> {
  return Object.fromEntries(
    FLASH_CHANNEL_IDS.map((id) => [id, defaultBaud]),
  ) as Record<FlashChannelId, string>;
}

export function emptyChannelLogs(): Record<FlashChannelId, string[]> {
  return Object.fromEntries(FLASH_CHANNEL_IDS.map((id) => [id, [] as string[]])) as Record<
    FlashChannelId,
    string[]
  >;
}

export function firmwareBasename(path: string): string {
  if (!path) return "";
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? path;
}

export function isFlashChannelId(value: unknown): value is FlashChannelId {
  return typeof value === "string" && (FLASH_CHANNEL_IDS as readonly string[]).includes(value);
}
