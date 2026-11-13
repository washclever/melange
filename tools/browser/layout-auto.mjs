// 자동 배선은 고를 수 있다 (npm run e2e:browser layout-auto — node tools/browser/layout-auto.mjs <url> <shot dir> [example] [hand-drawn lines])
//   예제를 열고 자동 배치 -> 래츠네스트 몇 줄을 손으로 -> Auto route ▾ "Route the unfinished nets" (그린 넷은 그대로) -> "Route everything"
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire(import.meta.url)("playwright");
const [url, shot, example = "SKY130 5T OTA", nHand = "2"] = process.argv.slice(2);
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
const te = () => P(() => { const t = window.__melangeLayout.app.editors.track.te; return { draw: !!t.draw, msg: t.msg, checked: t.checked ? t.checked.errors.length : null, ver: t.checked?.ver }; });
const netWires = (nets) => P((ns) => JSON.stringify(window.__melangeLayout.app.editors.track.art().wires.filter((w) => ns.includes(w.net)).map((w) => [w.net, w.layer, w.x0, w.y0, w.x1, w.y1]).sort()), nets);
const idle = async () => { await page.waitForTimeout(200); await page.waitForFunction(() => !window.__melangeLayout.app.state.busy, null, { timeout: 300000 }); await page.waitForTimeout(400); };
const at = async (p) => { const b = await page.locator(".wspane[data-ws=layout] canvas").first().boundingBox(); return { x: b.x + p.x, y: b.y + p.y }; };
try {
  await page.goto(url);
  await page.waitForSelector("#ws-switch .ws-name[data-ws=layout]");
  await page.click('#menus button:has-text("Examples")');
  await page.locator(".menu > button").filter({ has: page.locator("span", { hasText: new RegExp(`^${example.replace(/[()]/g, "\\$&")}$`) }) }).first().click();
  await page.waitForTimeout(600);
  await page.click("#ws-switch .ws-name[data-ws=placement]");
  await page.waitForSelector(".wspane[data-ws=placement] .ws-tools [data-act=run]");
  await page.click(".wspane[data-ws=placement] .ws-tools [data-act=run]");
  await page.waitForFunction(() => window.__melangeLayout?.app?.state?.ours && !window.__melangeLayout.app.state.busy, null, { timeout: 300000 });
  await page.click("#ws-switch .ws-name[data-ws=layout]");
  await page.waitForSelector(".wspane[data-ws=layout] .ws-tools [data-act=tool][data-tool=track]");
  await page.waitForTimeout(300);
  const open0 = (await stats()).open.length;
  await page.keyboard.press("w");
  let hand = 0;
  for (const r of await P(() => window.__layoutViews.layout.probe.ratsnest())) {
    if (hand >= Number(nHand)) break;
    const a = await at(r.a), b = await at(r.b);
    await page.mouse.move(a.x, a.y); await page.waitForTimeout(50); await page.mouse.click(a.x, a.y); await page.waitForTimeout(50);
    if (!(await te()).draw) continue;
    await page.mouse.move(b.x, b.y); await page.waitForTimeout(80); await page.mouse.click(b.x, b.y); await page.waitForTimeout(80);
    if ((await te()).draw) { await page.keyboard.press("Escape"); await page.keyboard.press("Control+z"); continue; }
    hand++;
    // 그은 줄이 래츠네스트를 바꿨다 — 다시 읽는다
  }
  await page.waitForTimeout(500);
  const kept = await P(() => [...window.__melangeLayout.app.editors.track.finishedNets()]);
  const before = await netWires(kept);
  ok(hand > 0 && kept.length > 0, "손으로 그은 넷", `${hand}줄 · 다 이은 넷 ${kept.join(" ")} · 열린 넷 ${open0} -> ${(await stats()).open.length}`);
  await page.click(".wspane[data-ws=layout] .ws-tools [data-act=automenu]");
  await page.click('.pop.menu [data-act=autorest]');
  await idle();
  await page.waitForFunction(() => { const t = window.__melangeLayout.app.editors.track; return t.te.checked && t.te.checked.ver === t.art().ver; }, null, { timeout: 60000 });
  let st = await stats();
  ok(st.open.length === 0 && st.errors === 0, "Route the unfinished nets — 다 이어지고 DRC/LVS 0", `open ${st.open.length} · DRC/LVS ${st.errors} · 트랙 ${st.wires} · 비아 ${st.vias}`);
  ok(before === (await netWires(kept)), "손으로 그은 넷은 한 점도 안 바뀌었다", kept.join(" "));
  await page.screenshot({ path: `${shot}/auto-rest.png` });
  await page.keyboard.press("Control+z"); await idle();
  st = await stats();
  ok(st.open.length > 0 && before === (await netWires(kept)), "Ctrl+Z — 자동 배선 한 판을 통째로 되돌린다 (손으로 그은 것은 남는다)", `open ${st.open.length}`);
  await page.click(".wspane[data-ws=layout] .ws-tools [data-act=automenu]");
  await page.click('.pop.menu [data-act=autoall]');
  await idle();
  await page.waitForFunction(() => { const t = window.__melangeLayout.app.editors.track; return t.te.checked && t.te.checked.ver === t.art().ver; }, null, { timeout: 60000 });
  st = await stats();
  ok(st.open.length === 0 && st.errors === 0, "Route everything — DRC/LVS 0", `open ${st.open.length} · DRC/LVS ${st.errors} · 트랙 ${st.wires}`);
  // 자동 배선의 트랙도 손으로 고친다 — 하나 지우면 열린다
  await page.keyboard.press("s");
  const w0 = await P(() => { const w = window.__melangeLayout.app.editors.track.art().wires.find((q) => !q.net.startsWith("V")) ?? window.__melangeLayout.app.editors.track.art().wires[0]; return { p: window.__layoutViews.layout.probe.at((w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2), net: w.net }; });
  const wp = await at(w0.p);
  const n0 = st.wires + st.vias;
  await page.mouse.click(wp.x, wp.y); await page.waitForTimeout(100);
  const nsel = await P(() => window.__melangeLayout.app.editors.track.te.sel.size);
  await page.keyboard.press("Delete"); await page.waitForTimeout(500);
  st = await stats();
  ok(nsel >= 1 && st.wires + st.vias === n0 - nsel, "자동 배선의 트랙도 고르고 지운다", `${w0.net}: ${nsel} 골라 지움 -> 열린 넷 ${st.open.join(" ") || "없음 (겹친 도형이 아직 잇는다)"}`);
  // 다운로드에 GDS
  const dl = await P(() => window.__melangeLayout.app.downloads().map((x) => x.file));
  ok(dl.some((f) => f.endsWith(".gds")), "Download — 그린 판의 GDS", dl.join(" "));
} catch (e) { fails++; console.log("  FAIL  ", e.message.split("\n")[0]); await page.screenshot({ path: `${shot}/auto-error.png` }); }
ok(!errs.length, "페이지 오류 없음", errs.slice(0, 3).join(" | "));
await browser.close();
console.log(fails ? `FAIL ${fails}` : "ALL PASS");
process.exit(fails ? 1 : 0);
