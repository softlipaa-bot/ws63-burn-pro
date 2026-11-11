import { calcCrc16 } from "./crc.js";
import {
  FwPkgError,
  describeFwpkg,
} from "./fwpkg.js";
import { openImmutableFwpkgSnapshot } from "./stable-snapshot.js";
import { SERIAL_ERROR_CODE, SerialSession } from "./serial-session.js";
import { DEFAULT_YM_TIMING, ymodemXfer } from "./ymodem.js";
import { FrameParser, readFrame } from "./frame-parser.js";
import { installErrorSink } from "../serial/port-safety.js";
import {
  closeWithConfirmation,
  markQuarantineOpenLanded,
  openWithDeadline,
  trackQuarantine,
} from "../serial/port-lifecycle.js";
import {
  DEFAULT_PORT_LINES_MODE,
  buildSetFlags,
  describePortLines,
  normalizePortLinesMode,
} from "../serial/port-lines.js";

/** 产品规则：等待设备进入下载模式的最长时间。 */
const RESET_TIMEOUT = 60000;

/** 串口 open/set/update/close 这些原生调用卡住时的有限上限（W29-03）。 */
const PORT_OP_TIMEOUT = 8000;

export const FLASH_STAGES = Object.freeze({
  PREPARE: "prepare",
  WAIT_RESET: "wait_reset",
  HANDSHAKE: "handshake",
  BAUD_SWITCH: "baud_switch",
  LOADER_TRANSFER: "loader_transfer",
  LOADER_CONFIRM: "loader_confirm",
  ERASE: "erase",
  PARTITION_TRANSFER: "partition_transfer",
  FINISH: "finish",
  RESET: "reset",
  BOOT_VERIFY: "boot_verify",
  DONE: "done",
});

export const STAGE_LABELS = Object.freeze({
  prepare: "准备固件",
  wait_reset: "等待连接",
  handshake: "握手",
  baud_switch: "切换波特率",
  loader_transfer: "传输 loaderboot",
  loader_confirm: "确认 loaderboot",
  erase: "下发擦除命令",
  partition_transfer: "传输分区",
  finish: "下发结束命令",
  reset: "复位设备",
  boot_verify: "启动验证",
  done: "完成",
});

export const DEFAULT_FLASH_TIMING = Object.freeze({
  resetTimeout: RESET_TIMEOUT,
  handshakeRetryMs: 250,
  handshakeFrameMinGapMs: 40,
  settleAfterHandshakeMs: 300,
  settleAfterBaudMs: 120,
  commandAckTimeout: 8000,
  loaderConfirmTimeout: 10000,
  resetConfirmTimeout: 8000,
  /** 单次写入的有限等待（R2）：驱动回调丢失不能把整个烧录挂死。 */
  writeTimeout: 5000,
  ymodem: DEFAULT_YM_TIMING,
});

const WS63E_FLASHINFO = [
  {
    cmd: 0xf0,
    data: Buffer.from([0x00, 0xc2, 0x01, 0x00, 0x08, 0x01, 0x00, 0x00]),
    length: 8,
  },
  {
    cmd: 0xd2,
    data: Buffer.from([
      0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0x00, 0xff,
    ]),
    length: 14,
  },
  {
    cmd: 0x87,
    data: Buffer.from([0x00, 0x00]),
    length: 2,
  },
];

/** 握手应答的命令字（ACK）。这是本仓库**已有**的唯一命令字定义，来源于既有 W02 实现。 */
const HANDSHAKE_ACK_CMD = 0xe1;

/**
 * 命令应答匹配策略（W29-04）。
 *
 * 证据边界（重要）：本仓库目前**没有**官方协议文档、原厂工具输出或实机抓包，
 * 能证明“擦除/结束命令的应答命令字等于请求命令字”。`test/fixtures.mjs` 里的
 * FakeDevice 回显 0xD2/0x87 **只是测试夹具的行为，不能当作设备协议证据**。
 *
 * 因此：
 * - 默认策略 `structural` 保留既有语义：要求一帧**结构完整且 CRC/长度/命令反码全部正确**
 *   的应答帧（`FrameParser.next()` 本身只产出这种帧）。它不发明任何命令字含义，
 *   但必须如实标注“应答命令字语义未验证”。
 * - `echo` 是**收紧**策略：只接受命令字与请求一致的应答。它是一个**未验证假设**，
 *   默认关闭；只有拿到官方文档/原厂工具/实机抓包证据后才应评估是否改为默认。
 * - 任何策略都不再允许“调用方忘记传 accept 就静默接受”，策略一定是显式的。
 */
export const ACK_POLICY = Object.freeze({
  /** 只要一帧结构+CRC 完整的应答（不解释命令字，默认）。 */
  STRUCTURAL: "structural",
  /** 只接受回显请求命令字的应答（未验证假设，默认关闭）。 */
  ECHO: "echo",
});

export const DEFAULT_ACK_POLICY = ACK_POLICY.STRUCTURAL;

export const ACK_POLICY_LABEL = Object.freeze({
  structural: "仅结构校验（应答命令字语义未验证）",
  echo: "命令字回显（未验证假设）",
});

export const ACK_POLICY_NOTE = Object.freeze({
  structural:
    "应答帧结构与 CRC 已校验；设备应答命令字的语义尚无官方/抓包证据，本版本不做断言",
  echo:
    "只接受与请求命令字相同的应答；该规则为未验证假设，未取得协议证据前不应作为发布默认值",
});

export function normalizeAckPolicy(value) {
  if (value === ACK_POLICY.ECHO) return ACK_POLICY.ECHO;
  if (value === ACK_POLICY.STRUCTURAL) return ACK_POLICY.STRUCTURAL;
  return DEFAULT_ACK_POLICY;
}


/** 每阶段：成功条件 / 失败码 / 超时 / 是否可重试（由上层决定重试入口）。 */
export const STAGE_SPEC = Object.freeze({
  [FLASH_STAGES.PREPARE]: {
    success: "固件包通过全部校验并绑定文件快照",
    failCodes: ["FWPKG_*"],
    timeoutMs: null,
    retryable: false,
  },
  [FLASH_STAGES.HANDSHAKE]: {
    success: "收到 EF BE AD DE 帧且 cmd=0xE1、长度与 CRC 均正确",
    failCodes: ["HANDSHAKE_TIMEOUT", "STOPPED"],
    timeoutMs: RESET_TIMEOUT,
    retryable: true,
  },
  [FLASH_STAGES.LOADER_TRANSFER]: {
    success: "YMODEM 全部数据块 + EOT + 结束块均被 ACK",
    failCodes: ["NO_C", "ACK_TIMEOUT", "EOT_TIMEOUT", "SHORT_READ", "PEER_CANCEL", "STOPPED"],
    timeoutMs: null,
    retryable: true,
  },
  [FLASH_STAGES.ERASE]: {
    success: "擦除命令下发后收到结构完整、CRC 正确的应答帧（应答命令字语义未验证，见 ackPolicy）",
    failCodes: ["ERASE_ACK_TIMEOUT", "BAD_FRAME", "PORT_CLOSED", "IO_ERROR", "RX_OVERFLOW"],
    timeoutMs: 8000,
    retryable: false,
  },
  [FLASH_STAGES.FINISH]: {
    success: "结束命令（0x87）下发后收到结构完整、CRC 正确的应答帧（应答命令字语义未验证）",
    failCodes: ["FINISH_ACK_TIMEOUT", "PORT_CLOSED", "IO_ERROR", "RX_OVERFLOW"],
    timeoutMs: 8000,
    retryable: false,
  },
  [FLASH_STAGES.BOOT_VERIFY]: {
    success: "收到设备启动后的明确握手/版本响应（当前协议未定义，一律未验证）",
    failCodes: ["BOOT_UNVERIFIED"],
    timeoutMs: null,
    retryable: false,
  },
});

export class FlashError extends Error {
  /**
   * @param {string} code
   * @param {string} stage
   * @param {string} message
   */
  constructor(code, stage, message, detail = null) {
    super(message);
    this.name = "FlashError";
    this.code = code;
    this.stage = stage;
    this.stageLabel = STAGE_LABELS[stage] ?? stage;
    this.detail = detail;
  }
}

/** Per-job copy so parallel flashes never share mutable command buffers. */
function cloneCmd(template) {
  return {
    cmd: template.cmd,
    length: template.length,
    data: Buffer.from(template.data),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 给原生回调式/长阻塞的串口操作套一个有限 deadline（W29-03）。
 * 超时不抛错而是返回 {timedOut: true}，由调用方决定是失败还是继续。
 */
function withDeadline(executor, ms, label) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, timedOut: true, label });
    }, Math.max(1, ms));
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: !err, error: err ?? null, timedOut: false, label });
    };
    try {
      executor(finish);
    } catch (err) {
      finish(err);
    }
  });
}

function describePortError(err) {
  if (!err) return "未知错误";
  const msg = err instanceof Error ? err.message : String(err);
  // 常见现场原因给出可操作提示，而不是一律“请检查 RTS 是否连接 RESET”。
  if (/access denied|permission denied|拒绝访问|打开失败|busy|cannot open|EBUSY|EACCES/i.test(msg)) {
    return `串口被占用或权限不足（${msg}）`;
  }
  if (/cannot find|not found|no such file|ENOENT|不存在/i.test(msg)) {
    return `端口不存在或已拔出（${msg}）`;
  }
  return msg;
}

function buildCmdFrame(cmddef) {
  const totalBytes = cmddef.length + 10;
  const buf = Buffer.alloc(totalBytes + 12);
  buf.writeUInt32LE(0xdeadbeef, 0);
  buf.writeUInt16LE(totalBytes, 4);
  buf[6] = cmddef.cmd;
  buf[7] = cmddef.cmd ^ 0xff;
  cmddef.data.copy(buf, 8, 0, cmddef.length);
  const crc = calcCrc16(buf.subarray(0, totalBytes - 2));
  buf.writeUInt16LE(crc, 8 + cmddef.length);
  return buf.subarray(0, totalBytes);
}

/**
 * 握手超时的可操作诊断文案（W29-02）。
 * 按“完全没收到字节 / 收到坏帧 / 收到意外应答 / 什么都没收到”区分提示，
 * 不再一律要求“RTS 接 RESET”——未知控制线电路时那会把用户引向错误操作。
 */
export function buildHandshakeTimeoutMessage({
  resetTimeoutMs,
  attempts,
  rxBytes,
  lastCode,
  badFrames,
}) {
  const seconds =
    resetTimeoutMs >= 1000 ? Math.round(resetTimeoutMs / 1000) : Number((resetTimeoutMs / 1000).toFixed(2));
  const head = `等待设备复位进入下载模式超时（${seconds}s，尝试 ${attempts} 次，收到 ${rxBytes} 字节`;
  let cause;
  if (rxBytes === 0 && badFrames === 0) {
    cause =
      `期间没有收到任何字节：请在软件提示“现在按板上 RST”之后手动按一次复位键；` +
      `同时确认 COM 口选择正确、串口未被其它程序占用`;
  } else if (lastCode === "BAD_FRAME" || badFrames > 0) {
    cause =
      `收到了 ${badFrames} 个坏帧（长度/CRC/命令反码不符）：多为波特率不匹配、` +
      `按 RST 的时机不在窗口内，或线路噪声；请重试并确认烧录波特率`;
  } else if (lastCode === "UNEXPECTED_FRAME") {
    cause = `收到了非 0xE1 的应答帧：设备可能已处于其它模式，请断开后重新插拔再按 RST`;
  } else {
    cause = `收到 ${rxBytes} 字节但没有组成有效 ACK（cmd=0xE1）：请重试并在窗口内按 RST`;
  }
  return `${head}，最后原因 ${lastCode}）。${cause}。本软件不会自动拨动 RTS/DTR 复位硬件`;
}

function buildHandshakeResultFrameSummary(frame) {
  return { cmd: frame.cmd, len: frame.len };
}

/** 把 readFrame 的失败码翻成可操作的中文原因（W29-02/W29-03）。 */
export function describeFrameFailure(res, timeoutMs, expectCmd) {
  const expect = typeof expectCmd === "number" ? `0x${expectCmd.toString(16).toUpperCase()}` : "期望命令字";
  switch (res?.code) {
    case "BAD_FRAME":
      return `应答帧 CRC/长度校验失败（${res.badFrames ?? 0} 个坏帧）`;
    case "UNEXPECTED_FRAME":
      return `应答命令字不符（期望 ${expect}，收到 ${(res.rejected ?? [])
        .map((c) => `0x${c.toString(16).toUpperCase()}`)
        .join(",")}）`;
    case "PORT_CLOSED":
      return "串口已断开（设备被拔出或端口被占用）";
    case "IO_ERROR":
      return `串口 IO 错误：${describePortError(res.error)}`;
    case "RX_OVERFLOW":
      return `接收缓冲溢出（丢弃 ${res.overflow?.sessionBytes ?? res.overflow?.parserBytes ?? 0} 字节），协议结果不可信`;
    case "STOPPED":
      return "操作已取消";
    default:
      return `等待应答超时（${timeoutMs}ms，已缓冲 ${res?.pendingBytes ?? 0} 字节）`;
  }
}

async function defaultCreatePort(options) {
  const { SerialPort } = await import("serialport");
  return new SerialPort(options);
}

export class Ws63Flasher {
  /**
   * @param {{emit: (event: any) => void, stopSignal?: AbortSignal, createPort?: Function, timing?: Partial<typeof DEFAULT_FLASH_TIMING>, strictProtocol?: boolean, ackPolicy?: string}} opts
   */
  constructor({ emit, stopSignal, createPort, timing, strictProtocol, ackPolicy, portLines } = {}) {
    this.emit = emit ?? (() => {});
    this.stopSignal = stopSignal;
    this.createPort = createPort ?? defaultCreatePort;
    this.timing = { ...DEFAULT_FLASH_TIMING, ...(timing || {}) };
    this.port = null;
    this.session = null;
    /** @type {FrameParser|null} 全程唯一的解析器；残余字节跨阶段保留（W29-04）。 */
    this.parser = null;
    this.targetBaud = 115200;
    this.stages = [];
    this.warnings = [];
    /**
     * 控制线策略（W29-02 硬件安全）。默认 none = 一次 set() 都不调用。
     * 见 serial/port-lines.js：serialport 的 set() 会把默认 {dtr:true,rts:true} 合并进来，
     * 所以“只动 RTS”是不可能的，必须显式声明并在日志里说明 DTR 风险。
     */
    this.portLinesMode = normalizePortLinesMode(
      portLines ?? process.env.WS63_PORT_LINES ?? DEFAULT_PORT_LINES_MODE,
    );
    /**
     * 应答匹配策略（显式，永不静默）。见 ACK_POLICY 的证据边界说明。
     * 构造参数或环境变量 WS63_ACK_POLICY 可覆盖，但只影响“如何判定应答”，
     * 不会把未验证假设写成协议事实。
     */
    this.ackPolicy = normalizeAckPolicy(
      ackPolicy ?? process.env.WS63_ACK_POLICY ?? DEFAULT_ACK_POLICY,
    );
    /** 记录哪些阶段用的是“未验证语义”的判定，交给上层如实展示。 */
    this.ackNotes = [];
    /** 协议读出统计（长运行累计，只增不减）。 */
    this.rxStats = { badFrames: 0, skippedBytes: 0, framesSeen: 0, overflowBytes: 0 };
    this.handshakeInfo = null;
    // 严格模式（默认）：任何阶段缺少设备确认都算失败。
    // 现场诊断可用 WS63_STRICT_PROTOCOL=0 放宽为“记录缺口但继续”，此时整次不算协议确认。
    this.strictProtocol =
      typeof strictProtocol === "boolean"
        ? strictProtocol
        : process.env.WS63_STRICT_PROTOCOL !== "0";
    this.protocolConfirmed = true;
    this.protocolGaps = [];
  }

  log(message, level = "info") {
    this.emit({ type: "log", message, level });
  }

  progress(current, total, name) {
    this.emit({ type: "progress", current, total, name });
  }

  enterStage(stage, extra = {}) {
    const record = { stage, label: STAGE_LABELS[stage] ?? stage, at: Date.now(), ...extra };
    this.stages.push(record);
    this.emit({ type: "stage", ...record });
    return record;
  }

  assertNotAborted(stage) {
    if (this.stopSignal?.aborted) {
      throw new FlashError("STOPPED", stage, "烧录已取消");
    }
  }

  /** 新建/复用解析器：残余字节不丢（W29-04）。 */
  freshParser() {
    const parser = new FrameParser();
    const leftovers = [];
    const carried = this.parser?.takePending?.();
    if (carried?.length) leftovers.push(carried);
    const pending = this.session?.readAllPending?.();
    if (pending?.length) leftovers.push(pending);
    for (const buf of leftovers) parser.push(buf);
    this.parser = parser;
    return parser;
  }

  /**
   * 打开串口。
   * 关键顺序（W29-03）：SerialSession 必须在 port.open() **之前**绑定监听，
   * 否则 open/set 期间的收包与 error 事件落在空窗里（旧实现就是 open→set→new SerialSession）。
   */
  async openPort(path, baudRate, ownerOpts = {}) {
    this.port = await this.createPort({
      path,
      baudRate: 115200,
      autoOpen: false,
      rtscts: false,
    });
    // 先绑监听，再打开：收到第一字节与 error/close 都不会漏。
    this.session = new SerialSession(this.port);

    // D3：用共享的有界打开。超时后若驱动"迟到成功"，openWithDeadline 会自己关闭该句柄，
    // 不再出现 "closePort 已清掉 this.port、真实句柄却打开着" 的泄漏。
    const owner = {
      token: String(ownerOpts.token ?? this.ownerToken ?? ""),
      channel: ownerOpts.channel ?? this.ownerChannel ?? null,
      path,
    };
    const opened = await openWithDeadline(this.port, PORT_OP_TIMEOUT, {
      onLateOpen: (latePort, info) => {
        try {
          installErrorSink(latePort);
        } catch {
          /* ignore */
        }
        // Codex 复现：这里以前无条件写"已自动关闭"。必须按**实际确认结果**说话，
        // 未确认时把句柄与原 token 一起保留为隔离占用（上层因此还能仲裁）。
        // 迟到回调已真实返回 → 打开"落地"。此标记与 closed 无关：
        // landed 后 isOpen 才可作为关闭依据；closed 决定是否已经关掉。
        if (owner.token) markQuarantineOpenLanded(owner.token);
        if (info?.closed) {
          this.pendingOpenHandle = null;
          this.log("串口在打开超时后迟到成功，已确认关闭该句柄（占用已释放）", "error");
        } else {
          this.pendingOpenHandle = { port: latePort, ...owner };
          if (owner.token) {
            trackQuarantine({
              port: latePort,
              token: owner.token,
              channel: owner.channel,
              path: owner.path,
              pendingOpen: true,
              onResolved: () => {
                this.pendingOpenHandle = null;
              },
            });
            // open 回调已触发（迟到成功）→ 打开落地，此后 isOpen 反映真实状态
            markQuarantineOpenLanded(owner.token);
          }
          this.log(
            "串口在打开超时后迟到成功，但关闭未确认：已保留占用并等待驱动确认（不会重复打开该串口）",
            "error",
          );
        }
      },
    });
    if (!opened.ok) {
      this.session?.detach?.();
      this.session = null;
      // 关键（Codex 复现 case 1）：回调带 error 但句柄 isOpen===true 时，
      // 绝不能 this.port=null 把句柄丢掉；保留句柄与原 token，交给上层隔离/关闭。
      const stillOpen = Boolean(this.port?.isOpen);
      if (stillOpen || opened.timedOut) {
        this.ownerToken = owner.token;
        this.ownerChannel = owner.channel;
        this.pendingOpenHandle = { port: this.port, ...owner };
        if (owner.token) {
          trackQuarantine({
            port: this.port,
            token: owner.token,
            channel: owner.channel,
            path,
            pendingOpen: true,
            onResolved: () => {
              this.pendingOpenHandle = null;
            },
          });
          // Codex 复现：超时时 open 回调**根本没发生**，不能当作"落地"，
          // 否则会清掉 pendingOpenHandle 让主进程提前释放占用（late-open 用例 ownerBeforeLate=null）。
          if (!opened.timedOut) {
            // 回调已返回（哪怕报错）→ 打开落地
            markQuarantineOpenLanded(owner.token);
          }
        }
      } else {
        this.port = null;
      }
      const detail = opened.timedOut ? `打开串口超时（${PORT_OP_TIMEOUT}ms）` : describePortError(opened.error);
      throw new FlashError("PORT_OPEN_FAILED", FLASH_STAGES.PREPARE, `无法打开串口 ${path}：${detail}`, {
        path,
        timedOut: opened.timedOut,
      });
    }
    this.session.markOpen();

    // 控制线（W29-02 硬件安全）：默认不调用 set()。
    // 旧实现 set({rts:false}) 会因为 serialport 合并 defaultSetFlags 而同时把 DTR 置 1，
    // 在未知电路上可能复位设备 —— 这正是产品规则禁止的“自动复位硬件”。
    const lines = buildSetFlags(this.portLinesMode);
    if (!lines.flags) {
      this.log(
        `控制线：${describePortLines(this.portLinesMode)}；未知电路下不主动拨 RTS/DTR`,
        "info",
      );
      this.portLineInfo = {
        mode: lines.mode,
        label: lines.label,
        applied: false,
        dtrAsserted: false,
        flags: null,
      };
    } else {
      this.log(`控制线：${describePortLines(this.portLinesMode)}`, lines.dtrAsserted ? "error" : "info");
      const res = await withDeadline(
        (done) => this.port.set(lines.flags, (err) => done(err)),
        PORT_OP_TIMEOUT,
        "set",
      );
      if (!res.ok) {
        // 设置失败不致命：握手仍然靠用户手动按 RST。
        this.log(
          `控制线设置未生效（${res.timedOut ? "超时" : describePortError(res.error)}），不影响握手`,
          "info",
        );
      }
      this.portLineInfo = {
        mode: lines.mode,
        label: lines.label,
        applied: res.ok,
        dtrAsserted: lines.dtrAsserted,
        flags: lines.flags,
      };
    }

    this.targetBaud = Number(baudRate) || 921600;
    this.parser = null;
  }

  /**
   * 关闭串口。返回 true **仅当确认句柄已关闭**。
   * 旧实现 `port.close(() => done(null))` 直接忽略回调 err，也没有 isOpen 复核 —— 属于
   * "看起来关了、其实可能还开着"，上层据此释放所有权就会双开。这里改用共享的确认关闭。
   */
  async closePort() {
    const port = this.port;
    this.session?.detach?.();
    this.session = null;
    this.parser = null;
    // 摘掉监听后驱动仍可能补发 error；没有监听者时 EventEmitter 会抛出未捕获异常。
    installErrorSink(port);
    let closed = true;
    if (port?.isOpen) {
      closed = await closeWithConfirmation(port, 2000);
      if (!closed) {
        this.log(
          "串口关闭未确认（驱动未回调或报错），句柄状态不确定，上层应保留占用而不是当作空闲",
          "error",
        );
        // 保留 this.port 引用，交给上层做隔离/收尾；不能假装已经关掉
        return false;
      }
    }
    this.port = null;
    return closed;
  }

  /**
   * 摘下会话监听但仍保留句柄（供 IPC 层用统一的"确认关闭/隔离"规则收尾）。
   * @returns {any|null} 端口句柄（未关闭）
   */
  /** 是否存在"打开未决/失败但句柄可能仍打开"的情况（上层据此改用隔离而非直接释放）。 */
  hasPendingOpen() {
    return Boolean(this.pendingOpenHandle);
  }

  /** 摘下手柄但不释放所有权信息（供 settle 使用）。 */
  detachForClose() {
    const port = this.port;
    this.session?.detach?.();
    this.session = null;
    this.parser = null;
    installErrorSink(port);
    this.port = null;
    return port ?? null;
  }

  /** Keep the open SerialPort for monitor handoff (no close). */
  releasePort() {
    const port = this.port;
    this.session?.detach?.();
    this.session = null;
    this.parser = null;
    installErrorSink(port);
    this.port = null;
    return port;
  }

  async sendCmd(cmddef) {
    // R2：写入必须有界且可取消，否则驱动回调丢失时后续超时/停止检查都执行不到
    await this.session.write(buildCmdFrame(cmddef), {
      timeoutMs: this.timing.writeTimeout,
      stopSignal: this.stopSignal,
    });
  }

  /**
   * 切换波特率。
   * 不再无条件 drain()：先用字节边界标记，只丢弃“切换前就已缓冲”的字节，
   * 保留切换后到达的字节（例如设备立刻发来的 YMODEM 'C'）。
   */
  async updateBaud(baudRate) {
    const marker = this.session?.markBoundary?.() ?? 0;
    const res = await withDeadline(
      (done) => this.port.update({ baudRate }, (err) => done(err)),
      PORT_OP_TIMEOUT,
      "update",
    );
    if (!res.ok) {
      throw new FlashError(
        "BAUD_SWITCH_FAILED",
        FLASH_STAGES.BAUD_SWITCH,
        `切换波特率到 ${baudRate} 失败：${res.timedOut ? `超时（${PORT_OP_TIMEOUT}ms）` : describePortError(res.error)}`,
      );
    }
    const dropped = this.session?.discardBefore?.(marker) ?? 0;
    if (dropped) this.log(`已丢弃切换波特率前缓冲的 ${dropped} 字节（旧波特率解码无效）`, "info");
    // 换波特率后旧的帧缓冲无意义，但 session 里切换后到达的字节要保留。
    this.parser?.mergeStatsInto?.(this.rxStats);
    this.parser = null;
  }

  // ---------------------------------------------------------------- 阶段实现

  /**
   * 阶段：握手。成功条件 = 完整 ACK 帧（cmd=0xE1，CRC 正确）。
   * 失败时必须能区分：手动 RST 没按 / 串口被占 / 完全收不到字节 / 收到坏帧 / 收到意外应答 / 断线。
   */
  async stageHandshake() {
    const timing = this.timing;
    const cmd = cloneCmd(WS63E_FLASHINFO[0]);
    const parser = this.freshParser();
    const startedAt = Date.now();
    const deadline = startedAt + timing.resetTimeout;
    const rxAtStart = this.session?.stats?.bytesIn ?? 0;
    const badAtStart = parser?.badFrames ?? 0;
    let attempts = 0;
    let lastCode = "TIMEOUT";
    let lastError = null;

    this.emitHandshakeProgress({
      phase: "wait_reset",
      attempts: 0,
      elapsedMs: 0,
      rxBytes: 0,
      resetTimeoutMs: timing.resetTimeout,
    });

    while (Date.now() < deadline) {
      this.assertNotAborted(FLASH_STAGES.HANDSHAKE);
      attempts += 1;
      cmd.data.writeUInt32LE(this.targetBaud, 0);
      try {
        await this.sendCmd(cmd);
      } catch (err) {
        if (err?.code === SERIAL_ERROR_CODE.IO_ERROR || err?.code === SERIAL_ERROR_CODE.PORT_CLOSED) {
          throw this.handshakeFailure("HANDSHAKE_PORT_ERROR", err, { attempts });
        }
        throw err;
      }
      const res = await readFrame(this.session, parser, {
        timeoutMs: timing.handshakeRetryMs,
        stopSignal: this.stopSignal,
        accept: (frame) => frame.cmd === HANDSHAKE_ACK_CMD,
      });
      if (res.ok) {
        const status = res.frame.payload
          .subarray(2)
          .toString("hex")
          .toUpperCase();
        // 同一批里可能先丢弃过坏帧再命中好帧：不阻塞流程，但必须在日志里可见。
        const droppedBad = (parser?.badFrames ?? 0) - badAtStart;
        if (droppedBad > 0) {
          this.log(`握手成功，但期间丢弃了 ${droppedBad} 个坏帧（长度/CRC/反码不符）`, "info");
        }
        this.parser?.mergeStatsInto?.(this.rxStats);
        this.handshakeInfo = {
          attempts,
          elapsedMs: Date.now() - startedAt,
          rxBytes: Math.max(0, (this.session?.stats?.bytesIn ?? 0) - rxAtStart),
        };
        this.log(
          `握手成功（第 ${attempts} 次，cmd=0xE1，状态字节 ${status || "--"}），切换波特率至 ${this.targetBaud}`,
          "success",
        );
        return { attempts, frame: res.frame, ...this.handshakeInfo };
      }
      if (res.code === "STOPPED") {
        throw new FlashError("STOPPED", FLASH_STAGES.HANDSHAKE, "烧录已取消");
      }
      lastCode = res.code;
      lastError = res.error ?? null;
      if (res.code === "PORT_CLOSED" || res.code === "IO_ERROR") {
        throw this.handshakeFailure(
          res.code === "PORT_CLOSED" ? "HANDSHAKE_PORT_CLOSED" : "HANDSHAKE_IO_ERROR",
          res.error,
          { attempts, lastCode: res.code },
        );
      }
      if (res.code === "RX_OVERFLOW") {
        throw new FlashError(
          "RX_OVERFLOW",
          FLASH_STAGES.HANDSHAKE,
          `接收缓冲溢出（会话丢 ${res.overflow?.sessionBytes ?? 0} 字节），无法保证协议可靠，已中止`,
          res.overflow,
        );
      }
      if (res.code === "BAD_FRAME") {
        this.log(`设备应答帧 CRC/长度校验失败（bad=${res.badFrames ?? "?"}），继续重试`, "info");
      }
      this.emitHandshakeProgress({
        phase: "handshake",
        attempts,
        elapsedMs: Date.now() - startedAt,
        rxBytes: Math.max(0, (this.session?.stats?.bytesIn ?? 0) - rxAtStart),
        lastCode,
        resetTimeoutMs: timing.resetTimeout,
      });
      await sleep(timing.handshakeFrameMinGapMs);
    }

    this.parser?.mergeStatsInto?.(this.rxStats);
    const rxBytes = Math.max(0, (this.session?.stats?.bytesIn ?? 0) - rxAtStart);
    throw new FlashError(
      "HANDSHAKE_TIMEOUT",
      FLASH_STAGES.HANDSHAKE,
      buildHandshakeTimeoutMessage({
        resetTimeoutMs: timing.resetTimeout,
        attempts,
        rxBytes,
        lastCode,
        badFrames: this.rxStats.badFrames,
      }),
      { attempts, lastCode, rxBytes, badFrames: this.rxStats.badFrames, error: lastError ? describePortError(lastError) : "" },
    );
  }

  emitHandshakeProgress(payload) {
    this.emit({ type: "handshake_progress", ...payload });
  }

  handshakeFailure(code, error, extra = {}) {
    const reason = describePortError(error);
    return new FlashError(
      code,
      FLASH_STAGES.HANDSHAKE,
      `串口在握手期间中断（${reason}）。请确认 USB 线未松动、串口未被其它程序占用后重试；本次未自动复位硬件`,
      { ...extra, error: reason },
    );
  }

  /**
   * 按当前策略生成应答判定器（W29-04）。
   *
   * - `structural`：返回 null，即接受任何**结构完整且 CRC/长度/反码正确**的应答帧。
   *   `FrameParser.next()` 本身只产出这种帧，所以这不是“任意字节算成功”。
   *   该策略**不解释**命令字含义，必须配合 `noteAckSemanticsUnverified()` 如实标注。
   * - `echo`：只接受命令字等于 `expectedCmd` 的应答（未验证假设，默认关闭）。
   *
   * `expectedCmd` 为空表示“该阶段没有请求命令字可对照”（例如 loaderboot 接收后的
   * 设备自主应答），此时任何策略都只能做结构校验，且不得排除任何命令字
   * ——包括 0xE1，因为在没有证据时无法断言它不可能出现在这里。
   */
  ackAcceptor(expectedCmd, stage) {
    if (this.ackPolicy === ACK_POLICY.ECHO && typeof expectedCmd === "number") {
      return (frame) => frame.cmd === expectedCmd;
    }
    if (typeof expectedCmd === "number" && this.ackPolicy !== ACK_POLICY.ECHO) {
      this.noteAckSemanticsUnverified(stage, expectedCmd);
    }
    return null;
  }

  /** 如实记录“这一阶段的应答命令字语义未经验证”，不阻断流程但必须可审计。 */
  noteAckSemanticsUnverified(stage, expectedCmd) {
    const note = {
      stage,
      code: "ACK_CMD_UNVERIFIED",
      policy: this.ackPolicy,
      expectedCmd: typeof expectedCmd === "number" ? expectedCmd : null,
      note: ACK_POLICY_NOTE[this.ackPolicy] ?? ACK_POLICY_NOTE.structural,
    };
    this.ackNotes.push(note);
    this.log(
      `（证据边界）${STAGE_LABELS[stage] ?? stage} 应答按“${ACK_POLICY_LABEL[this.ackPolicy]}”判定：` +
        `应答命令字语义未验证；策略可用 WS63_ACK_POLICY 切换`,
      "info",
    );
    return note;
  }

  /**
   * 下发命令并等待一个应答帧。
   *
   * W29-04：`accept` 不再可缺省为“忘记传就静默接受”。这里一定通过 `ackAcceptor()`
   * 显式决定判定规则，并把“未验证语义”记录进 `ackNotes`，由上层如实展示。
   */
  async sendCmdExpectAck(cmddef, stage, code, timeoutMs, accept) {
    const acceptor = accept ?? this.ackAcceptor(cmddef?.cmd, stage);
    await this.sendCmd(cmddef);
    const parser = this.freshParser();
    const res = await readFrame(this.session, parser, {
      timeoutMs,
      stopSignal: this.stopSignal,
      accept: acceptor,
    });
    if (!res.ok) {
      if (res.code === "STOPPED") throw new FlashError("STOPPED", stage, "烧录已取消");
      const reason = describeFrameFailure(res, timeoutMs, cmddef?.cmd);
      throw new FlashError(code, stage, `${STAGE_LABELS[stage] ?? stage}失败：${reason}`, res);
    }
    return res.frame;
  }

  /** 记录一次“未获协议确认”的缺口（宽松模式下不中断烧录，但整次不算协议确认）。 */
  noteProtocolGap(stage, err) {
    this.protocolConfirmed = false;
    this.protocolGaps.push({ stage, code: err?.code ?? "UNCONFIRMED" });
    this.log(
      `（宽松模式 WS63_STRICT_PROTOCOL=0）${STAGE_LABELS[stage] ?? stage}未获设备确认：` +
        `${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }

  /**
   * 需要设备应答的步骤：严格模式（默认）下缺应答即失败；
   * 宽松模式（WS63_STRICT_PROTOCOL=0，仅现场诊断用）记录缺口并继续。
   */
  async sendCmdExpectAckOrGap(cmddef, stage, code, timeoutMs) {
    try {
      return await this.sendCmdExpectAck(cmddef, stage, code, timeoutMs);
    } catch (err) {
      if (this.strictProtocol) throw err;
      if (err instanceof FlashError && err.code === "STOPPED") throw err;
      this.noteProtocolGap(stage, err);
      return null;
    }
  }

  async readFrameOrGap(stage, code, timeoutMs, message, accept) {
    const parser = this.freshParser();
    const res = await readFrame(this.session, parser, {
      timeoutMs,
      stopSignal: this.stopSignal,
      accept,
    });
    if (res.ok) return res.frame;
    if (res.code === "STOPPED") {
      throw new FlashError("STOPPED", stage, "烧录已取消");
    }
    if (res.code === "PORT_CLOSED" || res.code === "IO_ERROR" || res.code === "RX_OVERFLOW") {
      // 断线/溢出是硬失败，宽松模式也不能吞：那会把“设备掉线”写成“顺利烧完”。
      throw new FlashError(
        res.code,
        stage,
        `${message}（${res.code === "RX_OVERFLOW" ? "接收缓冲溢出" : "串口连接中断"}）`,
        res,
      );
    }
    const err = new FlashError(code, stage, `${message}（${res.code}）`, res);
    if (this.strictProtocol) throw err;
    this.noteProtocolGap(stage, err);
    return null;
  }

  /** 阶段：单个分区（擦除命令 + 传输 [+ loaderboot 确认]）。 */
  async stagePartition(part, reader, isLoader, reportProgress) {
    const timing = this.timing;

    if (!isLoader) {
      const erasSize = Math.ceil(part.length / 8192) * 0x2000;
      const download = cloneCmd(WS63E_FLASHINFO[1]);
      download.data.writeUInt32LE(part.burn_addr, 0);
      download.data.writeUInt32LE(part.length, 4);
      download.data.writeUInt32LE(erasSize, 8);
      this.enterStage(FLASH_STAGES.ERASE, { part: part.name });
      this.log(
        `正在擦除写入 ${part.name}：地址 0x${part.burn_addr.toString(16).toUpperCase()}，` +
          `长度 0x${part.length.toString(16).toUpperCase()}，擦除范围 0x${erasSize.toString(16).toUpperCase()}`,
      );
      const frame = await this.sendCmdExpectAckOrGap(
        download,
        FLASH_STAGES.ERASE,
        "ERASE_ACK_TIMEOUT",
        timing.commandAckTimeout,
      );
      if (frame) {
        this.log(
          `擦除命令已确认（应答 cmd=0x${frame.cmd.toString(16).toUpperCase()}，` +
            `判定策略 ${this.ackPolicy}；状态字节语义未解释）`,
          "success",
        );
      }
    } else {
      this.log(`正在传输 ${part.name} ...`);
    }

    this.enterStage(FLASH_STAGES.PARTITION_TRANSFER, { part: part.name });
    const res = await ymodemXfer(
      this.session,
      reader,
      part,
      (c, t) => reportProgress(part, c, t),
      this.stopSignal,
      timing.ymodem,
    );
    if (!res.ok) {
      throw new FlashError(
        res.code || "TRANSFER_FAILED",
        FLASH_STAGES.PARTITION_TRANSFER,
        `传输 ${part.name} 失败：${res.message || res.code}${res.stage ? `（YMODEM ${res.stage} 阶段）` : ""}`,
        res,
      );
    }

    if (isLoader) {
      this.enterStage(FLASH_STAGES.LOADER_CONFIRM, { part: part.name });
      // 该帧是设备在 YMODEM 结束后的自主应答，没有请求命令字可对照；
      // 无证据时不得排除任何命令字（包括 0xE1），只做结构+CRC 校验并如实标注。
      const confirmAcceptor = this.ackAcceptor(undefined, FLASH_STAGES.LOADER_CONFIRM);
      if (!confirmAcceptor) this.noteAckSemanticsUnverified(FLASH_STAGES.LOADER_CONFIRM, undefined);
      const confirm = await this.readFrameOrGap(
        FLASH_STAGES.LOADER_CONFIRM,
        "LOADER_CONFIRM_TIMEOUT",
        timing.loaderConfirmTimeout,
        "loaderboot 传输后未收到设备应答帧，无法确认设备已接收",
        confirmAcceptor,
      );
      if (confirm) {
        this.log(
          `loaderboot 已被设备接收（应答 cmd=0x${confirm.cmd.toString(16).toUpperCase()}，` +
            `判定策略 ${this.ackPolicy}；状态字节语义未解释）`,
          "success",
        );
      }
      await sleep(50);
    } else {
      await sleep(100);
    }
  }

  // ------------------------------------------------------------------- 主流程

  /**
   * @param {string | {path: string, meta: any, sha256: string, size: number, mtimeMs: number}} firmware
   */
  async flash(firmware) {
    const timing = this.timing;
    const startedAt = Date.now();
    this.stages = [];
    this.protocolConfirmed = true;
    this.protocolGaps = [];

    // ---- 阶段 0：固件校验 + 不可变快照绑定（R5）
    // 旧实现用 inspectFwpkg 结果 + openFirmwareReader（只比 size/mtime），
    // 同大小同 mtime 的替换会"用旧摘要读新字节"。现在一律先做不可变快照：
    // 一次读取 → 同时算 sha256 → 写私有副本，随后全程只读这份副本。
    this.enterStage(FLASH_STAGES.PREPARE);
    let snapshot;
    /** @type {any} */
    let reader = null;
    try {
      if (typeof firmware === "string") {
        reader = await openImmutableFwpkgSnapshot(firmware, { stopSignal: this.stopSignal });
      } else if (firmware && typeof firmware.read === "function" && typeof firmware.close === "function") {
        reader = firmware; // 已经是不可变快照（IPC 层已校验）
      } else if (firmware?.path) {
        reader = await openImmutableFwpkgSnapshot(firmware.path, {
          expectedSha256: firmware.sha256,
          stopSignal: this.stopSignal,
        });
      } else {
        throw new FwPkgError("FWPKG_INVALID", "缺少固件校验结果");
      }
      snapshot = reader;
    } catch (err) {
      const code = err instanceof FwPkgError ? err.code : "FWPKG_INVALID";
      throw new FlashError(code, FLASH_STAGES.PREPARE, err instanceof Error ? err.message : String(err));
    }
    if (!snapshot?.meta) {
      await reader?.close?.().catch?.(() => {});
      throw new FlashError("FWPKG_INVALID", FLASH_STAGES.PREPARE, "缺少固件校验结果");
    }
    this.firmwareSha256 = snapshot.sha256;
    const meta = snapshot.meta;
    for (const line of describeFwpkg(meta)) this.log(line);
    this.log(`固件摘要 SHA256 ${snapshot.sha256}（已校验实际读取的字节并加锁为不可变快照）`, "info");
    this.warnings = [...(meta.warnings ?? [])];

    const loaderboot = meta.binInfos.find((p) => p.type === 0);
    if (!loaderboot) {
      throw new FlashError("FWPKG_NO_LOADER", FLASH_STAGES.PREPARE, "固件包中未找到 loaderboot 分区");
    }
    const flashParts = [loaderboot, ...meta.binInfos.filter((p) => p.type === 1)];
    const totalBytes = flashParts.reduce((sum, p) => sum + Math.max(p.length, 1), 0);
    let completedBytes = 0;

    const reportPartProgress = (part, currentBlk, totalBlk) => {
      const partShare = Math.max(part.length, 1);
      const within = Math.min(currentBlk / Math.max(totalBlk, 1), 1) * partShare;
      const capped = Math.min((completedBytes + within) / totalBytes, 0.99);
      this.progress(Math.round(capped * 1000), 1000, part.name);
    };

    const result = {
      transferComplete: false,
      protocolConfirmed: false,
      bootVerified: false,
      staged: this.stages,
      messages: [],
    };

    try {
      // reader 已在上面的 PREPARE 阶段创建（不可变快照），这里不再重新打开文件：
      // 重新打开会引入"校验的文件"与"读取的文件"不一致的窗口（R5）。
      this.enterStage(FLASH_STAGES.WAIT_RESET);
      this.log("等待设备复位进入下载模式...");
      this.progress(0, 1000, "等待复位");
      this.enterStage(FLASH_STAGES.HANDSHAKE);
      await this.stageHandshake();
      this.enterStage(FLASH_STAGES.BAUD_SWITCH, { baudRate: this.targetBaud });
      await this.updateBaud(this.targetBaud);
      await sleep(timing.settleAfterHandshakeMs);

      // ---- 阶段 2：逐分区传输
      for (let i = 0; i < flashParts.length; i += 1) {
        this.assertNotAborted(FLASH_STAGES.PARTITION_TRANSFER);
        const part = flashParts[i];
        const isLoader = part.type === 0;
        if (isLoader) this.enterStage(FLASH_STAGES.LOADER_TRANSFER, { part: part.name });
        await this.stagePartition(part, reader, isLoader, reportPartProgress);
        completedBytes += Math.max(part.length, 1);
      }
      result.transferComplete = true;
      this.log(`文件传输完成（${flashParts.length} 个分区），正在下发复位命令...`, "success");

      // ---- 阶段 3：结束命令 + 复位
      this.enterStage(FLASH_STAGES.FINISH);
      const finishCmd = cloneCmd(WS63E_FLASHINFO[2]);
      const finishFrame = await this.sendCmdExpectAckOrGap(
        finishCmd,
        FLASH_STAGES.FINISH,
        "FINISH_ACK_TIMEOUT",
        timing.commandAckTimeout,
      );
      if (finishFrame) {
        this.log(
          `结束命令已确认（应答 cmd=0x${finishFrame.cmd.toString(16).toUpperCase()}，` +
            `判定策略 ${this.ackPolicy}；状态字节语义未解释）`,
          "success",
        );
      }
      result.protocolConfirmed = this.protocolConfirmed;
      result.protocolGaps = [...this.protocolGaps];

      this.enterStage(FLASH_STAGES.RESET);
      const parser = this.freshParser();
      const resetRes = await readFrame(this.session, parser, {
        timeoutMs: timing.resetConfirmTimeout,
        stopSignal: this.stopSignal,
      });
      if (resetRes.code === "STOPPED") {
        // 取消必须一路取消到底：旧实现会把 STOPPED 当成“复位未确认”继续走到 DONE。
        throw new FlashError("STOPPED", FLASH_STAGES.RESET, "烧录已取消");
      }
      if (resetRes.ok) {
        this.log("设备已应答复位", "success");
      } else {
        // 复位阶段丢失应答不再判整次失败，但必须如实报告“未确认”
        const reason = describeFrameFailure(resetRes, timing.resetConfirmTimeout);
        result.messages.push(`复位应答未收到，复位结果未确认（${reason}）`);
        this.log(`复位应答未收到，复位结果未确认（${reason}）`, "error");
      }

      // ---- 阶段 4：启动验证（协议缺失 → 一律未验证）
      this.enterStage(FLASH_STAGES.BOOT_VERIFY);
      this.log(
        "烧录协议完成；设备启动未验证（请在烧录后手动按 RST，并从串口确认启动日志）",
        "info",
      );
      result.messages.push("设备启动未验证（协议未定义启动确认，需手动 RST 后看串口日志）");

      this.enterStage(FLASH_STAGES.DONE, { elapsedMs: Date.now() - startedAt });
      this.progress(1000, 1000, "完成");
      this.parser?.mergeStatsInto?.(this.rxStats);
      return {
        ...result,
        bootVerified: false,
        // 证据边界：把“本轮用的是哪种应答判定、哪些语义未验证”交给上层如实展示
        ackPolicy: this.ackPolicy,
        ackPolicyLabel: ACK_POLICY_LABEL[this.ackPolicy] ?? this.ackPolicy,
        ackNotes: [...this.ackNotes],
        portLines: this.portLineInfo ?? { mode: this.portLinesMode, applied: false, flags: null },
        rxStats: { ...this.rxStats },
        handshake: this.handshakeInfo ? { ...this.handshakeInfo } : null,
        partCount: flashParts.length,
        bytes: totalBytes,
        elapsedMs: Date.now() - startedAt,
        snapshot: {
          // 报原始路径（不是临时副本），但摘要来自实际发送的那份字节
          path: snapshot.sourcePath ?? snapshot.path,
          size: snapshot.size,
          sha256: snapshot.sha256,
          immutableSnapshot: true,
        },
        warnings: this.warnings,
      };
    } finally {
      await reader?.close?.();
    }
  }
}

export async function listSerialPorts() {
  const { SerialPort } = await import("serialport");
  return SerialPort.list();
}
