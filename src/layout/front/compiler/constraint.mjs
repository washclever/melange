/** 제약 — ALIGN schema/constraint.py 의 JS 판 (pydantic 모델을 흉내 낸다).
 *
 *  제약은 { constraint: "<종류>", 필드... } 이다. 종류마다 필드 순서·기본값·형(型)·검사기가 있고,
 *  만들 때(create) 파이썬 pydantic 처럼 형을 맞추고 검사기를 돌린다. 검사기는 제약이 속한 회로를
 *  본다 (db.parent): 소자가 회로에 있는가, 대칭 짝의 변수가 같은가, 포트가 회로 핀인가.
 *
 *    Constraint.create(db, 사전)   새 제약 (db 는 이 제약이 들어갈 ConstraintDB — 검사의 맥락)
 *    c.dict({ exclude_unset })      pydantic .dict() (필드 순서대로)
 *    c.reprKey()                    repr() 과 같은 구실 — ConstraintDB 가 중복을 거른다
 *    c.equals(d)                    == (dict 가 같으면)
 *    expandUserConstraints(목록)    사용자 제약을 낮은 제약으로 펴고(DoNotIdentify 등) 나머지는 그대로
 *    ConstraintDB                   목록 + 중복 거르개(repr 캐시 — 지운 뒤에도 남는다, ALIGN 과 같다)
 *
 *  ALIGN 은 굳은 제약(HardConstraint)을 넣을 때마다 z3 로 풀리는지 본다. 여기서는 풀이기를 돌리지
 *  않는다 — 자동으로 만드는 대칭 제약은 소자를 한 번씩만 쓰므로 서로 부딪히지 않는다.
 */

import { floatRepr } from "../py.mjs";

const REQ = Symbol("required");

// ---------------------------------------------------------------- 형 맞추기 (pydantic v1)
function asStr(v, what) {
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : floatRepr(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  throw new Error(`${what}: must be a string (${JSON.stringify(v)})`);
}
function asInt(v, what) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v);
  throw new Error(`${what}: must be an integer (${JSON.stringify(v)})`);
}
function asFloat(v, what) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  throw new Error(`${what}: must be a number (${JSON.stringify(v)})`);
}
const TRUE = new Set([1, "1", "on", "t", "true", "y", "yes"]), FALSE = new Set([0, "0", "off", "f", "false", "n", "no"]);
function asBool(v, what) {
  if (v === true || v === false) return v;
  const x = typeof v === "string" ? v.toLowerCase() : v;
  if (TRUE.has(x)) return true;
  if (FALSE.has(x)) return false;
  throw new Error(`${what}: must be true or false (${JSON.stringify(v)})`);
}
function asList(v, what) {
  if (Array.isArray(v)) return v;
  throw new Error(`${what}: must be a list (${JSON.stringify(v)})`);
}

/** 형 이름: str int float bool dict any list list<str> list<list<str>> list<float> [리터럴...] */
function coerce(type, v, what) {
  if (Array.isArray(type)) {
    if (!type.some((t) => t === v)) throw new Error(`${what}: ${JSON.stringify(v)} must be one of ${type.join("/")}`);
    return v;
  }
  switch (type) {
    case "str": return asStr(v, what);
    case "int": return asInt(v, what);
    case "float": return asFloat(v, what);
    case "bool": return asBool(v, what);
    case "dict":
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
      throw new Error(`${what}: must be a dictionary`);
    case "any": return v;
    case "list": return asList(v, what).slice();
    case "list<str>": return asList(v, what).map((x, i) => asStr(x, `${what}[${i}]`));
    case "list<float>": return asList(v, what).map((x, i) => asFloat(x, `${what}[${i}]`));
    case "list<list<str>>": return asList(v, what).map((x, i) => asList(x, `${what}[${i}]`).map((y, j) => asStr(y, `${what}[${i}][${j}]`)));
    default: throw new Error(`unknown type ${type}`);
  }
}

// ---------------------------------------------------------------- 검사기
/** get_instances_from_hacked_dataclasses — 회로의 소자 + 묶음 이름 + name 필드 */
function instancesOf(db) {
  const owner = db?.parent;
  if (!owner) throw new Error("cannot find the circuit of the constraint");
  let inst;
  if (owner.elements) inst = new Set(owner.elements.map((x) => x.name));
  else if (owner.instances) inst = new Set(owner.instances.map((x) => x.instance_name));
  else throw new Error("the circuit of the constraint has no element list");
  for (const c of db) {
    if ("instance_name" in c.fields()) inst.add(c.instance_name);
    if ("name" in c.fields()) inst.add(c.name);
  }
  return inst;
}

function validateInstances(db, value) {
  const inst = instancesOf(db);
  for (const x of value) if (!inst.has(x) && !inst.has(x.toUpperCase())) throw new Error(`Instance ${x} not found in the circuit`);
  return value.map((x) => x.toUpperCase());
}
function validatePorts(db, value) {
  const obj = db?.parent;
  if (obj && obj.pins) for (const v of value) if (!obj.pins.includes(v)) throw new Error(`Port ${v} not found in subcircuit ${String(obj.name).toLowerCase()}`);
  return value;
}
const upper = (value) => value.map((v) => v.toUpperCase());
const atLeastTwo = (db, value) => {
  if (value.length < 2) throw new Error("Must contain at least two instances");
  return validateInstances(db, value);
};
const nonNeg = (db, v) => { if (!(v >= 0)) throw new Error(`Value must be non-negative: ${v}`); return v; };
const groupBlockNames = (db) => [...db].filter((c) => c.constraint === "GroupBlocks").map((c) => c.instance_name.toUpperCase());

function dictEq(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

// ---------------------------------------------------------------- 종류
/** 필드: [이름, 형, 기본값(REQ = 필수)] / validators: 필드 -> [함수(db, 값, 앞의 값들)] (always 는 기본값에도) */
const SPECS = {
  Order: {
    hard: true, fields: [["instances", "list<str>", REQ], ["direction", [null, "horizontal", "vertical", "left_to_right", "right_to_left", "bottom_to_top", "top_to_bottom"], null], ["abut", "bool", false]],
    validators: { instances: [atLeastTwo] }, yields: (c) => [["DoNotIdentify", { instances: c.instances }]],
  },
  Align: {
    hard: true, fields: [["instances", "list<str>", REQ], ["line", [null, "h_any", "h_top", "h_bottom", "h_center", "v_any", "v_left", "v_right", "v_center"], null]],
    validators: { instances: [validateInstances, atLeastTwo] }, yields: (c) => [["DoNotIdentify", { instances: c.instances }]],
  },
  Floorplan: {
    hard: true, user: true, fields: [["regions", "list<list<str>>", REQ], ["order", "bool", false], ["symmetrize", "bool", false]],
    validators: { regions: [(db, v) => v.map((row) => validateInstances(db, row))] }, always: ["regions"],
    yields: (c) => {
      const out = [], seen = new Set();
      for (let i = 0; i + 1 < c.regions.length; i++) {
        for (const above of c.regions[i]) for (const below of c.regions[i + 1]) {
          seen.add(`${above}\u0000${below}`);
          if (seen.has(`${below}\u0000${above}`)) throw new Error(`Please review floorplan constraint: ${below} is previously placed above ${above}.`);
          out.push(["Order", { instances: [above, below], direction: "top_to_bottom", abut: false }]);
        }
      }
      if (c.order) for (const r of c.regions) if (r.length > 1) out.push(["Order", { instances: r, direction: "left_to_right", abut: false }]);
      if (c.symmetrize) {
        const pairs = [];
        for (const r of c.regions) {
          if (r.length <= 2) pairs.push(r);
          else {
            let i = 0;
            for (i = 0; i < Math.floor(r.length / 2); i++) pairs.push([r[i], r[r.length - 1 - i]]);
            if (r.length % 2 === 1) pairs.push([r[i]]);
          }
        }
        out.push(["SymmetricBlocks", { pairs, direction: "V" }]);
      }
      if (c.symmetrize && c.order) out.push(["DoNotIdentify", { instances: c.regions.flat() }]);
      return out;
    },
  },
  Spread: {
    hard: true, fields: [["instances", "list<str>", REQ], ["direction", ["horizontal", "vertical"], REQ], ["distance", "int", REQ]],
    validators: { instances: [atLeastTwo] }, yields: (c) => [["DoNotIdentify", { instances: c.instances }]],
  },
  AssignBboxVariables: { hard: true, fields: [["bbox_name", "str", REQ], ["llx", "int", REQ], ["lly", "int", REQ], ["urx", "int", REQ], ["ury", "int", REQ]] },
  AspectRatio: {
    hard: true, fields: [["ratio_low", "float", 0.1], ["ratio_high", "float", 10], ["weight", "int", 1]],
    validators: {
      ratio_low: [nonNeg],
      ratio_high: [(db, v, values) => { if (!(v > values.ratio_low)) throw new Error(`AspectRatio:ratio_high ${v} should be greater than ratio_low ${values.ratio_low}`); return v; }],
    },
  },
  Boundary: {
    hard: true, fields: [["max_width", "float", 100000], ["max_height", "float", 100000], ["halo_horizontal", "float", 0], ["halo_vertical", "float", 0]],
    validators: {
      max_width: [nonNeg], max_height: [nonNeg], halo_vertical: [nonNeg],
      halo_horizontal: [nonNeg, (db, v, values) => { if (!(values.max_width > v)) throw new Error("Halo should be smaller than the max_width"); return v; }],
    },
  },
  AlignInOrder: {
    hard: true, user: true,
    fields: [["instances", "list<str>", REQ], ["line", ["top", "bottom", "left", "right", "center"], "bottom"], ["direction", [null, "horizontal", "vertical"], null], ["abut", "bool", false]],
    validators: {
      direction: [(db, v, values) => {
        if (["bottom", "top"].includes(values.line)) {
          if (v == null) v = "horizontal";
          else if (v !== "horizontal") throw new Error("direction is horizontal if line is bottom or top");
        } else if (["left", "right"].includes(values.line)) {
          if (v == null) v = "vertical";
          else if (v !== "vertical") throw new Error("direction is vertical if line is left or right");
        } else if (values.line === "center" && !v) throw new Error("direction must be specified if line == center");
        return v;
      }],
    },
    always: ["direction"],
    yields: (c) => [
      ["Align", { instances: c.instances, line: `${c.direction[0]}_${c.line}` }],
      ["Order", { instances: c.instances, direction: c.direction === "horizontal" ? "left_to_right" : "top_to_bottom", abut: c.abut }],
      ["DoNotIdentify", { instances: c.instances }],
    ],
  },
  CompactPlacement: { fields: [["style", ["left", "right", "center"], "left"]] },
  Generator: { fields: [["name", "str", null], ["parameters", "dict", null]] },
  SameTemplate: {
    fields: [["instances", "list<str>", REQ]],
    validators: {
      instances: [(db, v) => {
        const inst = validateInstances(db, v);
        const owner = db.parent;
        if (!owner.elements || owner.elements.length === 0) return inst;
        const gb = groupBlockNames(db);
        for (let i = 0; i + 1 < inst.length; i++) {
          const [a, b] = [inst[i], inst[i + 1]];
          if (!gb.includes(a) && !gb.includes(b) && !dictEq(owner.getElement(a).parameters, owner.getElement(b).parameters))
            throw new Error(`Parameters of ${a} and ${b} must match for SameTemplate in subckt ${owner.name}`);
        }
        return inst;
      }],
    },
  },
  GroupBlocks: {
    hard: true,
    fields: [["instance_name", "str", REQ], ["instances", "list<str>", REQ], ["template_name", "str", null], ["generator", "dict", null], ["constraints", "list", null]],
    validators: {
      instance_name: [(db, v) => {
        if (!v) throw new Error("Cannot be an empty string");
        if (!v.toUpperCase().startsWith("X")) throw new Error(`instance name ${v} of the group should start with X`);
        return v.toUpperCase();
      }],
    },
  },
  PlaceCloser: { fields: [["instances", "list<str>", REQ]], validators: { instances: [validateInstances] }, yields: (c) => [["DoNotIdentify", { instances: c.instances }]] },
  PlaceOnBoundary: {
    fields: ["north", "south", "east", "west"].map((k) => [k, "list<str>", null]).concat(["northeast", "northwest", "southeast", "southwest"].map((k) => [k, "str", null])),
    validators: Object.fromEntries(["north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"].map((k) => [k, [(db, v) => (Array.isArray(v) ? validateInstances(db, v) : validateInstances(db, [v]))]])),
    yields: (c) => {
      const inst = [];
      for (const k of ["north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"]) {
        const v = c[k];
        if (v) Array.isArray(v) ? inst.push(...v) : inst.push(v);
      }
      return [["DoNotIdentify", { instances: inst }]];
    },
  },
  DoNotIdentify: { fields: [["instances", "list<str>", REQ]], validators: { instances: [(db, v) => v] }, always: ["instances"] },
  PlaceOnGrid: { fields: [["direction", ["H", "V"], REQ], ["pitch", "int", REQ], ["ored_terms", "list", null]] },
  BlockDistance: { fields: [["abs_distance", "int", REQ]] },
  HorizontalDistance: { fields: [["abs_distance", "int", REQ]] },
  VerticalDistance: { fields: [["abs_distance", "int", REQ]] },
  GuardRing: { fields: [["guard_ring_primitives", "str", REQ], ["global_pin", "str", REQ], ["block_name", "str", REQ]] },
  SymmetricBlocks: {
    hard: true, fields: [["pairs", "list<list<str>>", REQ], ["direction", ["H", "V"], REQ]],
    validators: {
      pairs: [(db, value) => {
        instancesOf(db);
        if (value.length === 1 && value[0].length !== 2) throw new Error("Must contain at least a pair of two instances or more than two pairs.");
        for (const p of value) {
          if (p.length < 1) throw new Error("Must contain at least one instance");
          if (p.length > 2) throw new Error("Must contain at most two instances");
        }
        value = value.map((p) => validateInstances(db, p));
        const owner = db.parent;
        if (!owner.elements || owner.elements.length === 0) return value;
        const gb = groupBlockNames(db);
        for (const p of value) {
          if (p.some((e) => gb.includes(e))) continue;
          if (p.length === 2) {
            const a = owner.getElement(p[0]), b = owner.getElement(p[1]);
            if (!a) throw new Error(`element ${p[0]} not found in design`);
            if (!b) throw new Error(`element ${p[1]} not found in design`);
            if (!dictEq(a.parameters, b.parameters)) throw new Error(`Parameters of the symmetry pair ${p} do not match in subckt ${owner.name}`);
          }
        }
        return value;
      }],
    },
    yields: (c) => [["DoNotIdentify", { instances: c.pairs.flat() }]],
  },
  GroupCaps: { fields: [["name", "str", REQ], ["instances", "list<str>", REQ], ["unit_cap", "str", REQ], ["num_units", "list", REQ], ["dummy", "bool", REQ]] },
  NetConst: { fields: [["nets", "list<str>", REQ], ["shield", "str", null], ["criticality", "int", null]] },
  PortLocation: { fields: [["ports", "list", REQ], ["location", ["TL", "TC", "TR", "RT", "RC", "RB", "BL", "BC", "BR", "LB", "LC", "LT"], REQ]] },
  SymmetricNets: {
    fields: [["net1", "str", REQ], ["net2", "str", REQ], ["pins1", "list", null], ["pins2", "list", null], ["direction", ["H", "V"], REQ]],
    validators: {
      net1: [(db, v) => v.toUpperCase()],
      net2: [(db, v) => v.toUpperCase()],
      pins1: [(db, v) => pinsCheck(db, v)],
      pins2: [(db, v, values) => {
        const out = pinsCheck(db, v);
        if (out && (values.pins1 ?? []).length !== out.length) throw new Error("pin size mismatch");
        return out;
      }],
    },
  },
  MultiConnection: { fields: [["nets", "list<str>", REQ], ["multiplier", "int", REQ]] },
  DoNotRoute: { fields: [["nets", "list<str>", REQ]], validators: { nets: [(db, v) => upper(v)] } },
  PowerPorts: { fields: [["ports", "list<str>", REQ], ["propagate", "bool", true]], validators: { ports: [(db, v) => upper(v), validatePorts] } },
  GroundPorts: { fields: [["ports", "list<str>", REQ], ["propagate", "bool", true]], validators: { ports: [(db, v) => upper(v), validatePorts] } },
  ClockPorts: { fields: [["ports", "list<str>", REQ], ["propagate", "bool", true]], validators: { ports: [(db, v) => upper(v)] } },
  DoNotUseLib: { fields: [["libraries", "list<str>", REQ], ["propagate", "bool", false]] },
  ConfigureCompiler: {
    fields: [["is_digital", "bool", false], ["auto_constraint", "bool", true], ["identify_array", "bool", true], ["fix_source_drain", "bool", true],
      ["remove_dummy_hierarchies", "bool", true], ["remove_dummy_devices", "bool", true], ["merge_series_devices", "bool", true],
      ["merge_parallel_devices", "bool", true], ["same_template", "bool", true], ["propagate", "bool", true]],
  },
  NetPriority: {
    fields: [["nets", "list<str>", REQ], ["weight", "int", REQ]],
    validators: { weight: [(db, v) => { if (v < 0) throw new Error("must be non-negative"); return v; }], nets: [(db, v) => upper(v)] },
  },
  Route: { fields: [["min_layer", "str", null], ["max_layer", "str", null], ["customize", "list", []]] },
  ChargeFlow: {
    fields: [["dist_type", [null, "Euclidean", "Manhattan"], "Manhattan"], ["time", "list<float>", REQ], ["pin_current", "dict", REQ]],
    validators: {
      time: [(db, v) => { if (v.length < 1) throw new Error("Must contain at least one time stamp"); return v; }],
      pin_current: [(db, v, values) => {
        const inst = instancesOf(db);
        for (const [pin, cur] of Object.entries(v)) {
          if (!inst.has(pin.split("/")[0].toUpperCase())) throw new Error(`element ${pin} not found in design`);
          if (cur.length !== values.time.length) throw new Error("Must contain at least one instance");
        }
        return v;
      }],
    },
  },
};

function pinsCheck(db, pins) {
  if (!pins || pins.length === 0) return pins;
  const inst = instancesOf(db);
  const out = pins.map((p) => String(p).toUpperCase());
  for (const p of out) {
    if (p.includes("/")) { if (!inst.has(p.split("/")[0].toUpperCase())) throw new Error(`element of pin ${p} not found in design`); }
    else validatePorts(db, [p]);
  }
  return out;
}

/** ConstraintType 의 순서 (pydantic Union 이 이 순서로 맞춰 본다) */
export const CONSTRAINT_TYPES = [
  "Order", "Align", "Floorplan", "Spread", "AssignBboxVariables", "AspectRatio", "Boundary", "AlignInOrder", "CompactPlacement",
  "Generator", "SameTemplate", "GroupBlocks", "PlaceCloser", "PlaceOnBoundary", "DoNotIdentify", "PlaceOnGrid", "BlockDistance",
  "HorizontalDistance", "VerticalDistance", "GuardRing", "SymmetricBlocks", "GroupCaps", "NetConst", "PortLocation", "SymmetricNets",
  "MultiConnection", "DoNotRoute", "PowerPorts", "GroundPorts", "ClockPorts", "DoNotUseLib", "ConfigureCompiler", "NetPriority",
  "Route", "ChargeFlow",
];

const clone = (v) => (v == null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v)));

export class Constraint {
  /**
   * @param {ConstraintDB|null} db  만드는 맥락 (검사기가 db.parent 회로를 본다)
   * @param {object} data  { constraint, 필드... }
   */
  static create(db, data) {
    const kind = data.constraint;
    const spec = SPECS[kind];
    if (!spec) throw new Error(`unknown constraint ${kind}`);
    const c = new Constraint();
    c.constraint = kind;
    c._set = new Set(["constraint"]);
    c._parent = db;
    for (const k of Object.keys(data)) if (k !== "constraint" && !spec.fields.some(([f]) => f === k)) throw new Error(`${kind}: unknown field ${k}`);
    const values = { constraint: kind };
    for (const [f, type, dflt] of spec.fields) {
      const given = Object.prototype.hasOwnProperty.call(data, f);
      let v;
      if (given) {
        c._set.add(f);
        v = data[f];
        if (v === null || v === undefined) {
          if (dflt === REQ) throw new Error(`${kind}.${f}: no value`);
          v = null;
        } else v = coerce(type, v, `${kind}.${f}`);
      } else {
        if (dflt === REQ) throw new Error(`${kind}.${f}: required field is missing`);
        v = clone(dflt);
      }
      const vals = spec.validators?.[f];
      if (vals && ((given && v != null) || spec.always?.includes(f))) for (const fn of vals) v = fn(db, v, values);
      values[f] = v;
      c[f] = v;
    }
    return c;
  }
  get spec() { return SPECS[this.constraint]; }
  get parent() { return this._parent; }
  fields() {
    const o = {};
    for (const [f] of this.spec.fields) o[f] = true;
    return o;
  }
  hasField(f) { return this.spec.fields.some(([x]) => x === f); }
  get isHard() { return !!this.spec.hard; }
  get isUser() { return !!this.spec.user; }
  /** pydantic .dict() */
  dict({ exclude_unset = false } = {}) {
    const o = {};
    if (!exclude_unset || this._set.has("constraint")) o.constraint = this.constraint;
    for (const [f] of this.spec.fields) if (!exclude_unset || this._set.has(f)) o[f] = clone(this[f]);
    return o;
  }
  reprKey() { return this.constraint + JSON.stringify(this.dict()); }
  equals(other) { return other instanceof Constraint && JSON.stringify(this.dict()) === JSON.stringify(other.dict()); }
  /** yield_constraints() (없으면 null) */
  yieldConstraints() {
    const y = this.spec.yields;
    if (!y) return null;
    return y(this).map(([kind, data]) => Constraint.create(this._parent, { constraint: kind, ...data }));
  }
}

/** expand_user_constraints */
export function* expandUserConstraints(list) {
  for (const c of list) {
    const ys = c.yieldConstraints();
    if (ys) yield* ys;
    if (!c.isUser) yield c;
  }
}

export class ConstraintDB {
  /** @param {object} parent  이 목록을 가진 회로 (SubCircuit) */
  constructor(parent) {
    this.parent = parent;
    /** @type {Constraint[]} */
    this.items = [];
    this._cache = new Set();
  }
  [Symbol.iterator]() { return this.items[Symbol.iterator](); }
  get length() { return this.items.length; }
  at(i) { return this.items.at(i); }
  /** 사전이면 이 목록의 맥락에서 제약으로 만든다. 같은 repr 은 (지운 적이 있어도) 다시 넣지 않는다 */
  append(c) {
    if (!(c instanceof Constraint)) c = Constraint.create(this, c);
    const key = c.reprKey();
    if (this._cache.has(key)) return;
    this.items.push(c);
    this._cache.add(key);
  }
  /** 검사 없이 넣는다 (ConstraintDB 를 처음 만들 때 ALIGN 이 그렇게 한다) */
  appendRaw(c) { this.items.push(c); }
  extend(list) { for (const c of list) this.append(c); }
  includes(c) { return this.items.some((x) => x.equals(c)); }
  remove(c) {
    const i = this.items.findIndex((x) => x.equals(c));
    if (i < 0) throw new Error("list.remove(x): x not in list");
    this.items.splice(i, 1);
  }
  pop(i = -1) {
    const k = i < 0 ? this.items.length + i : i;
    return this.items.splice(k, 1)[0];
  }
  dict() { return this.items.map((c) => c.dict()); }
}

export { REQ };
