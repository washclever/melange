// 완료 기준: 데모 회로를 회로도로 만들고 -> 넷 추출 -> 넷리스트 -> ngspice ->
// 손으로 계산한 기대값과 대조까지 한 줄로 통과하는지 본다.
// 넷리스트를 손으로 적지 않고 회로도에서 만들어 내는 것이 핵심이다.
import { Simulation } from "eecircuit-engine";
import { DEMOS, builder } from "../src/lib/demos.ts";
import { extractNets } from "../src/net/extract.ts";
import { beforeEnd, buildNetlist, checkCircuit, savePlan } from "../src/net/netlist.ts";
import { fitSine, phaseDiffDeg } from "../src/measure.ts";
import type { SimSettings } from "../src/doc/types.ts";
import { toTraces } from "../src/sim-values.ts";
import { diagnose } from "../src/sim-log.ts";
import { measureNames, parseMeasures, formatMeasure } from "../src/sim-measure.ts";
import { readFileSync, existsSync } from "node:fs";

/*
 * SKY130 모델을 엔진의 가상 파일 시스템에 올린다. 브라우저 워커가 하는 일과 같다.
 *
 * 번들 안의 본문만으로는 코너 파라미터가 없어 ngspice 가 2,400개를 undefined 로 뱉고
 * 멈춘 채 돌아오지 않는다. tools/extract-sky130.mjs 가 그 자리를 채운 파일을 쓴다.
 */
const SKY_FILES = ["sky130-common", "sky130-nfet", "sky130-pfet", "sky130-pfet-hvt"];
const SKY_MODELS: Record<string, string> | null =
  SKY_FILES.every(f => existsSync("src/vendor/" + f + ".spice"))
    ? Object.fromEntries(SKY_FILES.map(f => ["/" + f + ".spice", readFileSync("src/vendor/" + f + ".spice", "utf8")]))
    : null;
/**
 * 워커가 하는 일과 같다 — **넷리스트가 부르는 파일만** 올린다.
 *
 * 전부 올려 버리면 쪼개 둔 의미를 시험하지 못한다. 예컨대 hvt 를 제 파일에서
 * 빼먹어도 다른 파일에 묻어 들어온 채로 통과해 버린다.
 */
function loadSkyModels(s: Simulation, netlist: string) {
  if (!SKY_MODELS) throw new Error("src/vendor/sky130-*.spice 가 없습니다 (npm run postinstall)");
  const FS = (s as unknown as { __getSpiceModuleForTests(): { FS: { writeFile(p: string, d: string): void } } })
    .__getSpiceModuleForTests().FS;
  for (const line of netlist.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.toLowerCase().startsWith(".include ")) continue;
    const p = t.slice(".include ".length).trim();
    const text = SKY_MODELS[p];
    if (text) FS.writeFile(p, text);
  }
}

const AMP_TOL = 0.01;    // 진폭 +-1%
const PHASE_TOL = 1.0;   // 위상 +-1도

let fail = 0;

for (const demo of DEMOS) {
  console.log(`\n=== ${demo.name} ===`);

  const project = demo.build();
  const sheet = project.sheets[0];
  const ex = extractNets(sheet, project.library);
  const issues = checkCircuit(sheet, project.library, ex);
  const errors = issues.filter(i => i.level === "error");

  console.log(`넷 ${ex.nets.size}개, 자동 접합점 ${ex.junctions.length}개, ` +
              `오류 ${errors.length}개, 경고 ${issues.length - errors.length}개`);
  for (const i of issues) console.log(`  [${i.level}] ${i.message}`);
  if (errors.length) { fail++; console.log("오류가 있어 실행하지 않습니다"); continue; }

  const netlist = buildNetlist(sheet, project.library, ex, project.sim, project.name);
  console.log(netlist.split("\n").map(l => "  " + l).join("\n"));

  // 데모마다 엔진을 새로 띄운다. 같은 Simulation 인스턴스에 연달아 runSim 을 부르면
  // 두 번째 호출이 resolve 되지 않는다 (초기화는 ~80 ms 라 테스트에서는 그냥 새로 만든다)
  const sim = new Simulation();
  await sim.start();
  // SKY130 데모는 브라우저 워커와 같은 모델 파일이 있어야 돈다 (코너 파라미터 포함)
  if (netlist.includes(".include /sky130-")) loadSkyModels(sim, netlist);
  sim.setNetList(netlist);
  const res: any = await sim.runSim();
  const err = sim.getError?.() ?? [];
  if (err.length) { fail++; console.log("ngspice 오류:", err); continue; }

  const traces = toTraces(res.data);
  const pick = (name: string) => {
    const t = traces.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!t) throw new Error(`${name} 없음. 있는 것: ${traces.map(x => x.name).join(", ")}`);
    return t.values;
  };
  const line = (name: string, ok: boolean, got: string, exp: string, err: string, tol: string) => {
    if (!ok) fail++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(10)} ${got.padStart(10)}   기대 ${exp}  오차 ${err}  허용 ${tol}`);
  };

  // 사인이 아닌 데모(정류기 등)는 스스로 잰다. 기대값은 회로 정의 옆에 있다
  if (demo.measure) {
    console.log(`  ${res.numPoints} 점`);
    for (const m of demo.measure(name => {
      const t = traces.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (!t) throw new Error(`${name} 없음. 있는 것: ${traces.map(x => x.name).join(", ")}`);
      return t;
    })) {
      const err = Math.abs(m.got - m.want);
      line(m.name, err <= m.tol, m.got.toFixed(6) + m.unit, m.want.toFixed(6) + m.unit,
           err.toExponential(2), m.tol.toExponential(0));
    }
    continue;
  }
  if (!demo.expect || !demo.window) continue;

  const time = pick("time");
  const fi = fitSine(time, pick("V(in)"), 1000, demo.window);
  const fo = fitSine(time, pick("V(out)"), 1000, demo.window);
  // 위상차는 원 위의 거리로 잰다. 180도는 +180 과 -180 이 같은 값이다
  const phaseErr = Math.abs(phaseDiffDeg(phaseDiffDeg(fo.phaseDeg, fi.phaseDeg), demo.expect.phaseDeg));
  const ampErr = Math.abs(fo.amplitude - demo.expect.amplitude);

  console.log(`  ${res.numPoints} 점, 측정 구간 ${demo.window.from * 1e3}~${demo.window.to * 1e3} ms, ` +
              `잔차 RMS ${fo.rmsResidual.toExponential(2)} V`);
  line("Output amplitude", ampErr <= AMP_TOL * demo.expect.amplitude,
       fo.amplitude.toFixed(4) + " V", demo.expect.amplitude.toFixed(4), ampErr.toExponential(2), `${AMP_TOL * 100}%`);
  line("Phase shift", phaseErr <= PHASE_TOL,
       phaseDiffDeg(fo.phaseDeg, fi.phaseDeg).toFixed(4) + "°", demo.expect.phaseDeg.toFixed(2), phaseErr.toExponential(2), `${PHASE_TOL}°`);
}

/*
 * 같은 RC 회로로 해석 종류를 바꿔 돈다 (설계서 'DC·AC 확장').
 * 과도는 위에서 쟀으니 여기서는 손계산과 정확히 맞아야 하는 세 가지를 본다.
 *   .op  SIN 원의 DC 성분이 0 이라 두 노드 다 0 V
 *   .dc  DC 에서 축전기는 열린 회로 -> v(out) 이 쓸어 올린 값과 같다
 *   .ac  코너 주파수에서 크기 1/sqrt(2), 위상 -45도
 * 넷리스트는 여기서도 회로도에서 만들어 낸다 — 손으로 적으면 검증이 아니다.
 */
console.log("\n=== 해석 종류 (RC 저역통과) ===");
{
  const rc = DEMOS[0].build();
  const sh = rc.sheets[0];
  const ex2 = extractNets(sh, rc.library);
  const f0 = 1 / (2 * Math.PI * 1e3 * 100e-9);   // 1591.549 Hz

  const run = async (sim: SimSettings) => {
    const nl = buildNetlist(sh, rc.library, ex2, sim, "RC");
    console.log("  " + nl.split("\n").filter(l => l.startsWith(".")).join("   "));
    // 해석마다 엔진을 새로 띄운다 (한 인스턴스에 연달아 runSim 을 부르면 안 돌아온다)
    const s2 = new Simulation();
    await s2.start();
    s2.setNetList(nl);
    const res: any = await s2.runSim();
    // Note: 는 안내다 (src/sim-log.ts). 그 밖의 줄이 있으면 실패로 본다
    const bad = (s2.getError?.() ?? []).filter((l: string) => !/^\s*(note|warning|info):/i.test(l));
    if (bad.length) { fail++; console.log("  FAIL  ngspice 오류: " + JSON.stringify(bad)); return null; }
    // 워커와 같은 변환기를 거친 결과로 본다 — 엔진 출력 모양이 바뀌면 여기서 걸린다
    return toTraces(res.data);
  };
  type Traces = ReturnType<typeof toTraces>;
  const get = (ts: Traces, name: string) => {
    const t = ts.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!t) throw new Error(`${name} 없음. 있는 것: ${ts.map(x => x.name).join(", ")}`);
    return t;
  };
  const check = (name: string, got: number, exp: number, tol: number, unit: string) => {
    const e = Math.abs(got - exp);
    if (e > tol) fail++;
    console.log(`  ${e <= tol ? "PASS" : "FAIL"}  ${name.padEnd(15)} ${(got.toFixed(6) + unit).padStart(13)}` +
                `   기대 ${exp.toFixed(6)}${unit}  오차 ${e.toExponential(2)}  허용 ${tol.toExponential(0)}`);
  };
  const pass = (cond: boolean, msg: string) => {
    if (!cond) fail++;
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  };

  // .op — 점 하나. 파형 패널이 그래프 대신 표로 보여 주는 경우다
  const op = await run({ kind: "op" });
  if (op) {
    pass(get(op, "v(out)").values.length === 1, "동작점은 점 하나다");
    pass(!op.some(t => /^(time|frequency)$/i.test(t.name) || /sweep/i.test(t.name)),
         ".op 에는 가로축 벡터가 없다 (표로 보여 주는 근거)");
    check("v(out) 동작점", get(op, "v(out)").values[0], 0, 1e-12, " V");
  }

  // .dc — DC 에서 축전기는 열린 회로. v(out) 이 쓸어 올린 값과 정확히 같다
  const dc = await run({ kind: "dc", source: "V1", start: "0", stop: "5", step: "1" });
  if (dc) {
    const sweep = dc.find(t => /sweep/i.test(t.name));
    if (!sweep) { fail++; console.log("  FAIL  스윕 축 벡터가 없다: " + dc.map(t => t.name).join(", ")); }
    else {
      pass(true, `스윕 축 이름 ${sweep.name} — 앱이 /sweep/ 으로 찾는다`);
      pass(sweep.values.length === 6, `0~5 를 1 씩 쓸어 6점 (${sweep.values.length}점)`);
      const out = get(dc, "v(out)").values;
      let worst = 0;
      for (let i = 0; i < sweep.values.length; i++) worst = Math.max(worst, Math.abs(out[i] - sweep.values[i]));
      check("v(out)-스윕값", worst, 0, 1e-9, " V");
      check("스윕 끝점", sweep.values[sweep.values.length - 1], 5, 1e-9, " V");
    }
  }

  // .ac — 코너 주파수 한 점. 1/sqrt(2) 에 -45도
  const ac = await run({ kind: "ac", sweep: "lin", points: "1", fstart: f0.toFixed(6), fstop: f0.toFixed(6) });
  if (ac) {
    const out = get(ac, "v(out)");
    check("|v(out)| @f0", out.values[0], Math.SQRT1_2, 1e-5, " V");
    check("위상 @f0", out.phaseDeg ? out.phaseDeg[0] : NaN, -45, 1e-3, "deg");
    check("Frequency", get(ac, "frequency").values[0], f0, 1e-3, " Hz");
    pass(!!get(ac, "v(in)").phaseDeg, "AC 결과는 모든 줄기가 위상을 갖는다");
    check("위상 v(in)", get(ac, "v(in)").phaseDeg![0], 0, 1e-12, "deg");
    check("|v(in)| @f0", get(ac, "v(in)").values[0], 1, 1e-9, " V");
  }
}

/*
 * 자동 측정 (.meas).
 *
 * 측정값은 결과 벡터가 아니라 getInfo() 의 **글자**로 온다. 글자를 파싱해 쓰는 것이라
 * 엔진 판이 올라가며 모양이 한 칸만 바뀌어도 조용히 깨진다 — 그때 깨지는 자리가
 * 여기여야 한다. 파서의 단위 검사(tools/verify-dotmeas.ts)는 박아 둔 본문을 쓰므로
 * 엔진이 모양을 바꿔도 통과한다. 그래서 실제 엔진에 물어보는 검사를 따로 둔다.
 *
 * 기대값은 엔진이 준 값을 적는 게 아니라 **손으로 계산한다**. 안 그러면 '엔진이 말한
 * 것과 엔진이 말한 것' 을 비교하는 셈이다. RC 저역통과의 정상 응답은 닫힌 식이 있다.
 */
console.log("\n=== 자동 측정 (.meas) ===");
{
  const rc = DEMOS[0].build();
  const sh = rc.sheets[0];
  const ex4 = extractNets(sh, rc.library);

  const w = 2 * Math.PI * 1000;              // SIN(0 1 1k) — 데모의 신호원
  const wRC = w * 1e3 * 100e-9;              // 0.628319
  const A = 1 / Math.sqrt(1 + wRC * wRC);    // 0.846733 V
  const PH = -Math.atan(wRC);                // -32.1419도
  // 5 ms 는 정확히 5주기. sin(wt)=0 인 순간이라 출력은 위상만큼 밀린 값이다
  const V_AT_5MS = A * Math.sin(PH);                         // -0.450477 V
  // 0.8 V 를 지나며 올라가는 네 번째 지점. 3주기 지났으면 10*tau 를 훨씬 넘겼다
  const T_RISE4 = (Math.asin(0.8 / A) - PH) / w + 3e-3;      // 3.286159 ms
  // 그 사이 0.1 V -> 0.8 V 에 걸린 시간 (같은 주기 안이라 주기 항이 지워진다)
  const TR = (Math.asin(0.8 / A) - Math.asin(0.1 / A)) / w;  // 177.929 us

  const meas = [
    "tran vfinal FIND v(out) AT=5m",
    "tran t4 WHEN v(out)=0.8 RISE=4",
    "tran tr TRIG v(out) VAL=0.1 RISE=4 TARG v(out) VAL=0.8 RISE=4",
    "tran nope FIND v(out) AT=9",   // 구간 밖 — 일부러 실패시킨다
  ];
  // 해석 설정은 데모 그대로 쓴다 (.tran 10u 5m 0 10u) — 손계산이 그 구간을 가정한다
  const nl = buildNetlist(sh, rc.library, ex4, rc.sim, "meas", meas);
  console.log("  " + nl.split("\n").filter(l => l.startsWith(".meas")).join("\n  "));

  const s3 = new Simulation();
  await s3.start();
  const before = s3.getInfo?.() ?? "";
  s3.setNetList(nl);
  const res3: any = await s3.runSim();

  // 워커와 같은 길로 간다: 로그 판정 -> 글자에서 값 읽기
  const hasData = Array.isArray(res3?.data) && res3.data.some((d: any) => d?.values?.length > 0);
  const errLines = s3.getError?.() ?? [];
  const d3 = diagnose(errLines, hasData);
  const after = s3.getInfo?.() ?? "";
  const ms = parseMeasures(after.startsWith(before) ? after.slice(before.length) : after, measureNames(nl));
  const by = (n: string) => ms.find(m => m.name === n)!;

  const chk = (name: string, got: number | null, exp: number, tol: number, unit: string) => {
    const e = got === null ? NaN : Math.abs(got - exp);
    const good = e <= tol;
    if (!good) fail++;
    console.log(`  ${good ? "PASS" : "FAIL"}  ${name.padEnd(12)} ${String(got).padStart(13)}${unit}` +
                `   손계산 ${exp.toExponential(6)}${unit}  오차 ${e.toExponential(2)}  허용 ${tol.toExponential(0)}`);
  };
  const pass3 = (cond: boolean, msg: string, detail = "") => {
    if (!cond) fail++;
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
  };

  /*
   * 측정 하나가 실패했다고 실행 전체를 버리면 안 된다. ngspice 는 그 실패를
   * getError() 에 'Error:' 로 적으므로, 거르지 않으면 파형까지 같이 사라진다.
   */
  pass3(hasData, "결과 벡터는 그대로 나왔다", `${res3.numPoints} 점`);
  pass3(!d3.fatal, "측정 하나가 실패해도 실행은 성공으로 본다", JSON.stringify(d3.message).slice(0, 50));
  pass3(errLines.some((l: string) => /nope/.test(String(l))), "엔진이 실패를 알리기는 한다");

  pass3(ms.length === 4, "넷리스트에 적은 네 개를 다 읽어 온다", ms.map(m => m.name).join(", "));
  chk("vfinal", by("vfinal").value, V_AT_5MS, 2e-4, " V");
  chk("t4", by("t4").value, T_RISE4, 2e-6, " s");
  chk("tr", by("tr").value, TR, 2e-6, " s");

  // 설명 자리: 엔진이 붙여 주는 targ=/trig= 를 그대로 들고 와야 쓸모가 있다
  pass3(/targ=/.test(by("tr").detail) && /trig=/.test(by("tr").detail),
        "TRIG/TARG 측정은 두 시점을 설명으로 달고 온다", `"${by("tr").detail}"`);

  // 실패한 측정: 값은 없고 이유는 있다
  pass3(by("nope").value === null, "구간 밖 측정은 값이 없다", String(by("nope").value));
  pass3(by("nope").detail.includes("out of interval"), "실패한 이유를 들고 온다",
        `"${by("nope").detail}"`);
  pass3(formatMeasure(by("nope")) === "failed", "표에는 'failed' 로 적힌다");
}

/*
 * 반도체 모델이 엔진까지 제대로 닿는지 본다 (설계서 '부품 라이브러리' 반도체 표).
 *
 * .model 줄이 빠지거나 노드 순서가 틀리면 ngspice 가 바로 죽으니 그건 쉽게 걸린다.
 * 어려운 쪽은 계수가 엉뚱한 자리에 들어가 '돌긴 도는데 다른 소자'가 되는 경우다.
 * 그래서 교과서 식과 숫자를 맞춘다.
 *
 * 바이어스 회로는 배선 없이 넷 라벨로만 잇는다 — 시험용 회로라 짧은 쪽이 낫다.
 */
console.log("\n=== 반도체 모델 ===");
{
  const bias = (device: string, gate: string, drain: string) => {
    const b = builder("bias");
    b.part("vdc", [-60, 0], { dc: gate });     // V1 — 게이트/베이스
    b.label("g", [-60, -20]);
    b.part("gnd", [-60, 20]);
    b.part(device, [0, 0]);
    b.label("g", [-20, 0]);
    b.label("d", [0, -20]);
    b.part("gnd", [0, 20]);
    b.part("vdc", [60, 0], { dc: drain });     // V2 — 드레인/컬렉터
    b.label("d", [60, -20]);
    b.part("gnd", [60, 20]);
    b.project.sim = { kind: "op" };
    return b.project;
  };

  const runOp = async (project: ReturnType<typeof bias>, title: string) => {
    const sh = project.sheets[0];
    const ex3 = extractNets(sh, project.library);
    const issues = checkCircuit(sh, project.library, ex3).filter(i => i.level === "error");
    if (issues.length) { fail++; console.log("  FAIL  " + issues.map(i => i.message).join(", ")); return null; }
    const nl = buildNetlist(sh, project.library, ex3, project.sim, title);
    for (const l of nl.split("\n")) if (/^[DQM]|^\.model/.test(l)) console.log("  " + l);
    const s3 = new Simulation();
    await s3.start();
    s3.setNetList(nl);
    const res: any = await s3.runSim();
    const bad = (s3.getError?.() ?? []).filter((l: string) => !/^\s*(note|warning|info):/i.test(l));
    if (bad.length) { fail++; console.log("  FAIL  ngspice 오류: " + JSON.stringify(bad)); return null; }
    const ts = toTraces(res.data);
    return (name: string) => {
      const t = ts.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (!t) throw new Error(`${name} 없음. 있는 것: ${ts.map(x => x.name).join(", ")}`);
      return t.values[0];
    };
  };

  const rel = (name: string, got: number, want: number, tol: number, why: string) => {
    const e = Math.abs(got - want) / Math.abs(want);
    if (e > tol) fail++;
    console.log(`  ${e <= tol ? "PASS" : "FAIL"}  ${name.padEnd(14)} ${got.toPrecision(7).padStart(13)}` +
                `   기대 ${want.toPrecision(7)}  상대오차 ${e.toExponential(2)}  허용 ${tol.toExponential(0)} (${why})`);
  };

  // kT/q at 27°C. 지수 안에 들어가므로 상수가 조금만 달라도 전류는 25배로 벌어진다
  const VT = (1.380649e-23 * 300.15) / 1.602176634e-19;

  // ── NPN: 전류 이득이 모델의 BF 그대로여야 한다
  const npn = await runOp(bias("npn", "0.65", "5"), "NPN");
  if (npn) {
    const ib = Math.abs(npn("i(v1)")), ic = Math.abs(npn("i(v2)"));
    // ngspice 기본 reltol 이 1e-3 이라 전류비를 그보다 더 조일 수는 없다
    rel("βF = IC/IB", ic / ib, 100, 1e-3, "reltol");
    rel("IC = IS e^(VBE/VT)", ic, 1e-16 * Math.exp(0.65 / VT), 1e-4, "지수 민감도");
  }

  // ── NMOS: 포화 영역 전류가 레벨 1 식 그대로여야 한다
  const nmos = await runOp(bias("nmos", "4", "5"), "NMOS");
  if (nmos) {
    // ID = KP/2 * W/L * (VGS-VTO)^2 * (1 + LAMBDA*VDS)
    const want = (20e-6 / 2) * (100e-6 / 10e-6) * (4 - 2) ** 2 * (1 + 0.02 * 5);
    rel("ID (포화)", Math.abs(nmos("i(v2)")), want, 1e-6, "레벨 1 식");
    const ig = Math.abs(nmos("i(v1)"));
    if (ig !== 0) { fail++; console.log(`  FAIL  게이트 전류가 0 이 아니다 (${ig})`); }
    else console.log("  PASS  게이트로는 전류가 흐르지 않는다");
  }
}

/*
 * SKY130 공정 소자가 엔진까지 닿는지 본다.
 *
 * 여기는 **숫자를 교과서 식과 맞출 수 없다** — BSIM4 는 수백 개 계수로 도는 모델이라
 * 손으로 풀 수 있는 닫힌 식이 없다. 대신 물리로 참이어야 하는 것들을 조인다:
 * 켜면 µA 단위로 흐르고, 끄면 그보다 몇 자릿수 아래이고, 게이트로는 안 흐르고,
 * pFET 은 반대 극성이다. 모델이 안 붙거나 bin 을 못 찾으면 그 전에 죽는다.
 *
 * 노드에서는 엔진 번들에 모델 본문이 그대로 들어 있지만, 그 본문만으로는 코너
 * 파라미터가 없어 ngspice 가 멈춘다. 브라우저 워커와 **같은 파일**을 FS 에 써서
 * 같은 조건으로 돌린다 (tools/extract-sky130.mjs 가 만든 것).
 */
console.log("\n=== SKY130 공정 소자 ===");
{
  if (!SKY_MODELS) {
    fail++;
    console.log("  FAIL  src/vendor/sky130-*.spice 가 없습니다 (npm run postinstall)");
  } else {
    const runSky = async (label: string, vg: string, vd: string, sub: string) => {
      const b = builder(label);
      b.part("vdc", [-60, 0], { dc: vg });
      b.label("g", [-60, -20]); b.part("gnd", [-60, 20]);
      b.part(sub, [0, 0]);
      b.label("g", [-20, 0]); b.label("d", [0, -20]); b.part("gnd", [0, 20]);
      b.part("vdc", [60, 0], { dc: vd });
      b.label("d", [60, -20]); b.part("gnd", [60, 20]);
      b.project.sim = { kind: "op" };

      const sh = b.sheet;
      const exK = extractNets(sh, b.project.library);
      const errs = checkCircuit(sh, b.project.library, exK).filter(i => i.level === "error");
      if (errs.length) { fail++; console.log("  FAIL  " + errs.map(i => i.message).join(", ")); return null; }
      const nl = buildNetlist(sh, b.project.library, exK, b.project.sim, label);
      const s = new Simulation();
      await s.start();
      loadSkyModels(s, nl);
      s.setNetList(nl);
      const res: any = await s.runSim();
      const bad = (s.getError?.() ?? []).filter((l: string) => !/^\s*(note|warning|info):/i.test(l));
      if (bad.length) { fail++; console.log("  FAIL  ngspice 오류: " + JSON.stringify(bad).slice(0, 160)); return null; }
      const ts = toTraces(res.data);
      const at = (n: string) => ts.find(x => x.name.toLowerCase() === n)?.values[0] ?? NaN;
      return { id: Math.abs(at("i(v2)")), ig: Math.abs(at("i(v1)")), raw: at("i(v2)") };
    };

    const on = await runSky("nfet on", "1.8", "1.8", "sky130_nfet");
    const off = await runSky("nfet off", "0", "1.8", "sky130_nfet");
    const pon = await runSky("pfet on", "-1.8", "-1.8", "sky130_pfet");

    const check = (cond: boolean, msg: string, detail = "") => {
      if (!cond) fail++;
      console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
    };
    if (on) {
      // W/L = 1.26u/0.15u 짜리 1.8 V 소자. 공정 자료의 구동 전류는 µm 당 수백 µA 다
      const perUm = on.id / 1.26e-6 * 1e-6;
      check(on.id > 1e-4 && on.id < 2e-3, "켜면 수백 µA 가 흐른다", `${(on.id * 1e6).toFixed(1)} µA`);
      check(perUm > 200e-6 && perUm < 900e-6, "µm 당 구동 전류가 공정 수준이다",
            `${(perUm * 1e6).toFixed(0)} µA/µm`);
      check(on.ig === 0, "게이트로는 전류가 흐르지 않는다", `${on.ig}`);
    }
    if (on && off) {
      check(off.id < on.id / 1e5, "끄면 몇 자릿수 아래로 떨어진다",
            `${(on.id / off.id).toExponential(1)} 배`);
    }
    /*
     * hvt 는 모델 파일이 따로다 (1.23 MB). 쓰지 않는 회로는 안 부르도록 쪼개 두었는데,
     * 그 때문에 **쓸 때 안 불러오는 실수**가 생겨도 아무도 모른다. 여기서 확인한다.
     */
    const hvt = await runSky("pfet hvt on", "-1.8", "-1.8", "sky130_pfet_hvt");
    if (hvt) {
      check(hvt.id > 1e-5, "hvt 는 제 파일을 불러와서 돈다", `${(hvt.id * 1e6).toFixed(1)} µA`);
      if (pon) check(hvt.id < pon.id, "hvt 가 보통 pFET 보다 약하다 (문턱이 높다)",
                     `${(pon.id / hvt.id).toFixed(2)} 배`);
    }
    if (on && pon) {
      check(pon.raw * on.raw < 0, "pFET 은 반대 극성이다",
            `n ${on.raw.toExponential(2)} / p ${pon.raw.toExponential(2)}`);
      check(pon.id > on.id / 5 && pon.id < on.id, "pFET 이 nFET 보다 약하다 (이동도 차이)",
            `${(on.id / pon.id).toFixed(2)} 배`);
    }
  }
}

/*
 * 실행할 때만 붙이는 .save (src/net/netlist.ts savePlan) 가 그려지는 값을 바꾸지 않는가.
 *
 * 저장할 벡터만 정하는 줄이라 계산은 같아야 한다 — 같은 넷리스트를 .save 없이·있이 돌려
 * 파형 패널이 그리는 최상위 노드 전압을 **비트 단위로** 견준다. 저장하는 벡터 수가 실제로
 * 줄어드는지도 본다 (SKY130 은 서브회로 내부 노드가 빠진다).
 */
console.log("\n=== 실행할 때 붙이는 .save ===");
{
  const check = (cond: boolean, msg: string, detail = "") => {
    if (!cond) fail++;
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
  };
  const shown = (name: string) => /^v\(/i.test(name) && !/[.#]/.test(name.slice(2, -1));
  for (const demo of DEMOS) {
    const project = demo.build();
    const sheet = project.sheets[0];
    const ex = extractNets(sheet, project.library);
    const netlist = buildNetlist(sheet, project.library, ex, project.sim, project.name, project.meas);
    const plan = savePlan(ex.netNames(), [], project.meas ?? [], sheet.spice, project.sim.kind);
    const run = async (text: string) => {
      const sim = new Simulation();
      await sim.start();
      if (text.includes(".include /sky130-")) loadSkyModels(sim, text);
      sim.setNetList(text);
      const res: any = await sim.runSim();
      return toTraces(res.data);
    };
    const full = await run(netlist);
    const less = await run(beforeEnd(netlist, plan.lines));
    const a = full.filter(t => shown(t.name)), b = less.filter(t => shown(t.name));
    const same = a.length === b.length && a.every(t => {
      const u = b.find(x => x.name === t.name);
      return !!u && u.values.length === t.values.length && u.values.every((v, i) => Object.is(v, t.values[i]));
    });
    check(same, `${demo.name}: 그리는 노드 전압이 비트 단위로 같다`, `벡터 ${full.length} -> ${less.length}`);
  }
}

console.log(fail === 0
  ? `\n회로도 -> 넷리스트 -> 시뮬레이션: 데모 ${DEMOS.length}개 + 해석 4종 + 자동 측정 + 반도체 모델 + SKY130 모두 통과`
  : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
