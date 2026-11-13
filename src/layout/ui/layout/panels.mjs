/** 레이아웃 편집기의 패널 — 도구 줄, 넷 · 오류 목록(왼쪽), 층(오른쪽 위), 속성(오른쪽), 상태 막대.
 *
 *  전부 편집기 상태(te — track.mjs)를 읽어 HTML 을 내는 함수다. 단추는 data-act 를 달고, 누르면 workspace.mjs 의 act() 가
 *  받는다 — 단추를 더하거나 고치려면 여기와 act() 둘만 보면 된다.
 */
import { esc, fmt, icon } from "../core/dom.mjs";
import { tb, sep } from "../ui/frame.mjs";
import { METALS } from "../../art/rules.mjs";
import { LAYERS, GROUPS, OBJECTS, lname, ltitle, ldir, larrow } from "./layers.mjs";

const dirWord = (l) => (ldir(l) === "v" ? "vertical" : "horizontal");

/** 도구 줄 */
export function toolsHtml({ app, T, frame }) {
  const te = T?.te, busy = !!app.state.busy, ready = !!T?.base();
  const out = [];
  out.push(`<span class="seg">` +
    tb("tool", "Select", { ic: "select", key: "S", title: "Select tracks and vias (Shift adds, drag on empty space for a box). Double-click selects the connected track. Click a pin to highlight its net", pressed: te?.tool === "select", data: { tool: "select" } }) +
    tb("tool", "Track", { ic: "wire", key: "W", title: "Draw a track: press on a pin, a track or a via, click at each bend, and it ends on the same net. Space flips the corner, 1–5 change layer with a via, Backspace undoes a bend, Esc ends", pressed: te?.tool === "track", data: { tool: "track" } }) +
    tb("tool", "Via", { ic: "via", key: "V", title: "Put a via on a pin, track or via — from its layer up or down to the drawing layer", pressed: te?.tool === "via", data: { tool: "via" } }) + `</span>`);
  // 층 — 숫자 키 1 ~ 5. 층마다 한 방향 (↕ ↔): 꺾는 토막은 짝 층(이웃)에 비아로
  out.push(`<span class="seg lays" title="Drawing layer (keys 1–${METALS.length}). Each SKY130 metal runs one way only (↕ vertical, ↔ horizontal), so the leg that turns goes on the neighboring layer through a via — as a track changing layers on a PCB">` +
    METALS.map((l, i) => `<button type="button" class="tb lay-b" data-act="layer" data-layer="${l}" aria-pressed="${te?.layer === l}" title="Draw on ${ltitle(l)} — ${dirWord(l)}; key ${i + 1}">${esc(lname(l))} <span class="ldir">${larrow(l)}</span> <kbd>${i + 1}</kbd></button>`).join("") + `</span>`);
  out.push(sep);
  const a = T?.art();
  out.push(tb("undo", "Undo", { ic: "undo", key: "Ctrl+Z", disabled: !(te?.draw || a?.hist.length), cls: "icon" }));
  out.push(tb("redo", "Redo", { ic: "redo", key: "Ctrl+Y", disabled: !a?.fut.length, cls: "icon" }));
  out.push(tb("del", "Delete", { ic: "trash", key: "Del", title: "Delete the selected tracks and vias", disabled: !te?.sel.size, cls: "icon" }));
  out.push(sep);
  out.push(`<span class="more"><button type="button" class="tb run" data-act="automenu" ${!ready || busy ? "disabled" : ""} title="Optional — let the router (a wasm port of ALIGN's) route for you. Its tracks can be edited like yours">${icon("route", 15)} Auto route ▾</button></span>`);
  out.push(tb("check", "Check", { ic: "check", title: "Run DRC/LVS on the cells and the tracks now (it also runs by itself after each change)", disabled: !ready }));
  out.push(sep);
  out.push(tb("fit", "Fit", { ic: "fit", key: "K", cls: "icon", title: "Fit to view (K or Home)" }));
  out.push(tb("zin", "Zoom in", { ic: "zoomin", key: "+", cls: "icon" }));
  out.push(tb("zout", "Zoom out", { ic: "zoomout", key: "-", cls: "icon" }));
  out.push(sep);
  out.push(tb("downloads", "Download", { ic: "download", cls: "icon", title: "Download the GDS (for KLayout), the DRC/LVS report and the placement" }));
  out.push(`<span class="tfill"></span>${frame.panelButtons()}`);
  return out.join("");
}

/** "자동 배선 ▾" */
export function autoMenuHtml({ T }) {
  const a = T?.art(), has = !!(a?.wires.length || a?.vias.length), done = T ? T.finishedNets() : new Set();
  const it = (act, label, title, off = false) => `<button type="button" class="mi" data-act="${act}"${off ? " disabled" : ""} title="${title}">${label}</button>`;
  return `<div class="mh">Auto route</div>` +
    it("autoall", has ? "Route everything (replaces your tracks)" : "Route everything", "Run the router on the whole layout. Undo brings your tracks back") +
    it("autorest", `Route the unfinished nets${done.size ? ` (keeps ${done.size} you finished)` : ""}`, "Nets you finished stay as they are and the router avoids them; it routes the others (a net you started but did not finish is redone)", !has) +
    `<div class="msep"></div>` +
    it("clear", "Delete every track and via", "Start over by hand — Undo brings them back", !has);
}

/** 왼쪽 — 넷 목록 */
export function netsHtml({ T, filter = "" }) {
  const d = T?.derived();
  if (!d) return `<p class="empty">No placement yet — press Auto place in the Placement editor</p>`;
  const f = filter.trim().toLowerCase(), te = T.te;
  const rows = [...d.an.nets].filter(([n]) => !f || n.toLowerCase().includes(f)).sort((a, b) => (b[1].comps > 1) - (a[1].comps > 1) || a[0].localeCompare(b[0]))
    .map(([n, s]) => {
      const st = s.pins < 2 ? "—" : s.comps > 1 ? `<b class="bad">Open ${s.comps - 1}</b>` : "Connected";
      return `<tr data-net="${esc(n)}" class="${te.net === n ? "on" : ""}"><td class="nm">${esc(n)}</td><td class="n">${s.pins}</td><td>${st}</td></tr>`;
    }).join("");
  return `<table class="list"><thead><tr><th>Net</th><th class="n">Pins</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
}
/** 왼쪽 — 검사기 오류 */
export function errorsHtml({ T }) {
  const c = T?.te.checked;
  if (!c) return `<p class="empty">DRC/LVS appears here — it runs after each change</p>`;
  if (!c.errors.length) return `<p class="good">No DRC/LVS errors</p>`;
  const pending = (i) => c.isPending?.(i) ?? false;
  const item = (e, i) => {
    const k = e.split(" (")[0], mk = T.te.marks[i];
    return `<li data-err="${i}" class="${mk?.rects.length ? "go" : ""}${pending(i) ? " todo" : ""}" title="${esc(e.slice(0, 400))}"><b>${esc(k.slice(0, 60))}</b><br>${esc(e.slice(k.length, k.length + 160))}</li>`;
  };
  const real = [], todo = [];
  c.errors.slice(0, 200).forEach((e, i) => (pending(i) ? todo : real).push(item(e, i)));
  const kinds = new Map();
  c.errors.forEach((e, i) => { if (pending(i)) return; const k = e.split(" (")[0].replace(/ violation.*/, ""); kinds.set(k, (kinds.get(k) ?? 0) + 1); });
  const out = [];
  out.push(real.length ? `<p class="sum">${[...kinds].map(([k, v]) => `${esc(k)} ${v}`).join(" · ")}${c.errors.length > 200 ? " (first 200 only)" : ""}</p><ul class="errs">${real.join("")}</ul>`
                       : `<p class="good">No DRC/LVS errors in what is drawn</p>`);
  // 아직 안 이은 넷 — 오류가 아니라 할 일 (래츠네스트의 가는 선). 다 그리거나 Auto route 를 하면 사라진다
  if (todo.length) out.push(`<p class="sum">Not connected yet · ${c.pending} net${c.pending === 1 ? "" : "s"} — follow the thin lines (ratsnest), or Auto route</p><ul class="errs todo">${todo.join("")}</ul>`);
  return out.join("");
}

/** 오른쪽 위 — 층: 보이기, 색, 그리기 층 */
export function layersHtml({ vis, T, fold = [] }) {
  const te = T?.te;
  const row = (key, label, color, opts = {}) => {
    const on = vis.has(key);
    return `<div class="lrow${opts.active ? " act" : ""}" data-layer="${key}">` +
      `<button type="button" class="eye" data-act="vis" data-key="${key}" aria-pressed="${on}" title="${on ? "Hide" : "Show"}">${icon(on ? "eye" : "eyeoff", 14)}</button>` +
      (color ? `<i class="sw" style="background:${color}"></i>` : `<i class="sw obj"></i>`) +
      (opts.drawable ? `<button type="button" class="lname" data-act="layer" data-layer="${key}" title="Draw on this layer">${label}${opts.dir ? ` <span class="ldir">${opts.dir}</span>` : ""}</button>` : `<span class="lname">${label}</span>`) +
      (opts.active ? `<span class="tag">drawing</span>` : opts.other ? `<span class="tag">turns</span>` : "") + `</div>`;
  };
  const out = [];
  for (const [g, label] of GROUPS) {
    const keys = g === "object" ? OBJECTS.map((o) => o.key) : LAYERS.filter((l) => l.group === g).map((l) => l.key);
    const all = keys.every((k) => vis.has(k)), some = keys.some((k) => vis.has(k));
    const shut = fold.includes(g);
    out.push(`<div class="lgroup"><button type="button" class="eye" data-act="visgroup" data-group="${g}" aria-pressed="${all}" title="${all ? "Hide" : "Show"} the whole group">${icon(some ? "eye" : "eyeoff", 14)}</button>` +
             `<button type="button" class="lg" data-act="fold" data-group="${g}" aria-expanded="${!shut}" title="${shut ? "Expand" : "Collapse"}"><span class="chev${shut ? " shut" : ""}"></span>${label}</button></div>`);
    if (shut) continue;
    if (g === "object") for (const o of OBJECTS) out.push(row(o.key, o.label, null));
    else for (const l of LAYERS.filter((q) => q.group === g)) out.push(row(l.key, lname(l.key), l.color, { drawable: METALS.includes(l.key), active: te?.layer === l.key, other: te?.other === l.key, dir: larrow(l.key) }));
  }
  return out.join("");
}

/** 오른쪽 — 속성: 그리는 중 / 고른 것 / 넷 / 요약 */
export function propsHtml({ app, T }) {
  const row = (lab, body) => `<div class="prow"><span class="pl">${lab}</span><span class="pv">${body}</span></div>`;
  const btn = (act, label, title = "", off = false, cls = "", attrs = "") => `<button type="button" class="pb ${cls}" data-act="${act}"${off ? " disabled" : ""} title="${title}" ${attrs}>${label}</button>`;
  if (!app.state.ours) return `<p class="empty">Placement comes first — press Auto place in the Placement editor. Then draw the tracks here, by hand or with Auto route.</p>`;
  const d = T?.derived();
  if (!d) return `<p class="empty">${esc(T?.te.msg || "Preparing the cells…")}</p>`;
  const te = T.te, a = T.art(), out = [];
  if (te.draw) {
    const D = te.draw, pv = te.preview;
    out.push(`<h4>Track — ${esc(D.net)}</h4>`);
    out.push(row("Layer", `${esc(lname(D.cur))} ${larrow(D.cur)} · turns on ${esc(lname(D.other ?? ""))} ${larrow(D.other ?? "")}`));
    out.push(row("Bends", String(D.groups.length)));
    if (pv?.judge.shorts.length) out.push(row("Next", `<b class="bad">Would short ${esc(pv.judge.shorts[0].net)}</b>`));
    else if (pv?.judge.warns.length) out.push(row("Next", `<b class="warn">Close to ${esc(pv.judge.warns[0].net)} (${esc(pv.judge.warns[0].what)})</b>`));
    else if (pv?.plan.joined) out.push(row("Next", "Connects — click to finish"));
    out.push(`<div class="pbtns">${btn("finish", "Finish <kbd>Enter</kbd>", "Keep what is drawn (also Esc, double-click, right-click)", false, "run")}${btn("back", "Undo bend <kbd>⌫</kbd>")}${btn("flip", "Flip corner <kbd>Space</kbd>")}</div>`);
    out.push(`<p class="hint">Click to fix the bend and keep going. Reaching a pin, track or via of ${esc(D.net)} finishes the track. Keys 1–${METALS.length} put a via here and continue on that layer.</p>`);
    return out.join("");
  }
  if (te.sel.size) {
    const picked = [...a.wires, ...a.vias].filter((o) => te.sel.has(o.id));
    const nets = [...new Set(picked.map((o) => o.net))];
    const wires = picked.filter((o) => "x0" in o), vias = picked.filter((o) => !("x0" in o));
    out.push(`<h4>${picked.length === 1 ? (wires.length ? "Track" : "Via") : `${picked.length} pieces`}</h4>`);
    out.push(row("Net", nets.map(esc).join(" ")));
    const nudge = (vert) => vert
      ? `${btn("nudge", "←", "One track left (←)", false, "", 'data-dx="-1"')}${btn("nudge", "→", "One track right (→)", false, "", 'data-dx="1"')}`
      : `${btn("nudge", "↓", "One track down (↓)", false, "", 'data-dy="-1"')}${btn("nudge", "↑", "One track up (↑)", false, "", 'data-dy="1"')}`;
    if (picked.length === 1 && wires.length) {
      const w = wires[0], vert = w.x0 === w.x1 && w.y0 !== w.y1;
      const others = T.layersForSel();
      out.push(row("Layer", `${esc(lname(w.layer))} ${larrow(w.layer)}`));
      if (others.length) out.push(row("Move to", others.map((L) => btn("relayer", `${esc(lname(L))} ${larrow(L)}`, `Move this track to ${lname(L)} — the vias where it meets other layers are rebuilt`, false, "chip", `data-layer="${L}"`)).join(" ")));
      out.push(row("Track", `${vert ? "x" : "y"} = ${fmt(vert ? w.x0 : w.y0)} nm ${nudge(vert)}`),
               row("Length", `${fmt(Math.abs(w.x1 - w.x0) + Math.abs(w.y1 - w.y0))} nm`),
               row("From", `${fmt(w.x0)}, ${fmt(w.y0)}`), row("To", `${fmt(w.x1)}, ${fmt(w.y1)}`));
    } else if (picked.length === 1) {
      const v = vias[0];
      out.push(row("Via", `${esc(lname(v.layer))}`), row("At", `${fmt(v.x)}, ${fmt(v.y)} nm`),
               row("Move", `${nudge(true)} ${nudge(false)}`));
    } else out.push(row("Tracks · vias", `${wires.length} · ${vias.length}`));
    out.push(`<div class="pbtns">${btn("del", "Delete <kbd>Del</kbd>")}${btn("clearsel", "Clear selection <kbd>Esc</kbd>")}</div>`);
    out.push(`<p class="hint">Drag a track to move it to another track — the tracks it meets stretch to stay connected, and where it is held (a pin, a via stack) a short jog keeps it connected. Drag a via to move the corner; drag a free end to lengthen it. Arrow keys move one track.</p>`);
    return out.join("");
  }
  if (te.net && d.an.nets.has(te.net)) {
    const s = d.an.nets.get(te.net), mine = [...a.wires, ...a.vias].filter((o) => o.net === te.net);
    out.push(`<h4>Net ${esc(te.net)}</h4>`);
    out.push(row("Pins", String(s.pins)), row("Tracks · vias", `${mine.filter((o) => "x0" in o).length} · ${mine.filter((o) => !("x0" in o)).length}`));
    out.push(row("Connection", s.pins < 2 ? "One pin" : s.comps > 1 ? `<b class="bad">Open ${s.comps - 1}</b> — follow the ratsnest` : "Connected"));
    out.push(`<p class="hint">Press W and start on one of its pins to draw. The thin lines are the ratsnest: what is still to connect.</p>`);
    return out.join("");
  }
  const st = T.stats();
  out.push(`<h4>Layout</h4>`);
  out.push(row("Tracks · vias", `${st.wires} · ${st.vias}`));
  out.push(row("Nets", `${d.an.nets.size} · open ${st.open.length ? `<b class="bad">${st.open.length}</b>` : 0}`));
  out.push(row("DRC/LVS", te.checked ? (te.checked.real ? `<b class="bad">${te.checked.real}</b>` : `<b class="good">0</b>`) +
    (te.checked.pending ? ` <small>· ${te.checked.pending} not connected yet</small>` : "") : "…"));
  if (st.open.length) out.push(row("Open", st.open.slice(0, 30).map((q) => `<button type="button" class="chip" data-act="pick" data-net="${esc(q)}">${esc(q)}</button>`).join(" ")));
  out.push(`<p class="hint">Draw from scratch: press <kbd>W</kbd>, start on a pin and click at each bend — the thin lines (ratsnest) show what to connect. Each metal runs one way (↕ ↔), so a turn goes on the neighboring layer through a via. Auto route is optional, and its tracks can be edited like yours.</p>`);
  return out.join("");
}

/** 상태 막대 */
export function statusHtml({ T, cursor, view, hint }) {
  const te = T?.te, st = T?.stats();
  const parts = [
    `<span class="xy">${cursor ? `X <b>${fmt(cursor.x)}</b> Y <b>${fmt(cursor.y)}</b>` : "X — Y —"} <small>nm</small></span>`,
    te ? `<span>Layer <b>${lname(te.draw?.cur ?? te.layer)}</b> ${larrow(te.draw?.cur ?? te.layer)} <small>turns on ${lname(te.draw?.other ?? te.other ?? "")}</small></span>` : "",
    `<span>${view.s.toFixed(view.s < 10 ? 2 : 1)}×</span>`,
    // 아직 안 이은 넷은 할 일이다 — 붉게 칠하지 않는다 (다 이으면 초록)
    st ? `<span title="Nets not connected yet — the thin lines show them">Open <b class="${st.open.length ? "" : "good"}">${st.open.length}</b></span>` : "",
    te?.checked ? `<span class="${te.checked.real ? "bad" : "good"}">DRC/LVS ${te.checked.real ?? te.checked.errors.length}</span>` : "",
    `<span class="hint" id="lyHint">${esc(hint ?? "")}</span>`,
  ];
  return parts.filter(Boolean).join("");
}
