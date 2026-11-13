// ngspice 메시지 분류 검증.
//
// 이 판정이 느슨하면 실패한 시뮬레이션을 성공으로 보여 주고,
// 빡빡하면 잘 돈 시뮬레이션을 실패로 보여 준다. 둘 다 조용히 틀리는 쪽이다.
import { diagnose } from "../src/sim-log.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

// ── 1. 안내 + 결과 있음 -> 성공 ───────────────────────────────────────
console.log("[성공] 안내만 나왔고 결과도 나왔으면 성공이다");
{
  // AC 해석에서 실제로 오는 줄. 결과 101점이 멀쩡히 나온다
  const d = diagnose(["Note: v1: has no value, DC 0 assumed"], true);
  ok(!d.fatal, "Note 는 실패가 아니다");
  ok(d.notes.length === 1, "로그에는 남긴다", JSON.stringify(d.notes));

  const w = diagnose(["Warning: some harmless thing"], true);
  ok(!w.fatal, "Warning 도 결과가 있으면 실패가 아니다");

  ok(!diagnose([], true).fatal, "메시지가 아예 없으면 당연히 성공");
}

// ── 2. 진짜 오류 -> 실패 ──────────────────────────────────────────────
console.log("\n[실패] 치명적인 줄이 있으면 실패다");
{
  // 외부 .sp 의 .end 뒤를 파싱하다 났던 실제 오류
  const d = diagnose(["Error on line 8 or its substitute:", " unknown device type - error "], true);
  ok(d.fatal, "Error 줄은 결과가 있어도 실패", d.message.slice(0, 40));

  const mixed = diagnose(["Note: 그냥 안내", "Error: circuit not parsed."], true);
  ok(mixed.fatal, "안내와 섞여 있어도 실패");
  ok(!mixed.message.includes("그냥 안내"), "실패 메시지에는 안내를 섞지 않는다", mixed.message);
  ok(mixed.notes.length === 1, "안내는 로그로 간다");
}

// ── 3. 경고뿐인데 결과가 비었으면 -> 실패 ─────────────────────────────
console.log("\n[빈 결과] 경고만 나와도 결과가 없으면 실패다");
{
  // 떠 있는 노드가 이렇게 온다. ngspice 는 Warning 으로만 알리고 빈 결과를 준다
  const d = diagnose([
    "Warning: singular matrix:  check node in",
    "Warning: Dynamic gmin stepping failed",
  ], false);
  ok(d.fatal, "경고 + 빈 결과 = 실패");
  ok(d.message.includes("singular"), "원인을 그대로 보여 준다", d.message.slice(0, 40));

  const silent = diagnose([], false);
  ok(silent.fatal, "아무 말 없이 빈 결과여도 실패");
  ok(silent.message.length > 0, "그래도 할 말은 있어야 한다", silent.message);
}

// ── 4. 측정 실패는 실행의 실패가 아니다 ──────────────────────────────
console.log("\n[측정] .meas 하나가 실패해도 실행은 성공이다");
{
  // 엔진이 실제로 뱉은 두 줄 (.meas tran nope find v(out) at=9)
  const LINES = [
    "",
    "Error: measure  nope  find(AT) : out of interval",
    " .meas tran nope find v(out) at=9 failed!",
    "",
  ];
  const d = diagnose(LINES, true);
  ok(!d.fatal, "머리말이 Error: 여도 파형을 버리지 않는다", d.message.slice(0, 40));
  ok(d.notes.length === 2, "두 줄 다 로그에 남긴다", JSON.stringify(d.notes));

  // 결과가 비었으면 이야기가 다르다 — 그때는 그대로 실패다
  const empty = diagnose(LINES, false);
  ok(empty.fatal, "결과까지 비었으면 실패");
  ok(empty.message.includes("out of interval"), "이유를 그대로 보여 준다", empty.message.slice(0, 40));

  // 측정과 무관한 Error 는 여전히 실패여야 한다. 여기가 느슨해지면
  // 'Error:' 로 시작하는 진짜 오류를 알림으로 넘겨 버린다
  ok(diagnose(["Error: measurement of the circuit failed"], true).fatal,
     "measure 로 시작하지 않는 Error 는 그대로 실패");
  ok(diagnose([" .meas tran t WHEN v(out)=1 RISE=1"], true).fatal,
     "failed! 로 끝나지 않는 .meas 줄은 오류로 본다");
  ok(diagnose(["Error: measure  a  bad", "Error: circuit not parsed."], true).fatal,
     "측정 실패와 진짜 오류가 섞이면 실패");
}

// ── 5. 여러 줄이 한 덩어리로 올 때 ────────────────────────────────────
console.log("\n[줄 나누기] 한 문자열에 여러 줄이 들어와도 가른다");
{
  const d = diagnose(["Note: 첫 줄\nError: 둘째 줄"], true);
  ok(d.fatal, "덩어리 안의 Error 도 찾아낸다");
  ok(d.notes.length === 1 && d.notes[0].includes("첫 줄"), "같은 덩어리의 안내는 분리한다");
}

console.log(fail === 0 ? "\n시뮬레이션 메시지 분류 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
