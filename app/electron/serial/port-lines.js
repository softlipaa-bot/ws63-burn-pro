/**
 * 串口控制线（RTS/DTR）策略（W29-02 硬件安全）。
 *
 * 已核实的事实（本机 `@serialport/stream@13.0.0` dist/index.js）：
 *
 *   const defaultSetFlags = { brk: false, cts: false, dtr: true, rts: true };
 *   set(options, callback) {
 *     const settings = { ...defaultSetFlags, ...options };   // ← 每次都会合并默认值
 *     this.port.set(settings).then(...)
 *   }
 *
 * 也就是说 `port.set({ rts: false })` 实际下发的是
 * `{ brk:false, cts:false, dtr:true, rts:false }` —— **它同时把 DTR 置为 1**，
 * 顺带清 BRK/CTS。旧实现 `set({rts:false})` 因此在没有电路依据的情况下拨动了 DTR，
 * 而 DTR 在很多开发板上接 RESET/EN，可能直接把设备复位掉。
 *
 * 产品规则：**未知控制线电路时不得自动复位硬件**。所以：
 * - 默认 `none`：一次 `set()` 都不调用，保持系统/驱动默认电平；
 * - 其它模式必须显式开启（构造参数 `portLines` 或环境变量 `WS63_PORT_LINES`），
 *   并且把**完整**的四位标志与“DTR 会被置 1”的风险写进日志。
 */

export const PORT_LINES_MODE = Object.freeze({
  /** 不调用 set()，不碰 RTS/DTR（默认，最安全）。 */
  NONE: "none",
  /** 显式 rts=0；注意 serialport 会同时把 dtr 置 1。 */
  RTS_LOW: "rts-low",
  /** 显式 rts=0 且 dtr=0（两者都主动驱动，需电路依据）。 */
  RTS_LOW_DTR_LOW: "rts-low-dtr-low",
});

export const DEFAULT_PORT_LINES_MODE = PORT_LINES_MODE.NONE;

/** 复刻 serialport 的默认值，用于如实计算“最终会下发什么”。 */
export const SERIALPORT_SET_DEFAULTS = Object.freeze({
  brk: false,
  cts: false,
  dtr: true,
  rts: true,
});

export const PORT_LINES_LABEL = Object.freeze({
  none: "不操作 RTS/DTR（保持驱动默认）",
  "rts-low": "显式 RTS=0（serialport 会同时置 DTR=1）",
  "rts-low-dtr-low": "显式 RTS=0 且 DTR=0",
});

export function normalizePortLinesMode(value) {
  if (value === PORT_LINES_MODE.RTS_LOW) return PORT_LINES_MODE.RTS_LOW;
  if (value === PORT_LINES_MODE.RTS_LOW_DTR_LOW) return PORT_LINES_MODE.RTS_LOW_DTR_LOW;
  if (value === PORT_LINES_MODE.NONE) return PORT_LINES_MODE.NONE;
  return DEFAULT_PORT_LINES_MODE;
}

/**
 * 计算要下发的完整标志。
 * @param {string} mode
 * @returns {{mode: string, label: string, flags: {brk:boolean,cts:boolean,dtr:boolean,rts:boolean}|null,
 *            dtrAsserted: boolean, warning: string}}
 */
export function buildSetFlags(mode) {
  const normalized = normalizePortLinesMode(mode);
  const label = PORT_LINES_LABEL[normalized] ?? normalized;

  if (normalized === PORT_LINES_MODE.NONE) {
    return {
      mode: normalized,
      label,
      flags: null,
      dtrAsserted: false,
      warning: "",
    };
  }

  // 四个标志全部写全：不依赖 serialport 的隐式默认合并，日志与实际下发一致。
  const flags =
    normalized === PORT_LINES_MODE.RTS_LOW
      ? { ...SERIALPORT_SET_DEFAULTS, rts: false }
      : { brk: false, cts: false, dtr: false, rts: false };

  const dtrAsserted = flags.dtr === true;
  const warning = dtrAsserted
    ? "该设置会把 DTR 置为 1（serialport 的 set() 会合并默认值 {dtr:true,rts:true}）；" +
      "若板上 DTR 接 RESET/EN，可能复位设备。电路未知时请用默认 WS63_PORT_LINES=none"
    : "该设置会主动把 DTR 驱动为 0；只有确认 DTR 不接 RESET/EN 时才可使用";

  return { mode: normalized, label, flags, dtrAsserted, warning };
}

/** 一行诊断文本（写进日志/结果）。 */
export function describePortLines(mode) {
  const { label, flags, warning } = buildSetFlags(mode);
  if (!flags) return `${label}（不调用 set()）`;
  const text = Object.entries(flags)
    .map(([k, v]) => `${k}=${v ? 1 : 0}`)
    .join(", ");
  return `${label} → set({ ${text} })${warning ? `；警告：${warning}` : ""}`;
}
