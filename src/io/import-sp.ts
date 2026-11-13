/**
 * 외부 .sp 를 회로도로 바꾼다 (설계서 E34).
 *
 * 우리가 그릴 수 있는 소자만 부품으로 옮기고, 나머지는 **원문 그대로** SPICE 지시문
 * 블록(E33)에 남긴다. 회로도에 안 그려도 노드 이름이 같아서 시뮬레이션에는 그대로
 * 들어간다 — 그래서 "불러와서 다시 내보내면 같은 결과" 가 성립한다.
 *
 * 배선으로 잇지 않고 핀마다 짧은 꼬리를 빼서 넷 라벨로만 잇는다. 선이 겹치지 않고,
 * 노드 이름이 원문 그대로 남아 보존한 줄과 아귀가 맞는다.
 */
import {
  emptyProject, pinAt, snapPt, transform, uid,
  type LibPart, type NetLabel, type Part, type Project, type Pt, type Sheet,
  type SimSettings, type Wire,
} from "../doc/types.ts";
import { BUILTIN, defaultParams } from "../lib/parts.ts";
import { normalizeValue } from "../doc/units.ts";

export interface ImportResult {
  project: Project;
  /** 부품으로 옮긴 소자 줄 수 */
  placed: number;
  /** 지시문 블록에 그대로 남긴 줄 */
  kept: string[];
  warnings: string[];
}

/*
 * 자동 배치 간격.
 *
 * 설계서는 가로 800 mil·세로 600 mil 을 적었지만, 핀마다 200 mil 꼬리를 빼면
 * 2핀 부품의 가로 폭이 800 mil 이라 옆 부품의 꼬리 끝과 **같은 점**에서 만난다.
 * 같은 좌표면 연결로 판정되어 서로 다른 넷이 붙어 버린다. 세로도 마찬가지다.
 * 그래서 꼬리 끝 사이가 벌어지도록 1200 × 1000 mil 로 둔다.
 */
const COL = 120, ROW = 100, PER_ROW = 6, STUB = 20;

/** 놓을 부품 하나. 자리는 전부 읽은 뒤에 정한다 */
interface Pending {
  libId: string;
  ref: string;
  nodes: string[];
  params: Record<string, string>;
}

/** 한 줄을 공백으로 쪼갠다. 괄호 안의 공백은 살린다 — SIN(0 1 1k) 이 토큰 하나여야 한다 */
export function tokens(line: string): string[] {
  const out: string[] = [];
  let buf = "", depth = 0;
  for (const ch of line) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) { if (buf) { out.push(buf); buf = ""; } continue; }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/** SIN(0 1 1k) 의 괄호 안 값들. 괄호 없이 띄어 쓴 형태도 받는다 */
function args(spec: string[], keyword: string): string[] {
  const joined = spec.join(" ");
  const m = new RegExp(keyword + "\\s*\\(([^)]*)\\)", "i").exec(joined);
  if (m) return m[1].trim().split(/[\s,]+/).filter(Boolean);
  const i = spec.findIndex(t => t.toUpperCase() === keyword.toUpperCase());
  return i >= 0 ? spec.slice(i + 1).filter(t => !/^(ac|dc)$/i.test(t)) : [];
}

interface ModelCard { name: string; type: string; line: string }

/** .model 줄을 모은다. 이름은 대소문자를 가리지 않는다 */
function collectModels(lines: string[]): Map<string, ModelCard> {
  const out = new Map<string, ModelCard>();
  for (const line of lines) {
    const m = /^\.model\s+(\S+)\s+([A-Za-z]+)/i.exec(line);
    if (m) out.set(m[1].toLowerCase(), { name: m[1], type: m[2].toUpperCase(), line });
  }
  return out;
}

/**
 * 외부 모델을 쓰는 부품 정의.
 *
 * 모델 줄은 **원문 그대로** 들고 간다. 계수를 우리 틀(IS·N 뿐)로 다시 쓰면
 * RS·CJO 같은 것이 조용히 사라져 다른 소자가 된다.
 */
function importedPart(base: LibPart, card: ModelCard, extra: Record<string, string>): LibPart {
  const def = structuredClone(base);
  def.id = base.id + ":" + card.name.toLowerCase();
  def.name = base.name + " (" + card.name + ")";
  def.params = [
    { key: "model", label: "Model name", unit: "", default: card.name },
    ...Object.keys(extra).map(k => ({ key: k, label: k.toUpperCase(), unit: "", default: extra[k] })),
  ];
  def.spice = { element: base.spice!.element, template: base.spice!.template, model: card.line };
  return def;
}

export function spToProject(text: string, fallbackName = "imported"): ImportResult {
  /*
   * 토큰화: 줄 잇기, 주석, .end 자르기 (설계서 '외부 .sp 읽기 규칙').
   *
   * 첫 줄은 **무조건** 제목이다. 소자처럼 생겼어도 SPICE 는 제목으로 읽고 버린다.
   * 주석을 먼저 걷어내고 나서 제목을 고르면, 제목이 `*` 로 시작하는 보통의 파일에서
   * 첫 소자 줄이 제목으로 먹힌다 — 회로가 조용히 끊긴다.
   */
  const all = text.split(/\r?\n/);
  const first = all.findIndex(l => l.trim());
  const title = first >= 0 ? all[first].trim() : "";

  const raw: string[] = [];
  for (const rawLine of all.slice(first + 1)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\.end\b/i.test(line)) break;
    if (line.startsWith("*") || line.startsWith(";")) continue;
    if (line.startsWith("+") && raw.length) { raw[raw.length - 1] += " " + line.slice(1).trim(); continue; }
    raw.push(line);
  }

  const models = collectModels(raw);
  const used = new Set<string>();
  const project = emptyProject(title.replace(/^\*+\s*/, "").trim() || fallbackName);
  const sheet = project.sheets[0];
  const kept: string[] = [];
  const warnings: string[] = [];
  const todo: Pending[] = [];
  let sim: SimSettings | null = null;

  const useLib = (def: LibPart): string => {
    if (!project.library[def.id]) project.library[def.id] = def;
    return def.id;
  };
  const builtin = (id: string): string => useLib(structuredClone(BUILTIN[id]));

  for (const line of raw) {
    const t = tokens(line);
    const head = t[0] ?? "";
    const rest = t.slice(1);

    if (head.startsWith(".")) {
      const d = head.toLowerCase();
      if (/^\.(tran|op|dc|ac|noise|tf)$/.test(d)) {
        const parsed = parseAnalysis(d.slice(1), rest);
        if (parsed && !sim) { sim = parsed; continue; }
        kept.push(line);
        if (parsed) warnings.push("More than one analysis line, so " + head + " was kept in a SPICE directive block");
        else warnings.push(head + " could not be read and was kept in a SPICE directive block");
        continue;
      }
      kept.push(line);
      if (/^\.(control|include|lib)$/.test(d)) {
        warnings.push(head + " was left as is — in a browser the file it points at cannot be found");
      }
      continue;
    }

    const kind = head[0]?.toUpperCase() ?? "";
    let ok = false;
    const passive = (libId: string): boolean => {
      if (rest.length < 3) return false;
      todo.push({ libId, ref: head, nodes: [rest[0], rest[1]], params: { value: normalizeValue(rest[2]) } });
      return true;
    };
    if (kind === "R") ok = passive(builtin("r"));
    else if (kind === "C") ok = passive(builtin("c"));
    else if (kind === "L") ok = passive(builtin("l"));
    else if (kind === "V") ok = source(head, rest, todo, builtin);
    else if (kind === "D" || kind === "Q" || kind === "M") {
      ok = semiconductor(kind, head, rest, models, used, todo, useLib, warnings);
    }
    if (!ok) kept.push(line);
  }

  // 부품으로 옮긴 모델 줄은 라이브러리가 들고 있다. 블록에도 두면 두 번 나간다
  const taken = new Set([...used].map(n => models.get(n)!.line));
  const keptFinal = kept.filter(l => !taken.has(l));

  place(sheet, project, todo);

  if (keptFinal.length) {
    const rows = Math.max(1, Math.ceil(todo.length / PER_ROW));
    sheet.spice.push({ id: uid(), at: snapPt([0, rows * ROW + 20]), lines: keptFinal, active: true });
  }
  if (sim) project.sim = sim;
  else warnings.push("No analysis line, so the default transient settings are used");

  return { project, placed: todo.length, kept: keptFinal, warnings };
}

/** .tran / .op / .dc / .ac / .noise / .tf 를 해석 설정으로 */
export function parseAnalysis(kind: string, a: string[]): SimSettings | null {
  if (kind === "op") return { kind: "op" };
  if (kind === "tran") {
    // .tran tstep tstop [tstart [tmax]] — 최대 스텝이 없으면 출력 간격을 그대로 쓴다
    if (a.length < 2) return null;
    return { kind: "tran", tmax: a[3] ?? a[0], tstop: a[1], tstart: a[2] ?? "0" };
  }
  if (kind === "dc") {
    if (a.length < 4) return null;
    return { kind: "dc", source: a[0], start: a[1], stop: a[2], step: a[3] };
  }
  if (kind === "ac") {
    const sweep = (a[0] ?? "").toLowerCase();
    if (a.length < 4 || (sweep !== "dec" && sweep !== "oct" && sweep !== "lin")) return null;
    return { kind: "ac", sweep, points: a[1], fstart: a[2], fstop: a[3] };
  }
  if (kind === "noise") {
    // .noise v(out[,ref]) 입력전원 dec|oct|lin 점수 시작 끝. v(out, ref) 는 tokens() 가 괄호째 한 낱말로 준다
    const sweep = (a[2] ?? "").toLowerCase();
    if (a.length < 6 || (sweep !== "dec" && sweep !== "oct" && sweep !== "lin")) return null;
    return { kind: "noise", out: a[0], src: a[1], sweep, points: a[3], fstart: a[4], fstop: a[5] };
  }
  if (kind === "tf") {
    if (a.length < 2) return null;
    return { kind: "tf", out: a[0], src: a[1] };
  }
  return null;
}

/** 전압원. DC · SIN · PULSE 한 가지로만 된 것만 부품이 된다 (설계서 읽기 규칙 표) */
function source(ref: string, rest: string[], todo: Pending[], builtin: (id: string) => string): boolean {
  if (rest.length < 3) return false;
  const nodes = [rest[0], rest[1]];
  const spec = rest.slice(2);
  const joined = spec.join(" ");
  if (/\b(PWL|EXP|SFFM|AM|TRNOISE|TRRANDOM)\b/i.test(joined)) return false;

  const acIdx = spec.findIndex(t => /^ac$/i.test(t));
  const ac = acIdx >= 0 ? (spec[acIdx + 1] ?? "1") : "1";

  const fill = (libId: string, keys: string[], values: string[]) => {
    const params: Record<string, string> = { ac };
    keys.forEach((k, i) => { params[k] = normalizeValue(values[i] ?? "0"); });
    todo.push({ libId, ref, nodes, params });
  };

  if (/\bSIN\b/i.test(joined)) {
    fill(builtin("vsin"), ["vo", "va", "freq", "td", "theta", "phase"], args(spec, "SIN"));
    return true;
  }
  if (/\bPULSE\b/i.test(joined)) {
    fill(builtin("vpulse"), ["v1", "v2", "td", "tr", "tf", "pw", "per"], args(spec, "PULSE"));
    return true;
  }

  // 남은 것이 DC 하나뿐이어야 한다. "V1 1 0 5" 처럼 DC 를 생략한 형태도 받는다
  const dcIdx = spec.findIndex(t => /^dc$/i.test(t));
  let dc: string | undefined;
  if (dcIdx >= 0) dc = spec[dcIdx + 1];
  else {
    const numbers = spec.filter((t, i) => !/^(ac|dc)$/i.test(t) && i !== acIdx + 1);
    dc = numbers[0];
  }
  if (dc === undefined || !/^[-+.\d]/.test(dc)) return false;
  todo.push({ libId: builtin("vdc"), ref, nodes, params: { dc: normalizeValue(dc), ac } });
  return true;
}

/** D · Q · M. 짝이 되는 .model 이 있어야 부품이 된다 */
function semiconductor(
  kind: string, ref: string, rest: string[],
  models: Map<string, ModelCard>, used: Set<string>,
  todo: Pending[], useLib: (def: LibPart) => string, warnings: string[],
): boolean {
  const nodeCount = kind === "D" ? 2 : kind === "Q" ? 3 : 4;
  if (rest.length < nodeCount + 1) return false;
  const nodes = rest.slice(0, nodeCount);
  const modelName = rest[nodeCount];
  const card = models.get(modelName.toLowerCase());
  if (!card) {
    warnings.push(ref + ": model " + modelName + " was not in the file, so the line was left as is");
    return false;
  }

  const baseId =
    kind === "D" && card.type === "D" ? "d"
    : kind === "Q" && card.type === "NPN" ? "npn"
    : kind === "Q" && card.type === "PNP" ? "pnp"
    : kind === "M" && card.type === "NMOS" ? "nmos"
    : kind === "M" && card.type === "PMOS" ? "pmos"
    : null;
  if (!baseId) {
    warnings.push(ref + ": model type " + card.type + " cannot be drawn yet, so the line was left as is");
    return false;
  }

  const params: Record<string, string> = { model: card.name };
  const extra: Record<string, string> = {};
  if (kind === "M") {
    // 네 번째 노드(몸통)가 소스와 다르면 우리 심볼로는 못 그린다 (핀이 D·G·S 뿐)
    if (nodes[3].toLowerCase() !== nodes[2].toLowerCase()) {
      warnings.push(ref + ": bulk differs from source, so the line was left as is (" + nodes[3] + ")");
      return false;
    }
    for (const t of rest.slice(nodeCount + 1)) {
      const m = /^([WL])\s*=\s*(\S+)$/i.exec(t);
      if (m) { const k = m[1].toLowerCase(); params[k] = normalizeValue(m[2]); extra[k] = params[k]; }
    }
  }

  const def = importedPart(BUILTIN[baseId], card, extra);
  if (kind === "M") {
    def.spice!.template = "{ref} {d} {g} {s} {s} {model}"
      + (params.w ? " W={w}" : "") + (params.l ? " L={l}" : "");
  }
  used.add(modelName.toLowerCase());
  todo.push({ libId: useLib(def), ref, nodes: nodes.slice(0, kind === "M" ? 3 : nodeCount), params });
  return true;
}

/**
 * 자동 배치 (설계서 E34). 파일에 나온 순서대로 한 줄에 6개씩 놓고,
 * 핀마다 짧은 꼬리를 빼서 끝에 노드 이름으로 넷 라벨을 붙인다. 노드 0 은 GND 기호다.
 */
function place(sheet: Sheet, project: Project, todo: Pending[]) {
  todo.forEach((item, i) => {
    const lib = project.library[item.libId];
    const at: Pt = [(i % PER_ROW) * COL, Math.floor(i / PER_ROW) * ROW];
    const part: Part = {
      id: uid(), lib: item.libId, ref: item.ref, at, rot: 0, mirror: false,
      params: { ...defaultParams(lib), ...item.params },
    };
    sheet.parts.push(part);

    lib.symbol.pins.forEach((pin, k) => {
      const node = item.nodes[k];
      if (node === undefined) return;
      const p = pinAt(part, lib, k);
      const d = transform(pin.at, part.rot, part.mirror);
      // 꼬리는 핀이 원점에서 벗어난 쪽으로 뺀다. 긴 축만 쓴다
      const dir: Pt = Math.abs(d[0]) >= Math.abs(d[1])
        ? [Math.sign(d[0]) || 1, 0]
        : [0, Math.sign(d[1]) || 1];
      const end: Pt = [p[0] + dir[0] * STUB, p[1] + dir[1] * STUB];
      const wire: Wire = { id: uid(), pts: [p, end] };
      sheet.wires.push(wire);

      if (node === "0") {
        if (!project.library.gnd) project.library.gnd = structuredClone(BUILTIN.gnd);
        sheet.parts.push({
          id: uid(), lib: "gnd", ref: "GND", at: end, rot: 0, mirror: false, params: {},
        });
      } else {
        const label: NetLabel = { id: uid(), name: node, at: end, kind: "label" };
        sheet.labels.push(label);
      }
    });
  });
}
