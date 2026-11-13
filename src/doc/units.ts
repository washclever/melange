/**
 * 공학 단위 (설계서 E21).
 *
 * SPICE 는 대소문자를 구분하지 않고, 접미사 뒤에 붙은 단위 글자는 무시한다.
 * 그래서 10uF 와 10u 는 같은 값이다. 함정은 M 이다 — SPICE 에서 M 은 밀리(1e-3)이고
 * 메가는 MEG 이다. 1M 을 메가로 알고 쓰는 실수가 흔해서 따로 알려 준다.
 */

const MULT: Record<string, number> = {
  f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3,
  k: 1e3, meg: 1e6, g: 1e9, t: 1e12,
};

/** meg 를 m 보다 먼저 봐야 한다 */
const SUFFIX = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(meg|[fpnumkgt])?/i;

/** "1k" -> 1000. 못 읽으면 null */
export function parseEng(s: string | undefined | null): number | null {
  if (s == null) return null;
  const m = SUFFIX.exec(String(s).trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const suf = (m[2] ?? "").toLowerCase();
  return suf ? n * MULT[suf] : n;
}

/** 값에 ASCII 가 아닌 글자가 섞였는지 (설계서 E21: 값은 ASCII 만) */
export const isAscii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

/**
 * 메가로 쓴 듯한 1M 을 잡아낸다. SPICE 에서는 밀리로 읽힌다.
 * 맞으면 안내 문구를, 아니면 null 을 준다.
 */
export function megaWarning(value: string): string | null {
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))M([a-zA-Z]*)$/.exec(value.trim());
  if (!m) return null;
  return `In "${value}", M means milli (1e-3). For mega write ${m[1]}meg`;
}

/**
 * 넷리스트 제목 줄을 ASCII 로 만든다.
 *
 * ngspice 는 제목 줄에 ASCII 가 아닌 바이트가 있으면 **오류 없이 결과를 망가뜨린다.**
 * 측정해 보면 한글 제목일 때 time 벡터 길이가 513(데이터는 512)이 되고 그 안에
 * 시간이 아니라 전류 값이 들어온다. 실패가 아니라 조용히 틀린 답이라 제일 나쁜 종류다.
 *
 * 설계서 내보내기 규칙 8은 "한글은 제목 줄에만 들어갈 수 있다" 고 했지만
 * 이 엔진에서는 그것도 안 된다. 한글 이름은 .sp 의 복원 정보(JSON)에 그대로 남으므로
 * 다시 열 때 잃지 않는다.
 */
export function asciiTitle(s: string, fallback = "circuit"): string {
  const cleaned = s.replace(/[^\x20-\x7e]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

/** µ 처럼 ASCII 밖의 글자를 SPICE 가 읽는 형태로 바꾼다 */
export function normalizeValue(s: string): string {
  return s.trim()
    .replace(/[µμ]/g, "u")   // MICRO SIGN, GREEK SMALL MU
    .replace(/[ΩΩ]/g, "")    // OHM SIGN 은 버린다
    .replace(/−/g, "-");          // MINUS SIGN
}
