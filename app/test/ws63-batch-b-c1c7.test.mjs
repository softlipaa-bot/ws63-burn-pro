/**
 * 批次 WS63-20261029-B / A 阶段：C1~C7 的永久回归。
 *
 * 覆盖：
 *  - C1/C2/C3：代际闸门（启动响应不得复活同代终态、pending 可停止、跨任务乱序）
 *  - C4：接管关闭未确认时不得打开新句柄（真实 monitor + ownership 模块）
 *  - C5：脱敏三例（编码查询键 / 含空格用户名 / JSON 转义键）
 *  - C6：日志队列按 UTF-8 字节计预算（汉字/emoji），字符指标保留
 *  - C7：离线图标集合覆盖源码里所有 i-lucide-*，且 gen-icons --check 通过
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  anyTaskActive,
  canStopChannel,
  createGenerationGate,
} from "../src/lib/task-generation.ts";
import { createLogQueue, utf8Bytes, DEFAULT_MAX_PENDING_LOG_BYTES } from "../src/lib/log-queue.js";
import { redactText } from "../electron/diagnostics.js";
import { __setPortFactory, abortAllMonitors, connectMonitor, closeMonitorForTakeover } from "../electron/serial/monitor.js";
import { OWNER_KIND, holderOf, resetRegistry } from "../electron/serial/ownership.js";
import { clearQuarantine } from "../electron/serial/port-lifecycle.js";
import { sleep } from "./fake-serial-port.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");

/* ------------------------------------------------ C3：跨任务乱序（可复现） */

test("C3: 上一轮迟到事件不得覆盖新任务（快照/阶段/进度/终态一致过滤）", () => {
  const gate = createGenerationGate();

  // 第一轮 gen=4 结束
  assert.equal(gate.acceptStart("1", 4), true);
  assert.equal(gate.acceptEvent("1", 4, true), true);

  // 第二轮 gen=5 开始
  assert.equal(gate.acceptStart("1", 5), true);

  // 上一轮的四种事件全部迟到到达 → 一律丢弃
  assert.equal(gate.acceptEvent("1", 4), false, "旧 progress/flash_state 必须丢弃");
  assert.equal(gate.acceptEvent("1", 4, true), false, "旧 flash_done 必须丢弃");

  // 新一轮事件正常采纳
  assert.equal(gate.acceptEvent("1", 5), true);
});

test("C3: 事件先于 IPC 响应到达时采纳新代，随后响应被接受", () => {
  const gate = createGenerationGate();
  assert.equal(gate.acceptEvent("2", 9), true, "未知代际的更新事件应先采纳");
  assert.equal(gate.acceptStart("2", 9), true, "随后同代启动响应接受");
});

/* ------------------------------------- C1：启动响应不得复活同代终态 */

test("C1: 同代已 flash_done（失败）时，晚到的启动响应不得置为运行中", () => {
  const gate = createGenerationGate();
  gate.acceptStart("3", 7);
  gate.acceptEvent("3", 7, true); // 准备阶段就失败
  assert.equal(gate.acceptStart("3", 7), false, "同代启动响应必须被拒绝");
  assert.equal(gate.acceptEvent("3", 7), false, "终态后的进度帧必须丢弃");
});

test("C1: 更旧代际的启动响应不得覆盖更新任务", () => {
  const gate = createGenerationGate();
  gate.acceptStart("4", 11);
  assert.equal(gate.acceptStart("4", 10), false);
});

/* ------------------------------------- C2：准备期可停止 */

test("C2: pending / 本地 start-in-flight 都必须有停止入口", () => {
  assert.equal(canStopChannel({ running: false, pending: true }), true, "pending 准备阶段必须能停");
  assert.equal(canStopChannel({ startInFlight: true }), true, "启动请求在飞时也必须能停");
  assert.equal(canStopChannel({ running: true }), true);
  assert.equal(canStopChannel({}), false, "空闲不应显示停止");
  assert.equal(anyTaskActive([{}, { pending: true }]), true, "Esc 需要至少一个可取消目标");
});

/* ------------------------------------- C4：接管必须先确认关闭 */

class RefuseClosePort extends (await import("node:events")).EventEmitter {
  constructor(p) {
    super();
    this.path = p;
    this.baudRate = 115200;
    this.isOpen = false;
    this.closeCalls = 0;
  }
  open(cb) {
    this.isOpen = true;
    cb(null);
  }
  close(cb) {
    this.closeCalls += 1;
    cb(new Error("synthetic close failed")); // 驱动拒绝关闭，句柄仍开着
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

test("C4: 监听关闭未确认时，接管必须失败并保留 closing 占用（不得 open 新句柄）", async () => {
  resetRegistry();
  clearQuarantine();
  await abortAllMonitors();
  const port = new RefuseClosePort("COM87");
  __setPortFactory(() => port);
  try {
    await connectMonitor("1", "COM87", 115200, () => {}, () => {});
    assert.equal(holderOf("COM87")?.kind, OWNER_KIND.MONITORING);

    const takeover = await closeMonitorForTakeover("COM87", {});
    assert.equal(takeover.closed, false, "关闭未确认必须返回 closed:false");
    assert.equal(takeover.quarantined, true, "必须登记隔离");
    assert.ok(takeover.token, "必须保留原 token 以便仲裁");
    assert.equal(port.isOpen, true, "句柄仍未关闭");
    const holder = holderOf("COM87");
    assert.ok(holder, "占用绝不能丢");
    assert.equal(holder.kind, OWNER_KIND.CLOSING, `应为 closing，实际 ${holder?.kind}`);
  } finally {
    await abortAllMonitors();
    __setPortFactory(null);
    resetRegistry();
    clearQuarantine();
  }
});

/* ------------------------------------- C5：脱敏三例 */

test("C5: 编码查询键、含空格用户名、JSON 转义键都不得泄漏", () => {
  const cases = [
    ["GET https://example.test/fw?%74oken=SYNTHETIC-query-secret", /SYNTHETIC/],
    ["A29 打开 C:\\Users\\Alice Smith\\Desktop\\demo.fwpkg 失败", /Alice Smith|Smith/],
    ['context: {"pass\\u0077ord":"SYNTHETIC-json-secret"}', /SYNTHETIC-json-secret/],
  ];
  for (const [input, leak] of cases) {
    const out = redactText(input);
    assert.equal(leak.test(out), false, `泄漏：${out}`);
  }
  // 正常文本不能被误伤
  assert.equal(redactText("正在烧录 partition app，进度 42%"), "正在烧录 partition app，进度 42%");
});

/* ------------------------------------- C6：前端日志队列按字节 */

test("C6: 261000 个汉字必须被 256 KiB 字节预算挡住（不是 262144 字符）", () => {
  const q = createLogQueue({
    maxParts: 1_000_000,
    scheduleFrame: () => 0,
    cancelFrame: () => {},
    scheduleTimer: () => 0,
    cancelTimer: () => {},
  });
  const han = "汉".repeat(1000);
  for (let i = 0; i < 261; i += 1) q.enqueue(han);
  const stats = q.stats();
  assert.equal(utf8Bytes(han), 3000, "一个汉字 3 字节");
  assert.ok(
    stats.bytes <= DEFAULT_MAX_PENDING_LOG_BYTES,
    `字节必须 ≤ ${DEFAULT_MAX_PENDING_LOG_BYTES}，实际 ${stats.bytes}`,
  );
  assert.ok(stats.chars > 0, "字符数作为观测指标仍保留");
  assert.ok(stats.dropped > 0, "超预算必须计入丢弃");
});

test("C6: emoji（4 字节）同样按字节计量", () => {
  const q = createLogQueue({
    maxParts: 1_000_000,
    scheduleFrame: () => 0,
    cancelFrame: () => {},
    scheduleTimer: () => 0,
    cancelTimer: () => {},
  });
  const emo = "😀".repeat(500); // 2000 字节
  for (let i = 0; i < 400; i += 1) q.enqueue(emo);
  assert.ok(q.stats().bytes <= DEFAULT_MAX_PENDING_LOG_BYTES);
  assert.equal(utf8Bytes("😀"), 4);
});

/* ------------------------------------- C7：离线图标 */

test("C7: 源码用到的每个 i-lucide-* 都已在本地集合注册", async () => {
  const collectionPath = path.join(appRoot, "src", "lib", "ws63-icon-collection.json");
  assert.ok(fs.existsSync(collectionPath), "缺少本地图标集合（先跑 node scripts/gen-icons.mjs）");
  const collection = JSON.parse(fs.readFileSync(collectionPath, "utf8"));
  // 先构造 registered，再做任何断言（此前是 TDZ：used 以后才声明）
  const registered = new Set([
    ...Object.keys(collection.icons ?? {}),
    ...Object.keys(collection.aliases ?? {}),
  ]);
  assert.equal(collection.prefix, "lucide");

  const { collectUsedIcons, COMPONENT_DEFAULT_ICONS } = await import("../scripts/gen-icons.mjs");
  const used = collectUsedIcons();
  // Codex 断网复现：组件默认图标（check/chevron-down/loader-circle）不写在 src，
  // 但运行时确实会被请求 —— 必须一并纳入，否则"21 个图标通过"不等于离线完整。
  const lackingDefaults = COMPONENT_DEFAULT_ICONS.filter((n) => !registered.has(n));
  assert.deepEqual(
    lackingDefaults,
    [],
    `组件默认图标未本地注册（断网会请求 api.iconify.design）：${lackingDefaults.join(", ")}。请运行 node scripts/gen-icons.mjs 重新生成（由 Cursor 在 src 冻结解除后执行）`,
  );
  assert.ok(used.length > 0, "应当扫描到图标使用");


  const missing = used.filter((name) => !registered.has(name));
  assert.deepEqual(missing, [], `以下图标未本地注册（离线会变空 SVG）：${missing.join(", ")}`);
});

test("C7: 集合不得包含整包（只保留实际用到的子集）", async () => {
  const collection = JSON.parse(
    fs.readFileSync(path.join(appRoot, "src", "lib", "ws63-icon-collection.json"), "utf8"),
  );
  const count = Object.keys(collection.icons ?? {}).length;
  assert.ok(count > 0 && count <= 64, `图标子集应很小，实际 ${count} 个（整包 2078 个）`);
});

test("C7: gen-icons --check 通过（集合与源码同步）", () => {
  const res = spawnSync(process.execPath, ["scripts/gen-icons.mjs", "--check"], {
    cwd: appRoot,
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `集合过期：${res.stdout}${res.stderr}`);
});

void sleep;
