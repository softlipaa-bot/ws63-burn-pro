import fs from "fs";
import os from "os";
import path from "path";
import { calcCrc16 } from "../electron/burn/crc.js";

/* ------------------------------------------------------------------ fwpkg 合成 */

const BIN_INFO_SIZE = 52;

/**
 * 合成一个 fwpkg 文件。
 * @param {{
 *   parts: Array<{name?: string, type?: number, data?: Buffer, offset?: number, length?: number,
 *                 burn_addr?: number, burn_size?: number}>,
 *   totalLength?: number|null,
 *   truncateTo?: number,
 *   corruptHeaderCrc?: boolean,
 *   magic?: number,
 *   cnt?: number,
 *   totalBytes?: number,
 * }} spec
 */
export function buildFwpkgBytes(spec = {}) {
  const parts = spec.parts ?? [
    { name: "loaderboot", type: 0, data: Buffer.alloc(1024, 0xa1), burn_addr: 0x100000 },
    { name: "application", type: 1, data: Buffer.alloc(2048, 0xb2), burn_addr: 0x200000 },
  ];
  const cnt = spec.cnt ?? parts.length;
  const headerSize = 12 + cnt * BIN_INFO_SIZE;

  let cursor = headerSize;
  const placed = parts.map((part) => {
    const data = part.data ?? Buffer.alloc(part.length ?? 1024, 0x5a);
    const offset = part.offset ?? cursor;
    cursor = Math.max(cursor, offset + data.length);
    return {
      name: part.name ?? "part",
      type: part.type ?? 1,
      data,
      offset,
      length: part.length ?? data.length,
      burn_addr: part.burn_addr ?? 0x100000,
      burn_size: part.burn_size ?? data.length,
    };
  });

  const fileSize = spec.totalBytes ?? cursor;
  const buf = Buffer.alloc(Math.max(fileSize, headerSize));
  buf.writeUInt32LE(spec.magic ?? 0xefbeaddf, 0);
  buf.writeUInt16LE(0, 4); // crc 占位
  buf.writeUInt16LE(cnt, 6);
  const declaredLength = spec.totalLength ?? buf.length;
  buf.writeUInt32LE(declaredLength, 8);

  let infoOffset = 12;
  for (const part of placed) {
    // 名称字段 32 字节；不做截断（超长名字要能被校验发现）
    Buffer.from(part.name, "latin1").copy(buf, infoOffset, 0, 32);
    buf.writeUInt32LE(part.offset, infoOffset + 32);
    buf.writeUInt32LE(part.length, infoOffset + 36);
    buf.writeUInt32LE(part.burn_addr, infoOffset + 40);
    buf.writeUInt32LE(part.burn_size, infoOffset + 44);
    buf.writeUInt32LE(part.type, infoOffset + 48);
    infoOffset += BIN_INFO_SIZE;
  }

  for (const part of placed) {
    if (part.data.length && part.offset + part.data.length <= buf.length) {
      part.data.copy(buf, part.offset);
    }
  }

  const headerEnd = Math.min(12 + cnt * BIN_INFO_SIZE, buf.length);
  let crc = calcCrc16(buf.subarray(6, headerEnd));
  if (spec.corruptHeaderCrc) crc = (crc ^ 0xffff) & 0xffff;
  buf.writeUInt16LE(crc, 4);

  if (spec.truncateTo && spec.truncateTo < buf.length) {
    return buf.subarray(0, spec.truncateTo);
  }
  return buf;
}

let tmpCounter = 0;

export function writeTempFile(bytes, ext = ".fwpkg") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws63-test-"));
  const file = path.join(dir, `sample-${tmpCounter++}${ext}`);
  fs.writeFileSync(file, bytes);
  return file;
}

/** 一个有效包（loaderboot + application）。 */
export function makeValidPackage(spec = {}) {
  return writeTempFile(buildFwpkgBytes(spec));
}

/* ------------------------------------------------------------- 应答帧（设备侧） */

export function buildDeviceFrame(cmd, data = [0, 0, 0, 0], { corruptCrc = false } = {}) {
  const len = 8 + data.length;
  const frame = Buffer.alloc(len);
  frame[0] = 0xef;
  frame[1] = 0xbe;
  frame[2] = 0xad;
  frame[3] = 0xde;
  frame.writeUInt16LE(len, 4);
  frame[6] = cmd;
  frame[7] = cmd ^ 0xff;
  Buffer.from(data).copy(frame, 8);
  let crc = calcCrc16(frame.subarray(0, len - 2));
  if (corruptCrc) crc = (crc ^ 0xffff) & 0xffff;
  frame.writeUInt16LE(crc, len - 2);
  return frame;
}

/* --------------------------------------------------------------- Fake 串口设备 */

const CMD_MAGIC = "efbeadde";

/**
 * YMODEM 接收方模拟器 + bootrom 命令应答。
 * variant: happy | no-c | nak-all | no-erase-ack | no-finish-ack | bad-handshake-crc | no-loader-ack
 */
export class FakeDevice {
  constructor({ variant = "happy", autoC = true } = {}) {
    this.variant = variant;
    this.autoCOn = autoC && variant !== "no-c";
    this.mode = "bootrom";
    this.filesFinished = 0;
    this.writes = [];
    this.pending = [];
    this.negotiatedBaud = null;
    this.handshakeCount = 0;
  }

  /** ymodem 等待阶段：设备持续发送 'C'。 */
  get autoC() {
    return this.mode === "ymodem" && this.autoCOn;
  }

  pushBytes(bytes) {
    for (const b of bytes) this.pending.push(b);
  }

  takeByte() {
    if (!this.pending.length) return null;
    return this.pending.shift();
  }

  /** 处理一次写入，可能产生应答字节。 */
  onWrite(bytes) {
    this.writes.push(Buffer.from(bytes));
    const head = bytes.subarray(0, 4).toString("hex");

    // ---- 命令帧（ef be ad de | len | cmd | ~cmd ...）
    if (head === CMD_MAGIC) {
      const cmd = bytes[6];
      if (cmd === 0xf0) {
        this.handshakeCount += 1;
        this.negotiatedBaud = bytes.readUInt32LE(8);
        // 握手成功后设备进入 YMODEM 接收态（会持续发 'C'）
        this.mode = "ymodem";
        if (this.variant === "bad-handshake-crc") {
          this.pushBytes(buildDeviceFrame(0xe1, [0, 0, 0, 0], { corruptCrc: true }));
        } else {
          this.pushBytes(buildDeviceFrame(0xe1, [0, 0, 0, 0]));
        }
        return;
      }
      if (cmd === 0xd2) {
        this.mode = "ymodem";
        if (this.variant === "no-erase-ack") return; // 故意不回应答
        this.pushBytes(buildDeviceFrame(0xd2, [0, 0]));
        return;
      }
      if (cmd === 0x87) {
        this.mode = "bootrom";
        if (this.variant === "no-finish-ack") return;
        this.pushBytes(buildDeviceFrame(0x87, [0, 0]));
        return;
      }
      return;
    }

    // ---- YMODEM
    const marker = bytes[0];
    if (marker === 0x01) {
      // SOH 信息块 / 结束块（133 字节），块头为 00 ff
      const isFinishBlock = bytes.length === 133 && bytes[3] === 0;
      if (isFinishBlock) {
        this.filesFinished += 1;
        if (this.variant === "nak-all") {
          this.pushBytes([0x15]);
          return;
        }
        this.pushBytes([0x06]);
        this.mode = "bootrom";
        if (this.filesFinished === 1 && this.variant !== "no-loader-ack") {
          // loaderboot 接收完毕后的“进入 ROM”应答帧
          this.pushBytes(buildDeviceFrame(0xd0, [0, 0]));
        }
        return;
      }
      if (this.variant === "nak-all") {
        this.pushBytes([0x15]);
        return;
      }
      this.mode = "ymodem";
      this.pushBytes([0x06]);
      return;
    }
    if (marker === 0x02) {
      // STX 数据块
      if (this.variant === "nak-all") {
        this.pushBytes([0x15]);
        return;
      }
      this.pushBytes([0x06]);
      return;
    }
    if (marker === 0x04) {
      // EOT
      if (this.variant === "nak-all") {
        this.pushBytes([0x15]);
        return;
      }
      this.pushBytes([0x06]);
      return;
    }
  }
}

/** 与 SerialSession 接口兼容的假会话。 */
export class FakeSession {
  constructor(device, { readSliceMs = 2 } = {}) {
    this.device = device;
    this.queue = [];
    this.waiters = [];
    this.readSliceMs = readSliceMs;
    this.bytesOut = [];
  }

  push(bytes) {
    for (const b of bytes) this.queue.push(b);
  }

  take() {
    if (this.queue.length) return this.queue.shift();
    if (this.device?.pending?.length) return this.device.pending.shift();
    return null;
  }

  readByte(timeoutMs = 250) {
    const immediate = this.take();
    if (immediate !== null) return Promise.resolve(immediate);
    const autoC = this.device?.autoC;
    if (autoC) return Promise.resolve("C".charCodeAt(0));
    const wait = Math.max(1, Math.min(timeoutMs, this.readSliceMs));
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const again = this.take();
        if (again !== null) resolve(again);
        else reject(new Error("串口读取超时"));
      }, wait);
    });
  }

  readAllPending() {
    const all = [...this.queue];
    this.queue.length = 0;
    if (this.device?.pending?.length) {
      all.push(...this.device.pending);
      this.device.pending.length = 0;
    }
    return Buffer.from(all);
  }

  drain() {
    this.queue.length = 0;
    if (this.device?.pending) this.device.pending.length = 0;
  }

  async write(bytes) {
    const buf = Buffer.from(bytes);
    this.bytesOut.push(buf);
    const response = this.device?.onWrite(buf);
    if (response?.length) for (const b of response) this.queue.push(b);
  }
}

/** 与 serialport 接口兼容的假端口，供 Ws63Flasher.createPort 注入。 */
export class FakePort {
  constructor({ path: portPath = "COM9", baudRate = 115200 } = {}) {
    this.path = portPath;
    this.baudRate = baudRate;
    this.isOpen = false;
    this.updates = [];
    this.closed = false;
    this.listeners = new Map();
  }

  open(cb) {
    this.isOpen = true;
    cb(null);
  }

  set(_opts, cb) {
    cb(null);
  }

  update(opts, cb) {
    this.updates.push(opts);
    if (opts.baudRate) this.baudRate = opts.baudRate;
    cb(null);
  }

  close(cb) {
    this.isOpen = false;
    this.closed = true;
    cb?.();
  }

  flush(cb) {
    cb?.();
  }

  pause() {}

  resume() {}

  on(event, handler) {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  off(event, handler) {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      list.filter((h) => h !== handler),
    );
  }

  emit(event, arg) {
    for (const handler of this.listeners.get(event) ?? []) handler(arg);
  }
}
