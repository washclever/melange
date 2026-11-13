// 넷 추출 동등성 검증.
//
// src/net/extract.ts 는 속도 때문에 숫자 키로 다시 짰다. 바뀐 것은 속도뿐이어야 한다 —
// 자동 넷 이름(N001...)은 union 순서에 따라 정해지므로, 순서를 하나만 잘못 옮겨도 같은
// 회로가 다른 이름을 받고 넷리스트가 달라진다. 화면으로는 절대 못 찾는 종류다.
// 그래서 얼려 둔 예전 구현(tools/ref/extract-ref.ts)과 결과를 **통째로** 비교한다:
// 핀→넷, 넷→좌표(순서까지), 접합점, 떠 있는 핀, 끊긴 배선 끝, 치울 접합점, 경고, 좌표→넷.
import { extractNets, type Extraction } from "../src/net/extract.ts";
import { extractNetsRef } from "./ref/extract-ref.ts";
import { BUILTIN, defaultParams } from "../src/lib/parts.ts";
import { DEMOS } from "../src/lib/demos.ts";
import { emptyProject, pinAt, type LibPart, type Part, type Pt, type Sheet } from "../src/doc/types.ts";
import { checkCircuit } from "../src/net/netlist.ts";

/*
 * 실행 전 검사의 '떠 있는 핀' 은 이제 넷 추출이 바로 구해 준다(ex.floating). 예전 방식(pinNet 으로
 * 넷마다 핀을 세고 nets 로 좌표를 세는 것)과 문제 목록이 한 줄도 다르지 않은지 같이 본다.
 */
function issuesBothWays(s: Sheet, lib: Record<string, LibPart>): [string, string] {
  const ex = extractNets(s, lib);
  const ref = extractNetsRef(s, lib);
  const old = { ...ref, netSize: (n: string) => ref.nets.get(n)?.length ?? 0, netCount: ref.nets.size, netNames: () => [...ref.nets.keys()] };
  return [JSON.stringify(checkCircuit(s, lib, ex)), JSON.stringify(checkCircuit(s, lib, old as never))];
}

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

/** 두 추출 결과가 같은가. 다르면 처음 어긋난 곳을 알려 준다 */
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
  ];
  for (const [name, x, y] of pairs) {
    const sx = j(x), sy = j(y);
    if (sx !== sy) {
      let i = 0;
      while (i < sx.length && sx[i] === sy[i]) i++;
      return `${name} 가 다르다 @${i}: ${sx.slice(Math.max(0, i - 40), i + 40)} | ${sy.slice(Math.max(0, i - 40), i + 40)}`;
    }
  }
  for (const p of probes) {
    const x = a.netAt(p), y = b.netAt(p);
    if (x !== y) return `netAt(${p}) 가 다르다: ${x} | ${y}`;
  }
  // 새로 생긴 조회(넷 수·넷 크기)는 nets 를 만들지 않고 답한다. 만든 것과 같아야 한다
  if (a.netCount !== b.nets.size) return `netCount ${a.netCount} | nets.size ${b.nets.size}`;
  for (const [name, pts] of b.nets) {
    if (a.netSize(name) !== pts.length) return `netSize(${name}) ${a.netSize(name)} | ${pts.length}`;
  }
  if (a.netSize("이런 넷은 없다") !== 0) return "없는 넷의 크기가 0 이 아니다";
  if ([...a.netNames()].sort().join("|") !== [...b.nets.keys()].sort().join("|")) return "netNames 가 nets 의 이름과 다르다";
  return null;
}

/** 좌표→넷을 물어볼 점들: 모든 연결점, 선분 가운데, 격자 위 아무 데, 격자 밖 */
function probePoints(s: Sheet, lib: Record<string, LibPart>, rnd: () => number, extra = 60): Pt[] {
  const out: Pt[] = [];
  for (const w of s.wires) {
    for (const p of w.pts) out.push([p[0], p[1]]);
    for (let i = 0; i < w.pts.length - 1; i++) {
      const a = w.pts[i], b = w.pts[i + 1];
      out.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      out.push([Math.round((a[0] + b[0]) / 20) * 10, Math.round((a[1] + b[1]) / 20) * 10]);
    }
  }
  for (const part of s.parts) {
    const l = lib[part.lib];
    if (l) l.symbol.pins.forEach((_, i) => out.push(pinAt(part, l, i)));
  }
  for (let i = 0; i < extra; i++) {
    out.push([Math.round((rnd() * 2 - 1) * 60) * 10, Math.round((rnd() * 2 - 1) * 60) * 10]);
    out.push([(rnd() * 2 - 1) * 600, (rnd() * 2 - 1) * 600]);
  }
  return out;
}

// ── 1. 데모 회로 ──────────────────────────────────────────────────────
console.log("[데모] 아홉 개 데모에서 예전 구현과 같다");
{
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let bad = 0, why = "";
  for (const d of DEMOS) {
    const pr = d.build();
    const s = pr.sheets[0];
    const r = diff(extractNets(s, pr.library), extractNetsRef(s, pr.library), probePoints(s, pr.library, rnd));
    if (r) { bad++; why ||= `${d.name}: ${r}`; }
  }
  ok(bad === 0, `데모 ${DEMOS.length}개 전부 일치`, why);
}

// ── 2. 무작위 회로 ────────────────────────────────────────────────────
console.log("\n[무작위] 핀·배선·라벨·접합점이 마구 겹치는 회로에서 예전 구현과 같다");
{
  let seed = 20261110;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
  const libs = ["r", "c", "l", "vdc", "vsin", "vpulse", "d", "npn", "pnp", "nmos", "pmos", "opamp", "gnd", "sky130_nfet"]
    .filter(k => BUILTIN[k]);
  const names = ["out", "OUT", "in", "Vcc", "vcc", "N001", "n002", "x", " ", "gnd"];

  let bad = 0, why = "", cases = 0, badIssues = 0, whyIssues = "";
  for (let t = 0; t < 400; t++) {
    const pr = emptyProject("rnd");
    for (const k of Object.keys(BUILTIN)) pr.library[k] = structuredClone(BUILTIN[k]);
    const s = pr.sheets[0];
    // 좁은 판에 몰아넣어야 우연한 겹침(T 자, 십자, 핀끼리 맞닿음)이 많이 생긴다
    const span = 8 + Math.floor(rnd() * 30);
    const G = () => Math.round((rnd() * 2 - 1) * span) * 10;
    const anchors: Pt[] = [];

    const nParts = Math.floor(rnd() * 25);
    for (let i = 0; i < nParts; i++) {
      const lib = rnd() < 0.03 ? "nope" : pick(libs);
      const part: Part = {
        id: "p" + i, lib, ref: (BUILTIN[lib]?.refPrefix ?? "Z") + (1 + Math.floor(rnd() * 9)),
        at: [G(), G()], rot: pick([0, 90, 180, 270] as const), mirror: rnd() < 0.3,
        params: BUILTIN[lib] ? defaultParams(BUILTIN[lib]) : {},
      };
      s.parts.push(part);
      const l = pr.library[lib];
      if (l) l.symbol.pins.forEach((_, k) => anchors.push(pinAt(part, l, k)));
    }

    const nWires = Math.floor(rnd() * 40);
    for (let i = 0; i < nWires; i++) {
      const n = rnd() < 0.08 ? 1 : 2 + Math.floor(rnd() * 3);
      const pts: Pt[] = [];
      let cur: Pt = anchors.length && rnd() < 0.5 ? [...pick(anchors)] as Pt : [G(), G()];
      pts.push(cur);
      for (let k = 1; k < n; k++) {
        const r = rnd();
        let next: Pt;
        if (r < 0.35 && anchors.length) next = [...pick(anchors)] as Pt;               // 핀이나 다른 점에 붙인다
        else if (r < 0.65) next = [cur[0], G()];                                       // 세로
        else if (r < 0.9) next = [G(), cur[1]];                                        // 가로
        else if (r < 0.95) next = [cur[0], cur[1]];                                    // 같은 점이 두 번
        else next = [G(), G()];                                                        // 대각선
        pts.push(next);
        cur = next;
      }
      // 가끔 격자 밖·범위 밖 좌표 (문자열 키로 떨어지는 길)
      if (rnd() < 0.03) pts.push([cur[0] + 5.5, cur[1]]);
      if (rnd() < 0.01) pts.push([2 ** 26, cur[1]]);
      s.wires.push({ id: "w" + i, pts });
      for (const p of pts) anchors.push(p);
    }

    const nLabels = Math.floor(rnd() * 10);
    for (let i = 0; i < nLabels; i++) {
      s.labels.push({
        id: "l" + i, name: pick(names), at: anchors.length && rnd() < 0.8 ? [...pick(anchors)] as Pt : [G(), G()],
        kind: pick(["label", "label", "power", "gnd"] as const),
      });
    }
    const nJ = Math.floor(rnd() * 6);
    for (let i = 0; i < nJ; i++) s.junctions.push(anchors.length && rnd() < 0.7 ? [...pick(anchors)] as Pt : [G(), G()]);

    const r = diff(extractNets(s, pr.library), extractNetsRef(s, pr.library), probePoints(s, pr.library, rnd, 20));
    cases++;
    if (r) { bad++; why ||= `#${t}: ${r}`; }
    const [a, b] = issuesBothWays(s, pr.library);
    if (a !== b) { badIssues++; whyIssues ||= `#${t}: ${a.slice(0, 200)} | ${b.slice(0, 200)}`; }
  }
  ok(bad === 0, `무작위 회로 ${cases}개 전부 일치`, why);
  ok(badIssues === 0, "실행 전 검사의 문제 목록도 예전 방식과 같다 (떠 있는 핀 포함)", whyIssues);
}

// ── 3. 큰 합성 시트 (tools/bench.ts 와 같은 모양) ─────────────────────
console.log("\n[규모] 부품 2,000개 합성 시트에서도 같고, 더 빠르다");
{
  const pr = emptyProject("bench");
  for (const k of Object.keys(BUILTIN)) pr.library[k] = structuredClone(BUILTIN[k]);
  const s = pr.sheets[0];
  for (let i = 0; i < 2000; i++) {
    const at: Pt = [(i % 40) * 80, Math.floor(i / 40) * 80];
    s.parts.push({ id: "p" + i, lib: "r", ref: "R" + (i + 1), at, rot: 0, mirror: false, params: defaultParams(BUILTIN.r) });
    for (let w = 0; w < 3; w++) {
      const y = at[1] + (w - 1) * 20;
      s.wires.push({ id: `w${i}_${w}`, pts: [[at[0] + 20, y], [at[0] + 60, y]] });
    }
  }
  s.parts.push({ id: "gnd", lib: "gnd", ref: "GND1", at: [-80, 0], rot: 0, mirror: false, params: {} });
  s.wires.push({ id: "wg", pts: [[-80, 0], [-20, 0]] });
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const r = diff(extractNets(s, pr.library), extractNetsRef(s, pr.library), probePoints(s, pr.library, rnd, 200));
  ok(r === null, "결과가 같다", r ?? "");

  const time = (f: () => void) => { let best = Infinity; for (let i = 0; i < 5; i++) { const t = performance.now(); f(); best = Math.min(best, performance.now() - t); } return best; };
  const tNew = time(() => extractNets(s, pr.library));
  const tOld = time(() => extractNetsRef(s, pr.library));
  ok(tNew < tOld, "새 구현이 더 빠르다", `(${tOld.toFixed(1)} ms -> ${tNew.toFixed(1)} ms, ${(tOld / tNew).toFixed(1)}배)`);
}

console.log(fail === 0 ? "\n넷 추출 동등성: 모두 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
