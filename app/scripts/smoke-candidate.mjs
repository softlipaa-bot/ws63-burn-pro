#!/usr/bin/env node
/**
 * 打包产物冒烟测试（第一阶段验收）。
 *
 * 约束：
 * - 独立 `--user-data-dir`：不污染、也不受已有用户配置影响。
 * - **不访问任何物理 COM**：不 open 端口；日志压力通过 `serial_disconnect`
 *   （无连接时幂等，且会产生真实日志行）触发，不伪造串口数据。
 * - 用 CDP（Node 内置 WebSocket + Input.dispatch*），不引入新依赖。
 * - 每个步骤记录“该步骤新增的渲染器异常”，异常的归属可定位，而不是一句“有个 Uncaught”。
 * - `ResizeObserver loop ...` 是 Chromium 已知的良性警告（会被记为 benign，不算失败），
 *   其它任何异常都算失败。
 *
 * 用法：
 *   node scripts/smoke-candidate.mjs --exe "<...>\WS63BurnPro.exe" [--json]
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";

const argv = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BENIGN = [/ResizeObserver loop/i];

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.consoleErrors = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(new Error(`CDP 连接失败: ${e?.message ?? e}`)));
    });
    this.ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails ?? {};
        this.exceptions.push({
          text: d.text ?? "Uncaught",
          desc: d.exception?.description ?? "",
          url: d.url ?? "",
          line: d.lineNumber ?? 0,
        });
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        this.consoleErrors.push(
          (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" "),
        );
      }
    });
  }

  send(method, params = {}) {
    const id = (this.seq += 1);
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 15000);
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const err = new Error(`页面求值失败: ${res.exceptionDetails.text}`);
      err.detail = res.exceptionDetails.exception?.description ?? "";
      throw err;
    }
    return res.result?.value;
  }

  async waitFor(expression, timeoutMs = 4000, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.eval(expression)) return true;
      await sleep(intervalMs);
    }
    return false;
  }

  async centerOf(expression) {
    return this.eval(`(() => {
      const el = ${expression};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
  }

  async realClick(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function waitForTarget(port, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return null;
}

function launch({ exe, label, port }) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `ws63-smoke-${label}-`));
  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += String(d);
  });
  child.stderr?.on("data", (d) => {
    stderr += String(d);
  });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, userData, exited, out: () => stdout, err: () => stderr };
}

async function stop(session, cdp) {
  cdp?.close();
  try {
    session.child.kill();
  } catch {
    /* ignore */
  }
  await Promise.race([session.exited, sleep(4000)]);
  await sleep(300);
  try {
    fs.rmSync(session.userData, { recursive: true, force: true });
  } catch {
    /* 仍被占用时忽略 */
  }
}

async function runOne({ exe, label, port }) {
  const report = { label, ok: false, steps: [], errors: [], benign: [] };
  let exceptionMark = 0;
  const step = (name, ok, detail = "", cdp = null) => {
    const fresh = cdp ? cdp.exceptions.slice(exceptionMark) : [];
    if (cdp) exceptionMark = cdp.exceptions.length;
    const benign = fresh.filter((e) => BENIGN.some((re) => re.test(e.text) || re.test(e.desc)));
    const real = fresh.filter((e) => !BENIGN.some((re) => re.test(e.text) || re.test(e.desc)));
    report.benign.push(...benign.map((e) => `${name}: ${e.text}`));
    report.steps.push({
      name,
      ok,
      detail,
      newExceptions: real.map((e) => `${e.text}${e.desc ? ` :: ${e.desc.split("\n")[0]}` : ""}`),
    });
    if (!ok) report.errors.push(`${name}: ${detail}`);
    for (const e of real) report.errors.push(`${name} 新增异常: ${e.text} ${e.desc.split("\n")[0] ?? ""}`);
    return ok;
  };

  const session = launch({ exe, label, port });
  let cdp = null;
  try {
    const target = await waitForTarget(port, 60000);
    if (!step("窗口/页面加载", Boolean(target), target ? target.url : "CDP 未发现 page target")) {
      report.stderrTail = session.err().slice(-1500);
      return report;
    }
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    // ---- 1) preload 桥接 + 构建身份
    const hasBridge = await cdp.eval(`Boolean(window.ws63 && window.ws63.call)`);
    step("preload 桥接（window.ws63.call）", hasBridge === true, String(hasBridge), cdp);

    const info = await cdp.eval(`window.ws63.call("get_build_info")`);
    step(
      "get_build_info 返回版本与运行路径",
      Boolean(info?.version) && info.version !== "unknown" && Boolean(info?.runtime?.execPath),
      JSON.stringify({
        version: info?.version,
        exec: info?.runtime?.execPath,
        packaged: info?.runtime?.packaged,
      }),
      cdp,
    );
    step(
      "构建清单存在且与 package.json 一致",
      info?.manifest?.found === true && info?.manifest?.matchesPackageVersion === true,
      JSON.stringify({ found: info?.manifest?.found, warnings: info?.warnings ?? [] }),
      cdp,
    );
    step("确认为打包运行（非开发模式）", info?.runtime?.packaged === true, String(info?.runtime?.packaged), cdp);

    // ---- 2) 空串口启动
    const state = await cdp.eval(`window.ws63.call("get_state")`);
    step("空串口启动：无烧录任务", state?.flashRunning === false, String(state?.flashRunning), cdp);
    step(
      "空串口启动：10 路通道全部空闲",
      Object.values(state?.channels ?? {}).length === 10 &&
        Object.values(state?.channels ?? {}).every((c) => c.running === false && c.status === "idle"),
      JSON.stringify(Object.values(state?.channels ?? {}).map((c) => c.status)),
      cdp,
    );

    // ---- 3) 界面渲染（标题栏版本徽标）
    const titleText = await cdp.eval(`document.querySelector(".chrome-tabs-title")?.textContent?.trim() ?? ""`);
    step("主界面渲染", String(titleText).includes("WS63"), String(titleText), cdp);
    const badge = await cdp.eval(
      `[...document.querySelectorAll(".chrome-tabs-meta *")].map(e=>e.textContent.trim()).find(t=>/^v\\d+\\.\\d+\\.\\d+/.test(t)) ?? ""`,
    );
    step("标题栏显示版本徽标", /^v\d+\.\d+\.\d+/.test(String(badge)), String(badge), cdp);

    // ---- 4) 页面切换：以“该页独有的元素”为准，不用导航文字（导航文字永远在页面上）
    const sections = [
      {
        label: "串口与日志",
        nav: "串口与日志",
        marker: `document.querySelectorAll('textarea, [role=textbox], pre, .log-panel, [class*=log]').length > 0`,
      },
      {
        label: "关于与更新",
        nav: "关于与更新",
        marker: `document.body.innerText.includes("本次运行的程序包")`,
      },
      {
        label: "固件烧录",
        nav: "固件烧录",
        marker: `document.querySelectorAll('.slot-flash-grid > *').length > 0`,
      },
    ];
    for (const sec of sections) {
      const box = await cdp.centerOf(
        `[...document.querySelectorAll('button[role=tab]')].find(b=>b.textContent.trim().includes(${JSON.stringify(
          sec.nav,
        )}))`,
      );
      if (!box) {
        step(`切换到「${sec.label}」`, false, "未找到导航标签", cdp);
        continue;
      }
      await cdp.realClick(box.x, box.y);
      const appeared = await cdp.waitFor(sec.marker, 4000);
      step(`切换到「${sec.label}」`, appeared, `marker=${sec.marker}`, cdp);
    }

    // ---- 5) 多路渲染：1 路 → 10 路 → 1 路
    // 主断言用“恢复持久化配置后重载”，确定性高；随后再记录一次真实交互切换的结果。
    const setSlotsAndReload = async (count) => {
      await cdp.eval(`(() => {
        // 与 App.vue 的 PREFS_KEY 保持一致
        const KEY = "ws63-burn-pro-prefs-v1";
        let prefs = {};
        try { prefs = JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { prefs = {}; }
        prefs.flashSlotCount = ${count};
        prefs.monitorSlotCount = ${count};
        localStorage.setItem(KEY, JSON.stringify(prefs));
        return KEY;
      })()`);
      await cdp.send("Page.reload", { ignoreCache: false });
      await sleep(1500);
      const ok = await cdp.waitFor(
        `document.querySelectorAll('.slot-flash-grid > *').length === ${count}`,
        10000,
      );
      return ok;
    };
    for (const count of [10, 1]) {
      const rendered = await setSlotsAndReload(count);
      const cards = await cdp.eval(`document.querySelectorAll('.slot-flash-grid > *').length`);
      step(`多路渲染 → ${count} 路卡片`, rendered && Number(cards) === count, `cards=${cards}`, cdp);
    }

    // 真实交互切换（Nuxt UI combobox）：结果记录在案，不做硬断言（CDP 驱动非产品行为）
    const combo = `[...document.querySelectorAll('button[role=combobox]')].find(x=>/^\\d+ 路$/.test(x.textContent.trim()))`;
    let interactiveDetail = "skipped";
    const comboBox = await cdp.centerOf(combo);
    if (comboBox) {
      await cdp.realClick(comboBox.x, comboBox.y);
      const opened = await cdp.waitFor(`document.querySelectorAll('[role=option]').length >= 10`, 4000);
      if (opened) {
        const opt = await cdp.centerOf(
          `[...document.querySelectorAll('[role=option]')].find(x=>x.textContent.trim()==="3 路")`,
        );
        if (opt) {
          await cdp.realClick(opt.x, opt.y);
          await sleep(500);
        }
      }
      const text = String((await cdp.eval(`${combo}?.textContent.trim()`)) ?? "");
      interactiveDetail = `opened=${opened} combobox="${text}"`;
    }
    report.interactive = interactiveDetail;

    // ---- 6) 日志压力（真实 IPC，不碰串口）
    const before = (await cdp.eval(`window.ws63.call("get_state")`))?.logs?.length ?? 0;
    for (let i = 0; i < 60; i += 1) {
      await cdp.eval(`window.ws63.call("serial_disconnect", {})`);
    }
    await sleep(600);
    const after = (await cdp.eval(`window.ws63.call("get_state")`))?.logs?.length ?? 0;
    step("日志压力（60 次真实 IPC 日志）", after > before, `before=${before} after=${after}`, cdp);
    const alive = await cdp.eval(`Boolean(document.querySelector(".chrome-tabs-title"))`);
    step("日志压力后界面仍存活", alive === true, String(alive), cdp);

    // ---- 7) 关闭前状态一致性
    const finalState = await cdp.eval(`window.ws63.call("get_state")`);
    step(
      "退出前无遗留烧录/占用",
      finalState?.flashRunning === false && finalState?.busy?.busy === false,
      JSON.stringify({ flashRunning: finalState?.flashRunning, busy: finalState?.busy?.busy }),
      cdp,
    );
    step("渲染器无 console.error", cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 3).join(" | "), cdp);

    report.ok = report.errors.length === 0;
    return report;
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
    report.stderrTail = session.err().slice(-1500);
    report.stdoutTail = session.out().slice(-1000);
    return report;
  } finally {
    await stop(session, cdp);
  }
}

const exeArg = arg("exe");
if (!exeArg || exeArg === true) {
  console.error("用法: node scripts/smoke-candidate.mjs --exe <WS63BurnPro.exe> [--json]");
  process.exitCode = 2;
} else {
  const exe = path.resolve(String(exeArg));
  if (!fs.existsSync(exe)) {
    console.error(`找不到可执行文件: ${exe}`);
    process.exitCode = 2;
  } else {
    const first = await runOne({ exe, label: "first", port: 9333 });
    const reopen = await runOne({ exe, label: "reopen", port: 9334 });
    const summary = { exe, firstRun: first, reopen, ok: first.ok && reopen.ok };
    if (arg("json")) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      for (const [name, r] of [["首次启动", first], ["关闭重开", reopen]]) {
        console.log(`\n===== ${name} =====`);
        for (const s of r.steps) {
          const extra = s.newExceptions?.length ? ` [新增异常 ${s.newExceptions.length}]` : "";
          console.log(`  [${s.ok ? "OK  " : "FAIL"}] ${s.name}${s.detail ? ` — ${s.detail}` : ""}${extra}`);
          for (const e of s.newExceptions ?? []) console.log(`         异常: ${e}`);
        }
        if (r.interactive) console.log(`  [INFO] 交互式 combobox 切换: ${r.interactive}`);
        if (r.benign?.length) console.log(`  [INFO] 良性浏览器警告 ${r.benign.length} 条（ResizeObserver，非应用错误）`);
        if (r.stderrTail) console.log(`  stderr: ${r.stderrTail}`);
        for (const e of r.errors) console.log(`  ERROR ${e}`);
      }
      console.log(`\n结论：${summary.ok ? "冒烟通过（未访问物理 COM）" : "冒烟未通过"}`);
    }
    if (!summary.ok) process.exitCode = 1;
  }
}
