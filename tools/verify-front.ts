// 레이아웃 앞단 검증 — JS 로 옮긴 ALIGN 컴파일러·셀 생성기가 파이썬 ALIGN 과 같은 출력을 내는가.
//
// 기준(tools/ref/front/<회로>/expect.json)은 파이썬 ALIGN(PYTHONHASHSEED=0) + ALIGN-pdk-sky130 으로 만든 것이다:
// 계층 넷리스트(topology)와 원시 소자 표(primitives)는 그대로, 셀 도형은 sha256 으로 대조한다.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { frontEnd } from "../src/layout/front/index.mjs";
import { PySet, pyHash } from "../src/layout/front/py.mjs";
import { alignKey } from "../src/layout/front/sha256.mjs";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

// ── 파이썬 집합 순서 · 해시 (CPython 3.13, PYTHONHASHSEED=0) ─────────────
console.log("파이썬 집합 흉내");
ok(same([...new PySet(["D", "G", "S", "B"])], ["S", "G", "D", "B"]), "핀 이름 집합의 순서");
ok(same([...new PySet(["VDD", "VSS", "VOUT", "VINN", "VINP", "ID", "NET8", "SOURCE"])], ["VINP", "VINN", "VSS", "NET8", "VDD", "VOUT", "SOURCE", "ID"]), "넷 이름 집합의 순서");
ok(same([...new PySet([[3, "S"], [5, "D"], [7, "S"], [4, "G"]])], [[3, "S"], [7, "S"], [4, "G"], [5, "D"]]), "(정수, 문자열) 튜플 집합의 순서");
ok(same([...new PySet([130, 2, 66, 194, 258, 9, 17])], [258, 194, 130, 2, 66, 9, 17]), "정수 집합의 순서 (충돌)");
ok(same([pyHash("NET8"), pyHash(["X0", "X1"]), pyHash(-1), pyHash(2 ** 61)].map(String), ["-4574085037181188785", "4419500231591086650", "-2", "1"]), "hash() 값");
ok(alignKey("abc") === "_" + String(BigInt("0x" + createHash("sha256").update("abc").digest("hex")) % 100000000n), "이름 꼬리표 (sha256 % 10^8)");

// ── 회로마다 앞단 전체 ─────────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REF = path.join(HERE, "ref", "front");
const names: string[] = JSON.parse(fs.readFileSync(path.join(REF, "index.json"), "utf8"));
console.log(`앞단 (${names.length} 회로, 기준: 파이썬 ALIGN)`);
for (const name of names) {
  const dir = path.join(REF, name);
  const text = fs.readFileSync(path.join(dir, name + ".sp"), "utf8");
  const top = (text.split(/\r?\n/).filter((l) => l.toLowerCase().startsWith(".subckt")).pop() ?? "").split(/\s+/)[1];
  const userConstraints: Record<string, object[]> = {};
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".const.json")) userConstraints[f.slice(0, -11).toUpperCase()] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const want = JSON.parse(fs.readFileSync(path.join(dir, "expect.json"), "utf8"));
  let blob: any;
  const t0 = performance.now();
  try {
    blob = JSON.parse(JSON.stringify(frontEnd(text, top, { userConstraints })));
  } catch (e) {
    ok(false, name, "오류: " + (e as Error).message);
    continue;
  }
  const ms = (performance.now() - t0).toFixed(0);
  const leafBad = Object.keys(want.leaves).filter((k) => sha(blob.leaves.leaves[k]) !== want.leaves[k]);
  const tplBad = Object.keys(want.templates).filter((k) => sha(blob.templates[k]) !== want.templates[k]);
  const extra = Object.keys(blob.leaves.leaves).filter((k) => !(k in want.leaves));
  const good = same(blob.topology, want.topology) && same(blob.primitives, want.primitives) && !leafBad.length && !tplBad.length && !extra.length && sha(blob) === want.blob;
  ok(good, `${name}`, good
    ? `${blob.topology.modules.length} 모듈 · 변형 ${Object.keys(blob.primitives).length} · ${ms} ms`
    : [!same(blob.topology, want.topology) && "topology", !same(blob.primitives, want.primitives) && "primitives",
       leafBad.length && `셀 ${leafBad.slice(0, 3).join(",")}`, tplBad.length && "templates", extra.length && `더 있는 셀 ${extra}`].filter(Boolean).join(" · "));
}

console.log(fail ? `\nFAIL ${fail}` : "\nALL PASS");
process.exit(fail ? 1 : 0);
