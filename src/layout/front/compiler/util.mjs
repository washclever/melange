/** 컴파일러 도우미 — ALIGN compiler/util.py 의 JS 판.
 *
 *    getNextLevel        전원에서 접지 쪽으로 걸을 때 다음 마디 (트랜지스터는 G/B 로는 건너지 않는다)
 *    getBaseModel        소자의 바탕 모델 (NMOS/PMOS/...)
 *    getLeafConnection   넷이 맨 아래 소자의 어느 핀에 닿는가
 *    leafWeights / reducedNeighbors / reducedSDNeighbors / getPortsWeight
 *    genKey(사전)        이름 꼬리표 "_12345678" (변수를 정렬해 sha256)
 *    flatKey(사전)       FlatDict 로 펴서 같은 꼬리표 (새 서브회로 이름)
 *    createNodeId / compareTwoNodes   대칭 찾기에서 두 마디가 같은 종류인가
 */
import { AGraph } from "./graph.mjs";
import { PySet, pyCmp, pyStr } from "../py.mjs";
import { alignKey } from "../sha256.mjs";

/** ports_weight 의 빈 칸 — ALIGN 은 빈 집합이 아니라 빈 사전({})을 넣는다 */
export const EMPTY_DICT = Object.freeze({ __emptyDict: true });

export const sortedStr = (xs) => [...xs].sort(pyCmp);

export function getNextLevel(subckt, G, treeL1) {
  const next = [];
  for (const node of [...treeL1]) {
    const el = subckt.getElement(node);
    if (!el && !subckt.nets.includes(node)) throw new Error(`${node} not present in ${subckt.name}`);
    const bm = el ? getBaseModel(subckt, node) : null;
    if (el && bm && bm.includes("MOS")) {
      for (const nbr of G.neighbors(node)) {
        const pins = G.getEdgeData(node, nbr).pin;
        if ([...pins].some((p) => p !== "G" && p !== "B")) next.push(nbr);
      }
    } else if (subckt.nets.includes(node)) {
      for (const nbr of G.neighbors(node)) next.push(nbr);
    } else {
      throw new Error(`cannot walk ${node}`);
    }
  }
  return next;
}

export function getBaseModel(subckt, node) {
  const el = subckt.getElement(node);
  if (!el) throw new Error(`node ${node} not found in subckt ${subckt.name}`);
  const cm = el.model;
  const def = subckt.parent.find(cm);
  if (!def) throw new Error(`no model ${cm}`);
  if (def.kind === "SubCircuit" && def.elements.length === 1) return getBaseModel(def, def.elements[0].name);
  if (def.kind === "Model") return def.base || cm;
  return cm;
}

export function getLeafConnection(subckt, net) {
  const conn = [];
  if (!subckt.nets.includes(net)) return conn;
  const g = new AGraph(subckt);
  for (const nbr of g.neighbors(net)) {
    for (const pin of g.getEdgeData(net, nbr).pin) {
      const s = subckt.parent.find(g.nodeAttrs(nbr).instance.model);
      if (s && s.kind === "SubCircuit" && s.name !== subckt.name) conn.push(...getLeafConnection(s, pin));
      else conn.push(pin);
    }
  }
  return conn;
}

function pinOf(inst, net) {
  for (const [p, n] of inst.pins) if (n === net) return p;
  throw new Error(`net ${net} not connected to ${inst.name}`);
}

/** leaf_weights(G, node, nbr) -> PySet */
export function leafWeights(G, node, nbr) {
  const subckt = G.subckt;
  let conn;
  const el = subckt.getElement(node);
  if (el) {
    if (!subckt.nets.includes(nbr)) throw new Error(`net ${nbr} not in ${subckt.name}`);
    const s = subckt.parent.find(el.model);
    const p = pinOf(el, nbr);
    conn = s && s.kind === "SubCircuit" ? new PySet(getLeafConnection(s, p)) : G.getEdgeData(node, nbr).pin;
  } else {
    if (!subckt.nets.includes(node)) throw new Error(`net ${node} not in ${subckt.name}`);
    const n = subckt.getElement(nbr);
    const s = subckt.parent.find(n.model);
    const p = pinOf(n, node);
    conn = s && s.kind === "SubCircuit" ? new PySet(getLeafConnection(s, p)) : G.getEdgeData(node, nbr).pin;
  }
  return new PySet(sortedStr(conn));
}

export const reducedNeighbors = (G, node, nbr) => {
  const c = leafWeights(G, node, nbr);
  return !(c.size === 1 && c.has("B"));
};
export const reducedSDNeighbors = (G, node, nbr) => [...leafWeights(G, node, nbr)].some((p) => p !== "B" && p !== "G");

/** get_ports_weight -> Map(포트 -> PySet | EMPTY_DICT) */
export function getPortsWeight(G) {
  const out = new Map();
  for (const port of G.subckt.pins) {
    const lc = getLeafConnection(G.subckt, port);
    out.set(port, lc.length ? new PySet(sortedStr(lc)) : EMPTY_DICT);
  }
  return out;
}

/** ports_weight 값 비교 (집합끼리, 빈 사전끼리) */
export function weightEq(a, b) {
  if (a === EMPTY_DICT || b === EMPTY_DICT) return a === b;
  return a.equals(b);
}
export const weightTruthy = (a) => a !== EMPTY_DICT && a.size > 0;

/** gen_key(param) */
export function genKey(param) {
  const entries = param instanceof Map ? [...param] : Object.entries(param);
  const keys = entries.map(([k]) => k).sort(pyCmp);
  const m = new Map(entries);
  return alignKey(keys.map((k) => `${k}:${pyStr(m.get(k))}`).join("_"));
}

/** FlatDict(d) — 비지 않은 사전만 ":" 로 편다 (목록·빈 사전은 잎) */
export function flatDict(d, prefix = "", out = new Map()) {
  const entries = d instanceof Map ? [...d] : Object.entries(d);
  for (const [k, v] of entries) {
    const key = prefix ? `${prefix}:${k}` : String(k);
    const isDict = v && typeof v === "object" && !Array.isArray(v) && !(v instanceof PySet) && !v.__tuple;
    const size = isDict ? (v instanceof Map ? v.size : Object.keys(v).length) : 0;
    if (isDict && size > 0) flatDict(v, key, out);
    else out.set(key, v);
  }
  return out;
}

/** FlatDict 로 편 사전의 꼬리표 (gen_group_key, create_subckt_instance) */
export function flatKey(d) {
  const flat = flatDict(d);
  const keys = [...flat.keys()].sort(pyCmp);
  return alignKey(keys.map((k) => `${k}:${pyStr(flat.get(k))}`).join("_"));
}

/** create_node_id */
export function createNodeId(G, node, portsWeight = null) {
  const inst = G.nodeAttrs(node).instance;
  if (inst) {
    const props = new Map([["model", inst.model], ["n_pins", new Set(inst.pins.values()).size]]);
    if (inst.parameters && Object.keys(inst.parameters).length) for (const [k, v] of Object.entries(inst.parameters)) props.set(k, v);
    return genKey(props);
  }
  const nbrs = G.neighbors(node).filter((nbr) => reducedSDNeighbors(G, node, nbr));
  const props = nbrs.map((nbr) => G.nodeAttrs(nbr).instance.model);
  if (portsWeight && portsWeight.has(node)) {
    const w = portsWeight.get(node);
    if (w !== EMPTY_DICT) for (const p of w) props.push(pyStr(p));
  } else {
    for (const nbr of nbrs) props.push(pyStr(leafWeights(G, node, nbr)));
  }
  props.sort(pyCmp);
  return alignKey(props.join("_"));
}

export const compareTwoNodes = (G, a, b, pw = null) => createNodeId(G, a, pw) === createNodeId(G, b, pw);
