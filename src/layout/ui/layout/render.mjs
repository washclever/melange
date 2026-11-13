/** 레이아웃 그리기 — 바탕(격자·배선 도형)과 덧칠(블록 윤곽·고른 것·플라이라인·그리는 중·오류 표식·재기).
 *
 *  배선 도형은 많다 (수천~수만 사각형). 커서를 따라 덧칠만 바뀔 때는 바탕을 다시 그리지 않게, 바탕을 화면 밖 캔버스에
 *  그려 두고 열쇠(배선 판·변환·보이는 층·고른 넷·테마)가 같으면 그대로 붙인다.
 *
 *  좌표: 도형(geo)과 배치(ours)는 PDK 단위(nm). 그린 트랙의 덧칠은 art-render.mjs 에 있다.
 */
import { drawEmpty } from "../canvas/viewport.mjs";
import { COLOR, GROUP_OF, ALPHA, viaBetween } from "./layers.mjs";

const MONO = "ui-monospace, Menlo, Consolas, monospace";
const METAL_ORDER = ["M1", "M2", "M3", "M4", "M5", "M6"];

// ---------------------------------------------------------------- 바탕
const buckets = new WeakMap();          // geo -> Map(층 -> [terminal])
function byLayer(geo) {
  let b = buckets.get(geo);
  if (!b) {
    b = new Map();
    for (const t of geo.terminals) {
      if (t.layer === "Outline" || !COLOR.has(t.layer)) continue;
      (b.get(t.layer) ?? b.set(t.layer, []).get(t.layer)).push(t);
    }
    buckets.set(geo, b);
  }
  return b;
}

/** 격자 — 가로 피치 gx, 세로 피치 gy (배치 격자 = M1·M3 와 M2·M4 의 트랙). 6 px 보다 촘촘하면 배수로 */
export function drawGrid(ctx, m, panel, pal, [gx, gy]) {
  if (!(m.S > 0) || !Number.isFinite(m.S) || panel.w < 1 || panel.h < 1) return [gx, gy];
  const step = (g) => { let k = 1; for (let i = 0; i < 80 && g * k * m.S < 6; i++) k *= k === 1 ? 5 : 2; return g * k; };
  const sx = step(gx), sy = step(gy);
  const x0 = m.toX(panel.x), x1 = m.toX(panel.x + panel.w), yTop = m.toY(panel.y), yBot = m.toY(panel.y + panel.h);
  ctx.save();
  ctx.lineWidth = 1;
  const lines = (major) => {
    ctx.beginPath();
    for (let k = Math.ceil(x0 / sx); k * sx <= x1; k++) {
      if ((k % 10 === 0) !== major) continue;
      const X = Math.round(m.X(k * sx)) + 0.5; ctx.moveTo(X, panel.y); ctx.lineTo(X, panel.y + panel.h);
    }
    for (let k = Math.ceil(yBot / sy); k * sy <= yTop; k++) {
      if ((k % 10 === 0) !== major) continue;
      const Y = Math.round(m.Y(k * sy)) + 0.5; ctx.moveTo(panel.x, Y); ctx.lineTo(panel.x + panel.w, Y);
    }
    ctx.stroke();
  };
  ctx.strokeStyle = pal.grid; ctx.globalAlpha = 0.55; lines(false);
  ctx.strokeStyle = pal.gridMajor; ctx.globalAlpha = 0.7; lines(true);
  ctx.restore();
  return [sx, sy];
}

/** 배선 도형을 층 차례로. focus(넷 이름 Set)를 주면 그 넷만 제 색, 나머지는 흐리게. active 층은 금속 맨 위에 */
export function drawGeometry(ctx, m, geo, { vis, focus = null, active = null, keep = null }) {
  const b = byLayer(geo);
  let drawn = 0;
  // keep: 이 층들만 또렷하게 (그리기 층과 꺾는 층, 그 사이 비아) — 나머지는 옅게
  const kept = (layer) => !keep || keep.has(layer) || (GROUP_OF.get(layer) === "via" && viaBetween(layer).every((q) => q && keep.has(q)));
  const paint = (layer, a0) => {
    const list = b.get(layer);
    if (!list || !vis.has(layer)) return;
    const a = kept(layer) ? a0 : a0 * 0.14;
    ctx.fillStyle = COLOR.get(layer);
    for (const t of list) {
      const r = t.rect;
      const x = m.X(r[0]), y = m.Y(r[3]);
      const w = Math.max(0.6, (r[2] - r[0]) * m.S), h = Math.max(0.6, (r[3] - r[1]) * m.S);
      ctx.globalAlpha = focus && !(t.netName && focus.has(t.netName)) ? a * 0.15 : a;
      ctx.fillRect(x, y, w, h);
      drawn++;
    }
  };
  for (const [layer] of b) if (GROUP_OF.get(layer) === "well") paint(layer, ALPHA.well);
  for (const [layer] of b) if (GROUP_OF.get(layer) === "device") paint(layer, ALPHA.device);
  const metals = METAL_ORDER.filter((l) => l !== active);
  if (active && METAL_ORDER.includes(active)) metals.push(active);
  for (const l of metals) paint(l, ALPHA.metal);
  for (const [layer] of b) if (GROUP_OF.get(layer) === "via") paint(layer, ALPHA.via);
  ctx.globalAlpha = 1;
  return drawn;
}

/** 바탕 캔버스 — 열쇠가 같으면 다시 안 그린다 */
export function createBaseCache(doc) {
  let cv = null, key = "";
  return function base(ctx, W, H, dpr, k, paint) {
    if (!cv) cv = doc.createElement("canvas");
    const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; key = ""; }
    if (k !== key) {
      const c = cv.getContext("2d");
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, pw, ph);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(c);
      key = k;
    }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(cv, 0, 0); ctx.restore();
  };
}

// ---------------------------------------------------------------- 블록
/** 배치된 블록 — 배선 전이면 칠하고, 배선 뒤면 윤곽과 이름만 (금속을 가리지 않게). hi 는 밝힐 블록 이름 Set */
export function drawBlocks(ctx, m, pal, rects, { routed, vis, hi = null, probe = null }) {
  if (!rects?.length) return;
  ctx.save();
  ctx.font = `500 10px ${MONO}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const r of rects) {
    const px = m.X(r.x), py = m.Y(r.y + r.h), pw = r.w * m.S, ph = r.h * m.S;
    if (!routed && vis.has("blocks")) { ctx.globalAlpha = 0.45; ctx.fillStyle = pal.block; ctx.fillRect(px, py, pw, ph); }
    if (vis.has("blocks")) {
      ctx.globalAlpha = routed ? 0.8 : 1; ctx.strokeStyle = pal.blockLine; ctx.lineWidth = 1;
      if (routed) ctx.setLineDash([5, 3]);
      ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1); ctx.setLineDash([]);
    }
    const on = hi?.has(r.name), pr = probe?.has(r.name);
    if (on || pr) {
      ctx.globalAlpha = 1; ctx.strokeStyle = on ? pal.ours : pal.probe; ctx.lineWidth = on ? 2.5 : 2;
      ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
    }
    if (vis.has("names") && pw > 34 && ph > 13) {
      ctx.globalAlpha = routed ? 0.85 : 1;
      const t = r.name.replace(/^X_?/, "");
      const label = t.length > 14 ? t.slice(0, 13) + "…" : t;
      if (routed) {                          // 금속 위에서 읽히게 바탕을 깐다
        const w = ctx.measureText(label).width + 6;
        ctx.fillStyle = pal.canvas; ctx.globalAlpha = 0.75; ctx.fillRect(px + pw / 2 - w / 2, py + ph / 2 - 7, w, 14);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = pal.ink;
      ctx.fillText(label, px + pw / 2, py + ph / 2);
    }
  }
  ctx.restore();
}

/** 배선 전의 연결선 — 블록 핀끼리 넷마다 최소 신장 트리 (배치 문제의 핀 오프셋에서) */
export function drawRatsnest(ctx, m, pal, model, live, { focus = null, alpha = 0.45, color = null, dots = false } = {}) {
  if (!model || !live) return;
  const P = model.P, { cx, cy, rects } = live;
  const pins = new Map();
  for (let p = 0; p < P.pinInst.length; p++) {
    const i = P.pinInst[p];
    const x = cx[i] + rects[i].sx * P.pinOff[2 * p], y = cy[i] + rects[i].sy * P.pinOff[2 * p + 1];
    (pins.get(P.pinNet[p]) ?? pins.set(P.pinNet[p], []).get(P.pinNet[p])).push([x, y]);
  }
  ctx.save();
  ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
  for (const [n, pts] of pins) {
    if (pts.length < 2) continue;
    const name = P.netNames[n];
    const on = focus?.has(name);
    ctx.strokeStyle = on ? pal.ours : color ?? pal.axis; ctx.globalAlpha = focus ? (on ? 0.95 : 0.12) : alpha;
    if (dots) { ctx.fillStyle = ctx.strokeStyle; for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(m.X(x), m.Y(y), 2.2, 0, Math.PI * 2); ctx.fill(); } }
    // Prim — 핀 수가 적다 (수십)
    const inT = new Array(pts.length).fill(false), best = new Array(pts.length).fill(Infinity), from = new Array(pts.length).fill(-1);
    best[0] = 0;
    for (let k = 0; k < pts.length; k++) {
      let u = -1;
      for (let i = 0; i < pts.length; i++) if (!inT[i] && (u < 0 || best[i] < best[u])) u = i;
      inT[u] = true;
      if (from[u] >= 0) { ctx.beginPath(); ctx.moveTo(m.X(pts[u][0]), m.Y(pts[u][1])); ctx.lineTo(m.X(pts[from[u]][0]), m.Y(pts[from[u]][1])); ctx.stroke(); }
      for (let i = 0; i < pts.length; i++) {
        if (inT[i]) continue;
        const d = Math.abs(pts[i][0] - pts[u][0]) + Math.abs(pts[i][1] - pts[u][1]);
        if (d < best[i]) { best[i] = d; from[i] = u; }
      }
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- 재기
/** 재기 — 두 점 사이 가로·세로·길이 (레이아웃 좌표, nm) */
export function drawMeasure(ctx, m, pal, ms) {
  if (!ms?.a) return;
  const b = ms.b ?? ms.cur;
  if (!b) return;
  const ax = m.X(ms.a.x), ay = m.Y(ms.a.y), bx = m.X(b.x), by = m.Y(b.y);
  ctx.save();
  ctx.strokeStyle = pal.ours; ctx.fillStyle = pal.ours; ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, ay); ctx.lineTo(bx, by); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  for (const [x, y] of [[ax, ay], [bx, by]]) { ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); }
  const dx = b.x - ms.a.x, dy = b.y - ms.a.y;
  const t = `dx ${Math.round(dx)}  dy ${Math.round(dy)}  L ${Math.round(Math.hypot(dx, dy))} nm`;
  ctx.font = `500 11px ${MONO}`;
  const w = ctx.measureText(t).width + 10, lx = (ax + bx) / 2 - w / 2, ly = Math.min(ay, by) - 24;
  ctx.globalAlpha = 0.92; ctx.fillStyle = pal.panel; ctx.fillRect(lx, ly, w, 18);
  ctx.globalAlpha = 1; ctx.strokeStyle = pal.ours; ctx.lineWidth = 1; ctx.strokeRect(lx + 0.5, ly + 0.5, w, 18);
  ctx.fillStyle = pal.ink; ctx.textBaseline = "middle"; ctx.fillText(t, lx + 5, ly + 9);
  ctx.restore();
}

/** 아직 그릴 것이 없을 때 */
export { drawEmpty };
