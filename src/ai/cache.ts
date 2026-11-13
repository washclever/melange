/**
 * 프롬프트 캐시 (OpenRouter 를 거쳐).
 *
 * 어시스턴트의 요청은 앞부분이 늘 같다 — 도구 정의, 시스템 프롬프트, 그때까지의 대화. 공급자가 그
 * 앞부분을 캐시에 두면 다음 단계는 그만큼 싸고 빠르다. 공급자마다 방식이 둘이다:
 *
 *  - **표시를 달아야 하는 곳** (Anthropic 의 Claude, Alibaba 의 Qwen): cache_control 을 단 곳까지를
 *    캐시한다. 시스템 프롬프트 끝과 마지막 사용자 메시지에 단다. Claude 에는 OpenRouter 의 맨 위
 *    cache_control 도 보낸다 — 그 표시는 대화 끝으로 따라 움직여서, 도구를 부르는 단계마다 앞 단계가
 *    써 둔 것을 읽는다.
 *  - **스스로 하는 곳** (OpenAI, Google Gemini, DeepSeek, xAI, Moonshot, Z.ai, MiniMax …): 아무것도
 *    안 단다. 앞부분이 같고, 같은 공급자에게 가기만 하면 된다.
 *
 * 같은 공급자에게 가게 하는 것이 session_id 다. 대화의 요청마다 같은 값을 보내면 OpenRouter 가 그
 * 대화를 처음 간 공급자에게 계속 보낸다 — 그 공급자가 만든 캐시를 읽는다.
 *
 * 한 번만 쓰는 요청(대화 요약)에는 표시를 달지 않는다. 아무도 다시 읽지 않는 캐시 쓰기는 값만 더 든다.
 * 공급자가 받지 않는 필드는 그 모델에서 빼고 다시 보낸다 (openrouter.ts).
 */
import type { CacheMark, Message, Part } from "./openrouter.ts";

export type CacheKind = "marked" | "automatic" | "none";

/** 캐시 표시를 달아야 하는 모델들 */
const MARKED = [/^anthropic\//, /^qwen\//, /^alibaba\//];
/** 공급자가 스스로 캐시하는 모델들 */
const AUTOMATIC = [
  /^openai\//, /^google\/gemini/, /^deepseek\//, /^x-ai\//, /^moonshotai\//, /^z-ai\//, /^minimax\//, /^thudm\//,
];

/** 모델 목록의 값 매김. 캐시 읽기에 값이 매겨져 있으면 캐시를 한다는 뜻이다 */
export interface CachePrice { input_cache_read?: string; input_cache_write?: string }

/** 그 모델의 캐시 방식. 모르는 집안이면 값 매김으로 어림한다 */
export function cacheKind(model: string, price?: CachePrice): CacheKind {
  const id = model.toLowerCase();
  if (MARKED.some(r => r.test(id))) return "marked";
  if (AUTOMATIC.some(r => r.test(id))) return "automatic";
  const read = Number(price?.input_cache_read);
  return Number.isFinite(read) && read > 0 ? "automatic" : "none";
}

/** Claude 인가 — 맨 위 cache_control 과 한 시간 캐시는 Claude 만 받는다 */
export const isClaude = (model: string): boolean => /^anthropic\//i.test(model);

/** 설정 창에 적을 짧은 말 */
export function cacheNote(model: string, price?: CachePrice): string {
  switch (cacheKind(model, price)) {
    case "marked": return "prompt cache: marked";
    case "automatic": return "prompt cache: automatic";
    default: return "no prompt cache";
  }
}

export interface CacheOptions {
  /** Claude: 캐시를 다섯 분이 아니라 한 시간 둔다 (쓰기 값이 더 든다) */
  longTtl?: boolean;
  /** 맨 위 cache_control 을 뺀다 (공급자가 거부했다) */
  noTop?: boolean;
  /** 메시지의 표시를 뺀다 (공급자가 거부했다) */
  noMarks?: boolean;
}

export interface CachePlan {
  messages: Message[];
  /** OpenRouter 의 맨 위 cache_control (Claude) */
  top?: CacheMark;
  /** 메시지에 표시를 달았다 */
  marked: boolean;
}

/** 요청 본문에 실을 메시지와 캐시 필드. 대화 기록 자체는 건드리지 않는다 (사본에 단다) */
export function cachePlan(model: string, messages: readonly Message[], opt: CacheOptions = {}): CachePlan {
  if (opt.noMarks || cacheKind(model) !== "marked") return { messages: [...messages], marked: false };
  const mark: CacheMark = isClaude(model) && opt.longTtl ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  const out = messages.map(m => ({ ...m }));
  const sys = out.findIndex(m => m.role === "system");
  if (sys >= 0) out[sys] = marked(out[sys], mark);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "user") { out[i] = marked(out[i], mark); break; }
  }
  const plan: CachePlan = { messages: out, marked: true };
  if (isClaude(model) && !opt.noTop) plan.top = mark;
  return plan;
}

/** 메시지의 마지막 글 조각에 표시를 단 사본 */
function marked(m: Message, mark: CacheMark): Message {
  if (typeof m.content === "string") {
    return m.content ? { ...m, content: [{ type: "text", text: m.content, cache_control: mark }] } : m;
  }
  if (!Array.isArray(m.content)) return m;
  const parts: Part[] = m.content.map(p => ({ ...p }));
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.type === "text") { parts[i] = { ...p, cache_control: mark }; break; }
  }
  return { ...m, content: parts };
}

/** 공급자의 거절 글에서, 받지 않은 필드가 무엇인지 (session_id 또는 캐시 표시) */
export function refusedField(status: number, text: string): "session" | "cache" | null {
  if (status !== 400 && status !== 404 && status !== 422) return null;
  if (/session_id/i.test(text)) return "session";
  if (/cache[_ ]control|prompt cach/i.test(text)) return "cache";
  return null;
}
