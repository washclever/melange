// 화면 시험 — 진짜 브라우저(Playwright 의 Chromium)로 앱을 연다.  npm run e2e:browser [이름 ...]
//
//   개발 서버(vite)를 빈 포트에 띄우고 시험을 하나씩 돌린 뒤 끈다. BASE_URL 을 주면 그 주소를 쓴다 (빌드한 판: npm run build 뒤
//   npx vite preview 를 띄우고 BASE_URL=http://localhost:4173/). 스크린숏은 BROWSER_SHOTS (기본: 임시 폴더) 에 남는다.
//   Playwright 가 있어야 한다 — 없으면: npm i -D playwright && npx playwright install chromium
//
//   layout-draw     배치만 하고 Layout 에서 처음부터 손으로 — 핀에서 핀으로 클릭해 열린 넷 0 · DRC/LVS 0, 되돌리기 · 지우기
//   layout-auto     자동 배선은 고를 수 있다 — 몇 넷을 손으로, 나머지만 자동 (그린 넷은 그대로), 전부 자동, GDS
//   layout-tools    도구가 사람의 버릇대로 — 핀이 아닌 곳의 까닭이 커서 옆에, 누른 채 끌어 긋기, 트랙 도구로 끌면 옮기기 · 누르면 새 트랙
//   layout-edit     트랙 고치기 — 토막을 끌어 옆 트랙으로 (이웃이 따라 는다), 비아 끌기, 화살표, 층 바꾸기, 단락 자리는 거절, 되돌리기
//   smoke           회로도 · 배치 · 레이아웃 전환과 보기 (나란히 · 위아래 · 셋 · 새 창), 선택 연동, 테마
//   placement-edit  배치 편집의 키 (X · Y 뒤집기, 끌기, 정리, 되돌리기), 내려받기
//   ai-layout       어시스턴트가 배치 · 배선을 끝까지 (OpenRouter 를 대본대로 답하는 가짜로 받는다 — 키가 필요 없다)
//   ai-pane         어시스턴트 칸이 어느 보기에서나 맨 오른쪽
//   phone           좁은 화면
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, "..", "..");
const ALL = ["layout-draw", "layout-auto", "layout-edit", "layout-tools", "smoke", "placement-edit", "ai-layout", "ai-pane", "phone"];
const only = process.argv.slice(2);
const tests = only.length ? ALL.filter((t) => only.includes(t)) : ALL;
const shots = process.env.BROWSER_SHOTS ?? join(tmpdir(), "melange-browser-shots");

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

let server = null, url = process.env.BASE_URL;
if (!url) {
  const port = await freePort();
  server = spawn("npx", ["vite", "--port", String(port), "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  url = `http://localhost:${port}/`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).ok) break; } catch { /* 아직 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}
console.log(`browser tests on ${url} (screenshots: ${shots})`);
const results = [];
for (const t of tests) {
  mkdirSync(join(shots, t), { recursive: true });
  console.log(`\n=== ${t}`);
  const code = await new Promise((res) => {
    const p = spawn(process.execPath, [join(here, `${t}.mjs`), url, join(shots, t)], { cwd: root, stdio: "inherit" });
    p.on("exit", (c) => res(c ?? 1));
  });
  results.push([t, code]);
}
server?.kill();
console.log("\n" + results.map(([t, c]) => `${c === 0 ? "PASS" : "FAIL"}  ${t}`).join("\n"));
const bad = results.filter(([, c]) => c !== 0).length;
console.log(bad ? `\nFAIL ${bad}` : "\nALL PASS");
process.exit(bad ? 1 : 0);
