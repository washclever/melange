import { defineConfig, type Plugin } from "vite";

const MARKER = "data:application/wasm;base64,";

/**
 * eecircuit-engine 번들에서 base64 wasm 두 벌(각 7.8 MB)을 걷어낸다.
 *
 * 그 패키지는 wasm 을 .mjs 안에 data: URL 로 넣어 둔다. 한 벌은 브라우저 경로,
 * 한 벌은 `process.versions.node` 안에 있는 node 전용 경로다. 브라우저 빌드에서는
 * node 쪽이 절대 실행되지 않는데도 7.8 MB 가 그대로 실려 나간다.
 * 둘 다 삼항 연산자 안이라 번들러가 흔들어 떨굴 수 없다.
 *
 * 그래서:
 *   1) 모든 base64 payload 를 비운다 (문자열만 남는다)
 *   2) 브라우저 경로가 우리가 넣어 준 URL 을 쓰게 바꾼다
 *      — 그 URL 은 sim.worker.ts 가 `?url` 임포트로 받은 Vite 에셋이다
 *
 * 결과: JS 번들에서 15.6 MB 가 빠지고, wasm 은 별도 파일이 되어
 *       instantiateStreaming 으로 받으며, 실행을 누를 때까지 안 받는다.
 */
/**
 * 파운드리 PDK 모델 본문을 비운다.
 *
 * 엔진은 SKY130(2.2 MB) · GF180(1.2 MB) · PTM(0.2 MB) 공정 모델을 통째로 안고 있고,
 * 엔진이 뜰 때마다 emscripten FS 에 써 넣는다. 이 프로젝트는 R·C·L·신호원·op-amp 와
 * 자체 일반 모델만 쓰므로 전부 쓰이지 않는다. 설계서의 '부품 모델 라이선스' 항목도
 * 제조사 모델을 내장하지 않는다고 못박아 두었다.
 *
 * 축소된 변수 이름이 아니라 '내용' 으로 찾는다. 패키지가 올라가도 덜 깨진다.
 * 이 모델들이 필요하면 vite.config.ts 에서 DROP_FOUNDRY_MODELS 를 false 로.
 */
const DROP_FOUNDRY_MODELS = true;
const FOUNDRY = /SKY130|GlobalFoundries|FreePDK|PDK45|PDK15|PTM (?:High|Low|\d)/i;

function dropFoundryModels(code: string): [string, number] {
  const STUB = "* (foundry model omitted by build - see README)\\n";
  let out = "", i = 0, removed = 0;

  while (i < code.length) {
    const q = code[i];
    if (q !== '"' && q !== "'" && q !== "`") { out += q; i++; continue; }

    // 리터럴 끝 찾기. 보통 문자열은 줄을 못 넘는다
    let j = i + 1;
    for (; j < code.length; j++) {
      if (code[j] === "\\") { j++; continue; }
      if (code[j] === q) break;
      if (q !== "`" && code[j] === "\n") break;
    }
    if (j >= code.length || code[j] !== q) { out += q; i++; continue; }

    const body = code.slice(i + 1, j);
    // 보간이 든 템플릿은 코드일 수 있으니 손대지 않는다
    const safe = body.length > 20000
      && !(q === "`" && body.includes("${"))
      && FOUNDRY.test(body.slice(0, 400));

    if (safe) { out += q + STUB + q; removed += body.length; }
    else out += code.slice(i, j + 1);
    i = j + 1;
  }
  return [out, removed];
}

function stripInlineWasm(): Plugin {
  let stripped = 0;
  return {
    name: "strip-inline-wasm",
    enforce: "pre",
    apply: () => true,
    transform(code, id) {
      if (!id.includes("eecircuit-engine")) return null;
      if (!code.includes(MARKER)) return null;

      // 1) base64 payload 비우기. 20 MB 문자열이라 전역 정규식은 스택을 터뜨린다
      let out = "", cursor = 0, removed = 0, blobs = 0;
      for (;;) {
        const at = code.indexOf(MARKER, cursor);
        if (at < 0) { out += code.slice(cursor); break; }
        const from = at + MARKER.length;
        let to = from;
        while (to < code.length && /[A-Za-z0-9+/=]/.test(code[to])) to++;
        out += code.slice(cursor, from);
        removed += to - from;
        blobs++;
        cursor = to;
      }

      // 2) 브라우저 경로를 우리 URL 로. 축소된 식별자 이름은 버전마다 바뀌므로 느슨하게 맞춘다
      const before = out.length;
      out = out.replace(
        /return\s+\w+\.locateFile\s*\?\s*\w+\("spice\.wasm"\)\s*:\s*new URL\("data:application\/wasm;base64,",\s*""\s*\+\s*import\.meta\.url\)\.href;/,
        'return globalThis.__SPICE_WASM_URL__;',
      );
      const rewired = out.length !== before;

      if (!rewired) {
        this.error(
          "eecircuit-engine 의 wasm 로드 경로를 못 찾았습니다. " +
          "패키지가 올라가면서 모양이 바뀐 것 같습니다 — vite.config.ts 의 정규식을 맞춰 주세요",
        );
      }

      // 3) 쓰지 않는 파운드리 PDK 모델 본문 비우기
      let models = 0;
      if (DROP_FOUNDRY_MODELS) [out, models] = dropFoundryModels(out);

      stripped += removed + models;
      this.info(
        `base64 ${blobs}벌 ${(removed / 1048576).toFixed(1)} MB` +
        (models ? ` + 파운드리 모델 ${(models / 1048576).toFixed(1)} MB` : "") + " 제거",
      );
      return { code: out, map: null };
    },
    buildEnd() {
      if (stripped) console.log(`[strip-inline-wasm] 번들에서 ${(stripped / 1048576).toFixed(1)} MB 제거`);
    },
  };
}

export default defineConfig({
  // './' 로 두면 GitHub Pages 의 어떤 하위 경로에서도 그대로 동작한다
  base: "./",
  plugins: [stripInlineWasm()],
  // 미리 번들하면 위 transform 이 원본을 못 본다
  optimizeDeps: { exclude: ["eecircuit-engine"] },
  worker: { format: "es", plugins: () => [stripInlineWasm()] },
  build: {
    target: "es2022",
    rollupOptions: {
      // layout.html 은 레이아웃 편집기를 새 창으로 띄울 때만 연다 (src/layout/ui/popup.mjs)
      input: { index: "index.html", "spike-a": "spike-a.html", "spike-b": "spike-b.html", "layout-window": "layout.html" },
      output: {
        /*
         * 레이아웃 코드(앞단·배치기·배선기·편집기·예제, src/layout/)는 동적 import 로만 닿는다 — 전환 단추(switch.ts)만 첫 화면에
         * 실리고, 나머지는 Placement · Layout 이나 레이아웃 예제를 처음 열 때 받는다. 청크는 번들러가 나누게 두고 레이아웃
         * 코드가 든 청크의 이름만 layout- 으로 둔다 — tools/check-bundle.mjs 가 그 이름으로 첫 화면에서 빼고 따로 센다.
         *
         * manualChunks 로 한 덩어리에 묶지 않는다: 함수형 manualChunks 는 넣은 모듈의 의존성까지 끌고 들어가서, 공유
         * 모듈(단위 읽기, vite 의 preload 도우미, 회로도 잇기)을 따로 떼어도 그 묶음이 첫 화면에 실렸다.
         */
        chunkFileNames(info) {
          const layout = info.moduleIds.some((id) => id.includes("/src/layout/") && !id.includes("/src/layout/ui/switch.ts"));
          return layout ? "assets/layout-[name]-[hash].js" : "assets/[name]-[hash].js";
        },
      },
    },
  },
});
