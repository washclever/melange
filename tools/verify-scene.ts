// 정적 층 도형 검증 (src/render/scene.ts).
//
// 화면은 이제 GPU 가 그린다. 그래서 '무엇을 그리는가' 가 예전과 같은지는 픽셀이 아니라
// 도형으로 확인한다: 예전 drawPart 를 가짜 캔버스에 그려 경로(moveTo·lineTo·arc·closePath)를
// 받아 적고, 새 도형 목록을 같은 화면 좌표로 옮겨 통째로 비교한다. 내장 부품 전부 × 회전 4 × 대칭 2
// × 배율 여럿. 하나라도 빠지거나 어긋나면 그 부품은 화면에서 다르게 보인다.
//
// 그다음, 바뀐 것만 다시 만드는 덩어리 관리가 처음부터 다시 만든 것과 같은 도형을 내는지
// 무작위 편집 수백 번으로 확인한다.
import { BASE, SEG, DISC, RING, STYLE, Scene, emitPart, emitWire, thick, Prims } from "../src/render/scene.ts";
import { drawPart, theme as _theme, type Theme } from "../src/render/schematic.ts";
import { SheetIndex } from "../src/doc/sheet-index.ts";
import { History, addPart, addWire, removeObjects, setParam, setWirePts, toggleNc, transform } from "../src/doc/history.ts";
import { BUILTIN, defaultParams } from "../src/lib/parts.ts";
import { emptyProject, type Part, type Pt } from "../src/doc/types.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};
void _theme;

// ── 가짜 캔버스: 경로를 선분·원으로 받아 적는다 ─────────────────────────
interface Rec { segs: string[]; discs: string[]; rings: string[]; widths: Set<number> }
function recorder(): { g: CanvasRenderingContext2D; rec: Rec } {
  const rec: Rec = { segs: [], discs: [], rings: [], widths: new Set() };
  let cur: Pt | null = null, start: Pt | null = null;
  let path: Array<{ t: "seg"; a: Pt; b: Pt } | { t: "arc"; c: Pt; r: number }> = [];
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  const key = (a: Pt, b: Pt) => {
    const p = [r6(a[0]), r6(a[1])], q = [r6(b[0]), r6(b[1])];
    // 방향은 상관없다 (선분은 양 끝이 바뀌어도 같은 선이다)
    return (p[0] < q[0] || (p[0] === q[0] && p[1] <= q[1])) ? `${p}|${q}` : `${q}|${p}`;
  };
  const g = {
    lineWidth: 1, strokeStyle: "", fillStyle: "", lineCap: "", lineJoin: "", font: "", textAlign: "", textBaseline: "",
    beginPath() { path = []; cur = start = null; },
    moveTo(x: number, y: number) { cur = start = [x, y]; },
    lineTo(x: number, y: number) { if (cur) path.push({ t: "seg", a: cur, b: [x, y] }); cur = [x, y]; },
    closePath() { if (cur && start) path.push({ t: "seg", a: cur, b: start }); cur = start; },
    arc(x: number, y: number, r: number) { path.push({ t: "arc", c: [x, y], r }); cur = [x + r, y]; },
    stroke() {
      rec.widths.add(r6(this.lineWidth));
      for (const p of path) {
        if (p.t === "seg") rec.segs.push(key(p.a, p.b) + "|w" + r6(this.lineWidth));
        else rec.rings.push(`${r6(p.c[0])},${r6(p.c[1])},${r6(p.r)}|w${r6(this.lineWidth)}`);
      }
    },
    fill() { for (const p of path) if (p.t === "arc") rec.discs.push(`${r6(p.c[0])},${r6(p.c[1])},${r6(p.r)}`); },
    fillText() {}, strokeRect() {}, fillRect() {}, setLineDash() {}, measureText: () => ({ width: 0 }),
  };
  return { g: g as unknown as CanvasRenderingContext2D, rec };
}

/** 새 도형을 같은 화면 좌표의 같은 표기로 */
function project(p: Prims, view: { at: Pt; scale: number }): Rec {
  const rec: Rec = { segs: [], discs: [], rings: [], widths: new Set() };
  const k = thick(view.scale);
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  const X = (x: number) => (x - view.at[0]) * view.scale, Y = (y: number) => (y - view.at[1]) * view.scale;
  const key = (a: Pt, b: Pt) => {
    const P = [r6(a[0]), r6(a[1])], Q = [r6(b[0]), r6(b[1])];
    return (P[0] < Q[0] || (P[0] === Q[0] && P[1] <= Q[1])) ? `${P}|${Q}` : `${Q}|${P}`;
  };
  for (const b of [p.seg, p.segTop]) {
    const d = b.data;
    for (let i = 0; i < b.length; i += SEG) {
      const w = r6(BASE[d[i + 8]] * k);
      rec.segs.push(key([X(d[i]) + d[i + 4] * k, Y(d[i + 1]) + d[i + 5] * k], [X(d[i + 2]) + d[i + 6] * k, Y(d[i + 3]) + d[i + 7] * k]) + "|w" + w);
    }
  }
  for (let i = 0; i < p.ring.length; i += RING) {
    const d = p.ring.data;
    rec.rings.push(`${r6(X(d[i]))},${r6(Y(d[i + 1]))},${r6(d[i + 2] * view.scale)}|w${r6(BASE[d[i + 3]] * k)}`);
  }
  for (let i = 0; i < p.disc.length; i += DISC) {
    const d = p.disc.data;
    rec.discs.push(`${r6(X(d[i]))},${r6(Y(d[i + 1]))},${r6(d[i + 2] * k)}`);
  }
  return rec;
}

/*
 * 같은가 — 허용 오차를 둔다. GPU 로 올리는 도형은 Float32 라서, 인덕터처럼 곡선을 점으로
 * 근사한 소수 좌표는 마지막 자리가 다르다 (화면에서 1/1000 px 아래). 표기를 숫자로 되돌려
 * 정렬한 뒤 짝지어 견준다.
 */
const nums = (k: string) => k.split(/[|,w]+/).filter(Boolean).map(Number);
const same = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false;
  const order = (x: number[], y: number[]) => { for (let i = 0; i < x.length; i++) { const d = Math.round(x[i] * 10) - Math.round(y[i] * 10); if (d) return d; } return 0; };
  const A = a.map(nums).sort(order), B = b.map(nums).sort(order);
  return A.every((x, i) => x.length === B[i].length && x.every((v, j) => Math.abs(v - B[i][j]) < 1e-3));
};

// ── 1. 부품 하나하나가 예전 drawPart 와 같은 도형이다 ─────────────────
console.log(`[도형] 부품 ${Object.keys(BUILTIN).length}종 × 회전·대칭 8가지 × 배율 4가지가 예전 drawPart 와 같다`);
{
  const t = { part: "#000", pin: "#111", junction: "#222", text: "#333", muted: "#444", bad: "#555" } as unknown as Theme;
  let cases = 0, bad = 0, why = "";
  for (const id of Object.keys(BUILTIN)) {
    const lib = BUILTIN[id];
    for (const rot of [0, 90, 180, 270] as const) for (const mirror of [false, true]) for (const scale of [0.25, 1, 2.4, 9]) {
      const part: Part = {
        id: "x", lib: id, ref: "X1", at: [130, -70], rot, mirror, params: defaultParams(lib),
        // 첫 핀에 미연결 표시를 붙여 X 도 같이 본다
        nc: lib.symbol.pins.length ? [lib.symbol.pins[0].id] : undefined,
      };
      const view = { at: [-37.5, 12.25] as Pt, scale };
      const { g, rec } = recorder();
      drawPart(g, view, part, lib, t.part, t, false, false);
      const prims = new Prims();
      emitPart(part, lib, prims);
      const got = project(prims, view);
      cases++;
      if (!same(rec.segs, got.segs)) { bad++; why ||= `${id} rot${rot} m${mirror} s${scale} 선분 ${rec.segs.length} vs ${got.segs.length}`; }
      else if (!same(rec.discs, got.discs)) { bad++; why ||= `${id} rot${rot} 원판 ${rec.discs} vs ${got.discs}`; }
      else if (!same(rec.rings, got.rings)) { bad++; why ||= `${id} rot${rot} 고리 ${rec.rings} vs ${got.rings}`; }
    }
  }
  ok(bad === 0, `${cases}가지가 선분·핀 점·원·미연결 X 까지 일치`, why);
}

// ── 2. 굵기·반지름 규칙이 예전 lw() 와 같다 ───────────────────────────
console.log("\n[굵기] 배율에 따른 굵기가 예전 lw() 와 같다");
{
  const lw = (scale: number, base: number) => Math.max(base, base * Math.min(scale / 2, 2));
  let bad = 0;
  for (const s of [0.25, 0.5, 1, 2, 3, 4, 8, 16]) {
    if (Math.abs(BASE[STYLE.wire] * thick(s) - lw(s, 1.4)) > 1e-12) bad++;
    if (Math.abs(BASE[STYLE.part] * thick(s) - lw(s, 1.3)) > 1e-12) bad++;
    if (Math.abs(BASE[STYLE.junction] * thick(s) - Math.max(2.2, lw(s, 2.4))) > 1e-12) bad++;
  }
  ok(bad === 0, "배선 1.4 · 심볼 1.3 · 접합점 2.4 (배율 0.25~16)", `(${bad}건 다름)`);
}

// ── 3. 바뀐 것만 다시 만들어도 처음부터 만든 것과 같다 ─────────────────
console.log("\n[덩어리] 바뀐 덩어리만 다시 만든 결과가 처음부터 다시 만든 것과 같다");
{
  let seed = 99;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const G = () => Math.round((rnd() * 2 - 1) * 300) * 10;
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
  const pr = emptyProject("scene");
  for (const k of Object.keys(BUILTIN)) pr.library[k] = structuredClone(BUILTIN[k]);
  const s = pr.sheets[0];
  let uid = 0;
  const mk = (): Part => {
    const lib = pick(["r", "c", "vsin", "d", "npn", "opamp", "gnd"]);
    return { id: "p" + ++uid, lib, ref: "X" + uid, at: [G(), G()], rot: pick([0, 90, 180, 270] as const), mirror: rnd() < 0.5, params: defaultParams(BUILTIN[lib]) };
  };
  for (let i = 0; i < 3000; i++) s.parts.push(mk());
  for (let i = 0; i < 4000; i++) s.wires.push({ id: "w" + ++uid, pts: [[G(), G()], [G(), G()]] });

  const idx = new SheetIndex(), scene = new Scene(), h = new History(2000);
  scene.apply(idx.sync(s, pr.library), pr.library);
  scene.flush();

  const all = (sc: Scene) => {
    const out: string[] = [];
    for (const c of [...sc.wires, ...sc.parts]) {
      const r = project(c.prims, { at: [0, 0], scale: 1 });
      out.push(...r.segs, ...r.discs.map(d => "d" + d), ...r.rings.map(d => "r" + d));
    }
    return out.sort().join("\n");
  };
  let bad = 0, rebuilt = 0, total = 0;
  for (let step = 0; step < 300; step++) {
    const r = rnd();
    const p = pick(s.parts), w = pick(s.wires);
    if (r < 0.25) h.run(s, addPart(mk()), null, null);
    else if (r < 0.45 && p) h.run(s, transform([{ kind: "part", id: p.id }], { move: [G() / 10, G() / 10] }), null, null);
    else if (r < 0.55 && p) h.run(s, toggleNc(p.id, BUILTIN[p.lib].symbol.pins[0].id), null, null);
    else if (r < 0.62 && p) h.run(s, setParam(p.id, "value", "9k"), null, null);
    else if (r < 0.75) h.run(s, addWire({ id: "w" + ++uid, pts: [[G(), G()], [G(), G()], [G(), G()]] }), null, null);
    else if (r < 0.85 && w) h.run(s, setWirePts(w.id, [[G(), G()], [G(), G()]]), null, null);
    else if (r < 0.92 && p && w) h.run(s, removeObjects([{ kind: "part", id: p.id }, { kind: "wire", id: w.id }]), null, null);
    else h.undo(s);
    scene.apply(idx.sync(s, pr.library), pr.library);
    rebuilt += scene.flush();
    total += scene.wires.length + scene.parts.length;

    if (step % 25 === 24) {
      const fresh = new Scene();
      fresh.apply(new SheetIndex().sync(s, pr.library), pr.library);
      fresh.flush();
      if (all(scene) !== all(fresh)) bad++;
    }
  }
  ok(bad === 0, "편집 300번 내내 처음부터 만든 장면과 도형이 같다", `(${bad}번 어긋남)`);
  ok(rebuilt < total * 0.2, "다시 만든 덩어리는 전체의 일부다", `(${rebuilt} / ${total} 덩어리-프레임)`);

  // 끄는 중인 객체는 덩어리에서 빠지고 live 에 그려진다
  const idx2 = new SheetIndex(), sc2 = new Scene();
  sc2.apply(idx2.sync(s, pr.library), pr.library);
  sc2.flush();
  const before = all(sc2);
  const entries = idx2.query(-3000, -3000, 3000, 3000).filter(e => e.kind === "part").slice(0, 5);
  sc2.setLive(entries);
  sc2.flush();
  const liveCount = sc2.live.disc.length + sc2.live.seg.length;
  const withLive = [all(sc2), ...[project(sc2.live, { at: [0, 0], scale: 1 })].flatMap(r => [...r.segs, ...r.discs.map(d => "d" + d), ...r.rings.map(d => "r" + d)])].join("\n");
  ok(liveCount > 0 && all(sc2) !== before, "끄기 시작하면 그 객체는 덩어리에서 빠지고 따로 그려진다");
  const merged = withLive.split("\n").filter(Boolean).sort().join("\n");
  ok(merged === before, "덩어리 + 따로 그린 것 = 원래 장면", "");
  sc2.setLive(null);
  sc2.flush();
  ok(all(sc2) === before && sc2.live.seg.length === 0, "끄기가 끝나면 덩어리로 돌아온다");
}

console.log(fail === 0 ? "\n정적 층 도형 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
