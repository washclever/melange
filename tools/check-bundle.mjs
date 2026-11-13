/**
 * 번들 예산 검사. 빌드 뒤에 돈다.
 *
 * vite.config.ts 의 strip-inline-wasm 플러그인은 엔진 패키지의 모양에 기대고 있다.
 * 패키지가 올라가면서 모양이 바뀌면 base64 가 조용히 다시 들어올 수 있다.
 * wasm 로드 경로는 못 찾으면 빌드가 실패하지만, 파운드리 모델 쪽은 조용히 통과한다.
 * 그래서 산출물을 직접 재서 막는다.
 */
import { copyFile, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist", "assets");
const MARKER = "data:application/wasm;base64,";

const BUDGET = {
  workerRawKB: 400,      // 엔진 래퍼만 남아야 한다 (현재 78 kB)
  /*
   * dist/assets 의 JS 가운데 처음에 받는 것 (brotli). 편집기(WebGPU 렌더러 포함) + 시뮬레이션 워커 +
   * 스파이크 페이지 = 어시스턴트를 잇는 자리(간편 · 편집 모드, 어시스턴트 칸)를 넣은 뒤 104 kB (그 전 101 kB —
   * 잡음 · 전달 함수 해석과 계산기를 잇는 자리 · 예제의 계산기 줄, 그 전 96 kB, 부품 라이브러리 창 전에는 88 kB).
   * 계산기 · 어시스턴트 본체는 여기 들지 않는다 — 아래에서 따로 센다.
   * 이 예산이 막으려는 것은 몇 kB 가 아니라 엔진의 base64 wasm·파운드리 모델처럼 **MB 단위로**
   * 다시 새어 들어오는 것이다.
   */
  firstPaintBrotliKB: 108,
  /*
   * 계산기 청크 (brotli). 첫 화면에 싣지 않고 계산기 탭을 열거나 계산기 줄이 있는 프로젝트를 돌릴 때
   * 받는다 (src/calc/calc.ts). 함수 표 · 성능지표 본보기 · 스펙트럼 계산 · 그래프를 합쳐 지금 35 kB.
   */
  calcBrotliKB: 45,
  /*
   * 어시스턴트 청크 (brotli). 패널을 처음 열 때 받는다 (src/ai/assistant.ts) — OpenRouter 클라이언트 · 대화 ·
   * 도구 · 시스템 프롬프트(부품 표 포함) · 패널. 레이아웃 도구 여덟(src/ai/tools-layout.ts)과 프롬프트의 레이아웃 절을
   * 더해 지금 42 kB (그 전 39 kB). 레이아웃 본체는 여기 들지 않는다 — 도구는 레이아웃 덩어리를 그때 받는다.
   */
  aiBrotliKB: 46,
  /*
   * 레이아웃 덩어리 (brotli) — 앞단(ALIGN 을 JS 로 옮긴 컴파일러·셀 생성기) · 배치기 · 배선 파이프라인 · 편집기 셋.
   * Placement · Layout 을 처음 열 때 받는다 (src/layout/ui/shell.mjs). 배선기 wasm 은 따로 (배선을 누를 때).
   */
  layoutBrotliKB: 160,
};

let fail = 0;
const ok = (cond, msg, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

const files = await readdir(DIST);

// 1) JS 어디에도 base64 wasm 이 남아 있으면 안 된다
let inlineBytes = 0;
for (const f of files.filter(f => f.endsWith(".js"))) {
  const src = await readFile(join(DIST, f), "utf8");
  let i = 0;
  for (;;) {
    const at = src.indexOf(MARKER, i);
    if (at < 0) break;
    let j = at + MARKER.length;
    while (j < src.length && /[A-Za-z0-9+/=]/.test(src[j])) j++;
    inlineBytes += j - (at + MARKER.length);
    i = j;
  }
}
ok(inlineBytes === 0, "JS 에 인라인 base64 wasm 이 없다",
  inlineBytes ? `(${(inlineBytes / 1048576).toFixed(1)} MB 남음)` : "");

// 2) wasm 이 별도 에셋으로 나와 있고 유효하다
const wasmFile = files.find(f => f.startsWith("spice") && f.endsWith(".wasm"));
ok(!!wasmFile, "spice.wasm 이 별도 에셋으로 나온다", wasmFile ?? "");
if (wasmFile) {
  const b = await readFile(join(DIST, wasmFile));
  ok(b[0] === 0x00 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d,
    "wasm 매직 넘버가 맞다", `(${(b.length / 1048576).toFixed(2)} MB)`);
}

/*
 * 2b) SKY130 모델이 **별도 에셋**이어야 한다.
 *
 * JS 안에 다시 들어오면 2.2 MB 가 실행을 누르기도 전에 따라온다 — 저항 하나 그리는
 * 사람까지 받게 된다. 빌드는 멀쩡히 통과하므로 여기서 재서 막는다.
 */
const skyFiles = files.filter(f => f.startsWith("sky130-") && f.endsWith(".spice"));
ok(skyFiles.length === 4, "SKY130 모델이 소자별 에셋 4개로 나온다", `${skyFiles.length}개`);
/*
 * 파일은 **내용으로** 찾는다. 이름에서 해시를 떼어 내려 들면 Vite 의 해시 알파벳에
 * '-' 가 끼는 날 조용히 어긋난다 — 이 저장소가 엔진 모델을 찾을 때 쓰는 방식과 같다.
 */
const skyText = await Promise.all(skyFiles.map(f => readFile(join(DIST, f), "utf8")));
const withSubckt = (name) =>
  skyText.find(t => new RegExp(`\\.subckt\\s+${name}\\s`).test(t));
const nfet = withSubckt("sky130_fd_pr__nfet_01v8");
ok(!!nfet, "nFET 파일에 서브회로가 있다", nfet ? `(${(nfet.length / 1048576).toFixed(2)} MB)` : "(없음)");
/*
 * **쓰는 것만 읽게 쪼갠 것이 요점이다.** 한 파일에 다 들어가면 nFET 하나 쓰는 회로도
 * hvt 의 bin 198개를 같이 읽어 첫 실행이 몇 초씩 걸린다. 서로 섞이지 않았는지 본다.
 */
ok(!!nfet && !nfet.includes("sky130_fd_pr__pfet_01v8_hvt__model."),
  "nFET 파일에 hvt 모델이 섞이지 않았다");
const hvt = withSubckt("sky130_fd_pr__pfet_01v8_hvt");
ok(!!hvt && hvt.length > (nfet?.length ?? 0), "hvt 는 따로 떨어져 있다",
  hvt ? `(${(hvt.length / 1048576).toFixed(2)} MB)` : "(없음)");
ok(skyText.some(t => t.includes("Apache License")),
  "Apache 고지가 파일 안에 남아 있다");
let skyInJs = 0;
for (const f of files.filter(f => f.endsWith(".js"))) {
  const src = await readFile(join(DIST, f), "utf8");
  if (src.includes("sky130_fd_pr__nfet_01v8__model.")) skyInJs++;
}
ok(skyInJs === 0, "JS 에 SKY130 모델 본문이 없다", skyInJs ? `(${skyInJs}개 파일)` : "");

// 3) 워커 청크 크기
const workerFile = files.find(f => f.startsWith("sim.worker") && f.endsWith(".js"));
if (workerFile) {
  const kb = (await stat(join(DIST, workerFile))).size / 1024;
  ok(kb < BUDGET.workerRawKB, `워커 청크가 ${BUDGET.workerRawKB} kB 미만`, `(${kb.toFixed(0)} kB)`);
}

// 4) 실행 전에 받는 JS 합계 (brotli). 필요할 때 받는 계산기 · 어시스턴트 · 레이아웃 청크는 따로 센다
const isCalc = f => /^calc-[\w-]+\.js$/.test(f);
const isAi = f => /^assistant-[\w-]+\.js$/.test(f);
const isLayout = f => /^layout[-.][\w.-]+\.js$/.test(f);

/*
 * 4-0) 첫 화면 청크가 **정적으로** 가져오는 청크 (import … from "./x.js" 를 따라간다). 필요할 때 받는 덩어리
 * (계산기·어시스턴트·레이아웃)가 여기 끼면 이름은 따로여도 첫 화면에 다 받는다 — 아래 합계는 이름으로 빼고 세므로
 * 그것을 못 본다. 공유 모듈이 덩어리로 끌려 들어가면 그렇게 된다 (vite.config.ts).
 */
const staticImports = (src) => [...src.matchAll(/\bimport\s*(?:[\w$\s{},*]+?\s*from\s*)?["']\.\/([\w.-]+\.js)["']/g)].map((m) => m[1]);
const closure = async (roots) => {
  const out = new Set();
  const follow = async (f) => {
    if (out.has(f) || !files.includes(f)) return;
    out.add(f);
    for (const g of staticImports(await readFile(join(DIST, f), "utf8"))) await follow(g);
  };
  for (const r of roots) await follow(r);
  return out;
};
const indexChunk = files.find(f => /^index-[\w-]+\.js$/.test(f));
const eager = indexChunk ? await closure([indexChunk]) : new Set();
const eagerLazy = [...eager].filter(f => isCalc(f) || isAi(f) || isLayout(f));
ok(!!indexChunk && eagerLazy.length === 0, "첫 화면 청크가 필요할 때 받는 덩어리를 정적으로 가져오지 않는다",
  eagerLazy.length ? `(${eagerLazy.join(" ")})` : `(정적으로 ${eager.size}개: ${[...eager].join(" ")})`);

// 필요할 때 받는 덩어리만 가져오는 공유 청크 (어시스턴트와 레이아웃 예제가 같이 쓰는 회로도 잇기 같은 것) — 첫 화면이 아니다
const lazyRoots = files.filter(f => f.endsWith(".js") && (isCalc(f) || isAi(f) || isLayout(f)));
const lazyOnly = [...await closure(lazyRoots)].filter(f => !eager.has(f) && !lazyRoots.includes(f));
let firstPaint = 0;
for (const f of files.filter(f => f.endsWith(".js") && !isCalc(f) && !isAi(f) && !isLayout(f) && !lazyOnly.includes(f))) {
  firstPaint += brotliCompressSync(await readFile(join(DIST, f))).length;
}
const fpKB = firstPaint / 1024;
ok(fpKB < BUDGET.firstPaintBrotliKB, `첫 화면 JS 가 brotli ${BUDGET.firstPaintBrotliKB} kB 미만`,
  `(${fpKB.toFixed(0)} kB${lazyOnly.length ? `; 덩어리만 쓰는 공유 청크 ${lazyOnly.join(" ")} 는 뺐다` : ""})`);

/*
 * 4-1) 계산기는 **따로 떨어진 청크**여야 한다. 누가 app.ts 에서 계산기 모듈을 값으로 import 하면
 * 번들러가 조용히 첫 화면 청크에 합쳐 버린다 — 타입만 가져와야 한다. 청크가 없으면 그렇게 된 것이다.
 */
const calcFile = files.find(isCalc);
ok(!!calcFile, "계산기가 따로 받는 청크로 나온다", calcFile ?? "(없음 — 첫 화면 청크에 합쳐졌다)");
if (calcFile) {
  const kb = brotliCompressSync(await readFile(join(DIST, calcFile))).length / 1024;
  ok(kb < BUDGET.calcBrotliKB, `계산기 청크가 brotli ${BUDGET.calcBrotliKB} kB 미만`, `(${kb.toFixed(0)} kB)`);
  // 첫 화면 청크에 계산기 본문이 새어 들지 않았는지: 성능지표 본보기의 글이 거기 있으면 안 된다
  const index = files.find(f => /^index-[\w-]+\.js$/.test(f));
  const first = index ? await readFile(join(DIST, index), "utf8") : "";
  ok(!first.includes("Transit frequency fT"), "첫 화면 청크에 계산기 본문이 없다");
  // 단위 표(src/calc/units.ts)도. app.ts 가 첫 화면에서 쓰는 format.ts 가 units.ts 를 가져오면 딸려 온다
  ok(!first.includes("V²·s"), "첫 화면 청크에 단위 표가 없다");
}

/*
 * 4-2) 어시스턴트도 **따로 떨어진 청크**여야 한다. app.ts 는 그 타입만 가져온다 (src/ai/host.ts) — 값을 가져오면
 * 번들러가 OpenRouter 클라이언트와 시스템 프롬프트까지 첫 화면에 합친다. 키를 안 쓰는 사람까지 받게 된다.
 */
const aiFile = files.find(isAi);
ok(!!aiFile, "어시스턴트가 따로 받는 청크로 나온다", aiFile ?? "(없음 — 첫 화면 청크에 합쳐졌다)");
if (aiFile) {
  const kb = brotliCompressSync(await readFile(join(DIST, aiFile))).length / 1024;
  ok(kb < BUDGET.aiBrotliKB, `어시스턴트 청크가 brotli ${BUDGET.aiBrotliKB} kB 미만`, `(${kb.toFixed(0)} kB)`);
  const index = files.find(f => /^index-[\w-]+\.js$/.test(f));
  const first = index ? await readFile(join(DIST, index), "utf8") : "";
  // 시스템 프롬프트의 첫 문장과 OpenRouter 의 채팅 주소 — 둘 다 어시스턴트 본체에만 있어야 한다
  ok(!first.includes("You are the assistant built into Melange"), "첫 화면 청크에 시스템 프롬프트가 없다");
  ok(!first.includes("/chat/completions"), "첫 화면 청크에 OpenRouter 클라이언트가 없다");
  // 계산기와 어시스턴트가 서로를 품지 않는다 (어시스턴트는 계산기를 앱을 거쳐 받는다)
  const ai = await readFile(join(DIST, aiFile), "utf8");
  ok(!ai.includes("Transit frequency fT"), "어시스턴트 청크에 계산기 본문이 없다");
  // 레이아웃 도구는 레이아웃 덩어리를 그때 받는다 — 어시스턴트 청크가 그것을 품거나 정적으로 가져오면 안 된다
  ok(!ai.includes(".subckt NMOS_4T") && !staticImports(ai).some(isLayout), "어시스턴트 청크에 레이아웃 본체가 없다");
}

/*
 * 4-3) 레이아웃도 **따로 떨어진 청크**여야 한다. app.ts 는 전환 단추(src/layout/ui/switch.ts)만 값으로 가져온다 —
 * shell.mjs 를 값으로 가져오면 앞단·배치기·편집기가 첫 화면에 합쳐진다. 배선기 wasm 은 별도 에셋이다.
 */
// 레이아웃 코드가 든 청크들 (vite.config.ts 의 chunkFileNames 가 layout- 으로 이름 짓는다) — 워커와 새 창의 입구는 뺀다
const layoutFiles = files.filter(f => /^layout-[\w-]+\.js$/.test(f) && !/^layout-window-/.test(f));
const layoutFile = layoutFiles[0];
ok(!!layoutFile, "레이아웃이 따로 받는 청크로 나온다", layoutFiles.length ? `${layoutFiles.length}개` : "(없음 — 첫 화면 청크에 합쳐졌다)");
if (layoutFile) {
  let kb = 0;
  for (const f of layoutFiles) kb += brotliCompressSync(await readFile(join(DIST, f))).length / 1024;
  ok(kb < BUDGET.layoutBrotliKB, `레이아웃 청크들이 합쳐 brotli ${BUDGET.layoutBrotliKB} kB 미만`, `(${kb.toFixed(0)} kB, ${layoutFiles.length}개)`);
  const index = files.find(f => /^index-[\w-]+\.js$/.test(f));
  const first = index ? await readFile(join(DIST, index), "utf8") : "";
  // ALIGN 원시 소자 틀과 배선 파이프라인의 문구 — 레이아웃 덩어리에만 있어야 한다
  ok(!first.includes(".subckt NMOS_4T") && !first.includes("Unmatched generator for this instance"), "첫 화면 청크에 앞단 본문이 없다");
  ok(first.includes("ws-switch"), "첫 화면에 편집기 전환 단추가 있다");
}
const workers = files.filter(f => /^layout-(front|place|route)\.worker-[\w-]+\.js$/.test(f));
ok(workers.length === 3, "레이아웃 워커 셋 (앞단·배치·배선)", workers.join(" "));
ok(files.some(f => f.startsWith("alignroute") && f.endsWith(".wasm")), "배선기 wasm 이 별도 에셋으로 나온다");

/*
 * 5) 제3자 라이선스 표시를 결과물에 같이 둔다.
 *
 * dist 에는 ngspice 를 빌드한 spice.wasm 이 그대로 들어간다. BSD 계열은 바이너리로
 * 재배포할 때 저작권 표시와 보증 부인을 "함께 배포하는 자료" 에 넣으라고 요구하므로,
 * 정적 호스팅에 올라가는 폴더 안에 있어야 한다.
 */
const NOTICE = "THIRD-PARTY.md";
await copyFile(join(ROOT, NOTICE), join(ROOT, "dist", NOTICE));
ok(true, "제3자 라이선스 표시를 dist 에 넣었다", NOTICE);

console.log(fail === 0 ? "\n번들 예산 통과" : `\n${fail}개 초과`);
process.exit(fail === 0 ? 0 : 1);
