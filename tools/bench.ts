// 성능 예산 측정 (설계서 명세 11).
//
// 기준 장면은 부품 1,000개 · 배선 3,000개짜리 합성 시트다.
// EasyEDA Pro 가 렉 때문에 시트당 100개 미만을 권하므로, 열 배 큰 시트에서도
// 같은 손맛을 내는 것이 목표다.
import { extractNets } from "../src/net/extract.ts";
import { buildNetlist } from "../src/net/netlist.ts";
import { BUILTIN, defaultParams } from "../src/lib/parts.ts";
import { emptyProject, serialize, type Part, type Pt, type Project } from "../src/doc/types.ts";

function synth(parts: number, wiresPerPart: number): Project {
  const pr = emptyProject("bench");
  for (const k of Object.keys(BUILTIN)) pr.library[k] = structuredClone(BUILTIN[k]);
  const s = pr.sheets[0];
  const COLS = 40, DX = 80, DY = 80;

  for (let i = 0; i < parts; i++) {
    const col = i % COLS, row = Math.floor(i / COLS);
    const at: Pt = [col * DX, row * DY];
    const p: Part = {
      id: "p" + i, lib: "r", ref: "R" + (i + 1), at,
      rot: 0, mirror: false, params: defaultParams(BUILTIN.r),
    };
    s.parts.push(p);
    // 핀에서 배선을 뽑아 옆 부품으로 잇는다
    for (let w = 0; w < wiresPerPart; w++) {
      const y = at[1] + (w - 1) * 20;
      s.wires.push({ id: `w${i}_${w}`, pts: [[at[0] + 20, y], [at[0] + 60, y]] });
    }
  }
  // 접지 하나는 있어야 검사가 통과한다
  s.parts.push({ id: "gnd", lib: "gnd", ref: "GND1", at: [-80, 0], rot: 0, mirror: false, params: {} });
  s.wires.push({ id: "wg", pts: [[-80, 0], [-20, 0]] });
  return pr;
}

const ms = (f: () => void, runs = 3): number => {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) { const a = performance.now(); f(); t.push(performance.now() - a); }
  return Math.min(...t);
};

const budget = (name: string, got: number, limit: number, unit = "ms") => {
  const ok = got <= limit;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(26)} ${got.toFixed(1).padStart(8)} ${unit}  (예산 ${limit} ${unit})`);
  return ok;
};

for (const [n, wpp] of [[100, 3], [500, 3], [1000, 3]] as const) {
  const pr = synth(n, wpp);
  const s = pr.sheets[0];
  console.log(`\n=== 부품 ${s.parts.length} · 배선 ${s.wires.length} ===`);

  const tExtract = ms(() => { extractNets(s, pr.library); });
  const ex = extractNets(s, pr.library);
  const tNetlist = ms(() => { buildNetlist(s, pr.library, ex, pr.sim, "b"); });
  const tSerialize = ms(() => { serialize(pr); });
  const tParse = ms(() => { JSON.parse(serialize(pr)); });

  console.log(`  넷 ${ex.nets.size}개, 자동 접합점 ${ex.junctions.length}개`);
  budget("넷 재계산", tExtract, 50);
  budget("넷리스트 생성", tNetlist, 50);
  budget("직렬화", tSerialize, 300);
  budget("열기(파싱)", tParse, 1000);
}
