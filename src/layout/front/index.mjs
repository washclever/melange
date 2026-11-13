/** 앞단 — SPICE 넷리스트에서 배치기·배선기가 읽는 설계 묶음까지 (ALIGN 1_topology + 2_primitives).
 *
 *  파이썬도 Pyodide 도 쓰지 않는다. ALIGN 의 컴파일러와 셀 생성기를 JS 로 옮긴 것이고, 같은 입력에
 *  ALIGN(PYTHONHASHSEED=0)과 같은 출력을 낸다 (tools/verify-front.ts 가 대조한다).
 *
 *    frontEnd(netlist, top, { userConstraints })  ->  {
 *      topology     계층 넷리스트 (modules, global_signals)
 *      primitives   원시 소자 변형 표 (ALIGN __primitives__.json)
 *      templates    변형마다 { bbox, terminals(핀만) }
 *      place        null (배치기가 채운다)
 *      leaves       { format: "leaves/1", leaves: { 변형: { bbox, t: [[층, 넷, 핀?, x0, y0, x1, y1, 단자?]...], s?: [소자...] } } }
 *    }
 *
 *  userConstraints: { "<서브회로>": [ { constraint: "PowerPorts", ports: ["VDD"] }, ... ] } — ALIGN 의
 *  <서브회로>.const.json 과 같은 내용. 전원·접지를 주면 D/S 바로잡기와 대칭 찾기가 그것을 기준으로 한다.
 */
import { compileNetlist } from "./compiler/index.mjs";
import { generatePrimitives } from "./primitive.mjs";
import { SKY130 } from "../pdk/sky130.mjs";
import { pyCmp } from "./py.mjs";

/** 셀 JSON -> 배치기 리프 */
export function leafOf(cell) {
  const rows = [];
  for (const t of cell.terminals ?? []) {
    const row = [t.layer, t.netName ?? null, t.netType === "pin" ? 1 : 0, ...t.rect];
    if (t.terminal) row.push(t.terminal);
    rows.push(row);
  }
  const leaf = { bbox: cell.bbox, t: rows };
  if (cell.subinsts && Object.keys(cell.subinsts).length) leaf.s = Object.keys(cell.subinsts);
  return leaf;
}

export function frontEnd(netlist, top, opts = {}) {
  return runFrontEnd(netlist, top, opts).blob;
}

/** frontEnd 와 같고, 블록 -> 소자 표(groups)를 같이 준다 — { blob, groups } */
export function runFrontEnd(netlist, top, { userConstraints = {}, layers = SKY130 } = {}) {
  const { topology, primitiveList, groups } = compileNetlist(netlist, top, { userConstraints });
  const { primitives, cells } = generatePrimitives(primitiveList, layers);
  const templates = {}, leaves = {};
  for (const cn of Object.keys(primitives).sort(pyCmp)) {
    const d = cells[cn];
    if (!d) continue;
    templates[cn] = { bbox: d.bbox, terminals: (d.terminals ?? []).filter((t) => t.netType === "pin" && t.netName) };
    leaves[cn] = leafOf(d);
  }
  return { blob: { topology, primitives, templates, place: null, leaves: { format: "leaves/1", leaves } }, groups };
}

export { compileNetlist, generatePrimitives };
