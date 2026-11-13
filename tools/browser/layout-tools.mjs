// 레이아웃 도구가 사람의 버릇대로 되는지 (npm run e2e:browser layout-tools — node tools/browser/layout-tools.mjs <url> <shot dir> [example])
//   - 트랙 도구로 핀이 아닌 곳을 누르면 왜 안 되는지가 커서 옆에 뜬다
//   - 누른 채 끌어 떼도 그어진다 (클릭 · 클릭 말고)
//   - 트랙 도구 그대로 그린 트랙을 끌면 옮겨지고, 그냥 누르면 거기서 새 트랙이 시작된다
import { createRequire } from "node:module";
import fs from "node:fs";
import { metal } from "../../src/layout/art/rules.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");
const [url, shot, example = "SKY130 5T OTA"] = process.argv.slice(2);
fs.mkdirSync(shot, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console " + m.text()); });
let fails = 0;
const ok = (c, msg, d = "") => { if (!c) fails++; console.log(`  ${c ? "PASS" : "FAIL"}  ${msg}${d ? "   " + d : ""}`); };
const P = (fn, arg) => page.evaluate(fn, arg);
const stats = () => P(() => window.__layoutViews.layout.probe.stats());
const te = () => P(() => { const t = window.__melangeLayout.app.editors.track.te; return { tool: t.tool, draw: !!t.draw, msg: t.msg, flash: t.flash?.text ?? null, edit: t.edit ? { shorts: t.edit.judge.shorts.length, warns: t.edit.judge.warns.length } : null }; });
const canvas = async () => page.locator(".wspane[data-ws=layout] canvas").first().boundingBox();
const at = async (x, y) => { const p = await P(([x, y]) => window.__layoutViews.layout.probe.at(x, y), [x, y]); const b = await canvas(); return { x: b.x + p.x, y: b.y + p.y }; };
const px = async (p) => { const b = await canvas(); return { x: b.x + p.x, y: b.y + p.y }; };
async function press(a, b, steps = 8) {
  await page.mouse.move(a.x, a.y); await page.waitForTimeout(60);
  await page.mouse.down(); await page.waitForTimeout(40);
  for (let k = 1; k <= steps; k++) { await page.mouse.move(a.x + (b.x - a.x) * k / steps, a.y + (b.y - a.y) * k / steps); await page.waitForTimeout(25); }
  await page.waitForTimeout(100);
}
try {
  await page.goto(url);
  await page.waitForSelector("#ws-switch .ws-name[data-ws=layout]");
  await page.click('#menus button:has-text("Examples")');
  await page.click(`text=${example}`);
  await page.waitForTimeout(400);
  await page.click("#ws-switch .ws-name[data-ws=placement]");
  await page.waitForSelector(".wspane[data-ws=placement] .ws-tools [data-act=run]");
  await page.click(".wspane[data-ws=placement] .ws-tools [data-act=run]");
  await page.waitForFunction(() => window.__melangeLayout?.app?.state?.ours && !window.__melangeLayout.app.state.busy, null, { timeout: 180000 });
  await page.click("#ws-switch .ws-name[data-ws=layout]");
  await page.waitForSelector(".wspane[data-ws=layout] .ws-tools [data-act=tool][data-tool=track]");
  await page.waitForTimeout(300);
  await page.keyboard.press("w");

  // ------------------------------------------------ 핀이 아닌 곳 — 까닭이 커서 옆에
  const b0 = await canvas();
  await page.mouse.click(b0.x + 12, b0.y + b0.height - 40); await page.waitForTimeout(120);
  let t = await te();
  ok(!t.draw && /Start on a pin/.test(t.flash ?? ""), "핀이 아닌 곳을 누르면 — 안 된 까닭이 커서 옆에 뜬다", t.flash ?? t.msg);
  await page.screenshot({ path: `${shot}/tools-flash.png` });

  // ------------------------------------------------ 누른 채 끌어 떼기로 긋는다
  const open0 = (await stats()).open.length;
  let joined = 0;
  for (const r of await P(() => window.__layoutViews.layout.probe.ratsnest())) {
    const a = await px(r.a), b = await px(r.b);
    await press(a, b, 10);
    await page.mouse.up(); await page.waitForTimeout(150);
    t = await te();
    if (t.draw) { await page.keyboard.press("Escape"); await page.keyboard.press("Control+z"); await page.waitForTimeout(80); continue; }
    if ((await stats()).open.length < open0) { joined++; break; }
  }
  const st1 = await stats();
  ok(joined > 0 && st1.open.length < open0, "누른 채 끌어 떼도 그어진다 — 핀에서 핀으로", `열린 넷 ${open0} -> ${st1.open.length} · 트랙 ${st1.wires}`);

  // ------------------------------------------------ 자동 배선 뒤, 트랙 도구 그대로 끌면 옮긴다
  await page.click(".wspane[data-ws=layout] .ws-tools [data-act=automenu]");
  await page.click(".pop.menu [data-act=autoall]");
  await page.waitForFunction(() => { const t = window.__melangeLayout.app.editors.track; return t.art().wires.length && t.te.checked && t.te.checked.ver === t.art().ver && !window.__melangeLayout.app.state.busy; }, null, { timeout: 180000 });
  await page.keyboard.press("w"); await page.waitForTimeout(80);
  if ((await te()).tool !== "track") { await page.keyboard.press("w"); await page.waitForTimeout(80); }
  const wires = await P(() => window.__melangeLayout.app.editors.track.art().wires.map((w) => ({ ...w })));
  const longest = [...wires].sort((p, q) => (Math.abs(q.x1 - q.x0) + Math.abs(q.y1 - q.y0)) - (Math.abs(p.x1 - p.x0) + Math.abs(p.y1 - p.y0)));
  let moved = null;
  for (const w of longest.slice(0, 20)) {
    const vert = metal(w.layer).dir === "v", pitch = metal(w.layer).pitch, mid = { x: (w.x0 + w.x1) / 2, y: (w.y0 + w.y1) / 2 };
    const to = vert ? { x: mid.x + pitch, y: mid.y } : { x: mid.x, y: mid.y + pitch };
    const a = await at(mid.x, mid.y), b = await at(to.x, to.y);
    await press(a, b, 8);
    const ed = (await te()).edit;
    if (!ed || ed.shorts || ed.warns) { await page.keyboard.press("Escape"); await page.mouse.up(); await page.waitForTimeout(80); continue; }
    await page.mouse.up(); await page.waitForTimeout(200);
    const w1 = await P((id) => window.__melangeLayout.app.editors.track.art().wires.find((q) => q.id === id), w.id);
    moved = { w, shift: vert ? w1.x0 - w.x0 : w1.y0 - w.y0, pitch };
    break;
  }
  t = await te();
  ok(!!moved && moved.shift === moved.pitch && t.tool === "track" && !t.draw, "트랙 도구 그대로 그린 트랙을 끌면 옮겨진다 (새 트랙이 시작되지 않는다)",
     moved ? `${moved.w.net} ${moved.w.layer} ${moved.shift} nm · 도구 ${t.tool}` : "옮길 수 있는 트랙이 없다");
  if (moved) { await page.keyboard.press("Control+z"); await page.waitForTimeout(200); }

  // ------------------------------------------------ 트랙 도구로 그린 트랙을 그냥 누르면 거기서 새 트랙
  const w = longest[0], m = await at((w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2);
  await page.mouse.click(m.x, m.y); await page.waitForTimeout(150);
  t = await te();
  ok(t.draw, "트랙 도구로 그린 트랙을 그냥 누르면 거기서 새 트랙이 시작된다", t.msg.slice(0, 80));
  await page.keyboard.press("Escape"); await page.waitForTimeout(80);
} catch (e) { fails++; console.log("  FAIL  ", e.message.split("\n")[0]); await page.screenshot({ path: `${shot}/tools-error.png` }); }
ok(!errs.length, "페이지 오류 없음", errs.slice(0, 3).join(" | "));
await browser.close();
console.log(fails ? `FAIL ${fails}` : "ALL PASS");
process.exit(fails ? 1 : 0);
