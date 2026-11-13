// 기준 장면(부품 1,000 · 배선 3,000)을 .json 으로 내보내 브라우저에서 열어 본다
import { serialize, emptyProject, type Part, type Pt } from "../src/doc/types.ts";
import { BUILTIN, defaultParams } from "../src/lib/parts.ts";
import { writeFile } from "node:fs/promises";

const N = Number(process.argv[3] ?? 1000);
const pr = emptyProject("bench " + N);
for (const k of Object.keys(BUILTIN)) pr.library[k] = structuredClone(BUILTIN[k]);
const s = pr.sheets[0];
const COLS = 40, DX = 80, DY = 80;
for (let i = 0; i < N; i++) {
  const at: Pt = [(i % COLS) * DX, Math.floor(i / COLS) * DY];
  s.parts.push({ id: "p" + i, lib: "r", ref: "R" + (i + 1), at, rot: 0, mirror: false, params: defaultParams(BUILTIN.r) } as Part);
  for (let w = 0; w < 3; w++) {
    const y = at[1] + (w - 1) * 20;
    s.wires.push({ id: `w${i}_${w}`, pts: [[at[0] + 20, y], [at[0] + 60, y]] });
  }
}
s.parts.push({ id: "gnd", lib: "gnd", ref: "GND1", at: [-80, 0], rot: 0, mirror: false, params: {} } as Part);
s.wires.push({ id: "wg", pts: [[-80, 0], [-20, 0]] });
await writeFile(process.argv[2], serialize(pr));
console.log(`부품 ${s.parts.length} · 배선 ${s.wires.length} -> ${process.argv[2]}`);
