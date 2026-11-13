/** Placement 그리기 — 블록(배치기가 놓은 것, 도는 중이면 그 최선), 대칭축, 그리고 편집의 덧칠.
 *
 *  덧칠 (편집기가 있을 때): 움직인 블록의 원래 자리(유령 상자), 겹침·Order 위반(빨강), 잠금(점선), 고른 것과 가리킨 것,
 *  고정한 variant 표, 고른(가리킨) 블록의 넷 플라이라인, 대칭축 핸들. 좌표는 PDK 단위(nm).
 */
const MONO = "ui-monospace, Menlo, Consolas, monospace";

/** 블록과 대칭축 — 옛 view.mjs 의 drawPanel 과 같은 그림 */
export function drawPlacement(ctx, m, pal, data, { accent = true, hi = null, probe = null } = {}) {
  const [x0, y0, x1, y1] = data.bbox;
  ctx.strokeStyle = pal.hair; ctx.lineWidth = 1;
  ctx.strokeRect(m.X(x0) + 0.5, m.Y(y1) + 0.5, (x1 - x0) * m.S, (y1 - y0) * m.S);
  for (const a of data.axes ?? []) {
    ctx.save();
    ctx.strokeStyle = pal.axis; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
    ctx.beginPath();
    if (a.vert) { ctx.moveTo(m.X(a.at), m.Y(y1)); ctx.lineTo(m.X(a.at), m.Y(y0)); }
    else { ctx.moveTo(m.X(x0), m.Y(a.at)); ctx.lineTo(m.X(x1), m.Y(a.at)); }
    ctx.stroke();
    ctx.restore();
  }
  ctx.font = `500 10px ${MONO}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const r of data.rects) {
    const px = m.X(r.x), py = m.Y(r.y + r.h), pw = r.w * m.S, ph = r.h * m.S;
    ctx.globalAlpha = accent ? 0.55 : 0.82;
    ctx.fillStyle = pal.block; ctx.fillRect(px, py, pw, ph);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent ? pal.ours : pal.blockLine; ctx.lineWidth = accent ? 1.5 : 1;
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
    if (hi?.has(r.name) || probe?.has(r.name)) {
      ctx.strokeStyle = hi?.has(r.name) ? pal.ours : pal.probe; ctx.lineWidth = 2.5;
      ctx.strokeRect(px - 2, py - 2, pw + 4, ph + 4);
    }
    if (pw > 34 && ph > 13) {
      ctx.fillStyle = pal.ink;
      const t = r.name.replace(/^X_?/, "");
      ctx.fillText(t.length > 14 ? t.slice(0, 13) + "…" : t, px + pw / 2, py + ph / 2);
    }
  }
}

/** 편집의 덧칠 — pl 은 배치 편집기의 상태, ours 는 굳힌 배치 */
export function drawPlaceOverlay(ctx, m, pal, pl, ours) {
  if (!pl.live || !pl.model) return;
  const { rects } = pl.live;
  const bb = ours?.bbox;
  // 원래 자리 (움직인 블록만, 유령 상자)
  const base = ours?.rects ? new Map(ours.rects.map((r) => [r.name, r])) : null;
  if (base) {
    ctx.setLineDash([3, 3]); ctx.strokeStyle = pal.faint; ctx.lineWidth = 1; ctx.globalAlpha = 0.7;
    for (const r of rects) {
      const b = base.get(r.name);
      if (!b || (Math.abs(b.x - r.x) < 1e-6 && Math.abs(b.y - r.y) < 1e-6 && b.w === r.w && b.h === r.h)) continue;
      ctx.strokeRect(m.X(b.x) + 0.5, m.Y(b.y + b.h) + 0.5, b.w * m.S, b.h * m.S);
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  // 겹침·Order 위반은 빨갛게, 잠금은 점선, 고른 것은 강조
  for (const r of rects) {
    const px = m.X(r.x), py = m.Y(r.y + r.h), pw = r.w * m.S, ph = r.h * m.S;
    const bad = pl.live.overlap.names.has(r.name) || pl.live.orderBad.has(r.name);
    if (bad) { ctx.fillStyle = pal.bad; ctx.globalAlpha = 0.22; ctx.fillRect(px, py, pw, ph); ctx.globalAlpha = 1; }
    if (pl.locked.has(r.name)) { ctx.setLineDash([4, 3]); ctx.strokeStyle = pal.ink; ctx.lineWidth = 1; ctx.strokeRect(px + 2.5, py + 2.5, pw - 5, ph - 5); ctx.setLineDash([]); }
    if (pl.sel.has(r.name) || pl.hover === r.name) {
      ctx.strokeStyle = pl.sel.has(r.name) ? pal.ours : pal.axis; ctx.lineWidth = pl.sel.has(r.name) ? 2.5 : 1.5;
      ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
    }
    if (pl.pinned.has(r.name) && pw > 20 && ph > 20) {
      ctx.fillStyle = pal.ours; ctx.font = `600 9px ${MONO}`; ctx.textAlign = "right"; ctx.textBaseline = "top";
      ctx.fillText("pinned", px + pw - 4, py + 3);
    }
  }
  // 플라이라인 — 고른(또는 가리킨) 블록의 넷
  const focus = pl.hover ?? [...pl.sel][0];
  if (focus) drawBlockNets(ctx, m, pal, pl, focus);
  // 축 핸들
  if (bb) {
    for (const a of pl.live.axes) {
      const hx = a.vert ? m.X(a.at) : m.X(bb[2]) - 8, hy = a.vert ? m.Y(bb[3]) + 8 : m.Y(a.at);
      ctx.fillStyle = pal.axis; ctx.globalAlpha = 0.9;
      ctx.fillRect(hx - 5, hy - 5, 10, 10);
      ctx.globalAlpha = 1;
    }
  }
}

/** 블록 하나의 핀에서 같은 넷의 다른 블록 핀까지 */
function drawBlockNets(ctx, m, pal, pl, name) {
  const P = pl.model.P, i = pl.model.idx.get(name);
  if (i === undefined) return;
  const { cx, cy } = pl.live, sx = pl.sx, sy = pl.sy;
  const pinXY = (p) => [cx[P.pinInst[p]] + sx[P.pinInst[p]] * P.pinOff[2 * p], cy[P.pinInst[p]] + sy[P.pinInst[p]] * P.pinOff[2 * p + 1]];
  ctx.strokeStyle = pal.ours; ctx.lineWidth = 1; ctx.globalAlpha = 0.75; ctx.setLineDash([]);
  for (let p = 0; p < P.pinInst.length; p++) {
    if (P.pinInst[p] !== i) continue;
    const [x1, y1] = pinXY(p);
    for (let q = 0; q < P.pinInst.length; q++) {
      if (q === p || P.pinNet[q] !== P.pinNet[p] || P.pinInst[q] === i) continue;
      const [x2, y2] = pinXY(q);
      ctx.beginPath(); ctx.moveTo(m.X(x1), m.Y(y1)); ctx.lineTo(m.X(x2), m.Y(y2)); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(m.X(x1), m.Y(y1), 2.5, 0, Math.PI * 2); ctx.fillStyle = pal.ours; ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** 넷 하나의 핀들 사이 (회로·레이아웃에서 넷을 골랐을 때 따라 보인다) */
export function drawNetPins(ctx, m, pal, pl, net) {
  if (!pl.model || !pl.live) return;
  const P = pl.model.P, n = P.netNames.indexOf(net);
  if (n < 0) return;
  const { cx, cy } = pl.live, sx = pl.sx, sy = pl.sy, pts = [];
  for (let p = 0; p < P.pinInst.length; p++) if (P.pinNet[p] === n) {
    const i = P.pinInst[p];
    pts.push([cx[i] + sx[i] * P.pinOff[2 * p], cy[i] + sy[i] * P.pinOff[2 * p + 1]]);
  }
  ctx.save();
  ctx.strokeStyle = pal.probe; ctx.fillStyle = pal.probe; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.9; ctx.setLineDash([5, 3]);
  for (let k = 1; k < pts.length; k++) { ctx.beginPath(); ctx.moveTo(m.X(pts[0][0]), m.Y(pts[0][1])); ctx.lineTo(m.X(pts[k][0]), m.Y(pts[k][1])); ctx.stroke(); }
  ctx.setLineDash([]);
  for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(m.X(x), m.Y(y), 3, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}
