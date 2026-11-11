/**
 * Codex 复审补充：取消必须从**真实写入取消 / 真实快照取消**一路传导到 IPC/UI 结论，
 * 且判定依据是**错误码**，不是中文文案匹配。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SerialError, SerialSession } from "../electron/burn/serial-session.js";
import { FLASH_OUTCOME, classifyFlashError, isCancellation } from "../electron/burn/flash-outcome.js";
import { openImmutableFwpkgSnapshot } from "../electron/burn/stable-snapshot.js";
import { Ws63Flasher } from "../electron/burn/ws63flash.js";
import { makeValidPackage } from "./fixtures.mjs";
import { FakeSerialPort, sleep } from "./fake-serial-port.mjs";

test("取消链路 1: 写入被 AbortSignal 取消 → SerialError(ABORTED) → classification = 取消", async () => {
  const port = new FakeSerialPort({
    path: "COM9",
    onWrite: () => {
      /* 永不回应答，让流程停在写入/等待 */
    },
  });
  // 让写永不回调，确保只有 AbortSignal 能结束它
  port.write = () => {};
  const session = new SerialSession(port);
  session.markOpen();

  const controller = new AbortController();
  const pending = session.write(Buffer.from([1]), { stopSignal: controller.signal });
  controller.abort();

  let caught = null;
  try {
    await pending;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof SerialError);
  assert.equal(caught.code, "ABORTED");
  assert.equal(isCancellation(caught), true, "必须凭 code 判定为取消");

  const verdict = classifyFlashError(caught);
  assert.equal(verdict.outcome, FLASH_OUTCOME.CANCELLED);
  assert.equal(verdict.cancelled, true);
  assert.equal(verdict.ok, false, "取消绝不能是成功");
  assert.equal(verdict.status, "idle", "取消不应显示为错误状态");
});

test("取消链路 2: 固件快照复制中途取消 → FWPKG_ABORTED → classification = 取消", async () => {
  const file = makeValidPackage();
  const controller = new AbortController();
  const pending = openImmutableFwpkgSnapshot(file, { stopSignal: controller.signal });
  controller.abort(); // 立刻取消（复制循环会检查）

  let caught = null;
  try {
    await pending;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "必须抛错而不是静默成功");
  assert.equal(caught.code, "FWPKG_ABORTED");
  const verdict = classifyFlashError(caught);
  assert.equal(verdict.outcome, FLASH_OUTCOME.CANCELLED);
  assert.equal(verdict.cancelled, true);
  assert.equal(verdict.status, "idle");
});

test("取消链路 3: 真 flash() 在握手写入阶段被取消 → 结论为取消而非设备失败", async () => {
  const controller = new AbortController();
  const flasher = new Ws63Flasher({
    emit: () => {},
    stopSignal: controller.signal,
    timing: { resetTimeout: 3000, handshakeRetryMs: 200, writeTimeout: 5000, handshakeFrameMinGapMs: 5 },
    createPort: async () => {
      const port = new FakeSerialPort({ path: "COM9" });
      port.write = () => {}; // 写永不回调：只有取消能结束
      return port;
    },
  });
  await flasher.openPort("COM9", 921600);

  const running = flasher.flash(makeValidPackage());
  await sleep(30);
  controller.abort();

  let caught = null;
  try {
    await running;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "取消必须让 flash 结束（抛错）");
  const verdict = classifyFlashError(caught);
  assert.equal(
    verdict.outcome,
    FLASH_OUTCOME.CANCELLED,
    `真实链路取消应判为取消，实际 ${verdict.outcome}（code=${caught.code}）`,
  );
  // 措辞上也要是"已取消"，不能出现成功字样
  assert.equal(/成功|完成/.test(verdict.message) && !/取消/.test(verdict.message), false);
});
