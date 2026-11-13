/** 제약 옮기기 — ALIGN schema/translator.py (ConstraintTranslator) 의 JS 판.
 *
 *  소자 몇 개를 새 계층(X_...)으로 묶을 때 제약의 소자 이름을 고친다:
 *    updateConst(새 이름, 맵)      위 회로의 제약: 묶인 소자 이름을 새 인스턴스 이름으로
 *    topToBottom(맵)               아래(새 서브회로)에 제약이 없으면 위 회로의 해당 제약을 내려 준다
 */
import { PySet } from "../py.mjs";
import { Constraint } from "./constraint.mjs";

/** 사전 == 사전 (파이썬처럼 키 순서는 보지 않는다) */
export function sameDict(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameDict(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameDict(a[k], b[k]));
  }
  return a === b;
}

const listReplace = (lst, oldV, newV) => { for (let i = 0; i < lst.length; i++) if (lst[i] === oldV) lst[i] = newV; };

export class ConstraintTranslator {
  /**
   * @param {import("./schema.mjs").Library} lib
   * @param {string} parentName
   * @param {import("./schema.mjs").SubCircuit} [child]
   */
  constructor(lib, parentName, child = null) {
    this.lib = lib;
    this.parentName = parentName;
    this.parent = lib.find(parentName);
    if (!this.parent) throw new Error(`Hierarchy not found, ${parentName}`);
    this.parentConst = this.parent.constraints;
    this.child = child;
    this.childName = child ? child.name : null;
    this.childConst = child ? child.constraints : null;
  }

  /** _top_to_bottom_translation(node_map) — node_map: 위 회로 마디 -> 아래 소자 이름 (Map) */
  topToBottom(nodeMap) {
    if (this.childConst && this.childConst.length === 0) {
      for (const c of [...this.parentConst]) {
        if (["HorizontalDistance", "VerticalDistance", "BlockDistance", "CompactPlacement"].includes(c.constraint)) this.childConst.append(c);
        else if (c.constraint === "ConfigureCompiler" && c.propagate) this.childConst.append(c);
        else if (c.hasField("instances") && c.constraint !== "GroupBlocks") {
          const d = {};
          for (const f of c._set) d[f] = f === "instances" ? c.instances.filter((b) => nodeMap.has(b)).map((b) => nodeMap.get(b)) : c[f];
          this.addConst(this.childConst, d);
        }
      }
    }
    for (const c of [...this.parentConst]) {
      if (!c.hasField("pin_current")) continue;
      const pinMap = new Map();
      for (const pin of Object.keys(c.pin_current)) {
        const pi = pin.split("/")[0].toUpperCase(), pp = pin.split("/")[1].toUpperCase();
        if (nodeMap.has(pi)) {
          const ci = nodeMap.get(pi);
          if (!this.child.getElement(ci).pins.has(pp)) throw new Error(`${pp} is not a pin of ${ci}`);
          pinMap.set(pin, `${ci}/${pp}`);
        }
      }
      const d = {};
      for (const f of c._set) {
        d[f] = f === "pin_current"
          ? Object.fromEntries(Object.entries(c.pin_current).filter(([p]) => pinMap.has(p)).map(([p, cur]) => [pinMap.get(p), cur]))
          : c[f];
      }
      this.addConst(this.childConst, d);
    }
  }

  /** _update_const(new_inst_name, node_map) */
  updateConst(newName, nodeMap) {
    const keys = [...nodeMap.keys()];
    for (const c of this.parentConst) {
      if (c.hasField("instances") && c.constraint !== "GroupBlocks") {
        if (c.instances.some((x) => nodeMap.has(x))) {
          let replace = true;
          for (const old of keys) {
            if (replace && !c.instances.includes(newName)) { listReplace(c.instances, old, newName); replace = false; }
            else if (c.instances.includes(old)) c.instances.splice(c.instances.indexOf(old), 1);
          }
        }
      } else if (c.hasField("pairs")) {
        for (const pair of c.pairs) {
          if (pair.length === 2) {
            const a = nodeMap.has(pair[0]), b = nodeMap.has(pair[1]);
            if (a && b) { pair[0] = newName; pair.pop(); }
            else if (a && !b) pair[0] = newName;
            else if (b && !a) pair[1] = newName;
          } else if (pair.length === 1) {
            if (nodeMap.has(pair[0])) pair[0] = newName;
          }
        }
      } else if (c.hasField("pin_current")) {
        const updated = new Map(), remove = [];
        for (const [pin, cur] of Object.entries(c.pin_current)) {
          const pi = pin.split("/")[0].toUpperCase();
          if (!nodeMap.has(pi)) continue;
          remove.push(pin);
          if (!this.childName) throw new Error("Groupcap does not have child hieararchy");
          const np = this.child.getElement(nodeMap.get(pi)).pins.get(pin.split("/")[1]);
          const k = `${newName}/${np}`;
          if (updated.has(k)) updated.get(k).forEach((x, id, arr) => { arr[id] = x + cur[id]; });
          else updated.set(k, cur);
        }
        for (const p of remove) delete c.pin_current[p];
        for (const [p, cur] of updated) c.pin_current[p] = cur;
      } else if (c.hasField("pins1") && c.pins1 && c.pins1.length) {
        const rep = new Map();
        for (const pin of [...c.pins1, ...c.pins2]) {
          if (!pin.includes("/")) continue;
          if (this.child) {
            const np = this.pinMap(pin, nodeMap, newName);
            if (np) rep.set(pin, np);
          } else {
            const pi = pin.split("/")[0];
            if (nodeMap.has(pi)) rep.set(pin, pin.replace(pi, newName));
          }
        }
        for (const [k, v] of rep) {
          for (let i = 0; i < c.pins1.length; i++) {
            if (k === c.pins1[i]) c.pins1[i] = v;
            if (k === c.pins2[i]) c.pins2[i] = v;
          }
        }
      } else if (c.hasField("regions")) {
        c.regions.forEach((row, i) => {
          if (!row.some((x) => nodeMap.has(x))) return;
          let replace = true;
          for (const old of keys) {
            if (replace) { listReplace(c.regions[i], old, newName); replace = false; }
            else if (row.includes(old)) c.regions[i].splice(c.regions[i].indexOf(old), 1);
          }
        });
      }
    }
  }

  pinMap(pin, nodeMap, newName) {
    const [pi, port] = pin.split("/");
    if (!nodeMap.has(pi)) return null;
    if (!this.childName) throw new Error("Groupcap does not have child hieararchy");
    const ce = this.child.getElement(nodeMap.get(pi));
    if (!ce) throw new Error(`child does not have instance ${nodeMap.get(pi)}`);
    return `${newName}/${ce.pins.get(port)}`;
  }

  /** _add_const — 사전(바뀐 제약)이거나 제약 */
  addConst(list, c) {
    const isDict = !(c && typeof c.dict === "function");
    let isAppend = false;
    if (!isDict && c.hasField("instances") && c.instances.length > 0) isAppend = true;
    else if (isDict && "instances" in c && c.instances.length === 0) { /* 빈 제약은 넣지 않는다 */ }
    else if (isDict || !c.hasField("instances")) isAppend = true;
    // 파이썬: 제약 == 사전 은 제약.dict() == 사전 (키 순서 무관)
    const inList = () => list.items.some((x) => (isDict ? sameDict(x.dict(), c) : x.equals(c)));
    if (!isAppend && inList()) list.remove(isDict ? Constraint.create(list, c) : c);
    if (isAppend && !inList()) list.append(c);
  }
}

