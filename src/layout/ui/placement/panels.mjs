/** Placement 편집기의 패널 — 도구 줄, 블록 목록(왼쪽), 속성·배치기 설정·결과(오른쪽), 상태 막대.
 *
 *  편집기 상태(pl)와 앱 상태를 읽어 HTML 을 낸다. 단추의 data-act 는 workspace.mjs 의 act() 가 받는다.
 */
import { esc, short, fmt, num } from "../core/dom.mjs";
import { tb, sep } from "../ui/frame.mjs";
import { frontBlocksHtml } from "./blocks.mjs";
import { placeGrid, placeGridLayers, layerName } from "../../pdk/pdk.mjs";

const GRID_LAYERS = placeGridLayers().map(layerName);       // 화면에는 SKY130 이름 (li1, met1)

/** 도구 줄 */
export function toolsHtml({ app, ed, frame, rats = true }) {
  const P = ed?.placement, pl = P?.pl, has = !!pl?.model, busy = !!(pl?.busy || app.state.busy);
  const sel = pl?.sel.size ?? 0;
  const out = [];
  out.push(tb("run", "Auto place", { ic: "play", cls: "run", id: "run", title: "Run the placer — it chooses variants, flips, regions and the grid (settings: 'Placer settings' in the right panel)", disabled: app.state.busy }));
  out.push(sep);
  out.push(tb("flipx", "Flip x", { ic: "flipx", key: "X", cls: "icon", disabled: !sel || busy }));
  out.push(tb("flipy", "Flip y", { ic: "flipy", key: "Y", cls: "icon", disabled: !sel || busy }));
  out.push(tb("lock", "Lock", { ic: "lock", key: "L", cls: "icon", title: "Locked blocks cannot be dragged and stay in place when settling", disabled: !sel || busy }));
  out.push(tb("swap", "Swap", { ic: "swap", key: "S", cls: "icon", title: "Swap the positions of the two selected blocks", disabled: sel !== 2 || busy }));
  out.push(sep);
  out.push(tb("settle", "Settle", { ic: "settle", key: "Enter", cls: pl?.dirty ? "warn" : "", title: "Keep the pairwise relations (topology) of the edited positions, remove overlaps and snap to the grid", disabled: !has || busy }));
  out.push(tb("retry", "Optimize (keep topology)", { title: "Settle, then re-choose variants exhaustively within the same topology — pinned variants stay", disabled: !has || busy }));
  out.push(sep);
  out.push(tb("undo", "Undo", { ic: "undo", key: "Ctrl+Z", cls: "icon", disabled: !pl?.hist.length || busy }));
  out.push(tb("redo", "Redo", { ic: "redo", key: "Ctrl+Y", cls: "icon", disabled: !pl?.fut.length || busy }));
  out.push(sep);
  out.push(tb("rats", "Ratsnest", { ic: "ratsnest", cls: "icon", pressed: !!rats, title: "Ratsnest — every net's connections between block pins, so you can see what pulls where while you place" }));
  out.push(tb("fit", "Fit", { ic: "fit", key: "K", cls: "icon", title: "Fit to view (K or Home)" }));
  out.push(tb("zin", "Zoom in", { ic: "zoomin", key: "+", cls: "icon" }));
  out.push(tb("zout", "Zoom out", { ic: "zoomout", key: "-", cls: "icon" }));
  out.push(sep);
  out.push(tb("downloads", "Download", { ic: "download", cls: "icon", title: "Download the placement (JSON)" }));
  out.push(`<span class="tfill"></span>${frame.panelButtons()}`);
  return out.join("");
}

/** 왼쪽 — 블록 목록. 배치가 있으면 고른 variant·크기·반전, 없으면 앞단이 만든 블록 (종류·variant 후보·제약) */
export function blocksHtml({ app, ed }) {
  const pl = ed?.placement.pl, ours = app.state.ours;
  const sel = pl?.sel ?? new Set();
  if (ours) {
    const rects = pl?.live?.rects ?? ours.rects;
    const rows = rects.map((r) => `<tr data-block="${esc(r.name)}" class="${sel.has(r.name) ? "on" : ""}">` +
      `<td class="nm">${esc(r.name)}${pl?.locked.has(r.name) ? ' <span class="tag">locked</span>' : ""}${pl?.pinned.has(r.name) ? ' <span class="tag">pinned</span>' : ""}</td>` +
      `<td>${esc(short(r.concrete))}</td><td class="n">${Math.round(r.w)}×${Math.round(r.h)}</td><td class="flip">${r.sx > 0 ? "+" : "−"}${r.sy > 0 ? "+" : "−"}</td></tr>`).join("");
    return `<table class="list"><thead><tr><th>Block</th><th>Variant</th><th class="n">Size</th><th>Flip</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  return frontBlocksHtml(app);
}

/** 오른쪽 — 속성: 블록 하나 / 여럿 / 아무것도 (배치 상태와 편집 동작) */
export function propsHtml({ app, ed }) {
  const P = ed?.placement, pl = P?.pl, ours = app.state.ours;
  const row = (lab, body) => `<div class="prow"><span class="pl">${lab}</span><span class="pv">${body}</span></div>`;
  const btn = (act, label, title = "", off = false, cls = "", data = "") => `<button type="button" class="pb ${cls}" data-act="${act}"${data}${off ? " disabled" : ""} title="${title}">${label}</button>`;
  if (!ours) return `<p class="empty">${app.state.busy ? "Placer running…" : "Press Auto place to place the blocks, then edit them here by hand."}</p>`;
  if (!pl?.model) return `<p class="empty">${esc(pl?.err ?? "Preparing the editor…")}</p>`;
  const live = pl.live, mm = live.m, busy = pl.busy || app.state.busy;
  const base = ours.base ?? { area: ours.area, hpwl: ours.hpwl };
  const out = [];
  const sel = [...pl.sel];
  if (sel.length === 1) {
    const nm = sel[0], i = pl.model.idx.get(nm), vc = P.variantChoices(nm), ff = P.flipFreedom(nm), r = live.rects[i];
    const opts = vc.choices.map((c) => `<option value="${esc(c.concrete)}"${c.concrete === vc.current ? " selected" : ""}>${esc(short(c.concrete))} ${Math.round(c.w)}×${Math.round(c.h)}</option>`).join("");
    out.push(`<h4>Block ${esc(nm)}</h4>`);
    out.push(row("Template", esc(pl.model.design.instances.find((v) => v.name === nm)?.abstract ?? "")));
    if (vc.members.length > 1) out.push(row("Mirror pair", esc(vc.members.filter((q) => q !== nm).join(" "))));
    out.push(row("Variant", `<select data-act="variant" data-name="${esc(nm)}"${vc.choices.length > 1 && !busy ? "" : " disabled"}>${opts}</select>` +
      (pl.pinned.has(nm) ? ` ${btn("unpin", "Unpin", "Let Placement choose this variant again", false, "", ` data-name="${esc(nm)}"`)}` : "")));
    out.push(row("x", `<input type="number" class="num" data-act="posx" data-name="${esc(nm)}" value="${Math.round(r.x)}" step="${pl.model.grid?.[0] ?? placeGrid()[0]}"${pl.locked.has(nm) || busy ? " disabled" : ""}> <small>nm</small>`));
    out.push(row("y", `<input type="number" class="num" data-act="posy" data-name="${esc(nm)}" value="${Math.round(r.y)}" step="${pl.model.grid?.[1] ?? placeGrid()[1]}"${pl.locked.has(nm) || busy ? " disabled" : ""}> <small>nm</small>`));
    out.push(row("Size", `${Math.round(r.w)} × ${Math.round(r.h)}`));
    out.push(row("Flip", btn("flipx", `x ${pl.sx[i] > 0 ? "+" : "−"} <kbd>X</kbd>`, ff.xFree ? "Flip x" : "Held by constraints", !ff.xFree || busy) + " " +
                         btn("flipy", `y ${pl.sy[i] > 0 ? "+" : "−"} <kbd>Y</kbd>`, ff.yFree ? "Flip y" : "Held by constraints", !ff.yFree || busy)));
    out.push(row("Lock", btn("lock", pl.locked.has(nm) ? "Unlock <kbd>L</kbd>" : "Lock <kbd>L</kbd>", "Locked blocks cannot be dragged and stay in place when settling", busy)));
    const nets = P.netsOf(nm);
    if (nets.length) out.push(row("Nets", nets.map((n) => `<button type="button" class="chip" data-act="net" data-net="${esc(n)}" title="Show this net in Circuit and Layout too">${esc(n)}</button>`).join(" ")));
  } else if (sel.length > 1) {
    out.push(`<h4>${sel.length} blocks</h4>`, row("Selected", esc(sel.join(" "))));
    out.push(`<div class="pbtns">${btn("swap", "Swap <kbd>S</kbd>", "Swap the positions of the two blocks", sel.length !== 2 || busy)}${btn("lock", "Lock/unlock <kbd>L</kbd>", "", busy)}${btn("flipx", "Flip x <kbd>X</kbd>", "", busy)}${btn("flipy", "Flip y <kbd>Y</kbd>", "", busy)}</div>`);
  }
  out.push(`<h4>Placement</h4>`);
  out.push(row("State", `${pl.dirty ? '<b class="warn">Not settled</b>' : "Settled"} · edits ${pl.edits}`));
  out.push(row("Overlapping pairs", `${live.overlap.pairs}${live.overlap.pairs ? " — settle to remove them" : ""}`));
  out.push(row("Order violations", String(mm.orderBad.length)));
  out.push(row("HPWL", `${fmt(mm.hpwl)} <small>(vs placer ${base.hpwl ? (mm.hpwl / base.hpwl).toFixed(3) + "×" : "—"})</small>`));
  out.push(row("Area", `${base.area ? (mm.area / base.area).toFixed(3) + "×" : "—"} <small>vs placer</small>`));
  out.push(row("Off grid", String(mm.offgrid)));
  out.push(`<div class="pbtns">` +
    btn("settle", "Settle (keep topology) <kbd>Enter</kbd>", "Keep the pairwise relations (topology) of the edited positions, remove overlaps and snap to the grid", busy, "run") +
    btn("retry", "Optimize (keep topology)", "Settle, then re-choose variants exhaustively within the same topology — pinned variants stay", busy) +
    btn("reflip", "Reflip", "Keep positions and re-choose only the flips", busy) +
    btn("revert", "Revert to original", "Go back to the placement the placer produced (pinned variants are kept)", busy) + `</div>`);
  out.push(row("Compaction", `<input type="range" data-act="compact" min="0" max="20" step="1" value="${Math.round(pl.compact * 10)}"> <b class="cval">${pl.compact.toFixed(1)}</b> <small>0 = only what you moved · 0.5 = placer default</small>`));
  out.push(row("Relations", `<label><input type="checkbox" data-act="both"${pl.both ? " checked" : ""}> Keep both x and y <small>(moves less, compacts less)</small></label>`));
  if (pl.pinned.size) {
    const seen = new Set(), items = [];
    for (const [nm, c] of pl.pinned) { if (seen.has(c + nm)) continue; seen.add(c + nm); items.push(`${esc(nm)} <small>${esc(short(c))}</small> <button type="button" class="x" data-act="unpin" data-name="${esc(nm)}" title="Unpin">×</button>`); }
    out.push(row("Pinned variants", items.join(" · ") + `<br><small class="muted">The next Auto place uses these variants too</small>`));
  }
  if (pl.ranking) {
    const cur = pl.ranking.find((q) => q.current)?.score;
    const tr = pl.ranking.map((r, k) => `<tr><td>${k + 1}</td><td>${Math.round(r.bbox[2])}×${Math.round(r.bbox[3])}</td><td>${fmt(r.hpwl)}</td><td>${(r.score - (cur ?? r.score)).toFixed(3)}</td><td>${r.current ? "<small>current</small>" : btn("apply", "Apply", "", busy, "", ` data-k="${k}"`)}</td></tr>`).join("");
    out.push(`<h4>Variant ranking</h4><table class="rank"><thead><tr><th></th><th>bbox</th><th>HPWL</th><th>Score diff</th><th></th></tr></thead><tbody>${tr}</tbody></table>`);
  }
  if (!sel.length) out.push(`<p class="hint">Drag a block to move it along its constraints (mirror pairs mirror each other, blocks on an axis slide along it). Shift for several, Alt for the whole group; drag on empty space to box select. The magenta axis handle moves the whole symmetry group.</p>`);
  return out.join("");
}


/** 배치 결과 (배치기가 낸 지표) — 옛 결과 카드 */
export function resultHtml(r) {
  if (!r) return `<p class="empty">Filled in after Auto place</p>`;
  const rows = [];
  const add = (k, v, cls = "") => rows.push(`<div class="m"><dt>${k}</dt><dd class="${cls}">${v}</dd></div>`);
  let blockArea = 0;
  for (const q of r.rects) blockArea += q.w * q.h;
  const bw = r.bbox[2] - r.bbox[0], bh = r.bbox[3] - r.bbox[1];
  add("Area", `${Math.round(bw)} × ${Math.round(bh)} <small>fill ${(blockArea / Math.max(1, r.area)).toFixed(2)}</small>`);
  add("HPWL", r.hpwl > 0 ? num(r.hpwl) : "— <small>no nets</small>");
  add("Overlap", `${(r.overlap / blockArea).toExponential(1)} <small>vs block area</small>`, "win");
  add("Symmetry residual", `${r.resid.toExponential(1)}`, "win");
  add("Routing grid", r.offgrid === 0 ? `0 <small>off grid / ${GRID_LAYERS[0]} ${r.grid[0]} ${GRID_LAYERS[1]} ${r.grid[1]}</small>` : `${r.offgrid} <small>blocks off grid</small>`, r.offgrid === 0 ? "win" : "lose");
  add("Variant combos", `${r.combos} <small>· ${r.configs} configs searched</small>`);
  if (r.hpwlWeight) add("Weights", `area 1 : wirelength ${r.hpwlWeight.toFixed(2)}<small> · spread ${(r.lamRatio ?? 1).toFixed(2)}×</small>`);
  if (r.medOverlap != null) add("Continuous-stage overlap", `${r.medOverlap.toFixed(3)} <small>candidate median · before legalize</small>`);
  if (r.phaseSecs) add("Time", `${r.phaseSecs.search.toFixed(1)}s <small>search · legalize ${r.phaseSecs.legalize.toFixed(1)}s</small>`);
  add("Starts", `${r.starts ?? "—"} <small>rounds ${r.rounds ?? 1}` + (r.runner === "gpu" ? ` · WebGPU, ${r.perConfig} per config` : r.runner === "cpu" ? " · CPU" : "") + `</small>`);
  const why = Object.entries(r.legalFailBy ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ");
  if (r.tried != null) add("legalize", `${r.tried - r.legalFail}/${r.tried} <small>succeeded` + (r.legalRescued ? ` · ${r.legalRescued} rescued by widening slack` : "") + (why ? ` · ${why}` : "") + "</small>", r.legalFail ? "" : "win");
  if (r.nOrder) add("Order constraints", `${r.orderBad} <small>violated / ${r.nOrder}</small>`, r.orderBad ? "lose" : "win");
  if (r.hpwlBeforeFlip) add("Flip effect", `${(r.hpwl / r.hpwlBeforeFlip).toFixed(2)}× <small>HPWL</small>`, "win");
  if (r.edited) add("Edits", `${r.edited} <small>· vs placer: area ${(r.area / Math.max(1, r.base?.area ?? r.area)).toFixed(3)}× · HPWL ${(r.hpwl / Math.max(1, r.base?.hpwl ?? r.hpwl)).toFixed(3)}×</small>`);
  let subs = "";
  if (r.subs?.length) subs = `<h4>Shapes offered by submodules</h4><table class="list"><thead><tr><th>Module</th><th>Used</th><th>Offered</th></tr></thead><tbody>` +
    r.subs.map((s) => `<tr><td class="nm">${esc(s.name.replace(/^PRIMITIVE_/, "P·"))}</td><td>${s.box[0]}×${s.box[1]}</td><td class="muted">${s.shapes.slice(0, 4).map((b) => b[0] + "×" + b[1]).join("  ")}</td></tr>`).join("") + `</tbody></table>`;
  return `<dl class="metrics" id="metrics">${rows.join("")}</dl>${subs}`;
}

/** 상태 막대 */
export function statusHtml({ app, ed, cursor, view }) {
  const pl = ed?.placement.pl, grid = app.state.ours?.grid ?? placeGrid();
  const live = pl?.live;
  return [
    `<span class="xy">${cursor ? `X <b>${fmt(cursor.x)}</b> Y <b>${fmt(cursor.y)}</b>` : "X — Y —"} <small>nm</small></span>`,
    `<span title="Placement grid: the ${GRID_LAYERS[0]} and ${GRID_LAYERS[1]} track pitch">Grid ${grid[0]}×${grid[1]}</span>`,
    `<span>${view.s.toFixed(view.s < 10 ? 2 : 1)}×</span>`,
    live ? `<span class="${live.overlap.pairs ? "bad" : ""}">Overlaps ${live.overlap.pairs}</span><span>HPWL ${fmt(live.m.hpwl)}</span>` : "",
    `<span class="hint" id="plHint">${esc(ed?.hint("placement") ?? "")}</span>`,
  ].filter(Boolean).join("");
}
