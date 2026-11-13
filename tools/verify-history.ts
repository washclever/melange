// 명령 패턴 검증 (설계서 E12).
// 핵심 불변조건: 어떤 명령이든 apply -> revert 하면 문서가 바이트 단위로 원래대로 돌아온다.
import {
  History, addPart, removePart, movePart, rotatePart, setParam, setRef,
  addWire, removeWire, addLabel, removeLabel, addProbe, removeProbe, batch, removeObjects,
  setCalc, setMeas, setSim,
  type Command,
} from "../src/doc/history.ts";
import { BUILTIN, defaultParams } from "../src/lib/parts.ts";
import { emptyProject, serialize, type Part, type Pt, type Project, type Sheet } from "../src/doc/types.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

let n = 0;
function base(): Project {
  const pr = emptyProject("history test");
  for (const k of Object.keys(BUILTIN)) pr.library[k] = structuredClone(BUILTIN[k]);
  const s = pr.sheets[0];
  const mk = (lib: string, ref: string, at: Pt): Part =>
    ({ id: "p" + ++n, lib, ref, at, rot: 0, mirror: false, params: defaultParams(BUILTIN[lib]) });
  s.parts.push(mk("vsin", "V1", [0, 0]), mk("r", "R1", [60, -40]), mk("c", "C1", [120, 0]));
  s.wires.push({ id: "w" + ++n, pts: [[0, -20], [0, -40], [40, -40]] });
  s.labels.push({ id: "l" + ++n, name: "in", at: [0, -40], kind: "label" });
  return pr;
}

const part = (s: Sheet, ref: string) => s.parts.find(p => p.ref === ref)!;

// ── 1. apply -> revert 가 원래대로 ────────────────────────────────────
console.log("[불변조건] 모든 명령이 apply -> revert 로 정확히 되돌아온다");
{
  const make: Array<[string, (s: Sheet) => Command]> = [
    ["Place part", s => addPart({ id: "new1", lib: "r", ref: "R9", at: [200, 200], rot: 0, mirror: false, params: { value: "4k7" } })],
    ["Delete part", s => removePart(part(s, "R1").id)],
    ["Move part", s => movePart(part(s, "R1").id, [300, 300])],
    ["Rotate", s => rotatePart(part(s, "R1").id, 90)],
    ["Change value", s => setParam(part(s, "R1").id, "value", "47k")],
    ["Change designator", s => setRef(part(s, "R1").id, "R42")],
    ["Wires", s => addWire({ id: "wnew", pts: [[0, 0], [100, 0]] })],
    ["Delete wire", s => removeWire(s.wires[0].id)],
    ["Net label", s => addLabel({ id: "lnew", name: "out", at: [120, -40], kind: "label" })],
    ["Delete label", s => removeLabel(s.labels[0].id)],
    ["Probes", s => addProbe({ id: "pr1", at: [0, -40], color: "--t1" })],
  ];

  let bad = 0;
  for (const [name, factory] of make) {
    const pr = base();
    const before = serialize(pr);
    const cmd = factory(pr.sheets[0]);
    cmd.apply(pr.sheets[0]);
    const changed = serialize(pr) !== before;
    cmd.revert(pr.sheets[0]);
    const restored = serialize(pr) === before;
    if (!changed) { console.log(`      ${name}: 문서가 안 바뀜`); bad++; }
    if (!restored) { console.log(`      ${name}: 되돌아오지 않음`); bad++; }
  }
  ok(bad === 0, `명령 ${make.length}가지가 모두 정확히 되돌아온다`);
}

// ── 2. 지웠다 되돌리면 원래 자리로 ────────────────────────────────────
console.log("\n[순서] 지웠다 되돌리면 배열의 원래 자리에 들어간다");
{
  const pr = base();
  const s = pr.sheets[0];
  const order = () => s.parts.map(p => p.ref).join(",");
  const cmd = removePart(part(s, "R1").id);   // 가운데 것
  cmd.apply(s);
  ok(order() === "V1,C1", "가운데가 빠진다", `(${order()})`);
  cmd.revert(s);
  ok(order() === "V1,R1,C1", "되돌리면 가운데로 다시 들어간다", `(${order()})`);
}

// ── 3. 묶음은 역순으로 되돌린다 ───────────────────────────────────────
console.log("\n[묶음] 여러 명령을 한 단계로");
{
  const pr = base();
  const s = pr.sheets[0];
  const before = serialize(pr);
  const r1 = part(s, "R1");
  const cmd = batch("여러 변경", [
    setParam(r1.id, "value", "10k"),
    movePart(r1.id, [500, 500]),
    addProbe({ id: "pb", at: [0, -40], color: "--t2" }),
  ]);
  cmd.apply(s);
  ok(part(s, "R1").params.value === "10k" && s.probes.length === 1, "묶음이 전부 적용된다");
  cmd.revert(s);
  ok(serialize(pr) === before, "묶음이 한 번에 되돌아온다");
}

// ── 4. History: 취소 / 다시 실행 / 선택 복원 ──────────────────────────
console.log("\n[기록] 취소 · 다시 실행 · 선택 복원");
{
  const pr = base();
  const s = pr.sheets[0];
  const h = new History();
  const before = serialize(pr);
  const r1 = part(s, "R1");

  h.run(s, setParam(r1.id, "value", "22k"), r1.id, r1.id);
  ok(part(s, "R1").params.value === "22k", "명령이 적용된다");
  ok(h.canUndo && !h.canRedo, "취소는 가능, 다시 실행은 아직");
  ok(h.undoLabel === "Change value", "마지막 명령 이름", `(${h.undoLabel})`);

  const sel = h.undo(s);
  ok(serialize(pr) === before, "취소하면 원래대로");
  ok(sel === r1.id, "취소하면 선택도 그때로 되돌린다");
  ok(!h.canUndo && h.canRedo, "이제 다시 실행만 가능");

  h.redo(s);
  ok(part(s, "R1").params.value === "22k", "다시 실행된다");

  // 새 편집은 '다시 실행' 가지를 버린다
  h.undo(s);
  h.run(s, setRef(r1.id, "R7"), null, r1.id);
  ok(!h.canRedo, "되돌린 뒤 새로 편집하면 다시 실행 가지가 사라진다");

  // null(선택 없음으로 되돌림)과 undefined(되돌릴 게 없음)는 다른 값이다
  h.run(s, setParam(r1.id, "value", "33k"), r1.id, r1.id);
  h.run(s, movePart(r1.id, [9, 9]), r1.id, r1.id);
  const depth = h.depth;
  let steps = 0;
  while (h.undo(s) !== undefined) steps++;
  ok(steps === depth, `쌓인 ${depth}단계를 모두 거슬러 올라간다`, `(${steps}단계)`);
  ok(serialize(pr) === before, "끝까지 되돌리면 처음 상태");
  ok(h.undo(s) === undefined, "더 없으면 undefined");
}

// ── 5. 끌기 한 번 = 한 단계 ───────────────────────────────────────────
console.log("\n[단계 크기] 끌기 한 번이 한 단계");
{
  const pr = base();
  const s = pr.sheets[0];
  const h = new History();
  const r1 = part(s, "R1");
  const origin: Pt = [r1.at[0], r1.at[1]];

  // 끄는 동안은 화면용으로 직접 움직이고, 끝날 때 시작 위치로 되돌린 뒤 한 번만 기록한다.
  // 그래야 명령이 apply 시점에 '바뀌기 전 값' 을 제대로 잡는다.
  for (const step of [[10, 0], [20, 0], [30, 0], [40, 0]] as Pt[]) r1.at = step;
  r1.at = origin;
  h.run(s, movePart(r1.id, [40, 0]), r1.id, r1.id);

  ok(h.depth === 1, "중간 단계가 아니라 한 단계만 쌓인다", `(${h.depth})`);
  h.undo(s);
  ok(part(s, "R1").at[0] === origin[0] && part(s, "R1").at[1] === origin[1],
     "한 번 취소로 끌기 시작 위치까지", `(${part(s, "R1").at})`);
}

// ── 6. 깊이 제한 ──────────────────────────────────────────────────────
console.log("\n[한계] 기록 깊이");
{
  const pr = base();
  const s = pr.sheets[0];
  const h = new History(5);
  const r1 = part(s, "R1");
  for (let i = 0; i < 20; i++) h.run(s, setParam(r1.id, "value", String(i + 1)), null, null);
  ok(h.depth === 5, "한계를 넘으면 오래된 것부터 버린다", `(${h.depth})`);
}

// ── 7. 여러 개를 지웠다 되돌리면 순서까지 돌아온다 ────────────────────
/*
 * 예전 removeObjects 는 하나 지울 때마다 줄어든 배열의 자리를 적었다. 앞쪽부터 고른 것을
 * 지웠다 되돌리면 [A,B,C] -> [A,C,B] 가 됐다. 순서는 자동 넷 이름을 정하므로, 되돌렸는데
 * 넷리스트가 달라지는 조용한 버그였다. 고른 순서를 바꿔 가며 바이트 단위로 비교한다.
 */
console.log("\n[순서] 여러 개 지우기를 되돌리면 배열 순서까지 같다");
{
  let bad = 0;
  const orders: Array<(ids: string[]) => string[]> = [
    ids => ids, ids => [...ids].reverse(), ids => [ids[2], ids[0], ids[4], ids[1], ids[3]].filter(Boolean),
  ];
  for (const order of orders) {
    const pr = base();
    const s = pr.sheets[0];
    s.wires.push(...[1, 2, 3, 4].map(i => ({ id: "extra" + i, pts: [[i * 100, 0], [i * 100, 50]] as Pt[] })));
    const before = serialize(pr);
    const picks = [s.parts[0].id, s.parts[2].id, s.wires[1].id, s.wires[3].id, s.wires[4].id];
    const refs = order(picks).map(id => ({ kind: id.startsWith("p") ? "part" as const : "wire" as const, id }));
    const cmd = removeObjects(refs);
    cmd.apply(s);
    if (s.parts.length !== 1 || s.wires.length !== 2) bad++;
    cmd.revert(s);
    if (serialize(pr) !== before) bad++;
  }
  ok(bad === 0, "고른 순서가 어떻든 원래 순서로 돌아온다", `(${bad}건 어긋남)`);

  // 같은 배열에서 S 개를 지우는 비용이 S × N 이 아니다 (1만 개 중 1만 개)
  const pr = base();
  const s = pr.sheets[0];
  for (let i = 0; i < 20000; i++) s.wires.push({ id: "b" + i, pts: [[i * 10, 0], [i * 10, 10]] });
  const refs = s.wires.map(w => ({ kind: "wire" as const, id: w.id }));
  const t0 = performance.now();
  const cmd = removeObjects(refs);
  cmd.apply(s);
  cmd.revert(s);
  const ms = performance.now() - t0;
  ok(ms < 200 && s.wires.length === 20001, "배선 2만 개를 지웠다 되돌리는 데 0.2초 안", `(${ms.toFixed(0)} ms)`);
}

// ── 8. 꼬리표로 묶기 — 어시스턴트 요청 하나가 한 단계 ───────────────
/*
 * 어시스턴트가 도구를 여러 번 불러도 요청 하나는 실행 취소 한 단계다. 요청 중에도 사람이 손으로
 * 고칠 수 있으므로, 끼어든 손 편집은 따로 한 단계가 되고 그 뒤의 어시스턴트 명령은 새 단계다.
 * 어떻게 끼어들든 끝까지 되돌리면 바이트 단위로 처음과 같아야 한다.
 */
console.log("\n[묶기] 같은 꼬리표가 잇달아 오면 한 단계, 손 편집이 끼면 갈라진다");
{
  const pr = base();
  const s = pr.sheets[0];
  const h = new History();
  const before = serialize(pr);
  const g = { id: "req1", label: "AI: build a filter" };
  const r1 = part(s, "R1"), c1 = part(s, "C1");

  h.run(s, setParam(r1.id, "value", "10k"), [], [], g);
  h.run(s, setParam(c1.id, "value", "1u"), [], [], g);
  h.run(s, addWire({ id: "wg", pts: [[200, 0], [300, 0]] }), [], [], g);
  ok(h.depth === 1, "세 명령이 한 단계", `(${h.depth})`);
  ok(h.undoLabel === "AI: build a filter", "단계 이름은 꼬리표의 이름", `(${h.undoLabel})`);
  ok(h.undoGroup === "req1", "맨 위 단계의 꼬리표를 알 수 있다");
  const after = serialize(pr);
  h.undo(s);
  ok(serialize(pr) === before, "한 번 취소로 셋 다 되돌아온다");
  h.redo(s);
  ok(serialize(pr) === after, "다시 실행하면 셋 다 다시 적용된다");
  h.undo(s);

  // 손 편집이 끼면: [AI][손][AI] 세 단계
  h.run(s, setParam(r1.id, "value", "10k"), [], [], g);
  h.run(s, movePart(c1.id, [140, 0]), [], []);
  h.run(s, setParam(c1.id, "value", "2u2"), [], [], g);
  ok(h.depth === 3, "끼어든 손 편집이 단계를 가른다", `(${h.depth})`);
  ok(h.undoGroup === "req1" && h.undoLabel === "AI: build a filter", "뒤쪽 어시스턴트 단계도 같은 이름");
  h.undo(s);
  ok(h.undoGroup === undefined && h.undoLabel === "Move part", "그다음은 손 편집 단계");
  while (h.undo(s) !== undefined) { /* 끝까지 */ }
  ok(serialize(pr) === before, "끝까지 되돌리면 처음과 바이트 단위로 같다");

  // 다른 꼬리표는 붙지 않는다
  h.run(s, setParam(r1.id, "value", "1"), [], [], { id: "a", label: "AI: a" });
  h.run(s, setParam(r1.id, "value", "2"), [], [], { id: "b", label: "AI: b" });
  ok(h.depth === 2, "꼬리표가 다르면 다른 단계", `(${h.depth})`);

  // 한계를 세는 단위는 단계다. 묶인 명령이 많아도 한 단계다
  const h2 = new History(3);
  for (let i = 0; i < 50; i++) h2.run(s, setParam(r1.id, "value", String(i)), [], [], { id: "big", label: "AI: big" });
  ok(h2.depth === 1, "명령 50개가 묶이면 한 단계 (한계 3에 걸리지 않는다)", `(${h2.depth})`);
}

// ── 9. 해석 설정 · .meas · 계산기 줄도 명령으로 ────────────────────────
console.log("\n[프로젝트 값] 해석 설정 · .meas · 계산기 줄이 실행 취소 기록에 남는다");
{
  const pr = base();
  const s = pr.sheets[0];
  const h = new History();
  const before = serialize(pr);
  h.run(s, setSim(pr, { kind: "ac", sweep: "dec", points: "20", fstart: "10", fstop: "1meg" }), [], []);
  ok(pr.sim.kind === "ac", "해석 종류가 바뀐다");
  h.run(s, setMeas(pr, ["ac f3 WHEN vdb(out)=-3"]), [], []);
  h.run(s, setCalc(pr, ["a0 = dcgain(v(out)/v(in))"]), [], []);
  ok(pr.meas?.[0] === "ac f3 WHEN vdb(out)=-3" && pr.calc?.[0]?.startsWith("a0"), ".meas 와 계산기 줄이 들어간다");
  const after = serialize(pr);
  h.undo(s); h.undo(s); h.undo(s);
  ok(serialize(pr) === before, "셋 다 되돌리면 바이트 단위로 처음과 같다");
  h.redo(s); h.redo(s); h.redo(s);
  ok(serialize(pr) === after, "다시 실행하면 바이트 단위로 바꾼 뒤와 같다");

  // 바뀌기 전 값은 apply 할 때 읽는다 — 명령을 만든 뒤에 값이 바뀌어도 그 값으로 되돌아온다
  const cmd = setMeas(pr, ["tran x MAX v(out)"]);
  pr.meas = ["dc y MIN v(out)"];
  cmd.apply(s);
  cmd.revert(s);
  ok(pr.meas.length === 1 && pr.meas[0] === "dc y MIN v(out)", "되돌리면 apply 때의 값으로");

  // 명령이 넘겨받은 배열을 나중에 바꿔도 명령은 그대로다 (계산기 칸이 배열을 제자리에서 고친다)
  const rows = ["x = 1"];
  const c2 = setCalc(pr, rows);
  rows[0] = "x = 2";
  c2.apply(s);
  ok(pr.calc?.[0] === "x = 1", "넘겨받은 배열을 복사해 둔다");
}

console.log(fail === 0 ? "\n명령 패턴 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
