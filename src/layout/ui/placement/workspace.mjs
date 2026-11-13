/** Placement 편집기 (작업 공간) — 회로도에서 읽은 블록(앞단이 묶은 원시 소자)을 보고, 배치기가 놓은 배치를 손으로 고친다.
 *
 *    도구 줄     자동 배치 · 반전 x/y · 잠금 · 자리 바꾸기 · 정리 · 위상 유지 최적화 · 되돌리기 · 보기
 *    왼쪽        회로도에서 읽은 것 (이름·트랜지스터·핀·바뀐 것, 다시 읽기) · 블록 목록 — 배치 전에는 앞단이 만든
 *                블록(종류·부품·variant 수·제약), 뒤에는 고른 variant·크기·반전
 *    가운데      캔버스 — 블록, 대칭축, 편집의 덧칠 (원래 자리, 겹침, 잠금, 고른 것, 넷, 축 핸들)
 *    오른쪽      속성 (블록: variant·좌표·반전·잠금 / 여럿 / 배치 상태와 정리) · 배치기 설정 · 결과
 *    아래        커서 좌표 · 격자 · 배율 · 겹침 · HPWL · 하는 일 한 줄
 *
 *  편집은 위상을 사용자가 정하고 나머지를 최적화기가 한다 — 셈은 placement/edit.mjs 와 src/layout/edit/place.mjs.
 *  mountPlacement(root, app, opts) -> { unmount, probe }
 */
import { makeView, fitOf, mapper, zoomAt, drawEmpty } from "../canvas/viewport.mjs";
import { createStage } from "../canvas/stage.mjs";
import { attachCanvas, drawBox } from "../canvas/interact.mjs";
import { createFrame } from "../ui/frame.mjs";
import { readPalette } from "../core/palette.mjs";
import { watchTheme } from "../core/theme.mjs";
import { popover, esc } from "../core/dom.mjs";
import { drawPlacement, drawPlaceOverlay, drawNetPins } from "./render.mjs";
import { drawRatsnest } from "../layout/render.mjs";
import { toolsHtml, blocksHtml, propsHtml, resultHtml, statusHtml } from "./panels.mjs";
import { placementKey } from "./keymap.mjs";
import { sourceHtml } from "./blocks.mjs";
import { downloadMenu } from "../ui/downloads.mjs";

const SETTINGS = `
  <label class="field" title="Total budget of start points. The number of configurations (variant assignment x region candidate) is the minimum, so in hierarchical designs with many configurations it mostly sets the breadth — how many assignments get scanned grows with it. Leftover budget goes to the top-scoring configurations in extra rounds."><span>Starts</span>
    <select id="batch"><option value="48">48 — fast</option><option value="96">96 — default</option><option value="288">288 — broad</option></select></label>
  <label class="field slide" title="Selection weight. Candidate score = log(area) + w x log(HPWL) — w = 1 is ALIGN's LAMBDA. 10% of area counts the same as 10% of wirelength. HPWL is measured on pin bounding boxes. Takes effect from the next placement.">
    <span>Area ↔ wirelength <b id="hwVal">1 : 1.00</b></span><input type="range" id="hw" min="-40" max="40" step="1" value="0"></label>
  <label class="field" id="gpuField" hidden title="With WebGPU, the continuous stage (Adam) runs on the GPU. Start points are then this many per configuration (variant assignment x region), not a total budget."><span>GPU starts/config</span>
    <select id="perConfig"><option value="8">8</option><option value="32">32</option><option value="128">128</option></select></label>
  <label class="field slide" title="Continuous-stage weight: how strong the density (spreading force) gradient is relative to the wirelength (pulling force) gradient at the start points (lamRatio in calibrate). Lower gives shorter wires but leaves more overlap; higher spreads blocks out and leaves less. Legalize brings overlap to 0 anyway.">
    <span>Wirelength ↔ spread <b id="lamVal">1.00×</b></span><input type="range" id="lam" min="-20" max="20" step="1" value="0"></label>`;

export function mountPlacement(root, app, { isActive = () => true, activate = () => {} } = {}) {
  const doc = root.ownerDocument, win = doc.defaultView;
  const f = createFrame(root, { id: "placement", label: "Placement editor" });
  app.state.ui ??= {};
  const U = (app.state.ui.placement ??= { rats: true });       // 보기 설정 — 새 창과 같이 본다
  const view = makeView();
  let pal = readPalette(doc);
  let cursor = null, lastMap = null;
  const ed = () => app.editors;
  const offs = [];
  const on = (t, fn) => offs.push(app.bus.on(t, fn, win));

  const srcBody = f.section("left", "source", "From the schematic", { open: true });
  srcBody.id = "plSource";
  const blocksBody = f.section("left", "blocks", "Blocks", { open: true });
  blocksBody.id = "plBlocks";
  const propsBody = f.section("right", "props", "Properties", { open: true });
  propsBody.id = "plProps";
  const setBody = f.section("right", "placer", "Placer settings", { open: false });
  setBody.innerHTML = `<div class="settings">${SETTINGS}</div>`;
  const resBody = f.section("right", "result", "Placement result", { open: false });
  f.tools.id = "plTools"; f.status.id = "plStatus";

  // ---------------------------------------------------------------- 배치기 설정 (앱 상태에 둔다 — 새 창과 같이 본다)
  const $ = (id) => setBody.querySelector("#" + id);
  function showSettings() {
    const s = app.state.settings;
    $("batch").value = String(s.batch); $("perConfig").value = String(s.perConfig);
    $("hw").value = String(s.hw); $("lam").value = String(s.lam);
    $("hwVal").textContent = `1 : ${app.hpwlWeight().toFixed(2)}`;
    $("lamVal").textContent = `${app.lamRatio().toFixed(2)}×`;
    $("gpuField").hidden = app.state.runner ? app.state.runner !== "gpu" : !app.state.gpu;
  }
  setBody.addEventListener("input", (e) => { const t = e.target; if (t.id === "hw" || t.id === "lam") { app.setSetting(t.id, Number(t.value)); } });
  setBody.addEventListener("change", (e) => { const t = e.target; if (t.id === "batch" || t.id === "perConfig") app.setSetting(t.id, Number(t.value)); });

  // ---------------------------------------------------------------- 변환
  const panelNow = () => { const { W, H } = stage.size(); return { x: 0, y: 0, w: W, h: H }; };
  function dataNow() {
    const st = app.state;
    return st.frame ?? ed()?.placement.liveData() ?? st.ours;
  }
  function mapNow() {
    const panel = panelNow();
    const d = dataNow();
    if (!d?.rects?.length) return null;
    const fit = fitOf(app.state.frame ? d.bbox : (app.state.ours?.bbox ?? d.bbox), panel);
    return { m: mapper(fit, view, panel), panel, fit };
  }
  const useMap = () => ed()?.setMap("placement", () => lastMap ?? (lastMap = mapNow()));
  const toLayout = (px, py) => { const mm = (lastMap = mapNow())?.m; return mm ? { x: mm.toX(px), y: mm.toY(py) } : null; };

  // ---------------------------------------------------------------- 그리기
  function draw(ctx, W, H) {
    if (!f.canvas.offsetParent) return;
    const panel = { x: 0, y: 0, w: W, h: H }, st = app.state;
    ctx.fillStyle = pal.canvas; ctx.fillRect(0, 0, W, H);
    const sel = st.link ? st.selection : null, pr = st.link ? st.probe : null;
    const mm = mapNow();
    lastMap = mm;
    if (!mm) { drawEmpty(ctx, panel, pal, st.busy ? ["Placer running…"] : ["No placement yet", "Press Auto place"]); return; }
    useMap();
    const d = dataNow(), m = mm.m, pl = ed()?.placement.pl;
    const hi = sel?.kind === "block" && sel.from !== "placement" ? new Set(sel.names) : null;
    const pb = pr?.kind === "block" && pr.from !== "placement" ? new Set(pr.names) : null;
    drawPlacement(ctx, m, pal, d, { accent: true, hi, probe: pb });
    // 래츠네스트 — 넷마다 블록 핀을 잇는 최소 신장 트리 (PCB 의 배치 화면처럼). 고른 블록·넷의 것만 진하게
    if (U.rats && pl?.model && pl.live && !st.frame) {
      const one = pl.sel.size === 1 ? [...pl.sel][0] : pl.hover ?? null;
      const focus = sel?.kind === "net" ? new Set([sel.name]) : one ? new Set(ed().placement.netsOf(one)) : null;
      drawRatsnest(ctx, m, pal, pl.model, pl.live, { focus, alpha: 0.85, color: pal.ink, dots: true });
    }
    if (pl?.model && !st.frame) drawPlaceOverlay(ctx, m, pal, pl, st.ours);
    if (sel?.kind === "net" && pl?.model) drawNetPins(ctx, m, pal, pl, sel.name);
    drawBox(ctx, inter?.box, pal.ours);
    ctx.font = "500 10px ui-monospace, Menlo, Consolas, monospace"; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillStyle = pal.ours;
    ctx.fillText(st.frame ? `Searching · ${st.frame.module}` : `Placement · ${Math.round(d.bbox[2] - d.bbox[0])} × ${Math.round(d.bbox[3] - d.bbox[1])}`, 10, 8);
  }
  const stage = createStage(f.canvas, draw);

  // ---------------------------------------------------------------- 포인터
  function fit() { view.s = 1; view.tx = 0; view.ty = 0; stage.invalidate(); renderStatus(); }
  function zoom(k) { const p = panelNow(); zoomAt(view, p, p.w / 2, p.h / 2, k, 0.25, 200); stage.invalidate(); renderStatus(); }
  const inter = attachCanvas(f.canvas, {
    view, panel: panelNow, redraw: () => stage.invalidate(), limits: [0.25, 200],
    spaceGrabs: () => isActive(),
    down(e, px, py) {
      activate();
      const P = ed()?.placement;
      lastMap = mapNow(); useMap();
      if (!P?.pl.model || app.state.busy || app.state.frame) return false;
      if (P.axisDown(e, px, py)) return true;
      if (P.blockDown(e, px, py)) return true;
      return "box";
    },
    move(e, px, py) {
      lastMap = mapNow();
      ed()?.placement.move(e, px, py);
    },
    up(e, px, py, info) {
      ed()?.placement.up();
    },
    click(e) { if (!e.shiftKey) ed()?.placement.clearSelection(); },
    box(b, opt) {
      const a = toLayout(b.x0, b.y0), c = toLayout(b.x1, b.y1);
      ed()?.placement.selectBox([Math.min(a.x, c.x), Math.min(a.y, c.y), Math.max(a.x, c.x), Math.max(a.y, c.y)], opt);
    },
    context(e, px, py) { contextMenu(px, py); },
    leave() { cursor = null; ed()?.placement.leave(); renderStatus(); stage.invalidate(); },
    moved(px, py) { cursor = toLayout(px, py); statusSoon(); },
    fit, zoomed: () => renderStatus(),
  });

  function contextMenu(px, py) {
    const P = ed()?.placement;
    if (!P?.pl.model) return;
    const p = toLayout(px, py), nm = P.hitBlock(p.x, p.y);
    if (nm && !P.pl.sel.has(nm)) P.selectNames([nm]);
    const it = (act, label, off = false) => `<button type="button" class="mi" data-act="${act}"${off ? " disabled" : ""}>${label}</button>`;
    const busy = P.pl.busy || app.state.busy, n = P.pl.sel.size;
    const html = nm
      ? `<div class="mh">Block ${esc(nm)}${n > 1 ? ` +${n - 1} more` : ""}</div>` + it("flipx", "Flip x <kbd>X</kbd>", busy) + it("flipy", "Flip y <kbd>Y</kbd>", busy) +
        it("lock", "Lock / unlock <kbd>L</kbd>", busy) + it("swap", "Swap <kbd>S</kbd>", busy || n !== 2) + `<div class="msep"></div>` + it("settle", "Settle <kbd>Enter</kbd>", busy)
      : `<div class="mh">Placement</div>` + it("settle", "Settle <kbd>Enter</kbd>", busy) + it("retry", "Optimize (keep topology)", busy) + it("reflip", "Reflip", busy) +
        it("revert", "Revert to original", busy) + `<div class="msep"></div>` + it("fit", "Fit to view <kbd>K</kbd>");
    const r = f.canvas.getBoundingClientRect();
    popover(doc, html, { x: r.left + px, y: r.top + py, className: "pop menu", onClick: (ev, close) => { const b = ev.target.closest("[data-act]"); if (!b || b.disabled) return; close(); act(b.dataset.act, b); } });
  }

  // ---------------------------------------------------------------- 동작
  function act(a, b) {
    const P = ed()?.placement;
    switch (a) {
      case "run": app.runPlacement(); return;
      case "rebuild": app.rebuild(); return;
      case "rats": U.rats = !U.rats; renderTools(); stage.invalidate(); return;
      case "downloads": downloadMenu(doc, app, b); return;
      case "fit": fit(); return;
      case "zin": zoom(1.25); return;
      case "zout": zoom(1 / 1.25); return;
      case "net": app.select({ kind: "net", name: b.dataset.net }, "placement"); stage.invalidate(); return;
    }
    if (!P) return;
    switch (a) {
      case "flipx": P.flip("x"); return;
      case "flipy": P.flip("y"); return;
      case "lock": P.toggleLock(); return;
      case "swap": P.swap(); return;
      case "settle": P.settle(); return;
      case "retry": P.retry(); return;
      case "reflip": P.reflip(); return;
      case "revert": P.revert(); return;
      case "undo": P.undo(); return;
      case "redo": P.redo(); return;
      case "unpin": P.unpin(b.dataset.name); return;
      case "apply": P.applyRank(Number(b.dataset.k)); return;
    }
  }
  f.tools.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b && !b.disabled) { activate(); act(b.dataset.act, b); } });
  srcBody.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b && !b.disabled) { activate(); act(b.dataset.act, b); } });
  propsBody.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b && !b.disabled && b.tagName === "BUTTON") act(b.dataset.act, b); });
  propsBody.addEventListener("change", (e) => {
    const t = e.target, P = ed()?.placement;
    if (!P) return;
    if (t.dataset.act === "variant") P.setVariant(t.dataset.name, t.value);
    else if (t.dataset.act === "both") P.setBoth(t.checked);
    else if (t.dataset.act === "posx" || t.dataset.act === "posy") {
      const r = P.rectOf(t.dataset.name);
      if (r) P.moveTo(t.dataset.name, t.dataset.act === "posx" ? Number(t.value) : r.x, t.dataset.act === "posy" ? Number(t.value) : r.y);
    }
  });
  propsBody.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.act === "compact") { ed()?.placement.setCompact(Number(t.value) / 10); const v = propsBody.querySelector(".cval"); if (v) v.textContent = (Number(t.value) / 10).toFixed(1); }
  });
  blocksBody.addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-block]");
    if (!row) return;
    const P = ed()?.placement;
    if (P?.pl.model) P.selectNames([row.dataset.block], { add: e.shiftKey });
    else { app.select({ kind: "block", names: [row.dataset.block] }, "placement"); stage.invalidate(); }
  });

  // ---------------------------------------------------------------- 패널
  function renderTools() { f.tools.innerHTML = toolsHtml({ app, ed: ed(), frame: f, rats: U.rats }); }
  let shownStale = null;
  function renderSource() { shownStale = app.state.blob ? app.stale() : null; srcBody.innerHTML = sourceHtml(app); }
  function renderBlocks() { blocksBody.innerHTML = blocksHtml({ app, ed: ed() }); }
  function renderProps() {
    // 고치는 중인 칸(좌표·압축)을 다시 그리면 손이 끊긴다 — 그 칸을 떠난 뒤에
    const a = doc.activeElement;
    if (a && propsBody.contains(a) && a.tagName === "INPUT" && a.type === "number") { a.addEventListener("blur", () => renderProps(), { once: true }); return; }
    propsBody.innerHTML = propsHtml({ app, ed: ed() });
  }
  function renderResult() { resBody.innerHTML = resultHtml(app.state.ours); }
  function renderStatus() { f.status.innerHTML = statusHtml({ app, ed: ed(), cursor, view }); }
  let statusQ = 0;
  const statusSoon = () => { if (!statusQ) statusQ = win.requestAnimationFrame(() => { statusQ = 0; renderStatus(); }); };
  function renderAll() { renderTools(); renderSource(); renderBlocks(); renderProps(); renderResult(); renderStatus(); showSettings(); stage.invalidate(); }

  on("edit", (w) => { if (w && w !== "placement") return; renderTools(); renderBlocks(); renderProps(); renderStatus(); stage.invalidate(); });
  on("redraw", (w) => { if (!w || w === "placement") { stage.invalidate(); statusSoon(); } });
  on("hint", (w) => { if (w === "placement") statusSoon(); });
  on("placement", () => { renderAll(); });
  on("busy", () => { renderTools(); renderSource(); renderBlocks(); renderProps(); });
  on("design", () => { view.s = 1; view.tx = 0; view.ty = 0; renderAll(); });
  on("info", () => { renderSource(); });
  on("settings", showSettings);
  on("selection", () => { stage.invalidate(); renderProps(); renderBlocks(); });
  on("probe", (p) => { if (p?.from !== "placement") stage.invalidate(); });
  const unTheme = watchTheme(doc, () => { pal = readPalette(doc); stage.invalidate(); });
  f.onPanels = () => stage.invalidate();

  const keys = (e) => {
    if (!isActive() || !f.canvas.offsetParent) return;
    const t = e.target;
    if (t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable)) return;
    if (placementKey(e, { ed, fit, zoom })) e.preventDefault();
  };
  win.addEventListener("keydown", keys);
  const staleTimer = win.setInterval(() => { if (app.state.blob && app.stale() !== shownStale) renderSource(); }, 1000);
  renderAll();

  // ---------------------------------------------------------------- 검사가 들여다보는 것
  const probe = {
    map: () => (lastMap = mapNow()),
    /** 블록의 화면 좌표 (캔버스 CSS px) */
    rectPx(name) {
      const r = ed()?.placement.pl.live?.rects.find((q) => q.name === name) ?? app.state.ours?.rects.find((q) => q.name === name), m = mapNow()?.m;
      if (!r || !m) return null;
      return { x: m.X(r.x), y: m.Y(r.y + r.h), w: r.w * m.S, h: r.h * m.S, cx: m.X(r.x + r.w / 2), cy: m.Y(r.y + r.h / 2) };
    },
    axisPx(k) {
      const pl = ed()?.placement.pl, a = pl?.live?.axes.find((q) => q.k === k), m = mapNow()?.m, bb = app.state.ours?.bbox;
      if (!a || !m || !bb) return null;
      return { x: a.vert ? m.X(a.at) : m.X(bb[2]) - 8, y: a.vert ? m.Y(bb[3]) + 8 : m.Y(a.at) };
    },
    canvas: f.canvas, view,
  };
  return {
    probe, frame: f, view,
    redraw: () => stage.invalidate(),
    unmount() {
      offs.forEach((x) => x()); unTheme(); inter.detach(); stage.destroy(); f.destroy();
      win.removeEventListener("keydown", keys);
      win.clearInterval(staleTimer);
      root.innerHTML = "";
    },
  };
}
