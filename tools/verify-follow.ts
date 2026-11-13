// 붙은 배선이 따라오는 길 검증 (src/doc/route.ts · src/doc/follow.ts).
//
// 사용자가 본 문제: 부품을 이리저리 옮기거나 한 바퀴 돌리면 배선이 꼬인 채 남았다. 꺾점이
// 쌓이고, 제 몸을 되밟고, 한 번은 저항 몸통을 가로질러 자기 다른 핀을 선분 중간에 얹었다 —
// 그림은 그럴듯한데 넷리스트에서는 저항이 단락된다. 그래서 여기서는 모양보다 먼저
// **연결이 하나도 안 바뀌는가** 를 본다. 그다음이 '꼬이지 않았는가' 다.
import { BEND, BLOCK, CellMap, EDGE_H, NOBEND, route, type RouteEnds } from "../src/doc/route.ts";
import { Follow, pinOut, simplify } from "../src/doc/follow.ts";
import { batch, setWirePts, splitWire, transform, xformPoint, type Ref } from "../src/doc/history.ts";
import { DEMOS, RC_LOWPASS } from "../src/lib/demos.ts";
import { BUILTIN } from "../src/lib/parts.ts";
import { extractNets, onSegment } from "../src/net/extract.ts";
import { symbolBox } from "../src/doc/sheet-index.ts";
import { pinAt, uid, type LibPart, type Part, type Project, type Pt, type Sheet } from "../src/doc/types.ts";
import { buildNetlist } from "../src/net/netlist.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};
const show = (pts: Pt[]) => pts.map(p => `[${p[0]},${p[1]}]`).join("");
const NONE: RouteEnds = { inDir: -1, outDir: -1, arriveDir: -1, onDir: -1 };

// ── 1. 경로 찾기 ──────────────────────────────────────────────────────
console.log("[경로] 빈 곳에서는 곧게, 아니면 꺾임 하나");
{
  const empty = () => 0;
  ok(show(route([0, 0], [100, 0], empty, NONE)!) === "[0,0][100,0]", "축이 맞으면 직선");
  const l = route([0, 0], [60, 40], empty, NONE)!;
  ok(l.length === 3, "아니면 꺾임 하나 (L 자)", show(l));
  const same = route([0, 0], [60, 40], empty, NONE)!;
  ok(show(same) === show(l), "같은 입력이면 같은 결과");
  // 도착 방향을 바라면 그 축으로 들어간다
  const down = route([0, 0], [60, 40], empty, { ...NONE, arriveDir: 1 })!;
  ok(show(down) === "[0,0][60,0][60,40]", "아래로 들어가길 바라면 마지막이 세로", show(down));
  const right = route([0, 0], [60, 40], empty, { ...NONE, arriveDir: 0 })!;
  ok(show(right) === "[0,0][0,40][60,40]", "오른쪽으로 들어가길 바라면 마지막이 가로", show(right));
}

console.log("\n[경로] 지나면 연결이 바뀌는 자리는 못 지난다");
{
  // 가운데에 몸통 상자: 직선이 막힌다
  const m = new CellMap();
  m.box(30, -10, 70, 10);
  const r = route([0, 0], [100, 0], (x, y) => m.at(x, y), NONE)!;
  const through = r.some((p, i) => i < r.length - 1 && p[1] === 0 && r[i + 1][1] === 0 && Math.min(p[0], r[i + 1][0]) < 70 && Math.max(p[0], r[i + 1][0]) > 30);
  ok(!through && r.length > 2, "몸통을 돌아간다", show(r));

  // 다른 핀(연결점)이 가는 길 위에 있다
  const pin = new CellMap();
  pin.point(50, 0);
  const rp = route([0, 0], [100, 0], (x, y) => pin.at(x, y), NONE)!;
  ok(!rp.some((p, i) => i < rp.length - 1 && p[1] === 0 && rp[i + 1][1] === 0), "핀을 밟지 않는다", show(rp));

  // 다른 배선과 겹치지 않는다 (같은 줄을 따라가면 서로의 끝이 상대 위에 놓여 이어진다)
  const w = new CellMap();
  w.wire([[20, 0], [80, 0]]);
  ok((w.at(3, 0) & EDGE_H) !== 0 && (w.at(3, 0) & NOBEND) !== 0 && (w.at(2, 0) & BLOCK) !== 0, "배선 표시: 끝은 막고, 사이는 꺾기·겹치기 금지");
  const rw = route([0, 0], [100, 0], (x, y) => w.at(x, y), NONE)!;
  ok(!rw.some((p, i) => i < rw.length - 1 && p[1] === 0 && rw[i + 1][1] === 0 && Math.max(p[0], rw[i + 1][0]) > 20 && Math.min(p[0], rw[i + 1][0]) < 80), "다른 배선을 따라가지 않는다", show(rw));

  // 세로 배선을 십자로 건너는 것은 된다 (규칙 5) — 하지만 그 위에서 꺾지는 않는다
  const v = new CellMap();
  v.wire([[50, -100], [50, 100]]);
  const rv = route([0, 0], [100, 0], (x, y) => v.at(x, y), NONE)!;
  ok(show(rv) === "[0,0][100,0]", "십자로는 건넌다", show(rv));
  const rb = route([0, 0], [100, 40], (x, y) => v.at(x, y), NONE)!;
  ok(!rb.slice(1, -1).some(p => p[0] === 50), "꺾점이 다른 배선 위에 놓이지 않는다", show(rb));

  // 몸통으로만 막혀 있으면 몸통을 지나서라도 잇는다 — 보기는 싫어도 연결은 안 바뀐다
  const wall = new CellMap();
  wall.box(40, -500, 60, 500);
  const rw2 = route([0, 0], [100, 0], (x, y) => wall.at(x, y), NONE);
  ok(rw2 !== null && show(rw2) === "[0,0][100,0]", "몸통뿐이면 지나간다 (두 번째 찾기)", rw2 ? show(rw2) : "null");
  // 연결점으로 막혀 있으면 길이 없다 (부르는 쪽이 배선을 그대로 둔다)
  const hard = new CellMap();
  for (let y = -400; y <= 400; y += 10) hard.point(50, y);
  ok(route([0, 0], [100, 0], (x, y) => hard.at(x, y), NONE) === null, "연결점으로 막혀 있으면 null");
}

console.log("\n[핀 방향] 핀 다리에서 바깥 방향을 읽는다");
{
  const d = (lib: LibPart, i: number) => pinOut(lib, i).join(",");
  ok(d(BUILTIN.r, 0) === "-1,0" && d(BUILTIN.r, 1) === "1,0", "저항: 왼쪽 핀은 왼쪽, 오른쪽 핀은 오른쪽");
  ok(d(BUILTIN.c, 0) === "0,-1" && d(BUILTIN.c, 1) === "0,1", "커패시터: 위·아래");
  ok(d(BUILTIN.gnd, 0) === "0,-1", "GND: 위");
  ok(d(BUILTIN.opamp, 2) === "1,0", "op-amp 출력: 오른쪽");
}

// ── 2. 실제 회로 ──────────────────────────────────────────────────────
/** 핀 -> 넷을 '어느 핀끼리 같은 넷인가' 로 바꾼다. 자동 이름(N001...)은 좌표 순이라 비교하지 않는다 */
function connectivity(pr: Project): string {
  const s = pr.sheets[0];
  const ex = extractNets(s, pr.library);
  const groups = new Map<string, string[]>();
  for (const [pin, net] of ex.pinNet) {
    const k = /^N\d{3,}$/.test(net) ? "auto" + [...ex.pinNet].filter(e => e[1] === net).map(e => e[0]).sort()[0] : net;
    const g = groups.get(k);
    if (g) g.push(pin); else groups.set(k, [pin]);
  }
  const labels = s.labels.map(l => l.name + "@" + (ex.netAt(l.at) === null ? "none" : "net")).sort();
  return [...groups.entries()].map(([k, v]) => (k.startsWith("auto") ? "" : k) + ":" + v.sort().join("+")).sort().join(" | ") + " || " + labels.join(" ");
}

/** 직각이고, 길이 0 이 없고, 같은 꺾점을 두 번 지나지 않는다 */
function tidy(s: Sheet): string | null {
  for (const w of s.wires) {
    const seen = new Set<string>();
    for (let i = 0; i < w.pts.length; i++) {
      const p = w.pts[i], k = p.join(",");
      if (seen.has(k)) return `${w.id} 점 반복 ${show(w.pts)}`;
      seen.add(k);
      if (i && p[0] !== w.pts[i - 1][0] && p[1] !== w.pts[i - 1][1]) return `${w.id} 대각선 ${show(w.pts)}`;
    }
    // 같은 배선의 두 선분이 겹치면 (되밟기)
    for (let i = 0; i < w.pts.length - 1; i++) for (let j = i + 1; j < w.pts.length - 1; j++) {
      if (overlap(w.pts[i], w.pts[i + 1], w.pts[j], w.pts[j + 1])) return `${w.id} 되밟기 ${show(w.pts)}`;
    }
  }
  return null;
}
function overlap(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  if (a[1] === b[1] && c[1] === d[1] && a[1] === c[1]) {
    return Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) > Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0]));
  }
  if (a[0] === b[0] && c[0] === d[0] && a[0] === c[0]) {
    return Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1])) > Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1]));
  }
  return false;
}

/** 배선이 지나는 격자점 중 그 부품의 몸통 상자 안(핀은 빼고)에 든 것의 수 */
function bodyHits(pr: Project, only: Part): number {
  const s = pr.sheets[0];
  let n = 0;
  for (const part of [only]) {
    const lib = pr.library[part.lib];
    if (!lib) continue;
    const [x0, y0, x1, y1] = symbolBox(lib, part.rot, part.mirror);
    const pins = new Set(lib.symbol.pins.map((_, i) => pinAt(part, lib, i).join(",")));
    // 이 부품에 붙어 따라온 배선만 본다 (다른 배선 위로 부품을 옮겨 놓은 것은 사용자가 한 일이다)
    const mine = s.wires.filter(w => w.pts.some(p => pins.has(p.join(","))));
    for (const w of mine) for (let i = 0; i < w.pts.length - 1; i++) {
      const a = w.pts[i], b = w.pts[i + 1];
      const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / 10;
      for (let k = 0; k <= steps; k++) {
        const x = a[0] + Math.sign(b[0] - a[0]) * 10 * k, y = a[1] + Math.sign(b[1] - a[1]) * 10 * k;
        if (x >= part.at[0] + x0 && x <= part.at[0] + x1 && y >= part.at[1] + y0 && y <= part.at[1] + y1 && !pins.has(x + "," + y)) n++;
      }
    }
  }
  return n;
}

const wireLen = (s: Sheet) => s.wires.reduce((t, w) => t + w.pts.reduce((u, p, i) => u + (i ? Math.abs(p[0] - w.pts[i - 1][0]) + Math.abs(p[1] - w.pts[i - 1][1]) : 0), 0), 0);
const corners = (s: Sheet) => s.wires.reduce((t, w) => t + Math.max(0, w.pts.length - 2), 0);

/**
 * 옮긴 핀이 **그대로 남는 것** 위에 내려앉았는가. 그러면 새 연결이 생기는 게 맞다 —
 * 사용자가 핀을 배선 위에 놓은 것과 같다. 따라온 배선이 만든 연결과 가려 보려는 것이다.
 * 그대로 남는 것: 붙지 않은 배선, 붙은 배선 중 다시 놓지 않는 구간, 다른 부품의 핀, 라벨, 접합점.
 */
function landed(pr: Project, part: Part, follow: Follow, newPins: Pt[]): boolean {
  const s = pr.sheets[0];
  const attached = new Set(follow.attach.map(a => a.wireId));
  const stays: Pt[][] = s.wires.filter(w => !attached.has(w.id)).map(w => w.pts);
  for (const a of follow.attach) for (let k = 0; k < a.keys.length - 1; k++) {
    if (a.keys[k].pin === null && a.keys[k + 1].pin === null) stays.push(a.origPts.slice(a.keys[k].i, a.keys[k + 1].i + 1));
  }
  const on = (p: Pt, pts: Pt[]) => pts.some((q, i) => i < pts.length - 1 && onSegment(p, q, pts[i + 1])) || (pts.length === 1 && pts[0][0] === p[0] && pts[0][1] === p[1]);
  for (const p of newPins) {
    if (stays.some(w => on(p, w))) return true;
    for (const o of s.parts) {
      if (o === part) continue;
      const lib = pr.library[o.lib];
      if (lib.symbol.pins.some((_, i) => { const q = pinAt(o, lib, i); return q[0] === p[0] && q[1] === p[1]; })) return true;
    }
    if (s.labels.some(l => l.at[0] === p[0] && l.at[1] === p[1])) return true;
  }
  return false;
}

/** 앱의 회전(applyXform)과 같은 순서: 따라올 배선을 찾고, 새 자세를 읽고, 한 단계로 적용 */
function rotate(pr: Project, part: Part): boolean {
  const s = pr.sheets[0];
  const refs: Ref[] = [{ kind: "part", id: part.id }];
  const xf = { rotate: 90 as const, center: part.at };
  const follow = new Follow({ sheet: s, library: pr.library, parts: [part] });
  const rigid = xformPoint(s, refs, xf);
  const cmd = transform(refs, xf, "Rotate");
  cmd.apply(s);
  const pose = { at: [part.at[0], part.at[1]] as Pt, rot: part.rot, mirror: part.mirror };
  const lib = pr.library[part.lib];
  const pins = lib.symbol.pins.map((_, i) => pinAt(part, lib, i));
  cmd.revert(s);
  const land = landed(pr, part, follow, pins);
  const shapes = follow.shapes(() => pose, rigid);
  batch("Rotate", [cmd, ...shapes.map(f => setWirePts(f.id, f.pts))]).apply(s);
  return land;
}

/** 앱의 끌기를 놓을 때와 같은 계산 */
function move(pr: Project, part: Part, d: Pt): boolean {
  const s = pr.sheets[0];
  const follow = new Follow({ sheet: s, library: pr.library, parts: [part] });
  const lib = pr.library[part.lib];
  const pins = lib.symbol.pins.map((_, i) => { const p = pinAt(part, lib, i); return [p[0] + d[0], p[1] + d[1]] as Pt; });
  const land = landed(pr, part, follow, pins);
  const shapes = follow.translated(d);
  batch("Move", [transform([{ kind: "part", id: part.id }], { move: d }), ...shapes.map(f => setWirePts(f.id, f.pts))]).apply(s);
  return land;
}

console.log("\n[한 바퀴] 모든 데모의 모든 부품을 90도씩 네 번 돌린다");
{
  let parts = 0, steps = 0, landings = 0;
  const broke: string[] = [], messy: string[] = [], longer: string[] = [];
  for (const demo of DEMOS) {
    const base = demo.build();
    const len0 = wireLen(base.sheets[0]);
    for (let k = 0; k < base.sheets[0].parts.length; k++) {
      // build() 는 부품 id 를 새로 만든다 — 비교할 연결은 같은 문서에서 읽는다
      const pr = demo.build();
      const want = connectivity(pr);
      const part = pr.sheets[0].parts[k];
      parts++;
      let landedOnce = false;
      for (let turn = 1; turn <= 4; turn++) {
        // 돌린 핀이 남아 있는 배선 위에 내려앉으면 새 연결이 맞다. 그 뒤로는 다른 회로다
        if (rotate(pr, part)) { landedOnce = true; landings++; break; }
        steps++;
        const got = connectivity(pr);
        if (got !== want) broke.push(`${demo.id} ${part.ref} ${turn * 90}°`);
        const t = tidy(pr.sheets[0]);
        if (t) messy.push(`${demo.id} ${part.ref} ${turn * 90}°: ${t}`);
      }
      if (!landedOnce && wireLen(pr.sheets[0]) > len0) longer.push(`${demo.id} ${part.ref} ${len0} -> ${wireLen(pr.sheets[0])}`);
    }
  }
  ok(broke.length === 0, `돌릴 때마다 연결이 그대로 (${parts}개 부품, ${steps}번. 핀이 남은 배선에 내려앉은 ${landings}번은 뺐다)`, broke.slice(0, 4).join("; "));
  ok(messy.length === 0, "직각 · 길이 0 없음 · 되밟기 없음", messy.slice(0, 3).join("; "));
  ok(longer.length === 0, "한 바퀴 돌고 나면 배선이 원래보다 길지 않다 (꺾점이 쌓이지 않는다)", longer.slice(0, 4).join("; "));
}

console.log("\n[제자리] RC 데모: 한 바퀴 돌린 R1 의 배선이 원래 모양으로 돌아온다");
{
  const pr = RC_LOWPASS.build();
  const before = pr.sheets[0].wires.map(w => show(w.pts)).join(" ");
  const r1 = pr.sheets[0].parts.find(p => p.ref === "R1")!;
  rotate(pr, r1);
  const quarter = pr.sheets[0].wires.map(w => show(w.pts));
  for (let i = 0; i < 3; i++) rotate(pr, r1);
  const after = pr.sheets[0].wires.map(w => show(w.pts)).join(" ");
  ok(after === before, "네 번 돌리면 처음 모양", after);
  ok(quarter.every(w => w.split("][").length <= 5), "돌린 중간에도 꺾점 셋 이하", quarter.join(" "));
}

console.log("\n[이리저리] 끌기를 여러 번 해서 한 바퀴 돌아와도 꼬이지 않는다");
{
  const pr = RC_LOWPASS.build();
  const s = pr.sheets[0];
  const want = connectivity(pr), before = s.wires.map(w => show(w.pts)).join(" ");
  const r1 = s.parts.find(p => p.ref === "R1")!;
  const path: Pt[] = [[0, -60], [120, 0], [0, 60], [-120, 0]];
  let bad = "";
  for (const d of path) {
    move(pr, r1, d);
    if (connectivity(pr) !== want) bad ||= `연결 바뀜 @${r1.at}`;
    bad ||= tidy(s) ?? "";
  }
  ok(!bad, "매 단계 연결 그대로, 꼬임 없음", bad);
  ok(s.wires.map(w => show(w.pts)).join(" ") === before, "제자리로 오면 처음 모양", s.wires.map(w => show(w.pts)).join(" "));

  // 예전에 단락이 났던 자리: 아래로 60, 오른쪽으로 60 (저항이 커패시터 옆으로)
  const p2 = RC_LOWPASS.build();
  const r = p2.sheets[0].parts.find(p => p.ref === "R1")!;
  move(p2, r, [0, 60]);
  move(p2, r, [60, 0]);
  const ex = extractNets(p2.sheets[0], p2.library);
  ok(ex.pinNet.get(r.id + ":1") !== ex.pinNet.get(r.id + ":2"), "저항 양쪽이 다른 넷 (몸통을 가로질러 단락되지 않는다)",
     `${ex.pinNet.get(r.id + ":1")} / ${ex.pinNet.get(r.id + ":2")}`);
  ok(bodyHits(p2, r) === 0, "따라온 배선이 저항 몸통을 지나지 않는다");
}

console.log("\n[무작위] 데모 부품을 아무 데나 옮겨도 (핀이 다른 것 위에 내려앉지 않는 한) 연결이 그대로");
{
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let tried = 0, used = 0;
  const broke: string[] = [], messy: string[] = [];
  for (let iter = 0; iter < 600; iter++) {
    const demo = DEMOS[Math.floor(rnd() * DEMOS.length)];
    const pr = demo.build(), s = pr.sheets[0];
    const want = connectivity(pr);
    let okSoFar = true;
    for (let step = 0; step < 4 && okSoFar; step++) {
      const part = s.parts[Math.floor(rnd() * s.parts.length)];
      const lib = pr.library[part.lib];
      tried++;
      let land: boolean;
      if (rnd() < 0.3) land = rotate(pr, part);
      else {
        const d: Pt = [Math.round((rnd() - 0.5) * 16) * 10, Math.round((rnd() - 0.5) * 16) * 10];
        // 몸통이 다른 것을 덮으면 그 위를 지나는 배선이 생긴다 — 사용자가 일부러 겹친 것이니 뺀다
        if (landsOnSomething(pr, part, lib, d)) continue;
        land = move(pr, part, d);
      }
      // 핀이 남아 있는 배선 위에 내려앉으면 새 연결이 맞다 — 그 뒤로는 다른 회로다
      if (land) break;
      used++;
      if (connectivity(pr) !== want) { broke.push(`${demo.id} #${iter}.${step} ${part.ref}`); okSoFar = false; }
      const t = tidy(s);
      if (t) { messy.push(`${demo.id} #${iter}.${step}: ${t}`); okSoFar = false; }
    }
  }
  ok(broke.length === 0, `연결이 그대로 (${used}/${tried}번 옮김)`, broke.slice(0, 4).join("; "));
  ok(messy.length === 0, "꼬임 없음", messy.slice(0, 2).join("; "));
}

/** d 만큼 옮기면 그 부품의 핀·몸통이 다른 것에 닿는가 (닿으면 새 연결이 생기는 게 맞다) */
function landsOnSomething(pr: Project, part: Part, lib: LibPart, d: Pt): boolean {
  const s = pr.sheets[0];
  const [bx0, by0, bx1, by1] = symbolBox(lib, part.rot, part.mirror);
  const x0 = part.at[0] + d[0] + bx0 - 10, x1 = part.at[0] + d[0] + bx1 + 10;
  const y0 = part.at[1] + d[1] + by0 - 10, y1 = part.at[1] + d[1] + by1 + 10;
  const inBox = (p: Pt) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  for (const o of s.parts) {
    if (o === part) continue;
    const ol = pr.library[o.lib];
    const [ox0, oy0, ox1, oy1] = symbolBox(ol, o.rot, o.mirror);
    if (o.at[0] + ox1 >= x0 && o.at[0] + ox0 <= x1 && o.at[1] + oy1 >= y0 && o.at[1] + oy0 <= y1) return true;
  }
  for (const w of s.wires) for (let i = 0; i < w.pts.length - 1; i++) {
    const a = w.pts[i], b = w.pts[i + 1];
    // 선분이 상자를 지나면
    if (Math.max(a[0], b[0]) >= x0 && Math.min(a[0], b[0]) <= x1 && Math.max(a[1], b[1]) >= y0 && Math.min(a[1], b[1]) <= y1) {
      // 이 부품에 붙은 배선의 붙은 끝이 상자 안인 것은 괜찮다 — 그 배선은 따라온다
      const own = lib.symbol.pins.some((_, k) => { const p = pinAt(part, lib, k); return w.pts.some(q => q[0] === p[0] && q[1] === p[1]); });
      if (!own) return true;
    }
  }
  for (const l of s.labels) if (inBox(l.at)) return true;
  return false;
}

// ── 예전 고무줄 검증에서 가져온 것 (끌기에서 지켜야 하는 것은 그대로다) ─────────────
console.log("\n[실전] RC 데모에서 R1 을 축 밖으로 끌어도 넷이 안 바뀐다");
{
  const pr = RC_LOWPASS.build();
  const s = pr.sheets[0];
  const r1 = s.parts.find(p => p.ref === "R1")!;
  const line0 = buildNetlist(s, pr.library, extractNets(s, pr.library), pr.sim, "x").split("\n").find(l => l.startsWith("R1"));
  const follow = new Follow({ sheet: s, library: pr.library, parts: [r1] });
  ok(follow.attach.length === 2, "R1 양쪽에 배선이 붙어 있다", `${follow.attach.length}개`);
  move(pr, r1, [0, 30]);
  const ex = extractNets(s, pr.library);
  const line1 = buildNetlist(s, pr.library, ex, pr.sim, "x").split("\n").find(l => l.startsWith("R1"));
  ok(line1 === line0, "끌어도 SPICE 줄이 그대로", `${line0} -> ${line1}`);
  ok([...ex.nets.keys()].sort().join(",") === "0,in,out", "넷 이름도 그대로", [...ex.nets.keys()].sort().join(","));
  ok(!tidy(s), "따라온 배선이 직각이고 길이 0 없음", tidy(s) ?? "");
  /*
   * 새 선분이 배선의 앞부분을 되밟으면 분기가 없는 자리에 가짜 접합점이 찍힌다 (사용자는
   * 연결된 줄로 읽는다). 그 회귀를 여기서 막는다.
   */
  const js = ex.junctions.map(p => `[${p[0]},${p[1]}]`).sort().join(" ");
  ok(js === "[0,60]", "가짜 접합점이 생기지 않는다 (GND 자리 하나뿐)", js);
}

console.log("\n[T 자] 배선 한가운데에 닿은 부품을 옮겨도 연결이 그대로");
{
  // [0,0]-[120,0] 배선 한가운데 [60,0] 에 커패시터 윗핀이 얹혀 있다
  const library = { c: BUILTIN.c };
  const cap: Part = { id: uid(), lib: "c", ref: "C1", at: [60, 20], rot: 0, mirror: false, params: {} };
  const pr = { library, sheets: [{ id: "s", name: "s", parts: [cap], wires: [{ id: uid(), pts: [[0, 0], [120, 0]] as Pt[] }], labels: [], junctions: [], probes: [], spice: [], notes: [] }] } as unknown as Project;
  const sheet = pr.sheets[0];
  const before = extractNets(sheet, library);
  ok(!!before.pinNet.get(cap.id + ":1"), "옮기기 전에는 배선과 한 넷");
  const f = new Follow({ sheet, library, parts: [cap] });
  ok(f.attach.length === 1 && f.attach[0].keys.some(k => k.pin !== null && k.i > 0 && k.i < f.attach[0].origPts.length - 1),
     "배선 가운데의 핀을 움직이는 마디로 잡는다");
  move(pr, cap, [0, 30]);
  const after = extractNets(sheet, library);
  const moved = pinAt(cap, library.c, 0);
  const wireNet = after.netAt([0, 0]);
  ok(after.pinNet.get(cap.id + ":1") === wireNet, "옮긴 뒤에도 배선과 한 넷", `${after.pinNet.get(cap.id + ":1")} / ${wireNet}`);
  ok(after.nets.size === before.nets.size, "넷 수가 그대로", `${before.nets.size} -> ${after.nets.size}`);
  ok(!tidy(sheet), "직각 · 되밟기 없음", show(sheet.wires[0].pts));
  // 핀이 배선을 타면 가지가 셋이라 접합점이 맞다. 볼 것은 그 점이 핀을 따라갔는가다
  ok(after.junctions.length === before.junctions.length && after.junctions.every(p => p[0] === moved[0] && p[1] === moved[1]),
     "접합점이 핀을 따라간다", after.junctions.map(p => `[${p}]`).join(" "));
}

console.log("\n[정리] 군더더기 꺾점을 뺀다");
{
  const same = (a: Pt[], b: Pt[]) => show(a) === show(b);
  ok(same(simplify([[0, 0], [50, 0], [100, 0]]), [[0, 0], [100, 0]]), "일직선 가운데 점을 뺀다");
  ok(same(simplify([[0, 0], [0, 0], [100, 0]]), [[0, 0], [100, 0]]), "같은 점 반복을 뺀다");
  ok(same(simplify([[0, 0], [100, 0], [100, 50]]), [[0, 0], [100, 0], [100, 50]]), "진짜 꺾점은 남긴다");
  ok(same(simplify([[0, 0], [50, 0], [100, 0], [100, 50], [100, 90]]), [[0, 0], [100, 0], [100, 90]]), "여러 개를 한 번에");
  // 되돌아가는 점은 일직선이어도 사이에 있지 않으므로 남긴다 (되밟기를 숨기지 않는다)
  ok(same(simplify([[0, 0], [100, 0], [50, 0]]), [[0, 0], [100, 0], [50, 0]]), "되돌아가는 꺾점은 남긴다");
}

console.log("\n[선분 삭제] 배선이 갈라지거나 짧아진다");
{
  const pts: Pt[] = [[0, 0], [0, 40], [60, 40], [60, 80]];
  const mid = splitWire(pts, 1);
  ok(mid.length === 2 && JSON.stringify(mid[0]) === "[[0,0],[0,40]]" && JSON.stringify(mid[1]) === "[[60,40],[60,80]]",
     "가운데를 빼면 둘로 갈라진다", JSON.stringify(mid));
  const first = splitWire(pts, 0);
  ok(first.length === 1 && first[0].length === 3, "첫 선분을 빼면 하나만 남는다", JSON.stringify(first));
  const last = splitWire(pts, 2);
  ok(last.length === 1 && last[0].length === 3, "끝 선분도 마찬가지", JSON.stringify(last));
  ok(splitWire([[0, 0], [10, 0]], 0).length === 0, "선분 하나짜리 배선은 통째로 사라진다");
  const copy = JSON.stringify(pts);
  splitWire(pts, 1)[0][0][0] = 999;
  ok(JSON.stringify(pts) === copy, "원본을 건드리지 않는다 (실행 취소가 되돌릴 모양)");
}

void BEND;
console.log(fail === 0 ? "\n따라오는 배선 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
