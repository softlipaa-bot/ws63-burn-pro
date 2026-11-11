/**
 * 工作站状态文案。
 * 把“串口已选择 / 正在监听 / 等待按 RST / 正在握手 / 握手成功 / 正在烧录 / 启动未验证”分开。
 * bootVerified 在协议里恒为 false，成功态不能画成“已验证启动”。
 */

const ACTIVE = new Set([
  "pending",
  "prepare",
  "wait_reset",
  "handshake",
  "handshake_ok",
  "flashing",
]);

export function flashPhase(channel, outcome = "") {
  const ch = channel ?? {};
  const result = String(outcome || "");
  if (ch.pending && !ch.running && ch.status !== "running") {
    return { id: "pending", label: "准备中", tone: "warning" };
  }
  if (ch.running || ch.status === "running") {
    switch (ch.stage) {
      case "wait_reset":
        return { id: "wait_reset", label: "等待按 RST", tone: "warning" };
      case "handshake":
        return { id: "handshake", label: "正在握手", tone: "warning" };
      case "baud_switch":
      case "loader_transfer":
      case "loader_confirm":
        return { id: "handshake_ok", label: "握手成功", tone: "primary" };
      case "prepare":
        return { id: "prepare", label: "正在准备", tone: "warning" };
      default:
        return { id: "flashing", label: "正在烧录", tone: "warning" };
    }
  }
  if (result === "cancelled") {
    return { id: "cancelled", label: "已取消", tone: "neutral" };
  }
  if (ch.status === "success" || result === "success") {
    return { id: "unverified", label: "启动未验证", tone: "warning" };
  }
  if (result === "partial") {
    return { id: "partial", label: "未完全成功", tone: "error" };
  }
  if (ch.status === "error") {
    return { id: "error", label: "失败", tone: "error" };
  }
  return { id: "idle", label: "空闲", tone: "neutral" };
}

export function monitorPhase(serial) {
  if (serial?.connected) return { id: "listening", label: "正在监听", tone: "success" };
  if (serial?.portSelected) return { id: "port_selected", label: "串口已选择", tone: "neutral" };
  return { id: "idle", label: "未连接", tone: "neutral" };
}

export function globalPhase({ phases, listening }) {
  const list = phases ?? [];
  const count = (id) => list.filter((item) => item.id === id).length;
  const wait = count("wait_reset");
  const shake = count("handshake");
  const shook = count("handshake_ok");
  const flashing = list.filter((item) => ACTIVE.has(item.id)).length;
  if (wait) {
    return {
      id: "wait_reset",
      label: wait > 1 ? `${wait} 路等待按 RST` : "等待按 RST",
      tone: "warning",
    };
  }
  if (shake) {
    return {
      id: "handshake",
      label: shake > 1 ? `${shake} 路正在握手` : "正在握手",
      tone: "warning",
    };
  }
  if (shook && flashing === shook) {
    return { id: "handshake_ok", label: "握手成功", tone: "primary" };
  }
  if (flashing) {
    return {
      id: "flashing",
      label: flashing > 1 ? `${flashing} 路烧录中` : "正在烧录",
      tone: "warning",
    };
  }
  if (listening > 1) {
    return { id: "listening", label: `${listening} 路正在监听`, tone: "success" };
  }
  if (listening === 1) {
    return { id: "listening", label: "正在监听", tone: "success" };
  }
  const partial = count("partial");
  const errors = count("error");
  if (partial && !errors) {
    return {
      id: "partial",
      label: partial > 1 ? `${partial} 路未完全成功` : "未完全成功",
      tone: "error",
    };
  }
  if (partial + errors > 0) {
    const bad = partial + errors;
    return {
      id: "error",
      label: bad > 1 ? `${bad} 路失败` : "有失败通道",
      tone: "error",
    };
  }
  if (count("unverified")) {
    return { id: "unverified", label: "启动未验证", tone: "warning" };
  }
  if (count("cancelled")) {
    return { id: "cancelled", label: "已取消", tone: "neutral" };
  }
  return { id: "ready", label: "就绪", tone: "neutral" };
}

export function progressCaption(channel, outcome = "") {
  const phase = flashPhase(channel, outcome);
  if (phase.id === "unverified") return "协议完成（启动未验证）";
  if (phase.id === "partial") return "未完全成功";
  if (phase.id === "cancelled") return "已取消";
  const stage = channel?.stageLabel || "";
  const part = channel?.partName || "";
  if (stage && part && part !== stage) return `${stage} · ${part}`;
  return stage || part || "进度";
}
