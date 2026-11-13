/** 배열 계층 — ALIGN compiler/create_array_hierarchy.py 의 JS 판.
 *
 *  대칭 찾기가 팬아웃이 큰 넷을 "배열 출발점"으로 표시하면, 그 넷에서 같은 모양으로 뻗는 가지들을 찾아
 *    - 가지마다 소자 하나면: SameTemplate + Align/AlignInOrder 제약 (한 줄로 세운다)
 *    - 가지가 여러 소자면: ARRAY_HIER_<넷> 계층과 가지마다 ARRAY_TEMPLATE 계층을 만든다
 */
import { AGraph } from "./graph.mjs";
import { SubCircuit, Instance } from "./schema.mjs";
import { Constraint } from "./constraint.mjs";
import { createNodeId, reducedSDNeighbors, sortedStr } from "./util.mjs";
import { PySet, pyCmp } from "../py.mjs";

export class ProcessArrays {
  constructor(ckt, matchPairs) {
    this.dl = ckt.parent;
    this.ckt = ckt;
    this.graph = new AGraph(ckt);
    this.stopPoints = [];
    this.condition = true;
    this.isDigital = false;
    for (const c of ckt.constraints) {
      if (["PowerPorts", "GroundPorts", "ClockPorts"].includes(c.constraint)) this.stopPoints.push(...c.ports);
      else if (c.constraint === "ConfigureCompiler") { this.condition = c.identify_array; this.isDigital = c.is_digital; }
    }
    this.matchPairs = matchPairs;
    this.name = ckt.name;
    this.iconst = ckt.constraints;
    this.hierSp = new Set();
    this.alignBlock = new Map();
    this.newHier = new Map();
    for (const pair of this.matchPairs.values()) {
      if (!pair.has("array_start_point")) continue;
      const sp = pair.get("array_start_point");
      if (sp && sp.length && typeof sp[0] === "string") for (const x of sp) this.hierSp.add(x);
      pair.delete("array_start_point");
    }
    for (const sp of sortedStr(this.hierSp)) {
      if (!this.graph.hasNode(sp)) throw new Error(`${sp} not found in graph`);
      this.findArray(sp, this.stopPoints);
    }
  }

  findArray(start, traversed) {
    if (!this.condition || this.isDigital) return null;
    const lvl1 = [...new PySet(this.graph.neighbors(start)).difference(new PySet(traversed))];
    const groups = this.matchingGroups(start, lvl1);
    if (groups.length === 0) return null;
    let array = null;
    for (const group of [...groups].map((g, i) => [g, i]).sort((a, b) => a[0].length - b[0].length || a[1] - b[1]).map(([g]) => g)) {
      if (group.length === 0) continue;
      const templates = [];
      const matchGrps = new Map();
      let el = null;
      for (el of sortedStr(group)) matchGrps.set(el, [el]);
      const visited = [...group, ...this.stopPoints, el, start];
      array = new Map([...matchGrps].map(([k, v]) => [k, v]));
      this.traceTemplate(matchGrps, visited, templates, array);
    }
    return this.processResults(start, array);
  }

  processResults(start, array) {
    if (!array || array.size === 0) throw new Error("Wrong array identification, check find_array() code");
    const a2 = [...array.values()].map((lst) => sortedStr(lst).filter((i) => this.ckt.getElement(i)));
    if (a2[0].length === 1) {
      this.alignBlock.set(start, a2.map((x) => x[0]));
      return this.alignBlock.get(start);
    }
    this.newHier.set(start, a2);
    return a2;
  }

  matchingGroups(node, lvl1) {
    const props = new Map();
    for (const n of lvl1) props.set(n, createNodeId(this.graph, n) + sortedStr(this.graph.getEdgeData(node, n).pin).join("_"));
    const sim = new Map();
    for (const [k, v] of props) {
      if (sim.has(v)) sim.get(v).push(k);
      else sim.set(v, [k]);
    }
    return [...sim.values()].filter((v) => v.length > 1).sort(pyCmp);
  }

  traceTemplate(matchGrps, visited, template, array) {
    const next = new Map();
    const traversed = visited.slice();
    for (const [source, groups] of matchGrps) {
      next.set(source, []);
      for (const node of sortedStr(groups)) {
        const nbrs = new PySet(this.graph.neighbors(node)).difference(new PySet(traversed));
        const lvl1 = [...nbrs].filter((nbr) => reducedSDNeighbors(this.graph, node, nbr));
        next.get(source).push(...lvl1);
        visited.push(...lvl1);
      }
      if (next.get(source).length === 0) next.delete(source);
    }
    if (next.size && this.matchBranches(next)) {
      for (const source of array.keys()) if (next.has(source)) array.get(source).push(...next.get(source));
      template.push(...next.get([...next.keys()][0]));
      if (this.checkNonConvergence(next)) this.traceTemplate(next, visited, template, array);
    }
  }

  matchBranches(nodes) {
    const vals = [];
    for (const nbrs of nodes.values()) {
      const c = new Map();
      for (const nbr of nbrs) {
        const k = this.graph.isElement(nbr) ? this.graph.element(nbr).abstract_name : "net";
        c.set(k, (c.get(k) ?? 0) + 1);
      }
      vals.push(c);
    }
    const main = vals.pop();
    const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
    return vals.every((v) => same(v, main));
  }

  checkNonConvergence(match) {
    const vals = [];
    for (const val of match.values()) {
      const common = val.filter((x) => vals.includes(x));
      if (common.some((n) => this.graph.isElement(n))) return false;
      vals.push(...val);
    }
    return true;
  }

  addAlignBlockConst() {
    for (const insts of this.alignBlock.values()) {
      const h = insts.filter((i) => this.graph.hasNode(i));
      if (!h.length) continue;
      for (const c of this.iconst) if (c.constraint === "Align" && c.instances.every((x) => h.includes(x))) return;
      this.iconst.append(Constraint.create(this.iconst, { constraint: "SameTemplate", instances: h }));
      const b0 = this.ckt.getElement(h[0]);
      let differ = false;
      for (const b of h) {
        const b1 = this.ckt.getElement(b);
        if (!samePins(b0.pins, b1.pins)) { differ = true; break; }
      }
      if (differ) this.iconst.append(Constraint.create(this.iconst, { constraint: "Align", line: "h_bottom", instances: h }));
      else this.iconst.append(Constraint.create(this.iconst, { constraint: "AlignInOrder", direction: "horizontal", instances: h }));
    }
  }

  addNewArrayHier() {
    const sub = new PySet();
    for (const [key, a2] of this.newHier) {
      let all = a2.flat().filter((i) => this.graph.hasNode(i) && !sub.has(i));
      const count = new Map();
      for (const i of all) count.set(i, (count.get(i) ?? 0) + 1);
      const repeated = new PySet([...count].filter(([, c]) => c > 1).map(([i]) => i));
      const allSet = new PySet(all).difference(repeated);
      const arr = a2.map((row) => [...new PySet(row).difference(repeated)]);
      sub.update(allSet);
      if (allSet.size <= 1) continue;
      const hierName = "ARRAY_HIER_" + key;
      createNewHierarchy(this.dl, this.name, hierName, [...allSet]);
      const names = [];
      for (const t of arr) {
        const tn = this.newSubcktName("ARRAY_TEMPLATE");
        createNewHierarchy(this.dl, hierName, tn, t);
        names.push(tn);
      }
      const hc = this.dl.find(hierName).constraints;
      const insts = names.map((m) => "X_" + m);
      hc.append(Constraint.create(hc, { constraint: "Align", line: "h_bottom", instances: insts }));
      hc.append(Constraint.create(hc, { constraint: "SameTemplate", instances: insts }));
    }
  }

  newSubcktName(name) {
    let count = 1, n = name;
    while (this.ckt.parent.find(n)) { n = name + String(count); count++; }
    return n;
  }
}

function samePins(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

export function createNewHierarchy(dl, parentName, childName, elements, pinsMap = null) {
  const parent = dl.find(parentName);
  if (!pinsMap) {
    let pm = new Map();
    const G = new AGraph(parent);
    for (const e of elements) if (parent.getElement(e)) for (const net of G.neighbors(e)) pm.set(net, net);
    pinsMap = new Map([...pm.keys()].filter((net) => parent.pins.includes(net) || G.neighbors(net).some((x) => !elements.includes(x))).map((n) => [n, n]));
  }
  if (!pinsMap.size) throw new Error("can't create module with no pins");
  if (dl.find(childName)) throw new Error(`subcircuit ${childName} already existing`);
  const child = SubCircuit.create(dl, { name: childName, pins: [...pinsMap.keys()] });
  dl.append(child);
  const pes = [];
  for (const e of elements) {
    const pe = parent.getElement(e);
    if (pe) { pes.push(pe); child.elements.push(pe); }
  }
  for (const c of [...parent.constraints]) {
    if (["HorizontalDistance", "VerticalDistance", "BlockDistance", "CompactPlacement"].includes(c.constraint)) child.constraints.append(c);
  }
  const instName = "X_" + childName;
  for (const pe of pes) parent.elements.splice(parent.elements.indexOf(pe), 1);
  parent.elements.push(Instance.create(parent, { name: instName, model: childName, pins: pinsMap, abstract_name: childName }));
}
