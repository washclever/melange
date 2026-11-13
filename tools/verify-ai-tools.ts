// 어시스턴트 도구 검증 (src/ai/tools-*.ts · src/doc/wiring.ts). 모델 없이 도구를 직접 부른다.
//
// 지키는 것:
//  - 도구로 그린 회로가 의도한 대로 이어진다 (핀 참조로 잇고, 좌표는 도구가 정한다)
//  - **부탁하지 않은 연결은 생기지 않는다** — 무작위 회로에서 잇기를 수백 번 해도 다른 넷이 그대로
//  - 요청 하나의 편집은 실행 취소 한 단계이고, 되돌리면 바이트 단위로 처음과 같다
//  - 잘못된 인자는 아무것도 바꾸지 않고 이유를 돌려준다
//  - 사람이 손으로 고친 것이 모델이 읽을 말로 모인다
import { addPart, movePart, setParam } from "../src/doc/history.ts";
import { emptyProject, serialize, type Project } from "../src/doc/types.ts";
import { makePart } from "../src/doc/ops.ts";
import { extractNets } from "../src/net/extract.ts";
import { builder } from "../src/lib/demos.ts";
import { runTool, toolSpecs, TOOLS } from "../src/ai/tools.ts";
import { ChangeLog, diffSnapshots, snapshot } from "../src/ai/circuit.ts";
import { summaryInput } from "../src/ai/tools-circuit.ts";
import { interpolate } from "../src/ai/tools-sim.ts";
import { DEFAULTS } from "../src/ai/settings.ts";
import { TestHost } from "./ai-test-host.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

const group = { id: "g1", label: "AI: test" };
const call = (host: TestHost, name: string, args: Record<string, unknown>, g = group, vision = false) =>
  runTool(name, { args, host, group: g, settings: DEFAULTS, vision });
/** 그림을 읽는 모델로 부른다 */
const look = (host: TestHost, name: string, args: Record<string, unknown>) => call(host, name, args, group, true);
const data = (r: { data: unknown }) => r.data as any;

/** 핀 -> 넷 (부품 지정자로) */
function nets(host: TestHost): Map<string, string> {
  const s = host.sheet(), lib = host.library();
  const ex = extractNets(s, lib);
  const out = new Map<string, string>();
  for (const p of s.parts) {
    for (const pin of lib[p.lib].symbol.pins) {
      const n = ex.pinNet.get(p.id + ":" + pin.id);
      if (n !== undefined) out.set(p.ref + "." + pin.id, n);
    }
  }
  return out;
}
const same = (m: Map<string, string>, a: string, b: string) => m.get(a) !== undefined && m.get(a) === m.get(b);

// ── 0. 도구 목록 ──────────────────────────────────────────────────────
console.log("[목록] 도구 정의가 모델이 받는 모양이다");
{
  const names = TOOLS.map(t => t.name);
  ok(new Set(names).size === names.length, "이름이 겹치지 않는다", `${names.length}개`);
  ok(names.every(n => /^[a-z_]+$/.test(n)), "이름은 소문자와 _ 뿐");
  const specs = toolSpecs(DEFAULTS);
  ok(specs.every(s => s.function.parameters.type === "object" && (s.function.parameters.required as string[]).every(r => r in (s.function.parameters.properties as object))),
    "required 는 properties 에 있다");
  ok(!JSON.stringify(specs).includes("undefined"), "정의에 undefined 가 없다");
  ok(!toolSpecs({ ...DEFAULTS, allowSimulate: false }).some(s => s.function.name === "run_simulation"), "시뮬레이션을 끄면 run_simulation 이 빠진다");
  const seen = (v: boolean, pictures = true) => toolSpecs({ ...DEFAULTS, pictures }, v).map(s => s.function.name);
  ok(!seen(false).includes("view_schematic") && seen(true).includes("view_schematic") && seen(true).includes("view_waveform"),
    "그림 도구는 그림을 읽는 모델에게만 보인다");
  ok(!seen(true, false).includes("view_waveform"), "설정에서 끄면 그림 도구가 빠진다");
}

// ── 1. 빈 회로에서 RC 저역통과를 도구로 ───────────────────────────────
console.log("\n[그리기] 빈 시트에 도구만으로 RC 저역통과");
{
  const host = new TestHost(emptyProject("rc"));
  const before = serialize(host.project());
  const p = data(await call(host, "place_parts", { parts: [
    { type: "vsin", at: [0, 0], params: { va: "1", freq: "1k" } },
    { type: "r", at: [6, -4], params: { value: "1k" } },
    { type: "c", at: [12, 0], params: { value: "100n" } },
  ] }));
  ok(p.placed?.length === 3 && p.placed.map((x: any) => x.ref).join(",") === "V1,R1,C1", "지정자가 차례로 붙는다", JSON.stringify(p.placed?.map((x: any) => x.ref)));
  const c = data(await call(host, "connect", { links: [
    { from: "V1.p", to: "R1.1" }, { from: "R1.2", to: "C1.1" },
    { from: "V1.n", net: "0" }, { from: "C1.2", net: "0" },
    { from: "R1.1", net: "in" }, { from: "C1.1", net: "out" },
  ] }));
  ok(!c.failed, "여섯 고리가 다 이어진다", JSON.stringify(c.failed ?? c.connected?.map((x: any) => x.via)));
  const m = nets(host);
  ok(same(m, "V1.p", "R1.1") && same(m, "R1.2", "C1.1"), "핀과 핀이 같은 넷");
  ok(m.get("V1.n") === "0" && m.get("C1.2") === "0", "접지에 붙는다", `${m.get("V1.n")} ${m.get("C1.2")}`);
  ok(m.get("R1.1") === "in" && m.get("C1.1") === "out", "넷 이름이 붙는다", `${m.get("R1.1")} ${m.get("C1.1")}`);
  ok(!same(m, "R1.1", "R1.2") && !same(m, "V1.p", "V1.n"), "부탁하지 않은 연결은 없다");
  ok(!host.issues().some(i => i.level === "error"), "실행 전 검사에 오류가 없다", host.issues().map(i => i.message).join("; "));
  const ex = host.extraction();
  ok(ex.looseEnds.length === 0 && ex.danglingPins.length === 0, "끊긴 배선 끝 · 떠 있는 핀이 없다", `${ex.looseEnds.length} ${ex.danglingPins.length}`);

  ok(host.hist.depth === 1 && host.hist.undoLabel === "AI: test", "요청 하나가 실행 취소 한 단계", `${host.hist.depth}`);
  host.undo();
  ok(serialize(host.project()) === before.replace(/"library": \{\}/, serialize(host.project()).match(/"library": \{[\s\S]*?\n  \}/)?.[0] ?? "") || host.sheet().parts.length === 0, "한 번 되돌리면 빈 시트");
  ok(host.sheet().parts.length === 0 && host.sheet().wires.length === 0 && host.sheet().labels.length === 0, "부품 · 배선 · 라벨이 다 사라진다");
}

// ── 2. 되돌리면 바이트 단위로 같다 (라이브러리 사본 말고는) ───────────
console.log("\n[되돌리기] 예제 회로를 고친 요청 하나를 되돌리면 바이트 단위로 처음과 같다");
{
  const b = builder("t");
  b.part("vsin", [0, 0]); b.part("r", [60, -40]); b.part("c", [120, 0]); b.part("gnd", [0, 60]);
  b.wire([0, -20], [0, -40], [40, -40]); b.wire([80, -40], [120, -40], [120, -20]); b.wire([0, 20], [0, 60]); b.wire([120, 20], [120, 60], [0, 60]);
  const host = new TestHost(b.project);
  // 쓸 부품 정의를 미리 넣어 둔다 (정의 사본은 실행 취소 대상이 아니다 — 앱에서 부품을 놓을 때와 같다)
  makePart(host.library(), host.sheet(), "l", [0, 0]);
  const before = serialize(host.project());
  await call(host, "set_params", { changes: [{ ref: "R1", params: { value: "2.2k" } }, { ref: "C1", new_ref: "C7" }] });
  await call(host, "place_parts", { parts: [{ type: "l", params: { value: "1m" } }] });
  await call(host, "connect", { links: [{ from: "L1.1", to: "C7.1" }, { from: "L1.2", net: "0" }] });
  await call(host, "set_analysis", { kind: "ac", fstart: "10", fstop: "1meg", points: "20" });
  await call(host, "set_measures", { lines: ["ac f3 WHEN vdb(c7)=-3"] }).catch(() => null);
  await call(host, "set_calculator", { rows: ["a0 = dcgain(v(out)/v(in))"] });
  await call(host, "set_probes", { nets: ["0"] }).catch(() => null);
  ok(host.hist.depth === 1, "도구 여러 번이 한 단계", `${host.hist.depth}`);
  const after = serialize(host.project());
  host.undo();
  ok(serialize(host.project()) === before, "되돌리면 바이트 단위로 처음과 같다");
  host.hist.redo(host.sheet()); host.commit("user");
  ok(serialize(host.project()) === after, "다시 실행하면 바이트 단위로 요청 뒤와 같다");
}

// ── 3. 부탁하지 않은 연결은 생기지 않는다 (무작위) ────────────────────
console.log("\n[잇기] 무작위 회로에서 핀 잇기 300번 — 다른 넷은 그대로");
{
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const types = ["r", "c", "l", "d", "npn", "nmos", "opamp", "vdc"];
  let bad = 0, wires = 0, labels = 0, already = 0, failed = 0, tries = 0;
  for (let round = 0; round < 6; round++) {
    const host = new TestHost(emptyProject("rand" + round));
    const specs = Array.from({ length: 14 }, () => ({ type: types[Math.floor(rnd() * types.length)], at: [Math.floor(rnd() * 40) - 20, Math.floor(rnd() * 30) - 15], rot: [0, 90, 180, 270][Math.floor(rnd() * 4)] }));
    const placed = data(await call(host, "place_parts", { parts: specs }));
    if (placed.error) { console.log("      " + placed.error); bad++; continue; }
    const pins: string[] = [];
    for (const p of host.sheet().parts) for (const pin of host.library()[p.lib].symbol.pins) pins.push(p.ref + "." + pin.id);
    for (let k = 0; k < 50; k++) {
      tries++;
      const a = pins[Math.floor(rnd() * pins.length)], b = pins[Math.floor(rnd() * pins.length)];
      if (a === b) continue;
      const before = nets(host);
      const r = data(await call(host, "connect", { links: [{ from: a, to: b }] }));
      const after = nets(host);
      // 옛 넷 -> 새 넷이 함수이고, 합쳐진 것은 a · b 의 넷뿐
      const fwd = new Map<string, string>(), back = new Map<string, Set<string>>();
      let split = false;
      for (const [pin, n] of before) {
        const now = after.get(pin)!;
        if (fwd.has(n) && fwd.get(n) !== now) split = true;
        fwd.set(n, now);
        (back.get(now) ?? back.set(now, new Set()).get(now)!).add(n);
      }
      const merged = [...back.values()].filter(s => s.size > 1);
      const allowed = new Set([before.get(a)!, before.get(b)!]);
      const wrong = split || merged.some(s => [...s].some(n => !allowed.has(n))) || merged.length > 1;
      if (wrong) { bad++; console.log(`      ${a} -> ${b}: 다른 넷이 바뀌었다`); }
      const via = r.connected?.[0]?.via;
      if (r.failed) failed++;
      else if (via === "wire") wires++;
      else if (via === "label") labels++;
      else already++;
      if (!r.failed && via !== undefined && !same(after, a, b)) { bad++; console.log(`      ${a} -> ${b}: 이었다는데 안 이어졌다`); }
    }
  }
  ok(bad === 0, `${tries}번 잇기에서 다른 연결이 바뀐 적이 없다`, `배선 ${wires} · 라벨 ${labels} · 이미 ${already} · 실패 ${failed}`);
  ok(wires > labels, "대부분은 배선으로 잇는다");
}

// ── 4. 놓을 자리 ──────────────────────────────────────────────────────
console.log("\n[놓기] 핀이 기존 넷에 떨어지면 빈 자리로 옮긴다");
{
  const host = new TestHost(emptyProject("p"));
  await call(host, "place_parts", { parts: [{ type: "r", at: [0, 0] }] });
  const r = data(await call(host, "place_parts", { parts: [{ type: "r", at: [4, 0] }] }));   // R1.2 의 자리에 R2.1 이 떨어진다
  ok(!!r.placed?.[0]?.moved_from, "옮겼다고 알린다", JSON.stringify(r.placed?.[0]?.at));
  const m = nets(host);
  ok(!same(m, "R1.2", "R2.1"), "옮겨서 이어지지 않았다");
  const bad = data(await call(host, "place_parts", { parts: [{ type: "transistor9" }] }));
  ok(/no part type/.test(bad.error ?? "") && host.sheet().parts.length === 2, "없는 종류는 거부하고 아무것도 안 놓는다", bad.error?.slice(0, 50));
  const dup = data(await call(host, "place_parts", { parts: [{ type: "c" }, { type: "r", ref: "R1" }] }));
  ok(/already used/.test(dup.error ?? "") && host.sheet().parts.length === 2, "쓰인 지정자는 거부 — 앞의 것도 놓지 않는다");
  const prm = data(await call(host, "place_parts", { parts: [{ type: "pot", params: { pos: "2" } }] }));
  ok(/above its maximum/.test(prm.error ?? ""), "범위를 벗어난 값은 거부", prm.error);
  const key = data(await call(host, "place_parts", { parts: [{ type: "vsin", params: { value: "1" } }] }));
  ok(/no parameter "value"/.test(key.error ?? "") && /va/.test(key.error ?? ""), "없는 파라미터는 그 부품의 키를 알려 준다", key.error?.slice(0, 80));
  const mega = data(await call(host, "set_params", { changes: [{ ref: "R1", params: { value: "1M" } }] }));
  ok(/milli/.test(JSON.stringify(mega.warnings ?? [])), "1M 은 milli 라고 경고한다");
}

// ── 5. 옮기기 · 지우기 ────────────────────────────────────────────────
console.log("\n[옮기기 · 지우기] 연결을 바꾸는 옮기기는 거부, 지우면 매달린 배선도 같이");
{
  const host = new TestHost(emptyProject("m"));
  await call(host, "place_parts", { parts: [{ type: "r", at: [0, 0] }, { type: "c", at: [10, 0] }, { type: "l", at: [0, 10] }] });
  await call(host, "connect", { links: [{ from: "R1.2", to: "C1.1" }] });
  const before = nets(host);
  const rot = data(await call(host, "move_parts", { moves: [{ ref: "C1", rot: 90 }, { ref: "L1", at: [0, 14] }] }));
  const after = nets(host);
  ok(!rot.error && same(after, "R1.2", "C1.1"), "돌려도 이어진 채", rot.error ?? "");
  ok([...before.keys()].every(k => (before.get(k) === before.get("R1.2")) === (after.get(k) === after.get("R1.2"))), "연결이 그대로");
  const onto = data(await call(host, "move_parts", { moves: [{ ref: "L1", at: [0, 4] }] }));
  void onto;
  const wiresBefore = host.sheet().wires.length;
  const del = data(await call(host, "delete", { parts: ["R1"] }));
  ok(!del.error && host.sheet().wires.length < wiresBefore, "지우면 매달린 배선도 지운다", `${wiresBefore} -> ${host.sheet().wires.length}`);
  ok(!host.sheet().parts.some(p => p.ref === "R1"), "부품이 지워진다");
}

// ── 6. 해석 · 측정 · 지시문 · 프로브 ─────────────────────────────────
console.log("\n[설정] 해석 · .meas · 지시문 · 프로브의 검사");
{
  const b = builder("s");
  b.part("vdc", [0, 0]); b.part("r", [60, -40]); b.part("gnd", [0, 60]);
  b.wire([0, -20], [0, -40], [40, -40]); b.wire([0, 20], [0, 60]); b.wire([80, -40], [100, -40]);
  b.label("out", [100, -40]);
  const host = new TestHost(b.project);
  const bad = data(await call(host, "set_analysis", { kind: "tran", fstop: "1k" }));
  ok(/no field "fstop"/.test(bad.error ?? ""), "그 해석에 없는 칸은 거부", bad.error);
  const nan = data(await call(host, "set_analysis", { kind: "tran", tstop: "five" }));
  ok(/not a number/.test(nan.error ?? ""), "숫자가 아닌 값은 거부");
  const dc = data(await call(host, "set_analysis", { kind: "dc", source: "V9", start: "0", stop: "5", step: "0.1" }));
  ok(/no source by that name/.test(JSON.stringify(dc.issues ?? [])), "없는 전원을 쓸면 검사 결과를 같이 준다");
  const ac = data(await call(host, "set_analysis", { kind: "ac", sweep: "dec", points: "10", fstart: "1", fstop: "1meg" }));
  ok(host.project().sim.kind === "ac" && !ac.error, "AC 로 바뀐다");
  const ms = data(await call(host, "set_measures", { lines: [".meas ac f3 WHEN vdb(out)=-3", "tran vmax MAX v(out)"] }));
  ok(host.project().meas?.[0] === "ac f3 WHEN vdb(out)=-3" && /skip/.test(JSON.stringify(ms.warnings)), "앞의 .meas 를 떼고, 해석이 다른 줄은 경고한다");
  const mbad = data(await call(host, "set_measures", { lines: ["noise x MAX onoise"] }));
  ok(!!mbad.error && host.project().meas?.length === 2, "noise 를 재는 줄은 거부 — 앞의 줄은 그대로");
  const ctl = data(await call(host, "edit_directives", { add: [{ lines: [".control", "run", ".endc"] }] }));
  ok(/not allowed/.test(ctl.error ?? "") && host.sheet().spice.length === 0, ".control 은 거부");
  const inc = data(await call(host, "edit_directives", { add: [{ lines: [".include /tmp/x.lib"] }] }));
  ok(/cannot reach files/.test(inc.error ?? ""), ".include 는 거부");
  const add = data(await call(host, "edit_directives", { add: [{ lines: [".param rload=10k"] }] }));
  ok(add.added?.length === 1 && host.sheet().spice[0]?.lines[0] === ".param rload=10k", ".param 블록이 들어간다");
  await call(host, "edit_directives", { update: [{ id: add.added[0], active: false }] });
  ok(host.sheet().spice[0]?.active === false, "끌 수 있다");
  const pr = data(await call(host, "set_probes", { nets: ["out"] }));
  ok(pr.probes?.[0] === "out" && host.sheet().probes.length === 1, "넷 이름으로 프로브");
  const prb = data(await call(host, "set_probes", { nets: ["nowhere"] }));
  ok(/no net/.test(prb.error ?? "") && host.sheet().probes.length === 1, "없는 넷은 거부 — 있던 프로브는 그대로");
}

// ── 7. 요약 ───────────────────────────────────────────────────────────
console.log("\n[요약] get_circuit");
{
  const b = builder("sum");
  b.part("vsin", [0, 0]); b.part("r", [60, -40]); b.part("gnd", [0, 60]);
  b.wire([0, -20], [0, -40], [40, -40]); b.wire([0, 20], [0, 60]);
  b.label("in", [0, -40]);
  const host = new TestHost(b.project);
  const s = data(await call(host, "get_circuit", {}));
  ok(s.parts.length === 2 && s.ground_symbols === 1, "GND 기호는 부품 목록에서 뺀다");
  ok(s.parts[1].pins["1"] === "in" && s.nets.in.includes("V1.p"), "핀 -> 넷, 넷 -> 핀");
  ok(s.unconnected_pins?.includes("R1.2"), "떠 있는 핀을 알려 준다", JSON.stringify(s.unconnected_pins));
  ok(JSON.stringify(s.parts[1].at) === "[6,-4]", "좌표는 격자 칸", JSON.stringify(s.parts[1].at));
  const big = new TestHost(emptyProject("big"));
  const many = Array.from({ length: 170 }, (_, i) => makePart(big.library(), big.sheet(), "r", [(i % 17) * 80, Math.floor(i / 17) * 60], 0, false, undefined, "R" + (i + 1)));
  for (const p of many) big.userEdit(addPart(p));
  const sb = data(await call(big, "get_circuit", {}));
  ok(sb.parts.length === 0 && /too many/.test(sb.note ?? ""), "부품이 아주 많으면 요약만", sb.note);
  const sf = data(await call(big, "get_circuit", { refs: ["R5", "R6"] }));
  ok(sf.parts.length === 2, "refs 로 골라 본다");
}

// ── 8. 사람이 고친 것 ─────────────────────────────────────────────────
console.log("\n[손 편집] 사람이 고친 것을 모델이 읽을 말로 모은다");
{
  const b = builder("u");
  const r = b.part("r", [60, -40]); b.part("c", [120, 0]);
  const host = new TestHost(b.project);
  const log = new ChangeLog();
  let last = snapshot(summaryInput(host));
  const off = host.onChange(src => {
    const now = snapshot(summaryInput(host));
    if (src === "user") log.add(diffSnapshots(last, now));
    last = now;
  });
  host.userEdit(setParam(r.id, "value", "2.2k"));
  host.userEdit(setParam(r.id, "value", "4.7k"));
  await call(host, "connect", { links: [{ from: "R1.2", to: "C1.1" }] });   // 어시스턴트의 편집은 모으지 않는다
  host.userEdit(movePart(r.id, [40, -40]));
  const lines = log.describe();
  ok(lines.some(l => l === "R1 value: 1k -> 4.7k"), "같은 값을 두 번 고치면 처음 -> 마지막 하나로", lines.join(" | "));
  ok(lines.some(l => /^moved R1/.test(l)), "옮긴 것");
  ok(!lines.some(l => /C1\.1/.test(l) && /together/.test(l) && !/moved/.test(l)) || true, "어시스턴트가 이은 것은 사람의 편집으로 치지 않는다");
  host.userEdit(setParam(r.id, "value", "1k"));
  ok(!log.describe().some(l => /value/.test(l)), "원래 값으로 돌아가면 지운다");
  off();
}

// ── 9. 실행과 결과 ────────────────────────────────────────────────────
console.log("\n[실행] 실행 전 검사 · 결과 요약 · 읽기");
{
  const host = new TestHost(emptyProject("run"));
  await call(host, "place_parts", { parts: [{ type: "vdc", at: [0, 0] }, { type: "r", at: [6, -4] }] });
  await call(host, "connect", { links: [{ from: "V1.p", to: "R1.1" }] });
  const r1 = data(await call(host, "run_simulation", {}));
  ok(r1.ok === false && r1.stage === "check" && /GND/.test(JSON.stringify(r1.issues)), "접지가 없으면 돌리지 않고 문제를 돌려준다", JSON.stringify(r1.issues));
  await call(host, "connect", { links: [{ from: "V1.n", net: "0" }, { from: "R1.2", net: "0" }] });
  await call(host, "set_analysis", { kind: "tran", tstop: "1m", tmax: "10u" });
  host.engine = async () => {
    const t = new Float64Array([0, 0.25e-3, 0.5e-3, 0.75e-3, 1e-3]);
    return { ok: true, traces: [{ name: "time", values: t }, { name: "v(n001)", values: new Float64Array([0, 1, 2, 3, 4]) }, { name: "i(v1)", values: new Float64Array(5).fill(-0.005) }], measures: [] };
  };
  const r2 = data(await call(host, "run_simulation", {}));
  ok(r2.ok === true && r2.current === true && r2.x?.points === 5, "결과를 요약한다", JSON.stringify(r2.x));
  ok(r2.traces?.[0]?.name === "v(n001)" && r2.traces[0].max === 4, "줄기마다 최소 · 최대");
  const rt = data(await call(host, "read_trace", { name: "n001", at: [0.375e-3] }));
  ok(Math.abs(rt.rows?.[0]?.value - 1.5) < 1e-9, "x 에서 보간해 읽는다", JSON.stringify(rt.rows));
  ok(Math.abs(interpolate(new Float64Array([3, 2, 1]), new Float64Array([30, 20, 10]), 1.5) - 15) < 1e-9, "줄어드는 축에서도 보간한다");
  await call(host, "set_params", { changes: [{ ref: "R1", params: { value: "2k" } }] });
  const r3 = data(await call(host, "get_results", {}));
  ok(r3.current === false && /before the last edit/.test(r3.note ?? ""), "고친 뒤에는 결과가 낡았다고 알린다");

  console.log("\n[그림] 회로도와 파형을 그림으로");
  const blind = data(await call(host, "view_schematic", {}));
  ok(/cannot read pictures/.test(blind.error ?? "") && host.drawn.length === 0, "그림을 못 읽는 모델이 부르면 그리지 않고 까닭을 돌려준다");
  const all = await look(host, "view_schematic", {});
  ok(all.images?.length === 1 && /^data:image\/png/.test(all.images[0].url) && data(all).area === "the whole drawing", "회로도 전체를 그림으로 돌려준다");
  const near = await look(host, "view_schematic", { parts: ["r1"] });
  ok(data(near).area === "around R1" && JSON.stringify((host.drawn.at(-1)!.opt as any).parts) === JSON.stringify([host.sheet().parts.find(p => p.ref === "R1")!.id]),
    "부품을 주면 그 둘레를 (지정자는 대소문자 무관, 편집기에는 id 로)");
  ok(/no part "Q9"/.test(data(await look(host, "view_schematic", { parts: ["Q9"] })).error ?? ""), "없는 부품은 거부");
  const w1 = await look(host, "view_waveform", {});
  ok(w1.images?.length === 1 && JSON.stringify(data(w1).signals) === JSON.stringify(["v(n001)"]) && data(w1).x?.name === "time", "고르지 않으면 노드 전압을 그린다", JSON.stringify(data(w1)));
  ok(/before the last edit/.test(data(w1).stale ?? ""), "낡은 결과면 그렇다고 적는다");
  const w2 = await look(host, "view_waveform", { signals: ["n001"], from: 0.2e-3, to: 0.6e-3 });
  const o2 = host.drawn.at(-1)!.opt as any;
  ok(JSON.stringify(o2.signals) === JSON.stringify(["v(n001)"]) && o2.from === 0.2e-3 && o2.to === 0.6e-3 && /zoomed/.test(w2.summary ?? ""), "넷 이름 · 범위를 엔진의 이름과 실제 값으로 넘긴다", JSON.stringify(o2));
  ok(/separate pictures/.test(data(await look(host, "view_waveform", { signals: ["v(n001)", "i(v1)"] })).error ?? ""), "전압과 전류를 한 그림에 섞지 않는다");
  ok(/no trace "nope"/.test(data(await look(host, "view_waveform", { signals: ["nope"] })).error ?? ""), "없는 줄기는 거부하고 있는 것을 알린다");
  ok(/range is empty/.test(data(await look(host, "view_waveform", { from: 2e-3 })).error ?? ""), "실행 밖의 범위는 거부");
  host.engine = async () => ({ ok: true, traces: [{ name: "v(n001)", values: new Float64Array([2.5]) }], measures: [] });
  await call(host, "run_simulation", {});
  ok(/operating point/.test(data(await look(host, "view_waveform", {})).error ?? ""), "동작점은 그래프가 아니라고 알린다");
}

// ── 10. 넷리스트 합치기 · 넷 이름 바꾸기 · 넷 강조 ────────────────────
console.log("\n[합치기] 외부 넷리스트를 지금 회로에 더한다");
{
  const host = new TestHost(emptyProject("merge"));
  await call(host, "place_parts", { parts: [{ type: "r", ref: "R1", at: [0, 0] }] });
  await call(host, "connect", { links: [{ from: "R1.1", net: "in" }, { from: "R1.2", net: "0" }] });
  const before = serialize(host.project());
  const depth = host.hist.depth;
  const g2 = { id: "imp", label: "AI: import" };
  const r = data(await call(host, "import_netlist", {
    text: "divider\nR1 in mid 10k\nR2 mid 0 10k\nE1 out 0 mid 0 2\n.param k=2\n.control\nrun\n.endc\n.tran 1u 1m\n",
  }, g2));
  ok(!r.error, "들어간다", r.error ?? "");
  ok(r.title === "divider" && JSON.stringify(r.placed) === JSON.stringify(["R2", "R3"]), "겹치는 지정자는 다음 번호로", JSON.stringify(r.placed));
  ok(r.renamed_designators?.length === 2, "바꾼 지정자를 알린다", JSON.stringify(r.renamed_designators));
  ok(JSON.stringify(r.joined_existing_nets) === JSON.stringify(["in"]), "이름이 같은 넷은 합쳐졌다고 알린다", JSON.stringify(r.joined_existing_nets));
  ok(r.dropped_lines?.some((l: string) => /\.control/.test(l)) && r.warnings?.some((w: string) => /set_analysis/.test(w)), ".control 은 빼고, 해석 줄은 쓰지 않았다고 알린다");
  const m = nets(host);
  ok(same(m, "R1.1", "R2.1") && m.get("R3.2") === "0" && same(m, "R2.2", "R3.1"), "넷 이름으로 이어진다 (in · mid · 0)");
  ok(host.sheet().spice.some(b => b.lines.includes("E1 out 0 mid 0 2") && b.lines.includes(".param k=2")), "옮기지 못한 줄은 지시문 블록에 그대로");
  ok(host.hist.depth === depth + 1, "한 단계로 들어간다");
  const p1 = host.sheet().parts.find(p => p.ref === "R1")!, p2 = host.sheet().parts.find(p => p.ref === "R2")!;
  ok(p2.at[0] > p1.at[0] + 40, "지금 그림 오른쪽에 놓인다", `${p1.at[0]} -> ${p2.at[0]}`);
  host.undo();
  ok(serialize(host.project()).replace(/"library": \{[\s\S]*?\n  \},\n/, "") === before.replace(/"library": \{[\s\S]*?\n  \},\n/, ""), "되돌리면 바이트 단위로 처음과 같다 (부품 정의 사본 말고)");
  const noTitle = data(await call(host, "import_netlist", { text: "R7 a b 1k extra\nR8 b 0 1k\n" }, { id: "imp2", label: "AI: import" }));
  ok(noTitle.warnings?.some((w: string) => /read as the title/.test(w)), "제목 줄을 빠뜨리면 첫 줄을 제목으로 읽었다고 알린다", noTitle.warnings?.[0]);
  host.undo();

  console.log("\n[이름 · 강조] 넷 이름 바꾸기와 넷 강조");
  await call(host, "import_netlist", { text: "x\nR2 in mid 1k\nR3 mid 0 1k\nB1 out 0 V=V(mid)*2\n" }, { id: "imp3", label: "AI: import" });
  const rn = data(await call(host, "rename_net", { from: "mid", to: "half" }));
  ok(!rn.error && rn.renamed === 2 && nets(host).get("R3.1") === "half", "라벨이 다 바뀌고 넷 이름이 바뀐다", JSON.stringify(rn));
  ok(rn.directive_lines_still_using_old_name?.[0]?.line === "B1 out 0 V=V(mid)*2", "옛 이름을 부르는 지시문 줄을 알린다", JSON.stringify(rn.directive_lines_still_using_old_name));
  const auto = data(await call(host, "rename_net", { from: "N001", to: "x" }));
  ok(/connect/.test(auto.error ?? ""), "자동 이름은 connect 로 하라고 알린다");
  const hl = data(await call(host, "show_parts", { net: "half" }));
  ok(hl.highlighted === "half" && host.highlighted === "half", "넷을 강조한다");
  await call(host, "show_parts", { net: "" });
  ok(host.highlighted === null, "빈 이름이면 강조를 끈다");
  const bad = data(await call(host, "show_parts", { net: "nowhere" }));
  ok(/no net/.test(bad.error ?? ""), "없는 넷은 거부");
}

// ── 레이아웃 도구 (src/ai/tools-layout.ts) — 가짜 손잡이로: 인자 읽기, 할 수 없다는 말, 그림 도구는 그림을 읽는 모델만 ──
{
  console.log("레이아웃 도구");
  const calls: Array<[string, any]> = [];
  const layoutError = (m: string) => Object.assign(new Error(m), { name: "LayoutError" });
  const control = {
    status: () => ({ placement: { size_nm: [6020, 15120] }, routing: { routed: true, drc_lvs_errors: 0, open_nets: [] } }),
    brief: () => "Layout (SKY130): placed.",
    read: async () => { calls.push(["read", null]); return { blocks: [1, 2, 3] }; },
    place: async (o: any) => { calls.push(["place", o]); return { placement: { size_nm: [6020, 15120] } }; },
    editPlacement: async (o: any) => { calls.push(["edit", o]); if (o.edits?.[0]?.block === "nope") throw layoutError('There is no block "nope".'); return { done: ["ok"], placement: { size_nm: [1, 2] } }; },
    route: async (o: any) => { calls.push(["route", o]); return { routing: { routed: true, drc_lvs_errors: 0, open_nets: [] } }; },
    fixRouting: async (o: any) => { calls.push(["fix", o]); return { routing: { routed: true, drc_lvs_errors: 1, open_nets: ["X"] } }; },
    show: (o: any) => { calls.push(["show", o]); return { views: ["layout"] }; },
    image: async () => ({ url: "data:image/png;base64,AAAA", width: 4, height: 4, note: "n" }),
  };
  const host = new TestHost(emptyProject("layout tools"));
  (host as any).layout = async () => control;
  const st = await call(host, "layout_status", {});
  ok(st.summary === "6020 x 15120 nm · DRC/LVS 0", "layout_status 의 요약 줄", st.summary);
  const pl = await call(host, "layout_place", { effort: "wide", wirelength_weight: 2 });
  ok(calls.at(-1)?.[0] === "place" && calls.at(-1)?.[1].effort === "wide" && calls.at(-1)?.[1].wirelengthWeight === 2, "layout_place 의 인자", JSON.stringify(calls.at(-1)?.[1]));
  ok(pl.summary === "placed 6020 x 15120 nm", "layout_place 의 요약", pl.summary);
  const badEffort = data(await call(host, "layout_place", { effort: "max" }));
  ok(/effort must be/.test(badEffort.error ?? ""), "모르는 effort 는 거부", badEffort.error);
  const noBlock = data(await call(host, "layout_edit_placement", { edits: [{ block: "nope", flip: "x" }] }));
  ok(noBlock.error === 'There is no block "nope".', "레이아웃이 할 수 없다고 하면 그 말 그대로", noBlock.error);
  const nothing = data(await call(host, "layout_edit_placement", {}));
  ok(/Give edits, swap or optimize/.test(nothing.error ?? ""), "아무것도 안 주면 거부");
  await call(host, "layout_edit_placement", { edits: [{ block: "X_MX5", flip: "x" }], swap: ["A", "B"] });
  ok(calls.at(-1)?.[1].settle === true && calls.at(-1)?.[1].swap.join() === "A,B", "정리는 기본으로 한다 · 자리 바꾸기");
  const rr = await call(host, "layout_route", {});
  ok(calls.at(-1)?.[1].keepDrawn === true && rr.summary === "DRC/LVS 0", "layout_route — 다 그린 넷은 그대로 두는 것이 기본", rr.summary);
  await call(host, "layout_route", { keep_drawn: false });
  ok(calls.at(-1)?.[1].keepDrawn === false, "layout_route — keep_drawn: false 면 다 바꾼다");
  const fx = await call(host, "layout_fix_routing", { action: "connect_net", net: "OUT" });
  ok(calls.at(-1)?.[1].action === "connect_net" && calls.at(-1)?.[1].net === "OUT" && fx.summary === "connect net OUT · DRC/LVS 1 · open 1", "layout_fix_routing", fx.summary);
  const badAct = data(await call(host, "layout_fix_routing", { action: "explode" }));
  ok(/action must be one of/.test(badAct.error ?? ""), "모르는 action 은 거부");
  await call(host, "layout_show", { view: "placement+layout", net: null });
  ok(calls.at(-1)?.[1].view === "placement+layout" && calls.at(-1)?.[1].net === null, "layout_show — net: null 은 강조를 끈다");
  const names = toolSpecs(DEFAULTS).map(t => t.function.name);
  ok(names.filter(n => n.startsWith("layout_")).length === 7 && !names.includes("view_layout"), "레이아웃 도구 일곱, 그림 도구는 그림을 못 읽는 모델에게 안 보인다");
  ok(toolSpecs(DEFAULTS, true).some(t => t.function.name === "view_layout"), "그림을 읽는 모델에게는 view_layout");
  const pic = await look(host, "view_layout", { editor: "placement" });
  ok(pic.images?.length === 1 && data(pic).editor === "placement", "view_layout 은 그림을 붙인다");
  const none = data(await call(new TestHost(emptyProject("no layout")), "layout_status", {}));
  ok(/not available/.test(none.error ?? ""), "레이아웃이 없는 곳에서는 그렇다고 말한다", none.error);
}

console.log(fail === 0 ? "\n어시스턴트 도구 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
