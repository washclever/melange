// ALIGN 예제 넷리스트를 src/layout/examples/netlists.ts 로 — 한 번 돌려 결과를 저장소에 둔다 (원문 그대로).
//   node tools/make-layout-examples.mjs <netlists 폴더> <이름...>
// 넷리스트는 ALIGN-public 의 examples/ 의 것이다 (BSD-3-Clause, THIRD-PARTY.md).
import fs from "node:fs";
import path from "node:path";
const [dir, ...names] = process.argv.slice(2);
if (!dir || !names.length) { console.error("usage: node tools/make-layout-examples.mjs <dir> <name...>"); process.exit(2); }
const out = {};
for (const n of names) {
  const sp = fs.readFileSync(path.join(dir, n + ".sp"), "utf8");
  const cf = path.join(dir, n + ".const.json");
  const constraints = fs.existsSync(cf) ? JSON.parse(fs.readFileSync(cf, "utf8")).filter((c) => c.constraint === "PowerPorts" || c.constraint === "GroundPorts") : [];
  out[n] = { sp, constraints };
}
const body = Object.entries(out).map(([n, v]) => `  ${n}: {\n    sp: ${JSON.stringify(v.sp)},\n    constraints: ${JSON.stringify(v.constraints)},\n  },`).join("\n");
const file = `/** ALIGN 예제 넷리스트 — ALIGN-public 의 examples/ (BSD-3-Clause, THIRD-PARTY.md). FinFET 모의 공정으로 적힌 원문 그대로다.
 *  SKY130 회로도로는 build.ts 가 옮긴다. 만든 것: node tools/make-layout-examples.mjs (제약은 PowerPorts · GroundPorts 만 남긴다)
 */
export const NETLISTS: Record<string, { sp: string; constraints: Array<Record<string, unknown>> }> = {
${body}
};
`;
fs.writeFileSync(new URL("../src/layout/examples/netlists.ts", import.meta.url), file);
console.log(`wrote ${names.length} netlists, ${(file.length / 1024).toFixed(1)} KB`);
