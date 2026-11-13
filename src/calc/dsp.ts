/**
 * 스펙트럼과 고조파.
 *
 * 두 가지 길이 있다. 고르는 기준은 "무엇을 알고 있는가" 다.
 *
 * 1. **FFT** (fft · psd · sfdr · sndr) — 스펙트럼 전체를 본다. ngspice 의 과도 해석은 간격이
 *    고르지 않으므로 먼저 고르게 다시 찍는다(점 사이는 직선). 창 함수를 고를 수 있다.
 *
 * 2. **최소제곱 고조파 맞추기** (harmonic · hd · thd) — 기본 주파수 f0 를 알면 미지수는 고조파마다
 *    둘(cos · sin)뿐이다. 비균일 샘플에 그대로 쓰고, 다시 찍을 때의 보간 오차도 창의 누설도 없다.
 *    이 앱의 진폭 · 위상 측정이 FFT 대신 사인 맞추기를 쓰는 것(src/measure.ts)과 같은 이유다 —
 *    -100 dB 아래의 고조파는 보간 오차에 묻힌다.
 *
 *    가중치는 각 점이 차지하는 시간 폭이다. 그래야 연속 시간의 푸리에 계수와 같아진다 —
 *    점마다 같은 무게를 주면 빠르게 변하는 구간(점이 몰린 곳)에 맞추느라 계수가 치우친다.
 */
import { eng } from "./format.ts";
import { CalcError, ascending, clip, edges, nextPow2, stats, uniform, window, type Wave } from "./wave.ts";

export const WINDOWS = ["rect", "hann", "hamming", "blackman", "bh", "flattop"] as const;
export type WindowName = (typeof WINDOWS)[number];

/** 창마다 주 엽의 반폭 (빈). 신호의 전력으로 셀 칸이다 */
const LOBE: Record<WindowName, number> = { rect: 1, hann: 2, hamming: 2, blackman: 3, bh: 4, flattop: 5 };

/** a0 - a1·cos θ + a2·cos 2θ - … (주기 창: θ = 2πk/n) */
const COEF: Record<WindowName, number[]> = {
  rect: [1],
  hann: [0.5, 0.5],
  hamming: [0.54, 0.46],
  blackman: [0.42, 0.5, 0.08],
  bh: [0.35875, 0.48829, 0.14128, 0.01168],
  flattop: [0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368],
};

export function windowValues(name: WindowName, n: number): Float64Array {
  const c = COEF[name];
  const w = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const th = (2 * Math.PI * k) / n;
    let s = c[0];
    for (let j = 1; j < c.length; j++) s += (j % 2 ? -1 : 1) * c[j] * Math.cos(j * th);
    w[k] = s;
  }
  return w;
}

export function windowName(s: string | undefined): WindowName {
  const k = (s ?? "hann").toLowerCase().replace(/[-_ ]/g, "");
  const alias: Record<string, WindowName> = {
    rect: "rect", rectangular: "rect", none: "rect", boxcar: "rect",
    hann: "hann", hanning: "hann", hamming: "hamming", blackman: "blackman",
    bh: "bh", blackmanharris: "bh", flattop: "flattop",
  };
  const w = alias[k];
  if (!w) throw new CalcError(`Unknown window "${s}" — use one of ${WINDOWS.join(", ")}`);
  return w;
}

/**
 * 제자리 FFT (기수 2). 회전 인자는 표로 미리 구한다 — 점화식으로 곱해 나가면 2^18 점에서
 * 오차가 쌓여 -200 dB 바닥이 올라온다.
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n < 2) return;
  if (n & (n - 1)) throw new Error("fft size must be a power of two");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const half = n >> 1;
  const cs = new Float64Array(half), sn = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    cs[k] = Math.cos((2 * Math.PI * k) / n);
    sn[k] = -Math.sin((2 * Math.PI * k) / n);
  }
  for (let len = 2; len <= n; len <<= 1) {
    const h = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < h; k++) {
        const wr = cs[k * step], wi = sn[k * step];
        const a = i + k, b = a + h;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

export interface Spectrum {
  /** 0, df, 2df, … n/2·df */
  f: Float64Array;
  /** 단측 복소 진폭. 진폭 A 의 코사인이 그 빈에서 크기 A 로 읽히게 창의 이득까지 되돌렸다 */
  re: Float64Array;
  im: Float64Array;
  df: number;
  n: number;
  win: WindowName;
  /** 빈마다의 단측 전력 (보정 전 |X|²). 신호 대 잡음 비는 같은 창을 거친 것끼리 나누므로 이걸로 된다 */
  power: Float64Array;
  /** 창 값의 제곱합 — 밀도(PSD)로 바꿀 때 쓴다 */
  w2: number;
  /** 다시 찍은 간격의 역수 (Hz) */
  fs: number;
  lobe: number;
}

function countIn(x: Float64Array, lo: number, hi: number): number {
  let c = 0;
  for (let i = 0; i < x.length; i++) if (x[i] >= lo && x[i] <= hi) c++;
  return c;
}

/**
 * [from, to) 를 n 점으로 고르게 찍어 창을 씌운 FFT.
 *
 * n 을 안 주면 그 구간의 점 수 이상인 2의 거듭제곱 (1024 ~ 2^18). 주파수 간격은 1/(to-from) 이다 —
 * 기본파가 빈 위에 딱 떨어지려면 구간에 주기가 정수 개 들어가야 한다. 그러면 사각 창(rect)이 정확하고,
 * 아니면 hann · bh 같은 창이 누설을 줄인다.
 */
export function spectrum(w0: Wave, from?: number, to?: number, nIn?: number, win: WindowName = "hann"): Spectrum {
  if (w0.im) throw new CalcError("fft needs a real waveform (a transient result) — an AC result is already a spectrum");
  const w = ascending(w0);
  const [lo, hi] = window(w, from, to);
  const T = hi - lo;
  if (!(T > 0)) throw new CalcError("The span is empty");
  const count = countIn(w.x, lo, hi);
  const n = nIn !== undefined ? nextPow2(Math.max(8, Math.min(nIn, 1 << 22))) : Math.min(1 << 18, nextPow2(Math.max(1024, count)));
  const y = uniform(w, lo, T / n, n);
  const wv = windowValues(win, n);
  let cg = 0, w2 = 0;
  for (let k = 0; k < n; k++) { cg += wv[k]; w2 += wv[k] * wv[k]; }
  cg /= n;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let k = 0; k < n; k++) re[k] = y[k] * wv[k];
  fft(re, im);
  const m = (n >> 1) + 1;
  const f = new Float64Array(m), sr = new Float64Array(m), si = new Float64Array(m), p = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const edge = k === 0 || k === n >> 1;
    const s = (edge ? 1 : 2) / (n * cg);
    f[k] = k / T;
    sr[k] = re[k] * s;
    si[k] = im[k] * s;
    p[k] = (re[k] * re[k] + im[k] * im[k]) * (edge ? 1 : 2);
  }
  return { f, re: sr, im: si, df: 1 / T, n, win, power: p, w2, fs: n / T, lobe: LOBE[win] };
}

/** 단측 전력 밀도 (단위²/Hz). 백색 잡음의 분산 σ² 이 적분하면 σ² 로 돌아온다 */
export function psdOf(sp: Spectrum): Float64Array {
  const out = new Float64Array(sp.power.length);
  for (let k = 0; k < out.length; k++) out[k] = sp.power[k] / (sp.fs * sp.w2);
  return out;
}

// ── 기본 주파수 ───────────────────────────────────────────────────────
/**
 * 기본 주파수를 파형에서 찾는다. 뒤쪽 절반(켜질 때의 과도를 피해)에서 가운데 레벨을
 * 히스테리시스를 두고 오르는 자리의 평균 간격. 그게 안 되면 FFT 의 가장 큰 빈.
 */
export function estimateF0(w0: Wave): number {
  const w = ascending(w0);
  const n = w.x.length;
  if (n < 4) throw new CalcError("Too few points to find a frequency");
  const x0 = w.x[0], x1 = w.x[n - 1];
  for (const start of [x0 + (x1 - x0) / 2, x0]) {
    const seg = start > x0 ? clip(w, start, x1) : w;
    const s = stats(seg);
    const pp = s.max - s.min;
    if (!(pp > 0)) continue;
    const e = edges(seg.x, seg.re, (s.max + s.min) / 2, 0.1 * pp);
    if (e.rise.length >= 3) return (e.rise.length - 1) / (e.rise[e.rise.length - 1] - e.rise[0]);
  }
  const sp = spectrum(w, undefined, undefined, undefined, "hann");
  let best = -1, bv = 0;
  for (let k = sp.lobe + 1; k < sp.f.length; k++) if (sp.power[k] > bv) { bv = sp.power[k]; best = k; }
  if (best < 0) throw new CalcError("Could not find a fundamental frequency — give f0");
  return sp.f[best];
}

/**
 * 고조파 분석의 기본 구간: 뒤쪽 절반을 **주기의 정수배**로 자른 것. 앞쪽은 켜질 때의 과도라
 * 고조파로 잘못 읽힌다. 정수배가 아니면 맞추기는 여전히 되지만 끝이 잘린 주기가 오차를 보탠다.
 */
export function lastPeriods(w0: Wave, f0: number): [number, number] {
  const w = ascending(w0);
  const x0 = w.x[0], x1 = w.x[w.x.length - 1];
  const total = (x1 - x0) * f0;
  if (total < 1 - 1e-9) {
    throw new CalcError(`The waveform holds ${total.toFixed(2)} periods of ${eng(f0, "Hz")} — at least one is needed`);
  }
  const k = Math.max(1, Math.floor(total / 2 + 1e-9));
  return [x1 - k / f0, x1];
}

export interface Harmonics {
  f0: number;
  dc: number;
  /** amp[k] 는 k 번째 고조파의 진폭 (amp[0] = 0, 직류는 dc) */
  amp: number[];
  /** 코사인 기준 위상 (도), 구간 시작이 0 */
  phase: number[];
  from: number;
  to: number;
  nh: number;
  /** 맞추고 남은 것의 RMS */
  resid: number;
}

/** 최소제곱으로 dc + Σ (a_k cos kωt + b_k sin kωt), k = 1..nh */
export function harmonicFit(w0: Wave, f0: number, nh: number, from: number, to: number): Harmonics {
  if (w0.im) throw new CalcError("Harmonic analysis needs a real (transient) waveform");
  if (!(f0 > 0)) throw new CalcError("f0 must be positive");
  const w = ascending(w0);
  const idx: number[] = [];
  for (let i = 0; i < w.x.length; i++) if (w.x[i] >= from && w.x[i] <= to) idx.push(i);
  const m = 1 + 2 * nh;
  if (idx.length < 2 * m) {
    throw new CalcError(`Only ${idx.length} samples in the span — too few for ${nh} harmonics. ` +
      "Lower the transient's max step, or ask for fewer harmonics");
  }
  const A = Array.from({ length: m }, () => new Float64Array(m));
  const b = new Float64Array(m);
  const basis = new Float64Array(m);
  const om = 2 * Math.PI * f0;
  let wsum = 0;
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    const xl = j > 0 ? w.x[idx[j - 1]] : w.x[i];
    const xr = j + 1 < idx.length ? w.x[idx[j + 1]] : w.x[i];
    const wt = (xr - xl) / 2;
    if (!(wt > 0)) continue;
    wsum += wt;
    const th = om * (w.x[i] - from);
    basis[0] = 1;
    for (let k = 1; k <= nh; k++) { basis[2 * k - 1] = Math.cos(k * th); basis[2 * k] = Math.sin(k * th); }
    const y = w.re[i];
    for (let r = 0; r < m; r++) {
      const br = basis[r] * wt;
      b[r] += br * y;
      const row = A[r];
      for (let c = r; c < m; c++) row[c] += br * basis[c];
    }
  }
  for (let r = 0; r < m; r++) for (let c = 0; c < r; c++) A[r][c] = A[c][r];
  const sol = solve(A, b);
  const amp = [0], phase = [0];
  for (let k = 1; k <= nh; k++) {
    const a = sol[2 * k - 1], s = sol[2 * k];
    amp.push(Math.hypot(a, s));
    phase.push((Math.atan2(-s, a) * 180) / Math.PI);
  }
  let sse = 0;
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    const xl = j > 0 ? w.x[idx[j - 1]] : w.x[i];
    const xr = j + 1 < idx.length ? w.x[idx[j + 1]] : w.x[i];
    const wt = (xr - xl) / 2;
    if (!(wt > 0)) continue;
    const th = om * (w.x[i] - from);
    let fit = sol[0];
    for (let k = 1; k <= nh; k++) fit += sol[2 * k - 1] * Math.cos(k * th) + sol[2 * k] * Math.sin(k * th);
    sse += wt * (w.re[i] - fit) ** 2;
  }
  return { f0, dc: sol[0], amp, phase, from, to, nh, resid: Math.sqrt(sse / (wsum || 1)) };
}

/** 고조파 수를 그 구간의 점 밀도에 맞춰 줄인다 — 한 주기에 점이 너무 적으면 높은 고조파는 못 맞춘다 */
export function harmonicsFor(w: Wave, f0: number, nh: number, from?: number, to?: number): Harmonics {
  const [lo, hi] = from === undefined && to === undefined ? lastPeriods(w, f0) : window(w, from, to);
  const a = ascending(w);
  let count = 0;
  for (let i = 0; i < a.x.length; i++) if (a.x[i] >= lo && a.x[i] <= hi) count++;
  const periods = (hi - lo) * f0;
  if (periods < 1 - 1e-9) {
    throw new CalcError(`The span holds ${periods.toFixed(2)} periods of ${eng(f0, "Hz")} — at least one is needed`);
  }
  // 고조파 하나에 한 주기마다 점이 넷은 있어야 한다 (나이퀴스트의 두 배 여유)
  const fit = Math.max(1, Math.min(nh, Math.floor(count / periods / 4)));
  return harmonicFit(a, f0, fit, lo, hi);
}

/** THD = √(Σ_{k≥2} A_k²) / A_1 (진폭 비). 제곱하면 전력 비다 */
export function thdOf(h: Harmonics): number {
  let s = 0;
  for (let k = 2; k <= h.nh; k++) s += h.amp[k] * h.amp[k];
  return Math.sqrt(s) / h.amp[1];
}

/**
 * 전력 밀도 S(f) 를 [f1, f2] 에서 적분한다 (잡음의 제곱 평균).
 *
 * AC · 잡음 해석의 점은 10배마다 같은 수다. 그 사이를 직선으로 이어 사다리꼴로 적분하면 1/f 잡음과
 * 극점 너머의 -40 dB/dec 꼬리에서 크게 틀린다 — 로그 간격에서 직선은 위로 볼록하게 부풀기 때문이다.
 * 구간마다 거듭제곱 S = S_a·(f/f_a)^α 으로 보고 정확히 적분한다. 1/f 잡음(α = -1)과 단극점의 양쪽
 * 끝(α = 0, -2)이 이 꼴이라 오차가 거의 없다. 0 이나 음수가 있는 구간만 사다리꼴로 간다.
 */
export function integratePower(f: Float64Array, s: Float64Array, f1: number, f2: number): number {
  const n = Math.min(f.length, s.length);
  let total = 0;
  const seg = (fa: number, fb: number, sa: number, sb: number): number => {
    if (fa > 0 && sa > 0 && sb > 0 && fb > fa) {
      const a = Math.log(sb / sa) / Math.log(fb / fa);
      if (Math.abs(a + 1) < 1e-9) return sa * fa * Math.log(fb / fa);
      return ((sa * fa) / (a + 1)) * (Math.pow(fb / fa, a + 1) - 1);
    }
    return ((fb - fa) * (sa + sb)) / 2;
  };
  /** 거듭제곱 꼴 그대로 구간 안의 한 점을 짚는다 (잘린 끝) */
  const pt = (fa: number, fb: number, sa: number, sb: number, fq: number): number => {
    if (fa > 0 && sa > 0 && sb > 0 && fb > fa) return sa * Math.pow(fq / fa, Math.log(sb / sa) / Math.log(fb / fa));
    return sa + ((sb - sa) * (fq - fa)) / (fb - fa);
  };
  for (let i = 0; i + 1 < n; i++) {
    const fa = f[i], fb = f[i + 1];
    if (fb <= f1 || fa >= f2 || fb <= fa) continue;
    const a = Math.max(fa, f1), b = Math.min(fb, f2);
    const sa = a === fa ? s[i] : pt(fa, fb, s[i], s[i + 1], a);
    const sb = b === fb ? s[i + 1] : pt(fa, fb, s[i], s[i + 1], b);
    total += seg(a, b, sa, sb);
  }
  return total;
}

/** 가우스 소거 (부분 피벗). 맞추기의 정규방정식은 크기가 41 을 넘지 않는다 */
export function solve(A: Float64Array[], b: Float64Array): Float64Array {
  const n = b.length;
  const M = A.map((r, i) => { const row = new Float64Array(n + 1); row.set(r); row[n] = b[i]; return row; });
  let scale = 0;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(M[i][i]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (!(Math.abs(M[piv][col]) > 1e-13 * scale)) {
      throw new CalcError("The fit is singular — the span needs at least one full period of f0 " +
        "and several samples per period of the highest harmonic");
    }
    if (piv !== col) { const t = M[col]; M[col] = M[piv]; M[piv] = t; }
    const p = M[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / p;
      if (f === 0) continue;
      const rr = M[r], rc = M[col];
      for (let c = col; c <= n; c++) rr[c] -= f * rc[c];
    }
  }
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
  return x;
}
