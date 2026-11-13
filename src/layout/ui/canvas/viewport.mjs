/** 보기 변환 — 레이아웃 좌표와 화면 좌표 사이 (옛 view.mjs 의 셈).
 *
 *  좌표계가 둘이다.
 *    레이아웃 좌표 : 템플릿 단위 (PDK 단위, nm. telescopic_ota 는 1440 x 11760). y 는 위로 큰다
 *    화면 좌표     : 캔버스의 CSS 픽셀. y 는 아래로 큰다
 *  fitOf() 가 레이아웃 상자를 패널에 꽉 채우는 배율을 잡고, view {s, tx, ty} 가 그 위에 사용자의 확대/이동을 얹는다.
 *  회로도(src/schematic/draw.mjs)와 레이아웃(app/layout/) 이 같은 변환을 쓴다.
 */

export function makeView() {
  return { s: 1, tx: 0, ty: 0 };
}

/** 레이아웃 bbox 를 패널에 맞추는 기본 변환. */
export function fitOf(bbox, panel, pad = 24) {
  const [x0, y0, x1, y1] = bbox;
  const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  // 칸이 여백보다 좁으면 (편집기를 막 붙여 아직 자리가 안 잡혔을 때) 음수가 된다 — 음수 배율은 그림을 뒤집고
  // 격자 간격 셈을 멈추지 않게 한다 (drawGrid). 아주 작은 양수로 둔다
  const s = Math.max(1e-6, Math.min((panel.w - pad * 2) / bw, (panel.h - pad * 2) / bh));
  return { s, ox: panel.x + (panel.w - bw * s) / 2, oy: panel.y + (panel.h - bh * s) / 2, x0, y0, bh };
}

/** 레이아웃 -> 화면. view 를 얹는다. X, Y 는 레이아웃 -> 화면, toX, toY 는 화면 -> 레이아웃. */
export function mapper(fit, view, panel) {
  const S = fit.s * view.s;
  const cxp = panel.x + panel.w / 2, cyp = panel.y + panel.h / 2;
  // 확대는 패널 중심 기준, 이동은 그 뒤에
  const ox = cxp + (fit.ox - cxp) * view.s + view.tx;
  const oy = cyp + (fit.oy - cyp) * view.s + view.ty;
  return {
    S,
    X: (v) => ox + (v - fit.x0) * S,
    Y: (v) => oy + (fit.bh - (v - fit.y0)) * S,      // y 를 위로
    toX: (px) => (px - ox) / S + fit.x0,
    toY: (py) => fit.bh - (py - oy) / S + fit.y0,
  };
}

/** 커서를 고정한 채 확대한다. lo, hi 는 배율의 한계 (fit 대비). */
export function zoomAt(view, panel, px, py, factor, lo = 0.25, hi = 40) {
  const cx = panel.x + panel.w / 2, cy = panel.y + panel.h / 2;
  // 확대 전 커서가 가리키던 내용 좌표가 확대 뒤에도 같은 픽셀에 오도록 tx,ty 보정
  const bx = (px - cx - view.tx) / view.s;
  const by = (py - cy - view.ty) / view.s;
  view.s = Math.min(hi, Math.max(lo, view.s * factor));
  view.tx = px - cx - bx * view.s;
  view.ty = py - cy - by * view.s;
  return view;
}

/** 레이아웃 상자 하나(r = [x0, y0, x1, y1])가 패널 가운데 오고 frac 만큼 차지하게 view 를 잡는다 (넷·블록으로 가기). */
export function focusBox(view, fit, panel, r, frac = 0.5, hi = 40) {
  const w = Math.max(1, r[2] - r[0]), h = Math.max(1, r[3] - r[1]);
  const want = Math.min((panel.w * frac) / (w * fit.s), (panel.h * frac) / (h * fit.s));
  view.s = Math.min(hi, Math.max(1, want));
  // 상자 가운데가 패널 가운데로: mapper 의 X(c) = cxp
  const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
  const cxp = panel.x + panel.w / 2, cyp = panel.y + panel.h / 2;
  view.tx = -((fit.ox - cxp) * view.s + (cx - fit.x0) * fit.s * view.s);
  view.ty = -((fit.oy - cyp) * view.s + (fit.bh - (cy - fit.y0)) * fit.s * view.s);
  return view;
}

const MONO = "ui-monospace, Menlo, Consolas, monospace";

/** 아직 그릴 것이 없는 패널 — 빈 상자 대신 무엇을 눌러야 하는지 적는다 (좁은 패널에서도 읽히게 줄을 나눈다). */
export function drawEmpty(ctx, panel, pal, lines) {
  const ls = Array.isArray(lines) ? lines : [lines];
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = panel.x + panel.w / 2, cy = panel.y + panel.h / 2;
  const font = (i) => `${i === 0 ? 500 : 400} ${i === 0 ? 12 : 11}px ${MONO}`;
  const rows = [];
  ls.forEach((t, i) => {
    ctx.font = font(i);
    let cur = "";
    for (const ch of String(t)) {
      if (cur && ctx.measureText(cur + ch).width > panel.w - 20) { rows.push([cur, i]); cur = ""; }
      cur += ch;
    }
    rows.push([cur, i]);
  });
  rows.forEach(([t, i], k) => {
    ctx.font = font(i);
    ctx.fillStyle = pal.faint;
    ctx.globalAlpha = i === 0 ? 1 : 0.8;
    ctx.fillText(t, cx, cy + (k - (rows.length - 1) / 2) * 16);
  });
  ctx.restore();
}
