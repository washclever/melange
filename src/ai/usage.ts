/**
 * 어시스턴트가 쓴 것의 기록 — 요청마다, 대화 요약마다, 프로젝트 메모를 고칠 때마다 모델 · 호출 수 · 토큰
 * (캐시에서 읽은 것 · 캐시에 쓴 것) · 크레딧 · 걸린 시간을 남긴다. 프로젝트마다 이 브라우저에 둔다
 * (kv.ts). 새 대화를 시작해도 남는다 — 돈은 대화가 아니라 프로젝트에 든다.
 *
 * 크레딧은 OpenRouter 가 알려 줄 때만 센다 (usage.cost). 모르는 것을 어림해 적지 않는다.
 */
import { uid } from "../doc/types.ts";
import { kvGet, kvSet } from "./kv.ts";
import { cachedTokens, type Usage } from "./openrouter.ts";

export type UsageKind = "request" | "summary" | "memo";

export const KIND_LABEL: Record<UsageKind, string> = {
  request: "Requests",
  summary: "Conversation summaries",
  memo: "Project memo",
};

export interface UsageEntry {
  id: string;
  kind: UsageKind;
  /** 무엇이었나 (요청의 글, 줄여서) */
  label: string;
  /** 시작한 때 (ms) 와 걸린 시간 (ms) */
  at: number;
  ms: number;
  model: string;
  calls: number;
  prompt: number;
  cached: number;
  written: number;
  completion: number;
  /** 크레딧 (알려 준 것만) */
  cost: number;
  tools: number;
  /** 모델에게 보낸 그림 수 */
  images: number;
  /** 아직 도는 중 */
  running?: boolean;
}

export interface UsageTotals { count: number; calls: number; prompt: number; cached: number; completion: number; cost: number; ms: number; tools: number; images: number }

export const emptyTotals = (): UsageTotals => ({ count: 0, calls: 0, prompt: 0, cached: 0, completion: 0, cost: 0, ms: 0, tools: 0, images: 0 });

export function addTo(t: UsageTotals, e: UsageEntry): UsageTotals {
  t.count++; t.calls += e.calls; t.prompt += e.prompt; t.cached += e.cached; t.completion += e.completion;
  t.cost += e.cost; t.ms += e.ms; t.tools += e.tools; t.images += e.images;
  return t;
}

/** 프로젝트마다 남기는 줄 수. 넘으면 오래된 것부터 버린다 */
const MAX_ENTRIES = 500;
const KEY = "usage:";

/** 하나의 일이 쓰는 것을 모은다. end() 에서 기록에 들어간다 */
export class UsageTask {
  readonly entry: UsageEntry;
  private readonly log: UsageLog;
  private readonly t0: number;
  constructor(log: UsageLog, entry: UsageEntry) {
    this.log = log;
    this.entry = entry;
    this.t0 = Date.now();
  }

  /** 모델 호출 하나 */
  chat(model: string, u: Usage | null): void {
    const e = this.entry;
    e.model = model;
    e.calls++;
    if (u) {
      e.prompt += u.prompt_tokens ?? 0;
      const c = cachedTokens(u);
      e.cached += c.read;
      e.written += c.written;
      e.completion += u.completion_tokens ?? 0;
      if (typeof u.cost === "number" && Number.isFinite(u.cost)) e.cost += u.cost;
    }
    e.ms = Date.now() - this.t0;
    this.log.changed();
  }

  tool(): void { this.entry.tools++; this.log.changed(); }
  images(n: number): void { this.entry.images += n; this.log.changed(); }

  end(): void {
    this.entry.ms = Date.now() - this.t0;
    delete this.entry.running;
    // 모델을 한 번도 못 부른 일(키가 틀렸다, 바로 멈췄다)은 남기지 않는다
    if (!this.entry.calls) this.log.drop(this.entry);
    this.log.changed(true);
  }
}

export class UsageLog {
  entries: UsageEntry[] = [];
  private key = "";
  private gen = 0;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** 그 프로젝트의 기록을 읽는다 (프로젝트가 바뀔 때마다) */
  async open(projectKey: string): Promise<void> {
    const gen = ++this.gen;
    this.flush();
    this.key = projectKey;
    this.entries = [];
    this.emit();
    const saved = await kvGet<UsageEntry[]>(KEY + projectKey).catch(() => undefined);
    if (gen !== this.gen) return;
    // 읽는 사이에 시작한 일은 그대로 두고 앞에 붙인다
    if (Array.isArray(saved)) this.entries = [...saved.filter(e => e && typeof e.at === "number"), ...this.entries];
    this.emit();
  }

  begin(kind: UsageKind, label: string): UsageTask {
    const e: UsageEntry = {
      id: uid(), kind, label: label.replace(/\s+/g, " ").trim().slice(0, 120), at: Date.now(), ms: 0, model: "",
      calls: 0, prompt: 0, cached: 0, written: 0, completion: 0, cost: 0, tools: 0, images: 0, running: true,
    };
    this.entries.push(e);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.emit();
    return new UsageTask(this, e);
  }

  drop(e: UsageEntry): void {
    const i = this.entries.indexOf(e);
    if (i >= 0) this.entries.splice(i, 1);
  }

  /** 바뀌었다 — 듣는 쪽에 알리고, 잠깐 모았다가 저장한다 (now: 바로) */
  changed(now = false): void {
    this.emit();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), now ? 0 : 1500);
  }

  private flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.key) return;
    void kvSet(KEY + this.key, this.entries.map(e => ({ ...e, running: undefined })));
  }

  clear(): void {
    this.entries = [];
    this.changed(true);
  }

  totals(filter?: (e: UsageEntry) => boolean): UsageTotals {
    const t = emptyTotals();
    for (const e of this.entries) if (!filter || filter(e)) addTo(t, e);
    return t;
  }

  /** 모델별 합계, 크레딧 · 토큰이 큰 것부터 */
  byModel(): Array<[string, UsageTotals]> {
    const m = new Map<string, UsageTotals>();
    for (const e of this.entries) {
      const k = e.model || "(unknown)";
      addTo(m.get(k) ?? m.set(k, emptyTotals()).get(k)!, e);
    }
    return [...m].sort((a, b) => b[1].cost - a[1].cost || (b[1].prompt + b[1].completion) - (a[1].prompt + a[1].completion));
  }

  /** 표 계산 프로그램에서 열 수 있는 글 */
  csv(): string {
    const head = ["time", "kind", "label", "model", "model_calls", "prompt_tokens", "cached_tokens", "cache_write_tokens",
      "completion_tokens", "credits", "seconds", "tool_calls", "images"];
    const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows = this.entries.map(e => [
      new Date(e.at).toISOString(), e.kind, q(e.label), q(e.model), e.calls, e.prompt, e.cached, e.written,
      e.completion, e.cost.toFixed(6), (e.ms / 1000).toFixed(1), e.tools, e.images,
    ].join(","));
    return [head.join(","), ...rows].join("\n") + "\n";
  }

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit() { for (const f of this.listeners) f(); }
}
