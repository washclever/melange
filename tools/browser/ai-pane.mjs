// 어시스턴트 칸이 모든 보기에서 맨 오른쪽에 있는가 (npm run e2e:browser ai-pane)
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire(import.meta.url)("playwright");
const [url, shot] = process.argv.slice(2);
fs.mkdirSync(shot, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror " + e.message));
let fails = 0;
const ok = (c, msg, d = "") => { if (!c) fails++; console.log(`  ${c ? "PASS" : "FAIL"}  ${msg}${d ? "   " + d : ""}`); };
const box = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), shown: !!e.offsetParent || getComputedStyle(e).display !== "none" }; });
const rightmost = async (label) => {
  const ai = await box("#ai");
  const others = await page.evaluate(() => [...document.querySelectorAll("#toolbar, #mid, #bottom, #lyt-host")].filter((e) => e.offsetParent && getComputedStyle(e).display !== "none")
    .map((e) => ({ id: e.id, r: Math.round(e.getBoundingClientRect().right) })));
  const maxOther = Math.max(...others.map((o) => o.r));
  ok(ai.r >= 1440 - 16 && ai.l > maxOther && ai.t < 90 && ai.b > 860, `${label}: 어시스턴트 칸이 맨 오른쪽, 세로로 다`, `ai ${ai.l}-${ai.r} × ${ai.t}-${ai.b} · 나머지 오른쪽 끝 ${maxOther} (${others.map((o) => o.id).join(" ")})`);
};
try {
  await page.goto(url);
  await page.waitForSelector("#ws-switch .ws-name[data-ws=layout]");
  const order = await page.$$eval("#menubar > *", (els) => els.map((e) => e.id || e.className));
  ok(order.slice(-3).join() === "ws-switch,t-ai,t-theme", "메뉴 막대 끝: 전환 · AI · 테마", order.slice(-3).join(" "));
  ok(!(await page.$("#toolbar #t-ai")), "도구 막대에는 어시스턴트 단추가 없다 (AI 단추 하나)");
  await page.click("#t-ai");
  await page.waitForTimeout(400);
  ok(await page.$eval("#t-ai", (b) => b.classList.contains("on")), "AI 단추를 누르면 켜진다");
  await rightmost("Circuit");
  await page.screenshot({ path: `${shot}/a1-circuit.png` });
  await page.click("#ws-switch .ws-name[data-ws=placement]");
  await page.waitForTimeout(500);
  await rightmost("Placement 하나");
  await page.screenshot({ path: `${shot}/a2-placement.png` });
  await page.click('#ws-switch .ws-caret[data-pair="1"]');
  await page.click(".lyt-menu button[data-act=cols]");
  await page.waitForTimeout(500);
  await rightmost("Placement | Layout");
  await page.click('#ws-switch .ws-caret[data-pair="0"]');
  await page.click(".lyt-menu button[data-act=all]");
  await page.waitForTimeout(500);
  await rightmost("셋 다");
  await page.screenshot({ path: `${shot}/a3-all.png` });
  await page.click('#ws-switch .ws-caret[data-pair="0"]');
  await page.click(".lyt-menu button[data-act=rows]");
  await page.waitForTimeout(500);
  await rightmost("Circuit 위 · 편집기 아래");
  await page.screenshot({ path: `${shot}/a4-rows.png` });
  await page.click("#t-ai");
  await page.waitForTimeout(300);
  const hidden = await page.$eval("#ai", (e) => getComputedStyle(e).display === "none");
  const host = await box("#lyt-host");
  ok(hidden && host.r >= 1440 - 16, "AI 단추로 끄면 칸이 빠지고 편집기가 넓어진다", `lyt-host 오른쪽 ${host.r}`);
  await page.keyboard.press("Shift+A").catch(() => {});
} catch (e) {
  fails++;
  console.log("  FAIL  " + e.message.split("\n")[0]);
  await page.screenshot({ path: `${shot}/aipane-fail.png` }).catch(() => {});
}
for (const e of errs.slice(0, 10)) console.log("   ", e.slice(0, 200));
await browser.close();
console.log(fails || errs.length ? `실패 ${fails}, 오류 ${errs.length}` : "통과");
process.exit(fails ? 1 : 0);
