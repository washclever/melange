// 트랙 고치기 (npm run e2e:browser layout-edit — node tools/browser/layout-edit.mjs <url> <shot dir> [example])
//   PCB 편집기처럼: 자동 배선한 판에서 고르기 도구로 토막을 끌어 옆 트랙으로 (붙은 이웃 토막이 따라 늘고 준다), 비아(꺾는 점)를
//   끌고, 화살표로 한 트랙, 속성 칸에서 층을 바꾼다 (붙은 곳의 비아를 그 층까지 다시 쌓는다). 그때마다 열린 넷 0 · 검사기 DRC/LVS 0,
//   Ctrl+Z 한 번이면 처음과 같다. 단락이 될 자리로는 놓아도 고치지 않는다.
import { createRequire } from "node:module";
import fs from "node:fs";
import { metal, via } from "../../src/layout/art/rules.mjs";
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
const artNow = () => P(() => { const a = window.__melangeLayout.app.editors.track.art(); return { wires: a.wires, vias: a.vias, ver: a.ver }; });
const keyOf = (a) => JSON.stringify([[...a.wires].sort((p, q) => p.id - q.id), [...a.vias].sort((p, q) => p.id - q.id)]);
const editNow = () => P(() => { const t = window.__melangeLayout.app.editors.track.te; return t.edit ? { shorts: t.edit.judge.shorts.length, warns: t.edit.judge.warns.length, del: t.edit.e.del.length, followed: t.edit.e.followed, jogs: t.edit.e.jogs } : null; });
const checked = () => page.waitForFunction(() => { const t = window.__melangeLayout.app.editors.track; return t.te.checked && t.te.checked.ver === t.art().ver && !window.__melangeLayout.app.state.busy; }, null, { timeout: 60000 });
const at = async (x, y) => {
  const p = await P(([x, y]) => window.__layoutViews.layout.probe.at(x, y), [x, y]);
  const b = await page.locator(".wspane[data-ws=layout] canvas").first().boundingBox();
  return { x: b.x + p.x, y: b.y + p.y };
};
/** 누르고 끌어 놓기 직전까지 — 미리 보기를 돌려준다 (놓기는 부르는 쪽이) */
async function dragTo(from, to) {
  const a = await at(from.x, from.y), b = await at(to.x, to.y);
  await page.mouse.move(a.x, a.y); await page.waitForTimeout(60);
  await page.mouse.down(); await page.waitForTimeout(60);
  for (let k = 1; k <= 6; k++) { await page.mouse.move(a.x + (b.x - a.x) * k / 6, a.y + (b.y - a.y) * k / 6); await page.waitForTimeout(25); }
  await page.waitForTimeout(120);
  return editNow();
}
const cancel = async () => { await page.keyboard.press("Escape"); await page.mouse.up(); await page.waitForTimeout(80); };

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
  await page.waitForSelector(".wspane[data-ws=layout] .ws-tools [data-act=automenu]:not([disabled])");
  await page.click(".wspane[data-ws=layout] .ws-tools [data-act=automenu]");
  await page.click(".pop.menu [data-act=autoall]");
  await page.waitForFunction(() => { const t = window.__melangeLayout?.app?.editors?.track; return t && t.art().wires.length && !window.__melangeLayout.app.state.busy; }, null, { timeout: 300000 });
  await checked();
  let st = await stats();
  ok(st.open.length === 0 && st.errors === 0, "자동 배선한 판 — 고칠 것", `트랙 ${st.wires} · 비아 ${st.vias} · DRC/LVS ${st.errors}`);
  await page.keyboard.press("s");

  // ------------------------------------------------ 토막을 끌어 옆 트랙으로 (긴 것부터, 단락 · 경고가 없는 첫 자리)
  let a0 = await artNow(), moved = null;
  const byLen = [...a0.wires].filter((w) => metal(w.layer)).sort((p, q) => (Math.abs(q.x1 - q.x0) + Math.abs(q.y1 - q.y0)) - (Math.abs(p.x1 - p.x0) + Math.abs(p.y1 - p.y0)));
  for (const w of byLen.slice(0, 30)) {
    const vert = metal(w.layer).dir === "v", pitch = metal(w.layer).pitch;
    const mid = { x: (w.x0 + w.x1) / 2, y: (w.y0 + w.y1) / 2 };
    for (const k of [1, -1, 2]) {
      const to = vert ? { x: mid.x + k * pitch, y: mid.y } : { x: mid.x, y: mid.y + k * pitch };
      const ed = await dragTo(mid, to);
      if (!ed || ed.shorts || ed.warns) { await cancel(); continue; }
      if (!moved) await page.screenshot({ path: `${shot}/edit-dragging.png` });
      await page.mouse.up(); await page.waitForTimeout(150);
      moved = { w, k, ed, vert, pitch };
      break;
    }
    if (moved) break;
  }
  ok(!!moved, "토막을 끌면 미리 보기 — 단락 · 간격 경고가 없는 자리를 찾는다", moved ? `${moved.w.net} ${moved.w.layer} ${moved.k > 0 ? "+" : ""}${moved.k} 트랙 · 따라감 ${moved.ed.followed} · jog ${moved.ed.jogs}` : "없음");
  if (moved) {
    await checked();
    st = await stats();
    const a1 = await artNow(), w1 = a1.wires.find((q) => q.id === moved.w.id);
    const shift = moved.vert ? w1.x0 - moved.w.x0 : w1.y0 - moved.w.y0;
    ok(Math.abs(shift - moved.k * moved.pitch) <= 1 && st.open.length === 0 && st.errors === 0,
       "놓으면 옆 트랙으로 — 붙은 이웃이 따라 늘고 준다, 열린 넷 0 · DRC/LVS 0",
       `${shift} nm · 열린 넷 ${st.open.length} · DRC/LVS ${st.errors} · ${(await P(() => window.__melangeLayout.app.editors.track.te.msg)).slice(0, 90)}`);
    const selKept = await P((id) => window.__melangeLayout.app.editors.track.te.sel.has(id), moved.w.id);
    ok(selKept, "옮긴 토막은 고른 채로 남는다");
    await page.screenshot({ path: `${shot}/edit-moved.png` });
    await page.keyboard.press("Control+z"); await page.waitForTimeout(200);
    ok(keyOf(await artNow()) === keyOf(a0), "Ctrl+Z 한 번 — 처음과 같다");
    await page.keyboard.press("Control+y"); await page.waitForTimeout(200);
    ok(keyOf(await artNow()) === keyOf(a1), "Ctrl+Y — 다시 옮긴 판");
    await page.keyboard.press("Control+z"); await page.waitForTimeout(200);
  }

  // ------------------------------------------------ 단락이 될 자리로는 놓아도 그대로
  a0 = await artNow();
  let refused = false;
  for (const w of byLen.slice(0, 30)) {
    const vert = metal(w.layer).dir === "v", pitch = metal(w.layer).pitch, mid = { x: (w.x0 + w.x1) / 2, y: (w.y0 + w.y1) / 2 };
    for (const k of [1, -1, 2, -2, 3]) {
      const ed = await dragTo(mid, vert ? { x: mid.x + k * pitch, y: mid.y } : { x: mid.x, y: mid.y + k * pitch });
      if (!ed || !ed.shorts) { await cancel(); continue; }
      await page.mouse.up(); await page.waitForTimeout(150);
      refused = true;
      break;
    }
    if (refused) break;
  }
  const msg = await P(() => window.__melangeLayout.app.editors.track.te.msg);
  ok(refused && keyOf(await artNow()) === keyOf(a0) && /short/.test(msg), "다른 넷에 닿는 자리 — 빨강, 놓아도 고치지 않는다", msg.slice(0, 90));

  // ------------------------------------------------ 비아(꺾는 점)를 끌기
  a0 = await artNow();
  let corner = null;
  const corners = a0.vias.filter((v) => { const V = via(v.layer); return [V.lo, V.hi].every((L) => a0.wires.some((w) => w.net === v.net && w.layer === L && (metal(L).dir === "v" ? Math.abs(w.x0 - v.x) <= 1 : Math.abs(w.y0 - v.y) <= 1))); });
  for (const v of corners.slice(0, 20)) {
    const V = via(v.layer), Lv = [V.lo, V.hi].find((L) => metal(L).dir === "v"), Lh = [V.lo, V.hi].find((L) => metal(L).dir === "h");
    for (const [kx, ky] of [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [0, 1]]) {
      const ed = await dragTo(v, { x: v.x + kx * metal(Lv).pitch, y: v.y + ky * metal(Lh).pitch });
      if (!ed || ed.shorts || ed.warns) { await cancel(); continue; }
      await page.mouse.up(); await page.waitForTimeout(150);
      corner = { v, ed };
      break;
    }
    if (corner) break;
  }
  if (corner) {
    await checked();
    st = await stats();
    ok(st.open.length === 0 && st.errors === 0, "비아(꺾는 점)를 끌면 만나는 두 줄이 같이 — 열린 넷 0 · DRC/LVS 0",
       `${corner.v.net} ${corner.v.layer} · 따라감 ${corner.ed.followed} · jog ${corner.ed.jogs} · DRC/LVS ${st.errors}`);
    await page.screenshot({ path: `${shot}/edit-corner.png` });
    await page.keyboard.press("Control+z"); await page.waitForTimeout(200);
  } else ok(false, "비아(꺾는 점)를 끌기", `꺾는 점 ${corners.length}개 중 옮길 자리가 없다`);

  // ------------------------------------------------ 화살표로 한 트랙
  a0 = await artNow();
  let nudged = null;
  for (const w of byLen.slice(0, 30)) {
    const vert = metal(w.layer).dir === "v", m = await at((w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2);
    await page.mouse.click(m.x, m.y); await page.waitForTimeout(80);
    if (!(await P((id) => window.__melangeLayout.app.editors.track.te.sel.has(id), w.id))) continue;
    const ver = (await artNow()).ver;
    await page.keyboard.press(vert ? "ArrowRight" : "ArrowUp"); await page.waitForTimeout(150);
    const a1 = await artNow();
    if (a1.ver === ver) continue;
    const w1 = a1.wires.find((q) => q.id === w.id);
    nudged = { w, shift: vert ? w1.x0 - w.x0 : w1.y0 - w.y0, pitch: metal(w.layer).pitch };
    break;
  }
  if (nudged) {
    await checked();
    st = await stats();
    ok(nudged.shift === nudged.pitch && st.open.length === 0, "화살표 — 고른 토막을 한 트랙 (가로 층은 ↑ ↓, 세로 층은 ← →)", `${nudged.w.net} ${nudged.w.layer} ${nudged.shift} nm · 열린 넷 ${st.open.length} · DRC/LVS ${st.errors}`);
    await page.keyboard.press("Control+z"); await page.waitForTimeout(200);
  } else ok(false, "화살표 — 한 트랙", "옮길 수 있는 토막이 없다");

  // ------------------------------------------------ 층 바꾸기 (속성 칸) — 비아를 그 층까지 다시 쌓는다
  a0 = await artNow();
  let relayered = null;
  for (const w of byLen.slice(0, 40)) {
    const m = await at((w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2);
    await page.mouse.click(m.x, m.y); await page.waitForTimeout(100);
    if (!(await P((id) => window.__melangeLayout.app.editors.track.te.sel.has(id), w.id))) continue;
    const chips = await page.$$eval(".wspane[data-ws=layout] [data-act=relayer]", (bs) => bs.map((b) => b.dataset.layer));
    for (const L2 of chips) {
      const ver = (await artNow()).ver;
      await page.click(`.wspane[data-ws=layout] #lyProps [data-act=relayer][data-layer=${L2}]`); await page.waitForTimeout(200);
      const a1 = await artNow();
      if (a1.ver === ver) continue;
      await checked();
      st = await stats();
      if (st.open.length || st.errors) { await page.keyboard.press("Control+z"); await page.waitForTimeout(200); continue; }
      relayered = { w, L2, vias: a1.vias.length - a0.vias.length, st };
      break;
    }
    if (relayered) break;
  }
  ok(!!relayered, "층 바꾸기 — 같은 방향의 층으로, 붙은 곳의 비아를 다시 쌓아 열린 넷 0 · DRC/LVS 0",
     relayered ? `${relayered.w.net} ${relayered.w.layer} -> ${relayered.L2} · 비아 ${relayered.vias >= 0 ? "+" : ""}${relayered.vias}` : "없음");
  if (relayered) { await page.screenshot({ path: `${shot}/edit-layer.png` }); await page.keyboard.press("Control+z"); await page.waitForTimeout(200); }
  ok(keyOf(await artNow()) === keyOf(a0), "되돌리면 자동 배선한 판 그대로");
} catch (e) { fails++; console.log("  FAIL  ", e.message.split("\n")[0]); await page.screenshot({ path: `${shot}/edit-error.png` }); }
ok(!errs.length, "페이지 오류 없음", errs.slice(0, 3).join(" | "));
await browser.close();
console.log(fails ? `FAIL ${fails}` : "ALL PASS");
process.exit(fails ? 1 : 0);
