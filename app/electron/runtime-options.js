/**
 * 运行时/Chromium 开关（W08）。
 *
 * 旧 main.js 无条件强制 ignore-gpu-blocklist / CanvasOopRasterization /
 * disable-renderer-backgrounding / --max-old-space-size=4096 / sandbox:false。
 * 这些开关没有诊断输出，也无法回退。这里改成：
 * - 模式 + 环境变量/命令行可切换（auto / force / disable），启动时打印实际生效值；
 * - 默认 auto 只保留低风险的 GPU 光栅化加速，不再强制忽略 GPU 黑名单；
 * - sandbox 默认开启（renderer 不使用任何 Node API，preload 只用 electron 模块）。
 */

const VALID_GPU_MODES = new Set(["auto", "force", "disable"]);

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv ?? []) {
    if (typeof arg !== "string") continue;
    const m = /^--ws63-([a-z0-9-]+)=(.*)$/i.exec(arg);
    if (m) opts[m[1].toLowerCase()] = m[2];
  }
  return opts;
}

function clampHeap(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const mb = Math.floor(n);
  if (mb < 512) return 512;
  if (mb > 8192) return 8192;
  return mb;
}

/**
 * @param {{env?: Record<string,string|undefined>, argv?: string[]}} input
 */
export function computeRuntimeOptions({ env = {}, argv = [] } = {}) {
  const args = parseArgs(argv);
  const rawMode = String(args.gpu ?? env.WS63_GPU_MODE ?? "auto").toLowerCase();
  const gpuMode = VALID_GPU_MODES.has(rawMode) ? rawMode : "auto";
  const heapMb = clampHeap(args.heap ?? env.WS63_HEAP_MB ?? 4096, 4096);
  const sandboxRaw = String(args.sandbox ?? env.WS63_SANDBOX ?? "1").toLowerCase();
  const sandbox = !(sandboxRaw === "0" || sandboxRaw === "false" || sandboxRaw === "off");

  /** @type {Array<[string, string?]>} */
  const switches = [];
  const features = [];

  if (gpuMode === "force") {
    switches.push(["ignore-gpu-blocklist", undefined]);
    switches.push(["enable-gpu-rasterization", undefined]);
    switches.push(["enable-zero-copy", undefined]);
    features.push("CanvasOopRasterization", "Accelerated2dCanvas");
    switches.push(["num-raster-threads", "4"]);
  } else if (gpuMode === "auto") {
    switches.push(["enable-gpu-rasterization", undefined]);
    switches.push(["enable-zero-copy", undefined]);
  } else {
    switches.push(["disable-gpu", undefined]);
    switches.push(["disable-gpu-compositing", undefined]);
  }

  if (features.length) switches.push(["enable-features", features.join(",")]);
  switches.push(["js-flags", `--max-old-space-size=${heapMb}`]);

  return {
    gpuMode,
    heapMb,
    sandbox,
    switches,
    /** 需要在 UI/日志里能看到的决策摘要 */
    describe() {
      return {
        gpuMode,
        heapMb,
        sandbox,
        switches: switches.map(([k, v]) => (v === undefined ? k : `${k}=${v}`)),
        envOverrides: Object.fromEntries(
          Object.entries({
            WS63_GPU_MODE: env.WS63_GPU_MODE,
            WS63_HEAP_MB: env.WS63_HEAP_MB,
            WS63_SANDBOX: env.WS63_SANDBOX,
          }).filter(([, v]) => v !== undefined),
        ),
      };
    },
  };
}

/** @param {{commandLine: {appendSwitch(name: string, value?: string): void}}} appLike */
export function applyRuntimeOptions(appLike, options) {
  for (const [name, value] of options.switches) {
    if (value === undefined) appLike.commandLine.appendSwitch(name);
    else appLike.commandLine.appendSwitch(name, value);
  }
  return options.describe();
}
