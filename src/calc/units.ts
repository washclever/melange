/**
 * 단위 — 표시 글자를 차원으로 풀어 셈하고, 다시 글자로 되돌린다.
 *
 * 예전에는 짝의 표(V·A = W, V/A = Ω …)를 찾았다. 그래서
 *   - 표에 없는 짝(Ω·F, S/F, H·F)은 단위가 지워졌고,
 *   - 지워진 단위가 '차원 없음' 과 구별되지 않아, 다음 셈에서 엉뚱한 단위가 붙었다
 *     ('모름'/Ω 이 S 가 되었다).
 *   - 숫자에 적은 단위(1kHz)는 아예 버려졌다.
 * 이제는:
 *
 *  - 전기 단위는 모두 V · A · s 의 거듭제곱이다. 길이 m 와 온도 K 를 더한다.
 *    Ω = V/A,  F = A·s/V,  H = V·s/A,  Hz = 1/s,  J = V·A·s …
 *    곱 · 나눗셈 · 거듭제곱 · 제곱근이 지수의 셈이 된다: 1/(2π·1kΩ·100nF) 는 Hz, √(kT/C) 는 V.
 *    잡음 밀도(V/√Hz)를 위해 지수는 ½ 단위까지 둔다.
 *  - dB · ° · % · ppm/… 은 곱해지는 단위가 아니다 (로그 · 각도 · 비율). 같은 것끼리 더하고 빼거나,
 *    차원 없는 수로 곱하고 나눌 때만 그 단위로 남는다. 다른 것과 곱하면 모름이다.
 *    °C 는 온도 차로 읽어 K 와 같은 차원으로 친다 — 온도 스윕의 미분이 V/K 가 된다.
 *  - 모름(UNKNOWN)은 '차원 없음'("") 과 따로 둔다. 모르는 것이 한 번 끼면 끝까지 모름이고,
 *    화면에는 빈칸으로 나온다. 틀린 단위를 붙이느니 비워 둔다.
 *
 * 값은 지금처럼 단위를 글자로 들고 다닌다 — 그래프의 축 가르기, 표시, 함수 설명이 모두 글자를 쓴다.
 * 단위 없이 적은 수는 차원 없는 수다 (2*v(out) 은 V, 1/ro(M1) 은 S). 그래서 손으로 적은 주파수를
 * 단위 없이 시뮬레이션의 Hz 로 나누면 s 가 된다 — 5033Hz 처럼 단위를 붙여 적으면 차원이 없어진다.
 */

import { UNKNOWN } from "./format.ts";

/** 단위를 모른다 — 화면에는 빈칸. 정의는 format.ts 에 있다 (첫 화면 JS 에 단위 표가 딸려 오지 않게) */
export { UNKNOWN };

/** V · A · s · m · K 의 지수 */
type Dim = readonly [number, number, number, number, number];
const BASE = ["V", "A", "s", "m", "K"] as const;
const ZERO: Dim = [0, 0, 0, 0, 0];

/*
 * 이름이 있는 단위. 같은 차원에 이름이 둘이면(V²·s 와 V²/Hz) 표시가 없는 쪽이 기본이고,
 * "hz" 가 붙은 쪽은 셈하는 값 하나라도 Hz 를 단위에 품고 있을 때(잡음 밀도를 제곱할 때) 쓴다.
 */
const NAMED: ReadonlyArray<readonly [string, Dim, "hz"?]> = [
  ["", ZERO],
  ["V", [1, 0, 0, 0, 0]], ["A", [0, 1, 0, 0, 0]], ["s", [0, 0, 1, 0, 0]], ["m", [0, 0, 0, 1, 0]], ["K", [0, 0, 0, 0, 1]],
  ["Hz", [0, 0, -1, 0, 0]],
  ["Ω", [1, -1, 0, 0, 0]], ["S", [-1, 1, 0, 0, 0]],
  ["W", [1, 1, 0, 0, 0]], ["J", [1, 1, 1, 0, 0]], ["C", [0, 1, 1, 0, 0]],
  ["F", [-1, 1, 1, 0, 0]], ["H", [1, -1, 1, 0, 0]],
  ["V/s", [1, 0, -1, 0, 0]], ["A/s", [0, 1, -1, 0, 0]],
  ["V⁻¹", [-1, 0, 0, 0, 0]], ["Hz/V", [-1, 0, -1, 0, 0]], ["A/V²", [-2, 1, 0, 0, 0]],
  ["A/m", [0, 1, 0, -1, 0]], ["V/K", [1, 0, 0, 0, -1]], ["J/K", [1, 1, 1, 0, -1]],
  ["V²", [2, 0, 0, 0, 0]], ["A²", [0, 2, 0, 0, 0]], ["Ω²", [2, -2, 0, 0, 0]], ["s²", [0, 0, 2, 0, 0]],
  ["V/√Hz", [1, 0, 0.5, 0, 0]], ["A/√Hz", [0, 1, 0.5, 0, 0]],
  ["V·s", [1, 0, 1, 0, 0]], ["V²·s", [2, 0, 1, 0, 0]], ["A²·s", [0, 2, 1, 0, 0]],
  ["V²/Hz", [2, 0, 1, 0, 0], "hz"], ["A²/Hz", [0, 2, 1, 0, 0], "hz"],
];

/** 글자 → 차원. 셈해서 새로 지은 이름도 여기에 남겨, 다음 셈에서 다시 풀린다 */
const BY_NAME = new Map<string, Dim>(NAMED.map(([n, d]) => [n, d]));
/** 온도 스윕의 축. 온도 차로 읽는다 */
BY_NAME.set("°C", [0, 0, 0, 0, 1]);

/** 차원. 곱해지지 않는 단위(dB · ° · % · ppm/…)와 모름은 null */
function dims(u: string): Dim | null {
  return u === UNKNOWN ? null : BY_NAME.get(u) ?? null;
}

const same = (a: Dim, b: Dim): boolean => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
const combine = (a: Dim, b: Dim, k: number): Dim => a.map((x, i) => x + k * b[i]) as unknown as Dim;

const SUP: Record<string, string> = { "-": "⁻", "1": "¹", "2": "²", "3": "³", "4": "⁴" };
const sup = (e: number): string => (e === 1 ? "" : String(e).replace(/./g, c => SUP[c] ?? c));

/** 차원 → 글자. 이름이 없으면 V · A · s · m · K 로 짓는다. 지을 수 없으면(분수 지수, 너무 큰 지수) 모름 */
function name(d: Dim, hz: boolean): string {
  if (hz) for (const [n, nd, tag] of NAMED) if (tag === "hz" && same(nd, d)) return n;
  for (const [n, nd, tag] of NAMED) if (!tag && same(nd, d)) return n;
  if (d.some(e => !Number.isInteger(e) || Math.abs(e) > 4)) return UNKNOWN;
  const up: string[] = [], down: string[] = [];
  d.forEach((e, i) => {
    if (e > 0) up.push(BASE[i] + sup(e));
    if (e < 0) down.push(BASE[i] + sup(-e));
  });
  // 위가 비면 '1/s²' 대신 음의 지수로 적는다 — 앞에 접두어(m, µ)가 붙어도 읽힌다
  const out = !up.length
    ? d.map((e, i) => (e < 0 ? BASE[i] + sup(e) : "")).filter(Boolean).join("·")
    : up.join("·") + (down.length ? "/" + (down.length > 1 ? "(" + down.join("·") + ")" : down[0]) : "");
  BY_NAME.set(out, d);
  return out;
}

/** 셈하는 값 하나라도 단위에 Hz 를 품었나 — 밀도를 제곱하면 V²·s 가 아니라 V²/Hz 로 적는다 */
const hz = (...us: string[]): boolean => us.some(u => u.includes("Hz"));

export function unitMul(a: string, b: string): string {
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  if (!a) return b;
  if (!b) return a;
  const da = dims(a), db = dims(b);
  if (!da || !db) return UNKNOWN;                 // dB·V, °·s …
  return name(combine(da, db, 1), hz(a, b));
}

export function unitDiv(a: string, b: string): string {
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  if (!b) return a;
  if (a === b) return "";                         // dB/dB 도 비율이다
  const da = dims(a), db = dims(b);
  if (!da || !db) return UNKNOWN;                 // V/dB, 1/° …
  return name(combine(da, db, -1), hz(a, b));
}

/**
 * 더하기 · 빼기. 단위 없는 수는 상대의 단위를 따른다 (v(out) + 0.5 는 V).
 * 차원이 다르면(V + A) 모름이다
 */
export function unitAdd(a: string, b: string): string {
  if (a === b) return a;
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  if (!a) return b;
  if (!b) return a;
  const da = dims(a), db = dims(b);
  return da && db && same(da, db) ? a : UNKNOWN;
}

/** 거듭제곱. 지수는 수여야 한다 — 파형을 지수로 쓰면 단위가 점마다 달라지므로 모름 */
export function unitPow(a: string, p: number): string {
  if (a === UNKNOWN || !Number.isFinite(p)) return UNKNOWN;
  if (!a || p === 1) return a;
  if (p === 0) return "";
  const d = dims(a);
  if (!d) return UNKNOWN;
  const out = d.map(e => e * p) as unknown as Dim;
  return out.some(e => !Number.isInteger(e * 2)) ? UNKNOWN : name(out, hz(a));
}

/** 숫자 뒤에 적은 단위 낱말 → 단위. 대소문자를 가리는 것은 S(지멘스)와 s(초) 하나뿐이다 */
export function unitWord(w: string): string {
  if (w === "S") return "S";
  const l = w.toLowerCase();
  return ({
    hz: "Hz", ohm: "Ω", ohms: "Ω", "ω": "Ω", db: "dB", deg: "°", v: "V", a: "A", s: "s",
    f: "F", h: "H", w: "W", j: "J", c: "C", m: "m", "%": "%",
  } as Record<string, string>)[l] ?? "";
}
