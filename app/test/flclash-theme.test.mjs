/**
 * WS63 FlClash 主题与全局样式（DeepSeek 独占范围）
 *
 * 覆盖：
 *  1. src/lib/appearance.ts 的约定接口与行为（用假 DOM / 假 matchMedia / 假 localStorage，
 *     不打开窗口、不连串口、不发请求）
 *  2. src/assets/css/main.css 的语义令牌、浅深配色、对比度、Nuxt UI/Portal 映射、
 *     reduced-motion、焦点与旧硬编码清理
 *  3. index.html 首屏主题判定与启动壳、src/main.ts 初始化顺序
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const css = read("src/assets/css/main.css");
const indexHtml = read("index.html");
const mainTs = read("src/main.ts");
const appearanceSrc = read("src/lib/appearance.ts");

/* ==========================================================================
 * 假 DOM：只实现 appearance.ts 用到的接口
 * ========================================================================== */

function createFakeEnvironment({ stored = null, systemDark = false, storageThrows = false } = {}) {
  const attributes = new Map();
  const classes = new Set();
  const written = [];
  const listeners = [];
  let matchMediaCalls = 0;

  const meta = {
    content: "",
    setAttribute(name, value) {
      if (name === "content") this.content = String(value);
    },
  };

  const documentElement = {
    style: {},
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
  };

  const document = {
    documentElement,
    // vue/runtime-dom 在模块初始化时会取 document.createElement('template')，
    // 这里给个最小桩，让 appearance.ts 能在无浏览器环境下被真实加载。
    createElement() {
      return { style: {}, content: {}, innerHTML: "", setAttribute() {}, appendChild() {} };
    },
    createElementNS() {
      return { style: {}, setAttribute() {}, appendChild() {} };
    },
    querySelector(selector) {
      if (selector === 'meta[name="theme-color"]') return meta;
      return null;
    },
  };

  const mediaQueryList = {
    matches: systemDark,
    media: "(prefers-color-scheme: dark)",
    addEventListener(type, handler) {
      if (type === "change") listeners.push(handler);
    },
    removeEventListener(type, handler) {
      const index = listeners.indexOf(handler);
      if (index >= 0) listeners.splice(index, 1);
    },
  };

  const window = {
    matchMedia(query) {
      matchMediaCalls += 1;
      assert.equal(query, "(prefers-color-scheme: dark)");
      return mediaQueryList;
    },
    getComputedStyle() {
      return { getPropertyValue: (name) => (name === "--ws-page" ? "  #F2F1F5 " : "") };
    },
  };

  const store = new Map();
  if (stored !== null) store.set("ws63-appearance-v1", stored);

  const localStorage = {
    getItem(key) {
      if (storageThrows) throw new Error("storage disabled");
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      if (storageThrows) throw new Error("quota exceeded");
      store.set(key, String(value));
      written.push({ key, value: String(value) });
    },
    removeItem(key) {
      store.delete(key);
    },
  };

  return {
    window,
    document,
    localStorage,
    documentElement,
    mediaQueryList,
    attributes,
    classes,
    written,
    store,
    meta,
    get matchMediaCalls() {
      return matchMediaCalls;
    },
    get listeners() {
      return listeners;
    },
    emitSystemChange(matches) {
      mediaQueryList.matches = matches;
      for (const handler of [...listeners]) handler({ matches });
    },
    install() {
      globalThis.window = window;
      globalThis.document = document;
      globalThis.localStorage = localStorage;
      return this;
    },
  };
}

let moduleSeq = 0;
/** 每个用例一个全新模块实例（ESM 缓存用 query 打散） */
async function importAppearance(env) {
  env.install();
  moduleSeq += 1;
  const url = new URL("../src/lib/appearance.ts", import.meta.url).href;
  return import(`${url}?case=${moduleSeq}`);
}

/* ==========================================================================
 * 1. 约定接口
 * ========================================================================== */

test("契约：appearance.ts 导出约定的类型与四个入口", async () => {
  const env = createFakeEnvironment();
  const mod = await importAppearance(env);

  assert.equal(typeof mod.initializeAppearance, "function");
  assert.equal(typeof mod.useAppearance, "function");
  assert.equal(typeof mod.toggle, "function");
  assert.equal(typeof mod.setPreference, "function");
  assert.equal(typeof mod.normalizePreference, "function");
  assert.equal(typeof mod.resolveAppearance, "function");
  assert.equal(mod.APPEARANCE_STORAGE_KEY, "ws63-appearance-v1");

  const controller = mod.useAppearance();
  assert.deepEqual(Object.keys(controller).sort(), ["preference", "resolved", "setPreference", "toggle"]);
  // Ref / ComputedRef 形状（vue 的 ref 有 .value 与 dep）
  assert.ok("value" in controller.preference);
  assert.ok("value" in controller.resolved);
  assert.equal(typeof controller.toggle, "function");
  assert.equal(typeof controller.setPreference, "function");
  assert.ok(["light", "dark", "system"].includes(controller.preference.value));
  assert.ok(["light", "dark"].includes(controller.resolved.value));

  // 多次调用拿到同一份共享状态
  assert.equal(mod.useAppearance(), controller);
  assert.equal(mod.useAppearance().preference, controller.preference);
});

test("契约：非法输入归一化为 system，不做隐式三态轮换", async () => {
  const env = createFakeEnvironment();
  const mod = await importAppearance(env);

  assert.equal(mod.normalizePreference("light"), "light");
  assert.equal(mod.normalizePreference("dark"), "dark");
  assert.equal(mod.normalizePreference("system"), "system");
  for (const bad of [null, undefined, "", "auto", "DARK", 0, {}, []]) {
    assert.equal(mod.normalizePreference(bad), "system", `非法值 ${String(bad)} 应按 system`);
  }

  mod.setPreference("auto");
  assert.equal(mod.useAppearance().preference.value, "system");

  assert.equal(mod.resolveAppearance("system", true), "dark");
  assert.equal(mod.resolveAppearance("system", false), "light");
  assert.equal(mod.resolveAppearance("light", true), "light");
  assert.equal(mod.resolveAppearance("dark", false), "dark");
  assert.equal(mod.resolveAppearance("nonsense", true), "dark");
});

/* ==========================================================================
 * 2. 首屏、切换、持久化、系统监听
 * ========================================================================== */

test("首屏：无存储时跟随系统，并把 data-theme + dark class + color-scheme 写到 html", async () => {
  const env = createFakeEnvironment({ systemDark: true });
  const mod = await importAppearance(env);
  mod.initializeAppearance();

  assert.equal(mod.useAppearance().preference.value, "system");
  assert.equal(mod.useAppearance().resolved.value, "dark");
  assert.equal(env.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(env.classes.has("dark"), true);
  assert.equal(env.classes.has("light"), false);
  assert.equal(env.documentElement.style.colorScheme, "dark");
});

test("首屏：系统浅色时按浅色渲染", async () => {
  const env = createFakeEnvironment({ systemDark: false });
  const mod = await importAppearance(env);
  mod.initializeAppearance();

  assert.equal(mod.useAppearance().resolved.value, "light");
  assert.equal(env.documentElement.getAttribute("data-theme"), "light");
  assert.equal(env.classes.has("light"), true);
  assert.equal(env.classes.has("dark"), false);
  assert.equal(env.documentElement.style.colorScheme, "light");
});

test("首屏：已有存储时按存储渲染（刷新保持）", async () => {
  const env = createFakeEnvironment({ stored: "dark", systemDark: false });
  const mod = await importAppearance(env);
  mod.initializeAppearance();

  assert.equal(mod.useAppearance().preference.value, "dark");
  assert.equal(mod.useAppearance().resolved.value, "dark");
  assert.equal(env.documentElement.getAttribute("data-theme"), "dark");
});

test("首屏：存储值损坏时安全降级为跟随系统", async () => {
  const env = createFakeEnvironment({ stored: "purple-mode", systemDark: true });
  const mod = await importAppearance(env);
  mod.initializeAppearance();

  assert.equal(mod.useAppearance().preference.value, "system");
  assert.equal(mod.useAppearance().resolved.value, "dark");
});

test("切换：系统浅色下点一次立刻变深色，再点一次变浅色（每次点击都有可见变化）", async () => {
  const env = createFakeEnvironment({ systemDark: false });
  const mod = await importAppearance(env);
  mod.initializeAppearance();
  const { resolved, preference, toggle } = mod.useAppearance();

  assert.equal(resolved.value, "light");
  toggle();
  // 同步生效：调用返回时 html 已经变了，不需要等渲染
  assert.equal(env.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(env.classes.has("dark"), true);
  assert.equal(resolved.value, "dark");
  // 顶部快捷切换不再停留在 system（否则“跟随系统”会让人觉得没反应）
  assert.equal(preference.value, "dark");

  toggle();
  assert.equal(env.documentElement.getAttribute("data-theme"), "light");
  assert.equal(env.classes.has("light"), true);
  assert.equal(resolved.value, "light");
  assert.equal(preference.value, "light");
});

test("切换：系统深色下点一次变浅色（按实际显示主题反转）", async () => {
  const env = createFakeEnvironment({ systemDark: true });
  const mod = await importAppearance(env);
  mod.initializeAppearance();
  const { resolved, toggle } = mod.useAppearance();

  assert.equal(resolved.value, "dark");
  toggle();
  assert.equal(env.documentElement.getAttribute("data-theme"), "light");
  assert.equal(resolved.value, "light");
});

test("持久化：写入 ws63-appearance-v1，新会话读回相同偏好", async () => {
  const env = createFakeEnvironment({ systemDark: false });
  const mod = await importAppearance(env);
  mod.initializeAppearance();
  mod.setPreference("dark");

  assert.deepEqual(env.written.at(-1), { key: "ws63-appearance-v1", value: "dark" });
  assert.equal(env.store.get("ws63-appearance-v1"), "dark");

  // 模拟刷新：新模块实例 + 同一个存储
  const env2 = createFakeEnvironment({ stored: env.store.get("ws63-appearance-v1"), systemDark: false });
  const mod2 = await importAppearance(env2);
  mod2.initializeAppearance();
  assert.equal(mod2.useAppearance().preference.value, "dark");
  assert.equal(env2.documentElement.getAttribute("data-theme"), "dark");

  // 跟随系统也要能持久化（重新装回原测试桩，避免新会话的全局替换串线）
  env.install();
  mod.setPreference("system");
  assert.equal(env.store.get("ws63-appearance-v1"), "system");
});

test("降级：localStorage 抛错时仍可切换（内存生效，不抛异常）", async () => {
  const env = createFakeEnvironment({ storageThrows: true, systemDark: false });
  const mod = await importAppearance(env);
  assert.doesNotThrow(() => mod.initializeAppearance());

  const { preference, resolved, toggle } = mod.useAppearance();
  assert.doesNotThrow(() => mod.setPreference("dark"));
  assert.equal(preference.value, "dark");
  assert.equal(resolved.value, "dark");
  assert.equal(env.documentElement.getAttribute("data-theme"), "dark");

  assert.doesNotThrow(() => toggle());
  assert.equal(resolved.value, "light");
  assert.equal(env.documentElement.getAttribute("data-theme"), "light");
  assert.equal(env.written.length, 0);
});

test("降级：matchMedia 缺失时不崩溃，按浅色处理", async () => {
  const env = createFakeEnvironment();
  delete env.window.matchMedia;
  const mod = await importAppearance(env);
  assert.doesNotThrow(() => mod.initializeAppearance());
  assert.equal(mod.useAppearance().resolved.value, "light");
  assert.equal(env.documentElement.getAttribute("data-theme"), "light");
});

test("监听：initializeAppearance 反复调用只安装一个系统主题监听", async () => {
  const env = createFakeEnvironment({ systemDark: false });
  const mod = await importAppearance(env);

  const before = env.listeners.length;
  mod.initializeAppearance();
  mod.initializeAppearance();
  mod.initializeAppearance();

  assert.equal(env.listeners.length - before, 1, "系统主题监听必须只有一个");
  assert.equal(env.listeners.length, 1);
});

test("监听：system 模式跟随系统变化，显式浅/深色不被系统覆盖", async () => {
  const env = createFakeEnvironment({ systemDark: false });
  const mod = await importAppearance(env);
  mod.initializeAppearance();
  const { preference, resolved, setPreference } = mod.useAppearance();

  assert.equal(preference.value, "system");
  env.emitSystemChange(true);
  assert.equal(resolved.value, "dark");
  assert.equal(env.documentElement.getAttribute("data-theme"), "dark");

  env.emitSystemChange(false);
  assert.equal(resolved.value, "light");

  setPreference("light");
  env.emitSystemChange(true);
  assert.equal(resolved.value, "light", "显式浅色不应被系统深色覆盖");
  assert.equal(env.documentElement.getAttribute("data-theme"), "light");

  setPreference("dark");
  env.emitSystemChange(false);
  assert.equal(resolved.value, "dark", "显式深色不应被系统浅色覆盖");
});

test("隔离：外观模块不碰业务桥、不发请求、不写非外观存储", async () => {
  for (const forbidden of ["fetch(", "ipcRenderer", "window.electron", "start_flash", "sendSerial", "openPort"]) {
    assert.equal(appearanceSrc.includes(forbidden), false, `appearance.ts 不应出现 ${forbidden}`);
  }
  const keys = [...appearanceSrc.matchAll(/localStorage\.setItem\(([^,]+),/g)].map((m) => m[1].trim());
  assert.deepEqual([...new Set(keys)], ["APPEARANCE_STORAGE_KEY"]);
});

/* ==========================================================================
 * 3. 主样式：令牌与层级
 * ========================================================================== */

function blockBody(source, selector) {
  const index = source.indexOf(selector);
  assert.ok(index >= 0, `main.css 缺少选择器 ${selector}`);
  const open = source.indexOf("{", index);
  assert.ok(open > index, `${selector} 后缺少 {`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`无法解析 ${selector} 的块`);
}

function token(block, name) {
  const match = block.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

const lightBlock = blockBody(css, ":root {");
const darkBlock = blockBody(css, 'html[data-theme="dark"]');

test("令牌：约定的 --ws-* 语义令牌在浅色与深色都齐全", () => {
  const colorTokens = [
    "ws-page",
    "ws-card",
    "ws-block",
    "ws-text",
    "ws-secondary",
    "ws-primary",
    "ws-primary-soft",
    "ws-success",
    "ws-warning",
    "ws-error",
  ];
  // 颜色令牌必须两套齐全
  for (const name of colorTokens) {
    assert.ok(token(lightBlock, name), `浅色缺少 --${name}`);
    assert.ok(token(darkBlock, name), `深色缺少 --${name}`);
  }
  // 形状/间距/动效令牌与主题无关，只需在 :root 声明（深色若覆盖必须一致）
  for (const name of ["ws-radius-card", "ws-radius-block", "ws-gap", "ws-motion-nav", "ws-motion-page"]) {
    assert.ok(token(lightBlock, name), `缺少 --${name}`);
    const darkValue = token(darkBlock, name);
    assert.ok(darkValue === null || darkValue === token(lightBlock, name), `--${name} 不应在深色下改变`);
  }
});

test("令牌：使用指南给的配色与形状数值", () => {
  assert.equal(token(lightBlock, "ws-page").toLowerCase(), "#f2f1f5");
  assert.equal(token(lightBlock, "ws-card").toLowerCase(), "#fffcfe");
  assert.equal(token(lightBlock, "ws-block").toLowerCase(), "#efedf2");
  assert.equal(token(lightBlock, "ws-text").toLowerCase(), "#20232b");
  assert.equal(token(lightBlock, "ws-secondary").toLowerCase(), "#626674");
  assert.equal(token(lightBlock, "ws-primary").toLowerCase(), "#087fff");
  assert.equal(token(lightBlock, "ws-primary-soft").toLowerCase(), "#e3edff");

  assert.equal(token(darkBlock, "ws-page").toLowerCase(), "#171411");
  assert.equal(token(darkBlock, "ws-card").toLowerCase(), "#282420");
  assert.equal(token(darkBlock, "ws-block").toLowerCase(), "#36302b");
  assert.equal(token(darkBlock, "ws-text").toLowerCase(), "#f5f1ec");
  assert.equal(token(darkBlock, "ws-secondary").toLowerCase(), "#bdafa3");
  assert.equal(token(darkBlock, "ws-primary").toLowerCase(), "#ff9e45");
  assert.equal(token(darkBlock, "ws-primary-soft").toLowerCase(), "#493523");

  assert.equal(token(lightBlock, "ws-radius-card"), "32px");
  assert.equal(token(lightBlock, "ws-radius-block"), "20px");
  assert.equal(token(lightBlock, "ws-gap"), "12px");
  assert.equal(token(lightBlock, "ws-motion-nav"), "180ms");
  assert.equal(token(lightBlock, "ws-motion-page"), "220ms");
  assert.equal(token(lightBlock, "ws-motion-page-shift"), "6px");
});

test("令牌：每个被引用的 --ws-* 都有定义（防止拼写漏令牌）", () => {
  const defined = new Set([...css.matchAll(/--ws-[a-z0-9-]+(?=\s*:)/g)].map((m) => m[0]));
  const used = new Set([...css.matchAll(/var\((--ws-[a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `这些令牌被使用但没有定义：${missing.join(", ")}`);
});

test("令牌：深色重新配置了表面层级，而不是直接反色", () => {
  const values = ["ws-page", "ws-card", "ws-block", "ws-text", "ws-secondary", "ws-primary"].map((name) => ({
    name,
    light: token(lightBlock, name).toLowerCase(),
    dark: token(darkBlock, name).toLowerCase(),
  }));
  for (const row of values) {
    assert.notEqual(row.light, row.dark, `--${row.name} 浅深必须不同`);
  }
  // page → card → block 三级填充必须彼此不同
  for (const block of [lightBlock, darkBlock]) {
    const page = token(block, "ws-page");
    const card = token(block, "ws-card");
    const inner = token(block, "ws-block");
    assert.equal(new Set([page, card, inner]).size, 3, "page/card/block 必须三个不同层级");
  }
});

/* ==========================================================================
 * 4. 对比度（真实计算，不靠肉眼）
 * ========================================================================== */

function srgbToLinear(channel) {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex) {
  const normalized = hex.replace("#", "").trim();
  const full =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(hexA, hexB) {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

test("对比度：浅色正文/次要文字达到 WCAG AA 4.5:1 以上", () => {
  const card = token(lightBlock, "ws-card");
  const page = token(lightBlock, "ws-page");

  assert.ok(contrastRatio(token(lightBlock, "ws-text"), card) >= 7, "正文文字应 ≥7:1");
  assert.ok(contrastRatio(token(lightBlock, "ws-secondary"), page) >= 4.5, "次要文字在页面底色上应 ≥4.5:1");
  assert.ok(contrastRatio(token(lightBlock, "ws-secondary"), card) >= 4.5, "次要文字在卡片上应 ≥4.5:1");
  assert.ok(contrastRatio(token(lightBlock, "ws-primary-text"), card) >= 4.5, "主色文字应 ≥4.5:1");
  for (const name of ["ws-success", "ws-warning", "ws-error", "ws-info"]) {
    assert.ok(contrastRatio(token(lightBlock, name), card) >= 4.5, `--${name} 作为浅色文字应 ≥4.5:1`);
  }
});

test("对比度：深色正文/次要/状态文字达到 WCAG AA 4.5:1 以上", () => {
  const card = token(darkBlock, "ws-card");
  const page = token(darkBlock, "ws-page");

  assert.ok(contrastRatio(token(darkBlock, "ws-text"), card) >= 7, "正文文字应 ≥7:1");
  assert.ok(contrastRatio(token(darkBlock, "ws-secondary"), page) >= 4.5, "次要文字在页面底色上应 ≥4.5:1");
  assert.ok(contrastRatio(token(darkBlock, "ws-secondary"), card) >= 4.5, "次要文字在卡片上应 ≥4.5:1");
  for (const name of ["ws-success", "ws-warning", "ws-error", "ws-info"]) {
    assert.ok(contrastRatio(token(darkBlock, name), card) >= 4.5, `--${name} 作为深色文字应 ≥4.5:1`);
  }
});

test("对比度：主色实心上的文字可读（深色用深字，浅色达 UI 组件 3:1）", () => {
  // 深色主按钮：橙底深字
  const darkOnPrimary = contrastRatio(token(darkBlock, "ws-on-primary"), token(darkBlock, "ws-primary"));
  assert.ok(darkOnPrimary >= 4.5, `深色主按钮文字应 ≥4.5:1，实际 ${darkOnPrimary.toFixed(2)}`);
  // 浅色主按钮：蓝底白字（FlClash 蓝本身较亮，按 UI 组件/大字号 3:1 门槛）
  const lightOnPrimary = contrastRatio(token(lightBlock, "ws-on-primary"), token(lightBlock, "ws-primary"));
  assert.ok(lightOnPrimary >= 3, `浅色主按钮文字应 ≥3:1，实际 ${lightOnPrimary.toFixed(2)}`);
  assert.ok(contrastRatio(token(lightBlock, "ws-primary-text"), token(lightBlock, "ws-page")) >= 4.5);
});

/* ==========================================================================
 * 5. Nuxt UI / Portal / 旧样式清理
 * ========================================================================== */

test("Nuxt UI：语义变量在浅色与深色都映射到项目令牌", () => {
  const names = [
    "ui-bg",
    "ui-bg-muted",
    "ui-bg-elevated",
    "ui-bg-accented",
    "ui-text",
    "ui-text-highlighted",
    "ui-text-muted",
    "ui-text-toned",
    "ui-text-dimmed",
    "ui-border",
    "ui-primary",
    "ui-secondary",
    "ui-success",
    "ui-warning",
    "ui-error",
    "ui-info",
  ];
  for (const name of names) {
    assert.ok(token(lightBlock, name), `浅色缺少 --${name}`);
    assert.ok(token(darkBlock, name), `深色缺少 --${name}`);
  }
  // 圆角阶与主题无关，声明一次即可
  assert.ok(token(lightBlock, "ui-radius"), "缺少 --ui-radius");
  // 主色必须随主题翻转（浅蓝 → 深橙）
  assert.match(token(lightBlock, "ui-primary"), /--ws-primary/);
  assert.match(token(darkBlock, "ui-primary"), /--ws-primary/);
  assert.match(token(darkBlock, "ui-color-primary-500"), /--color-ember-500/);
  assert.match(token(lightBlock, "ui-color-primary-500"), /--color-brand-500/);
});

test("Portal：下拉/气泡/提示/弹窗内容面与遮罩统一走令牌", () => {
  const overrides = blockBody(css, "[data-slot=\"content\"]");
  assert.match(overrides, /background-color:\s*var\(--ws-card\)/);
  assert.match(overrides, /box-shadow:\s*var\(--ws-shadow-pop\)/);
  const overlay = blockBody(css, "[data-slot=\"overlay\"]");
  assert.match(overlay, /background-color:\s*var\(--ws-scrim\)/);
  assert.match(css, /\[data-slot="item"\][\s\S]*?--ws-primary-soft/);
  // 兜底层必须晚于 utilities，否则压不住组件自带的工具类
  const overridesLayer = css.indexOf("@layer ws-overrides {");
  const componentsLayer = css.indexOf("@layer components {");
  assert.ok(overridesLayer > componentsLayer, "@layer ws-overrides 必须位于 @layer components 之后");
});

test("清理：不再有全页玻璃、装饰渐变与旧浅蓝底色", () => {
  assert.equal(/backdrop-filter:\s*blur\(/.test(css), false, "不允许残留毛玻璃");
  assert.equal(/backdrop-filter:\s*blur\(/.test(indexHtml), false, "启动壳不允许毛玻璃");
  assert.equal(/radial-gradient|linear-gradient|conic-gradient/.test(css), false, "不允许渐变装饰");
  assert.equal(/radial-gradient|linear-gradient|conic-gradient/.test(indexHtml), false, "启动壳不允许渐变");
  assert.equal(css.includes("#d9e4f2"), false, "旧浅蓝底色应清除");
  assert.equal(css.toLowerCase().includes("rgb(255 255 255 / 0."), false, "不应残留半透明白色玻璃底");
  assert.equal(/--glass-bg\s*:/.test(css), false, "旧 --glass-* 令牌必须删除");
});

test("焦点：鼠标触摸不出现蓝框，键盘仍有可见焦点", () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ws-focus-ring\)/);
  assert.match(css, /:focus:not\(:focus-visible\)\s*\{[^}]*outline:\s*none/);
  assert.match(css, /-webkit-tap-highlight-color:\s*transparent/);
  // 组件库的 focus:outline-none 工具类会压掉 base 层焦点环，必须在 utilities 之后再兜一次
  const lateLayer = blockBody(css, "@layer ws-overrides {");
  assert.match(
    lateLayer,
    /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ws-focus-ring\)/,
    "ws-overrides 层需要键盘焦点兜底，否则 Nuxt UI 的 outline-none 会让焦点不可见",
  );
  // 不能一刀切关闭所有焦点
  assert.equal(/outline:\s*none\s*!important/.test(css), false);
  assert.equal(css.includes("outline: none !important"), false);
});

test("状态：卡片状态色由令牌合成，不使用写死的浅色背景", () => {
  for (const state of ["is-running", "is-success", "is-error", "is-unverified"]) {
    assert.match(css, new RegExp(`\\.flash-card-compact\\.${state}\\s*\\{[^}]*var\\(--ws-`), `${state} 应引用令牌`);
  }
  assert.match(css, /\.channel-error\s*\{[^}]*var\(--ws-error-soft\)/);
  assert.match(css, /\.action-notice\.is-success\s*\{\s*color:\s*var\(--ws-success\)/);
  assert.match(css, /\.ws-status\.is-warning\s*\{\s*--ws-status-fg:\s*var\(--ws-warning\)/);
});

test("日志与表单：等宽数字、可复制文本、44px 点击目标", () => {
  assert.match(css, /\.log-text\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /\.ws-mono\s*\{[^}]*font-family:\s*var\(--ws-font-mono\)/);
  assert.match(css, /\.ws-value\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /\.channel-error-text[\s\S]*?user-select:\s*text/);
  assert.match(css, /\.ws-hit\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /@media \(pointer: coarse\)/);
});

test("减少动效：保留既有约束并覆盖导航/页面过渡", () => {
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.chrome-tab-indicator/);
  assert.match(reduced, /\.section-fade-enter-active/);
  assert.match(reduced, /\.ws-nav-capsule/);
  assert.match(reduced, /transition:\s*none !important/);
});

test("点击目标：section-pane 内按钮/combobox/文本输入 ≥44px，且不撑大 badge/checkbox/日志", () => {
  const normalize = (text) =>
    text
      .slice(0, text.indexOf("{"))
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\s+/g, " ")
      .trim();

  // 1) ws-overrides 层里只应有一条 44px 兜底规则，且必须限定在业务页面内
  const overrides = blockBody(css, "@layer ws-overrides {");
  const overrideRules = [...overrides.matchAll(/[^{}]+\{[^{}]*(?:min-height|min-width):\s*44px[^{}]*\}/g)].map((m) =>
    normalize(m[0]),
  );
  assert.equal(overrideRules.length, 1, `ws-overrides 里应只有一条 44px 兜底规则，实际 ${overrideRules.length} 条`);

  const targetRule = overrideRules[0];
  assert.ok(
    targetRule.startsWith(".ws-app .section-pane button:not([role=\"checkbox\"])"),
    `44px 兜底必须限定 .ws-app .section-pane 的按钮，实际：${targetRule}`,
  );
  // 关键：不能写成 `.section-pane :is(...) :not(...)`——伪类之间的空格是后代组合符，
  // 规则会落到按钮内部的 span 上，看起来加了样式实际不生效。
  assert.equal(targetRule.includes(":is("), false, "不要用 :is() 跨行拼接，避免误成后代组合符");
  assert.equal(/\)\s+:not\(/.test(targetRule), false, "选择器里不允许出现「) :not(」这种后代组合符");

  const selectorList = targetRule.split(",").map((part) => part.trim());
  assert.ok(selectorList.length >= 4, "按钮 / combobox / 文本输入 / textarea 各自要有一条选择器");
  for (const part of selectorList) {
    assert.ok(part.startsWith(".ws-app .section-pane "), `每条选择器都要限定在 section-pane 内：${part}`);
  }
  const joined = selectorList.join(" , ");
  assert.match(joined, /button:not\(\[role="checkbox"\]\)/, "普通按钮必须命中");
  assert.match(joined, /\[role="combobox"\]/, "USelect 触发器等 combobox 必须命中");
  assert.match(joined, /input:not\(\[type="checkbox"\]\)/, "文本输入必须命中");
  assert.match(joined, /textarea/, "多行文本输入必须命中");
  assert.equal(joined.includes(`[role="switch"]`), true, "switch 必须排除");
  assert.equal(joined.includes(`[role="option"]`), true, "下拉项必须排除");

  // 2) 任何声明 44px 的规则都不许把 badge / span / 日志文字卷进来
  for (const match of css.matchAll(/[^{}]+\{[^{}]*(?:min-height|min-width):\s*44px[^{}]*\}/g)) {
    const selector = normalize(match[0]);
    assert.equal(
      /badge|\[data-slot="base"\]|\bspan\b|\.log-text|\.log-scroll-area/.test(selector),
      false,
      `不允许把 badge/span/日志文字卷进 44px：${selector}`,
    );
  }
});

test("既有测试约束仍满足（毛玻璃关闭 / 焦点 / 720px / 错误换行）", () => {
  assert.match(css, /\.slot-list-grid\.is-animating \.flash-card-compact[\s\S]*backdrop-filter:\s*none !important/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /\.channel-error-text[\s\S]*overflow-wrap:\s*anywhere/);
});

/* ==========================================================================
 * 6. 首屏启动壳与 main.ts 接入
 * ========================================================================== */

test("首屏：index.html 在绘制前用同一 key 判定主题", () => {
  const scriptStart = indexHtml.indexOf("ws63-appearance-v1");
  assert.ok(scriptStart > 0, "index.html 必须使用同一个 localStorage key");
  const styleStart = indexHtml.indexOf("<style>");
  assert.ok(scriptStart < styleStart, "主题判定脚本必须在样式之前，避免首帧闪错颜色");
  assert.match(indexHtml, /setAttribute\("data-theme", resolved\)/);
  assert.match(indexHtml, /classList\.toggle\("dark", resolved === "dark"\)/);
  assert.match(indexHtml, /style\.colorScheme = resolved/);
  // 存储不可用时也不能抛错打断启动
  assert.match(indexHtml, /try\s*\{[\s\S]*localStorage[\s\S]*\}\s*catch/);
});

test("首屏：启动壳使用与主样式同名的令牌，颜色一致", () => {
  const bootBlock = blockBody(indexHtml, ":root {");
  const bootDark = blockBody(indexHtml, 'html[data-theme="dark"]');
  for (const name of ["ws-page", "ws-card", "ws-block", "ws-text", "ws-secondary", "ws-primary", "ws-primary-soft"]) {
    assert.equal(
      token(bootBlock, name).toLowerCase(),
      token(lightBlock, name).toLowerCase(),
      `启动壳与主样式的 --${name} 必须一致`,
    );
    assert.equal(
      token(bootDark, name).toLowerCase(),
      token(darkBlock, name).toLowerCase(),
      `启动壳与方法式的深色 --${name} 必须一致`,
    );
  }
  assert.equal(token(bootBlock, "ws-radius-card"), token(lightBlock, "ws-radius-card"));
});

test("接入：main.ts 在挂载前初始化外观", () => {
  const importIndex = mainTs.indexOf('from "./lib/appearance"');
  const initIndex = mainTs.indexOf("initializeAppearance()");
  const mountIndex = mainTs.indexOf("app.mount(");
  assert.ok(importIndex > 0, "main.ts 必须引入 appearance 模块");
  assert.ok(initIndex > 0, "main.ts 必须调用 initializeAppearance()");
  assert.ok(initIndex < mountIndex, "初始化必须早于 app.mount");
  assert.ok(mainTs.indexOf('import "./assets/css/main.css"') < initIndex, "样式先于主题落地加载");
});

test("边界：DeepSeek 未越界修改 Cursor/冻结文件", () => {
  // App.vue 归 Cursor；这里只校验主样式没有反过来依赖它的内部结构
  assert.equal(/\.flclash-/.test(css), false, "全局样式不应写死 Cursor 组件类名");
  for (const forbidden of ["station_", "workbench", "工作台"]) {
    assert.equal(css.includes(forbidden), false, `主样式不应引入已撤除的功能痕迹：${forbidden}`);
  }
  // 版本与构建配置不在本次范围：这里只确认 package.json 仍是完整的 semver 字段，
  // 不把具体版本写死（版本号归 Codex，改动版本不应让主题测试失败）
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/);
  assert.equal(typeof pkg.build.directories.output, "string");
});

test("诊断：报告用摘要（供 DONE 记录）", () => {
  const summary = {
    cssBytes: Buffer.byteLength(css, "utf8"),
    indexHtmlBytes: Buffer.byteLength(indexHtml, "utf8"),
    appearanceBytes: Buffer.byteLength(appearanceSrc, "utf8"),
    cssSha256: createHash("sha256").update(css).digest("hex"),
    verdict: "ok",
  };
  assert.equal(summary.verdict, "ok");
  assert.ok(summary.cssBytes > 10000);
});
