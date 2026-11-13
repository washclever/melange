/**
 * 정렬과 분배 (설계서 E30 · 5절).
 *
 * 좌표만 다루는 부분을 떼어 둔다. 대상은 **부품 원점**이다 — 심볼마다 크기가 달라
 * 테두리로 맞추면 원점이 격자를 벗어나고, 그러면 핀도 격자를 벗어나 연결이 끊긴다
 * (설계서 12-5: 정렬·분배 뒤에도 핀은 격자 위, 연결은 유지).
 */
import { snapGrid, type Pt } from "./types.ts";

export type AlignKind = "left" | "right" | "top" | "bottom" | "cx" | "cy";

/** 정렬 뒤 자리. 들어온 순서 그대로 돌려준다 */
export function alignTargets(ats: readonly Pt[], kind: AlignKind): Pt[] {
  if (ats.length < 2) return ats.map(p => [p[0], p[1]] as Pt);
  const xs = ats.map(p => p[0]), ys = ats.map(p => p[1]);
  const horizontal = kind === "left" || kind === "right" || kind === "cx";
  const target =
    kind === "left" ? Math.min(...xs)
    : kind === "right" ? Math.max(...xs)
    : kind === "top" ? Math.min(...ys)
    : kind === "bottom" ? Math.max(...ys)
    // 가운데는 평균이 아니라 양 끝의 한가운데다. 한쪽에 몰린 무리가 끌려가지 않는다
    : kind === "cx" ? snapGrid((Math.min(...xs) + Math.max(...xs)) / 2)
    : snapGrid((Math.min(...ys) + Math.max(...ys)) / 2);
  return ats.map(p => (horizontal ? [target, p[1]] : [p[0], target]) as Pt);
}

/**
 * 같은 간격으로 벌린 자리. 양 끝은 그대로 두고 사이를 고르게 나눈다.
 *
 * 격자에 붙이므로 간격이 한 칸씩 다를 수 있다 — 딱 떨어지는 간격보다
 * 핀이 격자 위에 있는 쪽이 중요하다.
 */
export function distributeTargets(ats: readonly Pt[], axis: "h" | "v"): Pt[] {
  const i = axis === "h" ? 0 : 1;
  if (ats.length < 3) return ats.map(p => [p[0], p[1]] as Pt);

  const order = ats.map((p, k) => k).sort((a, b) => ats[a][i] - ats[b][i]);
  const lo = ats[order[0]][i], hi = ats[order[order.length - 1]][i];
  const step = (hi - lo) / (order.length - 1);

  const out = ats.map(p => [p[0], p[1]] as Pt);
  order.forEach((idx, k) => { out[idx][i] = snapGrid(lo + step * k); });
  return out;
}

/** 지정자 재부여 순서 (설계서 E31) */
export type AnnotateOrder = "rowFirst" | "colFirst";

/**
 * 접두어마다 따로 번호를 센다 (R1 R2 … C1 C2 …).
 * rowFirst 는 읽는 순서다 — 위에서 아래로, 같은 줄은 왼쪽에서 오른쪽으로.
 */
export function annotate<T extends { at: Pt; prefix: string }>(
  parts: readonly T[], order: AnnotateOrder, start: number,
): Array<{ part: T; ref: string }> {
  const sorted = [...parts].sort((a, b) =>
    order === "rowFirst"
      ? (a.at[1] - b.at[1]) || (a.at[0] - b.at[0])
      : (a.at[0] - b.at[0]) || (a.at[1] - b.at[1]));
  const next: Record<string, number> = {};
  return sorted.map(part => {
    next[part.prefix] ??= start;
    return { part, ref: part.prefix + next[part.prefix]++ };
  });
}
