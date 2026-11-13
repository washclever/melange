/** 월드 <-> 화면 변환. 변환을 한곳에 모아 두지 않으면 배율마다 다른 버그가 생긴다 */
import type { Pt } from "./snap.ts";
import type { FeelProfile } from "./profile.ts";

export interface Viewport {
  /** 화면 (0,0) 에 해당하는 월드 좌표 */
  at: Pt;
  /** 월드 1단위당 화면 px */
  scale: number;
}

export const toScreen = (v: Viewport, w: Pt): Pt =>
  [(w[0] - v.at[0]) * v.scale, (w[1] - v.at[1]) * v.scale];

export const toWorld = (v: Viewport, s: Pt): Pt =>
  [s[0] / v.scale + v.at[0], s[1] / v.scale + v.at[1]];

/**
 * 커서 밑의 월드 좌표를 고정한 채 확대·축소한다.
 * 화면 중앙 기준으로 하면 즉시 틀린 느낌이 난다.
 */
export function zoomAt(v: Viewport, screenPt: Pt, factor: number, p: FeelProfile): Viewport {
  const before = toWorld(v, screenPt);
  const scale = Math.max(p.zoomMin, Math.min(p.zoomMax, v.scale * factor));
  return { scale, at: [before[0] - screenPt[0] / scale, before[1] - screenPt[1] / scale] };
}

/** 휠 이벤트를 배율로 바꾼다. 마우스(line)와 트랙패드(pixel)는 크기가 전혀 다르다 */
export function wheelFactor(e: WheelEvent, p: FeelProfile): number {
  if (e.ctrlKey || e.deltaMode === 0) {
    // 트랙패드 핀치, 또는 픽셀 단위 스크롤
    return Math.exp(-e.deltaY * p.trackpadPinchScale);
  }
  // 마우스 휠 한 칸
  return e.deltaY < 0 ? p.zoomStepPerNotch : 1 / p.zoomStepPerNotch;
}
