/** 편집기 셋의 자리 — 회로(melange 의 회로도) · Placement · Layout.
 *
 *  메뉴 막대 오른쪽의 [Circuit ▾ Placement ▾ Layout] (switch.ts 가 그린다):
 *    이름을 누르면 그 편집기 하나만. 이름 사이의 삼각형은 그 양옆 둘을 어떻게 볼지 고른다 —
 *    좌우로 / 위아래로 / 셋 다 / 새 창으로 / 새 창 합치기 / 선택 연동 켜고 끄기.
 *
 *  회로는 melange 의 화면 그대로다 (도구 막대·회로도·패널·아래 칸). Placement·Layout 은 그 옆(또는 아래)의 #lyt-host 에
 *  붙는다. 둘이 같이 보이면 #lyt-host 안에서 다시 나눈다. 사이의 막대를 끌어 폭을 나누고, 마지막으로 누른 편집기가
 *  단축키를 받는다 (테두리로 보인다).
 *
 *  새 창은 layout.html?ws=<편집기> 를 연다 — 그 창은 이 창의 앱(window.__melangeLayout)을 그대로 써서 같은 배치·배선·
 *  이력을 본다. 이 창이 닫히면 새 창도 닫는다.
 */
import { createApp } from "./core/app.mjs";
import { createEditors } from "./editors.mjs";
import { createLayoutControl } from "./ai.mjs";
import { layoutNetlist } from "../bridge.ts";
import { esc, icon, popover } from "./core/dom.mjs";
import "./styles/layout.css";

export const WS = [
  { id: "circuit", label: "Circuit" },
  { id: "placement", label: "Placement" },
  { id: "layout", label: "Layout" },
];
const LABEL = Object.fromEntries(WS.map((w) => [w.id, w.label]));
const KEY = "melange.layout.shell";
const MOUNT = {
  placement: () => import("./placement/workspace.mjs").then((M) => M.mountPlacement),
  layout: () => import("./layout/workspace.mjs").then((M) => M.mountLayout),
};

/**
 * @param {Document} doc
 * @param {object} host0  melange 쪽 — snapshot() (시트·라이브러리·넷 추출·이름), version(), selectParts(), highlightNet(),
 *                        onSelection(cb), onLayoutChange() (회로 칸의 크기가 바뀌었다), refreshSwitch()
 */
export function createShell(doc, host0) {
  const win = doc.defaultView;
  const root = doc.documentElement;
  // 회로도 -> 레이아웃 넷리스트는 여기서 (bridge.ts 도 이 덩어리에 든다)
  const host = {
    ...host0,
    netlist: () => { const s = host0.snapshot(); return layoutNetlist(s.sheet, s.library, s.ex, { name: s.name }); },
    name: () => host0.snapshot().name,
  };
  const app = createApp(host);
  app.attachEditors(createEditors(app));
  host.onSelection?.((refs) => app.fromCircuit(refs));

  let S = { visible: ["circuit"], dir: "cols", split: 0.5, inner: 0.5, active: "circuit" };
  try { const s = JSON.parse(localStorage.getItem(KEY) ?? "{}"); S.dir = s.dir ?? S.dir; S.split = s.split ?? S.split; S.inner = s.inner ?? S.inner; } catch { /* 처음 */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ dir: S.dir, split: S.split, inner: S.inner })); } catch { /* 기억 못 해도 된다 */ } };

  // ---------------------------------------------------------------- 자리
  const hostEl = doc.createElement("div");
  hostEl.id = "lyt-host";
  hostEl.className = "lyt";
  hostEl.hidden = true;
  hostEl.innerHTML = `<div class="lyt-split lyt-outer" title="Drag to resize"></div><div class="lyt-inner"></div>`;
  doc.body.append(hostEl);
  const inner = hostEl.querySelector(".lyt-inner");
  const panes = new Map();           // 편집기 -> { el, ws, loading }
  const popped = new Map();          // 편집기 -> Window
  const innerSplit = doc.createElement("div");
  innerSplit.className = "lyt-split lyt-mid";
  innerSplit.title = "Drag to resize";

  function paneOf(id) {
    let p = panes.get(id);
    if (p) return p;
    const el = doc.createElement("section");
    el.className = "wspane"; el.dataset.ws = id; el.hidden = true;
    el.setAttribute("aria-label", LABEL[id]);
    p = { el, ws: null, loading: null };
    panes.set(id, p);
    el.addEventListener("pointerdown", () => activate(id), true);
    p.loading = MOUNT[id]()
      .then((mount) => mount(el, app, { isActive: () => isActive(id), activate: () => activate(id) }))
      .then((ws) => { p.ws = ws; win.__layoutViews ??= {}; win.__layoutViews[id] = ws; ws.redraw(); })
      .catch((e) => {
        console.error(`[${LABEL[id]} editor failed to load]`, e);
        el.innerHTML = `<p class="loadfail">The ${esc(LABEL[id])} editor failed to load — ${esc(e.message)}. Try reloading the page.</p>`;
      });
    return p;
  }

  /** 이 창에서 보이는 것 (새 창으로 뺀 것은 빼고) */
  const shown = () => S.visible.filter((id) => !popped.has(id));
  const isActive = (id) => S.active === id && !popped.has(id);

  function activate(id) {
    if (S.active === id) return;
    S.active = id;
    for (const [k, p] of panes) p.el.classList.toggle("active", k === id && shown().length > 1);
    root.classList.toggle("lyt-circuit-active", id === "circuit" && shown().length > 1);
    host.refreshSwitch?.();
  }

  function apply() {
    const vis = shown();
    const circuit = vis.includes("circuit");
    const eds = vis.filter((v) => v !== "circuit");
    root.classList.toggle("lyt-on", eds.length > 0);
    root.classList.toggle("lyt-solo", eds.length > 0 && !circuit);
    root.classList.toggle("lyt-cols", eds.length > 0 && circuit && S.dir === "cols");
    root.classList.toggle("lyt-rows", eds.length > 0 && circuit && S.dir === "rows");
    root.style.setProperty("--lyt-a", `${(S.split * 100).toFixed(2)}fr`);
    root.style.setProperty("--lyt-b", `${((1 - S.split) * 100).toFixed(2)}fr`);
    hostEl.hidden = eds.length === 0;
    hostEl.querySelector(".lyt-outer").hidden = !circuit;
    inner.classList.toggle("rows", (circuit ? S.dir === "cols" : S.dir === "rows"));   // 회로가 옆이면 둘은 위아래로
    inner.replaceChildren();
    eds.forEach((id, i) => {
      const p = paneOf(id);
      p.el.hidden = false;
      p.el.style.flex = eds.length > 1 ? `${(i === 0 ? S.inner : 1 - S.inner) * 100} 1 0` : "1 1 0";
      if (i === 1) inner.append(innerSplit);
      inner.append(p.el);
    });
    for (const [id, p] of panes) if (!eds.includes(id)) p.el.hidden = true;
    if (!vis.includes(S.active)) S.active = eds[0] ?? "circuit";
    for (const [k, p] of panes) p.el.classList.toggle("active", k === S.active && vis.length > 1);
    root.classList.toggle("lyt-circuit-active", S.active === "circuit" && vis.length > 1);
    for (const id of eds) { const p = panes.get(id); p.loading?.then(() => p.ws?.redraw()); }
    host.onLayoutChange?.();
    host.refreshSwitch?.();
  }

  // ---------------------------------------------------------------- 보기 바꾸기
  /** 편집기 하나만 (새 창에 있으면 그 창으로) */
  function show(id) {
    if (popped.has(id)) { popped.get(id).focus(); return; }
    S.visible = [id]; S.active = id;
    apply();
  }
  function showPair(a, b, dir) {
    S.visible = [a, b]; S.dir = dir; S.active = b;
    save(); apply();
  }
  function showAll(dir = S.dir) {
    S.visible = ["circuit", "placement", "layout"]; S.dir = dir; S.active = "placement";
    save(); apply();
  }

  /** 편집기를 새 창으로 */
  function popOut(id) {
    if (id === "circuit") return;
    if (popped.has(id) && !popped.get(id).closed) { popped.get(id).focus(); return; }
    const url = new URL("layout.html", win.location.href);
    url.searchParams.set("ws", id);
    const w = win.open(url.href, `melange-${id}`, "popup,width=1180,height=820");
    if (!w) { app.sayErr("The browser blocked the new window — allow pop-ups for this page."); return; }
    popped.set(id, w);
    panes.get(id)?.el && (panes.get(id).el.hidden = true);
    if (!S.visible.includes(id)) S.visible = [...S.visible, id];
    if (S.visible.every((v) => popped.has(v))) S.visible = ["circuit", ...S.visible.filter((v) => v !== "circuit")];
    apply();
    const watch = win.setInterval(() => {
      if (!w.closed) return;
      win.clearInterval(watch);
      if (popped.get(id) === w) { popped.delete(id); S.visible = S.visible.filter((v) => v !== id); if (!shown().length) S.visible = ["circuit"]; apply(); }
    }, 500);
  }
  /** 새 창을 다시 이 창으로 */
  function merge() {
    const back = [...popped.keys()];
    for (const [, w] of popped) { try { w.close(); } catch { /* 이미 닫혔다 */ } }
    popped.clear();
    S.visible = [...new Set([...S.visible, ...back])];
    apply();
  }
  win.addEventListener("beforeunload", () => { for (const [, w] of popped) { try { w.close(); } catch { /* 닫혔다 */ } } });

  /** 삼각형 메뉴 — 양옆 둘(a, b)을 어떻게 볼지 */
  function pairMenu(i, anchor) {
    const a = WS[i].id, b = WS[i + 1].id;
    const A = LABEL[a], B = LABEL[b];
    const item = (act, ic, text, on = false) =>
      `<button type="button" data-act="${act}" class="${on ? "on" : ""}">${icon(ic, 15)}<span>${esc(text)}</span></button>`;
    const pairOn = S.visible.length === 2 && S.visible.includes(a) && S.visible.includes(b);
    const html = [
      item("cols", "cols", `${A} | ${B} side by side`, pairOn && S.dir === "cols"),
      item("rows", "rows", `${A} above ${B}`, pairOn && S.dir === "rows"),
      item("all", "cols", "All three", S.visible.length === 3),
      '<hr>',
      ...[a, b].filter((x) => x !== "circuit").map((x) => item(`pop:${x}`, "popout", popped.has(x) ? `${LABEL[x]} window — bring to front` : `Open ${LABEL[x]} in a new window`)),
      popped.size ? item("merge", "merge", "Bring the windows back here") : "",
      '<hr>',
      item("link", "link", "Link selection with the schematic", app.state.link),
    ].join("");
    popover(doc, html, {
      anchor, className: "pop lyt-menu",
      onClick: (e, close) => {
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;
        const act = btn.dataset.act;
        close();
        if (act === "cols" || act === "rows") showPair(a, b, act);
        else if (act === "all") showAll();
        else if (act.startsWith("pop:")) popOut(act.slice(4));
        else if (act === "merge") merge();
        else if (act === "link") { app.state.link = !app.state.link; app.emit("settings"); }
      },
    });
  }

  // ---------------------------------------------------------------- 사이 막대
  function drag(bar, set) {
    bar.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const move = (ev) => set(ev);
      const up = () => { bar.removeEventListener("pointermove", move); bar.removeEventListener("pointerup", up); save(); apply(); };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
    });
  }
  drag(hostEl.querySelector(".lyt-outer"), (ev) => {
    const W = doc.documentElement.clientWidth, H = doc.documentElement.clientHeight;
    S.split = Math.min(0.85, Math.max(0.15, S.dir === "rows" ? ev.clientY / H : ev.clientX / W));
    root.style.setProperty("--lyt-a", `${(S.split * 100).toFixed(2)}fr`);
    root.style.setProperty("--lyt-b", `${((1 - S.split) * 100).toFixed(2)}fr`);
    host.onLayoutChange?.();
  });
  drag(innerSplit, (ev) => {
    const r = inner.getBoundingClientRect();
    const rows = inner.classList.contains("rows");
    S.inner = Math.min(0.85, Math.max(0.15, rows ? (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width));
    const eds = shown().filter((v) => v !== "circuit");
    eds.forEach((id, i) => { panes.get(id).el.style.flex = `${(i === 0 ? S.inner : 1 - S.inner) * 100} 1 0`; });
  });

  // 레이아웃 편집기가 다른 편집기를 보여 달라고 할 때 (배치가 끝나면 Placement, 배선이 끝나면 Layout)
  app.bus.on("reveal", (id) => {
    if (popped.has(id) || S.visible.includes(id)) return;
    if (S.visible.length === 1 && S.visible[0] !== "circuit") { S.visible = [id]; S.active = id; apply(); }
  });

  const api = {
    app, show, showPair, showAll, popOut, merge, pairMenu, activate,
    /** 스위치가 그릴 것: 편집기마다 { shown, active, popped } */
    view: () => Object.fromEntries(WS.map((w) => [w.id, { shown: S.visible.includes(w.id) && !popped.has(w.id), active: S.active === w.id, popped: popped.has(w.id) }])),
    /** melange 의 단축키 대신 레이아웃 편집기가 키를 받을 때 */
    ownsKeys: () => S.active !== "circuit" && shown().includes(S.active),
    /** 새 창(layout.html)이 부른다 — 그 창의 문서에 편집기를 붙인다 */
    mountPopup: async (id, el, popupWin) => {
      const mount = await MOUNT[id]();
      const ws = mount(el, app, { isActive: () => true, activate: () => {} });
      popupWin.addEventListener("beforeunload", () => ws.destroy?.());
      return ws;
    },
  };
  /** 어시스턴트의 손잡이 (src/ai/tools-layout.ts) */
  api.control = createLayoutControl(app, api);
  win.__melangeLayout = api;
  return api;
}
