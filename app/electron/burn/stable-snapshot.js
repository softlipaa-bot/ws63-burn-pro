/**
 * 烧录用的不可变固件快照（R5 + W29-11 的必要部分）。
 *
 * 旧设计的问题（已被 Codex 离线复现）：
 * - `inspectFwpkg` 的缓存键只有 (path, size, mtime)；
 * - `openFirmwareReader` 也只比 size/mtime。
 * 于是“同路径、同长度、保留时间戳”地替换固件后，界面与日志显示的是旧 SHA256，
 * 而实际发出去的是新字节 —— 属于“声称校验过、其实没校验”。
 *
 * 现在的做法（一次读取、一次写入、内容身份与传输字节同源）：
 *   1. 打开源文件句柄，fstat 取大小；
 *   2. **流式**读取：分块 read → sha256.update → 写入私有临时文件（带 await 让出事件循环，不阻塞主线程）；
 *   3. 写满 size 字节后 fsync 并关闭源句柄；
 *   4. 从**临时副本**解析包头并做跨段校验；
 *   5. 整次传输都从这份私有副本读，外部再改/换源文件都不影响已开始的烧录。
 *
 * 这同时解决了“校验后再修改”的窗口：校验用的字节就是之后发送的字节。
 * 明确的代价与边界：
 * - 需要与固件等量的临时磁盘空间（用后立即删除）；
 * - 首次读取仍然要完整读一遍（这是内容身份校验的最低成本，不为提速删校验）；
 * - 摘要比对不上就拒绝，绝不会“用旧摘要读新字节”。
 */

import { readSync } from "fs";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { FwPkgError, MAX_PACKAGE_BYTES, buildSnapshotFromFd } from "./fwpkg.js";

/** 分块大小：够大以摊薄系统调用，够小以便及时让出事件循环。 */
export const SNAPSHOT_CHUNK_BYTES = 1024 * 1024;

/**
 * @param {string} filePath
 * @param {{chunkBytes?: number, onProgress?: (done: number, total: number) => void,
 *          stopSignal?: AbortSignal, expectedSha256?: string, tempDir?: string}} [opts]
 * @returns {Promise<{path: string, size: number, sha256: string, meta: any, warnings: string[],
 *                    sourcePath: string, read(offset: number, length: number): Buffer,
 *                    close(): Promise<void>}>}
 */
export async function openImmutableFwpkgSnapshot(filePath, opts = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new FwPkgError("FWPKG_BAD_PATH", "固件路径无效");
  }
  const abs = path.resolve(filePath);
  const chunkBytes = Math.max(64 * 1024, Number(opts.chunkBytes) || SNAPSHOT_CHUNK_BYTES);
  const stopSignal = opts.stopSignal;

  let source;
  try {
    source = await fs.open(abs, "r");
  } catch {
    throw new FwPkgError("FWPKG_NOT_FOUND", "固件文件不存在或不可读");
  }

  let tempPath = "";
  let tempHandle = null;
  try {
    const stat = await source.stat();
    if (!stat.isFile()) throw new FwPkgError("FWPKG_NOT_FILE", "固件路径不是普通文件");
    if (stat.size <= 0) throw new FwPkgError("FWPKG_EMPTY", "固件文件为空");
    if (stat.size > MAX_PACKAGE_BYTES) {
      throw new FwPkgError(
        "FWPKG_TOO_LARGE",
        `固件包过大（${stat.size} 字节，上限 ${MAX_PACKAGE_BYTES}）`,
      );
    }

    const dir = opts.tempDir ?? os.tmpdir();
    tempPath = path.join(
      dir,
      `ws63-fw-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}.bin`,
    );
    tempHandle = await fs.open(tempPath, "wx+");

    const hash = crypto.createHash("sha256");
    const chunk = Buffer.alloc(Math.min(chunkBytes, stat.size));
    let pos = 0;
    while (pos < stat.size) {
      if (stopSignal?.aborted) {
        throw new FwPkgError("FWPKG_ABORTED", "固件校验已取消");
      }
      const want = Math.min(chunk.length, stat.size - pos);
      const { bytesRead } = await source.read(chunk, 0, want, pos);
      if (bytesRead <= 0) {
        throw new FwPkgError(
          "FWPKG_SHORT_READ",
          `固件读取不足：在 ${pos} 处提前结束（期望 ${stat.size} 字节）`,
        );
      }
      hash.update(chunk.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const w = await tempHandle.write(chunk, written, bytesRead - written, pos + written);
        if (!w.bytesWritten) throw new FwPkgError("FWPKG_SNAPSHOT_WRITE", "固件快照写入失败");
        written += w.bytesWritten;
      }
      pos += bytesRead;
      opts.onProgress?.(pos, stat.size);
      // 让出事件循环：大包校验不应把主进程卡死（W29-11）
      await new Promise((resolve) => setImmediate(resolve));
    }

    const total = pos;
    if (total !== stat.size) {
      throw new FwPkgError(
        "FWPKG_SHORT_READ",
        `固件读取不足：期望 ${stat.size} 字节，实际 ${total}`,
      );
    }
    const sha256 = hash.digest("hex");

    // 摘要必须由**本次实际复制的那份字节**算出；与调用方期望值不符就直接拒绝。
    if (opts.expectedSha256 && sha256 !== opts.expectedSha256) {
      throw new FwPkgError(
        "FWPKG_CHANGED",
        "固件内容与预览摘要不一致（文件在选择之后被替换或修改），请重新选择固件",
      );
    }

    await tempHandle.sync();
    await source.close();
    source = null;

    // 从私有副本解析包头（小读，同步即可）
    const { fd } = tempHandle;
    const snapshot = buildSnapshotFromFd(fd, {
      path: tempPath,
      size: total,
      mtimeMs: stat.mtimeMs,
      sha256,
    });

    let closed = false;
    return {
      ...snapshot,
      sourcePath: abs,
      get closed() {
        return closed;
      },
      read(offset, length) {
        if (closed) throw new FwPkgError("FWPKG_READER_CLOSED", "固件句柄已关闭");
        if (!Number.isInteger(offset) || !Number.isInteger(length) || length <= 0) {
          throw new FwPkgError("FWPKG_BAD_READ", "固件读取参数非法");
        }
        if (offset < 0 || offset + length > total) {
          throw new FwPkgError(
            "FWPKG_OUT_OF_RANGE",
            `固件读取越界: ${offset}+${length} > ${total}`,
          );
        }
        const buf = Buffer.alloc(length);
        let done = 0;
        while (done < length) {
          const n = readSync(tempHandle.fd, buf, done, length - done, offset + done);
          if (n <= 0) {
            throw new FwPkgError("FWPKG_SHORT_READ", "固件快照读取不足");
          }
          done += n;
        }
        return buf;
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await tempHandle.close();
        } catch {
          /* ignore */
        }
        tempHandle = null;
        try {
          await fs.unlink(tempPath);
        } catch {
          /* ignore */
        }
      },
    };
  } catch (err) {
    if (source) {
      try {
        await source.close();
      } catch {
        /* ignore */
      }
    }
    if (tempHandle) {
      try {
        await tempHandle.close();
      } catch {
        /* ignore */
      }
    }
    if (tempPath) {
      try {
        await fs.unlink(tempPath);
      } catch {
        /* ignore */
      }
    }
    throw err;
  }
}
