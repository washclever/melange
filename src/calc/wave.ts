/**
 * 계산기의 값 — 숫자와 파형 — 과 그 위의 기본 수치 계산.
 *
 * 파형은 x 와 y 의 쌍이다. y 는 실수이거나(과도 · DC 스윕) 복소수다(AC). SPICE 가 하는 그대로
 * **점 사이는 직선**으로 본다 — 보간 · 적분 · 교차가 모두 그 가정 위에 있어서, 같은 파형을 어느
 * 함수로 재든 서로 어긋나지 않는다.
 *
 * ngspice 의 과도 해석은 시간 간격이 고르지 않다(내부 스텝이 가변). 그래서 여기 함수들은 전부
 * **비균일 간격**을 그대로 받는다. 평균 · RMS 는 점의 산술 평균이 아니라 시간으로 가중한 값이다 —
 * 빠르게 변하는 구간에 점이 몰리는데, 점마다 같은 무게를 주면 그 구간이 평균을 끌고 간다.
 */
import { eng } from "./format.ts";

/** x 가 무엇인가. 그림의 가로축과 단위, 로그 눈금 여부가 여기서 정해진다 */
export type Axis = "time" | "frequency" | "sweep" | "temp" | "spectrum" | "cycle" | "index";

export interface Wave {
  t: "wave";
  x: Float64Array;
  re: Float64Array;
  /** 복소수일 때만. 실수 파형은 null */
  im: Float64Array | null;
  axis: Axis;
  /** x 의 단위 (s · Hz · V · °C …) */
  xunit: string;
  /** y 의 단위 */
  unit: string;
  /** 이어진 곡선이 아니라 점들이다 (sample · periods 의 결과). 통계를 점의 산술로 낸다 */
  discrete?: boolean;
}

/** 결과 칸에 덧붙여 보일 모양 — 비율을 %·dB 로, 이득을 dB 로 */
export type Show = "gain" | "pct";

export interface Num {
  t: "num";
  re: number;
  /** 실수면 0 */
  im: number;
  unit: string;
  show?: Show;
  /** 값에 붙는 설명 (어디서 쟀는지, 어떤 가정을 했는지) */
  note?: string;
}

export interface Str { t: "str"; s: string }

export type Value = Wave | Num | Str;

/** 사용자에게 그대로 보여 줄 오류. 식의 어디가 왜 틀렸는지 말한다 */
export class CalcError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CalcError";
  }
}

export const num = (re: number, unit = "", extra: Partial<Num> = {}): Num => ({ t: "num", re, im: 0, unit, ...extra });
export const cnum = (re: number, im: number, unit = ""): Num => ({ t: "num", re, im, unit });
export const str = (s: string): Str => ({ t: "str", s });

export function mkWave(
  x: Float64Array, re: Float64Array, im: Float64Array | null,
  axis: Axis, xunit: string, unit: string, discrete = false,
): Wave {
  const w: Wave = { t: "wave", x, re, im, axis, xunit, unit };
  if (discrete) w.discrete = true;
  return w;
}

/** y 만 바꾼 같은 축의 파형 */
export const withY = (w: Wave, re: Float64Array, im: Float64Array | null, unit: string): Wave =>
  mkWave(w.x, re, im, w.axis, w.xunit, unit, w.discrete);

/** AC 결과처럼 로그 눈금이 자연스러운 축인가 (0 이하가 있으면 로그를 못 쓴다) */
export const logAxis = (w: Wave): boolean => w.axis === "frequency" && w.x.length > 1 && w.x[0] > 0;

// ── 찾기 · 보간 ───────────────────────────────────────────────────────
/**
 * xq 를 끼고 있는 칸의 왼쪽 끝 i (x[i] .. x[i+1]). 범위 밖이면 -1.
 * DC 스윕은 5 V 에서 0 V 로 내려가며 쓸 수도 있어서 내림차순도 받는다.
 */
export function bracket(x: ArrayLike<number>, xq: number): number {
  const n = x.length;
  if (n < 2) return -1;
  const up = x[n - 1] >= x[0];
  const lo = up ? x[0] : x[n - 1], hi = up ? x[n - 1] : x[0];
  const tol = (hi - lo) * 1e-12;
  if (!(xq >= lo - tol && xq <= hi + tol)) return -1;
  let a = 0, b = n - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (up ? x[m] <= xq : x[m] >= xq) a = m; else b = m;
  }
  return a;
}

/** 점 사이를 직선으로 이어 xq 에서의 값. 범위 밖이면 NaN */
export function interp(x: ArrayLike<number>, y: ArrayLike<number>, xq: number): number {
  const n = Math.min(x.length, y.length);
  if (n === 0) return NaN;
  if (n === 1) return x[0] === xq ? y[0] : NaN;
  const i = bracket(x, xq);
  if (i < 0) return NaN;
  const x0 = x[i], x1 = x[i + 1];
  if (x1 === x0) return y[i + 1];
  const f = Math.min(1, Math.max(0, (xq - x0) / (x1 - x0)));
  return y[i] + (y[i + 1] - y[i]) * f;
}

/**
 * 로그 축에서의 보간. AC 의 점은 10배마다 같은 수라, 그 사이를 주파수에 대해 직선으로 이으면
 * 아래쪽 끝으로 치우친다. log f 에 대해 직선으로 잇는다.
 */
export function interpLogX(x: ArrayLike<number>, y: ArrayLike<number>, xq: number): number {
  const i = bracket(x, xq);
  if (i < 0) return NaN;
  const x0 = x[i], x1 = x[i + 1];
  if (!(x0 > 0 && x1 > 0 && xq > 0) || x1 === x0) return interp(x, y, xq);
  const f = Math.min(1, Math.max(0, Math.log(xq / x0) / Math.log(x1 / x0)));
  return y[i] + (y[i + 1] - y[i]) * f;
}

/** 파형 축에 맞는 보간 */
export const at = (w: Wave, arr: Float64Array, xq: number): number =>
  logAxis(w) ? interpLogX(w.x, arr, xq) : interp(w.x, arr, xq);

/** 파형의 xq 에서의 값 (복소수면 실수부 · 허수부) */
export function valueAt(w: Wave, xq: number): [number, number] {
  return [at(w, w.re, xq), w.im ? at(w, w.im, xq) : 0];
}

/** x 가 오름차순인 같은 파형. 이미 그러면 그대로 돌려준다 */
export function ascending(w: Wave): Wave {
  const n = w.x.length;
  if (n < 2 || w.x[n - 1] >= w.x[0]) return w;
  const rev = (a: Float64Array) => Float64Array.from(a).reverse();
  return mkWave(rev(w.x), rev(w.re), w.im ? rev(w.im) : null, w.axis, w.xunit, w.unit, w.discrete);
}

/** 두 격자가 같은가. 같은 실행에서 나온 벡터는 같은 배열을 공유해서 대개 첫 비교로 끝난다 */
export function sameGrid(a: Float64Array, b: Float64Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 1e-12 * Math.max(Math.abs(a[i]), Math.abs(b[i]), 1e-300)) return false;
  }
  return true;
}

/**
 * b 를 a 의 격자에 맞춘다. 연산 두 개의 x 가 다르면(보관해 둔 다른 실행 · fft 결과끼리) 점 사이를
 * 보간해 맞춘다. 축의 종류가 다르면 맞출 길이 없다 — 시간 파형과 주파수 응답을 더하는 것은 실수다.
 */
export function onGridOf(a: Wave, b: Wave): Wave {
  if (sameGrid(a.x, b.x)) return b;
  if (a.axis !== b.axis) {
    throw new CalcError(`Cannot combine a ${axisWord(a.axis)} waveform with a ${axisWord(b.axis)} waveform`);
  }
  const n = a.x.length;
  const re = new Float64Array(n);
  const im = b.im ? new Float64Array(n) : null;
  for (let i = 0; i < n; i++) {
    re[i] = at(b, b.re, a.x[i]);
    if (im) im[i] = at(b, b.im!, a.x[i]);
  }
  return mkWave(a.x, re, im, a.axis, a.xunit, b.unit, a.discrete);
}

export const axisWord = (a: Axis): string =>
  ({ time: "time", frequency: "frequency", sweep: "DC sweep", temp: "temperature", spectrum: "spectrum",
     cycle: "per-cycle", index: "indexed" } as const)[a];

// ── 구간 ──────────────────────────────────────────────────────────────
/** [from, to] 를 파형 범위 안으로 누른다. 겹치는 데가 없으면 오류 */
export function window(w: Wave, from?: number, to?: number): [number, number] {
  const a = ascending(w);
  const n = a.x.length;
  if (!n) throw new CalcError("The waveform is empty");
  const x0 = a.x[0], x1 = a.x[n - 1];
  let lo = from ?? x0, hi = to ?? x1;
  if (lo > hi) [lo, hi] = [hi, lo];
  lo = Math.max(lo, x0);
  hi = Math.min(hi, x1);
  if (!(hi >= lo)) {
    throw new CalcError(`The span ${eng(from ?? x0, a.xunit)} … ${eng(to ?? x1, a.xunit)} is outside the data ` +
      `(${eng(x0, a.xunit)} … ${eng(x1, a.xunit)})`);
  }
  return [lo, hi];
}

/** [from, to] 만 잘라 낸 파형. 양 끝은 보간한 점이 들어간다 (점 묶음은 안의 점만) */
export function clip(w: Wave, from?: number, to?: number): Wave {
  const a = ascending(w);
  const [lo, hi] = window(a, from, to);
  const xs: number[] = [], re: number[] = [], im: number[] = [];
  const push = (x: number, r: number, i: number) => { xs.push(x); re.push(r); im.push(i); };
  const n = a.x.length;
  if (!a.discrete) push(lo, at(a, a.re, lo), a.im ? at(a, a.im, lo) : 0);
  for (let i = 0; i < n; i++) {
    const x = a.x[i];
    const inside = a.discrete ? x >= lo && x <= hi : x > lo && x < hi;
    if (inside) push(x, a.re[i], a.im ? a.im[i] : 0);
  }
  if (!a.discrete && hi > lo) push(hi, at(a, a.re, hi), a.im ? at(a, a.im, hi) : 0);
  if (!xs.length) throw new CalcError("No points in that span");
  return mkWave(Float64Array.from(xs), Float64Array.from(re), a.im ? Float64Array.from(im) : null,
    a.axis, a.xunit, a.unit, a.discrete);
}

// ── 적분 ──────────────────────────────────────────────────────────────
/**
 * 조각마다 직선인 y 를 [lo, hi] 에서 적분한다 (x 오름차순).
 *
 * sq 가 참이면 (y - m)² 을 사다리꼴로 적분한다 — 점에서의 제곱 값을 잇는다. 직선 조각의 제곱을
 * 정확히(h·(a² + ab + b²)/3) 적분하면 사인파의 전력이 참값의 (2 + cos ωh)/3 배로 **작게** 나온다:
 * 직선이 꼭대기를 깎기 때문이다. 점 400개/주기에서 4e-5 모자라는데, −40 dB 고조파의 전력이 1e-4 라
 * SNDR 이 40 이 아니라 42.3 dB 로 읽혔다 (재 봤다). 사다리꼴은 고르게 찍은 사인의 정수 주기에서
 * 정확하고, ngspice 의 `.meas … RMS` 도 이렇게 잰다 — 두 값을 맞대 볼 수 있다.
 */
export function integrate(x: Float64Array, y: Float64Array, lo: number, hi: number, sq = false, m = 0): number {
  const n = Math.min(x.length, y.length);
  let s = 0;
  for (let i = 0; i + 1 < n; i++) {
    const xa = x[i], xb = x[i + 1];
    if (xb <= lo || xa >= hi || xb === xa) continue;
    const a0 = Math.max(xa, lo), b0 = Math.min(xb, hi);
    if (b0 <= a0) continue;
    const ya = y[i] + ((y[i + 1] - y[i]) * (a0 - xa)) / (xb - xa);
    const yb = y[i] + ((y[i + 1] - y[i]) * (b0 - xa)) / (xb - xa);
    const h = b0 - a0;
    if (sq) {
      const p = ya - m, q = yb - m;
      s += (h * (p * p + q * q)) / 2;
    } else s += (h * (ya + yb)) / 2;
  }
  return s;
}

/** 누적 적분 파형 (사다리꼴). 첫 점이 0 이다 */
export function cumulative(x: Float64Array, y: Float64Array): Float64Array {
  const n = Math.min(x.length, y.length);
  const out = new Float64Array(n);
  for (let i = 1; i < n; i++) out[i] = out[i - 1] + ((x[i] - x[i - 1]) * (y[i] + y[i - 1])) / 2;
  return out;
}

/**
 * 미분. 가운데 점은 비균일 3점 공식, 양 끝은 한쪽 차분.
 *
 *   f'(xi) ≈ [-h1/(h0(h0+h1))]·f(i-1) + [(h1-h0)/(h0·h1)]·f(i) + [h0/(h1(h0+h1))]·f(i+1)
 *
 * ngspice 는 중단점에서 같은 시각을 두 번 적는 일이 있다. 간격이 0 인 이웃은 건너뛴다 —
 * 그대로 나누면 그 자리만 무한대가 된다.
 */
export function derivative(x: Float64Array, y: Float64Array): Float64Array {
  const n = Math.min(x.length, y.length);
  const d = new Float64Array(n);
  if (n < 2) return d;
  for (let i = 0; i < n; i++) {
    let l = i - 1;
    while (l >= 0 && x[l] === x[i]) l--;
    let r = i + 1;
    while (r < n && x[r] === x[i]) r++;
    if (l < 0 && r >= n) { d[i] = 0; continue; }
    if (l < 0) { d[i] = (y[r] - y[i]) / (x[r] - x[i]); continue; }
    if (r >= n) { d[i] = (y[i] - y[l]) / (x[i] - x[l]); continue; }
    const h0 = x[i] - x[l], h1 = x[r] - x[i];
    d[i] = (-h1 / (h0 * (h0 + h1))) * y[l] + ((h1 - h0) / (h0 * h1)) * y[i] + (h0 / (h1 * (h0 + h1))) * y[r];
  }
  return d;
}

// ── 통계 ──────────────────────────────────────────────────────────────
export interface Stats {
  mean: number;
  rms: number;
  std: number;
  min: number;
  max: number;
  xmin: number;
  xmax: number;
  /** 가로 폭 */
  span: number;
}

/**
 * [from, to] 의 통계. 이어진 곡선은 x 로 가중하고(직선 조각 그대로), 점 묶음은 산술로 낸다.
 * 복소수면 최대 · 최소 · RMS 는 크기로, 평균은 실수부로 본다 — 복소 평균이 필요하면 real · imag 를 따로 쓴다.
 */
export function stats(w0: Wave, from?: number, to?: number): Stats {
  const w = from === undefined && to === undefined ? ascending(w0) : clip(w0, from, to);
  const n = w.x.length;
  const y = w.im ? magnitude(w) : w.re;
  let min = Infinity, max = -Infinity, imin = 0, imax = 0;
  for (let i = 0; i < n; i++) {
    if (y[i] < min) { min = y[i]; imin = i; }
    if (y[i] > max) { max = y[i]; imax = i; }
  }
  const span = n ? w.x[n - 1] - w.x[0] : 0;
  let mean: number, rms: number, std: number;
  if (w.discrete || span === 0) {
    let s = 0, s2 = 0;
    for (let i = 0; i < n; i++) { s += w.re[i]; s2 += y[i] * y[i]; }
    mean = s / n;
    rms = Math.sqrt(s2 / n);
    let v = 0;
    for (let i = 0; i < n; i++) v += (w.re[i] - mean) ** 2;
    std = Math.sqrt(v / n);
  } else {
    const lo = w.x[0], hi = w.x[n - 1];
    mean = integrate(w.x, w.re, lo, hi) / span;
    rms = Math.sqrt(integrate(w.x, y, lo, hi, true) / span);
    std = Math.sqrt(Math.max(0, integrate(w.x, w.re, lo, hi, true, mean) / span));
  }
  return { mean, rms, std, min, max, xmin: w.x[imin], xmax: w.x[imax], span };
}

/** |y| */
export function magnitude(w: Wave): Float64Array {
  const n = w.re.length;
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) m[i] = w.im ? Math.hypot(w.re[i], w.im[i]) : Math.abs(w.re[i]);
  return m;
}

/** 위상 (도). 점에서 점으로 360° 를 넘게 뛰지 않게 펼친다 — 보드 선도가 -180° 에서 끊기지 않게 */
export function unwrappedPhase(w: Wave): Float64Array {
  const n = w.re.length;
  const out = new Float64Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const p = (Math.atan2(w.im ? w.im[i] : 0, w.re[i]) * 180) / Math.PI;
    if (i === 0) out[i] = p;
    else {
      let d = p - prev;
      while (d > 180) d -= 360;
      while (d <= -180) d += 360;
      out[i] = out[i - 1] + d;
    }
    prev = p;
  }
  return out;
}

// ── 교차 ──────────────────────────────────────────────────────────────
export type Edge = "rise" | "fall" | "either";

export interface Crossing { x: number; rise: boolean }

/**
 * level 을 지나는 자리들 (보간). 값이 level 에 딱 걸친 점이 있어도 한 번만 센다 —
 * 부호가 바뀐 때만 교차로 보고, 0 이었던 점이 있으면 그 점이 교차 자리다.
 * logx 면 로그 축에서 보간한다 (AC 응답의 -3 dB 자리).
 */
export function crossings(x: Float64Array, y: Float64Array, level: number, edge: Edge = "either", logx = false): Crossing[] {
  const out: Crossing[] = [];
  const n = Math.min(x.length, y.length);
  let prevSign = 0, prevIdx = -1, zeroIdx = -1;
  for (let i = 0; i < n; i++) {
    const d = y[i] - level;
    if (Number.isNaN(d)) continue;
    if (d === 0) { if (zeroIdx < 0) zeroIdx = i; continue; }
    const s = d > 0 ? 1 : -1;
    if (prevSign !== 0 && s !== prevSign) {
      const rise = s > 0;
      let xc: number;
      if (zeroIdx >= 0) xc = x[zeroIdx];
      else {
        const x0 = x[prevIdx], x1 = x[i], y0 = y[prevIdx], y1 = y[i];
        const f = (level - y0) / (y1 - y0);
        xc = logx && x0 > 0 && x1 > 0 ? x0 * Math.pow(x1 / x0, f) : x0 + (x1 - x0) * f;
      }
      if (edge === "either" || (edge === "rise") === rise) out.push({ x: xc, rise });
    }
    prevSign = s;
    prevIdx = i;
    zeroIdx = -1;
  }
  return out;
}

/**
 * 히스테리시스가 있는 가장자리. 주기 · 듀티 · 지터를 잴 때 쓴다.
 *
 * 링잉이나 작은 잡음이 level 을 몇 번 오가면 주기가 반토막으로 잡힌다. 아래 문턱(level - h)
 * 밑으로 내려갔다가 위 문턱(level + h)을 넘어야 상승 하나로 센다. 기록하는 시각은 그 사이에
 * level 을 지난 자리다.
 */
export function edges(x: Float64Array, y: Float64Array, level: number, h: number): { rise: number[]; fall: number[] } {
  const rise: number[] = [], fall: number[] = [];
  const n = Math.min(x.length, y.length);
  let state = 0;               // -1 낮음, +1 높음, 0 모름
  let last = NaN;              // 마지막으로 level 을 지난 자리
  for (let i = 0; i < n; i++) {
    const v = y[i];
    if (i > 0) {
      const a = y[i - 1] - level, b = v - level;
      if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) last = x[i - 1] + ((x[i] - x[i - 1]) * (level - y[i - 1])) / (v - y[i - 1]);
    }
    if (v > level + h) {
      if (state === -1 && Number.isFinite(last)) rise.push(last);
      state = 1;
    } else if (v < level - h) {
      if (state === 1 && Number.isFinite(last)) fall.push(last);
      state = -1;
    }
  }
  return { rise, fall };
}

// ── 고르게 다시 찍기 ──────────────────────────────────────────────────
/** [from, from + n·dx) 의 n 점. 끝점을 넣지 않는다 — FFT 의 주기 창이 이 모양이다 */
export function uniform(w: Wave, from: number, dx: number, n: number, arr: Float64Array = w.re): Float64Array {
  const a = ascending(w);
  const src = a === w ? arr : Float64Array.from(arr).reverse();
  const out = new Float64Array(n);
  const x = a.x;
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = from + k * dx;
    while (j + 2 < x.length && x[j + 1] < t) j++;
    const x0 = x[j], x1 = x[j + 1] ?? x0;
    // 끝에서 반올림으로 범위를 살짝 넘는 점은 바깥으로 늘이지 않고 끝값을 쓴다
    const f = x1 === x0 ? 0 : Math.min(1, Math.max(0, (t - x0) / (x1 - x0)));
    out[k] = x1 === x0 ? src[j] : src[j] + (src[j + 1] - src[j]) * f;
  }
  return out;
}

export const nextPow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(2, n)));
