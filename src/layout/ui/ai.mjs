/** 어시스턴트가 레이아웃을 다루는 손잡이 (src/ai/host.ts 의 LayoutControl) — src/ai/tools-layout.ts 의 도구가 부른다.
 *
 *  편집기 화면의 단추가 부르는 것과 같은 함수를 부른다: 회로도 읽기(app.rebuild) · 자동 배치(app.runPlacement) ·
 *  배치 편집(editors.placement) · 자동 배선(app.runRouting, 고를 수 있다) · 트랙 그리기(editors.track). 그래서 사람이 보는
 *  화면과 이력(되돌리기)이 그대로 따라온다. 배치·배선처럼 오래 걸리는 것은 끝날 때까지 기다린다 (idle).
 *  편집기가 아직 화면에 없어도 된다 — 편집기(app.editors)는 화면과 따로 있다. 보이고 싶으면 reveal.
 *
 *  돌려주는 값은 모델에게 그대로 보낼 JSON 이다 (좌표 · 크기는 nm, 층은 SKY130 이름).
 */
import { frontBlocks } from "./placement/blocks.mjs";
import { layerName } from "../pdk/pdk.mjs";

const EFFORT = { fast: 48, normal: 96, wide: 288 };

/** 모델에게 돌아갈 오류 (도구가 ToolError 로 바꾼다) */
const fail = (msg) => { throw Object.assign(new Error(msg), { name: "LayoutError" }); };
const plain = (html) => String(html ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const r0 = (v) => Math.round(v);

export function createLayoutControl(app, shell) {
  const S = app.state;
  const E = () => app.editors;
  const busyNow = () => S.busy || !!E()?.placement.pl.busy;
  const T = () => E()?.track ?? null;

  /** 레이아웃이 일을 마칠 때까지 (배치 · 배선 · 재검사 · 위상 유지 최적화) */
  function idle({ signal, timeout = 10 * 60e3 } = {}) {
    return new Promise((resolve, reject) => {
      let off = null, timer = null, poll = null;
      const finish = (err) => {
        off?.(); clearTimeout(timer); clearInterval(poll); signal?.removeEventListener("abort", onAbort);
        if (err) reject(err); else resolve();
      };
      const check = () => { if (!busyNow()) finish(); };
      const onAbort = () => finish(new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort);
      off = app.bus.on("*", () => setTimeout(check, 0));
      poll = setInterval(check, 250);               // 소식 없이 끝나는 것도 놓치지 않게
      timer = setTimeout(() => finish(Object.assign(new Error("Timed out waiting for the layout editors."), { name: "LayoutError" })), timeout);
      setTimeout(check, 0);
    });
  }

  /** 그 편집기가 안 보이면 보인다 — 보이는 것은 건드리지 않는다 (사용자가 고른 보기를 존중한다) */
  function reveal(id) {
    const v = shell.view();
    if (v[id]?.shown || v[id]?.popped) return;
    if (id === "placement") shell.showPair("circuit", "placement", "cols");
    else if (v.placement?.shown) shell.showPair("placement", "layout", "cols");
    else shell.show(id);
  }

  // ---------------------------------------------------------------- 읽기
  function schematicInfo() {
    const nl = S.netlist;
    if (!nl) return { read: false, note: "Not read yet — layout_place reads it first, or call layout_read_schematic." };
    return {
      read: true, circuit: nl.top, changed_since_read: app.stale(),
      transistors: Object.entries(nl.devices).map(([ref, dev]) => `${ref}=${dev}`),
      pins: nl.ports, not_in_layout: nl.excluded, notes: S.notes,
    };
  }
  function blocksInfo() {
    return frontBlocks(app).map((b) => ({ name: b.name, kind: b.gloss || b.family, template: b.family, parts: b.refs,
                                          variants: b.module ? "module" : b.variants, constraints: b.cons }));
  }
  function placementInfo() {
    const o = S.ours;
    if (!o) return null;
    const P = E()?.placement, pl = P?.pl, rects = pl?.live?.rects ?? o.rects;
    const bb = o.bbox;
    return {
      size_nm: [r0(bb[2] - bb[0]), r0(bb[3] - bb[1])], origin_nm: [r0(bb[0]), r0(bb[1])],
      hpwl_nm: r0(pl?.live?.m?.hpwl ?? o.hpwl), overlapping_pairs: pl?.live?.overlap.pairs ?? 0,
      edits: pl?.edits ?? o.edited ?? 0, unsettled: !!pl?.dirty, grid_nm: o.grid,
      blocks: rects.map((r) => {
        const vc = P?.variantChoices(r.name);
        return { name: r.name, variant: r.concrete, x: r0(r.x), y: r0(r.y), w: r0(r.w), h: r0(r.h),
                 flip: `${r.sx > 0 ? "+" : "-"}x ${r.sy > 0 ? "+" : "-"}y`, locked: !!pl?.locked.has(r.name), pinned: !!pl?.pinned.has(r.name),
                 other_variants: vc ? vc.choices.filter((c) => c.concrete !== vc.current).map((c) => `${c.concrete} ${r0(c.w)}x${r0(c.h)}`) : [] };
      }),
      problem: pl?.err ?? null,
    };
  }
  function routingInfo({ errors = 8 } = {}) {
    const t = T();
    if (!t?.base()) return null;
    if (!t.te.checked || t.te.checked.ver !== t.art().ver) t.checkNow();
    const st = t.stats(), d = t.derived(), c = t.te.checked;
    return {
      routed: true, tracks: st.wires, vias: st.vias, drc_lvs_errors: c?.errors.length ?? null,
      // 그중 아직 안 이은 넷의 OPEN (할 일) 과 그린 것의 오류 — 사람이 보는 상태 줄과 같은 나눔
      not_connected_yet: c?.pending ?? null, errors_in_drawn: c?.real ?? null, errors: (c?.errors ?? []).slice(0, errors),
      open_nets: st.open, nets: [...d.an.nets].map(([name, q]) => ({ name, pins: q.pins, open: Math.max(0, q.comps - 1) })),
      ...(S.routeFail ? { last_auto_route_failed: S.routeFail } : {}),
      layers: "li1 (vertical), met1 (horizontal), met2 (vertical), met3 (horizontal), met4 (vertical); the checker's messages call them M1..M5",
      undo_steps: t.art().hist.length,
    };
  }
  function status() {
    return {
      schematic: schematicInfo(), blocks: blocksInfo(), placement: placementInfo(), routing: routingInfo(),
      views: Object.entries(shell.view()).filter(([, v]) => v.shown || v.popped).map(([k, v]) => k + (v.popped ? " (own window)" : "")),
      busy: busyNow(), message: plain(S.status),
    };
  }
  function brief() {
    if (!S.netlist && !S.ours) return "Layout (SKY130): not started — the schematic has not been read for layout.";
    const parts = [`Layout (SKY130): ${S.netlist ? `${S.info?.blocks ?? 0} blocks from the schematic${app.stale() ? " (schematic changed since)" : ""}` : "no design"}`];
    if (S.ours) {
      const bb = S.ours.bbox;
      parts.push(`placed ${r0(bb[2] - bb[0])} x ${r0(bb[3] - bb[1])} nm${E()?.placement.pl.dirty ? " (unsettled edits)" : ""}`);
    } else parts.push("not placed");
    const st = S.ours ? T()?.stats() : null;
    if (st) parts.push(`${st.wires} tracks and ${st.vias} vias drawn, ${st.open.length} open nets${st.errors != null ? `, DRC/LVS ${st.errors}` : ""}`);
    if (S.routeFail) parts.push(`last auto route failed: ${S.routeFail}`);
    if (busyNow()) parts.push("working now");
    return parts.join(", ") + ".";
  }

  // ---------------------------------------------------------------- 하기
  async function read({ signal } = {}) {
    await idle({ signal });
    await app.rebuild();
    await idle({ signal });
    if (!S.blob) fail(plain(S.status) || "Could not read the schematic for layout.");
    return { message: plain(S.status), schematic: schematicInfo(), blocks: blocksInfo() };
  }

  async function place({ effort, wirelengthWeight, signal } = {}) {
    await idle({ signal });
    if (effort) app.setSetting("batch", EFFORT[effort] ?? S.settings.batch);
    if (wirelengthWeight != null) {
      const w = Number(wirelengthWeight);
      if (!(w > 0)) fail("wirelength_weight must be a positive number (1 = area and wirelength count the same).");
      app.setSetting("hw", Math.max(-40, Math.min(40, Math.round(10 * Math.log2(w)))));
    }
    reveal("placement");
    await app.runPlacement();
    await idle({ signal });
    if (!S.ours) fail(plain(S.status) || "Placement failed.");
    return { message: plain(S.status), schematic: schematicInfo(), placement: placementInfo() };
  }

  async function editPlacement({ edits = [], swap = null, settle = true, optimize = false, signal } = {}) {
    await idle({ signal });
    const P = E()?.placement, pl = P?.pl;
    if (!S.ours || !pl?.model) fail("There is no placement to edit — run layout_place first.");
    const names = new Set(pl.model.design.instances.map((v) => v.name));
    const need = (b) => { if (!names.has(b)) fail(`There is no block "${b}". Blocks: ${[...names].join(", ")}.`); return b; };
    const done = [];
    for (const e of edits) {
      const b = need(String(e.block ?? ""));
      if (e.variant != null) {
        const vc = P.variantChoices(b);
        if (!vc?.choices.some((c) => c.concrete === e.variant)) fail(`${b} has no variant "${e.variant}". It has: ${vc?.choices.map((c) => c.concrete).join(", ") || "only one"}.`);
        P.setVariant(b, e.variant); done.push(`${b} variant ${e.variant}`);
      }
      if (e.lock != null && !!e.lock !== pl.locked.has(b)) { P.selectNames([b]); P.toggleLock(); done.push(`${b} ${e.lock ? "locked" : "unlocked"}`); }
      if (e.x != null || e.y != null) {
        if (pl.locked.has(b)) fail(`${b} is locked — unlock it first (lock: false).`);
        P.moveTo(b, e.x != null ? Number(e.x) : NaN, e.y != null ? Number(e.y) : NaN); done.push(`${b} to (${e.x ?? "·"}, ${e.y ?? "·"})`);
      } else if (e.dx != null || e.dy != null) {
        if (pl.locked.has(b)) fail(`${b} is locked — unlock it first (lock: false).`);
        P.nudge(Number(e.dx ?? 0), Number(e.dy ?? 0), [b]); done.push(`${b} by (${e.dx ?? 0}, ${e.dy ?? 0})`);
      }
      if (e.flip) {
        for (const ax of e.flip === "xy" ? ["x", "y"] : [e.flip]) {
          if (ax !== "x" && ax !== "y") fail(`flip must be "x", "y" or "xy".`);
          const ff = P.flipFreedom(b);
          if (ff && !(ax === "x" ? ff.xFree : ff.yFree)) fail(`${b} cannot flip in ${ax} — its symmetry constraint holds it.`);
          P.selectNames([b]); P.flip(ax); done.push(`${b} flipped in ${ax}`);
        }
      }
    }
    if (swap) {
      if (swap.length !== 2) fail("swap takes exactly two block names.");
      P.selectNames(swap.map(need)); P.swap(); done.push(`swapped ${swap.join(" and ")}`);
    }
    let settled = null;
    if ((settle || optimize) && pl.dirty) {
      settled = P.settle();
      if (!settled) fail(`${pl.err ?? "Settle failed."} The edits so far stay (unsettled); undo them in the Placement editor or try other positions.`);
    }
    if (optimize) { await P.retry(); await idle({ signal }); }
    P.clearSelection();
    return { done, settled, message: plain(S.status), placement: placementInfo(), routing_cleared: !S.routed };
  }

  async function route({ keepDrawn = true, signal } = {}) {
    await idle({ signal });
    if (!S.ours) fail("There is no placement — run layout_place first.");
    const P = E()?.placement;
    if (P?.pl.dirty && !P.settle()) fail(`The placement has unsettled edits that cannot be settled: ${P.pl.err ?? ""}`);
    reveal("layout");
    const keep = keepDrawn ? T()?.finishedNets() ?? new Set() : new Set();
    S.routeFail = null;
    await app.runRouting({ keep });
    await idle({ signal });
    if (S.routeFail) fail(`Auto route failed: ${S.routeFail}`);
    return { message: plain(S.status), kept: [...keep], routing: routingInfo() };
  }

  async function fixRouting({ action, net = null, signal } = {}) {
    await idle({ signal });
    const t = T(), d = t?.derived();
    if (!S.ours || !d) fail("There is no placement — run layout_place first.");
    const needNet = () => {
      if (!net) fail(`${action} needs a net.`);
      if (!d.an.nets.has(net)) fail(`There is no net "${net}". Nets: ${[...d.an.nets.keys()].join(", ")}.`);
    };
    let did = null;
    switch (action) {
      case "connect_net": needNet(); reveal("layout"); did = t.autoConnect(net); break;
      case "connect_all": {
        reveal("layout");
        did = {};
        for (const n of t.stats().open) did[n] = t.autoConnect(n);
        break;
      }
      case "route_unfinished": return route({ keepDrawn: true, signal });
      case "delete_net": needNet(); did = { deleted: t.deleteNet(net) }; break;
      case "undo": if (!t.art().hist.length) fail("Nothing to undo in the layout."); t.undo(); break;
      case "redo": if (!t.art().fut.length) fail("Nothing to redo in the layout."); t.redo(); break;
      default: fail(`Unknown action "${action}".`);
    }
    t.checkNow();
    return { message: plain(S.status), did, routing: routingInfo() };
  }

  function show({ view = null, net, blocks } = {}) {
    const V = { circuit: () => shell.show("circuit"), placement: () => shell.show("placement"), layout: () => shell.show("layout"),
                "circuit+placement": () => shell.showPair("circuit", "placement", "cols"),
                "placement+layout": () => shell.showPair("placement", "layout", "cols"), all: () => shell.showAll() };
    if (view) { if (!V[view]) fail(`view must be one of ${Object.keys(V).join(", ")}.`); V[view](); }
    if (blocks?.length) {
      app.select({ kind: "block", names: blocks }, "assistant");
      if (E()?.placement.pl.model) E().placement.selectNames(blocks.filter((b) => E().placement.pl.model.idx.has(b)));
    } else if (net) {
      app.select({ kind: "net", name: net }, "assistant");
      T()?.selectNet(net);
    } else if (net === null) {
      app.select(null, "assistant");
      T()?.clearSelection();
    }
    return { views: status().views };
  }

  /** 편집기 화면을 그림으로 — 보이게 한 뒤 두 프레임 기다려 캔버스를 읽는다. 긴 변 1024 px 로 줄인다 */
  async function image({ editor = "layout" } = {}) {
    reveal(editor);
    const win = globalThis;
    await new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
    const ws = win.__layoutViews?.[editor];
    const cv = ws?.probe?.canvas;
    if (!cv || !cv.width || !cv.height) return { error: `The ${editor} editor is not on screen.` };
    ws.redraw?.();
    await new Promise((r) => win.requestAnimationFrame(r));
    const k = Math.min(1, 1024 / Math.max(cv.width, cv.height));
    const out = win.document.createElement("canvas");
    out.width = Math.max(1, Math.round(cv.width * k)); out.height = Math.max(1, Math.round(cv.height * k));
    out.getContext("2d").drawImage(cv, 0, 0, out.width, out.height);
    const what = editor === "placement" ? "blocks with their names, symmetry axes and the ratsnest (dashed)" :
      `cells and tracks by layer — ${["M1", "M2", "M3", "M4", "M5"].map(layerName).join(", ")}; dashed boxes are blocks, thin straight lines are the ratsnest (still to connect), red boxes are DRC/LVS errors`;
    return { url: out.toDataURL("image/png"), width: out.width, height: out.height, note: `The ${editor} editor as the user sees it: ${what}.` };
  }

  return { status, brief, read, place, editPlacement, route, fixRouting, show, image };
}
