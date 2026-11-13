/** 캔버스 무대 — 캔버스가 부모 상자를 꽉 채우고, 그리기를 프레임마다 한 번으로 모은다.
 *
 *  작업 공간(회로 편집·배선 편집)이 하나씩 쓴다. 새 창으로 띄운 작업 공간은 그 창의 requestAnimationFrame 으로 그린다
 *  (이 모듈은 쓰는 창마다 따로 읽힌다 — 전역 이름이 그 창의 것이다).
 *
 *    const st = createStage(canvas, (ctx, W, H) => { ... });
 *    st.invalidate()   다음 프레임에 그린다 (여러 번 불러도 한 번)
 *    st.drawNow()      지금 그린다
 *    st.size()         {W, H} — CSS 픽셀
 */
export function createStage(canvas, draw) {
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1, queued = 0, dead = false;
  const host = canvas.parentElement;

  function fit() {
    const r = host.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    const d = Math.min(2, window.devicePixelRatio || 1);
    if (w === W && h === H && d === dpr) return false;
    W = w; H = h; dpr = d;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    return true;
  }
  function drawNow() {
    if (dead) return;
    if (queued) { cancelAnimationFrame(queued); queued = 0; }
    fit();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, W, H, dpr);
  }
  function invalidate() {
    if (dead || queued) return;
    queued = requestAnimationFrame(() => { queued = 0; drawNow(); });
  }
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { if (fit()) drawNow(); }) : null;
  ro?.observe(host);
  // iOS Safari 는 무거운 워커가 메모리를 쥐고 있을 때 캔버스 내용을 말없이 버리기도 한다 — 돌아오면 다시 그린다
  const again = () => invalidate();
  document.addEventListener("visibilitychange", again);
  window.addEventListener("pageshow", again);
  window.addEventListener("focus", again);

  return {
    ctx, canvas, invalidate, drawNow,
    size: () => { fit(); return { W, H }; },
    destroy() {
      dead = true; ro?.disconnect();
      if (queued) cancelAnimationFrame(queued);
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("pageshow", again);
      window.removeEventListener("focus", again);
    },
  };
}
