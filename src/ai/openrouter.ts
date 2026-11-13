/**
 * OpenRouter 와 주고받기 — 채팅(도구 호출 · 스트리밍), 모델 목록, 키 받기(OAuth PKCE).
 *
 * 요청은 브라우저에서 openrouter.ai 로 바로 간다. 키는 사용자의 것이고, 사이에 이 앱의 서버는 없다
 * (melange 는 정적 호스팅이다). OpenAI 와 같은 모양의 chat/completions 를 쓴다.
 *
 * 받는 쪽은 스트림의 조각을 모아 답 하나로 만든다 (ReplyAssembler). 도구 호출의 인자는 여러 조각으로
 * 오고, 생각하는 모델의 추론(reasoning_details)은 **받은 그대로** 다음 요청에 돌려보내야 도구 루프의
 * 다음 단계가 거절되지 않는다 — 공급자가 서명까지 보고 통째로 검사한다.
 */
import { cachePlan, refusedField } from "./cache.ts";

export const API = "https://openrouter.ai/api/v1";

/** 모델 목록의 한 줄 (필요한 필드만) */
export interface Model {
  id: string;
  name: string;
  created?: number;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[] };
}

/** 캐시 표시 (cache.ts) */
export interface CacheMark { type: "ephemeral"; ttl?: "1h" }

export type Part =
  | { type: "text"; text: string; cache_control?: CacheMark }
  | { type: "image_url"; image_url: { url: string } };

export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }

/** 생각하는 모델의 추론 한 덩어리. 모양은 공급자가 정한다 — 그대로 돌려보낸다 */
export interface Reasoning { type: string; index?: number; [field: string]: unknown }

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Part[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning?: string;
  reasoning_details?: Reasoning[];
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** 크레딧. OpenRouter 가 알려 줄 때만 */
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  /** Anthropic 모양으로 오는 경로도 있다 */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** 캐시에서 읽은 · 캐시에 쓴 입력 토큰 */
export function cachedTokens(u: Usage | null | undefined): { read: number; written: number } {
  return {
    read: u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens ?? 0,
    written: u?.prompt_tokens_details?.cache_write_tokens ?? u?.cache_creation_input_tokens ?? 0,
  };
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** 대화의 열쇠 — 같은 공급자에게 가게 한다 (cache.ts) */
  session?: string;
  /** Claude: 캐시를 한 시간 둔다 */
  longCache?: boolean;
  /** 한 번만 쓰는 요청 (요약). 캐시 표시를 달지 않는다 */
  oneOff?: boolean;
}

export interface ChatReply {
  message: Message;
  /** stop · tool_calls · length … */
  finish: string;
  usage: Usage | null;
  /** 실제로 답한 모델 (OpenRouter 가 바꿔 보냈을 수 있다) */
  model: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === "AbortError";

/** 요청 머리. HTTP-Referer · X-Title 은 OpenRouter 의 앱 표시용이다 (사용자에 대한 것이 아니다) */
export function headers(key: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "X-Title": "Melange",
  };
  if (typeof location !== "undefined") h["HTTP-Referer"] = location.origin + location.pathname;
  return h;
}

/** 오류 응답을 사람 말로. 서버가 한 말이 있으면 그것을 살리고, 할 일을 앞에 붙인다 */
export function describeError(status: number, body: string): string {
  const hint =
    status === 401 ? "OpenRouter rejected the API key (401). Check it in the assistant settings."
    : status === 402 ? "The OpenRouter account has no credits left (402)."
    : status === 429 ? "OpenRouter is rate limiting the requests (429). Wait a moment and try again."
    : "";
  let said = "";
  try {
    const j = JSON.parse(body);
    said = String(j?.error?.message ?? j?.message ?? "");
    const raw = j?.error?.metadata?.raw;
    if (said && typeof raw === "string" && raw) said += ` (${raw.slice(0, 300)})`;
  } catch { /* JSON 이 아니다 */ }
  if (said) return hint ? `${hint} ${said}` : said;
  if (hint) return hint;
  // 프록시 · 관문의 오류 쪽지(HTML)는 그대로 보여 줄 것이 못 된다
  if (/^\s*</.test(body)) return `OpenRouter answered with HTTP ${status}. Try again in a moment.`;
  return body.trim().slice(0, 300) || `HTTP ${status}`;
}

// ── 모델 목록 ─────────────────────────────────────────────────────────
let models: { at: number; list: Model[] } | null = null;

/** OpenRouter 의 모델 목록 (공개 주소라 키가 필요 없다). 10분 동안 기억한다 */
export async function listModels(force = false): Promise<Model[]> {
  if (!force && models && Date.now() - models.at < 600_000) return models.list;
  const res = await fetch(`${API}/models`);
  if (!res.ok) throw new ApiError(describeError(res.status, await res.text()), res.status);
  const j = await res.json();
  const list: Model[] = Array.isArray(j?.data) ? j.data : [];
  models = { at: Date.now(), list };
  return list;
}

/** 도구 호출을 받는 모델인가. 목록이 그 정보를 안 주면 받는 것으로 본다 */
export const takesTools = (m: Model | undefined): boolean =>
  !m?.supported_parameters || m.supported_parameters.includes("tools");

/** 그림을 보는 모델인가 */
export const seesImages = (m: Model | undefined): boolean => !!m?.architecture?.input_modalities?.includes("image");

/**
 * 처음 고를 모델: 도구를 받는 가장 새 Claude Sonnet, 없으면 가장 새 Claude, 그것도 없으면 도구를
 * 받는 가장 새 모델. 도구가 없으면 어시스턴트가 아무것도 못 한다.
 */
export function defaultModel(list: readonly Model[]): string {
  const usable = list.filter(takesTools);
  const newest = (ms: Model[]) => [...ms].sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0]?.id;
  return newest(usable.filter(m => /^anthropic\/claude/.test(m.id) && /sonnet/.test(m.id)))
    ?? newest(usable.filter(m => /^anthropic\//.test(m.id)))
    ?? newest(usable)
    ?? "";
}

// ── 채팅 ──────────────────────────────────────────────────────────────
/** 한 번 더 해 볼 만한 상태 — 시간 초과, 너무 잦은 요청, 관문 오류 */
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_WAITS = [1500, 4000];

/** 모델마다 공급자가 거절한 필드. 이 탭이 살아 있는 동안 그 모델에는 빼고 보낸다 */
const refused = new Map<string, { top?: boolean; marks?: boolean; session?: boolean }>();

/** 기다린다. 멈추면 AbortError 로 끝난다 */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const t = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * 채팅 요청 하나 (스트리밍). onText 는 글이 오는 대로 받는다. 도구 호출은 조각을 모아 돌려준다.
 *
 * 연결이 끊기거나 일시적인 오류(429 · 5xx)면 두 번까지 기다렸다 다시 보낸다 — 아직 아무것도 흘려보내지
 * 않았을 때만이다. 공급자가 캐시 필드나 session_id 를 받지 않으면 그것을 빼고 다시 보낸다.
 */
export async function chat(
  key: string, req: ChatRequest, opt: { signal?: AbortSignal; onText?: (delta: string) => void } = {},
): Promise<ChatReply> {
  let res: Response | null = null;
  let retries = 0;
  for (let attempt = 0; attempt < 8 && !res; attempt++) {
    const r = refused.get(req.model) ?? {};
    const once = req.oneOff === true;
    const plan = cachePlan(req.model, req.messages, { longTtl: req.longCache, noTop: r.top || once, noMarks: r.marks || once });
    const body: Record<string, unknown> = { model: req.model, messages: plan.messages, stream: true, usage: { include: true } };
    if (plan.top) body.cache_control = plan.top;
    if (req.session && !r.session) body.session_id = req.session.slice(0, 256);
    if (req.tools?.length) { body.tools = req.tools; body.tool_choice = "auto"; }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens) body.max_tokens = req.maxTokens;

    let resp: Response;
    try {
      resp = await fetch(`${API}/chat/completions`, {
        method: "POST", headers: headers(key), body: JSON.stringify(body), signal: opt.signal,
      });
    } catch (e) {
      if (isAbort(e) || retries >= RETRY_WAITS.length) throw e;
      await wait(RETRY_WAITS[retries++], opt.signal);
      continue;
    }
    if (resp.ok) { res = resp; break; }

    const text = describeError(resp.status, await resp.text());
    if (TRANSIENT.has(resp.status) && retries < RETRY_WAITS.length) {
      const after = Number(resp.headers.get("retry-after"));
      await wait(after > 0 ? Math.min(after, 20) * 1000 : RETRY_WAITS[retries], opt.signal);
      retries++;
      continue;
    }
    // 받지 않은 필드를 빼고 다시: session_id, 그다음 맨 위 cache_control, 그다음 메시지의 표시
    const field = refusedField(resp.status, text);
    if (field === "session" && body.session_id) { refused.set(req.model, { ...r, session: true }); continue; }
    if (field === "cache" && body.cache_control) { refused.set(req.model, { ...r, top: true }); continue; }
    if (field === "cache" && plan.marked) { refused.set(req.model, { ...r, marks: true }); continue; }
    throw new ApiError(text, resp.status);
  }
  if (!res) throw new ApiError("OpenRouter did not answer the request.");
  return readReply(res, req.model, opt.onText);
}

/** 응답 본문을 읽어 답으로. 스트림이 아니라 한 덩어리로 답하는 경로도 있다 */
async function readReply(res: Response, model: string, onText?: (delta: string) => void): Promise<ChatReply> {
  const asm = new ReplyAssembler(model, onText);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream") || !res.body) {
    asm.feed(await res.text());
    return asm.finish();
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const line = (l: string) => {
    const t = l.trim();
    // ':' 로 시작하는 줄은 연결을 붙들어 두는 주석이다 (": OPENROUTER PROCESSING")
    if (t.startsWith("data:")) asm.feed(t.slice(5).trim());
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      line(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) line(buf);
  return asm.finish();
}

/** 추론 덩어리에서 글이 이어 붙는 필드 (종류별) */
const REASONING_TEXT: Record<string, string> = { "reasoning.text": "text", "reasoning.summary": "summary" };

/**
 * 스트림 조각을 모아 답 하나로. 조각 하나(data: 줄의 JSON)를 feed 에 넣는다.
 * 스트림이 아닌 한 덩어리 답도 같은 길로 읽는다 (choices[0].message).
 */
export class ReplyAssembler {
  private text = "";
  private reasoning = "";
  private readonly details: Reasoning[] = [];
  private readonly calls: ToolCall[] = [];
  private finishReason = "";
  private usage: Usage | null = null;
  private model: string;
  private readonly onText?: (delta: string) => void;

  constructor(model: string, onText?: (delta: string) => void) {
    this.model = model;
    this.onText = onText;
  }

  feed(data: string): void {
    if (!data || data === "[DONE]") return;
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    // 스트림 도중의 오류는 조각 하나로 온다
    if (j?.error) throw new ApiError(String(j.error.message || "The model returned an error."), Number(j.error.code) || 0);
    if (typeof j?.model === "string" && j.model) this.model = j.model;
    if (j?.usage) this.usage = j.usage;
    const choice = j?.choices?.[0];
    if (!choice) return;
    const d = choice.delta ?? choice.message ?? {};
    if (typeof d.content === "string" && d.content) {
      this.text += d.content;
      this.onText?.(d.content);
    }
    if (typeof d.reasoning === "string") this.reasoning += d.reasoning;
    if (Array.isArray(d.reasoning_details)) for (const p of d.reasoning_details) this.addReasoning(p);
    if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) this.addCall(tc);
    if (choice.finish_reason) this.finishReason = String(choice.finish_reason);
  }

  /**
   * 도구 호출 조각. index 가 있으면 그 자리, 없으면 새 id 가 새 호출이고 아니면 마지막 호출에 잇는다.
   * 이름이 조각으로 오는 경로도 있어서, 다른 이름이 오면 이어 붙인다 (같은 이름이 되풀이되면 그대로).
   */
  private addCall(tc: any): void {
    let i: number = typeof tc?.index === "number" ? tc.index : -1;
    if (i < 0) {
      const last = this.calls[this.calls.length - 1];
      i = !last || (tc?.id && last.id && tc.id !== last.id) ? this.calls.length : this.calls.length - 1;
    }
    const call = (this.calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
    if (tc?.id) call.id = String(tc.id);
    const name = tc?.function?.name;
    if (typeof name === "string" && name) call.function.name = call.function.name && call.function.name !== name ? call.function.name + name : name;
    const args = tc?.function?.arguments;
    if (typeof args === "string") call.function.arguments += args;
  }

  /**
   * 추론 조각. 한 덩어리(같은 종류 · 같은 index)의 조각은 잇달아 오고, 글은 이어 붙이고 서명 같은
   * 나머지 필드는 마지막 값을 둔다 — 공급자는 덩어리를 통째로 검사한다.
   */
  private addReasoning(piece: Reasoning): void {
    if (!piece || typeof piece !== "object") return;
    const last = this.details[this.details.length - 1];
    const field = REASONING_TEXT[piece.type];
    if (!field || !last || last.type !== piece.type || last.index !== piece.index) {
      this.details.push({ ...piece });
      return;
    }
    for (const [k, v] of Object.entries(piece)) {
      if (v === null || v === undefined) continue;
      last[k] = k === field ? `${(last[k] as string | undefined) ?? ""}${v}` : v;
    }
  }

  finish(): ChatReply {
    const calls = this.calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }));
    const message: Message = { role: "assistant", content: this.text || null };
    if (calls.length) message.tool_calls = calls;
    // 생각하는 모델만 보낸다. 다른 모델의 메시지는 예전 모양 그대로다
    if (this.details.length) {
      message.reasoning_details = this.details;
      if (this.reasoning) message.reasoning = this.reasoning;
    }
    return { message, finish: this.finishReason || (calls.length ? "tool_calls" : "stop"), usage: this.usage, model: this.model };
  }
}

// ── 키 받기 (OAuth PKCE) ─────────────────────────────────────────────
/*
 * "Connect with OpenRouter" 를 누르면 OpenRouter 로 갔다가 ?code= 를 달고 이 페이지로 돌아온다.
 * 그 code 와 처음에 만든 검증 값으로 키를 받는다. 검증 값은 이 탭의 sessionStorage 에만 둔다.
 * 돌아올 주소는 지금 페이지 그대로라 GitHub Pages 의 하위 경로에서도 된다.
 */
const PKCE_KEY = "melange.openrouter-pkce";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** OpenRouter 의 연결 화면으로 간다 */
export async function startSignIn(): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  sessionStorage.setItem(PKCE_KEY, verifier);
  const back = location.origin + location.pathname;
  location.href = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(back)}&code_challenge=${challenge}&code_challenge_method=S256`;
}

/** 이 페이지가 연결 화면에서 돌아온 참인가 (?code= 가 있고, 이 탭이 보낸 검증 값이 있다) */
export function signInReturned(): boolean {
  try {
    return new URLSearchParams(location.search).has("code") && !!sessionStorage.getItem(PKCE_KEY);
  } catch { return false; }
}

/** 돌아왔으면 키를 받아 돌려준다. 주소창의 ?code= 는 지운다 */
export async function finishSignIn(): Promise<string | null> {
  const q = new URLSearchParams(location.search);
  const code = q.get("code");
  const verifier = sessionStorage.getItem(PKCE_KEY);
  if (!code || !verifier) return null;
  sessionStorage.removeItem(PKCE_KEY);
  q.delete("code");
  const rest = q.toString();
  window.history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
  const res = await fetch(`${API}/auth/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  if (!res.ok) throw new ApiError(describeError(res.status, await res.text()), res.status);
  const j = await res.json();
  if (!j?.key) throw new ApiError("OpenRouter did not send a key.");
  return String(j.key);
}
