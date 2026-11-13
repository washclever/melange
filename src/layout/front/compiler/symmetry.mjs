/** 대칭 제약 찾기 — ALIGN compiler/find_constraint.py 의 JS 판.
 *
 *  전원·접지·클록이 아닌 포트 쌍에서 출발해 회로를 두 갈래로 함께 걷는다. 두 갈래의 마디가 같은 종류면
 *  (createNodeId) 짝으로 적고 계속 걷는다. 결과로 SymmetricBlocks(짝 소자)와 SymmetricNets(짝 넷) 를 단다.
 *  팬아웃이 큰 넷(이웃 10 개 초과)은 배열(array) 찾기의 출발점이 된다 (arrays.mjs).
 *
 *    constraintGenerator(lib)   생성기가 없는 서브회로마다 FindConst
 */
import { AGraph } from "./graph.mjs";
import { Constraint, expandUserConstraints } from "./constraint.mjs";
import {
  compareTwoNodes, getBaseModel, reducedNeighbors, reducedSDNeighbors, getLeafConnection, getPortsWeight,
  weightEq, weightTruthy, sortedStr,
} from "./util.mjs";
import { ProcessArrays } from "./arrays.mjs";
import { PySet, pyCmp } from "../py.mjs";

const isSub = (x) => x && x.kind === "SubCircuit";
const pk = (a, b) => JSON.stringify([a, b]);
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
/** 목록에 같은 집합(또는 같은 문자열)이 있는가 — 파이썬 `x in list` */
export const listHas = (list, x) => list.some((y) => (x instanceof Set ? y instanceof Set && setEq(x, y) : y === x));

function findUniqueMatchingBranches(G, nbrs1, nbrs2, pw) {
  const match = new Map();
  for (const n1 of nbrs1) {
    for (const n2 of nbrs2) {
      if (compareTwoNodes(G, n1, n2, pw)) {
        if (match.has(n1)) return false;
        match.set(n1, n2);
      }
    }
    if (!match.has(n1)) return false;
  }
  return match;
}

function compareNodes(G, matchPairs, matchPair, traversed, node1, node2, pw) {
  const reduce = (n) => {
    const nb = sortedStr(G.neighbors(n).filter((x) => !traversed.has(x)));
    return sortedStr([...new Set(nb.filter((x) => reducedNeighbors(G, n, x)))]);
  };
  const nbrs1 = reduce(node1), nbrs2 = reduce(node2);
  if (!nbrs1.length || !nbrs2.length) {
    if (compareTwoNodes(G, node1, node2, pw)) matchPair.set(node1, node2);
    return;
  }
  if (nbrs1.length > 10) {
    if (matchPair.get("array_start_point")) throw new Error("incorrect symmetry branch");
    matchPair.set("array_start_point", [node1, node2]);
    traversed.add(node1);
    return;
  }
  if (node1 === node2) {
    if (matchPair.has(node1) || [...matchPair.values()].includes(node1)) return;
    const sd = nbrs1.filter((nbr) => reducedSDNeighbors(G, node1, nbr));
    if (sd.length === 0) matchPair.set(node1, node1);
    else if (sd.length === 1) {
      matchPair.set(node1, node1);
      traversed.add(node1);
      compareNodes(G, matchPairs, matchPair, traversed, sd[0], sd[0], pw);
    } else {
      matchPair.set(node1, node1);
      traversed.add(node1);
      const sp = sortedStr(new Set(sd.filter((x) => !traversed.has(x))));
      let local = new Map();
      for (let i = 0; i < sp.length; i++) for (let j = i + 1; j < sp.length; j++) {
        const np = new Map();
        compareNodes(G, matchPairs, np, new Set(traversed), sp[i], sp[j], pw);
        if (np.size) local.set(pk(sp[i], sp[j]), np);
      }
      local = new Map([...local].filter(([, v]) => v.size > 0));
      if (local.size === 1) for (const [k, v] of [...local.values()][0]) matchPair.set(k, v);
      else {
        for (const n of sp) {
          if (matchPairs.has(pk(n, n))) continue;
          const np = new Map();
          compareNodes(G, matchPairs, np, new Set(traversed), n, n, pw);
          if (np.size) matchPairs.set(pk(n, n), np);
        }
      }
    }
  } else if (compareTwoNodes(G, node1, node2, pw)) {
    matchPair.set(node1, node2);
    traversed.add(node1); traversed.add(node2);
    const w1 = nbrs1.flatMap((nbr) => [...G.getEdgeData(node1, nbr).pin]);
    const w2 = nbrs2.flatMap((nbr) => [...G.getEdgeData(node2, nbr).pin]);
    const unique = findUniqueMatchingBranches(G, nbrs1, nbrs2, pw);
    if (unique) {
      matchPair.set(node1, node2);
      traversed.add(node1); traversed.add(node2);
      for (const [a, b] of unique) compareNodes(G, matchPairs, matchPair, new Set(traversed), a, b, pw);
    } else if (w1.length > new Set(w1).size && new Set(w1).size > 1 && w2.length > new Set(w2).size && new Set(w2).size > 1) {
      matchPair.set(node1, node2);
      if (matchPair.get("array_start_point")) throw new Error("incorrect symmetry branch");
      matchPair.set("array_start_point", [node1, node2]);
    }
    // 그 밖: 파이썬은 지역 변수만 {} 로 바꾼다 (부른 쪽의 짝은 그대로)
  }
}

function recursiveStartPoints(G, matchPairs, traversed, n1, n2, pw) {
  const pair = new Map();
  if (G.hasNode(n1) && G.hasNode(n2)) compareNodes(G, matchPairs, pair, traversed, n1, n2, pw);
  if (!pair.size) return;
  matchPairs.set(pk(n1, n2), pair);
}

export function findSymmetry(subckt, stopPoints) {
  const graph = new AGraph(subckt);
  let matchPairs = new Map();
  const nonPower = sortedStr([...new Set(subckt.pins)].filter((p) => !stopPoints.has(p)));
  const pw = getPortsWeight(graph);
  for (let i = 0; i < nonPower.length; i++) for (let j = i; j < nonPower.length; j++) {
    const p1 = nonPower[i], p2 = nonPower[j];
    const traversed = new Set(stopPoints);
    if (weightEq(pw.get(p1), pw.get(p2)) && weightTruthy(pw.get(p2))) {
      traversed.add(p1); traversed.add(p2);
      recursiveStartPoints(graph, matchPairs, traversed, p1, p2, pw);
      matchPairs = new Map([...matchPairs].filter(([, v]) => v.size > 0));
    }
  }
  return matchPairs;
}

export function constraintGenerator(lib) {
  for (let i = 0; i < lib.items.length; i++) {
    const s = lib.items[i];
    if (!isSub(s)) continue;
    if (!s.constraints.items.some((c) => c.constraint === "Generator") && !s.name.toUpperCase().includes("ARRAY_HIER_")) findConst(s);
  }
}

function findConst(subckt) {
  const stop = new Set();
  let auto = true;
  for (const c of subckt.constraints) {
    if (["PowerPorts", "GroundPorts", "ClockPorts"].includes(c.constraint)) for (const p of c.ports) stop.add(p);
    else if (c.constraint === "ConfigureCompiler") auto = !c.is_digital && c.auto_constraint;
  }
  const pp = new ProcessInputConst(subckt);
  const written = pp.processAll();
  if (!auto) return;
  let matchPairs = findSymmetry(subckt, stop);
  const arr = new ProcessArrays(subckt, matchPairs);
  arr.addAlignBlockConst();
  arr.addNewArrayHier();
  matchPairs = new Map([...matchPairs].filter(([, v]) => v.size > 1));
  const skip = written.slice();
  const add = new AddSymmetryConst(subckt, matchPairs, stop, written, skip);
  add.loopThroughPairs();
}

class ProcessInputConst {
  constructor(subckt) {
    this.list = [];
    this.subckt = subckt;
    this.G = new AGraph(subckt);
    this.iconst = subckt.constraints;
  }
  processAll() {
    this.processSymmnet();
    for (const c of expandUserConstraints(this.iconst)) if (c.constraint === "DoNotIdentify") this.list.push(...c.instances);
    return this.list;
  }
  processSymmnet() {
    const replace = [], newBlocks = [];
    for (const c of this.iconst) {
      if (c.constraint !== "SymmetricNets") continue;
      let pairs;
      if (!c.pins1 || c.pins1.length === 0) {
        const [p, s1, s2] = symmnetDevicePairs(this.G, c.net1.toUpperCase(), c.net2.toUpperCase(), this.list, null, true);
        if (!s1) throw new Error(`no connections found to net ${c.net1} in subcircuit ${this.subckt.name}, fix user const`);
        if (!s2) throw new Error(`no connections found to net ${c.net2} in subcircuit ${this.subckt.name}, fix user const`);
        replace.push([c, Constraint.create(this.iconst, { constraint: "SymmetricNets", direction: c.direction, net1: c.net1.toUpperCase(), net2: c.net2.toUpperCase(), pins1: s1, pins2: s2 })]);
        pairs = p;
      } else {
        const pinPairs = new Map(), dup = [];
        for (let i = 0; i < c.pins1.length; i++) {
          if (pinPairs.has(c.pins1[i])) dup.push(i);
          else if (!this.subckt.pins.includes(c.pins1[i])) pinPairs.set(c.pins1[i], c.pins2[i]);
        }
        for (const i of dup.sort((a, b) => b - a)) { c.pins1.splice(i, 1); c.pins2.splice(i, 1); }
        pairs = new Map([...pinPairs].map(([k, v]) => [k.split("/")[0], v.split("/")[0]]));
      }
      const pj = [];
      for (const [k, v] of pairs) {
        if (this.subckt.pins.includes(k)) continue;
        if (k !== v && !listHas(this.list, new Set([k, v]))) { this.list.push(new Set([k, v])); pj.push([k, v]); }
        else if (!listHas(this.list, k)) { this.list.push(k); pj.push([k]); }
      }
      if (pj.length > 0 && !(pj.length === 1 && pj[0].length === 1)) newBlocks.push(Constraint.create(this.iconst, { constraint: "SymmetricBlocks", direction: "V", pairs: pj }));
    }
    for (const [k, v] of replace) {
      if (!k.equals(v)) {
        this.iconst.remove(k);
        this.iconst.append(v);
        this.list.push(v.net1);
        this.list.push(v.net2);
      }
    }
    for (const sb of newBlocks) {
      const mine = new Set(sb.pairs.map((p) => JSON.stringify(p)));
      const covered = this.iconst.items.some((c) => c.constraint === "SymmetricBlocks" && [...mine].every((p) => c.pairs.some((q) => JSON.stringify(q) === p)));
      if (!covered) this.iconst.append(sb);
    }
  }
}

class AddSymmetryConst {
  constructor(subckt, matchPairs, stop, written, skip) {
    const asym = (m) => [...m].filter(([k, v]) => k !== v).length;
    this.allPairs = [...matchPairs.values()].map((v, i) => [v, i]).sort((a, b) => asym(b[0]) - asym(a[0]) || a[1] - b[1]).map(([v]) => v);
    this.written = written;
    this.subckt = subckt;
    this.G = new AGraph(subckt);
    this.iconst = subckt.constraints;
    this.stop = stop ?? new Set();
    this.skip = skip;
  }
  loopThroughPairs() {
    let pj = null;
    for (const pairs of this.allPairs) {
      const p = [...pairs].sort((a, b) => pyCmp(a[0], b[0]));
      pj = this.filterSymblockConst(p);
      addOrRevertConst(pj, this.iconst, this.written);
    }
    for (const pairs of this.allPairs) {
      const p = [...pairs].sort((a, b) => pyCmp(a[0], b[0]));
      this.filterSymnetConst(p);
      // 파이썬은 여기서 첫 고리의 마지막 pairsj 를 다시 넣는다 (같은 제약이라 거의 늘 걸러진다)
      addOrRevertConst(pj, this.iconst, this.written);
    }
  }
  preFilter(key, value) {
    const smb = new Set();
    if (typeof key !== "string") throw new Error(`invlid instance ${key}`);
    if (typeof value !== "string") throw new Error(`invlid instance ${value}`);
    for (const inst of this.written) {
      if (typeof inst === "string") smb.add(inst);
      else for (const x of inst) smb.add(x);
    }
    if (this.stop.has(key)) throw new Error(`No constraints should be generated for power ports ${key}`);
    if (smb.has(key) || smb.has(value)) return true;
    if (!this.G.hasNode(key)) return true;
    if (this.subckt.nets.includes(key)) {
      const [a, b] = this.G.allNeighborsDist([key, value]);
      if (a.size !== b.size || [...a].some(([k, v]) => b.get(k) !== v)) return true;
    }
    return false;
  }
  filterSymblockConst(pairs) {
    const pj = [];
    const single = new Set();
    for (const [key, value] of pairs) {
      if (this.preFilter(key, value)) continue;
      if (single.has(key) || single.has(value)) continue;
      if (!this.G.nodeAttrs(key).instance) continue;
      const bm = getBaseModel(this.subckt, key);
      if (key === value && ["NMOS", "PMOS", "RES", "CAP"].includes(bm)) continue;
      if (key !== value) { pj.push([key, value]); single.add(key); single.add(value); }
      else { pj.push([key]); single.add(key); }
    }
    return pj;
  }
  filterSymnetConst(pairs) {
    for (const [key, value] of pairs) {
      if (this.preFilter(key, value)) continue;
      if (this.G.nodeAttrs(key).instance) continue;
      if (key === value) continue;
      const [p, s1, s2] = symmnetDevicePairs(this.G, key, value, this.written, this.skip);
      if (p) {
        this.written.push(new Set([key, value]));
        this.iconst.append(Constraint.create(this.iconst, { constraint: "SymmetricNets", direction: "V", net1: key, net2: value, pins1: s1, pins2: s2 }));
      }
    }
  }
}

function addOrRevertConst(pj, iconst, written) {
  if (!pj) return;
  if (pj.length > 1 || (pj.length && pj[0].length === 2)) {
    try {
      const sb = Constraint.create(iconst, { constraint: "SymmetricBlocks", direction: "V", pairs: pj });
      iconst.append(sb);
      written.push(...pj.map((p) => new Set(p)));
    } catch {
      // 파이썬도 조용히 넘어간다
    }
  }
}

/** symmnet_device_pairs — 두 넷에 닿은 (소자, 핀) 들을 짝짓는다 */
export function symmnetDevicePairs(G, netA, netB, smb = [], skipBlocks = null, user = false) {
  const connection = (net) => {
    if (!G.hasNode(net)) throw new Error(`net ${net} is not in the graph`);
    const conn = new Map();
    for (const nbr of G.neighbors(net)) {
      const pins = G.getEdgeData(net, nbr).pin;
      const child = G.subckt.parent.find(G.nodeAttrs(nbr).instance.model);
      if (isSub(child)) {
        for (const pin of pins) {
          const lc = new PySet(sortedStr(getLeafConnection(child, pin).filter((c) => c !== "B")));
          if (lc.size) conn.set(JSON.stringify([nbr, pin]), { key: [nbr, pin], val: lc });
        }
      } else {
        for (const pin of pins) if (pin !== "B") conn.set(JSON.stringify([nbr, pin]), { key: [nbr, pin], val: [pin] });
      }
    }
    if (G.subckt.pins.includes(net)) conn.set(net, { key: net, val: new PySet(sortedStr(getLeafConnection(G.subckt, net).filter((c) => c !== "B"))) });
    return conn;
  };
  const valEq = (a, b) => {
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
    return a.equals(b);
  };
  const cA = connection(netA), cB = connection(netB);
  if (!cA.size) throw new Error(`No connection to net ${netA} found in ${G.subckt.name}`);
  if (!cB.size) throw new Error(`No connection to net ${netA} found in ${G.subckt.name}`);
  const pairs = new Map(), pinsA = [], pinsB = [];
  for (const { key: ea, val: va } of cA.values()) {
    for (const { key: eb, val: vb } of cB.values()) {
      if (Array.isArray(ea) && Array.isArray(eb)) {
        const a = ea[0], b = eb[0];
        if (skipBlocks && (skipBlocks.includes(a) || skipBlocks.includes(b))) continue;
        const ia = G.nodeAttrs(a).instance, ib = G.nodeAttrs(b).instance;
        if (!ia) throw new Error(`Block,${a} not found`);
        if (!ib) throw new Error(`Block,${b} not found`);
        if (valEq(va, vb) && ia.model === ib.model) {
          if ([...pairs.values()].includes(b)) return [null, null, null]; // 여러 짝이 맞으면 대칭 넷이 아니다
          else if (!user && !listHas(smb, new Set([a, b]))) continue;
          // 파이썬: ele_A not in pinsA — pinsA 에는 "블록/핀" 문자열만 있어 튜플은 늘 없다
          pairs.set(a, b);
          pinsA.push(ea.join("/"));
          pinsB.push(eb.join("/"));
        }
      } else if (!Array.isArray(ea) && !Array.isArray(eb) && valEq(va, vb) && !pinsA.includes(ea) && !pinsB.includes(eb)) {
        pairs.set(ea, eb);
        pinsA.push(ea);
        pinsB.push(eb);
      }
    }
  }
  if (pairs.size > 1) return [pairs, pinsA, pinsB];
  return [null, null, null];
}
