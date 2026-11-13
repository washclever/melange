/**
 * 계산기 식을 실행 결과 위에서 계산한다.
 *
 * 한 줄씩 위에서 아래로. `a0 = dcgain(v(out))` 처럼 이름을 붙이면 아래 줄에서 a0 로 쓴다.
 * 값을 가져오는 곳은 셋이다:
 *
 *   지난 실행           v(out) · i(V1) · gm(M1) · onoise · .meas 이름
 *   보관해 둔 실행      dm.v(out) — 이름을 붙여 남겨 둔 다른 실행 (CMRR · PSRR 처럼 두 번 돌려야 하는 것)
 *   위의 줄             a0 · fu …
 *
 * 무엇을 저장해야 하는지(calcSaves)도 여기서 식을 읽어 정한다 — 계산과 저장이 같은 해석을 써야
 * "식은 gm(M1) 을 쓰는데 저장은 안 했다" 가 안 생긴다.
 */
import { tfGainUnit, type Trace } from "../sim-values.ts";
import { eng } from "./format.ts";
import { CalcError, mkWave, num, str, type Axis, type Value } from "./wave.ts";
import { parseLine, walk, type Node } from "./parse.ts";
import { binary, mapComplex, negate } from "./ops.ts";
import { FNS } from "./funcs.ts";
import {
  DEVICE_FNS, PARAM_UNIT, allowedParams, badParam, currentOf, deviceNames, deviceNeeds, emptyDevices, findDevice,
  kindWord, vecName, type Device, type DeviceTable,
} from "./devices.ts";

export interface Vec { re: Float64Array; im: Float64Array | null; unit: string }

/** 실행 한 번의 결과. 보관해 두면 이것이 통째로 남는다 */
export interface RunData {
  /** tran · op · dc · ac · noise · tf. 외부 .sp 는 축 이름으로 짐작한다 */
  kind: string;
  /** 가로축. 점 하나짜리(.op · .tf)면 null 이고 모든 값이 숫자다 */
  x: Float64Array | null;
  axis: Axis;
  xunit: string;
  /** 소문자 벡터 이름 -> 값. v(@m1[vds]) 같은 이름은 @m1[vds] 로 줄여 둔다 */
  vec: Map<string, Vec>;
  devices: DeviceTable;
  measures: Map<string, number | null>;
  /** 저장해 달라고 했지만 엔진에 없어서 빼고 다시 돌린 벡터 */
  unavailable: Set<string>;
  /** 이번 실행에 따로 저장해 달라고 한 벡터. 없는 값이 '안 물어봐서' 인지 가르는 데 쓴다 */
  requested: Set<string>;
}

const KIND_WORD: Record<string, string> = {
  tran: "transient", op: "operating point", dc: "DC sweep", ac: "AC analysis", noise: "noise analysis",
  tf: "transfer function", unknown: "run",
};

/** 엔진 벡터 이름을 찾기 좋게. v(@m1[vds]) -> @m1[vds] (엔진이 종류에 따라 v() · i() 로 싸서 준다) */
export const normName = (name: string): string => {
  const k = name.trim().toLowerCase();
  const m = /^[vi]\((@.+)\)$/.exec(k);
  return m ? m[1] : k;
};

function unitOf(key: string, inoiseUnit: string): string {
  const m = /^@[^[]+\[(\w+)\]$/.exec(key);
  if (m) return PARAM_UNIT[m[1]] ?? "";
  if (key === "onoise_spectrum") return "V/√Hz";
  if (key === "inoise_spectrum") return inoiseUnit;
  if (key === "v(transfer_function)") return "";
  if (/impedance/.test(key)) return "Ω";
  if (key.startsWith("v(")) return "V";
  if (key.startsWith("i(")) return "A";
  return "";
}

export interface RunInfo {
  kind?: string;
  devices?: DeviceTable;
  measures?: ReadonlyArray<{ name: string; value: number | null }>;
  unavailable?: readonly string[];
  requested?: readonly string[];
  /** 잡음 해석의 입력이 전류원이면 입력 환산 잡음이 A/√Hz 다 */
  inoiseUnit?: string;
}

/**
 * 워커가 준 결과로 RunData 를 만든다. AC 결과는 크기 · 위상으로 오므로 실수부 · 허수부로 되돌린다
 * (src/sim-values.ts 가 크기 · 위상으로 바꿔 보낸다 — 파형 패널이 그 모양을 쓴다).
 */
export function runFromTraces(traces: readonly Trace[], info: RunInfo = {}): RunData {
  const axisT =
    traces.find(t => t.name.toLowerCase() === "time") ??
    traces.find(t => t.name.toLowerCase() === "frequency") ??
    traces.find(t => /sweep/i.test(t.name));
  const an = axisT?.name.toLowerCase() ?? "";
  let axis: Axis = "index", xunit = "";
  if (an === "time") { axis = "time"; xunit = "s"; }
  else if (an === "frequency") { axis = "frequency"; xunit = "Hz"; }
  else if (an === "temp-sweep") { axis = "temp"; xunit = "°C"; }
  else if (an.startsWith("v(")) { axis = "sweep"; xunit = "V"; }
  else if (an.startsWith("i(")) { axis = "sweep"; xunit = "A"; }
  else if (an) axis = "sweep";
  const points = traces.find(t => t !== axisT)?.values.length ?? 0;
  const x = axisT && points > 1 ? axisT.values : null;
  const kind = info.kind ?? (axis === "time" ? "tran" : axis === "frequency" ? "ac" : axis === "index" ? "op" : "dc");
  const vec = new Map<string, Vec>();
  const inoiseUnit = info.inoiseUnit ?? "V/√Hz";
  for (const t of traces) {
    if (t === axisT) continue;
    const key = normName(t.name);
    let re: Float64Array, im: Float64Array | null = null;
    if (t.phaseDeg) {
      const n = t.values.length;
      re = new Float64Array(n);
      im = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const p = (t.phaseDeg[i] * Math.PI) / 180;
        re[i] = t.values[i] * Math.cos(p);
        im[i] = t.values[i] * Math.sin(p);
      }
    } else re = t.values;
    vec.set(key, { re, im, unit: unitOf(key, inoiseUnit) });
  }
  // 전달 함수의 이득은 입출력이 무엇이냐에 따라 단위가 다르다: V/V · A/A 는 비율, V/A 는 Ω, A/V 는 S
  const tfGain = vec.get("v(transfer_function)");
  if (tfGain) tfGain.unit = tfGainUnit([...vec.keys()]);
  return {
    kind, x, axis, xunit, vec,
    devices: info.devices ?? emptyDevices(),
    measures: new Map((info.measures ?? []).map(m => [m.name.toLowerCase(), m.value])),
    unavailable: new Set((info.unavailable ?? []).map(normName)),
    requested: new Set((info.requested ?? []).map(normName)),
  };
}

// ── 계산 ──────────────────────────────────────────────────────────────
export interface Env {
  run: RunData | null;
  kept: ReadonlyMap<string, RunData>;
  vars: Map<string, Value>;
  /** 앞 줄에서 계산하다 실패한 이름 -> 그 줄 번호 (뒤 줄이 '그런 이름 없음' 대신 이유를 말하게) */
  failed: Map<string, number>;
}

export const CONSTANTS: Record<string, { v: number; unit: string; doc: string }> = {
  pi: { v: Math.PI, unit: "", doc: "π" },
  kb: { v: 1.380649e-23, unit: "J/K", doc: "Boltzmann constant k (J/K) — kb*tnom/q is VT in volts" },
  q: { v: 1.602176634e-19, unit: "C", doc: "Electron charge (C)" },
  tnom: { v: 300.15, unit: "K", doc: "ngspice's default temperature, 27 °C in kelvin" },
};

function runFor(scope: string | null, env: Env): RunData {
  if (scope) {
    const r = env.kept.get(scope.toLowerCase());
    if (!r) {
      const have = [...env.kept.keys()];
      throw new CalcError(`No kept result named "${scope}"` + (have.length ? ` — kept: ${have.join(", ")}` : " — use Keep to name a run first"));
    }
    return r;
  }
  if (!env.run) throw new CalcError("Run the simulation (F8) first");
  return env.run;
}

function vecValue(run: RunData, v: Vec): Value {
  if (!run.x) return { t: "num", re: v.re[0] ?? NaN, im: v.im ? v.im[0] : 0, unit: v.unit };
  const n = Math.min(run.x.length, v.re.length);
  const x = n === run.x.length ? run.x : run.x.subarray(0, n);
  return mkWave(x, n === v.re.length ? v.re : v.re.subarray(0, n), v.im ? v.im.subarray(0, n) : null, run.axis, run.xunit, v.unit);
}

/** 이 실행에 있는 넷 이름 (오류 문구의 후보) */
function netList(run: RunData): string[] {
  const out: string[] = [];
  for (const k of run.vec.keys()) {
    const m = /^v\(([^()]+)\)$/.exec(k);
    if (m && !/[.#@]/.test(m[1])) out.push(m[1]);
  }
  return out;
}
const some = (xs: string[], n = 8): string => xs.slice(0, n).join(", ") + (xs.length > n ? ` … (${xs.length})` : "");

function noVectorsHere(run: RunData): string {
  if (run.kind === "noise") return " A noise analysis records the noise spectra (onoise, inoise), not node voltages";
  if (run.kind === "tf") return " A transfer-function analysis records tf_gain, tf_rin and tf_rout";
  return "";
}

function voltage(run: RunData, name: string): Value {
  const k = name.trim().toLowerCase();
  if (k === "0") return run.x ? mkWave(run.x, new Float64Array(run.x.length), null, run.axis, run.xunit, "V") : num(0, "V");
  const v = run.vec.get(`v(${k})`);
  if (v) return vecValue(run, v);
  const nets = netList(run);
  throw new CalcError(`No net "${name}" in the ${KIND_WORD[run.kind] ?? "run"}.` +
    (nets.length ? ` Nets: ${some(nets)}` : noVectorsHere(run)));
}

/**
 * 소자 값이 점 하나인 실행인가. 동작점 · 전달 함수는 물론이고, **AC · 잡음 해석도** 그렇다 — 주파수를
 * 쓸어도 동작점은 하나라, ngspice 는 같은 값을 주파수 점마다 되풀이해 준다. 그것을 평평한 파형으로
 * 내놓으면 gm(M1) 이 숫자가 아니라 그림이 되고, gm(M1)·ro(M1) 같은 식도 덩달아 파형이 된다.
 */
const opPoint = (run: RunData): boolean => !run.x || run.axis === "frequency";

function paramArray(run: RunData, d: Device, p: string, label: string): Float64Array | number {
  const key = vecName(d, p);
  const v = run.vec.get(key);
  if (!v) throw new CalcError(missingParam(run, d, key, label));
  // AC 에서는 허수부 0 인 복소수로 오는데, 음수면 위상 180° 로 바뀌어 왔다 — 실수부가 원래 값이다
  return opPoint(run) ? v.re[0] : v.re;
}

function missingParam(run: RunData, d: Device, key: string, label: string): string {
  const who = d.ref ?? d.name;
  if (run.unavailable.has(key)) return `ngspice has no ${key} for ${who} — the run was repeated without it`;
  if (run.kind === "noise" || run.kind === "tf") {
    return `${label} is not in this ${KIND_WORD[run.kind]} — device values come with tran, op, dc and ac runs`;
  }
  return `${label} was not recorded in the last run — press Run (F8): the calculator asks ngspice for ${key}`;
}

function deviceValue(run: RunData, fn: string, devName: string, param: string | null): Value {
  const d = findDevice(run.devices, devName);
  if (!d) {
    const f = DEVICE_FNS[fn];
    const cands = deviceNames(run.devices, f?.kinds);
    throw new CalcError(`No part "${devName}" in the last run` + (cands.length ? ` — ${some(cands)}` : ""));
  }
  const label = fn === "op" ? `op(${devName}, ${param})` : `${fn}(${devName})`;
  const need = deviceNeeds(fn, d, param ?? undefined);
  if ("error" in need) throw new CalcError(need.error);
  if (fn === "op") {
    const p = param!.toLowerCase();
    const v = paramArray(run, d, p, label);
    const unit = PARAM_UNIT[p] ?? "";
    return typeof v === "number" ? num(v, unit) : mkWave(run.x!, v, null, run.axis, run.xunit, unit);
  }
  const f = DEVICE_FNS[fn];
  const ps = f.needs(d);
  const vals = new Map<string, Float64Array | number>();
  for (const p of ps) vals.set(p, paramArray(run, d, p, label));
  const x = run.x;
  if (!x || opPoint(run)) return num(f.calc(d, p => vals.get(p) as number), f.unit, f.unit === "" ? { show: "gain" } : {});
  const n = x.length;
  const out = new Float64Array(n);
  const arrs = new Map([...vals].map(([k, v]) => [k, v as Float64Array]));
  for (let i = 0; i < n; i++) out[i] = f.calc(d, p => arrs.get(p)![i]);
  return mkWave(x, out, null, run.axis, run.xunit, f.unit);
}

function currentValue(run: RunData, name: string): Value {
  const k = name.trim().toLowerCase();
  const direct = run.vec.get(`i(${k})`);
  if (direct) return vecValue(run, direct);
  const d = findDevice(run.devices, k);
  if (d) {
    const c = currentOf(d);
    if (c && "vector" in c) {
      const v = run.vec.get(c.vector);
      if (v) return vecValue(run, v);
      throw new CalcError(`i(${name}) was not recorded in the last run — press Run (F8) to record it`);
    }
    if (c && "param" in c) {
      /*
       * 소자 파라미터로 읽는 전류는 **동작점의 전류**다. AC 에서 @r1[i] 는 0 이고 @m1[id] 는 직류
       * 드레인 전류라, i(R1) 이라고 적은 사람이 기대한 AC 전류가 아니다 (재 봤다). 틀린 값을 주느니 막는다.
       */
      if (run.axis === "frequency") {
        throw new CalcError(`i(${name}) is not recorded in ${run.kind === "noise" ? "a noise" : "an AC"} analysis — ngspice keeps AC currents ` +
          `only for voltage sources and inductors. Put a 0 V source in series and read its i()` +
          (d.kind === "mos" || d.kind === "bjt" ? `; the bias current is ${d.kind === "mos" ? "id" : "ic"}(${name})` : ""));
      }
      const v = paramArray(run, d, c.param, `i(${name})`);
      return typeof v === "number" ? num(v, "A") : mkWave(run.x!, v, null, run.axis, run.xunit, "A");
    }
    throw new CalcError(`i() of a ${kindWord(d)} is not available — measure it with a 0 V source in series`);
  }
  const currents = [...run.vec.keys()].filter(x => /^i\([^@]/.test(x)).map(x => x.slice(2, -1));
  throw new CalcError(`No current "${name}" in the last run` + (currents.length ? ` — currents: ${some(currents)}` : ""));
}

function ident(name: string, scope: string | null, env: Env): Value {
  if (!scope) {
    const v = env.vars.get(name);
    if (v) return v;
    const failedAt = env.failed.get(name);
    if (failedAt !== undefined) throw new CalcError(`${name} has no value — row ${failedAt + 1} failed`);
    const c = CONSTANTS[name];
    if (c) return num(c.v, c.unit);
  }
  const axisNames: Record<string, Axis[]> = {
    time: ["time"], frequency: ["frequency"], freq: ["frequency"], sweep: ["sweep", "temp"], temp: ["temp"],
  };
  // 실행 전이다. 실행 결과에서 올 이름(축 · 잡음 · .tf)이면 실행하라고 하고, 아니면 그 이름을 모른다고 한다 —
  // 'a0*2' 의 a0 를 안 정했는데 "먼저 실행하라" 고 하면 실행해도 안 고쳐진다
  if (!scope && !env.run && !(name in axisNames) && !/^(onoise|inoise|tf_gain|tf_rin|tf_rout)$/.test(name)) {
    if (FNS.has(name)) throw new CalcError(`${name} is a function — write ${name}(…)`);
    throw new CalcError(`Unknown name "${name}"` + (env.vars.size ? ` — defined above: ${[...env.vars.keys()].join(", ")}` : ""));
  }
  const run = runFor(scope, env);
  if (axisNames[name]) {
    if (!run.x || !axisNames[name].includes(run.axis)) {
      throw new CalcError(`The ${KIND_WORD[run.kind] ?? "run"} has no ${name} axis`);
    }
    return mkWave(run.x, run.x, null, run.axis, run.xunit, run.xunit);
  }
  const alias: Record<string, (k: string) => boolean> = {
    onoise: k => k === "onoise_spectrum",
    inoise: k => k === "inoise_spectrum",
    tf_gain: k => k === "v(transfer_function)",
    // 전압 출력이면 output_impedance_at_v(out), 전류 출력(.tf i(V1) …)이면 v1#output_impedance 로 온다
    tf_rout: k => k.startsWith("v(output_impedance_at_") || k.endsWith("#output_impedance)"),
    tf_rin: k => k.endsWith("#input_impedance)"),
  };
  if (alias[name]) {
    for (const [k, v] of run.vec) if (alias[name](k)) return vecValue(run, v);
    throw new CalcError(name.startsWith("tf_")
      ? `${name} comes from a transfer-function analysis (.tf) — the last run is a ${KIND_WORD[run.kind] ?? "run"}`
      : `${name} comes from a noise analysis — the last run is a ${KIND_WORD[run.kind] ?? "run"}`);
  }
  if (run.measures.has(name)) {
    const m = run.measures.get(name);
    if (m === null || m === undefined) throw new CalcError(`The measurement ${name} failed — see the Measure tab`);
    return num(m);
  }
  const raw = run.vec.get(name);
  if (raw) return vecValue(run, raw);
  if (!scope && FNS.has(name)) throw new CalcError(`${name} is a function — write ${name}(…)`);
  throw new CalcError(`Unknown name "${name}"` + (env.vars.size ? ` — defined above: ${[...env.vars.keys()].join(", ")}` : ""));
}

function signal(n: Extract<Node, { k: "sig" }>, env: Env): Value {
  const run = runFor(n.scope, env);
  const isV = n.fn[0] === "v";
  let base: Value;
  if (isV) {
    base = voltage(run, n.names[0]);
    if (n.names.length === 2) base = binary("-", base, voltage(run, n.names[1]));
  } else base = currentValue(run, n.names[0]);
  const mod = n.fn.slice(1);
  if (!mod) return base;
  const unit = base.t === "str" ? "" : base.unit;
  switch (mod) {
    case "db": return mapComplex(base, (r, i) => [20 * Math.log10(Math.hypot(r, i)), 0], "dB", n.fn, true);
    case "m": return mapComplex(base, (r, i) => [Math.hypot(r, i), 0], unit, n.fn, true);
    case "p": return FNS.get("phase")!.run([base]);
    case "r": return mapComplex(base, r => [r, 0], unit, n.fn, true);
    case "i": return mapComplex(base, (_r, i) => [i, 0], unit, n.fn, true);
  }
  throw new CalcError(`Unknown signal function ${n.fn}()`);
}

export function evalNode(n: Node, env: Env): Value {
  switch (n.k) {
    case "num": return num(n.v, n.unit ?? "");
    case "str": return str(n.s);
    case "id": return ident(n.name, n.scope, env);
    case "sig": return signal(n, env);
    case "dev": return deviceValue(runFor(n.scope, env), n.fn, n.dev, n.param);
    case "raw": {
      const run = runFor(n.scope, env);
      const key = `@${n.path}[${n.param}]`;
      const v = run.vec.get(key);
      if (v) return opPoint(run) ? num(v.re[0], v.unit) : vecValue(run, v);
      const d = [...run.devices.byName.values()].find(x => x.path === n.path);
      const ok = d && allowedParams(d);
      if (d && ok && !ok.includes(n.param)) throw new CalcError(badParam(d, n.param));
      if (d) throw new CalcError(missingParam(run, d, key, key));
      throw new CalcError(`No device "${n.path}" in the last run`);
    }
    case "neg": return negate(evalNode(n.a, env));
    case "bin": return binary(n.op, evalNode(n.a, env), evalNode(n.b, env));
    case "call": {
      if (n.scope) throw new CalcError(`Kept results hold signals — write ${n.name}(${n.scope}.v(…)) rather than ${n.scope}.${n.name}(…)`);
      if (n.name === "vec") {
        const a = n.args[0];
        if (n.args.length !== 1 || a.k !== "str") throw new CalcError('vec("name") takes the engine\'s vector name in quotes');
        const run = runFor(null, env);
        const v = run.vec.get(normName(a.s));
        if (!v) throw new CalcError(`No vector "${a.s}" in the last run`);
        return vecValue(run, v);
      }
      const f = FNS.get(n.name);
      if (!f) throw new CalcError(`Unknown function ${n.name}()`);
      if (n.args.length < f.min || n.args.length > f.max) {
        throw new CalcError(`${n.name}(${f.sig}) takes ${f.min === f.max ? f.min : `${f.min}–${f.max}`} argument${f.max === 1 ? "" : "s"}`);
      }
      const args = n.args.map((a, i) =>
        f.words?.includes(i) && a.k === "id" && !env.vars.has(a.name) ? str(a.name) : evalNode(a, env));
      return f.run(args);
    }
  }
}

// ── 줄들 ──────────────────────────────────────────────────────────────
export interface RowResult {
  src: string;
  name: string | null;
  value: Value | null;
  error: string | null;
  warnings: string[];
  blank: boolean;
}

/** 줄을 위에서 아래로 계산한다. 한 줄의 실패가 다음 줄을 막지 않는다 */
export function evaluateRows(lines: readonly string[], run: RunData | null, kept: ReadonlyMap<string, RunData>): RowResult[] {
  const env: Env = { run, kept, vars: new Map(), failed: new Map() };
  return lines.map((src, row) => {
    const p = parseLine(src);
    const out: RowResult = { src, name: p.name, value: null, error: null, warnings: p.warnings, blank: p.blank };
    if (p.blank) return out;
    if (p.error) {
      out.error = p.error.msg;
      if (p.name) env.failed.set(p.name, row);
      return out;
    }
    try {
      out.value = evalNode(p.expr!, env);
      if (p.name) { env.vars.set(p.name, out.value); env.failed.delete(p.name); }
    } catch (e) {
      out.error = e instanceof CalcError ? e.message : `Internal error: ${(e as Error)?.message ?? e}`;
      if (p.name) { env.failed.set(p.name, row); env.vars.delete(p.name); }
    }
    return out;
  });
}

// ── 다음 실행에 저장할 것 ─────────────────────────────────────────────
/**
 * 식들이 지난 실행이 아니라 **다음 실행에서** 쓸 벡터. 넷 전압은 그 넷이 있을 때만 (없는 넷을
 * .save 에 넣어도 엔진은 멈추지 않지만 쓸데없다), 소자 파라미터는 그 모델에 실제로 있는 이름만.
 * 보관해 둔 결과(dm.…)를 읽는 노드는 다음 실행과 상관없으므로 건너뛴다.
 */
export function calcSaves(
  lines: readonly string[], devices: DeviceTable, nets: ReadonlySet<string>,
  /** 돌릴 해석. AC · 잡음에서는 소자 파라미터로 읽는 전류가 뜻이 없어 묻지 않는다 */
  kind?: string,
): string[] {
  const out = new Set<string>();
  for (const src of lines) {
    const p = parseLine(src);
    walk(p.expr, n => {
      if (!("scope" in n) || n.scope) return;
      if (n.k === "sig") {
        if (n.fn[0] === "v") {
          for (const name of n.names) {
            const k = name.toLowerCase();
            if (k !== "0" && nets.has(k)) out.add(`v(${k})`);
          }
          return;
        }
        const d = findDevice(devices, n.names[0]);
        if (!d) return;
        const c = currentOf(d);
        if (c && "vector" in c) out.add(c.vector);
        else if (c && "param" in c && kind !== "ac" && kind !== "noise") {
          const ok = allowedParams(d);
          if (!ok || ok.includes(c.param)) out.add(vecName(d, c.param));
        }
      } else if (n.k === "dev") {
        const d = findDevice(devices, n.dev);
        if (!d) return;
        const need = deviceNeeds(n.fn, d, n.param ?? undefined);
        if ("vectors" in need) for (const v of need.vectors) out.add(v);
      } else if (n.k === "raw") {
        const d = [...devices.byName.values()].find(x => x.path === n.path);
        const ok = d && allowedParams(d);
        if (ok && !ok.includes(n.param)) return;
        out.add(`@${n.path}[${n.param}]`);
      }
    });
  }
  return [...out];
}

/** 줄 하나의 결과를 한 줄 글로 (테스트와 복사용) */
export function describe(r: RowResult): string {
  if (r.blank) return "";
  if (r.error) return "error: " + r.error;
  const v = r.value!;
  if (v.t === "num") return eng(v.re, v.unit);
  return v.t === "str" ? v.s : `waveform ${v.x.length} pts`;
}
