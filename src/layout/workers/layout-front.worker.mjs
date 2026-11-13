/** 앞단 워커 — 레이아웃 넷리스트(SKY130 .subckt)를 원시 소자와 셀 도형으로 (../front, ALIGN 을 JS 로 옮긴 것).
 *    postMessage({ text, top, userConstraints }) -> { type: "front", blob, groups, ms } | { type: "error", msg } */
import { runFrontEnd } from "../front/index.mjs";

self.onmessage = (e) => {
  const { text, top, userConstraints } = e.data ?? {};
  try {
    const t0 = performance.now();
    const { blob, groups } = runFrontEnd(text, top, { userConstraints });
    postMessage({ type: "front", blob, groups, ms: performance.now() - t0 });
  } catch (err) {
    postMessage({ type: "error", msg: `${err?.message ?? err}\n${err?.stack ?? ""}`.slice(0, 1500) });
  }
};
