// 회로도 · 배치 · 레이아웃 편집기 화면 (npm run e2e:browser smoke)
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
import fs from "node:fs";
const [url, shot] = process.argv.slice(2);
fs.mkdirSync(shot, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console " + m.text()); });
let fails = 0;
const ok = (c, msg, d = "") => { if (!c) fails++; console.log(`  ${c ? "PASS" : "FAIL"}  ${msg}${d ? "   " + d : ""}`); };
const state = () => page.evaluate(() => {
  const a = window.__melangeLayout?.app?.state;
  const t = window.__melangeLayout?.app?.editors?.track, st = t?.stats();
  return a ? { key: a.key, busy: a.busy, ours: !!a.ours, wires: st?.wires ?? 0, open: st?.open.length ?? null, nerr: st?.errors ?? null,
               checked: !!t?.te.checked && t.te.checked.ver === t.art().ver, status: a.status, notes: a.notes } : null;
});
try {
  await page.goto(url);
  await page.waitForSelector("#ws-switch .ws-name[data-ws=placement]");
  ok(await page.$eval("#ws-switch", (e) => e.nextElementSibling?.id === "t-ai" && e.nextElementSibling.nextElementSibling?.id === "t-theme"), "메뉴 막대 끝: 전환 · AI · 테마");
  await page.click('#menus button:has-text("Examples")');
  await page.click('text=SKY130 5T OTA');
  await page.waitForTimeout(300);
  await page.click('#ws-switch .ws-name[data-ws=placement]');
  await page.waitForSelector('.wspane[data-ws=placement] .ws-tools [data-act=run]', { timeout: 20000 });
  ok(await page.evaluate(() => document.documentElement.classList.contains("lyt-solo")), "Placement 하나만 보인다");
  ok(!(await page.$('.wspane[data-ws=placement] .ws-tools [data-act=tab]')), "Primitives 탭이 없다 (chip 의 회로도 보기)");
  await page.screenshot({ path: `${shot}/1-placement-empty.png` });
  // 회로도 읽기 -> 블록 목록
  await page.click('.wspane[data-ws=placement] [data-act=rebuild]');
  await page.waitForFunction(() => window.__melangeLayout?.app?.state?.blob && !window.__melangeLayout.app.state.busy, null, { timeout: 20000 });
  await page.waitForTimeout(200);
  const kinds = await page.$$eval('.wspane[data-ws=placement] tr[data-block]', (els) => els.map((e) => e.textContent));
  ok(kinds.length === 3 && kinds.some((t) => /current mirror/.test(t)) && kinds.some((t) => /differential pair/.test(t)), "회로도를 읽으면 블록 목록 (종류·부품)", kinds.join(" | ").slice(0, 160));
  const src = await page.$eval('.wspane[data-ws=placement]', (e) => e.textContent);
  ok(/Transistors\s*5 in 3 blocks/.test(src) && /even finger count/.test(src), "From the schematic — 트랜지스터 수·바뀐 것", "");
  await page.screenshot({ path: `${shot}/1b-blocks.png` });
  await page.click('.wspane[data-ws=placement] .ws-tools [data-act=run]');
  await page.waitForFunction(() => window.__melangeLayout?.app?.state?.ours, null, { timeout: 120000 });
  const s1 = await state();
  ok(s1.ours, "자동 배치", s1.status.replace(/<[^>]+>/g, ""));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shot}/2-placement.png` });
  await page.click('#ws-switch .ws-name[data-ws=layout]');
  await page.waitForSelector('.wspane[data-ws=layout] .ws-tools [data-act=automenu]:not([disabled])', { timeout: 20000 });
  await page.click('.wspane[data-ws=layout] .ws-tools [data-act=automenu]');
  await page.click('.pop.menu [data-act=autoall]');
  await page.waitForFunction(() => { const t = window.__melangeLayout?.app?.editors?.track; return t && t.art().wires.length && t.te.checked && t.te.checked.ver === t.art().ver && !window.__melangeLayout.app.state.busy; }, null, { timeout: 120000 });
  const s2 = await state();
  ok(s2.wires > 0 && s2.open === 0 && s2.nerr === 0, "자동 배선 (고를 수 있다) — 트랙이 되고 DRC/LVS 0", `트랙 ${s2.wires} · 열림 ${s2.open} · 오류 ${s2.nerr} · ${s2.status.replace(/<[^>]+>/g, "")}`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shot}/3-layout.png` });
  // 삼각형 메뉴: Placement | Layout 좌우
  await page.click('#ws-switch .ws-caret[data-pair="1"]');
  await page.click('.lyt-menu button[data-act=cols]');
  await page.waitForTimeout(400);
  const two = await page.$$eval('.wspane:not([hidden])', (els) => els.map((e) => e.dataset.ws));
  ok(two.join() === "placement,layout", "Placement | Layout 좌우", two.join());
  await page.screenshot({ path: `${shot}/4-pair.png` });
  // 셋 다
  await page.click('#ws-switch .ws-caret[data-pair="0"]');
  await page.click('.lyt-menu button[data-act=all]');
  await page.waitForTimeout(500);
  ok(await page.evaluate(() => document.documentElement.classList.contains("lyt-cols")), "셋 다 — 회로 옆에 편집기 둘");
  await page.screenshot({ path: `${shot}/5-all.png` });
  // 선택 연동: Placement 에서 블록을 고르면 회로도의 부품이 골라진다
  const sel = await page.evaluate(() => {
    const L = window.__melangeLayout; const top = L.app.state.blob.topology.modules.at(-1);
    const b = top.instances.find((i) => i.instance_name.includes("MX3"))?.instance_name;
    L.app.select({ kind: "block", names: [b] }, "placement");
    return b;
  });
  await page.waitForTimeout(200);
  const props = await page.$eval("#propbody", (e) => e.textContent);
  ok(/^2 selected/.test(props.trim()) && /nFET/.test(props), "블록을 고르면 회로도에서 그 부품이 골라진다 (X3, X4: nFET 둘)", `${sel} -> ${props.slice(0, 60)}`);
  // 새 창
  const [pop] = await Promise.all([ctx.waitForEvent("page"), (async () => {
    await page.click('#ws-switch .ws-caret[data-pair="1"]');
    await page.click('.lyt-menu button[data-act="pop:layout"]');
  })()]);
  await pop.waitForSelector('.ws[data-ws=layout] .ws-tools', { timeout: 20000 });
  ok(true, "Layout 을 새 창으로 — 같은 배선이 보인다");
  await pop.waitForTimeout(500);
  await pop.screenshot({ path: `${shot}/6-popup.png` });
  const out = await page.$eval('#ws-switch .ws-name[data-ws=layout]', (e) => e.classList.contains("out"));
  ok(out, "전환 단추에 새 창 표시");
  // 단축키: Placement 가 키를 받을 때 회로도의 W(배선) 가 켜지지 않는다
  await page.click('#ws-switch .ws-name[data-ws=placement]');
  await page.waitForTimeout(200);
  await page.click('.wspane[data-ws=placement] canvas', { position: { x: 30, y: 30 } });
  await page.keyboard.press("KeyW");
  const wireOn = await page.$eval("#t-wire", (e) => e.classList.contains("on"));
  ok(!wireOn, "레이아웃 편집기가 키를 받는 동안 회로도 단축키는 쉰다");
  const hangul = await page.evaluate(() => [...document.querySelectorAll("#lyt-host, #ws-switch")].map((e) => e.innerText + " " + [...e.querySelectorAll("[title]")].map((q) => q.title).join(" ")).join(" ").match(/[\uac00-\ud7a3][^<>]{0,30}/g));
  ok(!hangul, "편집기 화면에 한글이 없다 (melange 는 영어)", hangul ? hangul.slice(0, 5).join(" | ") : "");
  // 어두운 테마 — Placement | Layout
  await page.click('#ws-switch .ws-caret[data-pair="1"]');
  await page.click('.lyt-menu button[data-act=cols]');
  await page.click("#t-theme");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shot}/7-dark.png` });
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector(".wspane[data-ws=placement] .ws-tools")).backgroundColor);
  ok(!/255, 255, 255/.test(bg), "어두운 테마에서 편집기 도구 줄도 어둡다", bg);
  await page.click("#t-theme");
  await page.click('#ws-switch .ws-name[data-ws=circuit]');
  ok(await page.evaluate(() => !document.documentElement.classList.contains("lyt-on")), "Circuit 으로 돌아온다");
} catch (e) {
  fails++;
  console.log("  FAIL  " + e.message.split("\n")[0]);
  await page.screenshot({ path: `${shot}/fail.png` }).catch(() => {});
}
for (const e of errs.slice(0, 10)) console.log("   ", e.slice(0, 200));
await browser.close();
console.log(fails || errs.length ? `실패 ${fails}, 오류 ${errs.length}` : "통과");
process.exit(fails ? 1 : 0);
