/** 路数切换：普通卡片重排约 160ms。 */

export const SLOT_ANIM_MS = 160;
export const SLOT_ANIM_REDUCED_MS = 64;

export function slotAnimDuration(reduced) {
  return reduced ? SLOT_ANIM_REDUCED_MS : SLOT_ANIM_MS;
}

export function shouldPopLeavingSlot(reduced) {
  return !reduced;
}
