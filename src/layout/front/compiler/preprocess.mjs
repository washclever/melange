/** 전처리 — ALIGN compiler/preprocess.py 의 JS 판.
 *
 *  서브회로마다 (ConfigureCompiler 로 끌 수 있다):
 *    defineSD           전원에서 걸어 PMOS 의 S 가 높은 쪽, NMOS 의 D 가 높은 쪽이 되게 D/S 를 바꾼다
 *    addParallel        같은 넷·같은 변수의 병렬 소자를 하나로 (PARALLEL = 개수)
 *    addSeries          D-S 로 이어진 같은 소자를 하나로 (STACK 을 더한다)
 *    removeDummies      꺼진 트랜지스터(PMOS 게이트가 전원, NMOS 게이트가 접지, D=G=S)를 지운다
 *    sameTemplate       같은 서브회로·같은 변수의 인스턴스들에 SameTemplate 제약
 *  그리고 맨 위에서부터 소자 하나짜리 계층을 펼친다.
 */
import { AGraph } from "./graph.mjs";
import { Instance } from "./schema.mjs";
import { Constraint } from "./constraint.mjs";
import { getNextLevel, getBaseModel, genKey } from "./util.mjs";
import { PySet, pyCmp } from "../py.mjs";

const isSub = (x) => x && x.kind === "SubCircuit";

function configure(subckt) {
  const o = { digital: false, fixSD: true, series: true, parallel: true, dummies: true, same: true, dummyHier: true };
  for (const c of subckt.constraints) {
    if (c.constraint !== "ConfigureCompiler") continue;
    o.digital = c.is_digital;
    o.fixSD = c.fix_source_drain;
    o.series = c.merge_series_devices;
    o.parallel = c.merge_parallel_devices;
    o.dummies = c.remove_dummy_devices;
    o.same = c.same_template;
    o.dummyHier = c.remove_dummy_hierarchies;
  }
  return o;
}

export function preprocessStackParallel(lib, designName) {
  const top = lib.find(designName);
  for (const s of [...lib]) {
    if (!isSub(s)) continue;
    const o = configure(s);
    if (o.digital) continue;
    if (o.fixSD) defineSD(s);
    if (o.parallel) addParallelDevices(s);
    if (o.series) addSeriesDevices(s);
    if (o.dummies) removeDummyDevices(s);
    if (o.same) sameTemplate(s);
  }
  if (isSub(top)) {
    const o = configure(top);
    if (!o.digital && o.dummyHier) {
      const hiers = [];
      findDummyHier(lib, top, hiers);
      if (hiers.length) removeDummies(lib, hiers, top.name);
    }
  }
}

function removeDummies(lib, hiers, top) {
  for (const dh of hiers) {
    if (dh === top) return;
    const ckt = lib.find(dh);
    if (!ckt) throw new Error(`No subckt with name ${dh} found`);
    for (const other of [...lib]) {
      if (!isSub(other) || other.name === ckt.name) continue;
      const replace = new Map();
      for (const inst of other.elements) if (inst.model === ckt.name) replace.set(inst.name, ckt.elements[0]);
      for (const [x, y] of replace) {
        const ele = other.getElement(x);
        if (!ele) throw new Error(`${x} not found in ${other.name}`);
        const pins = new Map();
        for (const [p, v] of y.pins) pins.set(p, ele.pins.get(v));
        for (const [k, v] of Object.entries(ele.parameters ?? {})) if (y.parameters && k in y.parameters) y.parameters[k] = v;
        other.elements.push(Instance.create(other, { name: ele.name, model: y.model, pins, parameters: y.parameters }));
        other.elements.splice(other.elements.indexOf(ele), 1);
      }
    }
    lib.remove(ckt);
  }
}

function findDummyHier(lib, ckt, hiers) {
  const all = new PySet(ckt.elements.filter((e) => isSub(lib.find(e.model))).map((e) => String(e.model)));
  for (const m of all.difference(new PySet(hiers))) findDummyHier(lib, lib.find(m), hiers);
  if (ckt.elements.length === 1) hiers.push(ckt.name);
}

function swapSD(circuit, G, node) {
  const nbrd = G.neighbors(node).filter((nbr) => G.getEdgeData(node, nbr).pin.has("D"))[0];
  if (!nbrd) throw new Error(`incorrect node connections ${node}`);
  const nbrs = G.neighbors(node).filter((nbr) => G.getEdgeData(node, nbr).pin.has("S"))[0];
  if (!nbrs) throw new Error(`incorrect node connections ${node}`);
  const pins = circuit.getElement(node).pins;
  pins.set("D", nbrs);
  pins.set("S", nbrd);
}

function defineSD(subckt) {
  let power = [], gnd = [];
  for (const c of subckt.constraints) {
    if (c.constraint === "PowerPorts") power = c.ports;
    else if (c.constraint === "GroundPorts") gnd = c.ports;
  }
  if (!power.length || !gnd.length) return;
  const G = new AGraph(subckt);
  const ports = subckt.pins;
  let high = [...new PySet(power).intersection(new PySet(ports))];
  let low = [...new PySet(gnd).intersection(new PySet(ports))];
  if (!high.length) throw new Error(`VDD port ${power} not defined in subckt port ${subckt.pins}`);
  if (!low.length) throw new Error(`GND port ${gnd} not defined in subckt port ${subckt.pins}`);
  const nets = subckt.nets;
  high = high.filter((n) => nets.includes(n));
  low = low.filter((n) => nets.includes(n));
  if (!high.length || !low.length) return;
  const walk = (start, traversed, pTerm, nTerm, out) => {
    const queue = start;
    while (queue.length) {
      const nxt = queue.shift();
      for (const node of getNextLevel(subckt, G, [nxt])) {
        const edge = G.getEdgeData(node, nxt).pin;
        if (!(edge.has("S") || edge.has("D")) || traversed.includes(node)) continue;
        let bm;
        if (subckt.getElement(node)) bm = getBaseModel(subckt, node);
        else {
          if (!subckt.nets.includes(node)) throw new Error(`${node} not found in nets`);
          bm = "net";
        }
        if (bm === "PMOS") { if (edge.has(pTerm)) out.push(node); }
        else if (bm === "NMOS") { if (edge.has(nTerm)) out.push(node); }
        queue.push(node);
        traversed.push(node);
      }
    }
  };
  const changesP = [];
  walk(high, [...high, ...gnd], "D", "S", changesP);
  const changesN = [];
  if (changesP.length) walk(low, [...low, ...new PySet(power).intersection(new PySet(ports))], "S", "D", changesN);
  if (changesN.length) for (const node of new PySet(changesN).intersection(new PySet(changesP))) swapSD(subckt, G, node);
}

function addParallelDevices(ckt) {
  for (const net of new PySet(ckt.nets)) {
    const ppList = [];
    const groups = new Map();
    const G = new AGraph(ckt);
    if (!G.hasNode(net)) continue;
    for (const node of G.neighbors(net)) {
      const ele = ckt.getElement(node);
      if (!ele.parameters || !("PARALLEL" in ele.parameters)) continue;
      const p = { ...Object.fromEntries(ele.pins), ...ele.parameters, model: ele.model };
      const i = ppList.findIndex((q) => sameObj(q, p));
      if (i >= 0) groups.get(i).push(ele);
      else { ppList.push(p); groups.set(ppList.length - 1, [ele]); }
    }
    for (const pd of groups.values()) {
      if (pd.length <= 1) continue;
      const pd0 = [...pd].sort((a, b) => pyCmp(a.name, b.name))[0];
      // ALIGN 은 getattr(parameters, "PARALLEL", "1") 로 읽어 늘 "1" — 결과는 소자 수
      pd0.parameters.PARALLEL = String(pd.length);
      for (const rn of pd.slice(1)) G.remove(rn);
    }
  }
}

function addSeriesDevices(ckt) {
  for (const net of new PySet(ckt.nets).difference(new PySet(ckt.pins))) {
    const G = new AGraph(ckt);
    if (!G.hasNode(net)) continue;
    const nbrs = G.neighbors(net).sort(pyCmp);
    if (nbrs.length !== 2) continue;
    const [a, b] = nbrs.map((n) => ckt.getElement(n));
    if (!a.parameters || !("STACK" in a.parameters)) continue;
    if (a.model !== b.model) continue;
    const ea = G.getEdgeData(a.name, net).pin, eb = G.getEdgeData(b.name, net).pin;
    if (ea.size !== 1 || eb.size !== 1) continue;
    if (ea.equals(eb)) continue;
    const conns = new PySet(nbrs.map((n) => [...G.getEdgeData(n, net).pin][0]));
    if (conns.size !== 2) throw new Error(`Not a stack ${nbrs}`);
    const ap = { ...a.parameters, ...Object.fromEntries(a.pins) }, bp = { ...b.parameters, ...Object.fromEntries(b.pins) };
    const s1 = parseInt(ap.STACK ?? 1, 10), s2 = parseInt(bp.STACK ?? 1, 10);
    delete ap.STACK; delete bp.STACK;
    for (const c of conns) {
      if (!(c in ap) || !(c in bp)) throw new Error(`pin ${c} not found`);
      delete ap[c]; delete bp[c];
    }
    const ds = conns.equals(new PySet(["D", "S"])) || conns.equals(new PySet(["PLUS", "MINUS"]));
    if (sameObj(ap, bp) && ds) {
      a.parameters.STACK = String(s1 + s2);
      for (const [p, n] of [...a.pins]) if (n === net) a.pins.set(p, b.pins.get(p));
      G.remove(b);
    }
  }
}

function removeDummyDevices(subckt) {
  const baseOf = (name) => {
    let m = subckt.parent.find(name);
    while (m.base) m = subckt.parent.find(m.base);
    return m.name;
  };
  let power = [], gnd = [];
  for (const c of subckt.constraints) {
    if (c.constraint === "PowerPorts") power = c.ports;
    else if (c.constraint === "GroundPorts") gnd = c.ports;
  }
  if (!power.length && !gnd.length) return;
  const remove = [];
  for (const inst of subckt.elements) {
    const bm = baseOf(inst.model);
    if (!["D", "G", "S"].every((k) => inst.pins.has(k))) continue;
    const g = inst.pins.get("G");
    if ((power.length && bm === "PMOS" && power.includes(g)) || (gnd.length && bm === "NMOS" && gnd.includes(g)) ||
      (["NMOS", "PMOS"].includes(bm) && inst.pins.get("D") === g && g === inst.pins.get("S"))) remove.push(inst);
  }
  const G = new AGraph(subckt);
  if (subckt.elements.length > 1 && subckt.elements.length === remove.length)
    throw new Error(`subcircuit ${subckt.name} has all dummy devices, please remove this hiearchy or turn off remove_dummy_devices feature`);
  for (const inst of remove) G.remove(inst);
}

function sameTemplate(subckt) {
  const groups = new Map();
  for (const inst of subckt.elements) {
    if (!isSub(subckt.parent.find(inst.model))) continue;
    const key = inst.model + genKey(inst.parameters ?? {});
    if (groups.has(key)) groups.get(key).push(inst.name);
    else groups.set(key, [inst.name]);
  }
  for (const g of groups.values()) if (g.length > 1) subckt.constraints.append(Constraint.create(subckt.constraints, { constraint: "SameTemplate", instances: g }));
}

function sameObj(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}
