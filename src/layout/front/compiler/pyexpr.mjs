/** 넷리스트 주석 제약 읽기 — "* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')".
 *
 *  ALIGN 은 이 줄을 파이썬 eval 로 읽는다. 여기서는 그 안의 작은 문법만 읽는다:
 *  이름(키워드 인자...) 호출 하나, 값은 문자열·수·True/False/None·[목록]·(튜플)·{사전}.
 *  결과는 { constraint: 이름, 인자... } 사전이다 (constraint.mjs 가 검사한다).
 */
export function parseConstraintCall(src) {
  let i = 0;
  const s = src;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const fail = (msg) => { throw new Error(`cannot read the constraint comment (${msg}): ${src}`); };
  const ident = () => {
    ws();
    const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(s.slice(i));
    if (!m) fail("no name");
    i += m[0].length;
    return m[0];
  };
  const expect = (ch) => { ws(); if (s[i] !== ch) fail(`expected '${ch}'`); i++; };
  const value = () => {
    ws();
    const c = s[i];
    if (c === "'" || c === '"') {
      const q = c;
      let out = "";
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\") {
          const n = s[i + 1];
          out += n === "n" ? "\n" : n === "t" ? "\t" : n;
          i += 2;
        } else out += s[i++];
      }
      if (s[i] !== q) fail("unterminated string");
      i++;
      return out;
    }
    if (c === "[" || c === "(") {
      const close = c === "[" ? "]" : ")";
      i++;
      const out = [];
      ws();
      while (s[i] !== close) {
        out.push(value());
        ws();
        if (s[i] === ",") { i++; ws(); } else if (s[i] !== close) fail(`expected '${close}'`);
      }
      i++;
      return out;
    }
    if (c === "{") {
      i++;
      const out = {};
      ws();
      while (s[i] !== "}") {
        const k = value();
        expect(":");
        out[String(k)] = value();
        ws();
        if (s[i] === ",") { i++; ws(); } else if (s[i] !== "}") fail("expected '}'");
      }
      i++;
      return out;
    }
    const m = /^[+-]?(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?)/i.exec(s.slice(i));
    if (m) { i += m[0].length; return Number(m[0]); }
    const w = /^(True|False|None)\b/.exec(s.slice(i));
    if (w) { i += w[0].length; return w[0] === "True" ? true : w[0] === "False" ? false : null; }
    fail("cannot read the value");
  };
  const name = ident();
  expect("(");
  const out = { constraint: name };
  ws();
  while (s[i] !== ")") {
    const k = ident();
    expect("=");
    out[k] = value();
    ws();
    if (s[i] === ",") { i++; ws(); } else if (s[i] !== ")") fail("expected ')'");
  }
  i++;
  ws();
  if (i < s.length) fail("trailing characters");
  return out;
}
