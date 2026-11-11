/**
 * 固件能力令牌 + 路径一致性仲裁（W29-06）。
 *
 * 旧实现的问题（已复现）：
 * - `App.vue` 的 `applyFirmwareToAll` 只复制 `firmwarePaths`，不复制/清空 `firmwareTokens`；
 * - 拖拽改 `firmwarePaths` 却不清 `firmwareTokens`；
 * - 后端 `resolveFirmware` 有 token 时**优先用 token.path**，完全忽略 renderer 传来的路径。
 * 结果：UI 显示的是 B，实际烧的是 A（上一次选中的文件）。
 *
 * 现在的契约：
 * - 只要同时给了路径与令牌，两者的规范化结果必须一致，否则拒绝（FWPKG_TOKEN_MISMATCH）。
 * - 令牌只是“已校验过的文件”的句柄，**永远**要重新做存在性/大小/摘要校验。
 * - 令牌表有 TTL 与容量上限（W29-14 的容量/淘汰部分在此落地）。
 */

import crypto from "crypto";

import * as guard from "../ipc-guard.js";
import { FwPkgError, inspectFwpkg } from "./fwpkg.js";

export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/** 令牌表容量上限：超出时按“最近使用”淘汰最旧的非占用令牌。 */
export const MAX_FIRMWARE_TOKENS = 64;

/** @type {Map<string, {path: string, sha256: string, size: number, created: number, usedAt: number}>} */
const firmwareTokens = new Map();

/**
 * 正在被运行中的烧录任务使用的令牌（R1）。
 * 这些令牌**绝不**参与容量淘汰：否则连续烧录 64 次后，界面仍持有的令牌会被删掉，
 * 用户看到“令牌无效，请重新选择”。
 * @type {Set<string>}
 */
const pinnedTokens = new Set();

export function pinFirmwareToken(token) {
  if (typeof token === "string" && token) pinnedTokens.add(token);
}

export function unpinFirmwareToken(token) {
  if (typeof token === "string" && token) pinnedTokens.delete(token);
}

export function pinnedTokenCount() {
  return pinnedTokens.size;
}

function pruneTokens(now = Date.now()) {
  for (const [token, entry] of [...firmwareTokens]) {
    if (now - entry.created > TOKEN_TTL_MS && !pinnedTokens.has(token)) {
      firmwareTokens.delete(token);
    }
  }
  // 只淘汰未被占用、且最近未使用的令牌；容量是安全阀，不是正确性来源
  while (firmwareTokens.size > MAX_FIRMWARE_TOKENS) {
    let victim = null;
    let victimAt = Infinity;
    for (const [token, entry] of firmwareTokens) {
      if (pinnedTokens.has(token)) continue;
      const at = entry.usedAt ?? entry.created;
      if (at < victimAt) {
        victimAt = at;
        victim = token;
      }
    }
    if (!victim) break; // 全被占用：宁可超容量也不删活令牌
    firmwareTokens.delete(victim);
  }
}

export function issueFirmwareToken(snapshot) {
  const token = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  firmwareTokens.set(token, {
    path: snapshot.path,
    sha256: snapshot.sha256,
    size: snapshot.size,
    created: now,
    usedAt: now,
  });
  pruneTokens();
  return token;
}

export function lookupFirmwareToken(token) {
  if (typeof token !== "string" || !token) return null;
  const entry = firmwareTokens.get(token);
  if (!entry) return null;
  if (Date.now() - entry.created > TOKEN_TTL_MS) {
    firmwareTokens.delete(token);
    return null;
  }
  return entry;
}

/** 刷新最近使用时间（LRU），不改变令牌本身。 */
export function touchFirmwareToken(token) {
  const entry = lookupFirmwareToken(token);
  if (!entry) return false;
  entry.usedAt = Date.now();
  return true;
}

export function tokenCount() {
  return firmwareTokens.size;
}

/** 仅测试/诊断用。 */
export function resetFirmwareTokens() {
  firmwareTokens.clear();
  pinnedTokens.clear();
}

/** 路径比较：Windows 大小写不敏感，斜杠方向归一。 */
export function sameFirmwarePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const norm = (p) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * renderer 只能提供“路径（按策略校验）”或“能力令牌”；两者都要重新做完整校验与摘要绑定。
 * 同时提供时，两者必须指向同一个文件（否则就是“UI 显示 B、实际烧 A”的竞态）。
 *
 * @param {{token?: string, filePath?: string, path?: string}} params
 * @param {{label?: string, inspect?: (p: string) => any, issueNewToken?: boolean}} [opts]
 */
export function resolveFirmware(params, opts = {}) {
  const label = opts.label ?? "固件";
  const inspect = opts.inspect ?? inspectFwpkg;

  const tokenEntry = lookupFirmwareToken(params?.token);
  if (params?.token && !tokenEntry) {
    throw new guard.IpcError("IPC_BAD_PARAMS", `${label}令牌无效或已过期，请重新选择文件`);
  }

  const rawPath = params?.filePath ?? params?.path;
  const hasPathParam = rawPath !== undefined && rawPath !== null && rawPath !== "";
  const pathFromParam = hasPathParam ? guard.assertFirmwarePathPolicy(rawPath, { label }) : null;

  if (tokenEntry && pathFromParam && !sameFirmwarePath(pathFromParam, tokenEntry.path)) {
    throw new guard.IpcError(
      "FWPKG_TOKEN_MISMATCH",
      `${label}路径与授权令牌不一致（界面路径 ${basename(pathFromParam)}，令牌指向 ${basename(
        tokenEntry.path,
      )}），请重新选择固件`,
    );
  }

  const filePath = tokenEntry ? tokenEntry.path : pathFromParam;
  if (!filePath) {
    throw new guard.IpcError("IPC_BAD_PARAMS", `${label}路径为空`);
  }

  let snapshot;
  try {
    snapshot = inspect(filePath);
  } catch (err) {
    if (err instanceof FwPkgError) {
      throw new guard.IpcError(err.code, `${label}不可用：${err.message}`);
    }
    throw err;
  }
  if (tokenEntry && tokenEntry.sha256 !== snapshot.sha256) {
    throw new guard.IpcError("FWPKG_CHANGED", `${label}文件已变化，请重新选择`);
  }

  // R1：复用有效令牌（并刷新 LRU）；只有“重新选择文件”才签发新令牌。
  // 旧实现每次 resolve 都签发新 token，而 start_flash 从不把新 token 回传 UI，
  // 于是连续烧录 64 次后 UI 手里的活令牌被容量淘汰。
  let token;
  let reusedToken = false;
  if (tokenEntry && !opts.issueNewToken) {
    touchFirmwareToken(params.token);
    token = params.token;
    reusedToken = true;
  } else {
    token = issueFirmwareToken(snapshot);
  }
  return { snapshot, token, reusedToken };
}

function basename(p) {
  const parts = String(p ?? "").replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || String(p ?? "");
}
