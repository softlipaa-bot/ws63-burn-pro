#!/usr/bin/env node
/**
 * 生成**仅包含实际使用图标**的本地 Iconify 集合（C7：离线不能出现空 SVG）。
 *
 * 背景：`@nuxt/ui` 的 `<UIcon name="i-lucide-*">` 走 `@iconify/vue`，在没有预注册数据时
 * 会去请求 api.iconify.design / api.simplesvg.com / api.unisvg.com；离线环境下按钮只剩空 SVG。
 *
 * 做法：扫 `src/**` 里出现的 `i-lucide-<name>`，从 `@iconify-json/lucide` 只挑这些条目，
 * 生成 `src/lib/ws63-icon-collection.json`，由 `main.ts` 在启动时 `addCollection` 注册。
 * 这样运行时零网络请求，也不会把整包上千图标塞进产物。
 *
 * 用法：node scripts/gen-icons.mjs [--check]
 *   --check  只报告是否有缺失/过期，不写文件（供测试使用）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(appRoot, "src");
const OUT = path.join(SRC, "lib", "ws63-icon-collection.json");
const LUCIDE = path.join(appRoot, "node_modules", "@iconify-json", "lucide", "icons.json");

/**
 * 组件**默认**图标（不由 src 字面量出现，但运行时会被 Nuxt UI 使用）。
 *
 * Codex 断网 headless 复现（`codex-ws63-headless-v2-results.json`）：除了 src 里写的图标，
 * `check`（checkbox/切换）、`chevron-down`（select/dropdown）、`loader-circle`（loading 态）
 * 仍会向 api.iconify.design 等发起请求 → 离线时控件缺图标。
 * 因此生成器必须把这些一并纳入，光扫 src 字面量**不足以**保证离线完整。
 */
export const COMPONENT_DEFAULT_ICONS = Object.freeze([
  "check",
  "chevron-down",
  "chevron-up",
  "chevron-right",
  "chevron-left",
  "x",
  "loader-circle",
  "loader-2",
  "circle",
  "circle-dot",
  "minus",
  "search",
  "alert-circle",
  "info",
  "triangle-alert",
  "copy",
  "external-link",
  "more-horizontal",
  "grip-vertical",
  "arrow-up",
  "arrow-down",
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.(vue|ts|js|tsx|jsx)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

/** 收集源码里用到的图标名（i-lucide-xxx → xxx）。 */
export function collectUsedIcons({ includeComponentDefaults = true } = {}) {
  const names = new Set();
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/\bi-lucide-([a-z0-9-]+)\b/g)) names.add(m[1]);
  }
  // 组件默认图标必须一起打包：它们不写在 src 里，但运行时确实会被请求
  if (includeComponentDefaults) for (const n of COMPONENT_DEFAULT_ICONS) names.add(n);
  return [...names].sort();
}

/** 从 lucide 数据集里挑出这些图标，生成最小集合（含必要的 aliases，例如 trash-2 → trash）。 */
export function buildCollection(used, lucideData) {
  const icons = {};
  const aliases = {};
  const missing = [];
  for (const name of used) {
    const body = lucideData.icons?.[name];
    if (body) {
      icons[name] = body;
      continue;
    }
    // 有些名字是 alias（lucide 把 trash-2 归到 trash 上）；带上 parent 才能渲染
    const alias = lucideData.aliases?.[name];
    if (alias?.parent) {
      const parent = alias.parent;
      if (lucideData.icons?.[parent]) {
        icons[parent] = lucideData.icons[parent];
        aliases[name] = alias;
        continue;
      }
    }
    missing.push(name);
  }
  return {
    collection: {
      prefix: "lucide",
      // 只带被用到的图标（以及它们的 alias 目标）；不复制整包 2000+ 图标
      icons,
      ...(Object.keys(aliases).length ? { aliases } : {}),
      width: lucideData.width ?? 24,
      height: lucideData.height ?? 24,
      ...(lucideData.left !== undefined ? { left: lucideData.left } : {}),
      ...(lucideData.top !== undefined ? { top: lucideData.top } : {}),
    },
    missing,
  };
}

function main() {
  const check = process.argv.includes("--check");
  if (!fs.existsSync(LUCIDE)) {
    console.error(`[icons] 缺少 ${LUCIDE}（先 npm i -D @iconify-json/lucide）`);
    process.exitCode = 2;
    return;
  }
  const lucideData = JSON.parse(fs.readFileSync(LUCIDE, "utf8"));
  const used = collectUsedIcons();
  const { collection, missing } = buildCollection(used, lucideData);

  if (missing.length) {
    console.error(`[icons] 以下图标在 lucide 数据集中不存在：${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const payload = `${JSON.stringify(collection, null, 2)}\n`;
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  const stale = existing !== payload;

  if (check) {
    if (stale) {
      console.error(
        `[icons] 集合适配过期：需要 ${used.length} 个图标，请运行 node scripts/gen-icons.mjs`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`[icons] OK：${used.length} 个图标已本地化（${path.relative(appRoot, OUT)}）`);
    return;
  }

  if (stale) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, payload, "utf8");
    console.log(`[icons] 已生成 ${path.relative(appRoot, OUT)}（${used.length} 个图标，${payload.length} 字节）`);
  } else {
    console.log(`[icons] 无需更新（${used.length} 个图标）`);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("gen-icons.mjs")) {
  main();
}
