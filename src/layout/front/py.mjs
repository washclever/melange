/** 파이썬의 몇 가지 동작 — ALIGN 앞단을 옮기면서 결과가 파이썬과 똑같이 나오도록.
 *
 *  ALIGN 은 집합(set)을 자주 돌고, 그 순서가 도형의 순서와 트랙 배정을 정한다. 파이썬 집합의 순서는
 *  해시와 표 크기로 정해지므로, 여기서 CPython(64 비트)의 해시와 집합 표를 그대로 흉내 낸다.
 *  문자열 해시는 PYTHONHASHSEED=0 일 때의 값(SipHash-1-3, 열쇠 0)이다 — 기준 실행도 그렇게 돌린다.
 *
 *    fdiv(a, b), divmod(a, b)   정수 // 와 divmod (음수에서 아래로 내림)
 *    pyHash(v)                  hash(v) — 정수, 문자열, 튜플(배열), None(null), bool
 *    PySet                      set — add / has / discard, 돌면 CPython 과 같은 순서
 *    pyEq(a, b), pyCmp(a, b)    == 와 < (튜플은 사전식)
 *    pyRepr(v)                  repr — 이름을 만들 때 (str, int, float, 튜플)
 *    roundHalfEven(x, nd)       round(x, nd)
 */

// ---------------------------------------------------------------- 정수 나눗셈
export const fdiv = (a, b) => Math.floor(a / b);
export function divmod(a, b) {
  const q = Math.floor(a / b);
  return [q, a - q * b];
}

// ---------------------------------------------------------------- 해시
const M64 = (1n << 64n) - 1n;
const MOD61 = (1n << 61n) - 1n;
const u64 = (x) => x & M64;
const s64 = (x) => (x & (1n << 63n) ? (x & M64) - (1n << 64n) : x & M64);
const rotl = (x, b) => u64((x << BigInt(b)) | (x >> BigInt(64 - b)));

/** SipHash-1-3, 열쇠 (0, 0) — CPython 3.11+ 의 기본 문자열 해시 */
function siphash13(bytes) {
  const k0 = 0n, k1 = 0n;
  let v0 = k0 ^ 0x736f6d6570736575n, v1 = k1 ^ 0x646f72616e646f6dn;
  let v2 = k0 ^ 0x6c7967656e657261n, v3 = k1 ^ 0x7465646279746573n;
  const round = () => {
    v0 = u64(v0 + v1); v2 = u64(v2 + v3);
    v1 = rotl(v1, 13) ^ v0; v3 = rotl(v3, 16) ^ v2;
    v0 = rotl(v0, 32);
    v2 = u64(v2 + v1); v0 = u64(v0 + v3);
    v1 = rotl(v1, 17) ^ v2; v3 = rotl(v3, 21) ^ v0;
    v2 = rotl(v2, 32);
  };
  const n = bytes.length;
  let i = 0;
  for (; i + 8 <= n; i += 8) {
    let mi = 0n;
    for (let k = 7; k >= 0; k--) mi = (mi << 8n) | BigInt(bytes[i + k]);
    v3 ^= mi; round(); v0 ^= mi;
  }
  let t = 0n;
  for (let k = n - 1; k >= i; k--) t = (t << 8n) | BigInt(bytes[k]);
  const b = u64((BigInt(n) << 56n) | t);
  v3 ^= b; round(); v0 ^= b;
  v2 ^= 0xffn;
  round(); round(); round();
  return u64((v0 ^ v1) ^ (v2 ^ v3));
}

/** 문자열의 내부 표현 바이트 (latin-1 / UCS-2 / UCS-4, 작은 끝) */
function strBytes(s) {
  const cps = Array.from(s, (c) => c.codePointAt(0));
  const max = cps.reduce((m, c) => Math.max(m, c), 0);
  const w = max < 256 ? 1 : max < 65536 ? 2 : 4;
  const out = new Uint8Array(cps.length * w);
  cps.forEach((c, i) => { for (let k = 0; k < w; k++) out[i * w + k] = (c >> (8 * k)) & 0xff; });
  return out;
}

const strCache = new Map();
function strHash(s) {
  let h = strCache.get(s);
  if (h === undefined) {
    if (s.length === 0) h = 0n;
    else {
      h = s64(siphash13(strBytes(s)));
      if (h === -1n) h = -2n;
    }
    if (strCache.size > 100000) strCache.clear();
    strCache.set(s, h);
  }
  return h;
}

function intHash(n) {
  const x = BigInt(n);
  const neg = x < 0n;
  let h = (neg ? -x : x) % MOD61;
  if (neg) h = -h;
  return h === -1n ? -2n : h;
}

const XXP1 = 11400714785074694791n, XXP2 = 14029467366897019727n, XXP5 = 2870177450012600261n;
function tupleHash(a) {
  let acc = XXP5;
  for (const v of a) {
    const lane = u64(pyHash(v));
    acc = u64(acc + u64(lane * XXP2));
    acc = rotl(acc, 31);
    acc = u64(acc * XXP1);
  }
  acc = u64(acc + (BigInt(a.length) ^ (XXP5 ^ 3527539n)));
  if (acc === M64) return 1546275796n;
  return s64(acc);
}

/** hash(v) — BigInt (Py_hash_t, 부호 있는 64 비트) */
export function pyHash(v) {
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`pyHash: float hashing is not implemented (${v})`);
    return intHash(v);
  }
  if (typeof v === "string") return strHash(v);
  if (typeof v === "boolean") return v ? 1n : 0n;
  if (v === null) return 0xfca86420n; // 3.12+ 의 hash(None)
  if (Array.isArray(v)) return tupleHash(v);
  throw new Error(`pyHash: unsupported value ${typeof v}`);
}

// ---------------------------------------------------------------- 비교
export function pyEq(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  return false;
}

/** a < b 이면 음수, 같으면 0 — 수, 문자열(코드 포인트 순), 튜플(사전식) */
export function pyCmp(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (!pyEq(a[i], b[i])) return pyCmp(a[i], b[i]);
    }
    return a.length - b.length;
  }
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") {
    const x = Array.from(a), y = Array.from(b);
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
      const p = x[i].codePointAt(0), q = y[i].codePointAt(0);
      if (p !== q) return p - q;
    }
    return x.length - y.length;
  }
  throw new Error(`pyCmp: cannot compare ${typeof a} ${typeof b}`);
}

// ---------------------------------------------------------------- 집합
const MINSIZE = 8, LINEAR_PROBES = 9, PERTURB_SHIFT = 5n;
const DUMMY = Symbol("dummy");

/** CPython set 과 같은 표 — 도는 순서가 같다 (Objects/setobject.c). */
export class PySet {
  constructor(items = null) {
    this._reset(MINSIZE);
    if (items) for (const x of items) this.add(x);
  }
  _reset(size) {
    this.mask = size - 1;
    this.keys = new Array(size).fill(undefined);
    this.hashes = new Array(size).fill(0n);
    this.fill = 0;
    this.used = 0;
  }
  get size() { return this.used; }

  _insertClean(keys, hashes, mask, key, hash) {
    let perturb = u64(hash);
    let i = Number(u64(hash) & BigInt(mask));
    for (;;) {
      if (keys[i] === undefined) break;
      let found = false;
      if (i + LINEAR_PROBES <= mask) {
        for (let j = 1; j <= LINEAR_PROBES; j++) {
          if (keys[i + j] === undefined) { i += j; found = true; break; }
        }
      }
      if (found) break;
      perturb >>= PERTURB_SHIFT;
      i = Number(u64(BigInt(i) * 5n + 1n + perturb) & BigInt(mask));
    }
    keys[i] = key;
    hashes[i] = hash;
  }

  _resize(minused) {
    let newsize = MINSIZE;
    while (newsize <= minused) newsize <<= 1;
    const oldKeys = this.keys, oldHashes = this.hashes;
    const keys = new Array(newsize).fill(undefined), hashes = new Array(newsize).fill(0n);
    for (let i = 0; i < oldKeys.length; i++) {
      const k = oldKeys[i];
      if (k !== undefined && k !== DUMMY) this._insertClean(keys, hashes, newsize - 1, k, oldHashes[i]);
    }
    this.keys = keys; this.hashes = hashes; this.mask = newsize - 1;
    this.fill = this.used;
  }

  /** 있으면 칸 번호, 없으면 -1 */
  _find(key, hash) {
    const mask = this.mask;
    let perturb = u64(hash);
    let i = Number(u64(hash) & BigInt(mask));
    for (;;) {
      let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      let e = i;
      do {
        const k = this.keys[e];
        if (k === undefined) return -1;
        if (k !== DUMMY && this.hashes[e] === hash && pyEq(k, key)) return e;
        e++;
      } while (probes--);
      perturb >>= PERTURB_SHIFT;
      i = Number(u64(BigInt(i) * 5n + 1n + perturb) & BigInt(mask));
    }
  }

  add(key) {
    const hash = pyHash(key);
    const mask = this.mask;
    let perturb = u64(hash);
    let i = Number(u64(hash) & BigInt(mask));
    let freeslot = -1;
    for (;;) {
      let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      let e = i;
      do {
        const k = this.keys[e];
        if (k === undefined) {
          if (freeslot >= 0) {
            this.used++;
            this.keys[freeslot] = key; this.hashes[freeslot] = hash;
            return this;
          }
          this.fill++; this.used++;
          this.keys[e] = key; this.hashes[e] = hash;
          if (this.fill * 5 >= mask * 3) this._resize(this.used > 50000 ? this.used * 2 : this.used * 4);
          return this;
        }
        if (k === DUMMY) freeslot = e; // 3.13: 지나간 칸 중 마지막 빈 칸
        else if (this.hashes[e] === hash && pyEq(k, key)) return this;
        e++;
      } while (probes--);
      perturb >>= PERTURB_SHIFT;
      i = Number(u64(BigInt(i) * 5n + 1n + perturb) & BigInt(mask));
    }
  }

  has(key) { return this._find(key, pyHash(key)) >= 0; }

  discard(key) {
    const e = this._find(key, pyHash(key));
    if (e < 0) return false;
    this.keys[e] = DUMMY; this.hashes[e] = -1n;
    this.used--;
    return true;
  }

  *[Symbol.iterator]() {
    for (const k of this.keys) if (k !== undefined && k !== DUMMY) yield k;
  }
  values() { return this[Symbol.iterator](); }
  toArray() { return [...this]; }

  /** [키, 해시] 를 표 순서대로 */
  *_entries() {
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[i];
      if (k !== undefined && k !== DUMMY) yield [k, this.hashes[i]];
    }
  }

  _addEntry(key, hash) {
    // add() 와 같다 (해시를 다시 구하지 않는다)
    const mask = this.mask;
    let perturb = u64(hash);
    let i = Number(u64(hash) & BigInt(mask));
    let freeslot = -1;
    for (;;) {
      let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      let e = i;
      do {
        const k = this.keys[e];
        if (k === undefined) {
          if (freeslot >= 0) {
            this.used++;
            this.keys[freeslot] = key; this.hashes[freeslot] = hash;
            return;
          }
          this.fill++; this.used++;
          this.keys[e] = key; this.hashes[e] = hash;
          if (this.fill * 5 >= mask * 3) this._resize(this.used > 50000 ? this.used * 2 : this.used * 4);
          return;
        }
        if (k === DUMMY) freeslot = e; // 3.13: 지나간 칸 중 마지막 빈 칸
        else if (this.hashes[e] === hash && pyEq(k, key)) return;
        e++;
      } while (probes--);
      perturb >>= PERTURB_SHIFT;
      i = Number(u64(BigInt(i) * 5n + 1n + perturb) & BigInt(mask));
    }
  }

  /** set_merge — 다른 집합을 이 집합에 (CPython 의 복사 경로 그대로) */
  _merge(other) {
    if (other === this || other.used === 0) return;
    if ((this.fill + other.used) * 5 >= this.mask * 3) this._resize((this.used + other.used) * 2);
    if (this.fill === 0 && this.mask === other.mask && other.fill === other.used) {
      for (let i = 0; i <= other.mask; i++) {
        const k = other.keys[i];
        if (k !== undefined) { this.keys[i] = k; this.hashes[i] = other.hashes[i]; }
      }
      this.fill = other.fill;
      this.used = other.used;
      return;
    }
    if (this.fill === 0) {
      this.fill = other.used;
      this.used = other.used;
      for (const [k, h] of other._entries()) this._insertClean(this.keys, this.hashes, this.mask, k, h);
      return;
    }
    for (const [k, h] of other._entries()) this._addEntry(k, h);
  }

  /** set.update(iterable) */
  update(items) {
    if (items instanceof PySet) this._merge(items);
    else for (const x of items) this.add(x);
    return this;
  }

  copy() {
    const s = new PySet();
    s._merge(this);
    return s;
  }

  _discardKey(key, hash) {
    const e = this._find(key, hash);
    if (e < 0) return false;
    this.keys[e] = DUMMY; this.hashes[e] = -1n;
    this.used--;
    return true;
  }

  /** set.difference_update(iterable) */
  differenceUpdate(items) {
    if (items instanceof PySet) {
      let other = items;
      if ((other.used >> 3) > this.used) other = this.intersection(other);
      for (const [k, h] of other._entries()) this._discardKey(k, h);
    } else {
      for (const x of items) this._discardKey(x, pyHash(x));
    }
    if (this.fill - this.used <= Math.floor(this.mask / 4)) return this;
    this._resize(this.used > 50000 ? this.used * 2 : this.used * 4);
    return this;
  }

  /** a - b, a.difference(b) */
  difference(items) {
    if (!(items instanceof PySet)) return this.copy().differenceUpdate(items);
    if ((this.used >> 2) > items.used) return this.copy().differenceUpdate(items);
    const out = new PySet();
    for (const [k, h] of this._entries()) if (items._find(k, h) < 0) out._addEntry(k, h);
    return out;
  }

  /** a & b, a.intersection(b) */
  intersection(items) {
    if (items === this) return this.copy();
    const out = new PySet();
    if (items instanceof PySet) {
      let so = this, other = items;
      if (other.used > so.used) [so, other] = [other, so];
      for (const [k, h] of other._entries()) if (so._find(k, h) >= 0) out._addEntry(k, h);
      return out;
    }
    for (const x of items) { const h = pyHash(x); if (this._find(x, h) >= 0) out._addEntry(x, h); }
    return out;
  }

  /** a | b */
  union(items) {
    const out = this.copy();
    out.update(items);
    return out;
  }

  /** 집합 == 집합 (순서 무관) */
  equals(other) {
    if (!(other instanceof PySet) || other.size !== this.size) return false;
    for (const [k, h] of this._entries()) if (other._find(k, h) < 0) return false;
    return true;
  }
}

// ---------------------------------------------------------------- str() / repr()
/** 파이썬 실수 표시 (정수인 실수는 PyFloat 로 싸서 넘긴다) */
export class PyFloat {
  constructor(v) { this.v = v; }
  valueOf() { return this.v; }
}

function strRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += "\\" + q;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + q;
}

/** repr(v) — 중첩 값 (list/tuple/dict/set/str/int/float/bool/None).
 *  JS 배열은 list, { __tuple: [...] } 는 tuple, Map 과 일반 객체는 dict, PySet 은 set. */
export function pyReprValue(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return strRepr(v);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : floatRepr(v);
  if (v instanceof PyFloat) return floatRepr(v.v);
  if (typeof v === "bigint") return String(v);
  if (Array.isArray(v)) return "[" + v.map(pyReprValue).join(", ") + "]";
  if (v instanceof PySet) return v.size ? "{" + [...v].map(pyReprValue).join(", ") + "}" : "set()";
  if (v.__tuple) return v.__tuple.length === 1 ? `(${pyReprValue(v.__tuple[0])},)` : "(" + v.__tuple.map(pyReprValue).join(", ") + ")";
  const entries = v instanceof Map ? [...v] : Object.entries(v);
  return "{" + entries.map(([k, x]) => `${pyReprValue(k)}: ${pyReprValue(x)}`).join(", ") + "}";
}

/** str(v) — 문자열은 그대로, 나머지는 repr */
export const pyStr = (v) => (typeof v === "string" ? v : pyReprValue(v));

// ---------------------------------------------------------------- 문자열로
/** repr(float) — 가장 짧은 왕복 표기, 파이썬 모양 (1e-06, 1.5, 100.0) */
export function floatRepr(x) {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const e = Math.floor(Math.log10(Math.abs(x)));
  let exp = x.toExponential(); // "1.05e-6"
  let [mant, ex] = exp.split("e");
  let n = Number(ex);
  // toExponential() 의 지수가 log10 어림과 어긋날 수 있다 — 자릿수는 toExponential 을 믿는다
  void e;
  if (n < -4 || n >= 16) {
    const sign = n < 0 ? "-" : "+";
    const mag = String(Math.abs(n)).padStart(2, "0");
    return `${mant}e${sign}${mag}`;
  }
  const s = String(x);
  return /[.e]/.test(s) ? s : s + ".0";
}

export function pyRepr(v) {
  if (typeof v === "string") return `'${v}'`;
  if (typeof v === "number") return Number.isInteger(v) && !Object.is(v, -0) && Math.abs(v) < 1e16 && v === Math.trunc(v) && !String(v).includes("e") ? String(v) : floatRepr(v);
  if (Array.isArray(v)) return v.length === 1 ? `(${pyRepr(v[0])},)` : `(${v.map(pyRepr).join(", ")})`;
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  throw new Error(`pyRepr: unsupported value ${typeof v}`);
}

/** round(x, nd) — 짝수 쪽으로 (파이썬은 십진 표기를 보고 정확히 반올림한다) */
export function roundHalfEven(x, nd = 0) {
  const f = 10 ** nd;
  const y = x * f;
  const r = Math.round(y);
  const isHalf = Math.abs(y % 1) === 0.5;
  const out = isHalf ? (r % 2 === 0 ? r : r - 1) : r;
  return out / f;
}
