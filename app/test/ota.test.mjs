import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  classifyAssetName,
  compareSemver,
  normalizeVersion,
  pickAsset,
  readAsarManifest,
  resolveInstallMode,
  sanitizeAssetFileName,
  verifyStagedPackage,
} from "../electron/ota/policy.js";
import { DownloadCancelledError, downloadToFile, DownloadTruncatedError } from "../electron/ota/download.js";

test("W05: 资源名/类型分类（zip / Setup.exe / 未知）", () => {
  assert.deepEqual(classifyAssetName("WS63BurnPro-win-x64.zip"), {
    type: "zip",
    name: "WS63BurnPro-win-x64.zip",
  });
  assert.equal(classifyAssetName("WS63BurnPro-Setup-1.1.2.exe").type, "installer");
  assert.equal(classifyAssetName("notes.txt").type, "unknown");
  assert.equal(classifyAssetName("").type, "unknown");
});

test("W05: 临时落盘文件名净化（不落到 update.bin，也不允许目录穿越）", () => {
  assert.equal(sanitizeAssetFileName("WS63BurnPro-win-x64.zip"), "WS63BurnPro-win-x64.zip");
  assert.equal(sanitizeAssetFileName("..\\..\\evil.exe"), "evil.exe");
  assert.equal(sanitizeAssetFileName(""), "update.bin");
  assert.equal(sanitizeAssetFileName("a\u0000b.zip"), "ab.zip");
});

test("W05/W06: 安装方式只认已验证资源类型，不看本地后缀", () => {
  assert.deepEqual(resolveInstallMode({ assetType: "zip", downloadPath: "C:/x.bin", packaged: true }), {
    mode: "zip",
  });
  assert.deepEqual(
    resolveInstallMode({ assetType: "installer", downloadPath: "C:/x.bin", packaged: true }),
    { mode: "installer" },
  );
  assert.throws(
    () => resolveInstallMode({ assetType: "unknown", downloadPath: "C:/x.zip", packaged: true }),
    (err) => {
      assert.equal(err.code, "OTA_UNKNOWN_ASSET");
      return true;
    },
  );
  assert.throws(
    () => resolveInstallMode({ assetType: "zip", downloadPath: "C:/x.zip", packaged: false }),
    (err) => err.code === "OTA_DEV_MODE",
  );
});

test("W05: pickAsset 优先精确名，其次产品 zip", () => {
  const assets = [
    { name: "notes.txt", browser_download_url: "u0" },
    { name: "WS63BurnPro-win-x64.zip", browser_download_url: "u1" },
    { name: "WS63BurnPro-Setup.exe", browser_download_url: "u2" },
  ];
  assert.equal(pickAsset(assets, "WS63BurnPro-win-x64.zip").browser_download_url, "u1");
  assert.equal(pickAsset(assets, "").browser_download_url, "u1");
  assert.equal(pickAsset([{ name: "WS63BurnPro-Setup.exe" }], "").name, "WS63BurnPro-Setup.exe");
});

test("W05: 版本比较", () => {
  assert.equal(normalizeVersion("v1.2.0"), "1.2.0");
  assert.equal(compareSemver("1.2.0", "1.1.9"), 1);
  assert.equal(compareSemver("v1.1.2", "1.1.2"), 0);
  assert.equal(compareSemver("1.0.0", "1.0.1"), -1);
});

test("W06: 真实 asar 的 package.json 可被读出（版本/产品校验依据）", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const candidates = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.startsWith("dist-electron")) continue;
    const asar = path.join(root, dir.name, "win-unpacked", "resources", "app.asar");
    if (fs.existsSync(asar)) candidates.push(asar);
  }
  if (!candidates.length) return; // 没有历史构建产物时跳过（不算失败）
  const manifest = readAsarManifest(candidates[0]);
  assert.ok(manifest, `应能解析 ${candidates[0]}`);
  assert.equal(manifest.name, "ws63-burn-pro");
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
});

test("W06: 暂存包结构校验能识别缺少 exe / asar / preload / 原生模块", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws63-ota-"));
  const empty = verifyStagedPackage({ root: dir });
  assert.equal(empty.ok, false);
  assert.ok(empty.problems.some((p) => p.includes("WS63BurnPro.exe")));
  assert.ok(empty.problems.some((p) => p.includes("app.asar")));
  assert.ok(empty.problems.some((p) => p.includes("preload")));
  assert.ok(empty.problems.some((p) => p.includes(".node")));
});

test("W06: 用真实 release 目录做一次正例（存在时）", () => {
  const root = path.resolve(import.meta.dirname, "..", "..", "release");
  if (!fs.existsSync(path.join(root, "WS63BurnPro.exe"))) return;
  const result = verifyStagedPackage({ root });
  assert.equal(result.ok, true, `真实 release 目录应通过校验：${result.problems.join("；")}`);
});

/* ------------------------------------------------------------------ 下载行为 */

function makeSlowStreamFetch({ total = 2048, chunkSize = 512 } = {}) {
  let produced = 0;
  return async (url, init) => {
    const signal = init?.signal;
    const body = {
      getReader() {
        return {
          async read() {
            if (signal?.aborted) throw new Error("aborted");
            await new Promise((r) => setTimeout(r, 5));
            if (produced >= total) return { done: true, value: undefined };
            produced += chunkSize;
            return { done: false, value: new Uint8Array(chunkSize) };
          },
          async cancel() {},
        };
      },
    };
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === "content-length" ? String(total) : null) },
      body,
    };
  };
}

function tmpDest(name = "update.zip") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws63-dl-"));
  return path.join(dir, name);
}

test("W05: 下载成功写入正式文件，且无 .part 残留", async () => {
  const dest = tmpDest();
  const result = await downloadToFile({
    fetchImpl: makeSlowStreamFetch({ total: 1024, chunkSize: 512 }),
    url: "https://example.invalid/WS63BurnPro-win-x64.zip",
    destPath: dest,
    deadlineMs: 5000,
  });
  assert.equal(result.path, dest);
  assert.equal(fs.statSync(dest).size, 1024);
  assert.equal(fs.existsSync(`${dest}.part`), false);
});

test("W05: 取消信号传到 fetch/reader —— 卡在读等待时也能及时取消并清理半包", async () => {
  const dest = tmpDest();
  const controller = new AbortController();
  const stuckFetch = async (url, init) => {
    // 模拟“永远不返回数据”的响应体：只有 abort 能打破等待
    const body = {
      getReader() {
        return {
          read() {
            return new Promise((_resolve, reject) => {
              init.signal.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            });
          },
          async cancel() {},
        };
      },
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body,
    };
  };

  const started = Date.now();
  const pending = downloadToFile({
    fetchImpl: stuckFetch,
    url: "https://example.invalid/x.zip",
    destPath: dest,
    signal: controller.signal,
    deadlineMs: 30000,
  });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(pending, (err) => {
    assert.ok(err instanceof DownloadCancelledError);
    assert.equal(err.code, "DOWNLOAD_CANCELLED");
    return true;
  });
  assert.ok(Date.now() - started < 2000, "取消应立即生效，而不是等整个超时");
  assert.equal(fs.existsSync(dest), false, "取消后不应留下正式文件");
  assert.equal(fs.existsSync(`${dest}.part`), false, "取消后不应留下半包");
});

test("W05: 下载不完整（content-length 不符）报错并清理", async () => {
  const dest = tmpDest();
  const fetchImpl = async (url, init) => {
    let sent = false;
    const body = {
      getReader() {
        return {
          async read() {
            if (init.signal?.aborted) throw new Error("aborted");
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new Uint8Array(100) };
          },
          async cancel() {},
        };
      },
    };
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === "content-length" ? "400" : null) },
      body,
    };
  };
  await assert.rejects(
    () =>
      downloadToFile({
        fetchImpl,
        url: "https://example.invalid/x.zip",
        destPath: dest,
        deadlineMs: 5000,
      }),
    (err) => {
      assert.ok(err instanceof DownloadTruncatedError);
      return true;
    },
  );
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(`${dest}.part`), false);
});

test("W05: deadline 到期会中止下载", async () => {
  const dest = tmpDest();
  const fetchImpl = async (url, init) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: () =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
        cancel: async () => {},
      }),
    },
  });
  await assert.rejects(
    () =>
      downloadToFile({
        fetchImpl,
        url: "https://example.invalid/x.zip",
        destPath: dest,
        deadlineMs: 1000,
      }),
    /超时|aborted/,
  );
  assert.equal(fs.existsSync(dest), false);
});
