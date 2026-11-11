/** 给 node:test 直接加载的前端模块补类型。运行时仍是同目录的 .js。 */

declare module "@/lib/error-hint.js" {
  export function hintForErrorCode(code: string): string;
  export function describeFailure(error: unknown): {
    code: string;
    message: string;
    hidden: boolean;
    hint: string;
  };
}

declare module "@/lib/keyboard-nav.js" {
  export function nextTabIndex(current: number, key: string, length: number): number | null;
  export function escapeStopsFlash(input: {
    flashing: boolean;
    key: string;
    repeat?: boolean;
    defaultPrevented?: boolean;
    targetTag?: string;
    editable?: boolean;
    inPopup?: boolean;
  }): boolean;
}

declare module "@/lib/log-queue.js" {
  export interface LogQueueItem {
    text: string;
    channel: string | null;
  }
  export interface LogQueue {
    enqueue(text: string, channel?: string | null): void;
    setBackground(hidden: boolean): void;
    clear(): void;
    dispose(): void;
    stats(): { parts: number; chars: number; dropped: number };
    hasPending(): boolean;
    flushBatch(): boolean;
  }
  export function createLogQueue(options: {
    onFlush: (items: LogQueueItem[], meta: { dropped: number }) => void;
    onResume?: () => void;
  }): LogQueue;
}

declare module "@/lib/progress-guard.js" {
  export interface ProgressPatch {
    channel: string;
    progress: number;
    partName?: string;
    mainGeneration?: number;
  }
  export interface ProgressGuard {
    begin(channel: string): void;
    seal(channel: string, generation?: number): void;
    offer(
      channel: string,
      progress: number,
      partName?: string | null,
      generation?: number,
    ): { accepted: boolean; reason?: string; generation?: number };
    drain(): { applied: ProgressPatch[]; dropped: string[] };
    isSealed(channel: string): boolean;
    pendingCount(): number;
  }
  export function createProgressGuard(): ProgressGuard;
  export function mergeSealedChannel<T extends { bootVerified?: boolean; running?: boolean; status?: string; progress?: number; stageLabel?: string }>(
    local: T | undefined,
    incoming: T | undefined,
    sealed: boolean,
  ): T;
}

declare module "@/lib/retry-action.js" {
  export interface RetryRow {
    id: string;
    status: string;
    running?: boolean;
    pending?: boolean;
    firmwarePath?: string;
    port?: string;
  }
  export interface RetrySkip {
    channel: string;
    reason: string;
  }
  export interface RetryResult {
    ok: boolean;
    started: string[];
    skipped: RetrySkip[];
    reason: string;
    inFlight: boolean;
    tokens: Record<string, string> | null;
    generations: Record<string, number> | null;
  }
  export function selectRetryChannels(rows: RetryRow[]): {
    selected: RetryRow[];
    skipped: RetrySkip[];
  };
  export function runUserRetry(input: {
    rows: RetryRow[];
    gate: { current: boolean };
    invoke: (rows: RetryRow[]) => Promise<{
      ok?: boolean;
      started?: string[];
      skipped?: RetrySkip[];
      reason?: string;
      tokens?: Record<string, string> | null;
      generations?: Record<string, number> | null;
    }>;
  }): Promise<RetryResult>;
  export function runDiagnosticExport(input: {
    gate: { current: boolean };
    invoke: () => Promise<{ ok?: boolean; cancelled?: boolean; bytes?: number; reason?: string }>;
  }): Promise<{
    ok: boolean;
    inFlight: boolean;
    cancelled: boolean;
    bytes: number;
    reason: string;
  }>;
}

declare module "@/lib/slot-motion.js" {
  export function slotAnimDuration(reduced: boolean): number;
  export function shouldPopLeavingSlot(reduced: boolean): boolean;
}

declare module "@/lib/station-phase.js" {
  export interface PhaseView {
    id: string;
    label: string;
    tone: string;
  }
  export function flashPhase(channel: unknown, outcome?: string): PhaseView;
  export function monitorPhase(serial: { connected?: boolean; portSelected?: boolean }): PhaseView;
  export function globalPhase(input: { phases: PhaseView[]; listening: number }): PhaseView;
  export function progressCaption(channel: unknown, outcome?: string): string;
}
