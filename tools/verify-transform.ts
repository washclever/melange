// 회전·대칭·이동 검증 (설계서 E09 · E10).
//
// 핵심 불변조건: 부품을 돌리거나 뒤집어도 '그림'과 '핀 좌표'가 같이 움직여야 한다.
// 둘이 어긋나면 화면은 멀쩡한데 연결만 조용히 바뀐다 — 제일 찾기 어려운 버그다.
import { transform, removeObjects, addObjects, addJunction, History, type Ref } from "../src/doc/history.ts";
import { BUILTIN, defaultParams } from "../src/lib/parts.ts";
import { GRID, emptyProject, pinAt, serialize, transform as pinXf, type Part, type Pt, type Project, type Sheet } from "../src/doc/types.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};
const eq = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];
const show = (p: Pt) => `[${p[0]},${p[1]}]`;

let n = 0;
function base(): Project {
  const pr = emptyProject("transform test");
  for (const k of Object.keys(BUILTIN)) pr.library[k] = structuredClone(BUILTIN[k]);
  return pr;
}
function addPart(s: Sheet, lib: string, at: Pt): Part {
  const p: Part = { id: "p" + ++n, lib, ref: "X" + n, at, rot: 0, mirror: false, params: defaultParams(BUILTIN[lib]) };
  s.parts.push(p);
  return p;
}
const R = (kind: Ref["kind"], id: string): Ref => ({ kind, id });

// ── 1. 핀이 격자 위에 남는다 ──────────────────────────────────────────
console.log("[불변조건] 어떤 회전·대칭 뒤에도 핀은 격자 위에 있다");
{
  let bad = 0;
  for (const lib of Object.keys(BUILTIN)) {
    const pr = base(), s = pr.sheets[0];
    const p = addPart(s, lib, [50, 30]);
    for (const xf of [{ rotate: 90 }, { rotate: 180 }, { rotate: 270 }, { flip: "x" }, { flip: "y" }] as const) {
      transform([R("part", p.id)], xf as never).apply(s);
      const lp = pr.library[lib];
      for (let i = 0; i < lp.symbol.pins.length; i++) {
        const w = pinAt(p, lp, i);
        if (w[0] % GRID !== 0 || w[1] % GRID !== 0) {
          console.log(`      ${lib} ${JSON.stringify(xf)}: 핀 ${i} 가 ${show(w)}`);
          bad++;
        }
      }
    }
  }
  ok(bad === 0, `내장 부품 ${Object.keys(BUILTIN).length}종 × 변환 5가지에서 핀이 전부 격자 위`);
}

// ── 2. 대칭이 그림과 핀을 같이 뒤집는다 ───────────────────────────────
console.log("\n[대칭] 핀 좌표가 실제로 거울상이 된다");
{
  // op-amp: - [-20,-10], + [-20,10], out [20,0]  (부품 원점 기준)
  const pr = base(), s = pr.sheets[0];
  const p = addPart(s, "opamp", [0, 0]);
  const lp = pr.library.opamp;
  const pins = () => lp.symbol.pins.map((_, i) => pinAt(p, lp, i));

  ok(eq(pins()[2], [20, 0]), "돌리기 전 출력은 오른쪽", show(pins()[2]));

  transform([R("part", p.id)], { flip: "x", center: [0, 0] }).apply(s);
  const after = pins();
  ok(eq(after[2], [-20, 0]), "좌우 대칭하면 출력이 왼쪽으로", show(after[2]));
  ok(eq(after[0], [20, -10]), "- 입력도 거울상", show(after[0]));
  ok(eq(after[1], [20, 10]), "+ 입력도 거울상", show(after[1]));

  // 두 번 뒤집으면 제자리
  transform([R("part", p.id)], { flip: "x", center: [0, 0] }).apply(s);
  ok(eq(pins()[2], [20, 0]) && eq(pins()[0], [-20, -10]), "두 번 뒤집으면 원래대로");
}

// ── 3. 그림과 핀이 같은 변환을 쓴다 ───────────────────────────────────
console.log("\n[일관성] 심볼 도형과 핀이 같은 변환을 거친다");
{
  const pr = base(), s = pr.sheets[0];
  const p = addPart(s, "opamp", [40, 40]);
  const lp = pr.library.opamp;
  let bad = 0;
  for (const xf of [{ rotate: 90 }, { rotate: 270 }, { flip: "x" }, { flip: "y" }] as const) {
    transform([R("part", p.id)], xf as never, "t").apply(s);
    for (let i = 0; i < lp.symbol.pins.length; i++) {
      // 렌더러가 쓰는 변환과 pinAt 이 쓰는 변환이 같은 결과를 내야 한다
      const viaRender = pinXf(lp.symbol.pins[i].at, p.rot, p.mirror);
      const expected: Pt = [p.at[0] + viaRender[0], p.at[1] + viaRender[1]];
      if (!eq(pinAt(p, lp, i), expected)) {
        console.log(`      ${JSON.stringify(xf)} 핀 ${i}: ${show(pinAt(p, lp, i))} vs ${show(expected)}`);
        bad++;
      }
    }
  }
  ok(bad === 0, "렌더러 변환과 핀 좌표가 항상 일치");
}

// ── 4. 배선이 섞인 선택도 돈다 (설계서 12-1: Pro 와 다르게 하는 것) ──
console.log("\n[묶음 변환] 배선이 섞여 있어도 함께 돈다");
{
  const pr = base(), s = pr.sheets[0];
  const p = addPart(s, "r", [0, 0]);
  s.wires.push({ id: "w1", pts: [[20, 0], [60, 0], [60, 40]] });
  s.labels.push({ id: "l1", name: "n", at: [60, 0], kind: "label" });
  s.probes.push({ id: "pb1", at: [60, 40], color: "--t1" });

  const refs = [R("part", p.id), R("wire", "w1"), R("label", "l1"), R("probe", "pb1")];
  const before = serialize(pr);

  const cmd = transform(refs, { rotate: 90, center: [0, 0] });
  cmd.apply(s);
  ok(eq(s.wires[0].pts[0], [0, -20]), "배선 꺾점이 돌았다", show(s.wires[0].pts[0]));
  ok(eq(s.labels[0].at, [0, -60]), "라벨도 돌았다", show(s.labels[0].at));
  ok(eq(s.probes[0].at, [40, -60]), "프로브도 돌았다", show(s.probes[0].at));
  ok(p.rot === 90, "부품 각도도 바뀌었다", String(p.rot));

  cmd.revert(s);
  ok(serialize(pr) === before, "되돌리면 전부 원래대로");
}

// ── 5. 이동은 자기 자신이 역이다 ──────────────────────────────────────
console.log("\n[이동] 다중 이동과 되돌리기");
{
  const pr = base(), s = pr.sheets[0];
  const a = addPart(s, "r", [0, 0]);
  const b = addPart(s, "c", [100, 0]);
  s.wires.push({ id: "w1", pts: [[20, 0], [100, -20]] });
  const before = serialize(pr);
  const cmd = transform([R("part", a.id), R("part", b.id), R("wire", "w1")], { move: [30, -20] });
  cmd.apply(s);
  ok(eq(a.at, [30, -20]) && eq(b.at, [130, -20]), "부품 둘이 같이 움직인다");
  ok(eq(s.wires[0].pts[0], [50, -20]), "배선도 같이", show(s.wires[0].pts[0]));
  cmd.revert(s);
  ok(serialize(pr) === before, "되돌리면 원래대로");
}

// ── 6. 종류를 가리지 않는 삭제 ────────────────────────────────────────
console.log("\n[삭제] 부품·배선·라벨·프로브를 한 번에");
{
  const pr = base(), s = pr.sheets[0];
  const a = addPart(s, "r", [0, 0]);
  addPart(s, "c", [100, 0]);
  s.wires.push({ id: "w1", pts: [[0, 0], [50, 0]] }, { id: "w2", pts: [[0, 50], [50, 50]] });
  s.labels.push({ id: "l1", name: "a", at: [0, 0], kind: "label" });
  s.probes.push({ id: "pb1", at: [0, 0], color: "--t1" });
  const before = serialize(pr);

  const cmd = removeObjects([R("part", a.id), R("wire", "w1"), R("label", "l1"), R("probe", "pb1")]);
  cmd.apply(s);
  ok(s.parts.length === 1 && s.wires.length === 1 && s.labels.length === 0 && s.probes.length === 0,
     "고른 것만 지워진다", `(부품 ${s.parts.length} 배선 ${s.wires.length})`);
  cmd.revert(s);
  ok(serialize(pr) === before, "되돌리면 원래 자리로 전부 복귀");
}

// ── 7. 붙여넣기와 수동 접합점 ─────────────────────────────────────────
console.log("\n[붙여넣기 · 접합점]");
{
  const pr = base(), s = pr.sheets[0];
  const before = serialize(pr);
  const p: Part = { id: "np", lib: "r", ref: "R9", at: [10, 10], rot: 0, mirror: false, params: { value: "1k" } };
  const cmd = addObjects([p], [{ id: "nw", pts: [[0, 0], [10, 0]] }], [], []);
  cmd.apply(s);
  ok(s.parts.length === 1 && s.wires.length === 1, "한 번에 들어간다");
  cmd.revert(s);
  ok(serialize(pr) === before, "한 번에 빠진다");

  const j = addJunction([50, 50]);
  j.apply(s);
  ok(s.junctions.length === 1 && eq(s.junctions[0], [50, 50]), "수동 접합점이 생긴다");
  j.revert(s);
  ok(s.junctions.length === 0, "되돌아간다");
}

// ── 8. 기록과 선택 복원 ───────────────────────────────────────────────
console.log("\n[기록] 다중 선택이 그대로 복원된다");
{
  const pr = base(), s = pr.sheets[0];
  const a = addPart(s, "r", [0, 0]);
  const b = addPart(s, "c", [100, 0]);
  const h = new History();
  const sel = ["part:" + a.id, "part:" + b.id];
  h.run(s, transform([R("part", a.id), R("part", b.id)], { move: [10, 0] }), [], sel);
  ok(h.redo(s) === undefined, "다시 실행할 것은 없다");
  const restored = h.undo(s);
  ok(Array.isArray(restored) && restored.length === 0, "취소하면 이전 선택(빈 선택)으로", JSON.stringify(restored));
  const again = h.redo(s);
  ok(Array.isArray(again) && again.length === 2, "다시 실행하면 둘 다 선택", JSON.stringify(again?.length));
}

console.log(fail === 0 ? "\n변환 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
