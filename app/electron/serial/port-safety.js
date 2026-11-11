/**
 * 端口对象的安全兜底（W29-05）。
 *
 * 背景：`EventEmitter` 上 emit("error") 若**没有**任何监听者，Node 会把它当未捕获异常抛出。
 * 我们在 detach/close 之后会摘掉自己的 error 监听，而串口驱动仍可能在之后补发一个
 * error（拔线、驱动卸载）。这会把主进程直接带崩，因此摘掉监听后必须留一个静默 sink。
 *
 * 端口对象随会话一起被回收，所以每次接管只挂一个 sink 不会无限增长；这里用标记位
 * 避免同一个端口被反复挂 sink。
 */

const SINK_KEY = Symbol.for("ws63.errorSinkInstalled");

/**
 * 给端口装一个“吞掉迟到 error”的监听（幂等）。
 * @param {any} port
 * @returns {boolean} 是否新装
 */
export function installErrorSink(port) {
  if (!port || typeof port.on !== "function") return false;
  if (port[SINK_KEY]) return false;
  try {
    port.on("error", () => {
      /* 迟到/已无主的串口错误：由上层状态机负责，不在这里抛出 */
    });
    port[SINK_KEY] = true;
    return true;
  } catch {
    return false;
  }
}

/** 测试用：判断某端口是否已装 sink。 */
export function hasErrorSink(port) {
  return Boolean(port?.[SINK_KEY]);
}
