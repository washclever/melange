// 회로도를 앱이 하는 그대로 엔진까지 돌린다 — tools/e2e-calc.ts 와 tools/e2e-layout-examples.ts 가 같이 쓴다.
//
// 앱(src/app.ts runJob · 워커)처럼: 실행 전 검사 -> 넷리스트 -> 계산기 줄이 읽는 것을 저장 줄에 보태고 -> ngspice
// (엔진에 없는 것을 물어 멈추면 그것을 빼고 다시) -> 결과를 계산기가 읽는 모양으로 풀어 식을 계산한다.
// SKY130 모델은 넷리스트가 부르는 파일만 엔진의 파일 시스템에 올린다 (워커와 같다).
import { Simulation } from "eecircuit-engine";
import type { Project } from "../src/doc/types.ts";
import { extractNets } from "../src/net/extract.ts";
import { beforeEnd, buildNetlist, checkAnalysis, checkCircuit, savePlan, spiceName } from "../src/net/netlist.ts";
import { toTraces } from "../src/sim-values.ts";
import { diagnose } from "../src/sim-log.ts";
import { EngineStuck, runWithFallback } from "../src/sim-run.ts";
import { calcSaves, evaluateRows, runFromTraces, type RowResult, type RunData } from "../src/calc/eval.ts";
import { parseDevices } from "../src/calc/devices.ts";
import { readFileSync } from "node:fs";

const SKY: Record<string, string> = Object.fromEntries(
  ["sky130-common", "sky130-nfet", "sky130-pfet", "sky130-pfet-hvt"].map(f =>
    ["/" + f + ".spice", readFileSync(new URL("../src/vendor/" + f + ".spice", import.meta.url), "utf8")]));

export async function engine(netlist: string): Promise<Simulation> {
  const s = new Simulation();
  await s.start();
  const FS = (s as unknown as { __getSpiceModuleForTests(): { FS: { writeFile(p: string, d: string): void } } }).__getSpiceModuleForTests().FS;
  for (const line of netlist.split("\n")) {
    const p = line.trim().toLowerCase().startsWith(".include ") ? line.trim().slice(9).trim() : "";
    if (SKY[p]) FS.writeFile(p, SKY[p]);
  }
  return s;
}

export interface Ran { run: RunData; rows: RowResult[]; netlist: string; unavailable: string[] }

/** 돌린 결과, 또는 무엇이 안 됐는지 (what: 단계, error: 엔진 · 검사의 말) */
export async function runCalc(pr: Project, lines: string[], kept: ReadonlyMap<string, RunData> = new Map()): Promise<Ran | { what: string; error: string }> {
  const sh = pr.sheets[0];
  const ex = extractNets(sh, pr.library);
  const errs = [...checkCircuit(sh, pr.library, ex), ...checkAnalysis(pr.sim, sh, pr.library)].filter(i => i.level === "error");
  if (errs.length) return { what: "실행 전 검사 오류 없음", error: errs.map(e => e.message).join(" / ") };
  const base = buildNetlist(sh, pr.library, ex, pr.sim, pr.name);
  const refs = new Map<string, string>();
  for (const p of sh.parts) { const sp = pr.library[p.lib]?.spice; if (sp) refs.set(p.ref, spiceName(p.ref, sp.element)); }
  const nets = new Set([...ex.netNames()].map(n => n.toLowerCase()));
  const extra = calcSaves(lines, parseDevices(base, refs), nets, pr.sim.kind);
  const probed = sh.probes.map(q => ex.netAt(q.at)).filter((n): n is string => !!n);
  const plan = savePlan(ex.netNames(), probed, [], sh.spice, pr.sim.kind, extra);
  const plain = savePlan(ex.netNames(), probed, [], sh.spice, pr.sim.kind);
  const netlist = beforeEnd(base, plan.lines);
  const quiet = console.log, quietErr = console.error, quietInfo = console.info;
  console.log = console.error = console.info = () => {};     // 엔진이 stdout 에 쏟는 알림은 화면에서만 감춘다
  try {
    const out = await runWithFallback<any, Simulation>(await engine(netlist), netlist, extra.length ? beforeEnd(base, plain.lines) : undefined,
      async () => engine(netlist));
    console.log = quiet; console.error = quietErr; console.info = quietInfo;
    const hasData = Array.isArray(out.result?.data) && out.result.data.some((d: any) => d?.values?.length > 0);
    const d = diagnose(out.engine.getError?.() ?? [], hasData);
    if (d.fatal) return { what: "ngspice 오류 없음", error: d.message.slice(0, 300) };
    const inoiseUnit = pr.sim.kind === "noise" && /^i/i.test(pr.sim.src) ? "A/√Hz" : "V/√Hz";
    const run = runFromTraces(toTraces(out.result.data), {
      kind: pr.sim.kind, devices: parseDevices(out.netlist, refs), unavailable: out.unavailable, requested: extra, inoiseUnit,
    });
    return { run, rows: evaluateRows(lines, run, kept), netlist: out.netlist, unavailable: out.unavailable };
  } catch (e) {
    console.log = quiet; console.error = quietErr; console.info = quietInfo;
    return { what: "엔진이 결과를 낸다", error: e instanceof EngineStuck ? e.lines.join(" | ").slice(0, 300) : String(e) };
  }
}
