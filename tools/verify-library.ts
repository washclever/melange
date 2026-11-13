// 부품 라이브러리 검증 — 목차 · 심볼 · 넷리스트 줄 · 실행 전 검사 · 엔진에서 손계산과 대조.
//
// 새 부품은 그림만 그럴듯해서는 안 된다. 화살표가 위를 보는 전류원이 실제로 위 핀으로 전류를 내는지,
// 변압기의 점이 찍힌 끝끼리 같은 위상인지, 가변 저항의 0 과 1 이 어느 끝인지는 **엔진에 돌려 봐야**
// 안다. 그래서 부품마다 회로도를 만들고(라벨로 핀을 잇는다), 넷 추출 -> 넷리스트 -> ngspice 를 거쳐
// 손으로 계산한 값과 맞춘다. 넷리스트는 손으로 적지 않는다 — 손으로 적으면 검증이 아니다.
//
// 끝으로, 아무것도 구동하지 않는 넷 때문에 엔진이 결과 없이 멈추는 경우를 실행 전 검사가 막는지,
// 그래도 새어 나가면 실행하는 쪽(src/sim-run.ts)이 멈춘 엔진을 알아채고 끝내는지 본다.
import { Simulation } from "eecircuit-engine";
import { builder } from "../src/lib/demos.ts";
import { BUILTIN } from "../src/lib/parts.ts";
import { ABOUT, ENTRIES, LIBRARIES, PALETTE, elementLetters, search } from "../src/lib/catalog.ts";
import { pinOut } from "../src/doc/follow.ts";
import { pinAt, type Part, type Project, type SimSettings } from "../src/doc/types.ts";
import { extractNets } from "../src/net/extract.ts";
import { buildNetlist, checkCircuit, deviceLines, exprNodes, sensePins } from "../src/net/netlist.ts";
import { toTraces, type Trace } from "../src/sim-values.ts";
import { diagnose } from "../src/sim-log.ts";
import { fitSine } from "../src/measure.ts";
import { EngineStuck, runGuarded, stuckMessage } from "../src/sim-run.ts";
import { summary } from "../src/ui/library.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};
/** 손계산과 대조. tol 은 절대 오차 */
const near = (got: number, want: number, tol: number, msg: string) =>
  ok(Math.abs(got - want) <= tol, msg, `${got.toPrecision(10)} (기대 ${want.toPrecision(10)}, 오차 ${Math.abs(got - want).toExponential(2)})`);

// ── 1. 목차 ───────────────────────────────────────────────────────────
console.log("[목차] 모든 내장 부품이 라이브러리 한 곳에만 있다");
{
  const ids = ENTRIES.map(e => e.id);
  const builtin = Object.keys(BUILTIN);
  ok(new Set(ids).size === ids.length, "목차에 같은 부품이 두 번 나오지 않는다");
  ok(builtin.every(id => ids.includes(id)), `내장 부품 ${builtin.length}종이 전부 목차에 있다`,
     builtin.filter(id => !ids.includes(id)).join(", "));
  ok(ids.every(id => BUILTIN[id]), "목차의 부품이 전부 내장 부품이다");
  ok(PALETTE.join() === ids.join(), "왼쪽 목록 순서 = 목차 순서");
  ok(LIBRARIES.slice(0, 2).map(l => l.name).join() === "Passive,Analog", "수동 소자 · 아날로그 라이브러리가 맨 앞");
  const badCat = ENTRIES.filter(e => e.part.category !== e.lib.name);
  ok(!badCat.length, "부품의 category 가 그 라이브러리 이름이다 (프로젝트 파일에 남는 값)",
     badCat.map(e => `${e.id}:${e.part.category}`).join(", "));
  const noText = ENTRIES.filter(e => !ABOUT[e.id]?.text);
  ok(!noText.length, "부품마다 설명이 있다", noText.map(e => e.id).join(", "));
  const badPinRole = ENTRIES.flatMap(e =>
    Object.keys(ABOUT[e.id]?.pins ?? {}).filter(k => !e.part.symbol.pins.some(p => p.id === k)).map(k => `${e.id}.${k}`));
  ok(!badPinRole.length, "핀 설명이 가리키는 핀이 실제로 있다", badPinRole.join(", "));
  const passive = LIBRARIES[0].groups.flatMap(g => g.parts);
  ok(["r", "pot", "c", "cpol", "l", "xfmr", "tline"].every(id => passive.includes(id)), "수동 소자: R · 가변 R · C · 극성 C · L · 변압기 · 전송선");
  const analog = LIBRARIES[1].groups.flatMap(g => g.parts);
  ok(["idc", "isin", "ipulse", "vcvs", "vccs", "ccvs", "cccs", "opamp", "comparator", "vswitch", "mult", "bv", "zener"]
    .every(id => analog.includes(id)), "아날로그: 전류원 · 제어 전원 넷 · 비교기 · 스위치 · 곱셈기 · 동작 전원 · 제너");
}

console.log("\n[찾기] 이름 · 낱말 · SPICE 문자로 찾는다");
{
  const first = (q: string) => search(q)[0]?.id;
  ok(first("resistor") === "r", "'resistor' -> 저항이 먼저", first("resistor"));
  ok(first("pot") === "pot", "'pot' -> 가변 저항", first("pot"));
  ok(search("current").slice(0, 3).map(e => e.id).sort().join() === "idc,ipulse,isin", "'current' -> 전류원 셋이 먼저",
     search("current").slice(0, 4).map(e => e.id).join());
  ok(first("pulse cur") === "ipulse", "낱말 머리 둘 -> 펄스 전류원", first("pulse cur"));
  ok(first("vcvs") === "vcvs", "'vcvs'", first("vcvs"));
  ok(search("transconductance").some(e => e.id === "vccs"), "'transconductance' -> VCCS (설명에서)");
  ok(search("relay").some(e => e.id === "vswitch"), "'relay' -> 스위치 (찾기 낱말)");
  ok(search("zzzz").length === 0, "없는 말은 아무것도 없다");
  ok(search("").length === ENTRIES.length, "빈 찾기는 전부");
  ok(search("cap", ENTRIES.filter(e => e.lib.id === "passive")).every(e => e.lib.id === "passive"), "범위 안에서만 찾는다");
  ok(elementLetters(BUILTIN.xfmr) === "L + K", "변압기의 SPICE 문자는 L + K", elementLetters(BUILTIN.xfmr));
  ok(elementLetters(BUILTIN.cccs) === "V + F", "CCCS 는 V + F (감지 전원)", elementLetters(BUILTIN.cccs));
  ok(summary(BUILTIN.r) === "1k Ω" && summary(BUILTIN.vsin) === "1 V · 1k Hz" && summary(BUILTIN.xfmr) === "1m : 1m H",
     "목록의 값 칸", [summary(BUILTIN.r), summary(BUILTIN.vsin), summary(BUILTIN.xfmr)].join(" | "));
}

// ── 2. 심볼 ───────────────────────────────────────────────────────────
console.log("\n[심볼] 핀마다 다리가 있고, 핀끼리 겹치지 않는다");
{
  let noLeg = 0, overlap = 0, why = "";
  for (const [id, lib] of Object.entries(BUILTIN)) {
    lib.symbol.pins.forEach((pin, i) => {
      // 다리(핀에서 시작하는 축 방향 선)가 있어야 배선이 따라올 때 바깥 방향을 안다 (doc/follow.ts)
      const hasLeg = lib.symbol.graphics.some(s => "line" in s &&
        s.line.some(p => p[0] === pin.at[0] && p[1] === pin.at[1]) &&
        ((s.line[0][0] === s.line[1][0]) !== (s.line[0][1] === s.line[1][1])));
      const o = pinOut(lib, i);
      if (lib.id !== "gnd" && (!hasLeg || (o[0] === 0 && o[1] === 0))) { noLeg++; why ||= `${id}.${pin.id}`; }
    });
    const keys = lib.symbol.pins.map(p => p.at.join(","));
    if (new Set(keys).size !== keys.length) { overlap++; why ||= `${id} 핀 겹침`; }
  }
  ok(noLeg === 0, "모든 핀(접지 제외)에 축 방향 다리가 있다", why);
  ok(overlap === 0, "한 부품의 핀끼리 같은 자리에 있지 않다 (같은 자리면 단락이다)");
  const t = (id: string, i: number) => pinOut(BUILTIN[id], i).join(",");
  ok(t("idc", 0) === "0,1" && t("idc", 1) === "0,-1", "전류원: 1 은 아래, 2 는 위로 나간다");
  ok(t("xfmr", 0) === "-1,0" && t("xfmr", 2) === "1,0", "변압기: 1차는 왼쪽, 2차는 오른쪽");
  ok(t("vcvs", 0) === "0,-1" && t("vcvs", 2) === "-1,0", "제어 전원: 출력 + 는 위, C+ 는 왼쪽");
}

console.log("\n[입력 핀] 틀에서 읽는다 — 예전 프로젝트에 든 op-amp 사본에도 맞다");
{
  const s = (id: string) => [...sensePins(BUILTIN[id])].sort().join(",");
  ok(s("opamp") === "inn,inp", "op-amp: + · -", s("opamp"));
  ok(s("vcvs") === "cn,cp" && s("vccs") === "cn,cp", "VCVS · VCCS: C+ · C-");
  ok(s("ccvs") === "" && s("cccs") === "", "전류 제어는 입력 핀이 아니다 (0 V 전원이 이어 준다)");
  ok(s("comparator") === "inn,inp" && s("mult") === "x,y", "비교기 · 곱셈기 (B 식의 V(핀))");
  ok(s("r") === "" && s("bv") === "", "저항 · 동작 전원(식은 따로 본다)은 없다");
  const legacy = structuredClone(BUILTIN.opamp);
  ok([...sensePins(legacy)].sort().join(",") === "inn,inp", "사본(structuredClone)에서도 같다");
  ok(exprNodes("2*V(in)+V(a, b)-v(0)").join() === "in,a,b", "식이 읽는 넷: V(in) · V(a,b), 0 은 뺀다",
     exprNodes("2*V(in)+V(a, b)-v(0)").join());
}

// ── 3. 회로 만들기 도우미 ─────────────────────────────────────────────
/**
 * 부품을 늘어놓고 핀마다 넷 라벨을 붙여 잇는다 ('0' 은 GND 기호). 배선을 긋지 않아도
 * 라벨이 이름으로 넷을 잇는다 (규칙 7).
 */
function circuit(name: string, sim: SimSettings) {
  const b = builder(name);
  b.project.sim = sim;
  let x = 0;
  const put = (lib: string, nets: Record<string, string>, params?: Record<string, string>): Part => {
    const p = b.part(lib, [x, 0], params);
    x += 120;
    const def = b.project.library[lib];
    def.symbol.pins.forEach((pin, i) => {
      const net = nets[pin.id];
      if (net === undefined) return;
      const at = pinAt(p, def, i);
      if (net === "0") b.part("gnd", at); else b.label(net, at);
    });
    return p;
  };
  return { ...b, put };
}

function netlistOf(pr: Project): { netlist: string; errors: string[] } {
  const s = pr.sheets[0];
  const ex = extractNets(s, pr.library);
  const errors = checkCircuit(s, pr.library, ex).filter(i => i.level === "error").map(i => i.message);
  return { netlist: buildNetlist(s, pr.library, ex, pr.sim, pr.name), errors };
}

/** 회로도 -> 넷리스트 -> 엔진. 오류가 있으면 실패로 적고 null */
async function run(pr: Project): Promise<{ get(n: string): Trace; netlist: string } | null> {
  const { netlist, errors } = netlistOf(pr);
  if (errors.length) { ok(false, `${pr.name}: 실행 전 검사 오류 없음`, errors.join(" / ")); return null; }
  const sim = new Simulation();
  await sim.start();
  sim.setNetList(netlist);
  let res: any;
  /*
   * 엔진은 알림을 stdout 에도 쏟는다 (변압기를 전압원이 바로 모는 회로는 직류에서 인덕터가 단락이라
   * 'singular matrix' 를 스무 줄 내고 transient op 로 풀어 낸다). 판정은 getError() 로 하므로 화면에서만 감춘다.
   */
  const quiet = console.log;
  console.log = () => {};
  try { res = await runGuarded(sim); }
  catch (e) { console.log = quiet; ok(false, `${pr.name}: 엔진이 결과를 낸다`, String(e)); return null; }
  console.log = quiet;
  const hasData = Array.isArray(res?.data) && res.data.some((d: any) => d?.values?.length > 0);
  const d = diagnose(sim.getError?.() ?? [], hasData);
  if (d.fatal) { ok(false, `${pr.name}: ngspice 오류 없음`, d.message.slice(0, 300)); console.log(netlist); return null; }
  const traces = toTraces(res.data);
  return {
    netlist,
    get(n: string) {
      const t = traces.find(x => x.name.toLowerCase() === n.toLowerCase());
      if (!t) throw new Error(`${n} 없음: ${traces.map(x => x.name).join(", ")}`);
      return t;
    },
  };
}

const OP: SimSettings = { kind: "op" };
const at0 = (t: Trace) => t.values[0];

// ── 4. 넷리스트 줄 ────────────────────────────────────────────────────
console.log("\n[넷리스트] 여러 줄을 내는 부품과 부품마다 따로 내는 모델");
{
  const c = circuit("lines", OP);
  c.put("vdc", { p: "in", n: "0" });
  c.put("pot", { "1": "in", w: "w", "2": "0" }, { pos: "0.3" });
  c.put("xfmr", { p1: "in", p2: "0", s1: "s", s2: "0" }, { ls: "4m" });
  c.put("cccs", { cp: "w", cn: "0", p: "0", n: "f" });
  c.put("vswitch", { "1": "in", "2": "sw", cp: "w", cn: "0" });
  c.put("vswitch", { "1": "in", "2": "sw2", cp: "w", cn: "0" }, { vt: "1" });
  for (const n of ["s", "f", "sw", "sw2"]) c.put("r", { "1": n, "2": "0" });
  const { netlist, errors } = netlistOf(c.project);
  const has = (l: string) => netlist.split("\n").includes(l);
  ok(has("RV1_a in w {max(10k*0.3,1m)}") && has("RV1_b w 0 {max(10k*(1-0.3),1m)}"), "가변 저항 -> 저항 둘 (중괄호 식)",
     netlist.split("\n").filter(l => l.startsWith("RV")).join(" | "));
  ok(has("LT1_p in 0 1m") && has("LT1_s s 0 4m") && has("KLT1 LT1_p LT1_s 0.999"), "변압기 -> 인덕터 둘 + K",
     netlist.split("\n").filter(l => /^[LK]/.test(l)).join(" | "));
  ok(has("VF1_s w 0 0") && has("F1 0 f VF1_s 10"), "CCCS -> 0 V 감지 전원 + F (전류는 위 핀으로)",
     netlist.split("\n").filter(l => /^(VF|F)/.test(l)).join(" | "));
  ok(has(".model S1_MOD SW(VT=2.5 VH=0 RON=1 ROFF=1meg)") && has(".model S2_MOD SW(VT=1 VH=0 RON=1 ROFF=1meg)"),
     "스위치는 제 이름의 모델을 낸다 — 문턱이 달라도 이름을 바꿀 필요가 없다");
  ok(!errors.some(e => /Model/.test(e)), "문턱이 다른 스위치 둘이 모델 이름 충돌로 막히지 않는다", errors.join(" / "));
  const order = netlist.split("\n").filter(l => /^[A-Z]/.test(l)).map(l => l[0]);
  ok(order.join("").startsWith("V") && order.indexOf("L") < order.indexOf("F") && order.indexOf("F") < order.indexOf("S"),
     "줄 순서: 전원 -> 수동 -> 제어 전원 -> 스위치", order.join(""));

  // 미리보기도 같은 함수로 만든다 (src/ui/library.ts)
  const part: Part = { id: "x", lib: "ccvs", ref: "H1", at: [0, 0], rot: 0, mirror: false, params: { value: "1k" } };
  const lines = deviceLines(part, BUILTIN.ccvs, id => `<${BUILTIN.ccvs.symbol.pins.find(p => p.id === id)!.name}>`, OP);
  ok(lines.join(" | ") === "VH1_s <C+> <C-> 0 | H1 <+> <-> VH1_s 1k", "라이브러리 창의 SPICE 미리보기", lines.join(" | "));
}

// ── 5. 실행 전 검사 ───────────────────────────────────────────────────
console.log("\n[실행 전 검사] 엔진을 멈추게 하는 회로를 먼저 막는다");
{
  const errs = (c: ReturnType<typeof circuit>) => netlistOf(c.project).errors;

  const a = circuit("floating input", OP);
  a.put("vdc", { p: "in", n: "0" });
  a.put("opamp", { inn: "in", out: "out" });          // + 입력을 비워 둔다
  a.put("r", { "1": "out", "2": "0" });
  ok(errs(a).some(e => /U1: input \+ is not driven/.test(e)), "op-amp 의 빈 입력은 오류다 (예전에는 경고였고 실행이 끝나지 않았다)", errs(a).join(" / "));
  const warn = checkCircuit(a.sheet, a.project.library, extractNets(a.sheet, a.project.library))
    .filter(i => i.level === "warning" && /U1: pin \+ is floating/.test(i.message));
  ok(warn.length === 0, "같은 핀에 '떠 있는 핀' 경고를 또 내지 않는다");

  const b = circuit("input to input", OP);
  b.put("vdc", { p: "in", n: "0" });
  b.put("opamp", { inn: "in", inp: "x", out: "o1" });
  b.put("opamp", { inn: "in", inp: "x", out: "o2" });   // 두 입력끼리만 이어진 넷 x
  b.put("r", { "1": "o1", "2": "0" }); b.put("r", { "1": "o2", "2": "0" });
  ok(errs(b).filter(e => /input \+ is not driven/.test(e)).length === 2, "입력끼리만 이어진 넷도 구동하는 것이 없다", errs(b).join(" / "));

  const nc = circuit("nc input", OP);
  nc.put("vdc", { p: "in", n: "0" });
  const u = nc.put("opamp", { inn: "in", out: "out" });
  nc.put("r", { "1": "out", "2": "0" });
  u.nc = ["inp"];
  ok(!errs(nc).length, "미연결 표시를 붙인 입력은 1 TΩ 로 접지에 묶이므로 통과", errs(nc).join(" / "));

  const e = circuit("vcvs open control", OP);
  e.put("vcvs", { p: "out", n: "0" });
  e.put("r", { "1": "out", "2": "0" });
  ok(errs(e).filter(x => /E1: input C[+-] is not driven/.test(x)).length === 2, "VCVS 의 빈 제어 단자 둘", errs(e).join(" / "));

  const bv = circuit("expression", OP);
  bv.put("vdc", { p: "in", n: "0" });
  bv.put("bv", { p: "out", n: "0" }, { value: "2*V(in)+V(nothere)" });
  bv.put("r", { "1": "out", "2": "0" });
  ok(errs(bv).some(x => /reads V\(nothere\), but no net is named nothere/.test(x)), "동작 전원의 식이 없는 넷을 읽으면 오류", errs(bv).join(" / "));
  ok(!errs(bv).some(x => /V\(in\)/.test(x)), "있는 넷(대소문자 무관)은 통과");

  const sh = circuit("shorted sense", OP);
  sh.put("vdc", { p: "in", n: "0" });
  sh.put("r", { "1": "in", "2": "s" });
  sh.put("cccs", { cp: "s", cn: "s", p: "0", n: "f" });
  sh.put("r", { "1": "f", "2": "0" }); sh.put("r", { "1": "s", "2": "0" });
  ok(errs(sh).some(x => /F1: control pins C\+ and C- are on the same net/.test(x)), "전류 제어 단자의 단락", errs(sh).join(" / "));

  const k = circuit("coupling", OP);
  k.put("vdc", { p: "in", n: "0" });
  k.put("xfmr", { p1: "in", p2: "0", s1: "s", s2: "0" }, { k: "1.2" });
  k.put("r", { "1": "s", "2": "0" });
  ok(errs(k).some(x => /T1: Coupling k must be between 0 and 1 \(it is 1.2\)/.test(x)), "결합 계수 1 초과", errs(k).join(" / "));
  const xf = k.sheet.parts.find(p => p.lib === "xfmr")!;
  xf.params.k = "0.95";
  ok(!errs(k).length, "0.95 는 통과", errs(k).join(" / "));
  xf.params.k = "{kk}";
  ok(!errs(k).length, "숫자로 못 읽는 값(.param 식)은 건드리지 않는다", errs(k).join(" / "));

  const d = circuit("diode models", OP);
  d.put("vdc", { p: "in", n: "0" });
  d.put("d", { a: "in", k: "x" }); d.put("d", { a: "x", k: "0" }, { is: "1e-12" });
  ok(errs(d).some(x => /Model DGEN has different coefficients/.test(x)), "다이오드 모델 이름 충돌 검사는 그대로");
}

// ── 6. 엔진에서 손계산과 대조 ─────────────────────────────────────────
console.log("\n[엔진] 부품마다 회로도 -> 넷리스트 -> ngspice, 손계산과 대조");

{ // 가변 저항: 1 V 를 걸고 와이퍼 0.3 -> 와이퍼 전압 = 1 - 0.3 (0 이 핀 1 쪽)
  const c = circuit("pot", OP);
  c.put("vdc", { p: "in", n: "0" }, { dc: "1" });
  c.put("pot", { "1": "in", w: "w", "2": "0" }, { pos: "0.3" });
  const r = await run(c.project);
  if (r) near(at0(r.get("v(w)")), 0.7, 1e-9, "가변 저항: 위치 0.3 이면 와이퍼가 0.7 V (0 은 핀 1 쪽)");
  c.sheet.parts.find(p => p.lib === "pot")!.params.pos = "1";
  const r2 = await run(c.project);
  if (r2) near(at0(r2.get("v(w)")), 1e-7, 1e-9, "가변 저항: 끝(1)에서도 0 Ω 이 아니라 1 mΩ — 전류가 맞다");
}

{ // 전류원 셋: 아래(1)를 접지, 위(2)를 1k 에 -> 위 핀으로 전류가 나와 +V
  const c = circuit("current sources", OP);
  c.put("idc", { p: "0", n: "a" }, { dc: "2m" });
  c.put("r", { "1": "a", "2": "0" });
  const r = await run(c.project);
  if (r) near(at0(r.get("v(a)")), 2, 1e-9, "직류 전류원 2 mA × 1 kΩ = +2 V (화살표 쪽 핀으로 나온다)");

  const t = circuit("current waves", { kind: "tran", tstop: "3m", tmax: "5u", tstart: "0" });
  t.put("isin", { p: "0", n: "s" }, { va: "1m" });
  t.put("r", { "1": "s", "2": "0" });
  t.put("ipulse", { p: "0", n: "q" }, { v2: "3m" });
  t.put("r", { "1": "q", "2": "0" });
  const rt = await run(t.project);
  if (rt) {
    const fit = fitSine(rt.get("time").values, rt.get("v(s)").values, 1000, { from: 1e-3, to: 3e-3 });
    near(fit.amplitude, 1, 1e-3, "사인 전류원 1 mA × 1 kΩ: 진폭 1 V");
    // fitSine 의 위상은 cos 기준이다: +sin(ωt) = cos(ωt - 90°). 뒤집혔다면 +90° 가 나온다
    near(fit.phaseDeg, -90, 0.5, "+sin(ωt) — 뒤집히지 않았다 (cos 기준 -90°)");
    const q = rt.get("v(q)").values;
    near(Math.max(...q), 3, 1e-9, "펄스 전류원 3 mA × 1 kΩ: 꼭대기 3 V");
  }
}

{ // PWL: 0 0 1m 1 2m 0 -> 1 ms 에 1 V, 0.5 ms 에 0.5 V
  const c = circuit("pwl", { kind: "tran", tstop: "2m", tmax: "10u", tstart: "0" });
  c.put("vpwl", { p: "p", n: "0" });
  c.put("r", { "1": "p", "2": "0" });
  const r = await run(c.project);
  if (r) {
    const t = r.get("time").values, v = r.get("v(p)").values;
    const at = (x: number) => { for (let i = 1; i < t.length; i++) if (t[i] >= x) return v[i - 1] + (v[i] - v[i - 1]) * (x - t[i - 1]) / (t[i] - t[i - 1]); return NaN; };
    near(at(0.5e-3), 0.5, 1e-9, "PWL 전압원: 0.5 ms 에서 0.5 V");
    near(Math.max(...v), 1, 1e-9, "꼭대기 1 V");
  }
}

{ // 제어 전원 넷. 출력은 모두 위 핀이 양(전압) 또는 전류가 나오는 쪽(전류)
  const c = circuit("controlled sources", OP);
  c.put("vdc", { p: "c", n: "0" }, { dc: "0.3" });
  c.put("vcvs", { cp: "c", cn: "0", p: "e", n: "0" }, { value: "10" });
  c.put("r", { "1": "e", "2": "0" });
  c.put("vccs", { cp: "c", cn: "0", p: "0", n: "g" }, { value: "2m" });
  c.put("r", { "1": "g", "2": "0" });
  // 전류 제어: 1 V -> 1 kΩ -> C+ ... C- -> 접지, 감지 전류 1 mA
  c.put("vdc", { p: "src", n: "0" }, { dc: "1" });
  c.put("r", { "1": "src", "2": "sp" });
  c.put("ccvs", { cp: "sp", cn: "m", p: "h", n: "0" }, { value: "500" });
  c.put("cccs", { cp: "m", cn: "0", p: "0", n: "f" }, { value: "10" });
  c.put("r", { "1": "h", "2": "0" }); c.put("r", { "1": "f", "2": "0" });
  const r = await run(c.project);
  if (r) {
    near(at0(r.get("v(e)")), 3, 1e-9, "VCVS: 10 × 0.3 V = 3 V");
    near(at0(r.get("v(g)")), 0.6, 1e-9, "VCCS: 2 mS × 0.3 V × 1 kΩ = +0.6 V (전류가 위 핀으로 나온다)");
    near(at0(r.get("v(h)")), 0.5, 1e-9, "CCVS: 500 Ω × 1 mA = 0.5 V");
    near(at0(r.get("v(f)")), 10, 1e-8, "CCCS: 10 × 1 mA × 1 kΩ = +10 V");
    near(at0(r.get("v(sp)")), 0, 1e-12, "전류 제어 단자는 단락이다 (두 단자 사이 0 V)");
  }
}

{ // 비교기 · 곱셈기 · 동작 전원
  const c = circuit("behavioral", OP);
  c.put("vdc", { p: "hi", n: "0" }, { dc: "1.01" });
  c.put("vdc", { p: "ref", n: "0" }, { dc: "1" });
  c.put("vdc", { p: "lo", n: "0" }, { dc: "0.99" });
  c.put("comparator", { inp: "hi", inn: "ref", out: "c1" });
  c.put("comparator", { inp: "lo", inn: "ref", out: "c2" });
  c.put("comparator", { inp: "ref", inn: "ref", out: "c3" });
  c.put("vdc", { p: "x", n: "0" }, { dc: "2" });
  c.put("vdc", { p: "y", n: "0" }, { dc: "3" });
  c.put("mult", { x: "x", y: "y", out: "m" }, { value: "0.5" });
  c.put("bv", { p: "b", n: "0" }, { value: "2*V(x)+V(Y)/3" });
  for (const n of ["c1", "c2", "c3", "m", "b"]) c.put("r", { "1": n, "2": "0" });
  const r = await run(c.project);
  if (r) {
    near(at0(r.get("v(c1)")), 5, 1e-6, "비교기: V+ 가 10 mV 높으면 high (5 V)");
    near(at0(r.get("v(c2)")), 0, 1e-6, "10 mV 낮으면 low (0 V)");
    near(at0(r.get("v(c3)")), 2.5, 1e-9, "같으면 가운데 (tanh(0) = 0)");
    near(at0(r.get("v(m)")), 3, 1e-9, "곱셈기: 0.5 × 2 × 3 = 3 V");
    near(at0(r.get("v(b)")), 5, 1e-9, "동작 전원: 2·V(x) + V(Y)/3 = 5 V (넷 이름의 대소문자 무관)");
  }
  const t = circuit("bv default", { kind: "tran", tstop: "3m", tmax: "5u", tstart: "0" });
  t.put("bv", { p: "b", n: "0" });
  t.put("r", { "1": "b", "2": "0" });
  const rt = await run(t.project);
  if (rt) {
    const fit = fitSine(rt.get("time").values, rt.get("v(b)").values, 1000, { from: 1e-3, to: 3e-3 });
    near(fit.amplitude, 1, 1e-3, "동작 전원의 기본 식 sin(2*pi*1k*time): 1 kHz 진폭 1 V — 놓자마자 돈다");
  }
}

{ // 스위치: 문턱 2.5 V. 제어 5 V 면 닫힘(1 Ω), 0 V 면 열림(1 MΩ)
  const c = circuit("switch", OP);
  c.put("vdc", { p: "in", n: "0" }, { dc: "5" });
  c.put("vdc", { p: "on", n: "0" }, { dc: "5" });
  c.put("vswitch", { "1": "in", "2": "a", cp: "on", cn: "0" });
  c.put("vswitch", { "1": "in", "2": "b", cp: "0", cn: "0" });
  c.put("r", { "1": "a", "2": "0" }); c.put("r", { "1": "b", "2": "0" });
  const r = await run(c.project);
  if (r) {
    near(at0(r.get("v(a)")), 5 * 1000 / 1001, 1e-9, "닫힌 스위치: 1 Ω 과 1 kΩ 의 분압");
    near(at0(r.get("v(b)")), 5 * 1000 / 1001000, 1e-12, "열린 스위치: 1 MΩ 과 1 kΩ 의 분압");
  }
}

{ // 변압기: 1 mH : 4 mH (1:2), k = 0.999, 2차에 1 kΩ.
  // V2/V1 = k·√(Ls/Lp) / (1 + jω·Ls(1-k²)/R) — 1차를 이상 전압원이 직접 몰 때의 정확한 해
  const c = circuit("transformer", { kind: "ac", sweep: "dec", points: "1", fstart: "100", fstop: "100k" });
  c.put("vdc", { p: "p", n: "0" }, { dc: "0" });
  c.put("xfmr", { p1: "p", p2: "0", s1: "s", s2: "0" }, { ls: "4m" });
  c.put("r", { "1": "s", "2": "0" });
  const r = await run(c.project);
  if (r) {
    const f = r.get("frequency").values, v = r.get("v(s)");
    let worst = 0, worstPh = 0;
    for (let i = 0; i < f.length; i++) {
      const w = 2 * Math.PI * f[i], k = 0.999, b = w * 4e-3 * (1 - k * k) / 1000;
      const mag = 2 * k / Math.hypot(1, b), ph = -Math.atan(b) * 180 / Math.PI;
      worst = Math.max(worst, Math.abs(v.values[i] - mag));
      worstPh = Math.max(worstPh, Math.abs(v.phaseDeg![i] - ph));
    }
    ok(worst < 1e-9, `권선비 2 의 2차 전압이 손계산과 같다 (${f.length}개 주파수, 100 Hz–100 kHz)`, `최대 오차 ${worst.toExponential(2)}`);
    ok(worstPh < 1e-6, "점이 찍힌 끝끼리 같은 위상이다 (거꾸로 감겼다면 180°)", `최대 위상 오차 ${worstPh.toExponential(2)}°`);
  }
}

{ // 전송선: 양 끝 정합(50 Ω), 지연 10 ns. |V(b)/V(in)| = 1/2, 위상 = -360°·f·TD
  const c = circuit("tline", { kind: "ac", sweep: "lin", points: "4", fstart: "1meg", fstop: "25meg" });
  c.put("vdc", { p: "in", n: "0" }, { dc: "0" });
  c.put("r", { "1": "in", "2": "a" }, { value: "50" });
  c.put("tline", { a: "a", ar: "0", b: "b", br: "0" }, { td: "10n" });
  c.put("r", { "1": "b", "2": "0" }, { value: "50" });
  const r = await run(c.project);
  if (r) {
    const f = r.get("frequency").values, v = r.get("v(b)");
    let worst = 0, worstPh = 0;
    for (let i = 0; i < f.length; i++) {
      worst = Math.max(worst, Math.abs(v.values[i] - 0.5));
      const want = -360 * f[i] * 10e-9;
      const d = ((v.phaseDeg![i] - want) % 360 + 540) % 360 - 180;
      worstPh = Math.max(worstPh, Math.abs(d));
    }
    ok(worst < 1e-9, "정합된 전송선: 크기 1/2 (반사 없음)", `최대 오차 ${worst.toExponential(2)}`);
    ok(worstPh < 1e-6, "위상 = -360°·f·TD (지연 10 ns)", `최대 오차 ${worstPh.toExponential(2)}°`);
  }
}

{ // 극성 커패시터: RC 코너에서 -3 dB, -45° — 보통 커패시터와 같은 소자다
  const c = circuit("cpol", { kind: "ac", sweep: "lin", points: "1", fstart: String(1 / (2 * Math.PI * 1e3 * 10e-6)), fstop: String(1 / (2 * Math.PI * 1e3 * 10e-6)) });
  c.put("vdc", { p: "in", n: "0" }, { dc: "0" });
  c.put("r", { "1": "in", "2": "o" });
  c.put("cpol", { p: "o", n: "0" });
  const r = await run(c.project);
  if (r) {
    near(r.get("v(o)").values[0], Math.SQRT1_2, 1e-6, "극성 커패시터 RC 코너: |H| = 1/√2");
    near(r.get("v(o)").phaseDeg![0], -45, 1e-4, "위상 -45°");
  }
}

{ // 제너: 1 mA 를 음극으로 밀어 넣으면 K-A 가 BV. ngspice 는 IBV 에서 BV 가 되도록 맞춘다
  const c = circuit("zener", OP);
  c.put("idc", { p: "0", n: "k" }, { dc: "1m" });
  c.put("zener", { a: "0", k: "k" });
  const r = await run(c.project);
  if (r) near(at0(r.get("v(k)")), 5.1, 0.02, "제너: IBV(1 mA) 에서 역방향 전압 ≈ BV 5.1 V");
  const c2 = circuit("zener forward", OP);
  c2.put("idc", { p: "0", n: "a" }, { dc: "1m" });
  c2.put("zener", { a: "a", k: "0" });
  const r2 = await run(c2.project);
  // 순방향은 보통 다이오드: V = n·Vt·ln(I/Is + 1)
  if (r2) near(at0(r2.get("v(a)")), 1 * 0.025852 * Math.log(1e-3 / 1e-14 + 1), 2e-3, "순방향은 보통 다이오드 (Shockley)");
}

{ // AC 해석: 직류 전류원은 AC 0 이 기본 — 바이어스가 신호가 되지 않는다
  const c = circuit("ac bias", { kind: "ac", sweep: "dec", points: "1", fstart: "1k", fstop: "1k" });
  c.put("vdc", { p: "in", n: "0" }, { dc: "0" });
  c.put("r", { "1": "in", "2": "o" });
  c.put("idc", { p: "0", n: "o" }, { dc: "1m" });
  c.put("r", { "1": "o", "2": "0" });
  const r = await run(c.project);
  if (r) near(r.get("v(o)").values[0], 0.5, 1e-9, "AC: 직류 전류원(바이어스)은 신호를 넣지 않는다 — 분압 1/2 그대로");
  ok(netlistOf(c.project).netlist.includes("I1 0 o DC 1m AC 0"), "직류 전류원 줄에 AC 0", netlistOf(c.project).netlist.split("\n").find(l => l.startsWith("I1")));
}

// ── 7. 멈춘 엔진 ──────────────────────────────────────────────────────
console.log("\n[멈춘 엔진] 결과 없이 멈추면 실행하는 쪽이 알아채고 끝낸다 (src/sim-run.ts)");
{
  // 검사를 거치지 않은 넷리스트 (지시문 블록에 들어온 줄 같은 것) — op-amp 입력 둘 다 비었다
  const stuck = new Simulation();
  await stuck.start();
  const quiet = console.log;
  console.log = () => {};        // 엔진이 stdout 에 오류를 스무 줄 쏟는다
  stuck.setNetList("stuck\nEU1 out 0 a b 1e6\nR1 out 0 1k\n.op\n.end");
  const t0 = performance.now();
  let caught: unknown = null;
  try { await runGuarded(stuck); } catch (e) { caught = e; }
  console.log = quiet;
  const ms = performance.now() - t0;
  ok(caught instanceof EngineStuck, "결과 없이 멈춘 실행을 실패로 끝낸다", `${ms.toFixed(0)} ms`);
  ok(ms < 5000, "기다리지 않는다 (5 초 안)", `${ms.toFixed(0)} ms`);
  const msg = caught instanceof EngineStuck ? stuckMessage(caught.lines) : "";
  ok(/stopped without producing a result/.test(msg) && /\ba\b|\bb\b/.test(msg), "사람이 읽는 말에 ngspice 가 가리킨 노드가 있다", msg.split("\n")[0]);
  // 새 인스턴스는 멀쩡하다 (워커는 멈춘 것을 버리고 새로 띄운다)
  const fresh = new Simulation();
  await fresh.start();
  fresh.setNetList("ok\nV1 a 0 DC 1\nR1 a 0 1k\n.op\n.end");
  const res: any = await runGuarded(fresh);
  ok(toTraces(res.data).some(t => t.name === "v(a)" && t.values[0] === 1), "멈춘 뒤 새 엔진은 정상으로 돈다");

  /*
   * ngspice 가 스스로 끝내 버리는 경우 — 그 레벨에 없는 모델 계수(레벨 6 에 VT · KV · KC 는 없다).
   * 'fatal error in ngspice, exit(1)' 을 남기고 약속은 그대로 남는다. 예전에는 앱이 'Running…' 에서 멈췄다.
   */
  const fatal = new Simulation();
  await fatal.start();
  console.log = () => {};
  const qe = console.error;
  console.error = () => {};
  fatal.setNetList("fatal\nV1 d 0 DC 5\nV2 g 0 DC 2\nM1 d g 0 0 MX W=100u L=10u\n.model MX NMOS(LEVEL=6 VT=1 KV=1 KC=2e-5)\n.op\n.end");
  const t1 = performance.now();
  let caught2: unknown = null;
  try { await runGuarded(fatal); } catch (e) { caught2 = e; }
  console.log = quiet;
  console.error = qe;
  ok(caught2 instanceof EngineStuck && performance.now() - t1 < 5000, "ngspice 가 스스로 끝낸 실행도 실패로 끝낸다", `${(performance.now() - t1).toFixed(0)} ms`);
  const msg2 = caught2 instanceof EngineStuck ? stuckMessage(caught2.lines) : "";
  ok(/gave up on this netlist/.test(msg2) && /strtod/.test(msg2) && !/voltage/.test(msg2), "그때는 떠 있는 넷 이야기가 아니라 ngspice 가 남긴 말을 보여 준다", msg2.split("\n").slice(0, 2).join(" / "));
}

console.log(fail ? `\n${fail}건 실패` : "\n부품 라이브러리: 목차 · 심볼 · 넷리스트 · 실행 전 검사 · 엔진 대조 · 멈춘 엔진 모두 통과");
process.exit(fail ? 1 : 0);
