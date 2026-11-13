// 스냅 판정을 수치로 검증한다.
// 손맛을 "EasyEDA 처럼"이 아니라 측정 가능한 목표로 정의하기 위한 계측이다.
import { resolveSnap, type Pt, type SnapTarget } from "../src/feel/snap.ts";
import { DEFAULT_PROFILE, type FeelProfile } from "../src/feel/profile.ts";

const SCALE = 2;        // 월드 1단위(10 mil)당 화면 px → 격자 100 mil = 20 px
const GRID = 10;        // 월드 단위의 격자 간격
const noHyst = (p: FeelProfile): FeelProfile => ({ ...p, snapBreakMultiplier: 1.0 });

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

/** 커서 경로를 따라가며 스냅 대상이 몇 번 바뀌는지 센다 */
function run(path: Pt[], cands: SnapTarget[], p: FeelProfile) {
  let prev: SnapTarget | null = null;
  let changes = 0;
  const seen: string[] = [];
  for (const c of path) {
    const r = resolveSnap(c, cands, prev, p, SCALE, GRID);
    if (prev && r.target.ref !== prev.ref) changes++;
    prev = r.target;
    seen.push(r.target.ref);
  }
  return { changes, final: prev!, seen };
}

// 재현 가능한 의사난수 (손떨림 모사)
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);

const pinA: SnapTarget = { kind: "pin", at: [0, 0], ref: "A" };
const pinB: SnapTarget = { kind: "pin", at: [6, 0], ref: "B" };
const two = [pinA, pinB];

console.log("설정: 격자 100 mil = 20 px, 스냅 반경 8 px, 히스테리시스 배수 1.8\n");

// ── 1. 떨림 억제: 두 핀 사이 모호한 지점에서 손이 떨릴 때
console.log("[1] 모호한 지점에서의 떨림 (두 핀 중간, 손떨림 +-1.5 px)");
{
  const path: Pt[] = [];
  for (let i = 0; i < 300; i++) path.push([3 + (rnd() * 1.5) / SCALE, (rnd() * 1.5) / SCALE]);
  const off = run(path, two, noHyst(DEFAULT_PROFILE));
  const on = run(path, two, DEFAULT_PROFILE);
  console.log(`      히스테리시스 없음: ${String(off.changes).padStart(3)}회 전환`);
  console.log(`      히스테리시스 있음: ${String(on.changes).padStart(3)}회 전환`);
  ok(on.changes === 0, "떨림 구간에서 전환 0회", `(없으면 ${off.changes}회)`);
  ok(off.changes > 20, "히스테리시스가 실제로 문제를 막고 있음", `(없을 때 ${off.changes}회)`);
}

// ── 2. 그래도 옮겨 갈 수는 있어야 한다
console.log("\n[2] 확실히 움직이면 전환된다 (A 에서 B 로 직진)");
{
  const path: Pt[] = [];
  for (let i = 0; i <= 120; i++) path.push([(6 * i) / 120, 0]);
  const r = run(path, two, DEFAULT_PROFILE);
  ok(r.final.ref === "B", "끝에서 B 에 붙어 있다", `(최종 ${r.final.ref})`);
  const idx = r.seen.findIndex(s => s === "B");
  const commitWorld = (6 * idx) / 120;
  console.log(`      전환 지점: A 에서 ${commitWorld.toFixed(2)} 월드 (B 까지 ${(6 - commitWorld).toFixed(2)}),` +
              ` 화면으로 B 에서 ${((6 - commitWorld) * SCALE).toFixed(1)} px`);
}

// ── 3. 계층 가산점은 '반경 안에서' 동점을 가른다 (사거리를 늘리지는 않는다)
console.log("\n[3] 계층 우선순위 (핀 vs 격자)");
{
  // (a) 반경 안의 핀: 격자가 훨씬 가까워도 핀이 이긴다
  const nearPin: SnapTarget = { kind: "pin", at: [3.5, 0], ref: "P" };
  const a = resolveSnap([0.75, 0], [nearPin], null, DEFAULT_PROFILE, SCALE, GRID);
  ok(a.target.kind === "pin", "격자 1.5 px / 핀 7.0 px (반경 안) → 핀", `(고른 것: ${a.target.kind})`);

  // (b) 반경 밖의 핀: 사거리 밖이라 후보가 아니다. 반경이 예측 가능성을 만든다
  const farPin: SnapTarget = { kind: "pin", at: [5.5, 0], ref: "P" };
  const b = resolveSnap([0.75, 0], [farPin], null, DEFAULT_PROFILE, SCALE, GRID);
  ok(b.target.kind === "grid", "격자 1.5 px / 핀 9.5 px (반경 밖) → 격자", `(고른 것: ${b.target.kind})`);
}

// ── 4. 반경이 배율에 따라 묶인다
console.log("\n[4] 축소 시 반경 클램프");
{
  const { snapRadiusPx } = await import("../src/feel/snap.ts");
  const at = (s: number) => snapRadiusPx(DEFAULT_PROFILE, GRID * s);
  console.log(`      격자 20 px (기본) → 반경 ${at(2)} px`);
  console.log(`      격자 60 px (확대) → 반경 ${at(6)} px`);
  console.log(`      격자  8 px (축소) → 반경 ${at(0.8)} px`);
  ok(at(6) === 12, "확대하면 기준값 12 px 까지만", `(${at(6)})`);
  ok(at(0.8) === 8, "축소해도 하한 8 px 아래로 안 감", `(${at(0.8)})`);
  ok(at(2) <= 20 * 0.4 + 1e-9, "격자 크기의 0.4배를 넘지 않음", `(${at(2)})`);
}

// ── 5. 아무것도 없으면 격자
console.log("\n[5] 아무 대상도 없을 때");
{
  const r = resolveSnap([23, 47], [], null, DEFAULT_PROFILE, SCALE, GRID);
  ok(r.target.kind === "grid" && r.target.at[0] === 20 && r.target.at[1] === 50,
     "가장 가까운 격자점으로", `(${r.target.at})`);
}

console.log(fail === 0 ? "\n스냅 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
