const { contextBridge, ipcRenderer, webUtils } = require("electron");

const listeners = new Set();

ipcRenderer.on("ws63:event", (_e, payload) => {
  for (const cb of listeners) cb(payload);
});

/**
 * Electron 34 里 `File.path` 已被移除（32 起废弃），拖拽取路径必须走
 * `webUtils.getPathForFile(file)`。这里保持 sandbox + contextIsolation 不变：
 * 只在 preload 内暴露“把 File 换成路径”这一个能力，不暴露 fs 或任意模块。
 */
function getPathForFile(file) {
  try {
    if (!file) return "";
    if (typeof webUtils?.getPathForFile === "function") {
      const p = webUtils.getPathForFile(file);
      if (p) return String(p);
    }
  } catch {
    /* 落到下面的兜底 */
  }
  // 极旧版本 Electron 才有 file.path；保留兜底但不依赖它
  if (typeof file?.path === "string" && file.path) return file.path;
  return "";
}

contextBridge.exposeInMainWorld("ws63", {
  call: (method, params) => ipcRenderer.invoke("ws63:call", method, params),
  notifyUiReady: () => ipcRenderer.send("ws63:ui-ready"),
  getPathForFile,
  onEvent: (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
});
