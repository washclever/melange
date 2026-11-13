/**
 * 문서 모델. 설계서 '데이터 모델과 연결 판정' 의 구조를 그대로 따른다.
 *
 * 모든 좌표는 10 mil 단위 정수이고, 핀 끝과 배선 꺾점은 100 mil 격자(10의 배수) 위에만 둔다.
 * 연결 판정이 정수 비교가 되어 부동소수점 오차로 연결이 끊기는 버그가 구조적으로 안 생긴다.
 *
 * 계산해서 얻는 값(자동 접합점, 넷 이름)은 저장하지 않는다.
 */

export type Id = string;
export type Pt = [number, number];

/** 100 mil 격자 (10 mil 단위로 10) */
export const GRID = 10;

export const snapGrid = (v: number): number => Math.round(v / GRID) * GRID;
export const snapPt = (p: Pt): Pt => [snapGrid(p[0]), snapGrid(p[1])];
export const key = (p: Pt): string => p[0] + "," + p[1];
export const samePt = (a: Pt, b: Pt): boolean => a[0] === b[0] && a[1] === b[1];

// ── 라이브러리 ────────────────────────────────────────────────────────
/**
 * 심볼 도형. 호(arc)는 두지 않는다 — 회전·대칭을 '점마다 transform' 으로 처리해서
 * 핀 좌표 계산과 그림이 절대 어긋나지 않게 하려는 것이고, 호는 각도까지 같이
 * 돌려야 해서 어긋날 여지가 생긴다. 곡선은 poly 로 근사한다.
 */
export type Shape =
  | { line: [Pt, Pt] }
  | { rect: [number, number, number, number] }        // x, y, w, h
  | { circle: { c: Pt; r: number } }                  // 원은 회전해도 같은 모양
  | { poly: Pt[] };

export interface LibPin {
  id: string;
  name: string;
  /** 부품 원점 기준 상대 좌표. 격자 배수여야 회전해도 격자 위에 남는다 */
  at: Pt;
  /**
   * 회로도에 핀 이름을 적지 않는다. 심볼이 극성을 그림으로 이미 보여 주고, 이름 글자가 들어갈
   * 자리가 마땅치 않은 핀(제어 전원의 네 핀)이다. 이름 자체는 문제 목록의 말에 그대로 쓰인다.
   */
  hideName?: boolean;
}

export interface LibParam {
  key: string;
  label: string;
  unit: string;
  default: string;
  /**
   * 받을 수 있는 범위 (양 끝 포함). 실행 전 검사가 본다 — 결합 계수가 1 을 넘으면 ngspice 는
   * 오류 대신 1e293 같은 숫자를 낸다. 숫자로 못 읽는 값(식 따위)은 건드리지 않는다.
   */
  min?: number;
  max?: number;
}

export interface LibPart {
  id: string;
  name: string;
  category: string;
  /** 지정자 접두어: R, C, V... */
  refPrefix: string;
  symbol: { pins: LibPin[]; graphics: Shape[] };
  /**
   * 새로 놓을 때의 지정자·값 글자 자리 (Part.textAt 의 처음 값). 없으면 DEFAULT_TEXT_AT.
   * 기본 자리(위·아래)가 심볼의 선과 겹치는 부품만 둔다 — 와이퍼가 위로 나가는 가변 저항.
   */
  textAt?: { ref: Pt; value: Pt };
  params: LibParam[];
  /**
   * 넷리스트 한 줄의 틀. {ref} 는 지정자, {핀id} 는 그 핀이 속한 노드 이름,
   * 그 밖의 {키} 는 params 값으로 치환된다.
   * spice 가 없으면 넷리스트에 줄을 내지 않는다 (GND 등).
   *
   * 줄바꿈이 있으면 줄마다 따로 채워 여러 줄을 낸다 — 소자 하나로 안 되는 부품이 그렇다
   * (가변 저항 = 저항 둘, 변압기 = 인덕터 둘 + K, 전류 제어 전원 = 0 V 감지 전원 + F/H).
   *
   * element 는 SPICE 소자 문자다. 줄 순서를 정하고(설계서 내보내기 규칙 3),
   * 지정자가 이 문자로 시작하지 않으면 앞에 붙인다(규칙 4: op-amp U1 -> EU1).
   */
  spice?: {
    element: string;
    template: string;
    /**
     * 이 부품이 필요로 하는 .model 줄의 틀 (설계서 '반도체 부품').
     * 소자 줄과 같은 규칙으로 채운다. 같은 줄이 여러 번 나오면 한 번만 적는다.
     * 제조사 모델은 재배포 조건이 제각각이라 내장하지 않는다 — 일반 모델만 둔다.
     */
    model?: string;
  };
}

// ── 문서 ──────────────────────────────────────────────────────────────
export interface Part {
  id: Id;
  /** 프로젝트 라이브러리 키 */
  lib: string;
  /** "R1" */
  ref: string;
  at: Pt;
  rot: 0 | 90 | 180 | 270;
  mirror: boolean;
  /** 단위 문자 그대로 보관한다: { value: "1k" } */
  params: Record<string, string>;
  /**
   * 미연결 표시가 붙은 핀 id (설계서 E05). Pro 처럼 핀의 속성으로 둔다.
   * 여기 든 핀은 '떠 있는 핀' 경고에서 빠지고, 내보낼 때 1 TΩ 저항으로 접지에 묶인다.
   */
  nc?: string[];
  /** 지정자·값 글자 위치. 부품 원점 기준 상대 좌표 (설계서 E17) */
  textAt?: { ref: Pt; value: Pt };
}

/** 글자 위치 기본값과 고를 수 있는 자리 */
export const TEXT_SLOTS: Record<string, { ref: Pt; value: Pt }> = {
  "Above/Below": { ref: [0, -16], value: [0, 16] },
  "Below/Above": { ref: [0, 16], value: [0, -16] },
  "Right": { ref: [16, -4], value: [16, 10] },
  "Left": { ref: [-16, -4], value: [-16, 10] },
};
export const DEFAULT_TEXT_AT = TEXT_SLOTS["Above/Below"];

export interface Wire {
  id: Id;
  /** 꺾점은 격자 위. 선분 각도 자체에는 제한이 없다 */
  pts: Pt[];
}

export interface NetLabel {
  id: Id;
  name: string;
  at: Pt;
  kind: "label" | "power" | "gnd";
}

/**
 * 전압 프로브 (설계서 E24). 꽂은 자리의 넷 전압을 파형에 그린다.
 * 어느 넷인지는 저장하지 않고 좌표에서 매번 계산한다 — 넷은 기하에서 나오는 값이다.
 */
export interface Probe {
  id: Id;
  at: Pt;
  color: string;
}

/** 프로브 색. 꽂은 순서대로 돌려 쓰고, 파형 선 색이 프로브 색과 같다 */
export const PROBE_COLORS = ["--t1", "--t2", "--t3", "--t4", "--t5"] as const;

/**
 * SPICE 지시문 블록 (설계서 E33).
 *
 * 회로도로 그리지 않는 줄을 원문 그대로 담는 자리다. `.model`·`.param`·`.include`
 * 같은 지시문과, 외부 .sp 에서 우리 부품으로 못 옮긴 소자 줄이 여기 들어간다.
 * 회로도에 안 그려도 노드 이름이 같아서 시뮬레이션에는 그대로 들어간다.
 *
 * active 가 false 면 내보낼 때 줄마다 `*` 를 붙여 주석으로 나간다 — 지우지 않고
 * 꺼 두는 길이 있어야 "이 줄만 빼고 돌려 보기" 를 할 수 있다.
 */
export interface SpiceBlock {
  id: Id;
  at: Pt;
  lines: string[];
  active: boolean;
}

/**
 * 주석용 글자·선·사각형 (설계서 E32). 넷리스트에는 나가지 않는다.
 *
 * text 는 pts[0] 이 글자 왼쪽 아래, line·rect 는 pts[0]·pts[1] 이 양 끝/두 모서리다.
 * 점만으로 모양이 정해져서 회전·대칭이 배선과 같은 길로 처리된다.
 */
export interface Note {
  id: Id;
  kind: "text" | "line" | "rect";
  pts: Pt[];
  text?: string;
}

export interface Sheet {
  id: Id;
  name: string;
  parts: Part[];
  wires: Wire[];
  labels: NetLabel[];
  /** 수동 접합점만. 자동 접합점은 계산한다 */
  junctions: Pt[];
  probes: Probe[];
  /** SPICE 지시문 블록 (E33). 외부 .sp 에서 보존한 줄도 여기 온다 */
  spice: SpiceBlock[];
  /** 주석용 글자·선·사각형 (E32) */
  notes: Note[];
  /**
   * 레이아웃 블록의 핀으로 내보낼 넷 (회로도의 넷 이름). 없으면 레이아웃 브리지가 정한다 — 트랜지스터가 아닌 부품 ·
   * 넷 라벨 · 전원 기호에 닿은 넷 (src/layout/bridge.ts). 있으면 넷 라벨은 핀을 정하지 않는다. ALIGN 예제가 원래
   * 서브회로의 핀을 지키려고 쓴다 (src/layout/examples/build.ts)
   */
  layoutPins?: string[];
}

/**
 * 해석 설정. 종류마다 필요한 값이 달라 kind 로 나눈다.
 * 설계서: "DC·AC 를 넣을 때는 넷리스트 생성기의 해석 줄과 파형 패널의 가로축만 더한다."
 */
export type SimSettings =
  /** 과도 해석. 가로축은 시간 */
  | { kind: "tran"; tstop: string; tmax: string; tstart: string }
  /** DC 동작점. 점 하나라 그래프 대신 표로 보여 준다 */
  | { kind: "op" }
  /** DC 스윕. 가로축은 쓸어 올린 전압 */
  | { kind: "dc"; source: string; start: string; stop: string; step: string }
  /** AC 해석. 가로축은 로그 주파수, 세로축은 크기 */
  | { kind: "ac"; sweep: "dec" | "oct" | "lin"; points: string; fstart: string; fstop: string }
  /**
   * 잡음 해석. out 은 출력(넷 이름이나 v(a,b)), src 는 입력 환산의 기준이 되는 독립 전원.
   * 결과는 출력 잡음 밀도(onoise)와 입력 환산 잡음 밀도(inoise), V/√Hz — Razavi 7장의 두 양이다.
   */
  | { kind: "noise"; out: string; src: string; sweep: "dec" | "oct" | "lin"; points: string; fstart: string; fstop: string }
  /** 전달 함수 (.tf). 작은 신호 DC 이득 · 입력 저항 · 출력 저항 세 값이 나온다 (Razavi 3장) */
  | { kind: "tf"; out: string; src: string };

export const SIM_KIND_LABEL: Record<SimSettings["kind"], string> = {
  tran: "Transient",
  op: "DC operating point",
  dc: "DC sweep",
  ac: "AC analysis",
  noise: "Noise analysis",
  tf: "Transfer function",
};

/** 종류를 바꿀 때 쓸 기본값 */
export function defaultSim(kind: SimSettings["kind"]): SimSettings {
  switch (kind) {
    case "tran": return { kind, tstop: "5m", tmax: "10u", tstart: "0" };
    case "op": return { kind };
    case "dc": return { kind, source: "V1", start: "0", stop: "5", step: "0.1" };
    case "ac": return { kind, sweep: "dec", points: "20", fstart: "10", fstop: "1meg" };
    case "noise": return { kind, out: "out", src: "V1", sweep: "dec", points: "10", fstart: "1", fstop: "1g" };
    case "tf": return { kind, out: "out", src: "V1" };
  }
}

/**
 * 바깥에서 들어온 프로젝트의 해석 설정을 손본다.
 *
 * 해석이 과도뿐이던 때 저장한 파일에는 kind 가 없다. 그대로 두면 해석 줄이
 * 통째로 빠진 넷리스트가 나가고, 엔진은 아무 해석도 안 한 빈 결과를 준다.
 * 종류별 기본 모양을 깔고 저장된 값으로 덮어 — 빠진 칸은 기본값으로 채운다.
 */
export function normalizeSim(p: Project): Project {
  const saved = (p.sim ?? {}) as Record<string, string>;
  const kind = (saved.kind in SIM_KIND_LABEL ? saved.kind : "tran") as SimSettings["kind"];
  p.sim = Object.fromEntries(
    Object.entries(defaultSim(kind)).map(([k, v]) => [k, k === "kind" ? v : (saved[k] ?? v)]),
  ) as SimSettings;
  return p;
}

/**
 * 바깥에서 들어온 프로젝트를 지금 모양으로 맞춘다.
 *
 * 시트에 나중에 더한 배열(지금은 spice)이 예전 파일에는 없다. undefined 인 채로
 * 두면 넷리스트 생성이나 렌더러가 거기서 멈춘다 — 빈 배열로 채워 둔다.
 */
export function normalizeProject(p: Project): Project {
  normalizeSim(p);
  for (const s of p.sheets ?? []) {
    s.parts ??= []; s.wires ??= []; s.labels ??= [];
    s.junctions ??= []; s.probes ??= []; s.spice ??= []; s.notes ??= [];
  }
  // 예전에 저장한 파일에는 없다
  if (!Array.isArray(p.meas)) p.meas = [];
  if (!Array.isArray(p.calc)) p.calc = [];
  // SKY130 소자의 배수: 예전 사본은 mult= 만 적어 ngspice 가 곱하지 않았다 (src/lib/parts.ts 의 sky) — m= 을 더한다
  for (const l of Object.values(p.library ?? {})) {
    const t = l?.spice?.template;
    if (t && t.includes(" sky130_fd_pr__") && t.includes("mult={mult}") && !/\bm=\{mult\}/.test(t))
      l.spice!.template = t.replace("mult={mult}", "mult={mult} m={mult}");
  }
  return p;
}

export interface Project {
  formatVersion: 1;
  name: string;
  /** 1차 화면은 첫 장만 쓰지만 파일은 처음부터 배열 */
  sheets: Sheet[];
  /** 프로젝트 라이브러리: 쓴 부품 정의의 사본 */
  library: Record<string, LibPart>;
  sim: SimSettings;
  /**
   * .meas 줄 (ngspice 자동 측정). 해석 설정과 같은 결에 있어서 시트가 아니라
   * 프로젝트에 둔다 — 회로도 위의 어디에 놓인 것이 아니라 "무엇을 재고 싶은가" 다.
   * 원문을 그대로 들고 다닌다. 틀을 씌우면 ngspice 가 받는 문법의 대부분을 못 쓴다.
   */
  meas?: string[];
  /**
   * 계산기 줄 (결과 후처리). `a0 = dcgain(v(out))` 처럼 한 줄에 식 하나 (src/calc/).
   * .meas 와 같은 이유로 프로젝트에 둔다 — 무엇을 재고 싶은가는 회로도 위의 자리가 아니다.
   */
  calc?: string[];
  /**
   * 계산기 본보기(Metrics)의 자리 — 무엇이 출력 · 입력 · 입력 소자인가 ({ out: "von", in: "vip", m: "XMN2" }). 없으면 넷 이름으로
   * 짐작한다 (src/calc/metrics.ts hints). 예제처럼 이름만으로는 틀리게 짐작되는 회로가 밝혀 둔다.
   */
  calcRoles?: Record<string, string>;
}

// ── 심볼 기하 ─────────────────────────────────────────────────────────
/** 회전·대칭을 적용한다. rot 은 반시계 방향 */
export function transform(p: Pt, rot: 0 | 90 | 180 | 270, mirror: boolean): Pt {
  const x = mirror ? -p[0] : p[0];
  const y = p[1];
  switch (rot) {
    case 0: return [x, y];
    case 90: return [y, -x];
    case 180: return [-x, -y];
    case 270: return [-y, x];
  }
}

/** 부품의 i 번째 핀의 시트 좌표 */
export function pinAt(part: Part, lib: LibPart, i: number): Pt {
  const t = transform(lib.symbol.pins[i].at, part.rot, part.mirror);
  return [part.at[0] + t[0], part.at[1] + t[1]];
}

export const uid = (): Id =>
  (globalThis.crypto?.randomUUID?.() ?? "id" + Math.random().toString(36).slice(2, 10));

/**
 * 키를 정렬해 직렬화한다. 같은 문서는 항상 같은 바이트가 나와서
 * "저장했다 다시 열면 바이트 단위로 같다" 를 확인할 수 있다.
 */
export function serialize(p: Project): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sort((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(p), null, 2) + "\n";
}

export function emptyProject(name = "untitled"): Project {
  return {
    formatVersion: 1,
    name,
    sheets: [{ id: uid(), name: "Sheet1", parts: [], wires: [], labels: [], junctions: [], probes: [], spice: [], notes: [] }],
    library: {},
    sim: { kind: "tran", tstop: "5m", tmax: "10u", tstart: "0" },
    // 새 프로젝트에도 자리를 만들어 둔다. 없는 채로 두면 파일을 한 바퀴 돌릴 때
    // (내보냈다 다시 열기) 정규화가 [] 를 붙여 바이트가 달라진다
    meas: [],
    calc: [],
  };
}
