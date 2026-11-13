// 넷 추출의 연결 규칙을 규칙마다 검증하고, 마지막에 RC 데모를
// 회로도 -> 넷리스트 -> 시뮬레이션까지 한 줄로 통과시킨다.
import { extractNets } from "../src/net/extract.ts";
import { buildNetlist, checkCircuit } from "../src/net/netlist.ts";
import { measureNames } from "../src/sim-measure.ts";
import { BUILTIN, defaultParams } from "../src/lib/parts.ts";
import { emptyProject, pinAt, type Part, type Pt, type Sheet, type Project } from "../src/doc/types.ts";
import { serialize } from "../src/doc/types.ts";
import { removeObjects, withJunctionCleanup } from "../src/doc/history.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

// ── 작은 빌더 ─────────────────────────────────────────────────────────
let n = 0;
function mk(): Project {
  const p = emptyProject("test");
  for (const k of Object.keys(BUILTIN)) p.library[k] = structuredClone(BUILTIN[k]);
  return p;
}
function addPart(sheet: Sheet, lib: string, ref: string, at: Pt): Part {
  const part: Part = {
    id: "p" + ++n, lib, ref, at, rot: 0, mirror: false,
    params: defaultParams(BUILTIN[lib]),
  };
  sheet.parts.push(part);
  return part;
}
const addWire = (sheet: Sheet, ...pts: Pt[]) => sheet.wires.push({ id: "w" + ++n, pts });
const addLabel = (sheet: Sheet, name: string, at: Pt, kind: "label" | "gnd" = "label") =>
  sheet.labels.push({ id: "l" + ++n, name, at, kind });

const eqs = (got: readonly string[], exp: readonly string[], msg: string) =>
  ok(got.join(",") === exp.join(","), msg, `(${got.join(",") || "-"})`);

const netOf = (ex: ReturnType<typeof extractNets>, part: Part, pinId: string) =>
  ex.pinNet.get(part.id + ":" + pinId);

// ── 규칙 1: 배선 끝점 == 핀 끝 ────────────────────────────────────────
console.log("[규칙 1] 배선 끝점이 핀과 같은 좌표면 연결");
{
  const pr = mk(), s = pr.sheets[0];
  const r = addPart(s, "r", "R1", [0, 0]);          // 핀 [-20,0] [20,0]
  addWire(s, [20, 0], [60, 0], [60, 40]);
  const ex = extractNets(s, pr.library);
  const w = ex.nets.get(netOf(ex, r, "2")!)!;
  ok(w.some(p => p[0] === 60 && p[1] === 40), "핀과 배선 끝이 같은 넷");
  ok(netOf(ex, r, "1") !== netOf(ex, r, "2"), "반대쪽 핀은 다른 넷");
}

// ── 규칙 2: 배선 끝점이 다른 배선 중간에 (T자) ─────────────────────────
console.log("\n[규칙 2] 배선 끝점이 다른 배선 중간에 닿으면 연결 + 자동 접합점");
{
  const pr = mk(), s = pr.sheets[0];
  addWire(s, [0, 0], [100, 0]);
  addWire(s, [50, 0], [50, 50]);
  const ex = extractNets(s, pr.library);
  ok(ex.nets.size === 1, "두 배선이 한 넷", `(넷 ${ex.nets.size}개)`);
  ok(ex.junctions.some(p => p[0] === 50 && p[1] === 0), "교차점에 자동 접합점",
     `(${ex.junctions.map(p => `[${p}]`).join(" ")})`);
}

// ── 규칙 3: 핀이 배선 중간에 ──────────────────────────────────────────
console.log("\n[규칙 3] 핀 끝이 배선 중간에 놓여도 연결 + 자동 접합점");
{
  const pr = mk(), s = pr.sheets[0];
  addWire(s, [0, 0], [100, 0]);
  const c = addPart(s, "c", "C1", [50, 20]);        // 핀 [50,0] [50,40]
  const ex = extractNets(s, pr.library);
  const wireNet = ex.nets.get(netOf(ex, c, "1")!)!;
  ok(wireNet.some(p => p[0] === 0 && p[1] === 0), "핀이 배선과 같은 넷");
  ok(ex.junctions.some(p => p[0] === 50 && p[1] === 0), "접합점이 생김");
}

// ── 규칙 5: 십자 교차는 연결이 아니다 ─────────────────────────────────
console.log("\n[규칙 5] 십자로 겹치기만 하면 연결이 아니다");
{
  const pr = mk(), s = pr.sheets[0];
  addWire(s, [0, 0], [100, 0]);
  addWire(s, [50, -50], [50, 50]);
  const ex = extractNets(s, pr.library);
  ok(ex.nets.size === 2, "서로 다른 두 넷으로 남는다", `(넷 ${ex.nets.size}개)`);
  ok(ex.junctions.length === 0, "접합점이 안 생긴다", `(${ex.junctions.length}개)`);

  // 수동 접합점을 놓으면 연결된다
  s.junctions.push([50, 0]);
  const ex2 = extractNets(s, pr.library);
  ok(ex2.nets.size === 1, "수동 접합점을 놓으면 한 넷", `(넷 ${ex2.nets.size}개)`);
  ok(ex2.junctions.some(p => p[0] === 50 && p[1] === 0), "그 자리에 점이 찍힌다");
}

// ── 규칙 6: 핀 끼리 직접 ──────────────────────────────────────────────
console.log("\n[규칙 6] 핀 끝끼리 같은 좌표면 배선 없이도 연결");
{
  const pr = mk(), s = pr.sheets[0];
  const a = addPart(s, "r", "R1", [0, 0]);     // 핀 [-20,0] [20,0]
  const b = addPart(s, "r", "R2", [40, 0]);    // 핀 [20,0] [60,0]
  const ex = extractNets(s, pr.library);
  ok(netOf(ex, a, "2") === netOf(ex, b, "1"), "맞닿은 핀이 같은 넷");
}

// ── 규칙 7: 라벨 이름, 대소문자 무시 ──────────────────────────────────
console.log("\n[규칙 7] 이름이 같은 라벨은 같은 넷, 대소문자 무시");
{
  const pr = mk(), s = pr.sheets[0];
  const a = addPart(s, "r", "R1", [0, 0]);
  const b = addPart(s, "r", "R2", [0, 100]);
  addLabel(s, "out", [20, 0]);        // R1 의 오른쪽 핀
  addLabel(s, "OUT", [-20, 100]);     // R2 의 왼쪽 핀
  const ex = extractNets(s, pr.library);
  ok(netOf(ex, a, "2") === netOf(ex, b, "1"), "out 과 OUT 이 한 넷");
  ok(netOf(ex, a, "2") === "out", "이름은 라벨을 따른다", `(${netOf(ex, a, "2")})`);
}

// ── 규칙 8: GND 는 노드 0, 자동 이름은 라벨과 안 겹친다 ────────────────
console.log("\n[규칙 8] 이름 우선순위");
{
  const pr = mk(), s = pr.sheets[0];
  const r = addPart(s, "r", "R1", [0, 0]);
  addPart(s, "gnd", "GND1", [-20, 0]);     // R1 왼쪽 핀에 접지
  const ex = extractNets(s, pr.library);
  ok(netOf(ex, r, "1") === "0", "GND 가 닿은 넷은 노드 0", `(${netOf(ex, r, "1")})`);
  ok(netOf(ex, r, "2")!.startsWith("N"), "이름 없는 넷은 자동 이름", `(${netOf(ex, r, "2")})`);

  // 사용자가 N001 을 직접 쓰면 자동 이름은 비켜 간다
  const pr2 = mk(), s2 = pr2.sheets[0];
  const a = addPart(s2, "r", "RA", [0, 0]);
  const b = addPart(s2, "r", "RB", [0, 100]);
  addLabel(s2, "N001", [20, 0]);
  const ex2 = extractNets(s2, pr2.library);
  const names = [netOf(ex2, a, "1"), netOf(ex2, a, "2"), netOf(ex2, b, "1"), netOf(ex2, b, "2")];
  ok(new Set(names).size === 4, "이름이 겹치지 않는다", `(${names.join(", ")})`);
}

// ── RC 데모: 회로도 -> 넷리스트 ───────────────────────────────────────
console.log("\n[RC 데모] 회로도에서 넷리스트까지");
const demo = mk();
{
  const s = demo.sheets[0];
  const v1 = addPart(s, "vsin", "V1", [0, 0]);      // p [0,-20]  n [0,20]
  const r1 = addPart(s, "r", "R1", [60, -40]);      // 1 [40,-40] 2 [80,-40]
  const c1 = addPart(s, "c", "C1", [120, 0]);       // 1 [120,-20] 2 [120,20]
  addPart(s, "gnd", "GND1", [0, 60]);

  addWire(s, [0, -20], [0, -40], [40, -40]);        // V1.p -> R1.1
  addWire(s, [80, -40], [120, -40], [120, -20]);    // R1.2 -> C1.1
  addWire(s, [0, 20], [0, 60]);                     // V1.n -> GND
  addWire(s, [120, 20], [120, 60], [0, 60]);        // C1.2 -> GND
  addLabel(s, "in", [0, -40]);
  addLabel(s, "out", [120, -40]);

  const ex = extractNets(s, demo.library);
  ok(netOf(ex, v1, "p") === "in", "V1.+ 가 in", `(${netOf(ex, v1, "p")})`);
  ok(netOf(ex, v1, "n") === "0", "V1.- 가 0", `(${netOf(ex, v1, "n")})`);
  ok(netOf(ex, r1, "1") === "in" && netOf(ex, r1, "2") === "out", "R1 이 in-out");
  ok(netOf(ex, c1, "1") === "out" && netOf(ex, c1, "2") === "0", "C1 이 out-0");

  const issues = checkCircuit(s, demo.library, ex);
  const errs = issues.filter(i => i.level === "error");
  ok(errs.length === 0, "실행 전 검사에 오류 없음",
     errs.length ? `(${errs.map(e => e.message).join("; ")})` : "");

  const nl = buildNetlist(s, demo.library, ex, demo.sim, "RC lowpass");
  // 줄 순서는 설계서 내보내기 규칙 3: 신호원 -> 수동 소자 -> ...
  const expected = [
    "* RC lowpass - generated",
    "V1 in 0 SIN(0 1 1k 0 0 0)",
    "R1 in out 1k",
    "C1 out 0 100n",
    ".tran 10u 5m 0 10u",
    ".end",
  ].join("\n");
  ok(nl === expected, "넷리스트가 기대값과 정확히 같다");
  if (nl !== expected) {
    console.log("    --- 생성 ---\n" + nl.split("\n").map(l => "    " + l).join("\n"));
    console.log("    --- 기대 ---\n" + expected.split("\n").map(l => "    " + l).join("\n"));
  }

  /*
   * 자동 측정. 줄은 해석 줄 **뒤**, .end **앞**에 들어가야 한다 — ngspice 는 .meas 를
   * 읽을 때 어느 해석의 결과를 볼지 알아야 하고, .end 뒤의 글은 아예 읽지 않는다.
   * 앞의 .meas 를 안 적어도 붙여 주고, 빈 줄은 내보내지 않는다.
   */
  const withMeas = buildNetlist(s, demo.library, ex, demo.sim, "RC lowpass",
    ["tran vpeak MAX v(out)", ".meas tran vfinal FIND v(out) AT=5m", "   ", ""]);
  const expMeas = [
    "* RC lowpass - generated",
    "V1 in 0 SIN(0 1 1k 0 0 0)",
    "R1 in out 1k",
    "C1 out 0 100n",
    ".tran 10u 5m 0 10u",
    ".meas tran vpeak MAX v(out)",
    ".meas tran vfinal FIND v(out) AT=5m",
    ".end",
  ].join("\n");
  ok(withMeas === expMeas, ".meas 줄이 해석 줄 뒤 .end 앞에 들어간다");
  if (withMeas !== expMeas) console.log("    " + withMeas.split("\n").join("\n    "));
  // 내보낸 글에서 결과 이름이 다시 뽑혀야 한다. 넷리스트와 결과 읽기가 맞물리는 자리다
  eqs(measureNames(withMeas), ["vpeak", "vfinal"], "내보낸 줄에서 결과 이름이 뽑힌다");
  eqs(measureNames(nl), [], "측정을 안 넣으면 이름도 없다");
}

// ── 프로브: 꽂은 좌표 -> 넷 ───────────────────────────────────────────
console.log("\n[E24] 프로브가 꽂힌 자리의 넷을 찾는다");
{
  const pr = mk(), s = pr.sheets[0];
  const r = addPart(s, "r", "R1", [0, 0]);          // 핀 [-20,0] [20,0]
  addWire(s, [20, 0], [80, 0], [80, 60]);
  addLabel(s, "out", [80, 0]);
  const ex = extractNets(s, pr.library);

  ok(ex.netAt([20, 0]) === "out", "핀 끝에 꽂으면 그 넷", `(${ex.netAt([20, 0])})`);
  ok(ex.netAt([50, 0]) === "out", "배선 선분 중간에 꽂아도 그 넷", `(${ex.netAt([50, 0])})`);
  ok(ex.netAt([80, 60]) === "out", "배선 끝에 꽂아도 그 넷", `(${ex.netAt([80, 60])})`);
  ok(ex.netAt([-20, 0]) === netOf(ex, r, "1"), "반대쪽 핀은 다른 넷");
  ok(ex.netAt([400, 400]) === null, "아무것도 없는 곳은 null", `(${ex.netAt([400, 400])})`);
}

// ── 명세 12-7: 끝나지 않은 곳 표시 ────────────────────────────────────
console.log("\n[12-7] 끊긴 배선 끝과 연결 안 된 핀");
{
  const pr = mk(), s = pr.sheets[0];
  const r = addPart(s, "r", "R1", [0, 0]);        // 핀 [-20,0] [20,0]
  addWire(s, [20, 0], [60, 0]);                   // 오른쪽 핀에만 배선, 끝은 허공
  let ex = extractNets(s, pr.library);

  const has = (arr: typeof ex.danglingPins, p: Pt) => arr.some(q => q[0] === p[0] && q[1] === p[1]);
  ok(has(ex.danglingPins, [-20, 0]), "아무것도 안 붙은 핀을 찾는다", JSON.stringify(ex.danglingPins));
  ok(has(ex.looseEnds, [60, 0]), "어디로도 안 이어진 배선 끝을 찾는다", JSON.stringify(ex.looseEnds));
  ok(!has(ex.danglingPins, [20, 0]), "배선이 붙은 핀은 표시하지 않는다");

  // 연결하면 사라진다
  addPart(s, "r", "R2", [80, 0]);                 // 핀 [60,0] 이 배선 끝과 만난다
  ex = extractNets(s, pr.library);
  ok(!has(ex.looseEnds, [60, 0]), "이으면 표시가 사라진다", JSON.stringify(ex.looseEnds));

  // 핀 둘이 맞닿은 자리는 배선 없이도 연결이다 (규칙 6)
  const pr2 = mk(), s2 = pr2.sheets[0];
  addPart(s2, "r", "RA", [0, 0]);
  addPart(s2, "r", "RB", [40, 0]);                // RA.2 와 RB.1 이 [20,0] 에서 만난다
  const ex2 = extractNets(s2, pr2.library);
  ok(!ex2.danglingPins.some(p => p[0] === 20 && p[1] === 0), "맞닿은 핀은 떠 있는 게 아니다");

  // 넷 라벨이 놓인 끝은 끝난 곳이다 (규칙 7: 이름으로 이어진다). 짧은 배선 끝에 clk 를 다는 그림
  const pr3 = mk(), s3 = pr3.sheets[0];
  addPart(s3, "r", "RC", [0, 0]);                 // 핀 [-20,0] [20,0]
  addWire(s3, [20, 0], [40, 0]);
  s3.labels.push({ id: "lb1", name: "clk", at: [40, 0], kind: "label" });
  s3.labels.push({ id: "lb2", name: "clk", at: [-20, 0], kind: "label" });   // 핀 바로 위
  const ex3 = extractNets(s3, pr3.library);
  ok(!has(ex3.looseEnds, [40, 0]), "라벨을 단 배선 끝은 끝나지 않은 곳이 아니다", JSON.stringify(ex3.looseEnds));
  ok(!has(ex3.danglingPins, [-20, 0]), "라벨을 바로 단 핀도 떠 있는 게 아니다", JSON.stringify(ex3.danglingPins));
  ok(ex3.junctions.length === 0, "라벨은 가지가 아니다 — 접합점을 만들지 않는다", JSON.stringify(ex3.junctions));
}

// ── 명세 12-6: 의미를 잃은 수동 접합점 ───────────────────────────────
console.log("\n[12-6] 교차가 사라진 수동 접합점");
{
  const pr = mk(), s = pr.sheets[0];
  addWire(s, [0, 0], [100, 0]);
  addWire(s, [50, -50], [50, 50]);
  s.junctions.push([50, 0]);
  let ex = extractNets(s, pr.library);
  ok(ex.staleJunctions.length === 0, "교차가 있는 동안은 멀쩡하다", `(${ex.staleJunctions.length}개)`);

  // 한쪽 배선을 지우면 교차가 사라진다
  const cmd = withJunctionCleanup(removeObjects([{ kind: "wire", id: s.wires[1].id }]),
                                  sh => extractNets(sh, pr.library).staleJunctions);
  const before = serialize(pr);
  cmd.apply(s);
  ok(s.junctions.length === 0, "배선을 지우면 접합점도 같이 치워진다", `(${s.junctions.length}개)`);
  cmd.revert(s);
  ok(serialize(pr) === before, "취소하면 배선과 접합점이 같이 돌아온다");
}

// ── E05 미연결 표시 ───────────────────────────────────────────────────
console.log("\n[E05] 미연결 표시");
{
  const pr = mk(), s = pr.sheets[0];
  const r = addPart(s, "r", "R1", [0, 0]);
  addPart(s, "gnd", "GND1", [-20, 0]);          // 왼쪽 핀만 접지
  const warn = (p: typeof r) =>
    checkCircuit(s, pr.library, extractNets(s, pr.library))
      .filter(i => i.level === "warning" && i.message.includes("is floating")).length;

  ok(warn(r) === 1, "표시 전에는 떠 있는 핀 경고", `(${warn(r)}개)`);
  r.nc = ["2"];
  ok(warn(r) === 0, "미연결 표시를 붙이면 경고에서 빠진다", `(${warn(r)}개)`);

  // 내보낼 때 1 TΩ 저항으로 묶어 ngspice 가 떠 있는 노드로 실패하지 않게 한다
  const ex2 = extractNets(s, pr.library);
  const nl = buildNetlist(s, pr.library, ex2, pr.sim, "nc");
  const ncLine = nl.split("\n").find(l => l.startsWith("R_nc"));
  ok(!!ncLine, "1 TΩ 저항 줄이 생긴다", ncLine ?? "(없음)");
  ok(!!ncLine && ncLine.endsWith(" 0 1T"), "접지로 묶는다", ncLine ?? "");
  ok(ncLine!.startsWith("R_nc"), "이름이 밑줄로 시작해 사용자 지정자와 안 겹친다");
}

// ── E07 전원 기호 ─────────────────────────────────────────────────────
console.log("\n[E07] 전원 기호와 이름 우선순위");
{
  const pr = mk(), s = pr.sheets[0];
  const a = addPart(s, "r", "R1", [0, 0]);
  const b = addPart(s, "r", "R2", [0, 100]);
  s.labels.push({ id: "pw1", name: "VCC", at: [20, 0], kind: "power" });
  s.labels.push({ id: "pw2", name: "VCC", at: [-20, 100], kind: "power" });
  let ex2 = extractNets(s, pr.library);
  ok(netOf(ex2, a, "2") === netOf(ex2, b, "1"), "이름이 같은 전원 기호끼리 한 넷");
  ok(netOf(ex2, a, "2") === "VCC", "넷 이름이 전원 이름", `(${netOf(ex2, a, "2")})`);

  // 같은 넷에 넷 라벨이 있으면 그쪽이 이긴다 (규칙 8)
  s.labels.push({ id: "l1", name: "supply", at: [20, 0], kind: "label" });
  ex2 = extractNets(s, pr.library);
  ok(netOf(ex2, a, "2") === "supply", "넷 라벨 > 전원 기호", `(${netOf(ex2, a, "2")})`);
}

// ── 실행 전 검사 ──────────────────────────────────────────────────────
console.log("\n[실행 전 검사]");
{
  const pr = mk(), s = pr.sheets[0];
  const r = addPart(s, "r", "R1", [0, 0]);
  addPart(s, "r", "R1", [0, 100]);              // 중복 지정자
  r.params.value = "";                           // 값 없음
  const ex = extractNets(s, pr.library);
  const msgs = checkCircuit(s, pr.library, ex);
  const has = (t: string) => msgs.some(m => m.message.includes(t));
  ok(has("GND"), "GND 없음 오류");
  ok(has("share the designator"), "지정자 중복 오류");
  ok(has("is empty"), "값 없음 오류");
  ok(has("is floating"), "떠 있는 핀 경고");
}

// ── SKY130 공정 소자 ──────────────────────────────────────────────────
console.log("\n[SKY130] 서브회로 줄과 .include");
{
  const { builder } = await import("../src/lib/demos.ts");
  const { usesSky130, sky130Includes, SKY130_COMMON, SKY130_FILES } = await import("../src/net/netlist.ts");

  const b = builder("sky");
  b.part("vdc", [-60, 0], { dc: "1.8" });
  b.label("g", [-60, -20]);
  b.part("gnd", [-60, 20]);
  b.part("sky130_nfet", [0, 0]);
  b.label("g", [-20, 0]);
  b.label("d", [0, -20]);
  b.part("gnd", [0, 20]);
  const sheet = b.sheet;
  const exS = extractNets(sheet, b.project.library);
  const nl = buildNetlist(sheet, b.project.library, exS, b.project.sim, "sky").split("\n");

  ok(usesSky130(sheet, b.project.library), "SKY130 소자를 쓰는 시트로 알아본다");
  const inc = nl.findIndex(l => l.startsWith(".include"));
  ok(inc >= 0, "모델 파일을 .include 한다", nl[inc] ?? "(없음)");
  ok(nl[inc] === `.include ${SKY130_COMMON}`, "공용 파라미터가 먼저", nl[inc]);
  const incs = nl.filter(l => l.startsWith(".include"));
  ok(incs.length === 2, "쓰는 소자 것만 부른다 (hvt 는 안 부른다)", incs.join(" | "));
  ok(incs[1] === `.include ${SKY130_FILES["sky130_fd_pr__nfet_01v8"]}`, "nFET 파일", incs[1]);
  ok(sky130Includes(sheet, b.project.library).length === 2, "쓰는 파일 수");
  const xi = nl.findIndex(l => l.startsWith("X"));
  ok(xi > inc, "서브회로를 풀어야 하니 소자 줄보다 앞이다", `include ${inc} < X ${xi}`);

  const x = nl[xi];
  ok(/^X\w+ d g 0 0 sky130_fd_pr__nfet_01v8 /.test(x), "X 줄: 노드 넷, 몸통은 소스에 묶인다", x);
  ok(x.includes("W=1.26u") && x.includes("L=0.15u"), "기본 W·L 은 bin 0 한가운데", x);
  ok(x.includes("nf=1") && x.includes("mult=1"), "핑거 수와 병렬 수도 넘긴다", x);

  // 안 쓰면 줄도 안 나간다 — 저항만 있는 회로의 넷리스트는 예전과 글자까지 같아야 한다
  const b2 = builder("plain");
  b2.part("vdc", [-60, 0]); b2.label("a", [-60, -20]); b2.part("gnd", [-60, 20]);
  b2.part("r", [0, 0]); b2.label("a", [-20, 0]); b2.part("gnd", [20, 0]);
  const nl2 = buildNetlist(b2.sheet, b2.project.library, extractNets(b2.sheet, b2.project.library),
                           b2.project.sim, "plain");
  ok(!usesSky130(b2.sheet, b2.project.library), "안 쓰는 시트는 안 쓴다고 한다");
  ok(!nl2.includes(".include"), "SKY130 을 안 쓰면 .include 가 안 나간다", nl2.split("\n")[1]);

  /*
   * bin 밖의 치수는 실행 전에 잡는다. 그냥 두면 ngspice 가 소자 줄에서 죽는데
   * 로그에 모델 이름도 없는 긴 줄 하나만 남아 원인을 알 수가 없다.
   */
  const dim = (w: string, l: string) => {
    const b3 = builder("dim");
    b3.part("sky130_nfet", [0, 0], { w, l });
    b3.label("g", [-20, 0]); b3.label("d", [0, -20]); b3.part("gnd", [0, 20]);
    return checkCircuit(b3.sheet, b3.project.library, extractNets(b3.sheet, b3.project.library))
      .filter(i => i.level === "error" && i.message.includes("no bin"));
  };
  ok(dim("1.26u", "0.15u").length === 0, "기본 치수는 bin 안에 있다");
  const bad = dim("2.52u", "0.15u");
  ok(bad.length === 1, "bin 밖의 W 는 오류", bad[0]?.message?.slice(0, 80) ?? "(없음)");
  ok(/W must be one of: .*1\.26u/.test(bad[0]?.message ?? ""), "쓸 수 있는 W 를 알려 준다",
     bad[0]?.message?.slice(-90) ?? "");
  const badL = dim("1.26u", "0.3u");
  ok(badL.length === 1 && /L must be one of: .*0\.15u/.test(badL[0].message),
     "L 이 어느 bin 에도 없으면 L 목록을 알려 준다", badL[0]?.message?.slice(-70) ?? "");
}

// ── 반도체 모델 줄 ────────────────────────────────────────────────────
console.log("\n[.model] 쓴 모델만, 중복 없이, 소자 줄 다음에");
{
  const { builder } = await import("../src/lib/demos.ts");
  const { modelLine } = await import("../src/net/netlist.ts");
  const { BUILTIN } = await import("../src/lib/parts.ts");

  const b = builder("semi");
  b.part("vsin", [-60, 0]);
  b.part("gnd", [-60, 20]);
  b.part("d", [0, 0]);               // D1 — 기본 모델
  b.part("d", [0, 60]);              // D2 — 같은 모델, 같은 계수
  b.part("npn", [80, 0]);            // Q1
  const sheet = b.sheet;
  const ex2 = extractNets(sheet, b.project.library);
  const nl = buildNetlist(sheet, b.project.library, ex2, b.project.sim, "semi").split("\n");

  const models = nl.filter(l => l.startsWith(".model"));
  ok(models.length === 2, "다이오드 둘이 같은 모델을 써도 줄은 하나", models.join(" | "));
  ok(models[0] === ".model DGEN D(IS=1e-14 N=1)", "다이오드 모델 줄", models[0]);
  ok(models[1] === ".model QNGEN NPN(IS=1e-16 BF=100)", "NPN 모델 줄", models[1]);
  ok(models.join() === [...models].sort().join(), "이름순이라 파일이 늘 같다");

  const iDev = nl.findIndex(l => /^D1 /.test(l));
  const iModel = nl.findIndex(l => l.startsWith(".model"));
  const iAnalysis = nl.findIndex(l => /^\.(tran|op|dc|ac)/.test(l));
  ok(iDev < iModel && iModel < iAnalysis, "소자 줄 → .model → 해석 줄 (규칙 7)",
     `${iDev} < ${iModel} < ${iAnalysis}`);

  // 모델이 없는 부품은 줄을 내지 않는다
  ok(modelLine(sheet.parts[0], BUILTIN.vsin) === null, "전압원은 모델 줄이 없다");

  // 계수를 바꾸면 줄도 바뀐다 — 그리고 이름이 같으면 실행 전 검사가 잡아야 한다
  const d2 = sheet.parts.find(p => p.ref === "D2")!;
  d2.params.is = "2e-14";
  const conflict = checkCircuit(sheet, b.project.library, ex2);
  ok(conflict.some(i => i.level === "error" && i.message.includes("different coefficients per part")),
     "같은 이름에 다른 계수면 오류", conflict.map(i => i.message).join(" | ").slice(0, 60));

  d2.params.model = "DFAST";
  const fixed = checkCircuit(sheet, b.project.library, ex2);
  ok(!fixed.some(i => i.message.includes("different coefficients")), "이름을 나누면 괜찮다");
  const two = buildNetlist(sheet, b.project.library, ex2, b.project.sim, "semi")
    .split("\n").filter(l => l.startsWith(".model"));
  ok(two.length === 3, "모델이 셋이 된다", two.join(" | "));

  // 대소문자만 다른 이름은 SPICE 에서 같은 모델이다
  d2.params.model = "dgen";
  const same = checkCircuit(sheet, b.project.library, ex2);
  ok(same.some(i => i.message.includes("different coefficients per part")), "dgen 과 DGEN 은 같은 이름");
}

// ── 전압원 병렬·단락 (설계서 E26) ────────────────────────────────────
console.log("\n[전압원] 직접 병렬과 단락을 미리 잡는다");
{
  const { builder } = await import("../src/lib/demos.ts");

  // 같은 두 노드에 전압원 둘 — ngspice 는 특이 행렬로 죽고, 메시지는 노드만 가리킨다
  const b = builder("parallel");
  b.part("vdc", [0, 0]); b.label("a", [0, -20]); b.part("gnd", [0, 20]);
  b.part("vdc", [60, 0], { dc: "3" }); b.label("a", [60, -20]); b.part("gnd", [60, 20]);
  b.part("r", [120, 0]); b.label("a", [100, 0]); b.part("gnd", [140, 0]);
  const exP = extractNets(b.sheet, b.project.library);
  const errs = checkCircuit(b.sheet, b.project.library, exP).filter(i => i.level === "error");
  ok(errs.some(e => e.message.includes("directly in parallel")), "병렬 전압원을 오류로 잡는다", errs.map(e => e.message).join(" | "));
  ok(errs.some(e => e.partId), "어느 부품인지 가리킨다");

  // 값이 같아도 병렬이면 못 푼다 — 값으로 봐주지 않는다
  const same = builder("same");
  same.part("vdc", [0, 0]); same.label("a", [0, -20]); same.part("gnd", [0, 20]);
  same.part("vdc", [60, 0]); same.label("a", [60, -20]); same.part("gnd", [60, 20]);
  const exS = extractNets(same.sheet, same.project.library);
  ok(checkCircuit(same.sheet, same.project.library, exS).some(i => i.message.includes("directly in parallel")),
     "값이 같아도 병렬은 오류");

  // 양 끝이 한 넷인 전압원 (스스로 단락)
  const sh = builder("short");
  sh.part("vdc", [0, 0]); sh.label("a", [0, -20]); sh.label("a", [0, 20]);
  sh.part("gnd", [60, 0]); sh.label("a", [60, 0]);
  const exH = extractNets(sh.sheet, sh.project.library);
  ok(checkCircuit(sh.sheet, sh.project.library, exH).some(i => i.message.includes("(short)")),
     "양 끝이 같은 넷이면 오류");

  // 직렬로 쌓은 전압원은 멀쩡하다 — 넷이 다르면 잡으면 안 된다
  const ser = builder("series");
  ser.part("vdc", [0, 0]); ser.label("hi", [0, -20]); ser.label("mid", [0, 20]);
  ser.part("vdc", [60, 0]); ser.label("mid", [60, -20]); ser.part("gnd", [60, 20]);
  ser.part("r", [120, 0]); ser.label("hi", [100, 0]); ser.part("gnd", [140, 0]);
  const exR = extractNets(ser.sheet, ser.project.library);
  ok(!checkCircuit(ser.sheet, ser.project.library, exR).some(i => i.message.includes("in parallel")),
     "직렬로 쌓은 것은 건드리지 않는다");
}

// ── 저장/열기 왕복 ────────────────────────────────────────────────────
console.log("\n[왕복] 직렬화가 결정적인가");
{
  const { serialize } = await import("../src/doc/types.ts");
  const a = serialize(demo);
  const b = serialize(JSON.parse(a));
  ok(a === b, "저장했다 다시 열면 바이트 단위로 같다", `(${a.length} bytes)`);
}

console.log(fail === 0 ? "\n넷 추출 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
