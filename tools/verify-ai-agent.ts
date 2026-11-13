// 어시스턴트 대화 검증 (src/ai/agent.ts). 대본대로 답하는 가짜 OpenRouter 로 돈다 — 키 없이.
//
// 지키는 것:
//  - 도구 호출 -> 결과 -> 다음 단계의 순서가 맞고, 요청 하나가 실행 취소 한 단계다
//  - 사람이 요청 사이에 고친 것은 다음 요청의 <editor-context> 에, 요청 도중에 고친 것은 다음 단계 앞의
//    [editor] 쪽지로 모델에게 간다
//  - 멈추면 결과 없는 도구 호출이 남지 않는다 (다음 요청이 거부되지 않게)
//  - 단계 한계, 깨진 인자, 대화 저장 · 다른 프로젝트로 바꾸기, 긴 대화 요약
import { setParam } from "../src/doc/history.ts";
import { emptyProject } from "../src/doc/types.ts";
import { builder } from "../src/lib/demos.ts";
import { Agent } from "../src/ai/agent.ts";
import { settings } from "../src/ai/settings.ts";
import { kvGet } from "../src/ai/kv.ts";
import { DOT, TestHost } from "./ai-test-host.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

type Step = string | Array<{ name: string; args: unknown; raw?: string }>;
const bodies: any[] = [];
let script: Step[] = [];
/** 모델에게 보내기 직전에 부른다 (요청 도중에 사람이 고치는 것을 흉내 낸다) */
let before: ((n: number) => void | Promise<void>) | null = null;
let hold: Promise<void> | null = null;

function reply(step: Step): Response {
  const delta = typeof step === "string"
    ? { content: step }
    : { tool_calls: step.map((c, index) => ({ index, id: `call_${bodies.length}_${index}`, type: "function", function: { name: c.name, arguments: c.raw ?? JSON.stringify(c.args) } })) };
  const chunk = { model: "test/model", choices: [{ delta, finish_reason: typeof step === "string" ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1000, completion_tokens: 20, cost: 0.001, prompt_tokens_details: { cached_tokens: 600 } } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

(globalThis as { fetch: unknown }).fetch = async (url: string, init: RequestInit = {}) => {
  if (String(url).endsWith("/models")) {
    return new Response(JSON.stringify({ data: [
      { id: "test/model", name: "Test", supported_parameters: ["tools"] },
      { id: "test/vision", name: "Vision", supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"] } },
    ] }));
  }
  const body = JSON.parse(String(init.body));
  bodies.push(body);
  await before?.(bodies.length);
  if (hold) {
    // 멈춤 시험: 응답을 붙들고 있다가 멈추면 AbortError
    await new Promise<void>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
  }
  return reply(script.shift() ?? "Done.");
};

settings.setKey("test-key");
// 메모는 따로 시험한다 (켜 두면 요청이 끝날 때마다 모델을 한 번 더 불러 대본이 어긋난다)
settings.set({ model: "test/model", maxSteps: 30, memo: false });

const userTexts = (b: any) => b.messages.filter((m: any) => m.role === "user").map((m: any) => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text).join("")));
const settle = () => new Promise(r => setTimeout(r, 0));

// ── 1. 도구를 부르고 답하는 요청 하나 ─────────────────────────────────
console.log("[요청] 도구 호출 -> 결과 -> 답, 한 단계로");
{
  const host = new TestHost(emptyProject("a"));
  const agent = new Agent(host);
  bodies.length = 0;
  script = [
    [{ name: "place_parts", args: { parts: [{ type: "vdc", at: [0, 0] }, { type: "r", at: [6, -4] }] } }],
    [{ name: "connect", args: { links: [{ from: "V1.p", to: "R1.1" }, { from: "V1.n", net: "0" }, { from: "R1.2", net: "0" }] } }],
    "Built a 5 V source across a 1 kΩ resistor.",
  ];
  await agent.send("Put a resistor across a 5 V source");
  ok(bodies.length === 3, "모델을 세 번 부른다", String(bodies.length));
  ok(bodies[0].messages[0].role === "system" && bodies[0].tools?.length > 10, "시스템 프롬프트와 도구 정의를 보낸다");
  ok(/<editor-context>[\s\S]*Project "a"[\s\S]*<\/editor-context>\s*Put a resistor/.test(userTexts(bodies[0])[0]), "상황 설명이 요청 앞에 붙는다");
  const tools2 = bodies[1].messages.filter((m: any) => m.role === "tool");
  ok(tools2.length === 1 && /"placed"/.test(tools2[0].content), "다음 단계에 도구 결과가 간다");
  ok(bodies[1].session_id && bodies[1].session_id === bodies[0].session_id, "같은 대화는 같은 session_id");
  ok(host.sheet().parts.length === 4 && host.hist.depth === 1, "회로가 바뀌고 한 단계로 묶인다", `${host.sheet().parts.length} parts, ${host.hist.depth} step`);
  const lastTurn = agent.turns[agent.turns.length - 1];
  ok(lastTurn.role === "assistant" && /5 V/.test(lastTurn.text) && !!lastTurn.undo, "마지막 답에 되돌리기가 달린다");
  ok(agent.turns.filter(t => t.role === "tool").length === 2 && agent.turns.every(t => t.tool?.state !== "running"), "도구 줄 둘, 도는 채로 남은 것이 없다");
  const used = agent.usageLog.totals();
  ok(used.calls === 3 && used.cached === 1800 && used.tools === 2 && Math.abs(used.cost - 0.003) < 1e-12, "사용량을 센다 (호출 · 캐시 · 도구 · 크레딧)", JSON.stringify(used));
  const entry = agent.usageLog.entries.at(-1);
  ok(entry?.kind === "request" && entry.label.startsWith("Put a resistor") && entry.model === "test/model" && !entry.running, "요청 하나가 한 줄로 남는다");
  ok(/^time,kind,label,model,model_calls/.test(agent.usageLog.csv()) && agent.usageLog.csv().trim().split("\n").length === 2, "CSV 로 내려받을 수 있다");
  ok(agent.undoTurn(lastTurn) && host.sheet().parts.length === 0, "대화 창에서 되돌리면 회로가 처음으로");
  agent.reset();
  ok(agent.usageLog.totals().calls === 3, "새 대화를 시작해도 사용 기록은 남는다");
  agent.dispose();
}

// ── 2. 사람이 고친 것을 알려 준다 ─────────────────────────────────────
console.log("\n[손 편집] 요청 사이 · 요청 도중에 고친 것이 모델에게 간다");
{
  const b = builder("u");
  const r = b.part("r", [60, -40]);
  b.part("c", [120, 0]);
  const host = new TestHost(b.project);
  const agent = new Agent(host);
  bodies.length = 0;
  script = ["Okay."];
  await agent.send("hello");
  host.userEdit(setParam(r.id, "value", "47k"));
  script = ["Noted."];
  await agent.send("what changed?");
  const ctx = userTexts(bodies[1]).at(-1) as string;
  ok(/Changes by the user since your last turn:[\s\S]*R1 value: 1k -> 47k/.test(ctx), "요청 사이의 편집이 상황 설명에", ctx.split("\n").find(l => /R1/.test(l)));
  // 요청 도중: 두 번째 모델 호출을 받는 사이에 사람이 값을 바꾼다
  bodies.length = 0;
  before = async n => { if (n === 2) host.userEdit(setParam(r.id, "value", "10k")); };
  script = [
    [{ name: "get_circuit", args: {} }],
    [{ name: "get_circuit", args: {} }],
    "Done.",
  ];
  await agent.send("check the circuit twice");
  before = null;
  const third = bodies[2]?.messages ?? [];
  const note = third.find((m: any) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[editor]"));
  ok(!!note && /R1 value: 47k -> 10k/.test(note.content), "요청 도중의 편집이 다음 단계 앞에 [editor] 쪽지로", note?.content?.split("\n")[1]);
  ok(agent.turns.some(t => t.role === "note" && /passed on/.test(t.text)), "대화 창에도 알렸다고 적는다");
  ok(!/Changes by the user/.test(userTexts(bodies[2]).filter((t: string) => t.includes("<editor-context>")).at(-1) ?? ""), "이미 알린 것은 다시 싣지 않는다");
  // 어시스턴트의 편집은 사람의 것으로 치지 않는다
  bodies.length = 0;
  script = [[{ name: "set_params", args: { changes: [{ ref: "C1", params: { value: "1u" } }] } }], "ok"];
  await agent.send("change C1");
  script = ["ok"];
  await agent.send("anything new?");
  ok(!/Changes by the user/.test(userTexts(bodies.at(-1)).at(-1)), "어시스턴트가 바꾼 C1 은 사람의 편집으로 나오지 않는다");

  // 사람이 고칠 때는 아무것도 훑지 않는다 — 차이는 모델에게 보낼 때 한 번 낸다
  const read = host.extraction.bind(host);
  let reads = 0;
  host.extraction = () => { reads++; return read(); };
  for (let i = 0; i < 50; i++) host.userEdit(setParam(r.id, "value", `${i + 1}k`));
  ok(reads === 0, "손 편집 50번에 어시스턴트는 회로를 한 번도 훑지 않는다", `${reads}번`);
  host.extraction = read;
  bodies.length = 0;
  script = ["ok"];
  await agent.send("and now?");
  ok(/R1 value: 10k -> 50k/.test(userTexts(bodies[0]).at(-1)), "보낼 때 한 번 낸 차이에는 처음과 마지막 값만", userTexts(bodies[0]).at(-1).split("\n").find((l: string) => /R1 value/.test(l)));

  // 드문 경우: 사람의 편집이 넘어가기 전에 어시스턴트의 편집이 섞였다 — 숨기지 않고 알린다
  host.userEdit(setParam(r.id, "value", "7k"));
  host.edit(setParam(r.id, "value", "8k"), { id: "x", label: "AI: x" });
  await settle();
  bodies.length = 0;
  script = ["ok"];
  await agent.send("check");
  ok(/mixed with your own edits/.test(userTexts(bodies[0]).at(-1)), "섞였으면 그렇다고 알리고 get_circuit 을 권한다");
  agent.dispose();
}

// ── 3. 단계 한계 · 깨진 인자 · 멈춤 ───────────────────────────────────
console.log("\n[한계] 단계 한계, 깨진 인자, 멈춤");
{
  const host = new TestHost(emptyProject("lim"));
  const agent = new Agent(host);
  settings.set({ maxSteps: 3 });
  bodies.length = 0;
  script = Array.from({ length: 10 }, () => [{ name: "get_circuit", args: {} }]);
  await agent.send("loop");
  ok(bodies.length === 3 && /Paused after 3/.test(agent.turns.at(-1)!.text), "한계에서 멈추고 알린다", String(bodies.length));
  settings.set({ maxSteps: 30 });

  script = [[{ name: "place_parts", args: null, raw: "{\"parts\": [" }], "fixed"];
  bodies.length = 0;
  await agent.send("broken");
  const res = bodies[1]?.messages.filter((m: any) => m.role === "tool").at(-1)?.content ?? "";
  ok(/not a JSON object/.test(res), "깨진 인자는 고치라는 결과가 된다", res.slice(0, 60));

  // 응답을 붙들고 있는 동안 멈춘다
  script = [];
  hold = Promise.resolve();
  const p = agent.send("will be stopped");
  await new Promise(r => setTimeout(r, 30));
  agent.stop();
  await p;
  hold = null;
  ok(agent.turns.at(-1)!.text === "Stopped." && !agent.busy, "멈추면 'Stopped.'");
  // 도구 호출 도중에 멈추면 그 호출에 결과가 채워진다
  script = [[{ name: "run_simulation", args: {} }, { name: "get_circuit", args: {} }]];
  host.engine = () => new Promise(() => { /* 끝나지 않는 시뮬레이션 */ });
  await host.simulate().catch(() => null);
  const q = agent.send("stop during a tool");
  await new Promise(r => setTimeout(r, 30));
  agent.stop();
  await q;
  const hist = (agent as unknown as { history: any[] }).history;
  const asked = hist.filter(m => m.role === "assistant").flatMap(m => m.tool_calls ?? []).map((c: any) => c.id);
  const answered = new Set(hist.filter(m => m.role === "tool").map(m => m.tool_call_id));
  ok(asked.every((id: string) => answered.has(id)), "결과 없는 도구 호출이 남지 않는다", `${asked.length}개 모두 답이 있다`);
  agent.dispose();
}

// ── 4. 대화 저장과 프로젝트 바꾸기 ────────────────────────────────────
console.log("\n[저장] 프로젝트마다 대화를 두고, 다른 프로젝트를 열면 그 대화로");
{
  const p1 = emptyProject("one");
  const host = new TestHost(p1);
  const a1 = new Agent(host);
  script = ["first answer"];
  await a1.send("remember me");
  await new Promise(r => setTimeout(r, 700));     // 저장은 잠깐 모았다 한다
  a1.dispose();
  const a2 = new Agent(host);
  await settle(); await new Promise(r => setTimeout(r, 20));
  ok(a2.turns.some(t => t.text === "remember me") && a2.hasHistory, "다시 만들면 대화가 이어진다", String(a2.turns.length));
  host.load(emptyProject("two"));
  await new Promise(r => setTimeout(r, 20));
  ok(a2.turns.length === 0, "다른 프로젝트를 열면 그 프로젝트의 (빈) 대화");
  host.load(p1);
  await new Promise(r => setTimeout(r, 20));
  ok(a2.turns.some(t => t.text === "first answer"), "돌아오면 앞의 대화가 다시");
  a2.dispose();
}

// ── 5. 긴 대화 요약 ───────────────────────────────────────────────────
console.log("\n[요약] 긴 대화는 앞부분을 요약한다");
{
  const host = new TestHost(emptyProject("long"));
  const agent = new Agent(host);
  const long = "x".repeat(32_000);
  for (let i = 0; i < 4; i++) { script = [`answer ${i} ${long}`]; await agent.send(`question ${i}`); }
  bodies.length = 0;
  script = ["SUMMARY: the user asked four questions.", "fresh answer"];
  await agent.send("question 5");
  ok(bodies[0]?.messages?.[0]?.content?.startsWith("You condense") && !bodies[0].tools, "요약 요청은 도구 없이 한 번짜리로", bodies[0]?.messages?.[0]?.content?.slice(0, 30));
  ok(/<conversation-summary>[\s\S]*SUMMARY/.test(JSON.stringify(bodies[1]?.messages ?? [])), "다음 요청은 요약을 안고 간다");
  ok(agent.size() < 90_000 && agent.turns.some(t => t.detail?.startsWith("SUMMARY")), "대화가 짧아지고, 요약을 펼쳐 볼 수 있다", String(agent.size()));
  agent.dispose();
}

// ── 6. 그림 ───────────────────────────────────────────────────────────
console.log("\n[그림] 도구가 그린 그림과 사람이 붙인 사진");
{
  const host = new TestHost(emptyProject("pics"));
  const agent = new Agent(host);
  bodies.length = 0;
  ok(!(await agent.send("look", undefined, [DOT])) && bodies.length === 0 && /cannot read pictures/.test(agent.turns.at(-1)!.text),
    "그림을 못 읽는 모델이면 사진을 보내지 않고 알린다");
  script = ["ok"];
  await agent.send("hi");
  ok(!bodies[0].tools.some((t: any) => t.function.name === "view_schematic"), "그림을 못 읽는 모델에게는 그림 도구가 없다");

  settings.set({ model: "test/vision" });
  script = [
    [{ name: "place_parts", args: { parts: [{ type: "r", at: [0, 0] }] } }],
    [{ name: "view_schematic", args: {} }],
    "Looks fine.",
  ];
  bodies.length = 0;
  await agent.send("draw a resistor and look at it");
  ok(bodies[0].tools.some((t: any) => t.function.name === "view_schematic"), "그림을 읽는 모델에게는 그림 도구가 있다");
  const m3 = bodies[2].messages;
  const at = m3.findIndex((m: any) => m.role === "tool" && /attached below/.test(m.content));
  const next = m3[at + 1];
  ok(at > 0 && next?.role === "user" && next.content.some((p: any) => p.type === "image_url" && p.image_url.url === DOT) && /^\[pictures\]/.test(next.content.at(-1).text),
    "도구 결과 뒤에 그림을 사용자 메시지 하나로 싣는다");
  ok(agent.usageLog.entries.at(-1)!.images === 1, "보낸 그림을 센다");
  ok(agent.turns.find(t => t.tool?.name === "view_schematic")?.tool?.pics?.[0] === DOT, "대화 창에서 모델이 본 그림을 볼 수 있다");
  script = ["noted"];
  bodies.length = 0;
  await agent.send("thanks");
  const flat = JSON.stringify(bodies[0].messages);
  ok(!flat.includes(DOT) && /no longer attached/.test(flat), "요청이 끝나면 도구의 그림은 대화에서 빠진다");

  script = ["I see a resistor."];
  bodies.length = 0;
  ok(await agent.send("what is this?", undefined, [DOT]), "그림을 읽는 모델이면 사진을 보낸다");
  const u = bodies[0].messages.filter((m: any) => m.role === "user").at(-1);
  ok(Array.isArray(u.content) && u.content[0].type === "image_url" && /<editor-context>[\s\S]*what is this\?$/.test(u.content.at(-1).text),
    "사진은 글 앞에, 상황 설명과 한 메시지로");
  script = ["still see it"];
  bodies.length = 0;
  await agent.send("and now?");
  ok(JSON.stringify(bodies[0].messages).includes(DOT), "붙인 사진은 이 탭의 대화 동안 남는다 (다음 요청도 본다)");
  ok(agent.turns.some(t => t.role === "user" && t.pics?.[0] === DOT && t.picCount === 1), "사용자 말풍선에 사진이 보인다");
  script = ["a picture only"];
  bodies.length = 0;
  ok(await agent.send("", undefined, [DOT]) && /sent only the picture/.test(JSON.stringify(bodies[0].messages.at(-1))), "글 없이 사진만 보내도 된다");
  ok(!(await agent.send("x", undefined, [DOT, DOT, DOT, DOT, DOT])), "한 번에 네 장까지");
  script = ["fine"];
  await agent.send("ok");
  // 요약해도 그림을 붙인 요청의 글 조각 앞에 요약이 붙는다
  script = ["SUMMARY: pictures."];
  ok(await agent.compact(), "요약한다");
  const first = (agent as unknown as { history: any[] }).history[0];
  ok(Array.isArray(first.content) && first.content[0].type === "image_url" && /^<conversation-summary>/.test(first.content.find((p: any) => p.type === "text").text),
    "그림을 붙인 요청이 맨 앞이면 요약은 그 글 조각에 붙는다");

  await new Promise(r => setTimeout(r, 700));
  const saved = await kvGet<any>("session:" + host.projectKey());
  const text = JSON.stringify(saved ?? null);
  ok(!!saved && !text.includes("data:image") && /not kept after the page closes/.test(text) && saved.turns.some((t: any) => t.picCount === 1),
    "저장한 대화에는 그림이 없다 (몇 장이었는지만)");
  agent.dispose();
  const again = new Agent(host);
  await settle(); await new Promise(r => setTimeout(r, 20));
  ok(again.turns.some(t => t.picCount === 1 && !t.pics), "다시 열면 사진 자리만 남는다");
  again.dispose();
  settings.set({ model: "test/model" });
}

// ── 7. 프로젝트 메모 ──────────────────────────────────────────────────
console.log("\n[메모] 대화가 바뀌어도 남는 프로젝트 메모");
{
  settings.set({ memo: true });
  const host = new TestHost(emptyProject("memo"));
  const agent = new Agent(host);
  await settle();
  script = ["Hello."];
  bodies.length = 0;
  await agent.send("hi");
  await agent.memoSettled();
  ok(bodies.length === 1 && !agent.memo, "회로를 바꾸지 않은 요청 뒤에는 메모를 고치지 않는다");

  script = [[{ name: "place_parts", args: { parts: [{ type: "r", at: [0, 0], params: { value: "4.7k" } }] } }], "Placed R1.", "Goal: a 4.7k load resistor.\nR1 = 4.7k placed."];
  bodies.length = 0;
  await agent.send("Place a 4.7k load");
  await agent.memoSettled();
  const mb = bodies[2];
  ok(bodies.length === 3 && /^You keep the project memo/.test(mb?.messages?.[0]?.content) && !mb.tools, "회로를 바꾼 요청 뒤에 메모를 한 번 고친다 (도구 없이)");
  const input = String(mb?.messages?.[1]?.content ?? "");
  ok(/<current-memo>\n\(empty\)/.test(input) && /USER: Place a 4\.7k load/.test(input) && /<circuit>[\s\S]*Project "memo"/.test(input) && !/<editor-context>/.test(input),
    "지금 메모 · 회로 · 이번 요청을 보낸다");
  ok(agent.memo?.text.startsWith("Goal: a 4.7k") === true && agent.memo?.by === "assistant", "메모가 생긴다");
  ok(agent.usageLog.entries.at(-1)?.kind === "memo", "사용 기록에 메모 줄이 남는다");

  script = ["ok"];
  bodies.length = 0;
  await agent.send("thanks");
  ok(!/Project memo/.test(userTexts(bodies[0]).at(-1)), "이미 실어 보낸 메모는 다시 싣지 않는다");
  agent.reset();
  script = ["ok"];
  bodies.length = 0;
  await agent.send("what are we doing?");
  ok(/Project memo \(your notes from earlier conversations\):\nGoal: a 4\.7k/.test(userTexts(bodies[0])[0]), "새 대화는 메모를 안고 시작한다");

  agent.setMemo("Goal: a 10k load.");
  script = ["ok"];
  bodies.length = 0;
  await agent.send("go on");
  ok(/Project memo \(updated, last edited by the user\):\nGoal: a 10k load\./.test(userTexts(bodies[0]).at(-1)), "사람이 고친 메모를 다음 요청에 알린다");

  // 모델이 메모를 쓰는 사이에 사람이 고친다
  let release: () => void = () => {};
  before = n => {
    if (String(bodies[n - 1]?.messages?.[0]?.content ?? "").startsWith("You keep the project memo")) return new Promise<void>(r => { release = r; });
  };
  script = [[{ name: "set_params", args: { changes: [{ ref: "R1", params: { value: "12k" } }] } }], "Set.", "Goal: 12k (from the assistant)."];
  await agent.send("make it 12k");
  await settle();
  ok(agent.memoBusy, "메모를 고치는 동안은 그렇다고 알린다");
  agent.setMemo("Goal: mine.");
  release();
  await agent.memoSettled();
  before = null;
  ok(agent.memo?.text === "Goal: mine." && agent.memo?.by === "user" && !agent.memoBusy, "고치는 사이에 사람이 고친 메모는 덮지 않는다");

  await new Promise(r => setTimeout(r, 30));
  ok((await kvGet<any>("memo:" + host.projectKey()))?.text === "Goal: mine.", "메모는 이 브라우저에 남는다");
  agent.dispose();
  const again = new Agent(host);
  await settle(); await new Promise(r => setTimeout(r, 20));
  ok(again.memo?.text === "Goal: mine.", "다시 열면 메모가 있다");

  settings.set({ memo: false });
  again.reset();
  script = [[{ name: "set_params", args: { changes: [{ ref: "R1", params: { value: "1k" } }] } }], "Set."];
  bodies.length = 0;
  await again.send("1k");
  await again.memoSettled();
  ok(bodies.length === 2 && !/Project memo/.test(JSON.stringify(bodies)), "메모를 끄면 싣지도 고치지도 않는다");
  again.dispose();
}

console.log(fail === 0 ? "\n어시스턴트 대화 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
