// 해석 종류(과도·동작점·DC 스윕·AC)와 결과 값 변환 검증.
//
// 여기가 틀리면 조용히 틀린다: 해석 줄이 잘못되면 엔진은 다른 해석을 돌려 주고,
// 복소수 변환이 잘못되면 오류 하나 없이 NaN 그래프가 나온다.
import { DEMOS } from "../src/lib/demos.ts";
import { defaultSim, normalizeProject, type SimSettings } from "../src/doc/types.ts";
import { extractNets } from "../src/net/extract.ts";
import { buildNetlist } from "../src/net/netlist.ts";
import { toTraces } from "../src/sim-values.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

// RC 저역통과 데모 하나로 해석만 바꿔 가며 넷리스트를 만든다
const project = DEMOS[0].build();
const sheet = project.sheets[0];
const ex = extractNets(sheet, project.library);
const netlist = (sim: SimSettings) => buildNetlist(sheet, project.library, ex, sim, "RC");
const lineOf = (sim: SimSettings, pre: string) =>
  netlist(sim).split("\n").find(l => l.startsWith(pre)) ?? "(없음)";

// ── 1. 해석 줄 ────────────────────────────────────────────────────────
console.log("[해석 줄] 종류마다 ngspice 문법 그대로 나온다");
{
  // .tran tstep tstop tstart tmax — tstep 과 tmax 를 같이 줘서 간격을 고정한다
  ok(lineOf(defaultSim("tran"), ".tran") === ".tran 10u 5m 0 10u", "과도", lineOf(defaultSim("tran"), ".tran"));
  ok(lineOf(defaultSim("op"), ".op") === ".op", "동작점", lineOf(defaultSim("op"), ".op"));
  ok(lineOf(defaultSim("dc"), ".dc") === ".dc V1 0 5 0.1", "DC sweep", lineOf(defaultSim("dc"), ".dc"));
  ok(lineOf(defaultSim("ac"), ".ac") === ".ac dec 20 10 1meg", "AC", lineOf(defaultSim("ac"), ".ac"));

  const ac2: SimSettings = { kind: "ac", sweep: "lin", points: "1", fstart: "1k", fstop: "1k" };
  ok(lineOf(ac2, ".ac") === ".ac lin 1 1k 1k", "AC 선형 한 점", lineOf(ac2, ".ac"));

  // 잡음 · 전달 함수: 넷 이름만 적으면 v() 로 싸고, v(a,b) · i(V1) 는 그대로 둔다
  const nz: SimSettings = { kind: "noise", out: "out", src: "V1", sweep: "dec", points: "10", fstart: "1", fstop: "1g" };
  ok(lineOf(nz, ".noise") === ".noise v(out) V1 dec 10 1 1g", "잡음", lineOf(nz, ".noise"));
  ok(lineOf({ ...nz, out: "v(out, in)" }, ".noise") === ".noise v(out,in) V1 dec 10 1 1g", "잡음 — 차동 출력", lineOf({ ...nz, out: "v(out, in)" }, ".noise"));
  ok(lineOf({ kind: "tf", out: "out", src: "V1" }, ".tf") === ".tf v(out) V1", "전달 함수", lineOf({ kind: "tf", out: "out", src: "V1" }, ".tf"));
  ok(lineOf({ kind: "tf", out: "i(V1)", src: "V1" }, ".tf") === ".tf i(V1) V1", "전달 함수 — 전류 출력");
  ok(lineOf(nz, "V1") === "V1 in 0 AC 1 SIN(0 1 1k 0 0 0)", "잡음 해석은 입력 전원에 AC 크기가 있어야 한다", lineOf(nz, "V1"));

  for (const k of ["tran", "op", "dc", "ac"] as const) {
    const ls = netlist(defaultSim(k)).split("\n");
    ok(ls.filter(l => l.startsWith(".")).length === 2, `${k}: 해석 줄 하나 + .end`, ls.filter(l => l.startsWith(".")).join(" | "));
    ok(ls[ls.length - 1] === ".end", `${k}: 마지막은 .end`);
  }
}

// ── 2. AC 크기 스펙 ───────────────────────────────────────────────────
console.log("\n[AC 크기] AC 해석일 때만 전압원에 AC 1 이 붙는다");
{
  const vLine = (sim: SimSettings) => lineOf(sim, "V1");
  ok(vLine(defaultSim("ac")) === "V1 in 0 AC 1 SIN(0 1 1k 0 0 0)", "AC 는 AC 1 을 적는다", vLine(defaultSim("ac")));

  /*
   * 과도 넷리스트는 설계서에 적힌 데모 넷리스트와 글자 하나까지 같아야 한다.
   * .sp 왕복과 데스크톱 ngspice 대조가 거기에 걸려 있다.
   */
  ok(vLine(defaultSim("tran")) === "V1 in 0 SIN(0 1 1k 0 0 0)", "과도는 그대로다", vLine(defaultSim("tran")));
  ok(vLine(defaultSim("op")) === "V1 in 0 SIN(0 1 1k 0 0 0)", "동작점도 그대로다", vLine(defaultSim("op")));
  ok(!netlist(defaultSim("dc")).includes(" AC "), "DC 스윕에도 안 붙는다");

  // 전압원의 ac 파라미터를 바꾸면 그 값이 나간다
  const v1 = sheet.parts.find(p => p.ref === "V1")!;
  const saved = v1.params.ac;
  v1.params.ac = "2";
  ok(vLine(defaultSim("ac")).includes("AC 2 "), "ac 파라미터를 따른다", vLine(defaultSim("ac")));
  delete v1.params.ac;
  ok(vLine(defaultSim("ac")).includes("AC 1 "), "값이 없으면 1 로 본다", vLine(defaultSim("ac")));
  v1.params.ac = saved;

  // 치환 자리가 비어도 빈칸이 두 번 겹치지 않는다
  for (const k of ["tran", "op", "dc", "ac"] as const) {
    const bad = netlist(defaultSim(k)).split("\n").filter(l => /\s\s|\s$/.test(l));
    ok(bad.length === 0, `${k}: 겹친 빈칸이 없다`, bad.join(" | "));
  }
}

// ── 3. 결과 값 변환 ───────────────────────────────────────────────────
console.log("\n[값 변환] 과도는 실수, AC 는 크기와 위상으로");
{
  const f = new Float64Array([1, 2, 3]);
  ok(toTraces([{ name: "time", values: f }])[0].values === f, "Float64Array 는 그대로 넘긴다");

  const real = toTraces([{ name: "v(out)", values: [0, -1.5, 2] }])[0];
  ok(real.values instanceof Float64Array && real.values[1] === -1.5, "실수 배열은 부호까지 그대로", String(real.values[1]));
  ok(real.phaseDeg === undefined, "실수 벡터에는 위상이 없다");

  // AC 해석의 실제 값. 코너 주파수에서 0.5 - 0.5j -> 0.7071 ∠-45°
  const ac = toTraces([{ name: "v(out)", values: [{ real: 0.5, img: -0.5 }, { real: 0, img: -1 }] }])[0];
  ok(Math.abs(ac.values[0] - Math.SQRT1_2) < 1e-12, "크기", ac.values[0].toFixed(6));
  ok(Math.abs(ac.phaseDeg![0] + 45) < 1e-12, "Phase", ac.phaseDeg![0].toFixed(4) + "°");
  ok(Math.abs(ac.phaseDeg![1] + 90) < 1e-12, "순허수는 -90°", ac.phaseDeg![1].toFixed(4) + "°");

  /*
   * AC 결과는 한 묶음이 통째로 복소수다. 허수부가 늘 0 인 입력도 위상을 받아야
   * 표에서 v(out) 만 각도가 붙는 이상한 모양이 안 된다.
   */
  const set = toTraces([
    { name: "frequency", values: [{ real: 100, img: 0 }, { real: 1000, img: 0 }] },
    { name: "v(in)", values: [{ real: 1, img: 0 }, { real: 1, img: 0 }] },
    { name: "v(out)", values: [{ real: 0.5, img: -0.5 }, { real: 0, img: -1 }] },
  ]);
  ok(set[0].values[1] === 1000, "주파수 값이 실수부 그대로", String(set[0].values[1]));
  ok(set[1].phaseDeg?.[0] === 0, "허수부가 0 인 입력도 위상 0 을 받는다", String(set[1].phaseDeg?.[0]));
  ok(set.every(t => !!t.phaseDeg), "복소수 묶음은 전부 위상을 받는다");

  // 실수 묶음(과도·DC 스윕)에는 아무도 위상을 받지 않는다
  const realSet = toTraces([{ name: "time", values: [0, 1] }, { name: "v(out)", values: [0, -2] }]);
  ok(realSet.every(t => !t.phaseDeg), "실수 묶음에는 위상이 없다");
  ok(realSet[1].values[1] === -2, "실수 묶음은 부호 그대로", String(realSet[1].values[1]));

  /*
   * 점마다 복소수 여부를 보면 위상이 딱 180° 인 점(허수부 0, 실수부 음수)에서
   * 크기가 음수로 나와 버린다. 그래서 벡터 단위로 판정한다.
   */
  const mixed = toTraces([{ name: "v(out)", values: [{ real: -2, img: 0 }, { real: 0, img: 3 }] }])[0];
  ok(mixed.values[0] === 2, "180° 점의 크기는 양수", String(mixed.values[0]));
  ok(Math.abs(mixed.phaseDeg![0] - 180) < 1e-12, "그 점의 위상은 180°", mixed.phaseDeg![0].toFixed(1) + "°");

  ok(toTraces([{ name: "v(out)", values: [] }])[0].values.length === 0, "빈 벡터도 받는다");
}

// ── 4. 예전 파일 열기 ─────────────────────────────────────────────────
console.log("\n[예전 파일] 해석이 과도뿐이던 때 저장한 것도 열린다");
{
  // kind 가 없던 판의 모양
  const old = { ...project, sim: { tstop: "2m", tmax: "5u", tstart: "0" } } as unknown as typeof project;
  const fixed = normalizeProject(structuredClone(old));
  ok(fixed.sim.kind === "tran", "과도로 본다", fixed.sim.kind);
  ok(fixed.sim.kind === "tran" && fixed.sim.tstop === "2m", "저장돼 있던 값은 지킨다", JSON.stringify(fixed.sim));
  ok(buildNetlist(sheet, project.library, ex, fixed.sim, "RC").includes(".tran 5u 2m 0 5u"),
     "해석 줄이 빠지지 않는다");

  // 칸이 빠진 경우와 모르는 종류
  const half = normalizeProject({ ...project, sim: { kind: "dc", source: "V2" } } as unknown as typeof project);
  ok(JSON.stringify(half.sim) === JSON.stringify({ kind: "dc", source: "V2", start: "0", stop: "5", step: "0.1" }),
     "빠진 칸은 기본값으로", JSON.stringify(half.sim));
  const weird = normalizeProject({ ...project, sim: { kind: "pz" } } as unknown as typeof project);
  ok(weird.sim.kind === "tran", "모르는 종류는 과도로", weird.sim.kind);
  // 잡음 · 전달 함수는 아는 종류다. 빠진 칸만 기본값으로 채운다
  const nz = normalizeProject({ ...project, sim: { kind: "noise", src: "V3" } } as unknown as typeof project);
  ok(nz.sim.kind === "noise" && nz.sim.src === "V3" && nz.sim.out === "out" && nz.sim.fstop === "1g",
     "잡음 해석의 빠진 칸은 기본값으로", JSON.stringify(nz.sim));
  const tf = normalizeProject({ ...project, sim: { kind: "tf", out: "x" } } as unknown as typeof project);
  ok(tf.sim.kind === "tf" && tf.sim.out === "x" && tf.sim.src === "V1", "전달 함수도", JSON.stringify(tf.sim));
  ok(normalizeProject({ ...project, sim: undefined } as unknown as typeof project).sim.kind === "tran", "아예 없어도 연다");
}

console.log(fail === 0 ? "\n해석 종류·값 변환 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
