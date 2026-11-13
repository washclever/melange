/**
 * 어시스턴트가 보는 회로 — 요약(get_circuit), 요청마다 붙는 상황 설명, 사람이 고친 것의 차이.
 *
 * 모델에게는 **연결**로 보여 준다: 부품마다 핀이 어느 넷에 있는지, 넷마다 어느 핀이 있는지.
 * 좌표는 격자 칸 단위(1칸 = 100 mil)로만 준다 — 내부의 10 mil 단위를 보여 주면 모델이 격자 밖 좌표를
 * 만든다. 자동 넷 이름(N001…)은 편집할 때마다 번호가 밀릴 수 있어 참조로는 핀(R1.2)을 쓰게 한다.
 *
 * 순수한 계산이다. 문서 · 라이브러리 · 넷 추출만 받는다.
 */
import { GRID, type Id, type LibPart, type Part, type Pt, type Sheet, type SimSettings } from "../doc/types.ts";
import type { Extraction } from "../net/extract.ts";
import type { Issue } from "../net/netlist.ts";
import type { PinRef } from "../doc/wiring.ts";

/** 모델이 틀린 인자를 줬다. 그 말이 모델에게 그대로 돌아간다 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** 내부 좌표 -> 격자 칸 */
export const toGrid = (p: Pt): [number, number] => [p[0] / GRID, p[1] / GRID];
/** 격자 칸 -> 내부 좌표 */
export const fromGrid = (p: readonly number[]): Pt => [Math.round(Number(p[0])) * GRID, Math.round(Number(p[1])) * GRID];

const isGround = (p: Part, library: Record<string, LibPart>) => (library[p.lib]?.id ?? p.lib) === "gnd";

/** 지정자로 부품을 찾는다 (대소문자 무관 — 넷리스트도 가리지 않는다). id 도 받는다 */
export function findPart(sheet: Sheet, ref: string): Part | undefined {
  const want = ref.trim().toLowerCase();
  return sheet.parts.find(p => p.ref.toLowerCase() === want) ?? sheet.parts.find(p => p.id === ref);
}

/** 부품 하나를 찾거나, 없으면 모델이 고칠 수 있게 알려 준다 */
export function needPart(sheet: Sheet, ref: unknown): Part {
  if (typeof ref !== "string" || !ref.trim()) throw new ToolError("A part designator such as \"R1\" is needed.");
  const p = findPart(sheet, ref);
  if (!p) throw new ToolError(`There is no part "${ref}". Call get_circuit for the designators.`);
  return p;
}

/** "R1.2" · "Q1.b" · "U1.out" 의 핀. 핀이 하나뿐인 부품(GND)은 지정자만 써도 된다 */
export function needPin(sheet: Sheet, library: Record<string, LibPart>, text: unknown): PinRef {
  if (typeof text !== "string" || !text.trim()) throw new ToolError("A pin such as \"R1.2\" is needed.");
  const s = text.trim();
  const dot = s.search(/[.:](?=[^.:]*$)/);
  const ref = dot > 0 ? s.slice(0, dot) : s;
  const pinId = dot > 0 ? s.slice(dot + 1) : "";
  const part = findPart(sheet, ref);
  if (!part) throw new ToolError(`There is no part "${ref}" (from "${s}"). Call get_circuit for the designators.`);
  const lib = library[part.lib];
  if (!lib) throw new ToolError(`${part.ref} has no definition in the project library.`);
  const pins = lib.symbol.pins;
  let i = pinId ? pins.findIndex(p => p.id.toLowerCase() === pinId.toLowerCase()) : pins.length === 1 ? 0 : -1;
  if (i < 0 && pinId) i = pins.findIndex(p => p.name.toLowerCase() === pinId.toLowerCase());
  if (i < 0) {
    const list = pins.map(p => `${part.ref}.${p.id}`).join(", ");
    throw new ToolError(pinId ? `${part.ref} has no pin "${pinId}". Its pins: ${list}.` : `Say which pin of ${part.ref}: ${list}.`);
  }
  return { part, lib, i };
}

/** 핀의 이름 "R1.2" */
export const pinName = (part: Part, lib: LibPart, i: number): string => `${part.ref}.${lib.symbol.pins[i].id}`;

/** 핀 이름 -> 넷 이름. GND 기호의 핀은 뺀다 (넷 0 이 그것이다) */
export function pinTable(sheet: Sheet, library: Record<string, LibPart>, ex: Extraction): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of sheet.parts) {
    const lib = library[p.lib];
    if (!lib || isGround(p, library)) continue;
    lib.symbol.pins.forEach((pin, i) => {
      const net = ex.pinNet.get(p.id + ":" + pin.id);
      if (net !== undefined) out.set(pinName(p, lib, i), net);
    });
  }
  return out;
}

/** 넷 이름 -> 그 넷의 핀들 */
export function netTable(pins: ReadonlyMap<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [pin, net] of pins) {
    const l = out.get(net);
    if (l) l.push(pin); else out.set(net, [pin]);
  }
  return out;
}

/** 해석 설정을 한 줄로 */
export function simText(s: SimSettings): string {
  const kv = Object.entries(s).filter(([k]) => k !== "kind").map(([k, v]) => `${k}=${v}`);
  return [s.kind, ...kv].join(" ");
}

// ── get_circuit ───────────────────────────────────────────────────────
export interface SummaryInput {
  name: string;
  sheet: Sheet;
  library: Record<string, LibPart>;
  ex: Extraction;
  sim: SimSettings;
  meas: readonly string[];
  calc: readonly string[];
  issues: readonly Issue[];
  external: boolean;
}

/** 부품이 이보다 많으면 기본은 요약만 (refs · nets 로 골라 보게) */
export const DETAIL_LIMIT = 150;

/**
 * get_circuit 의 답. refs · nets 를 주면 그 부품 · 그 넷에 든 부품만 자세히 준다.
 * 부품이 아주 많은 회로에서 대화가 회로 설명으로 다 차지 않게 하려는 것이다.
 */
export function summarize(inp: SummaryInput, filter: { refs?: string[]; nets?: string[] } = {}): Record<string, unknown> {
  const { sheet, library, ex } = inp;
  const pins = pinTable(sheet, library, ex);
  const nets = netTable(pins);
  const wantRefs = new Set((filter.refs ?? []).map(r => r.toLowerCase()));
  const wantNets = new Set((filter.nets ?? []).map(n => n.toLowerCase()));
  for (const [net, members] of nets) {
    if (wantNets.has(net.toLowerCase())) for (const m of members) wantRefs.add(m.split(".")[0].toLowerCase());
  }
  const filtered = wantRefs.size > 0 || wantNets.size > 0;
  const real = sheet.parts.filter(p => !isGround(p, library));
  const detailed = filtered ? real.filter(p => wantRefs.has(p.ref.toLowerCase())) : real.length <= DETAIL_LIMIT ? real : [];

  const out: Record<string, unknown> = {
    name: inp.name,
    coordinates: "grid units (1 = 100 mil), x to the right, y down",
  };
  if (inp.external) {
    out.mode = "An external netlist is open as text. The schematic below is not what runs; editing tools are refused. " +
      "get_netlist shows the text that runs.";
  }
  out.parts = detailed.map(p => {
    const lib = library[p.lib];
    const pinNets: Record<string, string> = {};
    lib?.symbol.pins.forEach((pin, i) => {
      const n = pins.get(pinName(p, lib, i));
      if (n !== undefined) pinNets[pin.id] = n;
    });
    const o: Record<string, unknown> = { ref: p.ref, type: lib?.id ?? p.lib, params: { ...p.params }, pins: pinNets, at: toGrid(p.at) };
    if (p.rot) o.rot = p.rot;
    if (p.mirror) o.mirror = true;
    if (p.nc?.length) o.no_connect = p.nc;
    return o;
  });
  if (!filtered && real.length > DETAIL_LIMIT) {
    const byType = new Map<string, number>();
    for (const p of real) byType.set(library[p.lib]?.id ?? p.lib, (byType.get(library[p.lib]?.id ?? p.lib) ?? 0) + 1);
    out.parts_summary = Object.fromEntries(byType);
    out.note = `${real.length} parts — too many to list. Pass refs (designators) or nets to get_circuit to see some of them.`;
  }
  const grounds = sheet.parts.length - real.length;
  if (grounds) out.ground_symbols = grounds;

  const netOut: Record<string, string[]> = {};
  for (const [net, members] of [...nets].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (filtered && !wantNets.has(net.toLowerCase()) && !members.some(m => wantRefs.has(m.split(".")[0].toLowerCase()))) continue;
    if (!filtered && real.length > DETAIL_LIMIT && members.length > 40) { netOut[net] = [...members.slice(0, 40), `… ${members.length - 40} more`]; continue; }
    netOut[net] = members;
  }
  if (!filtered && real.length > DETAIL_LIMIT && Object.keys(netOut).length > 200) {
    out.net_count = Object.keys(netOut).length;
  } else out.nets = netOut;

  out.labels = sheet.labels.map(l => ({ name: l.name, kind: l.kind, at: toGrid(l.at) }));
  if (sheet.spice.length) out.directives = sheet.spice.map(b => ({ id: b.id, active: b.active, lines: b.lines }));
  if (sheet.notes.length) out.notes = sheet.notes.length;
  out.analysis = { ...inp.sim };
  out.measures = [...inp.meas];
  out.calculator = [...inp.calc];
  out.probes = sheet.probes.map(p => ex.netAt(p.at)).filter((n): n is string => !!n);
  out.issues = inp.issues.map(i => ({ level: i.level, message: i.message }));
  const floating = floatingPins(sheet, library, ex);
  if (floating.length) out.unconnected_pins = floating;
  return out;
}

/** 아무것도 안 붙은 핀 (미연결 표시를 단 핀은 뺀다) */
export function floatingPins(sheet: Sheet, library: Record<string, LibPart>, ex: Extraction): string[] {
  const out: string[] = [];
  const keys = ex.floating?.pins;
  if (!keys) return out;
  for (const k of keys) {
    const [id, pinId] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    const p = sheet.parts.find(x => x.id === id);
    const lib = p && library[p.lib];
    if (!p || !lib || p.nc?.includes(pinId) || isGround(p, library)) continue;
    out.push(`${p.ref}.${pinId}`);
  }
  return out.sort();
}

// ── 사람이 고친 것 ────────────────────────────────────────────────────
/** 문서의 한 순간. 차이를 내는 데만 쓴다 */
export interface Snapshot {
  parts: Map<Id, { ref: string; type: string; params: Record<string, string>; pose: string }>;
  /** 핀(부품 id:핀 id) -> 같은 넷의 다른 핀들 (지정자로, 정렬해서). 넷 이름이 아니라 함께 있는 핀으로 본다 */
  conn: Map<string, string>;
  /** 핀(부품 id:핀 id) -> "R1.2" */
  names: Map<string, string>;
  labels: Map<Id, string>;
  blocks: Map<Id, string>;
  sim: string;
  meas: string;
  calc: string;
  probes: string;
  notes: number;
}

export function snapshot(inp: SummaryInput): Snapshot {
  const { sheet, library, ex } = inp;
  const parts = new Map<Id, { ref: string; type: string; params: Record<string, string>; pose: string }>();
  const names = new Map<string, string>();
  const byNet = new Map<string, string[]>();
  for (const p of sheet.parts) {
    const lib = library[p.lib];
    const type = lib?.id ?? p.lib;
    const ground = type === "gnd";
    if (!ground) {
      parts.set(p.id, {
        ref: p.ref, type, params: { ...p.params },
        pose: `at (${toGrid(p.at).join(", ")})${p.rot ? ` rot ${p.rot}` : ""}${p.mirror ? " mirrored" : ""}`,
      });
    }
    lib?.symbol.pins.forEach((pin, i) => {
      const key = p.id + ":" + pin.id;
      const net = ex.pinNet.get(key);
      // GND 기호는 핀 이름이 아니라 '접지' 로 본다 — GND2 를 GND1 로 바꿔 놓아도 같은 연결이다
      const name = ground ? "GND" : pinName(p, lib, i);
      if (!ground) names.set(key, name);
      if (net === undefined) return;
      const l = byNet.get(net);
      if (l) l.push(name); else byNet.set(net, [name]);
    });
  }
  const conn = new Map<string, string>();
  for (const [key, name] of names) {
    const net = ex.pinNet.get(key);
    const members = net === undefined ? [] : [...new Set(byNet.get(net) ?? [])].filter(m => m !== name).sort();
    conn.set(key, members.join(", "));
  }
  return {
    parts, conn, names,
    labels: new Map(sheet.labels.map(l => [l.id, `${l.kind === "label" ? "net label" : l.kind === "power" ? "supply symbol" : "ground label"} ${l.name}`])),
    blocks: new Map(sheet.spice.map(b => [b.id, `${b.active ? "" : "(off) "}${b.lines.join(" | ")}`])),
    sim: simText(inp.sim),
    meas: inp.meas.join(" | "),
    calc: inp.calc.join(" | "),
    probes: sheet.probes.map(p => ex.netAt(p.at) ?? "?").sort().join(", "),
    notes: sheet.notes.length,
  };
}

/** 바뀐 것 하나. from · to 가 null 이면 없던 것 · 없어진 것 */
export interface Change { key: string; from: string | null; to: string | null; label?: string }

/** 두 순간의 차이 */
export function diffSnapshots(a: Snapshot, b: Snapshot): Change[] {
  const out: Change[] = [];
  const put = (key: string, from: string | null, to: string | null, label?: string) => {
    if (from !== to) out.push({ key, from, to, label });
  };
  for (const id of new Set([...a.parts.keys(), ...b.parts.keys()])) {
    const x = a.parts.get(id), y = b.parts.get(id);
    put("part:" + id, x ? `${x.ref} (${x.type})` : null, y ? `${y.ref} (${y.type})` : null);
    if (!x || !y) continue;
    put("ref:" + id, x.ref, y.ref);
    for (const k of new Set([...Object.keys(x.params), ...Object.keys(y.params)])) {
      put(`param:${id}:${k}`, x.params[k] ?? null, y.params[k] ?? null, `${y.ref} ${k}`);
    }
    put("pose:" + id, x.pose, y.pose, y.ref);
  }
  for (const key of new Set([...a.conn.keys(), ...b.conn.keys()])) {
    put("conn:" + key, a.conn.get(key) ?? null, b.conn.get(key) ?? null, b.names.get(key) ?? a.names.get(key));
  }
  for (const id of new Set([...a.labels.keys(), ...b.labels.keys()])) put("label:" + id, a.labels.get(id) ?? null, b.labels.get(id) ?? null);
  for (const id of new Set([...a.blocks.keys(), ...b.blocks.keys()])) put("block:" + id, a.blocks.get(id) ?? null, b.blocks.get(id) ?? null);
  put("sim", a.sim, b.sim);
  put("meas", a.meas, b.meas);
  put("calc", a.calc, b.calc);
  put("probes", a.probes, b.probes);
  put("notes", String(a.notes), String(b.notes));
  return out;
}

/**
 * 사람이 고친 것을 모아 둔다. 같은 것을 여러 번 고쳤으면 처음 값에서 마지막 값으로 하나로 합치고,
 * 되돌려 원래대로 돌아갔으면 지운다 — 어시스턴트에게는 "그래서 지금 무엇이 달라졌나" 만 알려 준다.
 * 사람의 편집 사이사이에 어시스턴트의 편집이 끼어도 된다: 각 편집의 차이를 그때그때 쌓기 때문이다.
 */
export class ChangeLog {
  private readonly pending = new Map<string, Change>();

  add(changes: readonly Change[]): void {
    for (const c of changes) {
      const was = this.pending.get(c.key);
      const merged: Change = was ? { key: c.key, from: was.from, to: c.to, label: c.label ?? was.label } : { ...c };
      if (merged.from === merged.to) this.pending.delete(c.key);
      else this.pending.set(c.key, merged);
    }
  }

  get size(): number { return this.pending.size; }

  clear(): void { this.pending.clear(); }

  /** 사람이 읽을(모델이 읽을) 줄들. 많으면 줄인다 */
  describe(limit = 30): string[] {
    const lines: string[] = [];
    const cs = [...this.pending.values()];
    const removedParts = new Set<string>();
    for (const c of cs) {
      if (!c.key.startsWith("part:")) continue;
      if (c.from === null) lines.push(`added ${c.to}`);
      else if (c.to === null) { lines.push(`deleted ${c.from}`); removedParts.add(c.key.slice(5)); }
    }
    for (const c of cs) {
      const k = c.key;
      if (k.startsWith("ref:")) lines.push(`renamed ${c.from} to ${c.to}`);
      else if (k.startsWith("param:")) lines.push(`${c.label}: ${c.from ?? "(none)"} -> ${c.to ?? "(none)"}`);
      else if (k.startsWith("pose:")) lines.push(`moved ${c.label}: ${c.from} -> ${c.to}`);
      else if (k.startsWith("label:")) lines.push(c.from === null ? `added ${c.to}` : c.to === null ? `removed ${c.from}` : `${c.from} -> ${c.to}`);
      else if (k.startsWith("block:")) lines.push(c.from === null ? `added SPICE directive: ${c.to}` : c.to === null ? `removed SPICE directive: ${c.from}` : `SPICE directive: ${c.from} -> ${c.to}`);
      else if (k === "sim") lines.push(`analysis: ${c.from} -> ${c.to}`);
      else if (k === "meas") lines.push(`.meas lines: ${c.to || "(none)"}`);
      else if (k === "calc") lines.push(`calculator rows: ${c.to || "(none)"}`);
      else if (k === "probes") lines.push(`probes: ${c.to || "(none)"}`);
      else if (k === "notes") lines.push(`annotations: ${c.from} -> ${c.to}`);
    }
    // 연결: 같은 핀들과 함께하게 된 핀을 한 줄로 묶는다
    const groups = new Map<string, string[]>();
    for (const c of cs) {
      if (!c.key.startsWith("conn:") || c.to === null || !c.label) continue;
      if (removedParts.has(c.key.slice(5, c.key.lastIndexOf(":")))) continue;
      const together = [c.label, ...(c.to ? c.to.split(", ") : [])].sort();
      const sig = together.join(", ");
      groups.set(sig, together);
    }
    for (const together of groups.values()) {
      lines.push(together.length === 1 ? `${together[0]} is now unconnected` : `now together on one net: ${together.join(", ")}`);
    }
    if (lines.length > limit) return [...lines.slice(0, limit), `… and ${lines.length - limit} more changes (call get_circuit)`];
    return lines;
  }
}
