/** 레이아웃 편집기 (그리기) — PCB 편집기의 트랙 그리기를 IC 금속에 맞춘 것. 화면(DOM)은 모른다.
 *
 *  배치만 있으면 바로 그린다 — 자동 배선은 고를 수 있는 단추일 뿐이다. 셀의 핀(바탕, art/base.mjs) 위에 토막과 비아(그린 것,
 *  art/doc.mjs)를 긋고, 그때마다 넷의 덩이 · 래츠네스트 · 단락을 다시 세고(art/connect.mjs), 조금 뒤에 검사기로 DRC/LVS 를
 *  본다(art/check.mjs).
 *
 *    고르기   그린 토막 · 비아를 누르면 고른다 (Shift 로 여럿, 빈 곳을 끌면 상자로). 두 번 누르면 이어진 트랙 전부.
 *             Delete 로 지운다. 핀을 누르면 그 넷을 밝힌다
 *    트랙     핀 · 토막 · 비아에서 누르면 시작 — 커서를 따라 L 자 (지금 층의 방향으로 한 토막, 짝 층으로 꺾는 토막, 꺾는 점에 비아).
 *             누르면 꺾는 자리가 정해지고 이어서 긋는다. 같은 넷의 도형에 닿으면 끝난다. Space 는 L 을 뒤집고, 1 ~ 5 는 그 자리에
 *             비아를 쌓고 층을 바꾼다, Backspace 는 마지막 꺾점을 무른다, Esc · Enter · 오른쪽 클릭 · 두 번 누르기로 끝낸다
 *    비아     도형을 누르면 그 자리에 비아 — 도형의 층에서 지금 층까지 (같으면 짝 층까지)
 *    고치기   고르기 도구로 그린 토막을 끌면 그 곧은 줄이 옆 트랙으로 옮겨 가고 붙은 이웃 줄이 늘고 준다. 비아(꺾는 점)를 끌면 두 줄이
 *             같이, 빈 끝을 끌면 그 끝이 늘고 준다. 화살표는 한 트랙씩, 층 바꾸기는 비아를 다시 쌓는다 (art/edit.mjs)
 *
 *  다른 넷의 금속에 닿는 토막은 긋지 않는다 (단락). 끝단 · 비아 간격이 모자라면 주황으로 알리고 긋는다 — 검사기가 오류로 센다.
 */
import { composeBase } from "../../art/base.mjs";
import { analyze } from "../../art/connect.mjs";
import { createArt, apply, undo as undoArt, redo as redoArt, shapesOf, clearAll } from "../../art/doc.mjs";
import { checkArt, errorRects } from "../../art/check.mjs";
import { startOn, planL, judge, shapesOfPlan, partner, climb } from "../../art/draw.mjs";
import { METALS, metal, via, touch } from "../../art/rules.mjs";
import { shapesToArt } from "../../art/import.mjs";
import { runOf, dragRun, dragVia, stretchEnd, endInfo, nudge, changeLayerOf, sameDirectionLayers, acrossOf, alongOf } from "../../art/edit.mjs";
import { routePlacement } from "../services/routing.mjs";
import { lname } from "./layers.mjs";

const CELL = 4000;

/** 층마다 칸으로 나눈 사각형 찾기 */
function makeIndex(list) {
  const g = new Map();
  list.forEach((s, i) => {
    for (let cx = Math.floor(s.rect[0] / CELL); cx <= Math.floor(s.rect[2] / CELL); cx++)
      for (let cy = Math.floor(s.rect[1] / CELL); cy <= Math.floor(s.rect[3] / CELL); cy++) {
        const k = `${s.layer}|${cx}|${cy}`;
        (g.get(k) ?? g.set(k, []).get(k)).push(i);
      }
  });
  return (layer, box) => {
    const out = new Set();
    for (let cx = Math.floor(box[0] / CELL); cx <= Math.floor(box[2] / CELL); cx++)
      for (let cy = Math.floor(box[1] / CELL); cy <= Math.floor(box[3] / CELL); cy++)
        for (const i of g.get(`${layer}|${cx}|${cy}`) ?? []) out.add(i);
    return [...out].map((i) => list[i]).filter((s) => touch(s.rect, box));
  };
}

const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);

export function createTrackEditor(ctx) {
  const te = {
    tool: "select",                     // select | track | via
    layer: "M3", other: "M4",           // 그리기 층과 짝 층 (꺾는 토막이 가는 층)
    firstA: true,                       // L 의 첫 토막이 지금 층 (Space 로 바꾼다)
    draw: null,                         // 그리는 중 { net, cur, other, at, groups: [{wires, vias}], start }
    preview: null,                      // 다음 L { plan, judge }
    hover: null, cursor: null,          // 커서 아래 도형, 커서 (nm)
    sel: new Set(),                     // 고른 토막 · 비아 id
    net: null,                          // 밝힌 넷
    checked: null, marks: [], checking: false,
    drag: null,                         // 고치는 중 { kind: "run"|"via"|"end", id, which?, p0, moved } (고르기 도구로 끌기)
    edit: null,                         // 고친 결과 미리 보기 { e: {add, del, ...}, judge }
    press: null,                        // 그리는 중 누른 자리 (누른 채 끌어 떼면 거기까지 긋는다)
    flash: null,                        // 커서 옆에 잠깐 보이는 말 { text, until }
    msg: "",
  };
  const S = () => ctx.app.state;

  // ---------------------------------------------------------------- 바탕 · 그린 것 · 셈 (판이 바뀔 때만 다시)
  let baseKey = null, baseVal = null;
  function base() {
    const st = S();
    if (!st.blob || !st.ours) return null;
    if (baseKey?.blob === st.blob && baseKey?.ours === st.ours) return baseVal;
    try { baseVal = composeBase(st.blob, routePlacement(st.ours)); }
    catch (err) { console.error("[layout] cells", err); baseVal = null; te.msg = `Could not place the cells: ${err.message}`; }
    baseKey = { blob: st.blob, ours: st.ours };
    // 바탕의 층별 묶음 (그리기의 MinL 셈)
    if (baseVal) {
      baseVal.byLayer = new Map();
      for (const s of baseVal.shapes) if (s.netName != null) (baseVal.byLayer.get(s.layer) ?? baseVal.byLayer.set(s.layer, []).get(s.layer)).push(s);
    }
    return baseVal;
  }
  function art() { return (S().art ??= createArt()); }
  let anKey = null, anVal = null, idxVal = null;
  function derived() {
    const b = base(), a = art();
    if (!b) return null;
    if (anKey?.b === b && anKey?.ver === a.ver) return { an: anVal, index: idxVal };
    const drawn = shapesOf(a, b);
    anVal = analyze(b, drawn);
    anVal.drawn = drawn;
    const named = b.shapes.filter((s) => s.netName != null && (metal(s.layer) || via(s.layer)));
    idxVal = makeIndex([...named.map((s) => ({ ...s, from: "base" })), ...drawn.map((s) => ({ ...s, from: "art" }))]);
    anKey = { b, ver: a.ver };
    return { an: anVal, index: idxVal };
  }

  // ---------------------------------------------------------------- 찾기
  /** 커서 아래의 넷 도형 — 그린 것이 먼저, 지금 층이 먼저, 작은 것이 먼저. pins: 셀의 핀도 */
  function hitAt(p, tol, { pins = true, artOnly = false } = {}) {
    const d = derived();
    if (!d) return null;
    const box = [p.x - tol, p.y - tol, p.x + tol, p.y + tol];
    const cand = [];
    for (const L of [...METALS, "V1", "V2", "V3", "V4"]) {
      for (const s of d.index(L, box)) {
        if (s.from === "base" && (artOnly || !pins || s.netType !== "pin")) continue;
        cand.push(s);
      }
    }
    if (!cand.length) return null;
    // 커서가 안에 든 것이 먼저, 아니면 가까운 것 — 허용 거리가 넓어도 옆의 엉뚱한 것을 집지 않게. 그다음 그린 것 · 지금 층 · 작은 것
    const gap = (r) => Math.hypot(Math.max(r[0] - p.x, 0, p.x - r[2]), Math.max(r[1] - p.y, 0, p.y - r[3]));
    const rank = (s) => { const d = gap(s.rect); return [d > 0 ? 1 : 0, d, s.from === "art" ? 0 : 1, s.layer === te.layer ? 0 : via(s.layer) ? 1 : 2, area(s.rect)]; };
    cand.sort((a, b) => { const ra = rank(a), rb = rank(b); for (let k = 0; k < ra.length; k++) if (ra[k] !== rb[k]) return ra[k] - rb[k]; return 0; });
    const s = cand[0];
    // 비아의 컷을 누르면 그 비아의 지금 층 쪽 금속으로 (거기서 그을 수 있게)
    if (via(s.layer) && s.from === "art") {
      const pad = d.an.drawn.find((q) => q.id === s.id && q.layer === te.layer) ?? d.an.drawn.find((q) => q.id === s.id && q.role !== "cut");
      return pad ? { ...pad, from: "art" } : s;
    }
    return s;
  }

  // ---------------------------------------------------------------- 상태 줄 · 알림
  const say = (t) => { te.msg = t; ctx.hint(t); };
  const changed = () => { ctx.changed(); };
  const redraw = () => ctx.redraw();
  /** 안 되는 것은 커서 옆에도 잠깐 — 상태 줄의 말만으로는 놓치기 쉽다 (누른 자리가 핀이 아니었다, 단락이라 못 옮긴다 …) */
  let flashT = 0;
  const flash = (t) => {
    say(t);
    te.flash = { text: t, until: performance.now() + 2600 };
    clearTimeout(flashT);
    flashT = setTimeout(() => { te.flash = null; redraw(); }, 2700);
    redraw();
  };

  let checkT = 0;
  function checkSoon(delay = 250) {
    clearTimeout(checkT);
    checkT = setTimeout(checkNow, delay);
  }
  function checkNow() {
    const b = base(), d = derived();
    if (!b || !d) { te.checked = null; te.marks = []; changed(); return; }
    const t0 = performance.now();
    try {
      te.checked = { ...checkArt(b, d.an.drawn), ver: art().ver, ms: performance.now() - t0 };
      te.marks = te.checked.errors.map((text) => ({ text, rects: errorRects(text) }));
      // 아직 안 이은 넷(래츠네스트가 보이는 넷)의 OPEN 은 '할 일'이지 잘못이 아니다 — 따로 센다. 이었다고 보는 넷의 OPEN 은 오류다
      const openNets = new Set([...d.an.nets].filter(([, q]) => q.comps > 1).map(([n]) => n));
      const pendingOf = (e) => { const m = /^OPEN \('([^']+)'/.exec(e); return !!m && openNets.has(m[1]); };
      te.checked.pending = te.checked.errors.filter(pendingOf).length;
      te.checked.real = te.checked.errors.length - te.checked.pending;
      te.checked.isPending = (i) => pendingOf(te.checked.errors[i]);
    } catch (err) {
      console.error("[layout] check", err);
      te.checked = { errors: [`The checker stopped: ${err.message}`], notes: [], ver: art().ver, pending: 0, real: 1, isPending: () => false };
      te.marks = [];
    }
    changed();
  }

  // ---------------------------------------------------------------- 그리기
  function setLayer(L) {
    if (!metal(L)) return;
    if (te.draw) { switchLayer(L); return; }
    te.layer = L; te.other = partner(L);
    say(`Drawing on ${lname(L)}, turning on ${te.other ? lname(te.other) : "—"}.`);
    changed();
  }
  function setTool(t) {
    if (te.draw && t !== "track") finish();
    te.tool = t; te.preview = null;
    changed();
  }
  function begin(p, tol) {
    const h = hitAt(p, tol);
    if (!h) { flash("Start on a pin, a track or a via of the net — the dots and thin lines show what to connect."); return false; }
    const s = startOn(h, p, te.layer, te.other);
    if (s.error) { flash(s.error); return false; }
    const d = derived();
    const j = judge(s.pre, d.index);
    if (j.shorts.length) { flash(`Can't start here — the via would short ${j.shorts[0].net}.`); return false; }
    te.draw = { net: s.net, cur: te.layer, other: te.other, at: s.at, groups: s.pre.wires.length || s.pre.vias.length ? [s.pre] : [],
                lit: te.net };                                   // 그리기 전에 밝혀 둔 넷 (끝나면 그것으로 돌아간다)
    te.net = s.net;
    say(`Net ${s.net} — click to bend, reach the same net to finish. Space flips the corner, 1–5 changes layer, Backspace undoes a bend, Esc ends.`);
    plan(p, tol);
    changed();
    return true;
  }
  /** 다음 L 을 계산한다 (미리 보기) */
  function plan(p, tol) {
    const D = te.draw;
    if (!D) return;
    const h = hitAt(p, tol);
    const target = h && h.netName === D.net ? h : null;
    const pl = planL(D.net, D.at, D.cur, D.other, p, { firstA: te.firstA, target });
    const d = derived();
    // 지금 그리는 것도 장애물이 아니다 (같은 넷)
    te.preview = { plan: pl, judge: judge(pl, d.index), target, other: h && h.netName !== D.net ? h : null };
    redraw();
  }
  function commitPlan() {
    const D = te.draw, pv = te.preview;
    if (!D || !pv) return false;
    if (pv.judge.shorts.length) { flash(`That would short ${pv.judge.shorts[0].net} on ${lname(pv.judge.shorts[0].layer)} — go around it or change layer.`); return false; }
    const pl = pv.plan;
    if (!pl.wires.length && !pl.vias.length && !pl.joined) return false;
    D.groups.push({ wires: pl.wires, vias: pl.vias, from: { at: D.at, cur: D.cur, other: D.other } });
    if (pl.joined) { finish(); say(`Net ${D.net} connected.`); return true; }
    if (pl.layer !== D.cur) { D.other = D.cur; D.cur = pl.layer; }
    D.at = pl.end;
    if (pv.judge.warns.length) say(`Too close to ${pv.judge.warns[0].net} (${pv.judge.warns[0].what}) — the checker will flag it.`);
    te.preview = null;
    changed();
    return true;
  }
  /** 그리는 중에 층 바꾸기 — 그 자리에 비아를 쌓는다 (트랙이 안 지나면 가장 가까운 트랙까지 짧게) */
  function switchLayer(L) {
    const D = te.draw;
    if (!D || L === D.cur) return;
    const c = climb(D.net, D.at, D.cur, L, te.cursor ?? D.at);
    const g = { wires: c.wires, vias: c.vias.filter(Boolean) };
    const j = judge(g, derived().index);
    if (j.shorts.length) { flash(`Can't change to ${lname(L)} here — it would short ${j.shorts[0].net}.`); return; }
    D.groups.push({ ...g, from: { at: D.at, cur: D.cur, other: D.other } });
    D.at = c.at; D.cur = L; D.other = partner(L);
    te.layer = L; te.other = D.other;
    say(`Now on ${lname(L)}, turning on ${lname(D.other)}.`);
    te.preview = null;
    changed();
  }
  function back() {
    const D = te.draw;
    if (!D) return false;
    const g = D.groups.pop();
    if (!g) { cancel(); return true; }
    if (g.from) { D.at = g.from.at; D.cur = g.from.cur; D.other = g.from.other; }
    else cancel();
    te.preview = null;
    changed();
    return true;
  }
  function finish() {
    const D = te.draw;
    if (!D) return;
    te.draw = null; te.preview = null; te.net = D.lit ?? null;
    const wires = D.groups.flatMap((g) => g.wires), vias = D.groups.flatMap((g) => g.vias);
    if (wires.length || vias.length) { apply(art(), { add: { wires, vias } }, `track ${D.net}`); checkSoon(); }
    changed();
  }
  function cancel() { te.net = te.draw?.lit ?? null; te.draw = null; te.preview = null; say("Track cancelled."); changed(); }
  function flip() { te.firstA = !te.firstA; if (te.draw && te.cursor) plan(te.cursor, 0); }

  function placeVia(p, tol) {
    const h = hitAt(p, tol);
    if (!h) { flash("Click a pin, a track or a via to put a via on it."); return; }
    const to = h.layer === te.layer ? te.other : te.layer;
    if (!to) return;
    const s = startOn(h, p, to, te.layer);
    if (s.error) { flash(s.error); return; }
    const j = judge(s.pre, derived().index);
    if (j.shorts.length) { flash(`A via here would short ${j.shorts[0].net}.`); return; }
    if (!s.pre.vias.length) return;
    apply(art(), { add: s.pre }, `via ${s.net}`);
    say(`Via on ${s.net} from ${lname(h.layer)} to ${lname(to)}.`);
    checkSoon(); changed();
  }

  // ---------------------------------------------------------------- 고르기
  function pick(p, tol, add = false) {
    const h = hitAt(p, tol, { artOnly: false });
    if (h?.from === "art") {
      if (!add) te.sel.clear();
      if (te.sel.has(h.id) && add) te.sel.delete(h.id); else te.sel.add(h.id);
      te.net = h.netName;
    } else if (h) { if (!add) te.sel.clear(); te.net = h.netName; }
    else { te.sel.clear(); te.net = null; }
    ctx.selected("net", te.net);
    changed();
  }
  function pickConnected(p, tol) {
    const h = hitAt(p, tol);
    if (!h?.netName) return;
    const d = derived(), an = d.an;
    const i = an.shapes.findIndex((s) => s.from === "art" && s.id === h.id) ;
    const root = i >= 0 ? an.find(i) : null;
    te.sel.clear();
    an.shapes.forEach((s, k) => { if (s.from === "art" && s.netName === h.netName && (root == null || an.find(k) === root)) te.sel.add(s.id); });
    te.net = h.netName;
    changed();
  }
  function selectBox(r, add = false) {
    if (!add) te.sel.clear();
    for (const s of derived()?.an.drawn ?? []) if (s.rect[0] >= r[0] && s.rect[1] >= r[1] && s.rect[2] <= r[2] && s.rect[3] <= r[3]) te.sel.add(s.id);
    changed();
  }
  function del() {
    if (!te.sel.size) return false;
    const n = te.sel.size;
    apply(art(), { del: [...te.sel] }, "delete");
    te.sel.clear();
    say(`Deleted ${n} piece${n === 1 ? "" : "s"}.`);
    checkSoon(); changed();
    return true;
  }
  function selectNet(net) { te.net = net; te.sel.clear(); ctx.selected("net", net); changed(); }
  function clearSelection() { te.sel.clear(); te.net = null; ctx.selected("net", null); changed(); }

  // ---------------------------------------------------------------- 고치기 (PCB 편집기처럼 — art/edit.mjs)
  /** 누른 자리에서 끌 것 — 비아(꺾는 점), 토막의 빈 끝, 토막(그 곧은 줄) */
  function editTarget(p, tol) {
    const d = derived();
    if (!d) return null;
    const a = art(), box = [p.x - tol, p.y - tol, p.x + tol, p.y + tol];
    const gap = (r) => Math.hypot(Math.max(r[0] - p.x, 0, p.x - r[2]), Math.max(r[1] - p.y, 0, p.y - r[3]));
    // 가장 가까운 그린 것 (커서가 안에 든 것이 먼저) — 비아와 토막이 같으면 비아 (꺾는 점을 끈다)
    const hits = d.an.drawn.filter((s) => touch(s.rect, box)).map((s) => ({ s, d: gap(s.rect), isVia: s.role !== "wire" }))
      .sort((x, y) => x.d - y.d || (y.isVia ? 1 : 0) - (x.isVia ? 1 : 0));
    const best = hits[0];
    if (!best) return null;
    if (best.isVia) { const v = a.vias.find((q) => q.id === best.s.id); if (v) return { kind: "via", id: v.id }; }
    const w = a.wires.find((q) => q.id === best.s.id) ?? a.wires.find((q) => hits.some((h) => h.s.id === q.id));
    if (!w) return null;
    const al = alongOf(w.layer), ends = al === "y" ? [w.y0, w.y1] : [w.x0, w.x1];
    const reach = Math.max(2 * tol, metal(w.layer).width);
    for (const which of [0, 1]) {
      if (Math.abs(p[al] - ends[which]) > reach) continue;
      const info = endInfo(a, d.index, w, which);
      if (info.via) return { kind: "via", id: info.via.id };
      if (info.free) return { kind: "end", id: w.id, which };
    }
    return { kind: "run", id: w.id };
  }
  /** 커서 모양 — 끌 수 있는 것 위에서 그 방향을 보인다 */
  function cursorAt(p, tol) {
    if (te.tool !== "select" || te.draw) return "";
    if (te.drag) return te.drag.kind === "via" ? "move" : te.drag.cursor ?? "";
    const t = editTarget(p, tol);
    if (!t) return "";
    if (t.kind === "via") return "move";
    const w = art().wires.find((q) => q.id === t.id), v = metal(w.layer).dir === "v";
    return t.kind === "end" ? (v ? "ns-resize" : "ew-resize") : (v ? "ew-resize" : "ns-resize");
  }
  function previewDrag(p) {
    const D = te.drag, d = derived(), a = art();
    let e = null;
    if (D.kind === "run") {
      const run = runOf(a, D.id);
      if (run) { const ax = acrossOf(run.layer); e = dragRun(a, d.index, run, run.c + (p[ax] - D.p0[ax])); }
    } else if (D.kind === "via") {
      const v = a.vias.find((q) => q.id === D.id);
      if (v) e = dragVia(a, d.index, D.id, { x: v.x + (p.x - D.p0.x), y: v.y + (p.y - D.p0.y) });
    } else {
      const w = a.wires.find((q) => q.id === D.id);
      if (w) e = stretchEnd(a, d.index, D.id, D.which, p[alongOf(w.layer)]);
    }
    te.edit = e ? { e, judge: judge(e.add, d.index) } : null;
    redraw();
  }
  /** 고친 것을 한 칸으로 — 단락이면 고치지 않는다. verb: "move" | "stretch", to: 층을 바꿨으면 그 층 */
  function commitEdit(ed, verb, to = "") {
    if (!ed?.e) return false;
    if (ed.judge.shorts.length) { flash(`Can't move it there — it would short ${ed.judge.shorts[0].net} on ${lname(ed.judge.shorts[0].layer)}.`); return false; }
    const e = ed.e;
    const net = [...e.add.wires, ...e.add.vias][0]?.net ?? "";
    const what = `${net}${to ? ` to ${lname(to)}` : ""}`;
    apply(art(), { add: e.add, del: e.del }, `${verb} ${what}`);                 // 되돌리기: "Undid move VSS to met3."
    const parts = [];
    if (e.followed) parts.push(`${e.followed} track${e.followed === 1 ? "" : "s"} followed`);
    if (e.jogs) parts.push(`${e.jogs} jog${e.jogs === 1 ? "" : "s"} added to stay connected`);
    say(`${verb === "move" ? "Moved" : "Stretched"} ${what}${parts.length ? " — " + parts.join(", ") : ""}.` +
        (ed.judge.warns.length ? ` Close to ${ed.judge.warns[0].net} (${ed.judge.warns[0].what}) — the checker will flag it.` : "") +
        (e.left.length ? ` It left a pin of ${e.left[0]} — reconnect it.` : ""));
    checkSoon(); changed();
    return true;
  }
  /** 고른 것을 한 트랙씩 (화살표) */
  function nudgeSel(dx, dy) {
    if (!te.sel.size || te.draw) return false;
    const d = derived(), e = nudge(art(), d.index, [...te.sel], dx, dy);
    if (!e) { flash("Arrow keys move a track across its direction: ↑ ↓ for horizontal layers, ← → for vertical ones."); return true; }
    commitEdit({ e, judge: judge(e.add, d.index) }, "move");
    return true;
  }
  /** 고른 토막들을 같은 방향의 층 L2 로 — 붙은 곳의 비아를 그 층까지 다시 쌓는다 */
  function relayerSel(L2) {
    if (!te.sel.size) return false;
    const d = derived(), e = changeLayerOf(art(), d.index, [...te.sel], L2);
    if (!e) { flash(`Only tracks that run the same way as ${lname(L2)} can move to it.`); return false; }
    return commitEdit({ e, judge: judge(e.add, d.index) }, "move", L2);
  }
  /** 고른 토막 하나가 갈 수 있는 층 (같은 방향) */
  function layersForSel() {
    const w = art().wires.find((q) => te.sel.has(q.id));
    return w ? sameDirectionLayers(w.layer) : [];
  }

  // ---------------------------------------------------------------- 이력 · 자동 배선
  function undo() { if (te.draw) return back(); const l = undoArt(art()); if (l) { te.sel.clear(); say(`Undid ${l}.`); checkSoon(); changed(); } return !!l; }
  function redo() { const l = redoArt(art()); if (l) { say(`Redid ${l}.`); checkSoon(); changed(); } return !!l; }
  function clear() { const r = clearAll(art(), "clear tracks"); if (r) { te.sel.clear(); say("Cleared every track and via (Undo brings them back)."); checkSoon(); changed(); } }
  /** 배선기의 결과를 그린 것으로 — keep 이면 넷 이름이 keep 에 든 지금 것은 두고 나머지만 바꾼다 */
  function importRouted(shapes, keep = new Set()) {
    const conv = shapesToArt(shapes);
    const a = art();
    const del = [...a.wires, ...a.vias].filter((o) => !keep.has(o.net)).map((o) => o.id);
    const add = { wires: conv.wires.filter((w) => !keep.has(w.net)), vias: conv.vias.filter((v) => !keep.has(v.net)) };
    apply(a, { add, del }, keep.size ? "auto route (the rest)" : "auto route");
    checkNow();
  }
  /** 다 이어진 넷 (맨 위 넷만 — 하위 모듈 안의 넷은 배선기가 다시 한다) */
  function finishedNets() {
    const d = derived();
    if (!d) return new Set();
    const mine = new Set([...art().wires, ...art().vias].map((o) => o.net));
    return new Set([...d.an.nets].filter(([n, s]) => s.comps <= 1 && mine.has(n) && !n.includes("/")).map(([n]) => n));
  }

  // ---------------------------------------------------------------- 넷 잇기 (어시스턴트가 쓴다 — 사람이 긋는 것과 같은 L 로)
  const PAIRS = [["M3", "M4"], ["M2", "M3"], ["M4", "M3"], ["M3", "M2"], ["M1", "M2"]];
  /** 래츠네스트 한 줄의 끝에 닿는 그 넷의 도형 (핀 또는 그린 것) */
  function shapeAt(net, pt) {
    const d = derived(), box = [pt[0] - 1, pt[1] - 1, pt[0] + 1, pt[1] + 1];
    for (const L of [...METALS, "V1", "V2", "V3", "V4"]) {
      const s = d.index(L, box).find((q) => q.netName === net && (q.from === "art" ? q.role !== "cut" : q.netType === "pin"));
      if (s) return s;
    }
    return null;
  }
  /** 한 줄을 L 하나로 — 층 짝과 꺾는 쪽을 바꿔 가며 단락도 간격 경고도 없는 것을 긋는다 */
  function connectOne(r) {
    const A = shapeAt(r.net, r.a), B = shapeAt(r.net, r.b);
    if (!A || !B) return false;
    for (const [lay, oth] of PAIRS) for (const firstA of [true, false]) for (const [s0, t0, p0, p1] of [[A, B, r.a, r.b], [B, A, r.b, r.a]]) {
      const s = startOn(s0, { x: p0[0], y: p0[1] }, lay, oth);
      if (s.error) continue;
      const pl = planL(s.net, s.at, lay, oth, { x: p1[0], y: p1[1] }, { firstA, target: t0 });
      if (!pl.joined) continue;
      const all = { wires: [...s.pre.wires, ...pl.wires], vias: [...s.pre.vias, ...pl.vias] };
      const j = judge(all, derived().index);
      if (j.shorts.length || j.warns.length) continue;
      apply(art(), { add: all }, `track ${r.net}`);
      return true;
    }
    return false;
  }
  /** 넷 하나를 래츠네스트를 따라 잇는다 -> { connected, still_open } */
  function autoConnect(net) {
    let made = 0;
    for (let round = 0; round < 6; round++) {
      const rats = derived()?.an.ratsnest.filter((r) => r.net === net) ?? [];
      if (!rats.length) break;
      let moved = false;
      for (const r of rats) if (connectOne(r)) { made++; moved = true; break; }   // 하나 그으면 덩이가 바뀐다 — 다시 센다
      if (!moved) break;
    }
    const left = derived()?.an.nets.get(net)?.comps ?? 1;
    if (made) checkSoon(0);
    changed();
    return { tracks_drawn: made, still_open: Math.max(0, left - 1) };
  }
  /** 넷의 트랙 · 비아를 다 지운다 */
  function deleteNet(net) {
    const ids = [...art().wires, ...art().vias].filter((o) => o.net === net).map((o) => o.id);
    if (!ids.length) return 0;
    apply(art(), { del: ids }, `delete ${net}`);
    te.sel.clear();
    checkSoon(0); changed();
    return ids.length;
  }

  // ---------------------------------------------------------------- 포인터 (워크스페이스가 nm 좌표와 허용 거리로 부른다)
  function down(e, p, tol) {
    te.cursor = p;
    if (te.tool === "track") {
      if (!te.draw) {
        // 그린 트랙 위에서 누르면: 끌면 옮기고(고르기 도구와 같이), 그냥 떼면 거기서 새 트랙을 시작한다
        const h = hitAt(p, tol);
        const t = h?.from === "art" ? editTarget(p, tol) : null;
        if (t) { te.drag = { ...t, p0: p, tol, moved: false, cursor: "", fromTrack: true }; return "grab"; }
        if (!begin(p, tol)) return false;
        te.press = { p0: p, tol };
        return "grab";
      }
      if (te.preview) commitPlan(); else plan(p, tol);
      te.press = { p0: p, tol };
      return "grab";
    }
    if (te.tool === "via") { placeVia(p, tol); return "grab"; }
    const h = hitAt(p, tol);
    if (!h) return "box";
    pick(p, tol, e.shiftKey);
    // 그린 것이면 끌어서 고친다 (Shift 는 여럿 고르기라 끌지 않는다)
    const t = !e.shiftKey && h.from === "art" ? editTarget(p, tol) : null;
    if (t) te.drag = { ...t, p0: p, moved: false, cursor: cursorAt(p, tol) };
    return "grab";
  }
  function move(e, p, tol) {
    te.cursor = p;
    if (te.tool === "track" && te.draw) { plan(p, tol); return; }
    if (te.drag) {
      if (!(e.buttons & 1)) { te.drag = null; te.edit = null; redraw(); }
      else {
        if (!te.drag.moved && Math.hypot(p.x - te.drag.p0.x, p.y - te.drag.p0.y) > tol) te.drag.moved = true;
        if (te.drag.moved) previewDrag(p);
        return;
      }
    }
    const h = hitAt(p, tol);
    const key = h ? `${h.from}|${h.id ?? ""}|${h.layer}|${h.rect.join(",")}` : "";
    if (key !== (te.hover?.key ?? "")) { te.hover = h ? { ...h, key } : null; redraw(); }
    if (te.tool === "track" && h) {
      const s = startOn(h, p, te.layer, te.other);
      te.hover.start = s.error ? null : s;
      redraw();
    }
    ctx.hint(h ? `${h.netName ?? "—"} · ${lname(h.layer)}${h.from === "base" ? " pin" : ""}` : "");
  }
  function up(e, p, tol) {
    // 누른 채 끌어 그렸으면 뗀 자리까지 긋는다 (누르고 · 떼고 · 누르는 식도 그대로 된다)
    const P = te.press;
    te.press = null;
    if (P && te.draw && p && Math.hypot(p.x - P.p0.x, p.y - P.p0.y) > P.tol) { plan(p, tol); commitPlan(); return true; }
    const D = te.drag;
    if (!D) return false;
    if (D.moved && p) previewDrag(p);
    const ed = te.edit;
    te.drag = null; te.edit = null;
    if (D.moved && ed) commitEdit(ed, D.kind === "end" ? "stretch" : "move");
    else if (D.moved) flash(D.kind === "via" ? "That via sits on a pin or a stack — drag one of its tracks instead." : "Nothing to move there — drag across the track, at least half a track.");
    else if (D.fromTrack) begin(D.p0, D.tol);                     // 트랙 도구로 그냥 눌렀다 — 거기서 새 트랙
    changed();
    return true;
  }
  function cancelDrag() { if (!te.drag) return false; te.drag = null; te.edit = null; redraw(); return true; }
  function leave() { te.hover = null; te.cursor = null; if (!te.draw) te.preview = null; redraw(); }

  return {
    te, base, art, derived, checkNow, checkSoon,
    setTool, setLayer, flip, finish, back, cancel, del, undo, redo, clear,
    selectNet, clearSelection, selectBox, pickConnected,
    importRouted, finishedNets, autoConnect, deleteNet,
    down, move, up, leave, cancelDrag, cursorAt,
    nudgeSel, relayerSel, layersForSel,
    commitPlan, plan, begin, switchLayer, placeVia,
    /** 그린 것의 외곽 (없으면 null) — 화면 맞추기가 쓴다 */
    artBox() {
      const a = S().art;
      if (!a || (!a.wires.length && !a.vias.length)) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const w of a.wires) { x0 = Math.min(x0, w.x0, w.x1); y0 = Math.min(y0, w.y0, w.y1); x1 = Math.max(x1, w.x0, w.x1); y1 = Math.max(y1, w.y0, w.y1); }
      for (const v of a.vias) { x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y); }
      return [x0, y0, x1, y1];
    },
    /** 검사가 보는 것 */
    stats() {
      const d = derived();
      if (!d) return null;
      const open = [...d.an.nets].filter(([, s]) => s.comps > 1).map(([n]) => n);
      return { wires: art().wires.length, vias: art().vias.length, open, shorts: d.an.shorts.length,
               errors: te.checked?.errors.length ?? null, drc: te.checked?.real ?? null, checkedVer: te.checked?.ver ?? null, ver: art().ver };
    },
  };
}
