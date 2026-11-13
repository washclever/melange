/** 회로 데이터베이스 — ALIGN compiler/create_database.py 와 user_const.py 의 JS 판.
 *
 *    new CreateDatabase(parser, userConstraints)
 *        쓰이지 않는 모델을 지우고, 사용자 제약을 붙인다 (ALIGN 의 <서브회로>.const.json 과 같은 내용:
 *        { "<서브회로 이름>": [ {constraint: ..., ...}, ... ] })
 *    readInputs(top)   변수 풀기(계층 회로의 .subckt 변수), 전원·접지 포트를 아래로 퍼뜨리기
 *    addGenerators()   PDK 생성기와 이름이 같은 서브회로에 생성기를 단다
 */
import { SubCircuit, Instance } from "./schema.mjs";
import { Constraint } from "./constraint.mjs";
import { PySet, pyCmp } from "../py.mjs";
import { pdkGenerator } from "./library.mjs";

const isSub = (x) => x && x.kind === "SubCircuit";
const ports = (c) => c.ports;

export class CreateDatabase {
  /**
   * @param {import("./spice.mjs").SpiceParser} parser
   * @param {Record<string, object[]>} [userConstraints]  서브회로 이름(대소문자 무관) -> 제약 목록
   */
  constructor(parser, userConstraints = {}) {
    this.parser = parser;
    this.lib = parser.library;
    this.circuit = parser.circuit;
    this.multi = [];
    this.userConstraints = new Map(Object.entries(userConstraints ?? {}).map(([k, v]) => [k.toUpperCase(), v]));
    this.removeRedundantModels();
    for (const s of [...this.lib]) if (isSub(s)) this.annotateUserConstraints(s);
  }

  readInputs(name) {
    const top = this.lib.find(name.toUpperCase());
    if (!top) throw new Error(`${name.toUpperCase()} not found in library`);
    if (Object.keys(this.circuit.parameters).length) this.resolveParameters(name, this.circuit.parameters);
    else this.resolveParameters(name, top.parameters);
    this.updateLeafInstances();
    const [pwr, gnd, clk] = this.getPgc(top);
    this.propagatePowerPorts(top, pwr, gnd, clk);
    this.propagateConstTopToBottom(name, new PySet([name]));
    return this.lib;
  }

  addGenerators() {
    for (const s of this.lib) {
      if (!isSub(s)) continue;
      if (pdkGenerator(s.name) && Object.keys(s.generator).length === 0) {
        s.addGenerator(s.name);
        if (!s.constraints.items.some((c) => c.constraint === "Generator")) s.constraints.append(Constraint.create(s.constraints, { constraint: "Generator", name: s.name }));
      }
    }
  }

  /** ConstraintParser.annotate_user_constraints (파일 하나 = 이 서브회로의 목록) */
  annotateUserConstraints(node) {
    const list = this.userConstraints.get(node.name);
    if (!list) return;
    node.constraints.extend(list.map((c) => ({ ...c })));
    for (const c of node.constraints) {
      if (c.hasField("instances") && c.instances && c.instances.length > 0) c.instances.forEach((x, i) => { c.instances[i] = x.toUpperCase(); });
      else if (c.hasField("pairs")) for (const pair of c.pairs) pair.forEach((x, i) => { pair[i] = x.toUpperCase(); });
    }
    let dni = [];
    for (const c of node.constraints) {
      if (c.constraint === "GroupBlocks" || c.constraint === "GroupCaps") continue;
      if (c.hasField("instances") && c.instances && c.instances.length > 1) dni.push(...c.instances);
      else if (c.hasField("pairs")) for (const pair of c.pairs) dni.push(...pair);
      else if (c.hasField("pins1") && c.pins1 && c.pins1.length) dni.push(...[...c.pins1, ...c.pins2].filter((p) => p.includes("/")).map((p) => p.split("/")[0]));
    }
    if (dni.length) {
      dni = [...new Set(dni)].sort(pyCmp);
      node.constraints.append({ instances: dni, constraint: "DoNotIdentify" });
    }
  }

  propagateConstTopToBottom(topName, traversed) {
    const top = this.lib.find(topName);
    let all = new PySet(top.elements.filter((i) => isSub(this.lib.find(i.model))).map((i) => i.model));
    all = all.difference(traversed);
    if (all.size === 0) return;
    for (const c of top.constraints) {
      if (c.constraint !== "ConfigureCompiler" && c.constraint !== "DoNotUseLib") continue;
      for (const child of all) {
        const cc = this.lib.find(child).constraints;
        if (!cc.includes(c) && c.propagate) cc.append(c);
      }
    }
    traversed.update(all);
    for (const child of all) this.propagateConstTopToBottom(child, traversed);
  }

  removeRedundantModels() {
    const used = [];
    for (const s of this.lib) if (isSub(s)) for (const e of s.elements) used.push(e.model);
    const redundant = this.lib.items.filter((m) => !isSub(m) && !(used.includes(m.name) || m.base == null));
    for (const m of redundant) this.lib.remove(m);
  }

  resolveParameters(name, param) {
    const subckt = this.lib.find(name.toUpperCase());
    if (!subckt) throw new Error(`No subckt found with name: ${name}`);
    if (!isSub(subckt)) throw new Error(`${subckt.name} is not a subcircuit`);
    const N = name.toUpperCase();
    if (this.multi.includes(N)) {
      if (Object.entries(subckt.parameters).filter(([p]) => p in param).every(([p, v]) => v === param[p])) {
        this.multi.push(N);
        return N;
      }
      const [newName, updated] = this.findNewInstName(subckt, param);
      if (newName === subckt.name || this.lib.find(newName)) return newName;
      this.multi.push(newName);
      const s2 = SubCircuit.create(this.lib, { name: newName, pins: subckt.pins, parameters: updated, constraints: subckt.constraints.items, generator: subckt.generator });
      if (this.lib.find(newName)) throw new Error(`Redefining subckt with name ${newName}`);
      this.lib.append(s2);
      for (const e of subckt.elements) s2.elements.push(Instance.create(s2, { model: e.model, name: e.name, pins: e.pins, parameters: e.parameters }));
      this.updateIntermediateInstances(s2);
      return newName;
    }
    this.multi.push(N);
    for (const p of Object.keys(subckt.parameters)) if (p in param) subckt.parameters[p] = param[p];
    this.updateIntermediateInstances(subckt);
    return N;
  }

  updateIntermediateInstances(subckt) {
    const cp = this.circuit.parameters;
    for (const inst of [...subckt.elements]) {
      if (!isSub(this.lib.find(inst.model.toUpperCase()))) continue;
      for (const [p, v] of Object.entries(inst.parameters ?? {})) {
        if (v in cp) inst.parameters[p] = cp[v];
        else if (v in subckt.parameters) inst.parameters[p] = subckt.parameters[v] in cp ? cp[subckt.parameters[v]] : subckt.parameters[v];
      }
      const newName = this.resolveParameters(inst.model.toUpperCase(), inst.parameters ?? {});
      if (!this.lib.find(newName)) throw new Error(`Model ${newName} not found`);
      const i = subckt.elements.findIndex((x) => x.name === inst.name.toUpperCase());
      const cur = subckt.elements[i];
      subckt.elements[i] = Instance.create(subckt, { name: inst.name, model: newName, pins: cur.pins, parameters: cur.parameters });
    }
  }

  updateLeafInstances() {
    const cp = this.circuit.parameters;
    for (const s of this.lib) {
      if (!isSub(s)) continue;
      for (const inst of s.elements) {
        for (const [p, v] of Object.entries(inst.parameters ?? {})) {
          if (v in cp) inst.parameters[p] = cp[v];
          else if (v in s.parameters) inst.parameters[p] = s.parameters[v] in cp ? cp[s.parameters[v]] : s.parameters[v];
        }
      }
    }
  }

  findNewInstName(subckt, param, counter = 1) {
    let name = `${subckt.name.toUpperCase()}_${counter}`;
    const ck = this.lib.find(name);
    let np = { ...subckt.parameters };
    for (const p of Object.keys(np)) if (p in param) np[p] = param[p];
    if (ck) {
      let dup = true;
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      if (same(subckt.pins, ck.pins) && sameObj(np, ck.parameters) && same(subckt.constraints.dict(), ck.constraints.dict()) && sameObj(subckt.generator, ck.generator)) {
        for (const x of subckt.elements) {
          const y = ck.getElement(x.name);
          if (y && y.model === x.model && sameObj(y.parameters ?? {}, x.parameters ?? {}) && sameObj(Object.fromEntries(y.pins), Object.fromEntries(x.pins))) continue;
          dup = false;
          break;
        }
      } else dup = false;
      if (!dup) [name, np] = this.findNewInstName(subckt, param, counter + 1);
    }
    return [name, np];
  }

  getPgc(subckt) {
    const pwr = [], gnd = [], clk = [];
    for (const c of subckt.constraints) {
      if (c.constraint === "PowerPorts") pwr.push(...ports(c));
      else if (c.constraint === "GroundPorts") gnd.push(...ports(c));
      else if (c.constraint === "ClockPorts") clk.push(...ports(c));
    }
    return [pwr, gnd, clk];
  }

  propagatePowerPorts(subckt, pwr, gnd, clk) {
    let [pc, gc, cc] = this.getPgc(subckt);
    const step = (child, parent, kind) => {
      if (!child.length && parent.length) {
        child = parent;
        subckt.constraints.append(Constraint.create(subckt.constraints, { constraint: kind, ports: child }));
      } else if (child.length) {
        const diff = [...new PySet(parent).difference(child)];
        child.push(...diff);
        for (const c of subckt.constraints) if (c.constraint === kind && c.propagate) c.ports.push(...diff);
      }
      return child;
    };
    pc = step(pc, pwr, "PowerPorts");
    gc = step(gc, gnd, "GroundPorts");
    cc = step(cc, clk, "ClockPorts");
    let propClk = true, propPwr = true, propGnd = true;
    for (const c of subckt.constraints) {
      if (c.constraint === "ClockPorts") propClk = c.propagate;
      else if (c.constraint === "PowerPorts") propPwr = c.propagate;
      else if (c.constraint === "GroundPorts") propGnd = c.propagate;
    }
    for (const inst of subckt.elements) {
      const is = this.lib.find(inst.model);
      if (!isSub(is)) continue;
      const pp = [...inst.pins].filter(([, n]) => pc.includes(n) && propPwr).map(([p]) => p);
      const gp = [...inst.pins].filter(([, n]) => gc.includes(n) && propGnd).map(([p]) => p);
      const cp = [...inst.pins].filter(([, n]) => cc.includes(n) && propClk).map(([p]) => p);
      this.propagatePowerPorts(is, pp, gp, cp);
    }
  }
}

function sameObj(a, b) {
  const ka = Object.keys(a ?? {}), kb = Object.keys(b ?? {});
  return ka.length === kb.length && ka.every((k) => b[k] === a[k]);
}
