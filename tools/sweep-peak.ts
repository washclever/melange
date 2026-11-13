// 꼭대기 찾기 방식의 오차가 격자 정렬에 얼마나 좌우되는지 쓸어 본다.
// 위상을 0~360도로 바꿔 가며 최악 오차를 찾는다.
import { fitSine, phaseDiffDeg } from "../src/measure.ts";

const f = 1000, STEP = 10e-6, WIN = { from: 1e-3, to: 5e-3 };
let worstPeak = 0, worstPeakAt = 0, worstFit = 0, worstFitAt = 0;
let overTol = 0, total = 0;

for (let trueDeg = -179; trueDeg <= 180; trueDeg++) {
  const t: number[] = [], vin: number[] = [], vout: number[] = [];
  for (let ti = 0; ti <= 5e-3 + 1e-12; ti += STEP) {
    t.push(ti);
    vin.push(Math.sin(2 * Math.PI * f * ti));
    vout.push(0.8467 * Math.sin(2 * Math.PI * f * ti + (trueDeg * Math.PI) / 180));
  }
  // 피팅
  const d = phaseDiffDeg(fitSine(t, vout, f, WIN).phaseDeg, fitSine(t, vin, f, WIN).phaseDeg);
  const fitErr = Math.abs(phaseDiffDeg(d, trueDeg));
  // 꼭대기: 각 파형의 창 안 최대점 시간차
  const pk = (y: number[]) => {
    let bi = -1, bv = -Infinity;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < WIN.from || t[i] > WIN.to) continue;
      if (y[i] > bv) { bv = y[i]; bi = i; }
    }
    return t[bi];
  };
  const peakDeg = phaseDiffDeg(-(pk(vout) - pk(vin)) * f * 360, 0);
  const peakErr = Math.abs(phaseDiffDeg(peakDeg, trueDeg));

  total++;
  if (peakErr > 1.0) overTol++;
  if (peakErr > worstPeak) { worstPeak = peakErr; worstPeakAt = trueDeg; }
  if (fitErr > worstFit) { worstFit = fitErr; worstFitAt = trueDeg; }
}

console.log(`위상 ${total}개를 10 us 스텝으로 쓸어 봄 (점 간격 3.6도)\n`);
console.log(`꼭대기 찾기  최악 오차 ${worstPeak.toFixed(2)} deg  (위상 ${worstPeakAt} 에서)`);
console.log(`             +-1도 초과한 경우 ${overTol}/${total} (${(100*overTol/total).toFixed(0)}%)`);
console.log(`사인 피팅    최악 오차 ${worstFit.toExponential(2)} deg  (위상 ${worstFitAt} 에서)`);
