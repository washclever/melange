/** 배치 편집기 — 블록을 고르고, 제약을 따라 끌고, 뒤집고, variant 를 바꾸고, 정리한다. 화면(DOM)은 모른다.
 *
 *  셈은 전부 src/edit/place.mjs 에 있다 (문제 다시 짓기, 끌기 사영, 정리, variant 다시). 여기는 그 셈을 부르는 차례와
 *  이력뿐이다. 진실은 model 의 theta 와 반전(sx, sy)이고, 화면의 rects 는 거기서 다시 낸다.
 *
 *    끌기      제약을 따라 (거울 쌍은 거울로, 축 위 블록은 축을 따라, Align 줄은 같이). 축은 고정, Alt 는 그룹째
 *    정리      편집 좌표의 쌍 관계(위상)를 박고 legalize — 겹침 0, 격자, Order, 압축
 *    위상 유지 최적화   정리 뒤 같은 위상에서 variant 를 전수로 다시 고른다 (워커)
 *    variant 고정  고른 variant 는 고정된다 — 다음 "Placement 실행" 도 그 variant 를 쓴다
 *
 *  ctx (app/editors.mjs 가 준다): app, design(), map() -> {m} (지금 화면 변환), changed(), redraw(), hint(text),
 *  status(html), pushed(kind) (이력 — 새 편집이면 다른 편집기의 다시 실행을 비운다), selected(kind, names) (선택 연동)
 */
import { rebuild, centers, dragTheta, pinRows, dragRows, overlapping, settle, toRects, chooseFlips, flipGroup,
         flipFreedom, variantChoices, withVariant, measure } from "../../edit/place.mjs";
import { esc, short, fmt } from "../core/dom.mjs";

export function createPlacementEditor(ctx) {
  const pl = {
    model: null, base: null, orig: null, kit: null,   // 문제, 편집기를 세운 배치, 배치기가 낸 done(원래대로), 편집 키트
    theta: null, sx: null, sy: null,         // 진실
    live: null,                              // {rects, axes, cx, cy, ax, m} — theta 에서 낸 화면 상태
    sel: new Set(), locked: new Set(), pinned: new Map(),
    hist: [], fut: [], drag: null, hover: null,
    dirty: false, edits: 0, err: null,
    compact: 0.5, both: false, ranking: null, busy: false,
  };
  const state = () => ctx.app.state;
  const mapNow = () => ctx.map();
  const toLayout = (px, py) => { const m = mapNow()?.m; return m ? { x: m.toX(px), y: m.toY(py) } : null; };
  const done = () => { ctx.changed(); };

  // ---------------------------------------------------------------- 모델과 화면 상태
  function refreshLive() {
    const { model, theta, sx, sy } = pl;
    if (!model) { pl.live = null; return; }
    const { cx, cy, ax } = centers(model, theta);
    const P = model.P;
    const rects = P.names.map((nm, i) => ({
      name: nm, concrete: P.concrete[i], x: cx[i] - P.w[i] / 2, y: cy[i] - P.h[i] / 2, w: P.w[i], h: P.h[i], sx: sx[i], sy: sy[i],
    }));
    const m = measure(model, cx, cy, sx, sy);
    const ov = overlapping(model, cx, cy);
    const axesNow = [];
    for (const [nm, r] of model.roles) {
      if (axesNow[r.k]) continue;
      axesNow[r.k] = { vert: r.vert, at: ax[r.k], k: r.k, name: nm };
    }
    pl.live = { rects, cx, cy, ax, m, overlap: ov, axes: axesNow.filter(Boolean),
                orderBad: new Set(m.orderBad.flatMap((s) => s.split(" -> "))) };
  }

  /** 지금 그릴 배치 — theta 에서 낸 rects (bbox 는 정리된 것 그대로: 끄는 동안 틀이 안 뛰게). 편집기가 없으면 null */
  function liveData() {
    const ours = state().ours;
    if (!pl.live || !pl.base || !ours) return null;
    return { ...ours, rects: pl.live.rects, axes: pl.live.axes.map((a) => ({ vert: a.vert, at: a.at })) };
  }

  function snapshot() {
    return { rects: pl.live.rects.map((r) => ({ ...r })), locked: new Set(pl.locked), pinned: new Map(pl.pinned),
             ours: state().ours, edits: pl.edits };
  }
  function restore(s) {
    pl.model = rebuild(ctx.design(), pl.kit, s.rects);
    pl.theta = pl.model.theta; pl.sx = pl.model.sx; pl.sy = pl.model.sy;
    pl.locked = new Set(s.locked); pl.pinned = new Map(s.pinned); pl.edits = s.edits;
    if (s.ours !== state().ours) ctx.app.setOurs(s.ours);
    // 정리 전 상태였나 — 좌표나 variant 가 굳힌 배치와 다르면
    const by = new Map(s.ours.rects.map((r) => [r.name, r]));
    pl.dirty = s.rects.some((r) => { const o = by.get(r.name); return !o || o.concrete !== r.concrete || Math.abs(r.x - o.x) > 1e-6 || Math.abs(r.y - o.y) > 1e-6; });
    refreshLive();
  }
  const pushHistory = () => { pl.hist.push(snapshot()); if (pl.hist.length > 60) pl.hist.shift(); pl.fut = []; ctx.pushed("pl"); };
  function undo() { if (!pl.hist.length || !pl.model) return; pl.fut.push(snapshot()); restore(pl.hist.pop()); afterEdit(); }
  function redo() { if (!pl.fut.length || !pl.model) return; pl.hist.push(snapshot()); restore(pl.fut.pop()); afterEdit(); }

  /** 배치 하나로 편집기를 다시 세운다 (워커의 done 이거나 원래 배치로 되돌릴 때). 고정한 variant 는 부르는 쪽이 남긴다 */
  function placed(d) {
    pl.base = d; pl.kit = d?.edit ?? null; pl.err = null;
    pl.hist = []; pl.fut = []; pl.dirty = false; pl.edits = d?.edited ?? 0; pl.sel = new Set(); pl.ranking = null;
    pl.locked = new Set(); pl.drag = null; pl.hover = null;
    if (!d || !pl.kit) {
      pl.model = null; pl.live = null;
      pl.err = d ? "This placement has no editing data — run Placement again" : null;
      done(); return;
    }
    try {
      pl.model = rebuild(ctx.design(), pl.kit, d.rects);
      pl.theta = pl.model.theta; pl.sx = pl.model.sx; pl.sy = pl.model.sy;
      refreshLive();
    } catch (e) {
      pl.model = null; pl.live = null; pl.err = "Could not prepare the editor — " + e.message; console.error("[edit]", e);
    }
    done();
  }

  /** 편집 하나가 끝났다. 배선은 배치를 굳힐 때(setOurs — 정리·반전·variant 다시) 앱이 지운다: 끄는 중의 배치는 아직
   *  배치가 아니다 (정리 전). 그래서 끌기만 하고 되돌리면 배선은 그대로다 */
  function afterEdit() {
    refreshLive();
    done(); ctx.redraw();
  }

  // ---------------------------------------------------------------- 편집들
  function selectedIndices() { return [...pl.sel].map((nm) => pl.model.idx.get(nm)).filter((i) => i !== undefined); }

  function settleNow({ silent = false } = {}) {
    const { model, sx, sy } = pl;
    if (!model) return false;
    const { cx, cy } = pl.live;
    const r = settle(model, cx, cy, sx, sy, { both: pl.both, compact: pl.compact });
    if (r.status !== "OPTIMAL") {
      const why = r.status === "NODIRECTION"
        ? `Settle failed — pairs that cannot be separated in any direction: ${r.pairs.map((p) => p.join("~")).join(", ")}`
        : `Settle failed (${r.status})` + (r.orderBad.length ? ` — Order violations: ${r.orderBad.join(", ")}` : "");
      pl.err = why; if (!silent) ctx.status(`<span class="err">${esc(why)}</span>`);
      done(); return false;
    }
    pushHistory();
    applyCoords(r.cx, r.cy, sx, sy, { ms: r.ms, slack: r.slack });
    return true;
  }

  /** 정리된 좌표를 새 배치(ours)로 굳힌다 */
  function applyCoords(cx, cy, sx, sy, info = {}) {
    const out = toRects(pl.model, cx, cy, sx, sy);
    const ours = state().ours;
    const base = ours.base ?? { area: ours.area, hpwl: ours.hpwl, bbox: ours.bbox };
    const next = { ...ours, ...out, edited: pl.edits + 1, base, hpwlBeforeFlip: null, fixedVariants: fixedVariants(),
                   editInfo: { ms: info.ms ?? null, slack: info.slack ?? null } };
    delete next.score;
    pl.edits++;
    ctx.app.setOurs(next);
    pl.model = rebuild(ctx.design(), pl.kit, next.rects);
    pl.theta = pl.model.theta; pl.sx = pl.model.sx; pl.sy = pl.model.sy;
    pl.dirty = false; pl.err = null;
    refreshLive(); done();
  }

  function flip(axis) {
    const names = [...pl.sel];
    if (!names.length || !pl.model) return;
    let sx = pl.sx, sy = pl.sy, any = false;
    const seen = new Set();
    for (const nm of names) {
      if (seen.has(nm)) continue;
      const f = flipGroup(pl.model, nm, axis, sx, sy);
      if (!f) continue;
      f.members.forEach((m) => seen.add(m));
      sx = f.sx; sy = f.sy; any = true;
    }
    if (!any) { ctx.status(`<span>Constraints prevent flipping ${esc(names.join(", "))} in ${axis}</span>`); return; }
    pushHistory();
    // 반전은 좌표를 안 바꾼다 — 정리 없이 바로 굳힌다 (HPWL 만 다시 잰다). 정리 전 상태였다면 그 좌표째 굳는다
    const { cx, cy } = pl.live;
    applyCoords(cx, cy, sx, sy);
  }

  function setVariant(name, concrete) {
    if (!pl.model) return;
    const vc = variantChoices(pl.model, name);
    if (!vc || vc.current === concrete) return;
    const rects = withVariant(pl.model, pl.live.rects, name, concrete);
    if (!rects) return;
    pushHistory();
    for (const m of vc.members) pl.pinned.set(m, concrete);
    pl.model = rebuild(ctx.design(), pl.kit, rects);
    pl.theta = pl.model.theta; pl.sx = pl.model.sx; pl.sy = pl.model.sy;
    pl.dirty = true;
    afterEdit();
    ctx.status(`<span>${esc(name)} variant set to ${esc(short(concrete))} — settle if it now overlaps. This variant is now pinned</span>`);
  }
  function unpin(name) {
    const vc = pl.model ? variantChoices(pl.model, name) : null;
    for (const m of vc?.members ?? [name]) pl.pinned.delete(m);
    done();
  }
  function fixedVariants() { return pl.pinned.size ? Object.fromEntries(pl.pinned) : null; }

  function swap() {
    if (pl.sel.size !== 2 || !pl.model) return;
    const [a, b] = selectedIndices();
    const { cx, cy } = pl.live;
    pushHistory();
    pl.theta = dragTheta(pl.model, pl.theta, pinRows(pl.model, { locked: pl.locked }),
                         [[2 * a, cx[b]], [2 * a + 1, cy[b]], [2 * b, cx[a]], [2 * b + 1, cy[a]]]);
    pl.dirty = true;
    afterEdit();
  }
  function toggleLock() {
    for (const nm of pl.sel) { if (pl.locked.has(nm)) pl.locked.delete(nm); else pl.locked.add(nm); }
    done(); ctx.redraw();
  }
  /** 고른 블록(또는 names)을 (dx, dy) 만큼 — 제약을 따라 */
  function nudge(dx, dy, names = null) {
    const list = (names ?? [...pl.sel]).filter((nm) => !pl.locked.has(nm));
    if (!list.length || !pl.model) return;
    pushHistory();
    const { cx, cy, ax } = pl.live;
    pl.theta = dragTheta(pl.model, pl.theta, pinRows(pl.model, { locked: pl.locked }), dragRows(pl.model, list, dx, dy, cx, cy, ax));
    pl.dirty = true;
    afterEdit();
  }
  /** 블록의 왼쪽 아래를 (x, y) 로 — 속성 칸에 좌표를 적었을 때. 제약이 막으면 갈 수 있는 데까지 */
  function moveTo(name, x, y) {
    const r = pl.live?.rects.find((q) => q.name === name);
    if (!r) return;
    const dx = Number.isFinite(x) ? x - r.x : 0, dy = Number.isFinite(y) ? y - r.y : 0;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return;
    nudge(dx, dy, [name]);
  }
  function reflip() {
    if (!pl.model) return;
    const { cx, cy } = pl.live;
    const fr = chooseFlips(pl.model, cx, cy);
    const same = fr.sx.every((v, i) => v === pl.sx[i]) && fr.sy.every((v, i) => v === pl.sy[i]);
    if (same) { ctx.status("<span>Flips are already optimal</span>"); return; }
    pushHistory();
    applyCoords(cx, cy, fr.sx, fr.sy);
  }
  function revert() {
    if (!pl.orig) return;
    pushHistory();
    ctx.app.setOurs(pl.orig);
    placedKeepPins(pl.orig);
  }
  function placedKeepPins(d) { const pinned = pl.pinned, hist = pl.hist; placed(d); pl.pinned = pinned; if (d === pl.orig && hist.length) pl.hist = hist; done(); }

  /** 정리 뒤 같은 위상에서 variant 를 다시 고른다 (워커). 끝나면 1 위를 적용하고 순위를 보인다 */
  async function retry() {
    if (!pl.model || pl.busy) return;
    if (pl.dirty && !settleNow()) return;
    pl.busy = true; done();
    ctx.status('<span class="dot"></span><span>Re-choosing variants within the same topology…</span>');
    try {
      const ours = state().ours;
      const blob = ctx.design();
      const r = await ctx.app.services.placement.retry(
        { kind: "retry", blob: { topology: blob.topology, primitives: blob.primitives, templates: blob.templates },
          kit: pl.kit, rects: ours.rects, fixed: fixedVariants(), compact: pl.compact, hpwlWeight: ours.hpwlWeight ?? 1 },
        (m) => ctx.status(`<span class="dot"></span><span>variant ${m.done}/${m.total} · ${m.t.toFixed(0)}s</span>`));
      pl.ranking = r.ranking.slice(0, 6).map((x) => ({ ...x }));
      const best = r.ranking[0];
      if (best && !best.current) {
        pushHistory();
        applyOut(best.out);
        ctx.status(`<span>Variant search — applied the best of ${r.tried} assignments (area x wirelength ${Math.exp(best.score - (r.ranking[r.current]?.score ?? best.score)).toFixed(3)}×)  ${(r.ms / 1000).toFixed(1)}s</span>`);
      } else ctx.status(`<span>Variant search — the current assignment is already the best of ${r.tried}  ${(r.ms / 1000).toFixed(1)}s</span>`);
    } catch (e) {
      ctx.status(`<span class="err">Variant search failed — ${esc(e.message)}</span>`);
    } finally { pl.busy = false; done(); ctx.redraw(); }
  }
  /** retry 의 순위 하나를 배치로 굳힌다 */
  function applyOut(out) {
    const ours = state().ours;
    const base = ours.base ?? { area: ours.area, hpwl: ours.hpwl, bbox: ours.bbox };
    const next = { ...ours, ...out, edited: pl.edits + 1, base, hpwlBeforeFlip: null, fixedVariants: fixedVariants() };
    delete next.score;
    pl.edits++;
    ctx.app.setOurs(next);
    pl.model = rebuild(ctx.design(), pl.kit, next.rects);
    pl.theta = pl.model.theta; pl.sx = pl.model.sx; pl.sy = pl.model.sy;
    pl.dirty = false; pl.err = null;
    refreshLive(); done();
  }
  function applyRank(k) {
    const r = pl.ranking?.[k];
    if (!r?.out) return;
    pushHistory();
    applyOut(r.out);
  }

  // ---------------------------------------------------------------- 고르기
  function setSel(next, { quiet = false } = {}) {
    pl.sel = next;
    if (!quiet) ctx.selected("block", [...next]);
    hint();
  }
  function selectNames(names, { add = false } = {}) {
    if (!pl.model) return;
    const ok = names.filter((n) => pl.model.idx.has(n));
    const next = add ? new Set([...pl.sel, ...ok]) : new Set(ok);
    setSel(next); done(); ctx.redraw();
  }
  function clearSelection() { if (!pl.sel.size) return; setSel(new Set()); done(); ctx.redraw(); }
  /** 상자로 고르기 — 왼쪽에서 오른쪽으로 끌면 다 든 것만, 반대로 끌면 걸친 것까지 (CAD 관례) */
  function selectBox(r, { add = false, crossing = false } = {}) {
    if (!pl.live) return;
    const [x0, y0, x1, y1] = r;
    const hit = pl.live.rects.filter((q) => crossing
      ? q.x < x1 && q.x + q.w > x0 && q.y < y1 && q.y + q.h > y0
      : q.x >= x0 && q.x + q.w <= x1 && q.y >= y0 && q.y + q.h <= y1).map((q) => q.name);
    selectNames(hit, { add });
  }

  // ---------------------------------------------------------------- 포인터 (화면 좌표 px, py — 캔버스의 CSS 픽셀)
  function hitBlock(x, y) {
    if (!pl.live) return null;
    let best = null;
    for (const r of pl.live.rects) {
      if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
      if (pl.sel.has(r.name)) return r.name;          // 고른 것이 위
      if (!best || r.w * r.h < best.w * best.h) best = r;
    }
    return best?.name ?? null;
  }
  function axisHandle(px, py) {
    const m = mapNow()?.m, bb = state().ours?.bbox;
    if (!pl.live || !m || !bb) return null;
    for (const a of pl.live.axes) {
      const hx = a.vert ? m.X(a.at) : m.X(bb[2]) - 8, hy = a.vert ? m.Y(bb[3]) + 8 : m.Y(a.at);
      if (Math.abs(px - hx) <= 8 && Math.abs(py - hy) <= 8) return a;
    }
    return null;
  }
  /** 축 핸들을 눌렀나 — 그러면 축 끌기를 시작한다 */
  function axisDown(e, px, py) {
    const p = toLayout(px, py);
    if (!p || !pl.live || state().busy) return false;
    const ax = axisHandle(px, py);
    if (!ax) return false;
    pl.drag = { kind: "axis", k: ax.k, vert: ax.vert, x0: p.x, y0: p.y, theta0: pl.theta, live0: pl.live, moved: false, snap: snapshot() };
    return true;
  }
  /** 블록을 눌렀나 — 고르고 끌기를 시작한다 (Shift 는 더하고 빼기, Alt 는 그룹째) */
  function blockDown(e, px, py) {
    const p = toLayout(px, py);
    if (!p || !pl.live || state().busy) return false;
    const nm = hitBlock(p.x, p.y);
    if (!nm) return false;
    let next = pl.sel;
    if (e.shiftKey) { next = new Set(pl.sel); if (next.has(nm)) next.delete(nm); else next.add(nm); }
    else if (!pl.sel.has(nm)) next = new Set([nm]);
    if (next !== pl.sel) setSel(next);
    const names = [...pl.sel].filter((q) => !pl.locked.has(q));
    pl.drag = { kind: "block", names, x0: p.x, y0: p.y, theta0: pl.theta, live0: pl.live, group: e.altKey, moved: false, snap: snapshot() };
    done(); ctx.redraw();
    return true;
  }
  /** 끄는 중이면 끌고 true. 아니면 가리킨 블록을 밝히고 false */
  function move(e, px, py) {
    const d = pl.drag;
    if (!d) {
      const p = toLayout(px, py);
      const nm = p ? hitBlock(p.x, p.y) : null;
      if (nm !== pl.hover) { pl.hover = nm; hint(); ctx.redraw(); }
      return false;
    }
    const p = toLayout(px, py);
    if (!p) return true;
    const dx = p.x - d.x0, dy = p.y - d.y0;
    if (!d.moved && Math.hypot(dx, dy) * (mapNow()?.m.S ?? 1) < 3) return true;
    d.moved = true;
    const { cx, cy, ax } = d.live0;
    if (d.kind === "axis") {
      pl.theta = dragTheta(pl.model, d.theta0, pinRows(pl.model, { lockAxes: false, locked: pl.locked }),
                           [[2 * pl.model.n + d.k, ax[d.k] + (d.vert ? dx : dy)]]);
    } else {
      pl.theta = dragTheta(pl.model, d.theta0, pinRows(pl.model, { lockAxes: !d.group, locked: pl.locked }),
                           dragRows(pl.model, d.names, dx, dy, cx, cy, ax, { group: d.group }));
    }
    refreshLive();
    liveHint();
    ctx.redraw();
    return true;
  }
  function up() {
    const d = pl.drag;
    pl.drag = null;
    if (!d) return false;
    if (d.moved) {
      pl.hist.push(d.snap); if (pl.hist.length > 60) pl.hist.shift(); pl.fut = []; ctx.pushed("pl");
      pl.dirty = true;
      afterEdit();
    } else { done(); ctx.redraw(); }
    return true;
  }
  function leave() { if (pl.hover) { pl.hover = null; ctx.redraw(); } }

  function hint() {
    const nm = pl.hover ?? [...pl.sel][0];
    if (!nm || !pl.model) { ctx.hint(""); return; }
    const P = pl.model.P, i = pl.model.idx.get(nm);
    if (i === undefined) { ctx.hint(""); return; }
    const nets = new Set();
    for (let p = 0; p < P.pinInst.length; p++) if (P.pinInst[p] === i) nets.add(P.netNames[P.pinNet[p]]);
    ctx.hint(`${nm} · ${short(P.concrete[i])} · ${Math.round(P.w[i])}×${Math.round(P.h[i])}` + (nets.size ? ` · nets ${[...nets].join(" ")}` : ""));
  }
  function liveHint() {
    if (!pl.live) return;
    const m = pl.live.m;
    ctx.hint(`Overlapping pairs ${pl.live.overlap.pairs} · Order violations ${m.orderBad.length} · HPWL ${fmt(m.hpwl)}`);
  }

  /** 블록이 닿는 넷 이름들 — 속성 칸과 회로 쪽 연동이 쓴다 */
  function netsOf(name) {
    if (!pl.model) return [];
    const P = pl.model.P, i = pl.model.idx.get(name), out = new Set();
    for (let p = 0; p < P.pinInst.length; p++) if (P.pinInst[p] === i) out.add(P.netNames[P.pinNet[p]]);
    return [...out];
  }

  return {
    pl, placed, liveData, refreshLive,
    undo, redo, settle: settleNow, flip, setVariant, unpin, fixedVariants, swap, toggleLock, nudge, moveTo, reflip, revert,
    retry, applyRank, selectNames, clearSelection, selectBox, hitBlock, axisHandle, axisDown, blockDown, move, up, leave,
    hint, netsOf, variantChoices: (nm) => (pl.model ? variantChoices(pl.model, nm) : null),
    flipFreedom: (nm) => (pl.model ? flipFreedom(pl.model, nm) : null),
    setCompact: (v) => { pl.compact = v; }, setBoth: (b) => { pl.both = !!b; },
    get dirty() { return pl.dirty; },
    /** 블록 사각형 (레이아웃 좌표) — 블록으로 가기 */
    rectOf: (nm) => pl.live?.rects.find((q) => q.name === nm) ?? state().ours?.rects.find((q) => q.name === nm) ?? null,
  };
}
