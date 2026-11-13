/** 그리기 편집기의 덧칠 — 그린 토막 · 비아, 래츠네스트, 그리는 중인 L, 시작점, 고른 것, 검사기 오류, 커서 옆 층 표시.
 *
 *  셀(바탕)은 render.mjs 의 drawGeometry 로 화면 밖 캔버스에 그려 둔다 (자주 안 바뀐다). 여기 것은 그릴 때마다 바뀐다.
 *  좌표는 nm (m: viewport mapper — X(x), Y(y), S).
 */
import { COLOR, lname, larrow } from "./layers.mjs";
import { metal, via } from "../../art/rules.mjs";
import { shapesOfPlan } from "../../art/draw.mjs";

const MONO = "ui-monospace, Menlo, Consolas, monospace";
const WARN = "#d9822b";

function fillRect(ctx, m, r) {
  ctx.fillRect(m.X(r[0]), m.Y(r[3]), Math.max(0.8, (r[2] - r[0]) * m.S), Math.max(0.8, (r[3] - r[1]) * m.S));
}
function strokeRect(ctx, m, r, pad = 0) {
  ctx.strokeRect(m.X(r[0]) - pad, m.Y(r[3]) - pad, Math.max(1, (r[2] - r[0]) * m.S) + 2 * pad, Math.max(1, (r[3] - r[1]) * m.S) + 2 * pad);
}
/** 비아 — 컷에 X 표 */
function viaMark(ctx, m, r, color) {
  const x0 = m.X(r[0]), y0 = m.Y(r[3]), w = Math.max(2, (r[2] - r[0]) * m.S), h = Math.max(2, (r[3] - r[1]) * m.S);
  ctx.fillStyle = color; ctx.fillRect(x0, y0, w, h);
  if (w < 5) return;
  ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + w, y0 + h); ctx.moveTo(x0 + w, y0); ctx.lineTo(x0, y0 + h); ctx.stroke();
}

/**
 * 그린 것 — 층 차례(아래부터, 지금 층은 맨 위), 비아는 그 위. focus 넷이 있으면 다른 넷은 옅게.
 * @param {Array} drawn  doc.shapesOf 의 결과
 */
export function drawArt(ctx, m, drawn, { vis, active, focus = null, sel = new Set(), hover = null, pal, hide = null }) {
  if (hide?.size) drawn = drawn.filter((s) => !hide.has(s.id));   // 끄는 중 — 옛 자리는 미리 보기가 대신 그린다
  ctx.save();
  const order = ["M1", "M2", "M3", "M4", "M5"].filter((l) => l !== active).concat(active ? [active] : []);
  for (const L of order) {
    if (!vis.has(L)) continue;
    ctx.fillStyle = COLOR.get(L);
    for (const s of drawn) {
      if (s.layer !== L || s.role === "cut") continue;
      ctx.globalAlpha = focus && s.netName !== focus ? 0.18 : 0.92;
      fillRect(ctx, m, s.rect);
    }
  }
  for (const s of drawn) {
    if (s.role !== "cut" || !vis.has(s.layer)) continue;
    ctx.globalAlpha = focus && s.netName !== focus ? 0.25 : 1;
    viaMark(ctx, m, s.rect, COLOR.get(s.layer) ?? "#777");
  }
  // 고른 것 · 커서 아래
  ctx.globalAlpha = 1;
  if (sel.size) {
    ctx.strokeStyle = pal.ours; ctx.lineWidth = 2;
    for (const s of drawn) if (sel.has(s.id) && s.role !== "cut") strokeRect(ctx, m, s.rect, 1.5);
  }
  if (hover?.from === "art" && !sel.has(hover.id)) {
    ctx.strokeStyle = pal.ours; ctx.lineWidth = 1; ctx.setLineDash([3, 2]);
    for (const s of drawn) if (s.id === hover.id && s.role !== "cut") strokeRect(ctx, m, s.rect, 1);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/** 셀의 핀 — 커서 아래 핀과 밝힌 넷의 핀을 윤곽으로 */
export function drawPins(ctx, m, base, { focus = null, hover = null, pal }) {
  if (!base) return;
  ctx.save();
  if (focus) {
    ctx.strokeStyle = pal.ours; ctx.lineWidth = 1.5;
    for (const p of base.pins) if (p.netName === focus) strokeRect(ctx, m, p.rect, 1);
  }
  if (hover?.from === "base") {
    ctx.strokeStyle = pal.ink; ctx.lineWidth = 1.5; ctx.setLineDash([3, 2]);
    strokeRect(ctx, m, hover.rect, 1.5);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/** 래츠네스트 — 아직 안 이은 덩이 사이의 가는 선 (PCB 의 래츠네스트) */
export function drawRats(ctx, m, rats, { focus = null, pal }) {
  if (!rats?.length) return;
  ctx.save();
  ctx.lineWidth = 1;
  for (const r of rats) {
    const on = !focus || r.net === focus;
    ctx.globalAlpha = on ? 0.9 : 0.18;
    ctx.strokeStyle = on && focus ? pal.ours : pal.ink;
    ctx.beginPath(); ctx.moveTo(m.X(r.a[0]), m.Y(r.a[1])); ctx.lineTo(m.X(r.b[0]), m.Y(r.b[1])); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    for (const q of [r.a, r.b]) { ctx.beginPath(); ctx.arc(m.X(q[0]), m.Y(q[1]), 2, 0, 2 * Math.PI); ctx.fill(); }
  }
  ctx.restore();
}

/** 그리는 중 — 이미 정한 토막(굵게)과 다음 L(미리 보기). 단락은 빨강, 간격 경고는 주황 */
export function drawDrawing(ctx, m, draw, preview, pal) {
  if (!draw) return;
  ctx.save();
  const groups = draw.groups.flatMap((g) => shapesOfPlan(g));
  for (const s of groups) {
    if (s.role === "cut") { viaMark(ctx, m, s.rect, COLOR.get(s.layer) ?? "#777"); continue; }
    ctx.globalAlpha = 0.95; ctx.fillStyle = COLOR.get(s.layer); fillRect(ctx, m, s.rect);
    ctx.globalAlpha = 1; ctx.strokeStyle = pal.ours; ctx.lineWidth = 1; strokeRect(ctx, m, s.rect, 0.5);
  }
  if (preview) {
    const bad = preview.judge.shorts.length > 0, warn = preview.judge.warns.length > 0;
    for (const s of shapesOfPlan(preview.plan)) {
      if (s.role === "cut") { ctx.globalAlpha = 0.8; viaMark(ctx, m, s.rect, COLOR.get(s.layer) ?? "#777"); continue; }
      ctx.globalAlpha = 0.55; ctx.fillStyle = COLOR.get(s.layer); fillRect(ctx, m, s.rect);
      ctx.globalAlpha = 1; ctx.strokeStyle = bad ? pal.bad : warn ? WARN : pal.ours; ctx.lineWidth = 1.5; ctx.setLineDash(bad ? [] : [4, 3]);
      strokeRect(ctx, m, s.rect, 1);
      ctx.setLineDash([]);
    }
    for (const x of preview.judge.shorts) { ctx.strokeStyle = pal.bad; ctx.lineWidth = 2; strokeRect(ctx, m, x.rect, 2); }
    for (const x of preview.judge.warns) { ctx.strokeStyle = WARN; ctx.lineWidth = 1.5; strokeRect(ctx, m, x.rect, 2); }
    if (preview.target && preview.plan.joined) { ctx.strokeStyle = pal.ours; ctx.lineWidth = 2; strokeRect(ctx, m, preview.target.rect, 2); }
    // 끝점
    const e = preview.plan.end;
    ctx.globalAlpha = 1; ctx.strokeStyle = bad ? pal.bad : pal.ours; ctx.lineWidth = 1.5;
    const X = m.X(e.x), Y = m.Y(e.y);
    ctx.beginPath(); ctx.moveTo(X - 6, Y); ctx.lineTo(X + 6, Y); ctx.moveTo(X, Y - 6); ctx.lineTo(X, Y + 6); ctx.stroke();
  }
  ctx.restore();
}

/** 시작할 자리 — 트랙 도구로 핀 위에 있을 때 */
export function drawStart(ctx, m, start, pal) {
  if (!start) return;
  ctx.save();
  for (const s of shapesOfPlan(start.pre)) {
    if (s.role === "cut") { ctx.globalAlpha = 0.7; viaMark(ctx, m, s.rect, COLOR.get(s.layer) ?? "#777"); }
  }
  const X = m.X(start.at.x), Y = m.Y(start.at.y);
  ctx.globalAlpha = 1; ctx.strokeStyle = pal.ours; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(X, Y, 5, 0, 2 * Math.PI); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(X - 8, Y); ctx.lineTo(X + 8, Y); ctx.moveTo(X, Y - 8); ctx.lineTo(X, Y + 8); ctx.stroke();
  ctx.restore();
}

/** 검사기 오류 — 그 줄이 가리키는 사각형. OPEN 은 그 넷의 도형 전부라 (래츠네스트가 이미 보인다) 목록에서 고를 때만 */
export function drawErrorMarks(ctx, m, marks, pal, focusText = null) {
  if (!marks?.length) return;
  ctx.save();
  ctx.strokeStyle = pal.bad;
  for (const mk of marks) {
    if (mk.text.startsWith("OPEN") && mk.text !== focusText) continue;
    ctx.lineWidth = mk.text === focusText ? 3 : 1.5;
    ctx.globalAlpha = focusText && mk.text !== focusText ? 0.35 : 1;
    for (const r of mk.rects.slice(0, 40)) strokeRect(ctx, m, r, 2);
  }
  ctx.restore();
}

/** 커서 옆 — 지금 층과 짝 층 */
export function drawLayerHud(ctx, cursorPx, layer, other, pal) {
  if (!cursorPx) return;
  const t = `${lname(layer)} ${larrow(layer)}${other ? `  ·  ${lname(other)} ${larrow(other)}` : ""}`;
  ctx.save();
  ctx.font = `500 11px ${MONO}`; ctx.textAlign = "left"; ctx.textBaseline = "top";
  const w = ctx.measureText(t).width + 10, x = cursorPx.x + 14, y = cursorPx.y + 14;
  ctx.globalAlpha = 0.85; ctx.fillStyle = pal.canvas; ctx.fillRect(x, y, w, 17);
  ctx.globalAlpha = 1; ctx.strokeStyle = COLOR.get(layer) ?? pal.line; ctx.lineWidth = 1.5; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 16);
  ctx.fillStyle = pal.ink; ctx.fillText(t, x + 5, y + 3);
  ctx.restore();
}

/** 금속인가 · 비아인가 (속성 칸) */
export const kindOf = (layer) => (metal(layer) ? "track" : via(layer) ? "via" : "shape");

/**
 * 끄는 중의 미리 보기 — 고친 뒤의 토막 · 비아(옮겨 간 것, 따라 늘어난 것, 새 짧은 토막과 비아). 단락이면 빨강(놓아도 고치지
 * 않는다), 간격 경고는 주황.
 */
export function drawEditPreview(ctx, m, edit, pal) {
  if (!edit?.e) return;
  const bad = edit.judge.shorts.length > 0, warn = edit.judge.warns.length > 0;
  ctx.save();
  for (const s of shapesOfPlan(edit.e.add)) {
    if (s.role === "cut") { ctx.globalAlpha = 0.9; viaMark(ctx, m, s.rect, COLOR.get(s.layer) ?? "#777"); continue; }
    ctx.globalAlpha = 0.75; ctx.fillStyle = COLOR.get(s.layer); fillRect(ctx, m, s.rect);
    ctx.globalAlpha = 1; ctx.strokeStyle = bad ? pal.bad : warn ? WARN : pal.ours; ctx.lineWidth = 1.5; ctx.setLineDash(bad ? [] : [4, 3]);
    strokeRect(ctx, m, s.rect, 1);
    ctx.setLineDash([]);
  }
  for (const x of edit.judge.shorts) { ctx.strokeStyle = pal.bad; ctx.lineWidth = 2; strokeRect(ctx, m, x.rect, 2); }
  for (const x of edit.judge.warns) { ctx.strokeStyle = WARN; ctx.lineWidth = 1.5; strokeRect(ctx, m, x.rect, 2); }
  ctx.restore();
}

/** 고른 토막의 손잡이 — 두 끝과 가운데 (끝을 끌면 늘고, 몸을 끌면 옆 트랙으로), 고른 비아는 네모 */
export function drawHandles(ctx, m, art, sel, pal) {
  if (!sel?.size) return;
  ctx.save();
  ctx.fillStyle = pal.canvas; ctx.strokeStyle = pal.ours; ctx.lineWidth = 1.5;
  const box = (x, y, r = 3.5) => { ctx.fillRect(m.X(x) - r, m.Y(y) - r, 2 * r, 2 * r); ctx.strokeRect(m.X(x) - r, m.Y(y) - r, 2 * r, 2 * r); };
  for (const w of art.wires) if (sel.has(w.id)) { box(w.x0, w.y0); box(w.x1, w.y1); box((w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2, 3); }
  for (const v of art.vias) if (sel.has(v.id)) box(v.x, v.y, 5);
  ctx.restore();
}

/** 커서 옆에 잠깐 — 안 된 까닭 (핀이 아닌 곳을 눌렀다, 단락이라 못 옮긴다 …). 캔버스 오른쪽 끝에서는 왼쪽으로 */
export function drawFlash(ctx, cursorPx, text, pal, W) {
  ctx.save();
  ctx.font = `500 12px ${MONO}`; ctx.textAlign = "left"; ctx.textBaseline = "top";
  const t = text.length > 90 ? text.slice(0, 89) + "…" : text;
  const w = ctx.measureText(t).width + 14;
  const x = Math.max(4, Math.min(cursorPx.x + 14, W - w - 4)), y = Math.max(4, cursorPx.y - 30);
  ctx.globalAlpha = 0.95; ctx.fillStyle = pal.canvas; ctx.fillRect(x, y, w, 20);
  ctx.globalAlpha = 1; ctx.strokeStyle = pal.bad; ctx.lineWidth = 1.5; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 19);
  ctx.fillStyle = pal.ink; ctx.fillText(t, x + 7, y + 4);
  ctx.restore();
}
