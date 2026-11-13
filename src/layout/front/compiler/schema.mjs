/** 회로 자료 — ALIGN schema/{library,model,subcircuit,instance}.py 의 JS 판.
 *
 *    Library      모델·서브회로 목록. find(이름) 은 대문자로 찾는다
 *    Model        소자 모델 (NMOS, PMOS, ... 또는 .model 로 만든 파생 모델: base 의 핀·변수를 물려받는다)
 *    SubCircuit   서브회로: 핀, 변수, 소자(elements), 생성기(generator), 제약(constraints)
 *    Instance     소자 하나: model, name, pins(형식 핀 -> 넷, Map), parameters (모델의 변수 순서로 채운다)
 *
 *  만들 때 pydantic 검사기와 같은 일을 한다: 이름·핀·변수를 대문자로, 모델이 있는가, 핀이 모델과 같은가,
 *  변수가 모델 변수의 부분집합인가. 값은 파이썬 str() 처럼 문자열로 바꾼다 (1.05e-06 -> "1.05E-06").
 */
import { ConstraintDB } from "./constraint.mjs";
import { floatRepr } from "../py.mjs";

/** pydantic 의 str 맞추기 — 정수는 그대로, 실수는 repr */
export function toStr(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    if (Number.isInteger(v)) return Math.abs(v) < 1e21 ? String(v) : BigInt(v).toString();
    return floatRepr(v);
  }
  if (typeof v === "boolean") return v ? "True" : "False";
  throw new Error(`cannot convert to a string: ${JSON.stringify(v)}`);
}

const upperMap = (m) => {
  const out = new Map();
  for (const [k, v] of m instanceof Map ? m : Object.entries(m)) out.set(toStr(k).toUpperCase(), toStr(v).toUpperCase());
  return out;
};
const upperObj = (o) => {
  const out = {};
  for (const [k, v] of o instanceof Map ? o : Object.entries(o)) out[toStr(k).toUpperCase()] = toStr(v).toUpperCase();
  return out;
};
const nonEmpty = (o) => o && (o instanceof Map ? o.size > 0 : Object.keys(o).length > 0);

export class Library {
  constructor() {
    /** @type {Array<Model|SubCircuit>} */
    this.items = [];
  }
  [Symbol.iterator]() { return this.items[Symbol.iterator](); }
  get length() { return this.items.length; }
  find(name) {
    const n = String(name).toUpperCase();
    return this.items.find((x) => x.name === n) ?? null;
  }
  append(item) {
    if (this.find(item.name)) throw new Error(`Duplicate model/subcircuit name ${item.name}`);
    this.items.push(item);
  }
  remove(item) {
    const i = this.items.indexOf(item);
    if (i < 0) throw new Error("list.remove(x): x not in list");
    this.items.splice(i, 1);
  }
  /** 기본 모델 (Library(loadbuiltins=True)) */
  static withBuiltins() {
    const lib = new Library();
    const mos = { W: 0, L: 0, NFIN: 1, NF: 2, M: 1, PARALLEL: 1, STACK: 1 };
    const two = { VALUE: 0, PARALLEL: 1, STACK: 1 };
    for (const [name, pins, parameters, prefix] of [
      ["NMOS", ["D", "G", "S", "B"], mos, ""], ["PMOS", ["D", "G", "S", "B"], mos, ""],
      ["CAP", ["PLUS", "MINUS"], two, "C"], ["RES", ["PLUS", "MINUS"], two, "R"], ["IND", ["PLUS", "MINUS"], two, "L"],
    ]) lib.append(Model.create(lib, { name, pins, parameters, prefix }));
    return lib;
  }
}

export class Model {
  /** @param {Library} lib */
  static create(lib, { name, base = null, pins = null, parameters = null, prefix = null }) {
    const m = new Model();
    Model._init(m, lib, { name, base, pins, parameters, prefix });
    return m;
  }
  static _init(m, lib, { name, base, pins, parameters, prefix }) {
    m.parent = lib;
    m.name = toStr(name);
    if (m.name.length === 0) throw new Error("Model name cannot be an empty string");
    m.name = m.name.toUpperCase();
    m.base = null;
    if (base != null) {
      const b = toStr(base).toUpperCase();
      if (!lib.items.some((x) => x.name === b)) throw new Error(`Could not find base model ${base} in libary`);
      m.base = b;
    }
    const baseModel = m.base ? lib.items.find((x) => x.name === m.base) : null;
    if (!m.base) {
      if (!pins || pins.length === 0) throw new Error("Pins must be specified for base models. Did something go wrong in base?");
      m.pins = pins.map((p) => toStr(p).toUpperCase());
    } else if (pins && pins.length) {
      throw new Error(`Inheriting from ${m.base}. Cannot add pins`);
    } else m.pins = baseModel.pins.slice();
    let params = nonEmpty(parameters) ? upperObj(parameters) : {};
    if (baseModel) params = Object.assign({ ...baseModel.parameters }, params);
    m.parameters = params;
    m.prefix = baseModel ? baseModel.prefix : prefix;
  }
  get kind() { return "Model"; }
  /** 이 모델의 바탕 모델 이름들 (가까운 것부터) */
  get bases() {
    if (!this.base) return [];
    const b = this.parent.items.find((x) => x.name === this.base);
    return [this.base, ...b.bases];
  }
}

export class SubCircuit extends Model {
  /**
   * @param {Library} lib  이 서브회로가 들어갈 라이브러리 (검사의 맥락)
   */
  static create(lib, { name, pins = null, parameters = null, generator = null, elements = [], constraints = [], prefix }) {
    const s = new SubCircuit();
    Model._init(s, lib, { name, base: null, pins, parameters, prefix: null });
    s.prefix = prefix ?? "";
    s.elements = [];
    for (const e of elements) s.elements.push(e instanceof Instance ? e : Instance.create(s, e));
    s.generator = generator ? upperless(generator) : {};
    s.constraints = new ConstraintDB(s);
    for (const c of constraints) s.constraints.append(c);
    return s;
  }
  get kind() { return "SubCircuit"; }
  /** 넷 (소자 핀이 처음 나온 순서) */
  get nets() {
    const out = [];
    const seen = new Set();
    for (const e of this.elements) for (const n of e.pins.values()) if (!seen.has(n)) { seen.add(n); out.push(n); }
    return out;
  }
  getElement(name) {
    const n = String(name).toUpperCase();
    return this.elements.find((x) => x.name === n) ?? null;
  }
  addGenerator(gen) { this.generator.name = gen; }
  /** pydantic dict(exclude_unset=True) 과 같은 꼴 (이름 꼬리표를 만들 때) */
  dictUnset() {
    return {
      name: this.name, pins: this.pins.slice(), parameters: { ...this.parameters },
      elements: this.elements.map((e) => e.dictUnset()), generator: { ...this.generator },
      constraints: this.constraints.items.map((c) => c.dict({ exclude_unset: true })),
    };
  }
}

/** Dict[str, str] — 값만 문자열로 (생성기 이름은 대문자로 바꾸지 않는다) */
function upperless(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[toStr(k)] = toStr(v);
  return out;
}

export class Instance {
  /**
   * @param {SubCircuit} owner  이 소자를 가진 서브회로 (owner.parent 가 라이브러리)
   * @param {{name:string, model:string, pins:Map<string,string>|object, parameters?:object}} data
   */
  static create(owner, { name, model, pins, parameters = null, abstract_name = null }) {
    const lib = owner.parent;
    if (!lib) throw new Error("Circuit / SubCircuit constaining instance must be registered to a Library");
    const i = new Instance();
    i.owner = owner;
    i.model = toStr(model).toUpperCase();
    const m = lib.items.find((x) => x.name === i.model);
    if (!m) throw new Error(`Could not find model ${i.model}`);
    i.name = toStr(name).toUpperCase();
    if (m.prefix && !i.name.startsWith(m.prefix)) throw new Error(`${i.name} does not start with ${m.prefix}`);
    i.pins = upperMap(pins);
    const want = new Set(m.pins);
    if (i.pins.size !== want.size || ![...i.pins.keys()].every((k) => want.has(k)))
      throw new Error(`${i.name}: pins ${[...i.pins.keys()]} differ from the pins ${m.pins} of model ${m.name}`);
    if (nonEmpty(parameters)) {
      const p = upperObj(parameters);
      const mp = m.parameters ?? {};
      if (!nonEmpty(mp) || !Object.keys(p).every((k) => k in mp))
        throw new Error(`could not identify device parameters ${i.name} ${JSON.stringify(p)} allowed parameters of model ${m.name} are ${JSON.stringify(mp)}`);
      i.parameters = {};
      for (const [k, v] of Object.entries(mp)) i.parameters[k] = k in p ? p[k] : v;
    } else if (nonEmpty(m.parameters)) i.parameters = { ...m.parameters };
    else i.parameters = parameters == null ? null : {};
    i.abstract_name = abstract_name;
    return i;
  }
  /** 이 소자의 모델 (라이브러리에서) */
  get mclass() {
    const m = this.owner.parent.items.find((x) => x.name === this.model);
    if (!m) throw new Error(`model ${this.model} is not in the library`);
    return m;
  }
  addAbsName(abn) { this.abstract_name = abn; }
  dictUnset() {
    return { model: this.model, name: this.name, pins: new Map(this.pins), parameters: this.parameters ? { ...this.parameters } : this.parameters };
  }
}
