// 공간 색인 검증.
//
// 색인은 '후보를 줄이는' 장치일 뿐이라, 줄인 결과가 전수 조사와 **정확히 같아야** 한다.
// 다르면 연결이 조용히 생기거나 사라진다 — 화면으로는 못 찾는 종류다.
// 그래서 무작위 회로를 만들어 색인 결과와 전수 조사 결과를 통째로 비교한다.
import { PointIndex, CELL } from "../src/net/spatial.ts";
import { extractNets } from "../src/net/extract.ts";
import { BUILTIN, defaultParams } from "../src/lib/parts.ts";
import { emptyProject, type Part, type Pt, type Sheet } from "../src/doc/types.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

// ── 전수 조사 기준 구현 ───────────────────────────────────────────────
const onSeg = (p: Pt, a: Pt, b: Pt) => {
  if ((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]) !== 0) return false;
  return p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
    && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
};

// ── 1. near() 가 선분 위의 점을 하나도 빠뜨리지 않는다 ────────────────
console.log("[완전성] 색인이 선분 위의 점을 빠뜨리지 않는다");
{
  let seed = 20261109;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const g = (n: number) => Math.round((rnd() * 2 - 1) * n / 10) * 10;   // 격자 위 정수

  let missed = 0, extraRatio = 0, cases = 0;
  for (let t = 0; t < 300; t++) {
    const pts: Pt[] = Array.from({ length: 200 }, () => [g(1200), g(1200)] as Pt);
    const idx = new PointIndex(pts);
    const a: Pt = [g(1200), g(1200)];
    // 가로·세로·대각선을 골고루
    const b: Pt = t % 3 === 0 ? [g(1200), a[1]] : t % 3 === 1 ? [a[0], g(1200)] : [g(1200), g(1200)];

    const brute = pts.filter(p => onSeg(p, a, b));
    const viaIndex = idx.near(a, b).filter(p => onSeg(p, a, b));
    // 같은 좌표가 여러 번 들어갈 수 있으니 좌표 집합으로 비교한다
    const ks = (arr: Pt[]) => [...new Set(arr.map(p => p[0] + "," + p[1]))].sort().join(" ");
    if (ks(brute) !== ks(viaIndex)) missed++;
    if (brute.length) { extraRatio += idx.near(a, b).length / pts.length; cases++; }
  }
  ok(missed === 0, "무작위 선분 300개에서 전수 조사와 일치", `(불일치 ${missed})`);
  ok(cases > 0 && extraRatio / cases < 0.5,
     "후보가 전체의 절반 미만으로 줄어든다", `(평균 ${((extraRatio / cases) * 100).toFixed(0)}%)`);
}

// ── 2. 칸 경계에 딱 걸친 점 ───────────────────────────────────────────
console.log("\n[경계] 칸 경계에 놓인 점");
{
  const pts: Pt[] = [[0, 0], [CELL, 0], [CELL - 10, 0], [CELL * 2, 0], [CELL, CELL]];
  const idx = new PointIndex(pts);
  const found = idx.near([0, 0], [CELL * 2, 0]).filter(p => onSeg(p, [0, 0], [CELL * 2, 0]));
  // 문자열 정렬은 "160,0" < "70,0" 이라 좌표를 숫자로 정렬해야 한다
  const keys = [...new Set(found.map(p => p.join(",")))]
    .sort((a, b) => Number(a.split(",")[0]) - Number(b.split(",")[0])).join(" ");
  ok(keys === "0,0 70,0 80,0 160,0", "칸을 넘나드는 선분이 전부 잡힌다", keys);

  // 음수 좌표도 (Math.floor 를 쓰므로 -1/CELL 이 0 이 되면 안 된다)
  const neg = new PointIndex([[-10, -10], [-CELL - 10, -10]] as Pt[]);
  const nf = neg.near([-CELL - 10, -10], [-10, -10]).filter(p => onSeg(p, [-CELL - 10, -10], [-10, -10]));
  ok(nf.length === 2, "음수 좌표도 잡힌다", `(${nf.length}개)`);
}

// ── 3. 실제 회로에서 결과가 바뀌지 않는다 ─────────────────────────────
console.log("\n[동등성] 합성 회로에서 넷·접합점이 그대로");
{
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];

  let n = 0;
  for (const scale of [20, 60, 150]) {
    const pr = emptyProject("rnd");
    for (const k of Object.keys(BUILTIN)) pr.library[k] = structuredClone(BUILTIN[k]);
    const s: Sheet = pr.sheets[0];
    const G = (v: number) => Math.round(v / 10) * 10;

    for (let i = 0; i < scale; i++) {
      const lib = pick(["r", "c", "l"]);
      const at: Pt = [G(rnd() * 600), G(rnd() * 600)];
      s.parts.push({ id: "p" + ++n, lib, ref: "X" + n, at, rot: pick([0, 90]) as 0 | 90,
        mirror: false, params: defaultParams(BUILTIN[lib]) } as Part);
    }
    for (let i = 0; i < scale * 2; i++) {
      const a: Pt = [G(rnd() * 600), G(rnd() * 600)];
      // 가로/세로/꺾인 배선을 섞는다
      const mid: Pt = [G(rnd() * 600), a[1]];
      s.wires.push({ id: "w" + ++n, pts: rnd() < 0.5 ? [a, mid] : [a, mid, [mid[0], G(rnd() * 600)]] });
    }
    s.parts.push({ id: "g" + ++n, lib: "gnd", ref: "GND1", at: [0, 0], rot: 0, mirror: false, params: {} } as Part);

    const ex = extractNets(s, pr.library);

    // 전수 조사로 접합점을 다시 센다
    const bruteJ: string[] = [];
    const coords = new Set<string>();
    for (const w of s.wires) for (const p of w.pts) coords.add(p.join(","));
    for (const part of s.parts) {
      const lib = pr.library[part.lib];
      lib.symbol.pins.forEach((_, i) => {
        const { pinAt } = { pinAt: (pp: Part, l: typeof lib, k: number) => {
          const t = l.symbol.pins[k].at;
          const r = pp.rot === 0 ? t : [t[1], -t[0]];
          return [pp.at[0] + r[0], pp.at[1] + r[1]] as Pt;
        } };
        coords.add(pinAt(part, lib, i).join(","));
      });
    }
    for (const ck of coords) {
      const p = ck.split(",").map(Number) as Pt;
      let br = 0;
      for (const part of s.parts) {
        const lib = pr.library[part.lib];
        lib.symbol.pins.forEach((_, i) => {
          const t = lib.symbol.pins[i].at;
          const r = part.rot === 0 ? t : [t[1], -t[0]];
          if (part.at[0] + r[0] === p[0] && part.at[1] + r[1] === p[1]) br++;
        });
      }
      for (const w of s.wires) {
        for (let i = 0; i < w.pts.length - 1; i++) {
          const a = w.pts[i], b = w.pts[i + 1];
          if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === b[0] && p[1] === b[1])) br += 1;
          else if (onSeg(p, a, b)) br += 2;
        }
      }
      if (br >= 3) bruteJ.push(ck);
    }

    const got = ex.junctions.map(p => p.join(",")).sort().join(" ");
    const want = bruteJ.sort().join(" ");
    ok(got === want, `부품 ${scale}개 회로에서 접합점이 전수 조사와 같다`,
       got === want ? `(${ex.junctions.length}개)` : `\n      색인 ${got}\n      전수 ${want}`);
  }
}

// ── 4. 칸 분포 ────────────────────────────────────────────────────────
console.log("\n[분포] 색인이 실제로 나눠 담고 있는가");
{
  const pts: Pt[] = [];
  for (let i = 0; i < 2000; i++) pts.push([(i % 50) * 80, Math.floor(i / 50) * 80]);
  const idx = new PointIndex(pts);
  const st = idx.stats();
  console.log(`      점 ${idx.size}개 -> 칸 ${st.cells}개, 칸당 평균 ${st.avg.toFixed(1)} 최대 ${st.max}`);
  ok(st.cells > 100, "칸이 충분히 나뉜다", `(${st.cells}칸)`);
  ok(st.max < idx.size / 10, "한 칸에 몰리지 않는다", `(최대 ${st.max})`);
}

console.log(fail === 0 ? "\n공간 색인 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
