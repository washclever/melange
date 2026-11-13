/** 원시 소자 셀 만들기 — ALIGN primitive/main.py (generate_primitives) 의 JS 판.
 *
 *  컴파일러가 낸 원시 소자 목록(SubCircuit 들)을 받아:
 *    1. PDK 의 gen_param 으로 변형(모양)마다 인자를 만들고           -> primitives
 *    2. 변형마다 셀 생성기를 돌려 도형을 얻는다 (writeJSON + json_pos)  -> cells
 *
 *  셀 JSON 은 ALIGN 2_primitives/<변형>.json 과 같다: { bbox, globalRoutes, globalRouteGrid, terminals,
 *  subinsts } — 원점은 (0, 0) 으로 옮겨져 있다. 배치기·배선기는 이것을 리프(leaf)로 읽는다.
 *
 *  원시 소자 모양 (컴파일러 출력과 같은 꼴):
 *    { name, pins: [넷...], generator: {name}, elements: [{ name, model, pins: {형식: 실제}, parameters }],
 *      constraints: [{ constraint: "Generator", name, parameters }] }
 */
import { Pdk } from "./cell/pdk.mjs";
import { MOSGenerator } from "./sky130/mos.mjs";
import { genParam } from "./sky130/param.mjs";
import { pyEq } from "./py.mjs";

const isSub = (p) => p && Array.isArray(p.elements);

/** dict == dict (키 순서 무시, 값은 깊게) */
function dictEq(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    const x = a[k], y = b[k];
    if (x && typeof x === "object" && !Array.isArray(x)) { if (!(y && typeof y === "object" && dictEq(x, y))) return false; }
    else if (!pyEq(x, y)) return false;
  }
  return true;
}

/** generate_MOS_primitive — 캔버스를 만들고 소자를 깐다 */
export function generateMOS(pdk, blockName, primitive, { height, nfin, x_cells, y_cells, vt_type, stack, parameters, bodyswitch }) {
  const fin = Math.trunc(nfin);
  const gateDummy = 3, gate = 1;
  const els = primitive.elements;
  let shared_diff = els.length === 2 && els[0].pins.S !== els[1].pins.S ? 0 : 1;
  const gens = (primitive.constraints ?? []).filter((c) => c.constraint === "Generator");
  let inputPattern = null;
  const g = gens.length ? gens[gens.length - 1] : null;
  if (g && g.parameters && Object.keys(g.parameters).length) {
    const p = g.parameters;
    if ("shared_diff" in p) shared_diff = Number(p.shared_diff);
    if ("pattern" in p) inputPattern = p.pattern;
    if ("body" in p) bodyswitch = Number(p.body);
    if ("height" in p) height = p.height;
  }
  const uc = new MOSGenerator(pdk, height, fin, gate, gateDummy, shared_diff, stack, bodyswitch);
  if (!inputPattern) {
    if (els.length === 1) inputPattern = "single_device";
    else if (!els.every((e) => dictEq(e.parameters, els[0].parameters))) inputPattern = "ratio_devices";
    else inputPattern = "cc";
  }
  const PATTERN = { single_device: 0, cc: 1, id: 2, ratio_devices: 3, ncc: 4 };
  if (!(inputPattern in PATTERN)) throw new Error(`${blockName}: unknown pattern ${inputPattern}`);
  let pattern = PATTERN[inputPattern];
  if (els.length === 2) {
    x_cells = 2 * x_cells;
    pattern = x_cells % 4 !== 0 ? 2 : pattern; // CC 를 못 만들면 엇갈림
  }
  if (!("model" in parameters)) parameters.model = primitive.name.includes("NMOS") ? "NMOS" : "PMOS";
  /** @type {Map<string, Array<[string, string]>>} */
  const connections = new Map(primitive.pins.map((p) => [p, []]));
  for (const e of els) {
    for (const [formal, actual] of Object.entries(e.pins)) {
      const c = connections.get(actual);
      if (!c) throw new Error(`${blockName}: net ${actual} of ${e.name}.${formal} is not a primitive pin`);
      c.push([e.name, formal]);
    }
  }
  if (primitive.name.includes("NMOS")) uc.addNMOSArray(x_cells, y_cells, pattern, vt_type, connections, parameters);
  else uc.addPMOSArray(x_cells, y_cells, pattern, vt_type, connections, parameters);
  return uc;
}

/** json_pos — 외곽의 왼쪽 아래를 (0, 0) 으로 */
function positiveCoord(data) {
  const [x0, y0] = data.bbox;
  data.bbox = [0, 0, data.bbox[2] - x0, data.bbox[3] - y0];
  for (const t of data.terminals) t.rect = [t.rect[0] - x0, t.rect[1] - y0, t.rect[2] - x0, t.rect[3] - y0];
  return data;
}

/**
 * generate_primitive — 변형 하나의 셀 JSON
 * @param {object} args  primitives[변형] (value, x_cells, y_cells, parameters, stack?, vt_type?, ...)
 */
export function generatePrimitive(pdk, blockName, primitive, args) {
  const a = { height: 28, x_cells: 1, y_cells: 1, value: 12, vt_type: "RVT", stack: 1, parameters: null, bodyswitch: 1, ...args };
  const gname = String(primitive.generator?.name ?? "").toUpperCase();
  if (gname !== "MOS") throw new Error(`${blockName}: ${gname || "?"} cells are not supported yet (transistors only)`);
  const uc = generateMOS(pdk, blockName, primitive, {
    height: a.height, nfin: a.value, x_cells: a.x_cells, y_cells: a.y_cells, vt_type: a.vt_type,
    stack: a.stack, parameters: a.parameters, bodyswitch: a.bodyswitch,
  });
  uc.computeBbox();
  // 파이썬은 파일로 쓰고 다시 읽는다 — 같은 효과로 깊은 복사
  const data = JSON.parse(JSON.stringify(uc.genData()));
  return positiveCoord(data);
}

/**
 * generate_primitives
 * @param {Array<object>} library  컴파일러가 낸 원시 소자 목록 (Model 항목은 건너뛴다)
 * @param {object} layers  PDK layers.json
 * @returns {{ primitives: Record<string, object>, cells: Record<string, object> }}
 */
export function generatePrimitives(library, layers) {
  const pdk = new Pdk(layers);
  const primitives = {};
  for (const p of library) {
    if (!isSub(p)) continue;
    const black = (p.constraints ?? []).some((c) => c.constraint === "Generator" && c.name === "black_box");
    const ring = p.generator?.name === "guard_ring";
    if (black) primitives[p.name] = { primitive: "black_box", abstract_template_name: p.name, concrete_template_name: p.name, parameters: p.pins };
    else if (ring) primitives[p.name] = { primitive: "guard_ring", abstract_template_name: p.name, concrete_template_name: p.name, parameters: p.pins };
    else genParam(p, primitives, pdk);
  }
  const cells = {};
  for (const [name, args] of Object.entries(primitives)) {
    const kind = args.primitive;
    if (kind === "black_box" || kind === "guard_ring") throw new Error(`${name}: ${kind} is not supported yet`);
    const def = library.find((x) => isSub(x) && x.name === String(args.abstract_template_name).toUpperCase());
    if (!def) throw new Error(`primitive ${name} has no definition (${args.abstract_template_name})`);
    delete args.primitive;
    const { abstract_template_name, concrete_template_name, ...rest } = args;
    void abstract_template_name; void concrete_template_name;
    cells[name] = generatePrimitive(pdk, name, def, rest);
  }
  return { primitives, cells };
}
