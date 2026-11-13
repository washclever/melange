/**
 * 어시스턴트의 대화 — 요청 하나를 받아 OpenRouter 에 보내고, 모델이 부르는 도구를 편집기에 실행하고,
 * 모델이 도구 없이 답할 때까지 되풀이한다.
 *
 *  - 요청 하나의 편집은 실행 취소 한 단계다 (꼬리표 — History.run). 요청 중에 사람이 손으로 고친
 *    것은 따로 한 단계가 되고, 어시스턴트의 작업은 그 앞뒤로 갈린다.
 *  - 사람이 고친 것은 다음에 모델을 부를 때 알려 준다. 요청과 요청 사이에 고친 것은 그 요청의
 *    <editor-context> 에, 요청 도중에 고친 것은 다음 단계 앞의 [editor] 쪽지로 (circuit.ts ChangeLog).
 *  - 대화는 프로젝트마다 이 브라우저에 둔다 (kv.ts). 다시 열면 이어진다. 길어지면 앞부분을 요약한다.
 *  - 프로젝트 메모: 회로를 바꾼 요청이 끝나면 모델이 짧은 노트를 고쳐 둔다 (따로 한 번 부른다). 새 대화는
 *    그 메모를 안고 시작한다 — 대화를 새로 열거나 요약해도 프로젝트에 대해 아는 것이 남는다. 사람도 고친다.
 *
 * DOM 을 쓰지 않는다. 화면(panel.ts)은 이 객체의 상태를 그리고 이벤트를 듣는다.
 */
import { uid } from "../doc/types.ts";
import { ChangeLog, diffSnapshots, floatingPins, simText, snapshot, type Snapshot } from "./circuit.ts";
import { kvDelete, kvGet, kvSet } from "./kv.ts";
import { ApiError, chat, defaultModel, listModels, seesImages, type Message, type Part } from "./openrouter.ts";
import { UsageLog } from "./usage.ts";
import { COMPACT_PROMPT, MEMO_PROMPT, SYSTEM_PROMPT } from "./prompt.ts";
import { settings as defaultSettings, type SettingsStore } from "./settings.ts";
import { runTool, toolSpecs } from "./tools.ts";
import { summaryInput } from "./tools-circuit.ts";
import type { AssistantHost, ChangeSource, Picture } from "./host.ts";

export interface ToolRow {
  name: string;
  /** 모델이 준 인자 (JSON 글) */
  args: string;
  state: "running" | "done" | "error";
  summary?: string;
  /** 모델에게 돌려준 결과 (잘라서) */
  result?: string;
  /** 도구가 모델에게 보여 준 그림 (data: URL). 이 탭에만 — 대화를 저장할 때 뺀다 */
  pics?: string[];
}

export interface Turn {
  id: number;
  role: "user" | "assistant" | "tool" | "note";
  text: string;
  tool?: ToolRow;
  error?: boolean;
  /** 이 요청의 편집 — 그 단계가 맨 위에 있으면 대화 창에서 되돌릴 수 있다 */
  undo?: { group: string; label: string };
  /** 펼쳐 볼 긴 글 (요약된 대화) */
  detail?: string;
  /** 사람이 붙인 그림 (data: URL). 이 탭에만 — 대화를 저장할 때 뺀다 */
  pics?: string[];
  /** 붙인 그림의 수 (저장한 뒤에도 남는다) */
  picCount?: number;
}


type Events = {
  /** 줄 하나가 생기거나 바뀌었다 (null: 전부 다시) */
  update: Turn | null;
  busy: boolean;
  /** 지금 도는 도구 ('' 이면 모델이 생각하거나 쓰는 중) */
  activity: string;
  /** 사용 기록이 바뀌었다 (usage.ts) */
  usage: null;
  /** 프로젝트 메모가 바뀌었거나, 고치기 시작했거나 끝났다 */
  memo: null;
};

/** 프로젝트 메모 — 대화가 바뀌어도 남는 짧은 노트 (kv "memo:<프로젝트>") */
export interface Memo {
  text: string;
  /** 고친 때 (ms) */
  at: number;
  /** 마지막으로 고친 쪽 */
  by: "assistant" | "user";
}

interface Session {
  version: 1;
  turns: Turn[];
  history: Message[];
  conversation: string;
  savedAt: string;
  /** 이 대화에 마지막으로 실어 보낸 프로젝트 메모 */
  memoSent?: string;
}

/** 이보다 길면 요청 전에 앞부분을 요약한다 (글자 수 — 토큰에 대충 비례한다) */
const COMPACT_CHARS = 90_000;
/** 요청 도중에 이보다 길어지면 오래된 요청부터 버린다 */
const MAX_CHARS = 220_000;
/** 요약할 때 그대로 남기는 최근 요청 수 */
const KEEP_REQUESTS = 2;
/** 모델에게 돌려주는 도구 결과의 한계 */
const MAX_RESULT = 24_000;
const SESSION = "session:";
const MEMO = "memo:";
/** 메모의 길이 한계 (글자) */
export const MEMO_MAX = 2000;
const EDITOR_NOTE = "[editor]";
/** 도구가 그린 그림을 싣는 사용자 메시지의 머리 */
const PICTURES = "[pictures]";
/** 한 요청에 붙일 수 있는 그림 수 */
export const MAX_ATTACH = 4;

/** 메시지의 글 — 조각으로 된 것은 글 조각만 잇는다 */
const textOf = (m: Message): string =>
  typeof m.content === "string" ? m.content : (m.content ?? []).map(p => (p.type === "text" ? p.text : "")).join("");
/** 사람이 쓴 것이 아닌 사용자 메시지 — 요청 도중의 [editor] 쪽지, 도구가 그린 그림 */
const isNote = (m: Message): boolean => {
  const t = textOf(m);
  return t.startsWith(EDITOR_NOTE) || t.startsWith(PICTURES);
};
const hasImage = (m: Message): boolean => Array.isArray(m.content) && m.content.some(p => p.type === "image_url");
const imageParts = (urls: readonly string[]): Part[] => urls.map(url => ({ type: "image_url", image_url: { url } }));

let turnSeq = 0;
const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === "AbortError";

export class Agent {
  turns: Turn[] = [];
  busy = false;
  /** 요약을 손으로 돌리는 중 (멈춤 버튼이 멈춘다) */
  working = false;
  activity = "";
  /** 이 프로젝트에서 쓴 토큰 · 크레딧의 기록 (대화를 새로 시작해도 남는다) */
  readonly usageLog = new UsageLog();
  /** 이 프로젝트의 메모 (없으면 null) */
  memo: Memo | null = null;
  /** 메모를 고치는 중 */
  memoBusy = false;

  private history: Message[] = [];
  private conversation = uid();
  private key = "";
  private abort: AbortController | null = null;
  private manual: AbortController | null = null;
  /** 대화를 바꿀 때마다 오른다 — 앞 대화의 요청은 그 뒤로 아무것도 쓰지 않는다 */
  private generation = 0;
  private loading: Promise<void> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Map<keyof Events, Set<(v: never) => void>>();
  /** 사람이 고친 것 (아직 모델에게 알리지 않은) */
  private readonly edits = new ChangeLog();
  /**
   * 어시스턴트가 아는 문서의 모습 — 제 편집 직후, 또는 사람의 편집을 마지막으로 모델에게 넘긴 때의 것.
   * 사람이 고치면 표시(dirty)만 하고 아무것도 계산하지 않는다. 차이는 모델에게 보내기 직전에 한 번 낸다
   * (userChanges). 편집할 때마다 회로 전체를 훑으면 큰 시트에서 끌기 · 값 입력이 그만큼 느려진다.
   */
  private known: Snapshot;
  private dirty = false;
  /** 어시스턴트의 편집 직후 모습을 뜨기로 했다 — 한 번에 몰아친 편집에 한 번만 */
  private snapQueued = false;
  /** 사람의 편집이 어시스턴트의 편집과 섞여 무엇이 사람의 것인지 가를 수 없게 됐다 (드물다) */
  private mixed = false;
  /** 이 요청에서 어시스턴트가 문서를 바꿨다 — 메모를 고칠 만한 요청인가 */
  private edited = false;
  /**
   * 이 대화가 아는 메모 — 실어 보냈거나, 이 대화의 요청을 보고 어시스턴트가 쓴 것. 같으면 다시 싣지 않는다.
   * 그래서 메모가 실리는 것은 대화가 시작될 때(새 대화 · 요약 뒤)와 사람이 메모를 고쳤을 때뿐이다.
   */
  private memoSent = "";
  /** 메모 고치기는 차례로 한다 */
  private memoJob: Promise<void> = Promise.resolve();
  private readonly host: AssistantHost;
  private readonly store: SettingsStore;
  private readonly off: () => void;

  constructor(host: AssistantHost, store: SettingsStore = defaultSettings) {
    this.host = host;
    this.store = store;
    this.known = snapshot(summaryInput(host));
    this.loading = this.openSession();
    this.off = host.onChange(source => this.changed(source));
    this.usageLog.on(() => this.emit("usage", null));
    // 탭을 닫는 순간, 모아 두던 저장을 바로 한다 — 모으는 사이(0.6 초)에 닫으면 마지막 요청이 빠진다
    if (typeof addEventListener === "function") addEventListener("pagehide", this.flush);
  }

  /** 기다리는 저장이 있으면 지금 한다 */
  private readonly flush = () => { if (this.saveTimer) this.save(true); };

  on<K extends keyof Events>(name: K, fn: (v: Events[K]) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, set = new Set());
    set.add(fn as (v: never) => void);
    return () => { set.delete(fn as (v: never) => void); };
  }

  private emit<K extends keyof Events>(name: K, v: Events[K]) {
    for (const f of this.listeners.get(name) ?? []) (f as (v: Events[K]) => void)(v);
  }

  /** 멈추면 될 것이 돌고 있다 */
  get running(): boolean { return this.busy || this.working; }
  get hasHistory(): boolean { return this.history.length > 0; }

  dispose(): void {
    this.off();
    this.stop();
    if (typeof removeEventListener === "function") removeEventListener("pagehide", this.flush);
  }

  // ── 문서가 바뀌었다 ──────────────────────────────────────────────────
  private changed(source: ChangeSource) {
    if (source === "load") {
      // 문서를 통째로 갈아끼웠다. 다른 프로젝트면 그 대화로 간다
      this.known = snapshot(summaryInput(this.host));
      this.dirty = false;
      this.mixed = false;
      this.edits.clear();
      if (this.host.projectKey() !== this.key) {
        if (this.busy) {
          this.stop();
          this.push({ role: "note", text: "Stopped — another project was opened." });
        }
        this.save(true);
        this.loading = this.openSession();
      }
      return;
    }
    // 사람의 편집: 표시만 한다
    if (source === "user") { this.dirty = true; return; }
    // 어시스턴트의 편집. 그 앞의 사람 편집이 아직 넘어가지 않았으면(도구가 기다리는 사이에 고쳤다) 둘이 섞인다
    this.edited = true;
    if (this.dirty) this.mixed = true;
    /*
     * 편집 직후의 모습을 뜬다. 한 도구가 잇달아 여러 번 고치므로(부품마다 · 고리마다) 지금 바로가 아니라
     * 이 동기 구간이 끝날 때 한 번 뜬다. 사람의 입력은 그 뒤에야 처리되므로 사람의 편집이 섞여 들지 않는다.
     */
    if (!this.snapQueued) {
      this.snapQueued = true;
      queueMicrotask(() => {
        this.snapQueued = false;
        this.known = snapshot(summaryInput(this.host));
        this.dirty = false;
      });
    }
  }

  /**
   * 어시스턴트가 마지막으로 안 뒤에 사람이 고친 것 — 모델에게 보내기 직전에 부른다. 고친 것이 없으면
   * 아무것도 훑지 않는다. 같은 것을 여러 번 고쳤으면 처음 값에서 마지막 값으로 하나다 (ChangeLog).
   */
  private userChanges(): string[] {
    if (this.dirty) {
      const now = snapshot(summaryInput(this.host));
      this.edits.add(diffSnapshots(this.known, now));
      this.known = now;
      this.dirty = false;
    }
    const lines = this.edits.describe();
    if (this.mixed) {
      lines.push("(the user also edited the circuit while one of your tools was running, mixed with your own edits — call get_circuit before relying on details)");
    }
    this.edits.clear();
    this.mixed = false;
    return lines;
  }

  // ── 대화 저장 ────────────────────────────────────────────────────────
  private async openSession() {
    const key = this.host.projectKey();
    const gen = ++this.generation;
    this.key = key;
    this.turns = [];
    this.history = [];
    this.conversation = uid();
    this.memo = null;
    this.memoSent = "";
    void this.usageLog.open(key);
    this.emit("update", null);
    this.emit("memo", null);
    const [data, memo] = await Promise.all([
      kvGet<Session>(SESSION + key).catch(() => undefined),
      kvGet<Memo>(MEMO + key).catch(() => undefined),
    ]);
    if (gen !== this.generation) return;
    if (memo && typeof memo.text === "string" && memo.text.trim()) { this.memo = memo; this.emit("memo", null); }
    if (!data || data.version !== 1) return;
    this.turns = Array.isArray(data.turns) ? data.turns : [];
    this.history = Array.isArray(data.history) ? data.history : [];
    this.conversation = typeof data.conversation === "string" ? data.conversation : uid();
    this.memoSent = typeof data.memoSent === "string" ? data.memoSent : "";
    for (const t of this.turns) {
      turnSeq = Math.max(turnSeq, t.id);
      // 도구가 도는 중에 닫았으면 그 줄은 영영 돌고 있다
      if (t.tool?.state === "running") { t.tool.state = "error"; t.tool.summary = "did not finish"; }
    }
    this.repair();
    this.emit("update", null);
  }

  /** 이 프로젝트의 대화를 저장한다 (잠깐 모았다가) */
  private save(now = false) {
    const key = this.key;
    const data: Session = {
      version: 1,
      // 줄이 아주 많으면 앞을 버리고, 긴 도구 결과는 자른다 — 다시 열었을 때 보기용이다. 그림은 싣지 않는다
      turns: this.turns.slice(-400).map(stored),
      history: this.history.map(withoutImages),
      conversation: this.conversation,
      savedAt: new Date().toISOString(),
      memoSent: this.memoSent,
    };
    const write = () => {
      if (!data.turns.length && !data.history.length) void kvDelete(SESSION + key);
      else void kvSet(SESSION + key, data);
    };
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (now) write();
    else this.saveTimer = setTimeout(write, 600);
  }

  /** 새 대화 (회로는 그대로다) */
  reset(): void {
    if (this.busy) this.stop();
    this.generation++;
    this.turns = [];
    this.history = [];
    this.conversation = uid();
    // 새 대화는 메모를 다시 안고 시작한다
    this.memoSent = "";
    // 새 대화는 지금 회로를 처음부터 본다 — 앞 대화에 알릴 것이었던 편집은 버린다
    this.edits.clear();
    this.mixed = false;
    if (this.dirty) { this.known = snapshot(summaryInput(this.host)); this.dirty = false; }
    this.emit("update", null);
    this.save();
  }

  /** 도는 요청이나 손으로 돌린 요약을 멈춘다 */
  stop(): void {
    this.abort?.abort();
    this.manual?.abort();
  }

  private push(t: Omit<Turn, "id">): Turn {
    const turn = { ...t, id: ++turnSeq };
    this.turns.push(turn);
    this.emit("update", turn);
    return turn;
  }

  private setActivity(a: string) {
    if (a === this.activity) return;
    this.activity = a;
    this.emit("activity", a);
  }


  // ── 상황 설명 ────────────────────────────────────────────────────────
  /** 요청마다 사용자 메시지 앞에 붙는 지금의 상황. 바뀌는 것은 여기에 — 시스템 프롬프트는 캐시된다 */
  context(): string {
    const h = this.host;
    const p = h.project(), sheet = h.sheet(), lib = h.library(), ex = h.extraction();
    const grounds = sheet.parts.filter(x => (lib[x.lib]?.id ?? x.lib) === "gnd").length;
    const lines: string[] = [];
    lines.push(`Project "${p.name}": ${sheet.parts.length - grounds} parts${grounds ? ` and ${grounds} ground symbol${grounds === 1 ? "" : "s"}` : ""}, ` +
      `${ex.netCount} nets, ${sheet.wires.length} wires, ${sheet.labels.length} net labels, ${sheet.spice.length} directive blocks.`);
    if (h.external()) lines.push("An external netlist is open as text: the schematic is not what runs, and editing tools are refused.");
    lines.push(`Analysis: ${simText(p.sim)}. ${(p.meas ?? []).length} .meas lines, ${(p.calc ?? []).length} calculator rows. ` +
      `Probes: ${sheet.probes.map(x => ex.netAt(x.at)).filter(Boolean).join(", ") || "none"}.`);
    const sel = h.selection().map(k => {
      const [kind, id] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
      if (kind === "part") return sheet.parts.find(x => x.id === id)?.ref;
      if (kind === "label") { const l = sheet.labels.find(x => x.id === id); return l ? `label ${l.name}` : undefined; }
      return kind;
    }).filter(Boolean);
    lines.push(`Selected: ${sel.length ? sel.slice(0, 20).join(", ") + (sel.length > 20 ? ` (+${sel.length - 20})` : "") : "nothing"}.`);
    const r = h.results();
    const err = h.lastError();
    lines.push(err ? `Last simulation failed: ${err.split("\n").slice(0, 3).join(" ")}`
      : !r ? "No simulation has run yet."
      : r.current ? `Last simulation (${r.kind ?? "?"}) is current — no edits since.`
      : `Last simulation (${r.kind ?? "?"}) is from before the latest edits.`);
    const iss = h.issues();
    const errs = iss.filter(i => i.level === "error");
    lines.push(iss.length
      ? `Pre-run issues: ${errs.length} error${errs.length === 1 ? "" : "s"}, ${iss.length - errs.length} warning${iss.length - errs.length === 1 ? "" : "s"}` +
        (errs.length ? ` — ${errs.slice(0, 3).map(i => i.message).join("; ")}` : "") + "."
      : "Pre-run issues: none.");
    const layout = h.layoutBrief?.();
    if (layout) lines.push(layout);
    const floating = floatingPins(sheet, lib, ex);
    if (floating.length) lines.push(`Unconnected pins: ${floating.slice(0, 12).join(", ")}${floating.length > 12 ? " …" : ""}.`);
    return lines.join("\n");
  }

  // ── 요청 ─────────────────────────────────────────────────────────────
  /**
   * 요청 하나를 돌린다. 돌지 못했으면(돌고 있다, 키가 없다) false.
   * shown 은 대화 창에 보일 글 — 모델에게는 text 를 보낸다 (문제 탭의 "고쳐 줘" 같은 것).
   */
  async send(text: string, shown?: string, images: readonly string[] = []): Promise<boolean> {
    const prompt = text.trim();
    if ((!prompt && !images.length) || this.busy) return false;
    await this.loading;
    const s = this.store;
    if (!s.key) {
      this.push({ role: "note", text: "Connect OpenRouter or paste an API key in the assistant settings first.", error: true });
      return false;
    }
    if (images.length > MAX_ATTACH) {
      this.push({ role: "note", text: `Attach at most ${MAX_ATTACH} pictures to one message.`, error: true });
      return false;
    }
    if (images.length && !(await this.canSee())) {
      this.push({
        role: "note", error: true,
        text: `${s.value.model || "The selected model"} cannot read pictures. Pick a model that "sees images" in the assistant settings, or send the message without the picture.`,
      });
      return false;
    }
    const gen = this.generation;
    const live = () => gen === this.generation;
    const cut = () => { if (!live()) throw new DOMException("Aborted", "AbortError"); };

    this.busy = true;
    this.emit("busy", true);
    this.setActivity("");
    const label = shown?.trim() || prompt || (images.length === 1 ? "(picture)" : `(${images.length} pictures)`);
    this.push({ role: "user", text: shown?.trim() || prompt, ...(images.length ? { pics: [...images], picCount: images.length } : {}) });
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const group = { id: uid(), label: `AI: ${label.replace(/\s+/g, " ").slice(0, 40)}${label.length > 40 ? "…" : ""}` };
    const task = this.usageLog.begin("request", label);
    let last: Turn | null = null;
    let stopped = false;
    let failed = false;
    let simulated = false;
    let asked: Message | null = null;
    this.edited = false;
    try {
      const model = await this.model();
      const vision = await this.canSee(model);
      cut();
      if (this.size() > COMPACT_CHARS) await this.compact(signal, true);
      cut();
      // 요청과 요청 사이에 사람이 고친 것은 상황 설명에 같이 싣는다
      const changes = this.userChanges();
      const ctx = this.context() + this.memoNote() + (changes.length ? `\nChanges by the user since your last turn:\n- ${changes.join("\n- ")}` : "");
      const body = `<editor-context>\n${ctx}\n</editor-context>\n\n${prompt || "(The user sent only the picture.)"}`;
      // 그림은 글 앞에 둔다 — 캐시 표시는 마지막 글 조각에 달리므로(cache.ts) 그림까지 캐시된다
      asked = images.length ? { role: "user", content: [...imageParts(images), { type: "text", text: body }] } : { role: "user", content: body };
      this.history.push(asked);
      task.images(images.length);

      const max = s.value.maxSteps;
      let step = 0;
      for (; step < max; step++) {
        // 모델이 생각하는 동안 · 도구가 도는 동안 사람이 고친 것을 다음 단계 앞에 알린다
        const lines = step > 0 ? this.userChanges() : [];
        if (lines.length) {
          this.history.push({
            role: "user",
            content: `${EDITOR_NOTE} While you were working, the user edited the circuit by hand:\n- ${lines.join("\n- ")}\n` +
              "These edits are intended. Build on them; do not undo them unless the user asks.",
          });
          this.push({ role: "note", text: "Your edits were passed on to the assistant." , detail: lines.join("\n") });
        }
        const turn = this.push({ role: "assistant", text: "" });
        last = turn;
        this.setActivity("");
        const reply = await chat(s.key, {
          model,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...this.history],
          tools: toolSpecs(s.value, vision),
          temperature: s.value.temperature,
          session: `melange-${this.key}-${this.conversation}`,
          longCache: s.value.cacheLong,
        }, {
          signal,
          onText: d => { turn.text += d; this.emit("update", turn); },
        });
        task.chat(reply.model || model, reply.usage);
        cut();
        this.history.push(reply.message);
        if (!turn.text.trim()) {
          // 도구 호출만 왔다 — 빈 말풍선은 치운다
          this.turns.splice(this.turns.indexOf(turn), 1);
          this.emit("update", turn);
          last = null;
        }
        const calls = reply.message.tool_calls ?? [];
        if (!calls.length) {
          // 공급자는 내용이 빈 assistant 메시지를 다음 요청에서 거부한다
          if (!reply.message.content) reply.message.content = "(empty answer)";
          if (reply.finish === "length") this.push({ role: "note", text: "The answer was cut off at the length limit." });
          else if (!turn.text.trim()) this.push({ role: "note", text: "The model sent an empty answer. Try again, or pick another model." });
          break;
        }
        /** 이 단계의 도구가 그린 그림 — 도구 결과들 뒤에 사용자 메시지 하나로 싣는다 (tool 메시지에 그림을 받는 공급자가 드물다) */
        const pics: Array<{ tool: string; pic: Picture }> = [];
        for (const call of calls) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          const row = this.push({ role: "tool", text: "", tool: { name: call.function.name, args: call.function.arguments || "{}", state: "running" } });
          this.setActivity(call.function.name);
          let args: Record<string, unknown> | null = null;
          try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = null; }
          let content: string;
          if (!args || typeof args !== "object" || Array.isArray(args)) {
            content = JSON.stringify({ error: "The arguments were not a JSON object. Send them again as a JSON object." });
            row.tool!.state = "error";
            row.tool!.summary = "invalid arguments";
          } else {
            task.tool();
            if (call.function.name === "run_simulation") simulated = true;
            const result = await runTool(call.function.name, { args, host: this.host, group, settings: s.value, signal, vision });
            cut();
            content = JSON.stringify(result.data ?? null);
            if (result.images?.length) {
              for (const pic of result.images) pics.push({ tool: call.function.name, pic });
              row.tool!.pics = result.images.map(p => p.url);
            }
            const failed = !!(result.data && typeof result.data === "object" && "error" in (result.data as object));
            row.tool!.state = failed ? "error" : "done";
            row.tool!.summary = failed ? String((result.data as { error: unknown }).error) : result.summary;
          }
          if (content.length > MAX_RESULT) content = content.slice(0, MAX_RESULT) + " … (cut)";
          row.tool!.result = content;
          this.history.push({ role: "tool", tool_call_id: call.id, content });
          this.emit("update", row);
        }
        if (pics.length) {
          const from = [...new Set(pics.map(x => x.tool))].join(", ");
          this.history.push({
            role: "user",
            content: [
              ...imageParts(pics.map(x => x.pic.url)),
              { type: "text", text: `${PICTURES} ${pics.length === 1 ? "The picture" : `The ${pics.length} pictures`} from ${from}, in the order of the calls above.` },
            ],
          });
          task.images(pics.length);
        }
        this.trim();
      }
      if (step >= max) this.push({ role: "note", text: `Paused after ${max} model calls (assistant settings). Say "continue" to go on.` });
    } catch (e) {
      if (isAbort(e)) {
        stopped = true;
        if (live()) this.push({ role: "note", text: "Stopped." });
      } else {
        failed = true;
        const msg = e instanceof ApiError ? e.message : `${(e as Error)?.message || e}`;
        if (live()) this.push({ role: "note", text: msg, error: true });
        console.warn("[assistant] request failed", e);
      }
    } finally {
      task.end();
      this.abort = null;
      this.busy = false;
      this.activity = "";
      if (live()) {
        this.retirePictures();
        this.settle(stopped);
        // 맨 위 실행 취소 단계가 이 요청의 것이면 대화 창에서 되돌릴 수 있게
        if (this.host.undoGroup() === group.id) {
          const end = [...this.turns].reverse().find(t => t.role === "assistant" || t.role === "note") ?? last;
          if (end) { end.undo = { group: group.id, label: group.label }; this.emit("update", end); }
        }
        // 요청이 끝나면 바로 저장한다 (모아 둘 것이 없다 — 곧 탭을 닫아도 남게)
        this.save(true);
        // 회로를 바꿨거나 돌려 본 요청이면 메모를 고친다 (뒤에서, 다음 요청을 막지 않는다)
        if (!stopped && !failed && (this.edited || simulated) && s.value.memo && asked) this.queueMemo(asked, label);
      }
      this.emit("activity", "");
      this.emit("busy", false);
    }
    return true;
  }

  /** 쓸 모델. 설정이 비었으면 목록을 받아 고른다 */
  private async model(): Promise<string> {
    const s = this.store;
    if (s.value.model) return s.value.model;
    const list = await listModels();
    const pick = defaultModel(list);
    if (!pick) throw new ApiError("No model with tool calling was found. Pick one in the assistant settings.");
    s.set({ model: pick });
    return pick;
  }

  // ── 프로젝트 메모 ────────────────────────────────────────────────────
  /** 이 요청의 상황 설명에 실을 메모 — 이 대화에 아직 안 실었거나 그 뒤로 바뀌었을 때만 */
  private memoNote(): string {
    if (!this.store.value.memo) return "";
    const text = this.memo?.text.trim() ?? "";
    if (text === this.memoSent) return "";
    const first = !this.memoSent;
    this.memoSent = text;
    if (!text) return "\nThe user cleared the project memo.";
    const who = this.memo?.by === "user" ? ", last edited by the user" : "";
    return `\nProject memo (${first ? "your notes from earlier conversations" : "updated"}${who}):\n${text}`;
  }

  /** 사람이 메모를 고친다. 빈 글이면 지운다 */
  setMemo(text: string): void {
    const t = text.trim().slice(0, MEMO_MAX);
    void this.writeMemo(this.key, t ? { text: t, at: Date.now(), by: "user" } : null);
  }

  /** 메모 고치기가 다 끝날 때 (검증 · 패널) */
  memoSettled(): Promise<void> { return this.memoJob; }

  private async writeMemo(key: string, m: Memo | null) {
    if (key === this.key) { this.memo = m; this.emit("memo", null); }
    if (m) await kvSet(MEMO + key, m).catch(() => undefined);
    else await kvDelete(MEMO + key).catch(() => undefined);
  }

  /**
   * 요청 하나가 끝났다 — 메모를 고치러 간다. 무엇을 보낼지(회로 모습 · 이 요청의 대화)는 지금 뜬다: 고치기는
   * 앞의 것이 끝난 뒤에 돌고, 그 사이에 회로가 바뀌거나 다른 프로젝트가 열릴 수 있다.
   */
  private queueMemo(asked: Message, label: string) {
    const at = this.history.indexOf(asked);
    if (at < 0) return;
    const job = { key: this.key, gen: this.generation, circuit: this.context(), request: transcript(this.history.slice(at)).slice(-12_000), label };
    this.memoJob = this.memoJob.then(() => this.refreshMemo(job));
  }

  private async refreshMemo(job: { key: string; gen: number; circuit: string; request: string; label: string }) {
    const key = job.key;
    const before = key === this.key ? this.memo : (await kvGet<Memo>(MEMO + key).catch(() => undefined)) ?? null;
    if (!this.store.key || !this.store.value.memo) return;
    this.memoBusy = true;
    this.emit("memo", null);
    const task = this.usageLog.begin("memo", job.label);
    try {
      const model = await this.model();
      const reply = await chat(this.store.key, {
        model,
        messages: [
          { role: "system", content: MEMO_PROMPT },
          {
            role: "user",
            content: `<current-memo>\n${before?.text.trim() || "(empty)"}\n</current-memo>\n\n<circuit>\n${job.circuit}\n</circuit>\n\n` +
              `<latest-request>\n${job.request}\n</latest-request>`,
          },
        ],
        temperature: 0.2,
        maxTokens: 700,
        oneOff: true,
      });
      task.chat(reply.model || model, reply.usage);
      const text = (typeof reply.message.content === "string" ? reply.message.content : "")
        .trim().replace(/^```[a-z]*\s*|\s*```$/g, "").trim().slice(0, MEMO_MAX);
      // 그 사이에 사람이 메모를 고쳤으면 사람의 것이 남는다 (같은 프로젝트면 객체가 바뀌었는지로 — 같은 밀리초에 고쳐도 가린다)
      if (key === this.key ? this.memo !== before : !sameMemo((await kvGet<Memo>(MEMO + key).catch(() => undefined)) ?? null, before)) return;
      if (!text || text === before?.text) return;
      // 이 메모는 이 대화에서 나왔다 — 이 대화에 다시 실을 까닭이 없다 (새 대화부터 싣는다)
      if (key === this.key && job.gen === this.generation) { this.memoSent = text; this.save(); }
      await this.writeMemo(key, { text, at: Date.now(), by: "assistant" });
    } catch (e) {
      // 메모는 덤이다 — 못 고쳐도 대화는 그대로 간다
      if (!isAbort(e)) console.warn("[assistant] memo update failed", e);
    } finally {
      task.end();
      this.memoBusy = false;
      this.emit("memo", null);
    }
  }

  /** 그 모델(기본: 설정의 모델)이 그림을 읽는가. 목록을 못 받으면 못 읽는 것으로 친다 */
  async canSee(model = this.store.value.model): Promise<boolean> {
    if (!model) return false;
    try { return seesImages((await listModels()).find(m => m.id === model)); } catch { return false; }
  }

  /**
   * 도구가 그린 그림을 대화에서 뺀다 — 요청이 끝나면 지난 모습이고, 둘수록 다음 요청마다 값이 든다.
   * 다시 보려면 도구를 다시 부른다. 사람이 붙인 그림은 이 탭에서는 남긴다 (다음 요청에서도 그 사진을 본다).
   */
  private retirePictures() {
    for (const m of this.history) {
      if (m.role !== "user" || !hasImage(m) || !textOf(m).startsWith(PICTURES)) continue;
      const n = (m.content as Part[]).filter(p => p.type === "image_url").length;
      m.content = `${PICTURES} (${n === 1 ? "a picture" : `${n} pictures`} from an earlier request — no longer attached; call the tool again to look)`;
    }
  }

  /** 대화 창의 '이 요청 되돌리기'. 그 단계가 맨 위에 있을 때만 */
  undoTurn(t: Turn): boolean {
    if (!t.undo || this.host.undoGroup() !== t.undo.group) return false;
    this.host.undo();
    delete t.undo;
    this.emit("update", t);
    this.save();
    return true;
  }

  /**
   * 요청이 끝난 뒤 정리: 첫 글자 전에 멈춘 단계의 빈 말풍선, 도는 채로 남은 도구 줄, 결과가 없는 도구
   * 호출(다음 요청이 거부된다)을 치운다.
   */
  private settle(stopped: boolean) {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t.role === "assistant" && !t.text.trim()) { this.turns.splice(i, 1); this.emit("update", t); }
      else if (t.tool?.state === "running") {
        t.tool.state = "error";
        t.tool.summary = stopped ? "stopped" : "did not finish";
        this.emit("update", t);
      }
    }
    this.repair();
  }

  /** 도구 호출마다 결과가 있게 한다 — 없으면 다음 요청을 공급자가 거부한다 */
  private repair() {
    const answered = new Set(this.history.filter(m => m.role === "tool").map(m => m.tool_call_id));
    for (let i = 0; i < this.history.length; i++) {
      const m = this.history[i];
      if (m.role !== "assistant" || !m.tool_calls) continue;
      let at = i + 1;
      while (at < this.history.length && this.history[at].role === "tool") at++;
      for (const c of m.tool_calls) {
        if (answered.has(c.id)) continue;
        this.history.splice(at++, 0, { role: "tool", tool_call_id: c.id, content: JSON.stringify({ error: "Cancelled." }) });
        answered.add(c.id);
      }
    }
  }

  // ── 긴 대화 ──────────────────────────────────────────────────────────
  /** 대화의 길이 (글자) */
  size(): number {
    let n = 0;
    for (const m of this.history) {
      n += typeof m.content === "string" ? m.content.length : (m.content ?? []).reduce((a, p) => a + (p.type === "text" ? p.text.length : 1000), 0);
      if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
    }
    return n;
  }

  /** 사람이 한 요청의 첫 메시지 자리들 ([editor] 쪽지 · 도구의 그림은 요청이 아니다) */
  private starts(): number[] {
    const out: number[] = [];
    this.history.forEach((m, i) => {
      if (m.role === "user" && !isNote(m)) out.push(i);
    });
    return out;
  }

  /** 길어지면 오래된 요청부터 버린다 — 사용자 메시지 앞에서만 자른다 (도구 호출과 결과가 갈리지 않게) */
  private trim() {
    while (this.size() > MAX_CHARS) {
      const s = this.starts().filter(i => i > 0);
      if (!s.length) break;
      this.history.splice(0, s[0]);
      this.memoSent = "";
    }
  }

  /**
   * 앞부분을 모델이 쓴 요약으로 바꾼다. 최근 요청 몇 개는 그대로 둔다.
   * 손으로 부르면(auto 가 아니면) 멈춤 버튼이 멈출 수 있게 따로 신호를 둔다.
   */
  async compact(signal?: AbortSignal, auto = false): Promise<boolean> {
    const starts = this.starts();
    if (!this.store.key || starts.length <= KEEP_REQUESTS) {
      if (!auto) this.push({ role: "note", text: "There is not enough conversation to compact yet." });
      return false;
    }
    const at = starts[starts.length - KEEP_REQUESTS];
    const older = this.history.slice(0, at);
    const note = this.push({ role: "note", text: auto ? "The conversation is long — summarizing the earlier part…" : "Summarizing the earlier part…" });
    const own = signal ? null : new AbortController();
    if (own) { this.manual = own; this.working = true; this.emit("busy", this.busy); }
    const gen = this.generation;
    const task = this.usageLog.begin("summary", auto ? "Summary of a long conversation" : "Summary of the conversation");
    try {
      const model = await this.model();
      const reply = await chat(this.store.key, {
        model,
        messages: [{ role: "system", content: COMPACT_PROMPT }, { role: "user", content: transcript(older) }],
        temperature: 0.2,
        maxTokens: 1500,
        session: `melange-${this.key}-${this.conversation}`,
        oneOff: true,
      }, { signal: signal ?? own!.signal });
      task.chat(reply.model || model, reply.usage);
      if (gen !== this.generation) return false;
      const summary = typeof reply.message.content === "string" ? reply.message.content.trim() : "";
      if (!summary) throw new Error("the model returned an empty summary");
      const rest = this.history.slice(at);
      const first = rest[0];
      const wrap = `<conversation-summary>\n${summary}\n</conversation-summary>\n\n`;
      if (typeof first.content === "string") first.content = wrap + first.content;
      else if (Array.isArray(first.content)) {
        // 그림을 붙인 요청: 글 조각 앞에 붙인다
        const i = first.content.findIndex(p => p.type === "text");
        const p = first.content[i];
        if (p && p.type === "text") first.content[i] = { ...p, text: wrap + p.text };
        else first.content.push({ type: "text", text: wrap });
      }
      this.history = rest;
      this.memoSent = "";
      note.text = `Summarized ${older.length} earlier messages.`;
      note.detail = summary;
      this.emit("update", note);
      this.save();
      return true;
    } catch (e) {
      if (isAbort(e)) {
        if (!own) throw e;
        note.text = "Summarizing stopped.";
        this.emit("update", note);
        return false;
      }
      if (gen !== this.generation) return false;
      note.text = `Summarizing failed (${(e as Error)?.message || e}); the oldest messages were dropped instead.`;
      note.error = true;
      this.emit("update", note);
      while (this.size() > COMPACT_CHARS) {
        const s = this.starts().filter(i => i > 0);
        if (!s.length) break;
        this.history.splice(0, s[0]);
        this.memoSent = "";
      }
      return false;
    } finally {
      task.end();
      if (own) { this.manual = null; this.working = false; this.emit("busy", this.busy); }
    }
  }
}

const sameMemo = (a: Memo | null, b: Memo | null) => (a?.at ?? 0) === (b?.at ?? 0) && (a?.text ?? "") === (b?.text ?? "");

/** 저장할 대화 줄 — 그림을 빼고, 긴 도구 결과를 자른다 */
function stored(t: Turn): Turn {
  const out: Turn = { ...t };
  delete out.pics;
  if (t.tool) {
    const tool = { ...t.tool };
    delete tool.pics;
    if (tool.result && tool.result.length > 4000) tool.result = tool.result.slice(0, 4000) + " …";
    out.tool = tool;
  }
  return out;
}

/**
 * 저장할 메시지 — 그림을 글 한 줄로 바꾼다. 그림은 크고(한 장에 수백 kB) 이 브라우저의 저장소에 쌓일
 * 까닭이 없다. 다시 열면 모델은 그 자리에 그림이 있었다는 것만 안다.
 */
function withoutImages(m: Message): Message {
  if (!hasImage(m)) return m;
  return {
    ...m,
    content: (m.content as Part[]).map(p => (p.type === "image_url"
      ? { type: "text", text: "[a picture was attached here; it is not kept after the page closes — ask for it again if you need it]" } : p)),
  };
}

/** 요약할 대화를 글로 */
function transcript(ms: readonly Message[]): string {
  const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …" : s);
  const out: string[] = [];
  for (const m of ms) {
    const text = typeof m.content === "string" ? m.content : (m.content ?? []).map(p => (p.type === "text" ? p.text : "[image]")).join("\n");
    if (m.role === "user") out.push(`USER: ${cap(text.replace(/<editor-context>[\s\S]*?<\/editor-context>\s*/, ""), 3000)}`);
    else if (m.role === "assistant") {
      if (text) out.push(`ASSISTANT: ${cap(text, 3000)}`);
      for (const c of m.tool_calls ?? []) out.push(`TOOL ${c.function.name}: ${cap(c.function.arguments, 600)}`);
    } else if (m.role === "tool") out.push(`RESULT: ${cap(text, 800)}`);
  }
  const all = out.join("\n");
  // 그래도 길면 끝을 남긴다 — 최근 것이 더 중요하다
  return all.length > 80_000 ? "…\n" + all.slice(-80_000) : all;
}
