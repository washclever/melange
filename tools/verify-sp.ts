// .sp 내보내기·불러오기 검증 (설계서 E22 · E23 · E28)
import { exportSp, parseSp, scanSp, runnable } from "../src/io/sp.ts";
import { extractNets } from "../src/net/extract.ts";
import { buildNetlist, spiceName, orderedParts } from "../src/net/netlist.ts";
import { BUILTIN, defaultParams } from "../src/lib/parts.ts";
import { emptyProject, serialize, type Part, type Pt, type Sheet } from "../src/doc/types.ts";
import { parseEng, megaWarning, normalizeValue, asciiTitle } from "../src/doc/units.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

// ── RC 데모를 코드로 만든다 ───────────────────────────────────────────
let n = 0;
function demo() {
  const pr = emptyProject("RC lowpass demo");
  for (const k of Object.keys(BUILTIN)) pr.library[k] = structuredClone(BUILTIN[k]);
  const s: Sheet = pr.sheets[0];
  const add = (lib: string, ref: string, at: Pt): Part => {
    const p: Part = { id: "p" + ++n, lib, ref, at, rot: 0, mirror: false, params: defaultParams(BUILTIN[lib]) };
    s.parts.push(p);
    return p;
  };
  const w = (...pts: Pt[]) => s.wires.push({ id: "w" + ++n, pts });
  add("vsin", "V1", [0, 0]); add("r", "R1", [60, -40]); add("c", "C1", [120, 0]); add("gnd", "GND1", [0, 60]);
  w([0, -20], [0, -40], [40, -40]);
  w([80, -40], [120, -40], [120, -20]);
  w([0, 20], [0, 60]);
  w([120, 20], [120, 60], [0, 60]);
  s.labels.push({ id: "l1", name: "in", at: [0, -40], kind: "label" });
  s.labels.push({ id: "l2", name: "out", at: [120, -40], kind: "label" });
  return pr;
}

const project = demo();
const sheet = project.sheets[0];
const ex = extractNets(sheet, project.library);
const netlist = buildNetlist(sheet, project.library, ex, project.sim, project.name);

// ── 줄 순서와 이름 ────────────────────────────────────────────────────
console.log("[내보내기 규칙 3·4·5] 줄 순서와 SPICE 이름");
{
  const body = netlist.split("\n").slice(1);
  ok(body[0].startsWith("V1 ") && body[1].startsWith("R1 ") && body[2].startsWith("C1 "),
     "신호원 -> 수동 소자 순 (V1, R1, C1)", `(${body.slice(0, 3).map(l => l.split(" ")[0]).join(", ")})`);
  ok(spiceName("U1", "E") === "EU1", "지정자가 소자 문자로 시작 안 하면 앞에 붙인다 (U1 -> EU1)");
  ok(spiceName("R1", "R") === "R1", "이미 맞으면 그대로 (R1)");
  ok(!/[A-Z]/.test(body[0].split(" ").slice(1, 3).join("")), "노드 이름은 소문자", `(${body[0]})`);
  ok(orderedParts(sheet, project.library).length === 3, "GND 는 줄을 내지 않는다");
}

// ── 왕복 ──────────────────────────────────────────────────────────────
console.log("\n[E22·E23] 내보냈다 다시 열면 회로도가 그대로");
const sp = await exportSp(project, netlist);
{
  const lines = sp.split("\n");
  ok(lines[0] === "* RC lowpass demo", "첫 줄이 제목 줄", `(${lines[0]})`);
  ok(/^\*@sch-begin v1 body=[0-9a-f]{64}$/.test(lines[1]), "복원 정보 머리글 + 본문 해시");
  ok(lines.some(l => l === "*@sch-end"), "복원 정보 끝 표시");
  ok(lines.filter(l => l.startsWith("*@ ")).every(l => l.length <= 79), "base64 줄이 76자씩 잘림");
  ok(sp.trimEnd().endsWith(".end"), "마지막은 .end");

  // SPICE 가 읽는 부분에 비 ASCII 가 없어야 한다 (규칙 8: 한글은 제목 줄에만)
  const body = sp.split("\n").slice(sp.split("\n").findIndex(l => l === "*@sch-end") + 1);
  ok(body.every(l => /^[\x20-\x7e]*$/.test(l)), "본문은 ASCII 만");

  const loaded = await parseSp(sp);
  ok(loaded.kind === "restored", "다시 열면 복원된다", `(${loaded.kind})`);
  if (loaded.kind === "restored") {
    ok(serialize(loaded.project) === serialize(project),
       "복원한 프로젝트가 바이트 단위로 같다");
    const ex2 = extractNets(loaded.project.sheets[0], loaded.project.library);
    const nl2 = buildNetlist(loaded.project.sheets[0], loaded.project.library, ex2, loaded.project.sim, loaded.project.name);
    ok(nl2 === netlist, "다시 만든 넷리스트도 같다");
  }
}

// ── 본문이 바뀌면 알아챈다 ────────────────────────────────────────────
console.log("\n[불러오기] 텍스트를 누가 고친 경우");
{
  const tampered = sp.replace("R1 in out 1k", "R1 in out 2k");
  const loaded = await parseSp(tampered);
  ok(loaded.kind === "drifted", "본문이 바뀌면 drifted 로 알린다", `(${loaded.kind})`);
  if (loaded.kind === "drifted") {
    ok(loaded.storedHash !== loaded.actualHash, "해시가 다르다");
    ok(loaded.project.name === "RC lowpass demo", "회로도는 그대로 읽어 둔다");
  }
}

// ── 외부 .sp ──────────────────────────────────────────────────────────
console.log("\n[E28] 복원 정보가 없는 외부 .sp");
{
  const ext = `My external circuit
V1 1 0 SIN(0 1 1k)
R1 1 2 1k
+ ; 이어 붙기 확인
C1 2 0 100n
* 주석
.tran 10u 5m
.end
이 줄은 .end 뒤라 안 읽힌다`;
  const loaded = await parseSp(ext);
  ok(loaded.kind === "external", "외부 파일로 인식", `(${loaded.kind})`);
  // ngspice 는 .end 뒤에서 멈추지 않고 파싱을 계속하다 실패한다. 우리가 잘라서 넘겨야 한다
  ok(loaded.kind === "external" && !loaded.body.includes("안 읽힌다"),
     "엔진에 넘길 본문이 .end 에서 잘린다");
  ok(loaded.kind === "external" && loaded.body.trimEnd().endsWith(".end"),
     "본문이 .end 로 끝난다");

  // SPICE 는 첫 줄을 제목으로 먹는다. 본문만 넘기면 V1 이 사라져 회로가 끊긴다
  if (loaded.kind === "external") {
    const run = runnable(loaded.title, loaded.body);
    ok(run.startsWith("* "), "돌릴 넷리스트는 제목 줄로 시작한다", `(${run.split("\n")[0]})`);
    ok(run.split("\n")[1].startsWith("V1"), "첫 소자가 제목에 먹히지 않는다", `(${run.split("\n")[1]})`);
  }

  const scan = scanSp(ext);
  ok(!scan.lines.some(l => l.startsWith("*")), "주석이 빠진다");
  ok(!scan.lines.some(l => l.includes("안 읽힌다")), ".end 뒤는 안 읽는다");
  ok(scan.lines.some(l => l.startsWith("R1") && l.includes("이어 붙기")), "+ 줄이 앞 줄에 이어 붙는다",
     `(${scan.lines.find(l => l.startsWith("R1"))})`);
  ok(scan.analyses.length === 1 && scan.analyses[0].startsWith(".tran"), "해석 줄을 찾는다");

  // 우리가 돌릴 수 있는 해석을 '못 다루는 줄' 로 알리면 안 된다
  const four = scanSp("* x\nV1 1 0 AC 1\n.op\n.dc V1 0 5 0.1\n.ac dec 10 1 1k\n.noise v(1) V1 dec 10 1 1k\n.tf v(1) V1\n.pz 1 0 1 0 vol pz\n.end\n");
  ok(four.analyses.length === 5, ".op·.dc·.ac·.noise·.tf 는 해석으로 센다", four.analyses.join(" | "));
  ok(four.unsupported.length === 1 && four.unsupported[0].startsWith(".pz"),
     "아직 못 다루는 것만 못 다룬다고 한다", four.unsupported.join(" | "));
}

// ── 제목 줄은 ASCII 여야 한다 ─────────────────────────────────────────
console.log("\n[제목 줄] 비 ASCII 제목은 엔진 결과를 조용히 망가뜨린다");
{
  // 한글 제목이면 ngspice 가 오류 없이 time 벡터를 전류 벡터로 바꿔 놓는다.
  // 실패가 아니라 틀린 답이라 반드시 막아야 한다.
  const pr = demo();
  pr.name = "RC 저역통과 데모";
  const ex2 = extractNets(pr.sheets[0], pr.library);
  const nl = buildNetlist(pr.sheets[0], pr.library, ex2, pr.sim, pr.name);
  const titleLine = nl.split("\n")[0];
  ok(/^[\x20-\x7e]*$/.test(titleLine), "생성된 제목 줄이 ASCII", `(${titleLine})`);
  ok(titleLine.includes("RC"), "ASCII 부분은 남는다", `(${titleLine})`);

  ok(asciiTitle("반전 증폭기") === "circuit", "전부 비 ASCII 면 기본 이름으로", `(${asciiTitle("반전 증폭기")})`);
  ok(asciiTitle("RC 저역통과 filter") === "RC filter", "한글만 걷어낸다", `(${asciiTitle("RC 저역통과 filter")})`);

  const run = runnable("외부 회로", "V1 1 0 DC 5\n.end\n");
  ok(/^[\x20-\x7e]*$/.test(run.split("\n")[0]), "외부 .sp 제목도 ASCII", `(${run.split("\n")[0]})`);

  // 프로젝트 이름 자체는 복원 정보에 그대로 남아야 한다
  const sp2 = await exportSp(pr, nl);
  const back = await parseSp(sp2);
  ok(back.kind === "restored" && back.project.name === "RC 저역통과 데모",
     "한글 이름은 복원 정보에 그대로 남는다");
}

// ── 공학 단위 (E21) ───────────────────────────────────────────────────
console.log("\n[E21] 공학 단위");
{
  const cases: Array<[string, number | null]> = [
    ["1k", 1e3], ["100n", 100e-9], ["10u", 10e-6], ["1meg", 1e6],
    ["1M", 1e-3], ["2.5k", 2500], ["1e3", 1000], ["-5m", -5e-3],
    ["10uF", 10e-6], ["1T", 1e12], ["abc", null],
  ];
  let bad = 0;
  for (const [s, want] of cases) {
    const got = parseEng(s);
    if (got !== want && !(want !== null && got !== null && Math.abs(got - want) < Math.abs(want) * 1e-12)) {
      console.log(`      ${s} -> ${got} (기대 ${want})`);
      bad++;
    }
  }
  ok(bad === 0, `${cases.length}가지 값을 읽는다`);
  ok(parseEng("1M") === 1e-3, "SPICE 에서 M 은 밀리다");
  ok(megaWarning("1M") !== null, "메가로 착각한 1M 을 잡아낸다");
  ok(megaWarning("1meg") === null, "1meg 은 경고하지 않는다");
  ok(normalizeValue("10µF") === "10uF", "µ 를 u 로 바꾼다", `(${normalizeValue("10µF")})`);
}

// ── 반도체가 든 회로도 왕복 ───────────────────────────────────────────
console.log("\n[왕복] .model 이 든 회로도");
{
  const { RECTIFIER } = await import("../src/lib/demos.ts");
  const pr = RECTIFIER.build();
  const sh = pr.sheets[0];
  const ex2 = extractNets(sh, pr.library);
  const nl = buildNetlist(sh, pr.library, ex2, pr.sim, pr.name);
  const text = await exportSp(pr, nl);

  ok(nl.includes(".model DGEN D(IS=1e-14 N=1)"), "본문에 모델 줄이 있다");
  ok(/^\* /.test(text.split("\n")[0]), "제목 줄로 시작한다");

  const back = await parseSp(text);
  ok(back.kind === "restored", "다시 열면 복원된다", back.kind);
  if (back.kind === "restored") {
    ok(serialize(back.project) === serialize(pr), "프로젝트가 바이트 단위로 같다");
    const ex3 = extractNets(back.project.sheets[0], back.project.library);
    const again = buildNetlist(back.project.sheets[0], back.project.library, ex3, back.project.sim, back.project.name);
    ok(again === nl, "다시 만든 넷리스트도 같다 (모델 줄 포함)");
  }

  // 외부 .sp 로 읽어도 모델 줄이 본문에 남아야 돈다
  const ext = await parseSp(nl + "\n");
  ok(ext.kind === "external", "복원 정보가 없으면 외부 파일", ext.kind);
  if (ext.kind === "external") ok(ext.body.includes(".model DGEN"), "외부 본문에도 모델 줄이 남는다");
}

// ── SKY130: 앱 안에서만 통하는 경로는 안 내보낸다 ─────────────────────
console.log("\n[왕복] SKY130 회로도를 내보내면 밖에서도 읽히는 파일이어야 한다");
{
  const { SKY130_INVERTER } = await import("../src/lib/demos.ts");
  const pr = SKY130_INVERTER.build();
  const sh = pr.sheets[0];
  const ex4 = extractNets(sh, pr.library);
  const nl = buildNetlist(sh, pr.library, ex4, pr.sim, pr.name);

  ok(nl.includes(".include /sky130-"), "돌릴 넷리스트에는 모델 파일을 부르는 줄이 있다");

  const text = await exportSp(pr, nl);
  /*
   * /sky130-*.spice 는 워커가 엔진의 가상 파일 시스템에 올려 두는 자리다.
   * 그대로 내보내면 데스크톱 ngspice 에서 '파일 없음' 으로 죽는다.
   */
  ok(!/^\s*\.include\s+\/sky130-/im.test(text), "내보낸 파일에는 그 경로가 없다",
     text.split("\n").filter(l => l.includes("sky130-")).join(" | ").slice(0, 80));
  ok(text.includes("sky130.lib.spice"), "대신 무엇을 끼우면 되는지 적어 둔다");
  ok(text.includes("X1 ") || /\n[Xx]\w+ /.test(text), "소자 줄은 그대로 나간다");

  // 우리가 다시 열면 회로도는 복원 정보에서 되살아난다 — 그 길은 안 깨져야 한다
  const back = await parseSp(text);
  ok(back.kind === "restored", "다시 열면 복원된다", back.kind);
  if (back.kind === "restored") {
    ok(back.storedHash === back.actualHash, "본문 해시가 맞는다 (내보낼 때 고친 본문 기준)");
    ok(serialize(back.project) === serialize(pr), "프로젝트가 바이트 단위로 같다");
    const ex5 = extractNets(back.project.sheets[0], back.project.library);
    const again = buildNetlist(back.project.sheets[0], back.project.library, ex5, back.project.sim, back.project.name);
    ok(again === nl, "복원한 회로도에서 같은 넷리스트가 나온다");
  }
}

console.log(fail === 0 ? "\n.sp 입출력 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
