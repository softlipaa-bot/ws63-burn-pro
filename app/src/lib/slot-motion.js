/** 路数切换：普通动画约 480ms；减少动效时只留极短的一帧，用来关掉毛玻璃。 */

export const SLOT_ANIM_MS = 480;
export const SLOT_ANIM_REDUCED_MS = 64;

export function slotAnimDuration(reduced) {
  return reduced ? SLOT_ANIM_REDUCED_MS : SLOT_ANIM_MS;
}

export function shouldPopLeavingSlot(reduced) {
  return !reduced;
}
