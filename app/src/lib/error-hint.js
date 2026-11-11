/**
 * 按错误码给下一步。匹配的是码，不是中文句子。
 * 没有码时只显示原始 message。IPC_UNTRUSTED_SENDER 不展示给操作者。
 */

const HINTS = {
  IPC_BAD_PARAMS: "请重新选择固件后再试。",
  FWPKG_CHANGED: "文件内容和上次选择时不一致。请重新选择固件。",
  FWPKG_TOKEN_MISMATCH: "固件令牌和当前文件对不上。请重新选择固件。",
  PORT_BUSY: "这个串口正被占用。先断开占用它的烧录或监听。",
  PORT_OPEN_FAILED: "串口没有打开。检查线缆和端口后再试。",
  WRITE_TIMEOUT: "写入没有在时限内完成。可以重试，或更换串口线。",
  HANDSHAKE_TIMEOUT: "60 秒内没有进入下载模式。确认按的是板上 RST，并检查接线。",
  ACK_TIMEOUT: "设备应答超时。查看当前阶段。",
  ERASE_ACK_TIMEOUT: "擦除应答超时。查看当前阶段。",
};

export function hintForErrorCode(code) {
  if (!code) return "";
  return HINTS[String(code)] || "";
}

export function describeFailure(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code || "") : "";
  const message = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      ? String(error.message ?? "失败")
      : String(error ?? "失败");
  return {
    code,
    message,
    hidden: code === "IPC_UNTRUSTED_SENDER",
    hint: hintForErrorCode(code),
  };
}
