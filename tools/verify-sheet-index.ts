// 시트 색인 검증 (src/doc/sheet-index.ts).
//
// 색인은 두 가지를 약속한다. 둘 다 틀리면 화면으로는 거의 못 찾는다.
//  1) 자리로 물으면 상자가 겹치는 객체를 **하나도 빠뜨리지 않는다** — 빠뜨리면 그 부품은
//     클릭이 안 되거나, 스냅이 안 되거나, 화면에서 사라진다.
//  2) "연결은 안 바뀌었다" 고 하면 정말로 넷 추출 결과가 그대로다 — 틀리면 넷리스트가
//     낡은 채로 시뮬레이션에 나간다.
// 무작위 회로에 무작위 편집(명령·실행 취소·다시 실행)을 수백 번 하면서 매번 확인한다.
import { SheetIndex, symbolBox, type IndexedKind } from "../src/doc/sheet-index.ts";
import {
  History, addJunction, addLabel, addPart, addProbe, addWire, batch, removeJunction, removeObjects,
  renameLabel, setParam, setRef, setWirePts, toggleNc, transform, type Command,
} from "../src/doc/history.ts";
import { extractNets, type Extraction } from "../src/net/extract.ts";
import { BUILTIN, defaultParams } from "../src/lib/parts.ts";
import { emptyProject, type Part, type Pt, type Sheet } from "../src/doc/types.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

let seed = 4242;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const G = () => Math.round((rnd() * 2 - 1) * 40) * 10;

const pr = emptyProject("idx");
for (const k of Object.keys(BUILTIN)) pr.library[k] = structuredClone(BUILTIN[k]);
const s: Sheet = pr.sheets[0];
const libs = ["r", "c", "vdc", "d", "npn", "nmos", "opamp", "gnd"];
let uid = 0;
const newPart = (): Part => {
  const lib = pick(libs);
  return { id: "p" + ++uid, lib, ref: BUILTIN[lib].refPrefix + uid, at: [G(), G()], rot: pick([0, 90, 180, 270] as const), mirror: rnd() < 0.3, params: defaultParams(BUILTIN[lib]) };
};
for (let i = 0; i < 40; i++) s.parts.push(newPart());
for (let i = 0; i < 60; i++) s.wires.push({ id: "w" + ++uid, pts: [[G(), G()], [G(), G()]] });
for (let i = 0; i < 8; i++) s.labels.push({ id: "l" + ++uid, name: pick(["a", "b", "VCC"]), at: [G(), G()], kind: pick(["label", "power"] as const) });

/** 색인과 같은 규칙으로, 그러나 색인 없이 구한 상자 */
function boxOf(kind: IndexedKind, o: any): [number, number, number, number] {
  if (kind === "part") {
    const lib = pr.library[o.lib];
    if (!lib) return [o.at[0] - 8, o.at[1] - 8, o.at[0] + 8, o.at[1] + 8];
    const [a, b, c, d] = symbolBox(lib, o.rot, o.mirror);
    return [o.at[0] + a, o.at[1] + b, o.at[0] + c, o.at[1] + d];
  }
  if (kind === "wire") {
    const xs = o.pts.map((p: Pt) => p[0]), ys = o.pts.map((p: Pt) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (kind === "label") return [o.at[0], o.at[1] - 8, o.at[0] + o.name.length * 5 + 6, o.at[1] + 8];
  return [o.at[0], o.at[1], o.at[0], o.at[1]];
}

const fingerprint = (e: Extraction) => JSON.stringify([[...e.pinNet], [...e.nets], e.junctions, e.danglingPins, e.looseEnds, e.warnings]);

const idx = new SheetIndex();
const h = new History(1000);
let ex = extractNets(s, pr.library);
idx.sync(s, pr.library);

let queryMiss = 0, queryExtra = 0, staleNets = 0, lostChange = 0, steps = 0, skipped = 0, getMiss = 0;
const any = <T,>(arr: T[]) => (arr.length ? pick(arr) : null);

for (let step = 0; step < 600; step++) {
  // ── 무작위 편집 하나
  const before = { parts: new Map(s.parts.map(p => [p.id, JSON.stringify([p.at, p.rot, p.mirror, p.lib, p.nc])])), wires: new Map(s.wires.map(w => [w.id, JSON.stringify(w.pts)])) };
  const r = rnd();
  let cmd: Command | null = null;
  const p = any(s.parts), w = any(s.wires), l = any(s.labels);
  if (r < 0.1) cmd = addPart(newPart());
  else if (r < 0.18 && p) cmd = transform([{ kind: "part", id: p.id }], { move: [G() / 4, G() / 4] });
  else if (r < 0.24 && p) cmd = transform([{ kind: "part", id: p.id }], { rotate: 90 });
  else if (r < 0.3 && p) cmd = setParam(p.id, "value", String(Math.floor(rnd() * 100)));     // 연결 안 바뀜
  else if (r < 0.34 && p) cmd = setRef(p.id, "X" + Math.floor(rnd() * 100));                // 연결 안 바뀜
  else if (r < 0.38 && p && BUILTIN[p.lib].symbol.pins.length) cmd = toggleNc(p.id, BUILTIN[p.lib].symbol.pins[0].id);
  else if (r < 0.48) cmd = addWire({ id: "w" + ++uid, pts: [[G(), G()], [G(), G()], [G(), G()]] });
  else if (r < 0.56 && w) cmd = setWirePts(w.id, [[G(), G()], [G(), G()]]);
  else if (r < 0.64) {
    const refs = [p && { kind: "part" as const, id: p.id }, w && { kind: "wire" as const, id: w.id }, l && { kind: "label" as const, id: l.id }].filter(Boolean) as any;
    cmd = removeObjects(refs);
  }
  else if (r < 0.7) cmd = addLabel({ id: "l" + ++uid, name: pick(["a", "b", "c", "VCC"]), at: [G(), G()], kind: "label" });
  else if (r < 0.74 && l) cmd = renameLabel(l.id, pick(["a", "b", "zz"]));
  else if (r < 0.78) cmd = addJunction([G(), G()]);
  else if (r < 0.8 && s.junctions.length) cmd = removeJunction(s.junctions[0]);
  else if (r < 0.84) cmd = addProbe({ id: "q" + ++uid, at: [G(), G()], color: "--t1" });
  else if (r < 0.88 && p && w) cmd = batch("Move", [transform([{ kind: "part", id: p.id }, { kind: "wire", id: w.id }], { move: [10, 0] })]);
  if (cmd) h.run(s, cmd, null, null);
  else if (r < 0.95) h.undo(s);
  else h.redo(s);

  // ── 색인을 맞추고 확인한다
  const ch = idx.sync(s, pr.library);
  steps++;
  if (ch.connectivity) ex = extractNets(s, pr.library);
  else {
    skipped++;
    if (fingerprint(extractNets(s, pr.library)) !== fingerprint(ex)) staleNets++;
  }
  // 모양이 바뀐 것은 changed 에 들어 있어야 한다 (그리기 쪽이 이것만 다시 만든다)
  const changedIds = new Set(ch.changed.map(e => (e.obj as { id: string }).id));
  for (const q of s.parts) {
    const now = JSON.stringify([q.at, q.rot, q.mirror, q.lib, q.nc]);
    if (before.parts.get(q.id) !== now && !changedIds.has(q.id)) lostChange++;
  }
  for (const q of s.wires) {
    if (before.wires.get(q.id) !== JSON.stringify(q.pts) && !changedIds.has(q.id)) lostChange++;
  }
  // 자리로 묻기: 무작위 상자 몇 개를 전수 조사와 비교한다
  for (let k = 0; k < 4; k++) {
    const x0 = G(), y0 = G(), x1 = x0 + Math.abs(G()), y1 = y0 + Math.abs(G());
    const got = new Set(idx.query(x0, y0, x1, y1).map(e => e.obj));
    const want = new Set<object>();
    for (const [kind, arr] of [["part", s.parts], ["wire", s.wires], ["label", s.labels], ["probe", s.probes]] as const) {
      for (const o of arr as any[]) {
        const [a, b, c, d] = boxOf(kind, o);
        if (!(c < x0 || a > x1 || d < y0 || b > y1)) want.add(o);
      }
    }
    for (const o of want) if (!got.has(o)) queryMiss++;
    for (const o of got) if (!want.has(o)) queryExtra++;
  }
  for (const q of s.parts) if (idx.get("part", q.id) !== q) getMiss++;
}

ok(queryMiss === 0 && queryExtra === 0, "자리로 물은 결과가 전수 조사와 같다", `(빠짐 ${queryMiss}, 더함 ${queryExtra})`);
ok(staleNets === 0, "'연결 안 바뀜' 이라고 한 편집에서 넷 추출 결과가 정말 그대로다", `(${skipped}/${steps} 번 건너뜀, 틀림 ${staleNets})`);
ok(skipped > 30, "값·지정자·미연결 표시·프로브 편집은 넷 추출을 건너뛴다", `(${skipped}번)`);
ok(lostChange === 0, "모양이 바뀐 객체는 빠짐없이 '바뀜' 으로 나온다", `(빠짐 ${lostChange})`);
ok(getMiss === 0, "id 로 찾기가 지금 객체를 준다", `(틀림 ${getMiss})`);

// ── 문서를 통째로 바꾸면 처음부터 다시 만든다
{
  const other = emptyProject("other");
  for (const k of Object.keys(BUILTIN)) other.library[k] = structuredClone(BUILTIN[k]);
  other.sheets[0].parts.push({ id: "z1", lib: "r", ref: "R1", at: [0, 0], rot: 0, mirror: false, params: { value: "1k" } });
  const ch = idx.sync(other.sheets[0], other.library);
  ok(ch.reset && ch.connectivity && idx.query(-100, -100, 100, 100).length === 1, "다른 시트로 바꾸면 색인이 새로 시작한다");
}

console.log(fail === 0 ? "\n시트 색인 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
