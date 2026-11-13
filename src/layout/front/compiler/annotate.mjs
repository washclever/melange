/** 원시 소자 찾기 — ALIGN compiler/match_graph.py (Annotate) 와 gen_abstract_name.py (PrimitiveLibrary) 의 JS 판.
 *
 *    annotate(lib, templates)   생성기가 없는 서브회로마다, 틀을 차례로(orderLib 순서) 맞춰 소자 묶음을
 *                               새 서브회로 인스턴스 X_<소자들> 로 바꾼다 (DoNotIdentify 소자는 여러 소자 틀에서 뺀다)
 *    primitiveLibrary(lib)      쓰인 원시 소자(생성기가 있는 서브회로)와 그 소자 모델만 모은 라이브러리.
 *                               인스턴스마다 abstract_name 을 단다
 */
import { AGraph } from "./graph.mjs";
import { Library, SubCircuit, Instance } from "./schema.mjs";
import { expandUserConstraints } from "./constraint.mjs";
import { pdkGenerator } from "./library.mjs";
import { genKey } from "./util.mjs";

const isSub = (x) => x && x.kind === "SubCircuit";
const hasGen = (s) => s.constraints.items.some((c) => c.constraint === "Generator");
const isDigital = (s) => {
  let d = false;
  for (const c of s.constraints) if (c.constraint === "ConfigureCompiler") d = c.is_digital;
  return d;
};

function isSkip(ckt) {
  const out = [];
  for (const c of expandUserConstraints(ckt.constraints)) if (c.constraint === "DoNotIdentify") out.push(...c.instances);
  return out;
}

export function annotate(lib, templates) {
  const matched = new Map();
  for (const ckt of lib.items) {
    if (!isSub(ckt)) continue;
    if (ckt.constraints.items.some((c) => c.constraint === "GroupBlocks" || (c.constraint === "GroupCaps" && c.instances.length > 1)))
      throw new Error(`${ckt.name}: user GroupBlocks/GroupCaps constraints are not supported yet`);
  }
  for (let i = 0; i < lib.items.length; i++) {
    const ckt = lib.items[i];
    if (!isSub(ckt) || isDigital(ckt) || hasGen(ckt)) continue;
    createHierarchy(ckt, templates, matched);
  }
  for (const ckt of lib.items) {
    if (!isSub(ckt)) continue;
    if (!ckt.pins.length) throw new Error(`floating module found ${ckt.name}`);
    if (new Set(ckt.pins).size !== ckt.pins.length) throw new Error(`duplicate pins found in module ${ckt.name}, ${ckt.pins}`);
    for (const e of ckt.elements) {
      const m = lib.find(e.model);
      if (isSub(m) && e.pins.size !== m.pins.length) throw new Error("incorrect subckt instantiation");
    }
  }
}

function createHierarchy(ckt, templates, matched, skipNodes = null) {
  const g = new AGraph(ckt);
  const skipConstrained = skipNodes ? [...isSkip(ckt), ...skipNodes] : isSkip(ckt);
  const doNotUse = new Set();
  for (const c of ckt.constraints) if (c.constraint === "DoNotUseLib") for (const l of c.libraries) doNotUse.add(l);
  const all = [];
  for (const sub of templates) {
    if (sub.name === ckt.name || doNotUse.has(sub.name) || (matched.has(sub.name) && matched.get(sub.name).includes(ckt.name))) continue;
    const news = sub.elements.length > 1 ? g.replaceMatchingSubgraph(new AGraph(sub), skipConstrained) : g.replaceMatchingSubgraph(new AGraph(sub), skipNodes);
    if (matched.has(sub.name)) matched.get(sub.name).push(...news);
    else matched.set(sub.name, news);
    all.push(...news);
  }
  return all;
}

/** PrimitiveLibrary(ckt_lib).gen_primitive_collateral() */
export function primitiveLibrary(lib) {
  const plib = new Library();
  const addPrimitive = (name) => {
    if (plib.find(name)) return;
    const p = lib.find(name);
    if (isSub(p)) for (const e of p.elements) if (!plib.find(e.model)) plib.append(lib.find(e.model));
    plib.append(p);
  };
  const createSubckt = (el, name) => {
    if (plib.find(name)) return;
    const s = SubCircuit.create(plib, { name, pins: [...el.pins.keys()], generator: { name: el.model } });
    s.elements.push(Instance.create(s, { name: el.name, model: el.model, pins: new Map([...el.pins.keys()].map((x) => [x, x])), parameters: el.parameters }));
    plib.append(s);
  };
  for (const ckt of lib.items) {
    if (!isSub(ckt) || hasGen(ckt)) continue;
    const gc = [];
    for (const c of ckt.constraints) if (c.constraint === "GroupCaps") throw new Error(`${ckt.name}: GroupCaps is not supported yet`);
    for (const el of ckt.elements) {
      if (gc.includes(el.name)) { el.addAbsName(el.model); continue; }
      const gen = lib.find(el.model);
      if (isSub(gen)) {
        el.addAbsName(el.model);
        if (hasGen(gen) && !plib.find(gen.name)) addPrimitive(gen.name);
      } else if (pdkGenerator(el.model)) {
        const unique = `${el.model}${genKey(el.parameters ?? {})}`;
        el.addAbsName(unique);
        addPrimitive(el.model);
        createSubckt(el, unique);
      } else throw new Error(`Unmatched generator for this instance ${el.name} (${el.model}), please fix netlist`);
    }
  }
  for (const ckt of lib.items) {
    if (!isSub(ckt)) continue;
    for (const c of ckt.constraints) if (c.constraint === "GuardRing") throw new Error(`${ckt.name}: GuardRing is not supported yet`);
  }
  return plib;
}
