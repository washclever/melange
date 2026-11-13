// 스파이크 A: 엔진을 실제로 돌려 RC 데모가 기대값을 내는지 확인한다.
import { Simulation } from "eecircuit-engine";
import { fitSine, phaseDiffDeg } from "../src/measure.ts";

const NETLIST = `* RC lowpass - generated
V1 in 0 SIN(0 1 1k 0 0 0)
R1 in out 1k
C1 out 0 100n
.tran 10u 5m 0 10u
.end`;

const f = 1000;
const wRC = 2 * Math.PI * f * 1e3 * 100e-9;
const EXP_AMP = 1 / Math.sqrt(1 + wRC * wRC);
const EXP_PH = (-Math.atan(wRC) * 180) / Math.PI;
const WIN = { from: 1e-3, to: 5e-3 };   // 10*tau 지나고 정확히 4주기

console.log("넷리스트:\n" + NETLIST.split("\n").map(l => "  " + l).join("\n") + "\n");

const t0 = Date.now();
const sim = new Simulation();
await sim.start();
console.log(`엔진 초기화 ${Date.now() - t0} ms`);

sim.setNetList(NETLIST);
const t1 = Date.now();
const res: any = await sim.runSim();
console.log(`시뮬레이션 ${Date.now() - t1} ms`);

const err = sim.getError?.();
if (err?.length) console.log("오류:", err);

// 결과 구조 확인
console.log(`\n결과: ${res.numPoints} 점, 변수 ${res.numVariables}개`);
console.log("변수 목록:", res.variableNames ?? res.data?.map((d: any) => d.name));

const pick = (name: string) => {
  const d = res.data.find((x: any) => x.name.toLowerCase() === name.toLowerCase());
  if (!d) throw new Error(`${name} 을 결과에서 못 찾음. 있는 것: ${res.data.map((x: any) => x.name).join(", ")}`);
  return d.values;
};

const time = pick("time");
const vin = pick("V(in)");
const vout = pick("V(out)");

// 실제 시간 간격 분포 — ngspice가 균일하지 않다는 걸 확인
const dts: number[] = [];
for (let i = 1; i < time.length; i++) dts.push(time[i] - time[i - 1]);
dts.sort((a, b) => a - b);
console.log(`시간 간격: 최소 ${(dts[0]*1e9).toFixed(0)} ns, 중앙 ${(dts[dts.length>>1]*1e6).toFixed(2)} us, 최대 ${(dts[dts.length-1]*1e6).toFixed(2)} us`);

const fi = fitSine(time, vin, f, WIN);
const fo = fitSine(time, vout, f, WIN);
const gotPh = phaseDiffDeg(fo.phaseDeg, fi.phaseDeg);

console.log(`\n측정 구간 ${WIN.from*1e3}~${WIN.to*1e3} ms, 샘플 ${fo.samples}개`);
console.log(`입력 피팅 잔차 RMS ${fi.rmsResidual.toExponential(2)} V`);
console.log(`출력 피팅 잔차 RMS ${fo.rmsResidual.toExponential(2)} V`);

let fail = 0;
const check = (n: string, got: number, exp: number, tol: number, u: string) => {
  const d = Math.abs(got - exp), ok = d <= tol;
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n.padEnd(14)} ${got.toFixed(4).padStart(9)} ${u}   기대 ${exp.toFixed(4)}  오차 ${d.toExponential(2)}  허용 ${tol}`);
};
console.log("\n--- M3 완료 기준 ---");
check("Input amplitude", fi.amplitude, 1.0, 0.01, "V");
check("Output amplitude", fo.amplitude, EXP_AMP, 0.01 * EXP_AMP, "V");
check("Phase shift", gotPh, EXP_PH, 1.0, "deg");

console.log(fail === 0 ? "\n스파이크 A 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
