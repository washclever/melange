// 합성 신호로 사인 피팅을 검증한다. 엔진 문제와 수학 문제를 분리하기 위해
// 엔진을 붙이기 전에 먼저 돌린다.
import { fitSine, phaseDiffDeg } from "../src/measure.ts";

const f = 1000, R = 1e3, C = 100e-9;
const wRC = 2 * Math.PI * f * R * C;
const EXP_AMP = 1 / Math.sqrt(1 + wRC * wRC);          // 0.8467
const EXP_PH = (-Math.atan(wRC) * 180) / Math.PI;      // -32.14

/** 입력 sin(wt), 출력은 RC 저역통과를 지난 값. maxStep 간격, jitter 비율로 흔든다 */
function synth(maxStep: number, jitter = 0) {
  const t: number[] = [], vin: number[] = [], vout: number[] = [];
  let ti = 0;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  while (ti <= 5e-3) {
    t.push(ti);
    vin.push(Math.sin(2 * Math.PI * f * ti));
    vout.push(EXP_AMP * Math.sin(2 * Math.PI * f * ti + (EXP_PH * Math.PI) / 180));
    ti += maxStep * (1 - jitter * rnd());
  }
  return { t, vin, vout };
}

/** 지금 설계서가 쓰려는 방식: 꼭대기를 찾아 시간차로 위상을 낸다 */
function byPeak(t: number[], y: number[], win: { from: number; to: number }) {
  let bi = -1, bv = -Infinity;
  for (let i = 0; i < t.length; i++) {
    if (t[i] < win.from || t[i] > win.to) continue;
    if (y[i] > bv) { bv = y[i]; bi = i; }
  }
  return { amp: bv, tPeak: t[bi] };
}

const WIN = { from: 1e-3, to: 5e-3 };   // 10*tau 지나고 정확히 4주기
let fail = 0;
const check = (name: string, got: number, exp: number, tol: number, unit: string) => {
  const ok = Math.abs(got - exp) <= tol;
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(26)} ${got.toFixed(4).padStart(9)} ${unit}  (기대 ${exp.toFixed(4)}, 허용 +-${tol})`);
};

console.log("기대값: 진폭 %s V, 위상 %s deg\n", EXP_AMP.toFixed(4), EXP_PH.toFixed(2));

for (const [label, step, jit] of [
  ["균일 10us (설계서 기본값)", 10e-6, 0],
  ["비균일 10us (ngspice 실제)", 10e-6, 0.6],
  ["균일 1us", 1e-6, 0],
] as const) {
  console.log(`[${label}]`);
  const { t, vin, vout } = synth(step, jit);
  const fi = fitSine(t, vin, f, WIN);
  const fo = fitSine(t, vout, f, WIN);
  console.log(`  샘플 ${fo.samples}개, 잔차 RMS ${fo.rmsResidual.toExponential(2)} V`);
  check("진폭 (피팅)", fo.amplitude, EXP_AMP, 0.01 * EXP_AMP, "V");
  check("위상차 (피팅)", phaseDiffDeg(fo.phaseDeg, fi.phaseDeg), EXP_PH, 1.0, "deg");

  const pi = byPeak(t, vin, WIN), po = byPeak(t, vout, WIN);
  const peakPh = phaseDiffDeg(-(po.tPeak - pi.tPeak) * f * 360, 0);
  const peakErr = Math.abs(peakPh - EXP_PH);
  console.log(`  [대조] 꼭대기 시간차 방식: ${peakPh.toFixed(2)} deg  (오차 ${peakErr.toFixed(2)} deg) ${peakErr <= 1 ? "" : "<-- +-1도 초과"}`);
  console.log();
}

console.log(fail === 0 ? "사인 피팅 검증 통과" : `${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
