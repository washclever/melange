// OpenRouter 클라이언트 검증 (src/ai/openrouter.ts · cache.ts). 진짜 키 없이 가짜 fetch 로 돈다.
//
// 조각을 모으는 쪽이 틀리면 오류 없이 이상한 답이 된다 — 도구 인자가 반쯤 잘리고, 생각하는 모델의
// 추론이 쪼개져 다음 단계가 거절된다. 실제 스트림이 오는 모양을 그대로 흉내 내어 본다.
import {
  ApiError, ReplyAssembler, cachedTokens, chat, defaultModel, describeError, takesTools, type Message, type Model,
} from "../src/ai/openrouter.ts";
import { cacheKind, cachePlan, refusedField } from "../src/ai/cache.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

/** SSE 본문. 조각을 일부러 줄 중간에서 끊어 보낸다 (네트워크는 줄 단위로 주지 않는다) */
function sse(chunks: unknown[], opts: { cut?: number; comments?: boolean } = {}): Response {
  let text = "";
  if (opts.comments) text += ": OPENROUTER PROCESSING\n\n";
  for (const c of chunks) text += `data: ${JSON.stringify(c)}\n\n`;
  text += "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  const cut = opts.cut ?? 7;
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      for (let i = 0; i < bytes.length; i += cut) ctl.enqueue(bytes.slice(i, i + cut));
      ctl.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const sent: Array<{ url: string; body: any }> = [];
function fakeFetch(...handlers: Handler[]) {
  let n = 0;
  sent.length = 0;
  (globalThis as { fetch: unknown }).fetch = async (url: string, init: RequestInit = {}) => {
    sent.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    const h = handlers[Math.min(n++, handlers.length - 1)];
    return h(url, init);
  };
}
const msgs: Message[] = [{ role: "system", content: "You help." }, { role: "user", content: "Hi" }];

// ── 1. 글과 도구 호출 조각 모으기 ─────────────────────────────────────
console.log("[스트림] 글과 도구 호출을 조각에서 모은다");
{
  fakeFetch(() => sse([
    { model: "anthropic/claude-x", choices: [{ delta: { content: "Plac" } }] },
    { choices: [{ delta: { content: "ing parts." } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "place_parts", arguments: "{\"par" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "ts\":[{\"type\":\"r\"}]}" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", type: "function", function: { name: "get_circuit", arguments: "{}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1200, completion_tokens: 30, cost: 0.004, prompt_tokens_details: { cached_tokens: 900 } } },
  ], { comments: true }));
  let streamed = "";
  const r = await chat("k", { model: "anthropic/claude-x", messages: msgs }, { onText: d => { streamed += d; } });
  ok(r.message.content === "Placing parts." && streamed === "Placing parts.", "글이 이어지고 흘려보낸 것과 같다", JSON.stringify(r.message.content));
  ok(r.message.tool_calls?.length === 2, "도구 호출 둘", String(r.message.tool_calls?.length));
  ok(r.message.tool_calls?.[0].function.arguments === "{\"parts\":[{\"type\":\"r\"}]}", "쪼개진 인자가 한 덩어리로", r.message.tool_calls?.[0].function.arguments);
  ok(r.message.tool_calls?.[1].function.name === "get_circuit" && r.message.tool_calls?.[1].id === "c2", "index 로 자리를 찾는다");
  ok(r.finish === "tool_calls", "끝난 까닭", r.finish);
  ok(r.usage?.cost === 0.004 && cachedTokens(r.usage).read === 900, "사용량과 캐시 읽기");
  ok(sent[0].url.endsWith("/chat/completions") && sent[0].body.stream === true && sent[0].body.usage?.include === true, "스트림과 사용량을 요청한다");
}

// index 없이 id 만으로 오는 경로
{
  const a = new ReplyAssembler("m");
  a.feed(JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "x1", function: { name: "connect", arguments: "{\"a\":" } }] } }] }));
  a.feed(JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: "1}" } }] } }] }));
  a.feed(JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "x2", function: { name: "delete", arguments: "{}" } }] } }] }));
  const r = a.finish();
  ok(r.message.tool_calls?.length === 2 && r.message.tool_calls[0].function.arguments === "{\"a\":1}", "index 가 없으면 새 id 가 새 호출", JSON.stringify(r.message.tool_calls));
  ok(r.finish === "tool_calls", "finish_reason 이 없으면 도구 호출로 본다");
}

// ── 2. 생각하는 모델의 추론은 덩어리째 ─────────────────────────────────
console.log("\n[추론] reasoning_details 는 덩어리째 모아 그대로 돌려보낸다");
{
  const a = new ReplyAssembler("m");
  a.feed(JSON.stringify({ choices: [{ delta: { reasoning: "Let me ", reasoning_details: [{ type: "reasoning.text", index: 0, text: "Let me " }] } }] }));
  a.feed(JSON.stringify({ choices: [{ delta: { reasoning: "think.", reasoning_details: [{ type: "reasoning.text", index: 0, text: "think.", signature: null }] } }] }));
  a.feed(JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, signature: "sig123" }] } }] }));
  a.feed(JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", index: 1, data: "abc" }] } }] }));
  a.feed(JSON.stringify({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }));
  const r = a.finish();
  const d = r.message.reasoning_details ?? [];
  ok(d.length === 2, "덩어리 둘 (글 하나 · 암호 하나)", String(d.length));
  ok(d[0]?.text === "Let me think." && d[0]?.signature === "sig123", "글은 이어 붙이고 서명은 남긴다", JSON.stringify(d[0]));
  ok(r.message.reasoning === "Let me think.", "추론 글도 같이");
  const b = new ReplyAssembler("m");
  b.feed(JSON.stringify({ choices: [{ delta: { content: "plain" }, finish_reason: "stop" }] }));
  ok(!("reasoning_details" in b.finish().message), "추론이 없는 모델의 메시지는 예전 모양 그대로");
}

// ── 3. 스트림이 아닌 답, 스트림 도중의 오류 ───────────────────────────
console.log("\n[모양] 한 덩어리 답과 스트림 도중의 오류");
{
  fakeFetch(() => new Response(JSON.stringify({ model: "x/y", choices: [{ message: { content: "whole" }, finish_reason: "stop" }] }),
    { status: 200, headers: { "content-type": "application/json" } }));
  const r = await chat("k", { model: "x/y", messages: msgs });
  ok(r.message.content === "whole", "스트림이 아니어도 읽는다");

  fakeFetch(() => sse([{ choices: [{ delta: { content: "par" } }] }, { error: { message: "Provider fell over", code: 502 } }]));
  let err: unknown = null;
  try { await chat("k", { model: "x/y", messages: msgs }); } catch (e) { err = e; }
  ok(err instanceof ApiError && /fell over/.test((err as Error).message), "도중의 오류 조각은 오류가 된다", String(err));
}

// ── 4. 재시도와 오류 문구 ─────────────────────────────────────────────
console.log("\n[재시도] 일시적인 오류는 기다렸다 다시, 아닌 것은 바로 알린다");
{
  fakeFetch(
    () => new Response("{\"error\":{\"message\":\"slow down\"}}", { status: 429, headers: { "retry-after": "0.01" } }),
    () => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
  );
  const t0 = Date.now();
  const r = await chat("k", { model: "x/y", messages: msgs });
  ok(r.message.content === "ok" && sent.length === 2, "429 뒤에 한 번 더 보내 받는다", `(${sent.length}번, ${Date.now() - t0} ms)`);

  fakeFetch(() => new Response("{\"error\":{\"message\":\"User not found.\"}}", { status: 401 }));
  let err: unknown = null;
  try { await chat("k", { model: "x/y", messages: msgs }); } catch (e) { err = e; }
  ok(err instanceof ApiError && (err as ApiError).status === 401 && sent.length === 1, "401 은 다시 보내지 않는다");
  ok(/API key/.test(String((err as Error).message)) && /User not found/.test(String((err as Error).message)), "할 일과 서버의 말을 같이", String((err as Error).message));
  ok(/HTTP 502/.test(describeError(502, "<html>Bad gateway</html>")), "관문의 HTML 쪽지는 그대로 보이지 않는다", describeError(502, "<html>"));

  // 멈추면 기다리던 재시도도 끝난다
  fakeFetch(() => new Response("busy", { status: 503 }));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  let aborted = false;
  try { await chat("k", { model: "x/y", messages: msgs }, { signal: ac.signal }); } catch (e) { aborted = (e as Error).name === "AbortError"; }
  ok(aborted, "기다리는 중에 멈추면 AbortError");
}

// ── 5. 캐시 표시 ──────────────────────────────────────────────────────
console.log("\n[캐시] 표시는 Claude 와 Qwen 에만, 한 번만 쓰는 요청에는 안 단다");
{
  ok(cacheKind("anthropic/claude-sonnet-4.5") === "marked" && cacheKind("openai/gpt-5") === "automatic", "모델 집안별 방식");
  ok(cacheKind("someone/new", { input_cache_read: "0.0000001" }) === "automatic" && cacheKind("someone/new") === "none", "모르는 집안은 값 매김으로");
  const history: Message[] = [
    { role: "system", content: "S" }, { role: "user", content: "u1" }, { role: "assistant", content: "a1" },
    { role: "user", content: [{ type: "text", text: "u2" }] },
  ];
  const p = cachePlan("anthropic/claude-x", history, { longTtl: true });
  const sys = p.messages[0].content as Array<{ cache_control?: unknown }>;
  const last = p.messages[3].content as Array<{ cache_control?: unknown }>;
  ok(Array.isArray(sys) && !!sys[0].cache_control && !!last[0].cache_control, "시스템 프롬프트와 마지막 사용자 메시지에 단다");
  ok(typeof p.messages[1].content === "string", "가운데 메시지는 그대로");
  ok(JSON.stringify(p.top) === JSON.stringify({ type: "ephemeral", ttl: "1h" }), "Claude 는 맨 위 표시도, 한 시간");
  ok(typeof history[0].content === "string", "대화 기록 자체는 건드리지 않는다");
  ok(!cachePlan("openai/gpt-5", history).marked, "자동 캐시 모델에는 안 단다");

  fakeFetch(() => sse([{ choices: [{ delta: { content: "s" }, finish_reason: "stop" }] }]));
  await chat("k", { model: "anthropic/claude-x", messages: history, oneOff: true, session: "s1" });
  ok(!sent[0].body.cache_control && typeof sent[0].body.messages[0].content === "string", "요약 같은 한 번짜리에는 표시가 없다");
  ok(sent[0].body.session_id === "s1", "session_id 는 실린다");

  // 받지 않는 필드는 빼고 다시
  fakeFetch(
    () => new Response("{\"error\":{\"message\":\"session_id is not allowed\"}}", { status: 400 }),
    () => new Response("{\"error\":{\"message\":\"cache_control: unsupported\"}}", { status: 400 }),
    () => sse([{ choices: [{ delta: { content: "fine" }, finish_reason: "stop" }] }]),
  );
  const r = await chat("k", { model: "qwen/qwen-x", messages: history, session: "s2" });
  ok(r.message.content === "fine" && sent.length === 3, "session_id, 그다음 표시를 빼고 받는다", `(${sent.length}번)`);
  ok(!("session_id" in sent[2].body) && typeof sent[2].body.messages[0].content === "string", "마지막 요청에는 둘 다 없다");
  ok(refusedField(400, "cache_control not supported") === "cache" && refusedField(500, "cache_control") === null, "거절 글 읽기");
}

// ── 6. 모델 고르기 ────────────────────────────────────────────────────
console.log("\n[모델] 도구를 받는 가장 새 Claude Sonnet 이 기본");
{
  const list: Model[] = [
    { id: "openai/gpt-x", name: "", created: 300, supported_parameters: ["tools"] },
    { id: "anthropic/claude-sonnet-4", name: "", created: 100, supported_parameters: ["tools"] },
    { id: "anthropic/claude-sonnet-4.5", name: "", created: 200, supported_parameters: ["tools"] },
    { id: "anthropic/claude-sonnet-9", name: "", created: 400, supported_parameters: ["temperature"] },
  ];
  ok(defaultModel(list) === "anthropic/claude-sonnet-4.5", "도구를 못 받는 것은 건너뛴다", defaultModel(list));
  ok(defaultModel([{ id: "x/a", name: "", created: 1 }]) === "x/a", "정보가 없으면 받는 것으로 본다");
  ok(!takesTools({ id: "a", name: "", supported_parameters: [] }), "목록이 도구를 빼고 적었으면 못 받는다");
}

console.log(fail === 0 ? "\nOpenRouter 클라이언트 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
