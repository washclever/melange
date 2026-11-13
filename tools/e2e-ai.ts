// 어시스턴트 끝까지: 대본대로 답하는 가짜 모델이 도구만으로 RC 저역통과를 빈 시트에 그리고, AC 해석 ·
// .meas · 계산기 줄을 넣고, **진짜 ngspice** 로 돌린다. 모델이 받은 결과를 손계산과 견준다.
//
// 도구 -> 회로도 -> 넷리스트 -> 엔진 -> 결과 요약 -> 모델, 이 길이 키 없이 한 번에 지나가는지 본다.
// 기대값은 데모 1(src/lib/demos.ts)과 같다: R 1k, C 100n 이면 차단 주파수 1/(2πRC) = 1591.55 Hz.
import { Simulation } from "eecircuit-engine";
import { emptyProject, serialize } from "../src/doc/types.ts";
import { toTraces } from "../src/sim-values.ts";
import { diagnose } from "../src/sim-log.ts";
import { measureNames, parseMeasures } from "../src/sim-measure.ts";
import { Agent } from "../src/ai/agent.ts";
import { settings } from "../src/ai/settings.ts";
import { TestHost, type RunReply } from "./ai-test-host.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

/** 실행마다 새 엔진 — 같은 인스턴스로 두 번 잇달아 돌리면 두 번째가 안 끝난다 (README 의 엔진 메모) */
async function engine(netlist: string): Promise<RunReply> {
  const sim = new Simulation();
  await sim.start();
  const before = sim.getInfo?.() ?? "";
  sim.setNetList(netlist);
  const res: any = await sim.runSim();
  const hasData = Array.isArray(res?.data) && res.data.some((d: any) => d?.values?.length > 0);
  const d = diagnose(sim.getError?.() ?? [], hasData);
  if (d.fatal) return { ok: false, error: d.message };
  const after = sim.getInfo?.() ?? "";
  const measures = parseMeasures(after.startsWith(before) ? after.slice(before.length) : after, measureNames(netlist));
  return { ok: true, traces: toTraces(res.data), measures, log: [after, ...d.notes].join("\n") };
}

type Step = string | Array<{ name: string; args: unknown }>;
let script: Step[] = [];
const bodies: any[] = [];
// openrouter.ai 로 가는 것만 가짜로 받는다 — 엔진은 spice.wasm 을 fetch 로 읽는다
const realFetch = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = async (url: string, init: RequestInit = {}) => {
  if (!String(url).includes("openrouter.ai")) return realFetch(url, init);
  bodies.push(JSON.parse(String(init.body)));
  const step = script.shift() ?? "Done.";
  const delta = typeof step === "string" ? { content: step }
    : { tool_calls: step.map((c, index) => ({ index, id: `c${bodies.length}_${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
  const chunk = { choices: [{ delta, finish_reason: typeof step === "string" ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
};
settings.setKey("test-key");
settings.set({ model: "test/model", maxSteps: 30 });

const R = 1e3, C = 100e-9, FC = 1 / (2 * Math.PI * R * C);
console.log(`=== 어시스턴트가 그린 RC 저역통과 (기대 차단 ${FC.toFixed(2)} Hz) ===`);

const host = new TestHost(emptyProject("assistant e2e"), engine);
const empty = serialize(host.project());
const agent = new Agent(host);
script = [
  [{ name: "place_parts", args: { parts: [
    { type: "vsin", at: [0, 0], params: { va: "1", freq: "1k" } },
    { type: "r", at: [6, -4], params: { value: "1k" } },
    { type: "c", at: [12, 0], params: { value: "100n" } },
  ] } }],
  [{ name: "connect", args: { links: [
    { from: "V1.p", to: "R1.1" }, { from: "R1.2", to: "C1.1" },
    { from: "V1.n", net: "0" }, { from: "C1.2", net: "0" },
    { from: "R1.1", net: "in" }, { from: "C1.1", net: "out" },
  ] } }],
  [
    { name: "set_analysis", args: { kind: "ac", sweep: "dec", points: "50", fstart: "10", fstop: "1meg" } },
    { name: "set_measures", args: { lines: ["ac f3db WHEN vdb(out)=-3.0103 FALL=1"] } },
    { name: "set_calculator", args: { rows: ["fc = f3db(v(out)/v(in))", "a0 = dcgain(v(out)/v(in))"] } },
  ],
  [{ name: "run_simulation", args: {} }],
  [{ name: "read_trace", args: { name: "v(out)", at: [FC] } }],
  "The cutoff is at about 1.59 kHz.",
];
await agent.send("Draw an RC low-pass with 1k and 100n and measure its cutoff");

const toolResult = (name: string) => {
  for (let i = 0; i < bodies.length; i++) {
    const msgs = bodies[i].messages as any[];
    const call = msgs.flatMap(m => m.tool_calls ?? []).filter((c: any) => c.function.name === name).at(-1);
    if (!call) continue;
    const res = msgs.find(m => m.role === "tool" && m.tool_call_id === call.id);
    if (res) return JSON.parse(res.content);
  }
  return null;
};

const run = toolResult("run_simulation");
ok(run?.ok === true && run.analysis === "ac" && run.current === true, "시뮬레이션이 돈다", run?.error ?? "");
const f3 = run?.measures?.find((m: any) => m.name === "f3db")?.value;
ok(typeof f3 === "number" && Math.abs(f3 - FC) / FC < 0.002, ".meas 의 차단 주파수", `${f3?.toFixed(2)} Hz, 오차 ${(Math.abs(f3 - FC) / FC * 100).toFixed(3)}%`);
const fcRow = run?.calculator?.find((r: any) => r.row.startsWith("fc"))?.value ?? "";
const fcCalc = /([\d.]+)\s*kHz/.exec(fcRow);
ok(!!fcCalc && Math.abs(Number(fcCalc[1]) * 1e3 - FC) / FC < 0.002, "계산기 f3db 줄", fcRow);
const a0 = run?.calculator?.find((r: any) => r.row.startsWith("a0"))?.value ?? "";
ok(/^1(\.0+)?\b|^0\.99/.test(a0) || /^1\b/.test(a0), "계산기 dcgain 줄 (직류 이득 1)", a0);
const out = run?.traces?.find((t: any) => t.name === "v(out)");
ok(!!out && Math.abs(out.mag_first - 1) < 1e-3 && out.mag_last < 0.01, "결과 요약: 저주파 1, 고주파는 거의 0", out ? `${out.mag_first} -> ${out.mag_last}` : "(없음)");
const rt = toolResult("read_trace");
const at = rt?.rows?.[0];
ok(!!at && Math.abs(at.mag - Math.SQRT1_2) < 0.01 && Math.abs(at.phase + 45) < 1, "차단 주파수에서 |v(out)| = 0.707, 위상 -45°", at ? `${at.mag} · ${at.phase}°` : JSON.stringify(rt));
ok(host.hist.depth === 1, "요청 하나가 실행 취소 한 단계", `${host.hist.depth}`);
ok(host.runs === 1, "엔진을 한 번 돌렸다", `${host.runs}`);
host.undo();
ok(host.sheet().parts.length === 0 && host.project().sim.kind === "tran" && (host.project().meas ?? []).length === 0 && (host.project().calc ?? []).length === 0,
  "되돌리면 부품 · 해석 · .meas · 계산기 줄이 다 처음으로");
ok(serialize(host.project()).replace(/"library": \{[\s\S]*?\n  \},\n/, "") === empty.replace(/"library": \{\},\n/, ""), "부품 정의 사본 말고는 바이트 단위로 처음과 같다");
agent.dispose();

console.log(fail === 0 ? "\n어시스턴트 e2e 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
