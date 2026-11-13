// 외부 .sp → 회로도 변환 검증 (설계서 E34).
//
// 완료 기준이 "외부 .sp 3개를 회로도로 불러와 다시 내보내면 원본과 같은 결과" 라서,
// 구조만 보지 않고 **원문과 변환본을 둘 다 ngspice 로 돌려 숫자를 맞춘다.**
// 노드 이름이 바뀌거나 보존한 줄이 빠지면 여기서 바로 걸린다.
import { Simulation } from "eecircuit-engine";
import { spToProject } from "../src/io/import-sp.ts";
import { extractNets } from "../src/net/extract.ts";
import { buildNetlist, checkCircuit } from "../src/net/netlist.ts";
import { toTraces } from "../src/sim-values.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

/** 넷리스트 하나를 돌려 v(out) 의 꼭대기와 바닥을 돌려준다 */
async function run(netlist: string): Promise<{ hi: number; lo: number; n: number } | null> {
  const sim = new Simulation();
  await sim.start();
  sim.setNetList(netlist);
  const res: any = await sim.runSim();
  const bad = (sim.getError?.() ?? []).filter((l: string) => !/^\s*(note|warning|info):/i.test(l));
  if (bad.length) { console.log("    ngspice: " + JSON.stringify(bad)); return null; }
  const t = toTraces(res.data).find(x => x.name.toLowerCase() === "v(out)");
  if (!t) { console.log("    v(out) 없음: " + res.data.map((d: any) => d.name).join(", ")); return null; }
  let hi = -Infinity, lo = Infinity;
  for (let i = 0; i < t.values.length; i++) { hi = Math.max(hi, t.values[i]); lo = Math.min(lo, t.values[i]); }
  return { hi, lo, n: t.values.length };
}

const TOL = 1e-3;   // 0.1%

async function roundTrip(name: string, sp: string, expect: { placed: number; kept: number }) {
  console.log(`\n=== ${name}`);
  const r = spToProject(sp);
  const sheet = r.project.sheets[0];
  const ex = extractNets(sheet, r.project.library);
  const made = buildNetlist(sheet, r.project.library, ex, r.project.sim, r.project.name);

  ok(r.placed === expect.placed, `부품 ${expect.placed}개를 옮긴다`, `${r.placed}개`);
  ok(r.kept.length === expect.kept, `못 옮긴 ${expect.kept}줄을 보존한다`, JSON.stringify(r.kept));

  const errors = checkCircuit(sheet, r.project.library, ex).filter(i => i.level === "error");
  ok(errors.length === 0, "실행 전 검사에 오류가 없다", errors.map(i => i.message).join(" / "));

  // 보존한 줄은 글자 하나까지 그대로 나가야 한다
  for (const line of r.kept) {
    if (!made.includes(line)) { fail++; console.log(`  FAIL  보존한 줄이 빠졌다: ${line}`); }
  }
  if (r.kept.length) ok(true, "보존한 줄이 넷리스트에 그대로 있다");

  // 핀마다 꼬리와 라벨이 붙었는지 — 배선은 핀 수만큼이다
  const pins = sheet.parts.reduce((n, p) => n + (r.project.library[p.lib]?.spice ? r.project.library[p.lib].symbol.pins.length : 0), 0);
  ok(sheet.wires.length === pins, `핀마다 꼬리 하나 (${pins}개)`, `배선 ${sheet.wires.length}개`);

  // 원문은 이미 제목 줄과 .end 를 갖춘 완전한 파일이다. 제목을 덧붙이면
  // 원래 제목 줄이 소자 줄로 읽혀 엉뚱한 오류가 난다
  const a = await run(sp);
  const b = await run(made);
  if (!a || !b) { fail++; console.log("  FAIL  둘 중 하나가 안 돌았다"); return; }

  const rel = (x: number, y: number) => Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y), 1e-12);
  const dHi = rel(a.hi, b.hi), dLo = rel(a.lo, b.lo);
  const line = (what: string, x: number, y: number, d: number) => {
    if (d > TOL) fail++;
    console.log(`  ${d <= TOL ? "PASS" : "FAIL"}  ${what.padEnd(12)} 원본 ${x.toFixed(6)}  변환 ${y.toFixed(6)}  차이 ${(d * 100).toFixed(4)}%`);
  };
  line("v(out) 꼭대기", a.hi, b.hi, dHi);
  line("v(out) 바닥", a.lo, b.lo, dLo);
}

// ── 1. RC 저역통과 — 전부 우리 부품으로 옮겨진다
await roundTrip("RC lowpass", `* RC lowpass from another tool
V1 in 0 SIN(0 1 1k)
R1 in out 1k
C1 out 0 100n
.tran 10u 5m
.end
`, { placed: 3, kept: 0 });

// ── 2. 반파 정류기 — .model 을 원문 그대로 들고 가야 한다 (RS·CJO 가 빠지면 값이 달라진다)
await roundTrip("Rectifier", `Half-wave rectifier
V1 in 0 SIN(0 10 1k 0 0 0)
D1 in out DMOD
R1 out 0 1k
.model DMOD D(IS=1e-14 N=1 RS=0.5 CJO=4p)
.tran 10u 5m
.end
`, { placed: 3, kept: 0 });

// ── 3. 못 옮기는 줄이 섞인 회로 — 지시문 블록으로 보존해 그대로 돌아야 한다
await roundTrip("Mixed sources", `Mixed source test
V1 in 0 PWL(0 0 1m 5 5m 5)
R1 in mid 1k
R2 mid out 1k
I1 out 0 DC 1m
.param unused=3
.tran 10u 5m
.end
`, { placed: 2, kept: 3 });

// ── 되짚기: 변환한 회로도를 저장했다 열어도 같아야 한다
console.log("\n=== 변환한 회로도의 직렬화");
{
  const { serialize } = await import("../src/doc/types.ts");
  const r = spToProject(`t
V1 in 0 DC 5
R1 in out 1k
R2 out 0 1k
.op
.end
`);
  const a = serialize(r.project);
  const b = serialize(JSON.parse(a));
  ok(a === b, "저장했다 다시 열면 바이트 단위로 같다", `(${a.length} bytes)`);
  ok(r.project.sim.kind === "op", ".op 를 해석 설정으로 읽는다", r.project.sim.kind);
}

console.log(fail === 0 ? "\n외부 .sp → 회로도 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
