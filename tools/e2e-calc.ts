// 계산기를 엔진까지 거쳐 본다: 회로도 -> 넷 추출 -> 넷리스트 -> (계산기가 읽는 것을 .save 에 보태고)
// -> ngspice -> 결과 변환 -> 계산기 식 -> 손으로 계산한 값.
//
// tools/verify-calc.ts 는 답을 아는 파형 위에서 수치 계산을 본다. 여기서 보는 것은 그 앞뒤다 —
// ngspice 가 소자 값을 **어떤 이름과 부호로** 돌려주는지, 우리가 붙인 .save 줄이 결과를 망가뜨리지
// 않는지, 잡음 · 전달 함수 해석이 계산기가 읽는 모양으로 오는지. 전부 엔진 판이 바뀌면 조용히 틀리는
// 자리다. 기대값은 Razavi 의 식을 손으로 푼 것이다:
//
//   제곱 법칙      gm = 2·ID/(VGS − VTH),  rO = 1/(λ·ID0),  Av = −gm·(RD ‖ rO)      (2장 · 3장)
//   RC 의 잡음     ∫ 4kTR/(1 + (f/fc)²) df = kT/C,  Bn = π/2 · fc                    (7장)
//   왜곡           HD2 = (α2·A²/2)/(α1·A + 3α3·A³/4), 식 (14.9)                      (14장)
//   1차 계단       1 % 정착 = τ·ln 100                                               (예제 9.2)
import { Simulation } from "eecircuit-engine";
import { DEMOS, builder } from "../src/lib/demos.ts";
import { pinAt, type Part, type Project, type SimSettings } from "../src/doc/types.ts";
import { extractNets } from "../src/net/extract.ts";
import { beforeEnd, buildNetlist } from "../src/net/netlist.ts";
import { toTraces } from "../src/sim-values.ts";
import { EngineStuck, runWithFallback } from "../src/sim-run.ts";
import { evaluateRows, runFromTraces, type RunData } from "../src/calc/eval.ts";
import { parseDevices } from "../src/calc/devices.ts";
import { formatValue } from "../src/calc/format.ts";
import { engine, runCalc, type Ran } from "./sim-harness.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

/** 부품을 늘어놓고 핀마다 넷 라벨을 붙여 잇는다 ('0' 은 GND 기호). tools/verify-library.ts 와 같은 방식 */
function circuit(name: string, sim: SimSettings) {
  const b = builder(name);
  b.project.sim = sim;
  let x = 0;
  const put = (lib: string, nets: Record<string, string>, params?: Record<string, string>): Part => {
    const p = b.part(lib, [x, 0], params);
    x += 120;
    const def = b.project.library[lib];
    def.symbol.pins.forEach((pin, i) => {
      const net = nets[pin.id];
      if (net === undefined) return;
      const at = pinAt(p, def, i);
      if (net === "0") b.part("gnd", at); else b.label(net, at);
    });
    return p;
  };
  return { ...b, put };
}

/** 앱이 하는 그대로 돌린다 (tools/sim-harness.ts) — 실패하면 무엇이 안 됐는지 적는다 */
async function calc(pr: Project, lines: string[], kept: ReadonlyMap<string, RunData> = new Map()): Promise<Ran | null> {
  const r = await runCalc(pr, lines, kept);
  if ("error" in r) { ok(false, `${pr.name}: ${r.what}`, r.error); return null; }
  return r;
}

/** 줄 번호로 값을 꺼내 손계산과 견준다 (상대 오차) */
function expect(r: Ran, i: number, want: number, tol: number, what: string) {
  const row = r.rows[i];
  if (row.error || row.value?.t !== "num") { ok(false, `${what}: ${row.src}`, row.error ?? "숫자가 아니다"); return; }
  const got = row.value.re;
  const err = want === 0 ? Math.abs(got) : Math.abs(got / want - 1);
  ok(err <= tol, `${what.padEnd(34)} ${row.src}`, `${formatValue(row.value)}   기대 ${want.toPrecision(7)}  오차 ${err.toExponential(1)}  허용 ${tol.toExponential(0)}`);
}
const num = (r: Ran, i: number): number => {
  const v = r.rows[i].value;
  if (v?.t !== "num") throw new Error(`${r.rows[i].src}: ${r.rows[i].error ?? "숫자가 아니다"}`);
  return v.re;
};

// ── 1. 공통 소스 증폭기 (레벨 1 NMOS): 제곱 법칙 ──────────────────────
/*
 * VDD 5 V, RD 10 k, VGS 2.5 V, VTH 1 V, β = KP·W/L = 200 µA/V², λ = 0.02.
 *   ID = ½β·Vov²·(1 + λ·VDS),  VDS = 5 − RD·ID   ->   VDS = 2.75/1.045
 */
const VOV = 1.5, BETA = 200e-6, LAMBDA = 0.02, RD = 10e3;
const VDS = 2.75 / 1.045;
const ID = (5 - VDS) / RD;
const GM = BETA * VOV * (1 + LAMBDA * VDS);
const GDS = 0.5 * BETA * VOV * VOV * LAMBDA;
const ROUT = 1 / (1 / RD + GDS);
const AV = -GM * ROUT;

function csAmp(sim: SimSettings, pmos = false) {
  const c = circuit(pmos ? "PMOS CS" : "NMOS CS", sim);
  // 전원에는 AC 신호를 싣지 않는다. 그대로 두면 AC 해석에서 VDD 도 1 V 로 흔들려 이득에 전원 쪽 이득이 섞인다
  c.put("vdc", { p: "vdd", n: "0" }, { dc: "5", ac: "0" });                     // V1
  if (pmos) {
    // 거울상: 소스가 VDD, 게이트는 VDD 아래 2.5 V, 드레인 저항이 접지로
    c.put("vdc", { p: "in", n: "0" }, { dc: "2.5" });                            // V2
    c.put("r", { "1": "out", "2": "0" }, { value: "10k" });
    c.put("pmos", { d: "out", g: "in", s: "vdd" }, { vto: "-1" });
  } else {
    c.put("vdc", { p: "in", n: "0" }, { dc: "2.5" });                            // V2
    c.put("r", { "1": "vdd", "2": "out" }, { value: "10k" });
    c.put("nmos", { d: "out", g: "in", s: "0" }, { vto: "1" });
  }
  return c.project;
}

console.log("=== 공통 소스 증폭기, 동작점 — 소자 값 (Razavi 2장 · 3장) ===");
{
  const r = await calc(csAmp({ kind: "op" }), [
    "gm(M1)", "2*id(M1)/vov(M1)", "ro(M1)", "1/(0.02*id(M1)/(1+0.02*vds(M1)))", "gmro(M1)", "vov(M1)", "vth(M1)",
    "vdsat(M1)", "satmargin(M1)", "gmid(M1)", "id(M1)", "-i(V1)", "power(V1)", "av = -gm(M1)/(1/10k + gds(M1))",
    "v(out)", "i(R1)", "power(M1) + power(R1)", "@m1[von]", "op(M1, gds)",
  ]);
  if (r) {
    console.log("  " + r.netlist.split("\n").filter(l => l.startsWith(".")).join("   "));
    const saveLine = r.netlist.split("\n").find(l => l.startsWith(".save")) ?? "";
    ok(/^\.save all @m1\[gm\]/.test(saveLine) && !/ [vi]\(/.test(saveLine), ".op 의 저장 줄은 all 로 시작하고 소자 값만 덧붙인다 (전압 표를 잃지 않게)", saveLine);
    expect(r, 0, GM, 1e-8, "gm = β·Vov·(1 + λ·VDS)");
    expect(r, 1, GM, 1e-6, "gm = 2·ID/(VGS − VTH)");
    expect(r, 2, 1 / GDS, 1e-8, "rO = 1/gds");
    expect(r, 3, 1 / GDS, 1e-6, "rO = 1/(λ·ID0)");
    expect(r, 4, GM / GDS, 1e-8, "고유 이득 gm·rO");
    expect(r, 5, VOV, 1e-9, "VGS − VTH");
    expect(r, 6, 1, 1e-9, "VTH (레벨 1 은 von 으로 온다)");
    expect(r, 7, VOV, 1e-9, "VDS,sat = Vov");
    expect(r, 8, VDS - VOV, 1e-7, "포화 여유 VDS − VDS,sat");
    expect(r, 9, 2 / VOV, 1e-6, "gm/ID = 2/Vov");
    expect(r, 10, ID, 1e-7, "ID");
    expect(r, 11, ID, 1e-6, "공급 전류 −i(V1)");
    expect(r, 12, 5 * ID, 1e-6, "전원이 내보내는 전력");
    expect(r, 13, AV, 1e-8, "Av = −gm·(RD ‖ rO)");
    expect(r, 14, VDS, 1e-8, "v(out)");
    expect(r, 15, ID, 1e-6, "i(R1) — 저항의 전류");
    expect(r, 16, 5 * ID, 1e-5, "소자들이 쓴 전력 = 전원이 낸 전력");
    expect(r, 17, 1, 1e-9, "@m1[von] — ngspice 의 이름 그대로");
    expect(r, 18, GDS, 1e-8, "op(M1, gds)");
  }
}

console.log("\n=== 같은 회로의 PMOS 거울상 — 부호 (크기로 읽힌다) ===");
{
  const r = await calc(csAmp({ kind: "op" }, true), ["gm(M1)", "vov(M1)", "vth(M1)", "vdsat(M1)", "satmargin(M1)", "id(M1)", "vgs(M1)", "vds(M1)", "gmid(M1)", "@m1[von]", "@m1[vdsat]"]);
  if (r) {
    expect(r, 0, GM, 1e-8, "gm");
    expect(r, 1, VOV, 1e-9, "|VGS| − |VTH|");
    expect(r, 2, 1, 1e-9, "|VTH|");
    expect(r, 3, VOV, 1e-9, "|VDS,sat|");
    expect(r, 4, VDS - VOV, 1e-7, "포화 여유");
    expect(r, 5, ID, 1e-7, "ID (양수)");
    expect(r, 6, 2.5, 1e-9, "|VGS|");
    expect(r, 7, VDS, 1e-8, "|VDS|");
    expect(r, 8, 2 / VOV, 1e-6, "gm/ID");
    // 엔진이 주는 날것: 레벨 1 은 PMOS 의 von · vdsat 을 음수로 준다. 이게 바뀌면 위의 절댓값 처리를 다시 봐야 한다
    expect(r, 9, -1, 1e-9, "날것의 von 은 음수");
    expect(r, 10, -VOV, 1e-9, "날것의 vdsat 도 음수");
  }
}

console.log("\n=== 같은 회로, 전달 함수 (.tf) — 이득 · 입력 저항 · 출력 저항 ===");
{
  const r = await calc(csAmp({ kind: "tf", out: "out", src: "V2" }), ["tf_gain", "tf_rout", "tf_rin", "tf_gain + gm(M1)*tf_rout", "gm(M1)"]);
  if (r) {
    console.log("  " + r.netlist.split("\n").filter(l => l.startsWith(".")).join("   "));
    expect(r, 0, AV, 1e-7, "이득 = −gm·(RD ‖ rO)");
    expect(r, 1, ROUT, 1e-8, "출력 저항 = RD ‖ rO");
    ok(num(r, 2) >= 1e12, "입력 저항: 게이트는 열려 있다", formatValue(r.rows[2].value!));
    ok(Math.abs(num(r, 3)) < 1e-9, ".tf 의 이득과 소자의 gm · 출력 저항이 서로 맞는다", num(r, 3).toExponential(1));
    expect(r, 4, GM, 1e-8, ".tf 에서도 소자 값을 읽는다 (.save all 덕분)");
  }
  const none = await calc(csAmp({ kind: "tf", out: "out", src: "V2" }), ["tf_gain", "tf_rout"]);
  if (none) {
    ok(!none.netlist.includes(".save"), "계산기가 소자 값을 안 읽으면 .tf 에 저장 줄을 붙이지 않는다");
    expect(none, 0, AV, 1e-7, "그래도 이득은 같다");
  }
}

console.log("\n=== 같은 회로, DC 스윕 — 전달 곡선의 기울기가 작은 신호 이득이다 ===");
{
  const r = await calc(csAmp({ kind: "dc", source: "V2", start: "0", stop: "5", step: "0.01" }), [
    "slope(v(out), 2.5)", "value(gm(M1), 2.5)", "value(deriv(v(out)), 2.5) + value(gm(M1), 2.5)/(1/10k + value(gds(M1), 2.5))",
    "value(id(M1), 2.5)", "cross(satmargin(M1), 0, 1, fall)", "value(v(out), 0.5)", "avpk = ymax(abs(deriv(v(out))))",
  ]);
  if (r) {
    expect(r, 0, AV, 2e-5, "∂Vout/∂Vin at 2.5 V");
    expect(r, 1, GM, 1e-8, "스윕에서는 gm 이 곡선이다");
    ok(Math.abs(num(r, 2)) < 1e-4, "기울기 = −gm·(RD ‖ rO): 곡선에서 잰 것과 소자 값으로 셈한 것", num(r, 2).toExponential(1));
    expect(r, 3, ID, 1e-7, "ID at 2.5 V");
    // 포화의 끝: VDS = VGS − VTH 이고 ID = ½β·Vov²(1 + λ·Vov) = (5 − Vov)/RD
    let lo = 0, hi = 4;
    for (let i = 0; i < 80; i++) { const v = (lo + hi) / 2; if (0.5 * BETA * v * v * (1 + LAMBDA * v) * RD + v < 5) lo = v; else hi = v; }
    expect(r, 4, 1 + (lo + hi) / 2, 1e-4, "포화를 벗어나는 입력 전압");
    expect(r, 5, 5, 1e-6, "차단 영역: 출력 = VDD");
    ok(num(r, 6) > Math.abs(AV), "가장 큰 이득은 2.5 V 에서의 이득보다 크다 (포화의 끝 쪽)", formatValue(r.rows[6].value!));
  }
}

console.log("\n=== 같은 회로, AC — 소자 값은 숫자 하나, 이득은 .tf 와 같다 ===");
{
  const r = await calc(csAmp({ kind: "ac", sweep: "dec", points: "10", fstart: "1", fstop: "1meg" }), [
    "dcgain(v(out)/v(in))", "gm(M1)", "first(phase(v(out)/v(in)))", "gm(M1)*ro(M1)",
  ]);
  if (r) {
    expect(r, 0, -AV, 1e-7, "|Av|");
    expect(r, 1, GM, 1e-8, "gm (동작점의 값)");
    expect(r, 2, 180, 1e-9, "반전: 위상 180°");
    expect(r, 3, GM / GDS, 1e-8, "gm·rO");
  }
}

// ── 2. SKY130 5T OTA: BSIM4 의 이름과 부호, 주파수 응답 ───────────────
console.log("\n=== SKY130 5T OTA (AC) — 이득 · 대역폭 · 위상 여유 · BSIM4 소자 값 ===");
{
  const ota = DEMOS.find(d => d.name === "SKY130 5T OTA")!.build();
  const H = "v(out)/v(inp)";
  const r = await calc(ota, [
    `a0 = dcgain(${H})`, `f3 = f3db(${H})`, `fu = ugf(${H})`, `pm(${H})`, `gbw(${H})`,
    "g = gm(X3)*ro(X2)*ro(X4)/(ro(X2)+ro(X4))", "gmid(X3)", "vov(X3)", "vth(X3)", "satmargin(X3)", "satmargin(X2)",
    "id(X5)", "id(X3) + id(X4)", "ft(X3)", "cgg(X3)", "cgs(X3)", "vgs(X1)", "@m.x3.msky130_fd_pr__nfet_01v8[cgs]",
    `value(phase(${H}), f3)`, "id(X1)/id(X3)",
  ]);
  if (r) {
    ok(r.unavailable.length === 0, "물은 이름이 전부 BSIM4 에 있다 (한 번에 돌았다)", r.unavailable.join(" "));
    const a0 = num(r, 0), f3 = num(r, 1);
    ok(20 * Math.log10(a0) > 30 && 20 * Math.log10(a0) < 50, "이득 30~50 dB (공정 모델이 정하는 값)", formatValue(r.rows[0].value!));
    expect(r, 2, f3 * Math.sqrt(a0 * a0 - 1), 2e-3, "fu = f−3dB·√(A0² − 1) (극점 하나)");
    expect(r, 4, a0 * f3, 1e-9, "GBW = A0·f−3dB");
    ok(num(r, 3) > 85 && num(r, 3) < 90, "위상 여유 85~90° (극점 하나에 가깝다)", formatValue(r.rows[3].value!));
    expect(r, 18, -45, 2e-3, "f−3dB 에서 위상 −45°");
    // 손으로 푼 이득 gm1·(rO2 ‖ rO4) 과 AC 해석의 이득 — 소자 값과 AC 결과가 같은 회로를 말하는지
    expect(r, 5, a0, 0.03, "A0 ≈ gm1·(rO2 ‖ rO4)");
    ok(num(r, 6) > 3 && num(r, 6) < 30, "gm/ID 가 그럴듯하다 (약반전 ~25, 강반전 ~5)", formatValue(r.rows[6].value!));
    ok(num(r, 8) > 0.3 && num(r, 8) < 1.1, "nFET 의 VTH", formatValue(r.rows[8].value!));
    ok(num(r, 9) > 0 && num(r, 10) > 0, "입력쌍과 부하가 포화에 있다", `${formatValue(r.rows[9].value!)} · ${formatValue(r.rows[10].value!)}`);
    expect(r, 12, num(r, 11), 1e-3, "꼬리 전류 = 두 가지의 합");
    expect(r, 19, 1, 1e-3, "거울 쪽 전류 = 입력 트랜지스터 전류");
    ok(num(r, 13) > 1e8 && num(r, 13) < 1e11, "fT 가 그럴듯하다 (130 nm, L = 1 µm)", formatValue(r.rows[13].value!));
    ok(num(r, 14) > 0 && num(r, 15) > 0 && num(r, 15) < num(r, 14), "0 < Cgs < Cgg", `${formatValue(r.rows[15].value!)} < ${formatValue(r.rows[14].value!)}`);
    ok(num(r, 16) > 0, "pFET 의 VGS 는 크기로 온다", formatValue(r.rows[16].value!));
    // 엔진이 주는 날것: BSIM4 의 cgs 는 음수(상호 용량). 이게 바뀌면 cgs() 의 절댓값 처리를 다시 봐야 한다
    ok(num(r, 17) < 0, "날것의 BSIM4 cgs 는 음수다", num(r, 17).toExponential(3));
  }
}

// ── 2b. SKY130 의 배수 ────────────────────────────────────────────────
/*
 * 부품의 Multiplier 는 넷리스트에 m= 로 나간다 — ngspice 가 서브회로를 그만큼 병렬로 둔다. 모델의 mult 는 미스매치
 * 통계(sqrt(l*w*mult))에만 쓰여 mult= 만 적으면 배수 4 가 한 개로 돈다 (그렇게 돌던 때가 있었다).
 */
console.log("\n=== SKY130 배수 — Multiplier 가 소자를 곱한다 ===");
{
  const got: number[] = [];
  for (const mult of ["1", "4"]) {
    const c = circuit(`SKY130 x${mult}`, { kind: "op" });
    c.put("vdc", { p: "d", n: "0" }, { dc: "1.8", ac: "0" });
    c.put("vdc", { p: "g", n: "0" }, { dc: "1.0", ac: "0" });
    c.put("sky130_nfet", { d: "d", g: "g", s: "0" }, { w: "1.26u", l: "0.15u", nf: "1", mult });
    const r = await calc(c.project, ["id(X1)", "gm(X1)"]);
    got.push(r ? num(r, 0) : NaN, r ? num(r, 1) : NaN);
  }
  ok(Math.abs(got[2] / got[0] - 4) < 1e-3 && Math.abs(got[3] / got[1] - 4) < 1e-3, "배수 4 = 전류 · gm 4 배",
     `id ${got[0].toExponential(3)} A -> ${got[2].toExponential(3)} A`);
}

// ── 3. 잡음: RC 저역통과 ──────────────────────────────────────────────
console.log("\n=== RC 저역통과, 잡음 해석 — kT/C (Razavi 7장) ===");
{
  const rc = DEMOS[0].build();     // R 1k, C 100n
  rc.sim = { kind: "noise", out: "out", src: "V1", sweep: "dec", points: "10", fstart: "1", fstop: "1g" };
  const kT = 1.380649e-23 * 300.15, R = 1e3, C = 100e-9, fc = 1 / (2 * Math.PI * R * C);
  const r = await calc(rc, [
    "rmsnoise(onoise)", "value(onoise, 1)", "enbw(onoise)", "ymax(inoise)/ymin(inoise)", "value(inoise, 1k)",
    "rmsnoise(onoise, 1, 100)", "rmsnoise(onoise)/ymax(onoise/inoise)", "sqrt(kb*tnom/100n)", "f3db(onoise)",
  ]);
  if (r) {
    console.log("  " + r.netlist.split("\n").filter(l => l.startsWith(".") || l.startsWith("V1")).join("   "));
    expect(r, 0, Math.sqrt(kT / C), 3e-3, "전체 출력 잡음 = √(kT/C)");
    expect(r, 1, Math.sqrt(4 * kT * R), 1e-4, "저항의 열잡음 √(4kTR)");
    expect(r, 2, (Math.PI / 2) * fc, 5e-3, "잡음 대역폭 = π/2·fc (식 7.146)");
    expect(r, 3, 1, 1e-6, "입력 환산 잡음은 평평하다 (출력 잡음 ÷ 이득)");
    expect(r, 4, Math.sqrt(4 * kT * R), 1e-4, "입력 환산 밀도");
    expect(r, 5, Math.sqrt(4 * kT * R * 99) * Math.sqrt(1 - (100 / fc) ** 2 / 3), 2e-3, "1~100 Hz 대역의 잡음");
    expect(r, 6, Math.sqrt(kT / C), 3e-3, "입력 환산 RMS: 출력에서 적분하고 이득으로 나눈다 (7.9절)");
    expect(r, 7, Math.sqrt(kT / C), 1e-9, "식으로 셈한 kT/C");
    expect(r, 8, fc, 2e-3, "잡음 밀도의 −3 dB 도 fc 다");
    ok((r.rows[0].value as { unit: string }).unit === "V" && r.run.kind === "noise", "단위 V, 해석 종류 noise");
  }
}

// ── 4. 왜곡: 다항식 비선형 ────────────────────────────────────────────
console.log("\n=== 다항식 비선형 (동작 전원) — HD2 · HD3 · THD (Razavi 14장) ===");
{
  const A = 0.5, a1 = 1, a2 = 0.1, a3 = 0.05;
  const c = circuit("polynomial", { kind: "tran", tstop: "5m", tmax: "0.5u", tstart: "0" });
  c.put("vsin", { p: "x", n: "0" }, { va: String(A), freq: "1k" });
  c.put("bv", { p: "out", n: "0" }, { value: `${a1}*V(x)+${a2}*V(x)*V(x)+${a3}*V(x)*V(x)*V(x)` });
  c.put("r", { "1": "out", "2": "0" }, { value: "1k" });
  /*
   * ngspice 의 기본 허용 오차(reltol 1e-3)로는 동작 전원의 출력이 f(v(x)) 와 4e-6 V 쯤 어긋난 채로
   * 받아들여진다 — 뉴턴 반복이 예측값에서 선형화한 값으로 끝나서다. 그 오차가 고조파로 읽혀 HD2 가
   * 1.6e-4 (= (ω·h)², h 2 µs), HD3 가 그 세 배 틀린다 (재 봤다). 계산기가 아니라 엔진의 오차이므로,
   * 닫힌 식과 맞대 보려면 엔진을 조인다. 사용자도 −80 dB 아래의 왜곡을 보려면 이렇게 해야 한다.
   */
  c.sheet.spice.push({ id: "opt", at: [0, 200], lines: [".options reltol=1e-6"], active: true });
  const fund = a1 * A + (3 * a3 * A ** 3) / 4;
  const hd2 = (a2 * A * A / 2) / fund, hd3 = (a3 * A ** 3 / 4) / fund;
  const r = await calc(c.project, [
    "harmonic(v(out), 1, 1k)", "hd(v(out), 2, 1k)", "hd(v(out), 3, 1k)", "thd(v(out), 1k)", "thd(v(out))",
    "mean(v(out), 1m, 5m)", "value(mag(fft(v(out), 1m, 5m, 8192, rect)), 2k)", "freq(v(x))", "sfdr(v(out))",
    "thd(v(x))", "rms(v(x))", "hd(v(out), 4, 1k)",
  ]);
  if (r) {
    expect(r, 0, fund, 1e-6, "기본파 α1·A + 3α3·A³/4");
    expect(r, 1, hd2, 2e-5, "HD2");
    expect(r, 2, hd3, 5e-5, "HD3");
    expect(r, 3, Math.hypot(hd2, hd3), 2e-5, "THD");
    expect(r, 4, Math.hypot(hd2, hd3), 2e-5, "THD — 기본 주파수를 스스로 찾는다");
    expect(r, 5, a2 * A * A / 2, 1e-4, "짝수 차 항이 만드는 직류");
    expect(r, 6, a2 * A * A / 2, 2e-3, "FFT 의 2 kHz 빈 (다시 찍을 때의 보간 오차가 있다)");
    expect(r, 7, 1000, 1e-6, "입력의 주파수");
    expect(r, 8, -20 * Math.log10(hd2), 1e-4, "SFDR");
    ok(num(r, 9) < 1e-6, "순수한 사인의 THD 는 0 에 가깝다 (맞추기의 바닥)", num(r, 9).toExponential(1));
    expect(r, 10, A / Math.SQRT2, 1e-5, "RMS = A/√2");
    ok(num(r, 11) < 1e-6, "4차 고조파는 없다", num(r, 11).toExponential(1));
  }
}

// ── 5. 계단 응답 ──────────────────────────────────────────────────────
console.log("\n=== RC 계단 응답 — 정착 · 상승 시간 (예제 9.2) ===");
{
  const step = DEMOS.find(d => d.name === "RC step response")!.build();   // τ = 100 µs, 0 -> 5 V
  const tau = 1e-4;
  const r = await calc(step, ["settling(v(out), 1)", "risetime(v(out))", "overshoot(v(out))", "value(v(out), 100u)", "cross(v(out), 2.5)", "ymax(deriv(v(out)))", "slewrate(v(out))"]);
  if (r) {
    // 1 ms 에서 끝나는 실행이라 '끝 값' 이 5 V 가 아니라 5(1 − e⁻¹⁰) 이다. 그 값 기준의 1 % 띠로 잰다
    const yf = 5 * (1 - Math.exp(-10));
    expect(r, 0, -tau * Math.log(1 - (yf - 0.01 * yf) / 5), 2e-3, "1 % 정착 시간 ≈ τ·ln 100");
    expect(r, 1, tau * Math.log((5 - 0.1 * yf) / (5 - 0.9 * yf)), 2e-3, "10–90 % 상승 시간 ≈ τ·ln 9");
    ok(num(r, 2) < 1e-6, "1차 계는 오버슈트가 없다");
    expect(r, 3, 5 * (1 - Math.exp(-1)), 1e-3, "v(τ) = 5(1 − 1/e)");
    expect(r, 4, tau * Math.log(2), 2e-3, "절반에 닿는 시각 = τ·ln 2");
    expect(r, 5, 5 / tau, 2e-2, "처음 기울기 = V/τ");
    ok((r.rows[6].value as { unit: string }).unit === "V/s" && /V\/µs/.test(formatValue(r.rows[6].value!)), "슬루율은 V/µs 로 적는다", formatValue(r.rows[6].value!));
  }
}

// ── 6. 전달 함수: 분압기 ──────────────────────────────────────────────
console.log("\n=== 분압기, 전달 함수 — 저항만으로 딱 떨어지는 값 ===");
{
  const div = DEMOS.find(d => d.name === "Voltage divider")!.build();    // 5 V, 10k, 4.7k
  div.sim = { kind: "tf", out: "out", src: "V1" };
  const r = await calc(div, ["tf_gain", "tf_rin", "tf_rout"]);
  if (r) {
    expect(r, 0, 4.7 / 14.7, 1e-12, "이득 = R2/(R1 + R2)");
    expect(r, 1, 14.7e3, 1e-12, "입력 저항 = R1 + R2");
    expect(r, 2, (10e3 * 4.7e3) / 14.7e3, 1e-12, "출력 저항 = R1 ‖ R2");
  }
}

// ── 7. 두 번 돌려 비교: 보관한 실행 ───────────────────────────────────
console.log("\n=== 보관한 실행 — 저항을 바꿔 두 번 돌리고 비교한다 ===");
{
  const mk = (rd: string) => {
    const p = csAmp({ kind: "ac", sweep: "dec", points: "5", fstart: "1", fstop: "1k" });
    p.sheets[0].parts.find(x => x.ref === "R1")!.params.value = rd;
    return p;
  };
  const a = await calc(mk("10k"), ["dcgain(v(out)/v(in))"]);
  if (a) {
    const b = await calc(mk("5k"), ["dcgain(a.v(out)/a.v(in)) / dcgain(v(out)/v(in))", "a.gm(M1)"], new Map([["a", a.run]]));
    if (b) {
      // RD 가 바뀌면 VDS · gm 도 바뀐다. 두 실행 각각의 손계산 이득의 비
      const vds5 = (5 - 0.5 * BETA * VOV * VOV * 5e3) / (1 + 0.5 * BETA * VOV * VOV * LAMBDA * 5e3);
      const av5 = (BETA * VOV * (1 + LAMBDA * vds5)) / (1 / 5e3 + GDS);
      expect(b, 0, -AV / av5, 1e-7, "두 실행의 이득 비");
      ok(/not recorded|No part|press Run/.test(b.rows[1].error ?? "") , "보관한 실행에 없는 소자 값은 다시 물을 수 없다고 알려 준다", b.rows[1].error ?? "(오류 없음)");
    }
  }
}

// ── 8. 엔진에 없는 것을 물었을 때 ─────────────────────────────────────
console.log("\n=== 엔진에 없는 소자 파라미터 — 실행을 잃지 않는다 ===");
{
  // 표가 아는 모델이면 묻기 전에 막는다
  const known = await calc(csAmp({ kind: "op" }), ["op(M1, vth)", "@m1[cgg]", "v(out)"]);
  if (known) {
    ok(!known.netlist.includes(".save"), "레벨 1 에 없는 vth · cgg 는 저장 줄에 넣지 않는다");
    ok(/no "vth".*von/.test(known.rows[0].error ?? "") && /no "cgg"/.test(known.rows[1].error ?? ""), "대신 그 모델에 무엇이 있는지 알려 준다", known.rows[0].error ?? "");
    expect(known, 2, VDS, 1e-8, "다른 줄은 그대로 계산된다");
  }
  /*
   * 표가 모르는 모델(외부 .sp 의 것)이나 손으로 적은 @소자[이름] 은 걸러 낼 수 없다. 여기서는 손으로 없는
   * 이름을 넣어 그 경우를 만든다: 엔진이 결과 없이 멈추고, **그 벡터만** 뺀 넷리스트로 다시 돌려 결과를 낸다.
   * 같이 물은 gm 은 살아남아야 한다.
   */
  const pr = csAmp({ kind: "op" });
  const sh = pr.sheets[0];
  const base = buildNetlist(sh, pr.library, extractNets(sh, pr.library), pr.sim, pr.name);
  const quiet = console.log, qe = console.error;
  const attempt = async (save: string, fallback: string | undefined) => {
    const nl = beforeEnd(base, [save]);
    console.log = console.error = () => {};
    const t0 = performance.now();
    let fresh = 0;
    try {
      const out = await runWithFallback<any, Simulation>(await engine(nl), nl, fallback, async () => { fresh++; return engine(base); });
      console.log = quiet; console.error = qe;
      return { out, fresh, ms: performance.now() - t0, stuck: "" };
    } catch (e) {
      console.log = quiet; console.error = qe;
      return { out: null, fresh, ms: performance.now() - t0, stuck: e instanceof EngineStuck ? "stuck" : String(e) };
    }
  };
  const one = await attempt(".save all @m1[gm] @m1[bogus]", base);
  ok(!!one.out, "없는 이름을 물어도 결과가 나온다", one.stuck);
  if (one.out) {
    ok(one.out.unavailable.join() === "@m1[bogus]" && one.fresh === 1, "무엇이 없었는지 알려 주고, 새 엔진으로 한 번 더 돌렸다", one.out.unavailable.join());
    ok(one.out.netlist.includes(".save all @m1[gm]") && !one.out.netlist.includes("bogus"), "결과를 낸 것은 그 벡터만 뺀 넷리스트다");
    const run = runFromTraces(toTraces(one.out.result.data), { kind: "op", devices: parseDevices(one.out.netlist), unavailable: one.out.unavailable });
    const rows = evaluateRows(["v(out)", "op(M1, bogus)", "gm(M1)"], run, new Map());
    ok(rows[0].value?.t === "num" && Math.abs(rows[0].value.re / VDS - 1) < 1e-8, "전압은 그대로 읽힌다");
    ok(/no "bogus"/.test(rows[1].error ?? ""), "없는 값을 쓴 줄은 이유를 말한다", rows[1].error ?? "");
    ok(rows[2].value?.t === "num" && Math.abs(rows[2].value.re / GM - 1) < 1e-8, "같이 물은 gm 은 살아남는다 (통째로 빼지 않는다)", rows[2].error ?? "");
    ok(one.ms < 5000, `두 번 도는 데 ${one.ms.toFixed(0)} ms`);
  }
  // ngspice 는 없는 벡터를 한 번에 하나만 알려 준다. 둘이면 두 번 더 돈다
  const two = await attempt(".save all @m1[bogus] @m1[gm] @m1[cgg]", base);
  ok(!!two.out && two.out.unavailable.join() === "@m1[bogus],@m1[cgg]" && two.fresh === 2, "없는 것이 둘이면 하나씩 빼며 두 번 더 돈다", two.out ? two.out.unavailable.join() + ` · 새 엔진 ${two.fresh}번` : two.stuck);
  ok(!!two.out && two.out.result.data.some((d: any) => d.name === "@m1[gm]"), "그래도 gm 은 남는다");
  const none = await attempt(".save all @m1[gm] @m1[bogus]", undefined);
  ok(!!none.out && none.out.unavailable.join() === "@m1[bogus]", "되돌릴 넷리스트가 없어도 그 벡터만 빼고 돈다");
  // 계산기 탓이 아닌 멈춤(떠 있는 노드)은 다시 돌리지 않고 예전처럼 끝난다
  const float = "floating\nEU1 out 0 a b 1e6\nR1 out 0 1k\n.op\n.save all @r1[i]\n.end";
  console.log = console.error = () => {};
  let again = 0, floated = "";
  try { await runWithFallback<any, Simulation>(await engine(float), float, float.replace(".save all @r1[i]\n", ""), async () => { again++; return engine(float); }); }
  catch (e) { floated = e instanceof EngineStuck ? "stuck" : String(e); }
  console.log = quiet; console.error = qe;
  ok(floated === "stuck" && again === 0, "떠 있는 노드로 멈춘 것은 계산기 탓으로 돌리지 않는다 (다시 돌리지 않는다)", `${floated} · 다시 ${again}번`);
}

// ── 9. 예제마다 들어 있는 계산기 줄 ───────────────────────────────────
/*
 * 예제를 열면 Calculator 탭에 줄이 이미 들어 있다 (src/lib/demos.ts). 앱이 하는 그대로 돌려서
 *   - 모든 줄이 오류 없이 값을 내는지, 엔진에 없는 소자 값을 묻지 않는지
 *   - 값이 손계산과 맞는지, 단위가 바로 붙는지 — 예제는 보고 따라 쓰는 곳이라 틀린 단위가 특히 나쁘다
 * 를 본다. 예제 회로를 고치면서 줄을 그대로 두면(넷 이름이나 소자 번호가 바뀌면) 여기서 깨진다.
 * 줄은 이름(gain = …)이나, 주석을 뺀 식 그대로 찾는다.
 */
console.log("\n=== 예제의 계산기 줄 ===");
{
  const VT = (1.380649e-23 * 300.15) / 1.602176634e-19;

  /**
   * 반파 정류기를 손으로 푼다. 다이오드에 용량이 없어(CJO = 0) 순간마다 대수식이다:
   *   vin = Vd + R·Is·(e^(Vd/VT) − 1),  출력 = vin − Vd
   * Vd 에 대해 단조 증가라 이분법으로 푼다. 한 주기를 고르게 2만 점 찍어 평균 · RMS · 고조파를 낸다
   */
  const solveVd = (vin: number, r: number, is: number) => {
    let lo = Math.min(vin, 0) - 1, hi = Math.max(vin, 0) + 1;
    for (let k = 0; k < 100; k++) {
      const vd = (lo + hi) / 2;
      if (vd + r * is * (Math.exp(vd / VT) - 1) - vin > 0) hi = vd; else lo = vd;
    }
    return (lo + hi) / 2;
  };
  const halfWave = (vp: number, r: number, is: number) => {
    const n = 20000, y = new Float64Array(n);
    for (let k = 0; k < n; k++) { const vin = vp * Math.sin((2 * Math.PI * k) / n); y[k] = vin - solveVd(vin, r, is); }
    let sum = 0, sq = 0;
    for (const v of y) { sum += v; sq += v * v; }
    const amp = (h: number) => {
      let a = 0, b = 0;
      for (let k = 0; k < n; k++) { a += y[k] * Math.cos((2 * Math.PI * h * k) / n); b += y[k] * Math.sin((2 * Math.PI * h * k) / n); }
      return (2 / n) * Math.hypot(a, b);
    };
    let harm = 0;
    for (let h = 2; h <= 10; h++) harm += amp(h) ** 2;
    return { mean: sum / n, rms: Math.sqrt(sq / n), thd: Math.sqrt(harm) / amp(1) };
  };

  interface Got {
    /** 그 줄의 숫자 (단위가 기대와 다르면 따로 모아 둔다) */
    n(key: string, unit: string): number;
    /** 그 줄이 파형이고 단위가 맞는지 */
    w(key: string, unit: string): void;
  }
  const near = (what: string, got: number, want: number, tol: number) => {
    const err = want === 0 ? Math.abs(got) : Math.abs(got / want - 1);
    ok(err <= tol, `  ${what}`, `${got.toPrecision(7)}  기대 ${want.toPrecision(7)}  오차 ${err.toExponential(1)}  허용 ${tol.toExponential(0)}`);
  };
  const within = (what: string, got: number, lo: number, hi: number) =>
    ok(got >= lo && got <= hi, `  ${what}`, `${got.toPrecision(5)}  (${lo} ~ ${hi})`);

  const wRC = 2 * Math.PI * 1e3 * 1e3 * 100e-9;
  const A = 1e6, INV = -10 / (1 + 11 / A);
  const rect = halfWave(10, 1e3, 1e-14), vdPeak = solveVd(10, 1e3, 1e-14);
  const L = 10e-3, C = 100e-9, R = 100;
  const MOS = { beta: 200e-6, vt: 2, lambda: 0.02 }, VOV = 2.5 - MOS.vt;

  const CHECKS: Record<string, (g: Got, r: Ran) => void> = {
    rc: g => {
      near("진폭비 = 1/√(1 + (ωRC)²)", g.n("gain", ""), 1 / Math.hypot(1, wRC), 1e-3);
      near("fc = 1/(2πRC), 단위를 적어 Hz", g.n("fc", "Hz"), 1 / (2 * Math.PI * 1e3 * 100e-9), 1e-12);
      near("손계산 줄", g.n("1/sqrt(1 + (1kHz/fc)^2)", ""), 1 / Math.hypot(1, wRC), 1e-12);
      near("지연 = atan(ωRC)/ω", g.n("lag", "s"), Math.atan(wRC) / (2 * Math.PI * 1e3), 1e-3);
      near("위상 = −atan(ωRC)", g.n("deg(-2*pi*freq(v(in))*lag)", "°"), (-Math.atan(wRC) * 180) / Math.PI, 1e-3);
      near("손계산 줄", g.n("-deg(atan(1kHz/fc))", "°"), (-Math.atan(wRC) * 180) / Math.PI, 1e-12);
      g.w("spectrum", "V");
    },
    inv: g => {
      near("이득 = −(Rf/Rin)/(1 + (1 + Rf/Rin)/A)", g.n("gain", ""), INV, 1e-5);
      near("손계산 줄", g.n("-10k/1k/(1 + (1 + 10k/1k)/1e6)", ""), INV, 1e-12);
      near("출력 꼭대기 사이", g.n("pp(v(out))", "V"), 2 * 0.1 * -INV, 1e-3);
      near("입력 저항 = Rin (− 입력이 가상 접지)", g.n("rin", "Ω"), 1e3, 1e-4);
    },
    rect: g => {
      near("꼭대기의 다이오드 전압 (Shockley 식)", g.n("drop", "V"), vdPeak, 1e-3);
      near("꼭대기 = Vp − Vd", g.n("peak", "V"), 10 - vdPeak, 5e-4);
      near("평균 (손으로 푼 파형)", g.n("avg", "V"), rect.mean, 2e-3);
      near("RMS", g.n("rms(v(out))", "V"), rect.rms, 2e-3);
      near("THD (2 ~ 10차)", g.n("thd(v(out))", ""), rect.thd, 1e-2);
      g.w("spectrum", "V");
    },
    div: g => {
      near("v(out) = 5·R2/(R1 + R2)", g.n("v(out)", "V"), (5 * 4.7) / 14.7, 1e-9);
      near("손계산 줄", g.n("5V*4.7k/(10k + 4.7k)", "V"), (5 * 4.7) / 14.7, 1e-12);
      near("입력 저항 = R1 + R2", g.n("rin", "Ω"), 14.7e3, 1e-9);
      near("두 저항의 전력 = V²/(R1 + R2)", g.n("power(R1) + power(R2)", "W"), 25 / 14.7e3, 1e-9);
      near("전원이 내는 전력도 같다", g.n("power(V1)", "W"), 25 / 14.7e3, 1e-9);
    },
    step: g => {
      near("τ = 상승 시간/ln 9 = RC", g.n("tau", "s"), 1e3 * 100e-9, 1e-3);
      near("손계산 줄 RC", g.n("1kohm*100nF", "s"), 1e3 * 100e-9, 1e-12);
      near("1 % 정착/τ = ln 100", g.n("settling(v(out), 1)/tau", ""), Math.log(100), 2e-3);
      near("손계산 줄", g.n("ln(100)", ""), Math.log(100), 1e-12);
      g.w("ic", "A");
      near("쌓인 전하 = C·V·(1 − e⁻¹⁰)", g.n("q", "C"), 100e-9 * 5 * (1 - Math.exp(-10)), 1e-3);
      near("손계산 줄 C·V", g.n("100nF*5V", "C"), 100e-9 * 5, 1e-12);
    },
    rlc: g => {
      const f0 = 1 / (2 * Math.PI * Math.sqrt(L * C));
      g.w("bode", "dB");
      g.w("ph", "°");
      near("공진 = 1/(2π√(LC))", g.n("f0", "Hz"), f0, 1e-3);
      near("손계산 줄", g.n("1/(2*pi*sqrt(10mH*100nF))", "Hz"), f0, 1e-12);
      near("반전력점 = 20·log(1/√2)", g.n("hp", "dB"), 20 * Math.log10(Math.SQRT1_2), 1e-12);
      near("대역폭 = R/(2πL)", g.n("band", "Hz"), R / (2 * Math.PI * L), 1e-3);
      near("손계산 줄", g.n("100ohm/(2*pi*10mH)", "Hz"), R / (2 * Math.PI * L), 1e-12);
      near("Q = √(L/C)/R", g.n("q", ""), Math.sqrt(L / C) / R, 1e-3);
      near("손계산 줄", g.n("sqrt(10mH/100nF)/100ohm", ""), Math.sqrt(L / C) / R, 1e-12);
    },
    "inv-cmos": g => {
      near("문턱 = VDD/2 (맞춘 두 소자)", g.n("vm", "V"), 2.5, 1e-4);
      g.w("gain", "");
      const nml = g.n("nml", "V"), nmh = g.n("nmh", "V");
      near("NML = NMH (대칭)", nml, nmh, 1e-3);
      // λ 를 뺀 교과서 식. λ = 0.02 가 전환을 조금 무르게 해서 1 % 안쪽으로 비킨다
      near("NML ≈ (3VDD + 2VT)/8 (λ = 0 의 식)", nml, (3 * 5 + 2 * MOS.vt) / 8, 2e-2);
      g.w("av", "");
      near("문턱의 이득 = −2(1 + λ·VDS)/(λ·Vov)", g.n("value(av, vm)", ""), (-2 * (1 + MOS.lambda * 2.5)) / (MOS.lambda * VOV), 1e-4);
      const id = 0.5 * MOS.beta * VOV ** 2 * (1 + MOS.lambda * 2.5);
      near("관통 전류 = ½β·Vov²·(1 + λ·VDS)", g.n("ymax(id(M2))", "A"), id, 1e-4);
      near("손계산 줄", g.n("0.5*200uA*(2.5 - 2)^2*(1 + 0.02*2.5)", "A"), id, 1e-12);
    },
    ce: g => {
      g.w("gain", "");
      const av = g.n("av", ""), gmq = g.n("gmq", "S"), rpiq = g.n("rpiq", "Ω");
      near("이득 = −gm·RC/(1 + RB/rπ)", av, (-gmq * 10e3) / (1 + 100e3 / rpiq), 2e-3);
      near("손계산 줄", g.n("-gmq*10kohm/(1 + 100kohm/rpiq)", ""), (-gmq * 10e3) / (1 + 100e3 / rpiq), 1e-12);
      near("gm·rπ = BF (Early · 고주입 없음)", gmq * rpiq, 100, 1e-6);
      near("IC/gm = kT/q (27 °C)", g.n("value(ic(Q1), 0.9)/gmq", "V"), VT, 1e-3);
      near("손계산 줄 kT/q", g.n("kb*tnom/q", "V"), VT, 1e-12);
      within("포화된 VCE", g.n("ymin(v(c))", "V"), 0, 0.3);
    },
    "inv-sky130": (g, r) => {
      const vm = g.n("vm", "V");
      within("문턱 (pFET 이 약해 VDD/2 아래)", vm, 0.6, 0.9);
      g.w("gain", "");
      const nml = g.n("nml", "V"), nmh = g.n("nmh", "V");
      within("NML", nml, 0.4, 0.9);
      within("NMH", nmh, 0.4, 0.9);
      ok(nml < nmh, "  문턱이 낮으니 NML < NMH", `${nml.toFixed(3)} < ${nmh.toFixed(3)}`);
      g.w("av", "");
      const dev = g.n("value(av, vm)", "");
      within("문턱의 이득 (소자 값)", dev, -40, -5);
      // 전환이 무른 공정 소자는 20 mV 스윕의 미분으로도 그 이득이 나온다 — 두 길이 0.5 % 안에서 만난다
      const curve = r.rows.find(x => x.name === "gain")?.value;
      const i = curve?.t === "wave" ? curve.x.findIndex(x => x >= vm) : -1;
      if (curve?.t === "wave" && i > 0) {
        const t = (vm - curve.x[i - 1]) / (curve.x[i] - curve.x[i - 1]);
        near("전달 곡선의 기울기 = 소자 값의 이득", curve.re[i - 1] + (curve.re[i] - curve.re[i - 1]) * t, dev, 1e-2);
      } else ok(false, "  전달 곡선의 기울기 = 소자 값의 이득", "gain 파형에서 문턱을 못 찾았다");
      within("관통 전류", g.n("ymax(id(X2))", "A"), 1e-6, 1e-4);
      within("nFET 의 VTH", g.n("value(vth(X2), vm)", "V"), 0.3, 1.0);
    },
    "ota-sky130": g => {
      g.w("bode", "dB");
      g.w("phi", "°");
      const a0 = g.n("a0", "");
      near("A0 = gm3/(gds2 + gds4) (소자 값)", g.n("gm(X3)/(gds(X2) + gds(X4))", ""), a0, 2e-3);
      // 출력 마디에는 1 pF 말고 소자의 기생 용량도 있다 — 손계산이 그만큼(1.4 %) 높다
      const fu = g.n("fu", "Hz"), hand = g.n("gm(X3)/(2*pi*1pF)", "Hz");
      ok(hand > fu && hand / fu - 1 < 0.03, "  fu ≈ gm3/(2π·CL), 기생 용량만큼 손계산이 높다", `${(hand / 1e6).toFixed(2)} MHz 대 ${(fu / 1e6).toFixed(2)} MHz`);
      within("위상 여유", g.n("pm(v(out)/v(inp))", "°"), 85, 90);
      within("gm/ID", g.n("gmid(X3)", "V⁻¹"), 5, 30);
    },
    "strongarm-sky130": g => {
      g.w("d", "V");
      // 클럭은 1 ns 뒤 50 ps 에 걸쳐 오르고 10 ns 마다 되풀이된다: 둘째 가장자리가 0.9 V 를 지나는 때는 11.025 ns
      near("둘째 클럭 가장자리", g.n("tc2", "s"), 11.025e-9, 1e-4);
      const t1 = g.n("t1", "s"), t2 = g.n("t2", "s");
      within("결정 시간 (+10 mV)", t1, 50e-12, 300e-12);
      ok(Math.abs(t1 - t2) < 5e-12, "  좌우 대칭: 두 결정 시간이 같다", `${((t1 - t2) * 1e12).toFixed(2)} ps`);
      near("+10 mV 면 outp 가 VDD", g.n("value(d, 4.5n)", "V"), 1.8, 1e-2);
      near("−10 mV 면 outn 이 VDD", g.n("value(d, 14.5n)", "V"), -1.8, 1e-2);
      const p = g.n("p", "W");
      within("평균 전력", p, 1e-7, 1e-4);
      near("결정 한 번의 에너지 = P·T", g.n("p*period(v(clk))", "J"), p * 10e-9, 1e-6);
    },
  };

  for (const demo of DEMOS) {
    const pr = demo.build();
    const rows = pr.calc ?? [];
    console.log(`\n  -- ${demo.name} (${pr.sim.kind}, ${rows.length}줄)`);
    ok(rows.length > 0 && !!CHECKS[demo.id], `${demo.name}: 계산기 줄과 그 검사가 있다`);
    if (!rows.length) continue;
    const r = await calc(pr, rows);
    if (!r) continue;
    const bad = r.rows.filter(x => !x.blank && (x.error || !x.value));
    ok(bad.length === 0, `${demo.name}: 모든 줄이 값을 낸다`, bad.map(x => `${x.src} -> ${x.error}`).join(" / "));
    ok(r.unavailable.length === 0, `${demo.name}: 엔진에 없는 소자 값을 묻지 않는다`, r.unavailable.join(", "));
    const find = (key: string) => r.rows.find(x => x.name === key || x.src.split("#")[0].trim() === key);
    const units: string[] = [];
    const got: Got = {
      n(key, unit) {
        const row = find(key), v = row?.value;
        if (v?.t !== "num") { ok(false, `  ${key}: 숫자가 나온다`, row ? row.error ?? v?.t ?? "값 없음" : "그런 줄이 없다"); return NaN; }
        if (v.unit !== unit) units.push(`${key}: '${v.unit}' (기대 '${unit}')`);
        return v.re;
      },
      w(key, unit) {
        const row = find(key), v = row?.value;
        ok(v?.t === "wave" && v.x.length > 10, `  ${key}: 파형이 나온다`, v?.t === "wave" ? `${v.x.length}점` : row?.error ?? "그런 줄이 없다");
        if (v?.t === "wave" && v.unit !== unit) units.push(`${key}: '${v.unit}' (기대 '${unit}')`);
      },
    };
    CHECKS[demo.id]?.(got, r);
    ok(units.length === 0, `${demo.name}: 단위가 바로 붙는다`, units.join(" / "));
  }
}

console.log(fail === 0 ? "\n계산기 종단 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
