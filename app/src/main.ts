import "./assets/css/main.css";
import { createApp } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import ui from "@nuxt/ui/vue-plugin";
import { addCollection } from "@iconify/vue";
import App from "./App.vue";
import iconCollection from "./lib/ws63-icon-collection.json";
import { initializeAppearance } from "./lib/appearance";

/**
 * C7：本地注册**实际使用到的**图标（scripts/gen-icons.mjs 生成，21 个 ≈ 6 KB）。
 *
 * 不注册时 @iconify/vue 会去请求 api.iconify.design / api.simplesvg.com / api.unisvg.com，
 * 离线环境下按钮只剩空 SVG。这里只注册子集，不引入整包 2000+ 图标。
 * 新增图标后跑 `node scripts/gen-icons.mjs`（有测试检查是否遗漏）。
 */
addCollection(iconCollection as unknown as Parameters<typeof addCollection>[0]);

// Nuxt UI 需要 vue-router；单页路由保持最小开销
const router = createRouter({
  history: createWebHashHistory(),
  routes: [{ path: "/", component: { render: () => null } }],
});

/**
 * 外观主题先于挂载落地：读取 localStorage / 系统偏好，把 data-theme + dark class
 * 写到 html 上（index.html 的启动壳已做同样的首帧判断，避免挂载前闪错颜色）。
 * 幂等，可在别处重复调用。
 */
initializeAppearance();

const app = createApp(App);
app.use(router);
app.use(ui);
app.mount("#app");
