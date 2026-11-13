/** 회로 그래프 — ALIGN schema/graph.py (Graph) 의 JS 판.
 *
 *  서브회로 하나를 "소자 — 넷" 그래프로 감싼다 (서브회로를 그 자리에서 고친다). 변 속성 pin 은 그 소자가
 *  그 넷에 닿는 핀 이름의 집합이다.
 *
 *    findSubgraphMatches(틀 그래프, skip)    틀과 같은 모양의 부분들 (겹치지 않게, 틀의 제약이 성립하는 것만)
 *    replaceMatchingSubgraph(틀 그래프, skip) 찾은 부분을 새 서브회로 인스턴스(X_<소자들>)로 바꾼다
 *                                            새 서브회로 이름 = 틀 이름 + 꼬리표(내용의 sha256)
 */
import { NxGraph, GraphMatcher } from "./nx.mjs";
import { Instance, SubCircuit } from "./schema.mjs";
import { Constraint } from "./constraint.mjs";
import { ConstraintTranslator } from "./translator.mjs";
import { PySet, pyCmp } from "../py.mjs";
import { flatKey } from "./util.mjs";

export class AGraph extends NxGraph {
  /** @param {import("./schema.mjs").SubCircuit} subckt */
  constructor(subckt) {
    super();
    this.subckt = subckt;
    for (const e of subckt.elements) this._addToGraph(e);
  }
  get name() { return this.subckt.name; }
  _addToGraph(e) {
    for (const [pin, net] of e.pins) {
      if (this.hasEdge(e.name, net)) this.getEdgeData(e.name, net).pin.add(pin);
      else {
        this.addEdge(e.name, net, { pin: new PySet([pin]) });
        this.nodeAttrs(e.name).instance = e;
      }
    }
  }
  get elements() { return [...this._node.values()].filter((v) => "instance" in v).map((v) => v.instance); }
  element(name) {
    const a = this._node.get(name);
    if (!a || !("instance" in a)) throw new Error(`no element ${name}`);
    return a.instance;
  }
  isElement(n) { const a = this._node.get(n); return !!a && "instance" in a; }
  addInstance(data) {
    const e = Instance.create(this.subckt, data);
    this.subckt.elements.push(e);
    this._addToGraph(e);
    return e;
  }
  /** 소자를 회로와 그래프에서 지운다 (이 소자에만 닿던 넷도) */
  remove(element) {
    const els = this.subckt.elements;
    let i = els.indexOf(element);
    if (i < 0) i = els.findIndex((x) => x.name === element.name && x.model === element.model);
    if (i < 0) throw new Error("list.remove(x): x not in list");
    els.splice(i, 1);
    this.removeNodesFrom(this.neighbors(element.name).filter((x) => this.degree(x) === 1));
    this.removeNode(element.name);
  }

  static defaultNodeMatch(x, y) {
    const a = x.instance, b = y.instance;
    if (a instanceof Instance && b instanceof Instance) return [...a.mclass.bases, a.model].includes(b.model);
    // 둘 다 넷이면 참 (isinstance(None, NoneType))
    return a === undefined ? b === undefined : b !== undefined && a instanceof b.constructor;
  }
  static defaultEdgeMatch(x, y) { return x.pin.equals(y.pin); }

  findSubgraphMatches(graph, skip = null) {
    const matcher = new GraphMatcher(this, graph, AGraph.defaultNodeMatch, AGraph.defaultEdgeMatch);
    const correct = [];
    const temp = this.subckt.constraints.length;
    const all = [...matcher.subgraphIsomorphisms()].map((m) => new Map(m));
    const key = (m) => [...m].map(([x, y]) => [x, y]);
    const matches = all.map((m) => [key(m), m]).sort((a, b) => pyCmp(a[0], b[0])).map(([, m]) => m);
    for (const match of matches) {
      if (skip && [...match.keys()].some((k) => skip.includes(k))) continue;
      const taken = [...match.keys()].some((node) => this.isElement(node) && correct.some((x) => x.has(node)));
      if (taken) continue;
      try {
        this.checkConstraintSatisfiability(graph, match);
        correct.push(match);
      } catch {
        // 틀의 제약이 이 회로에서 성립하지 않으면 묶지 않는다
      }
    }
    while (this.subckt.constraints.length > temp) this.subckt.constraints.pop();
    return correct;
  }

  checkConstraintSatisfiability(subgraph, match) {
    const db = this.subckt.constraints;
    for (const c of subgraph.subckt.constraints) {
      if (c.constraint === "SymmetricBlocks") {
        const t = c.pairs.map((pair) => pair.map((ele) => this._getKey(ele, match)));
        const x = Constraint.create(db, { constraint: "SymmetricBlocks", direction: c.direction, pairs: t });
        if (!db.items.some((y) => y.equals(x))) db.append(x);
        if (!db.includes(x)) throw new Error(`constraint: ${x.reprKey()} not found`);
        db.remove(x);
      } else if (c.constraint === "SymmetricNets") {
        const pair = [this._getKey(c.net1, match), this._getKey(c.net2, match)];
        const [n1, n2] = this.allNeighborsDist(pair);
        if (!sameCounter(n1, n2)) throw new Error(`neighbors mismatch`);
      }
    }
  }

  allNeighborsDist(pair) {
    const count = (n) => {
      const c = new Map();
      for (const nbr of this.neighbors(n)) { const m = this.element(nbr).model; c.set(m, (c.get(m) ?? 0) + 1); }
      return c;
    };
    return [count(pair[0]), count(pair[1])];
  }

  _getKey(val, map) {
    for (const [k, v] of map) if (val === v) return k;
    return undefined;
  }

  replaceMatchingSubgraph(subgraph, skip = null) {
    const matches = this.findSubgraphMatches(subgraph, skip);
    return this._replaceMatchesWithSubckt(matches, subgraph.subckt, skip);
  }

  _replaceMatchesWithSubckt(matches, subckt, skip = null) {
    const names = [];
    for (const match of matches) {
      if (![...match.keys()].every((x) => this.hasNode(x))) throw new Error("an earlier replacement broke this match");
      if (new Set(subckt.pins).size !== subckt.pins.length) throw new Error(`duplicate pins found in module ${subckt.name}`);
      const removal = [...match].filter(([, y]) => !subckt.pins.includes(y)).map(([x]) => x);
      if (!removal.every((node) => this.neighbors(node).every((x) => match.has(x)))) continue;
      if (skip && removal.some((r) => skip.includes(r)) && removal.length > 1) continue;
      const nsub = this.createSubcktInstance(subckt, match);
      names.push(nsub.name);
      const nodes = [];
      for (const node of [...removal].sort(pyCmp)) {
        if (this.hasNode(node) && this.isElement(node)) {
          nodes.push(node);
          this.remove(this.element(node));
        }
      }
      const instName = `X_${nodes.join("_")}`;
      const db = this.subckt.constraints;
      const gc = subckt.constraints.items.filter((c) => c.constraint === "Generator");
      const genParam = gc.length ? Object.fromEntries(Object.entries(gc[0].dict()).filter(([k]) => k !== "constraint")) : null;
      if (nodes.length >= 1) {
        const temp = Constraint.create(db, { constraint: "GroupBlocks", instance_name: instName, template_name: subckt.name, instances: nodes, generator: genParam });
        if (!db.includes(temp)) db.append(temp);
      }
      const pin2net = new Map();
      for (const [net, pin] of match) if (subckt.pins.includes(pin)) pin2net.set(pin, net);
      if (!subckt.pins.every((p) => pin2net.has(p))) throw new Error(`not all pins of ${subckt.name} were matched`);
      this.addInstance({ name: instName, model: nsub.name, pins: pin2net });
      if (this.subckt.name) {
        const tr = new ConstraintTranslator(this.subckt.parent, this.subckt.name, nsub);
        tr.updateConst(instName, new Map([...match].filter(([k]) => removal.includes(k))));
      }
    }
    return names;
  }

  /** 틀(subckt)과 맞춘 소자들로 새 서브회로를 만든다 — 이름은 틀 이름 + 내용의 꼬리표 */
  createSubcktInstance(subckt, match) {
    const lib = this.subckt.parent;
    const inst = SubCircuit.create(lib, { name: subckt.name, pins: subckt.pins, parameters: subckt.parameters, generator: subckt.generator });
    for (const [x, y] of match) {
      const el = subckt.getElement(y);
      if (!el) continue;
      const src = this.nodeAttrs(x).instance;
      inst.elements.push(Instance.create(inst, { name: el.name, model: src.model, pins: el.pins, parameters: src.parameters }));
    }
    for (const c of subckt.constraints) inst.constraints.append(c);
    if (this.subckt.name) {
      const tr = new ConstraintTranslator(lib, this.subckt.name, inst);
      tr.topToBottom(match);
    }
    const d = inst.dictUnset();
    const key = flatKey(d);
    const nsub = SubCircuit.create(lib, { ...d, name: d.name + key });
    if (!lib.find(nsub.name)) lib.append(nsub);
    return nsub;
  }
}

function sameCounter(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
