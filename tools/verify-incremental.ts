// 증분 넷 추출 검증 (src/net/incremental.ts).
//
// 증분 추출은 바뀐 객체의 입력만 다시 만들고 풀기는 처음부터 한다. 그 결과가 extractNets 를
// 처음부터 부른 것과 **한 글자도** 다르지 않아야 한다 — 자동 넷 이름 하나가 어긋나면 같은
// 회로가 다른 넷리스트로 시뮬레이션에 나간다. 무작위 회로에 무작위 편집(명령 · 실행 취소 ·
// 다시 실행 · 문서 갈아끼우기 · 같은 id 가 둘인 깨진 문서)을 하면서 매번 통째로 견준다.
import { IncrementalNets } from "../src/net/incremental.ts";
import { extractNets, type Extraction } from "../src/net/extract.ts";
import { SheetIndex } from "../src/doc/sheet-index.ts";
import {
  History, addJunction, addLabel, addPart, addWire, batch, removeJunction, removeObjects,
  renameLabel, setParam, setRef, setWirePts, toggleNc, transform, type Command,
} from "../src/doc/history.ts";
import { BUILTIN, defaultParams } from "../src/lib/parts.ts";
import { emptyProject, pinAt, type Part, type Project, type Pt, type Sheet } from "../src/doc/types.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

function diff(a: Extraction, b: Extraction, probes: Pt[]): string | null {
  const j = (v: unknown) => JSON.stringify(v);
  const pairs: Array<[string, unknown, unknown]> = [
    ["pinNet", [...a.pinNet], [...b.pinNet]],
    ["nets", [...a.nets], [...b.nets]],
    ["junctions", a.junctions, b.junctions],
    ["danglingPins", a.danglingPins, b.danglingPins],
    ["looseEnds", a.looseEnds, b.looseEnds],
    ["staleJunctions", a.staleJunctions, b.staleJunctions],
    ["warnings", a.warnings, b.warnings],
    ["netCount", a.netCount, b.netCount],
    ["netNames", [...a.netNames()].sort(), [...b.netNames()].sort()],
    ["floating", a.floating && [[...a.floating.pins].sort(), [...a.floating.parts].sort()], b.floating && [[...b.floating.pins].sort(), [...b.floating.parts].sort()]],
  ];
  for (const [name, x, y] of pairs) {
    const sx = j(x), sy = j(y);
    if (sx !== sy) {
      let i = 0;
      while (i < sx.length && sx[i] === sy[i]) i++;
      return `${name} @${i}: …${sx.slice(Math.max(0, i - 50), i + 50)} | …${sy.slice(Math.max(0, i - 50), i + 50)}`;
    }
  }
  for (const p of probes) if (a.netAt(p) !== b.netAt(p)) return `netAt(${p}): ${a.netAt(p)} | ${b.netAt(p)}`;
  for (const n of b.netNames()) if (a.netSize(n) !== b.netSize(n)) return `netSize(${n})`;
  return null;
}

let seed = 20261111;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const libs = ["r", "c", "vdc", "vsin", "d", "npn", "nmos", "pmos", "opamp", "gnd"];
const names = ["out", "OUT", "in", "Vcc", "vcc", "N001", "n002", "x", " ", "gnd"];

let uid = 0;
function fresh(span: number): Project {
  const pr = emptyProject("inc");
  for (const k of Object.keys(BUILTIN)) pr.library[k] = structuredClone(BUILTIN[k]);
  const s = pr.sheets[0];
  const G = () => Math.round((rnd() * 2 - 1) * span) * 10;
  for (let i = 0; i < 30; i++) s.parts.push(mkPart(G));
  for (let i = 0; i < 40; i++) s.wires.push({ id: "w" + ++uid, pts: [[G(), G()], [G(), G()]] });
  for (let i = 0; i < 6; i++) s.labels.push({ id: "l" + ++uid, name: pick(names), at: [G(), G()], kind: pick(["label", "power", "gnd"] as const) });
  return pr;
}
function mkPart(G: () => number): Part {
  const lib = rnd() < 0.03 ? "nope" : pick(libs);
  return {
    id: "p" + ++uid, lib, ref: (BUILTIN[lib]?.refPrefix ?? "Z") + (1 + Math.floor(rnd() * 9)),
    at: [G(), G()], rot: pick([0, 90, 180, 270] as const), mirror: rnd() < 0.3,
    params: BUILTIN[lib] ? defaultParams(BUILTIN[lib]) : {},
  };
}

console.log("[동등성] 무작위 편집 내내 처음부터 뽑은 결과와 같다");
let pr = fresh(20);
let s: Sheet = pr.sheets[0];
const idx = new SheetIndex();
const inc = new IncrementalNets();
let h = new History(5000);
let bad = 0, why = "", steps = 0, incremental = 0, expected = 0, rebuiltObjs = 0;

for (let step = 0; step < 700; step++) {
  const span = 20;
  const G = () => Math.round((rnd() * 2 - 1) * span) * 10;
  // 이미 있는 점에 붙여야 T 자·맞닿음이 생긴다
  const anchors: Pt[] = [];
  for (const w of s.wires) for (const p of w.pts) anchors.push(p);
  for (const part of s.parts) { const l = pr.library[part.lib]; if (l) l.symbol.pins.forEach((_, k) => anchors.push(pinAt(part, l, k))); }
  const A = (): Pt => anchors.length && rnd() < 0.6 ? [...pick(anchors)] as Pt : [G(), G()];

  const r = rnd();
  const p = s.parts.length ? pick(s.parts) : null, w = s.wires.length ? pick(s.wires) : null, l = s.labels.length ? pick(s.labels) : null;
  let cmd: Command | null = null;
  if (r < 0.08) cmd = addPart(mkPart(G));
  else if (r < 0.16 && p) cmd = transform([{ kind: "part", id: p.id }], { move: [pick([-20, -10, 10, 20]), pick([-20, 0, 20])] });
  else if (r < 0.2 && p) cmd = transform([{ kind: "part", id: p.id }], { rotate: 90 });
  else if (r < 0.22 && p) cmd = transform([{ kind: "part", id: p.id }], { flip: "x" });
  else if (r < 0.25 && p) cmd = setParam(p.id, "value", "47k");
  else if (r < 0.28 && p) cmd = setRef(p.id, "Q" + Math.floor(rnd() * 5));
  else if (r < 0.31 && p && BUILTIN[p.lib]?.symbol.pins.length) cmd = toggleNc(p.id, BUILTIN[p.lib].symbol.pins[0].id);
  else if (r < 0.43) {
    const n = 2 + Math.floor(rnd() * 3), pts: Pt[] = [A()];
    for (let k = 1; k < n; k++) pts.push(rnd() < 0.5 ? [pts[k - 1][0], G()] : A());
    cmd = addWire({ id: "w" + ++uid, pts });
  }
  else if (r < 0.5 && w) cmd = setWirePts(w.id, [A(), A()]);
  else if (r < 0.56 && w) cmd = transform([{ kind: "wire", id: w.id }], { move: [10, -10] });
  else if (r < 0.63) {
    const refs = [p && { kind: "part" as const, id: p.id }, w && { kind: "wire" as const, id: w.id }, l && rnd() < 0.3 && { kind: "label" as const, id: l.id }].filter(Boolean) as any;
    if (refs.length) cmd = removeObjects(refs);
  }
  else if (r < 0.68) cmd = addLabel({ id: "l" + ++uid, name: pick(names), at: A(), kind: pick(["label", "label", "power", "gnd"] as const) });
  else if (r < 0.71 && l) cmd = renameLabel(l.id, pick(names));
  else if (r < 0.74) cmd = addJunction(A());
  else if (r < 0.76 && s.junctions.length) cmd = removeJunction(pick(s.junctions));
  else if (r < 0.8 && p && w) cmd = batch("Move", [transform([{ kind: "part", id: p.id }, { kind: "wire", id: w.id }], { move: [0, 10] })]);
  else if (r < 0.81) {
    // 문서를 통째로 갈아끼운다 (새로 열기 · 데모)
    pr = fresh(10 + Math.floor(rnd() * 20)); s = pr.sheets[0]; h = new History(5000);
  } else if (r < 0.815 && p) {
    // 깨진 문서: 같은 id 가 둘 (실행 취소 기록 밖에서 직접 넣는다)
    s.parts.push({ ...structuredClone(p), at: [G(), G()] });
  } else if (r < 0.92) h.undo(s);
  else h.redo(s);
  if (cmd) h.run(s, cmd, null, null);

  const change = idx.sync(s, pr.library);
  const got = inc.update(s, pr.library, idx, change);
  // 처음부터 해야 하는 경우(문서 교체, 같은 id 가 둘인 깨진 문서)가 아니면 늘 증분이어야 한다
  // (깨진 문서에서 막 벗어난 첫 편집도 처음부터 한다 — 그동안 객체마다 입력을 들고 있지 않았다)
  if (!change.reset && !idx.hasDupes && inc.stats.why !== "recover") { expected++; if (!inc.stats.full) { incremental++; rebuiltObjs += inc.stats.rebuilt; } }
  const want = extractNets(s, pr.library);
  const probes: Pt[] = [...anchors.slice(0, 40), [G(), G()], [G() + 5, G()], [0, 0]];
  for (const w2 of s.wires.slice(0, 20)) for (let k = 0; k < w2.pts.length - 1; k++) {
    probes.push([Math.round((w2.pts[k][0] + w2.pts[k + 1][0]) / 20) * 10, Math.round((w2.pts[k][1] + w2.pts[k + 1][1]) / 20) * 10]);
  }
  const d = diff(got, want, probes);
  steps++;
  if (d) { bad++; if (!why) why = `step ${step}: ${d}`; }
}
ok(bad === 0, `편집 ${steps}번 모두 처음부터 뽑은 결과와 같다`, why);
ok(incremental === expected, "문서 교체·깨진 문서가 아니면 늘 바뀐 객체만 다시 만들었다",
   `(${incremental}/${expected}번, 편집마다 평균 ${(rebuiltObjs / Math.max(incremental, 1)).toFixed(1)}개 객체)`);

// ── 큰 시트에서 편집 하나가 싸다
console.log("\n[비용] 부품 1만 개 시트에서 배선 하나를 더할 때");
{
  const big = emptyProject("big");
  for (const k of Object.keys(BUILTIN)) big.library[k] = structuredClone(BUILTIN[k]);
  const bs = big.sheets[0];
  for (let i = 0; i < 10000; i++) {
    const at: Pt = [(i % 40) * 80, Math.floor(i / 40) * 80];
    bs.parts.push({ id: "b" + i, lib: "r", ref: "R" + (i + 1), at, rot: 0, mirror: false, params: { value: "1k" } });
    for (let k = 0; k < 3; k++) { const y = at[1] + (k - 1) * 20; bs.wires.push({ id: `bw${i}_${k}`, pts: [[at[0] + 20, y], [at[0] + 60, y]] }); }
  }
  bs.parts.push({ id: "g", lib: "gnd", ref: "GND1", at: [-80, 0], rot: 0, mirror: false, params: {} });
  const bi = new SheetIndex(), bn = new IncrementalNets(), bh = new History();
  bn.update(bs, big.library, bi, bi.sync(bs, big.library));
  const times: number[] = [], fulls: number[] = [];
  for (let k = 0; k < 8; k++) {
    bh.run(bs, addWire({ id: "nw" + k, pts: [[k * 80 + 20, 20], [k * 80 + 20, 60]] }), null, null);
    const t0 = performance.now();
    const ch = bi.sync(bs, big.library);
    const e1 = bn.update(bs, big.library, bi, ch);
    times.push(performance.now() - t0);
    const t1 = performance.now();
    const e2 = extractNets(bs, big.library);
    fulls.push(performance.now() - t1);
    if (k === 7 && diff(e1, e2, []) !== null) ok(false, "큰 시트에서도 결과가 같다");
  }
  times.sort((a, b) => a - b); fulls.sort((a, b) => a - b);
  const med = (a: number[]) => a[a.length >> 1];
  // 시간은 기계마다 흔들리므로 넉넉하게 본다 (보통 절반 안팎이다)
  ok(med(times) < med(fulls) * 0.8, "색인 맞추기 + 증분 추출이 처음부터 뽑기보다 확실히 빠르다",
     `(${med(times).toFixed(1)} ms vs ${med(fulls).toFixed(1)} ms)`);
}

console.log(fail === 0 ? "\n증분 넷 추출 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
