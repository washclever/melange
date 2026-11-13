// 계산기 검증 (src/calc/). 엔진 없이, 답을 손으로 구할 수 있는 파형 위에서 본다.
//
// 여기가 틀리면 조용히 틀린다: 위상 여유가 3° 어긋나도, THD 가 2 dB 어긋나도 오류는 안 난다.
// 그래서 기대값은 전부 **닫힌 식**이다 — 단극점의 -3 dB 는 극점, kT/C, Razavi 식 (14.6) · (14.9),
// 1차 계단의 τ·ln 100. 엔진을 거친 값은 tools/e2e-calc.ts 가 본다.
import { parseLine } from "../src/calc/parse.ts";
import { calcSaves, evaluateRows, normName, runFromTraces, type RowResult, type RunData } from "../src/calc/eval.ts";
import { eng, formatValue } from "../src/calc/format.ts";
import { UNKNOWN } from "../src/calc/units.ts";
import { DEVICE_FNS, deviceNeeds, findDevice, parseDevices } from "../src/calc/devices.ts";
import { fft, spectrum } from "../src/calc/dsp.ts";
import { FNS, FUNCTIONS } from "../src/calc/funcs.ts";
import { CHAPTERS, fill, hints, rowFor, spiceNum, type Names } from "../src/calc/metrics.ts";
import { checkAnalysis, savePlan } from "../src/net/netlist.ts";
import { missingVectors, withoutSaves } from "../src/sim-run.ts";
import { tfGainUnit, type Trace } from "../src/sim-values.ts";
import { emptyProject, type SimSettings, type SpiceBlock } from "../src/doc/types.ts";
import { BUILTIN } from "../src/lib/parts.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};
/** 상대 오차로 견준다 (기대값이 0 이면 절대 오차) */
const near = (got: number, want: number, tol: number, msg: string) => {
  const err = want === 0 ? Math.abs(got) : Math.abs(got / want - 1);
  ok(err <= tol, msg, `${got.toPrecision(8)}  기대 ${want.toPrecision(8)}  오차 ${err.toExponential(1)}  허용 ${tol.toExponential(0)}`);
};

const T = (name: string, values: ArrayLike<number>, phaseDeg?: ArrayLike<number>): Trace =>
  ({ name, values: Float64Array.from(values), ...(phaseDeg ? { phaseDeg: Float64Array.from(phaseDeg) } : {}) });

const none = new Map<string, RunData>();
/** 식 하나의 값 (숫자). 오류면 던진다 */
function val(run: RunData | null, expr: string, kept: ReadonlyMap<string, RunData> = none): number {
  const r = evaluateRows([expr], run, kept)[0];
  if (r.error) throw new Error(`${expr}: ${r.error}`);
  if (r.value?.t !== "num") throw new Error(`${expr}: 숫자가 아니다 (${r.value?.t})`);
  return r.value.re;
}
const row = (run: RunData | null, expr: string, kept: ReadonlyMap<string, RunData> = none): RowResult =>
  evaluateRows([expr], run, kept)[0];
const errOf = (run: RunData | null, expr: string, kept: ReadonlyMap<string, RunData> = none): string =>
  row(run, expr, kept).error ?? "";

// ── 1. 문법 ───────────────────────────────────────────────────────────
console.log("[문법] 수 · 연산 순서 · 이름");
{
  const n = (s: string) => val(null, s);
  near(n("1k"), 1000, 0, "1k");
  near(n("2.2meg"), 2.2e6, 1e-15, "2.2meg (메가)");
  near(n("5m"), 5e-3, 1e-15, "5m (밀리)");
  near(n("3e-9 + 1n"), 4e-9, 1e-12, "지수 표기와 접미사");
  near(n("10uF * 1kHz"), 1e-2, 1e-12, "단위 글자는 무시한다 (10uF · 1kHz)");
  near(n("1µ"), 1e-6, 1e-15, "µ 도 u 로 읽는다");
  const m = parseLine("1M");
  ok(m.warnings.length === 1 && /milli/.test(m.warnings[0]), "1M 은 밀리라고 알려 준다", m.warnings[0]);
  ok(/write a \*/.test(parseLine("2pi").error?.msg ?? ""), "2pi 를 2p 로 읽지 않는다 — 곱셈표를 쓰라고 한다");

  near(n("2+3*4"), 14, 0, "곱셈이 먼저");
  near(n("-2^2"), -4, 0, "-2^2 = -(2^2)");
  near(n("2^3^2"), 512, 0, "거듭제곱은 오른쪽부터");
  near(n("2^-1"), 0.5, 0, "2^-1");
  near(n("2**3"), 8, 0, "** 도 거듭제곱");
  near(n("10/4/5"), 0.5, 0, "나눗셈은 왼쪽부터");
  near(n("(1+2)*3 # 주석"), 9, 0, "괄호 · 줄 끝 주석");
  ok(parseLine("  # 주석만").blank && parseLine("").blank, "주석뿐인 줄 · 빈 줄은 건너뛴다");

  const p = parseLine("z = v(output_impedance_at_v(out)) + @m.xm1.msky130_fd_pr__nfet_01v8[gm]");
  ok(p.name === "z" && !p.error, "이름 붙이기");
  const e = p.expr!;
  ok(e.k === "bin" && e.a.k === "sig" && e.a.names[0] === "output_impedance_at_v(out)", "v() 안의 괄호는 이름의 일부다");
  ok(e.k === "bin" && e.b.k === "raw" && e.b.path === "m.xm1.msky130_fd_pr__nfet_01v8" && e.b.param === "gm", "@경로[파라미터]");
  const d = parseLine("dm.v(a, b) / dm.gm(M1)").expr!;
  ok(d.k === "bin" && d.a.k === "sig" && d.a.scope === "dm" && d.a.names.join() === "a,b", "보관 이름 · v(a,b)");
  ok(d.k === "bin" && d.b.k === "dev" && d.b.scope === "dm" && d.b.dev === "M1", "보관 이름 · 소자 함수");
  const o = parseLine("op(M1, cgg)").expr!;
  ok(o.k === "dev" && o.fn === "op" && o.param === "cgg", "op(소자, 파라미터)");

  ok(!!parseLine("a == 3").error, "== 는 이름 붙이기가 아니다");
  ok(/Missing \)/.test(parseLine("(1+2").error?.msg ?? ""), "닫지 않은 괄호");
  ok(/Missing \)/.test(parseLine("v(out").error?.msg ?? ""), "닫지 않은 v(");
  ok(/empty name/.test(parseLine("v()").error?.msg ?? ""), "빈 이름");
  ok(/Unknown function/.test(errOf(null, "nope(1)")), "없는 함수");
  ok(/takes 2 arguments/.test(errOf(null, "atan2(1)")), "인자 수");
  ok(/is a function/.test(errOf(null, "mean")), "괄호 없이 적은 함수 이름");
  near(n("sqrt(kb*tnom/1p)"), Math.sqrt(1.380649e-23 * 300.15 / 1e-12), 1e-12, "상수: kT/C 잡음 64.4 µV");
}

// ── 2. 줄과 이름 ──────────────────────────────────────────────────────
console.log("\n[줄] 위 줄의 이름을 아래 줄이 쓴다");
{
  const rs = evaluateRows(["a = 2", "b = a*3", "c = nope + 1", "c*2", "b + 1"], null, none);
  ok(rs[1].value?.t === "num" && rs[1].value.re === 6, "b = a*3");
  ok(/Unknown name "nope"/.test(rs[2].error ?? ""), "모르는 이름");
  ok(/row 3 failed/.test(rs[3].error ?? ""), "실패한 줄의 이름을 쓰면 그 줄을 가리킨다", rs[3].error ?? "");
  ok(rs[4].value?.t === "num" && rs[4].value.re === 7, "한 줄의 실패가 다음 줄을 막지 않는다");
  ok(/Run the simulation/.test(errOf(null, "v(out)")), "실행 전에는 실행하라고 한다");
}

// ── 3. 과도 파형: 통계 · 미적분 · 교차 ────────────────────────────────
console.log("\n[과도] 고르지 않은 간격의 사인파 (ngspice 의 과도 해석이 그렇다)");
const F0 = 1e3, A = 0.8, OFF = 0.3;
// 간격이 1:3 으로 번갈아 바뀌는 격자 — 점의 산술 평균이 틀리게 나오는 모양이다
const tGrid: number[] = [];
for (let t = 0, i = 0; t < 5e-3 - 1e-12; i++) { tGrid.push(t); t += i % 2 ? 0.6e-6 : 1.8e-6; }
tGrid.push(5e-3);
const sine = runFromTraces([
  T("time", tGrid),
  T("v(out)", tGrid.map(t => OFF + A * Math.sin(2 * Math.PI * F0 * t))),
  T("v(in)", tGrid.map(t => A * Math.sin(2 * Math.PI * F0 * t))),
  T("v(ramp)", tGrid.map(t => 2 * t)),
  T("v(sq)", tGrid.map(t => t * t)),
  T("i(v1)", tGrid.map(t => 1e-3 * Math.cos(2 * Math.PI * F0 * t))),
], { kind: "tran" });
{
  near(val(sine, "mean(v(out))"), OFF, 1e-6, "평균 (시간 가중) = 오프셋");
  near(val(sine, "rms(v(out))"), Math.hypot(OFF, A / Math.SQRT2), 1e-6, "RMS = √(오프셋² + A²/2)");
  near(val(sine, "stddev(v(out))"), A / Math.SQRT2, 1e-6, "표준편차 = A/√2");
  near(val(sine, "pp(v(out))"), 2 * A, 1e-5, "최대 − 최소 = 2A");
  near(val(sine, "ymax(v(out))"), OFF + A, 1e-5, "최대");
  near(val(sine, "xmax(v(out), 0, 1m)"), 0.25e-3, 2e-3, "최대가 나는 시각 (첫 주기)");
  near(val(sine, "mean(v(out), 1m, 3m)"), OFF, 1e-6, "구간을 준 평균");
  near(val(sine, "integ(v(ramp))"), 25e-6, 1e-12, "∫ 2t dt = t² (직선은 정확하다)");
  near(val(sine, "integ(v(ramp), 1m, 2m)"), 3e-6, 1e-12, "구간 적분");
  near(val(sine, "value(deriv(v(ramp)), 2m)"), 2, 1e-12, "직선의 미분");
  near(val(sine, "value(deriv(v(sq)), 2m)"), 4e-3, 1e-9, "d(t²)/dt = 2t (3점 공식은 2차식에 정확하다)");
  near(val(sine, "last(iinteg(v(ramp)))"), 25e-6, 1e-12, "누적 적분의 끝값");
  near(val(sine, "value(v(ramp), 1.2345m)"), 2.469e-3, 1e-12, "보간한 값");
  // t = 0 에서 0 으로 시작하는 것은 교차가 아니다. 첫 상승 교차는 한 주기 뒤다
  near(val(sine, "cross(v(in), 0, 1, rise)"), 1e-3, 1e-6, "첫 상승 교차 = 1 주기 (0 에서 시작한 것은 세지 않는다)");
  near(val(sine, "cross(v(in), 0, 2, rise)"), 2e-3, 1e-6, "두 번째 상승 교차");
  near(val(sine, "cross(v(in), 0.4, 1)"), Math.asin(0.5) / (2 * Math.PI * F0), 1e-5, "레벨 0.4 의 첫 교차");
  near(val(sine, "cross(v(in), 0, -1, fall)"), 4.5e-3, 1e-6, "끝에서 첫 번째 하강 교차");
  near(val(sine, "ncross(v(in), 0, rise)"), 4, 0, "상승 교차 수 (t = 0 과 끝의 0 은 세지 않는다)");
  near(val(sine, "period(v(out))"), 1 / F0, 1e-6, "주기");
  near(val(sine, "freq(v(out))"), F0, 1e-6, "주파수");
  near(val(sine, "duty(v(out))"), 0.5, 1e-4, "듀티 50 %");
  near(val(sine, "mean(v(in)*i(v1))"), 0, 1e-9, "v·i 의 평균 (90° 어긋난 사인) = 0");
  near(val(sine, "rms(v(out) - v(in))"), OFF, 1e-9, "파형끼리의 뺄셈");
  ok(row(sine, "v(in)*i(v1)").value?.t === "wave" && (row(sine, "v(in)*i(v1)").value as { unit: string }).unit === "W", "V·A = W");
  ok(/No net "nope"/.test(errOf(sine, "v(nope)")) && /Nets: out, in/.test(errOf(sine, "v(nope)")), "없는 넷은 있는 넷을 알려 준다", errOf(sine, "v(nope)"));
  ok(/never crosses/.test(errOf(sine, "cross(v(in), 5)")), "닿지 않는 레벨");
  ok(/outside the data/.test(errOf(sine, "value(v(in), 1)")), "범위 밖의 x");
  ok(/rise, fall or either/.test(errOf(sine, "cross(v(in), 0, 1, up)")), "모르는 가장자리 이름");
}

console.log("\n[과도] 1차 계단 응답 1 − e^(−t/τ) — Razavi 예제 9.2");
{
  const tau = 1e-6;
  const t = Array.from({ length: 4001 }, (_, i) => i * 5e-9);          // 0 … 20τ
  const step = runFromTraces([T("time", t), T("v(out)", t.map(x => 1 - Math.exp(-x / tau)))], { kind: "tran" });
  near(val(step, "settling(v(out), 1)"), tau * Math.log(100), 2e-4, "1 % 정착 시간 = τ·ln 100 = 4.6τ");
  near(val(step, "settling(v(out), 0.1)"), tau * Math.log(1000), 5e-4, "0.1 % 정착 시간 = τ·ln 1000");
  near(val(step, "risetime(v(out))"), tau * Math.log(9), 2e-4, "10–90 % 상승 시간 = τ·ln 9");
  near(val(step, "slewrate(v(out))"), 0.8 / (tau * Math.log(9)), 2e-4, "10–90 % 평균 기울기");
  // 가장 가파른 곳이 맨 처음 점이다. 끝점의 미분은 한쪽 차분이라 간격의 절반만큼(h/2τ = 0.25 %) 낮다
  near(val(step, "ymax(deriv(v(out)))"), 1 / tau, 3e-3, "가장 가파른 기울기 = 1/τ");
  near(val(step, "overshoot(v(out))"), 0, 1e-12, "오버슈트 없음");
  ok(/does not fall/.test(errOf(step, "falltime(v(out))")), "오르는 계단에 falltime 을 쓰면 알려 준다");

  // 2차 저감쇠: 오버슈트 = exp(−πζ/√(1−ζ²))
  const z = 0.5, wn = 2 * Math.PI * 1e6, wd = wn * Math.sqrt(1 - z * z);
  const t2 = Array.from({ length: 20001 }, (_, i) => i * 1e-9);
  const y2 = t2.map(x => 1 - Math.exp(-z * wn * x) * (Math.cos(wd * x) + (z / Math.sqrt(1 - z * z)) * Math.sin(wd * x)));
  const ring = runFromTraces([T("time", t2), T("v(out)", y2)], { kind: "tran" });
  near(val(ring, "overshoot(v(out))"), Math.exp((-Math.PI * z) / Math.sqrt(1 - z * z)), 1e-4, "2차 계 ζ = 0.5 의 오버슈트 16.3 %");
  near(val(ring, "xmax(v(out))"), Math.PI / wd, 2e-3, "첫 봉우리의 시각 π/ωd");
  // 2 % 띠: 포락선 e^(−ζωn t)/√(1−ζ²) 가 0.02 가 되는 때보다 늦지 않다
  ok(val(ring, "settling(v(out), 2)") <= Math.log(1 / (0.02 * Math.sqrt(1 - z * z))) / (z * wn) * 1.0001, "2 % 정착은 포락선이 띠에 드는 때 안쪽이다");
}

console.log("\n[과도] 클럭: 주기 · 듀티 · 지터 · 지연");
{
  // 주기가 1 ns ± δ 로 번갈아 바뀌는 사다리꼴 클럭 (30 % 듀티). 지터의 표준편차는 δ 다
  const d = 5e-12, tr = 20e-12;
  const ts: number[] = [], ys: number[] = [];
  let t0 = 0;
  for (let k = 0; k < 40; k++) {
    const per = 1e-9 + (k % 2 ? d : -d);
    ts.push(t0, t0 + tr, t0 + 0.3 * per, t0 + 0.3 * per + tr);
    ys.push(0, 1, 1, 0);
    t0 += per;
  }
  ts.push(t0); ys.push(0);
  const clk = runFromTraces([T("time", ts), T("v(clk)", ys), T("v(late)", ys.map((_, i) => ys[i])), T("time2", ts)], { kind: "tran" });
  near(val(clk, "period(v(clk))"), 1e-9, 1e-3, "평균 주기");
  near(val(clk, "jitter(v(clk))"), d, 2e-2, "RMS 주기 지터 = δ");
  near(val(clk, "pp(periods(v(clk)))"), 2 * d, 2e-2, "주기의 최대 − 최소 = 2δ");
  near(val(clk, "duty(v(clk))"), 0.3, 1e-2, "듀티 30 %");
  ok(row(clk, "instfreq(v(clk))").value?.t === "wave", "instfreq 는 가장자리마다의 점들이다");
  near(val(clk, "delay(v(clk), shift(v(clk), 70p), rise, rise, 0.5, 0.5)"), 70e-12, 1e-6, "70 ps 늦춘 것과의 지연");
  near(val(clk, "delay(v(clk), shift(v(clk), 70p), rise, rise)"), 70e-12, 1e-6, "레벨을 안 주면 각자의 가운데");
  near(val(clk, "risetime(v(clk))"), 0.8 * tr, 1e-6, "클럭의 상승 시간 (처음 = 끝이면 최소 · 최대를 레벨로)");
}

// ── 4. 스펙트럼 · 왜곡 ────────────────────────────────────────────────
console.log("\n[스펙트럼] FFT 와 고조파 맞추기");
{
  // FFT 자체: 임펄스의 변환은 평평하다 / 파르스발
  const re = new Float64Array(64), im = new Float64Array(64);
  re[3] = 1;
  fft(re, im);
  ok(re.every((r, k) => Math.abs(Math.hypot(r, im[k]) - 1) < 1e-12), "임펄스의 FFT 는 크기가 전부 1");

  // 3 주기가 딱 들어가는 구간: 사각 창이 정확하다
  const sp = evaluateRows(["s = fft(v(in), 0, 3m, 4096, rect)", "value(mag(s), 1k)", "value(mag(s), 2k)", "ymax(mag(s))", "xmax(mag(s))"], sine, none);
  near((sp[1].value as { re: number }).re, A, 1e-4, "기본파의 크기 = 진폭 (사각 창, 정수 주기)");
  ok((sp[2].value as { re: number }).re < 1e-4 * A, "다른 빈은 비어 있다 (다시 찍을 때의 보간 오차뿐)");
  near((sp[4].value as { re: number }).re, 1e3, 1e-12, "봉우리의 주파수");
  near(val(sine, "value(mag(fft(v(out), 0, 4m, 4096, rect)), 0)"), OFF, 1e-6, "0 Hz 빈 = 직류 성분");
  near(val(sine, "ymax(mag(fft(v(in), 0, 4m, 8192, hann)))"), A, 1e-4, "hann 창도 진폭을 그대로 읽는다 (창 이득을 되돌린다)");
  near(val(sine, "ymax(mag(fft(v(in), 0, 4m, 8192, flattop)))"), A, 1e-4, "flattop 창");
  near(val(sine, "integ(psd(v(in), 0, 4m, 4096, rect))"), A * A / 2, 1e-3, "∫ PSD df = 분산 (파르스발)");
  ok(/Unknown window/.test(errOf(sine, "fft(v(in), 0, 4m, 4096, kaiser)")), "모르는 창 이름");
  const s2 = spectrum({ t: "wave", x: Float64Array.from(tGrid), re: Float64Array.from(tGrid, t => Math.sin(2 * Math.PI * F0 * t)), im: null, axis: "time", xunit: "s", unit: "V" }, 0, 4e-3, 4096, "rect");
  near(s2.df, 250, 1e-12, "주파수 간격 = 1/구간");

  // Razavi 식 (14.9): y = α1·A cos + α2·A² cos² + α3·A³ cos³
  const a1 = 1, a2 = 0.1, a3 = 0.05, amp = 0.5;
  const y = tGrid.map(t => { const c = amp * Math.cos(2 * Math.PI * F0 * t); return a1 * c + a2 * c * c + a3 * c * c * c; });
  const nl = runFromTraces([T("time", tGrid), T("v(out)", y)], { kind: "tran" });
  const fund = a1 * amp + (3 * a3 * amp ** 3) / 4;
  const hd2 = (a2 * amp * amp / 2) / fund, hd3 = (a3 * amp ** 3 / 4) / fund;
  near(val(nl, "harmonic(v(out), 1)"), fund, 1e-7, "기본파 = α1·A + 3α3·A³/4");
  near(val(nl, "hd(v(out), 2)"), hd2, 1e-6, "HD2 = (α2·A²/2) / 기본파");
  near(val(nl, "hd(v(out), 3)"), hd3, 1e-5, "HD3 = (α3·A³/4) / 기본파");
  near(val(nl, "thd(v(out))"), Math.hypot(hd2, hd3), 1e-6, "THD = √(HD2² + HD3²) — 진폭 비");
  near(val(nl, "thd(v(out))^2"), ((a2 * amp * amp / 2) ** 2 + (a3 * amp ** 3 / 4) ** 2) / fund ** 2, 5e-6, "그 제곱이 식 (14.10) 의 전력 비다");
  near(val(nl, "thd(v(out), 1k, 5, 1m, 4m)"), Math.hypot(hd2, hd3), 1e-6, "f0 · 구간을 준 THD");
  near(val(nl, "sfdr(v(out))"), -20 * Math.log10(hd2), 1e-5, "SFDR = 가장 큰 고조파까지의 거리");
  near(val(nl, "sndr(v(out))"), -20 * Math.log10(Math.hypot(hd2, hd3)), 1e-3, "SNDR (잡음이 없으면 = −THD)");
  near(val(nl, "mean(v(out), 1m, 5m)"), a2 * amp * amp / 2, 1e-5, "짝수 차 항이 만드는 직류 α2·A²/2");
  ok(/f0 = 1\.000 kHz/.test((row(nl, "thd(v(out))").value as { note?: string }).note ?? ""), "기본 주파수를 스스로 찾고 어디서 쟀는지 적는다");
  ok(/at least one/.test(errOf(nl, "thd(v(out), 10)")), "한 주기도 안 들어가는 f0 는 알려 준다");
}

// ── 5. 주파수 응답 ────────────────────────────────────────────────────
console.log("\n[주파수 응답] 극점이 정해진 전달 함수 — 10배마다 20점");
type C = [number, number];
const cdiv = (a: C, b: C): C => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
const cmul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const logGrid = (f1: number, f2: number, perDec = 20): number[] => {
  const n = Math.round(Math.log10(f2 / f1) * perDec);
  return Array.from({ length: n + 1 }, (_, i) => f1 * Math.pow(10, i / perDec));
};
/** 주파수마다의 복소 응답으로 AC 결과를 만든다 (워커가 주는 대로 크기 · 위상) */
function acRun(f: number[], sigs: Record<string, (f: number) => C>, info: Parameters<typeof runFromTraces>[1] = {}): RunData {
  const traces = [T("frequency", f)];
  for (const [name, h] of Object.entries(sigs)) {
    const v = f.map(h);
    traces.push(T(name, v.map(c => Math.hypot(c[0], c[1])), v.map(c => (Math.atan2(c[1], c[0]) * 180) / Math.PI)));
  }
  return runFromTraces(traces, { kind: "ac", ...info });
}
const pole = (f: number, p: number): C => cdiv([1, 0], [1, f / p]);
{
  const A0 = 1000, P1 = 1e3, P2 = 2e6, P3 = 3e7;
  const f = logGrid(1, 1e10);
  const ac = acRun(f, {
    "v(in)": () => [1, 0],
    "v(one)": x => cmul([A0, 0], pole(x, P1)),
    "v(inv)": x => cmul([-A0, 0], pole(x, P1)),
    "v(two)": x => cmul(cmul([A0, 0], pole(x, P1)), pole(x, P2)),
    "v(three)": x => cmul(cmul(cmul([A0, 0], pole(x, P1)), pole(x, P2)), pole(x, P3)),
    "v(half)": x => cmul([0.5, 0], pole(x, P1)),
  });
  near(val(ac, "dcgain(v(one)/v(in))"), A0, 1e-6, "A0");
  // 기준은 스윕의 첫 점(1 Hz)의 이득이다. 거기서도 이미 5e-7 만큼 내려와 있어서 반전력점이 그만큼 위다
  near(val(ac, "f3db(v(one))"), P1 * Math.sqrt(1 + 2 * (1 / P1) ** 2), 1e-6, "단극점의 −3 dB 주파수 = 극점 (반전력점 1/√2 로 잰다)");
  near(val(ac, "f3db(v(one), 6)"), P1 * Math.sqrt(10 ** 0.6 - 1), 2e-3, "다른 dB 는 그 값 그대로: −6 dB");
  near(val(ac, "ugf(v(one))"), P1 * Math.sqrt(A0 * A0 - 1), 1e-4, "단위 이득 주파수 = p·√(A0² − 1)");
  near(val(ac, "gbw(v(one))"), A0 * P1, 1e-6, "GBW = A0·f−3dB");
  near(val(ac, "pm(v(one))"), 180 - (Math.atan(Math.sqrt(A0 * A0 - 1)) * 180) / Math.PI, 1e-5, "단극점의 위상 여유 90.06°");
  near(val(ac, "pm(v(inv))"), val(ac, "pm(v(one))"), 1e-12, "반전 증폭(위상이 180° 에서 시작)도 같은 여유다");
  // 2극: |H| = 1 인 주파수를 풀어 위상을 구한다
  const mag2 = (x: number) => A0 / Math.hypot(1, x / P1) / Math.hypot(1, x / P2);
  let lo = 1, hi = 1e10;
  for (let i = 0; i < 200; i++) { const m = Math.sqrt(lo * hi); if (mag2(m) > 1) lo = m; else hi = m; }
  const fu2 = Math.sqrt(lo * hi);
  near(val(ac, "ugf(v(two))"), fu2, 3e-4, "2극 계의 단위 이득 주파수");
  near(val(ac, "pm(v(two))"), 180 - ((Math.atan(fu2 / P1) + Math.atan(fu2 / P2)) * 180) / Math.PI, 2e-3, "2극 계의 위상 여유");
  // 3극: 위상이 −180° 가 되는 주파수와 거기서의 이득
  const ph3 = (x: number) => Math.atan(x / P1) + Math.atan(x / P2) + Math.atan(x / P3);
  lo = 1; hi = 1e10;
  for (let i = 0; i < 200; i++) { const m = Math.sqrt(lo * hi); if (ph3(m) < Math.PI) lo = m; else hi = m; }
  const f180 = Math.sqrt(lo * hi);
  const mag3 = (x: number) => mag2(x) / Math.hypot(1, x / P3);
  near(val(ac, "pcross(v(three))"), f180, 1e-3, "위상 교차 주파수 (−180°)");
  near(val(ac, "gainmargin(v(three))"), -20 * Math.log10(mag3(f180)), 2e-3, "이득 여유");
  ok(val(ac, "gainmargin(v(two))") === Infinity, "위상이 −180° 에 닿지 않으면 이득 여유는 ∞");
  ok(/never reaches/.test((row(ac, "gainmargin(v(two))").value as { note?: string }).note ?? ""), "그 이유를 적는다");
  near(val(ac, "value(groupdelay(v(one)), 10)"), 1 / (2 * Math.PI * P1), 1e-3, "단극점의 군지연 1/(2π·p)");
  near(val(ac, "value(phase(v(three)), 1g)"), (-ph3(1e9) * 180) / Math.PI, 1e-6, "위상은 −180° 를 지나도 끊기지 않는다");
  near(val(ac, "value(db20(v(one)), 1meg)"), 20 * Math.log10(A0 / Math.hypot(1, 1e3)), 1e-9, "dB");
  near(val(ac, "value(vdb(one), 1meg)"), 20 * Math.log10(A0 / Math.hypot(1, 1e3)), 1e-9, "vdb(net) 은 db20(v(net)) 이다");
  near(val(ac, "value(vp(one), 1k)"), -45, 1e-9, "vp(net): 극점에서 −45°");
  // 남는 오차는 무릎에서의 보간이다 (10배마다 20점). 점을 늘리면 준다
  near(val(ac, "enbw(v(one))"), (Math.PI / 2) * P1, 1e-3, "잡음 대역폭 = π/2 · 극점 (Razavi 7.8)");
  near(val(ac, "peaking(v(one))"), 0, 1e-12, "단극점은 솟지 않는다");
  ok(/already below 1/.test(errOf(ac, "ugf(v(half))")), "이득이 처음부터 1 아래면 알려 준다");
  ok(/needs the phase/.test(errOf(ac, "pm(mag(v(one)))")), "크기만 주면 위상 여유를 못 잰다");
  ok(/frequency response/.test(errOf(sine, "ugf(v(out))")), "과도 파형에 ugf 를 쓰면 알려 준다");
  ok(/real waveform/.test(errOf(ac, "risetime(v(one))")), "복소 파형에 시간 함수를 쓰면 알려 준다");

  // 2차 공진: 봉우리 = Q/√(1 − 1/4Q²)
  const Q = 2, fn = 1e6;
  const res = acRun(logGrid(1e3, 1e9, 200), { "v(out)": x => cdiv([1, 0], [1 - (x / fn) ** 2, x / fn / Q]) });
  near(val(res, "peaking(v(out))"), 20 * Math.log10(Q / Math.sqrt(1 - 1 / (4 * Q * Q))), 1e-3, "2차 계의 솟음 (Q = 2) 6.30 dB");

  // 미들브룩: Tv = Ti = T 이면 … 두 주입의 결합식 자체를 본다
  near(val(null, "middlebrook(9, 4)"), (9 * 4 - 1) / (9 + 4 + 2), 1e-12, "미들브룩 결합식 (Tv·Ti − 1)/(Tv + Ti + 2)");
}

// ── 6. 잡음 ───────────────────────────────────────────────────────────
console.log("\n[잡음] RC 의 열잡음과 1/f 코너");
{
  const kT = 1.380649e-23 * 300.15, R = 1e3, Cc = 1e-9, fc = 1 / (2 * Math.PI * R * Cc);
  const f = logGrid(1, 1e11, 10);                       // 잡음 해석의 기본값: 10배마다 10점
  const on = f.map(x => Math.sqrt((4 * kT * R) / (1 + (x / fc) ** 2)));
  const corner = 2e4;
  const flick = f.map(x => 4e-9 * Math.sqrt(1 + corner / x));
  const nz = runFromTraces([T("frequency", f), T("onoise_spectrum", on), T("inoise_spectrum", flick)], { kind: "noise" });
  near(val(nz, "rmsnoise(onoise)"), Math.sqrt(kT / Cc), 2e-3, "∫ 4kTR/(1+(f/fc)²) df = kT/C  (2.035 µV)");
  near(val(nz, "rmsnoise(onoise, 1, 10)"), Math.sqrt(4 * kT * R * 9), 1e-6, "평평한 대역: √(4kTR·Δf)");
  near(val(nz, "enbw(onoise)"), (Math.PI / 2) * fc, 3e-3, "잡음 대역폭 = π/2 · fc (식 7.146)");
  near(val(nz, "fcorner(inoise)"), corner, 3e-2, "1/f 코너 주파수");
  near(val(nz, "ymin(inoise)"), 4e-9, 1e-3, "열잡음 바닥");
  near(val(nz, "value(onoise, 1)"), Math.sqrt(4 * kT * R), 1e-6, "저항의 열잡음 밀도 4.07 nV/√Hz");
  near(val(nz, "snr(1/sqrt(2), rmsnoise(onoise))"), 20 * Math.log10(1 / Math.SQRT2 / Math.sqrt(kT / Cc)), 1e-4, "SNR");
  const u = row(nz, "rmsnoise(onoise)").value as { unit: string };
  ok(u.unit === "V", "밀도(V/√Hz)를 적분하면 V 다");
  ok(formatValue(row(nz, "onoise").value!).includes("V/√Hz"), "밀도의 단위");
  ok(/comes from a noise analysis/.test(errOf(sine, "onoise")), "잡음 해석이 아닌데 onoise 를 쓰면 알려 준다");
  ok(/no 1\/f region/.test(errOf(nz, "fcorner(onoise)")), "1/f 구간이 없는 밀도에 fcorner 를 쓰면 알려 준다");
  ok(/noise spectra/.test(errOf(nz, "v(out)")), "잡음 해석에는 넷 전압이 없다고 알려 준다");
  const ni = runFromTraces([T("frequency", f), T("inoise_spectrum", flick)], { kind: "noise", inoiseUnit: "A/√Hz" });
  ok((row(ni, "rmsnoise(inoise)").value as { unit: string }).unit === "A", "입력이 전류원이면 입력 환산 잡음은 전류다");
}

// ── 7. DC 전달 ────────────────────────────────────────────────────────
console.log("\n[DC 스윕] 전달 곡선");
{
  const x = Array.from({ length: 2001 }, (_, i) => -1 + i * 1e-3);
  const dc = runFromTraces([
    T("v(v-sweep)", x),
    T("v(out)", x.map(v => -Math.tanh(10 * v))),
    T("v(cub)", x.map(v => v - 0.1 * v ** 3)),
    T("v(off)", x.map(v => 5 * (v - 0.0123))),
  ], { kind: "dc" });
  near(val(dc, "slope(v(out), 0)"), -10, 1e-4, "원점에서의 기울기 (작은 신호 이득)");
  near(val(dc, "ymax(abs(deriv(v(out))))"), 10, 1e-4, "가장 큰 이득");
  // 이득이 봉우리의 절반 이상인 구간: sech²(10x) ≥ 1/2 -> |y| ≤ tanh(acosh √2) = 1/√2
  near(val(dc, "swing(v(out), 0.5)"), Math.SQRT2, 1e-3, "출력 스윙 (이득 ≥ 봉우리의 절반) = √2");
  // Razavi 예제 14.1, 식 (14.6): y = α1 x + α3 x³, 범위 ±xmax
  const a3 = -0.1;
  near(val(dc, "nonlin(v(cub))"), Math.abs((2 * a3) / (3 * Math.sqrt(3) * 2 * (1 + a3))), 1e-5, "비선형성 = 2α3·x³/(3√3·2(α1x + α3x³)) — 식 (14.6)");
  near(val(dc, "nonlin(v(off))"), 0, 1e-12, "직선의 비선형성은 0");
  near(val(dc, "cross(v(off), 0)"), 0.0123, 1e-9, "출력이 0 이 되는 입력 = 오프셋");
  ok(/DC sweep/.test(errOf(dc, "v(out) + xval(fft(v(out)))")) || /Cannot combine/.test(errOf(dc, "v(out) + fft(v(out))")), "축이 다른 파형은 섞지 않는다");

  const temp = Array.from({ length: 34 }, (_, i) => -40 + i * 5);
  const vr = (t: number) => 1.2 + 1e-5 * (t - 27) - 1e-6 * (t - 27) ** 2;
  const bg = runFromTraces([T("temp-sweep", temp), T("v(ref)", temp.map(vr))], { kind: "dc" });
  const ys = temp.map(vr);
  const mean = val(bg, "mean(v(ref))");
  near(val(bg, "tc(v(ref))"), ((Math.max(...ys) - Math.min(...ys)) / (mean * 165)) * 1e6, 1e-9, "온도 계수 (상자법) ppm/°C");
  // 27 °C 는 찍힌 점이 아니다 (25 · 30 사이). 2차 항만큼 보간 오차가 있다
  near(val(bg, "tc(v(ref), 27)"), (1e-5 / 1.2) * 1e6, 1e-5, "27 °C 에서의 온도 계수 (1/V)·dV/dT");
  ok((row(bg, "tc(v(ref))").value as { unit: string }).unit === "ppm/°C", "온도 스윕이면 단위는 ppm/°C");
  near(val(bg, "value(v(ref), 27)"), 1.2, 1e-5, "27 °C 의 값 (보간)");
  near(val(bg, "value(v(ref), 30)"), vr(30), 1e-15, "찍힌 점에서는 그 값 그대로");
  ok(bg.axis === "temp" && bg.xunit === "°C", "temp-sweep 축을 온도로 읽는다");
  // °C 는 온도 차로 읽어 K 와 같은 차원이다 — 미분하면 V/K (= V/°C)
  ok((row(bg, "deriv(v(ref))").value as { unit: string }).unit === "V/K", "온도로 미분하면 V/K", (row(bg, "deriv(v(ref))").value as { unit: string }).unit);

  const idc = runFromTraces([T("i(i-sweep)", [0, 1e-3, 2e-3]), T("v(out)", [0, 2, 4])], { kind: "dc" });
  ok(idc.xunit === "A" && (row(idc, "deriv(v(out))").value as { unit: string }).unit === "Ω", "전류를 쓸면 dV/dI 의 단위는 Ω");
}

// ── 8. 자르기 · 다시 찍기 · 복소수 ────────────────────────────────────
console.log("\n[파형 다루기]");
{
  near(val(sine, "npoints(sample(v(ramp), 1m))"), 6, 0, "sample: 0 … 5 ms 를 1 ms 마다 = 6점");
  near(val(sine, "last(sample(v(ramp), 1m, 0.5m))"), 2 * 4.5e-3, 1e-12, "sample 의 시작 시각");
  near(val(sine, "mean(sample(v(ramp), 1m))"), 5e-3, 1e-12, "점 묶음의 평균은 산술 평균이다");
  near(val(sine, "first(clip(v(ramp), 1.5m, 2.5m))"), 3e-3, 1e-12, "clip 의 끝은 보간한 점이다");
  near(val(sine, "npoints(resample(v(ramp), 11))"), 11, 0, "resample");
  near(val(sine, "value(shift(v(ramp), 1m), 2m)"), 2e-3, 1e-12, "shift(w, dx): x 를 dx 만큼 민다");
  near(val(sine, "last(xval(v(ramp)))"), 5e-3, 1e-15, "xval: 가로축");
  near(val(sine, "last(time)"), 5e-3, 1e-15, "time 은 가로축이다");
  near(val(null, "mag((3+0)/(1-0))"), 3, 0, "숫자의 크기");
  const f = [1, 10];
  const cx = acRun(f, { "v(a)": () => [1, 2], "v(b)": () => [3, -1] });
  const q = cdiv([1, 2], [3, -1]);
  near(val(cx, "real(first(v(a)/v(b)))"), q[0], 1e-12, "복소수 나눗셈 — 실수부");
  near(val(cx, "imag(first(v(a)/v(b)))"), q[1], 1e-12, "복소수 나눗셈 — 허수부");
  near(val(cx, "first(mag(v(a)*conj(v(a))))"), 5, 1e-12, "z·z* = |z|²");
  near(val(cx, "first(phase(v(a)))"), (Math.atan2(2, 1) * 180) / Math.PI, 1e-12, "위상 (도)");
  near(val(cx, "first(mag(v(a,b)))"), Math.hypot(1 - 3, 2 + 1), 1e-12, "v(a,b) = v(a) − v(b)");
  near(val(cx, "first(vr(a))") + val(cx, "first(vi(a))"), 3, 1e-12, "vr · vi");
  near(val(cx, "mag(first(sqrt(v(a)*v(a))))"), Math.hypot(1, 2), 1e-12, "복소수의 제곱근");
  ok(/needs a real/.test(errOf(cx, "sin(v(a))")), "복소수에 실수 함수를 쓰면 알려 준다");
}

// ── 9. 숫자 적기 ──────────────────────────────────────────────────────
console.log("\n[표기] 공학 표기와 단위");
{
  ok(eng(13.834e6, "Hz") === "13.83 MHz", "13.83 MHz", eng(13.834e6, "Hz"));
  ok(eng(0.99996, "V") === "1.000 V", "반올림해서 1000 m 가 되면 한 칸 위 접두어로", eng(0.99996, "V"));
  ok(eng(2.035e-6, "V") === "2.035 µV", "µ", eng(2.035e-6, "V"));
  ok(eng(-4.7e3, "Ω") === "-4.700 kΩ", "음수", eng(-4.7e3, "Ω"));
  ok(eng(87.482, "°") === "87.48°", "도는 접두어 없이", eng(87.482, "°"));
  ok(eng(2.5e6, "V/s") === "2.500 V/µs", "슬루율은 V/µs 로", eng(2.5e6, "V/s"));
  ok(eng(Infinity, "dB") === "∞ dB", "무한대", eng(Infinity, "dB"));
  ok(eng(0, "V") === "0 V" && eng(NaN, "V") === "NaN", "0 과 NaN");
  ok(formatValue(row(null, "dcgain(100)").value!) === "100.00 (40.00 dB)", "이득은 dB 를 같이 적는다", formatValue(row(null, "dcgain(100)").value!));
  const pct = runFromTraces([T("time", [0, 1, 2, 3]), T("v(o)", [0, 1.2, 0.9, 1])], { kind: "tran" });
  ok(formatValue(row(pct, "overshoot(v(o))").value!) === "20.00 % (-13.98 dB)", "비율은 % 와 dB 로", formatValue(row(pct, "overshoot(v(o))").value!));
  ok(formatValue(row(sine, "v(out)").value!) === `waveform · ${tGrid.length} pts · V`, "파형은 점 수와 단위만");
  ok(spiceNum(2.5e-3) === "2.5m" && spiceNum(1.5e6) === "1.5meg" && spiceNum(10e-6) === "10u" && spiceNum(0) === "0", "식에 넣을 숫자는 SPICE 접미사로");
}

// ── 10. 소자 ──────────────────────────────────────────────────────────
console.log("\n[소자] 넷리스트에서 소자 표를 만들고 모델에 있는 이름만 묻는다");
const NETLIST = `* t
V1 vdd 0 DC 5
V2 in 0 AC 1 SIN(0 1 1k 0 0 0)
I1 0 b DC 1m
R1 vdd out 10k
L1 out x 1m
M1 out in 0 0 MNGEN W=100u L=10u
M2 pd in vdd vdd MPGEN W=100u L=10u
M3 a b 0 0 NB W=1u L=0.1u
M4 a b 0 0 MYSTERY W=1u L=1u
M6 a b 0 0 N3 W=1u L=1u
M7 a b 0 0 N6 W=1u L=1u
XM5 x inp tail tail sky130_fd_pr__nfet_01v8 W=5u L=1u nf=1 mult=1
X6 y inp vdd vdd sky130_fd_pr__pfet_01v8_hvt W=5u L=1u
Q1 c b 0 QNGEN
Q2 c b vdd QPGEN
D1 a 0 DGEN
EU1 o 0 inp inn 100k
B1 z 0 V=V(a)*2
B2 z 0 I=V(a)*2
.model MNGEN NMOS(VTO=2 KP=20u LAMBDA=0.02)
.model MPGEN PMOS(VTO=-2 KP=10u LAMBDA=0.02)
.model NB NMOS(LEVEL=54
+ VERSION=4.8)
.model N3 NMOS(LEVEL=8)
.model N6 NMOS(LEVEL=6)
.model QNGEN NPN(IS=1e-16 BF=100)
.model QPGEN PNP(IS=1e-16 BF=100)
.model DGEN D(IS=1e-14 N=1)
.subckt inner a b
M9 a b 0 0 MNGEN
.ends
.op
.end
M99 never read 0 0 MNGEN`;
const DEV = parseDevices(NETLIST, new Map([["U1", "EU1"], ["M5", "XM5"], ["RV1", "RV1"]]));
{
  const d = (n: string) => findDevice(DEV, n)!;
  ok(d("M1").kind === "mos" && d("M1").family === "classic" && d("M1").polarity === 1, "레벨 없는 .model 은 레벨 1 (classic)");
  ok(d("M2").polarity === -1, "PMOS");
  ok(d("M3").family === "bsim4", "LEVEL=54 는 BSIM4 (이어진 줄 + 도 읽는다)");
  ok(d("M6").family === "bsim3", "LEVEL=8 은 BSIM3");
  ok(d("M4").family === null && d("M4").kind === "mos", "모델을 못 찾으면 계열을 모른다");
  ok(d("M7").family === null, "표에 없는 레벨(6)도 모른다고 한다");
  ok(d("XM5").path === "m.xm5.msky130_fd_pr__nfet_01v8" && d("XM5").family === "bsim4" && d("XM5").polarity === 1, "SKY130 은 서브회로 안의 MOSFET (BSIM4)", d("XM5").path);
  ok(d("X6").path === "m.x6.msky130_fd_pr__pfet_01v8_hvt" && d("X6").polarity === -1, "SKY130 pFET HVT");
  ok(d("M5") === d("XM5"), "회로도의 지정자 M5 로 XM5 를 찾는다");
  ok(d("m5") === d("XM5") && d("xm5") === d("XM5"), "대소문자를 가리지 않는다");
  ok(findDevice(DEV, "U1")?.name === "EU1" && findDevice(DEV, "U1")?.branch === true, "op-amp U1 은 EU1 — 가지 전류가 있다");
  ok(d("Q1").kind === "bjt" && d("Q1").polarity === 1 && d("Q2").polarity === -1, "BJT 의 극성");
  ok(d("V2").dc === false && d("V1").dc === true && d("V1").nodes[0] === "vdd", "전원: 직류뿐인가, 어느 넷인가");
  ok(d("B1").branch && !d("B2").branch, "전압형 동작 전원만 가지 전류가 있다");
  ok(!findDevice(DEV, "M9") && !findDevice(DEV, "M99"), ".subckt 안쪽과 .end 뒤는 읽지 않는다");
  ok(d("XM5").nodes.join() === "x,inp,tail,tail", "X 줄의 노드는 서브회로 이름 앞까지");

  const need = (fn: string, dev: string, p?: string) => deviceNeeds(fn, d(dev), p);
  const vec = (r: ReturnType<typeof need>) => ("vectors" in r ? r.vectors.join(" ") : "ERR " + r.error);
  ok(vec(need("vth", "M1")) === "@m1[von]", "레벨 1 의 문턱은 von 으로 묻는다 (vth 를 물으면 엔진이 멈춘다)");
  ok(vec(need("vth", "M3")) === "@m3[vth]", "BSIM 의 문턱은 vth");
  ok(vec(need("cgg", "M1")) === "@m1[cgs] @m1[cgd] @m1[cgb]", "레벨 1 에는 cgg 가 없다 — 셋을 더한다");
  ok(vec(need("ft", "XM5")) === "@m.xm5.msky130_fd_pr__nfet_01v8[gm] @m.xm5.msky130_fd_pr__nfet_01v8[cgg]", "fT = gm/(2π·Cgg)");
  ok(vec(need("vce", "Q1")) === "@q1[vbe] @q1[vbc]", "BJT 에는 vce 가 없다 — vbe − vbc");
  ok(vec(need("beta", "Q1")) === "@q1[ic] @q1[ib]", "β = ic/ib");
  ok(/no "vth".*von/.test(vec(need("op", "M1", "vth"))), "op(M1, vth) 는 막고 von 을 알려 준다", vec(need("op", "M1", "vth")));
  ok(/no "ids"/.test(vec(need("op", "XM5", "ids"))), "BSIM 에 없는 ids 도 막는다");
  ok(vec(need("op", "M4", "whatever")) === "@m4[whatever]", "모르는 모델은 막지 않는다 (워커가 다시 돌린다)");
  ok(/no "cgb"/.test(vec(need("cgb", "M6"))) && vec(need("cgb", "M3")) === "@m3[cgb]", "BSIM3 에는 cgb 가 없고 BSIM4 에는 있다 (물으면 멈춘다)", vec(need("cgb", "M6")).slice(0, 60));
  ok(vec(need("cgg", "M6")) === "@m6[cgg]" && vec(need("vth", "M6")) === "@m6[vth]", "BSIM3 의 문턱 · 게이트 용량은 vth · cgg");
  // 계열을 모르면 문턱을 짐작하지 않는다: 레벨 6 에 vth 를 물으면 오류 없이 0 이 온다 (재 봤다) — 문턱 0 V 는 그럴듯해서 더 나쁘다
  for (const f of ["vth", "vov", "cgg", "ft"]) {
    ok(/not one the calculator knows.*op\(M7, vth\) or op\(M7, von\)/.test(vec(need(f, "M7"))), `모르는 모델의 ${f}() 는 막고 op() 를 알려 준다`);
  }
  ok(vec(need("gm", "M7")) === "@m7[gm]" && vec(need("gmid", "M4")) === "@m4[gm] @m4[id]", "이름이 계열과 무관한 값(gm · id)은 모르는 모델에서도 묻는다");
  ok(/does not apply/.test(vec(need("gm", "D1"))), "다이오드에 gm() 은 없다");
  ok(vec(need("power", "V1")) === "@v1[p]" && vec(need("power", "M1")) === "@m1[id] @m1[vds]", "power()");

  // 부호: ngspice 는 PMOS 의 vgs · vds · id 를 크기로 주고, 레벨 1 의 von · vdsat 은 음수 그대로 준다 (재 본 값)
  const pm = (o: Record<string, number>) => (p: string) => o[p];
  const mp = d("M2");
  near(DEVICE_FNS.vov.calc(mp, pm({ vgs: 2.5, von: -1 })), 1.5, 1e-12, "PMOS 레벨 1: VOV = |VGS| − |VTH|");
  near(DEVICE_FNS.satmargin.calc(mp, pm({ vds: 3.79, vdsat: -1.5 })), 2.29, 1e-12, "PMOS: |VDS| − |VDS,sat|");
  near(DEVICE_FNS.vth.calc(mp, pm({ von: -1 })), 1, 0, "PMOS: |VTH|");
  near(DEVICE_FNS.vth.calc(d("M1"), pm({ von: -0.4 })), -0.4, 0, "NMOS 의 음수 문턱(공핍형)은 그대로 둔다");
  near(DEVICE_FNS.cgs.calc(d("XM5"), pm({ cgs: -6.9e-16 })), 6.9e-16, 0, "BSIM 의 음수 상호 용량은 크기로");
  near(DEVICE_FNS.ft.calc(d("XM5"), pm({ gm: 4.2e-4, cgg: 9.5e-16 })), 4.2e-4 / (2 * Math.PI * 9.5e-16), 1e-12, "fT");
  near(DEVICE_FNS.ic.calc(d("Q2"), pm({ ic: -6.15e-5 })), 6.15e-5, 0, "PNP 의 전류는 정방향을 양수로");
  near(DEVICE_FNS.beta.calc(d("Q2"), pm({ ic: -6.15e-5, ib: -5.67e-7 })), 6.15e-5 / 5.67e-7, 1e-12, "β 는 극성과 무관하다");
  near(DEVICE_FNS.vce.calc(d("Q1"), pm({ vbe: 0.7, vbc: -4.24 })), 4.94, 1e-12, "VCE = VBE − VBC");
  near(DEVICE_FNS.power.calc(d("V1"), pm({ p: -1.368e-4 })), 1.368e-4, 0, "전원의 power 는 내보낸 전력 (양수)");
  near(DEVICE_FNS.gmid.calc(d("M1"), pm({ gm: 1e-4, id: 2.5e-5 })), 4, 1e-12, "gm/ID");
}

console.log("\n[소자] 실행 결과에서 값을 읽는다");
{
  const dev = parseDevices(NETLIST);
  const t = [0, 1e-3, 2e-3];
  // 엔진은 종류에 따라 v() · i() 로 싸서 준다: i(@m1[id]) · v(@m1[vgs]) (재 본 이름)
  const tr = runFromTraces([
    T("time", t), T("v(out)", [1, 2, 3]),
    T("@m1[gm]", [1e-4, 2e-4, 3e-4]), T("@m1[gds]", [1e-6, 1e-6, 2e-6]), T("i(@m1[id])", [1e-5, 2e-5, 3e-5]),
    T("v(@m1[vgs])", [2.5, 2.6, 2.7]), T("v(@m1[von])", [2, 2, 2]), T("i(v1)", [-1e-5, -2e-5, -3e-5]),
  ], { kind: "tran", devices: dev, unavailable: ["@m4[bogus]"] });
  ok(normName("i(@M1[id])") === "@m1[id]" && normName("V(Out)") === "v(out)", "엔진이 싸 준 이름을 벗긴다");
  near(val(tr, "value(gm(M1), 1m)"), 2e-4, 1e-12, "과도 해석에서는 소자 값도 시간의 파형이다");
  near(val(tr, "last(gm(M1)/id(M1))"), 10, 1e-12, "gm/ID");
  near(val(tr, "last(gmid(M1))"), 10, 1e-12, "gmid() 와 같다");
  near(val(tr, "last(ro(M1))"), 5e5, 1e-12, "rO = 1/gds");
  near(val(tr, "first(gmro(M1))"), 100, 1e-12, "gm·rO");
  near(val(tr, "last(vov(M1))"), 0.7, 1e-12, "VGS − VTH (레벨 1 은 von)");
  near(val(tr, "last(@m1[gm])"), 3e-4, 0, "@m1[gm] — ngspice 의 이름 그대로");
  near(val(tr, "last(op(M1, gds))"), 2e-6, 0, "op(M1, gds)");
  near(val(tr, "last(i(M1))"), 3e-5, 0, "i(M1) 은 드레인 전류");
  near(val(tr, "last(i(V1))"), -3e-5, 0, "i(V1) 은 가지 전류 (+ 단자로 들어가는 쪽이 양수)");
  ok((row(tr, "gm(M1)").value as { unit: string }).unit === "S" && (row(tr, "ro(M1)").value as { unit: string }).unit === "Ω", "단위");
  ok(/press Run/.test(errOf(tr, "vdsat(M1)")) && /@m1\[vdsat\]/.test(errOf(tr, "vdsat(M1)")), "저장 안 된 값은 다시 실행하라고 한다", errOf(tr, "vdsat(M1)"));
  ok(/repeated without it/.test(errOf(tr, "op(M4, bogus)")), "엔진에 없어서 뺀 값은 그렇게 말한다", errOf(tr, "op(M4, bogus)"));
  ok(/No part "M77"/.test(errOf(tr, "gm(M77)")) && /M1/.test(errOf(tr, "gm(M77)")), "없는 소자는 있는 것을 알려 준다");
  ok(/does not apply to diode/.test(errOf(tr, "gm(D1)")), "종류가 안 맞는 함수");

  // AC: 동작점은 하나다. 주파수마다 되풀이된 값을 숫자 하나로
  const ac = acRun([1, 10, 100], { "v(out)": () => [1, 0], "@m1[gm]": () => [1e-4, 0], "@m1[cgs]": () => [-2e-15, 0], "i(@m1[id])": () => [2e-5, 0] }, { devices: dev });
  const g = row(ac, "gm(M1)").value!;
  ok(g.t === "num" && g.re === 1e-4, "AC 해석의 gm 은 숫자 하나다 (평평한 파형이 아니다)");
  near(val(ac, "cgs(M1)"), 2e-15, 1e-12, "음수는 위상 180° 로 왔다가 실수부로 돌아온다");
  near(val(ac, "@m1[cgs]"), -2e-15, 1e-12, "@ 로 읽으면 ngspice 의 부호 그대로");
  ok(/AC currents only for voltage sources/.test(errOf(ac, "i(M1)")), "AC 에서 i(M1) 은 막는다 (동작점 전류이지 AC 전류가 아니다)", errOf(ac, "i(M1)"));

  const op = runFromTraces([T("v(out)", [4.7]), T("@m1[gm]", [1.1e-4]), T("i(@m1[id])", [2.7e-5]), T("i(v1)", [-2.7e-5])], { kind: "op", devices: dev });
  near(val(op, "gm(M1)/id(M1)"), 1.1e-4 / 2.7e-5, 1e-12, "동작점: 숫자끼리");
  near(val(op, "mean(v(out)) + ymax(v(out)) + pp(v(out))"), 9.4, 1e-12, "숫자 하나에 통계 함수를 써도 돈다");
  near(val(op, "-i(V1)*v(out)"), 2.7e-5 * 4.7, 1e-12, "전력 = −i(V1)·v");
  ok(/single number/.test(errOf(op, "deriv(v(out))")), "점 하나에 미분은 못 한다고 알려 준다");
}

console.log("\n[보관한 실행] 두 번 돌려 비교한다 (CMRR · PSRR)");
{
  const f = logGrid(1, 1e6);
  const dm = acRun(f, { "v(out)": x => cmul([200, 0], pole(x, 1e4)) });
  const cm = acRun(f, { "v(out)": x => cmul([0.02, 0], pole(x, 1e5)) });
  const kept = new Map([["dm", dm], ["cm", cm]]);
  near(val(null, "db20(dcgain(dm.v(out)) / dcgain(cm.v(out)))", kept), 80, 1e-6, "CMRR = |ADM/ACM| = 80 dB (식 4.55)");
  near(val(cm, "db20(dcgain(dm.v(out)) / dcgain(v(out)))", kept), 80, 1e-6, "보관한 것과 지난 실행을 섞는다");
  ok(/No kept result named "xx"/.test(errOf(dm, "xx.v(out)", kept)) && /dm, cm/.test(errOf(dm, "xx.v(out)", kept)), "없는 보관 이름");
  ok(/Keep to name a run/.test(errOf(dm, "xx.v(out)")), "보관한 것이 하나도 없을 때");
  // 격자가 다른 두 실행: 뒤의 것을 앞의 격자에 맞춘다
  const coarse = acRun(logGrid(1, 1e6, 5), { "v(out)": x => cmul([200, 0], pole(x, 1e4)) });
  near(val(dm, "ymax(mag(v(out)/c.v(out) - 1))", new Map([["c", coarse]])), 0, 0.05, "격자가 다른 실행끼리는 보간해 맞춘다 (오차는 성긴 쪽의 보간)");
  // 지난 실행이 다음 실행에 필요한 것만 저장한다 — 보관한 실행을 읽는 식은 빼고
  const saves = calcSaves(["gm(M1)", "dm.gm(M3)", "dm.v(q)"], DEV, new Set(["q"]));
  ok(saves.join() === "@m1[gm]", "보관한 실행을 읽는 식은 다음 실행에 아무것도 묻지 않는다", saves.join(" "));
}

// ── 11. 저장 줄 ───────────────────────────────────────────────────────
console.log("\n[저장] 계산기가 읽는 것을 다음 실행에 저장하게 한다");
{
  const nets = new Set(["out", "in", "vdd"]);
  const s = (lines: string[], kind?: string) => calcSaves(lines, DEV, nets, kind).join(" ");
  ok(s(["gm(M1)/id(M1)", "gm(M1)*ro(M1)"]) === "@m1[gm] @m1[id] @m1[gds]", "소자 값 (겹치는 것은 한 번)", s(["gm(M1)/id(M1)", "gm(M1)*ro(M1)"]));
  ok(s(["v(out) - v(nope) + v(0)"]) === "v(out)", "넷은 있는 것만");
  ok(s(["i(V1)", "i(L1)", "i(U1)", "i(R1)", "i(M1)", "i(Q1)", "i(I1)"]) === "i(v1) i(l1) i(eu1) @r1[i] @m1[id] @q1[ic] @i1[c]", "전류: 가지 전류가 있으면 그것, 없으면 소자 파라미터", s(["i(V1)", "i(L1)", "i(U1)", "i(R1)", "i(M1)", "i(Q1)", "i(I1)"]));
  ok(s(["i(V1)", "i(R1)", "i(M1)"], "ac") === "i(v1)", "AC 에서는 소자 파라미터로 읽는 전류를 묻지 않는다 (뜻이 없다)");
  ok(s(["op(M1, vth)", "@m1[cgg]", "gm(D1)", "gm(M77)"]) === "", "모델에 없는 이름 · 안 맞는 함수 · 없는 소자는 묻지 않는다 — 물으면 실행이 멈춘다");
  ok(s(["@m4[foo]", "op(M4, bar)"]) === "@m4[foo] @m4[bar]", "모르는 모델은 묻는다 (멈추면 워커가 빼고 다시 돌린다)");
  ok(s(["vth(M4)", "ft(M7)", "gm(M7)"]) === "@m7[gm]", "모르는 모델의 문턱 · fT 는 묻지 않는다 (짐작한 이름이 0 으로 올 수 있다)");
  ok(s(["a = gm(M1", "b = 2 +"]) === "", "문법이 틀린 줄은 건너뛴다");

  const block = (lines: string[]): SpiceBlock => ({ id: "b", at: [0, 0], lines, active: true });
  const X = ["@m1[gm]", "i(v1)"];
  const lines = (...a: Parameters<typeof savePlan>) => savePlan(...a).lines.join(" | ");
  ok(lines(["out", "in"], [], [], [], "tran", X) === ".save v(out) v(in) @m1[gm] i(v1)", "평소: 넷 전압 뒤에 붙는다", lines(["out", "in"], [], [], [], "tran", X));
  ok(lines(["out"], [], [], [], "op", X) === ".save all @m1[gm]", ".op 는 all 과 함께 — 그냥 적으면 그것만 저장돼 표의 전압이 사라진다 (all 이 품는 가지 전류는 다시 적지 않는다)", lines(["out"], [], [], [], "op", X));
  ok(lines(["out"], [], [], [], "noise", X) === ".save all @m1[gm]", "잡음도 all 과 함께 — 아니면 스펙트럼을 잃는다");
  ok(lines(["out"], [], [], [], "tf", X) === ".save all @m1[gm]", ".tf 도 — 아니면 해석을 건너뛴다");
  ok(lines(["out"], [], [], [], "op", ["v(out)", "i(v1)"]) === "", "전압 · 가지 전류만 읽으면 .op 에 줄을 붙이지 않는다 (이미 다 저장한다)");
  ok(lines(["out"], [], [], [], "noise") === "" && lines(["out"], [], [], [], "tf") === "", "묻는 것이 없으면 잡음 · .tf 에는 줄을 붙이지 않는다");
  ok(lines(["out"], [], [], [block(["R9 out x 1k"])], "tran", X) === ".save all @m1[gm]", "지시문 블록에 소자 줄이 있을 때도 all 과 함께");
  ok(lines(["out"], [], ["tran x FIND par('v(out)*2') AT=1m"], [], "tran", X) === ".save all @m1[gm]", ".meas 가 par() 를 쓸 때도");
  ok(lines(["out"], [], [], [block([".save v(out)"])], "tran", X) === ".save @m1[gm] i(v1)", "사용자가 .save 를 적었으면 all 없이 보태기만 한다");
  ok(/calculator/.test(savePlan(["out"], [], [], [], "tran", X).note), "무엇을 더 저장했는지 로그에 남긴다", savePlan(["out"], [], [], [], "tran", X).note);
  ok(savePlan(["out"], [], [], [], "tran").note === "", "묻는 것이 없으면 예전과 같다");
  const many = savePlan([], [], [], [], "op", Array.from({ length: 60 }, (_, i) => `@m${i}[gm]`)).lines;
  ok(many.length === 3 && many.every(l => l.startsWith(".save ")) && many[0].startsWith(".save all "), "길면 줄을 나눈다 (all 은 첫 줄에)");

  ok(missingVectors(["Warning from checkvalid: vector @m1[bogus] is not available or has zero length.", "Error during 'write': no writable vector found."]).join() === "@m1[bogus]",
     "엔진이 '없다' 고 한 벡터 이름을 읽는다");
  ok(missingVectors(["Note: v1: has no value, DC 0 assumed"]).length === 0, "다른 줄은 읽지 않는다");
  ok(missingVectors(["Warning from checkvalid: vector a is not available or has zero length."]).length === 0,
     "떠 있는 노드의 같은 문장은 계산기 탓이 아니다 (다시 돌려도 멈춘다)");
  ok(missingVectors(["run simulation(s) aborted", "Warning from checkvalid: vector @r1[i] is not available or has zero length.", "Error during 'write': no writable vector found."]).length === 0,
     "해석이 통째로 실패했으면 저장 줄의 첫 벡터를 탓하지 않는다");
  const nl = "* t\nR1 a 0 1k\n.op\n.save all @m1[gm] @M1[bogus]\n.save @m1[bogus]\n.save v(a) @m2[x]\n.end";
  ok(withoutSaves(nl, ["@m1[bogus]"]) === "* t\nR1 a 0 1k\n.op\n.save all @m1[gm]\n.save v(a) @m2[x]\n.end",
     "없는 벡터만 저장 줄에서 뺀다 — 비게 된 줄은 줄째", withoutSaves(nl, ["@m1[bogus]"]).split("\n").filter(l => l.startsWith(".save")).join(" | "));
  ok(withoutSaves(nl, ["@m9[zz]"]) === nl, "저장 줄에 없는 이름이면 그대로다");
}

// ── 12. 해석 설정 ─────────────────────────────────────────────────────
console.log("\n[해석] 잡음 · 전달 함수 · 전원 이름 검사");
{
  ok(tfGainUnit(["v(transfer_function)", "v(output_impedance_at_v(out))", "v(v2#input_impedance)"]) === "", "전압 -> 전압: 비율");
  ok(tfGainUnit(["v(transfer_function)", "v(i1#input_impedance)", "v(output_impedance_at_v(out))"]) === "Ω", "전류원 -> 전압: Ω");
  ok(tfGainUnit(["v(transfer_function)", "v(v1#output_impedance)", "v(v2#input_impedance)"]) === "S", "전압원 -> 전류: S");
  const tf = runFromTraces([T("v(transfer_function)", [-1.089]), T("v(output_impedance_at_v(out))", [9950.2]), T("v(v2#input_impedance)", [1e20])], { kind: "tf" });
  near(val(tf, "tf_gain"), -1.089, 0, "tf_gain");
  near(val(tf, "tf_rout"), 9950.2, 0, "tf_rout");
  near(val(tf, "tf_rin"), 1e20, 0, "tf_rin");
  ok((row(tf, "tf_rout").value as { unit: string }).unit === "Ω", "저항의 단위");
  const tfi = runFromTraces([T("v(transfer_function)", [1e-3]), T("v(v1#output_impedance)", [1e20]), T("v(v2#input_impedance)", [1e3])], { kind: "tf" });
  ok(val(tfi, "tf_rout") === 1e20 && (row(tfi, "tf_gain").value as { unit: string }).unit === "S", "전류 출력의 .tf");
  ok(/transfer-function analysis/.test(errOf(sine, "tf_gain")), ".tf 가 아닌데 tf_gain 을 쓰면 알려 준다");
  near(val(tf, 'vec("v(v2#input_impedance)")'), 1e20, 0, 'vec("이름") 으로 아무 벡터나');

  const p = emptyProject("t");
  const sh = p.sheets[0];
  p.library.vdc = structuredClone(BUILTIN.vdc);
  p.library.idc = structuredClone(BUILTIN.idc);
  sh.parts.push({ id: "a", lib: "vdc", ref: "V1", at: [0, 0], rot: 0, mirror: false, params: {} });
  sh.parts.push({ id: "b", lib: "idc", ref: "I1", at: [0, 0], rot: 0, mirror: false, params: {} });
  const chk = (sim: SimSettings) => checkAnalysis(sim, sh, p.library).map(i => i.message).join(" / ");
  ok(chk({ kind: "tran", tstop: "1m", tmax: "1u", tstart: "0" }) === "" && chk({ kind: "op" }) === "", "과도 · 동작점은 볼 것이 없다");
  ok(chk({ kind: "dc", source: "v1", start: "0", stop: "1", step: "0.1" }) === "", "있는 전원 (대소문자 무관)");
  ok(chk({ kind: "dc", source: "temp", start: "-40", stop: "125", step: "5" }) === "", "DC 스윕의 temp 는 온도다");
  ok(/no source by that name.*V1, I1.*temp/.test(chk({ kind: "dc", source: "V9", start: "0", stop: "1", step: "0.1" })), "없는 전원은 있는 것을 알려 준다", chk({ kind: "dc", source: "V9", start: "0", stop: "1", step: "0.1" }));
  ok(chk({ kind: "noise", out: "out", src: "I1", sweep: "dec", points: "10", fstart: "1", fstop: "1g" }) === "", "잡음의 입력은 전류원이어도 된다");
  ok(/no source/.test(chk({ kind: "tf", out: "out", src: "R1" })), "전달 함수의 입력이 전원이 아니다");
  ok(/needs a source name/.test(chk({ kind: "tf", out: "out", src: " " })), "이름이 비었다");
  sh.spice.push({ id: "s", at: [0, 0], lines: ["Vx a 0 DC 1"], active: true });
  ok(chk({ kind: "tf", out: "out", src: "VX" }) === "", "지시문 블록의 전원도 전원이다");
}

// ── 13. 성능지표 본보기 ───────────────────────────────────────────────
console.log("\n[본보기] 모든 식이 읽히고, 그 해석의 결과 위에서 돈다");
{
  const names: Names = {
    nets: ["in", "out", "vdd", "x", "outp", "outn", "inp", "inn", "vctrl", "vref"],
    probed: [], mos: ["M1", "M2"], bjt: ["Q1"],
    vsrc: [{ name: "V1", net: "vdd", dc: true }, { name: "V2", net: "in", dc: false }],
    tstop: 5e-3, sweep: [0, 50],
  };
  const h = hints(names);
  ok(h.out === "out" && h.in === "in" && h.supply === "V1" && h.vin === "V2" && h.m === "M1" && h.m2 === "M2", "자리를 회로의 이름으로 채운다", JSON.stringify({ out: h.out, in: h.in, supply: h.supply, vin: h.vin }));
  ok(h.outp === "outp" && h.outn === "outn" && h.ctrl === "vctrl" && h.ref === "vref", "차동 출력 · 제어 전압 · 기준 전압");
  ok(h.thalf === "2.5m" && h.xmid === "25", "해석 설정에서 온 숫자");
  // 전부 직류 전원이면 AC 를 실은 것이 입력이다 (5T OTA 데모: 바이어스 · 전원은 AC 0)
  const allDc = hints({ nets: ["inp", "out", "vdd", "vb"], probed: [], mos: [], bjt: [], vsrc: [
    { name: "V1", net: "vb", dc: true, ac: false }, { name: "V2", net: "inp", dc: true, ac: true }, { name: "V4", net: "vdd", dc: true, ac: false }] });
  ok(allDc.vin === "V2" && allDc.in === "inp" && allDc.supply === "V4", "직류 전원뿐이면 AC 를 실은 전원이 입력", JSON.stringify({ vin: allDc.vin, in: allDc.in, supply: allDc.supply }));
  const bare = hints({ nets: ["3", "n1"], probed: ["n1"], mos: [], bjt: [], vsrc: [] });
  ok(bare.out === "n1" && bare.m === "M1" && bare.supply === "V1", "이름이 없으면 프로브 · 본보기 값");
  ok(fill("{out}+{nope}", h) === "out+{nope}", "모르는 자리는 그대로 둔다");
  ok(rowFor(CHAPTERS[0].metrics[0], h, new Set(["gm", "gm_2"])) === "gm_3 = gm(M1)", "이름이 겹치면 번호를 붙인다");

  // 해석마다 그럴듯한 결과를 하나씩 만들어 본보기를 전부 돌려 본다. 문법 · 함수 이름 · 인자 수가
  // 틀렸으면 여기서 걸린다 (값이 맞는지는 위와 e2e 가 본다)
  const dev = parseDevices(`* t
V1 vdd 0 DC 5
V2 in 0 SIN(0 1 1k)
M1 out in 0 0 MN W=1u L=1u
M2 x in 0 0 MN W=1u L=1u
Q1 c b 0 QN
.model MN NMOS(VTO=1)
.model QN NPN(IS=1e-16)
.end`);
  const P = ["gm", "gds", "id", "vgs", "vds", "von", "vdsat", "gmbs", "cgs", "cgd", "cgb", "w", "l"];
  const devTraces = (n: number) => ["m1", "m2"].flatMap(m => P.map(p => T(`@${m}[${p}]`, Array.from({ length: n }, (_, i) =>
    p === "von" ? 1 + 0.01 * i / n : p === "vgs" ? 1.5 : p === "vds" ? 2 : p === "w" || p === "l" ? 1e-6 : 1e-4 * (1 + i / n)))));
  const tt = Array.from({ length: 5001 }, (_, i) => i * 1e-6);
  const osc = (t: number) => 0.9 + 0.8 * Math.sin(2 * Math.PI * 1e4 * t) + 0.05 * Math.sin(4 * Math.PI * 1e4 * t);
  const stepy = (t: number) => 1 - Math.exp(-t / 2e-4) * Math.cos(2 * Math.PI * 2e3 * t);
  const tran = runFromTraces([
    T("time", tt), ...["out", "in", "outp", "x"].map(n => T(`v(${n})`, tt.map(osc))),
    T("v(outn)", tt.map(t => 1.8 - osc(t))), T("v(vctrl)", tt.map(stepy)), T("v(vref)", tt.map(stepy)), T("v(vdd)", tt.map(() => 5)),
    T("i(v1)", tt.map(() => -1e-3)), T("@v1[p]", tt.map(() => -5e-3)), ...devTraces(tt.length),
  ], { kind: "tran", devices: dev });
  const fx = logGrid(1, 1e9);
  const H = (x: number): C => cmul(cmul(cmul([1000, 0], pole(x, 1e3)), pole(x, 1e7)), pole(x, 1e8));
  const mk = (kind: string): RunData => {
    const ac = acRun(fx, {
      "v(out)": H, "v(in)": () => [1, 0], "v(outp)": H, "v(outn)": x => cmul([-1, 0], H(x)), "v(inp)": () => [0.5, 0], "v(inn)": () => [-0.5, 0],
      "v(r)": x => cmul([-5, 0], pole(x, 1e4)), "v(f)": () => [1, 0], "i(vr)": x => cmul([-4, 0], pole(x, 1e4)), "i(vf)": () => [1, 0], "i(v2)": () => [-1e-6, 0],
      // AC 에서도 소자 값은 온다 (동작점의 값이 주파수마다 되풀이된다)
      ...Object.fromEntries(devTraces(1).map(t => [t.name, (): C => [t.values[0], 0]])),
    }, { devices: dev });
    ac.kind = kind;
    return ac;
  };
  const kept = new Map<string, RunData>(["dm", "cm", "sig", "sup", "tv", "ti"].map(k => [k, mk("ac")]));
  kept.set("a", tran); kept.set("b", tran);
  // 0 … 50 을 쓴다: 온도 스윕을 가정한 본보기(27 °C)도, 가운데(25)에서 재는 본보기도 같은 결과 위에서 돈다
  const sw = Array.from({ length: 501 }, (_, i) => i * 0.1);
  const dc = runFromTraces([
    T("v(v-sweep)", sw), ...["out", "outp", "vref", "x"].map(n => T(`v(${n})`, sw.map(v => 2.5 - 2 * Math.tanh(0.2 * (v - 24))))),
    T("v(outn)", sw.map(v => 2.5 + 2 * Math.tanh(0.2 * (v - 24)))), T("i(v1)", sw.map(() => -1e-3)), T("@v1[p]", sw.map(() => -5e-3)),
    ...devTraces(sw.length),
  ], { kind: "dc", devices: dev });
  const op = runFromTraces([T("v(out)", [1]), T("i(v1)", [-1e-3]), T("@v1[p]", [-5e-3]), ...devTraces(1)], { kind: "op", devices: dev });
  const nf = logGrid(1, 1e9, 10);
  const noise = runFromTraces([
    T("frequency", nf), T("onoise_spectrum", nf.map(x => 1e-7 * Math.sqrt(1 + 1e4 / x) / Math.hypot(1, x / 1e6))),
    T("inoise_spectrum", nf.map(x => 1e-8 * Math.sqrt(1 + 1e4 / x))),
  ], { kind: "noise" });
  const tfr = runFromTraces([T("v(transfer_function)", [-10]), T("v(output_impedance_at_v(out))", [1e4]), T("v(v2#input_impedance)", [1e20])], { kind: "tf" });
  const runs: Record<string, RunData> = { tran, ac: mk("ac"), dc, op, noise, tf: tfr };

  let count = 0, bad = 0;
  const seen = new Set<string>();
  for (const c of CHAPTERS) {
    for (const m of c.metrics) {
      count++;
      const line = rowFor(m, h, new Set());
      const p = parseLine(line);
      if (p.error || p.name !== m.name) { bad++; ok(false, `${c.title} › ${m.title}: 문법`, line + "  " + (p.error?.msg ?? "")); continue; }
      if (line.includes("{")) { bad++; ok(false, `${c.title} › ${m.title}: 채우지 못한 자리`, line); continue; }
      seen.add(c.title + "/" + m.name);
      // 그 식이 뜻을 갖는 해석마다 돌린다. 실행 결과가 필요 없는 식(kT/C)은 결과 없이
      for (const kind of m.needs.length ? m.needs : [null]) {
        const r = evaluateRows([line], kind ? runs[kind] : null, kept)[0];
        if (r.error) { bad++; ok(false, `${c.title} › ${m.title} (${kind ?? "실행 없이"})`, line + "  ->  " + r.error); }
      }
    }
  }
  ok(bad === 0, `본보기 ${count}개가 전부 돈다`);
  ok(seen.size === count, "장 안에서 이름이 겹치지 않는다");
  ok(CHAPTERS.length === 16 && CHAPTERS.every(c => /^Ch\. \d+ · /.test(c.ref)), "책의 2~17장을 따라 16묶음");
  ok(FUNCTIONS.every(f => f.doc.length > 8 && f.min <= f.max) && FNS.size === FUNCTIONS.length, `함수 ${FUNCTIONS.length}개: 이름이 겹치지 않고 설명이 있다`);
}

// ── 14. 단위 ──────────────────────────────────────────────────────────
/*
 * 단위는 차원으로 셈한다 (src/calc/units.ts). 숫자에 적은 단위도 값과 함께 가고, 모르는 것은 끝까지
 * 모름이다. 예전의 짝 표는 Ω·F 를 몰라 단위를 지웠고, 지워진 단위가 '차원 없음' 으로 읽혀
 * 다음 셈에서 '모름'/Ω 이 S 가 되었다 — 그런 일이 다시 생기면 여기서 깨진다.
 */
console.log("\n[단위] 차원으로 셈한다 — 숫자에 적은 단위도 가고, 모르는 것은 빈칸");
{
  const t = Array.from({ length: 200 }, (_, i) => i * 1e-6);
  const run = runFromTraces([T("time", t), T("v(out)", t.map(x => Math.sin(2e4 * x))), T("v(in)", t.map(() => 1)), T("i(v1)", t.map(() => -1e-3))], { kind: "tran" });
  const u = (expr: string): string => { const v = row(run, expr).value; return v && v.t !== "str" ? v.unit : "(값 없음: " + row(run, expr).error + ")"; };
  const is = (expr: string, want: string, msg: string) => ok(u(expr) === want, `${msg}: ${expr} -> ${want === "" ? "차원 없음" : want === UNKNOWN ? "모름" : want}`, `'${u(expr)}'`);

  // 숫자 뒤에 적은 단위
  is("1kohm*100nF", "s", "RC 는 시간");
  near(val(run, "1kohm*100nF"), 1e-4, 1e-12, "단위를 적어도 값은 그대로");
  is("1/(2*pi*1kohm*100nF)", "Hz", "1/(2πRC)");
  is("1mS/(2*pi*1pF)", "Hz", "gm/(2πC) — Razavi 의 ωu = gm/CL");
  is("1/(2*pi*sqrt(10mH*100nF))", "Hz", "1/(2π√(LC)) — 제곱근이 지수를 반으로");
  is("sqrt(10mH/100nF)/100ohm", "", "Q = √(L/C)/R");
  is("10kohm*1mA", "V", "옴의 법칙");
  is("1.8V*1mA", "W", "V·A");
  is("2.9uW*10ns", "J", "W·s");
  is("1mS*1kohm", "", "S 는 지멘스, s 는 초 — 그 둘만 대소문자를 가린다");
  is("1ms*1kHz", "", "ms · kHz");
  is("10uA/1um", "A/m", "ID/W");
  is("1F", "", "1F 는 SPICE 처럼 1 펨토 (단위가 아니다)");
  near(val(run, "1F"), 1e-15, 1e-12, "1F = 1e-15");

  // 상수
  is("kb*tnom/q", "V", "kT/q");
  near(val(run, "kb*tnom/q"), (1.380649e-23 * 300.15) / 1.602176634e-19, 1e-12, "kT/q = 25.86 mV");
  is("sqrt(kb*tnom/1pF)", "V", "√(kT/C)");
  is("sqrt(4*kb*tnom*1kohm)", "V/√Hz", "√(4kTR)");

  // 거듭제곱 · 적분 · 밀도
  is("v(out)^2", "V²", "제곱");
  is("(v(out)^2)^0.5", "V", "제곱근으로 되돌린다");
  is("integ(v(out)^2)", "V²·s", "∫ v² dt (밀도가 아니라 시간 적분)");
  is("psd(v(out))", "V²/Hz", "전력 밀도");
  is("deriv(v(out))", "V/s", "dv/dt");
  is("1/ymax(v(out))", "V⁻¹", "역수");

  // 단위 없이 적은 수는 차원이 없다
  is("2*v(out)", "V", "배수");
  is("v(out)/2", "V", "나누기");
  is("v(out) + 0.5", "V", "더한 수는 상대의 단위를 따른다");
  is("5033/1591Hz", "s", "단위 없이 적은 수를 Hz 로 나누면 s");
  is("5033Hz/1591Hz", "", "단위를 적으면 비율");

  // 모름은 끝까지 모름
  is("v(out) + i(v1)", UNKNOWN, "V + A");
  is("(v(out) + i(v1))/1kohm", UNKNOWN, "모름을 Ω 로 나눠도 S 가 되지 않는다");
  is("db20(v(out))*v(out)", UNKNOWN, "dB·V");
  is("2^v(out)", UNKNOWN, "지수에 단위");
  is("v(out)^v(in)", UNKNOWN, "파형을 지수로");
  is("db20(v(out)) + 3", "dB", "dB 에 수를 더한다");
  is("db20(v(out)) - db20(v(in))", "dB", "dB 끼리 뺀다");
  is("-3dB", "dB", "숫자 뒤의 dB");
  is("90deg", "°", "숫자 뒤의 deg");

  // 적기
  const unknown = row(run, "v(out) + i(v1)").value!;
  ok(formatValue(unknown) === "waveform · 200 pts", "모름은 빈칸으로 적는다", formatValue(unknown));
  ok(eng(1e-6, UNKNOWN) === eng(1e-6, ""), "숫자도 단위 없는 수와 똑같이 적는다", eng(1e-6, UNKNOWN));
  ok(eng(1e-6, "V²") === "1.000e-6 V²", "맨 앞에 지수가 붙은 단위에는 접두어를 달지 않는다 — µV² 는 (µV)² 로 읽힌다", eng(1e-6, "V²"));
  ok(eng(2e-4, "A/V²") === "200.0 µA/V²", "지수가 뒤에 있으면 접두어는 앞 글자에 붙는다", eng(2e-4, "A/V²"));
  ok(eng(4.071e-9, "V/√Hz") === "4.071 nV/√Hz", "잡음 밀도는 접두어 그대로", eng(4.071e-9, "V/√Hz"));
}

console.log(fail === 0 ? "\n계산기 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
