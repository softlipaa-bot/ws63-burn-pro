/** 顶栏分页的方向键，以及烧录中的 Esc。输入框和已打开的菜单不抢 Esc。 */

export function nextTabIndex(current, key, length) {
  const count = Number(length) || 0;
  if (count <= 0) return null;
  const index = Math.min(Math.max(Number(current) || 0, 0), count - 1);
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export function escapeStopsFlash(input) {
  if (!input?.flashing) return false;
  if (input.key !== "Escape" || input.repeat) return false;
  if (input.defaultPrevented) return false;
  const tag = String(input.targetTag || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  if (input.editable || input.inPopup) return false;
  return true;
}
