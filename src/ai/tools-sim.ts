/**
 * 시뮬레이션을 돌리고 결과를 읽는 도구.
 *
 * 결과 벡터를 통째로 보내지 않는다 — 과도 해석 한 번이 줄기마다 수천 점이고, 내부 노드까지 수백 줄기다.
 * 줄기마다 최소 · 최대 · 처음 · 끝만 요약하고, 모양이 궁금하면 read_trace 로 몇 점을 골라 읽게 한다.
 * 정확한 수치는 .meas 와 계산기 줄이 낸다 (엔진과 계산기가 재는 것이 모델이 눈대중하는 것보다 낫다).
 */
import { isUserName } from "../doc/wiring.ts";
import { tfGainUnit, type Trace } from "../sim-values.ts";
import { ToolError } from "./circuit.ts";
import { S, list, num, text, type Json, type Tool } from "./tool-kit.ts";
import type { AssistantHost, Results } from "./host.ts";

/** 가로축 줄기 — 파형 탭과 같은 규칙 (이름으로 찾는다) */
export function axisOf(ts: readonly Trace[]): Trace | undefined {
  return ts.find(t => t.name.toLowerCase() === "time")
    ?? ts.find(t => t.name.toLowerCase() === "frequency")
    ?? ts.find(t => /sweep/i.test(t.name));
}

/** 엔진이 만든 내부 이름 (서브회로 안의 노드, 소자 값) — 기본 요약에서 뺀다 */
const internal = (name: string) => /[.#@]/.test(name.replace(/^[vi]\(|\)$/gi, ""));

const sig = (v: number) => (Number.isFinite(v) ? Number(v.toPrecision(6)) : v);
const db = (m: number) => (m > 0 ? Number((20 * Math.log10(m)).toFixed(2)) : null);

/** 줄기 하나의 요약 */
function stats(t: Trace, x: Float64Array | undefined, ac: boolean): Json {
  const v = t.values;
  if (!v.length) return { name: t.name, points: 0 };
  let lo = 0, hi = 0;
  for (let i = 1; i < v.length; i++) {
    if (v[i] < v[lo]) lo = i;
    if (v[i] > v[hi]) hi = i;
  }
  const o: Json = { name: t.name };
  if (ac) {
    o.mag_first = sig(v[0]); o.mag_last = sig(v[v.length - 1]);
    o.mag_max = sig(v[hi]); o.db_max = db(v[hi]);
    if (x) o.f_at_max = sig(x[hi]);
    o.mag_min = sig(v[lo]);
    if (t.phaseDeg) { o.phase_first = sig(t.phaseDeg[0]); o.phase_last = sig(t.phaseDeg[t.phaseDeg.length - 1]); }
  } else {
    o.min = sig(v[lo]); o.max = sig(v[hi]);
    if (x && v.length > 1) { o.x_at_min = sig(x[lo]); o.x_at_max = sig(x[hi]); }
    o.first = sig(v[0]); o.last = sig(v[v.length - 1]);
  }
  return o;
}

/** 프로브한 넷과 이름 붙은 넷을 먼저 */
function rank(host: AssistantHost, ts: readonly Trace[]): Trace[] {
  const sheet = host.sheet(), ex = host.extraction();
  const probed = new Set(sheet.probes.map(p => ex.netAt(p.at)?.toLowerCase()).filter(Boolean) as string[]);
  const score = (t: Trace) => {
    const inner = t.name.replace(/^[vi]\(|\)$/gi, "").toLowerCase();
    if (/^v\(/i.test(t.name) && probed.has(inner)) return 0;
    if (/^v\(/i.test(t.name) && isUserName(inner)) return 1;
    if (/^i\(/i.test(t.name)) return 3;
    return 2;
  };
  return [...ts].sort((a, b) => score(a) - score(b));
}

const MAX_TRACES = 14;

/** 결과 요약. want 를 주면 그 줄기들만 */
export function summarizeResults(host: AssistantHost, r: Results, want: string[] = []): Json {
  const ts = r.traces;
  const axis = axisOf(ts);
  const x = axis?.values;
  const ac = ts.some(t => !!t.phaseDeg);
  const out: Json = { analysis: r.kind, current: r.current };
  if (!r.current) out.note = "These results are from before the last edit. Run again for the current circuit.";
  if (r.measures.length) out.measures = r.measures.map(m => ({ name: m.name, value: m.value === null ? null : sig(m.value), ...(m.detail ? { detail: m.detail } : {}) }));

  // 전달 함수 (.tf): 세 값
  const tf = ts.find(t => t.name.toLowerCase() === "v(transfer_function)");
  if (tf) {
    const unit = tfGainUnit(ts.map(t => t.name));
    const rin = ts.find(t => /#input_impedance\)$/i.test(t.name));
    const rout = ts.find(t => /^v\(output_impedance_at_|#output_impedance\)$/i.test(t.name));
    out.transfer_function = {
      gain: sig(tf.values[0]), gain_unit: unit || "V/V",
      ...(rin ? { input_resistance_ohm: sig(rin.values[0]) } : {}),
      ...(rout ? { output_resistance_ohm: sig(rout.values[0]) } : {}),
    };
    return out;
  }
  // 잡음: 두 스펙트럼
  const onoise = ts.find(t => t.name.toLowerCase() === "onoise_spectrum");
  if (onoise) {
    const inoise = ts.find(t => t.name.toLowerCase() === "inoise_spectrum");
    out.x = x ? { name: "frequency", from: sig(x[0]), to: sig(x[x.length - 1]), points: x.length } : undefined;
    out.noise = [stats(onoise, x, false), ...(inoise ? [stats(inoise, x, false)] : [])];
    out.note = (out.note ? out.note + " " : "") + "Densities in V/√Hz (or A/√Hz). Integrate with a calculator row such as rmsnoise(onoise, 10, 100k).";
    return out;
  }

  const named = (name: string) => ts.find(t => t.name.toLowerCase() === name.toLowerCase())
    ?? ts.find(t => t.name.toLowerCase() === `v(${name.toLowerCase()})`);
  let pick: Trace[];
  let omitted: string[] = [];
  if (want.length) {
    pick = [];
    const missing: string[] = [];
    for (const w of want) { const t = named(w); if (t) pick.push(t); else missing.push(w); }
    if (missing.length) out.missing = missing;
  } else {
    const all = rank(host, ts.filter(t => t !== axis && /^[vi]\(/i.test(t.name) && !internal(t.name)));
    pick = all.slice(0, x && x.length > 1 ? MAX_TRACES : 80);
    omitted = all.slice(pick.length).map(t => t.name);
  }
  if (x && x.length > 1) {
    out.x = { name: axis!.name, from: sig(x[0]), to: sig(x[x.length - 1]), points: x.length, ...(ac ? { scale: "log" } : {}) };
    out.traces = pick.map(t => stats(t, x, ac));
  } else {
    // 동작점: 점 하나 — 값만
    out.values = Object.fromEntries(pick.map(t => [t.name, sig(t.values[0])]));
  }
  if (omitted.length) out.more_traces = omitted.length > 40 ? [...omitted.slice(0, 40), `… ${omitted.length - 40} more`] : omitted;
  return out;
}

/** x 에서의 값 (선형 보간). x 는 한 방향으로만 간다 (시간 · 주파수 · 쓸어 올린 값) */
export function interpolate(xs: Float64Array, ys: Float64Array, x: number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  const up = xs[n - 1] >= xs[0];
  const v = (i: number) => (up ? xs[i] : -xs[i]);
  const want = up ? x : -x;
  if (want <= v(0)) return ys[0];
  if (want >= v(n - 1)) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (v(mid) <= want) lo = mid; else hi = mid;
  }
  const t = (want - v(lo)) / (v(hi) - v(lo) || 1);
  return ys[lo] + (ys[hi] - ys[lo]) * t;
}

export const simTools: Tool[] = [
  {
    name: "run_simulation",
    description:
      "Run the simulation with the current analysis settings and wait for it. Returns whether it worked, the ngspice error in plain words if not, " +
      "the .meas results, the calculator rows' values and a summary of the waveforms (min, max, first, last per trace). " +
      "The user sees the same results in the waveform, Measure and Calculator tabs. Pre-run errors (no ground, floating pins …) are returned without running.",
    needs: "simulate",
    async run({ host, settings, signal }) {
      const stop = () => host.stopSimulation();
      signal?.addEventListener("abort", stop, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<"timeout">(res => { timer = setTimeout(() => res("timeout"), settings.simTimeout * 1000); });
      const t0 = Date.now();
      const outcome = await Promise.race([host.simulate(), limit]);
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (outcome === "timeout") {
        host.stopSimulation();
        return {
          data: { ok: false, error: `The simulation ran longer than ${settings.simTimeout} s and was stopped. Make it shorter (tstop, max step, points) or ask the user to raise the limit in the assistant settings.` },
          summary: "timed out",
        };
      }
      if (!outcome.ok) {
        return {
          data: { ok: false, stage: outcome.stage, error: outcome.error, ...(outcome.issues ? { issues: outcome.issues.map(i => i.message) } : {}) },
          summary: outcome.stage === "check" ? "pre-run errors" : outcome.stage === "stopped" ? "stopped" : "failed",
        };
      }
      const r = host.results();
      const data: Json = { ok: true, seconds: Number(((outcome.runMs ?? Date.now() - t0) / 1000).toFixed(2)) };
      if (r) Object.assign(data, summarizeResults(host, r));
      if ((host.project().calc ?? []).some(l => l.trim())) {
        const values = await host.calcValues();
        if (values) data.calculator = values.filter(v => v.src.trim()).map(v => ({ row: v.src, value: v.text, ...(v.warnings.length ? { warnings: v.warnings } : {}) }));
      }
      const log = r?.log.split("\n").filter(l => /warning|note|error/i.test(l)).slice(0, 8) ?? [];
      if (log.length) data.log = log;
      return { data, summary: `ok, ${data.seconds} s` };
    },
  },
  {
    name: "get_results",
    description: "The last simulation's results again (summary, .meas values, calculator rows), and whether they still match the circuit. Pass traces to get only those.",
    params: { traces: S.strs("Trace names such as v(out) or i(V1) (optional)") },
    async run({ host, args }) {
      const r = host.results();
      const err = host.lastError();
      if (!r) return { data: { results: null, ...(err ? { last_run_failed: err } : { note: "Nothing has run yet." }) }, summary: "no results" };
      const data = summarizeResults(host, r, list<string>(args.traces, "traces"));
      if (err) data.last_run_failed = err;
      const values = (host.project().calc ?? []).length ? await host.calcValues() : null;
      if (values) data.calculator = values.filter(v => v.src.trim()).map(v => ({ row: v.src, value: v.text }));
      return { data, summary: r.current ? "current" : "stale" };
    },
  },
  {
    name: "read_trace",
    description:
      "Read one trace of the last run at chosen x values (time, frequency or swept value), or at evenly spaced points. " +
      "AC traces give magnitude, dB and phase.",
    params: {
      name: S.str("Trace name, for example v(out) (a bare net name also works)"),
      at: { type: "array", items: { type: "number" }, description: "x values to read at" },
      points: S.num("Or this many evenly spaced points (default 20, at most 200)"),
      from: S.num("Start of the range for points"),
      to: S.num("End of the range for points"),
    },
    required: ["name"],
    run({ host, args }) {
      const r = host.results();
      if (!r) throw new ToolError("Nothing has run yet. Call run_simulation first.");
      const want = text(args.name, "name", 200).trim();
      const t = r.traces.find(x => x.name.toLowerCase() === want.toLowerCase())
        ?? r.traces.find(x => x.name.toLowerCase() === `v(${want.toLowerCase()})`);
      if (!t) {
        const names = r.traces.filter(x => !internal(x.name)).map(x => x.name).slice(0, 60).join(", ");
        throw new ToolError(`There is no trace "${want}". Traces: ${names}.`);
      }
      const axis = axisOf(r.traces);
      if (!axis || axis.values.length < 2) return { data: { name: t.name, value: sig(t.values[0]) }, summary: t.name };
      const xs = axis.values;
      const log = !!t.phaseDeg && xs[0] > 0;
      let points: number[] = list<number>(args.at, "at").map(v => num(v, "at"));
      if (!points.length) {
        const n = Math.min(200, Math.max(2, Math.round(args.points === undefined ? 20 : num(args.points, "points"))));
        const a = args.from === undefined ? xs[0] : num(args.from, "from");
        const b = args.to === undefined ? xs[xs.length - 1] : num(args.to, "to");
        points = Array.from({ length: n }, (_, i) => {
          const f = i / (n - 1);
          return log && a > 0 && b > 0 ? a * Math.pow(b / a, f) : a + (b - a) * f;
        });
      }
      if (points.length > 200) throw new ToolError("At most 200 points.");
      const rows = points.map(x => {
        const o: Json = { x: sig(x) };
        const v = interpolate(xs, t.values, x);
        if (t.phaseDeg) { o.mag = sig(v); o.db = db(v); o.phase = sig(interpolate(xs, t.phaseDeg, x)); } else o.value = sig(v);
        return o;
      });
      return { data: { name: t.name, x: axis.name, rows, ...(r.current ? {} : { note: "From a run made before the last edit." }) }, summary: `${t.name}, ${rows.length} points` };
    },
  },
  {
    name: "view_waveform",
    description:
      "Look at the last run as a plot: voltages (or currents) against time, frequency (AC, log axis, magnitude) or the swept value. Use it to judge shapes " +
      "that numbers hide — ringing, overshoot, clipping, settling, distortion, a resonance peak. Read exact values with get_results, read_trace or .meas. " +
      "The picture is only kept until your answer.",
    params: {
      signals: S.strs("Traces to draw, such as v(out), out or i(V1) — at most 6, voltages and currents not mixed. Leave out for the probed nets, then the named ones."),
      from: S.num("Start of the x range (s, Hz or the swept value). Leave out for the whole run."),
      to: S.num("End of the x range"),
    },
    needs: "vision",
    run({ host, args }) {
      const r = host.results();
      if (!r) throw new ToolError(host.lastError() ? `The last run failed: ${host.lastError().split("\n")[0]}` : "Nothing has run yet. Call run_simulation first.");
      const ts = r.traces;
      if (ts.some(t => t.name.toLowerCase() === "v(transfer_function)")) throw new ToolError("A .tf result is three numbers, not a plot — use get_results.");
      if (ts.some(t => t.name.toLowerCase() === "onoise_spectrum")) throw new ToolError("Noise spectra are not drawn here — use read_trace onoise_spectrum, or a calculator row.");
      const axis = axisOf(ts);
      if (!axis || axis.values.length < 2) throw new ToolError("The result is a DC operating point (one value per node) — use get_results.");
      const want = list<string>(args.signals, "signals").map(w => text(w, "signals", 200).trim()).filter(Boolean);
      if (want.length > 6) throw new ToolError("At most 6 signals in one picture.");
      const names: string[] = [];
      for (const w of want) {
        const t = ts.find(x => x.name.toLowerCase() === w.toLowerCase()) ?? ts.find(x => x.name.toLowerCase() === `v(${w.toLowerCase()})`);
        if (!t || t === axis) {
          const known = ts.filter(x => x !== axis && /^[vi]\(/i.test(x.name) && !internal(x.name)).map(x => x.name).slice(0, 60).join(", ");
          throw new ToolError(`There is no trace "${w}". Traces: ${known}.`);
        }
        if (!names.includes(t.name)) names.push(t.name);
      }
      if (names.some(n => /^i\(/i.test(n)) && names.some(n => !/^i\(/i.test(n))) throw new ToolError("Draw voltages and currents in separate pictures — they have different units.");
      let note = "";
      if (!names.length) {
        // 고르지 않았으면 프로브한 넷, 이름 붙은 넷 차례로 (get_results 의 요약과 같은 차례)
        const ranked = rank(host, ts.filter(t => t !== axis && /^v\(/i.test(t.name) && !internal(t.name)));
        if (!ranked.length) throw new ToolError("There is no node voltage to draw. Pass signals (for example i(V1)).");
        names.push(...ranked.slice(0, 6).map(t => t.name));
        if (ranked.length > 6) note = `Drew ${names.length} of ${ranked.length} node voltages (probed and named nets first) — pass signals to choose.`;
      }
      const xs = axis.values, x0 = Math.min(xs[0], xs[xs.length - 1]), x1 = Math.max(xs[0], xs[xs.length - 1]);
      const from = args.from === undefined ? undefined : Math.max(x0, num(args.from, "from"));
      const to = args.to === undefined ? undefined : Math.min(x1, num(args.to, "to"));
      if ((from ?? x0) >= (to ?? x1)) throw new ToolError(`The range is empty. The run covers ${sig(x0)} to ${sig(x1)}.`);
      const pic = host.waveformImage({ signals: names, from, to });
      if ("error" in pic) throw new ToolError(pic.error);
      return {
        data: {
          picture: "attached below",
          signals: pic.shown,
          x: { name: pic.axis, from: sig(pic.from), to: sig(pic.to), ...(ts.some(t => !!t.phaseDeg) ? { scale: "log", y: "magnitude" } : {}) },
          ...(r.current ? {} : { stale: "From a run made before the last edit." }),
          ...(note || pic.note ? { note: [note, pic.note].filter(Boolean).join(" ") } : {}),
        },
        summary: `${pic.shown.join(", ")}${from !== undefined || to !== undefined ? " (zoomed)" : ""}`,
        images: [pic],
      };
    },
  },
];

