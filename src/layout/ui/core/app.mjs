/** 레이아웃 앱 — 상태 하나와 그것을 바꾸는 동작들. Placement·Layout 편집기가 이것을 읽어 그리고, 바뀌면 소식(bus)을 듣는다.
 *
 *  설계는 melange 의 회로도에서 온다 (host.netlist() — src/layout/bridge.ts). 회로도를 고치면 host.version() 이
 *  바뀌고, 다음 배치 때 앞단을 다시 돌린다. 새 창으로 띄운 편집기도 원래 창의 앱을 그대로 쓴다 (window.opener) —
 *  같은 배치·배선·편집 이력을 본다. 워커(앞단·배치·배선)도 원래 창에서 돈다.
 *
 *    state      설계(blob, netlist, groups), 배치(ours, frame), 배선(routed, lastRouted), 상태 줄, 실행 설정, 선택 연동
 *    services   front · placement · routing
 *    editors    배치·배선 편집기 (../editors.mjs) — 따로 받아 붙인다
 *
 *  소식: status · design · info · placement · routing · busy · selection · probe · reveal · settings · edit · redraw · hint
 */
import { createBus } from "./bus.mjs";
import { createFront, summarize } from "../services/front.mjs";
import { createPlacement } from "../services/placement.mjs";
import { createRouting, routePlacement } from "../services/routing.mjs";
import { artifacts } from "../services/exports.mjs";
import { clearAll } from "../../art/doc.mjs";
import { frozenPaths } from "../../art/import.mjs";
import { gdsArt } from "../../art/check.mjs";
import { esc } from "./dom.mjs";
import { PLACE_DEFAULTS } from "../../place/defaults.mjs";

/**
 * @param {{ netlist(): object, version(): number, name(): string, selectParts?(refs: string[]): void,
 *           highlightNet?(name: string|null): void }} host  melange 쪽 (회로도)
 */
export function createApp(host) {
  const bus = createBus();
  const emit = (t, p) => bus.emit(t, p);
  const state = {
    key: null,                   // 지금 설계의 이름 (앞단을 한 번이라도 돌렸으면 맨 위 서브회로 이름)
    netlist: null,               // 마지막으로 앞단에 넣은 레이아웃 넷리스트 (bridge.ts LayoutNetlist)
    blob: null,                  // 앞단 출력 {topology, primitives, templates, leaves}
    groups: null,                // 블록 -> 소자 (선택 연동)
    builtFor: -1,                // 그 출력을 낸 회로도의 판 (host.version())
    info: null,                  // 설계 요약
    ours: null, frame: null,
    routed: null, routeFail: null, liveRec: null, lastRouted: null, routedFor: null,
    busy: false, runner: null, status: "",
    settings: { batch: PLACE_DEFAULTS.batch, perConfig: PLACE_DEFAULTS.perConfig, hw: 0, lam: 0 },
    gpu: !!globalThis.navigator?.gpu,
    selection: null, probe: null, link: true,
    notes: [],                   // 회로도 -> 레이아웃에서 바뀐 것 (크기, 빠진 소자)
  };
  const setStatus = (html) => { state.status = html; emit("status", html); };
  const say = (text, busy = true) => setStatus(`${busy ? '<span class="dot"></span>' : ""}<span>${esc(text)}</span>`);
  const sayErr = (text) => setStatus(`<span class="err">${esc(text)}</span>`);

  const front = createFront();
  const placement = createPlacement({ say });
  const routing = createRouting({ say: (t) => say(`Routing — ${t}`) });
  const app = { bus, state, host, services: { front, placement, routing, views: { get: () => null, ensure() {}, loaded: null } },
                editors: null, popups: {} };

  const hpwlWeight = () => Math.pow(2, Number(state.settings.hw) / 10);
  const lamRatio = () => Math.pow(2, Number(state.settings.lam) / 10);

  function clearResults() {
    state.ours = null; state.frame = null; state.routed = null; state.liveRec = null; state.routeFail = null;
    state.lastRouted = null; state.routedFor = null; stash = null;
    state.selection = null; state.probe = null;
    app.editors?.placed(null);
    emit("placement"); emit("routing"); emit("selection"); emit("probe");
  }

  /** 회로도가 마지막 앞단 뒤로 바뀌었나 */
  const stale = () => !state.blob || host.version() !== state.builtFor;

  /** 회로도 -> 레이아웃 넷리스트 -> 앞단 (원시 소자·셀). 회로도가 그대로면 지난 결과를 쓴다 */
  async function build({ force = false } = {}) {
    if (!force && !stale()) return state.blob;
    const v = host.version();
    say("Reading the schematic…");
    const nl = host.netlist();
    // 회로도가 바뀌었어도 레이아웃 넷리스트가 같으면 (글자 위치, 시뮬레이션 설정 …) 배치·배선을 그대로 둔다
    if (state.blob && state.netlist?.text === nl.text && JSON.stringify(state.netlist.constraints) === JSON.stringify(nl.constraints)) {
      state.netlist = nl; state.builtFor = v; state.notes = nl.notes ?? [];
      emit("info");
      return state.blob;
    }
    say("Grouping transistors into primitives…");
    const r = await front.run({ text: nl.text, top: nl.top, userConstraints: nl.constraints });
    state.netlist = nl; state.blob = r.blob; state.groups = r.groups; state.builtFor = v; state.key = nl.top;
    state.notes = nl.notes ?? [];
    clearResults();
    state.info = summarize(r.blob, state.key);
    emit("design", state.key); emit("info");
    return r.blob;
  }

  /** 회로도에서 설계를 다시 만든다 (Placement 의 "From schematic") */
  async function rebuild() {
    if (state.busy) return;
    state.busy = true; emit("busy");
    try {
      const before = state.blob;
      await build({ force: true });
      const n = state.notes.length, notes = n ? ` — ${n} note${n > 1 ? "s" : ""}` : "";
      if (before && state.blob === before) say(`The layout netlist did not change${notes}.`, false);
      else say(`${state.info.blocks} blocks from the schematic${notes}. Press Auto place.`, false);
    } catch (e) { sayErr(e.message); console.error(e); }
    finally { state.busy = false; emit("busy"); }
  }

  // ---------------------------------------------------------------- 배치
  function handlePlace(m) {
    if (m.type === "start") {
      state.info = { ...(state.info ?? {}), blocks: m.blocks, modules: m.modules, leafCombos: m.leafCombos, ignored: m.ignored };
      if (m.runner) state.runner = m.runner;
      emit("info"); emit("settings");
      setStatus(`<span class="dot"></span><span>Placing — trying variant combinations` +
                (m.runner ? ` <small>(${m.runner === "gpu" ? "WebGPU" : "CPU"})</small>` : "") + `</span>`);
    } else if (m.type === "progress") {
      setStatus(`<span class="dot"></span><span>${m.done}/${m.total} ${esc(m.phase ?? "candidates")} · ${m.t.toFixed(0)}s</span>`);
    } else if (m.type === "frame") {
      state.frame = m;
      emit("placement");
      setStatus(`<span class="dot"></span><span>${esc(m.isTop ? "top" : m.module)} ${esc(m.phase ?? "config")} ${m.i}/${m.total} · ${m.t.toFixed(0)}s</span>`);
    } else if (m.type === "done") {
      state.ours = m; state.frame = null; state.busy = false;
      app.editors?.placed(m);
      emit("placement"); emit("busy");
      setStatus(`<span>Placed in ${m.secs.toFixed(1)} s · ${m.configs} configs · ${m.starts ?? "?"} starts` +
                (m.runner ? ` · ${m.runner === "gpu" ? "WebGPU" : "CPU"}` : "") + `</span>`);
    } else if (m.type === "error") {
      state.busy = false; state.frame = null;
      emit("busy"); emit("placement");
      sayErr(`Placement failed: ${m.msg.split("\n")[0]}`);
      console.error(m.msg);
    }
  }

  async function runPlacement() {
    if (state.busy) return;
    state.busy = true; emit("busy");
    try {
      const blob = await build();
      if (state.art && (state.art.wires.length || state.art.vias.length)) {
        clearAll(state.art, "new placement");
        say("Tracks were for the old placement — cleared (Undo in Layout brings them back)");
      }
      state.ours = null; state.frame = null;
      state.routed = null; state.liveRec = null; state.routeFail = null; state.lastRouted = null; state.routedFor = null; stash = null;
      emit("routing"); emit("placement");
      emit("reveal", "placement");
      say("Placing…");
      const fixedVariants = app.editors?.fixedVariants?.() ?? null;
      app.editors?.placed(null);
      placement.run({ name: state.key, blob, batch: Number(state.settings.batch), perConfig: Number(state.settings.perConfig),
                      hpwlWeight: hpwlWeight(), lamRatio: lamRatio(), fixedVariants }, handlePlace);
    } catch (err) {
      state.busy = false; emit("busy");
      sayErr(err.message);
      console.error(err);
    }
  }

  // ---------------------------------------------------------------- 배선
  let routeSeq = 0;
  let stash = null;

  /**
   * 자동 배선 (고를 수 있다). keep: 그대로 둘 넷 — 손으로 다 이은 넷은 배선기에 고정으로 넘겨(장애물) 나머지만 배선한다.
   * 결과는 레이아웃 편집기의 그린 것이 된다 (손으로 그린 것과 같이 고친다).
   */
  async function runRouting({ keep = new Set() } = {}) {
    if (!state.ours || state.busy) return;
    state.busy = true; emit("busy");
    setStatus(`<span class="dot"></span><span>Routing — ALIGN router (wasm)${keep.size ? `, keeping ${keep.size} net${keep.size === 1 ? "" : "s"} you drew` : ""}</span>`);
    try {
      const blob = state.blob;
      const forOurs = state.ours;
      const frozen = keep.size && state.art ? frozenPaths(state.art, keep) : [];
      const m = await routing.send({ design: { topology: blob.topology, primitives: blob.primitives }, leaves: blob.leaves,
                                     placement: routePlacement(forOurs), frozen });
      routeSeq++; stash = null; state.routedFor = forOurs;
      applyRouted(m, { reveal: true, keep });
      const st = m.stats;
      if (m.warnings?.length) console.warn("[router warnings]\n" + m.warnings.join("\n"));
      // 셀 사이에 길이 없어 둘레에 트랙을 더 두고 배선했으면 그렇다고 (배선이 배치의 외곽 밖으로 나간다)
      const room = m.room ? ` — no path between the cells, so ${m.room.tracks} tracks (${(m.room.x / 1000).toFixed(1)} µm) of room were added around them` : "";
      setStatus(`<span>Routed — DRC/LVS ${m.nerrors} error${m.nerrors === 1 ? "" : "s"}, ${st.nets} nets` +
                `, router ${st.routerMs.toFixed(0)} ms, GDS ${(m.gds.byteLength / 1024) | 0} KB` +
                `  (${m.secs.toFixed(m.secs < 10 ? 2 : 1)} s)${esc(room)}</span>`);
    } catch (err) {
      const msg = (err.message || "").replace(/^(Error: )+/, "");
      sayErr(`Routing failed — ${msg}`);
      console.error("[routing failed]", err);
      state.routeFail = msg.slice(0, 160); state.routed = null; state.liveRec = null;
      emit("routing"); emit("reveal", "layout");
    } finally {
      state.busy = false; emit("busy");
    }
  }

  function applyRouted(m, { reveal = false, keep = new Set() } = {}) {
    const errs = (m.errors ?? []).map((t) => ({ text: t, file: "" }));
    state.liveRec = { errors: errs, nerrors: m.nerrors ?? errs.length, gdsBytes: m.gds?.byteLength ?? 0, gdsName: m.gdsName ?? "",
                      rects: m.geo?.terminals?.length ?? 0 };
    state.routed = m.geo ?? null;
    state.routeFail = null;
    state.lastRouted = m;
    app.editors?.routed(m, { keep });
    emit("routing");
    if (reveal) emit("reveal", "layout");
  }

  /** 편집기가 고친 배치. 배선은 늘 지금 배치의 것이다 — 다른 배치로 바뀌면 지우고(넣어 두고), 되돌아오면 다시 꺼낸다 */
  /** 편집기가 고친 배치. 그린 트랙은 그대로 남는다 (PCB 에서 부품을 옮겨도 트랙이 남듯) — 레이아웃 편집기가 연결을 다시 센다 */
  function setOurs(o) {
    if (state.routedFor && o !== state.routedFor) invalidateRouting();
    state.ours = o; state.frame = null;
    emit("placement");
  }

  /** 배선기의 마지막 결과(검사 보고 · GDS)는 그 배치의 것 — 배치가 바뀌면 버린다. 그린 트랙은 레이아웃 편집기에 남는다 */
  function invalidateRouting() {
    state.routed = null; state.liveRec = null; state.routeFail = null; state.lastRouted = null; state.routedFor = null;
    emit("routing");
  }

  // ---------------------------------------------------------------- 선택 연동 (회로도 <-> 레이아웃)
  const key = (s) => (s ? JSON.stringify([s.kind, s.names ?? s.name ?? null]) : "null");
  function select(sel, from = null) {
    if (key(sel) === key(state.selection)) return;
    state.selection = sel ? { ...sel, from } : null;
    emit("selection", state.selection);
    if (from !== "circuit" && state.link) toCircuit(state.selection);
  }
  function setProbe(p, from = null) {
    if (key(p) === key(state.probe)) return;
    state.probe = p ? { ...p, from } : null;
    emit("probe", state.probe);
  }

  /** 블록 -> 소자 (계층 안쪽까지) */
  function devicesOf(block) {
    const out = [];
    const walk = (mod, inst) => {
      const ds = state.groups?.[mod]?.[inst];
      if (ds) { out.push(...ds); return; }
      const m = state.blob?.topology?.modules?.find((x) => x.instances?.some((i) => i.instance_name === inst));
      const sub = m?.instances.find((i) => i.instance_name === inst)?.abstract_template_name;
      const subMod = state.blob?.topology?.modules?.find((x) => x.name === sub);
      if (subMod) for (const i of subMod.instances) walk(subMod.name, i.instance_name);
    };
    walk(state.key, block);
    return out;
  }

  /** 레이아웃에서 고른 것 -> 회로도에서 고르기 */
  function toCircuit(sel) {
    if (!state.netlist) return;
    if (!sel) { host.selectParts?.([]); host.highlightNet?.(null); return; }
    if (sel.kind === "block") {
      const devs = new Set(sel.names.flatMap(devicesOf));
      host.selectParts?.(Object.entries(state.netlist.devices).filter(([, d]) => devs.has(d)).map(([ref]) => ref));
    } else if (sel.kind === "net") host.highlightNet?.(state.netlist.nets[sel.name] ?? null);
  }

  /** 회로도에서 고른 부품 -> 레이아웃의 블록 */
  function fromCircuit(refs) {
    if (!state.link || !state.netlist || !state.blob) return;
    const devs = new Set(refs.map((r) => state.netlist.devices[r]).filter(Boolean));
    if (!devs.size) { if (state.selection?.from !== "circuit") return; select(null, "circuit"); return; }
    const top = state.blob.topology.modules.find((m) => m.name === state.key);
    const names = (top?.instances ?? []).map((i) => i.instance_name).filter((b) => devicesOf(b).some((d) => devs.has(d)));
    select(names.length ? { kind: "block", names } : null, "circuit");
  }

  function setSetting(k, v) { state.settings[k] = v; emit("settings"); }

  /** 내려받기 — 배치 JSON, 그리고 그린 판(셀 + 트랙)의 GDS · 검사 보고. 그린 것이 바뀌었으면 먼저 다시 검사한다 */
  function downloads() {
    const name = state.key ? state.key.toLowerCase() : "layout";
    const T = app.editors?.track;
    let drawn = null;
    if (T?.base()) {
      if (!T.te.checked || T.te.checked.ver !== T.art().ver) T.checkNow();
      const c = T.te.checked;
      if (c?.terminals) drawn = { gds: gdsArt(c, state.key ?? name), errors: c.errors, wires: T.art().wires.length, vias: T.art().vias.length };
    }
    return artifacts({ name, ours: state.ours, drawn, wiresEdited: !!app.editors?.wiresEdited?.() });
  }

  function attachEditors(ed) {
    app.editors = ed;
    if (state.ours) ed.placed(state.ours);
    if (state.lastRouted && state.routed) ed.routed(state.lastRouted);
    emit("edit");
  }

  Object.assign(app, {
    build, rebuild, stale, runPlacement, runRouting, applyRouted, setOurs, invalidateRouting,
    select, setProbe, fromCircuit, devicesOf, setSetting, setStatus, say, sayErr, downloads, attachEditors, hpwlWeight, lamRatio,
    designName: () => state.key,
    design: () => state.blob,
    emit,
  });
  return app;
}
