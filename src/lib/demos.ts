/**
 * 설계서의 데모 회로.
 *
 * 앱의 '데모 불러오기' 와 자동 테스트가 같은 정의를 쓴다. 따로 두면 테스트는 통과하는데
 * 화면에서는 다른 회로가 뜨는 일이 생긴다.
 *
 * 기대값은 손으로 계산한 것이다:
 *   RC 저역통과  |H| = 1/sqrt(1+(wRC)^2),  위상 = -atan(wRC)
 *   반전 증폭기  이득 = -Rf/Rin
 *   반파 정류기  꼭대기 = Vp - Vd,  Vd 는 Shockley 식을 풀어서
 *
 * 예제마다 계산기 줄(project.calc)도 넣어 둔다. 열고 Run 을 누르면 Calculator 탭에 그 회로의
 * 성능지표가 바로 나온다 — 무엇을 어떻게 적는지 보고 고쳐 쓰라는 본보기다. 손계산을 적은 줄
 * (`# by hand`)은 시뮬레이션 값 바로 아래에 둔다. tools/e2e-calc.ts 가 이 줄들을 엔진으로 돌려
 * 값과 단위를 손계산과 견준다 — 회로를 고치고 줄을 그대로 두면 거기서 깨진다.
 *
 * 줄의 단위는 차원으로 셈한다(src/calc/units.ts). 손계산 줄에는 숫자에 단위를 붙여 적는다
 * (1kohm · 100nF · 1kHz) — 그래야 손계산도 kHz · V 로 읽혀 바로 위의 시뮬레이션 값과 견줄 수 있다.
 * 단위 없이 적은 수는 차원 없는 수라, 손으로 적은 주파수를 단위 없이 Hz 로 나누면(5033/band) s 가 된다.
 */
import { PROBE_COLORS, emptyProject, uid, type Part, type Project, type Pt } from "../doc/types.ts";
import { BUILTIN, defaultParams, ensureInLibrary } from "./parts.ts";

/** 한 가지 측정. 자동 테스트가 이대로 찍어 준다 */
export interface Measurement {
  name: string;
  got: number;
  want: number;
  tol: number;
  unit: string;
}

/** 결과 한 줄기. AC 는 크기와 위상이 한 쌍이다 (src/sim-values.ts 와 같은 모양) */
export interface DemoTrace {
  values: Float64Array;
  phaseDeg?: Float64Array;
}

export interface Demo {
  id: string;
  name: string;
  build(): Project;
  /** 사인으로 재는 데모 — 입력 대비 출력 */
  expect?: { amplitude: number; phaseDeg: number };
  /** 측정 구간 (초). 시작 직후 과도 구간을 뺀다 */
  window?: { from: number; to: number };
  /**
   * 사인이 아닌 데모가 스스로 재는 법 (정류기·AC·DC 스윕).
   * 기대값은 여기서 계산한다 — 회로 정의 옆에 있어야 둘이 같이 바뀐다.
   */
  measure?(get: (name: string) => DemoTrace): Measurement[];
}

/** 작은 빌더 — 데모 정의를 읽기 좋게 만들려는 것뿐이다. 자동 테스트도 쓴다 */
export function builder(name: string) {
  const project = emptyProject(name);
  const sheet = project.sheets[0];
  const counts: Record<string, number> = {};

  const part = (
    lib: string, at: Pt, params?: Record<string, string>,
    rot: Part["rot"] = 0, mirror = false,
  ): Part => {
    const def = ensureInLibrary(project.library, lib);
    counts[def.refPrefix] = (counts[def.refPrefix] ?? 0) + 1;
    const p: Part = {
      id: uid(), lib, ref: def.refPrefix + counts[def.refPrefix], at,
      rot, mirror, params: { ...defaultParams(def), ...params },
      // 앱에서 놓을 때와 같은 글자 자리 (LibPart.textAt — 가변 저항처럼 기본 자리가 심볼과 겹치는 부품)
      ...(def.textAt ? { textAt: structuredClone(def.textAt) } : {}),
    };
    sheet.parts.push(p);
    return p;
  };
  const wire = (...pts: Pt[]) => { sheet.wires.push({ id: uid(), pts }); };
  const label = (name: string, at: Pt) => { sheet.labels.push({ id: uid(), name, at, kind: "label" }); };
  /** 프로브를 꽂아 두면 파형 패널이 그 넷만 그린다 (색은 꽂은 순서) */
  const probe = (at: Pt) => {
    sheet.probes.push({ id: uid(), at, color: PROBE_COLORS[sheet.probes.length % PROBE_COLORS.length] });
  };

  return { project, sheet, part, wire, label, probe };
}

/**
 * 데모 1 — RC 저역통과 필터
 *   R 1k, C 100n (차단 1.59 kHz), 입력 1 kHz 진폭 1 V
 *   기대: 진폭 0.847 V, 위상 -32.1도
 */
export const RC_LOWPASS: Demo = {
  id: "rc",
  name: "RC low-pass",
  expect: { amplitude: 1 / Math.sqrt(1 + (2 * Math.PI * 1e3 * 1e3 * 100e-9) ** 2),
            phaseDeg: (-Math.atan(2 * Math.PI * 1e3 * 1e3 * 100e-9) * 180) / Math.PI },
  // 10*tau(1 ms) 지나고 정확히 4주기
  window: { from: 1e-3, to: 5e-3 },
  build() {
    const b = builder("RC lowpass");
    b.part("vsin", [0, 0]);
    b.part("r", [60, -40]);
    b.part("c", [120, 0]);
    b.part("gnd", [0, 60]);
    b.wire([0, -20], [0, -40], [40, -40]);     // V1.+ -> R1.1
    b.wire([80, -40], [120, -40], [120, -20]); // R1.2 -> C1.1
    b.wire([0, 20], [0, 60]);                  // V1.- -> GND
    b.wire([120, 20], [120, 60], [0, 60]);     // C1.2 -> GND
    b.label("in", [0, -40]);
    b.label("out", [120, -40]);
    // 진폭비는 사인 맞춤으로, 위상은 0 V 를 오르며 지나는 시각의 차로 잰다. 첫 교차가 1 ms(10τ)라 과도는 끝나 있다
    b.project.calc = [
      "fc = 1/(2*pi*1kohm*100nF)   # 1/(2πRC)",
      "gain = harmonic(v(out), 1)/harmonic(v(in), 1)",
      "1/sqrt(1 + (1kHz/fc)^2)   # by hand",
      "lag = delay(v(in), v(out), rise, rise, 0, 0)",
      "deg(-2*pi*freq(v(in))*lag)",
      "-deg(atan(1kHz/fc))   # by hand",
      "spectrum = fft(v(out), 1m, 5m)",
    ];
    return b.project;
  },
};

/**
 * 데모 2 — 반전 증폭기
 *   이상 op-amp(이득 1e6), 입력 저항 1k, 귀환 저항 10k, 입력 1 kHz 진폭 0.1 V
 *   기대: 진폭 1.0 V, 위상 180도 반전
 *
 * 유한 이득 때문에 실제 이득은 -10/(1+11/1e6) 이라 0.0011% 모자란다. 허용 오차 안이다.
 */
export const INVERTING_AMP: Demo = {
  id: "inv",
  name: "Inverting amplifier",
  expect: { amplitude: 0.1 * (10 / (1 + 11 / 1e6)), phaseDeg: 180 },
  // op-amp 쪽은 시상수가 없어 바로 정상 상태다. 그래도 첫 주기는 뺀다
  window: { from: 1e-3, to: 5e-3 },
  build() {
    const b = builder("Inverting amplifier");
    b.part("vsin", [-100, 10], { va: "0.1" });   // 핀 +[-100,-10]  -[-100,30]
    b.part("r", [-40, -10], { value: "1k" });    // 핀 [-60,-10] [-20,-10]
    b.part("r", [20, -60], { value: "10k" });    // 귀환. 핀 [0,-60] [40,-60]
    b.part("opamp", [20, 0]);                    // 핀 -[0,-10] +[0,10] out[40,0]
    b.part("gnd", [-100, 70]);
    b.part("gnd", [0, 50]);

    b.wire([-100, -10], [-60, -10]);   // V1.+ -> Rin.1
    b.wire([-20, -10], [0, -10]);      // Rin.2 -> op-amp.-
    b.wire([0, -10], [0, -60]);        // 그 마디 -> Rf.1   (여기서 접합점이 생긴다)
    b.wire([40, -60], [40, 0]);        // Rf.2 -> 출력
    b.wire([40, 0], [80, 0]);          // 출력 꼬리
    b.wire([0, 10], [0, 50]);          // op-amp.+ -> GND
    b.wire([-100, 30], [-100, 70]);    // V1.- -> GND

    b.label("in", [-80, -10]);
    b.label("out", [60, 0]);
    // 1.25 ms 는 입력 사인의 꼭대기다. 부호까지 읽으려고 진폭이 아니라 그 순간의 값을 나눈다.
    // 입력 저항이 Rin 하나인 것은 − 입력이 가상 접지라서다
    b.project.calc = [
      "gain = value(v(out), 1.25m)/value(v(in), 1.25m)",
      "-10k/1k/(1 + (1 + 10k/1k)/1e6)   # by hand",
      "pp(v(out))",
      "rin = value(v(in), 1.25m)/value(-i(V1), 1.25m)",
    ];
    return b.project;
  },
};

/**
 * 표본에 찍힌 꼭대기. 가장 큰 점과 양 옆 점을 지나는 포물선의 꼭짓점을 쓴다.
 *
 * 최댓값을 그냥 쓰면 표본 격자에 묶인다 — 10 µs 간격에 1 kHz 사인이면 꼭대기를
 * 최대 5 µs 비껴 집어 4.9 mV 낮게 읽는다. 포물선으로 되짚으면 1e-5 V 수준이다.
 * ngspice 의 시간 간격은 균일하지 않아서 세 점의 간격이 다를 수 있다 — 그래서
 * 라그랑주 2차식을 그대로 푼다.
 */
function peakOf(t: Float64Array, y: Float64Array): number {
  let i = 0;
  for (let k = 1; k < y.length; k++) if (y[k] > y[i]) i = k;
  if (i === 0 || i === y.length - 1) return y[i];

  const u0 = t[i - 1] - t[i], u2 = t[i + 1] - t[i];
  const a0 = y[i - 1] - y[i], a2 = y[i + 1] - y[i];
  const a = (a0 * u2 - a2 * u0) / (u0 * u2 * (u0 - u2));
  if (!(a < 0)) return y[i];                       // 꼭대기가 아니면 그냥 표본값
  const b = (a0 - a * u0 * u0) / u0;
  return y[i] - (b * b) / (4 * a);
}

/**
 * 데모 3 — 반파 정류기
 *   사인 10 V 1 kHz -> 다이오드 -> 부하 1k. 음의 반주기는 막힌다.
 *
 * 사인이 아니라서 피팅으로 못 잰다. 대신 손계산과 정확히 맞는 두 가지를 본다.
 *
 *   꼭대기   Vd 는 Shockley 식을 풀어서 얻는다. 전류가 Vd 에 들어 있어서 음함수다:
 *            I = (Vp - Vd)/R,  Vd = n Vt ln(I/Is + 1)   -> 몇 번 돌리면 수렴한다
 *   바닥     역방향에서는 포화 전류만 흐른다. -Is*R = -1e-11 V, 사실상 0
 */
const RECT = { vp: 10, r: 1e3, is: 1e-14, n: 1, vt: 1.380649e-23 * 300.15 / 1.602176634e-19 };

/** 꼭대기에서의 다이오드 전압. 고정점 반복 — 미분이 -0.003 이라 금방 수렴한다 */
function diodeDrop(): number {
  let vd = 0.7;
  for (let i = 0; i < 50; i++) {
    const id = Math.max((RECT.vp - vd) / RECT.r, 1e-18);
    vd = RECT.n * RECT.vt * Math.log(id / RECT.is + 1);
  }
  return vd;
}

export const RECTIFIER: Demo = {
  id: "rect",
  name: "Half-wave rectifier",
  build() {
    const b = builder("Half-wave rectifier");
    b.part("vsin", [0, 0], { va: "10" });
    b.part("d", [60, -40]);                       // 핀 A[40,-40] K[80,-40]
    b.part("r", [120, 0], { value: "1k" }, 270);  // 세로로 세운다. 핀 [120,-20] [120,20]
    b.part("gnd", [0, 60]);
    b.wire([0, -20], [0, -40], [40, -40]);        // V1.+ -> D1.A
    b.wire([80, -40], [120, -40], [120, -20]);    // D1.K -> R1
    b.wire([0, 20], [0, 60]);                     // V1.- -> GND
    b.wire([120, 20], [120, 60], [0, 60]);        // R1 -> GND
    b.label("in", [0, -40]);
    b.label("out", [120, -40]);
    // 입력과 출력은 같은 순간에 꼭대기라, 두 꼭대기의 차가 그 전류에서의 다이오드 전압이다
    b.project.calc = [
      "peak = ymax(v(out))",
      "drop = ymax(v(in)) - peak",
      "avg = mean(v(out))",
      "rms(v(out))",
      "thd(v(out))",
      "spectrum = fft(v(out))",
    ];
    return b.project;
  },
  measure(get) {
    const out = get("V(out)").values;
    let lo = Infinity;
    for (let i = 0; i < out.length; i++) lo = Math.min(lo, out[i]);
    return [
      /*
       * 허용 오차 0.5 mV 는 ngspice 가 쓰는 볼츠만·전하 상수가 요즘 값과 같다는 보장이
       * 없어서 남겨 둔 여유다 (Vt 는 로그 밖이라 그대로 Vd 에 실린다).
       * 실제로는 1.4e-6 V 까지 맞는다.
       */
      { name: "Output peak", got: peakOf(get("time").values, out), want: RECT.vp - diodeDrop(), tol: 5e-4, unit: " V" },
      /*
       * 역방향에는 포화 전류(-1e-11 V)와 ngspice 가 수렴을 위해 모든 소자에 병렬로
       * 넣는 GMIN(1e-12 S, -10 V 에서 -1e-8 V)만 흐른다. 사실상 0 이다.
       */
      { name: "Reverse floor", got: lo, want: 0, tol: 1e-6, unit: " V" },
    ];
  },
};


/**
 * 표본 사이를 선형 보간해서 x 에서의 값을 읽는다.
 *
 * 시상수처럼 '딱 그 시각' 의 값을 재야 하는데, 엔진의 시간 간격이 균일하지 않아
 * 그 시각에 표본이 없을 수 있다. 1 µs 간격에서 보간 오차는 1e-4 V 수준이다.
 */
function valueAt(x: Float64Array, y: Float64Array, at: number): number {
  const n = Math.min(x.length, y.length);
  if (!n) return NaN;
  if (at <= x[0]) return y[0];
  for (let i = 1; i < n; i++) {
    if (x[i] >= at) {
      const t = (at - x[i - 1]) / (x[i] - x[i - 1] || 1);
      return y[i - 1] + (y[i] - y[i - 1]) * t;
    }
  }
  return y[n - 1];
}

/** y 가 가장 큰 표본 번호 */
function argMax(y: Float64Array): number {
  let i = 0;
  for (let k = 1; k < y.length; k++) if (y[k] > y[i]) i = k;
  return i;
}

/**
 * 데모 4 — 분압기
 *   DC 5 V, R1 10k, R2 4.7k.  v(out) = 5 * 4.7/(10+4.7)
 *
 * 제일 작은 회로이자 DC 동작점(.op)을 쓰는 데모다. 값이 소수점 끝까지 딱 떨어져서
 * '넷 추출 → 넷리스트 → 엔진' 이 한 군데라도 어긋나면 바로 드러난다.
 */
export const DIVIDER: Demo = {
  id: "div",
  name: "Voltage divider",
  build() {
    const b = builder("Voltage divider");
    b.part("vdc", [0, 0], { dc: "5" });
    b.part("r", [60, -40], { value: "10k" });
    b.part("r", [120, 0], { value: "4.7k" }, 270);
    b.part("gnd", [0, 60]);
    b.wire([0, -20], [0, -40], [40, -40]);
    b.wire([80, -40], [120, -40], [120, -20]);
    b.wire([0, 20], [0, 60]);
    b.wire([120, 20], [120, 60], [0, 60]);
    b.label("in", [0, -40]);
    b.label("out", [120, -40]);
    b.project.sim = { kind: "op" };
    // 전원이 내는 전력과 두 저항이 쓰는 전력이 같다. ngspice 는 전원 전류를 + 단자로 들어가는 쪽으로 재서 부호가 반대다
    b.project.calc = [
      "v(out)",
      "5V*4.7k/(10k + 4.7k)   # by hand",
      "rin = -v(in)/i(V1)",
      "power(R1) + power(R2)",
      "power(V1)",
    ];
    return b.project;
  },
  measure: get => [
    { name: "v(out)", got: get("V(out)").values[0], want: 5 * 4.7 / 14.7, tol: 1e-9, unit: " V" },
    { name: "v(in)", got: get("V(in)").values[0], want: 5, tol: 1e-12, unit: " V" },
  ],
};

/**
 * 데모 5 — RC 계단 응답
 *   펄스 0 → 5 V, R 1k, C 100n.  tau = 100 us
 *   v(tau) = 5(1 - 1/e),  v(5 tau) = 5(1 - e^-5)
 *
 * 교과서의 시상수를 눈과 숫자로 같이 보는 자리다. 펄스 전압원을 쓰는 유일한 데모다.
 */
const TAU = 1e3 * 100e-9;   // 100 us

export const RC_STEP: Demo = {
  id: "step",
  name: "RC step response",
  build() {
    const b = builder("RC step response");
    b.part("vpulse", [0, 0], { v1: "0", v2: "5", td: "0", tr: "1n", tf: "1n", pw: "2m", per: "4m" });
    b.part("r", [60, -40], { value: "1k" });
    b.part("c", [120, 0], { value: "100n" });
    b.part("gnd", [0, 60]);
    b.wire([0, -20], [0, -40], [40, -40]);
    b.wire([80, -40], [120, -40], [120, -20]);
    b.wire([0, 20], [0, 60]);
    b.wire([120, 20], [120, 60], [0, 60]);
    b.label("in", [0, -40]);
    b.label("out", [120, -40]);
    b.project.sim = { kind: "tran", tstop: "1m", tmax: "1u", tstart: "0" };
    // 10–90 % 상승 시간은 τ·ln 9, 1 % 정착은 τ·ln 100 (Razavi 예제 9.2). 커패시터 전류를 적분하면 쌓인 전하 C·V 다
    b.project.calc = [
      "tau = risetime(v(out))/ln(9)",
      "1kohm*100nF   # by hand",
      "settling(v(out), 1)/tau",
      "ln(100)   # by hand",
      "ic = i(C1)",
      "q = integ(ic)",
      "100nF*5V   # by hand",
    ];
    return b.project;
  },
  measure(get) {
    const t = get("time").values, out = get("V(out)").values;
    return [
      { name: "v(tau)", got: valueAt(t, out, TAU), want: 5 * (1 - Math.exp(-1)), tol: 1e-3, unit: " V" },
      { name: "v(5tau)", got: valueAt(t, out, 5 * TAU), want: 5 * (1 - Math.exp(-5)), tol: 1e-3, unit: " V" },
      { name: "Initial", got: out[0], want: 0, tol: 1e-6, unit: " V" },
    ];
  },
};

/**
 * 데모 6 — RLC 직렬 공진 (대역통과)
 *   L 10m, C 100n, R 100.  f0 = 1/(2 pi sqrt(LC)) = 5032.9 Hz,  Q = sqrt(L/C)/R = 3.162
 *   공진에서 L 과 C 의 리액턴스가 상쇄되어 |v(R)/v(in)| = 1, 위상 0 이다.
 *
 * 인덕터와 AC 해석(로그 가로축)을 쓰는 데모다.
 */
const RLC = { l: 10e-3, c: 100e-9, r: 100 };
const rlcF0 = 1 / (2 * Math.PI * Math.sqrt(RLC.l * RLC.c));

/** 직렬 RLC 의 전달함수 R/(R + j(wL - 1/wC)). 표본 주파수에서 정확히 계산한다 */
function rlcTheory(f: number): { mag: number; phaseDeg: number } {
  const w = 2 * Math.PI * f;
  const x = w * RLC.l - 1 / (w * RLC.c);
  return {
    mag: RLC.r / Math.hypot(RLC.r, x),
    phaseDeg: (-Math.atan2(x, RLC.r) * 180) / Math.PI,
  };
}

export const RLC_RESONANCE: Demo = {
  id: "rlc",
  name: "RLC resonance",
  build() {
    const b = builder("Series RLC resonance");
    b.part("vsin", [0, 0], { va: "1", freq: "5k" });
    b.part("l", [60, -40], { value: "10m" });
    b.part("c", [140, -40], { value: "100n" }, 90);   // 가로로 눕힌다
    b.part("r", [200, 0], { value: "100" }, 270);
    b.part("gnd", [0, 60]);
    b.wire([0, -20], [0, -40], [40, -40]);
    b.wire([80, -40], [120, -40]);
    b.wire([160, -40], [200, -40], [200, -20]);
    b.wire([0, 20], [0, 60]);
    b.wire([200, 20], [200, 60], [0, 60]);
    b.label("in", [0, -40]);
    b.label("mid", [100, -40]);
    b.label("out", [200, -40]);
    b.project.sim = { kind: "ac", sweep: "dec", points: "50", fstart: "500", fstop: "50k" };
    // 공진은 위상이 0 을 지나는 곳, 대역폭은 반전력점(−3.01 dB) 두 곳의 차. 직렬 RLC 면 Q = f0/B = sqrt(L/C)/R
    b.project.calc = [
      "bode = db20(v(out)/v(in))",
      "ph = phase(v(out)/v(in))",
      "f0 = cross(ph, 0)",
      "1/(2*pi*sqrt(10mH*100nF))   # by hand",
      "hp = db20(1/sqrt(2))",
      "band = cross(bode, hp, -1) - cross(bode, hp, 1)",
      "100ohm/(2*pi*10mH)   # by hand",
      "q = f0/band",
      "sqrt(10mH/100nF)/100ohm   # by hand",
    ];
    return b.project;
  },
  measure(get) {
    const f = get("frequency").values;
    const out = get("V(out)");
    const i = argMax(out.values);          // 공진에서 가장 크다
    const th = rlcTheory(f[i]);
    return [
      // 표본이 f0 에 딱 떨어지지 않으므로, 그 표본 주파수에서의 이론값과 맞춘다
      { name: "|H| @peak", got: out.values[i], want: th.mag, tol: 1e-6, unit: "" },
      { name: "Phase @peak", got: out.phaseDeg ? out.phaseDeg[i] : NaN, want: th.phaseDeg, tol: 1e-4, unit: "deg" },
      // 꼭대기가 공진 주파수에 있는가. 10배마다 50점이라 표본 간격이 4.6% 다
      { name: "Peak freq", got: f[i], want: rlcF0, tol: rlcF0 * 0.05, unit: " Hz" },
      // 공진에서는 전압이 그대로 통과한다 (L 과 C 가 상쇄)
      { name: "Resonant |H|", got: rlcTheory(rlcF0).mag, want: 1, tol: 1e-12, unit: "" },
    ];
  },
};

/**
 * 데모 7 — CMOS 인버터
 *   NMOS·PMOS 를 맞춰 놓으면 문턱이 VDD/2 다:
 *   V_M = (V_Tn + sqrt(bp/bn)(VDD + V_Tp)) / (1 + sqrt(bp/bn)),  bn = bp 이면 (2 + 3)/2 = 2.5
 *
 * PMOS·NMOS 와 DC 스윕을 쓰는 데모다. 정적 전류가 없어 양 끝은 정확히 5 V 와 0 V 다.
 */
export const CMOS_INVERTER: Demo = {
  id: "inv-cmos",
  name: "CMOS inverter",
  build() {
    const b = builder("CMOS inverter");
    // PMOS 는 소스가 위로 가야 해서 뒤집어 놓는다 (회전 180 + 좌우 대칭이면 게이트가 왼쪽에 남는다)
    b.part("pmos", [0, -40], undefined, 180, true);   // D[0,-20] G[-20,-40] S[0,-60]
    b.part("nmos", [0, 40]);                          // D[0,20]  G[-20,40]  S[0,60]
    b.part("vdc", [-120, 0], { dc: "0" });            // 쓸어 올릴 입력
    b.part("vdc", [120, 0], { dc: "5" });             // VDD
    b.part("gnd", [0, 80]);
    b.part("gnd", [-120, 60]);
    b.part("gnd", [120, 60]);

    b.wire([0, -60], [0, -80]);                       // PMOS 소스 -> vdd
    b.wire([0, -20], [0, 20]);                        // 드레인끼리 -> out
    b.wire([0, 60], [0, 80]);                         // NMOS 소스 -> GND
    b.wire([-20, -40], [-40, -40], [-40, 40], [-20, 40]);   // 게이트끼리
    b.wire([-120, -20], [-120, -40], [-40, -40]);     // 입력
    b.wire([-120, 20], [-120, 60]);
    b.wire([120, -20], [120, -80], [0, -80]);         // VDD
    b.wire([120, 20], [120, 60]);
    b.label("in", [-40, 0]);
    b.label("out", [0, 0]);
    b.label("vdd", [60, -80]);
    b.project.sim = { kind: "dc", source: "V1", start: "0", stop: "5", step: "0.05" };
    /*
     * 노이즈 마진은 이득이 −1 인 두 점(VIL · VIH)에서 잰다.
     * 이득은 두 가지로 그린다. gain 은 전달 곡선의 미분, av 는 소자 값으로 낸 소신호 이득
     * −(gm1 + gm2)/(gds1 + gds2) 다 — 출력 마디에 두 소자뿐이라 어느 영역에서나 이 식이 맞다.
     * 문턱에서 av = −2(1 + λ·2.5)/(λ·Vov) = −210 인데, 전환이 가팔라서 50 mV 간격 스윕의 미분은
     * −45 쯤에서 멈춘다. 두 선이 그 차이를 보여 준다.
     * 문턱에서 흐르는 관통 전류는 제곱 법칙 ½·β·Vov²·(1 + λ·VDS), β = KP·W/L = 200 µA/V²
     */
    b.project.calc = [
      "vm = cross(v(out) - v(in), 0)",
      "gain = deriv(v(out))",
      "nml = cross(gain, -1, 1) - ymin(v(out))",
      "nmh = ymax(v(out)) - cross(gain, -1, 2)",
      "av = -(gm(M1) + gm(M2))/(gds(M1) + gds(M2))",
      "value(av, vm)",
      "ymax(id(M2))",
      "0.5*200uA*(2.5 - 2)^2*(1 + 0.02*2.5)  # by hand",
    ];
    return b.project;
  },
  measure(get) {
    const sweep = get("V(v-sweep)").values, out = get("V(out)").values;
    // 전달 특성이 대각선과 만나는 곳이 문턱이다
    let vm = NaN;
    for (let i = 1; i < sweep.length; i++) {
      const d0 = out[i - 1] - sweep[i - 1], d1 = out[i] - sweep[i];
      if (d0 >= 0 && d1 < 0) { vm = sweep[i - 1] + (sweep[i] - sweep[i - 1]) * d0 / (d0 - d1); break; }
    }
    return [
      { name: "In 0 V", got: out[0], want: 5, tol: 1e-6, unit: " V" },
      { name: "In 5 V", got: out[out.length - 1], want: 0, tol: 1e-6, unit: " V" },
      { name: "Threshold", got: vm, want: 2.5, tol: 1e-3, unit: " V" },
    ];
  },
};

/**
 * 데모 8 — 공통 이미터 증폭기 (전달 특성)
 *   VCC 10, RC 10k, RB 100k, BF 100.  VBB 를 쓸어 올리며 컬렉터 전압을 본다.
 *
 * 활성 영역의 기울기는 -BF*RC/(RB + r_pi) 다. r_pi = BF*VT/IC 라서 **시뮬레이션에서 읽은
 * IC 로 이론값을 계산한다** — 바이어스가 바뀌면 기울기도 같이 바뀌는 것까지 맞춘다.
 */
const CE = { vcc: 10, rc: 10e3, rb: 100e3, bf: 100, at: 0.9 };
const VT_27C = (1.380649e-23 * 300.15) / 1.602176634e-19;

export const CE_AMP: Demo = {
  id: "ce",
  name: "Common-emitter amplifier",
  build() {
    const b = builder("Common emitter amplifier");
    b.part("vdc", [-120, 0], { dc: "0.8" });            // V1 — 쓸어 올릴 베이스 바이어스
    b.part("r", [-60, -40], { value: "100k" });         // RB
    b.part("npn", [0, 0]);                              // C[0,-20] B[-20,0] E[0,20]
    b.part("r", [0, -60], { value: "10k" }, 270);       // RC: [0,-80] [0,-40]
    b.part("vdc", [100, -60], { dc: "10" });            // V2 — VCC
    b.part("gnd", [0, 40]);
    b.part("gnd", [-120, 60]);
    b.part("gnd", [100, -20]);

    b.wire([-120, -20], [-120, -40], [-80, -40]);       // V1 -> RB
    b.wire([-40, -40], [-20, -40], [-20, 0]);           // RB -> 베이스
    b.wire([0, -20], [0, -40]);                         // 컬렉터 -> RC
    b.wire([0, -80], [100, -80]);                       // RC -> VCC
    b.wire([0, 20], [0, 40]);                           // 이미터 -> GND
    b.wire([-120, 20], [-120, 60]);
    b.wire([100, -40], [100, -20]);
    b.label("bb", [-120, -40]);
    b.label("c", [0, -30]);
    b.label("vcc", [40, -80]);
    // 0.3~2 V 를 쓸면 차단 → 활성 → 포화가 한 화면에 들어온다.
    // 0.6 V 에서 시작하면 차단이 안 보인다 — 거기서도 IB 가 조금 흘러 컬렉터가 10 mV 낮다
    b.project.sim = { kind: "dc", source: "V1", start: "0.3", stop: "2", step: "0.01" };
    /*
     * VBB = 0.9 V 에서의 이득. 손계산은 Av = −gm·RC / (1 + RB/rπ) — 베이스 저항과 rπ 가 입력을 나눈다.
     * gm 과 rπ 는 그 바이어스에서 엔진이 낸 값을 쓴다. IC/gm 은 열전압 kT/q 다
     */
    b.project.calc = [
      "gain = deriv(v(c))",
      "av = slope(v(c), 0.9)",
      "gmq = value(gm(Q1), 0.9)",
      "rpiq = value(rpi(Q1), 0.9)",
      "-gmq*10kohm/(1 + 100kohm/rpiq)   # by hand",
      "value(ic(Q1), 0.9)/gmq",
      "kb*tnom/q   # VT, by hand",
      "ymin(v(c))   # saturated",
    ];
    return b.project;
  },
  measure(get) {
    const sweep = get("V(v-sweep)").values, c = get("V(c)").values;
    let i = 0;
    for (let k = 0; k < sweep.length; k++) if (Math.abs(sweep[k] - CE.at) < Math.abs(sweep[i] - CE.at)) i = k;
    const slope = (c[i + 1] - c[i - 1]) / (sweep[i + 1] - sweep[i - 1]);
    // 그 점에서 시뮬레이션이 낸 IC 로 r_pi 를 구한다
    const ic = (CE.vcc - c[i]) / CE.rc;
    const rpi = (CE.bf * VT_27C) / ic;
    return [
      { name: "Active slope", got: slope, want: (-CE.bf * CE.rc) / (CE.rb + rpi), tol: 2e-3, unit: "" },
      { name: "Cutoff region", got: c[0], want: CE.vcc, tol: 1e-3, unit: " V" },
    ];
  },
};

/**
 * 데모 9 — SKY130 인버터 (전달 특성)
 *
 * 데모 7 과 같은 회로를 **공정 모델**로 돌린다. 저쪽은 교과서 레벨 1 식이라 모양만 맞고,
 * 이쪽은 SkyWater 130 nm 의 BSIM4 카드다. 전원이 5 V 가 아니라 1.8 V 인 것이 그 차이를
 * 제일 잘 보여 준다 — 공정이 견디는 전압이 소자가 정한다.
 *
 * W·L 은 모델 bin 안에 있어야 한다 (실행 전 검사가 잡는다). 1.26u/0.15u 는 두 소자
 * 모두에 있는 자리다. pFET 을 더 넓게 하고 싶어도 아무 값이나 못 쓴다.
 */
export const SKY130_INVERTER: Demo = {
  id: "inv-sky130",
  name: "SKY130 inverter",
  build() {
    const b = builder("SKY130 inverter");
    b.part("sky130_pfet", [0, -40], undefined, 180, true);   // D[0,-20] G[-20,-40] S[0,-60]
    b.part("sky130_nfet", [0, 40]);                          // D[0,20]  G[-20,40]  S[0,60]
    b.part("vdc", [-120, 0], { dc: "0" });                   // 쓸어 올릴 입력
    b.part("vdc", [120, 0], { dc: "1.8" });                  // VDD — 1.8 V 공정이다
    b.part("gnd", [0, 80]);
    b.part("gnd", [-120, 60]);
    b.part("gnd", [120, 60]);

    b.wire([0, -60], [0, -80]);
    b.wire([0, -20], [0, 20]);
    b.wire([0, 60], [0, 80]);
    b.wire([-20, -40], [-40, -40], [-40, 40], [-20, 40]);
    b.wire([-120, -20], [-120, -40], [-40, -40]);
    b.wire([-120, 20], [-120, 60]);
    b.wire([120, -20], [120, -80], [0, -80]);
    b.wire([120, 20], [120, 60]);
    b.label("in", [-40, 0]);
    b.label("out", [0, 0]);
    b.label("vdd", [60, -80]);
    b.project.sim = { kind: "dc", source: "V1", start: "0", stop: "1.8", step: "0.02" };
    // 데모 7 과 같은 줄을 공정 모델로. pFET 이 약해 문턱이 VDD/2 아래로 내려가고 두 노이즈 마진이 달라진다.
    // 전환이 무른 만큼 20 mV 스윕의 미분(gain)과 소자 값의 이득(av)이 문턱에서 0.5 % 안으로 겹친다
    b.project.calc = [
      "vm = cross(v(out) - v(in), 0)",
      "gain = deriv(v(out))",
      "nml = cross(gain, -1, 1) - ymin(v(out))",
      "nmh = ymax(v(out)) - cross(gain, -1, 2)",
      "av = -(gm(X1) + gm(X2))/(gds(X1) + gds(X2))",
      "value(av, vm)",
      "ymax(id(X2))",
      "value(vth(X2), vm)",
    ];
    return b.project;
  },
  measure(get) {
    const sweep = get("V(v-sweep)").values, out = get("V(out)").values;
    let vm = NaN;
    for (let i = 1; i < sweep.length; i++) {
      const d0 = out[i - 1] - sweep[i - 1], d1 = out[i] - sweep[i];
      if (d0 >= 0 && d1 < 0) { vm = sweep[i - 1] + (sweep[i] - sweep[i - 1]) * d0 / (d0 - d1); break; }
    }
    /*
     * 실제 모델이라 레일에 딱 붙지 않는다 — 누설 때문에 수 mV 가 남는다. 문턱도
     * VDD/2 에서 조금 비켜 있다: 같은 W·L 이면 pFET 이 약해서 전환점이 아래로 내려간다.
     * 그 '조금' 까지 맞추려면 손계산이 아니라 공정 자료가 필요하므로, 여기서는
     * 인버터로서 참이어야 하는 것만 본다.
     */
    return [
      { name: "In 0 V", got: out[0], want: 1.8, tol: 2e-2, unit: " V" },
      { name: "In 1.8 V", got: out[out.length - 1], want: 0, tol: 2e-2, unit: " V" },
      { name: "Threshold", got: vm, want: 0.8, tol: 0.25, unit: " V" },
    ];
  },
};

/** y 가 처음 target 아래로 내려가는 주파수와 그때의 위상. 로그 주파수 위에서 선형 보간 */
function firstBelow(f: Float64Array, mag: Float64Array, ph: Float64Array, target: number): { f: number; ph: number } {
  for (let i = 1; i < f.length; i++) {
    if (mag[i] < target && mag[i - 1] >= target) {
      const k = (mag[i - 1] - target) / (mag[i - 1] - mag[i]);
      return { f: f[i - 1] * Math.pow(f[i] / f[i - 1], k), ph: ph[i - 1] + (ph[i] - ph[i - 1]) * k };
    }
  }
  return { f: NaN, ph: NaN };
}

/**
 * 데모 10 — SKY130 5트랜지스터 OTA (AC)
 *
 *   nFET 입력쌍(X3·X4) + pFET 전류 거울 부하(X1·X2) + 꼬리 전류원(X5). VDD 1.8 V,
 *   두 입력 모두 0.9 V, 꼬리 게이트 0.7 V, 부하 1 pF. 모든 소자 W 5 µm · L 1 µm.
 *   + 입력(inp)에만 AC 1 V 를 건다 — 나머지 전원은 AC 0 이다. 그렇지 않으면 VDD 에도
 *   신호가 실려 전원 잡음까지 같이 재게 된다.
 *
 * 입력이 같으면 출력이 거울 쪽 노드(x)와 같은 전압에 앉는다 — 대칭이라서다. 그래서 되먹임
 * 없이 열린 채로 돌려도 고이득 영역에 있고, 작은 신호 이득을 그대로 잴 수 있다.
 *
 * 이득 크기는 공정 모델이 정한다 (gm·(ro2 || ro4)). 손으로 맞출 수 있는 것은 **극이
 * 하나라는 것**이다 — 출력 노드의 1 pF 가 나머지 극보다 훨씬 낮은 곳에 극을 만든다:
 *   H(f) = A0 / (1 + j f/f3dB)
 *   -> f3dB 에서 위상 -45°,  낮은 주파수에서 위상 -atan(f/f3dB),  |H| = 1 인 주파수 = f3dB·sqrt(A0²-1)
 * 시뮬레이션은 이것과 0.04% 안에서 맞는다 (위상 여유 87.5°).
 *
 * 몸통(bulk)은 핀이 없어 소스에 묶인다 (SKY130 소자 공통). 입력쌍에 기판 효과가 없다.
 */
export const SKY130_OTA: Demo = {
  id: "ota-sky130",
  name: "SKY130 5T OTA",
  build() {
    const b = builder("SKY130 5T OTA");
    const size = { w: "5u", l: "1u" };
    // 전류 거울 (소스가 위). 회전 180 이면 게이트가 오른쪽, 거기에 좌우 대칭을 더하면 왼쪽
    b.part("sky130_pfet", [-60, -140], size, 180);          // X1 다이오드 쪽  S[-60,-160] D[-60,-120] G[-40,-140]
    b.part("sky130_pfet", [60, -140], size, 180, true);     // X2 출력 쪽      S[60,-160]  D[60,-120]  G[40,-140]
    // 입력쌍
    b.part("sky130_nfet", [-60, -40], size);                // X3 (+)  D[-60,-60] G[-80,-40] S[-60,-20]
    b.part("sky130_nfet", [60, -40], size, 0, true);        // X4 (-)  D[60,-60]  G[80,-40]  S[60,-20]
    b.part("sky130_nfet", [0, 40], size);                   // X5 꼬리 D[0,20] G[-20,40] S[0,60]
    b.part("gnd", [0, 80]);
    b.part("vdc", [-80, 80], { dc: "0.7", ac: "0" });       // V1 꼬리 바이어스
    b.part("gnd", [-80, 120]);
    b.part("vdc", [-140, 0], { dc: "0.9", ac: "1" });       // V2 + 입력 (AC 신호는 여기만)
    b.part("gnd", [-140, 40]);
    b.part("vdc", [120, 0], { dc: "0.9", ac: "0" });        // V3 - 입력
    b.part("gnd", [120, 40]);
    b.part("vdc", [220, -140], { dc: "1.8", ac: "0" });     // V4 VDD
    b.part("gnd", [220, -100]);
    b.part("c", [160, -80], { value: "1p" });               // C1 부하
    b.part("gnd", [160, -40]);

    b.wire([-60, -160], [-60, -180], [60, -180], [60, -160]);   // VDD 줄
    b.wire([220, -160], [220, -180], [60, -180]);
    b.wire([220, -120], [220, -100]);
    b.wire([-40, -140], [40, -140]);                            // 거울 게이트끼리
    b.wire([-40, -140], [-40, -100], [-60, -100]);              // X1 은 다이오드 연결
    b.wire([-60, -120], [-60, -60]);                            // x
    b.wire([60, -120], [60, -60]);                              // out
    b.wire([60, -100], [160, -100]);                            // 부하로
    b.wire([160, -60], [160, -40]);
    b.wire([-60, -20], [-60, 0], [60, 0], [60, -20]);           // 꼬리
    b.wire([0, 0], [0, 20]);
    b.wire([0, 60], [0, 80]);
    b.wire([-80, 60], [-80, 40], [-20, 40]);                    // vb
    b.wire([-80, 100], [-80, 120]);
    b.wire([-140, -20], [-140, -40], [-80, -40]);               // inp
    b.wire([-140, 20], [-140, 40]);
    b.wire([120, -20], [120, -40], [80, -40]);                  // inn
    b.wire([120, 20], [120, 40]);
    b.label("vdd", [0, -180]); b.label("x", [-60, -80]); b.label("out", [60, -80]);
    b.label("tail", [-30, 0]); b.label("vb", [-50, 40]);
    b.label("inp", [-110, -40]); b.label("inn", [100, -40]);
    // 열면 Bode 크기 하나만 보이게
    b.probe([110, -100]);
    b.project.sim = { kind: "ac", sweep: "dec", points: "20", fstart: "1k", fstop: "10G" };
    // 이득은 입력쌍의 gm 과 출력 마디의 두 출력 컨덕턴스로 손계산한다: A0 = gm3·(rO2 ‖ rO4) = gm3/(gds2 + gds4).
    // 극이 하나라 fu = A0·f−3dB = gm3/(2π·CL). 출력 마디에는 1 pF 말고 소자의 기생 용량도 있어 손계산이 1.4 % 높다
    b.project.calc = [
      "bode = db20(v(out)/v(inp))",
      "phi = phase(v(out)/v(inp))",
      "a0 = dcgain(v(out)/v(inp))",
      "gm(X3)/(gds(X2) + gds(X4))   # by hand",
      "fu = ugf(v(out)/v(inp))",
      "gm(X3)/(2*pi*1pF)   # by hand",
      "pm(v(out)/v(inp))",
      "gmid(X3)",
    ];
    return b.project;
  },
  measure(get) {
    const f = get("frequency").values, out = get("V(out)");
    const mag = out.values, ph = out.phaseDeg ?? new Float64Array(mag.length);
    const a0 = mag[0];
    const p3 = firstBelow(f, mag, ph, a0 / Math.SQRT2), pu = firstBelow(f, mag, ph, 1);
    const fu = p3.f * Math.sqrt(a0 * a0 - 1);
    return [
      /*
       * 이득은 손계산이 아니라 공정 모델이 정한다 (40.4 dB). 여기서는 'OTA 로서 이 정도는
       * 되어야 한다' 는 창만 둔다 — 소자 하나라도 선형 영역에 빠지면 이득이 수 dB 로 무너진다.
       */
      { name: "DC gain", got: 20 * Math.log10(a0), want: 40, tol: 6, unit: " dB" },
      // + 입력이라 반전이 없다. 극 하나가 낮은 주파수에서도 조금 늦춘다
      { name: "Phase @1kHz", got: ph[0], want: (-Math.atan(f[0] / p3.f) * 180) / Math.PI, tol: 0.2, unit: "deg" },
      { name: "Phase @f3dB", got: p3.ph, want: -45, tol: 1, unit: "deg" },
      { name: "Unity gain", got: pu.f, want: fu, tol: fu * 0.01, unit: " Hz" },
    ];
  },
};

/**
 * 데모 11 — SKY130 StrongARM 래치 (과도)
 *
 * 클럭이 낮으면 리셋: pFET 넷(X1·X4·X9·X10)이 출력과 안쪽 마디 p·q 를 VDD 로 올려 둔다.
 * 클럭이 오르면 꼬리(X11)가 켜지고, 입력쌍(X7·X8)이 p·q 를 끌어내린다. 입력이 조금이라도 큰
 * 쪽이 먼저 내려가고, 교차 결합된 두 인버터(X2·X3·X5·X6)가 그 차이를 레일까지 키운다.
 *
 * 비교기 한 개를 10 ns 클럭으로 두 번 돌린다. inn 은 0.9 V 에 묶고 inp 를 0.91 → 0.89 V 로
 * 바꿔 ±10 mV 를 한 번씩 준다:
 *   1~5 ns   inp > inn  ->  outp = VDD, outn = 0
 *   5~11 ns  리셋        ->  둘 다 VDD
 *   11~15 ns inp < inn  ->  outp = 0, outn = VDD
 *
 * 래치의 이득은 무한이라 결정의 **방향**과 **레일**은 손으로 안다. 걸리는 시간(10 mV 에서
 * 약 107 ps)은 공정 모델이 정한다 — 대신 회로가 좌우 대칭이므로 +10 mV 와 -10 mV 의 결정
 * 시간이 같아야 한다는 것을 본다.
 *
 * 클럭과 VDD 는 넷 라벨로 잇는다 (같은 이름이면 같은 넷). 트랜지스터 11개의 게이트·소스까지
 * 전부 선으로 끌고 다니면 그림이 선 덤불이 된다. 몸통은 소스에 묶인다 (SKY130 소자 공통).
 */
export const SKY130_STRONGARM: Demo = {
  id: "strongarm-sky130",
  name: "SKY130 StrongARM latch",
  build() {
    const b = builder("SKY130 StrongARM latch");
    const L = "0.15u";
    const small = { w: "1u", l: L }, wide = { w: "3u", l: L };
    // 위: 리셋과 교차 결합 pFET (소스가 위)
    b.part("sky130_pfet", [-120, -160], small, 180, true);   // X1 outn 리셋   S[-120,-180] D[-120,-140] G[-140,-160]
    b.part("sky130_pfet", [-60, -160], small, 180);          // X2 교차 (왼)   S[-60,-180]  D[-60,-140]  G[-40,-160]
    b.part("sky130_pfet", [60, -160], small, 180, true);     // X3 교차 (오른) S[60,-180]   D[60,-140]   G[40,-160]
    b.part("sky130_pfet", [120, -160], small, 180);          // X4 outp 리셋   S[120,-180]  D[120,-140]  G[140,-160]
    // 가운데: 교차 결합 nFET
    b.part("sky130_nfet", [-60, -100], small, 0, true);      // X5  D[-60,-120] S[-60,-80] G[-40,-100]
    b.part("sky130_nfet", [60, -100], small);                // X6  D[60,-120]  S[60,-80]  G[40,-100]
    // 아래: 입력쌍과 p·q 리셋
    b.part("sky130_nfet", [-60, -40], wide);                 // X7 (+) D[-60,-60] S[-60,-20] G[-80,-40]
    b.part("sky130_nfet", [60, -40], wide, 0, true);         // X8 (-) D[60,-60]  S[60,-20]  G[80,-40]
    b.part("sky130_pfet", [-120, -80], small, 180, true);    // X9  p 리셋 S[-120,-100] D[-120,-60] G[-140,-80]
    b.part("sky130_pfet", [120, -80], small, 180);           // X10 q 리셋 S[120,-100]  D[120,-60]  G[140,-80]
    b.part("sky130_nfet", [0, 40], wide);                    // X11 꼬리   D[0,20] G[-20,40] S[0,60]
    b.part("gnd", [0, 80]);
    b.part("vpulse", [-200, 40], { v1: "0", v2: "1.8", td: "1n", tr: "50p", tf: "50p", pw: "4n", per: "10n" }); // V1 clk
    b.part("gnd", [-200, 80]);
    b.part("vpulse", [-140, 20], { v1: "0.91", v2: "0.89", td: "7.5n", tr: "100p", tf: "100p", pw: "10n", per: "20n" }); // V2 inp
    b.part("gnd", [-140, 60]);
    b.part("vdc", [140, 20], { dc: "0.9" });                 // V3 inn
    b.part("gnd", [140, 60]);
    b.part("vdc", [200, -160], { dc: "1.8" });               // V4 VDD
    b.part("gnd", [200, -120]);

    // VDD 줄
    b.wire([-120, -180], [-120, -200], [120, -200], [120, -180]);
    b.wire([-60, -180], [-60, -200]);
    b.wire([60, -180], [60, -200]);
    b.wire([200, -180], [200, -200], [120, -200]);
    b.wire([200, -140], [200, -120]);
    b.label("vdd", [0, -200]);
    // 출력
    b.wire([-120, -140], [-60, -140]);
    b.wire([-60, -140], [-60, -120]);
    b.wire([120, -140], [60, -140]);
    b.wire([60, -140], [60, -120]);
    b.label("outn", [-110, -140]); b.label("outp", [70, -140]);
    // 교차 결합: 왼쪽 게이트 둘은 outp, 오른쪽 둘은 outn. 가로선 둘이 엇갈려 건넌다 (십자는 연결이 아니다)
    b.wire([-40, -160], [-40, -100]);
    b.wire([40, -160], [40, -100]);
    b.wire([-60, -130], [40, -130]);
    b.wire([60, -120], [-40, -120]);
    // p · q
    b.wire([-60, -80], [-60, -60]);
    b.wire([60, -80], [60, -60]);
    b.wire([-120, -60], [-60, -60]);
    b.wire([120, -60], [60, -60]);
    b.label("p", [-60, -70]); b.label("q", [60, -70]);
    b.wire([-120, -100], [-120, -120]); b.label("vdd", [-120, -120]);
    b.wire([120, -100], [120, -120]); b.label("vdd", [120, -120]);
    // 클럭 (라벨로)
    b.wire([-140, -160], [-160, -160]); b.label("clk", [-160, -160]);
    b.wire([140, -160], [160, -160]); b.label("clk", [160, -160]);
    b.wire([-140, -80], [-160, -80]); b.label("clk", [-160, -80]);
    b.wire([140, -80], [160, -80]); b.label("clk", [160, -80]);
    b.wire([-20, 40], [-40, 40]); b.label("clk", [-40, 40]);
    b.wire([-200, 20], [-200, -20]); b.label("clk", [-200, -20]);
    b.wire([-200, 60], [-200, 80]);
    // 꼬리
    b.wire([-60, -20], [-60, 0], [60, 0], [60, -20]);
    b.wire([0, 0], [0, 20]);
    b.wire([0, 60], [0, 80]);
    b.label("tail", [-30, 0]);
    // 입력
    b.wire([-140, 0], [-140, -40], [-80, -40]); b.label("inp", [-110, -40]);
    b.wire([-140, 40], [-140, 60]);
    b.wire([140, 0], [140, -40], [80, -40]); b.label("inn", [110, -40]);
    b.wire([140, 40], [140, 60]);
    // 파형은 클럭과 두 출력만 — 아홉 넷을 다 그리면 0 V 에 겹친 선 밑으로 결정이 묻힌다
    b.probe([-200, 0]); b.probe([100, -140]); b.probe([-80, -140]);
    b.project.sim = { kind: "tran", tstop: "20n", tmax: "10p", tstart: "0" };
    /*
     * 결정 시간: 클럭이 0.9 V 를 지나 오른 뒤 두 출력의 차가 0.9 V 가 될 때까지 (위의 measure 와 같은 정의).
     * 두 번째 결정은 교차를 두 번째 것으로 골라 잰다(tc2 는 둘째 클럭 가장자리). 좌우 대칭이라 둘이 같아야 한다.
     * 결정 한 번의 에너지 = 평균 전력 × 클럭 주기
     */
    b.project.calc = [
      "d = v(outp) - v(outn)",
      "t1 = delay(v(clk), abs(d), rise, rise, 0.9, 0.9)",
      "tc2 = cross(v(clk), 0.9, 2, rise)",
      "t2 = cross(abs(d), 0.9, 2, rise) - tc2",
      "value(d, 4.5n)   # inp - inn = +10 mV",
      "value(d, 14.5n)   # inp - inn = -10 mV",
      "p = mean(power(V4))",
      "p*period(v(clk))   # energy per decision",
    ];
    return b.project;
  },
  measure(get) {
    const t = get("time").values;
    const clk = get("V(clk)").values, op = get("V(outp)").values, on = get("V(outn)").values;
    /** 클럭이 오르는 가장자리(edge 근처)부터, 두 출력의 차가 VDD/2 가 될 때까지 */
    const decide = (edge: number): number => {
      const cross = (from: number, y: (i: number) => number) => {
        for (let i = 1; i < t.length; i++) {
          if (t[i] > from && y(i) >= 0 && y(i - 1) < 0) return t[i - 1] + (t[i] - t[i - 1]) * -y(i - 1) / (y(i) - y(i - 1));
        }
        return NaN;
      };
      const tc = cross(edge, i => clk[i] - 0.9);
      return cross(tc, i => Math.abs(op[i] - on[i]) - 0.9) - tc;
    };
    const up = decide(0.9e-9), down = decide(10.9e-9);
    return [
      { name: "+10mV outp", got: valueAt(t, op, 4.5e-9), want: 1.8, tol: 0.02, unit: " V" },
      { name: "+10mV outn", got: valueAt(t, on, 4.5e-9), want: 0, tol: 0.02, unit: " V" },
      { name: "Reset outp", got: valueAt(t, op, 9e-9), want: 1.8, tol: 0.02, unit: " V" },
      { name: "Reset outn", got: valueAt(t, on, 9e-9), want: 1.8, tol: 0.02, unit: " V" },
      { name: "-10mV outp", got: valueAt(t, op, 14.5e-9), want: 0, tol: 0.02, unit: " V" },
      { name: "-10mV outn", got: valueAt(t, on, 14.5e-9), want: 1.8, tol: 0.02, unit: " V" },
      // 좌우 대칭이라 ±10 mV 의 결정 시간이 같다 (시간 간격 10 ps 보다 훨씬 작게)
      { name: "Symmetry", got: (up - down) * 1e12, want: 0, tol: 5, unit: " ps" },
    ];
  },
};

export const DEMOS: Demo[] = [
  RC_LOWPASS, INVERTING_AMP, RECTIFIER,
  DIVIDER, RC_STEP, RLC_RESONANCE, CMOS_INVERTER, CE_AMP, SKY130_INVERTER,
  SKY130_OTA, SKY130_STRONGARM,
];
