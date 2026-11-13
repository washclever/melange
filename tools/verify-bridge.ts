// 회로도 -> 레이아웃 넷리스트 (src/layout/bridge.ts) 검증, 그리고 그 넷리스트가 앞단을 지나 원시 소자로 묶이는가.
//
// 시트는 코드로 만들고, 넷은 핀마다 직접 정한다 (배선 기하는 이 검사의 관심이 아니다 — extractNets 대신 같은 꼴의 표).
import { layoutNetlist, quantize } from "../src/layout/bridge.ts";
import { runFrontEnd } from "../src/layout/front/index.mjs";
import { BUILTIN, defaultParams } from "../src/lib/parts.ts";
import { emptyProject, type Part, type Sheet } from "../src/doc/types.ts";
import type { Extraction } from "../src/net/extract.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

/** 부품과 핀의 넷으로 시트와 추출 결과를 만든다. labels: [넷, 종류] */
function build(spec: Array<[lib: string, ref: string, pins: Record<string, string>, params?: Record<string, string>]>,
               labels: Array<[string, "label" | "power" | "gnd"]> = []) {
  const pr = emptyProject("bridge");
  for (const k of Object.keys(BUILTIN)) pr.library[k] = structuredClone(BUILTIN[k]);
  const sheet: Sheet = pr.sheets[0];
  const pinNet = new Map<string, string>();
  let n = 0;
  for (const [lib, ref, pins, params] of spec) {
    const p: Part = { id: "p" + ++n, lib, ref, at: [n * 40, 0], rot: 0, mirror: false, params: { ...defaultParams(BUILTIN[lib]), ...(params ?? {}) } };
    sheet.parts.push(p);
    for (const [pin, net] of Object.entries(pins)) pinNet.set(p.id + ":" + pin, net);
  }
  const at = new Map<string, string>();
  labels.forEach(([net, kind], i) => {
    const pt: [number, number] = [1000 + i * 10, 1000];
    sheet.labels.push({ id: "l" + i, name: net, at: pt, kind });
    at.set(pt.join(","), net);
  });
  const ex = { pinNet, netAt: (p: [number, number]) => at.get(p.join(",")) ?? null } as unknown as Extraction;
  return { sheet, library: pr.library, ex };
}

console.log("크기 맞추기");
ok(JSON.stringify(quantize(1.26e-6, 1)) === "[2,3]", "1.26 um, nf 1 -> 핑거 2 x 3 핀");
ok(JSON.stringify(quantize(10.5e-6, 10)) === "[10,5]", "10.5 um, nf 10 -> 핑거 10 x 5 핀");
ok(JSON.stringify(quantize(100e-6, 1)) === "[64,7]", "100 um, nf 1 -> 핑거가 너무 넓어 늘린다", JSON.stringify(quantize(100e-6, 1)));
ok(quantize(0.2e-6, 2)[1] === 2, "아주 좁으면 2 핀");

console.log("5 트랜지스터 OTA (SKY130)");
const W = { w: "2.52u", l: "0.15u", nf: "4", mult: "1" };
const ota = build([
  ["vdc", "VDD", { p: "vdd", n: "0" }, { dc: "1.8" }],
  ["vdc", "VIP", { p: "vinp", n: "0" }, { dc: "0.9" }],
  ["vdc", "VIN", { p: "vinn", n: "0" }, { dc: "0.9" }],
  ["idc", "IB", { p: "vdd", n: "id" }],
  ["sky130_nfet", "X5", { d: "id", g: "id", s: "0" }, { ...W, w: "1.05u", nf: "2" }],
  ["sky130_nfet", "X4", { d: "tail", g: "id", s: "0" }, { ...W, w: "1.05u", nf: "2" }],
  ["sky130_nfet", "X3", { d: "vout", g: "vinn", s: "tail" }, W],
  ["sky130_nfet", "X0", { d: "net8", g: "vinp", s: "tail" }, W],
  ["sky130_pfet", "X2", { d: "vout", g: "net8", s: "vdd" }, W],
  ["sky130_pfet", "X1", { d: "net8", g: "net8", s: "vdd" }, W],
  ["c", "CL", { 1: "vout", 2: "0" }],
], [["vout", "label"]]);
const ln = layoutNetlist(ota.sheet, ota.library, ota.ex, { name: "ota5" });
ok(ln.top === "OTA5", "서브회로 이름", ln.top);
ok(JSON.stringify(ln.ports) === JSON.stringify(["ID", "VDD", "VINN", "VINP", "VOUT", "VSS"]), "핀 = 빠진 소자·이름표·전원·접지에 닿은 넷", ln.ports.join(" "));
ok(!ln.ports.includes("TAIL") && !ln.ports.includes("NET8"), "트랜지스터끼리만 잇는 넷은 안쪽");
ok(JSON.stringify(ln.constraints) === JSON.stringify({ OTA5: [{ constraint: "PowerPorts", ports: ["VDD"] }, { constraint: "GroundPorts", ports: ["VSS"] }] }),
  "전원·접지 제약 (전원 기호가 없으면 접지에 물린 직류 전압원)", JSON.stringify(ln.constraints));
ok(ln.excluded.join(",") === "VDD,VIP,VIN,IB,CL", "트랜지스터가 아닌 것은 빠진다", ln.excluded.join(","));
ok(/^MX3 VOUT VINN TAIL VSS sky130_fd_pr__nfet_01v8 w=630e-9 l=150e-9 nf=4 m=1$/m.test(ln.text), "nFET 줄 — 몸통은 접지, 핑거 폭 = W / nf (3 핀)", ln.text.split("\n").find((l) => l.startsWith("MX3")));
ok(/^MX2 VOUT NET8 VDD VDD sky130_fd_pr__pfet_01v8 /m.test(ln.text), "pFET 줄 — 몸통은 전원");
ok(ln.devices.X3 === "MX3" && ln.nets.VSS === "0", "부품 -> 소자, 레이아웃 넷 -> 회로도 넷");

const t0 = performance.now();
const { blob, groups } = runFrontEnd(ln.text, ln.top, { userConstraints: ln.constraints });
const names = Object.keys(blob.primitives);
ok(names.some((n) => n.startsWith("DP_NMOS")), "입력 쌍이 차동 쌍(DP)으로 묶인다", names.filter((n) => n.startsWith("DP")).slice(0, 1).join());
ok(names.some((n) => n.startsWith("SCM_NMOS")) && names.some((n) => n.startsWith("SCM_PMOS")), "거울이 전류 거울(SCM)로 묶인다");
const top = blob.topology.modules.find((m: any) => m.name === "OTA5");
ok(top?.instances.length === 3, "블록 셋", String(top?.instances.length));
ok(top?.constraints.some((c: any) => c.constraint === "SymmetricBlocks"), "대칭 제약을 찾는다");
const g = groups.OTA5 ?? {};
ok(Object.values(g).some((d: any) => d.includes("MX3") && d.includes("MX0")), "블록 -> 소자 표 (선택 연동)", JSON.stringify(g));
ok(Object.keys(blob.leaves.leaves).length === names.length, "변형마다 셀 도형", `${names.length} · ${(performance.now() - t0).toFixed(0)} ms`);

console.log("일반 MOS · 홀수 핑거 · 몸통을 소스에");
const inv = build([
  ["vdc", "V1", { p: "vdd", n: "0" }, { dc: "1.8" }],
  ["vpulse", "V2", { p: "in", n: "0" }],
  ["nmos", "M1", { d: "out", g: "in", s: "0" }],
  ["pmos", "M2", { d: "out", g: "in", s: "vdd" }],
], [["vdd", "power"], ["out", "label"]]);
const li = layoutNetlist(inv.sheet, inv.library, inv.ex, { name: "inv", body: "source" });
ok(li.notes.some((n) => /M1: generic NMOS drawn as the SKY130 nFET/.test(n)), "일반 MOS 를 바꿔 그린다고 알린다", li.notes.join(" | "));
ok(li.notes.some((n) => /L 10 um/.test(n)), "L 이 150 nm 가 아니면 알린다");
ok(/^M1 OUT IN VSS VSS /m.test(li.text) && /^M2 OUT IN VDD VDD /m.test(li.text), "몸통 = 소스");
const fi = runFrontEnd(li.text, li.top, { userConstraints: li.constraints });
ok(Object.keys(fi.blob.primitives).length > 0, "앞단을 지난다", Object.keys(fi.blob.primitives).join(" ").slice(0, 80));

console.log("이름이 겹치는 부품");
const dup = build([
  ["sky130_nfet", "N-1", { d: "out", g: "in", s: "0" }, W],
  ["sky130_nfet", "N_1", { d: "out", g: "in", s: "0" }, W],
], [["out", "label"], ["in", "label"]]);
const ld = layoutNetlist(dup.sheet, dup.library, dup.ex);
ok([ld.devices["N-1"], ld.devices["N_1"]].sort().join() === "MN_1,MN_1_1", "식별자로 바꾸면 같은 이름 -> 뒤에 _1 (M 으로 시작)", JSON.stringify(ld.devices));
ok(ld.text.split("\n").filter((l) => /^M/.test(l)).length === 2, "두 줄 다 트랜지스터 줄");

console.log("시트가 정한 핀 (layoutPins — ALIGN 예제)");
{
  // 넷 라벨이 붙은 안쪽 넷(tail, mid)은 보통은 핀이 되지만, layoutPins 가 있으면 그 목록과 전원 · 접지 · R · C 에 닿은 넷만 핀이다
  const lp = build([
    ["sky130_nfet", "X1", { d: "mid", g: "inp", s: "tail" }, W],
    ["sky130_nfet", "X2", { d: "out", g: "inn", s: "tail" }, W],
    ["sky130_nfet", "X3", { d: "tail", g: "vb", s: "0" }, W],
    ["sky130_pfet", "X4", { d: "mid", g: "mid", s: "vdd" }, W],
    ["sky130_pfet", "X5", { d: "out", g: "mid", s: "vdd" }, W],
    ["c", "CL", { 1: "out", 2: "0" }],
  ], [["inp", "label"], ["inn", "label"], ["vb", "label"], ["out", "label"], ["tail", "label"], ["mid", "label"], ["vdd", "power"]]);
  const auto = layoutNetlist(lp.sheet, lp.library, lp.ex, { name: "lp" });
  ok(auto.ports.includes("TAIL") && auto.ports.includes("MID"), "보통은 이름표가 붙은 넷이 핀", auto.ports.join(" "));
  lp.sheet.layoutPins = ["inp", "inn", "vb"];
  const fixed = layoutNetlist(lp.sheet, lp.library, lp.ex, { name: "lp" });
  ok(JSON.stringify(fixed.ports) === JSON.stringify(["INN", "INP", "OUT", "VB", "VDD", "VSS"]), "layoutPins 가 있으면 그 넷 + 전원 · 접지 + C 에 닿은 OUT", fixed.ports.join(" "));
}

console.log("못 그리는 것");
let err = "";
try { layoutNetlist(build([["r", "R1", { 1: "a", 2: "0" }]]).sheet, ota.library, build([]).ex); } catch (e) { err = (e as Error).message; }
ok(/no transistors/.test(err), "트랜지스터가 없으면 알린다", err);

console.log(fail ? `\nFAIL ${fail}` : "\nALL PASS");
process.exit(fail ? 1 : 0);
