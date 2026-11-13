// 정렬·분배·지정자 재부여 검증 (설계서 E30 · E31).
//
// 여기서 격자를 벗어나면 핀도 격자를 벗어나 연결이 조용히 끊긴다 —
// 설계서가 "정렬·분배 뒤에도 핀은 격자 위, 연결은 유지" 라고 못 박은 이유다.
import { alignTargets, annotate, distributeTargets } from "../src/doc/arrange.ts";
import { GRID, type Pt } from "../src/doc/types.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};
const onGrid = (ps: Pt[]) => ps.every(p => p[0] % GRID === 0 && p[1] % GRID === 0);

// ── 정렬 ──────────────────────────────────────────────────────────────
console.log("[정렬] 한 줄로 맞추되 다른 축은 건드리지 않는다");
{
  const ats: Pt[] = [[0, 10], [50, 40], [20, 90]];

  const left = alignTargets(ats, "left");
  ok(left.every(p => p[0] === 0), "왼쪽 = 가장 작은 x", JSON.stringify(left));
  ok(left.map(p => p[1]).join() === "10,40,90", "y 는 그대로");
  ok(left.length === ats.length, "순서와 개수가 그대로");

  ok(alignTargets(ats, "right").every(p => p[0] === 50), "오른쪽 = 가장 큰 x");
  ok(alignTargets(ats, "top").every(p => p[1] === 10), "위 = 가장 작은 y");
  ok(alignTargets(ats, "bottom").every(p => p[1] === 90), "아래 = 가장 큰 y");

  // 가운데는 평균이 아니라 양 끝의 한가운데다 (한쪽에 몰린 무리가 끌려가지 않는다)
  const cx = alignTargets([[0, 0], [10, 0], [100, 0]], "cx");
  ok(cx.every(p => p[0] === 50), "세로축 가운데 = (min+max)/2", JSON.stringify(cx.map(p => p[0])));

  // 격자를 벗어나는 가운데값은 붙인다
  const cy = alignTargets([[0, 0], [0, 50]], "cy");
  ok(onGrid(cy), "가운데가 격자 위에 있다", JSON.stringify(cy));

  ok(alignTargets([[7, 7]], "left")[0][0] === 7, "하나뿐이면 그대로 둔다");
  // 원본을 건드리지 않는다
  const src: Pt[] = [[0, 0], [30, 0]];
  alignTargets(src, "right")[0][0] = 999;
  ok(src[0][0] === 0, "원본을 건드리지 않는다");
}

// ── 분배 ──────────────────────────────────────────────────────────────
console.log("\n[분배] 양 끝은 두고 사이를 고르게");
{
  const ats: Pt[] = [[0, 0], [10, 5], [90, 9]];
  const h = distributeTargets(ats, "h");
  ok(h[0][0] === 0 && h[2][0] === 90, "양 끝은 그대로", JSON.stringify(h.map(p => p[0])));
  ok(h[1][0] === 50, "가운데가 한가운데로", String(h[1][0]));
  ok(h.map(p => p[1]).join() === "0,5,9", "다른 축은 그대로");

  // 들어온 순서가 뒤죽박죽이어도 자리만 바뀐다 (짝은 유지)
  const mixed: Pt[] = [[90, 0], [0, 0], [40, 0]];
  const m = distributeTargets(mixed, "h");
  // 한가운데는 45 지만 격자에 붙어 50 이 된다 (격자가 먼저다)
  ok(m[0][0] === 90 && m[1][0] === 0 && m[2][0] === 50, "정렬 순서와 입력 순서를 섞지 않는다", JSON.stringify(m.map(p => p[0])));

  // 딱 나누어떨어지지 않으면 격자에 붙인다 — 간격이 한 칸씩 달라도 격자가 먼저다
  const four = distributeTargets([[0, 0], [1, 0], [2, 0], [70, 0]], "h");
  ok(onGrid(four), "모두 격자 위", JSON.stringify(four.map(p => p[0])));
  ok(four[3][0] === 70 && four[0][0] === 0, "양 끝은 그대로");

  const v = distributeTargets([[0, 0], [3, 30], [7, 100]], "v");
  ok(v.map(p => p[1]).join() === "0,50,100", "세로도 같다", JSON.stringify(v.map(p => p[1])));

  ok(distributeTargets([[0, 0], [10, 0]], "h")[1][0] === 10, "둘뿐이면 그대로 둔다");
}

// ── 지정자 재부여 ─────────────────────────────────────────────────────
console.log("\n[재부여] 접두어마다 따로, 읽는 순서로");
{
  const parts = [
    { id: "a", at: [100, 0] as Pt, prefix: "R" },
    { id: "b", at: [0, 0] as Pt, prefix: "R" },
    { id: "c", at: [50, 60] as Pt, prefix: "C" },
    { id: "d", at: [0, 60] as Pt, prefix: "R" },
  ];
  const rows = annotate(parts, "rowFirst", 1);
  ok(rows.map(r => r.part.id + "=" + r.ref).join(" ") === "b=R1 a=R2 d=R3 c=C1",
     "위에서 아래로, 같은 줄은 왼쪽부터", rows.map(r => r.part.id + "=" + r.ref).join(" "));

  const cols = annotate(parts, "colFirst", 1);
  ok(cols.map(r => r.part.id + "=" + r.ref).join(" ") === "b=R1 d=R2 c=C1 a=R3",
     "왼쪽에서 오른쪽으로, 같은 칸은 위부터", cols.map(r => r.part.id + "=" + r.ref).join(" "));

  const from5 = annotate(parts, "rowFirst", 5);
  ok(from5[0].ref === "R5", "시작 번호를 따른다", from5[0].ref);
  ok(from5.find(r => r.part.prefix === "C")!.ref === "C5", "접두어마다 따로 센다");

  ok(annotate([], "rowFirst", 1).length === 0, "빈 목록도 받는다");
}

console.log(fail === 0 ? "\n정렬·분배·재부여 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
