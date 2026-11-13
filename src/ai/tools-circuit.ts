/**
 * 회로를 읽고 고치는 도구.
 *
 * 고치는 도구는 모두 명령을 만들어 host.edit 로 넘긴다 — 사람이 고칠 때와 같은 기록을 거치므로
 * 요청 하나가 실행 취소 한 단계로 묶이고(History 의 꼬리표), 자동 저장 · 넷 추출 · 화면이 그대로 따라온다.
 * 인자는 **먼저 다 검사하고** 그다음 적용한다. 잘못된 인자 하나 때문에 반만 고쳐진 회로가 남지 않게.
 */
import {
  addObjects, addPart, addProbe, batch, removeObjects, renameLabel, setCalc, setMeas, setParam, setRef, setSim, setSpiceBlock,
  type Command, type Ref,
} from "../doc/history.ts";
import { makePart, moveCommand, xformCommand } from "../doc/ops.ts";
import {
  GRID, PROBE_COLORS, defaultSim, pinAt, snapPt, uid,
  type LibPart, type Part, type Pt, type SimSettings, type SpiceBlock,
} from "../doc/types.ts";
import { megaWarning, parseEng } from "../doc/units.ts";
import {
  connectPins, connectToNet, contentBox, deleteParts, findSpot, onlyMerged, pinNets, type PinRef,
} from "../doc/wiring.ts";
import { ABOUT, LIBRARIES } from "../lib/catalog.ts";
import { spToProject } from "../io/import-sp.ts";
import { BUILTIN } from "../lib/parts.ts";
import { checkAnalysis, deviceLines, modelLine } from "../net/netlist.ts";
import {
  ToolError, fromGrid, needPart, needPin, pinName, pinTable, summarize, toGrid, type SummaryInput,
} from "./circuit.ts";
import { S, list, point, rotation, text, type Json, type Tool, type ToolContext } from "./tool-kit.ts";
import type { AssistantHost } from "./host.ts";

/** 요약에 넣을 것 (host 에서 모은다) */
export function summaryInput(host: AssistantHost): SummaryInput {
  const p = host.project();
  return {
    name: p.name, sheet: host.sheet(), library: host.library(), ex: host.extraction(), sim: p.sim,
    meas: p.meas ?? [], calc: p.calc ?? [], issues: host.issues(), external: host.external(),
  };
}

/** 명령을 이 요청의 단계로 적용한다 */
const apply = (ctx: ToolContext, cmd: Command) => ctx.host.edit(cmd, ctx.group);

/** 라이브러리에서 부품 종류를 찾는다 (내장 부품, 또는 이 프로젝트에 들어온 것 — 외부 .sp 의 모델 부품) */
function partType(host: AssistantHost, type: unknown): LibPart {
  if (typeof type !== "string" || !type.trim()) throw new ToolError("type is needed — a part type id such as \"r\" or \"opamp\".");
  const id = type.trim();
  const lib = BUILTIN[id] ?? host.library()[id] ?? BUILTIN[id.toLowerCase()];
  if (!lib) {
    const ids = Object.keys(BUILTIN).join(", ");
    throw new ToolError(`There is no part type "${type}". Types: ${ids}. get_part_types describes them.`);
  }
  return lib;
}

/**
 * 파라미터 값 검사. 없는 키는 거부하고 (그 부품의 키를 알려 준다), 범위를 벗어난 값도 거부한다 —
 * 실행 전 검사가 어차피 막는다. 메가로 쓴 듯한 1M 은 고치지 않고 경고만 한다 (밀리일 수도 있다).
 */
function checkParams(lib: LibPart, ref: string, given: unknown, warn: string[]): Record<string, string> {
  if (given === undefined || given === null) return {};
  if (typeof given !== "object" || Array.isArray(given)) throw new ToolError(`params of ${ref} must be an object such as {"value": "10k"}.`);
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(given as Json)) {
    const def = lib.params.find(p => p.key === k) ?? lib.params.find(p => p.key.toLowerCase() === k.toLowerCase());
    if (!def) {
      const keys = lib.params.map(p => p.key).join(", ") || "(none)";
      throw new ToolError(`${ref} (${lib.id}) has no parameter "${k}". Its parameters: ${keys}.`);
    }
    if (typeof raw !== "string" && typeof raw !== "number") throw new ToolError(`${ref} ${k} must be a string such as "10k".`);
    const v = String(raw).trim();
    if (!v) throw new ToolError(`${ref} ${k} is empty.`);
    if (!/^[\x20-\x7e]*$/.test(v)) throw new ToolError(`${ref} ${k} must be plain ASCII (write u for micro): "${v}".`);
    const n = parseEng(v);
    if (n !== null && /^[-+.\d]/.test(v)) {
      if (def.min !== undefined && n < def.min) throw new ToolError(`${ref} ${k} = ${v} is below its minimum ${def.min}.`);
      if (def.max !== undefined && n > def.max) throw new ToolError(`${ref} ${k} = ${v} is above its maximum ${def.max}.`);
    }
    const mega = megaWarning(v);
    if (mega) warn.push(`${ref} ${k}: ${mega}`);
    out[def.key] = v;
  }
  return out;
}

/** 부품의 핀 좌표 (격자 칸) */
function pinsOf(part: Part, lib: LibPart): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  lib.symbol.pins.forEach((p, i) => { out[p.id] = toGrid(pinAt(part, lib, i)); });
  return out;
}

/** 넷 하나에 프로브를 꽂을 자리 — 그 넷의 핀, 없으면 라벨 */
function spotOnNet(host: AssistantHost, net: string): Pt | null {
  const sheet = host.sheet(), lib = host.library(), ex = host.extraction();
  const want = net.toLowerCase();
  for (const p of sheet.parts) {
    const l = lib[p.lib];
    if (!l || l.id === "gnd") continue;
    for (let i = 0; i < l.symbol.pins.length; i++) {
      if (ex.pinNet.get(p.id + ":" + l.symbol.pins[i].id)?.toLowerCase() === want) return pinAt(p, l, i);
    }
  }
  const label = sheet.labels.find(l => ex.netAt(l.at)?.toLowerCase() === want);
  return label ? label.at : null;
}

/** 지시문 블록에 두면 안 되는 줄 — 제자리 도구가 따로 있거나, 브라우저에서 돌 수 없다 */
function badDirective(line: string): string | null {
  const t = line.trim().toLowerCase();
  if (/^\.(control|endc)\b/.test(t)) return "control blocks (.control … .endc) are not allowed — the app runs the analysis itself";
  if (/^\.end\b(?!s)/.test(t)) return ".end is added by the netlist generator";
  if (/^\.(include|inc|lib)\b/.test(t)) return ".include / .lib cannot reach files from a browser — put the model text in the block instead";
  if (/^\.(tran|ac|dc|op|noise|tf)\b/.test(t)) return "analysis lines belong in set_analysis";
  if (/^\.meas(ure)?\b/.test(t)) return ".meas lines belong in set_measures";
  return null;
}

export const circuitTools: Tool[] = [
  // ── 읽기 ────────────────────────────────────────────────────────────
  {
    name: "get_circuit",
    description:
      "The circuit as it is now: parts (designator, type, parameter values, the net of each pin, position), nets (which pins each net joins), " +
      "net labels, SPICE directive blocks, analysis settings, .meas lines, calculator rows, probes, pre-run issues and unconnected pins. " +
      "Call it before editing. For big circuits pass refs or nets to see only part of it.",
    params: {
      refs: S.strs("Only these parts (designators), with the nets they touch"),
      nets: S.strs("Only these nets, with the parts on them"),
    },
    run({ host, args }) {
      const data = summarize(summaryInput(host), { refs: list<string>(args.refs, "refs"), nets: list<string>(args.nets, "nets") });
      const n = (data.parts as unknown[]).length;
      return { data, summary: `${n} part${n === 1 ? "" : "s"}` };
    },
  },
  {
    name: "get_part_types",
    description:
      "Details of part types: pins (id, name, role, offset from the part origin in grid units at rotation 0, and the side the pin faces), " +
      "parameters (key, unit, default, range), the SPICE line each part makes and what it is for. Without types it lists every type briefly.",
    params: { types: S.strs("Part type ids, for example [\"opamp\", \"nmos\"]") },
    run({ host, args }) {
      const types = list<string>(args.types, "types");
      if (!types.length) {
        const out = LIBRARIES.map(l => ({
          library: l.name,
          groups: l.groups.map(g => ({ group: g.name, types: g.parts.map(id => ({ type: id, name: BUILTIN[id]?.name, about: ABOUT[id]?.text })) })),
        }));
        return { data: out, summary: "catalog" };
      }
      const out = types.map(t => {
        const lib = partType(host, t);
        const about = ABOUT[lib.id];
        const sample = { id: "x", lib: lib.id, ref: lib.refPrefix + "1", at: [0, 0], rot: 0, mirror: false, params: {} } as Part;
        const pinNamesById = Object.fromEntries(lib.symbol.pins.map(p => [p.id, p.name]));
        const sideName = ["right", "down", "left", "up"];
        return {
          type: lib.id, name: lib.name, designator_prefix: lib.refPrefix, about: about?.text,
          pins: lib.symbol.pins.map((p, i) => {
            const side = p.at[0] > 0 && Math.abs(p.at[0]) >= Math.abs(p.at[1]) ? 0 : p.at[1] > 0 && Math.abs(p.at[1]) >= Math.abs(p.at[0]) ? 1 : p.at[0] < 0 && Math.abs(p.at[0]) >= Math.abs(p.at[1]) ? 2 : 3;
            return { id: p.id, name: p.name, role: about?.pins?.[p.id], offset: toGrid(pinAt(sample, lib, i)), faces: sideName[side] };
          }),
          params: lib.params.map(p => ({ key: p.key, label: p.label, unit: p.unit || undefined, default: p.default, min: p.min, max: p.max })),
          spice: lib.spice
            ? deviceLines({ ...sample, params: Object.fromEntries(lib.params.map(p => [p.key, p.default])) }, lib, id => pinNamesById[id] ?? id, host.project().sim)
            : "(no SPICE line — only joins its net to node 0)",
          model: lib.spice?.model ? modelLine({ ...sample, params: Object.fromEntries(lib.params.map(p => [p.key, p.default])) }, lib) : undefined,
        };
      });
      return { data: out, summary: types.join(", ") };
    },
  },
  {
    name: "get_netlist",
    description: "The SPICE netlist the simulator gets, as the Netlist tab shows it (generated from the schematic, or the external netlist text when one is open).",
    run({ host }) {
      const text = host.netlist();
      return { data: { external: host.external(), netlist: text.length > 20000 ? text.slice(0, 20000) + "\n* … (cut)" : text }, summary: `${text.split("\n").length} lines` };
    },
  },

  // ── 부품 ────────────────────────────────────────────────────────────
  {
    name: "place_parts",
    description:
      "Place parts. Each gets the next free designator unless you give one, and the default parameters unless you give params. " +
      "at is the part origin in grid units (optional — without it the part goes to the right of the drawing). " +
      "A part is never put where one of its pins would touch an existing net: it moves to the nearest free spot and the result says where. " +
      "Then wire the pins with connect.",
    params: {
      parts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: S.str("Part type id (see the parts table, or get_part_types)"),
            ref: S.str("Designator, for example R3 (optional)"),
            at: S.xy("Origin in grid units [x, y] (optional)"),
            rot: S.rot(),
            mirror: S.bool("Mirror horizontally"),
            params: { type: "object", description: "Parameter values by key, for example {\"value\": \"10k\"}", additionalProperties: { type: "string" } },
          },
          required: ["type"],
        },
      },
    },
    required: ["parts"],
    edits: true,
    run(ctx) {
      const { host, args } = ctx;
      const specs = list<Json>(args.parts, "parts");
      if (!specs.length) throw new ToolError("parts is empty.");
      if (specs.length > 60) throw new ToolError("At most 60 parts per call.");
      const sheet = host.sheet(), library = host.library();
      const warn: string[] = [];
      const taken = new Set(sheet.parts.map(p => p.ref.toLowerCase()));
      // 먼저 다 검사한다
      const plan = specs.map((s, k) => {
        const lib = partType(host, s.type);
        const ref = s.ref === undefined || s.ref === null || s.ref === "" ? null : text(s.ref, "ref", 32).trim();
        if (ref !== null) {
          if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(ref)) throw new ToolError(`Designator "${ref}" must start with a letter and use letters, digits or _.`);
          if (taken.has(ref.toLowerCase())) throw new ToolError(`${ref} is already used. Leave ref out to get the next free one.`);
          taken.add(ref.toLowerCase());
        }
        const params = checkParams(lib, ref ?? `${lib.refPrefix}? (part ${k + 1})`, s.params, warn);
        const at = s.at === undefined || s.at === null ? null : fromGrid(point(s.at, "at"));
        return { lib, ref, params, at, rot: rotation(s.rot), mirror: s.mirror === true };
      });
      // 자리를 정해 하나씩 놓는다. 앞에 놓은 것이 다음 것의 장애물이다 (편집할 때마다 색인 · 넷이 맞춰진다)
      const box = contentBox(sheet, library);
      let autoX = box ? Math.ceil((box[2] + 6 * GRID) / GRID) * GRID : 0;
      const autoY = box ? Math.round(box[1] / GRID) * GRID + 2 * GRID : 0;
      const placed: Json[] = [];
      for (const p of plan) {
        const want = p.at ?? snapPt([autoX, autoY]);
        const ex = host.extraction();
        const spot = findSpot(host.sheet(), library, host.index(), q => ex.netAt(q), p.lib, want, p.rot, p.mirror);
        if (!spot) throw new ToolError(`No free spot near (${toGrid(want).join(", ")}) for a ${p.lib.id}. ${placed.length ? `${placed.length} part(s) were placed before this one.` : ""}`);
        const part = makePart(library, host.sheet(), p.lib.id, spot, p.rot, p.mirror, p.params, p.ref ?? undefined);
        apply(ctx, addPart(part));
        const lib = library[part.lib];
        const o: Json = { ref: part.ref, type: lib.id, at: toGrid(part.at), pins: pinsOf(part, lib) };
        if (part.rot) o.rot = part.rot;
        if (part.mirror) o.mirror = true;
        if (spot[0] !== want[0] || spot[1] !== want[1]) o.moved_from = toGrid(want);
        placed.push(o);
        if (!p.at) {
          const w = lib.symbol.pins.reduce((m, q) => Math.max(m, Math.abs(q.at[0])), 10);
          autoX = spot[0] + 2 * w + 4 * GRID;
        }
      }
      return { data: { placed, ...(warn.length ? { warnings: warn } : {}) }, summary: placed.map(p => p.ref).join(", ") };
    },
  },
  {
    name: "connect",
    description:
      "Wire pins together. Each link joins pin `from` to pin `to` (for example \"R1.2\" to \"C1.1\"), or puts pin `from` on the named net `net` " +
      "(\"0\" is ground and places a GND symbol; other names place a short stub with a net label, or a supply symbol with kind \"power\"). " +
      "Wires are routed automatically and never touch anything else; when no clean route exists the pins are joined by net labels instead. " +
      "Pins already on the same net are left alone.",
    params: {
      links: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: S.str("Pin, for example \"R1.2\" or \"Q1.b\""),
            to: S.str("The other pin"),
            net: S.str("Or a net name to put the pin on (\"0\" = ground)"),
            kind: { type: "string", enum: ["label", "power"], description: "For net: a net label (default) or a supply symbol" },
          },
          required: ["from"],
        },
      },
    },
    required: ["links"],
    edits: true,
    run(ctx) {
      const { host, args } = ctx;
      const links = list<Json>(args.links, "links");
      if (!links.length) throw new ToolError("links is empty.");
      // 핀 이름이 다 맞는지 먼저 본다
      const sheet0 = host.sheet(), lib0 = host.library();
      const checked = links.map(l => {
        const a = needPin(sheet0, lib0, l.from);
        if (l.to !== undefined && l.to !== null && l.to !== "") return { l, a, b: needPin(sheet0, lib0, l.to) as PinRef, net: null };
        if (typeof l.net !== "string" || !l.net.trim()) throw new ToolError(`Link from ${l.from} needs "to" (a pin) or "net" (a net name).`);
        const net = l.net.trim();
        if (!/^[A-Za-z0-9_+\-]+$/.test(net)) throw new ToolError(`Net name "${net}" may use letters, digits, _ + - only.`);
        return { l, a, b: null, net };
      });
      const done: Json[] = [];
      const failed: Json[] = [];
      for (const c of checked) {
        const sheet = host.sheet(), library = host.library(), index = host.index();
        const fromName = pinName(c.a.part, c.a.lib, c.a.i);
        if (c.b) {
          const toName = pinName(c.b.part, c.b.lib, c.b.i);
          const w = connectPins(sheet, library, index, c.a, c.b, `${c.a.part.ref}_${c.a.lib.symbol.pins[c.a.i].id}`.toLowerCase());
          if (!w) {
            const pins = pinNets(sheet, library);
            const same = pins.get(c.a.part.id + ":" + c.a.lib.symbol.pins[c.a.i].id) === pins.get(c.b.part.id + ":" + c.b.lib.symbol.pins[c.b.i].id);
            if (same) done.push({ from: fromName, to: toName, via: "already connected" });
            else failed.push({ from: fromName, to: toName, error: "no clean route and no room for net labels — move one of the parts" });
            continue;
          }
          apply(ctx, w.cmd);
          done.push({ from: fromName, to: toName, via: w.via, ...(w.name ? { label: w.name } : {}) });
        } else {
          const kind = c.l.kind === "power" ? "power" : "label";
          const w = connectToNet(sheet, library, index, c.a, c.net!, kind);
          if (w === null) { done.push({ from: fromName, net: c.net, via: "already on that net" }); continue; }
          if (typeof w === "string") { failed.push({ from: fromName, net: c.net, error: w }); continue; }
          apply(ctx, w.cmd);
          done.push({ from: fromName, net: w.name, via: c.net === "0" || /^gnd$/i.test(c.net!) ? "ground symbol" : kind === "power" ? "supply symbol" : "net label" });
        }
      }
      // 이은 뒤의 넷 이름 (자동 이름이 바뀌었을 수 있다)
      const pins = pinTable(host.sheet(), host.library(), host.extraction());
      for (const d of done) d.net_now = pins.get(String(d.from)) ?? (String(d.from).toLowerCase().startsWith("gnd") ? "0" : undefined);
      return {
        data: { connected: done, ...(failed.length ? { failed } : {}) },
        summary: `${done.length} link${done.length === 1 ? "" : "s"}${failed.length ? `, ${failed.length} failed` : ""}`,
      };
    },
  },
  {
    name: "set_params",
    description: "Change parameter values (for example R1 value to \"4.7k\") and designators of placed parts. Values use SPICE suffixes: f p n u m k meg g — M is milli, mega is meg.",
    params: {
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ref: S.str("Designator of the part"),
            params: { type: "object", description: "New values by parameter key", additionalProperties: { type: "string" } },
            new_ref: S.str("A new designator (optional)"),
          },
          required: ["ref"],
        },
      },
    },
    required: ["changes"],
    edits: true,
    run(ctx) {
      const { host, args } = ctx;
      const sheet = host.sheet(), library = host.library();
      const changes = list<Json>(args.changes, "changes");
      if (!changes.length) throw new ToolError("changes is empty.");
      const warn: string[] = [];
      const cmds: Command[] = [];
      const out: Json[] = [];
      const refs = new Map(sheet.parts.map(p => [p.ref.toLowerCase(), p.id]));
      for (const c of changes) {
        const part = needPart(sheet, c.ref);
        const lib = library[part.lib];
        if (!lib) throw new ToolError(`${part.ref} has no definition.`);
        const params = checkParams(lib, part.ref, c.params, warn);
        const changed: Json = {};
        for (const [k, v] of Object.entries(params)) {
          if (part.params[k] === v) continue;
          cmds.push(setParam(part.id, k, v));
          changed[k] = `${part.params[k] ?? ""} -> ${v}`;
        }
        if (c.new_ref !== undefined && c.new_ref !== null && c.new_ref !== "") {
          const nr = text(c.new_ref, "new_ref", 32).trim();
          if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(nr)) throw new ToolError(`Designator "${nr}" must start with a letter and use letters, digits or _.`);
          const other = refs.get(nr.toLowerCase());
          if (other && other !== part.id) throw new ToolError(`${nr} is already used by another part.`);
          refs.delete(part.ref.toLowerCase());
          refs.set(nr.toLowerCase(), part.id);
          if (nr !== part.ref) { cmds.push(setRef(part.id, nr)); changed.ref = `${part.ref} -> ${nr}`; }
        }
        out.push({ ref: part.ref, changed });
      }
      if (cmds.length) apply(ctx, batch("Change values", cmds));
      return { data: { updated: out, ...(warn.length ? { warnings: warn } : {}) }, summary: `${cmds.length} change${cmds.length === 1 ? "" : "s"}` };
    },
  },
  {
    name: "move_parts",
    description:
      "Move, rotate or mirror placed parts; attached wires follow. at is the new origin in grid units. " +
      "A move that would join a pin to another net, or leave a wire behind, is refused — pick another spot.",
    params: {
      moves: {
        type: "array",
        items: {
          type: "object",
          properties: { ref: S.str("Designator"), at: S.xy("New origin in grid units"), rot: S.rot(), mirror: S.bool("Mirrored") },
          required: ["ref"],
        },
      },
    },
    required: ["moves"],
    edits: true,
    run(ctx) {
      const { host, args } = ctx;
      const moves = list<Json>(args.moves, "moves");
      if (!moves.length) throw new ToolError("moves is empty.");
      const plan = moves.map(m => ({
        part: needPart(host.sheet(), m.ref),
        at: m.at === undefined || m.at === null ? null : fromGrid(point(m.at, "at")),
        rot: m.rot === undefined || m.rot === null ? null : rotation(m.rot),
        mirror: typeof m.mirror === "boolean" ? m.mirror : null,
      }));
      const out: Json[] = [];
      for (const m of plan) {
        const sheet = host.sheet(), library = host.library();
        const steps: Array<() => Command | null> = [];
        const ref: Ref[] = [{ kind: "part", id: m.part.id }];
        if (m.mirror !== null && m.mirror !== m.part.mirror) {
          steps.push(() => xformCommand(host.sheet(), library, host.index(), ref, { flip: "x", center: m.part.at }, "Flip"));
        }
        steps.push(() => {
          if (m.rot === null || m.rot === m.part.rot) return null;
          const d = (((m.rot - m.part.rot) % 360) + 360) % 360 as 90 | 180 | 270;
          return xformCommand(host.sheet(), library, host.index(), ref, { rotate: d, center: m.part.at }, "Rotate");
        });
        steps.push(() => m.at ? moveCommand(host.sheet(), library, host.index(), [{ part: m.part, to: m.at }], "Move") : null);
        for (const make of steps) {
          const cmd = make();
          if (!cmd) continue;
          // 시험 삼아 적용해 연결이 그대로인지 본다 (붙은 배선이 못 따라오거나, 핀이 다른 넷에 닿으면 바뀐다)
          const before = pinNets(sheet, library);
          cmd.apply(sheet);
          const after = pinNets(sheet, library);
          cmd.revert(sheet);
          if (!onlyMerged(before, after, new Set()) || !onlyMerged(after, before, new Set())) {
            throw new ToolError(`Moving ${m.part.ref} that way would change its connections (a pin would land on another net, or a wire could not follow). ${out.length ? `${out.length} part(s) were moved before this one. ` : ""}Pick another spot.`);
          }
          apply(ctx, cmd);
        }
        const lib = library[m.part.lib];
        out.push({ ref: m.part.ref, at: toGrid(m.part.at), rot: m.part.rot, mirror: m.part.mirror, pins: lib ? pinsOf(m.part, lib) : {} });
      }
      return { data: { moved: out }, summary: out.map(o => o.ref).join(", ") };
    },
  },
  {
    name: "delete",
    description:
      "Delete parts (with the wires left dangling from their pins), net labels by name, SPICE directive blocks by id, probes by net.",
    params: {
      parts: S.strs("Designators"),
      labels: S.strs("Net label names — every label with that name"),
      directives: S.strs("Directive block ids (from get_circuit)"),
      probes: S.strs("Nets whose probes to remove"),
    },
    edits: true,
    run(ctx) {
      const { host, args } = ctx;
      const sheet = host.sheet(), library = host.library(), ex = host.extraction();
      const parts = list<string>(args.parts, "parts").map(r => needPart(sheet, r));
      const extra: Ref[] = [];
      for (const name of list<string>(args.labels, "labels")) {
        const ls = sheet.labels.filter(l => l.name.toLowerCase() === String(name).toLowerCase());
        if (!ls.length) throw new ToolError(`There is no net label "${name}".`);
        extra.push(...ls.map(l => ({ kind: "label" as const, id: l.id })));
      }
      for (const id of list<string>(args.directives, "directives")) {
        if (!sheet.spice.some(b => b.id === id)) throw new ToolError(`There is no directive block "${id}".`);
        extra.push({ kind: "spice", id });
      }
      for (const net of list<string>(args.probes, "probes")) {
        const ps = sheet.probes.filter(p => ex.netAt(p.at)?.toLowerCase() === String(net).toLowerCase());
        if (!ps.length) throw new ToolError(`There is no probe on net "${net}".`);
        extra.push(...ps.map(p => ({ kind: "probe" as const, id: p.id })));
      }
      if (!parts.length && !extra.length) throw new ToolError("Nothing to delete — give parts, labels, directives or probes.");
      const wiresBefore = sheet.wires.length;
      const cmd = deleteParts(sheet, library, parts, extra);
      apply(ctx, cmd);
      const wires = wiresBefore - host.sheet().wires.length;
      return {
        data: { deleted: { parts: parts.map(p => p.ref), labels: list<string>(args.labels, "labels"), directives: list<string>(args.directives, "directives"), probes: list<string>(args.probes, "probes"), wires } },
        summary: [...parts.map(p => p.ref), ...extra.map(e => e.kind)].join(", "),
      };
    },
  },

  // ── 해석 · 측정 · 계산기 · 지시문 · 프로브 ──────────────────────────
  {
    name: "set_analysis",
    description:
      "Set the analysis. kind tran: tstop, tmax, tstart · op: nothing · dc: source (a source name such as V1, or temp), start, stop, step · " +
      "ac: sweep (dec|oct|lin), points, fstart, fstop · noise: out (net or v(a,b)), src (input source), sweep, points, fstart, fstop · " +
      "tf: out, src. Values are SPICE numbers (5m, 10u, 1meg). Fields you leave out keep their value (or the default when the kind changes).",
    params: {
      kind: { type: "string", enum: ["tran", "op", "dc", "ac", "noise", "tf"] },
      tstop: S.str("tran: stop time"), tmax: S.str("tran: max step"), tstart: S.str("tran: start saving"),
      source: S.str("dc: source to sweep (V1, I1 or temp)"), start: S.str("dc: from"), stop: S.str("dc: to"), step: S.str("dc: step"),
      sweep: { type: "string", enum: ["dec", "oct", "lin"] }, points: S.str("ac/noise: points per decade/octave, or total for lin"),
      fstart: S.str("ac/noise: start frequency"), fstop: S.str("ac/noise: stop frequency"),
      out: S.str("noise/tf: output net or v(a,b) (tf also i(V1))"), src: S.str("noise/tf: input source name"),
    },
    required: ["kind"],
    edits: true,
    run(ctx) {
      const { host, args } = ctx;
      const kind = String(args.kind) as SimSettings["kind"];
      if (!["tran", "op", "dc", "ac", "noise", "tf"].includes(kind)) throw new ToolError("kind must be tran, op, dc, ac, noise or tf.");
      const cur = host.project().sim;
      const base: Record<string, string> = { ...(cur.kind === kind ? cur : defaultSim(kind)) } as Record<string, string>;
      const allowed = Object.keys(defaultSim(kind)).filter(k => k !== "kind");
      for (const [k, v] of Object.entries(args)) {
        if (k === "kind" || v === undefined || v === null || v === "") continue;
        if (!allowed.includes(k)) throw new ToolError(`A ${kind} analysis has no field "${k}". Its fields: ${allowed.join(", ") || "(none)"}.`);
        const s = text(v, k, 200).trim();
        if (k === "sweep") {
          if (!["dec", "oct", "lin"].includes(s)) throw new ToolError("sweep must be dec, oct or lin.");
        } else if (!["source", "out", "src"].includes(k)) {
          const n = parseEng(s);
          if (n === null) throw new ToolError(`${k} = "${s}" is not a number (SPICE suffixes like 5m, 10u, 1meg are fine).`);
          if (["tstop", "tmax", "points", "fstart", "fstop"].includes(k) && !(n > 0)) throw new ToolError(`${k} must be above 0.`);
        }
        base[k] = s;
      }
      const next = base as unknown as SimSettings;
      if (next.kind === "ac" || next.kind === "noise") {
        if ((parseEng(next.fstop) ?? 0) <= (parseEng(next.fstart) ?? 0)) throw new ToolError("fstop must be above fstart.");
      }
      if (next.kind === "tran" && (parseEng(next.tmax) ?? 0) > (parseEng(next.tstop) ?? 0)) throw new ToolError("tmax should not be above tstop.");
      apply(ctx, setSim(host.project(), next));
      const issues = checkAnalysis(host.project().sim, host.sheet(), host.library());
      return { data: { analysis: host.project().sim, ...(issues.length ? { issues: issues.map(i => i.message) } : {}) }, summary: kind };
    },
  },
  {
    name: "set_measures",
    description:
      "Replace the .meas lines (ngspice measures them after the run; results come back with run_simulation). Write each line without the leading .meas, " +
      "for example \"tran vpp PP v(out) FROM=1m TO=5m\" or \"ac f3db WHEN vdb(out)=-3 FALL=1\". The analysis word must match the analysis that runs " +
      "(tran, ac or dc). ngspice cannot measure noise or tf results — use the calculator for those.",
    params: { lines: S.strs("The .meas lines (all of them; an empty list removes them)") },
    required: ["lines"],
    edits: true,
    run(ctx) {
      const { host, args } = ctx;
      const lines = list<string>(args.lines, "lines").map(l => text(l, "line", 400).trim().replace(/^\.meas(ure)?\s+/i, "")).filter(Boolean);
      const kind = host.project().sim.kind;
      const names = new Set<string>();
      const warnings: string[] = [];
      for (const l of lines) {
        const w = l.split(/\s+/);
        const an = w[0]?.toLowerCase();
        if (!["tran", "ac", "dc"].includes(an)) throw new ToolError(`"${l}": the first word must be tran, ac or dc.`);
        const name = w[1]?.toLowerCase();
        if (!name || !/^[a-z_]\w*$/.test(name)) throw new ToolError(`"${l}": the second word must be the result name (letters, digits, _).`);
        if (names.has(name)) throw new ToolError(`Two lines measure "${name}". Names must differ.`);
        names.add(name);
        if (an !== kind) warnings.push(`"${l}" names ${an} but the analysis is ${kind}, so ngspice will skip it.`);
      }
      apply(ctx, setMeas(host.project(), lines));
      return { data: { lines, ...(warnings.length ? { warnings } : {}) }, summary: `${lines.length} line${lines.length === 1 ? "" : "s"}` };
    },
  },
  {
    name: "set_calculator",
    description:
      "Replace the calculator rows (post-processing of the last run, shown in the Calculator tab). One expression per row, optionally named: " +
      "\"a0 = dcgain(v(out)/v(in))\", \"fu = ugf(v(out)/v(in))\", \"pm(v(out)/v(in))\", \"gm(M1)/id(M1)\", \"thd(v(out))\". " +
      "Rows with device values (gm, ro, vov …) need one more run_simulation to get their values. calc_reference lists the functions.",
    params: { rows: S.strs("All calculator rows (an empty list removes them)") },
    required: ["rows"],
    edits: true,
    async run(ctx) {
      const { host, args } = ctx;
      const rows = list<string>(args.rows, "rows").map(r => text(r, "row", 600).trim()).filter(Boolean);
      if (rows.length > 60) throw new ToolError("At most 60 rows.");
      apply(ctx, setCalc(host.project(), rows));
      const values = await host.calcValues();
      const r = host.results();
      return {
        data: {
          rows,
          values: values?.map(v => ({ row: v.src, value: v.text, ...(v.warnings.length ? { warnings: v.warnings } : {}) })),
          note: !r ? "No run yet — run_simulation to get values." : !r.current ? "These values are from a run made before the last edit — run_simulation for current ones." : undefined,
        },
        summary: `${rows.length} row${rows.length === 1 ? "" : "s"}`,
      };
    },
  },
  {
    name: "calc_reference",
    description: "The calculator's functions with their arguments and what they do. Pass a category to shorten it (Math, Statistics, Timing & events, Spectrum & distortion, Frequency response, Noise, DC transfer, Device …).",
    params: { category: S.str("Optional category name") },
    async run({ host, args }) {
      const t = await host.calcReference(typeof args.category === "string" ? args.category : undefined);
      return { data: { reference: t }, summary: typeof args.category === "string" ? args.category : "all functions" };
    },
  },
  {
    name: "edit_directives",
    description:
      "SPICE directive blocks — lines kept verbatim in the netlist, for things the schematic does not draw: .param, .model, .ic, .nodeset, .options, " +
      ".func, .subckt … .ends, or device lines (B, E, G …) that join schematic nets by name. A block that is off is written as comments. " +
      "Not here: .control, .include/.lib, analysis lines (set_analysis) and .meas (set_measures).",
    params: {
      add: { type: "array", items: { type: "object", properties: { lines: S.strs("Lines"), active: S.bool("On (default true)") }, required: ["lines"] } },
      update: { type: "array", items: { type: "object", properties: { id: S.str("Block id"), lines: S.strs("New lines"), active: S.bool("On or off") }, required: ["id"] } },
      remove: S.strs("Block ids to remove"),
    },
    edits: true,
    run(ctx) {
      const { host, args } = ctx;
      const sheet = host.sheet();
      const cmds: Command[] = [];
      const check = (lines: unknown) => {
        const ls = list<string>(lines, "lines").map(l => text(l, "line", 2000));
        for (const l of ls) {
          const why = badDirective(l);
          if (why) throw new ToolError(`"${l.trim()}": ${why}.`);
        }
        return ls;
      };
      const added: string[] = [];
      const box = contentBox(sheet, host.library());
      let y = box ? Math.ceil((box[3] + 3 * GRID) / GRID) * GRID : 0;
      const x = box ? Math.floor(box[0] / GRID) * GRID : 0;
      const blocks: SpiceBlock[] = [];
      for (const a of list<Json>(args.add, "add")) {
        const lines = check(a.lines);
        if (!lines.length) throw new ToolError("A new block needs lines.");
        const b: SpiceBlock = { id: uid(), at: [x, y], lines, active: a.active !== false };
        y += (lines.length + 2) * GRID;
        blocks.push(b);
        added.push(b.id);
      }
      if (blocks.length) cmds.push(addObjects([], [], [], [], blocks));
      for (const u of list<Json>(args.update, "update")) {
        const id = text(u.id, "id", 80);
        if (!sheet.spice.some(b => b.id === id)) throw new ToolError(`There is no directive block "${id}".`);
        const next: { lines?: string[]; active?: boolean } = {};
        if (u.lines !== undefined) next.lines = check(u.lines);
        if (typeof u.active === "boolean") next.active = u.active;
        cmds.push(setSpiceBlock(id, next));
      }
      const removed = list<string>(args.remove, "remove");
      for (const id of removed) if (!sheet.spice.some(b => b.id === id)) throw new ToolError(`There is no directive block "${id}".`);
      if (removed.length) cmds.push(removeObjects(removed.map(id => ({ kind: "spice" as const, id }))));
      if (!cmds.length) throw new ToolError("Nothing to do — give add, update or remove.");
      apply(ctx, batch("Edit directive", cmds));
      return { data: { added, updated: list<Json>(args.update, "update").map(u => u.id), removed }, summary: `${cmds.length} change${cmds.length === 1 ? "" : "s"}` };
    },
  },
  {
    name: "set_probes",
    description: "Put voltage probes on these nets (replaces the probes). With probes, the waveform tab draws only the probed nets, in probe colors.",
    params: { nets: S.strs("Net names (an empty list removes all probes)") },
    required: ["nets"],
    edits: true,
    run(ctx) {
      const { host, args } = ctx;
      const nets = list<string>(args.nets, "nets").map(n => text(n, "net", 80).trim()).filter(Boolean);
      const sheet = host.sheet();
      const missing: string[] = [];
      const spots: Array<{ net: string; at: Pt }> = [];
      for (const n of nets) {
        const at = spotOnNet(host, n);
        if (at) spots.push({ net: n, at }); else missing.push(n);
      }
      if (missing.length) throw new ToolError(`There is no net ${missing.map(m => `"${m}"`).join(", ")}. get_circuit lists the nets.`);
      const cmds: Command[] = [];
      if (sheet.probes.length) cmds.push(removeObjects(sheet.probes.map(p => ({ kind: "probe" as const, id: p.id }))));
      spots.forEach((s, i) => cmds.push(addProbe({ id: uid(), at: [s.at[0], s.at[1]], color: PROBE_COLORS[i % PROBE_COLORS.length] })));
      if (cmds.length) apply(ctx, batch("Probes", cmds));
      return { data: { probes: spots.map(s => s.net) }, summary: spots.map(s => s.net).join(", ") || "none" };
    },
  },
  {
    name: "show_parts",
    description: "Point the user at something: select these parts and zoom to them, and/or highlight a net (as the H key does). net: \"\" clears the highlight.",
    params: { parts: S.strs("Designators"), net: S.str("A net to highlight (\"\" to clear)") },
    run({ host, args }) {
      const parts = list<string>(args.parts, "parts").map(r => needPart(host.sheet(), r));
      let net: string | null | undefined;
      if (typeof args.net === "string") {
        const want = args.net.trim().toLowerCase();
        if (!want) net = null;
        else {
          net = host.extraction().netNames().find(n => n.toLowerCase() === want) ?? null;
          if (!net) throw new ToolError(`There is no net "${args.net}". get_circuit lists the nets.`);
        }
      }
      if (!parts.length && net === undefined) throw new ToolError("Give parts, net, or both.");
      host.show(parts.map(p => "part:" + p.id), net);
      return {
        data: { shown: parts.map(p => p.ref), ...(net !== undefined ? { highlighted: net } : {}) },
        summary: [...parts.map(p => p.ref), ...(net ? [`net ${net}`] : [])].join(", ") || "cleared",
      };
    },
  },
  {
    name: "view_schematic",
    description:
      "Look at the schematic as a picture — what the user sees, with every net name written beside its wires. Use it to check that a drawing reads well " +
      "after building or rearranging (crossings, crowding, labels), or when the user talks about how something looks. The text tools stay the source of " +
      "truth for connections. Pass parts to frame the area around them; a large drawing is otherwise too small to read. " +
      "The picture is only kept until your answer — call again to see later changes.",
    params: { parts: S.strs("Designators to frame (the picture shows the area around them). Leave out for the whole drawing.") },
    needs: "vision",
    run({ host, args }) {
      const parts = list<string>(args.parts, "parts").map(r => needPart(host.sheet(), r));
      const pic = host.schematicImage({ parts: parts.length ? parts.map(p => p.id) : undefined });
      if (!pic) throw new ToolError("There is nothing drawn yet.");
      return {
        data: {
          picture: "attached below",
          area: parts.length ? `around ${parts.map(p => p.ref).join(", ")}` : "the whole drawing",
          size: `${pic.width}×${pic.height} px`,
          ...(pic.note ? { note: pic.note } : {}),
        },
        summary: parts.length ? `around ${parts.map(p => p.ref).join(", ")}` : "whole drawing",
        images: [pic],
      };
    },
  },
  {
    name: "rename_net",
    description:
      "Rename a named net: every net label and supply symbol called `from` becomes `to` (names ignore case). If a net called `to` already exists the two become one net. " +
      "Auto-named nets (N001 …) have no label — put a pin on the new name with connect({from: pin, net: name}) instead.",
    params: { from: S.str("The current name"), to: S.str("The new name") },
    required: ["from", "to"],
    edits: true,
    run(ctx) {
      const { host, args } = ctx;
      const from = text(args.from, "from", 80).trim(), to = text(args.to, "to", 80).trim();
      if (!/^[A-Za-z0-9_+\-]+$/.test(to)) throw new ToolError(`Net name "${to}" may use letters, digits, _ + - only.`);
      if (to === "0") throw new ToolError("Node 0 is ground — connect pins to the net \"0\" instead of renaming a label to it.");
      const labels = host.sheet().labels.filter(l => l.kind !== "gnd" && l.name.toLowerCase() === from.toLowerCase());
      if (!labels.length) {
        throw new ToolError(`No net label or supply symbol is called "${from}". ${/^N\d{3,}$/i.test(from) ? "Auto-named nets have no label — use connect with net." : "get_circuit lists the labels."}`);
      }
      const merged = host.extraction().netNames().some(n => n.toLowerCase() === to.toLowerCase() && n.toLowerCase() !== from.toLowerCase());
      // 지시문 블록의 줄은 넷을 이름으로 부른다. 옛 이름이 남아 있으면 그 줄은 조용히 다른(빈) 넷을 부른다
      const word = new RegExp(`(^|[\\s(,])${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s),])`, "i");
      const stale = host.sheet().spice.filter(b => b.active).flatMap(b => b.lines.filter(l => !l.trim().startsWith("*") && word.test(l)).map(l => ({ id: b.id, line: l.trim() })));
      apply(ctx, batch("Rename net", labels.map(l => renameLabel(l.id, to))));
      return {
        data: {
          renamed: labels.length, from, to,
          ...(merged ? { note: `A net called ${to} already existed; they are one net now.` } : {}),
          ...(stale.length ? { directive_lines_still_using_old_name: stale, warning: `These directive lines still name ${from} — update them with edit_directives.` } : {}),
        },
        summary: `${from} -> ${to}`,
      };
    },
  },
  {
    name: "import_netlist",
    description:
      "Add a SPICE netlist to the circuit (the first line is the title, as in any SPICE file). R, C, L, V (DC, SIN or PULSE), D, Q and M lines become parts, " +
      "laid out beside the drawing and connected by net labels named after the text's nodes; .model lines go with their parts; every other line " +
      "(subcircuits, behavioral or controlled sources, .param …) goes into a SPICE directive block verbatim. Node 0 joins the circuit's ground and a node " +
      "with the name of an existing net joins that net — use distinct node names to keep the text separate. Designators already taken get the next free " +
      "number. The text's analysis lines are not applied (use set_analysis). Good for big blocks that are quicker to write as a netlist.",
    params: { text: S.str("The SPICE netlist") },
    required: ["text"],
    edits: true,
    run(ctx) {
      const { host, args } = ctx;
      const src = text(args.text, "text", 60000);
      if (!src.trim()) throw new ToolError("text is empty.");
      /*
       * SPICE 는 첫 줄을 무조건 제목으로 읽고 버린다 (README 의 'SPICE 글에서 문 세 가지'). 여기서 짐작해 고치지
       * 않는다 — 제목이 'RC filter' 처럼 소자 줄로도 읽히면 짐작이 틀린다. 대신 무엇을 제목으로 읽었는지 돌려주고,
       * 그것이 소자 줄처럼 생겼으면 경고한다.
       */
      const title = src.split(/\r?\n/).find(l => l.trim())?.trim() ?? "";
      const r = spToProject(src);
      const inc = r.project.sheets[0];
      const warnings = [...r.warnings.filter(w => !/No analysis line/.test(w))];
      if (/^[RCLVIDQMXEGFHBKST][A-Za-z0-9_]*(\s+\S+){3,}/i.test(title)) {
        warnings.push(`The first line was read as the title, as SPICE does: "${title.slice(0, 80)}". If it was a device line, send the text again with a title line first.`);
      }
      if (!inc.parts.length && !inc.spice.length) throw new ToolError("Nothing in the text could be read as a device or directive line" + (warnings.length ? ` (${warnings[warnings.length - 1]})` : "."));
      const sheet = host.sheet(), library = host.library();
      if (r.project.sim && /^\s*\.(tran|ac|dc|op|noise|tf)\b/im.test(src)) warnings.push("The text's analysis line was not applied — call set_analysis for that.");

      // 부품 정의: 내장은 그대로, 가져온 모델 부품은 이름이 겹치고 내용이 다르면 새 이름으로
      const libRename = new Map<string, string>();
      for (const [id, def] of Object.entries(r.project.library)) {
        const have = library[id];
        if (!have) { library[id] = def; continue; }
        if (JSON.stringify(have) === JSON.stringify(def)) continue;
        let k = 2;
        while (library[`${id}~${k}`]) k++;
        library[`${id}~${k}`] = { ...def, id: `${id}~${k}` };
        libRename.set(id, `${id}~${k}`);
      }
      // 지정자: 이미 있으면 그 접두어의 다음 번호
      const taken = new Set(sheet.parts.map(p => p.ref.toLowerCase()));
      const renamed: string[] = [];
      for (const p of inc.parts) {
        if (libRename.has(p.lib)) p.lib = libRename.get(p.lib)!;
        if (!taken.has(p.ref.toLowerCase())) { taken.add(p.ref.toLowerCase()); continue; }
        const prefix = library[p.lib]?.refPrefix ?? p.ref.replace(/\d+$/, "");
        let n = 1;
        while (taken.has(`${prefix}${n}`.toLowerCase())) n++;
        renamed.push(`${p.ref} -> ${prefix}${n}`);
        p.ref = `${prefix}${n}`;
        taken.add(p.ref.toLowerCase());
      }
      // 지시문: 브라우저에서 못 쓰는 줄 · 제자리가 따로 있는 줄은 뺀다
      const dropped: string[] = [];
      for (const b of inc.spice) {
        b.lines = b.lines.filter(l => {
          const why = badDirective(l);
          if (why) dropped.push(`${l.trim()} (${why})`);
          return !why;
        });
      }
      const blocks = inc.spice.filter(b => b.lines.length);
      // 자리: 지금 그림의 오른쪽에, 위를 맞춰서
      const mine = contentBox(sheet, library), theirs = contentBox(inc, library);
      const dx = mine && theirs ? Math.ceil((mine[2] + 8 * GRID - theirs[0]) / GRID) * GRID : 0;
      const dy = mine && theirs ? Math.round((mine[1] - theirs[1]) / GRID) * GRID : 0;
      const shift = (p: Pt): Pt => [p[0] + dx, p[1] + dy];
      for (const p of inc.parts) p.at = shift(p.at);
      for (const w of inc.wires) w.pts = w.pts.map(shift);
      for (const l of inc.labels) l.at = shift(l.at);
      for (const b of blocks) b.at = shift(b.at);
      const before = new Set(host.extraction().netNames().map(n => n.toLowerCase()));
      const joined = [...new Set(inc.labels.filter(l => l.kind === "label" && before.has(l.name.toLowerCase())).map(l => l.name))];
      apply(ctx, addObjects(inc.parts, inc.wires, inc.labels, [], blocks, []));
      return {
        data: {
          title,
          placed: inc.parts.filter(p => (library[p.lib]?.id ?? p.lib) !== "gnd").map(p => p.ref),
          ...(joined.length ? { joined_existing_nets: joined } : {}),
          ...(renamed.length ? { renamed_designators: renamed } : {}),
          ...(blocks.length ? { directive_lines: blocks.reduce((n, b) => n + b.lines.length, 0) } : {}),
          ...(dropped.length ? { dropped_lines: dropped } : {}),
          ...(warnings.length ? { warnings } : {}),
        },
        summary: `${inc.parts.length} parts${blocks.length ? ", directives" : ""}`,
      };
    },
  },
];

