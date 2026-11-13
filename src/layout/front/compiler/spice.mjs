/** SPICE 넷리스트 읽기 — ALIGN schema/parser.py (SpiceParser) 의 JS 판.
 *
 *  토큰을 ALIGN 과 같은 정규식으로 자르고(주석·이어 쓰기·주석 제약 "* @: ..."), 줄마다
 *    .SUBCKT 이름 핀... 변수=값...   서브회로를 연다 (.ENDS 에서 모아 둔 주석 제약을 붙인다)
 *    .MODEL 이름 바탕 변수=값...      파생 모델
 *    .PARAM 변수=값...                지금 범위의 변수
 *    이름 넷... 모델 변수=값...        소자 (C/R/L 로 시작하면 값 하나로 CAP/RES/IND)
 *  로 라이브러리를 채운다. 수는 단위(T G X MEG K M U N P F)를 풀고 정수면 정수로 — 그 뒤 문자열이 된다.
 */
import { Library, Model, SubCircuit, Instance, toStr } from "./schema.mjs";
import { Constraint, ConstraintDB } from "./constraint.mjs";
import { parseConstraintCall } from "./pyexpr.mjs";
import { PySet } from "../py.mjs";

const UNITS = [["T", 1e12], ["G", 1e9], ["X", 1e6], ["MEG", 1e6], ["K", 1e3], ["M", 1e-3], ["U", 1e-6], ["N", 1e-9], ["P", 1e-12], ["F", 1e-15]];

/** 파이썬 float(str) — 받지 않는 모양이면 null */
function pyFloatOrNull(s) {
  const t = s.trim().replace(/(\d)_(?=\d)/g, "$1");
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  return Number(t);
}

/** str2float — 단위 접미사를 풀어 실수로. 안 되면 null (파이썬은 ValueError) */
export function str2float(val) {
  const unit = UNITS.find(([u]) => val.endsWith(u.toUpperCase()) || val.endsWith(u.toLowerCase()));
  const num = unit ? val.slice(0, -unit[0].length) : val;
  const f = pyFloatOrNull(num);
  if (f === null) return null;
  return unit ? f * unit[1] : f;
}

const modifiers = UNITS.map(([u]) => u).join("|");
const numericval = `[+-]?(?:0|[1-9]\\d*)(?:[.]\\d+)?(?:E[+\\-]?\\d+)?(?:${modifiers})?`;
const identifier = "[^\\s{}()=;*]+";
const operator = "\\s*[*+-/%]\\s*";
const exprcontent = `(?:${numericval}|${identifier})(?:${operator}(?:${numericval}|${identifier}))*`;
const commentchars = "(?:[;$]|//)";
const TOKENS = [
  ["ANNOTATION", `(?:^|\\s)*(?:\\*|${commentchars})+\\s*@:\\s*[^\\n\\r]*`],
  ["NLCOMMENT", "(?:^|[\\n\\r])+\\*[^\\n\\r]*"],
  ["COMMENT", `(?:^|\\s)*${commentchars}[^\\n\\r]*`],
  ["CONTINUE", "(?:^|[\\n\\r])+\\+"],
  ["CONTINUEBACKSLASH", "\\\\\\s*[\\n\\r]"],
  ["NEWL", "[\\n\\r]+"],
  ["EQUALS", "\\s*=\\s*"],
  ["EXPR", `(?<quote>['"])${exprcontent}\\k<quote>|(?:\\{)${exprcontent}(?:\\})`],
  ["NUMBER", `${numericval}(?=\\s|$|${commentchars})`],
  ["DECL", `\\.${identifier}`],
  ["NAME", identifier],
  ["WS", "\\s+"],
];
const TOKEN_RE = new RegExp(TOKENS.map(([n, p]) => `(?<${n}>${p})`).join("|"), "iy");
const KEEP = new Set(["EXPR", "NUMBER", "DECL", "NAME", "NEWL", "EQUALS", "ANNOTATION"]);

export function* tokenize(text) {
  let pos = 0;
  for (;;) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(text);
    if (!m || m[0].length === 0) return;
    pos = TOKEN_RE.lastIndex;
    const type = TOKENS.find(([n]) => m.groups[n] !== undefined)[0];
    if (KEEP.has(type)) yield { type, value: m[0] };
  }
}

/** 값 하나: 수면 정수/실수, 이름은 그대로, 따옴표 식은 안쪽 */
function cast(val, ty) {
  if (ty === "EXPR") return val.slice(1, -1);
  if (ty === "NAME") return val;
  const f = str2float(val);
  if (f === null) return val;
  return Number.isInteger(f) ? f : f;
}

export class SpiceParser {
  /** @param {Library} [library] */
  constructor(library = null) {
    this.library = library ?? Library.withBuiltins();
    // 맨 바깥 범위 (서브회로 밖의 소자와 .PARAM)
    this.circuit = { name: null, pins: [], parameters: {}, elements: [], parent: this.library, getElement(n) { return this.elements.find((x) => x.name === String(n).toUpperCase()) ?? null; } };
    this.circuit.constraints = new ConstraintDB(this.circuit);
    this._scope = [this.circuit];
    this._constraints = null;
  }

  parse(text) {
    let cache = [];
    this._constraints = null;
    for (const tok of tokenize(text)) {
      if (tok.type === "NEWL") { this._dispatch(cache); cache = []; }
      else if (tok.type === "ANNOTATION") { this._dispatch(cache); cache = []; this._queueConstraint(tok.value); }
      else cache.push(tok);
    }
    this._dispatch(cache);
  }

  _dispatch(cache) {
    if (cache.length === 0) return;
    const token = cache[0];
    const [args, kwargs] = SpiceParser._decompose(cache.slice(1));
    if (token.type === "DECL") this._declaration(token.value.toUpperCase(), args, kwargs);
    else if (token.type === "NAME") this._instance(token.value.toUpperCase(), args, kwargs);
    else throw new Error(`the line does not start with a name: ${token.value}`);
  }

  _queueConstraint(annotation) {
    const c = annotation.split("@:")[1].trim();
    if (this._constraints == null) throw new Error(`Constraint ${c} can only be defined within a .SUBCKT`);
    this._constraints.push(c);
  }

  static _decompose(cache) {
    if (!cache.every((x) => ["NAME", "NUMBER", "EXPR", "EQUALS"].includes(x.type))) throw new Error(`cannot read the line: ${cache.map((x) => x.value).join(" ")}`);
    const eqIdx = [];
    cache.forEach((x, i) => { if (x.type === "EQUALS") eqIdx.push(i); });
    const assignments = new PySet(eqIdx);
    for (const i of assignments) if (cache[i - 1]?.type !== "NAME") throw new Error("no name before =");
    const args = [];
    cache.forEach((x, i) => {
      if (!(assignments.has(i - 1) || assignments.has(i) || assignments.has(i + 1))) args.push(cast(x.value.toUpperCase(), x.type));
    });
    const kwargs = {};
    for (const i of assignments) {
      const v = cache[i + 1];
      if (!v) throw new Error("no value after =");
      kwargs[cache[i - 1].value.toUpperCase()] = cast(v.value.toUpperCase(), v.type);
    }
    return [args, kwargs];
  }

  _instance(name, args, kwargs) {
    const defaults = { C: "CAP", R: "RES", L: "IND" };
    let model;
    if (["C", "R", "L"].some((x) => name.startsWith(x))) {
      model = defaults[name[0]];
      if (Object.keys(kwargs).length === 0) kwargs.VALUE = args.pop();
      else model = args.pop();
    } else model = args.pop();
    if (model === undefined) throw new Error(`${name}: no model`);
    let m = this.library.find(String(model));
    if (!m) {
      // ALIGN 은 경고 후 일반 모델을 만든다 (핀 이름 p0, p1, ...)
      m = Model.create(this.library, { name: model, pins: args.map((_, i) => `p${i}`), parameters: Object.fromEntries(Object.keys(kwargs).map((k) => [k, "1"])), prefix: "" });
      this.library.append(m);
      m = this.library.find(String(model));
    }
    if (args.length !== m.pins.length)
      throw new Error(`Model ${m.name} has ${m.pins.length} pins ${m.pins}. ${args.length} nets ${args} were passed when instantiating ${name}.`);
    const pins = new Map(m.pins.map((p, i) => [p, args[i]]));
    const scope = this._scope[this._scope.length - 1];
    scope.elements.push(Instance.create(scope, { name, model: m.name, pins, parameters: kwargs }));
  }

  _processConstraints() {
    const scope = this._scope[this._scope.length - 1];
    for (const c of this._constraints ?? []) scope.constraints.append(Constraint.create(scope.constraints, parseConstraintCall(c)));
    this._constraints = null;
  }

  _declaration(decl, args, kwargs) {
    if (decl === ".SUBCKT") {
      this._constraints = [];
      const name = args.shift();
      const found = this.library.find(String(name));
      if (found && found.kind === "SubCircuit") throw new Error(`User is attempting to redeclare subcircuit ${name}`);
      const s = SubCircuit.create(this.library, { name, pins: args, parameters: kwargs });
      this.library.append(s);
      this._scope.push(s);
    } else if (decl === ".ENDS") {
      this._processConstraints();
      this._scope.pop();
    } else if (decl === ".PARAM") {
      if (args.length) throw new Error(`unsupported arguments ${args}, probably missing default values`);
      const scope = this._scope[this._scope.length - 1];
      for (const [k, v] of Object.entries(kwargs)) scope.parameters[k.toUpperCase()] = toStr(v).toUpperCase();
    } else if (decl === ".MODEL") {
      if (args.length !== 2) throw new Error(`.MODEL ${args}`);
      const [name, base] = args;
      if (this.library.find(String(name))) throw new Error(`User is attempting to redeclare ${name}`);
      if (!this.library.find(String(base))) throw new Error(`Base model ${base} not found for model ${name}`);
      this.library.append(Model.create(this.library, { name, base, parameters: kwargs }));
    }
  }
}

export { cast as _cast };
