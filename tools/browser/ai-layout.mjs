// 어시스턴트가 배치 · 배선을 끝까지 (npm run e2e:browser ai-layout, 또는 node tools/browser/ai-layout.mjs <url> <shot dir>)
//   OpenRouter 를 가짜로 받는다 (대본대로 도구를 부르는 모델). 진짜 앱 · 진짜 배치기 · 진짜 배선기가 돈다.
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire(import.meta.url)("playwright");
const [url, shot] = process.argv.slice(2);
fs.mkdirSync(shot, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  localStorage.setItem("melange.openrouter-key", "test-key");
  localStorage.setItem("melange.ai", JSON.stringify({ model: "test/model", maxSteps: 30, remember: true }));
});
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror " + e.message));
page.on("crash", () => console.log("    [page] CRASHED", new Date().toISOString()));
page.on("close", () => console.log("    [page] closed", new Date().toISOString()));
page.on("console", (m) => { if (m.type() === "error") errs.push("console " + m.text()); else if (process.env.DEBUG && /assistant|layout|routing|placement/i.test(m.text())) console.log("    [page]", m.type(), m.text().slice(0, 200)); });
let fails = 0;
const ok = (c, msg, d = "") => { if (!c) fails++; console.log(`  ${c ? "PASS" : "FAIL"}  ${msg}${d ? "   " + d : ""}`); };

const script = [
  [{ name: "layout_status", args: {} }],
  [{ name: "layout_place", args: { effort: "fast" } }],
  [{ name: "layout_edit_placement", args: { edits: [{ block: "X_MX5", flip: "x" }] } }],
  [{ name: "layout_route", args: {} }],
  [{ name: "layout_fix_routing", args: { action: "delete_net", net: "OUT" } }],
  [{ name: "layout_fix_routing", args: { action: "connect_net", net: "OUT" } }],
  [{ name: "layout_show", args: { view: "placement+layout", net: "OUT" } }],
  "Placed and routed in SKY130: no DRC/LVS errors.",
];
const bodies = [];
await ctx.route("https://openrouter.ai/api/v1/**", async (route) => {
  const u = route.request().url();
  if (u.endsWith("/models")) {
    return route.fulfill({ json: { data: [{ id: "test/model", name: "Test model", context_length: 200000, supported_parameters: ["tools"],
      architecture: { input_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } }] } });
  }
  if (u.includes("/chat/completions")) {
    const body = JSON.parse(route.request().postData() ?? "{}");
    bodies.push(body);
    // 메모 갱신 같은 다른 부르기(도구 없음)는 짧은 글로
    const step = body.tools ? (script.shift() ?? "Done.") : "memo";
    if (process.env.DEBUG) console.log("    [model] at", new Date().toISOString());
    if (process.env.DEBUG) { const last = body.messages?.at(-1); console.log(`    [model] #${bodies.length} ${body.tools ? "agent" : "side"} <- ${last?.role} ${String(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content)).slice(0, 160)}`); }
    const delta = typeof step === "string" ? { content: step }
      : { tool_calls: step.map((c, index) => ({ index, id: `c${bodies.length}_${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
    const chunk = { choices: [{ delta, finish_reason: typeof step === "string" ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n` });
  }
  return route.fulfill({ json: { data: {} } });
});
/** 그 도구의 결과 전부 (차례대로) — 마지막 요청에 대화가 다 실린다 */
const toolResults = (name) => {
  const b = bodies.at(-1), calls = new Map(), out = [];
  for (const m of b?.messages ?? []) {
    for (const c of m.tool_calls ?? []) calls.set(c.id, c.function.name);
    if (m.role === "tool" && calls.get(m.tool_call_id) === name) { try { out.push(JSON.parse(typeof m.content === "string" ? m.content : m.content?.[0]?.text ?? "null")); } catch { out.push(m.content); } }
  }
  return out;
};
const toolResult = (name) => {
  for (const b of bodies) {
    const calls = new Map();
    for (const m of b.messages ?? []) {
      for (const c of m.tool_calls ?? []) calls.set(c.id, c.function.name);
      if (m.role === "tool" && calls.get(m.tool_call_id) === name) { try { return JSON.parse(typeof m.content === "string" ? m.content : m.content?.[0]?.text ?? "null"); } catch { return m.content; } }
    }
  }
  return null;
};
try {
  await page.goto(url);
  await page.waitForSelector("#t-ai");
  await page.click('#menus button:has-text("Examples")');
  await page.click("text=SKY130 5T OTA");
  await page.waitForTimeout(300);
  await page.click("#t-ai");
  await page.waitForSelector("#ai textarea.ai-input", { timeout: 20000 });
  await page.fill("#ai textarea.ai-input", "Lay this circuit out in SKY130 — place and route it.");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("#ai .ai-msg")].some((e) => /Placed and routed in SKY130/.test(e.textContent)), null, { timeout: Number(process.env.WAIT ?? 240000) });
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => { const A = window.__melangeLayout?.app, t = A?.editors?.track; if (!A || !t) return null; t.checkNow(); const q = t.stats(); return { ours: !!A.state.ours, wires: q.wires, nerr: q.errors, opens: q.open.length, edits: A.state.ours?.edited ?? 0 }; });
  ok(st?.ours && st.wires > 0 && st.nerr === 0 && st.opens === 0, "어시스턴트가 배치하고 배선했다 — DRC/LVS 0, 열림 0", JSON.stringify(st));
  ok(st?.edits >= 1, "배치를 손으로 고쳤다 (X_MX5 x 반전)", `편집 ${st?.edits}`);
  const s0 = toolResult("layout_status");
  ok(s0?.schematic && s0.placement === null, "layout_status — 배치 전 상태를 읽는다", JSON.stringify(s0?.schematic ?? s0).slice(0, 120));
  const p = toolResult("layout_place");
  ok(p?.placement?.blocks?.length === 3 && p.placement.overlapping_pairs === 0, "layout_place — 블록 셋, 겹침 0", `${p?.placement?.size_nm?.join(" x ")} nm · HPWL ${p?.placement?.hpwl_nm}`);
  const ed = toolResult("layout_edit_placement");
  ok(ed?.done?.some((d) => /X_MX5 flipped in x/.test(d)) && ed.settled !== false, "layout_edit_placement — 뒤집고 정리", (ed?.done ?? [ed?.error]).join(" · "));
  const r = toolResult("layout_route");
  ok(r?.routing?.drc_lvs_errors === 0 && r.routing.open_nets.length === 0, "layout_route — DRC/LVS 0 을 모델에게 알린다", JSON.stringify(r?.routing ?? r).slice(0, 140));
  const fixes = toolResults("layout_fix_routing");
  ok(fixes[0]?.routing?.open_nets?.includes("OUT") && fixes[0].did?.deleted > 0, "delete_net — OUT 의 트랙을 지우면 OUT 이 열린다", JSON.stringify(fixes[0]?.did ?? fixes[0]));
  ok(fixes[1]?.did?.tracks_drawn > 0 && fixes[1].routing.open_nets.length === 0 && fixes[1].routing.drc_lvs_errors === 0, "connect_net — 사람처럼 L 로 다시 그어 DRC/LVS 0", JSON.stringify(fixes[1]?.did ?? fixes[1]));
  const views = await page.evaluate(() => Object.entries(window.__melangeLayout.view()).filter(([, v]) => v.shown).map(([k]) => k).join(","));
  ok(views === "placement,layout", "layout_show — Placement | Layout 을 보인다", views);
  const net = await page.evaluate(() => window.__melangeLayout.app.editors.track.te.net);
  ok(net === "OUT", "layout_show — OUT 넷 강조", String(net));
  const ctxLine = bodies.at(-1)?.messages?.find((m) => m.role === "user" && /editor-context/.test(typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  ok(!!ctxLine, "상황 설명이 실린다");
  const tools = (bodies.find((b) => b.tools)?.tools ?? []).map((t) => t.function.name).filter((n) => n.startsWith("layout_"));
  ok(tools.length === 7, "모델이 레이아웃 도구 일곱을 본다 (그림 도구는 그림을 읽는 모델만)", tools.join(" "));
  await page.screenshot({ path: `${shot}/ai-done.png` });
} catch (e) {
  fails++;
  console.log("  FAIL  " + e.message.split("\n")[0]);
  console.log("    state:", JSON.stringify(await page.evaluate(() => { const A = window.__melangeLayout?.app; if (!A) return null;
    return { busy: A.state.busy, pl: A.editors.placement.pl.busy, ours: !!A.state.ours, tracks: A.editors.track.stats(), status: A.state.status.replace(/<[^>]+>/g, ""), views: window.__melangeLayout.view() }; }).catch((x) => String(x))));
  await page.screenshot({ path: `${shot}/ai-fail.png` }).catch(() => {});
}
for (const e of errs.slice(0, 10)) console.log("   ", e.slice(0, 220));
await browser.close();
console.log(fails ? `실패 ${fails}, 오류 ${errs.length}` : errs.length ? `통과 (콘솔 오류 ${errs.length})` : "통과");
process.exit(fails ? 1 : 0);
