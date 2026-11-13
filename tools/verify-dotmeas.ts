/*
 * `.meas` 결과 읽기 검증 (src/sim-measure.ts).
 *
 * ngspice 는 측정값을 결과 벡터가 아니라 **글자로** 뱉는다. 글자를 파싱해 쓰는 것이라
 * 엔진 판이 올라가며 모양이 바뀌면 조용히 깨진다 — 여기서는 지금 엔진이 실제로 뱉은
 * 본문을 박아 두고 파서를 묶는다. 엔진이 모양을 바꾸면 tools/e2e.ts 의 실측이 깨지고,
 * 파서를 잘못 고치면 이 검사가 깨진다. 둘을 나눠 두면 어느 쪽이 변했는지 바로 안다.
 */
import { measureNames, parseMeasures, formatMeasure } from "../src/sim-measure.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};
const eq = (got: unknown, exp: unknown, msg: string) =>
  ok(JSON.stringify(got) === JSON.stringify(exp), msg, `(${JSON.stringify(got)})`);

// ── 이름 뽑기 ─────────────────────────────────────────────────────────
console.log("[이름] .meas 줄에서 결과 이름을 뽑는다");
{
  const nl = [
    "* RC lowpass - generated",
    "V1 in 0 SIN(0 1 1k 0 0 0)",
    ".tran 10u 5m 0 10u",
    ".meas tran vpeak MAX v(out)",
    ".measure tran TRISE TRIG v(out) VAL=0.1 RISE=1 TARG v(out) VAL=0.9 RISE=1",
    ".meas ac bw trig_at vdb(out) val=-3",
    ".end",
  ].join("\n");
  eq(measureNames(nl), ["vpeak", "trise", "bw"], ".meas 와 .measure 둘 다, 소문자로");

  eq(measureNames(".meas tran a MAX v(1)\n.meas tran a MIN v(1)"), ["a"],
     "같은 이름이 두 번이면 한 번만");
  eq(measureNames("* .meas tran x MAX v(1)\nR1 a b 1k"), [],
     "주석과 소자 줄은 이름이 아니다");
  eq(measureNames(".meas tran"), [], "이름 자리가 비면 건너뛴다");
  eq(measureNames(".meas tran 1bad MAX v(1)"), [], "식별자가 아닌 이름은 건너뛴다");
  eq(measureNames(".MEAS TRAN Vout MAX v(1)"), ["vout"], "대문자로 써도 읽는다");
  // 줄 끝이 CRLF 인 파일을 들고 와도 이름에 \r 이 붙으면 안 된다
  eq(measureNames(".meas tran vp MAX v(out)\r\n.end\r\n"), ["vp"], "CRLF 도 읽는다");
}

// ── 값 읽기: 지금 엔진이 실제로 뱉은 본문 ─────────────────────────────
console.log("\n[값] getInfo() 본문에서 값을 읽는다");
{
  /*
   * eecircuit-engine 1.9.0 (ngspice 44) 가 실제로 돌려준 글이다.
   * 앞뒤로 해석 안내가 섞여 있고, 측정 결과는 그 사이에 평평하게 끼어 있다.
   */
  const info = [
    "Circuit: * rc lowpass - generated",
    "",
    "Doing analysis at TEMP = 27.000000 and TNOM = 27.000000",
    "",
    "Initial Transient Solution",
    "--------------------------",
    "",
    "vfinal              =  9.998774e-01",
    "trise               =  2.195845e-04 targ=  2.196845e-04 trig=  1.000000e-07",
    "vpeak               =  9.999550e-01 at=  1.000000e-03",
    "",
    "Total analysis time (seconds) = 0.012",
  ].join("\n");

  const m = parseMeasures(info, ["vfinal", "trise", "vpeak"]);
  eq(m.map(x => x.name), ["vfinal", "trise", "vpeak"], "물어본 순서를 지킨다");
  ok(m[0].value === 9.998774e-1 && m[0].detail === "", "vfinal 값, 설명 없음",
     `(${m[0].value} / "${m[0].detail}")`);
  ok(m[1].value === 2.195845e-4, "trise 값", `(${m[1].value})`);
  ok(m[1].detail === "targ=  2.196845e-04 trig=  1.000000e-07", "trise 의 targ/trig 를 설명으로",
     `("${m[1].detail}")`);
  ok(m[2].value === 9.99955e-1 && m[2].detail === "at=  1.000000e-03", "vpeak 의 at= 를 설명으로",
     `(${m[2].value} / "${m[2].detail}")`);

  // 물어보지 않은 이름은 만들어 내지 않는다. 해석 안내 줄을 측정값으로 읽으면
  // 숫자를 지어내는 셈이 된다 — 그래서 넷리스트가 부른 이름만 찾는다
  eq(parseMeasures(info, []), [], "물어본 이름이 없으면 빈 배열");
  const g = parseMeasures(info, ["ghost"]);
  ok(g[0].value === null, "없는 이름은 null", `(${g[0].value})`);
  ok(formatMeasure(g[0]) === "failed", "null 은 'failed' 로 보인다");
}

// ── 이름이 겹칠 때 ────────────────────────────────────────────────────
console.log("\n[경계] 이름이 서로의 앞부분일 때");
{
  const info = ["vfinal2             =  2.500000e+00", "vfinal              =  1.000000e+00"].join("\n");
  const m = parseMeasures(info, ["vfinal", "vfinal2"]);
  ok(m[0].value === 1, "vfinal 이 vfinal2 의 값을 가져오지 않는다", `(${m[0].value})`);
  ok(m[1].value === 2.5, "vfinal2 도 제 값을 읽는다", `(${m[1].value})`);

  // '=' 가 이름에 붙어 있어도 (공백 없이) 읽는다
  ok(parseMeasures("vp=3.000000e+00", ["vp"])[0].value === 3, "이름 바로 뒤에 = 가 붙어도 읽는다");
  ok(parseMeasures("vpx = 3", ["vp"])[0].value === null, "vp 가 vpx 를 집지 않는다");
}

// ── 쌓인 글: 마지막 실행의 값 ─────────────────────────────────────────
console.log("\n[회차] 엔진이 글을 쌓아 두면 마지막 것을 쓴다");
{
  const info = [
    "vpeak               =  1.000000e+00",       // 1회차
    "Total analysis time (seconds) = 0.01",
    "vpeak               =  3.300000e+00",       // 2회차
  ].join("\n");
  ok(parseMeasures(info, ["vpeak"])[0].value === 3.3, "마지막 값으로 덮는다",
     `(${parseMeasures(info, ["vpeak"])[0].value})`);
}

// ── 측정이 실패했을 때 ────────────────────────────────────────────────
console.log("\n[실패] 측정 자체가 실패한 줄");
{
  // 조건에 걸리는 지점이 없으면 ngspice 는 값 자리에 'failed' 를 쓴다
  const m = parseMeasures("trise               =  failed", ["trise"]);
  ok(m[0].value === null, "숫자가 아니면 null", `(${m[0].value})`);
  ok(formatMeasure(m[0]) === "failed", "표에는 'failed'");
}

// ── 실패한 이유 ───────────────────────────────────────────────────────
console.log("\n[이유] 실패한 측정은 왜 실패했는지 같이 보여 준다");
{
  // 엔진이 실제로 뱉은 본문. 값 줄이 아예 없고 오류 두 줄만 있다
  const info = [
    "  Measurements for Transient Analysis",
    "",
    "Error: measure  nope  find(AT) : out of interval",
    "",
    " .meas tran nope find v(out) at=9 failed!",
    "",
    "vfinal              =  -4.505379e-01",
  ].join("\n");
  const m = parseMeasures(info, ["nope", "vfinal"]);
  ok(m[0].value === null, "값은 없다", `(${m[0].value})`);
  ok(m[0].detail === "find(AT) : out of interval", "이유가 설명 자리에 들어간다", `("${m[0].detail}")`);
  ok(m[1].value === -0.4505379 && m[1].detail === "", "같은 본문의 성공한 측정은 그대로",
     `(${m[1].value} / "${m[1].detail}")`);
  // 이유를 못 찾아도 'failed' 로는 보인다 (해석 종류가 안 맞으면 엔진이 아무 말도 안 한다)
  ok(formatMeasure(parseMeasures("", ["x"])[0]) === "failed", "아무 말도 없으면 그냥 failed");
}

// ── 표에 적는 글 ──────────────────────────────────────────────────────
console.log("\n[표기] 사람이 읽는 글자로");
{
  const f = (v: number) => formatMeasure({ name: "x", value: v, detail: "" });
  ok(f(0) === "0", "0", `(${f(0)})`);
  ok(f(0.9998774) === "0.999877", "1 V 근처는 그대로", `(${f(0.9998774)})`);
  ok(f(3.3) === "3.3", "꼬리에 0 이 붙지 않는다", `(${f(3.3)})`);
  ok(f(2.195845e-4) === "2.1958e-4", "작은 값은 지수로", `(${f(2.195845e-4)})`);
  ok(f(-1.5e7) === "-1.5000e+7", "큰 값도 지수로", `(${f(-1.5e7)})`);
  ok(f(1.26e-6).includes("e-6"), "um 단위 값도 지수로", `(${f(1.26e-6)})`);
}

console.log(fail === 0 ? "\n.meas 읽기 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
