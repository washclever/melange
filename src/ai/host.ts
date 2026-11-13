/**
 * 어시스턴트와 편집기 사이의 경계 — 편집기(app.ts)가 이것을 구현한다.
 *
 * app.ts 는 모듈 전역 상태로 된 편집기라 어시스턴트가 직접 만질 수 없다. 부품 라이브러리 창의
 * LibraryHost(src/ui/library.ts)처럼 필요한 것만 이 모양으로 건넨다. 어시스턴트 쪽 코드는 이것만
 * 보므로 DOM 없이도 돈다 — 검증(tools/verify-ai-*.ts)은 문서 하나로 만든 가짜 편집기를 넣는다.
 *
 * 타입만 있는 파일이다. app.ts 가 이것을 가져와도 어시스턴트 본체는 첫 화면에 실리지 않는다.
 */
import type { Command, Group } from "../doc/history.ts";
import type { SheetIndex } from "../doc/sheet-index.ts";
import type { LibPart, Project, Sheet } from "../doc/types.ts";
import type { Extraction } from "../net/extract.ts";
import type { Issue } from "../net/netlist.ts";
import type { Measurement } from "../sim-measure.ts";
import type { Trace } from "../sim-values.ts";

/** 문서를 바꾼 것이 누구인가 (load: 문서를 통째로 갈아끼웠다) */
export type ChangeSource = "user" | "ai" | "load";

/** 시뮬레이션 하나가 어떻게 끝났나 */
export interface RunOutcome {
  ok: boolean;
  /** check: 실행 전 검사에 걸려 돌리지 않았다 · engine: 엔진이 실패했다 · stopped: 멈췄다 */
  stage?: "check" | "engine" | "stopped";
  /** 사람 말로 옮긴 실패 이유 */
  error?: string;
  issues?: Issue[];
  runMs?: number;
}

/** 지난 실행의 결과 */
export interface Results {
  traces: readonly Trace[];
  measures: readonly Measurement[];
  /** 돌린 해석 종류 */
  kind: string | undefined;
  /** 결과가 지금 회로의 것인가 — 돌린 뒤로 문서를 고치지 않았다 */
  current: boolean;
  /** 엔진의 로그 (안내 · 경고) */
  log: string;
}

/** 계산기 줄 하나의 값 */
export interface CalcRow {
  src: string;
  name: string | null;
  /** 값을 한 줄 글로 (오류면 error: …) */
  text: string;
  error: string | null;
  warnings: string[];
}

/** 모델에게 보여 줄 그림 하나 */
export interface Picture {
  /** data: URL (PNG · JPEG) */
  url: string;
  width: number;
  height: number;
  /** 그림을 읽을 때 알아 둘 것 (글자가 작다, 몇 개만 그렸다 …) */
  note?: string;
}

/** 파형 그림에 무엇을 그렸나 */
export interface WavePicture extends Picture {
  /** 그린 신호 이름 (엔진의 이름 그대로: v(out)) */
  shown: string[];
  /** 가로축: time · frequency · 쓸어 올린 값 */
  axis: string;
  /** 그린 가로 범위 (실제 값) */
  from: number;
  to: number;
}

/** 배치 편집 하나 — 블록 하나를 옮기고(왼쪽 아래 x, y 또는 dx, dy · nm) 뒤집고 variant 를 바꾸고 잠근다 */
export interface PlacementEdit {
  block: string;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  flip?: "x" | "y" | "xy";
  variant?: string;
  lock?: boolean;
}

/** 레이아웃 편집기에서 하는 것 — 넷 잇기(사람처럼 트랙 그리기), 다 잇기, 남은 넷만 자동 배선, 넷의 트랙 지우기, 되돌리기 */
export type RoutingAction = "connect_net" | "connect_all" | "route_unfinished" | "delete_net" | "undo" | "redo";

export type LayoutView = "circuit" | "placement" | "layout" | "circuit+placement" | "placement+layout" | "all";

/**
 * 레이아웃 (Placement · Layout 편집기) — src/layout/ui/ai.mjs 가 만든다. 처음 쓸 때 레이아웃 덩어리를 받는다.
 * 편집기 화면의 단추와 같은 함수를 부르고, 오래 걸리는 것(배치 · 배선)은 끝날 때까지 기다린다. 결과는 모델에게
 * 그대로 보낼 수 있는 값이다. 할 수 없는 것은 name 이 "LayoutError" 인 오류로 던진다 (도구가 모델에게 돌려준다)
 */
export interface LayoutControl {
  /** 회로도에서 읽은 것 · 블록 · 배치 · 배선 · 보이는 편집기 */
  status(): Record<string, unknown>;
  /** 한 줄 요약 (요청마다 상황 설명에 싣는다) */
  brief(): string;
  /** 회로도를 다시 읽어 블록을 만든다 */
  read(opt?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  /** 자동 배치 */
  place(opt?: { effort?: "fast" | "normal" | "wide"; wirelengthWeight?: number; signal?: AbortSignal }): Promise<Record<string, unknown>>;
  /** 배치를 손으로 고친다 (편집기의 끌기 · 뒤집기 · variant · 잠금 · 자리 바꾸기 · 정리 · 위상 유지 최적화) */
  editPlacement(opt: { edits?: PlacementEdit[]; swap?: string[] | null; settle?: boolean; optimize?: boolean; signal?: AbortSignal }): Promise<Record<string, unknown>>;
  /** 자동 배선 — 고를 수 있다 (keepDrawn: 다 이은 넷은 그대로 두고 나머지만) */
  route(opt?: { keepDrawn?: boolean; signal?: AbortSignal }): Promise<Record<string, unknown>>;
  /** 배선 고치기 */
  fixRouting(opt: { action: RoutingAction; net?: string; signal?: AbortSignal }): Promise<Record<string, unknown>>;
  /** 편집기를 보이고, 넷이나 블록을 강조한다 */
  show(opt: { view?: LayoutView; net?: string | null; blocks?: string[] }): Record<string, unknown>;
  /** 편집기 화면을 그림으로 */
  image(opt: { editor: "placement" | "layout" }): Promise<Picture | { error: string }>;
}

export interface AssistantHost {
  // ── 읽기 ──
  project(): Project;
  sheet(): Sheet;
  library(): Record<string, LibPart>;
  /** 지금 문서의 넷 추출 (커밋마다 맞춰진다) */
  extraction(): Extraction;
  /** 지금 문서의 시트 색인 (커밋마다 맞춰진다) */
  index(): SheetIndex;
  /** 실행 전 검사 결과 */
  issues(): Issue[];
  /** 넷리스트 탭과 같은 글 */
  netlist(): string;
  /** 외부 .sp 를 텍스트로 연 상태 — 회로도는 실행되는 넷리스트가 아니다 */
  external(): boolean;
  /** 고른 것 ("part:id" 꼴) */
  selection(): string[];
  /** 지난 실행. 아직 없으면 null */
  results(): Results | null;
  /** 지난 실행이 실패했으면 그 이유 (없으면 빈 글) */
  lastError(): string;
  /** 대화를 프로젝트마다 두는 열쇠 */
  projectKey(): string;

  // ── 쓰기 ──
  /** 명령을 기록을 거쳐 적용한다. 같은 꼬리표는 실행 취소 한 단계로 묶인다 */
  edit(cmd: Command, group: Group): void;
  /** 맨 위 실행 취소 단계의 꼬리표 */
  undoGroup(): string | undefined;
  /** 맨 위 단계를 되돌린다 (사람이 누른 것으로 친다) */
  undo(): void;

  // ── 실행 ──
  simulate(): Promise<RunOutcome>;
  /** 도는 시뮬레이션을 멈춘다 */
  stopSimulation(): void;

  // ── 계산기 (필요할 때 받는다) ──
  /** 프로젝트의 계산기 줄을 지난 실행으로 계산한 값. 계산기를 못 받았으면 null */
  calcValues(): Promise<CalcRow[] | null>;
  /** 계산기 함수 목록 (이름 · 인자 · 설명). 분류를 주면 그것만 */
  calcReference(category?: string): Promise<string>;

  // ── 보기 ──
  /** 그것들을 골라 화면에 보여 준다. net 을 주면 그 넷을 강조한다 (H 키와 같다 — null 이면 강조를 끈다) */
  show(keys: string[], net?: string | null): void;
  /**
   * 회로도를 그림으로 — PNG 내보내기와 같은 그림에 넷 이름을 적는다. parts(부품 id)를 주면 그 둘레만.
   * 그릴 것이 없으면 null
   */
  schematicImage(opt: { parts?: string[] }): Picture | null;
  /**
   * 지난 결과를 그래프로 — 파형 탭과 같은 그림에 범례를 붙인다. signals 는 결과에 있는 이름 그대로
   * (도구가 미리 맞춘다). 비었으면 파형 탭이 그리는 것. 그래프가 아닌 결과(동작점 · .tf)면 error
   */
  waveformImage(opt: { signals?: string[]; from?: number; to?: number }): WavePicture | { error: string };

  // ── 레이아웃 (필요할 때 받는다) ──
  /** Placement · Layout 편집기를 다루는 손잡이. 없으면 레이아웃 편집기가 없는 곳이다 (검증의 가짜 편집기) */
  layout?(): Promise<LayoutControl>;
  /** 레이아웃 덩어리를 이미 받았으면 그 한 줄 요약, 아니면 null */
  layoutBrief?(): string | null;

  // ── 알림 ──
  /** 커밋마다 부른다 */
  onChange(fn: (source: ChangeSource) => void): () => void;
}
