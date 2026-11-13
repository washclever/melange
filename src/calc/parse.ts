/**
 * 계산기 식의 문법.
 *
 *   줄     :=  [이름 '='] 식            # 이름을 주면 뒤 줄에서 그 이름으로 쓴다
 *   식     :=  항 (('+' | '-') 항)*
 *   항     :=  단항 (('*' | '/') 단항)*
 *   단항   :=  '-' 단항 | 거듭
 *   거듭   :=  기본 ['^' 단항]          # 오른쪽 결합: 2^-1, -2^2 = -(2^2)
 *   기본   :=  수 | "글자" | @경로[파라미터] | '(' 식 ')' | [보관이름 '.'] (이름 | 함수 '(' 인자 ')')
 *
 * 수는 SPICE 처럼 접미사를 받는다: 10k · 2.2meg · 5m · 1u · 3n · 1p. 뒤에 단위 글자를 붙여도 된다
 * (10uF · 1kHz · 5mV). M 은 SPICE 에서 **밀리**다 — 메가는 meg.
 *
 * v() · i() 와 소자 함수(gm(M1) …)의 인자는 식이 아니라 **이름**이다. 넷 이름에 #·.·괄호가 들어갈 수
 * 있어서(외부 .sp 의 노드, ngspice 가 만든 v(v2#input_impedance)) 괄호 짝이 맞을 때까지 글자 그대로
 * 읽는다.
 *
 * 대소문자는 가리지 않는다 — SPICE 가 그렇다. 글자("…")만 그대로 둔다.
 */
import { DEVICE_FN_NAMES } from "./devices.ts";
import { unitWord } from "./units.ts";

/** 인자를 이름으로 읽는 신호 함수 */
export const SIGNAL_FNS = new Set(["v", "i", "vdb", "vm", "vp", "vr", "vi", "idb", "im", "ip", "ir", "ii"]);

export type Node =
  | { k: "num"; v: number; pos: number; unit?: string }
  | { k: "str"; s: string; pos: number }
  | { k: "id"; name: string; scope: string | null; pos: number }
  | { k: "call"; name: string; args: Node[]; scope: string | null; pos: number }
  | { k: "sig"; fn: string; names: string[]; scope: string | null; pos: number }
  | { k: "dev"; fn: string; dev: string; param: string | null; scope: string | null; pos: number }
  | { k: "raw"; path: string; param: string; scope: string | null; pos: number }
  | { k: "neg"; a: Node; pos: number }
  | { k: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Node; b: Node; pos: number };

export interface Parsed {
  /** 'a0 = …' 의 a0 (소문자). 없으면 null */
  name: string | null;
  expr: Node | null;
  error: { msg: string; pos: number } | null;
  /** 주석뿐이거나 빈 줄 */
  blank: boolean;
  /** 고쳐야 할 것은 아니지만 알려 줄 것 (1M 이 밀리라는 것 같은) */
  warnings: string[];
}

const SUFFIX: Record<string, number> = {
  f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9, t: 1e12,
};
/**
 * 수 뒤에 붙여도 되는 단위 글자. 이것 말고 글자가 붙으면 오류다 — 2pi 를 2p 로 읽으면 안 된다.
 * 붙인 단위는 값과 함께 간다 (1kohm·100nF 는 s). F · m 은 접두어 뒤에서만 단위다 — 1F 는
 * SPICE 처럼 1 펨토, 1m 은 1 밀리, 1pF · 1um 이 단위다
 */
const UNIT_WORDS = /^(?:hz|ohms?|Ω|db|deg|v|a|s|f|h|w|j|c|m|%)/i;

class ParseError extends Error {
  pos: number;
  constructor(msg: string, pos: number) {
    super(msg);
    this.pos = pos;
  }
}

class Parser {
  s: string;
  i = 0;
  warnings: string[] = [];
  constructor(s: string) { this.s = s; }

  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  peek(): string { this.ws(); return this.s[this.i] ?? ""; }
  /** 줄 끝이나 주석이면 참 */
  atEnd(): boolean {
    this.ws();
    return this.i >= this.s.length || this.s[this.i] === "#" || this.s.startsWith("//", this.i);
  }
  eat(c: string): boolean {
    if (this.peek() === c) { this.i++; return true; }
    return false;
  }
  fail(msg: string, pos = this.i): never { throw new ParseError(msg, pos); }

  expr(): Node {
    let a = this.term();
    for (;;) {
      const c = this.peek();
      if (c !== "+" && c !== "-") return a;
      const pos = this.i++;
      a = { k: "bin", op: c, a, b: this.term(), pos };
    }
  }
  term(): Node {
    let a = this.unary();
    for (;;) {
      const c = this.peek();
      if (c === "*" && this.s[this.i + 1] === "*") return a;   // ** 는 거듭제곱 (pow 가 받는다)
      if (c !== "*" && c !== "/") return a;
      const pos = this.i++;
      a = { k: "bin", op: c, a, b: this.unary(), pos };
    }
  }
  unary(): Node {
    const c = this.peek();
    if (c === "-") { const pos = this.i++; return { k: "neg", a: this.unary(), pos }; }
    if (c === "+") { this.i++; return this.unary(); }
    return this.power();
  }
  power(): Node {
    const a = this.primary();
    this.ws();
    if (this.s[this.i] === "^" || this.s.startsWith("**", this.i)) {
      const pos = this.i;
      this.i += this.s[this.i] === "^" ? 1 : 2;
      return { k: "bin", op: "^", a, b: this.unary(), pos };
    }
    return a;
  }

  primary(): Node {
    const c = this.peek();
    const pos = this.i;
    if (!c || c === "#") this.fail("The expression ends too early");
    if (/[0-9.]/.test(c)) return this.number();
    if (c === '"' || c === "'") return this.string();
    if (c === "@") return this.raw(null);
    if (c === "(") {
      this.i++;
      const e = this.expr();
      if (!this.eat(")")) this.fail("Missing )");
      return e;
    }
    if (/[A-Za-z_]/.test(c)) {
      let name = this.ident();
      let scope: string | null = null;
      // 보관해 둔 결과: dm.v(out) · dm.@m1[gm] · dm.onoise
      if (this.s[this.i] === "." && /[A-Za-z_@]/.test(this.s[this.i + 1] ?? "")) {
        this.i++;
        scope = name;
        if (this.s[this.i] === "@") return this.raw(scope);
        name = this.ident();
      }
      const lower = name.toLowerCase();
      if (this.peek() === "(") {
        this.i++;
        if (SIGNAL_FNS.has(lower)) {
          const names = this.rawArgs(lower);
          if (names.length > 2) this.fail(`${lower}() takes one net or two (a difference)`, pos);
          if (lower.startsWith("i") && names.length !== 1) this.fail(`${lower}() takes one name`, pos);
          return { k: "sig", fn: lower, names, scope, pos };
        }
        if (DEVICE_FN_NAMES.has(lower)) {
          const a = this.rawArgs(lower);
          if (lower === "op") {
            if (a.length !== 2) this.fail("op(device, parameter) takes two names — op(M1, cgg)", pos);
            return { k: "dev", fn: lower, dev: a[0], param: a[1].replace(/^["']|["']$/g, ""), scope, pos };
          }
          if (a.length !== 1) this.fail(`${lower}() takes one part name — ${lower}(M1)`, pos);
          return { k: "dev", fn: lower, dev: a[0], param: null, scope, pos };
        }
        const args: Node[] = [];
        if (!this.eat(")")) {
          for (;;) {
            args.push(this.expr());
            if (this.eat(",")) continue;
            if (this.eat(")")) break;
            this.fail(`Expected , or ) in ${lower}()`);
          }
        }
        return { k: "call", name: lower, args, scope, pos };
      }
      return { k: "id", name: lower, scope, pos };
    }
    this.fail(`Unexpected "${c}"`);
  }

  ident(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i));
    if (!m) this.fail("Expected a name");
    this.i += m[0].length;
    return m[0];
  }

  number(): Node {
    const pos = this.i;
    const rest = this.s.slice(this.i);
    const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(rest);
    if (!m) this.fail("Expected a number");
    this.i += m[0].length;
    let v = Number(m[0]);
    const after = this.s.slice(this.i);
    const sm = /^(meg|[fpnuµmkgt])/i.exec(after);
    if (sm) {
      const suf = sm[1];
      // SPICE 의 M 은 밀리다. 계산기에서도 같게 읽되, 메가를 뜻했을 수 있으니 알려 준다
      if (suf === "M") this.warnings.push(`${m[0]}M is ${m[0]} milli (SPICE reads M as 1e-3) — for mega write ${m[0]}meg`);
      v *= SUFFIX[suf.toLowerCase()];
      this.i += suf.length;
    }
    const word = UNIT_WORDS.exec(this.s.slice(this.i));
    let unit = "";
    if (word && !/[A-Za-z0-9_]/.test(this.s[this.i + word[0].length] ?? "")) {
      unit = unitWord(word[0]);
      this.i += word[0].length;
    }
    if (/[A-Za-z_]/.test(this.s[this.i] ?? "")) {
      this.fail(`"${this.s.slice(pos, this.i)}" is followed by "${this.s[this.i]}" — write a * between a number and a name`, this.i);
    }
    return unit ? { k: "num", v, pos, unit } : { k: "num", v, pos };
  }

  string(): Node {
    const pos = this.i;
    const q = this.s[this.i++];
    const end = this.s.indexOf(q, this.i);
    if (end < 0) this.fail("The text is not closed — missing " + q, pos);
    const s = this.s.slice(this.i, end);
    this.i = end + 1;
    return { k: "str", s, pos };
  }

  /** @m1[gm] · @m.xm1.msky130_fd_pr__nfet_01v8[gm] — ngspice 의 이름 그대로 */
  raw(scope: string | null): Node {
    const pos = this.i;
    const m = /^@([^\s[\]()]+)\[([A-Za-z0-9_]+)\]/.exec(this.s.slice(this.i));
    if (!m) this.fail("Write a device parameter as @name[parameter] — @m1[gm]", pos);
    this.i += m[0].length;
    return { k: "raw", path: m[1].toLowerCase(), param: m[2].toLowerCase(), scope, pos };
  }

  /** 괄호 짝이 맞을 때까지 글자 그대로. 쉼표로 나눈다 (괄호 안의 쉼표는 나누지 않는다) */
  rawArgs(fn: string): string[] {
    const start = this.i;
    let depth = 0;
    const out: string[] = [];
    let cur = "";
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) {
          this.i++;
          out.push(cur.trim());
          if (out.some(a => !a)) this.fail(`${fn}() has an empty name`, start);
          return out;
        }
        depth--;
      } else if (c === "," && depth === 0) {
        out.push(cur.trim());
        cur = "";
        this.i++;
        continue;
      }
      cur += c;
      this.i++;
    }
    this.fail(`Missing ) after ${fn}(`, start - 1);
  }
}

/** 한 줄을 읽는다. 문법 오류는 던지지 않고 결과에 담는다 */
export function parseLine(src: string): Parsed {
  const p = new Parser(src);
  const out: Parsed = { name: null, expr: null, error: null, blank: false, warnings: p.warnings };
  try {
    if (p.atEnd()) { out.blank = true; return out; }
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(src);
    if (m) {
      out.name = m[1].toLowerCase();
      p.i = m[0].length;
      if (p.atEnd()) p.fail(`Nothing after ${m[1]} =`);
    }
    out.expr = p.expr();
    if (!p.atEnd()) p.fail(`Unexpected "${p.s[p.i]}"`);
  } catch (e) {
    if (e instanceof ParseError) out.error = { msg: e.message, pos: e.pos };
    else throw e;
  }
  return out;
}

/** 식 나무를 훑는다 (보관 이름이 붙은 노드도 포함) */
export function walk(n: Node | null, f: (n: Node) => void): void {
  if (!n) return;
  f(n);
  if (n.k === "neg") walk(n.a, f);
  else if (n.k === "bin") { walk(n.a, f); walk(n.b, f); }
  else if (n.k === "call") for (const a of n.args) walk(a, f);
}
