/**
 * 알려진 주파수에서 최소제곱 사인 피팅으로 진폭·위상을 뽑는다.
 *
 * 왜 꼭대기 찾기가 아니라 피팅인가:
 *   .tran 의 최대 스텝이 10 us 면 1 kHz 사인파의 점 간격이 3.6도다.
 *   꼭대기 위치로 위상을 재면 잘해도 +-1.8도, 두 파형의 시간차로 재면
 *   +-3.6도까지 틀린다. 목표 허용 오차가 +-1도라서 통과할 수 없다.
 *
 * 왜 FFT가 아니라 최소제곱인가:
 *   ngspice 의 transient 출력은 시간 간격이 균일하지 않다(내부 스텝이 가변).
 *   FFT 는 먼저 재샘플링해야 하고 정수 주기 구간도 요구한다.
 *   최소제곱 피팅은 비균일 샘플에 그대로 쓸 수 있고, 분해능이 샘플 간격에
 *   묶이지 않는다. 주파수를 이미 알고 있으므로 미지수는 셋뿐이다.
 */

export interface SineFit {
  /** 진폭 (V) */
  amplitude: number;
  /** cos 기준 위상 (deg). 절대값보다 두 파형의 차이가 의미 있다 */
  phaseDeg: number;
  /** DC 오프셋 (V) */
  offset: number;
  /** 잔차 RMS (V). 피팅이 실제로 사인파에 맞았는지 확인하는 신뢰도 지표 */
  rmsResidual: number;
  /** 피팅에 쓰인 샘플 수 */
  samples: number;
}

/** 측정 구간 (초). 시작 직후 과도 구간을 빼는 데 쓴다 */
export interface Window {
  from: number;
  to: number;
}

/**
 * y = A*cos(wt) + B*sin(wt) + C 를 최소제곱으로 풀어
 * 진폭 sqrt(A^2+B^2), 위상 atan2(-B, A) 를 얻는다.
 */
export function fitSine(
  t: ArrayLike<number>,
  y: ArrayLike<number>,
  freqHz: number,
  win?: Window,
): SineFit {
  // ngspice 가 돌려주는 time 벡터가 데이터 벡터보다 한 칸 긴 경우가 있다
  // (512 점 결과에 time 은 513 개). 짧은 쪽에 맞춘다.
  const n = Math.min(t.length, y.length);
  if (n === 0) throw new Error("The vector is empty");
  const w = 2 * Math.PI * freqHz;

  // 정규방정식 3x3 을 누적한다
  let scc = 0, scs = 0, sc1 = 0, sss = 0, ss1 = 0, s11 = 0;
  let syc = 0, sys = 0, sy1 = 0;
  let used = 0;

  for (let i = 0; i < n; i++) {
    const ti = t[i];
    if (win && (ti < win.from || ti > win.to)) continue;
    const c = Math.cos(w * ti);
    const s = Math.sin(w * ti);
    const yi = y[i];
    scc += c * c; scs += c * s; sc1 += c;
    sss += s * s; ss1 += s;
    s11 += 1;
    syc += yi * c; sys += yi * s; sy1 += yi;
    used++;
  }

  if (used < 4) throw new Error(`Only ${used} samples in the measured span (4 minimum)`);

  const [A, B, C] = solve3(
    [[scc, scs, sc1],
     [scs, sss, ss1],
     [sc1, ss1, s11]],
    [syc, sys, sy1],
  );

  // 잔차 RMS
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const ti = t[i];
    if (win && (ti < win.from || ti > win.to)) continue;
    const r = y[i] - (A * Math.cos(w * ti) + B * Math.sin(w * ti) + C);
    sse += r * r;
  }

  return {
    amplitude: Math.hypot(A, B),
    phaseDeg: (Math.atan2(-B, A) * 180) / Math.PI,
    offset: C,
    rmsResidual: Math.sqrt(sse / used),
    samples: used,
  };
}

/** 두 위상의 차이를 (-180, 180] 로 정규화한다 */
export function phaseDiffDeg(a: number, b: number): number {
  let d = a - b;
  while (d <= -180) d += 360;
  while (d > 180) d -= 360;
  return d;
}

/** 부분 피벗 가우스 소거로 3x3 을 푼다 */
function solve3(m: number[][], v: number[]): [number, number, number] {
  const a = [[...m[0], v[0]], [...m[1], v[1]], [...m[2], v[2]]];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    }
    if (Math.abs(a[piv][col]) < 1e-300) {
      throw new Error("The normal equations are singular — the span is too short or the frequency is wrong");
    }
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c < 4; c++) a[r][c] -= f * a[col][c];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}
