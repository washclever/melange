/**
 * 어시스턴트 패널 — 대화 창. 속성 패널 오른쪽 칸에 산다 (좁은 화면에서는 오른쪽 서랍).
 *
 * 그리는 것: 연결 화면(키가 없을 때), 대화(사용자 · 어시스턴트 · 도구 줄 · 알림), 입력 칸, 설정.
 * 상태는 Agent 가 들고 있고 여기는 그것을 그리고 이벤트를 듣는다. 모델의 글은 작은 마크다운만
 * 받는다 — **먼저 이스케이프하고** 몇 가지 꾸밈만 되살린다. 모델의 글을 HTML 로 그대로 넣지 않는다.
 *
 * 캔버스 위에는 어시스턴트가 일하는 동안 작은 상태 칸을 띄운다 (무엇을 하는 중인지, 멈춤 버튼).
 * 요청 중에도 회로를 손으로 고칠 수 있다 — 고친 것은 어시스턴트에게 알려진다 (agent.ts).
 */
import { icon } from "../ui/icons.ts";
import { Agent, MAX_ATTACH, MEMO_MAX, type Turn } from "./agent.ts";
import {
  defaultModel, finishSignIn, listModels, seesImages, signInReturned, startSignIn, takesTools, type Model,
} from "./openrouter.ts";
import { cacheNote } from "./cache.ts";
import { settings, type AISettings } from "./settings.ts";
import { KIND_LABEL } from "./usage.ts";
import type { AssistantHost } from "./host.ts";

export interface PanelHooks {
  /** 좁은 화면의 서랍을 닫는다 */
  close(): void;
  /** 상태 칸을 띄울 캔버스 칸 */
  stage: HTMLElement;
}

/** 도구가 하는 일 (상태 칸 · 도구 줄의 말) */
const DOING: Record<string, string> = {
  get_circuit: "Reading the circuit", get_part_types: "Looking up parts", get_netlist: "Reading the netlist",
  place_parts: "Placing parts", connect: "Wiring", set_params: "Setting values", move_parts: "Moving parts",
  delete: "Deleting", set_analysis: "Setting the analysis", set_measures: "Adding measurements",
  set_calculator: "Writing calculator rows", calc_reference: "Looking up functions", edit_directives: "Editing directives",
  set_probes: "Placing probes", show_parts: "Pointing at parts", run_simulation: "Simulating",
  get_results: "Reading results", read_trace: "Reading a waveform", import_netlist: "Merging a netlist",
  rename_net: "Renaming a net", view_schematic: "Looking at the schematic", view_waveform: "Looking at the plot",
};
const doing = (name: string) => DOING[name] ?? name.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());

const SUGGESTIONS = [
  "Build an RC low-pass filter with a 1 kHz cutoff and show its Bode plot",
  "Explain what this circuit does",
  "Why does the simulation fail?",
  "Design a non-inverting amplifier with a gain of 11 and check it",
];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

function iconButton(name: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "ai-icon");
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = icon(name, 15);
  b.onclick = onClick;
  return b;
}

function textButton(label: string, onClick: () => void, cls = "btn"): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.onclick = onClick;
  return b;
}

// ── 붙인 그림 ─────────────────────────────────────────────────────────
/** 붙인 그림의 긴 변 (px). 모델들이 이보다 크면 줄여서 읽는다 — 미리 줄이면 보내는 양이 준다 */
const ATTACH_SIDE = 1568;

/**
 * 붙인 그림을 보낼 모양으로: 긴 변을 줄이고 JPEG 로. 사진의 방향(EXIF)은 그대로 따르고, 사진 속의 위치
 * 같은 메타데이터는 다시 그리면서 떨어진다. 투명한 곳은 흰 바탕이 된다 (JPEG 에는 투명이 없다).
 */
async function shrink(file: Blob): Promise<string> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const k = Math.min(1, ATTACH_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const g = cv.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
    g.imageSmoothingQuality = "high";
    g.drawImage(bmp, 0, 0, w, h);
    return cv.toDataURL("image/jpeg", 0.86);
  } finally { bmp.close(); }
}

const imageFiles = (list: FileList | readonly File[] | null | undefined): File[] =>
  [...(list ?? [])].filter(f => f.type.startsWith("image/"));
const dragsFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");

/** 그림을 크게 본다 — 누르거나 Esc 로 닫는다 */
function viewPicture(url: string) {
  const box = el("div", "ai-lightbox");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Picture");
  const img = el("img");
  img.src = url;
  img.alt = "";
  box.appendChild(img);
  const close = () => { box.remove(); document.removeEventListener("keydown", key, true); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  box.onclick = close;
  document.addEventListener("keydown", key, true);
  document.body.appendChild(box);
}

function picture(url: string, cls: string, alt: string): HTMLImageElement {
  const img = el("img", cls);
  img.src = url;
  img.alt = alt;
  img.title = "Click to enlarge";
  img.onclick = e => { e.preventDefault(); e.stopPropagation(); viewPicture(url); };
  return img;
}

// ── 작은 마크다운 ─────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 한 줄 안의 꾸밈. 코드 조각 안은 건드리지 않는다 */
function inline(s: string): string {
  return s.split(/(`[^`]+`)/g).map(part => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }).join("");
}

/** 모델의 글을 HTML 로. 받는 것: 문단, 목록, 제목(굵게), 코드 블록, 파이프 표 */
export function markdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let table: string[][] | null = null;
  const flush = () => {
    if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; }
    if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; }
    if (table) {
      const [head, ...rows] = table;
      out.push(`<table><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr>` +
        rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") + "</table>");
      table = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const t = line.trim();
    if (!t) { flush(); continue; }
    if (/^\|.*\|$/.test(t)) {
      const cells = t.slice(1, -1).split("|").map(c => c.trim());
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;   // 머리와 몸의 경계 줄
      if (!table) { if (para.length || list) flush(); table = []; }
      table.push(cells);
      continue;
    }
    if (table) flush();
    const h = /^#{1,6}\s+(.*)$/.exec(t);
    if (h) { flush(); out.push(`<p><strong>${inline(h[1])}</strong></p>`); continue; }
    const ul = /^[-*•]\s+(.*)$/.exec(t), ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      if (para.length) flush();
      if (list && list.tag !== tag) flush();
      list ??= { tag, items: [] };
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    if (list) flush();
    para.push(t);
  }
  flush();
  return out.join("");
}

/** JSON 을 보기 좋게 (실패하면 그대로) */
function pretty(s: string | undefined, max = 4000): string {
  if (!s) return "";
  let t = s;
  try { t = JSON.stringify(JSON.parse(s), null, 2); } catch { /* 그대로 */ }
  return t.length > max ? t.slice(0, max) + "\n…" : t;
}

const tokens = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
const money = (c: number) => "$" + (c < 0.1 ? c.toFixed(4) : c.toFixed(2));
const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};
/** 언제 — 오늘이면 시각만 */
const when = (at: number) => {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
};
/** 내려받을 파일 이름의 앞부분 (프로젝트 이름에서 파일 이름에 못 쓰는 글자를 뺀다) */
const fileStem = (name: string) => (name || "circuit").replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "circuit";
const price = (v: string | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? "$" + (n * 1e6).toFixed(2) : "?";
};

// ── 패널 ──────────────────────────────────────────────────────────────
export class AssistantPanel {
  readonly agent: Agent;
  private readonly host: AssistantHost;
  private readonly hooks: PanelHooks;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly send: HTMLButtonElement;
  private readonly modelBtn: HTMLButtonElement;
  private readonly usageEl: HTMLElement;
  private readonly compactBtn: HTMLButtonElement;
  private readonly memoBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly attachBox: HTMLElement;
  private readonly hintEl: HTMLElement;
  /** 보내기를 기다리는 그림 (data: URL) */
  private pending: string[] = [];
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private models: Model[] = [];
  private modelsLoaded = false;
  /** 대화 · 설정 · 사용 기록 · 프로젝트 메모. 대화가 아니면 입력 칸을 숨긴다 */
  private view: "chat" | "settings" | "usage" | "memo" = "chat";
  private openDetails = new Set<string>();
  private frame = 0;

  constructor(root: HTMLElement, host: AssistantHost, hooks: PanelHooks) {
    this.root = root;
    this.host = host;
    this.hooks = hooks;
    this.agent = new Agent(host);
    root.innerHTML = "";
    root.classList.add("ai-ready");

    const head = el("div", "ai-head");
    const title = el("span", "ai-title", "Assistant");
    this.modelBtn = el("button", "ai-model");
    this.modelBtn.type = "button";
    this.modelBtn.onclick = () => this.openSettings();
    this.usageEl = el("button", "ai-usage");
    (this.usageEl as HTMLButtonElement).type = "button";
    this.usageEl.onclick = () => this.openUsage();
    this.compactBtn = iconButton("compact", "Summarize the earlier part of the conversation", () => { void this.agent.compact(); });
    this.memoBtn = iconButton("memo", "Project memo — what the assistant remembers about this project", () => (this.view === "memo" ? this.closeAside() : this.openMemo()));
    head.append(
      title, this.modelBtn, el("span", "sp"),
      iconButton("plus", "New conversation (the circuit stays)", () => { this.agent.reset(); if (this.view !== "chat") this.closeAside(); else this.render(); }),
      this.compactBtn,
      this.memoBtn,
      iconButton("gear", "Assistant settings", () => this.openSettings()),
      Object.assign(iconButton("close", "Close", () => hooks.close()), { className: "ai-icon ai-close" }),
    );

    this.body = el("div", "ai-body");
    this.body.setAttribute("aria-live", "polite");

    const compose = el("div", "ai-compose");
    this.input = el("textarea", "ai-input");
    this.input.rows = 2;
    this.input.placeholder = "Ask for a circuit, a change or an explanation…";
    this.input.setAttribute("aria-label", "Message to the assistant");
    this.input.addEventListener("keydown", e => {
      e.stopPropagation();          // 편집기 단축키가 돌지 않게 (전역 처리도 입력 칸은 건너뛴다)
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.submit(); }
      else if (e.key === "Escape" && this.agent.running) { e.preventDefault(); this.agent.stop(); }
    });
    this.input.addEventListener("input", () => this.grow());
    this.send = el("button", "ai-send");
    this.send.type = "button";
    this.send.onclick = () => (this.agent.running ? this.agent.stop() : this.submit());
    // 그림 붙이기: 클립 단추 · 붙여넣기 · 끌어다 놓기. 손으로 그린 회로의 사진도 된다
    const file = el("input");
    file.type = "file";
    file.accept = "image/*";
    file.multiple = true;
    file.hidden = true;
    file.onchange = () => { void this.attach(imageFiles(file.files)); file.value = ""; };
    const clip = iconButton("attach", "Attach a picture — a photo of a hand-drawn circuit, a screenshot, a datasheet figure", () => file.click());
    clip.classList.add("ai-clip");
    compose.append(clip, file, this.input, this.send);
    this.input.addEventListener("paste", e => {
      const files = imageFiles(e.clipboardData?.files);
      if (!files.length) return;
      // 글도 같이 왔으면(문서에서 복사) 글은 그대로 붙게 둔다
      if (!e.clipboardData?.getData("text/plain")) e.preventDefault();
      void this.attach(files);
    });
    root.addEventListener("dragover", e => {
      if (!dragsFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
      root.classList.add("drop-target");
    });
    root.addEventListener("dragleave", e => {
      if (!root.contains(e.relatedTarget as Node | null)) root.classList.remove("drop-target");
    });
    root.addEventListener("drop", e => {
      if (!dragsFiles(e)) return;
      e.preventDefault();
      root.classList.remove("drop-target");
      if (this.view !== "chat") this.closeAside();
      void this.attach(imageFiles(e.dataTransfer?.files));
    });
    this.attachBox = el("div", "ai-attach");
    // 쓴 토큰 · 크레딧은 입력 칸 아래 작은 줄에 — 머리에 두면 좁은 칸에서 모델 이름이 잘린다
    const meta = el("div", "ai-meta");
    this.hintEl = el("span", "ai-meta-hint", "Enter sends · Shift+Enter new line");
    meta.append(this.usageEl, this.hintEl);
    root.append(head, this.body, this.attachBox, compose, meta);

    // 캔버스 위의 상태 칸
    this.status = el("div", "ai-status");
    this.status.setAttribute("role", "status");
    hooks.stage.appendChild(this.status);

    this.agent.on("update", t => this.update(t));
    this.agent.on("busy", () => this.sync());
    this.agent.on("activity", () => this.sync());
    this.agent.on("usage", () => this.sync());
    this.agent.on("memo", () => { this.sync(); this.renderMemo(); });
    settings.on(() => { this.sync(); if (this.view === "chat") this.render(); });
    // 손으로 고치면 '이 요청 되돌리기' 가 더는 맨 위 단계가 아닐 수 있다 (되돌리면 다시 맨 위다) — 단추를 맞춘다
    host.onChange(() => { if (this.view === "chat" && this.agent.turns.some(t => t.undo)) this.update(null); });
    this.render();
    this.sync();
    void this.completeSignIn();
  }

  /** 패널이 보이게 됐다 — 모델 목록은 이때 처음 받는다 (페이지를 열 때마다 받지 않게) */
  shown(): void {
    void this.loadModels();
    if (this.view === "chat") setTimeout(() => this.input.focus({ preventScroll: true }), 0);
  }

  /** 입력 칸에 물음의 앞부분을 적고 초점을 준다 (오른쪽 버튼 메뉴의 "Ask the assistant about R1") */
  prefill(text: string): void {
    if (this.view !== "chat") this.closeAside();
    const had = this.input.value.trim();
    this.input.value = had ? `${had}\n${text}` : text;
    this.grow();
    setTimeout(() => {
      this.input.focus({ preventScroll: true });
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    }, 0);
  }

  /** 입력 칸 아래에 잠깐 알린다 (그림을 못 붙였다 같은 것) */
  private flash(text: string) {
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintEl.textContent = text;
    this.hintEl.classList.add("warn");
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      this.hintEl.textContent = "Enter sends · Shift+Enter new line";
      this.hintEl.classList.remove("warn");
    }, 6000);
  }

  /** 그림을 붙인다. 지금 모델이 그림을 못 읽으면 붙이지 않고 알린다 */
  private async attach(files: readonly File[]) {
    if (!files.length) return;
    if (!settings.key) { this.openSettings(); return; }
    if (!(await this.agent.canSee())) {
      const m = this.models.find(x => x.id === settings.value.model);
      this.flash(`${m?.name || settings.value.model || "This model"} cannot read pictures — pick one that sees images in the settings.`);
      return;
    }
    for (const f of files) {
      if (this.pending.length >= MAX_ATTACH) { this.flash(`At most ${MAX_ATTACH} pictures per message.`); break; }
      try { this.pending.push(await shrink(f)); } catch { this.flash(`Could not read ${f.name || "that picture"}.`); }
    }
    this.renderAttach();
    this.input.focus({ preventScroll: true });
  }

  private renderAttach() {
    this.attachBox.innerHTML = "";
    this.pending.forEach((url, i) => {
      const t = el("div", "ai-thumb");
      const img = el("img");
      img.src = url;
      img.alt = `Picture ${i + 1}`;
      const x = el("button", "", "×");
      x.type = "button";
      x.title = "Remove";
      x.setAttribute("aria-label", `Remove picture ${i + 1}`);
      x.onclick = () => { this.pending.splice(i, 1); this.renderAttach(); };
      t.append(img, x);
      this.attachBox.appendChild(t);
    });
  }

  /** 밖에서 요청을 넣는다 (문제 탭의 "Ask the assistant" 같은 것) */
  ask(text: string, shown?: string): void {
    if (this.agent.running) { this.input.value = text; this.grow(); return; }
    void this.agent.send(text, shown);
  }

  private async completeSignIn() {
    if (!signInReturned()) return;
    try {
      const key = await finishSignIn();
      // 키를 넣으면 설정을 듣는 쪽이 다시 그린다 (연결 화면 -> 대화)
      if (key) settings.setKey(key);
    } catch (e) {
      this.body.prepend(el("div", "ai-note error", `OpenRouter sign-in failed: ${(e as Error)?.message || e}`));
    }
  }

  private async loadModels(force = false) {
    if (this.modelsLoaded && !force) return;
    try {
      this.models = await listModels(force);
      this.modelsLoaded = true;
      if (!settings.value.model) {
        const pick = defaultModel(this.models);
        if (pick) settings.set({ model: pick });
      }
    } catch { /* 목록을 못 받아도 id 를 손으로 적으면 된다 */ }
    this.sync();
  }

  private grow() {
    this.input.style.height = "auto";
    this.input.style.height = Math.min(160, this.input.scrollHeight) + "px";
  }

  private submit() {
    const text = this.input.value.trim();
    const pics = this.pending;
    if (!text && !pics.length) return;
    if (!settings.key) { this.openSettings(); return; }
    this.input.value = "";
    this.pending = [];
    this.renderAttach();
    this.grow();
    void this.agent.send(text, undefined, pics).then(started => {
      if (started) return;
      // 못 보냈다 (돌고 있었다 · 모델이 그림을 못 읽는다) — 적은 것과 그림을 되돌려 둔다
      if (!this.input.value) { this.input.value = text; this.grow(); }
      if (!this.pending.length && pics.length) { this.pending = pics; this.renderAttach(); }
    });
  }

  /** 머리 · 입력 칸 · 상태 칸을 지금 상태에 맞춘다 */
  private sync() {
    const a = this.agent;
    const m = this.models.find(x => x.id === settings.value.model);
    this.modelBtn.textContent = m?.name || settings.value.model || "Choose a model";
    this.modelBtn.title = settings.value.model
      ? `${settings.value.model}${m && !takesTools(m) ? " (does not support tools — pick another)" : ""} — click for settings`
      : "Pick a model in the settings";
    const u = a.usageLog.totals();
    const total = u.prompt + u.completion;
    this.usageEl.textContent = total ? `${tokens(total)} tok${u.cost ? ` · ${money(u.cost)}` : ""}` : "";
    this.usageEl.title = total
      ? `This project: ${u.calls} model calls · ${tokens(u.prompt)} in (${u.prompt ? Math.round((u.cached / u.prompt) * 100) : 0}% from the cache) · ${tokens(u.completion)} out — click for the usage log`
      : "";
    if (this.view === "usage") this.renderUsage();
    this.compactBtn.disabled = a.running || !a.hasHistory;
    this.memoBtn.hidden = !settings.value.memo && !a.memo;
    this.memoBtn.classList.toggle("busy", a.memoBusy);
    this.memoBtn.classList.toggle("on", this.view === "memo");
    this.memoBtn.title = a.memoBusy ? "Project memo — updating…" : "Project memo — what the assistant remembers about this project";
    this.send.innerHTML = a.running ? `${icon("close", 14)}<span>Stop</span>` : `${icon("send", 14)}<span>Send</span>`;
    this.send.classList.toggle("stop", a.running);
    this.send.title = a.running ? "Stop the assistant (Esc)" : "Send (Enter) · Shift+Enter for a new line";
    // 상태 칸
    this.status.classList.toggle("on", a.running);
    if (a.running) {
      this.status.innerHTML = "";
      const label = el("span", "ai-status-text", a.busy ? `Assistant: ${a.activity ? doing(a.activity) : "Thinking"}…` : "Assistant: summarizing…");
      const stop = textButton("Stop", () => a.stop(), "btn ai-status-stop");
      this.status.append(label, stop);
    }
  }

  // ── 대화 그리기 ──────────────────────────────────────────────────────
  private update(t: Turn | null) {
    if (this.view !== "chat") return;
    // 흘러오는 글은 그 말풍선만 고친다
    if (t && t.role === "assistant") {
      const node = this.body.querySelector<HTMLElement>(`[data-turn="${t.id}"] .ai-bubble`);
      if (node && this.turnIndex(t) >= 0) {
        const near = this.nearBottom();
        node.innerHTML = t.text ? markdown(t.text) : '<span class="ai-dots"><i></i><i></i><i></i></span>';
        if (near) this.body.scrollTop = this.body.scrollHeight;
        return;
      }
    }
    // 그 밖에는 한 프레임에 한 번 통째로 다시 그린다
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  private turnIndex(t: Turn) { return this.agent.turns.indexOf(t); }

  private nearBottom() { return this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 80; }

  private render() {
    if (this.view !== "chat") return;
    const near = this.nearBottom() || !this.body.childElementCount;
    // 펼쳐 둔 것을 기억했다가 다시 펼친다
    for (const d of this.body.querySelectorAll<HTMLDetailsElement>("details[data-key]")) {
      if (d.open) this.openDetails.add(d.dataset.key!); else this.openDetails.delete(d.dataset.key!);
    }
    this.body.innerHTML = "";
    if (!settings.key) { this.body.appendChild(this.onboarding()); return; }
    if (!this.agent.turns.length) { this.body.appendChild(this.welcome()); return; }
    let steps: { box: HTMLDetailsElement; list: HTMLElement; n: number; bad: number; running: string; kinds: string[] } | null = null;
    const closeSteps = () => {
      if (!steps) return;
      const sum = steps.box.querySelector("summary")!;
      // 도는 중이면 지금 하는 일, 끝났으면 한 일들 (같은 것은 한 번)
      const what = steps.running ? steps.running + "…" : steps.kinds.join(", ");
      sum.textContent = `${steps.n} step${steps.n === 1 ? "" : "s"}${steps.bad ? ` · ${steps.bad} with a problem` : ""} · ${what}`;
      steps = null;
    };
    for (const t of this.agent.turns) {
      if (t.role === "tool" && t.tool) {
        if (!steps) {
          const box = el("details", "ai-steps") as HTMLDetailsElement;
          box.dataset.key = "steps-" + t.id;
          box.open = this.openDetails.has(box.dataset.key);
          box.appendChild(el("summary"));
          const list = el("div", "ai-step-list");
          box.appendChild(list);
          this.body.appendChild(box);
          steps = { box, list, n: 0, bad: 0, running: "", kinds: [] };
        }
        steps.n++;
        if (t.tool.state === "error") steps.bad++;
        const k = doing(t.tool.name);
        if (!steps.kinds.includes(k)) steps.kinds.push(k);
        steps.running = t.tool.state === "running" ? k : "";
        steps.list.appendChild(this.toolRow(t));
        continue;
      }
      closeSteps();
      this.body.appendChild(this.turnView(t));
    }
    closeSteps();
    if (near) this.body.scrollTop = this.body.scrollHeight;
  }

  private turnView(t: Turn): HTMLElement {
    const box = el("div", `ai-msg ${t.role}${t.error ? " error" : ""}`);
    box.dataset.turn = String(t.id);
    if (t.role === "user") {
      if (t.pics?.length) {
        const pics = el("div", "ai-pics");
        t.pics.forEach((url, i) => pics.appendChild(picture(url, "", `Attached picture ${i + 1}`)));
        box.appendChild(pics);
      } else if (t.picCount) {
        box.appendChild(el("div", "ai-note", `${t.picCount === 1 ? "A picture was" : `${t.picCount} pictures were`} attached (not kept after the page closed)`));
      }
      if (t.text) box.appendChild(el("div", "ai-bubble", t.text));
    }
    else if (t.role === "assistant") {
      const b = el("div", "ai-bubble md");
      b.innerHTML = t.text ? markdown(t.text) : '<span class="ai-dots"><i></i><i></i><i></i></span>';
      box.appendChild(b);
    } else if (t.detail) {
      const d = el("details", "ai-note-detail") as HTMLDetailsElement;
      d.dataset.key = "note-" + t.id;
      d.open = this.openDetails.has(d.dataset.key);
      d.append(el("summary", "", t.text), el("pre", "", t.detail));
      box.appendChild(d);
    } else box.appendChild(el("div", "ai-note", t.text));
    if (t.undo && this.host.undoGroup() === t.undo.group) {
      const b = textButton("Undo these changes", () => {
        if (this.agent.undoTurn(t)) { this.render(); return; }
        // 그 사이에 다른 편집이 맨 위에 쌓였다. 그것까지 되돌리면 손으로 한 일을 잃는다
        b.textContent = "Other edits came after this — use Edit › Undo";
        b.disabled = true;
      }, "btn ai-undo");
      box.appendChild(b);
    }
    return box;
  }

  private toolRow(t: Turn): HTMLElement {
    const tool = t.tool!;
    const d = el("details", `ai-tool ${tool.state}`) as HTMLDetailsElement;
    d.dataset.key = "tool-" + t.id;
    d.open = this.openDetails.has(d.dataset.key);
    const sum = el("summary");
    sum.append(el("span", "ai-dot"), el("span", "ai-tool-name", doing(tool.name)));
    if (tool.summary) sum.appendChild(el("span", "ai-tool-sum", tool.summary));
    d.appendChild(sum);
    // 모델이 본 그림 — 이 탭에만 있다 (대화를 저장할 때 빠진다)
    for (const url of tool.pics ?? []) d.appendChild(picture(url, "ai-shot", "What the assistant looked at"));
    d.append(el("div", "ai-tool-label", `${tool.name} · arguments`), el("pre", "", pretty(tool.args)));
    if (tool.result) d.append(el("div", "ai-tool-label", "Result"), el("pre", "", pretty(tool.result)));
    return d;
  }

  private onboarding(): HTMLElement {
    const box = el("div", "ai-empty");
    box.append(
      el("div", "ai-empty-title", "Connect OpenRouter"),
      el("p", "", "The assistant builds and changes circuits with you, runs the simulation, reads the results and lays the transistors out in SKY130. " +
        "It uses a model on OpenRouter with your own key — the key stays in this browser and requests go straight to openrouter.ai."),
    );
    const row = el("div", "ai-row");
    row.append(
      textButton("Connect with OpenRouter", () => { void startSignIn(); }, "btn primary"),
      textButton("Paste an API key", () => this.openSettings()),
    );
    box.appendChild(row);
    const a = el("a", "", "Get a key at openrouter.ai");
    a.href = "https://openrouter.ai/keys";
    a.target = "_blank";
    a.rel = "noopener";
    box.appendChild(a);
    box.appendChild(el("p", "ai-fine", "The assistant sends your messages and a description of the circuit (parts, nets, netlist, simulation results) to OpenRouter, only when you use it."));
    return box;
  }

  private welcome(): HTMLElement {
    const box = el("div", "ai-empty");
    box.append(
      el("div", "ai-empty-title", "What should we build?"),
      el("p", "", "Describe a circuit or a change in your own words. The assistant edits the schematic, runs the simulation to check its work, and every request undoes as one step. You can keep editing by hand meanwhile — it is told what you changed."),
    );
    const list = el("div", "ai-suggest");
    for (const s of SUGGESTIONS) list.appendChild(textButton(s, () => this.ask(s), "btn ai-chip"));
    box.appendChild(list);
    return box;
  }

  // ── 설정 ─────────────────────────────────────────────────────────────
  /** 대화 대신 다른 것을 보인다. 그동안 입력 칸은 숨긴다 — 좁은 서랍에서 자리를 먹고, 거기 적을 일도 없다 */
  private aside(view: "settings" | "usage" | "memo") {
    this.view = view;
    this.root.classList.add("settings-open");
  }

  private closeAside() {
    this.view = "chat";
    this.root.classList.remove("settings-open");
    this.body.innerHTML = "";
    this.render();
    this.sync();
  }

  // ── 프로젝트 메모 ────────────────────────────────────────────────────
  private openMemo() {
    this.aside("memo");
    this.renderMemo(true);
    this.sync();
  }

  /** 메모 화면. 고치던 글이 있으면 뒤에서 메모가 바뀌어도 덮지 않는다 (아래 줄만 맞춘다) */
  private renderMemo(force = false) {
    if (this.view !== "memo") return;
    const a = this.agent;
    const status = () => (a.memoBusy ? "The assistant is updating the memo…"
      : a.memo ? `${a.memo.by === "user" ? "Last edited by you" : "Written by the assistant"} · ${when(a.memo.at)}` : "");
    const editing = this.body.querySelector<HTMLTextAreaElement>(".ai-memo");
    if (editing && !force && editing.value !== (editing.dataset.base ?? "")) {
      const info = this.body.querySelector(".ai-memo-info");
      if (info) info.textContent = status();
      return;
    }
    this.body.innerHTML = "";
    const box = el("div", "ai-settings");
    box.append(
      el("div", "ai-empty-title", "Project memo"),
      el("p", "ai-fine", "A short note the assistant keeps about this project — goals, specifications, decisions, results, what is left to do. " +
        "Every new conversation starts from it. The assistant updates it after a request that changes or simulates the circuit; " +
        "edit it to correct or add what it should remember. It stays in this browser."),
    );
    if (!settings.value.memo) box.appendChild(el("p", "ai-hint", "The project memo is turned off in the assistant settings: the assistant neither reads nor updates it."));
    const area = el("textarea", "ai-memo");
    area.value = a.memo?.text ?? "";
    area.dataset.base = area.value;
    area.maxLength = MEMO_MAX;
    area.rows = 10;
    area.placeholder = "Nothing yet. The assistant writes here after it changes the circuit — or write the goals and specifications yourself.";
    area.setAttribute("aria-label", "Project memo");
    area.addEventListener("keydown", e => e.stopPropagation());
    box.append(area, el("p", "ai-hint ai-memo-info", status()));
    const buttons = el("div", "ai-row ai-buttons");
    buttons.append(
      textButton("Save", () => { a.setMemo(area.value); this.closeAside(); }, "btn primary"),
      textButton("Back", () => this.closeAside()),
    );
    if (a.memo) buttons.appendChild(textButton("Clear", () => { if (confirm("Clear the project memo?")) { a.setMemo(""); this.renderMemo(true); } }, "btn danger"));
    box.appendChild(buttons);
    this.body.appendChild(box);
  }

  // ── 사용 기록 ────────────────────────────────────────────────────────
  private openUsage() {
    this.aside("usage");
    this.renderUsage();
  }

  private renderUsage() {
    const log = this.agent.usageLog;
    const t = log.totals();
    const keep = this.body.scrollTop;
    this.body.innerHTML = "";
    const box = el("div", "ai-settings");
    box.append(
      el("div", "ai-empty-title", "Usage"),
      el("p", "ai-fine", "What the assistant used on this project, kept in this browser. Credits are what OpenRouter reports; " +
        "starting a new conversation does not clear this."),
    );
    const stats = el("div", "ai-stats");
    const stat = (label: string, value: string) => {
      const d = el("div", "ai-stat");
      d.append(el("span", "ai-stat-v", value), el("span", "ai-stat-l", label));
      stats.appendChild(d);
    };
    stat("requests", String(log.entries.filter(e => e.kind === "request").length));
    stat("model calls", String(t.calls));
    stat("tokens in", tokens(t.prompt));
    stat("from the cache", t.prompt ? Math.round((t.cached / t.prompt) * 100) + "%" : "–");
    stat("tokens out", tokens(t.completion));
    stat("credits", money(t.cost));
    stat("time", duration(t.ms));
    stat("tool calls", String(t.tools));
    box.appendChild(stats);

    const table = (head: string[], rows: string[][]) => {
      const tb = el("table", "ai-table");
      const tr = el("tr");
      for (const h of head) tr.appendChild(el("th", "", h));
      tb.appendChild(tr);
      for (const r of rows) {
        const row = el("tr");
        r.forEach((c, i) => row.appendChild(el("td", i ? "num" : "", c)));
        tb.appendChild(row);
      }
      const wrap = el("div", "ai-table-wrap");
      wrap.appendChild(tb);
      return wrap;
    };
    const models = log.byModel();
    if (models.length) {
      box.appendChild(el("div", "ai-field-label", "By model"));
      box.appendChild(table(["Model", "Calls", "Tokens", "Credits"],
        models.map(([m, x]) => [m, String(x.calls), tokens(x.prompt + x.completion), money(x.cost)])));
    }
    const recent = [...log.entries].reverse().slice(0, 40);
    if (recent.length) {
      box.appendChild(el("div", "ai-field-label", "Recent"));
      box.appendChild(table(["What", "Tokens", "Credits", "Time"], recent.map(e => [
        `${when(e.at)} · ${e.kind === "request" ? e.label : KIND_LABEL[e.kind]}${e.running ? " (running)" : ""}`,
        tokens(e.prompt + e.completion), money(e.cost), duration(e.ms),
      ])));
    } else box.appendChild(el("p", "ai-fine", "Nothing yet."));

    const buttons = el("div", "ai-row ai-buttons");
    buttons.append(
      textButton("Back", () => this.closeAside(), "btn primary"),
      textButton("Download CSV", () => {
        const url = URL.createObjectURL(new Blob([log.csv()], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = fileStem(this.host.project().name) + "-assistant-usage.csv";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }),
    );
    if (log.entries.length) {
      buttons.appendChild(textButton("Clear", () => {
        if (confirm("Clear the usage log of this project?")) log.clear();
      }, "btn danger"));
    }
    box.appendChild(buttons);
    this.body.appendChild(box);
    this.body.scrollTop = keep;
  }

  // ── 설정 ─────────────────────────────────────────────────────────────
  private openSettings() {
    this.aside("settings");
    void this.loadModels();
    const v: AISettings = { ...settings.value };
    this.body.innerHTML = "";
    const form = el("div", "ai-settings");
    const field = (label: string, control: HTMLElement, hint?: string) => {
      const l = el("label", "ai-field");
      l.appendChild(el("span", "ai-field-label", label));
      l.appendChild(control);
      if (hint) l.appendChild(el("span", "ai-hint", hint));
      form.appendChild(l);
      return l;
    };
    const check = (label: string, on: boolean, hint?: string) => {
      const l = el("label", "ai-check");
      const c = el("input");
      c.type = "checkbox";
      c.checked = on;
      l.append(c, el("span", "", label));
      if (hint) l.appendChild(el("span", "ai-hint", hint));
      form.appendChild(l);
      return c;
    };

    form.appendChild(el("div", "ai-empty-title", "Assistant settings"));
    // 키
    const keyRow = el("div", "ai-row");
    const key = el("input");
    key.type = "password";
    key.value = settings.key;
    key.placeholder = "sk-or-…";
    key.autocomplete = "off";
    key.spellcheck = false;
    const show = textButton("Show", () => { key.type = key.type === "password" ? "text" : "password"; show.textContent = key.type === "password" ? "Show" : "Hide"; });
    keyRow.append(key, show);
    field("OpenRouter API key", keyRow);
    const remember = check("Remember the key on this device", v.remember, "Off: only until this tab closes.");
    const connect = el("div", "ai-row");
    connect.appendChild(textButton("Connect with OpenRouter", () => { void startSignIn(); }));
    const get = el("a", "", "Get a key");
    get.href = "https://openrouter.ai/keys"; get.target = "_blank"; get.rel = "noopener";
    connect.appendChild(get);
    form.appendChild(connect);

    // 모델
    const modelBox = el("div", "ai-combo");
    const model = el("input");
    model.value = v.model;
    model.placeholder = "provider/model";
    model.spellcheck = false;
    model.autocomplete = "off";
    const pop = el("div", "ai-combo-list");
    modelBox.append(model, pop);
    const info = el("span", "ai-hint");
    const describe = () => {
      const m = this.models.find(x => x.id === model.value.trim());
      if (!this.modelsLoaded) { info.textContent = "Loading the model list…"; return; }
      if (!m) { info.textContent = `${this.models.filter(takesTools).length} models with tool calling. Type to search.`; return; }
      const bits = [m.name];
      if (m.context_length) bits.push(`${Math.round(m.context_length / 1000)}k context`);
      if (!takesTools(m)) bits.push("no tool calling — pick another");
      bits.push(seesImages(m) ? "sees images" : "text only");
      bits.push(`${price(m.pricing?.prompt)} in / ${price(m.pricing?.completion)} out per M tokens`);
      bits.push(cacheNote(m.id, m.pricing));
      info.textContent = bits.join(" · ");
    };
    let hits: Model[] = [];
    let active = -1;
    const fill = () => {
      const q = model.value.trim().toLowerCase();
      hits = this.models.filter(takesTools).filter(m => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 50);
      pop.innerHTML = "";
      hits.forEach((m, i) => {
        const o = el("div", "ai-combo-item" + (i === active ? " on" : ""));
        o.append(el("span", "", m.name), el("span", "ai-hint", seesImages(m) ? `${m.id} · sees images` : m.id));
        o.onmousedown = e => { e.preventDefault(); model.value = m.id; pop.classList.remove("open"); describe(); };
        pop.appendChild(o);
      });
      pop.classList.toggle("open", document.activeElement === model && hits.length > 0);
    };
    model.addEventListener("focus", () => { active = -1; fill(); });
    model.addEventListener("blur", () => setTimeout(() => pop.classList.remove("open"), 120));
    model.addEventListener("input", () => { active = -1; fill(); describe(); });
    model.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = Math.max(0, Math.min(hits.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
        fill();
        pop.children[active]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && active >= 0 && hits[active]) {
        e.preventDefault();
        model.value = hits[active].id;
        pop.classList.remove("open");
        describe();
      } else if (e.key === "Escape") pop.classList.remove("open");
    });
    const refresh = textButton("Refresh", () => { void this.loadModels(true).then(() => { fill(); describe(); }); });
    const modelRow = el("div", "ai-row");
    modelRow.append(modelBox, refresh);
    field("Model", modelRow).appendChild(info);
    describe();
    void this.loadModels().then(describe);

    const temp = el("input");
    temp.type = "number"; temp.min = "0"; temp.max = "1.5"; temp.step = "0.05"; temp.value = String(v.temperature);
    field("Temperature", temp, "Lower is steadier. 0.3 suits circuit work.");
    const steps = el("input");
    steps.type = "number"; steps.min = "1"; steps.max = "80"; steps.step = "1"; steps.value = String(v.maxSteps);
    field("Model calls per request", steps, "The assistant pauses after this many and asks whether to go on.");
    const sim = check("Let the assistant run simulations", v.allowSimulate);
    const limit = el("input");
    limit.type = "number"; limit.min = "5"; limit.max = "3600"; limit.step = "5"; limit.value = String(v.simTimeout);
    field("Simulation time limit (seconds)", limit);
    const cache = check("Keep Claude's prompt cache for an hour", v.cacheLong,
      "Claude only. Writing the cache costs 2× instead of 1.25×; worth it when you come back after more than five minutes.");
    const pics = check("Let the assistant look at the schematic and plots", v.pictures,
      "Models that see images only. A picture costs about as much as a page of text; it is kept only until the answer.");
    const memo = check("Keep a project memo", v.memo,
      "After a request that changes or simulates the circuit, one small extra call updates a short note about the project. New conversations start from it.");

    form.appendChild(el("p", "ai-fine", "The key and these settings stay in this browser. The assistant sends your messages and a description of the circuit to OpenRouter only when you use it; nothing goes through a Melange server."));

    const buttons = el("div", "ai-row ai-buttons");
    buttons.append(
      textButton("Save", () => {
        settings.set({
          model: model.value.trim(),
          temperature: Number(temp.value),
          maxSteps: Number(steps.value),
          remember: remember.checked,
          allowSimulate: sim.checked,
          simTimeout: Number(limit.value),
          cacheLong: cache.checked,
          pictures: pics.checked,
          memo: memo.checked,
        });
        settings.setKey(key.value);
        this.closeSettings();
      }, "btn primary"),
      textButton("Cancel", () => this.closeSettings()),
    );
    if (settings.key) buttons.appendChild(textButton("Remove key", () => { settings.setKey(""); key.value = ""; }, "btn danger"));
    form.appendChild(buttons);
    this.body.appendChild(form);
    for (const i of form.querySelectorAll("input")) i.addEventListener("keydown", e => e.stopPropagation());
    (settings.key ? model : key).focus({ preventScroll: true });
  }

  private closeSettings() { this.closeAside(); }
}

/** 어시스턴트를 그 칸에 띄운다. 한 번만 부른다 */
export function mountAssistant(root: HTMLElement, host: AssistantHost, hooks: PanelHooks): AssistantPanel {
  return new AssistantPanel(root, host, hooks);
}
