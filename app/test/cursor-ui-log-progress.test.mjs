/**
 * 前端日志队列、终态进度、失败重试和界面约束。
 * 用生产模块 + 假调度 / 假 bridge，不打开窗口，不碰串口。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

import {
  DEFAULT_MAX_PENDING_LOG_CHARS,
  DEFAULT_MAX_PENDING_LOG_PARTS,
  createLogQueue,
} from "../src/lib/log-queue.js";
import { createProgressGuard, mergeSealedChannel } from "../src/lib/progress-guard.js";
import { runDiagnosticExport, runUserRetry, selectRetryChannels } from "../src/lib/retry-action.js";
import { escapeStopsFlash, nextTabIndex } from "../src/lib/keyboard-nav.js";
import { flashPhase, globalPhase, monitorPhase, progressCaption } from "../src/lib/station-phase.js";
import { describeFailure } from "../src/lib/error-hint.js";
import { shouldPopLeavingSlot, slotAnimDuration } from "../src/lib/slot-motion.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appVue = readFileSync(join(root, "src/App.vue"), "utf8");
const css = readFileSync(join(root, "src/assets/css/main.css"), "utf8");
const retrySrc = readFileSync(join(root, "src/lib/retry-action.js"), "utf8");

function harness(options = {}) {
  const frames = [];
  const timers = [];
  let seq = 1;
  const flushed = [];
  const queue = createLogQueue({
    ...options,
    scheduleFrame(cb) {
      const id = seq++;
      frames.push({ id, cb, cancelled: false });
      return id;
    },
    cancelFrame(id) {
      const found = frames.find((frame) => frame.id === id);
      if (found) found.cancelled = true;
    },
    scheduleTimer(cb) {
      const id = seq++;
      timers.push({ id, cb, cancelled: false });
      return id;
    },
    cancelTimer(id) {
      const found = timers.find((timer) => timer.id === id);
      if (found) found.cancelled = true;
    },
    onFlush(items, meta) {
      flushed.push({
        text: items.map((item) => item.text).join(""),
        channels: items.map((item) => item.channel),
        dropped: meta.dropped,
      });
    },
  });
  return {
    queue,
    flushed,
    frames,
    timers,
    fireFrame() {
      const frame = frames.shift();
      if (!frame || frame.cancelled) {
        frame?.cb();
        return false;
      }
      frame.cb();
      return true;
    },
    fireTimer() {
      const timer = timers.find((item) => !item.cancelled);
      if (!timer) return false;
      timer.cancelled = true;
      timer.cb();
      return true;
    },
  };
}

test("日志队列同时限制条数和字节，超长单条直接丢", () => {
  const { queue, flushed } = harness({ maxParts: 3, maxChars: 20, batchParts: 10, batchChars: 100 });
  queue.setBackground(true);
  for (let i = 0; i < 8; i += 1) queue.enqueue(`line-${i}-xxxx`, "1");
  const stats = queue.stats();
  assert.ok(stats.parts <= 3);
  assert.ok(stats.chars <= 20);
  assert.ok(stats.dropped > 0);
  queue.enqueue("this-piece-is-definitely-longer-than-the-cap", "2");
  assert.equal(queue.stats().parts <= 3, true);
  assert.ok(flushed.some((item) => item.dropped > 0));
  queue.dispose();
});

test("隐藏时不依赖 rAF；回到前台后补刷，且清空后不会复活", () => {
  const { queue, flushed, frames, fireFrame, fireTimer } = harness({
    maxParts: 20,
    maxChars: 200,
    batchParts: 1,
    batchChars: 50,
  });
  queue.setBackground(true);
  queue.enqueue("aaa\n", "1");
  queue.enqueue("bbb\n", "2");
  const stale = frames[0];
  assert.equal(flushed.length, 0, "隐藏期间假 rAF 还没跑，不能先刷");
  if (stale) stale.cb();
  assert.equal(flushed.length, 0, "被取消的 rAF 不能把队列刷掉或刷重");
  assert.equal(fireTimer(), true);
  assert.match(flushed.map((item) => item.text).join(""), /aaa/);
  queue.setBackground(false);
  let guard = 0;
  while (queue.hasPending() && guard < 10) {
    fireFrame();
    guard += 1;
  }
  const text = flushed.map((item) => item.text).join("");
  assert.match(text, /aaa/);
  assert.match(text, /bbb/);
  queue.clear();
  fireFrame();
  fireTimer();
  const after = flushed.map((item) => item.text).join("");
  assert.equal(after, text, "清空之后迟到的帧不能把旧日志写回来");
  queue.dispose();
});

test("终态之后的迟到进度不能覆盖，新任务可以重新接收", () => {
  const guard = createProgressGuard();
  guard.begin("1");
  assert.equal(guard.offer("1", 40, "loader").accepted, true);
  guard.offer("1", 55, null);
  guard.seal("1");
  assert.deepEqual(guard.drain().applied, []);
  assert.equal(guard.offer("1", 99, "late").accepted, false);
  assert.equal(guard.drain().applied.length, 0);
  guard.begin("1");
  guard.offer("1", 10, "part");
  guard.offer("1", 20);
  const applied = guard.drain().applied;
  assert.equal(applied.length, 1);
  assert.equal(applied[0].progress, 20);
  assert.equal(applied[0].partName, "part");

  const local = { progress: 100, stageLabel: "协议完成（启动未验证）", status: "success", running: false };
  const lateRunning = mergeSealedChannel(local, { progress: 40, status: "running", running: true, stageLabel: "传输" }, true);
  assert.equal(lateRunning.progress, 100);
  assert.equal(lateRunning.status, "success");
  const lateTerminal = mergeSealedChannel(local, { progress: 80, status: "success", running: false, stageLabel: "分区", errorMessage: "" }, true);
  assert.equal(lateTerminal.progress, 100);
  assert.equal(lateTerminal.stageLabel, "协议完成（启动未验证）");
  assert.equal(lateTerminal.bootVerified, false);
});

test("重试只提交失败通道，进行中的第二次不会再调用 bridge", async () => {
  const rows = [
    { id: "1", status: "success", running: false, pending: false, firmwarePath: "a.fwpkg", port: "COM1" },
    { id: "2", status: "error", running: false, pending: false, firmwarePath: "a.fwpkg", port: "COM2" },
    { id: "3", status: "error", running: true, pending: false, firmwarePath: "a.fwpkg", port: "COM3" },
    { id: "4", status: "idle", running: false, pending: false, firmwarePath: "a.fwpkg", port: "COM4" },
    { id: "5", status: "error", running: false, pending: false, firmwarePath: "", port: "COM5" },
  ];
  const calls = [];
  let release;
  const gate = { current: false };
  const first = runUserRetry({
    rows,
    gate,
    invoke: (chosen) => new Promise((resolve) => {
      calls.push(chosen.map((row) => row.id));
      release = resolve;
    }),
  });
  const second = await runUserRetry({
    rows,
    gate,
    invoke: () => {
      calls.push("second");
      return { ok: true, started: [] };
    },
  });
  assert.equal(second.inFlight, true);
  assert.deepEqual(calls, [["2"]]);
  release({ ok: true, started: ["2"], skipped: [] });
  const done = await first;
  assert.deepEqual(done.started, ["2"]);
  assert.equal(gate.current, false);

  const skippedOnly = await runUserRetry({
    rows: rows.filter((row) => row.status !== "error" || row.running || !row.firmwarePath),
    gate,
    invoke: () => {
      throw new Error("不应启动烧录");
    },
  });
  assert.equal(skippedOnly.ok, false);
  assert.equal(skippedOnly.started.length, 0);
});

test("诊断导出的取消和失败都不是成功，重复点击不会发第二次", async () => {
  const gate = { current: false };
  const cancelled = await runDiagnosticExport({
    gate,
    invoke: async () => ({ ok: false, cancelled: true }),
  });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.cancelled, true);
  const rejected = await runDiagnosticExport({
    gate,
    invoke: async () => ({ ok: false, reason: "没有写入权限" }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.cancelled, false);
  assert.match(rejected.reason, /没有写入权限/);

  let release;
  const pending = runDiagnosticExport({
    gate,
    invoke: () => new Promise((resolve) => {
      release = resolve;
    }),
  });
  const again = await runDiagnosticExport({
    gate,
    invoke: async () => ({ ok: true, bytes: 1 }),
  });
  assert.equal(again.inFlight, true);
  release({ ok: true, bytes: 24 });
  const done = await pending;
  assert.equal(done.ok, true);
  assert.equal(done.bytes, 24);

  const failed = await runDiagnosticExport({
    gate,
    invoke: async () => {
      throw new Error("磁盘满");
    },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /磁盘满/);
  assert.equal(retrySrc.includes("start_flash"), false);
});

test("状态文案把监听、等待复位、握手、烧录和启动未验证分开", () => {
  assert.equal(flashPhase({ running: true, stage: "wait_reset" }).label, "等待按 RST");
  assert.equal(flashPhase({ running: true, stage: "handshake" }).label, "正在握手");
  assert.equal(flashPhase({ running: true, stage: "baud_switch" }).label, "握手成功");
  assert.equal(flashPhase({ running: true, stage: "partition_transfer" }).label, "正在烧录");
  assert.equal(flashPhase({ status: "success" }, "success").label, "启动未验证");
  assert.equal(flashPhase({ status: "success" }, "success").tone, "warning");
  assert.equal(progressCaption({ status: "success" }, "success"), "协议完成（启动未验证）");
  assert.equal(flashPhase({ status: "error" }, "partial").label, "未完全成功");
  assert.equal(flashPhase({ status: "idle" }, "cancelled").label, "已取消");
  assert.equal(monitorPhase({ connected: true }).label, "正在监听");
  assert.equal(monitorPhase({ connected: false, portSelected: true }).label, "串口已选择");
  const global = globalPhase({
    phases: [flashPhase({ running: true, stage: "wait_reset" })],
    listening: 1,
  });
  assert.equal(global.label, "等待按 RST");
  const listening = globalPhase({ phases: [flashPhase({})], listening: 1 });
  assert.equal(listening.label, "正在监听");
  assert.notEqual(listening.label, "串口已连接");
});

test("键盘：方向键切换分页，输入框和弹出层里的 Esc 不停止烧录", () => {
  assert.equal(nextTabIndex(0, "ArrowRight", 3), 1);
  assert.equal(nextTabIndex(0, "ArrowLeft", 3), 2);
  assert.equal(nextTabIndex(2, "Home", 3), 0);
  assert.equal(nextTabIndex(0, "End", 3), 2);
  assert.equal(nextTabIndex(0, "a", 3), null);
  assert.equal(escapeStopsFlash({ flashing: true, key: "Escape" }), true);
  assert.equal(escapeStopsFlash({ flashing: false, key: "Escape" }), false);
  assert.equal(escapeStopsFlash({ flashing: true, key: "Escape", targetTag: "INPUT" }), false);
  assert.equal(escapeStopsFlash({ flashing: true, key: "Escape", inPopup: true }), false);
  assert.equal(slotAnimDuration(true) < slotAnimDuration(false), true);
  assert.equal(shouldPopLeavingSlot(true), false);
  const hidden = describeFailure({ code: "IPC_UNTRUSTED_SENDER", message: "nope" });
  assert.equal(hidden.hidden, true);
  const hint = describeFailure({ code: "HANDSHAKE_TIMEOUT", message: "超时" });
  assert.match(hint.hint, /RST/);
});

test("界面保留毛玻璃关闭、减少动效、焦点和停止/导出入口", () => {
  assert.match(css, /\.slot-list-grid\.is-animating \.flash-card-compact[\s\S]*backdrop-filter:\s*none !important/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /max-width:\s*720px/);
  assert.match(css, /\.channel-error-text[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(appVue, /slotAnimating \? 'is-animating'/);
  assert.match(appVue, /停止烧录/);
  assert.match(appVue, /导出诊断/);
  assert.match(appVue, /aria-live="polite"/);
  const script = appVue.slice(0, appVue.indexOf("<template>"));
  assert.equal((script.match(/retryFailedFlash\s*\(/g) || []).length, 1);
  assert.equal(script.includes("start_flash_parallel"), true);
  assert.equal((script.match(/retry_failed_channels/g) || []).length >= 1, true);
  const selection = selectRetryChannels([
    { id: "9", status: "success", running: false, pending: false, firmwarePath: "a", port: "COM9" },
  ]);
  assert.equal(selection.selected.length, 0);
});

test("同输入对比：无上限堆积、一次清空、分批刷新", () => {
  const line = `${"x".repeat(160)}\n`;
  const count = 20000;
  function drain(queue, onApply) {
    let batches = 0;
    let maxApply = 0;
    let totalApply = 0;
    let delivered = 0;
    const started = performance.now();
    let guard = 0;
    while (queue.hasPending() && guard < 100000) {
      const before = performance.now();
      queue.flushBatch();
      const elapsed = performance.now() - before;
      if (onApply) {
        /* flushBatch 内部已经计时；这里只数批次数 */
      }
      maxApply = Math.max(maxApply, elapsed);
      totalApply += elapsed;
      batches += 1;
      guard += 1;
    }
    return {
      batches,
      maxApplyMs: maxApply,
      totalApplyMs: totalApply,
      drainMs: performance.now() - started,
      delivered,
    };
  }

  function ingest(options, apply) {
    let delivered = 0;
    const queue = createLogQueue({
      ...options,
      scheduleFrame: () => 1,
      cancelFrame: () => {},
      scheduleTimer: () => 1,
      cancelTimer: () => {},
      onFlush(items) {
        const started = performance.now();
        let sink = "";
        for (const item of items) sink += item.text;
        if (sink.length > 80_000) sink = sink.slice(-80_000);
        delivered += sink.length;
        apply.push(performance.now() - started);
      },
    });
    queue.setBackground(true);
    const started = performance.now();
    for (let i = 0; i < count; i += 1) queue.enqueue(line, String((i % 10) + 1));
    const ingestMs = performance.now() - started;
    const peak = queue.stats();
    const applySamples = [];
    const result = drain(queue);
    // drain() 的 flush 已经走过 onFlush，applySamples 在上面的闭包里
    void applySamples;
    const payload = {
      ingestMs,
      peakChars: peak.chars,
      peakParts: peak.parts,
      dropped: peak.dropped,
      batches: result.batches,
      maxApplyMs: result.maxApplyMs,
      totalApplyMs: result.totalApplyMs,
      delivered,
    };
    queue.dispose();
    return payload;
  }

  const applyA = [];
  const unbounded = ingest({
    maxParts: 1_000_000,
    maxChars: 64 * 1024 * 1024,
    batchParts: 1_000_000,
    batchChars: 64 * 1024 * 1024,
  }, applyA);
  const applyB = [];
  const singleFlush = ingest({
    batchParts: 1_000_000,
    batchChars: 64 * 1024 * 1024,
  }, applyB);
  const applyC = [];
  const batched = ingest({}, applyC);

  assert.ok(unbounded.peakChars > DEFAULT_MAX_PENDING_LOG_CHARS);
  assert.ok(singleFlush.peakChars <= DEFAULT_MAX_PENDING_LOG_CHARS);
  assert.ok(singleFlush.peakParts <= DEFAULT_MAX_PENDING_LOG_PARTS);
  assert.ok(batched.peakChars <= DEFAULT_MAX_PENDING_LOG_CHARS);
  assert.ok(batched.peakParts <= DEFAULT_MAX_PENDING_LOG_PARTS);
  assert.equal(singleFlush.batches, 1);
  assert.ok(batched.batches > 1);
  assert.equal(batched.dropped * line.length + batched.peakChars, count * line.length);
  assert.equal(singleFlush.dropped * line.length + singleFlush.peakChars, count * line.length);

  const report = {
    machine: os.cpus()[0]?.model ?? "unknown",
    node: process.version,
    input: `${count} 行 × ${line.length} 字符，10 路轮转，隐藏且不跑 rAF`,
    unboundedPeakChars: unbounded.peakChars,
    singleFlush: {
      peakChars: singleFlush.peakChars,
      dropped: singleFlush.dropped,
      batches: singleFlush.batches,
      maxApplyMs: Number(singleFlush.maxApplyMs.toFixed(3)),
      totalApplyMs: Number(singleFlush.totalApplyMs.toFixed(3)),
      ingestMs: Number(singleFlush.ingestMs.toFixed(3)),
    },
    batched: {
      peakChars: batched.peakChars,
      dropped: batched.dropped,
      batches: batched.batches,
      maxApplyMs: Number(batched.maxApplyMs.toFixed(3)),
      totalApplyMs: Number(batched.totalApplyMs.toFixed(3)),
      ingestMs: Number(batched.ingestMs.toFixed(3)),
    },
  };
  console.log(`CURSOR_PERF ${JSON.stringify(report)}`);
});
