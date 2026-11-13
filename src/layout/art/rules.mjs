/** 그리기 규칙 — PDK(ALIGN layers.json)의 금속 · 비아 값을 손으로 그리는 편집기가 쓰는 모양으로. 단위 nm.
 *
 *  이 PDK 는 금속마다 방향이 하나다 — 검사기가 그 방향으로 도형을 읽는다 (li1 ↕ · met1 ↔ · met2 ↕ · met3 ↔ · met4 ↕).
 *  PCB 처럼 한 층에서 L 자로 꺾을 수 없는 까닭이다: 꺾는 토막은 방향이 맞는 이웃 층으로 올리고, 꺾는 자리에 비아를 둔다.
 *
 *    배선   그 층의 트랙(중심선 = Offset + k·Pitch) 위, 폭은 그 층의 Width. 끝은 자유다 (검사기는 중심선만 본다)
 *    비아   Vk 는 Mk 와 Mk+1 사이. 컷 WidthX × WidthY, 위아래 금속은 그 층의 진행 방향으로 컷 반 + VencA,
 *           옆으로는 그 층의 폭 — 배선기가 내는 것과 같다 (via 의 met1 쪽 320 × 280 nm 처럼)
 *    길이   같은 넷 · 같은 트랙의 금속 한 덩이는 MinL 이상, 다른 넷의 끝과는 EndToEnd 이상 떨어진다
 */
import { PDK } from "../pdk/pdk.mjs";

const A = new Map(PDK.Abstraction.map((l) => [l.Layer, l]));
const first = (v) => (Array.isArray(v) ? v[0] : v);
const K = (name) => Number(name.slice(1));

const lo = K(PDK.design_info.bottom_signal_routing_layer), hi = K(PDK.design_info.top_signal_routing_layer);
/** 그릴 수 있는 금속 — 신호 배선 층 (SKY130: M1 ~ M5 = li1, met1 ~ met4) */
export const METALS = Array.from({ length: hi - lo + 1 }, (_, i) => `M${lo + i}`);
/** 그 사이의 비아 (V1 ~ V4 = mcon, via, via2, via3) */
export const VIAS = METALS.slice(0, -1).map((m) => `V${K(m)}`);

const metals = new Map(), vias = new Map();
for (const name of METALS) {
  const l = A.get(name);
  metals.set(name, {
    name, k: K(name), dir: l.Direction === "V" ? "v" : "h",
    pitch: first(l.Pitch), offset: first(l.Offset) ?? 0, width: first(l.Width),
    minL: l.MinL ?? 0, e2e: l.EndToEnd ?? 0,
  });
}
for (const name of VIAS) {
  const l = A.get(name);
  vias.set(name, { name, lo: l.Stack[0], hi: l.Stack[1], wx: l.WidthX, wy: l.WidthY, sx: l.SpaceX, sy: l.SpaceY,
                   encLo: l.VencA_L ?? 0, encHi: l.VencA_H ?? 0 });
}

/** 금속 하나 { name, k, dir "h"|"v", pitch, offset, width, minL, e2e } — 그릴 수 없는 층이면 null */
export const metal = (name) => metals.get(name) ?? null;
/** 비아 하나 { name, lo, hi, wx, wy, sx, sy, encLo, encHi } */
export const via = (name) => vias.get(name) ?? null;
/** 이웃한 두 금속 사이의 비아 이름 — 이웃이 아니면 null */
export function viaOf(a, b) {
  const i = K(a), j = K(b);
  return Math.abs(i - j) === 1 && vias.has(`V${Math.min(i, j)}`) ? `V${Math.min(i, j)}` : null;
}
/** 위 · 아래 이웃 금속 (그릴 수 있는 것만) */
export const above = (name) => (metals.has(`M${K(name) + 1}`) ? `M${K(name) + 1}` : null);
export const below = (name) => (metals.has(`M${K(name) - 1}`) ? `M${K(name) - 1}` : null);
/** 꺾는 층 — 방향이 다른 이웃. 위가 먼저, 맨 위 층이면 아래 */
export const turnLayer = (name) => above(name) ?? below(name);

/** v 에서 가장 가까운 트랙 */
export function snap(name, v) {
  const m = metals.get(name);
  return m.offset + Math.round((v - m.offset) / m.pitch) * m.pitch;
}
export function onTrack(name, v) {
  const m = metals.get(name), q = (v - m.offset) / m.pitch;
  return Math.abs(q - Math.round(q)) < 1e-9;
}
/** [a, b] 안의 트랙들 (a ≤ b) */
export function tracksIn(name, a, b) {
  const m = metals.get(name), out = [];
  for (let k = Math.ceil((a - m.offset) / m.pitch - 1e-9); m.offset + k * m.pitch <= b + 1e-9; k++) out.push(m.offset + k * m.pitch);
  return out;
}

/** 배선 토막의 사각형. 세로 층은 x0 = x1 (트랙), 가로 층은 y0 = y1. w 를 주지 않으면 층의 폭 */
export function wireRect(w) {
  const m = metals.get(w.layer), half = (w.w ?? m.width) / 2;
  return m.dir === "v"
    ? [w.x0 - half, Math.min(w.y0, w.y1), w.x0 + half, Math.max(w.y0, w.y1)]
    : [Math.min(w.x0, w.x1), w.y0 - half, Math.max(w.x0, w.x1), w.y0 + half];
}

/** 비아의 도형 — 컷과 위아래 금속 [{layer, rect, role: "cut"|"lo"|"hi"}] */
export function viaShapes(v) {
  const V = vias.get(v.layer);
  const cut = [v.x - V.wx / 2, v.y - V.wy / 2, v.x + V.wx / 2, v.y + V.wy / 2];
  const enc = (layer, ext) => {
    const m = metals.get(layer);
    return m.dir === "v"
      ? [v.x - m.width / 2, v.y - (V.wy / 2 + ext), v.x + m.width / 2, v.y + (V.wy / 2 + ext)]
      : [v.x - (V.wx / 2 + ext), v.y - m.width / 2, v.x + (V.wx / 2 + ext), v.y + m.width / 2];
  };
  return [
    { layer: v.layer, rect: cut, role: "cut" },
    { layer: V.lo, rect: enc(V.lo, V.encLo), role: "lo" },
    { layer: V.hi, rect: enc(V.hi, V.encHi), role: "hi" },
  ];
}

/** 이 점에 비아가 설 수 있나 — 세로 층의 x 와 가로 층의 y 가 둘 다 트랙 위 */
export function viaFits(layer, x, y) {
  const V = vias.get(layer);
  if (!V) return false;
  for (const m of [V.lo, V.hi]) {
    const M = metals.get(m);
    if (!onTrack(m, M.dir === "v" ? x : y)) return false;
  }
  return true;
}

/** 사각형 두 개가 겹치거나 닿는다 */
export const touch = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
/** 넓이가 있게 겹친다 */
export const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
