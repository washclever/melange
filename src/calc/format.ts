/**
 * 계산기 값을 사람이 읽는 글자로.
 *
 * 공학 표기(접두어 f p n µ m k M G T)에 단위를 붙인다. 숫자가 수천 배씩 오가는 분야라
 * 1.3834e7 보다 13.83 MHz 가 한눈에 읽힌다. dB · ° · % 처럼 접두어가 뜻이 없는 단위는
 * 소수점 자리만 맞춘다.
 *
 * 이 파일은 wave.ts 의 **타입만** 가져온다 — wave.ts 가 오류 문구를 만들 때 여기 eng() 를
 * 쓰므로, 값을 가져오면 서로를 부르는 고리가 생긴다.
 *
 * '모름' 단위는 여기서 정한다. 단위 셈(units.ts)이 여기서 가져가지, 거꾸로가 아니다 — app.ts 가 첫 화면에서
 * eng() 를 쓰므로, 여기서 units.ts 를 가져오면 단위 표가 첫 화면 JS 로 딸려 온다.
 */
import type { Num, Value } from "./wave.ts";

/** 단위를 모른다 (units.ts). 화면에는 빈칸 */
export const UNKNOWN = "?";

/** 화면에 적을 단위 */
export const shown = (u: string): string => (u === UNKNOWN ? "" : u);

const PREFIX: Array<[number, string]> = [
  [1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""],
  [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"], [1e-18, "a"],
];

/** 접두어를 붙이면 뜻이 이상해지는 단위. 1 k°, 3 mdB 는 아무도 안 쓴다 */
const NO_PREFIX = new Set(["dB", "°", "%", "ppm/°C", "°C", "K", ""]);

/** 유효 숫자 digits 자리. 끝의 0 은 남긴다 (13.80 MHz 가 13.8 MHz 보다 정밀도를 말해 준다) */
function sig(v: number, digits: number): string {
  if (v === 0) return "0";
  const s = v.toPrecision(digits);
  // toPrecision 은 큰 수에서 지수 표기로 간다 (1.234e+5). 접두어를 거친 뒤라 999 를 넘지 않는다
  return s.includes("e") ? String(Number(s)) : s;
}

/** 1.3834e7, "Hz" -> "13.83 MHz" */
export function eng(v: number, unit = "", digits = 4): string {
  unit = shown(unit);   // 모르는 단위는 빈칸
  if (Number.isNaN(v)) return "NaN";
  if (!Number.isFinite(v)) return (v < 0 ? "-∞" : "∞") + (unit ? " " + unit : "");
  if (unit === "V/s") return sig(v * 1e-6, digits) + " V/µs";   // 슬루율은 V/µs 로 읽는다
  if (NO_PREFIX.has(unit)) return plain(v, digits) + (unit ? (unit === "°" ? "°" : " " + unit) : "");
  // 맨 앞 글자에 지수가 붙은 단위(V² · V²/Hz · Ω² · s² · V⁻¹)에 접두어를 달면 µV² 가 (µV)² 로 읽힌다.
  // 접두어 없이 적는다. A/V² 처럼 지수가 뒤에 있으면 접두어는 A 에 붙으니 괜찮다
  if (/[²³⁴⁻¹]/.test(unit.split(/[·/]/)[0])) return plain(v, digits) + " " + unit;
  const a = Math.abs(v);
  if (a === 0) return "0 " + unit;
  // 테라를 넘는 값(.tf 가 열린 게이트에 주는 1e20 Ω)은 접두어가 없다. 100000000 TΩ 보다 지수가 읽힌다
  if (a >= 1e15) return v.toExponential(digits - 1) + " " + unit;
  for (const [k, p] of PREFIX) {
    // 반올림하면 1000 이 되는 값은 한 칸 위 접두어로 (999.96 m -> 1.000)
    if (a >= k * (1 - 5e-5)) return sig(v / k, digits) + " " + p + unit;
  }
  return v.toExponential(digits - 1) + " " + unit;
}

/** 접두어 없이. 아주 크거나 작으면 지수 표기 */
export function plain(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e7)) return v.toExponential(digits - 1);
  // 0.001234 를 1.234e-3 으로 보내지 않고, 12345.6 은 소수 없이
  if (a >= 10 ** digits) return v.toFixed(0);
  return sig(v, digits);
}

/** dB 로 (비율) */
export const db20 = (ratio: number): number => 20 * Math.log10(Math.abs(ratio));

/** 결과 칸에 적을 글자 */
export function formatNum(n: Num): string {
  if (n.im !== 0 && Number.isFinite(n.im)) {
    const mag = Math.hypot(n.re, n.im);
    const ph = (Math.atan2(n.im, n.re) * 180) / Math.PI;
    return `${eng(mag, n.unit)} ∠${ph.toFixed(2)}°`;
  }
  if (n.show === "pct") {
    const v = n.re * 100;
    const db = n.re > 0 ? ` (${db20(n.re).toFixed(2)} dB)` : "";
    return `${Math.abs(v) >= 0.01 || v === 0 ? sig(v, 4) : v.toExponential(3)} %${db}`;
  }
  if (n.show === "gain") {
    const db = n.re !== 0 && Number.isFinite(n.re) ? ` (${db20(n.re).toFixed(2)} dB)` : "";
    return eng(n.re, n.unit, 5) + db;
  }
  return eng(n.re, n.unit);
}

/** 값 하나를 짧게. 파형은 점 수와 단위만 적는다 — 내용은 그림이 보여 준다 */
export function formatValue(v: Value): string {
  if (v.t === "num") return formatNum(v);
  if (v.t === "str") return JSON.stringify(v.s);
  const kind = v.discrete ? "points" : "waveform";
  const unit = shown(v.unit) ? ` · ${shown(v.unit)}` : "";
  const cx = v.im ? " · complex" : "";
  return `${kind} · ${v.x.length} pts${unit}${cx}`;
}

/** 숫자를 손실 없이 (복사해 쓰려는 사람을 위한 자세한 값) */
export function exact(n: Num): string {
  const r = Number(n.re.toPrecision(12));
  const u = shown(n.unit) ? " " + shown(n.unit) : "";
  if (n.im === 0) return String(r) + u;
  return `${r} ${n.im < 0 ? "-" : "+"} ${Math.abs(Number(n.im.toPrecision(12)))}j` + u;
}
