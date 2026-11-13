/** 캔버스 다루기 — 세 작업 공간이 같이 쓴다.
 *
 *    휠                커서 자리를 고정한 채 확대·축소
 *    오른쪽·가운데 끌기   이동. 오른쪽을 안 끌고 떼면 오른쪽 클릭 메뉴 (h.context)
 *    Space + 끌기       이동 (도구가 무엇이든)
 *    왼쪽 누르기        도구에 먼저 묻는다 (h.down) — true 면 도구가 끈다, "box" 면 상자 고르기, 아니면 이동
 *    터치               한 손가락은 도구 또는 이동,두 손가락은 확대·이동
 *    더블클릭           도구에 먼저 (h.dbl) — 안 받으면 화면 맞추기
 *
 *  도구는 늘 뗄 때(h.up)를 받는다 — 이동하다 뗀 것도 (클릭인지는 도구가 잰다). 좌표는 캔버스의 CSS 픽셀.
 */
import { zoomAt } from "./viewport.mjs";

export function attachCanvas(canvas, h) {
  const st = { pan: null, box: null, cursor: null, space: false, touches: new Map(), pinch: null, button: -1 };
  const xy = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const limits = h.limits ?? [0.25, 200];

  function startPan(e, button) {
    st.pan = { x: e.clientX, y: e.clientY, tx: h.view.tx, ty: h.view.ty, moved: false, button };
    canvas.classList.add("panning");
  }
  function onDown(e) {
    if (e.pointerType === "touch") {
      st.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (st.touches.size === 2) {                 // 두 손가락 — 하던 것을 버리고 확대·이동
        if (st.box) st.box = null;
        h.cancel?.();
        const [a, b] = [...st.touches.values()];
        st.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        st.pan = null;
        return;
      }
    }
    canvas.setPointerCapture?.(e.pointerId);
    st.button = e.button;
    const [px, py] = xy(e);
    if (e.button === 1 || e.button === 2 || (e.button === 0 && st.space)) { e.preventDefault(); startPan(e, e.button); return; }
    if (e.button !== 0) return;
    const r = h.down?.(e, px, py);
    if (r === true) return;
    if (r === "box" && e.pointerType !== "touch") { st.box = { x0: px, y0: py, x1: px, y1: py, add: e.shiftKey }; return; }
    startPan(e, 0);
  }
  function onMove(e) {
    const [px, py] = xy(e);
    st.cursor = [px, py];
    if (st.pinch && st.touches.has(e.pointerId)) {
      st.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...st.touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const r = canvas.getBoundingClientRect();
      h.view.tx += cx - st.pinch.cx; h.view.ty += cy - st.pinch.cy;
      if (st.pinch.d > 0) zoomAt(h.view, h.panel(), cx - r.left, cy - r.top, d / st.pinch.d, ...limits);
      st.pinch = { d, cx, cy };
      h.redraw(); return;
    }
    if (st.pan) {
      const dx = e.clientX - st.pan.x, dy = e.clientY - st.pan.y;
      if (!st.pan.moved && Math.hypot(dx, dy) < 3) { h.move?.(e, px, py); return; }
      st.pan.moved = true;
      h.view.tx = st.pan.tx + dx; h.view.ty = st.pan.ty + dy;
      h.redraw(); h.moved?.(px, py); return;
    }
    if (st.box) { st.box.x1 = px; st.box.y1 = py; h.redraw(); h.moved?.(px, py); return; }
    h.move?.(e, px, py);
    h.moved?.(px, py);
  }
  function onUp(e) {
    if (e.pointerType === "touch") {
      st.touches.delete(e.pointerId);
      if (st.pinch) { if (st.touches.size < 2) st.pinch = null; return; }
    }
    const [px, py] = xy(e);
    const pan = st.pan, box = st.box;
    st.pan = null; st.box = null;
    canvas.classList.remove("panning");
    if (pan && pan.button === 2) { if (!pan.moved) h.context?.(e, px, py); h.up?.(e, px, py, { panned: pan.moved, right: true }); return; }
    if (box) {
      const moved = Math.hypot(box.x1 - box.x0, box.y1 - box.y0) >= 3;
      if (moved) h.box?.(box, { add: box.add, crossing: box.x1 < box.x0 });
      else h.click?.(e, px, py);
      h.redraw();
      h.up?.(e, px, py, { boxed: moved });
      return;
    }
    h.up?.(e, px, py, { panned: !!pan?.moved });
  }
  function onWheel(e) {
    e.preventDefault();
    const [px, py] = xy(e);
    const k = e.ctrlKey ? Math.exp(-e.deltaY * 0.01) : (e.deltaY < 0 ? 1.15 : 1 / 1.15);
    zoomAt(h.view, h.panel(), px, py, k, ...limits);
    h.redraw(); h.zoomed?.();
  }
  const onDbl = (e) => { const [px, py] = xy(e); if (h.dbl?.(e, px, py)) return; h.fit?.(); };
  const onCtx = (e) => e.preventDefault();
  const onLeave = () => { st.cursor = null; h.leave?.(); };
  const onCancel = (e) => { st.touches.delete(e.pointerId); st.pan = null; st.box = null; st.pinch = null; canvas.classList.remove("panning"); h.cancel?.(); };
  // Space 를 누르고 있는 동안은 끌면 이동 — 캔버스가 보일 때만 (입력 칸에서 친 Space 는 그대로)
  const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName ?? "") || e.target?.isContentEditable;
  const onKeyDown = (e) => { if (e.code === "Space" && !typing(e) && canvas.offsetParent) { if (!st.space) { st.space = true; canvas.classList.add("pannable"); } if (h.spaceGrabs?.()) e.preventDefault(); } };
  const onKeyUp = (e) => { if (e.code === "Space") { st.space = false; canvas.classList.remove("pannable"); } };
  const win = canvas.ownerDocument.defaultView;

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDbl);
  canvas.addEventListener("contextmenu", onCtx);
  canvas.addEventListener("pointerleave", onLeave);
  win.addEventListener("keydown", onKeyDown);
  win.addEventListener("keyup", onKeyUp);
  return {
    state: st,
    /** 그릴 상자 (화면 좌표) — 끄는 중이면 */
    get box() { return st.box; },
    get cursor() { return st.cursor; },
    detach() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDbl);
      canvas.removeEventListener("contextmenu", onCtx);
      canvas.removeEventListener("pointerleave", onLeave);
      win.removeEventListener("keydown", onKeyDown);
      win.removeEventListener("keyup", onKeyUp);
    },
  };
}

/** 상자 고르기의 상자를 그린다 — 왼쪽에서 오른쪽(다 든 것만)은 실선, 반대(걸친 것까지)는 점선 */
export function drawBox(ctx, box, color) {
  if (!box) return;
  const x = Math.min(box.x0, box.x1), y = Math.min(box.y0, box.y1), w = Math.abs(box.x1 - box.x0), h = Math.abs(box.y1 - box.y0);
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
  ctx.setLineDash(box.x1 < box.x0 ? [4, 3] : []);
  ctx.globalAlpha = 0.08; ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 0.9; ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.restore();
}
