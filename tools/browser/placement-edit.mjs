// 배치 편집 (npm run e2e:browser placement-edit): 블록 고르기 -> x 반전 -> 끌기 -> 정리 -> 되돌리기 · 다시 -> 내려받기
//   Layout: 자동 배선(고를 수 있다) 뒤 DRC/LVS 0, 셀과 트랙의 GDS
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire(import.meta.url)("playwright");
const [url, shot] = process.argv.slice(2);
fs.mkdirSync(shot, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console " + m.text()); });
let fails = 0;
const ok = (c, msg, d = "") => { if (!c) fails++; console.log(`  ${c ? "PASS" : "FAIL"}  ${msg}${d ? "   " + d : ""}`); };
const idle = async (f, ms = 60000) => { await page.waitForTimeout(150); await page.waitForFunction(f, null, { timeout: ms }); await page.waitForTimeout(150); };
const plIdle = () => idle(() => { const A = window.__melangeLayout.app; return !A.state.busy && !A.editors.placement.pl.busy; });
const PL = () => page.evaluate(() => {
  const P = window.__melangeLayout.app.editors.placement.pl;
  const i = P.model?.idx.get("X_MX5");
  return { sel: [...P.sel], dirty: P.dirty, hist: P.hist.length, fut: P.fut.length, busy: P.busy || window.__melangeLayout.app.state.busy,
           overlap: P.live?.overlap?.pairs, sx: P.sx?.[i], x: P.live?.rects?.[i]?.x };
});
async function canvasPoint(ws, p) {
  const box = await page.locator(`.wspane[data-ws=${ws}] canvas`).first().boundingBox();
  return { x: box.x + p.x, y: box.y + p.y };
}
try {
  await page.goto(url);
  await page.waitForSelector("#ws-switch .ws-name[data-ws=placement]");
  await page.click('#menus button:has-text("Examples")');
  await page.click("text=SKY130 5T OTA");
  await page.waitForTimeout(300);
  await page.click("#ws-switch .ws-name[data-ws=placement]");
  await page.waitForSelector(".wspane[data-ws=placement] .ws-tools [data-act=run]");
  await page.click(".wspane[data-ws=placement] .ws-tools [data-act=run]");
  await page.waitForFunction(() => window.__melangeLayout?.app?.state?.ours, null, { timeout: 120000 });
  await plIdle();

  // ---------------------------------------------------------------- Placement
  const r = await page.evaluate(() => window.__layoutViews.placement.probe.rectPx("X_MX5"));
  const c = await canvasPoint("placement", { x: r.cx, y: r.cy });
  await page.mouse.click(c.x, c.y);
  await page.waitForTimeout(150);
  let s = await PL();
  ok(s.sel.join() === "X_MX5", "블록을 누르면 고른다", s.sel.join());
  const sx0 = s.sx;
  await page.keyboard.press("x");
  await plIdle();
  s = await PL();
  ok(s.sx === -sx0, "X — x 반전 (회로도와 같은 키)", `${sx0} -> ${s.sx}`);
  const x0 = s.x;
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(c.x + k * 25, c.y);
  await page.mouse.up();
  await page.waitForTimeout(200);
  s = await PL();
  ok(s.dirty && s.x !== x0, "끌어 옮긴다 (정리 전)", `x ${Math.round(x0)} -> ${Math.round(s.x)} · 겹침 ${s.overlap}`);
  await page.screenshot({ path: `${shot}/e1-dragged.png` });
  await page.keyboard.press("Enter");
  await plIdle();
  s = await PL();
  ok(!s.dirty && s.overlap === 0, "Enter — 정리: 겹침 0, 격자에", `겹침 ${s.overlap}`);
  const h1 = s.hist;
  await page.keyboard.press("Control+z");
  await plIdle();
  s = await PL();
  ok(s.hist === h1 - 1 && s.fut === 1, "Ctrl+Z — 되돌리기", `이력 ${h1} -> ${s.hist}`);
  await page.keyboard.press("Control+y");
  await plIdle();
  s = await PL();
  ok(s.hist === h1 && s.fut === 0, "Ctrl+Y — 다시 실행");
  // 내려받기
  await page.click(".wspane[data-ws=placement] .ws-tools [data-act=downloads]");
  const items = await page.$$eval(".lyt-pop .mi[data-i]", (els) => els.map((e) => e.title));
  ok(items.length === 2 && /\.place\.json$/.test(items[1]) && /-cells\.gds$/.test(items[0]), "배치 뒤 내려받기 — 배치 JSON, 셀만 담은 GDS", items.join(" "));
  const [d1] = await Promise.all([page.waitForEvent("download"), page.click(`.lyt-pop .mi[data-i='${items.findIndex((f) => f.endsWith(".place.json"))}']`)]);
  const pj = JSON.parse(fs.readFileSync(await d1.path(), "utf8"));
  ok(pj.instances?.length === 3 && pj.grid?.join() === "430,420", "배치 JSON — 블록 셋, SKY130 격자", `${d1.suggestedFilename()} · grid ${pj.grid}`);

  // ---------------------------------------------------------------- Layout (트랙은 그대로 남는다 — PCB 처럼)
  await page.click("#ws-switch .ws-name[data-ws=layout]");
  await page.waitForSelector(".wspane[data-ws=layout] .ws-tools [data-act=automenu]:not([disabled])");
  await page.click(".wspane[data-ws=layout] .ws-tools [data-act=automenu]");
  await page.click(".pop.menu [data-act=autoall]");
  await page.waitForFunction(() => { const t = window.__melangeLayout?.app?.editors?.track; return t && t.art().wires.length && t.te.checked && t.te.checked.ver === t.art().ver && !window.__melangeLayout.app.state.busy; }, null, { timeout: 120000 });
  let t = await page.evaluate(() => window.__layoutViews.layout.probe.stats());
  ok(t.errors === 0 && t.open.length === 0, "편집한 배치를 자동 배선 — DRC/LVS 0", `오류 ${t.errors} · 열림 ${t.open.length}`);
  const hint = await page.$eval(".wspane[data-ws=layout] .ws-status", (e) => e.textContent);
  ok(!/\bM[1-6]\b/.test(hint), "상태 줄에 SKY130 층 이름", hint.replace(/\s+/g, " ").slice(0, 120));
  await page.click(".wspane[data-ws=layout] .ws-tools [data-act=downloads]");
  const li = await page.$$eval(".lyt-pop .mi[data-i]", (els) => els.map((e) => e.title));
  ok(li.some((f) => f.endsWith(".gds")) && li.length === 3, "배선 뒤 내려받기 — GDS · 배치 · 보고", li.join(" "));
  const gi = li.findIndex((f) => f.endsWith(".gds"));
  const [d2] = await Promise.all([page.waitForEvent("download"), page.click(`.lyt-pop .mi[data-i='${gi}']`)]);
  const g = fs.readFileSync(await d2.path());
  ok(g.length > 1000 && g[0] === 0 && g[1] === 6 && g[2] === 0 && g[3] === 2, "GDS 파일 (HEADER 레코드로 시작)", `${d2.suggestedFilename()} · ${(g.length / 1024).toFixed(1)} KB`);
} catch (e) {
  fails++;
  console.log("  FAIL  " + e.message.split("\n")[0]);
  await page.screenshot({ path: `${shot}/edit-fail.png` }).catch(() => {});
}
for (const e of errs.slice(0, 10)) console.log("   ", e.slice(0, 200));
await browser.close();
console.log(fails || errs.length ? `실패 ${fails}, 오류 ${errs.length}` : "통과");
process.exit(fails ? 1 : 0);
