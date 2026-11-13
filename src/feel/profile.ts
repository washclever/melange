/**
 * 사용감 프로파일 — 편집기의 "손맛"을 만드는 값을 한곳에 모은다.
 *
 * 코드 어디에도 매직 넘버를 두지 않는다. 손맛은 코드 구조가 아니라
 * 이 숫자들과 몇 개의 순서 규칙에서 나오기 때문에, 한곳에 모아 두면
 * 측정하고 조절할 수 있는 대상이 된다.
 *
 * 프로젝트 파일(.json)에 넣지 않는다. 문서 데이터가 아니라 앱 설정이고,
 * 기본값이 바뀌면 "저장했다 열면 바이트 단위로 같다" 기준이 깨진다.
 */

/** 스냅 대상의 종류. 배열 순서가 곧 우선순위다 */
export type SnapKind = "pin" | "wireEnd" | "junction" | "wireSeg" | "grid";

export interface FeelProfile {
  id: string;

  // ── 입력 임계값
  /** 클릭이 끌기로 바뀌는 이동 거리. 윈도우 SM_CXDRAG 가 4 px, macOS 가 약 3 px */
  dragThresholdPx: number;
  /**
   * 오른쪽 버튼의 클릭과 팬을 '시간'이 아니라 '이동'으로 가른다.
   * 시간 기준은 입력 지연에 영향을 받아 느린 기기에서 다르게 동작한다.
   */
  rightPanFallbackMs: number;

  // ── 스냅
  /** 기준 스냅 반경 (화면 px). 월드 단위면 배율마다 느낌이 달라진다 */
  snapRadiusPx: number;
  /** 축소했을 때 반경이 격자 여러 칸을 덮지 않도록 격자 화면 크기로 묶는 비율 */
  snapRadiusGridFraction: number;
  /** 반경 하한 (화면 px) */
  snapRadiusMinPx: number;
  /**
   * ★ 히스테리시스. 한 번 붙으면 반경의 이 배수만큼 움직여야 떨어진다.
   * 이게 없으면 후보 둘 사이에서 커서가 떨며 지저분하게 느껴진다.
   * "딱 붙는 감각"의 절반 이상이 이 값 하나다.
   */
  snapBreakMultiplier: number;
  /** 우선순위. 앞이 셀수록 강하다 */
  snapPriority: SnapKind[];
  /**
   * 상위 계층 가산점 (화면 px). 한 단계 위 계층은 이만큼 더 멀어도 이긴다.
   * 최근접 탐색만 쓰면 의미 없는 격자점이 핀을 이겨서 틀린 느낌이 난다.
   */
  snapTierBonusPx: number;

  // ── 줌·팬
  /** 휠 한 칸의 배율. 1.25 는 튀고 1.05 는 답답하다 */
  zoomStepPerNotch: number;
  zoomMin: number;
  zoomMax: number;
  /** 트랙패드 핀치 (deltaMode=0) 의 배율 환산 */
  trackpadPinchScale: number;

  // ── 피드백 타이밍
  /** 스냅 표시는 즉시 뜬다. 0 이 아니면 지연돼 보인다 */
  snapIndicatorFadeInMs: number;
  /** 떨어질 때만 천천히 사라진다 */
  snapIndicatorFadeOutMs: number;
  /**
   * 스냅 표시의 '위치'는 절대 보간하지 않는다.
   * 투명도만 애니메이션하고 위치는 순간이동해야 즉각적으로 느껴진다.
   */
  snapIndicatorInterpolatePosition: false;
  /** 새로 생긴 연결을 잠깐 강조하는 시간 */
  newConnectionFlashMs: number;

  // ── 배선 기하
  /** 꺾임 방향이 뒤집히지 않는 밴드 (화면 px) */
  bendAxisHysteresisPx: number;
}

export const DEFAULT_PROFILE: FeelProfile = {
  id: "default-v1",
  dragThresholdPx: 4,
  rightPanFallbackMs: 500,
  snapRadiusPx: 12,
  snapRadiusGridFraction: 0.4,
  snapRadiusMinPx: 8,
  snapBreakMultiplier: 1.8,
  snapPriority: ["pin", "wireEnd", "junction", "wireSeg", "grid"],
  snapTierBonusPx: 8,
  zoomStepPerNotch: 1.15,
  zoomMin: 0.25,
  zoomMax: 16,
  trackpadPinchScale: 0.01,
  snapIndicatorFadeInMs: 0,
  snapIndicatorFadeOutMs: 100,
  snapIndicatorInterpolatePosition: false,
  newConnectionFlashMs: 220,
  bendAxisHysteresisPx: 6,
};

/** 사용자에게 노출하는 프리셋. 전체 표를 슬라이더로 열지 않는 이유는 값들이 서로 간섭해서다 */
export const PRESETS: Record<string, FeelProfile> = {
  기본: DEFAULT_PROFILE,
  또렷하게: { ...DEFAULT_PROFILE, id: "crisp", snapRadiusPx: 9, snapBreakMultiplier: 1.4, dragThresholdPx: 3 },
  느슨하게: { ...DEFAULT_PROFILE, id: "loose", snapRadiusPx: 16, snapBreakMultiplier: 2.2, dragThresholdPx: 6 },
};
