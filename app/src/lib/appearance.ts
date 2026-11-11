/**
 * WS63 外观主题（浅色 / 深色 / 跟随系统）
 *
 * 契约（见 `审查协作-2026-10-29/WS63-FlClash协作/协作约定.md`）：
 *   type AppearancePreference = 'light' | 'dark' | 'system'
 *   initializeAppearance(): void                     // 可重复调用；只安装一个系统主题监听
 *   useAppearance(): { preference, resolved, toggle, setPreference }
 *
 * 实际主题挂在 html 上：`data-theme="light|dark"` + `dark` class（浅色时补 `light`）。
 * 持久化 key：`ws63-appearance-v1`；localStorage 不可用（隐私模式 / 配额 / file:// 受限 /
 * 序列化异常）时自动降级为内存状态，不抛错、不阻塞启动。
 *
 * 主题只影响外观：不改采集、烧录、串口状态，也不触发任何请求。
 *
 * 界面衔接：
 * - 顶栏快捷按钮用 `toggle()`：按当前**实际显示**的主题反转为另一个显式主题，每次点击立即变化；
 *   系统模式处于浅色时点一下立刻变深色（不会出现“点了像没反应”）。
 * - 关于页外观设置用 `setPreference('light' | 'dark' | 'system')`。
 */

import { computed, ref, watch, type ComputedRef, type Ref } from "vue";

export type AppearancePreference = "light" | "dark" | "system";
export type ResolvedAppearance = "light" | "dark";

/** localStorage key（改动会让老用户的选择失效，勿随意改） */
export const APPEARANCE_STORAGE_KEY = "ws63-appearance-v1";
/** 挂在 documentElement 上的主题属性名 */
export const APPEARANCE_THEME_ATTRIBUTE = "data-theme";
/** 系统深色媒体查询 */
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export interface AppearanceController {
  preference: Ref<AppearancePreference>;
  resolved: ComputedRef<ResolvedAppearance>;
  toggle: () => void;
  setPreference: (next: AppearancePreference) => void;
}

function hasDom(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined" && !!document.documentElement;
}

/** 把任意输入收敛为三种合法偏好；非法值按 `system` 处理（首次默认跟随系统） */
export function normalizePreference(value: unknown): AppearancePreference {
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
}

export function resolveAppearance(
  next: AppearancePreference | string | null | undefined,
  systemDark: boolean,
): ResolvedAppearance {
  const preference = normalizePreference(next);
  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  return systemDark ? "dark" : "light";
}

/** 读系统深色偏好；matchMedia 缺失或被禁用时按浅色处理 */
export function systemPrefersDark(): boolean {
  if (!hasDom() || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(SYSTEM_DARK_QUERY).matches === true;
  } catch {
    return false;
  }
}

/* ---------------- 持久化（失败即内存降级） ---------------- */

let memoryPreference: AppearancePreference | null = null;

function readStoredPreference(): AppearancePreference | null {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return memoryPreference;
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (raw === null || raw === "") return memoryPreference;
    return normalizePreference(raw);
  } catch {
    return memoryPreference;
  }
}

function writeStoredPreference(next: AppearancePreference): void {
  memoryPreference = next;
  try {
    if (typeof localStorage === "undefined" || !localStorage) return;
    localStorage.setItem(APPEARANCE_STORAGE_KEY, next);
  } catch {
    /* 配额 / 隐私模式 / 存储被禁：保持内存值，界面行为不变 */
  }
}

/* ---------------- 共享状态 ---------------- */

const preference = ref<AppearancePreference>(readStoredPreference() ?? "system");
const systemDark = ref<boolean>(systemPrefersDark());

const resolved = computed<ResolvedAppearance>(() => resolveAppearance(preference.value, systemDark.value));

function applyResolvedAppearance(next: ResolvedAppearance): void {
  if (!hasDom()) return;
  const root = document.documentElement;
  root.setAttribute(APPEARANCE_THEME_ATTRIBUTE, next);
  root.classList.toggle("dark", next === "dark");
  root.classList.toggle("light", next !== "dark");
  // 让原生滚动条、下拉箭头、表单控件跟随主题
  try {
    root.style.colorScheme = next;
  } catch {
    /* 极少数嵌入式内核不支持 color-scheme，忽略 */
  }
  // 若页面声明了 theme-color（Electron / 移动端系统栏），一并同步
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && typeof meta.setAttribute === "function") {
      const style = typeof window.getComputedStyle === "function" ? window.getComputedStyle(root) : null;
      const page = style?.getPropertyValue("--ws-page")?.trim();
      if (page) meta.setAttribute("content", page);
    }
  } catch {
    /* 纯装饰，失败无害 */
  }
}

/**
 * 任意来源（setPreference / 直接改 preference.value / 系统变化）都要立即落到 DOM。
 * flush: "sync" 保证点击当帧生效，不排队、不抖动。
 */
watch(resolved, (next) => applyResolvedAppearance(next), { flush: "sync" });

/* ---------------- 系统主题监听（全局只装一个） ---------------- */

let mediaQueryList: MediaQueryList | null = null;
let started = false;

function onSystemThemeChange(event: { matches?: boolean } | null): void {
  // 只在 system 偏好下影响 resolved；显式浅/深色时该值变化不会改主题
  systemDark.value = event?.matches === true;
}

function installSystemListener(): void {
  if (!hasDom() || typeof window.matchMedia !== "function") return;
  let mql: MediaQueryList;
  try {
    mql = window.matchMedia(SYSTEM_DARK_QUERY);
  } catch {
    return;
  }
  mediaQueryList = mql;
  try {
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onSystemThemeChange);
    } else if (typeof mql.addListener === "function") {
      // Safari < 14 / 旧 WebView 兼容
      mql.addListener(onSystemThemeChange);
    }
  } catch {
    /* 不支持监听：仅保留启动时读取一次的值 */
  }
  systemDark.value = mql.matches === true;
}

/**
 * 初始化外观：可重复调用（main.ts 调用一次即可）。
 * 幂等：系统监听只安装一个，主题每次都会重新落到 DOM，避免首屏壳与运行态不一致。
 */
export function initializeAppearance(): void {
  if (!hasDom()) return;
  if (!started) {
    started = true;
    installSystemListener();
  }
  applyResolvedAppearance(resolved.value);
}

/** 设置偏好并持久化（存储不可用时仅内存生效） */
export function setPreference(next: AppearancePreference): void {
  const normalized = normalizePreference(next);
  preference.value = normalized;
  writeStoredPreference(normalized);
  // 值未变（例如 system → system）不会触发 watcher；未初始化时也补一次落地
  if (!started) applyResolvedAppearance(resolved.value);
}

/**
 * 顶栏快捷切换：按当前**实际显示**的主题反转。
 * resolved=light → 显式 dark；resolved=dark → 显式 light。每次点击立即生效。
 */
export function toggle(): void {
  setPreference(resolved.value === "dark" ? "light" : "dark");
}

const controller: AppearanceController = {
  preference,
  resolved,
  toggle,
  setPreference,
};

/** 组件里取共享的外观状态（同一份 ref，跨组件实时同步） */
export function useAppearance(): AppearanceController {
  return controller;
}

/** 仅供测试/诊断：清掉系统监听并复位内部标记 */
export function __resetAppearanceForTests(): void {
  if (mediaQueryList) {
    try {
      if (typeof mediaQueryList.removeEventListener === "function") {
        mediaQueryList.removeEventListener("change", onSystemThemeChange);
      } else if (typeof mediaQueryList.removeListener === "function") {
        mediaQueryList.removeListener(onSystemThemeChange);
      }
    } catch {
      /* ignore */
    }
  }
  mediaQueryList = null;
  started = false;
  memoryPreference = null;
}
