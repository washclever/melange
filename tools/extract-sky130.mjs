/**
 * eecircuit-engine 번들 안에 박혀 있는 SKY130 모델 카드를 꺼내 파일로 쓴다.
 *
 * 엔진은 뜰 때마다 공정 모델 몇 벌을 emscripten FS 에 써 넣는데, 그 본문이 .mjs 안에
 * 문자열로 들어 있다. SKY130 만 2.18 MB 라 빌드에서 걷어내고 있었다
 * (vite.config.ts 의 strip-inline-wasm).
 *
 * 걷어낸 채로 두면 PDK 소자를 못 쓰므로, 같은 본문을 **별도 에셋**으로 빼 둔다.
 * 워커가 PDK 소자를 처음 만났을 때만 받아서 엔진 FS 에 써 넣는다 — 저항 하나 돌리는
 * 사람이 2 MB 를 받을 일은 없다.
 *
 * postinstall 에서 돈다. 결과물은 git 에 넣지 않는다 (.gitignore 의 src/vendor).
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const DIR = join(process.cwd(), "src", "vendor");
const BINS = join(DIR, "sky130-bins.ts");
const FILE = "/modelcard.skywater";

/** 소자 이름 -> 내보낼 파일 이름 (src/net/netlist.ts 의 SKY130_FILES 와 짝이다) */
const DEVICES = {
  sky130_fd_pr__nfet_01v8: "sky130-nfet.spice",
  sky130_fd_pr__pfet_01v8: "sky130-pfet.spice",
  sky130_fd_pr__pfet_01v8_hvt: "sky130-pfet-hvt.spice",
};
const COMMON = "sky130-common.spice";

/**
 * 한 덩어리였던 모델 카드를 **소자별로 쪼갠다.**
 *
 * 2.29 MB 를 통째로 `.include` 하면 ngspice 가 매번 그걸 다 읽는다. 첫 실행이 몇 초씩
 * 걸리던 이유다. 그런데 그중 **hvt 혼자 1.26 MB (55%)** 다 — nFET 하나 쓰는 회로가
 * 쓰지도 않을 hvt 의 bin 198개를 읽고 있었다.
 *
 * 쪼개 두면 넷리스트가 쓰는 소자의 파일만 부른다. 나누는 자리는 `.subckt`/`.model`
 * 이름이다. 그 밖의 것(머리말, 공용 .param)은 공용 파일로 간다.
 */
function split(text) {
  const out = { [COMMON]: [] };
  for (const f of Object.values(DEVICES)) out[f] = [];
  const fileOf = (name) => {
    const dev = String(name).toLowerCase().replace(/__model\.\d+$/, "");
    return DEVICES[dev] ?? null;
  };

  let cur = COMMON;          // 지금 줄이 들어갈 파일
  let inSubckt = false;
  for (const line of text.split("\n")) {
    const sub = /^\s*\.subckt\s+(\S+)/i.exec(line);
    const mdl = /^\s*\.model\s+(\S+)/i.exec(line);
    if (sub) { cur = fileOf(sub[1]) ?? COMMON; inSubckt = true; }
    else if (mdl) { cur = fileOf(mdl[1]) ?? COMMON; inSubckt = false; }
    else if (!inSubckt && /^\s*\.(param|include|lib|option)\b/i.test(line)) {
      // 소자 이름이 든 .param 은 그 소자 파일로, 아니면 공용으로
      const named = /sky130_fd_pr__[a-z0-9_]+/i.exec(line);
      cur = (named && fileOf(named[0].replace(/__[a-z0-9]+$/i, ""))) ?? COMMON;
      // 이름이 소자와 안 맞으면 (`__dlc_rotweak` 같은 공용 묶음) 공용으로 둔다
      if (named && !cur) cur = COMMON;
    }
    out[cur].push(line);
    if (/^\s*\.ends\b/i.test(line)) { inSubckt = false; cur = COMMON; }
  }
  return out;
}

/**
 * 모델이 **어떤 W·L 에서만 정의되는가** 를 뽑아 둔다.
 *
 * BSIM 카드는 치수마다 다른 bin 으로 쪼개져 있고, 어느 bin 에도 안 걸리는 W·L 을 주면
 * ngspice 가 소자 줄에서 바로 죽는다 — 로그에 모델 이름도 없는 긴 줄 하나만 남아서
 * 뭐가 잘못됐는지 알기 어렵다. 실행 전 검사에서 먼저 잡으려고 표를 만든다 (설계서 E26 과 같은 생각).
 */
function binTable(text) {
  const out = {};
  const re = /\.model\s+(sky130_fd_pr__\w+)__model\.\d+\s+[\s\S]{0,500}?lmin\s*=\s*(\S+)\s+lmax\s*=\s*(\S+)\s+wmin\s*=\s*(\S+)\s+wmax\s*=\s*(\S+)/gi;
  for (const m of text.matchAll(re)) {
    const dev = m[1].toLowerCase();
    (out[dev] ??= []).push([+m[2], +m[3], +m[4], +m[5]]);
  }
  const body = Object.entries(out)
    .map(([dev, bins]) => `  "${dev}": [\n${bins.map(b => "    [" + b.join(", ") + "],").join("\n")}\n  ],`)
    .join("\n");
  return `// 자동 생성 — tools/extract-sky130.mjs. 고치지 말 것.\n`
    + `// 소자별로 모델이 정의된 [Lmin, Lmax, Wmin, Wmax] 묶음 (미터).\n`
    + `export const SKY130_BINS: Record<string, Array<[number, number, number, number]>> = {\n`
    + body + `\n};\n`;
}

/** 그 자리의 JS 문자열 리터럴 하나를 읽어 실제 문자열로 돌려준다 */
function literalAt(src, from) {
  const q = src.indexOf('"', from);
  if (q < 0) return null;
  let i = q + 1;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === '"') break;
    i++;
  }
  if (i >= src.length) return null;
  // 따옴표째 넘기면 JSON 이 이스케이프를 그대로 풀어 준다
  return JSON.parse(src.slice(q, i + 1));
}

/**
 * 모델 카드가 **쓰기만 하고 정의하지 않은** 코너 파라미터를 채운다.
 *
 * SkyWater 의 실제 PDK 는 모델 카드와 코너 파일이 따로다. 모델 식은 어디에나
 * `... + sky130_fd_pr__nfet_01v8__vth0_diff_12` 처럼 **공칭값에서의 차이**를 더하게 써 두고,
 * 그 차이를 코너 파일(tt·ff·ss)이 정한다. 엔진 번들에는 모델 카드만 들어 있어서,
 * 그대로 쓰면 ngspice 가 `Undefined parameter [...]` 로 2,400개를 뱉고
 * `Cannot compute substitute` 뒤에 **멈춘 채 돌아오지 않는다.**
 *
 * 그래서 전형(typical) 코너를 여기서 복원한다. 뜻 그대로 **차이가 0 인 자리**가 전형이고,
 * `mc_switch = 0` 은 식에 섞인 몬테카를로 항(agauss)을 끄는 스위치다. 값을 지어내는 게
 * 아니라 이름이 정의하는 그대로를 적는 것이다.
 *
 * 그래서 이 빌드의 SKY130 은 **전형 코너 하나뿐이고 소자 편차도 없다.** 공정 모서리를
 * 바꿔 가며 보는 것은 진짜 PDK 를 받아야 한다 (README·THIRD-PARTY.md 에 적어 두었다).
 */
function withCornerParams(text) {
  const defined = new Set();
  let inParam = false;
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    const body = /^\.param\b/i.test(l) ? (inParam = true, l.slice(6))
      : inParam && l.startsWith("+") ? l
      : (inParam = false, null);
    if (body === null) continue;
    for (const m of body.matchAll(/([A-Za-z_][\w.]*)\s*=/g)) defined.add(m[1].toLowerCase());
  }

  const need = new Set();
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    for (const id of m[1].matchAll(/[A-Za-z_][\w.]*/g)) {
      const n = id[0].toLowerCase();
      // 코너 오프셋과 몬테카를로 스위치만 채운다. 나머지는 손대지 않는다
      if (n !== "mc_switch" && !/_diff(_\d+)?$/.test(n)) continue;
      if (!defined.has(n)) need.add(n);
    }
  }

  const names = [...need].sort();
  const head = [
    "* --- added by melange (tools/extract-sky130.mjs) ---",
    "* The bundled model cards reference per-corner offsets that live in SkyWater's",
    "* corner files, which the engine bundle does not carry. Typical corner means every",
    "* offset is zero, and mc_switch=0 turns off the Monte-Carlo term in the expressions.",
    "* Without these, ngspice reports ~2400 undefined parameters and never returns.",
    ...names.map(n => `.param ${n} = 0`),
    "* --- end ---",
  ].join("\n");
  return [head + "\n" + text, names.length];
}

async function main() {
  const entry = join(process.cwd(), "node_modules", "eecircuit-engine", "dist", "eecircuit-engine.mjs");
  try {
    await stat(entry);
  } catch {
    console.log("[extract-sky130] eecircuit-engine 이 없습니다. 건너뜁니다");
    return;
  }

  const src = await readFile(entry, "utf8");
  const at = src.indexOf(FILE);
  if (at < 0) throw new Error(`번들에서 ${FILE} 을 못 찾았습니다`);
  // writeFile("/modelcard.skywater", "<본문>") 의 두 번째 인자
  const text = literalAt(src, src.indexOf(",", at) + 1);
  if (!text) throw new Error("모델 카드 본문을 못 읽었습니다");

  /*
   * 제대로 꺼냈는지 본다. 패키지가 올라가며 모양이 바뀌면 조용히 빈 파일을 쓰는 것이
   * 제일 나쁘다 — 빌드는 통과하고 시뮬레이션만 'model not found' 로 죽는다.
   */
  const want = ["sky130_fd_pr__nfet_01v8", "sky130_fd_pr__pfet_01v8"];
  for (const w of want) {
    if (!text.includes(`.subckt  ${w} `) && !text.includes(`.subckt ${w} `)) {
      throw new Error(`모델 카드에 ${w} 서브회로가 없습니다`);
    }
  }
  if (text.length < 1e6) throw new Error(`모델 카드가 너무 짧습니다 (${text.length} 바이트)`);

  const [full, added] = withCornerParams(text);
  await mkdir(DIR, { recursive: true });
  await writeFile(BINS, binTable(text));

  const parts = split(full);
  const sizes = [];
  for (const [name, lines] of Object.entries(parts)) {
    const body = lines.join("\n");
    await writeFile(join(DIR, name), body);
    sizes.push(`${name.replace(/^sky130-|\.spice$/g, "")} ${(body.length / 1048576).toFixed(2)}`);
  }
  console.log(`[extract-sky130] ${(text.length / 1048576).toFixed(2)} MB + 코너 ${added}개`
    + ` -> ${sizes.join(" / ")} MB`);
}

main().catch(e => { console.error("[extract-sky130]", e.message); process.exit(1); });
