/**
 * 스냅 판정 — "딱 붙는 감각"의 실체.
 *
 * 순수 함수로 둔다. 캔버스도 DOM 도 모르기 때문에 그대로 테스트할 수 있고,
 * 손맛을 수치로 잴 수 있다 (tools/verify-snap.ts).
 */
import type { FeelProfile, SnapKind } from "./profile.ts";

/** 월드 좌표. 10 mil 단위 정수 (설계서의 데이터 모델) */
export type Pt = [number, number];

export interface SnapTarget {
  kind: SnapKind;
  at: Pt;
  /** 어떤 객체의 어느 지점인지. 히스테리시스가 같은 대상을 알아보는 데 쓴다 */
  ref: string;
}

export interface SnapResult {
  target: SnapTarget;
  /** 보통 반경 밖인데 히스테리시스로 붙어 있는 상태 (계측·디버그용) */
  heldByHysteresis: boolean;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * 실제로 쓸 스냅 반경 (화면 px).
 * 축소했을 때 기준 반경이 격자 여러 칸을 덮으면 어느 칸에 붙을지 모호해지므로
 * 격자의 화면 크기에 비례해 묶고, 하한을 둔다.
 */
export function snapRadiusPx(p: FeelProfile, gridPx: number): number {
  return Math.max(p.snapRadiusMinPx, Math.min(p.snapRadiusPx, p.snapRadiusGridFraction * gridPx));
}

/** 커서에서 가장 가까운 격자점. 항상 존재하는 최후의 스냅 대상이다 */
export function nearestGrid(cursor: Pt, gridWorld: number): SnapTarget {
  const x = Math.round(cursor[0] / gridWorld) * gridWorld;
  const y = Math.round(cursor[1] / gridWorld) * gridWorld;
  return { kind: "grid", at: [x, y], ref: `grid:${x},${y}` };
}

/**
 * 커서가 붙을 대상을 정한다.
 *
 * 히스테리시스를 '반경 연장'이 아니라 '현 대상에게 주는 점수 보너스'로 모델링한다.
 * 반경만 늘리면 같은 계층의 다른 대상으로 영영 못 옮겨 간다 — 커서가 B 핀 바로
 * 위에 있어도 A 핀에 붙은 채로 남는다. 점수 보너스로 두면 폭 2*보너스 짜리
 * 불감대가 생겨서, 떨림은 막으면서 확실히 더 가까운 대상으로는 넘어간다.
 *
 * 조절 손잡이는 snapBreakMultiplier 하나이고 두 가지로 쓰인다:
 *   - 현 대상이 붙어 있을 수 있는 최대 거리 = 반경 * 배수
 *   - 현 대상이 받는 점수 보너스       = 반경 * (배수 - 1)
 *
 * 계층 가산점이 있어서 '상위 계층이 뺏는다'는 규칙은 따로 둘 필요가 없다.
 * 격자(최하위)에 붙어 있어도 핀이 반경 안에 들어오면 점수에서 이긴다.
 */
export function resolveSnap(
  cursor: Pt,
  candidates: readonly SnapTarget[],
  prev: SnapTarget | null,
  p: FeelProfile,
  scale: number,          // 월드 1단위당 화면 px
  gridWorld: number,
): SnapResult {
  const radPx = snapRadiusPx(p, gridWorld * scale);
  const radWorld = radPx / scale;
  const breakWorld = radWorld * p.snapBreakMultiplier;
  const holdBonusPx = radPx * (p.snapBreakMultiplier - 1);

  const tier = (k: SnapKind) => {
    const i = p.snapPriority.indexOf(k);
    return i < 0 ? p.snapPriority.length : i;
  };

  const grid = nearestGrid(cursor, gridWorld);

  // 현 대상을 지금 후보 목록에서 다시 찾는다 (객체가 움직였을 수 있다)
  const incumbent: SnapTarget | null = prev
    ? (prev.kind === "grid"
        ? (prev.ref === grid.ref ? grid : null)
        : candidates.find(c => c.ref === prev.ref) ?? null)
    : null;
  const incumbentRef =
    incumbent && dist(cursor, incumbent.at) <= breakWorld ? incumbent.ref : null;

  const score = (t: SnapTarget) =>
    dist(cursor, t.at) * scale
    + tier(t.kind) * p.snapTierBonusPx
    - (t.ref === incumbentRef ? holdBonusPx : 0);

  // 자격: 보통 반경 안. 격자는 바닥이라 항상, 현 대상은 break 반경까지 남는다
  const eligible: SnapTarget[] = [grid];
  for (const c of candidates) {
    const d = dist(cursor, c.at);
    if (d <= radWorld || c.ref === incumbentRef) eligible.push(c);
  }

  const best = eligible.reduce((a, b) => (score(b) < score(a) ? b : a));
  return {
    target: best,
    heldByHysteresis: best.ref === incumbentRef && dist(cursor, best.at) > radWorld,
  };
}
