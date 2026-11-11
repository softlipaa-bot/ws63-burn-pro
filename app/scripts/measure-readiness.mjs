#!/usr/bin/env node
/**
 * 后台就绪测量（**不抢焦点**版本）。
 *
 * 与 `codex-startup-audit.mjs` 的区别与分工：
 * - 那个脚本必须 `windowsHide:false` 才能测"窗口可见"，会占用桌面；
 * - 本脚本用 `WS63_NO_SHOW=1` 让主进程**不显示窗口**，只测：
 *   进程启动 → 页面加载完成（did-finish-load）→ IPC 真正可用（`get_state` 成功）。
 *
 * 因此本脚本的结论**不能**当作"窗口可见时间"，只能当作"后台就绪时间"。
 * 它不打开任何串口、不发起烧录、不访问业务网络。
 *
 * 用法：
 *   node scripts/measure-readiness.mjs <exe> [runs] [--json out.json]
 *
 * 输出（每次 + 汇总）：readyMs / pageLoadedMs / bootMarks；汇总给中位数与范围。
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const exe = process.argv[2];
const runs = Number(process.argv[3] ?? 5);
const jsonFlag = process.argv.indexOf("--json");
const jsonOut = jsonFlag > 0 ? process.argv[jsonFlag + 1] : "";

if (!exe || !fs.existsSync(exe)) {
  console.error("用法: node scripts/measure-readiness.mjs <packaged-exe> [runs] [--json out.json]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

class Cdp {
  constructor(url) {
    this.seq = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = (e) => reject(new Error(`CDP 连接失败: ${e?.message ?? "unknown"}`));
    });
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时 ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    }
    return res.result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    for (const p of this.pending.values()) clearTimeout(p.timer);
  }
}

const results = [];

for (let run = 1; run <= runs; run += 1) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `ws63-ready-${run}-`));
  const port = await freePort();
  const started = performance.now();
  let stderr = "";
  let stdout = "";
  const report = { run, profile: run === 1 ? "fresh userData" : "fresh userData (per run)" };

  const child = spawn(
    exe,
    [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`],
    {
      env: { ...process.env, WS63_NO_SHOW: "1" },
      windowsHide: true, // 不显示控制台；窗口由 WS63_NO_SHOW 抑制
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (b) => (stdout += b.toString()));
  child.stderr.on("data", (b) => (stderr += b.toString()));

  try {
    // 等调试端口可用
    let target = null;
    const deadline = started + 25000;
    while (performance.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (target) break;
      } catch {
        /* 端口还没起来 */
      }
      await sleep(25);
    }
    if (!target) throw new Error(`拿不到页面 target（stderr: ${stderr.slice(-300)}）`);

    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.ready;

    // 页面加载完成
    while (performance.now() < deadline) {
      const state = await cdp.eval("document.readyState").catch(() => "");
      if (state === "complete") {
        report.pageLoadedMs = Math.round(performance.now() - started);
        break;
      }
      await sleep(20);
    }

    // IPC 真正可用（这是"能干活"的判据，而不是窗口画出来）
    while (performance.now() < deadline) {
      const ok = await cdp
        .eval("typeof window.ws63?.call === 'function'")
        .catch(() => false);
      if (ok) {
        const stateOk = await cdp
          .eval(
            "window.ws63.call('get_state').then(s => ({ok: typeof s?.flashRunning === 'boolean'})).catch(e => ({ok:false, err:String(e)}))",
          )
          .catch((e) => ({ ok: false, err: String(e) }));
        if (stateOk?.ok) {
          report.readyMs = Math.round(performance.now() - started);
          break;
        }
      }
      await sleep(25);
    }

    report.build = await cdp
      .eval("window.ws63.call('get_build_info').then(v => ({version: v.version, packaged: v.runtime?.packaged}))")
      .catch(() => null);
    report.visible = await cdp
      .eval("document.visibilityState")
      .catch(() => "unknown");

    // 主进程打印的 boot 里程碑（含 windowShown / showSkippedByEnv）
    report.bootMarks = {};
    for (const line of stdout.split("\n")) {
      const m = /\[ws63\] boot (\S+) at \+(\d+)ms/.exec(line);
      if (m) report.bootMarks[m[1]] = Number(m[2]);
    }
    cdp.close();
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  } finally {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await sleep(300);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  results.push(report);
  console.log(JSON.stringify(report));
}

function summarize(key) {
  const values = results.map((r) => r[key]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : Math.round((values[mid - 1] + values[mid]) / 2);
  return { median, min: values[0], max: values[values.length - 1], n: values.length, values };
}

const summary = {
  exe,
  runs,
  measuredAt: new Date().toISOString(),
  note: "WS63_NO_SHOW=1：**不显示窗口**，因此这里是后台就绪时间，不是窗口可见时间；未打开任何串口。",
  readyMs: summarize("readyMs"),
  pageLoadedMs: summarize("pageLoadedMs"),
  results,
};

console.log("\n=== 汇总（后台就绪，非窗口可见） ===");
console.log(JSON.stringify({ readyMs: summary.readyMs, pageLoadedMs: summary.pageLoadedMs }, null, 2));

if (jsonOut) {
  fs.writeFileSync(jsonOut, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`已写入 ${jsonOut}`);
}

const failed = results.filter((r) => r.error);
if (failed.length) {
  console.error(`有 ${failed.length} 次运行失败：`, failed.map((r) => `#${r.run} ${r.error}`));
  process.exitCode = 1;
}
