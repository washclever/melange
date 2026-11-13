/**
 * eecircuit-engine 번들에 base64 로 박혀 있는 spice.wasm 을 꺼내 파일로 쓴다.
 *
 * 그 패키지는 wasm 을 별도 파일로 내보내지 않고 .mjs 안에 data: URL 로 두 벌 넣어 둔다.
 * (하나는 브라우저 경로, 하나는 node 전용 경로) 합쳐서 15.6 MB 이고 base64 라서
 * 스트리밍 컴파일도 못 탄다. 꺼내서 Vite 에셋으로 넘기면 번들에서 통째로 빠진다.
 *
 * postinstall 에서 돈다. 결과물은 git 에 넣지 않는다.
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";


const OUT = join(process.cwd(), "src", "vendor", "spice.wasm");
const MARKER = "data:application/wasm;base64,";

async function main() {
  // 패키지의 exports 맵이 "." 하나만 열어 두어서 require.resolve 로는 dist 안을 못 짚는다.
  // node_modules 경로를 직접 본다.
  const entry = join(process.cwd(), "node_modules", "eecircuit-engine", "dist", "eecircuit-engine.mjs");
  try {
    await stat(entry);
  } catch {
    console.log("[extract-wasm] eecircuit-engine 이 없습니다. 건너뜁니다");
    return;
  }

  const src = await readFile(entry, "utf8");

  // 20 MB 짜리 문자열이라 정규식 전역 매치는 스택을 터뜨린다. indexOf 로 훑는다
  const start = src.indexOf(MARKER);
  if (start < 0) throw new Error("번들에서 wasm base64 를 못 찾았습니다");
  const from = start + MARKER.length;
  let to = from;
  while (to < src.length && /[A-Za-z0-9+/=]/.test(src[to])) to++;

  const b64 = src.slice(from, to);
  const bytes = Buffer.from(b64, "base64");

  // wasm 매직 넘버 확인: 0x00 'a' 's' 'm'
  if (!(bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d)) {
    throw new Error("꺼낸 바이트가 wasm 이 아닙니다");
  }

  try {
    const prev = await stat(OUT);
    if (prev.size === bytes.length) {
      console.log(`[extract-wasm] 이미 최신입니다 (${(bytes.length / 1048576).toFixed(1)} MB)`);
      return;
    }
  } catch { /* 없으면 쓴다 */ }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, bytes);
  console.log(
    `[extract-wasm] base64 ${(b64.length / 1048576).toFixed(1)} MB -> ` +
    `spice.wasm ${(bytes.length / 1048576).toFixed(1)} MB`,
  );
}

main().catch(e => { console.error("[extract-wasm]", e.message); process.exit(1); });
