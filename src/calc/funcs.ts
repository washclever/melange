/**
 * 계산기 함수들.
 *
 * 함수마다 이름 · 인자 모양 · 분류 · 한 줄 설명을 같이 둔다. 도움말 창과 함수 고르기 목록이
 * 이 표를 그대로 읽는다 — 따로 적으면 언젠가 설명과 동작이 갈라진다.
 *
 * 인자에 숫자 대신 파형을 주면 대개 점마다 계산한다(수학 함수). 파형을 숫자 하나로 줄이는
 * 함수(mean · ymax · ugf …)에 숫자를 주면 그 숫자를 그대로 돌려준다 — .op 결과(점 하나)에도
 * 같은 식이 깨지지 않고 돈다.
 *
 * 성능지표의 정의는 Razavi, "Design of Analog CMOS Integrated Circuits" (2판) 를 따른다. 정의가
 * 여럿인 것(출력 스윙 · 코너 주파수)은 어느 정의인지 설명에 적었다.
 */
import { eng } from "./format.ts";
import {
  CalcError, ascending, at, axisWord, clip, crossings, cumulative, derivative, edges, integrate, interp, interpLogX,
  logAxis, magnitude, mkWave, num, onGridOf, stats, unwrappedPhase, valueAt, window, withY,
  type Edge, type Num, type Show, type Value, type Wave,
} from "./wave.ts";
import { estimateF0, harmonicsFor, integratePower, psdOf, spectrum, thdOf, windowName } from "./dsp.ts";
import { binary, mapComplex, mapReal, unitDiv, unitMul, unitPow } from "./ops.ts";

export const CATEGORIES = [
  "Signals", "Math", "Complex & dB", "Calculus", "Statistics", "Window & sampling", "Timing & events",
  "Spectrum & distortion", "Frequency response", "Noise", "DC transfer", "Device",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Fn {
  name: string;
  /** 도움말에 적을 인자 모양 */
  sig: string;
  cat: Category;
  doc: string;
  min: number;
  max: number;
  /** 이 자리의 인자는 따옴표 없는 낱말을 글자로 받는다 (rise · fall · hann …) */
  words?: number[];
  run(a: Value[]): Value;
}

// ── 인자 다루기 ───────────────────────────────────────────────────────
function W(v: Value | undefined, fn: string, what = "waveform"): Wave {
  if (v?.t === "wave") return v;
  if (v?.t === "num") {
    throw new CalcError(`${fn}() needs a ${what} — this is a single number (an operating point gives one value per signal)`);
  }
  throw new CalcError(`${fn}() needs a ${what}`);
}
function R(v: Value | undefined, fn: string, what = "waveform"): Wave {
  const w = W(v, fn, what);
  if (w.im) throw new CalcError(`${fn}() needs a real waveform — this one is complex (AC). Take db20(), mag() or phase() first`);
  return w;
}
function N(v: Value | undefined, fn: string, name: string, def?: number): number {
  if (v === undefined) {
    if (def === undefined) throw new CalcError(`${fn}() needs ${name}`);
    return def;
  }
  if (v.t === "num") {
    if (v.im !== 0) throw new CalcError(`${fn}(): ${name} must be a real number`);
    return v.re;
  }
  throw new CalcError(`${fn}(): ${name} must be a number${v.t === "wave" ? ", not a waveform" : ""}`);
}
const opt = (v: Value | undefined, fn: string, name: string): number | undefined => (v === undefined ? undefined : N(v, fn, name));
function S(v: Value | undefined, fn: string, name: string, def: string): string {
  if (v === undefined) return def;
  if (v.t === "str") return v.s;
  throw new CalcError(`${fn}(): ${name} must be a word such as ${def}`);
}
function edgeOf(v: Value | undefined, fn: string, def: Edge = "either"): Edge {
  const s = S(v, fn, "the edge", def).toLowerCase();
  if (s === "rise" || s === "rising" || s === "r") return "rise";
  if (s === "fall" || s === "falling" || s === "f") return "fall";
  if (s === "either" || s === "both" || s === "cross") return "either";
  throw new CalcError(`${fn}(): the edge is rise, fall or either — not "${s}"`);
}
const res = (v: number, unit: string, show?: Show, note?: string): Num => {
  const n = num(v, unit);
  if (show) n.show = show;
  if (note) n.note = note;
  return n;
};
/** 숫자를 받으면 그대로 (점 하나짜리 결과에도 같은 식이 돌게) */
const passNum = (v: Value | undefined): v is Num => v?.t === "num";

const FN: Fn[] = [];
const def = (f: Fn) => { FN.push(f); };

// ── 수학 ──────────────────────────────────────────────────────────────
const real1 = (name: string, f: (x: number) => number, doc: string) =>
  def({ name, sig: "x", cat: "Math", doc, min: 1, max: 1, run: a => mapReal(a[0], f, "", name) });

def({
  name: "abs", sig: "x", cat: "Math", doc: "Absolute value (the magnitude of a complex value)", min: 1, max: 1,
  run: a => mapComplex(a[0], (r, i) => [Math.hypot(r, i), 0], a[0].t === "str" ? "" : a[0].unit, "abs", true),
});
def({
  name: "sqrt", sig: "x", cat: "Math", doc: "Square root (principal value for complex)", min: 1, max: 1,
  run: a => {
    const v = a[0];
    const cx = v.t === "num" ? v.im !== 0 : v.t === "wave" && !!v.im;
    // 단위의 제곱근: √(V²) = V, √(kT/C) = V, √(4kTR) = V/√Hz
    const unit = unitPow(v.t === "str" ? "" : v.unit, 0.5);
    if (!cx) return mapReal(v, Math.sqrt, unit, "sqrt");
    return mapComplex(v, (r, i) => {
      const m = Math.hypot(r, i);
      return [Math.sqrt((m + r) / 2), (i < 0 ? -1 : 1) * Math.sqrt((m - r) / 2)];
    }, unit, "sqrt");
  },
});
def({
  name: "exp", sig: "x", cat: "Math", doc: "e to the x", min: 1, max: 1,
  run: a => mapComplex(a[0], (r, i) => { const m = Math.exp(r); return i === 0 ? [m, 0] : [m * Math.cos(i), m * Math.sin(i)]; }, "", "exp"),
});
for (const [name, base] of [["ln", 1], ["log", 1], ["log10", Math.LN10]] as const) {
  def({
    name, sig: "x", cat: "Math", doc: name === "log10" ? "Base-10 logarithm" : "Natural logarithm", min: 1, max: 1,
    run: a => {
      const v = a[0];
      const cx = v.t === "num" ? v.im !== 0 : v.t === "wave" && !!v.im;
      if (!cx) return mapReal(v, x => Math.log(x) / base, "", name);
      return mapComplex(v, (r, i) => [Math.log(Math.hypot(r, i)) / base, Math.atan2(i, r) / base], "", name);
    },
  });
}
def({ name: "pow", sig: "x, y", cat: "Math", doc: "x to the y (same as x^y)", min: 2, max: 2, run: a => binary("^", a[0], a[1]) });
real1("sin", Math.sin, "Sine (radians)");
real1("cos", Math.cos, "Cosine (radians)");
real1("tan", Math.tan, "Tangent (radians)");
real1("asin", Math.asin, "Arc sine (radians)");
real1("acos", Math.acos, "Arc cosine (radians)");
real1("atan", Math.atan, "Arc tangent (radians)");
real1("sinh", Math.sinh, "Hyperbolic sine");
real1("cosh", Math.cosh, "Hyperbolic cosine");
real1("tanh", Math.tanh, "Hyperbolic tangent");
real1("floor", Math.floor, "Round down to an integer");
real1("ceil", Math.ceil, "Round up to an integer");
real1("round", Math.round, "Round to the nearest integer");
real1("sign", Math.sign, "−1, 0 or +1");
def({
  name: "deg", sig: "x", cat: "Math", doc: "Radians to degrees", min: 1, max: 1,
  run: a => mapReal(a[0], x => (x * 180) / Math.PI, "°", "deg"),
});
def({
  name: "rad", sig: "x", cat: "Math", doc: "Degrees to radians", min: 1, max: 1,
  run: a => mapReal(a[0], x => (x * Math.PI) / 180, "", "rad"),
});

/** 실수 두 값을 점마다 (격자가 다르면 맞춘다) */
function zip(a: Value, b: Value, f: (x: number, y: number) => number, unit: string, fn: string): Value {
  if (a.t === "str" || b.t === "str") throw new CalcError(`${fn}() needs numbers or waveforms`);
  if ((a.t === "num" ? a.im : a.im ? 1 : 0) || (b.t === "num" ? b.im : b.im ? 1 : 0)) {
    throw new CalcError(`${fn}() needs real values — take mag() or real() first`);
  }
  if (a.t === "num" && b.t === "num") return num(f(a.re, b.re), unit);
  const base = (a.t === "wave" ? a : b) as Wave;
  const B = a.t === "wave" && b.t === "wave" ? onGridOf(a, b) : b;
  const n = base.x.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = f(a.t === "wave" ? a.re[i] : a.re, B.t === "wave" ? B.re[i] : (B as Num).re);
  }
  return withY(base, out, null, unit);
}
def({
  name: "atan2", sig: "y, x", cat: "Math", doc: "Angle of (x, y) in radians", min: 2, max: 2,
  run: a => zip(a[0], a[1], Math.atan2, "", "atan2"),
});
def({
  name: "hypot", sig: "a, b", cat: "Math", doc: "√(a² + b²)", min: 2, max: 2,
  run: a => zip(a[0], a[1], Math.hypot, a[0].t === "str" ? "" : a[0].unit, "hypot"),
});
for (const [name, red] of [["min", "ymin"], ["max", "ymax"]] as const) {
  def({
    name, sig: "w  |  a, b", cat: "Math",
    doc: name === "min" ? "One argument: the lowest value (= ymin). Two: the smaller of the two at each point"
      : "One argument: the highest value (= ymax). Two: the larger of the two at each point",
    min: 1, max: 2,
    run: a => a.length === 1 ? FNS.get(red)!.run(a)
      : zip(a[0], a[1], name === "min" ? Math.min : Math.max, a[0].t === "str" ? "" : a[0].unit, name),
  });
}

// ── 복소수 · dB ───────────────────────────────────────────────────────
def({
  name: "mag", sig: "x", cat: "Complex & dB", doc: "Magnitude |x|", min: 1, max: 1,
  run: a => mapComplex(a[0], (r, i) => [Math.hypot(r, i), 0], a[0].t === "str" ? "" : a[0].unit, "mag", true),
});
def({
  name: "phase", sig: "x", cat: "Complex & dB",
  doc: "Phase in degrees. Along a frequency axis it is unwrapped, so a Bode plot does not jump at ±180°", min: 1, max: 1,
  run: a => {
    const v = a[0];
    if (v.t === "str") throw new CalcError("phase() needs a number or a waveform");
    if (v.t === "num") return num((Math.atan2(v.im, v.re) * 180) / Math.PI, "°");
    return withY(v, unwrappedPhase(v), null, "°");
  },
});
def({
  name: "real", sig: "x", cat: "Complex & dB", doc: "Real part", min: 1, max: 1,
  run: a => mapComplex(a[0], r => [r, 0], a[0].t === "str" ? "" : a[0].unit, "real", true),
});
def({
  name: "imag", sig: "x", cat: "Complex & dB", doc: "Imaginary part", min: 1, max: 1,
  run: a => mapComplex(a[0], (_r, i) => [i, 0], a[0].t === "str" ? "" : a[0].unit, "imag", true),
});
def({
  name: "conj", sig: "x", cat: "Complex & dB", doc: "Complex conjugate", min: 1, max: 1,
  run: a => mapComplex(a[0], (r, i) => [r, -i], a[0].t === "str" ? "" : a[0].unit, "conj"),
});
def({
  name: "db20", sig: "x", cat: "Complex & dB", doc: "20·log10|x| — gains and voltages in dB", min: 1, max: 1,
  run: a => mapComplex(a[0], (r, i) => [20 * Math.log10(Math.hypot(r, i)), 0], "dB", "db20", true),
});
def({
  name: "db", sig: "x", cat: "Complex & dB", doc: "Same as db20", min: 1, max: 1,
  run: a => mapComplex(a[0], (r, i) => [20 * Math.log10(Math.hypot(r, i)), 0], "dB", "db", true),
});
def({
  name: "db10", sig: "x", cat: "Complex & dB", doc: "10·log10|x| — power ratios in dB", min: 1, max: 1,
  run: a => mapComplex(a[0], (r, i) => [10 * Math.log10(Math.hypot(r, i)), 0], "dB", "db10", true),
});

// ── 미적분 ────────────────────────────────────────────────────────────
def({
  name: "deriv", sig: "w", cat: "Calculus",
  doc: "Derivative dy/dx. On a DC sweep of the input this is the small-signal gain", min: 1, max: 1,
  run: a => {
    const w = W(a[0], "deriv");
    return withY(w, derivative(w.x, w.re), w.im ? derivative(w.x, w.im) : null, unitDiv(w.unit, w.xunit));
  },
});
def({
  name: "integ", sig: "w, from?, to?", cat: "Calculus", doc: "Definite integral ∫ y dx (a number)", min: 1, max: 3,
  run: a => {
    if (passNum(a[0])) throw new CalcError("integ() needs a waveform");
    const w = ascending(W(a[0], "integ"));
    const [lo, hi] = window(w, opt(a[1], "integ", "from"), opt(a[2], "integ", "to"));
    const re = integrate(w.x, w.re, lo, hi);
    const im = w.im ? integrate(w.x, w.im, lo, hi) : 0;
    // ∫ v² dt 는 V²·s. 단위를 모르는 것은 모르는 채로 남는다 (units.ts)
    return { t: "num", re, im, unit: unitMul(w.unit, w.xunit) };
  },
});
def({
  name: "iinteg", sig: "w", cat: "Calculus", doc: "Running integral — a waveform that starts at 0", min: 1, max: 1,
  run: a => {
    const w = ascending(W(a[0], "iinteg"));
    return withY(w, cumulative(w.x, w.re), w.im ? cumulative(w.x, w.im) : null, unitMul(w.unit, w.xunit));
  },
});

// ── 통계 ──────────────────────────────────────────────────────────────
const span = (a: Value[], fn: string): [number | undefined, number | undefined] => [opt(a[1], fn, "from"), opt(a[2], fn, "to")];
def({
  name: "mean", sig: "w, from?, to?", cat: "Statistics",
  doc: "Average over x (time-weighted — the samples of a transient are not evenly spaced)", min: 1, max: 3,
  run: a => {
    if (passNum(a[0])) return a[0];
    const w = W(a[0], "mean");
    const [f, t] = span(a, "mean");
    const s = stats(w, f, t);
    if (!w.im) return num(s.mean, w.unit);
    const im = stats(withY(w, w.im, null, w.unit), f, t).mean;
    return { t: "num", re: s.mean, im, unit: w.unit };
  },
});
def({ name: "avg", sig: "w, from?, to?", cat: "Statistics", doc: "Same as mean", min: 1, max: 3, run: a => FNS.get("mean")!.run(a) });
const stat1 = (name: string, doc: string, pick: (s: ReturnType<typeof stats>) => number, xunit = false) => def({
  name, sig: "w, from?, to?", cat: "Statistics", doc, min: 1, max: 3,
  run: a => {
    if (passNum(a[0])) {
      // 점 하나: 퍼짐은 0, 크기 · 최대 · 최소는 그 값 (복소수면 크기)
      const v = a[0];
      if (xunit) throw new CalcError(`${name}() needs a waveform`);
      if (name === "pp" || name === "stddev") return num(0, v.unit);
      return num(v.im !== 0 || name === "rms" ? Math.hypot(v.re, v.im) : v.re, v.unit);
    }
    const w = W(a[0], name);
    const [f, t] = span(a, name);
    return num(pick(stats(w, f, t)), xunit ? w.xunit : w.unit);
  },
});
stat1("rms", "Root mean square (time-weighted)", s => s.rms);
stat1("stddev", "Standard deviation (time-weighted; plain for sample points)", s => s.std);
stat1("ymax", "Highest value (the magnitude for complex)", s => s.max);
stat1("ymin", "Lowest value (the magnitude for complex)", s => s.min);
stat1("xmax", "x where the value is highest", s => s.xmax, true);
stat1("xmin", "x where the value is lowest", s => s.xmin, true);
stat1("pp", "Peak to peak: ymax − ymin", s => s.max - s.min);
def({
  name: "value", sig: "w, x", cat: "Statistics", doc: "The value at x, interpolated between samples", min: 2, max: 2,
  run: a => {
    if (passNum(a[0])) return a[0];
    const w = W(a[0], "value");
    const x = N(a[1], "value", "x");
    const [re, im] = valueAt(w, x);
    if (Number.isNaN(re)) {
      const s = ascending(w);
      throw new CalcError(`x = ${eng(x, w.xunit)} is outside the data (${eng(s.x[0], w.xunit)} … ${eng(s.x[s.x.length - 1], w.xunit)})`);
    }
    return { t: "num", re, im, unit: w.unit };
  },
});
for (const [name, doc, last] of [["first", "The first value", false], ["last", "The last value", true], ["final", "Same as last", true]] as const) {
  def({
    name, sig: "w", cat: "Statistics", doc, min: 1, max: 1,
    run: a => {
      if (passNum(a[0])) return a[0];
      const w = W(a[0], name);
      const i = last ? w.re.length - 1 : 0;
      return { t: "num", re: w.re[i], im: w.im ? w.im[i] : 0, unit: w.unit };
    },
  });
}
def({
  name: "npoints", sig: "w", cat: "Statistics", doc: "Number of points", min: 1, max: 1,
  run: a => num(passNum(a[0]) ? 1 : W(a[0], "npoints").x.length),
});

// ── 자르기 · 다시 찍기 ────────────────────────────────────────────────
def({
  name: "clip", sig: "w, from, to", cat: "Window & sampling", doc: "Only the part between from and to", min: 3, max: 3,
  run: a => clip(W(a[0], "clip"), N(a[1], "clip", "from"), N(a[2], "clip", "to")),
});
def({
  name: "sample", sig: "w, step, from?, to?", cat: "Window & sampling",
  doc: "Values every step, from from to to — sample points, the way a sampling circuit sees them", min: 2, max: 4,
  run: a => {
    const w = ascending(W(a[0], "sample"));
    const step = N(a[1], "sample", "step");
    if (!(step > 0)) throw new CalcError("sample(): step must be positive");
    const [lo, hi] = window(w, opt(a[2], "sample", "from"), opt(a[3], "sample", "to"));
    const n = Math.floor((hi - lo) / step + 1e-9) + 1;
    if (n > 1e6) throw new CalcError(`sample() would make ${n} points — use a larger step`);
    const x = new Float64Array(n), re = new Float64Array(n), im = w.im ? new Float64Array(n) : null;
    for (let k = 0; k < n; k++) {
      x[k] = lo + k * step;
      re[k] = at(w, w.re, x[k]);
      if (im) im[k] = at(w, w.im!, x[k]);
    }
    return mkWave(x, re, im, w.axis, w.xunit, w.unit, true);
  },
});
def({
  name: "resample", sig: "w, n, from?, to?", cat: "Window & sampling", doc: "n evenly spaced points (ends included)", min: 2, max: 4,
  run: a => {
    const w = ascending(W(a[0], "resample"));
    const n = Math.round(N(a[1], "resample", "n"));
    if (!(n >= 2 && n <= 1e6)) throw new CalcError("resample(): n must be between 2 and 1,000,000");
    const [lo, hi] = window(w, opt(a[2], "resample", "from"), opt(a[3], "resample", "to"));
    const x = new Float64Array(n), re = new Float64Array(n), im = w.im ? new Float64Array(n) : null;
    for (let k = 0; k < n; k++) {
      x[k] = logAxis(w) && lo > 0 ? lo * Math.pow(hi / lo, k / (n - 1)) : lo + ((hi - lo) * k) / (n - 1);
      re[k] = at(w, w.re, x[k]);
      if (im) im[k] = at(w, w.im!, x[k]);
    }
    return mkWave(x, re, im, w.axis, w.xunit, w.unit);
  },
});
def({
  name: "shift", sig: "w, dx", cat: "Window & sampling", doc: "Move along x by dx (a delay)", min: 2, max: 2,
  run: a => {
    const w = W(a[0], "shift");
    const dx = N(a[1], "shift", "dx");
    return mkWave(w.x.map(v => v + dx), w.re, w.im, w.axis, w.xunit, w.unit, w.discrete);
  },
});
def({
  name: "xval", sig: "w", cat: "Window & sampling", doc: "The x axis itself, as a waveform (time, frequency, sweep)", min: 1, max: 1,
  run: a => { const w = W(a[0], "xval"); return withY(w, w.x, null, w.xunit); },
});

// ── 시간 · 사건 ───────────────────────────────────────────────────────
function rangeText(w: Wave): string {
  const s = stats(w);
  return `${eng(s.min, w.unit)} … ${eng(s.max, w.unit)}`;
}
def({
  name: "cross", sig: "w, level, n=1, edge=either", cat: "Timing & events",
  doc: "x where w crosses level for the n-th time (negative n counts from the end). edge: rise, fall or either",
  min: 2, max: 4, words: [3],
  run: a => {
    const w = R(a[0], "cross");
    const level = N(a[1], "cross", "level");
    const n = Math.round(N(a[2], "cross", "n", 1));
    const e = edgeOf(a[3], "cross");
    const s = ascending(w);
    const c = crossings(s.x, s.re, level, e, logAxis(s));
    if (!c.length) {
      throw new CalcError(`It never crosses ${eng(level, w.unit)}${e === "either" ? "" : ` on a ${e === "rise" ? "rising" : "falling"} edge`} (it spans ${rangeText(w)})`);
    }
    if (n === 0) throw new CalcError("cross(): n counts from 1 (or from −1 at the end)");
    const k = n > 0 ? n - 1 : c.length + n;
    if (k < 0 || k >= c.length) throw new CalcError(`It crosses ${eng(level, w.unit)} only ${c.length} time${c.length === 1 ? "" : "s"}`);
    return num(c[k].x, w.xunit);
  },
});
def({
  name: "ncross", sig: "w, level, edge=either", cat: "Timing & events", doc: "How many times w crosses level", min: 2, max: 3, words: [2],
  run: a => {
    const w = ascending(R(a[0], "ncross"));
    return num(crossings(w.x, w.re, N(a[1], "ncross", "level"), edgeOf(a[2], "ncross")).length);
  },
});
const midLevel = (w: Wave): number => { const s = stats(w); return (s.max + s.min) / 2; };
def({
  name: "delay", sig: "w1, w2, edge1=either, edge2=either, level1?, level2?", cat: "Timing & events",
  doc: "Time from w1's first crossing to the next crossing of w2. Edges: rise, fall or either; levels default to each waveform's midpoint",
  min: 2, max: 6, words: [2, 3],
  run: a => {
    const w1 = ascending(R(a[0], "delay")), w2 = ascending(R(a[1], "delay"));
    const l1 = opt(a[4], "delay", "level1") ?? midLevel(w1);
    const l2 = opt(a[5], "delay", "level2") ?? midLevel(w2);
    const c1 = crossings(w1.x, w1.re, l1, edgeOf(a[2], "delay"));
    if (!c1.length) throw new CalcError(`The first waveform never crosses ${eng(l1, w1.unit)}`);
    const t1 = c1[0].x;
    const c2 = crossings(w2.x, w2.re, l2, edgeOf(a[3], "delay")).find(c => c.x >= t1);
    if (!c2) throw new CalcError(`The second waveform does not cross ${eng(l2, w2.unit)} after ${eng(t1, w1.xunit)}`);
    return num(c2.x - t1, w1.xunit);
  },
});

/**
 * 계단의 처음 · 끝 값. 주기 신호(클럭)처럼 처음과 끝이 같으면 최소 · 최대를 쓴다 — 그대로 두면
 * 계단의 크기가 0 이라 10 % · 90 % 가 같은 자리가 된다.
 */
function stepEnds(w: Wave, low: number | undefined, high: number | undefined, rising: boolean): [number, number] {
  const s = stats(w);
  const first = w.re[0], last = w.re[w.re.length - 1];
  const flat = Math.abs(last - first) < 0.01 * (s.max - s.min);
  const lo = low ?? (flat ? s.min : rising ? first : last);
  const hi = high ?? (flat ? s.max : rising ? last : first);
  return [lo, hi];
}
function transition(w0: Wave, fn: string, p1: number, p2: number, low: number | undefined, high: number | undefined, rising: boolean) {
  const w = ascending(w0);
  const [lo, hi] = stepEnds(w, low, high, rising);
  if (!(hi > lo)) {
    throw new CalcError(rising
      ? `It does not rise (${eng(w.re[0], w.unit)} → ${eng(w.re[w.re.length - 1], w.unit)}) — use falltime(), or give the levels: ${fn}(w, 10, 90, low, high)`
      : `It does not fall (${eng(w.re[0], w.unit)} → ${eng(w.re[w.re.length - 1], w.unit)}) — use risetime(), or give the levels: ${fn}(w, 10, 90, low, high)`);
  }
  const L1 = lo + (p1 / 100) * (hi - lo), L2 = lo + (p2 / 100) * (hi - lo);
  const edge: Edge = rising ? "rise" : "fall";
  const [first, second] = rising ? [L1, L2] : [L2, L1];
  const c1 = crossings(w.x, w.re, first, edge)[0];
  if (!c1) throw new CalcError(`It never crosses ${eng(first, w.unit)} (${rising ? p1 : p2} %)`);
  const c2 = crossings(w.x, w.re, second, edge).find(c => c.x >= c1.x);
  if (!c2) throw new CalcError(`It never reaches ${eng(second, w.unit)} (${rising ? p2 : p1} %) after ${eng(c1.x, w.xunit)}`);
  return { t: c2.x - c1.x, dv: Math.abs(L2 - L1), lo, hi, at: c1.x };
}
def({
  name: "risetime", sig: "w, p1=10, p2=90, low?, high?", cat: "Timing & events",
  doc: "Time from p1 % to p2 % of the step (initial → final value; min → max for a clock)", min: 1, max: 5,
  run: a => {
    const r = transition(R(a[0], "risetime"), "risetime", N(a[1], "risetime", "p1", 10), N(a[2], "risetime", "p2", 90),
      opt(a[3], "risetime", "low"), opt(a[4], "risetime", "high"), true);
    return res(r.t, "s", undefined, `${eng(r.lo, "")} → ${eng(r.hi, "")}, first edge at ${eng(r.at, "s")}`);
  },
});
def({
  name: "falltime", sig: "w, p1=10, p2=90, low?, high?", cat: "Timing & events",
  doc: "Time from p2 % down to p1 % of a falling step", min: 1, max: 5,
  run: a => {
    const r = transition(R(a[0], "falltime"), "falltime", N(a[1], "falltime", "p1", 10), N(a[2], "falltime", "p2", 90),
      opt(a[3], "falltime", "low"), opt(a[4], "falltime", "high"), false);
    return res(r.t, "s", undefined, `${eng(r.hi, "")} → ${eng(r.lo, "")}, first edge at ${eng(r.at, "s")}`);
  },
});
def({
  name: "slewrate", sig: "w, p1=10, p2=90, low?, high?", cat: "Timing & events",
  doc: "Slew rate: the change between p1 % and p2 % of the step divided by the time it takes (shown in V/µs)", min: 1, max: 5,
  run: a => {
    const w = R(a[0], "slewrate");
    const s = ascending(w);
    const rising = s.re[s.re.length - 1] >= s.re[0];
    const r = transition(w, "slewrate", N(a[1], "slewrate", "p1", 10), N(a[2], "slewrate", "p2", 90),
      opt(a[3], "slewrate", "low"), opt(a[4], "slewrate", "high"), rising);
    return res(r.dv / r.t, unitDiv(w.unit, w.xunit), undefined, rising ? "rising edge" : "falling edge");
  },
});
def({
  name: "settling", sig: "w, tol=1, t0?, final?", cat: "Timing & events",
  doc: "Time from t0 until w stays within ±tol % of the step around its final value (Razavi: 1 % settling)", min: 1, max: 4,
  run: a => {
    const w = ascending(R(a[0], "settling"));
    const tol = N(a[1], "settling", "tol", 1);
    const t0 = opt(a[2], "settling", "t0") ?? w.x[0];
    const n = w.x.length;
    const yi = interp(w.x, w.re, t0);
    const yf = opt(a[3], "settling", "final") ?? w.re[n - 1];
    const band = (Math.abs(tol) / 100) * Math.abs(yf - yi);
    if (!(band > 0)) throw new CalcError("The value at t0 equals the final value — there is no step (give t0 or final)");
    let out = -1;
    for (let i = n - 1; i >= 0 && w.x[i] >= t0; i--) {
      if (Math.abs(w.re[i] - yf) > band) { out = i; break; }
    }
    if (out < 0) return res(0, "s", undefined, `within ±${tol} % from t0`);
    if (out === n - 1) throw new CalcError(`It has not settled to ±${tol} % by the end of the run`);
    const ya = w.re[out], yb = w.re[out + 1];
    const edge = yf + Math.sign(ya - yf) * band;
    const f = (edge - ya) / (yb - ya);
    const t = w.x[out] + (w.x[out + 1] - w.x[out]) * Math.min(1, Math.max(0, f));
    return res(t - t0, "s", undefined, `±${tol} % of ${eng(Math.abs(yf - yi), w.unit)} around ${eng(yf, w.unit)}`);
  },
});
def({
  name: "overshoot", sig: "w, t0?", cat: "Timing & events",
  doc: "How far it goes past the final value, as a percentage of the step", min: 1, max: 2,
  run: a => {
    const w0 = ascending(R(a[0], "overshoot"));
    const t0 = opt(a[1], "overshoot", "t0");
    const w = t0 === undefined ? w0 : clip(w0, t0, w0.x[w0.x.length - 1]);
    const yi = w.re[0], yf = w.re[w.re.length - 1];
    const step = yf - yi;
    if (step === 0) throw new CalcError("The first and final values are equal — there is no step");
    const s = stats(w);
    const os = step > 0 ? (s.max - yf) / step : (yf - s.min) / -step;
    return res(Math.max(0, os), "", "pct");
  },
});

/** 주기 신호의 가장자리. 히스테리시스는 진폭의 5 % (링잉 · 잡음이 주기를 반토막 내지 않게) */
function periodic(w0: Value | undefined, lv: Value | undefined, ed: Value | undefined, fn: string): { t: number[]; w: Wave; level: number } {
  const w = ascending(R(w0, fn));
  const s = stats(w);
  const pp = s.max - s.min;
  if (!(pp > 0)) throw new CalcError("The waveform is flat — it has no period");
  const level = opt(lv, fn, "level") ?? (s.max + s.min) / 2;
  const room = Math.min(level - s.min, s.max - level);
  if (!(room > 0)) throw new CalcError(`level ${eng(level, w.unit)} is outside the waveform (${rangeText(w)})`);
  const h = Math.min(0.05 * pp, 0.45 * room);
  const e = edges(w.x, w.re, level, h);
  const edge = edgeOf(ed, fn, "rise");
  return { t: edge === "fall" ? e.fall : e.rise, w, level };
}
function periodsOf(t: number[], fn: string): number[] {
  if (t.length < 2) throw new CalcError(`${fn}() needs at least two edges — the run holds ${t.length}`);
  const p: number[] = [];
  for (let i = 1; i < t.length; i++) p.push(t[i] - t[i - 1]);
  return p;
}
def({
  name: "period", sig: "w, level?, edge=rise", cat: "Timing & events", doc: "Average period between edges (level defaults to the midpoint)",
  min: 1, max: 3, words: [2],
  run: a => {
    const { t } = periodic(a[0], a[1], a[2], "period");
    periodsOf(t, "period");
    return res((t[t.length - 1] - t[0]) / (t.length - 1), "s", undefined, `${t.length - 1} cycles`);
  },
});
def({
  name: "freq", sig: "w, level?, edge=rise", cat: "Timing & events", doc: "Frequency = 1/period (oscillators, clocks)",
  min: 1, max: 3, words: [2],
  run: a => {
    const { t } = periodic(a[0], a[1], a[2], "freq");
    periodsOf(t, "freq");
    return res((t.length - 1) / (t[t.length - 1] - t[0]), "Hz", undefined, `${t.length - 1} cycles`);
  },
});
def({
  name: "duty", sig: "w, level?", cat: "Timing & events", doc: "Fraction of each period spent above level", min: 1, max: 2,
  run: a => {
    const w = ascending(R(a[0], "duty"));
    const s = stats(w);
    const pp = s.max - s.min;
    if (!(pp > 0)) throw new CalcError("The waveform is flat");
    const level = opt(a[1], "duty", "level") ?? (s.max + s.min) / 2;
    const e = edges(w.x, w.re, level, Math.min(0.05 * pp, 0.45 * Math.min(level - s.min, s.max - level)));
    if (e.rise.length < 2) throw new CalcError("duty() needs at least two rising edges");
    let high = 0;
    for (let k = 0; k + 1 < e.rise.length; k++) {
      const f = e.fall.find(x => x > e.rise[k] && x < e.rise[k + 1]);
      if (f !== undefined) high += f - e.rise[k];
    }
    return res(high / (e.rise[e.rise.length - 1] - e.rise[0]), "", "pct");
  },
});
def({
  name: "periods", sig: "w, level?, edge=rise", cat: "Timing & events",
  doc: "Each period, as points at the edge that ends it — see the frequency settle (PLL lock) or spread (jitter)",
  min: 1, max: 3, words: [2],
  run: a => {
    const { t, w } = periodic(a[0], a[1], a[2], "periods");
    const p = periodsOf(t, "periods");
    return mkWave(Float64Array.from(t.slice(1)), Float64Array.from(p), null, w.axis, w.xunit, w.xunit, true);
  },
});
def({
  name: "instfreq", sig: "w, level?, edge=rise", cat: "Timing & events", doc: "1/period at each edge — the frequency over time",
  min: 1, max: 3, words: [2],
  run: a => {
    const { t, w } = periodic(a[0], a[1], a[2], "instfreq");
    const p = periodsOf(t, "instfreq");
    return mkWave(Float64Array.from(t.slice(1)), Float64Array.from(p, x => 1 / x), null, w.axis, w.xunit, "Hz", true);
  },
});
def({
  name: "jitter", sig: "w, level?, edge=rise", cat: "Timing & events", doc: "RMS period jitter: the standard deviation of the periods",
  min: 1, max: 3, words: [2],
  run: a => {
    const { t } = periodic(a[0], a[1], a[2], "jitter");
    const p = periodsOf(t, "jitter");
    const m = p.reduce((s, x) => s + x, 0) / p.length;
    const v = p.reduce((s, x) => s + (x - m) ** 2, 0) / p.length;
    return res(Math.sqrt(v), "s", undefined, `${p.length} periods, mean ${eng(m, "s")}`);
  },
});

// ── 스펙트럼 · 왜곡 ───────────────────────────────────────────────────
/**
 * 고조파 하나만 물어도 이만큼은 같이 맞춘다. 모형에 없는 고조파는 사라지지 않고 **맞춘 계수로 새어
 * 든다** — 격자가 고르지 않으면 cos kωt 들이 서로 직교하지 않기 때문이다. 2개만 맞추면 3차 고조파가
 * HD2 를 2e-4 만큼 틀리게 했다 (재 봤다). 신호에 든 고조파를 모형이 다 품으면 잔차가 0 이라 정확하다.
 */
const FIT_HARMONICS = 10;

const f0Of = (w: Wave, v: Value | undefined, fn: string): number => {
  const f = opt(v, fn, "f0");
  if (f !== undefined) {
    if (!(f > 0)) throw new CalcError(`${fn}(): f0 must be positive`);
    return f;
  }
  return estimateF0(w);
};
def({
  name: "fft", sig: "w, from?, to?, n?, window=hann", cat: "Spectrum & distortion",
  doc: "Spectrum: the amplitude of each frequency (a sine of amplitude A reads A). Windows: rect, hann, hamming, blackman, bh, flattop",
  min: 1, max: 5, words: [4],
  run: a => {
    const w = W(a[0], "fft");
    const sp = spectrum(w, opt(a[1], "fft", "from"), opt(a[2], "fft", "to"), opt(a[3], "fft", "n"), windowName(S(a[4], "fft", "window", "hann")));
    return mkWave(sp.f, sp.re, sp.im, "spectrum", "Hz", w.unit);
  },
});
def({
  name: "psd", sig: "w, from?, to?, n?, window=hann", cat: "Spectrum & distortion",
  doc: "Power spectral density (unit²/Hz) — for noise in a transient", min: 1, max: 5, words: [4],
  run: a => {
    const w = W(a[0], "psd");
    const sp = spectrum(w, opt(a[1], "psd", "from"), opt(a[2], "psd", "to"), opt(a[3], "psd", "n"), windowName(S(a[4], "psd", "window", "hann")));
    return mkWave(sp.f, psdOf(sp), null, "spectrum", "Hz", unitDiv(unitPow(w.unit, 2), "Hz"));
  },
});
def({
  name: "harmonic", sig: "w, k, f0?, from?, to?", cat: "Spectrum & distortion",
  doc: "Amplitude of the k-th harmonic (k = 1 is the fundamental), fitted at f0", min: 2, max: 5,
  run: a => {
    const w = R(a[0], "harmonic");
    const k = Math.round(N(a[1], "harmonic", "k"));
    if (k < 1 || k > 20) throw new CalcError("harmonic(): k is 1 … 20");
    const h = harmonicsFor(w, f0Of(w, a[2], "harmonic"), Math.max(k, FIT_HARMONICS), opt(a[3], "harmonic", "from"), opt(a[4], "harmonic", "to"));
    if (k > h.nh) throw new CalcError(`Too few samples per period to fit harmonic ${k} — lower the transient's max step`);
    return res(h.amp[k], w.unit, undefined, `f0 = ${eng(h.f0, "Hz")}, phase ${h.phase[k].toFixed(2)}°`);
  },
});
def({
  name: "hd", sig: "w, k, f0?, from?, to?", cat: "Spectrum & distortion",
  doc: "k-th harmonic distortion: A_k / A_1 (HD2, HD3 …)", min: 2, max: 5,
  run: a => {
    const w = R(a[0], "hd");
    const k = Math.round(N(a[1], "hd", "k"));
    if (k < 2 || k > 20) throw new CalcError("hd(): k is 2 … 20");
    const h = harmonicsFor(w, f0Of(w, a[2], "hd"), Math.max(k, FIT_HARMONICS), opt(a[3], "hd", "from"), opt(a[4], "hd", "to"));
    if (k > h.nh) throw new CalcError(`Too few samples per period to fit harmonic ${k} — lower the transient's max step`);
    return res(h.amp[k] / h.amp[1], "", "pct", `f0 = ${eng(h.f0, "Hz")}, A1 = ${eng(h.amp[1], w.unit)}`);
  },
});
def({
  name: "thd", sig: "w, f0?, n=10, from?, to?", cat: "Spectrum & distortion",
  doc: "Total harmonic distortion √(A2² + … + An²) / A1 — fitted on whole periods of the second half by default", min: 1, max: 5,
  run: a => {
    const w = R(a[0], "thd");
    const nh = Math.round(N(a[2], "thd", "n", 10));
    if (nh < 2 || nh > 20) throw new CalcError("thd(): n is 2 … 20 harmonics");
    const h = harmonicsFor(w, f0Of(w, a[1], "thd"), nh, opt(a[3], "thd", "from"), opt(a[4], "thd", "to"));
    const note = `f0 = ${eng(h.f0, "Hz")}, ${h.nh} harmonics, ${eng(h.from, "s")} … ${eng(h.to, "s")}` +
      (h.nh < nh ? ` (only ${h.nh} fit at this time step)` : "");
    return res(thdOf(h), "", "pct", note);
  },
});
/*
 * SNDR · SFDR 도 FFT 가 아니라 맞추기로 잰다. 기본 구간(뒤쪽 절반의 정수 주기)은 주기가 몇 개뿐일
 * 때가 많은데, 그러면 창의 주 엽이 2 · 3 차 고조파를 신호 쪽으로 삼켜 SNDR 이 20 dB 넘게 좋게
 * 나온다 (재 봤다: 1 % HD2 에 62.8 dB, 맞는 값은 40 dB). 정수 주기 구간에서는 시간 영역의 분산이
 * 정확히 신호 전력 + 나머지 전력이라 누설이 끼어들 틈이 없다.
 */
function distortion(a: Value[], fn: string) {
  const w = R(a[0], fn);
  const h = harmonicsFor(w, f0Of(w, a[1], fn), FIT_HARMONICS, opt(a[2], fn, "from"), opt(a[3], fn, "to"));
  const s = stats(w, h.from, h.to);
  const sig = (h.amp[1] * h.amp[1]) / 2;
  const rest = Math.max(s.std * s.std - sig, 1e-300);
  let spur = 0, at = 0;
  for (let k = 2; k <= h.nh; k++) if (h.amp[k] > spur) { spur = h.amp[k]; at = k; }
  return { h, sig, rest, spur, at, w };
}
def({
  name: "sfdr", sig: "w, f0?, from?, to?", cat: "Spectrum & distortion",
  doc: "Spurious-free dynamic range: the fundamental over the largest harmonic (dB)", min: 1, max: 4,
  run: a => {
    const r = distortion(a, "sfdr");
    return res(20 * Math.log10(r.h.amp[1] / r.spur), "dB", undefined, r.at ? `largest: harmonic ${r.at}` : "");
  },
});
def({
  name: "sndr", sig: "w, f0?, from?, to?", cat: "Spectrum & distortion",
  doc: "Signal to noise-and-distortion ratio: fundamental power over everything else (dB)", min: 1, max: 4,
  run: a => {
    const r = distortion(a, "sndr");
    return res(10 * Math.log10(r.sig / r.rest), "dB", undefined, `f0 = ${eng(r.h.f0, "Hz")}`);
  },
});
def({
  name: "enob", sig: "w, f0?, from?, to?", cat: "Spectrum & distortion",
  doc: "Effective number of bits: (SNDR − 1.76) / 6.02", min: 1, max: 4,
  run: a => {
    const r = distortion(a, "enob");
    return res((10 * Math.log10(r.sig / r.rest) - 1.76) / 6.02, "bits");
  },
});

// ── 주파수 응답 ───────────────────────────────────────────────────────
function freqResp(v: Value | undefined, fn: string): Wave {
  const w = W(v, fn, "frequency response");
  if (w.axis !== "frequency" && w.axis !== "spectrum") {
    throw new CalcError(`${fn}() needs a frequency response (an AC analysis) — this is a ${axisWord(w.axis)} waveform`);
  }
  const s = ascending(w);
  if (s.x.length < 2) throw new CalcError(`${fn}() needs at least two frequencies`);
  return s;
}
const dB = (m: number) => 20 * Math.log10(m);

/** |H| 가 처음으로 level 아래로 내려가는 주파수. 로그 주파수 · dB 에서 보간한다 */
function firstBelow(w: Wave, m: Float64Array, level: number): number | null {
  for (let i = 1; i < m.length; i++) {
    if (m[i - 1] >= level && m[i] < level) {
      const f0 = w.x[i - 1], f1 = w.x[i];
      const u = (dB(level) - dB(m[i - 1])) / (dB(m[i]) - dB(m[i - 1]));
      return f0 > 0 ? f0 * Math.pow(f1 / f0, u) : f0 + (f1 - f0) * u;
    }
  }
  return null;
}
/**
 * 위상을 펼치고, 낮은 주파수의 위상이 ±180° 근처면(반전 증폭) 0° 로 옮긴다.
 * 위상 여유는 루프 이득 βH 의 위상으로 정의한다 (Razavi 10.3: PM = 180° + ∠βH(ω1)). 반전 증폭기의
 * v(out)/v(in) 은 처음부터 180° 라 그대로 쓰면 여유가 180° 만큼 틀린다 — 음의 되먹임에서 그 부호는
 * 되먹임 쪽에 들어가 있는 것으로 본다.
 */
function loopPhase(w: Wave): Float64Array {
  const p = unwrappedPhase(w);
  const p0 = p[0];
  const shift = Math.abs(p0) > 90 ? -180 * Math.round(p0 / 180) : -360 * Math.round(p0 / 360);
  return shift ? p.map(x => x + shift) : p;
}
function ugfOf(w: Wave, m: Float64Array): number {
  if (m[0] < 1) throw new CalcError(`|H| is already below 1 at ${eng(w.x[0], "Hz")} (${eng(m[0], "")}) — there is no unity-gain crossing`);
  const f = firstBelow(w, m, 1);
  if (f === null) throw new CalcError(`|H| stays above 1 up to ${eng(w.x[w.x.length - 1], "Hz")} — extend the AC sweep`);
  return f;
}
def({
  name: "dcgain", sig: "H", cat: "Frequency response", doc: "|H| at the lowest frequency of the sweep — A0", min: 1, max: 1,
  run: a => {
    if (passNum(a[0])) return res(Math.hypot(a[0].re, a[0].im), a[0].unit, "gain");
    const w = freqResp(a[0], "dcgain");
    return res(magnitude(w)[0], w.unit, "gain", `at ${eng(w.x[0], "Hz")}`);
  },
});
/**
 * "−3 dB" 는 **반전력점**이다: |H| 가 1/√2 (−3.0103 dB) 로 내려간 곳. 딱 3 dB 로 재면 단극점의 대역폭이
 * 극점보다 0.24 % 낮게 나온다 — Razavi 의 3-dB 대역폭 ω0 는 극점 그 자체다. 다른 값을 주면 그 dB 그대로 잰다.
 */
const f3db = (a: Value[], fn: string): Num => {
  const w = freqResp(a[0], fn);
  const drop = N(a[1], fn, "dB", 3);
  const m = magnitude(w);
  const f = firstBelow(w, m, m[0] * (drop === 3 ? Math.SQRT1_2 : Math.pow(10, -drop / 20)));
  if (f === null) throw new CalcError(`|H| stays within ${drop} dB of its low-frequency value up to ${eng(w.x[w.x.length - 1], "Hz")}`);
  return res(f, "Hz");
};
def({ name: "f3db", sig: "H, dB=3", cat: "Frequency response", doc: "Bandwidth: where |H| has fallen to 1/√2 of its low-frequency value (the half-power point; another dB value is taken as given)", min: 1, max: 2, run: a => f3db(a, "f3db") });
def({ name: "bw", sig: "H, dB=3", cat: "Frequency response", doc: "Same as f3db", min: 1, max: 2, run: a => f3db(a, "bw") });
def({
  name: "ugf", sig: "H", cat: "Frequency response", doc: "Unity-gain frequency fu: where |H| falls through 1 (0 dB)", min: 1, max: 1,
  run: a => { const w = freqResp(a[0], "ugf"); return res(ugfOf(w, magnitude(w)), "Hz"); },
});
def({
  name: "gbw", sig: "H", cat: "Frequency response", doc: "Gain-bandwidth product A0 · f−3dB", min: 1, max: 1,
  run: a => {
    const w = freqResp(a[0], "gbw");
    const m = magnitude(w);
    return res(m[0] * f3db(a, "gbw").re, "Hz");
  },
});
def({
  name: "pm", sig: "H", cat: "Frequency response",
  doc: "Phase margin 180° + ∠H at the unity-gain frequency. H is the loop gain (or the open-loop gain for a unity-gain loop)", min: 1, max: 1,
  run: a => {
    const w = freqResp(a[0], "pm");
    if (!w.im) throw new CalcError("pm() needs the phase — give the complex AC result, not mag() or db20()");
    const m = magnitude(w);
    const fu = ugfOf(w, m);
    const ph = interpLogX(w.x, loopPhase(w), fu);
    return res(180 + ph, "°", undefined, `at fu = ${eng(fu, "Hz")}`);
  },
});
function phaseCross(w: Wave): number | null {
  const p = loopPhase(w);
  for (let i = 1; i < p.length; i++) {
    if (p[i - 1] > -180 && p[i] <= -180) {
      const f0 = w.x[i - 1], f1 = w.x[i];
      const u = (-180 - p[i - 1]) / (p[i] - p[i - 1]);
      return f0 > 0 ? f0 * Math.pow(f1 / f0, u) : f0 + (f1 - f0) * u;
    }
  }
  return null;
}
def({
  name: "gainmargin", sig: "H", cat: "Frequency response", doc: "Gain margin −20·log10|H| where the phase reaches −180° (dB)", min: 1, max: 1,
  run: a => {
    const w = freqResp(a[0], "gainmargin");
    if (!w.im) throw new CalcError("gainmargin() needs the phase — give the complex AC result");
    const f = phaseCross(w);
    if (f === null) return res(Infinity, "dB", undefined, "the phase never reaches −180° in the sweep");
    const m = magnitude(w);
    return res(-interpLogX(w.x, Float64Array.from(m, dB), f), "dB", undefined, `at ${eng(f, "Hz")}`);
  },
});
def({
  name: "pcross", sig: "H", cat: "Frequency response", doc: "Phase crossover: where the phase reaches −180°", min: 1, max: 1,
  run: a => {
    const w = freqResp(a[0], "pcross");
    if (!w.im) throw new CalcError("pcross() needs the phase — give the complex AC result");
    const f = phaseCross(w);
    if (f === null) throw new CalcError("The phase never reaches −180° in the sweep");
    return res(f, "Hz");
  },
});
def({
  name: "peaking", sig: "H", cat: "Frequency response", doc: "How far |H| rises above its low-frequency value (dB, 0 if it never does)", min: 1, max: 1,
  run: a => {
    const w = freqResp(a[0], "peaking");
    const m = magnitude(w);
    let mx = m[0], fm = w.x[0];
    for (let i = 1; i < m.length; i++) if (m[i] > mx) { mx = m[i]; fm = w.x[i]; }
    return res(dB(mx / m[0]), "dB", undefined, mx > m[0] ? `at ${eng(fm, "Hz")}` : "");
  },
});
def({
  name: "groupdelay", sig: "H", cat: "Frequency response", doc: "Group delay −dφ/dω (s)", min: 1, max: 1,
  run: a => {
    const w = freqResp(a[0], "groupdelay");
    const ph = unwrappedPhase(w).map(p => (p * Math.PI) / 180);
    const d = derivative(w.x, ph).map(v => -v / (2 * Math.PI));
    return withY(w, d, null, "s");
  },
});
def({
  name: "middlebrook", sig: "Tv, Ti", cat: "Frequency response",
  doc: "Loop gain from Middlebrook's two injections: (Tv·Ti − 1) / (Tv + Ti + 2)", min: 2, max: 2,
  run: a => {
    const one = num(1), two = num(2);
    return binary("/", binary("-", binary("*", a[0], a[1]), one), binary("+", binary("+", a[0], a[1]), two));
  },
});

// ── 잡음 ──────────────────────────────────────────────────────────────
/** 밀도 단위에서 /√Hz 를 떼면 적분한 RMS 의 단위다 */
/** 밀도 S 를 √(∫ S² df) 로 적분한 값의 단위: V/√Hz → V, A/√Hz → A */
const rmsUnit = (u: string): string => unitPow(unitMul(unitPow(u, 2), "Hz"), 0.5);
def({
  name: "rmsnoise", sig: "density, f1?, f2?", cat: "Noise",
  doc: "RMS noise: √(∫ S(f) df) of a spectral density (V/√Hz) between f1 and f2 — e.g. rmsnoise(onoise, 1, 1g)", min: 1, max: 3,
  run: a => {
    const w = freqResp(a[0], "rmsnoise");
    const [lo, hi] = window(w, opt(a[1], "rmsnoise", "f1"), opt(a[2], "rmsnoise", "f2"));
    const m = magnitude(w);
    const s = Float64Array.from(m, v => v * v);
    const asked = [opt(a[1], "rmsnoise", "f1"), opt(a[2], "rmsnoise", "f2")];
    const clamped = (asked[0] !== undefined && asked[0] < lo) || (asked[1] !== undefined && asked[1] > hi);
    return res(Math.sqrt(integratePower(w.x, s, lo, hi)), rmsUnit(w.unit), undefined,
      `${eng(lo, "Hz")} … ${eng(hi, "Hz")}${clamped ? " (the sweep's range)" : ""}`);
  },
});
def({
  name: "fcorner", sig: "density", cat: "Noise",
  doc: "Flicker-noise corner: where 1/f and white noise are equal — the log-log slope is half its low-frequency value", min: 1, max: 1,
  run: a => {
    const w = freqResp(a[0], "fcorner");
    const m = magnitude(w);
    const n = m.length;
    if (n < 4 || !(w.x[0] > 0)) throw new CalcError("fcorner() needs a noise sweep on a log axis with a few points");
    const lf = Float64Array.from(w.x, Math.log), ls = Float64Array.from(m, v => 2 * Math.log(v));
    const slope = derivative(lf, ls);
    const s0 = (slope[0] + slope[1]) / 2;
    if (!(s0 < -0.3)) throw new CalcError("The density is not falling at the start of the sweep — there is no 1/f region (start the sweep lower)");
    const target = s0 / 2;
    for (let i = 1; i < n; i++) {
      if (slope[i - 1] < target && slope[i] >= target) {
        const u = (target - slope[i - 1]) / (slope[i] - slope[i - 1]);
        return res(Math.exp(lf[i - 1] + u * (lf[i] - lf[i - 1])), "Hz", undefined, `1/f^${(-s0).toFixed(2)} meets the floor`);
      }
    }
    throw new CalcError("The 1/f noise reaches the end of the sweep — extend the sweep upward");
  },
});
def({
  name: "enbw", sig: "H", cat: "Noise",
  doc: "Noise-equivalent bandwidth ∫|H|² df / |H(0)|² (a single pole gives π/2 · f−3dB)", min: 1, max: 1,
  run: a => {
    const w = freqResp(a[0], "enbw");
    const m = magnitude(w);
    const s = Float64Array.from(m, v => v * v);
    // 식 (7.146) 의 적분은 0 부터다. 스윕이 시작하기 전은 첫 값으로 평평하다고 본다 (첫 주파수만큼의 폭)
    return res(w.x[0] + integratePower(w.x, s, w.x[0], w.x[w.x.length - 1]) / s[0], "Hz");
  },
});
def({
  name: "snr", sig: "signal, noise", cat: "Noise", doc: "Signal-to-noise ratio 20·log10(signal/noise) of two RMS values (dB)", min: 2, max: 2,
  run: a => mapReal(binary("/", a[0], a[1]), x => 20 * Math.log10(Math.abs(x)), "dB", "snr"),
});

// ── DC 전달 ───────────────────────────────────────────────────────────
def({
  name: "slope", sig: "w, x", cat: "DC transfer", doc: "dy/dx at x — the small-signal gain at that bias on a DC sweep", min: 2, max: 2,
  run: a => {
    const w = ascending(R(a[0], "slope"));
    const x = N(a[1], "slope", "x");
    const v = interp(w.x, derivative(w.x, w.re), x);
    if (Number.isNaN(v)) throw new CalcError(`x = ${eng(x, w.xunit)} is outside the sweep`);
    return num(v, unitDiv(w.unit, w.xunit));
  },
});
/** 이득 |dy/dx| 가 봉우리의 frac 이상인 구간 [x1, x2] — 봉우리를 낀 이어진 구간 */
function gainBand(w: Wave, frac: number): { x1: number; x2: number; g: number } {
  const g = derivative(w.x, w.re).map(Math.abs);
  let k = 0;
  for (let i = 1; i < g.length; i++) if (g[i] > g[k]) k = i;
  const thr = frac * g[k];
  let l = k, r = k;
  while (l > 0 && g[l - 1] >= thr) l--;
  while (r < g.length - 1 && g[r + 1] >= thr) r++;
  const edge = (i: number, j: number) => (g[i] === g[j] ? w.x[i] : w.x[i] + ((w.x[j] - w.x[i]) * (thr - g[i])) / (g[j] - g[i]));
  const x1 = l > 0 ? edge(l - 1, l) : w.x[0];
  const x2 = r < g.length - 1 ? edge(r + 1, r) : w.x[g.length - 1];
  return { x1, x2, g: g[k] };
}
def({
  name: "swing", sig: "w, frac=0.5", cat: "DC transfer",
  doc: "Output swing on a DC transfer curve: how far the output moves while the gain stays above frac of its peak", min: 1, max: 2,
  run: a => {
    const w = ascending(R(a[0], "swing"));
    const frac = N(a[1], "swing", "frac", 0.5);
    if (!(frac > 0 && frac < 1)) throw new CalcError("swing(): frac is between 0 and 1 (0.5 = the gain within 6 dB of its peak)");
    const b = gainBand(w, frac);
    const y1 = interp(w.x, w.re, b.x1), y2 = interp(w.x, w.re, b.x2);
    return res(Math.abs(y2 - y1), w.unit, undefined,
      `${eng(Math.min(y1, y2), w.unit)} … ${eng(Math.max(y1, y2), w.unit)} (input ${eng(b.x1, w.xunit)} … ${eng(b.x2, w.xunit)}, peak gain ${eng(b.g, "")})`);
  },
});
def({
  name: "nonlin", sig: "w, x1?, x2?", cat: "DC transfer",
  doc: "Nonlinearity (Razavi 14.1.1): the largest deviation from the straight line through the end points, over the output span", min: 1, max: 3,
  run: a => {
    const w = clip(R(a[0], "nonlin"), opt(a[1], "nonlin", "x1"), opt(a[2], "nonlin", "x2"));
    const n = w.x.length;
    const xa = w.x[0], xb = w.x[n - 1], ya = w.re[0], yb = w.re[n - 1];
    if (xb === xa || yb === ya) throw new CalcError("The end points have the same value — there is no span to compare with");
    let dev = 0, where = xa;
    for (let i = 0; i < n; i++) {
      const line = ya + ((yb - ya) * (w.x[i] - xa)) / (xb - xa);
      const d = Math.abs(w.re[i] - line);
      if (d > dev) { dev = d; where = w.x[i]; }
    }
    return res(dev / Math.abs(yb - ya), "", "pct", `ΔV = ${eng(dev, w.unit)} at ${eng(where, w.xunit)}`);
  },
});
def({
  name: "tc", sig: "w, x?", cat: "DC transfer",
  doc: "Temperature coefficient on a temperature sweep: (max − min)/(mean · ΔT) in ppm/°C, or (1/y)·dy/dx at x", min: 1, max: 2,
  run: a => {
    const w = ascending(R(a[0], "tc"));
    const unit = w.axis === "temp" ? "ppm/°C" : w.xunit ? "ppm/" + w.xunit : "ppm";
    const x = opt(a[1], "tc", "x");
    if (x !== undefined) {
      const d = interp(w.x, derivative(w.x, w.re), x), y = interp(w.x, w.re, x);
      if (Number.isNaN(d)) throw new CalcError(`x = ${eng(x, w.xunit)} is outside the sweep`);
      return res((d / y) * 1e6, unit);
    }
    const s = stats(w);
    const dx = w.x[w.x.length - 1] - w.x[0];
    return res(((s.max - s.min) / (Math.abs(s.mean) * dx)) * 1e6, unit, undefined, `box method over ${eng(dx, w.xunit)}`);
  },
});

export const FNS: ReadonlyMap<string, Fn> = new Map(FN.map(f => [f.name, f]));
export const FUNCTIONS: readonly Fn[] = FN;
