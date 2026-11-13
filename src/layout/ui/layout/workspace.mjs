/** 레이아웃 편집기 (작업 공간) — 셀 위에 트랙을 손으로 긋는 곳. PCB 편집기의 트랙 그리기를 IC 금속(층마다 한 방향)에 맞췄다.
 *
 *    도구 줄     고르기 · 트랙 · 비아 · 그리기 층 li1~met4 · 되돌리기 · 지우기 · 자동 배선 ▾ (고를 수 있다) · 검사 · 내려받기
 *    왼쪽        넷 목록(핀 · 열림) / DRC·LVS 오류 목록 — 누르면 고르고 그 자리로 간다
 *    가운데      캔버스 — 셀(바탕), 그린 트랙 · 비아, 래츠네스트, 그리는 중인 L, 오류 표식
 *    오른쪽      속성 (그리는 중 · 고른 것 · 넷 · 요약) / 층 (보이기 · 색 · 그리기 층)
 *    아래        커서 좌표(nm) · 그리기 층 · 배율 · 열린 넷 · DRC/LVS · 하는 일 한 줄
 *
 *  편집의 셈은 track.mjs (와 src/layout/art/) 에 있고, 여기는 그것을 화면에 붙인다.
 *  mountLayout(root, app, opts) -> { unmount, probe }. 새 창에서도 같은 함수로 붙는다 (그 창의 문서에).
 */
import { makeView, fitOf, mapper, zoomAt, focusBox, drawEmpty } from "../canvas/viewport.mjs";
import { createStage } from "../canvas/stage.mjs";
import { attachCanvas, drawBox } from "../canvas/interact.mjs";
import { createFrame } from "../ui/frame.mjs";
import { readPalette } from "../core/palette.mjs";
import { watchTheme } from "../core/theme.mjs";
import { popover } from "../core/dom.mjs";
import { defaultVisible, LAYERS, OBJECTS, lname, larrow } from "./layers.mjs";
import { drawGrid, drawGeometry, createBaseCache, drawBlocks, drawMeasure } from "./render.mjs";
import { drawArt, drawPins, drawRats, drawDrawing, drawStart, drawErrorMarks, drawLayerHud, drawEditPreview, drawHandles, drawFlash } from "./art-render.mjs";
import { toolsHtml, autoMenuHtml, netsHtml, errorsHtml, layersHtml, propsHtml, statusHtml } from "./panels.mjs";
import { layoutKey } from "./keymap.mjs";
import { placeGrid } from "../../pdk/pdk.mjs";
import { downloadMenu } from "../ui/downloads.mjs";

/** 누른 자리에서 이만큼(화면 px) 안의 핀 · 트랙을 집는다 — 손가락은 넓게 */
const PAD = 24, HIT_PX = 7, HIT_TOUCH = 16;

export function mountLayout(root, app, { isActive = () => true, activate = () => {} } = {}) {
  const doc = root.ownerDocument, win = doc.defaultView;
  const f = createFrame(root, { id: "layout", label: "Layout editor" });
  f.ids = true;
  app.state.ui ??= {};
  const L = (app.state.ui.layout ??= { vis: defaultVisible(), tab: "nets", filter: "", tool: "select" });
  const view = makeView();
  let pal = readPalette(doc);
  let measure = null;                     // 재기 {a, b, cur} (nm)
  let cursor = null, cursorPx = null;     // 커서 (nm, 캔버스 px)
  let lastMap = null;                     // {m, panel, fit}
  let errFocus = null;                    // 오류 목록에서 고른 줄
  const T = () => app.editors?.track ?? null;
  const offs = [];
  const on = (t, fn) => offs.push(app.bus.on(t, fn, win));

  // ---------------------------------------------------------------- 패널 자리
  f.left.innerHTML = `<div class="tabs" role="tablist"><button type="button" class="tab" data-tab="nets">Nets</button><button type="button" class="tab" data-tab="errs">Errors <b class="cnt"></b></button></div>
    <div class="tabpane" data-pane="nets"><input type="search" class="filter" placeholder="Filter net names" aria-label="Filter nets"><div class="lst" id="lyNets"></div></div>
    <div class="tabpane" data-pane="errs"><div class="lst" id="lyErrs"></div></div>`;
  const propsBody = f.section("right", "props", "Properties", { open: true });
  const layersBody = f.section("right", "layers", "Layers", { open: true });
  propsBody.id = "lyProps";
  layersBody.classList.add("layers");
  f.tools.id = "lyTools";
  f.status.id = "lyStatus";
  const netsEl = f.left.querySelector("#lyNets"), errsEl = f.left.querySelector("#lyErrs"), filterEl = f.left.querySelector(".filter");
  filterEl.value = L.filter ?? "";

  // ---------------------------------------------------------------- 변환
  function fitBox() {
    const o = app.state.ours ?? app.state.frame;
    let b = o?.bbox;
    if (!b) return null;
    // 그린 트랙이 배치의 외곽 밖으로 나가면 (둘레에 길을 내어 배선했거나 손으로 그었다) 그것까지 보이게
    const ext = T()?.artBox?.();
    if (ext) b = [Math.min(b[0], ext[0]), Math.min(b[1], ext[1]), Math.max(b[2], ext[2]), Math.max(b[3], ext[3])];
    const pad = Math.max(400, 0.03 * Math.max(b[2] - b[0], b[3] - b[1]));
    return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
  }
  function mapNow() {
    const { W, H } = stage.size();
    const panel = { x: 0, y: 0, w: W, h: H };
    const box = fitBox();
    if (!box) return null;
    const fit = fitOf(box, panel, PAD);
    return { m: mapper(fit, view, panel), panel, fit };
  }
  const toLayout = (px, py) => { const mm = (lastMap = mapNow())?.m; return mm ? { x: mm.toX(px), y: mm.toY(py) } : null; };
  let touchy = false;                     // 마지막 포인터가 손가락 · 펜이었나
  const tolNow = () => { const mm = lastMap ?? mapNow(); return mm ? (touchy ? HIT_TOUCH : HIT_PX) / mm.m.S : 0; };
  const panelNow = () => { const { W, H } = stage.size(); return { x: 0, y: 0, w: W, h: H }; };

  // ---------------------------------------------------------------- 그리기
  const cache = createBaseCache(doc);
  let cellsFor = null, cellsGeo = null, cellsVer = 0;
  function draw(ctx, W, H, dpr) {
    if (!f.canvas.offsetParent) return;                // 숨은 작업 공간은 안 그린다
    const panel = { x: 0, y: 0, w: W, h: H };
    const st = app.state, ed = T(), te = ed?.te;
    const box = fitBox();
    ctx.fillStyle = pal.canvas; ctx.fillRect(0, 0, W, H);
    if (!box) {
      lastMap = null;
      drawEmpty(ctx, panel, pal, st.busy ? ["Placing…"] : ["No placement yet", "Press Auto place in the Placement editor, then draw the tracks here"]);
      return;
    }
    const fit = fitOf(box, panel, PAD), m = mapper(fit, view, panel);
    lastMap = { m, panel, fit };
    const base = ed?.base(), d = ed?.derived();
    if (base !== cellsFor) { cellsFor = base; cellsGeo = base ? { terminals: base.shapes } : null; cellsVer++; }
    const focus = te?.draw?.net ?? te?.net ?? (st.selection?.kind === "net" && st.link ? st.selection.name : null);
    const grid = st.ours?.grid ?? placeGrid();
    const key = [cellsVer, m.S.toFixed(6), m.X(0).toFixed(2), m.Y(0).toFixed(2), W, H, dpr, [...L.vis].sort().join(","), focus ?? "", te?.layer ?? "", pal.canvas, pal.grid].join("|");
    cache(ctx, W, H, dpr, key, (c) => {
      c.fillStyle = pal.canvas; c.fillRect(0, 0, W, H);
      if (L.vis.has("grid")) drawGrid(c, m, panel, pal, grid);
      if (cellsGeo) drawGeometry(c, m, cellsGeo, { vis: L.vis, focus: focus ? new Set([focus]) : null, active: te?.layer });
    });
    const ob = (st.ours ?? st.frame)?.bbox;
    if (ob) { ctx.strokeStyle = pal.line; ctx.lineWidth = 1; ctx.strokeRect(m.X(ob[0]) + 0.5, m.Y(ob[3]) + 0.5, (ob[2] - ob[0]) * m.S, (ob[3] - ob[1]) * m.S); }
    const rects = (st.ours ?? st.frame)?.rects ?? [];
    const hi = st.selection?.kind === "block" && st.link ? new Set(st.selection.names) : null;
    const pb = st.probe?.kind === "block" && st.link ? new Set(st.probe.names) : null;
    drawBlocks(ctx, m, pal, rects, { routed: true, vis: L.vis, hi, probe: pb });
    if (d && te) {
      drawArt(ctx, m, d.an.drawn, { vis: L.vis, active: te.layer, focus, sel: te.sel, hover: te.hover, pal, hide: te.edit ? new Set(te.edit.e.del) : null });
      if (te.edit) drawEditPreview(ctx, m, te.edit, pal);
      else if (te.tool === "select") drawHandles(ctx, m, ed.art(), te.sel, pal);
      drawPins(ctx, m, base, { focus, hover: te.hover, pal });
      if (L.vis.has("fly")) drawRats(ctx, m, d.an.ratsnest, { focus, pal });
      if (L.vis.has("marks")) drawErrorMarks(ctx, m, te.marks, pal, errFocus);
      if (te.tool === "track" && !te.draw && te.hover?.start) drawStart(ctx, m, te.hover.start, pal);
      drawDrawing(ctx, m, te.draw, te.preview, pal);
      if ((te.tool === "track" || te.tool === "via") && cursorPx) drawLayerHud(ctx, cursorPx, te.draw?.cur ?? te.layer, te.draw?.other ?? te.other, pal);
      if (te.flash && cursorPx && performance.now() < te.flash.until) drawFlash(ctx, cursorPx, te.flash.text, pal, W);
    }
    if (L.tool === "measure") drawMeasure(ctx, m, pal, measure);
    drawBox(ctx, inter?.box, pal.ours);
    ctx.font = "500 10px ui-monospace, Menlo, Consolas, monospace"; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillStyle = pal.faint;
    const stt = ed?.stats();
    const label = st.frame ? `Searching · ${st.frame.module}` : stt ? `Layout · ${stt.wires} tracks · ${stt.vias} vias · open ${stt.open.length}` : "";
    if (label) ctx.fillText(label, 10, 8);
  }
  const stage = createStage(f.canvas, draw);

  // ---------------------------------------------------------------- 도구와 포인터
  const tool = () => L.tool;
  function setTool(t) {
    L.tool = t;
    if (t !== "measure") measure = null;
    T()?.setTool(t === "measure" ? "select" : t);
    f.canvas.classList.toggle("drawtool", t === "track" || t === "via" || t === "measure");
    renderTools(); renderProps(); stage.invalidate();
  }
  function clearMeasure() { if (!measure) return false; measure = null; renderProps(); stage.invalidate(); return true; }
  function fit() { view.s = 1; view.tx = 0; view.ty = 0; stage.invalidate(); renderStatus(); }
  function zoom(k) { const p = panelNow(); zoomAt(view, p, p.w / 2, p.h / 2, k, 0.25, 400); stage.invalidate(); renderStatus(); }
  /** 레이아웃 상자(nm)로 간다 */
  function goTo(r, frac = 0.35) {
    const mm = mapNow();
    if (!mm || !r) return;
    focusBox(view, mm.fit, mm.panel, r, frac, 400);
    stage.invalidate(); renderStatus();
  }
  const ready = () => !!T()?.base();
  const inter = attachCanvas(f.canvas, {
    view, panel: panelNow, redraw: () => stage.invalidate(), limits: [0.25, 400],
    spaceGrabs: () => isActive() && !T()?.te.draw,                 // 그리는 중의 Space 는 L 뒤집기
    down(e, px, py) {
      activate();
      touchy = e.pointerType === "touch" || e.pointerType === "pen";
      cursorPx = { x: px, y: py };
      lastMap = mapNow();
      const p = toLayout(px, py);
      if (L.tool === "measure") {
        if (!measure || measure.b) measure = { a: p, b: null, cur: p, x0: px, y0: py };
        else measure.b = p;
        renderProps(); stage.invalidate();
        return true;
      }
      if (!ready() || !p) return false;
      if (e.button === 2) return false;
      const r = T().down(e, p, tolNow());
      return r === "box" ? "box" : !!r;
    },
    move(e, px, py) {
      const p = toLayout(px, py);
      if (L.tool === "measure") { if (measure && !measure.b) { measure.cur = p; renderProps(); stage.invalidate(); } return; }
      if (!ready() || !p) return;
      T().move(e, p, tolNow());
      // 끌 수 있는 것 위에서는 커서가 그 방향을 보인다 (가로 층의 줄은 위아래로, 세로 층은 좌우로, 비아는 사방)
      const cur = T().cursorAt(p, tolNow());
      if (f.canvas.style.cursor !== cur) f.canvas.style.cursor = cur;
    },
    up(e, px, py) {
      if (!ready()) return;
      if (T().up(e, toLayout(px, py), tolNow())) { renderProps(); stage.invalidate(); }
    },
    click() { if (L.tool === "select" && ready()) T().clearSelection(); },
    box(b, opt) {
      if (L.tool !== "select" || !ready()) return;
      const a = toLayout(b.x0, b.y0), c = toLayout(b.x1, b.y1);
      T().selectBox([Math.min(a.x, c.x), Math.min(a.y, c.y), Math.max(a.x, c.x), Math.max(a.y, c.y)], !!opt?.add);
    },
    dbl(e, px, py) {
      if (!ready()) return false;
      if (T().te.draw) { T().finish(); return true; }
      if (L.tool === "select") { const p = toLayout(px, py); if (p) T().pickConnected(p, tolNow()); return true; }
      return false;
    },
    context(e, px, py) { contextMenu(e, px, py); },
    leave() { cursor = null; cursorPx = null; renderStatus(); T()?.leave(); },
    moved(px, py) { cursor = toLayout(px, py); cursorPx = { x: px, y: py }; statusSoon(); if (T()?.te.tool !== "select") stage.invalidate(); },
    fit, zoomed: () => renderStatus(),
  });

  function contextMenu(e, px, py) {
    const ed = T();
    if (!ed || !ready()) return;
    if (ed.te.draw) { ed.finish(); return; }                    // 그리는 중 오른쪽 클릭 = 끝
    const it = (act, label, off = false) => `<button type="button" class="mi" data-act="${act}"${off ? " disabled" : ""}>${label}</button>`;
    const moveTo = ed.layersForSel().map((Lr) => `<button type="button" class="mi" data-act="relayer" data-layer="${Lr}">Move to ${lname(Lr)} ${larrow(Lr)}</button>`).join("");
    const html = `<div class="mh">Layout</div>` + it("tool-track", "Track <kbd>W</kbd>") + it("tool-via", "Via <kbd>V</kbd>") +
      it("del", "Delete selected <kbd>Del</kbd>", !ed.te.sel.size) + (moveTo ? `<div class="msep"></div>${moveTo}` : "") +
      `<div class="msep"></div>` + it("fit", "Fit to view <kbd>K</kbd>") + it("check", "Check DRC/LVS");
    const r = f.canvas.getBoundingClientRect();
    popover(doc, html, { x: r.left + px, y: r.top + py, className: "pop menu", onClick: (ev, close) => { const b = ev.target.closest("[data-act]"); if (!b || b.disabled) return; close(); act(b.dataset.act, b); } });
  }

  // ---------------------------------------------------------------- 동작 (단추 · 메뉴 · 목록)
  function act(a, b) {
    const ed = T();
    switch (a) {
      case "downloads": downloadMenu(doc, app, b); return;
      case "tool": setTool(b.dataset.tool); return;
      case "tool-track": setTool("track"); return;
      case "tool-via": setTool("via"); return;
      case "fit": fit(); return;
      case "zin": zoom(1.25); return;
      case "zout": zoom(1 / 1.25); return;
      case "vis": { const k = b.dataset.key; if (L.vis.has(k)) L.vis.delete(k); else L.vis.add(k); renderLayers(); stage.invalidate(); return; }
      case "fold": { const g = b.dataset.group; L.fold ??= ["via", "device", "well"]; L.fold = L.fold.includes(g) ? L.fold.filter((x) => x !== g) : [...L.fold, g]; renderLayers(); return; }
      case "visgroup": {
        const g = b.dataset.group;
        const keys = g === "object" ? OBJECTS.map((o) => o.key) : LAYERS.filter((l) => l.group === g).map((l) => l.key);
        const all = keys.every((k) => L.vis.has(k));
        for (const k of keys) { if (all) L.vis.delete(k); else L.vis.add(k); }
        renderLayers(); stage.invalidate(); return;
      }
    }
    if (!ed) return;
    switch (a) {
      case "layer": ed.setLayer(b.dataset.layer); return;
      case "undo": ed.undo(); return;
      case "redo": ed.redo(); return;
      case "del": ed.del(); return;
      case "clearsel": ed.clearSelection(); return;
      case "finish": ed.finish(); return;
      case "back": ed.back(); return;
      case "flip": ed.flip(); return;
      case "check": ed.checkNow(); L.tab = "errs"; renderLeft(); return;
      case "clear": ed.clear(); return;
      case "automenu":
        popover(doc, autoMenuHtml({ T: ed }), { anchor: b, className: "pop menu", onClick: (ev, close) => { const x = ev.target.closest("[data-act]"); if (!x || x.disabled) return; close(); act(x.dataset.act, x); } });
        return;
      case "autoall": app.runRouting({ keep: new Set() }); return;
      case "autorest": app.runRouting({ keep: ed.finishedNets() }); return;
      case "pick": ed.selectNet(b.dataset.net); return;
      case "relayer": ed.relayerSel(b.dataset.layer); return;
      case "nudge": ed.nudgeSel(Number(b.dataset.dx ?? 0), Number(b.dataset.dy ?? 0)); return;
    }
  }
  f.tools.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b && !b.disabled) { activate(); act(b.dataset.act, b); } });
  f.right.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b && !b.disabled) act(b.dataset.act, b); });
  f.left.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) { L.tab = tab.dataset.tab; renderLeft(); return; }
    const row = e.target.closest("tr[data-net]");
    if (row && T()) { T().selectNet(row.dataset.net); return; }
    const li = e.target.closest("li[data-err]");
    if (li) {
      const mk = T()?.te.marks[Number(li.dataset.err)];
      errFocus = mk?.text ?? null;
      if (mk?.rects.length) {
        const r = mk.rects.reduce((a, q) => [Math.min(a[0], q[0]), Math.min(a[1], q[1]), Math.max(a[2], q[2]), Math.max(a[3], q[3])], [Infinity, Infinity, -Infinity, -Infinity]);
        goTo([r[0] - 400, r[1] - 400, r[2] + 400, r[3] + 400], 0.4);
      }
      stage.invalidate();
    }
  });
  f.left.addEventListener("dblclick", (e) => {
    const row = e.target.closest("tr[data-net]");
    const base = T()?.base();
    if (!row || !base) return;
    const rects = base.pins.filter((p) => p.netName === row.dataset.net).map((p) => p.rect);
    if (rects.length) goTo(rects.reduce((a, q) => [Math.min(a[0], q[0]), Math.min(a[1], q[1]), Math.max(a[2], q[2]), Math.max(a[3], q[3])], [Infinity, Infinity, -Infinity, -Infinity]), 0.6);
  });
  filterEl.addEventListener("input", () => { L.filter = filterEl.value; renderLeft(); });

  // ---------------------------------------------------------------- 패널 그리기
  function renderTools() { f.tools.innerHTML = toolsHtml({ app, T: T(), frame: f }); }
  function renderLeft() {
    for (const b of f.left.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === L.tab));
    for (const p of f.left.querySelectorAll("[data-pane]")) p.hidden = p.dataset.pane !== L.tab;
    const n = T()?.te.checked?.real;                                  // 아직 안 이은 넷은 오류 수에 넣지 않는다
    f.left.querySelector(".cnt").textContent = n ? String(n) : "";
    if (L.tab === "nets") netsEl.innerHTML = netsHtml({ T: T(), filter: L.filter ?? "" });
    else errsEl.innerHTML = errorsHtml({ T: T() });
  }
  function renderLayers() { layersBody.innerHTML = layersHtml({ vis: L.vis, T: T(), fold: L.fold ?? ["via", "device", "well"] }); }
  /** 커서 아래 넷을 밝힌다 (H — 회로도와 같은 키). 넷이 없으면 끈다 */
  function highlight() {
    const ed = T();
    if (!ed || !cursor) return;
    const d = ed.derived();
    const tol = tolNow(), box = [cursor.x - tol, cursor.y - tol, cursor.x + tol, cursor.y + tol];
    let net = null;
    for (const Lr of ["M5", "M4", "M3", "M2", "M1"]) { const s = d?.index(Lr, box).find((q) => q.netName); if (s) { net = s.netName; break; } }
    if (net) ed.selectNet(net); else ed.clearSelection();
  }
  function renderProps() { propsBody.innerHTML = propsHtml({ app, T: T() }); }
  function renderStatus() { f.status.innerHTML = statusHtml({ T: T(), cursor, view, hint: app.editors?.hint("layout") ?? "" }); }
  let statusQ = 0;
  const statusSoon = () => { if (!statusQ) statusQ = win.requestAnimationFrame(() => { statusQ = 0; renderStatus(); }); };
  function renderAll() { renderTools(); renderLeft(); renderLayers(); renderProps(); renderStatus(); stage.invalidate(); }

  on("edit", (w) => { if (w && w !== "layout" && w !== "placement") return; renderAll(); });
  on("redraw", (w) => { if (!w || w === "layout") stage.invalidate(); });
  on("hint", (w) => { if (w === "layout") statusSoon(); });
  for (const t of ["placement", "routing", "busy", "design"]) on(t, () => renderAll());
  on("selection", () => { stage.invalidate(); renderProps(); renderLeft(); });
  on("probe", () => stage.invalidate());
  on("design", () => { view.s = 1; view.tx = 0; view.ty = 0; measure = null; });
  const unTheme = watchTheme(doc, () => { pal = readPalette(doc); stage.invalidate(); });
  f.onPanels = () => stage.invalidate();

  // ---------------------------------------------------------------- 키
  const keys = (e) => {
    if (!isActive() || !f.canvas.offsetParent) return;
    const t = e.target;
    if (t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable)) return;
    if (layoutKey(e, { T, tool, setTool, fit, zoom, clearMeasure, highlight })) e.preventDefault();
  };
  win.addEventListener("keydown", keys);

  setTool(L.tool === "wire" ? "track" : L.tool ?? "select");
  renderAll();

  // ---------------------------------------------------------------- 검사가 들여다보는 것
  const probe = {
    map: () => (lastMap = mapNow()),
    /** 레이아웃 좌표(nm) -> 캔버스 CSS px */
    at(x, y) { const m = mapNow()?.m; return m ? { x: m.X(x), y: m.Y(y) } : null; },
    /** 핀 — 넷마다 [{ net, layer, rect, px: {x, y} 가운데 }] */
    pins(net = null) {
      const m = mapNow()?.m, base = T()?.base();
      if (!m || !base) return [];
      return base.pins.filter((p) => !net || p.netName === net).map((p) => ({ net: p.netName, layer: p.layer, rect: p.rect,
        px: { x: m.X((p.rect[0] + p.rect[2]) / 2), y: m.Y((p.rect[1] + p.rect[3]) / 2) } }));
    },
    ratsnest() { const m = mapNow()?.m; return (T()?.derived()?.an.ratsnest ?? []).map((r) => ({ net: r.net, a: m ? { x: m.X(r.a[0]), y: m.Y(r.a[1]) } : null, b: m ? { x: m.X(r.b[0]), y: m.Y(r.b[1]) } : null, nm: r })); },
    stats: () => T()?.stats() ?? null,
    canvas: f.canvas, view, tool, setTool,
  };
  return {
    probe, frame: f, view,
    redraw: () => stage.invalidate(),
    unmount() {
      offs.forEach((x) => x()); unTheme(); inter.detach(); stage.destroy(); f.destroy();
      win.removeEventListener("keydown", keys);
      root.innerHTML = "";
    },
  };
}
