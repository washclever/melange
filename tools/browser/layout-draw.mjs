// 레이아웃을 처음부터 손으로 (npm run e2e:browser layout-draw — node tools/browser/layout-draw.mjs <url> <shot dir> [example])
//   예제를 열고 자동 배치 -> Layout 에서 W -> 래츠네스트를 따라 핀에서 핀으로 클릭 -> 열린 넷 0 · DRC/LVS 0 (자동 배선 없이)
import { createRequire } from "node:module";
import fs from "node:fs";
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
const te = () => P(() => { const t = window.__melangeLayout.app.editors.track.te; return { tool: t.tool, draw: !!t.draw, layer: t.layer, other: t.other, msg: t.msg, sel: t.sel.size, checked: t.checked ? t.checked.errors.length : null }; });
const at = async (p) => { const b = await page.locator(".wspane[data-ws=layout] canvas").first().boundingBox(); return { x: b.x + p.x, y: b.y + p.y }; };
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
  let st = await stats();
  ok(st && st.wires === 0 && st.open.length > 0, "배치만 하고 Layout — 트랙 0, 열린 넷이 있다 (자동 배선 없이 시작)", JSON.stringify(st));
  const tools = await page.locator(".wspane[data-ws=layout] .ws-tools").innerText();
  ok(/Select/.test(tools) && /Track/.test(tools) && /Via/.test(tools) && /Auto route/.test(tools), "도구 줄: Select · Track · Via · Auto route ▾", tools.replace(/\s+/g, " ").slice(0, 160));
  await page.screenshot({ path: `${shot}/track-0-placed.png` });
  await page.keyboard.press("w");
  await page.waitForTimeout(100);
  ok((await te()).tool === "track", "W — 트랙 도구");
  const open0 = st.open.length;
  let drawn = 0, tries = 0;
  for (let round = 0; round < 12 && tries < 30; round++) {
    const rats = await P(() => window.__layoutViews.layout.probe.ratsnest());
    if (!rats.length) break;
    let progressed = false;
    for (const r of rats) {
      tries++;
      const a = await at(r.a), b = await at(r.b);
      await page.mouse.move(a.x, a.y); await page.waitForTimeout(60);
      await page.mouse.click(a.x, a.y); await page.waitForTimeout(60);
      const t1 = await te();
      if (!t1.draw) { console.log("     could not start:", t1.msg); continue; }
      await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2); await page.waitForTimeout(40);
      await page.mouse.move(b.x, b.y); await page.waitForTimeout(80);
      await page.mouse.click(b.x, b.y); await page.waitForTimeout(80);
      let t2 = await te();
      if (t2.draw) {
        // 한 번에 못 이었다 (단락 · 경고) — Space 로 꺾는 쪽을 바꿔 한 번 더, 안 되면 되돌린다
        await page.keyboard.press(" "); await page.waitForTimeout(60);
        await page.mouse.move(b.x + 1, b.y); await page.waitForTimeout(60);
        await page.mouse.click(b.x + 1, b.y); await page.waitForTimeout(80);
        t2 = await te();
        if (t2.draw) { await page.keyboard.press("Escape"); await page.keyboard.press("Control+z"); console.log("     gave up:", r.net, t2.msg); continue; }
      }
      drawn++; progressed = true;
      break;
    }
    if (!progressed) break;
  }
  await page.waitForTimeout(600);
  st = await stats();
  const checked = (await te()).checked;
  ok(st.open.length < open0, "핀에서 핀으로 클릭해 넷을 이었다", `열린 넷 ${open0} -> ${st.open.length}, 트랙 ${st.wires} · 비아 ${st.vias}, 그은 줄 ${drawn}`);
  ok(st.open.length === 0, "다 이었다 (자동 배선 없이)", st.open.join(" "));
  ok(checked === 0, "DRC/LVS 0 (검사기)", `오류 ${checked}`);
  await page.screenshot({ path: `${shot}/track-1-drawn.png` });
  // 되돌리기 · 다시
  await page.keyboard.press("Control+z"); await page.waitForTimeout(300);
  const st2 = await stats();
  ok(st2.wires < st.wires || st2.vias < st.vias, "Ctrl+Z — 마지막 트랙을 되돌린다", `${st.wires}/${st.vias} -> ${st2.wires}/${st2.vias}`);
  await page.keyboard.press("Control+y"); await page.waitForTimeout(300);
  const st3 = await stats();
  ok(st3.wires === st.wires && st3.vias === st.vias, "Ctrl+Y — 다시");
  // 고르기 · 지우기
  await page.keyboard.press("s");
  const wire1 = await P(() => { const A = window.__melangeLayout.app, w = A.editors.track.art().wires[0]; const p = window.__layoutViews.layout.probe.at((w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2); return { p, net: w.net }; });
  const wp = await at(wire1.p);
  await page.mouse.click(wp.x, wp.y); await page.waitForTimeout(100);
  ok((await te()).sel >= 1, "고르기 — 트랙을 누르면 골라진다", `net ${wire1.net}`);
  await page.keyboard.press("Delete"); await page.waitForTimeout(400);
  const st4 = await stats();
  ok(st4.wires === st3.wires - 1 || st4.open.length > 0, "Delete — 지운다 (열린 넷이 다시 생긴다)", `open ${st4.open.join(" ")}`);
  await page.keyboard.press("Control+z"); await page.waitForTimeout(300);
  // 자동 배선은 고를 수 있다 — 메뉴
  await page.click(".wspane[data-ws=layout] .ws-tools [data-act=automenu]");
  const menu = await page.locator(".pop.menu").innerText();
  ok(/Route everything/.test(menu) && /Route the unfinished nets/.test(menu), "Auto route ▾ — 다 / 남은 넷만", menu.replace(/\s+/g, " ").slice(0, 160));
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
} catch (e) { fails++; console.log("  FAIL  ", e.message.split("\n")[0]); await page.screenshot({ path: `${shot}/track-error.png` }); }
ok(!errs.length, "페이지 오류 없음", errs.slice(0, 3).join(" | "));
await browser.close();
console.log(fails ? `FAIL ${fails}` : "ALL PASS");
process.exit(fails ? 1 : 0);
