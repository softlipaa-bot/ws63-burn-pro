import fs from "fs";
import path from "path";

/**
 * 更新包下载（W05）。
 *
 * - 取消信号与整体 deadline 一路传到底层 fetch 和 reader，卡在读等待时也能及时取消；
 * - 先写 `.part` 临时文件，完整校验通过才 rename 成正式文件名，失败/取消都清理半包；
 * - content-length 存在时校验实收字节数，短包直接失败。
 */

export class DownloadCancelledError extends Error {
  constructor(message = "下载已取消") {
    super(message);
    this.name = "DownloadCancelledError";
    this.code = "DOWNLOAD_CANCELLED";
  }
}

export class DownloadTimeoutError extends Error {
  constructor(message = "下载超时") {
    super(message);
    this.name = "DownloadTimeoutError";
    this.code = "DOWNLOAD_TIMEOUT";
  }
}

export class DownloadTruncatedError extends Error {
  constructor(received, expected) {
    super(`下载不完整：收到 ${received} 字节，应为 ${expected} 字节`);
    this.name = "DownloadTruncatedError";
    this.code = "DOWNLOAD_TRUNCATED";
  }
}

function unlinkQuiet(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/**
 * @param {{
 *   fetchImpl: (url: string, init: any) => Promise<any>,
 *   url: string,
 *   destPath: string,
 *   headers?: Record<string, string>,
 *   signal?: AbortSignal,
 *   deadlineMs?: number,
 *   onProgress?: (percent: number) => void,
 *   onChunk?: (received: number, total: number) => void,
 * }} opts
 */
export async function downloadToFile(opts) {
  const {
    fetchImpl,
    url,
    destPath,
    headers = {},
    signal,
    deadlineMs = 10 * 60 * 1000,
    onProgress,
    onChunk,
  } = opts;

  if (typeof fetchImpl !== "function") throw new Error("缺少 fetch 实现");
  if (!url) throw new Error("缺少下载地址");

  const controller = new AbortController();
  let abortReason = null;
  const abortOnce = (reason) => {
    if (abortReason) return;
    abortReason = reason;
    controller.abort();
  };

  const onCallerAbort = () => abortOnce(new DownloadCancelledError());
  if (signal) {
    if (signal.aborted) throw new DownloadCancelledError();
    signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => abortOnce(new DownloadTimeoutError()), Math.max(1000, deadlineMs));

  const partPath = `${destPath}.part`;
  unlinkQuiet(partPath);
  unlinkQuiet(destPath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  let file = null;
  let reader = null;
  try {
    const res = await fetchImpl(url, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res?.ok) {
      throw new Error(`下载失败 HTTP ${res?.status ?? "?"}`);
    }
    if (!res.body) throw new Error("下载响应无内容");

    const total = Number(res.headers?.get?.("content-length") || 0);
    reader = res.body.getReader();
    file = fs.createWriteStream(partPath);
    let received = 0;

    for (;;) {
      if (abortReason) throw abortReason;
      const { done, value } = await raceAbort(reader.read(), controller.signal, () => abortReason);
      if (done) break;
      if (!value?.byteLength) continue;
      received += value.byteLength;
      await new Promise((resolve, reject) => {
        file.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
      });
      if (onChunk) onChunk(received, total);
      if (total > 0 && onProgress) {
        onProgress(Math.min(99, Math.round((received / total) * 100)));
      }
    }

    await new Promise((resolve, reject) => {
      file.end((err) => (err ? reject(err) : resolve()));
    });
    file = null;

    if (total > 0) {
      const stat = fs.statSync(partPath);
      if (stat.size !== total) throw new DownloadTruncatedError(stat.size, total);
    }
    if (abortReason) throw abortReason;
    fs.renameSync(partPath, destPath);
    if (onProgress) onProgress(100);
    return { path: destPath, size: fs.statSync(destPath).size };
  } catch (err) {
    // 取消/失败都要清理半包与底层句柄
    try {
      await reader?.cancel?.();
    } catch {
      /* ignore */
    }
    if (file) {
      try {
        file.destroy();
      } catch {
        /* ignore */
      }
    }
    unlinkQuiet(partPath);
    unlinkQuiet(destPath);
    if (abortReason) throw abortReason;
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onCallerAbort);
  }
}

/** reader.read() 与 abort 竞速，保证“卡在读等待”也能取消。 */
function raceAbort(promise, signal, getReason) {
  if (signal.aborted) {
    return Promise.reject(getReason() ?? new DownloadCancelledError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(getReason() ?? new DownloadCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
