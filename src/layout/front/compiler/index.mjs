/** 회로 컴파일러 — ALIGN compiler (generate_hierarchy) 의 JS 판. 파이썬·Pyodide 없이 브라우저에서 돈다.
 *
 *  SPICE 넷리스트 -> 계층 넷리스트(verilog.json 과 같은 꼴)와 원시 소자 라이브러리:
 *    1. 읽기        SKY130 모델 + 넷리스트 (spice.mjs), ALIGN 원시 소자 틀 (library.mjs)
 *    2. 데이터베이스 사용자 제약, 변수 풀기, 전원·접지 퍼뜨리기 (database.mjs)
 *    3. 전처리      D/S 바로잡기, 병렬·직렬 합치기, 꺼진 소자 지우기 (preprocess.mjs)
 *    4. 원시 소자   틀과 같은 부분을 X_... 인스턴스로 (annotate.mjs, graph.mjs, nx.mjs)
 *    5. 제약        대칭 소자·넷, 배열 (symmetry.mjs, arrays.mjs)
 *    6. 출력        { modules, global_signals } — 생성기 없는 서브회로마다 모듈 하나
 *
 *    compileNetlist(text, top, { userConstraints, onStage })
 *        -> { topology, library, primitives, primitiveList, groups }
 *           topology       verilog.json 과 같은 사전
 *           primitiveList  셀 생성기(primitive.mjs generatePrimitives)에 줄 원시 소자 목록
 *           groups         { 모듈: { 블록 인스턴스: [소자...] } } — 묶음 제약에서 (출력에서는 빠진다)
 */
import { readModels, readLib, orderLib } from "./library.mjs";
import { CreateDatabase } from "./database.mjs";
import { preprocessStackParallel } from "./preprocess.mjs";
import { annotate, primitiveLibrary } from "./annotate.mjs";
import { constraintGenerator } from "./symmetry.mjs";
import { pyCmp } from "../py.mjs";

const isSub = (x) => x && x.kind === "SubCircuit";
const EXCLUDE = ["DoNotIdentify", "GroupBlocks", "DoNotUseLib", "ConfigureCompiler"];

/** WriteVerilog.gen_dict */
function moduleDict(subckt) {
  return {
    name: subckt.name,
    parameters: subckt.pins.slice(),
    constraints: subckt.constraints.dict(),
    instances: subckt.elements.map((e) => ({
      abstract_template_name: e.abstract_name,
      instance_name: e.name,
      fa_map: [...e.pins].map(([formal, actual]) => ({ formal, actual })).sort((a, b) => pyCmp(a.formal, b.formal)),
    })),
  };
}

/** compiler_output — verilog.json 사전 (파일 대신 돌려준다) */
export function compilerOutput(lib, designName, groups = null) {
  const top = lib.find(designName);
  if (!top) throw new Error(`design ${designName} not found in database`);
  const out = { modules: [], global_signals: [] };
  for (const s of lib.items) {
    if (!isSub(s)) continue;
    if (s.constraints.items.some((c) => c.constraint === "Generator")) continue;
    // 묶음(GroupBlocks)은 출력에서 빠진다 — 그 전에 블록 -> 소자 표를 남긴다 (회로도와 선택을 잇는 데 쓴다)
    if (groups) {
      const g = (groups[s.name] = {});
      for (const c of s.constraints.items) if (c.constraint === "GroupBlocks") g[c.instance_name] = c.instances.slice();
    }
    for (const c of s.constraints.items.filter((c) => EXCLUDE.includes(c.constraint))) s.constraints.remove(c);
    out.modules.push(moduleDict(s));
  }
  const pwr = [], gnd = [];
  for (const c of top.constraints) {
    if (c.constraint === "PowerPorts") pwr.push(...c.ports);
    else if (c.constraint === "GroundPorts") gnd.push(...c.ports);
  }
  if (gnd.length && pwr.length) [gnd[0], pwr[0]].forEach((nm, i) => out.global_signals.push({ prefix: "global_power", formal: `supply${i}`, actual: nm }));
  return out;
}

/** 셀 생성기에 줄 꼴 (primitive.mjs) */
function primitiveEntry(s) {
  return {
    name: s.name, pins: s.pins.slice(), generator: { ...s.generator }, parameters: { ...s.parameters },
    elements: s.elements.map((e) => ({ name: e.name, model: e.model, abstract_name: e.abstract_name, pins: Object.fromEntries(e.pins), parameters: { ...(e.parameters ?? {}) } })),
    constraints: s.constraints.items.map((c) => c.dict()),
  };
}

/**
 * @param {string} text  SPICE 넷리스트
 * @param {string} top   맨 위 서브회로 이름
 * @param {{ userConstraints?: Record<string, object[]>, onStage?: (stage:string, lib:any)=>void }} [opts]
 */
export function compileNetlist(text, top, { userConstraints = {}, onStage = null } = {}) {
  const parser = readModels();
  parser.parse(text);
  onStage?.("parsed", parser.library);
  const templates = orderLib(readLib());
  onStage?.("templates", templates);
  const db = new CreateDatabase(parser, userConstraints);
  const lib = db.readInputs(top);
  db.addGenerators();
  onStage?.("database", lib);
  preprocessStackParallel(lib, top.toUpperCase());
  onStage?.("preprocessed", lib);
  annotate(lib, templates);
  onStage?.("annotated", lib);
  const prims = primitiveLibrary(lib);
  onStage?.("primitives", prims);
  constraintGenerator(lib);
  onStage?.("constrained", lib);
  const groups = {};
  const topology = compilerOutput(lib, top, groups);
  const primitiveList = prims.items.map((p) => (isSub(p) ? primitiveEntry(p) : { model: p.name, kind: "Model" }));
  return { topology, library: lib, primitives: prims, primitiveList, groups };
}
