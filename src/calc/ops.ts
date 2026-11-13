/**
 * 값끼리의 산술. 숫자와 파형, 실수와 복소수를 섞어 쓴다.
 *
 *   숫자 ○ 숫자   숫자
 *   파형 ○ 숫자   파형 (점마다)
 *   파형 ○ 파형   파형 — 격자가 다르면(보관해 둔 다른 실행) 뒤의 것을 앞의 격자에 보간해 맞춘다
 *
 * 단위는 차원으로 셈한다 (src/calc/units.ts): V/A = Ω, 1/(Ω·F) = Hz, √(V²) = V.
 * 모르는 조합은 '모름' 이 되어 빈칸으로 나온다 — 틀린 단위를 붙이는 것보다 비워 두는 쪽이 낫다.
 */
import { CalcError, onGridOf, type Num, type Value, type Wave } from "./wave.ts";
import { UNKNOWN, unitAdd, unitDiv, unitMul, unitPow } from "./units.ts";

export { unitAdd, unitDiv, unitMul, unitPow };

export type BinOp = "+" | "-" | "*" | "/" | "^";

/** 복소수 하나의 연산. 둘 다 실수면 JS 연산 그대로 (1/0 = ∞ 같은 규칙을 지킨다) */
export function scalarOp(op: BinOp, ar: number, ai: number, br: number, bi: number): [number, number] {
  if (ai === 0 && bi === 0) {
    switch (op) {
      case "+": return [ar + br, 0];
      case "-": return [ar - br, 0];
      case "*": return [ar * br, 0];
      case "/": return [ar / br, 0];
      // 음수의 분수 거듭제곱은 NaN 이다 (Math.pow 와 같다). 실수 계산이 슬그머니 복소수가 되지 않게
      case "^": return [Math.pow(ar, br), 0];
    }
  }
  switch (op) {
    case "+": return [ar + br, ai + bi];
    case "-": return [ar - br, ai - bi];
    case "*": return [ar * br - ai * bi, ar * bi + ai * br];
    case "/": {
      const d = br * br + bi * bi;
      return [(ar * br + ai * bi) / d, (ai * br - ar * bi) / d];
    }
    case "^": {
      // z^w = exp(w · ln z)
      if (ar === 0 && ai === 0) return [0, 0];
      const lr = Math.log(Math.hypot(ar, ai)), li = Math.atan2(ai, ar);
      const er = br * lr - bi * li, ei = br * li + bi * lr;
      const m = Math.exp(er);
      return [m * Math.cos(ei), m * Math.sin(ei)];
    }
  }
}

function unitOf(op: BinOp, a: Value, b: Value): string {
  const ua = a.t === "str" ? "" : a.unit, ub = b.t === "str" ? "" : b.unit;
  switch (op) {
    case "+": case "-": return unitAdd(ua, ub);
    case "*": return unitMul(ua, ub);
    case "/": return unitDiv(ua, ub);
    // 지수는 단위 없는 실수여야 한다. v(out)^2 는 V². 지수에 단위가 있거나(2^v(out)),
    // 단위 있는 값을 파형으로 거듭제곱하면(점마다 단위가 달라진다) 모름
    case "^":
      if (ub) return UNKNOWN;
      if (!ua) return "";
      return b.t === "num" && b.im === 0 ? unitPow(ua, b.re) : UNKNOWN;
  }
}

const isC = (v: Num | Wave): boolean => (v.t === "num" ? v.im !== 0 : !!v.im);

export function binary(op: BinOp, a: Value, b: Value): Value {
  if (a.t === "str" || b.t === "str") throw new CalcError(`Text cannot be used with ${op}`);
  const unit = unitOf(op, a, b);
  if (a.t === "num" && b.t === "num") {
    const [re, im] = scalarOp(op, a.re, a.im, b.re, b.im);
    return { t: "num", re, im, unit };
  }
  const base = (a.t === "wave" ? a : b) as Wave;
  const A = a, B = a.t === "wave" && b.t === "wave" ? onGridOf(a, b) : b;
  const n = base.x.length;
  const complex = isC(A) || isC(B);
  const re = new Float64Array(n);
  const im = complex ? new Float64Array(n) : null;
  const aw = A.t === "wave" ? A : null, bw = B.t === "wave" ? B : null;
  if (!complex) {
    const ar = aw?.re, br = bw?.re;
    const as = (A as Num).re, bs = (B as Num).re;
    for (let i = 0; i < n; i++) re[i] = scalarOp(op, ar ? ar[i] : as, 0, br ? br[i] : bs, 0)[0];
  } else {
    for (let i = 0; i < n; i++) {
      const [r, j] = scalarOp(op,
        aw ? aw.re[i] : (A as Num).re, aw ? (aw.im ? aw.im[i] : 0) : (A as Num).im,
        bw ? bw.re[i] : (B as Num).re, bw ? (bw.im ? bw.im[i] : 0) : (B as Num).im);
      re[i] = r;
      im![i] = j;
    }
  }
  return { t: "wave", x: base.x, re, im, axis: base.axis, xunit: base.xunit, unit, ...(base.discrete ? { discrete: true } : {}) };
}

export function negate(v: Value): Value {
  if (v.t === "str") throw new CalcError("Text cannot be negated");
  if (v.t === "num") return { ...v, re: -v.re, im: v.im === 0 ? 0 : -v.im };
  const re = v.re.map(x => -x);
  const im = v.im ? v.im.map(x => -x) : null;
  return { ...v, re, im };
}

/** 실수 함수를 점마다. 복소수가 오면 무엇을 뜻하는지 모호하므로 오류 */
export function mapReal(v: Value, f: (x: number) => number, unit: string, fn: string): Value {
  if (v.t === "str") throw new CalcError(`${fn}() needs a number or a waveform, not text`);
  if (v.t === "num") {
    if (v.im !== 0) throw new CalcError(`${fn}() needs a real value — take mag(), real() or phase() first`);
    return { t: "num", re: f(v.re), im: 0, unit };
  }
  if (v.im) throw new CalcError(`${fn}() needs a real waveform — take mag(), real() or phase() first`);
  return { ...v, re: v.re.map(f), im: null, unit };
}

/** 복소수 함수를 점마다 */
export function mapComplex(v: Value, f: (re: number, im: number) => [number, number], unit: string, fn: string, realOut = false): Value {
  if (v.t === "str") throw new CalcError(`${fn}() needs a number or a waveform, not text`);
  if (v.t === "num") {
    const [re, im] = f(v.re, v.im);
    return { t: "num", re, im: realOut ? 0 : im, unit };
  }
  const n = v.re.length;
  const re = new Float64Array(n);
  const im = realOut ? null : new Float64Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const [r, j] = f(v.re[i], v.im ? v.im[i] : 0);
    re[i] = r;
    if (im) { im[i] = j; if (j !== 0) any = true; }
  }
  return { ...v, re, im: any ? im : null, unit };
}
