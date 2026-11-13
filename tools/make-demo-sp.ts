// RC 데모를 .sp 로 내보내 파일로 쓴다 (브라우저 불러오기 확인용)
import { exportSp } from "../src/io/sp.ts";
import { extractNets } from "../src/net/extract.ts";
import { buildNetlist } from "../src/net/netlist.ts";
import { BUILTIN, defaultParams } from "../src/lib/parts.ts";
import { emptyProject, type Part, type Pt } from "../src/doc/types.ts";
import { writeFile } from "node:fs/promises";

let n = 0;
const pr = emptyProject("RC lowpass demo");
for (const k of Object.keys(BUILTIN)) pr.library[k] = structuredClone(BUILTIN[k]);
const s = pr.sheets[0];
const add = (lib: string, ref: string, at: Pt): Part => {
  const p: Part = { id: "p" + ++n, lib, ref, at, rot: 0, mirror: false, params: defaultParams(BUILTIN[lib]) };
  s.parts.push(p); return p;
};
const w = (...pts: Pt[]) => s.wires.push({ id: "w" + ++n, pts });
add("vsin", "V1", [0, 0]); add("r", "R1", [60, -40]); add("c", "C1", [120, 0]); add("gnd", "GND1", [0, 60]);
w([0, -20], [0, -40], [40, -40]);
w([80, -40], [120, -40], [120, -20]);
w([0, 20], [0, 60]);
w([120, 20], [120, 60], [0, 60]);
s.labels.push({ id: "l1", name: "in", at: [0, -40], kind: "label" });
s.labels.push({ id: "l2", name: "out", at: [120, -40], kind: "label" });

const ex = extractNets(s, pr.library);
const sp = await exportSp(pr, buildNetlist(s, pr.library, ex, pr.sim, pr.name));
await writeFile(process.argv[2] ?? "demo.sp", sp);
console.log(sp.split("\n").slice(0, 3).join("\n"));
console.log("…");
console.log(sp.split("\n").slice(-6).join("\n"));
console.log(`\n총 ${sp.split("\n").length}줄, ${sp.length} bytes`);
