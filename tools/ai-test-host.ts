// 검증용 편집기 — 어시스턴트가 보는 경계(AssistantHost)를 문서 하나로 흉내 낸다.
//
// 화면 없이 app.ts 와 같은 일을 한다: 명령은 기록을 거쳐 적용하고, 커밋마다 색인 · 넷 추출 · 실행 전
// 검사를 맞추고, 누가 바꿨는지 알린다. 시뮬레이션은 넘겨준 함수로 돌린다 — 도구 검증은 가짜 결과를,
// e2e 는 진짜 ngspice 를 넣는다.
import { History, type Command, type Group } from "../src/doc/history.ts";
import { SheetIndex } from "../src/doc/sheet-index.ts";
import type { Project } from "../src/doc/types.ts";
import { extractNets, type Extraction } from "../src/net/extract.ts";
import { buildNetlist, checkAnalysis, checkCircuit, type Issue } from "../src/net/netlist.ts";
import { describe, evaluateRows, runFromTraces } from "../src/calc/eval.ts";
import { parseDevices } from "../src/calc/devices.ts";
import { CATEGORIES, FUNCTIONS } from "../src/calc/funcs.ts";
import type { Measurement } from "../src/sim-measure.ts";
import type { Trace } from "../src/sim-values.ts";
import type { AssistantHost, CalcRow, ChangeSource, Picture, Results, RunOutcome, WavePicture } from "../src/ai/host.ts";

/** 그림 대신 쓰는 1×1 PNG — 검증은 그림이 어디로 가는지만 본다 */
export const DOT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export interface RunReply { ok: boolean; traces?: Trace[]; measures?: Measurement[]; error?: string; log?: string }

export class TestHost implements AssistantHost {
  pr: Project;
  readonly hist = new History(5000);
  readonly idx = new SheetIndex();
  ex!: Extraction;
  iss: Issue[] = [];
  rev = 0;
  res: { traces: Trace[]; measures: Measurement[]; kind: string; rev: number; log: string; netlist: string } | null = null;
  err = "";
  sel: string[] = [];
  shown: string[] = [];
  runs = 0;
  private readonly fns = new Set<(s: ChangeSource) => void>();
  /** 넷리스트를 받아 결과를 돌려준다 */
  engine: (netlist: string) => Promise<RunReply>;

  constructor(project: Project, engine?: (netlist: string) => Promise<RunReply>) {
    this.pr = project;
    this.engine = engine ?? (async () => ({ ok: false, error: "no engine in this test" }));
    this.commit("load");
  }

  /** app.ts 의 commit 과 같은 일 */
  commit(source: ChangeSource) {
    this.rev++;
    this.idx.sync(this.sheet(), this.pr.library);
    this.ex = extractNets(this.sheet(), this.pr.library);
    this.iss = [...checkCircuit(this.sheet(), this.pr.library, this.ex), ...checkAnalysis(this.pr.sim, this.sheet(), this.pr.library)];
    for (const f of this.fns) f(source);
  }

  /** 사람이 손으로 고친 것 */
  userEdit(cmd: Command) {
    this.hist.run(this.sheet(), cmd, [], []);
    this.commit("user");
  }

  /** 문서를 통째로 갈아끼운다 (다른 프로젝트 열기) */
  load(p: Project) {
    this.pr = p;
    this.hist.clear();
    this.res = null;
    this.commit("load");
  }

  project() { return this.pr; }
  sheet() { return this.pr.sheets[0]; }
  library() { return this.pr.library; }
  extraction() { return this.ex; }
  index() { return this.idx; }
  issues() { return this.iss; }
  netlist() { return buildNetlist(this.sheet(), this.pr.library, this.ex, this.pr.sim, this.pr.name, this.pr.meas ?? []); }
  external() { return false; }
  selection() { return this.sel; }
  results(): Results | null {
    if (!this.res) return null;
    return { traces: this.res.traces, measures: this.res.measures, kind: this.res.kind, current: this.res.rev === this.rev, log: this.res.log };
  }
  lastError() { return this.err; }
  projectKey() { return this.sheet().id; }
  edit(cmd: Command, group: Group) {
    this.hist.run(this.sheet(), cmd, [], [], group);
    this.commit("ai");
  }
  undoGroup() { return this.hist.undoGroup; }
  undo() {
    if (this.hist.undo(this.sheet()) !== undefined) this.commit("user");
  }

  async simulate(): Promise<RunOutcome> {
    const errs = this.iss.filter(i => i.level === "error");
    if (errs.length) return { ok: false, stage: "check", issues: errs };
    this.runs++;
    const netlist = this.netlist();
    const r = await this.engine(netlist);
    if (!r.ok) {
      this.err = r.error ?? "failed";
      return { ok: false, stage: "engine", error: this.err };
    }
    this.err = "";
    this.res = { traces: r.traces ?? [], measures: r.measures ?? [], kind: this.pr.sim.kind, rev: this.rev, log: r.log ?? "", netlist };
    return { ok: true, runMs: 1 };
  }
  stopSimulation() { /* 검증에서는 멈출 것이 없다 */ }

  async calcValues(): Promise<CalcRow[] | null> {
    const rows = this.pr.calc ?? [];
    const run = this.res ? runFromTraces(this.res.traces, { kind: this.res.kind as never, devices: parseDevices(this.res.netlist), measures: this.res.measures }) : null;
    return evaluateRows(rows, run, new Map()).map(r => ({ src: r.src, name: r.name, text: describe(r), error: r.error, warnings: r.warnings }));
  }
  async calcReference(category?: string) {
    const cats = category ? CATEGORIES.filter(c => c.toLowerCase() === category.toLowerCase()) : CATEGORIES;
    return FUNCTIONS.filter(f => (cats as readonly string[]).includes(f.cat)).map(f => `${f.name}(${f.sig}) — ${f.doc}`).join("\n");
  }
  highlighted: string | null = null;
  /** 그림을 그려 달라고 한 것 (검증이 들여다본다) */
  drawn: Array<{ what: "schematic" | "waveform"; opt: unknown }> = [];
  schematicImage(opt: { parts?: string[] }): Picture | null {
    this.drawn.push({ what: "schematic", opt });
    if (!this.sheet().parts.length && !this.sheet().wires.length) return null;
    return { url: DOT, width: 1, height: 1 };
  }
  waveformImage(opt: { signals?: string[]; from?: number; to?: number }): WavePicture | { error: string } {
    this.drawn.push({ what: "waveform", opt });
    if (!this.res) return { error: "no results" };
    const axis = this.res.traces[0];
    const xs = axis.values;
    const shown = opt.signals ?? this.res.traces.filter(t => /^v\(/i.test(t.name)).slice(0, 5).map(t => t.name);
    return { url: DOT, width: 1, height: 1, shown, axis: axis.name, from: opt.from ?? xs[0], to: opt.to ?? xs[xs.length - 1] };
  }
  show(keys: string[], net?: string | null) {
    this.shown = keys;
    if (net !== undefined) this.highlighted = net;
  }
  onChange(fn: (s: ChangeSource) => void) {
    this.fns.add(fn);
    return () => { this.fns.delete(fn); };
  }
}
