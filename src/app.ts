/**
 * M1-thin — 회로도를 그려서 파형까지 보는 가장 얇은 수직 슬라이스.
 *
 * 들어 있는 것: 부품 배치 · 배선 · 넷 라벨 · GND · 이동 · 삭제 · 회전 · 값 편집
 *               넷 추출 · 넷리스트 · 실행 전 검사 · 시뮬레이션 · 파형
 * 아직 없는 것: 명령 패턴(지금은 스냅샷 실행 취소) · 복사/붙여넣기 · 프로브
 *               .sp 입출력 · 찾기 · 정렬 · 다중 선택
 */
import {
  DEFAULT_TEXT_AT, GRID, PROBE_COLORS, SIM_KIND_LABEL, TEXT_SLOTS, defaultSim, emptyProject,
  key, pinAt, serialize, snapGrid, snapPt, uid,
  type Id, type LibPart, type NetLabel, type Note, type Part, type Probe, type Project, type Pt,
  type Sheet, type SimSettings, type Wire,
} from "./doc/types.ts";
import {
  History, addJunction, addLabel, addObjects, addPart, addProbe, addWire,
  batch, findById, parseRef, refKey, removeJunction, removeObjects, renameLabel, removeProbe, setParam, setRef,
  setCalc, setMeas, setSim, setTextAt, setSpiceBlock, setWirePts, splitWire, toggleNc, transform,
  withJunctionCleanup,
  type Command, type Group, type ObjKind, type Ref, type SelSnapshot, type Xform,
} from "./doc/history.ts";
import { BUILTIN, SKY130_IDS, ensureInLibrary } from "./lib/parts.ts";
import { ABOUT, LIBRARIES } from "./lib/catalog.ts";
import { closeLibrary, openLibrary } from "./ui/library.ts";
import { DEMOS, type Demo } from "./lib/demos.ts";
import { LAYOUT_EXAMPLE_MENU } from "./lib/layout-examples.ts";
import { Follow } from "./doc/follow.ts";
import { makePart, moveCommand, nextRef as opsNextRef, xformCommand } from "./doc/ops.ts";
import { AutoSave } from "./io/store.ts";
// 레이아웃(Placement · Layout 편집기) — 첫 화면에는 전환 단추만. 편집기 본체는 처음 열 때 받는다 (src/layout/ui/shell.mjs)
import { createLayoutSwitch, type LayoutSwitch } from "./layout/ui/switch.ts";
import { extractNets, onSegment, type Extraction } from "./net/extract.ts";
import { IncrementalNets } from "./net/incremental.ts";
import { PointIndex } from "./net/spatial.ts";
import { SheetIndex, symbolBox, type Entry, type IndexedKind } from "./doc/sheet-index.ts";
import {
  beforeEnd, buildNetlist, checkAnalysis, checkCircuit, chunked, orderedParts, savePlan, spiceName, type Issue,
} from "./net/netlist.ts";
import { alignTargets, annotate, distributeTargets, type AlignKind, type AnnotateOrder } from "./doc/arrange.ts";
import { DEFAULT_PROFILE } from "./feel/profile.ts";
import { resolveSnap, snapRadiusPx, type SnapTarget } from "./feel/snap.ts";
import { toScreen, toWorld, zoomAt, wheelFactor, type Viewport } from "./feel/viewport.ts";
import * as R from "./render/schematic.ts";
import { Scene, drawScene2D } from "./render/scene.ts";
import { GpuLayer, styleColors } from "./render/gpu.ts";
import { icon, stampIcons } from "./ui/icons.ts";
import { refract } from "./ui/glass.ts";
import { fitSine } from "./measure.ts";
import { exportSp, parseSp, scanSp, runnable, sineFreq } from "./io/sp.ts";
import { spToProject } from "./io/import-sp.ts";
import { parseEng } from "./doc/units.ts";
import type { SimResponse, Trace } from "./sim.worker.ts";
import { SimClient } from "./sim-client.ts";
// 어시스턴트도 타입만 여기서 가져온다. 본체는 패널을 열 때 받는다 (아래 loadAssistant · src/ai/assistant.ts)
import type { AssistantHost, ChangeSource, Picture, RunOutcome, WavePicture } from "./ai/host.ts";
import type { AssistantPanel } from "./ai/panel.ts";
import { formatMeasure, type Measurement } from "./sim-measure.ts";
import { tfGainUnit } from "./sim-values.ts";
import { eng } from "./calc/format.ts";
// 계산기와 그 그래프는 타입만 여기서 가져온다. 본체는 필요할 때 받는다 (아래 loadCalc · src/calc/calc.ts)
import type { PlotSource, PlotView, Series } from "./ui/plot.ts";
import type { RunData } from "./calc/eval.ts";
import type { Kind, Names } from "./calc/metrics.ts";
import type { CalcHost } from "./ui/calc-panel.ts";

const P = DEFAULT_PROFILE;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ── 상태 ──────────────────────────────────────────────────────────────
let project: Project = emptyProject("Melange");
let sheet: Sheet = project.sheets[0];
let ex: Extraction = extractNets(sheet, project.library);
let issues: Issue[] = [];
/** 편집기 전환 (메뉴 막대). 레이아웃 편집기가 키를 받는 동안 회로도의 단축키는 비켜 준다 */
let layoutSwitch: LayoutSwitch | null = null;

type Tool = "select" | "place" | "wire" | "label" | "gnd" | "probe" | "junction" | "nc" | "power" | "spice" | "text" | "line" | "rect";
let tool: Tool = "select";
let placing: string | null = null;         // 배치할 라이브러리 id
/** 배치 중에 정한 방향. 놓기 전에 Space/X/Y 로 돌린다 (O-13) */
let placeRot: 0 | 90 | 180 | 270 = 0;
let placeMirror = false;
/** 넷 강조 (E20). 회로도 전체에 적용된다 */
let highlightNet: string | null = null;
/** 끌 때 새로 붙을 자리 (설계서 12-4) */
let connectPreview: Pt[] = [];
/** 배선 중 Shift 를 누르고 있는가 — 가로·세로 한 구간으로 제한한다 */
let shiftHeld = false;

let vp: Viewport = { at: [-120, -120], scale: 2.4 };
let cursor: Pt = [0, 0];                   // 화면 좌표
let snap: SnapTarget | null = null;
/**
 * 선택. 부품만이 아니라 배선·라벨·프로브도 담는다 (설계서 E08).
 * 키는 "종류:id" 이고, 실행 취소가 선택까지 되돌릴 수 있게 그대로 기록에 들어간다.
 */
let selection = new Set<string>();
let hover: Ref | null = null;
/**
 * 배선 하나가 골라진 상태에서 그 배선을 한 번 더 누르면 선분 하나로 좁혀진다
 * (설계서 2절: 첫 클릭 / 한 번 더 클릭 = 배선 전체 / 선분 하나, Tab 으로 다시 넓힘).
 *
 * 선택 자체는 그대로 "wire:id" 하나다. 좁혀진 자리만 여기 따로 둔다 —
 * 선분은 문서의 객체가 아니라 배선의 일부라서, 참조 종류를 늘리면 명령·실행 취소·
 * 복사까지 전부 선분을 알아야 한다.
 */
let segSel: { wireId: Id; i: number } | null = null;
/** 빈 곳에서 끌면 박스 선택 */
let box: { from: Pt; to: Pt } | null = null;

/**
 * 부품 끌기. 붙은 배선(설계서 E09)은 끌기 시작 때 한 번 찾아 두고(follow), 매 프레임
 * 거기서 다시 계산한다 — 누적하지 않는다.
 */
let drag: { from: Pt; moved: Pt; follow: Follow } | null = null;
/**
 * 꺾점·선분 끌기 (설계서 4절). 골라 둔 배선의 꺾점이나 선분을 직접 잡아 옮긴다.
 * orig 는 끌기 시작 때의 모양이다 — 매 프레임 거기서 다시 만들어 누적 오차를 없앤다.
 */
let vdrag: { wireId: Id; pts: number[]; orig: Pt[]; from: Pt; moved: Pt } | null = null;
let pan: { from: Pt; at: Pt } | null = null;
let down: { at: Pt; button: number; moved: boolean; shift: boolean } | null = null;
let wireDraft: Pt[] | null = null;
let bend: "h" | "v" = "h";

/** 격자 점을 찍을지. 배치할 때 칸을 세는 데 쓰여서 기본은 켜 둔다 */
let showGrid = true;
/**
 * 핀 이름 (B·C·E, D·G·S 같은 것)과 넷 이름을 회로도에 적을지.
 *
 * 핀 이름은 기본으로 켠다 — 트랜지스터를 거꾸로 꽂는 것이 제일 흔한 실수인데,
 * 이름이 보이면 눈으로 바로 잡힌다. 넷 이름은 기본으로 끈다: 넷마다 글자가 하나씩
 * 붙으면 회로도가 복잡해지고, 넷리스트와 맞춰 볼 때만 필요하다.
 */
let showPinNames = true;
let showNetNames = false;
/**
 * 접어 둔 부품 묶음 이름. 저장된 설정을 되살리는 것은 부품 목록을 만든 **뒤**라,
 * 되살린 뒤에 applyLibGroups() 로 한 번 더 맞춘다.
 */
const libClosed = new Set<string>();

let traces: Trace[] | null = null;
/** 지난 실행에서 .meas 로 잰 값들 */
let measures: Measurement[] = [];
/**
 * 계산기가 읽는 지난 실행 (src/calc/). traces 와 같은 실행을 이름으로 찾기 좋게 풀어 둔 것이다 —
 * AC 의 크기 · 위상을 복소수로 되돌리고, 그 넷리스트의 소자 표를 붙였다. 계산기를 처음 쓸 때
 * lastResult 에서 만든다 (계산기 본체를 그때 받으므로).
 */
let calcRun: RunData | null = null;
/** 지난 실행의 결과와 그때 보낸 넷리스트. calcRun 의 재료다 */
let lastResult: { traces: Trace[]; job: RunJob | null; measures: Measurement[]; unavailable: string[] } | null = null;

/**
 * 계산기 본체. 첫 화면에 싣지 않고 **필요할 때** 받는다 — 계산기 탭을 열 때, 계산기 줄이 있는
 * 프로젝트를 돌릴 때, 도움말을 볼 때. 실행 결과가 있어야 쓸모가 있는 기능이 회로도를 그리러 온
 * 사람의 첫 화면을 늦추면 안 된다 (spice.wasm 을 실행을 누를 때 받는 것과 같은 생각이다).
 */
type CalcModule = typeof import("./calc/calc.ts");
let calcMod: CalcModule | null = null;
let calcLoading: Promise<CalcModule> | null = null;
function loadCalc(): Promise<CalcModule> {
  calcLoading ??= import("./calc/calc.ts").then(
    m => (calcMod = m),
    err => { calcLoading = null; throw err; },   // 받다 끊겼으면 다음에 다시 받게 한다
  );
  return calcLoading;
}
/**
 * 이름을 붙여 남겨 둔 실행 (계산기의 Keep run). CMRR · PSRR 처럼 두 번 돌려 비교하는 지표를 위한
 * 것이다. 세션 동안만 산다 — 결과는 크고, 프로젝트를 갈아끼우면 다른 회로의 것이 된다.
 */
const keptRuns = new Map<string, RunData>();
let simLog = "";
let running = false;
/** 워커가 알려 온 '지금 하는 일'. 비어 있으면 평소 상태 글을 쓴다 */
let simProgress = "";
const history = new History();

let staticDirty = true, overlayDirty = true;

// ── 캔버스 ────────────────────────────────────────────────────────────
const stage = $("stage");
/*
 * 캔버스 세 장:
 *   static  — WebGPU. 격자·배선·심볼·핀 점·접합점 (src/render/gpu.ts)
 *   text    — Canvas 2D. 글자와 장식(라벨·프로브·끝나지 않은 곳·넷 강조). 화면에 보이는 것만
 *   overlay — Canvas 2D. 커서를 따라 바뀌는 것 (호버·선택·스냅·미리보기)
 */
const cvS = $<HTMLCanvasElement>("static"), cvT = $<HTMLCanvasElement>("text"), cvO = $<HTMLCanvasElement>("overlay");
const gT = cvT.getContext("2d")!, gO = cvO.getContext("2d")!;
let W = 0, H = 0, fitted = false;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  W = stage.clientWidth; H = stage.clientHeight;
  // 좁은 화면의 어시스턴트 서랍은 툴바 아래부터 화면 끝까지 덮는다 (아래 패널까지) — 그 윗변.
  // 레이아웃 편집기만 보일 때는 회로도의 가운데 줄이 숨어 있으니 메뉴 막대 밑에서
  const midTop = $("mid").offsetParent ? $("mid").getBoundingClientRect().top : $("menubar").getBoundingClientRect().bottom + 6;
  document.documentElement.style.setProperty("--mid-top", Math.round(midTop) + "px");
  for (const c of [cvS, cvT, cvO]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  gT.setTransform(dpr, 0, 0, dpr, 0, 0);
  gO.setTransform(dpr, 0, 0, dpr, 0, 0);
  staticDirty = overlayDirty = true;
  if (!fitted && W > 0 && H > 0) { fitted = true; fit(); }
}
new ResizeObserver(resize).observe(stage);

// ── 문서 조작 ─────────────────────────────────────────────────────────
/**
 * 문서는 오직 명령으로만 바꾼다 (설계서 E12). 명령 밖에서 직접 건드리면
 * 실행 취소가 조용히 깨지므로, sheet 를 직접 수정하는 코드는 여기 말고 없어야 한다.
 */
// ── 선택 도우미 ───────────────────────────────────────────────────────
const selRefs = (): Ref[] => [...selection].map(parseRef);
const selParts = (): Part[] =>
  selRefs().filter(r => r.kind === "part").map(r => findById(sheet.parts, r.id)!).filter(Boolean);
/** 속성 패널은 하나만 골랐을 때 전체를 보여 준다 */
const selOnePart = (): Part | null => {
  const ps = selParts();
  return selection.size === 1 && ps.length === 1 ? ps[0] : null;
};
const setSelection = (keys: Iterable<string>) => { selection = new Set(keys); };

/**
 * 커밋마다 누가 바꿨는지 어시스턴트에게 알린다 — 어시스턴트는 사람이 손으로 고친 것을 다음 차례에
 * 알아야 한다 (src/ai/agent.ts). load 는 문서를 통째로 갈아끼운 것이다. 어시스턴트를 받기 전에는 아무도 안 듣는다.
 */
const docWatchers = new Set<(source: ChangeSource) => void>();
const onDocChange = (source: ChangeSource) => { for (const f of docWatchers) f(source); };

/**
 * group 은 어시스턴트 요청의 꼬리표다. 같은 꼬리표의 명령은 실행 취소 한 단계로 묶이고,
 * 꼬리표가 없는 편집(사람의 것)은 따로 한 단계다 (History.run).
 */
function edit(cmd: Command, selAfter: SelSnapshot = [...selection], group?: Group) {
  // 교차가 사라진 수동 접합점을 같은 단계에서 치운다 (설계서 12-6).
  // 수동 접합점이 없으면 확인할 것도 없다 — 대부분의 시트가 그렇다.
  // 확인은 명령을 적용한 직후의 문서로 한다: 색인·넷을 그 상태로 맞추고(바뀐 것만), 커밋은
  // 그다음 치운 접합점만큼만 다시 맞춘다
  const cmd2 = sheet.junctions.length ? withJunctionCleanup(cmd, () => refresh().staleJunctions) : cmd;
  history.run(sheet, cmd2, [...selection], selAfter, group);
  setSelection(selAfter);
  commit(group ? "ai" : "user");
}

const autosave = new AutoSave((state, detail) => {
  const el = $("save");
  el.textContent = state;
  el.title = detail ?? "";
  el.style.color = state === "Not saved" ? "var(--bad)" : "var(--mut)";
});

/**
 * 시트 색인 (src/doc/sheet-index.ts). 커밋마다 지난번 모습과 견주어 **바뀐 객체만** 다시
 * 다룬다. 연결에 닿는 것이 하나도 안 바뀌었으면(값·지정자·주석·프로브…) 넷 추출을 건너뛰고,
 * 바뀌었으면 증분 넷 추출(src/net/incremental.ts)이 바뀐 객체의 입력만 다시 만든다.
 */
const index = new SheetIndex();
const netBook = new IncrementalNets();

/** 색인·정적 층·넷 추출을 지금 문서에 맞춘다. 바뀐 것만 다룬다 */
function refresh(): Extraction {
  const change = index.sync(sheet, project.library);
  // 그리기도 바뀐 객체가 든 덩어리만 다시 만든다
  scene.apply(change, project.library);
  if (change.connectivity) {
    ex = netBook.update(sheet, project.library, index, change);
    junctionIdx = null; looseIdx = null; netSpots = null;
    scene.setJunctions([...ex.junctions, ...sheet.junctions]);
  }
  return ex;
}

/** 실행 전 검사. 회로도와, 해석 설정이 가리키는 전원 이름을 같이 본다 */
function recheck() {
  issues = [...checkCircuit(sheet, project.library, ex), ...checkAnalysis(project.sim, sheet, project.library)];
}

function commit(source: ChangeSource = "user") {
  docRev++;
  autosave.touch(project);
  refresh();
  recheck();
  syncProjectViews();
  markDuplicateRefs();
  staticDirty = overlayDirty = true;
  renderProps();
  scheduleTab();
  renderStatus();
  onDocChange(source);
}

/*
 * 해석 설정 · .meas · 계산기 줄을 패널이 지금 보여 주는 값. 실행 취소나 어시스턴트가 바꾸면 패널과
 * 문서가 달라지고, 그때만 다시 그린다 — 패널 스스로 고친 것까지 다시 그리면 다음 칸으로 옮긴
 * 초점이 날아간다 (패널은 고치기 전에 여기 새 값을 적어 둔다).
 */
let shownSim = "", shownMeas = "", shownCalc = "";
/** 지금의 결과 · 파형 커서가 딸린 해석 종류. 종류가 바뀌면 그것들은 새 가로축에서 뜻이 없다 */
let resultKind: SimSettings["kind"] = project.sim.kind;

function syncProjectViews() {
  if (project.sim.kind !== resultKind) {
    resultKind = project.sim.kind;
    curA = curB = null;        // 가로축이 바뀌면 커서는 의미가 없다
    resetWaveView();           // 확대해 둔 범위도 새 축에서는 뜻이 없다
    traces = null;             // 이전 해석 결과를 새 축에 그리면 안 된다
    calcRun = null; lastResult = null; calcMod?.calcInvalidate();
  }
  if (JSON.stringify(project.sim) !== shownSim || JSON.stringify(project.meas ?? []) !== shownMeas) renderSim();
  const calc = JSON.stringify(project.calc ?? []);
  if (calc !== shownCalc) {
    shownCalc = calc;
    calcMod?.calcInvalidate();
    // scheduleTab 은 계산기 탭을 다시 짓지 않는다 (적던 식의 초점). 밖에서 바뀐 줄은 보여야 한다
    if (tab === "calc") renderTab();
  }
}

/** 해석 설정을 바꾼다 — 실행 취소 기록에 남는다. 패널은 이미 그 값을 보여 준다 */
function changeSim(next: SimSettings) {
  shownSim = JSON.stringify(next);
  edit(setSim(project, next));
}

/** 문서를 통째로 갈아끼운다 (새로 열기·데모). 기록은 버린다 */
function replaceProject(p: Project) {
  project = p;
  sheet = project.sheets[0];
  sheet.probes ??= [];               // 예전 파일에는 probes 가 없다
  history.clear();
  selection.clear(); wireDraft = null; traces = null; externalNetlist = null;
  curA = curB = null; resetWaveView();
  // 계산기의 결과와 보관해 둔 실행은 앞 회로의 것이다. 줄 번호에 매인 상태도 같이 버린다
  calcRun = null; lastResult = null; keptRuns.clear(); calcMod?.calcReset();
  commit("load");
}

function undo() {
  const sel = history.undo(sheet);
  if (sel === undefined) return;
  setSelection(sel);
  wireDraft = null;
  commit("user");
}

function redo() {
  const sel = history.redo(sheet);
  if (sel === undefined) return;
  setSelection(sel);
  wireDraft = null;
  commit("user");
}

const nextRef = (prefix: string): string => opsNextRef(sheet, prefix);

/** 놓을 부품을 만든다 (배치 중의 방향 그대로). 문서에 넣는 것은 addPart 명령이 한다 */
const newPart = (libId: string, at: Pt): Part => makePart(project.library, sheet, libId, at, placeRot, placeMirror);

/**
 * 레이아웃 예제를 불러온다 (ALIGN-public examples/ -> SKY130 회로도). 회로도를 만드는 코드와 넷리스트는 레이아웃 덩어리에
 * 들어 있어 이때 받는다. 열고 나면 Placement 를 회로도 옆에 띄운다 — 자동 배치를 누를 자리다
 */
function loadLayoutExample(id: string) {
  const st = $("status");
  st.textContent = "Loading the layout example…";
  import("./layout/examples/index.ts").then(m => {
    replaceProject(m.layoutExample(id));
    renderSim();
    fit();
    // 불러오는 중이라는 말을 지우고 회로의 상태(부품 · 배선 · 넷 수)로 — 빈 칸으로 두면 예제가 열렸는지 알 수 없다
    renderStatus();
    layoutSwitch?.control().then(c => c.show({ view: "circuit+placement" }), () => {});
  }, err => {
    console.error("[layout example]", err);
    st.textContent = "Could not load the layout example — " + (err as Error).message;
  });
}

/** 데모를 불러온다. 회로 정의는 자동 테스트와 같은 모듈을 쓴다 (src/lib/demos.ts) */
function loadDemo(demo: Demo) {
  replaceProject(demo.build());
  renderSim();   // 데모마다 해석 설정이 따로다. 패널을 안 그리면 문서와 어긋난 채 남는다
  fit();
}

/**
 * 지금 선택한 부품들에 붙은 배선 (설계서 E09). 선택 안에 든 배선은 통째로 같이 움직이므로
 * 늘이지 않는다 (설계서 명세 5: "선택에 들어 있는 배선은 늘어나지 않는다").
 */
function followSelection(): Follow {
  const movingWires = new Set<Id>();
  for (const r of selRefs()) if (r.kind === "wire") movingWires.add(r.id);
  return new Follow({ sheet, library: project.library, parts: selParts(), movingWires, index });
}

/** 그 좌표에 핀이 있는 부품을 찾는다. 미연결 표시가 핀에만 붙게 하는 데 쓴다 */
function pinAtWorld(w: Pt): { part: Part; pinId: string } | null {
  for (const part of near<Part>(KINDS_PART, w[0], w[1], w[0], w[1])) {
    const lib = project.library[part.lib];
    if (!lib) continue;
    for (let i = 0; i < lib.symbol.pins.length; i++) {
      const at = pinAt(part, lib, i);
      if (at[0] === w[0] && at[1] === w[1]) return { part, pinId: lib.symbol.pins[i].id };
    }
  }
  return null;
}

/**
 * 끄는 중에 새로 생길 연결 (설계서 12-4).
 *
 * 움직이는 핀이 **원래는 자기 넷이 아니던** 넷 위에 올라오면 새 연결이다.
 * `ex` 는 끌기 전에 계산해 둔 것이라, 그게 바로 "지금 놓으면 붙을 곳" 이다.
 * 끌다가 엉뚱한 핀에 붙는 문제(FR1)를 놓기 전에 보여 주려는 것이다.
 */
function newConnections(): Pt[] {
  const out: Pt[] = [];
  for (const part of selParts()) {
    const lib = project.library[part.lib];
    if (!lib) continue;
    lib.symbol.pins.forEach((pin, i) => {
      const at = pinAt(part, lib, i);
      const landing = ex.netAt(at);
      if (!landing) return;
      // 원래부터 그 넷이었으면 새로 붙는 게 아니다
      if (ex.pinNet.get(part.id + ":" + pin.id) === landing) return;
      out.push(at);
    });
  }
  return out;
}

/** 다음에 쓸 프로브 색. 꽂은 순서대로 돌려 쓴다 */
const nextProbeColor = (): string => PROBE_COLORS[sheet.probes.length % PROBE_COLORS.length];

// ── 스냅 후보 ─────────────────────────────────────────────────────────
/**
 * 색인에서 상자 안에 걸칠 수 있는 객체를 종류별로, **시트 순서대로** 꺼낸다.
 * 예전 코드가 배열을 앞에서부터 훑었으므로, 같은 순서로 줘야 동점일 때 고르는 것이 같다.
 */
const KINDS_PART = new Set<IndexedKind>(["part"]);
const KINDS_WIRE = new Set<IndexedKind>(["wire"]);
const KINDS_LABEL = new Set<IndexedKind>(["label"]);
const KINDS_PROBE = new Set<IndexedKind>(["probe"]);
function near<T>(kinds: ReadonlySet<IndexedKind>, x0: number, y0: number, x1: number, y1: number): T[] {
  const hits = index.query(x0, y0, x1, y1, kinds);
  hits.sort((a: Entry, b: Entry) => a.index - b.index);
  return hits.map(e => e.obj as T);
}

/** 자동 접합점 자리 색인. 넷 추출이 바뀌면 다시 만든다 (스냅 후보용) */
let junctionIdx: PointIndex | null = null;

function candidates(c: Pt, radWorld: number): SnapTarget[] {
  const out: SnapTarget[] = [];
  const R4 = radWorld * 4;
  const near4 = (p: Pt) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= R4;
  for (const part of near<Part>(KINDS_PART, c[0] - R4, c[1] - R4, c[0] + R4, c[1] + R4)) {
    const lib = project.library[part.lib];
    if (!lib) continue;
    lib.symbol.pins.forEach((pin, i) => {
      const at = pinAt(part, lib, i);
      if (near4(at)) out.push({ kind: "pin", at, ref: part.id + ":" + pin.id });
    });
  }
  for (const w of near<Wire>(KINDS_WIRE, c[0] - R4, c[1] - R4, c[0] + R4, c[1] + R4)) {
    if (w.pts.length < 2) continue;
    for (const e of [w.pts[0], w.pts[w.pts.length - 1]]) {
      if (near4(e)) out.push({ kind: "wireEnd", at: e, ref: w.id + ":e" + e[0] + "," + e[1] });
    }
    for (let i = 0; i < w.pts.length - 1; i++) {
      const a = w.pts[i], b = w.pts[i + 1];
      // 선분 위에서도 격자점에만 붙는다 — 꺾점은 항상 격자 위여야 한다
      const g = snapPt(closestOnSeg(c, a, b));
      if (near4(g) && onSeg(g, a, b)) out.push({ kind: "wireSeg", at: g, ref: w.id + ":s" + i });
    }
  }
  // 접합점도 칸으로 묻는다. 결과 순서는 ex.junctions 의 순서로 되돌린다
  junctionIdx ??= new PointIndex(ex.junctions);
  const js: number[] = [];
  junctionIdx.eachNear([c[0] - R4, c[1] - R4], [c[0] + R4, c[1] + R4], i => { js.push(i); });
  js.sort((a, b) => a - b);
  for (const i of js) {
    const j = ex.junctions[i];
    if (near4(j)) out.push({ kind: "junction", at: j, ref: "j" + j[0] + "," + j[1] });
  }
  return out;
}

function closestOnSeg(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  if (L === 0) return a;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L));
  return [a[0] + t * dx, a[1] + t * dy];
}
function onSeg(p: Pt, a: Pt, b: Pt): boolean {
  if ((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]) !== 0) return false;
  return p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
    && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}

function updateSnap() {
  const w = toWorld(vp, cursor);
  const rad = snapRadiusPx(P, GRID * vp.scale) / vp.scale;
  snap = resolveSnap(w, candidates(w, rad), snap, P, vp.scale, GRID).target;
}

function bendPath(from: Pt, to: Pt): Pt[] {
  // Shift 를 누르고 있으면 가로·세로 한 구간으로만 간다 (P1). 꺾지 않는다
  if (shiftHeld) {
    const straight: Pt = Math.abs(to[0] - from[0]) >= Math.abs(to[1] - from[1])
      ? [to[0], from[1]]
      : [from[0], to[1]];
    return (straight[0] === from[0] && straight[1] === from[1]) ? [] : [straight];
  }
  const dx = Math.abs(to[0] - from[0]) * vp.scale, dy = Math.abs(to[1] - from[1]) * vp.scale;
  if (bend === "h" && dy - dx > P.bendAxisHysteresisPx) bend = "v";
  else if (bend === "v" && dx - dy > P.bendAxisHysteresisPx) bend = "h";
  const corner: Pt = bend === "h" ? [to[0], from[1]] : [from[0], to[1]];
  const out: Pt[] = [];
  if (corner[0] !== from[0] || corner[1] !== from[1]) out.push(corner);
  if (to[0] !== corner[0] || to[1] !== corner[1]) out.push(to);
  return out;
}

/**
 * 커서 밑의 객체. 위에 그려진 것부터 본다.
 * 집는 반경은 화면 px 로 두어야 배율이 달라져도 같은 느낌이 난다.
 */
function hitTest(w: Pt): Ref | null {
  const m = 6 / vp.scale;

  // 프로브 > 라벨 > 부품 > 배선 순. 작은 것이 큰 것에 가리지 않게 한다
  for (let i = sheet.probes.length - 1; i >= 0; i--) {
    const p = sheet.probes[i];
    if (Math.abs(p.at[0] - w[0]) <= m * 1.5 && Math.abs(p.at[1] - w[1]) <= m * 1.5) {
      return { kind: "probe", id: p.id };
    }
  }
  /*
   * 라벨·부품·배선은 색인에서 커서 둘레만 꺼낸다. 예전에는 마우스가 움직일 때마다 전부를
   * 훑어서 부품 5만 개에서 한 번에 27 ms 였다. 꺼낸 것은 시트 순서로 줄 세워 **뒤에서부터**
   * 본다 — 위에 그려진 것이 먼저라는 규칙은 그대로다.
   */
  const labels = near<NetLabel>(KINDS_LABEL, w[0], w[1], w[0], w[1]);
  for (let i = labels.length - 1; i >= 0; i--) {
    const l = labels[i];
    const wid = (l.name.length * 5 + 6);
    if (w[0] >= l.at[0] && w[0] <= l.at[0] + wid && Math.abs(w[1] - l.at[1]) <= 8) {
      return { kind: "label", id: l.id };
    }
  }
  const parts = near<Part>(KINDS_PART, w[0] - m, w[1] - m, w[0] + m, w[1] + m);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const lib = project.library[part.lib];
    if (!lib) continue;
    const [a, b] = R.partBounds(part, lib);
    if (w[0] >= a[0] - m && w[0] <= b[0] + m && w[1] >= a[1] - m && w[1] <= b[1] + m) {
      return { kind: "part", id: part.id };
    }
  }
  /*
   * 주석은 제일 뒤에 본다. 큰 사각형이 안쪽의 부품·배선을 가로채면 안 된다.
   * 사각형은 테두리 근처만, 선은 선분까지의 거리로, 글자는 상자로 잡는다.
   */
  for (let i = (sheet.notes?.length ?? 0) - 1; i >= 0; i--) {
    const n = sheet.notes[i];
    if (n.kind === "line") {
      if (n.pts.length >= 2 && distToSeg(w, n.pts[0], n.pts[1]) <= m) return { kind: "note", id: n.id };
      continue;
    }
    const [a, b] = R.noteBounds(n, vp, gO);
    const s = toScreen(vp, w);
    const inside = s[0] >= a[0] - 3 && s[0] <= b[0] + 3 && s[1] >= a[1] - 3 && s[1] <= b[1] + 3;
    if (!inside) continue;
    if (n.kind === "text") return { kind: "note", id: n.id };
    // 사각형은 테두리에서 6px 안쪽까지만
    const near = s[0] <= a[0] + 6 || s[0] >= b[0] - 6 || s[1] <= a[1] + 6 || s[1] >= b[1] - 6;
    if (near) return { kind: "note", id: n.id };
  }

  // 지시문 블록은 화면 좌표로 재는 상자다 (글자 길이에서 나오므로 배율을 탄다)
  const s0 = toScreen(vp, w);
  for (let i = (sheet.spice?.length ?? 0) - 1; i >= 0; i--) {
    const [a, b] = R.blockBounds(sheet.spice[i], vp);
    if (s0[0] >= a[0] && s0[0] <= b[0] && s0[1] >= a[1] && s0[1] <= b[1]) {
      return { kind: "spice", id: sheet.spice[i].id };
    }
  }
  const wires = near<Wire>(KINDS_WIRE, w[0] - m, w[1] - m, w[0] + m, w[1] + m);
  for (let i = wires.length - 1; i >= 0; i--) {
    const wire = wires[i];
    for (let k = 0; k < wire.pts.length - 1; k++) {
      if (distToSeg(w, wire.pts[k], wire.pts[k + 1]) <= m) return { kind: "wire", id: wire.id };
    }
  }
  return null;
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const q = closestOnSeg(p, a, b);
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

/** 박스에 걸치는 모든 객체. 걸치기만 해도 잡는다 (O-08 은 관찰 전이라 잠정) */
function refsInBox(a: Pt, b: Pt): Ref[] {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const inside = (p: Pt) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  const out: Ref[] = [];

  for (const part of near<Part>(KINDS_PART, x0, y0, x1, y1)) {
    const lib = project.library[part.lib];
    if (!lib) continue;
    const [lo, hi] = R.partBounds(part, lib);
    // 경계 상자끼리 겹치면 잡는다
    if (lo[0] <= x1 && hi[0] >= x0 && lo[1] <= y1 && hi[1] >= y0) out.push({ kind: "part", id: part.id });
  }
  for (const wire of near<Wire>(KINDS_WIRE, x0, y0, x1, y1)) if (wire.pts.some(inside)) out.push({ kind: "wire", id: wire.id });
  for (const l of near<NetLabel>(KINDS_LABEL, x0, y0, x1, y1)) if (inside(l.at)) out.push({ kind: "label", id: l.id });
  for (const p of near<Probe>(KINDS_PROBE, x0, y0, x1, y1)) if (inside(p.at)) out.push({ kind: "probe", id: p.id });
  return out;
}

// ── 그리기 ────────────────────────────────────────────────────────────
/** 정적 층의 도형 (src/render/scene.ts). 커밋 때 바뀐 덩어리만 다시 만든다 */
const scene = new Scene();
let gpu: GpuLayer | null = null;

/*
 * WebGPU 를 띄운다. 지원하지 않는 브라우저는 다루지 않기로 했으므로 대신 그리지 않고,
 * 무엇이 없어서 안 되는지를 캔버스 자리에 적는다 (빈 화면만 남으면 왜인지 알 수 없다).
 */
let gpuRestarts = 0;
/** 진단용 그리기 대상 (?gpu=readback | offscreen). 보통은 캔버스 (src/render/gpu.ts) */
const gpuTarget = (new URLSearchParams(location.search).get("gpu") ?? "canvas") as "canvas" | "readback" | "offscreen";

function startGpu() {
  GpuLayer.create(cvS, gpuTarget).then(layer => {
    gpu = layer;
    layer.onReadback = () => { staticDirty = true; };
    layer.onLost = reason => {
      // 장치를 잃으면(드라이버 재시작 따위) 새로 띄우고 도형을 전부 다시 올린다.
      // 계속 잃으면 되살리기를 멈추고 이유를 보인다 — 끝없이 다시 띄우면 아무것도 안 보인다
      gpu = null;
      console.warn("WebGPU device lost:", reason);
      if (++gpuRestarts <= 3) setTimeout(startGpu, 300);
      else showNoGpu("The graphics device keeps getting lost: " + reason);
    };
    staticDirty = true;
  }).catch((err: unknown) => showNoGpu(String(err instanceof Error ? err.message : err)));
}
function showNoGpu(why: string) {
  if (stage.querySelector(".nogpu")) return;
  const box = document.createElement("div");
  box.className = "nogpu";
  box.innerHTML = "<b>WebGPU is required</b><br>" +
    why.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!) +
    "<br>Use a current Chrome, Edge or Safari, or Firefox on Windows or Apple Silicon.";
  stage.appendChild(box);
}
startGpu();

/** 자동 접합점·끝나지 않은 곳·넷 이름 자리의 색인. 넷 추출이 바뀌면 다시 만든다 */
let looseIdx: { pins: PointIndex; ends: PointIndex } | null = null;
let netSpots: { list: Array<[string, Pt]>; idx: PointIndex } | null = null;

/** 화면에 보이는 월드 영역 (글자가 객체 상자 밖으로 나가는 만큼 여유를 둔다) */
function viewRect(marginPx: number): [number, number, number, number] {
  const m = marginPx / vp.scale;
  return [vp.at[0] - m, vp.at[1] - m, vp.at[0] + W / vp.scale + m, vp.at[1] + H / vp.scale + m];
}

function drawStatic() {
  const t = R.theme();
  const dpr = window.devicePixelRatio || 1;
  scene.flush();
  if (scene.hasLive) scene.buildLive();
  gpu?.draw(scene, { at: vp.at, scale: vp.scale }, W, H, dpr,
    { styles: styleColors(t), grid: t.grid, gridBold: t.gridBold || t.grid, axis: t.axis }, showGrid);
  drawTextLayer(t);
}

/**
 * 글자 층. 예전에는 화면 밖 부품의 지정자와 값까지 전부 fillText 했다 — 확대해서 몇 개만
 * 보일 때가 전체를 볼 때보다 3~7배 느렸던 이유다. 지금은 색인에서 화면 근처만 꺼낸다.
 */
function drawTextLayer(t: R.Theme) {
  gT.clearRect(0, 0, W, H);
  const [x0, y0, x1, y1] = viewRect(160);
  const inView = (p: Pt) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  // 끄는 중인 것은 색인이 옛 자리를 들고 있으므로 따로 더한다
  const extra = drag || vdrag ? liveEntries() : [];

  const wantParts = vp.scale > 0.6;           // 핀 이름은 0.6, 지정자·값은 0.9 부터 보인다
  const kinds = new Set<IndexedKind>(["label"]);
  if (wantParts) kinds.add("part");
  if (highlightNet) kinds.add("wire");
  const hits = [...index.query(x0, y0, x1, y1, kinds), ...extra.filter(e => kinds.has(e.kind))];
  hits.sort((a, b) => a.index - b.index);
  const seen = new Set<unknown>();
  const parts: Part[] = [], labels: NetLabel[] = [], wires: Wire[] = [];
  for (const e of hits) {
    if (seen.has(e.obj)) continue;
    seen.add(e.obj);
    if (e.kind === "part") parts.push(e.obj as Part);
    else if (e.kind === "label") labels.push(e.obj as NetLabel);
    else if (e.kind === "wire") wires.push(e.obj as Wire);
  }

  for (const part of parts) {
    const lib = project.library[part.lib];
    if (lib) R.drawPartText(gT, vp, part, lib, t, dupRefs.has(part.ref.toUpperCase()), showPinNames);
  }
  R.drawLabels(gT, vp, labels, t);
  // 넷 이름은 라벨 **뒤**에 적는다. 라벨이 있는 넷은 이름이 같아 두 번 보일 뿐이다
  if (showNetNames && vp.scale >= 0.6) {
    if (!netSpots) {
      const list = R.netNameSpots(ex.nets);
      netSpots = { list, idx: new PointIndex(list.map(x => x[1])) };
    }
    const ids: number[] = [];
    netSpots.idx.eachNear([x0, y0], [x1, y1], i => { ids.push(i); });
    ids.sort((a, b) => a - b);
    R.drawNetNames(gT, vp, ids.map(i => netSpots!.list[i]), t);
  }
  // 지시문 블록·주석·프로브는 몇 개 안 되므로 다 그린다 (상자가 화면에 걸치는지만 본다)
  R.drawSpiceBlocks(gT, vp, sheet.spice, t);
  R.drawNotes(gT, vp, sheet.notes, t);
  R.drawProbes(gT, vp, sheet.probes, p => ex.netAt(p),
    p => index.query(p[0], p[1], p[0], p[1], KINDS_LABEL).some(e => {
      const l = e.obj as NetLabel;
      return l.at[0] === p[0] && l.at[1] === p[1];
    }), t);
  // 끝나지 않은 곳을 눈에 띄게 (설계서 12-7). 배율이 작으면 그리지 않는다 (drawLooseMarks)
  if (vp.scale >= 0.8) {
    looseIdx ??= { pins: new PointIndex(ex.danglingPins), ends: new PointIndex(ex.looseEnds) };
    const pick = (idx: PointIndex, src: Pt[]) => {
      const out: Pt[] = [];
      idx.eachNear([x0, y0], [x1, y1], i => { if (inView(src[i])) out.push(src[i]); });
      return out;
    };
    R.drawLooseMarks(gT, vp, pick(looseIdx.pins, ex.danglingPins), pick(looseIdx.ends, ex.looseEnds), t);
  }
  if (highlightNet) R.drawNetHighlight(gT, vp, wires, p => ex.netAt(p) === highlightNet, t);
}

/** 끄는 중에 움직이는 객체들 (고른 것 + 따라 늘어나는 배선). 정적 층에서 빼고 따로 그린다 */
function liveEntries(): Entry[] {
  const out: Entry[] = [];
  const add = (kind: IndexedKind, id: Id) => { const e = index.entry(kind, id); if (e) out.push(e); };
  if (vdrag) add("wire", vdrag.wireId);
  if (drag) {
    for (const r of selRefs()) if (r.kind === "part" || r.kind === "wire" || r.kind === "label" || r.kind === "probe") add(r.kind, r.id);
    for (const a of drag.follow.attach) add("wire", a.wireId);
  }
  return out;
}

/**
 * 지정자가 겹친 부품 (설계서 E18: 중복이면 빨간 표시).
 * 문제 목록에도 오류로 뜨지만, 회로도에서 어느 것인지 바로 보여야 고칠 수 있다.
 */
let dupRefs = new Set<string>();
function markDuplicateRefs() {
  const seen = new Map<string, number>();
  for (const p of sheet.parts) {
    if (!project.library[p.lib]?.spice) continue;   // GND 기호는 센지 않는다
    const k = p.ref.toUpperCase();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  dupRefs = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
}

function drawOverlay() {
  const t = R.theme();
  gO.clearRect(0, 0, W, H);

  /*
   * 좁혀 둔 선분은 그 배선이 선택에서 빠지거나 사라지면 같이 없어진다.
   * 선택이 바뀌는 길이 여럿이라 (도구 전환·실행 취소·전체 선택·불러오기)
   * 지우는 쪽을 흩뿌리지 않고 그리기 직전에 한 번 확인한다.
   */
  if (segSel) {
    const wire = findById(sheet.wires, segSel!.wireId);
    if (!wire || !selection.has(refKey({ kind: "wire", id: segSel.wireId })) ||
        segSel.i >= wire.pts.length - 1) segSel = null;
  }

  /** 선택·호버한 것을 강조색으로 덧그린다 */
  const highlight = (r: Ref, withBox: boolean) => {
    if (r.kind === "part") {
      const p = findById(sheet.parts, r.id);
      const lib = p && project.library[p.lib];
      if (p && lib) {
        R.drawPart(gO, vp, p, lib, t.select, t);
        if (withBox) R.drawSelection(gO, vp, p, lib, t);
      }
    } else if (r.kind === "wire") {
      const wre = findById(sheet.wires, r.id);
      if (!wre) return;
      gO.strokeStyle = t.select;
      gO.lineWidth = Math.max(2.4, 2.4 * Math.min(vp.scale / 2, 2));
      gO.lineJoin = "round"; gO.lineCap = "round";
      const narrowed = withBox && segSel?.wireId === r.id;
      gO.beginPath();
      if (narrowed) {
        // 좁혀 뒀으면 그 선분만 강조색이다. 나머지는 원래 색 그대로 두어
        // '배선 전체' 와 '선분 하나' 가 한눈에 갈린다 (설계서 2절)
        const a = toScreen(vp, wre.pts[segSel!.i]), b = toScreen(vp, wre.pts[segSel!.i + 1]);
        gO.moveTo(a[0], a[1]); gO.lineTo(b[0], b[1]);
      } else {
        wre.pts.forEach((p, i) => { const s = toScreen(vp, p); if (i) gO.lineTo(s[0], s[1]); else gO.moveTo(s[0], s[1]); });
      }
      gO.stroke();
      // 꺾점 손잡이 — 잡아서 끌 수 있다는 표시 (설계서 4절)
      if (withBox) {
        gO.fillStyle = t.select;
        for (const p of wre.pts) {
          const s = toScreen(vp, p);
          gO.fillRect(Math.round(s[0]) - 2.5, Math.round(s[1]) - 2.5, 5, 5);
        }
      }
    } else if (r.kind === "note") {
      const n = findById(sheet.notes, r.id);
      if (!n) return;
      const [a, b] = R.noteBounds(n, vp, gO);
      gO.strokeStyle = t.select;
      gO.lineWidth = 1.5;
      gO.strokeRect(Math.round(a[0]) - 2.5, Math.round(a[1]) - 2.5, b[0] - a[0] + 5, b[1] - a[1] + 5);
    } else if (r.kind === "spice") {
      const b = findById(sheet.spice, r.id);
      if (!b) return;
      const [a, bb] = R.blockBounds(b, vp);
      gO.strokeStyle = t.select;
      gO.lineWidth = 1.5;
      gO.strokeRect(Math.round(a[0]) - 1.5, Math.round(a[1]) - 1.5, bb[0] - a[0] + 3, bb[1] - a[1] + 3);
    } else {
      const o = r.kind === "label"
        ? findById(sheet.labels, r.id)
        : findById(sheet.probes, r.id);
      if (!o) return;
      const s = toScreen(vp, o.at);
      gO.strokeStyle = t.select;
      gO.lineWidth = 1.5;
      gO.strokeRect(Math.round(s[0]) - 6.5, Math.round(s[1]) - 6.5, 13, 13);
    }
  };

  const hoverKey = hover ? refKey(hover) : null;
  if (hover && !selection.has(hoverKey!)) highlight(hover, false);
  /*
   * 고른 것이 많으면(전체 선택) 화면 밖 것은 건너뛴다. 예전에는 커서가 움직일 때마다 고른 것
   * 전부를 다시 그렸다 — 부품 5만 개를 다 고르면 한 번에 수십만 개. 지금 모양으로 상자를
   * 재므로 끄는 중에도 맞다. 글자가 상자 밖으로 나가는 만큼 여유를 둔다.
   */
  const [vx0, vy0, vx1, vy1] = viewRect(160);
  const visible = (r: Ref): boolean => {
    if (selection.size < 200) return true;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (p: Pt) => { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; };
    if (r.kind === "part") {
      const part = findById(sheet.parts, r.id), lib = part && project.library[part.lib];
      if (!part || !lib) return false;
      const b = symbolBox(lib, part.rot, part.mirror);
      add([part.at[0] + b[0], part.at[1] + b[1]]); add([part.at[0] + b[2], part.at[1] + b[3]]);
    } else if (r.kind === "wire") findById(sheet.wires, r.id)?.pts.forEach(add);
    else if (r.kind === "label") { const l = findById(sheet.labels, r.id); if (l) add(l.at); }
    else if (r.kind === "probe") { const q = findById(sheet.probes, r.id); if (q) add(q.at); }
    else return true;                                // 주석·지시문 블록은 몇 개 안 된다
    return x1 >= vx0 && x0 <= vx1 && y1 >= vy0 && y0 <= vy1;
  };
  for (const r of selRefs()) if (visible(r)) highlight(r, true);

  // 박스 선택
  if (box) {
    const a = toScreen(vp, box.from), b = toScreen(vp, box.to);
    gO.strokeStyle = t.select;
    gO.fillStyle = t.select;
    gO.globalAlpha = 0.08;
    gO.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    gO.globalAlpha = 1;
    gO.lineWidth = 1;
    gO.setLineDash([4, 3]);
    gO.strokeRect(Math.round(a[0]) + 0.5, Math.round(a[1]) + 0.5, Math.round(b[0] - a[0]), Math.round(b[1] - a[1]));
    gO.setLineDash([]);
  }

  // 배치 미리보기
  if (tool === "place" && placing && snap) {
    const lib = BUILTIN[placing];
    const ghost: Part = { id: "ghost", lib: placing, ref: "", at: snap.at, rot: placeRot, mirror: placeMirror, params: {} };
    project.library[placing] ??= structuredClone(lib);
    gO.globalAlpha = 0.55;
    R.drawPart(gO, vp, ghost, project.library[placing], t.select, t);
    gO.globalAlpha = 1;
  }

  // 배선 미리보기
  if (wireDraft && snap) {
    const pts = [...wireDraft, ...bendPath(wireDraft[wireDraft.length - 1], snap.at)];
    gO.strokeStyle = t.wire; gO.globalAlpha = 0.6;
    gO.lineWidth = Math.max(1.4, 1.4 * Math.min(vp.scale / 2, 2));
    gO.lineJoin = "round"; gO.lineCap = "round";
    gO.beginPath();
    pts.forEach((p, i) => { const s = toScreen(vp, p); if (i) gO.lineTo(s[0], s[1]); else gO.moveTo(s[0], s[1]); });
    gO.stroke(); gO.globalAlpha = 1;
  }

  // 끌 때 새로 붙을 자리 (설계서 12-4)
  if (connectPreview.length) R.drawConnectPreview(gO, vp, connectPreview, t);

  // 스냅 표시 — 위치는 보간하지 않는다
  if (snap && tool !== "select") {
    const s = toScreen(vp, snap.at);
    gO.strokeStyle = snap.kind === "grid" ? t.muted : t.select;
    gO.lineWidth = 1.5;
    gO.beginPath(); gO.arc(s[0], s[1], snap.kind === "grid" ? 3 : 6, 0, Math.PI * 2); gO.stroke();
  }
}

function frame() {
  if (staticDirty) { drawStatic(); staticDirty = false; }
  if (overlayDirty) { drawOverlay(); overlayDirty = false; }
  requestAnimationFrame(frame);
}

/**
 * 화면 맞춤. refs 를 주면 그것만, 안 주면 그린 것 전체에 맞춘다 (설계서 1절 '선택 맞춤').
 * K 는 도면 테두리가 아니라 그린 내용 전체다 — 1차에는 도면 틀이 없다 (설계서 12-3).
 */
function fit(refs?: Ref[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Pt) => {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  };
  const keys = refs && new Set(refs.map(refKey));
  const want = (r: Ref) => !keys || keys.has(refKey(r));
  for (const part of sheet.parts) {
    const lib = project.library[part.lib];
    if (lib && want({ kind: "part", id: part.id })) { const [a, b] = R.partBounds(part, lib); add(a); add(b); }
  }
  for (const w of sheet.wires) if (want({ kind: "wire", id: w.id })) w.pts.forEach(add);
  if (keys) {
    for (const l of sheet.labels) if (want({ kind: "label", id: l.id })) add(l.at);
    for (const p of sheet.probes) if (want({ kind: "probe", id: p.id })) add(p.at);
    // 점 하나짜리 선택(라벨·프로브 한 개)은 넓이가 0 이라 그대로 맞추면 배율이 튄다
    if (isFinite(x0) && x1 - x0 < 80 && y1 - y0 < 80) {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      x0 = cx - 40; x1 = cx + 40; y0 = cy - 40; y1 = cy + 40;
    }
  }
  if (!isFinite(x0)) { vp = { at: [-W / 2 / 2.4, -H / 2 / 2.4], scale: 2.4 }; staticDirty = overlayDirty = true; return; }
  const m = 60;
  const scale = Math.max(P.zoomMin, Math.min(P.zoomMax,
    Math.min((W - m * 2) / Math.max(x1 - x0, 1), (H - m * 2) / Math.max(y1 - y0, 1))));
  vp = { scale, at: [x0 - (W / scale - (x1 - x0)) / 2, y0 - (H / scale - (y1 - y0)) / 2] };
  staticDirty = overlayDirty = true;
}

// ── 입력 ──────────────────────────────────────────────────────────────
const local = (e: { clientX: number; clientY: number }): Pt => {
  const r = stage.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

stage.addEventListener("pointerdown", e => {
  // 캡처는 "있으면 좋은 것" 이다. 포인터가 이미 놓였거나 합성 이벤트면 던지는데,
  // 여기서 예외가 나면 아래 선택·배치 처리가 통째로 날아간다
  try { stage.setPointerCapture(e.pointerId); } catch { /* 캡처 없이도 끌기는 된다 */ }
  cursor = local(e);
  down = { at: cursor, button: e.button, moved: false, shift: e.shiftKey || e.ctrlKey || e.metaKey };
  if (e.button !== 0) return;
  updateSnap();

  if (tool === "place" && placing) {
    const p = newPart(placing, snap!.at);
    if (!e.shiftKey) { tool = "select"; placing = null; }  // Shift 로 연속 배치
    // 배선 위에 놓았으면 그 배선을 끊어 부품을 끼운다 (설계서 연결 규칙 4).
    // 한 단계여야 Ctrl+Z 한 번에 배선까지 돌아온다
    const splice = spliceCommandsFor(p);
    edit(splice.length ? batch("Insert part", [addPart(p), ...splice]) : addPart(p), ["part:" + p.id]);
    syncToolbar();
  } else if (tool === "wire") {
    if (!wireDraft) wireDraft = [snap!.at];
    else {
      const add = bendPath(wireDraft[wireDraft.length - 1], snap!.at);
      wireDraft.push(...add);
      if (snap!.kind === "pin" || snap!.kind === "wireEnd" || snap!.kind === "wireSeg") finishWire();
    }
  } else if (tool === "label") {
    const name = prompt("Net name (starts with a letter; letters, digits, underscore)", nextLabelName());
    if (name && /^[A-Za-z]\w*$/.test(name)) {
      lastLabelName = name;
      edit(addLabel({ id: uid(), name, at: snap!.at, kind: "label" }), []);
    } else if (name) {
      alert("A name must start with a letter and use only letters, digits and underscores");
    }
    tool = "select"; syncToolbar();
  } else if (tool === "probe") {
    const hit = sheet.probes.find(p => p.at[0] === snap!.at[0] && p.at[1] === snap!.at[1]);
    if (hit) edit(removeProbe(hit.id), []);
    else if (ex.netAt(snap!.at)) {
      edit(addProbe({ id: uid(), at: snap!.at, color: nextProbeColor() }), []);
    } else {
      alert("It has to sit on a net — click a wire or a pin end");
    }
    if (!e.shiftKey) { tool = "select"; syncToolbar(); }
  } else if (tool === "nc") {
    // 미연결 표시는 핀 끝에만 놓인다 (설계서 E05)
    const hit = pinAtWorld(snap!.at);
    if (hit) edit(toggleNc(hit.part.id, hit.pinId), []);
    else alert("It can only go on a pin end");
    if (!e.shiftKey) { tool = "select"; syncToolbar(); }
  } else if (tool === "power") {
    const name = prompt("Supply name (VCC, VDD, …)", "VCC");
    if (name && /^[A-Za-z]\w*$/.test(name)) {
      edit(addLabel({ id: uid(), name, at: snap!.at, kind: "power" }), []);
    } else if (name) {
      alert("A name must start with a letter and use only letters, digits and underscores");
    }
    tool = "select"; syncToolbar();
  } else if (tool === "spice") {
    // 빈 지시문 블록을 놓고 바로 고를 수 있게 한다 (설계서 E33)
    const block = { id: uid(), at: snap!.at, lines: [] as string[], active: true };
    edit(addObjects([], [], [], [], [block]), [refKey({ kind: "spice", id: block.id })]);
    setTool("select");
    setSelection([refKey({ kind: "spice", id: block.id })]);
    renderProps();
  } else if (tool === "text" || tool === "line" || tool === "rect") {
    startNote(tool, snap!.at);
  } else if (tool === "junction") {
    toggleJunction(snap!.at);
    if (!e.shiftKey) { tool = "select"; syncToolbar(); }
  } else if (tool === "gnd") {
    const g = newPart("gnd", snap!.at);
    if (!e.shiftKey) { tool = "select"; syncToolbar(); }
    edit(addPart(g), []);
  } else {
    const w0 = toWorld(vp, cursor);
    /*
     * 떠 있는 핀 끝을 누르면 거기서 배선이 시작된다 (설계서 4절: Std 는 회색 핀 점).
     * 이미 이어진 핀은 그냥 고른다 — 부품을 집으려다 배선이 시작되면 성가시다.
     */
    const freePin = ex.danglingPins.find(p => p[0] === snap!.at[0] && p[1] === snap!.at[1]);
    // 스냅이 이미 반경을 보고 붙여 준 자리다. 여기서 또 재면 "핀에 붙었는데 시작은 안 된다" 가 된다
    if (freePin) {
      setTool("wire");
      wireDraft = [[freePin[0], freePin[1]]];
      overlayDirty = true;
      return;
    }
    const hit = hitTest(w0);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!hit) { if (!additive) { selection.clear(); segSel = null; } }
    else {
      const k = refKey(hit);
      if (additive) { selection.has(k) ? selection.delete(k) : selection.add(k); segSel = null; }
      else if (!selection.has(k)) { setSelection([k]); segSel = null; }
      // 이미 골라 둔 배선을 한 번 더 누르면 선분 하나로 좁힌다 (설계서 2절)
      else if (hit.kind === "wire") {
        const i = segmentAt(hit.id, w0);
        if (i !== null) segSel = { wireId: hit.id, i };
      }
    }
    renderProps();
  }
  overlayDirty = true;
});

stage.addEventListener("pointermove", e => {
  cursor = local(e);
  shiftHeld = e.shiftKey;
  if (down && !down.moved && dist(cursor, down.at) > P.dragThresholdPx) {
    down.moved = true;
    if (down.button === 2 || down.button === 1) pan = { from: down.at, at: [vp.at[0], vp.at[1]] };
    else if (down.button === 0 && tool === "select") {
      const w0 = toWorld(vp, down.at);
      const hit = hitTest(w0);
      // 골라 둔 배선의 꺾점이나 좁힌 선분을 잡았으면 그것만 옮긴다 (설계서 4절)
      const vd = wirePartAt(w0);
      if (vd) vdrag = vd;
      else if (hit && selection.has(refKey(hit))) {
        // 기록은 끌기가 끝날 때 한 번만 남긴다 (pointerup)
        drag = { from: w0, moved: [0, 0], follow: followSelection() };
      } else {
        box = { from: w0, to: w0 };
      }
      // 움직일 것은 정적 층에서 빼서 매 프레임 따로 그린다 (나머지 덩어리는 그대로 둔다)
      if (vdrag || drag) scene.setLive(liveEntries());
    }
  }

  if (pan) {
    const dx = cursor[0] - pan.from[0], dy = cursor[1] - pan.from[1];
    vp = { scale: vp.scale, at: [pan.at[0] - dx / vp.scale, pan.at[1] - dy / vp.scale] };
    staticDirty = overlayDirty = true;
    return;
  }

  updateSnap();

  if (vdrag) {
    // 끌기 시작 때의 모양에서 매번 다시 만든다 (누적하지 않는다)
    const w = toWorld(vp, cursor);
    const want = snapPt([w[0] - vdrag.from[0], w[1] - vdrag.from[1]]);
    if (want[0] !== vdrag.moved[0] || want[1] !== vdrag.moved[1]) {
      vdrag.moved = want;
      const wire = findById(sheet.wires, vdrag!.wireId);
      if (wire) wire.pts = movedPts(vdrag);
      staticDirty = true;
    }
  } else if (drag) {
    // 끄는 동안은 화면용으로 직접 움직인다. 격자 배수만큼씩 옮겨
    // 핀이 항상 격자 위에 남게 한다
    const w = toWorld(vp, cursor);
    const want = snapPt([w[0] - drag.from[0], w[1] - drag.from[1]]);
    const step: Pt = [want[0] - drag.moved[0], want[1] - drag.moved[1]];
    if (step[0] || step[1]) {
      transform(selRefs(), { move: step }).apply(sheet);
      drag.moved = want;
      connectPreview = newConnections();
      // 붙은 배선은 시작 모양에서 매번 다시 만든다 (누적하지 않는다)
      for (const f of drag.follow.translated(want)) {
        const wire = findById(sheet.wires, f.id);
        if (wire) wire.pts = f.pts;
      }
      staticDirty = true;
    }
  } else if (box) {
    box.to = toWorld(vp, cursor);
  } else if (tool === "select") {
    hover = hitTest(toWorld(vp, cursor));
  } else {
    hover = null;
  }
  overlayDirty = true;
});

/**
 * 끄는 중이던 것을 없던 일로 한다.
 *
 * 끄는 동안은 화면을 위해 문서를 **기록 없이** 직접 움직인다. 그래서 drag 를 그냥 버리면
 * 옮겨진 채로 남고, 그 변경은 실행 취소로도 되돌릴 수 없다. 시작 모양으로 돌려놓는다.
 */
function cancelDrag() {
  if (drag) {
    const { moved, follow } = drag;
    if (moved[0] || moved[1]) transform(selRefs(), { move: [-moved[0], -moved[1]] }).apply(sheet);
    for (const a of follow.attach) {
      const w = findById(sheet.wires, a.wireId);
      if (w) w.pts = a.docPts.map(p => [p[0], p[1]] as Pt);
    }
    drag = null;
    connectPreview = [];
    staticDirty = overlayDirty = true;
  }
  if (vdrag) {
    const w = findById(sheet.wires, vdrag.wireId);
    if (w) w.pts = vdrag.orig.map(p => [p[0], p[1]] as Pt);
    vdrag = null;
    staticDirty = overlayDirty = true;
  }
  scene.setLive(null);
}

stage.addEventListener("pointerup", () => {
  if (vdrag || drag) scene.setLive(null);
  if (vdrag) {
    const v = vdrag;
    vdrag = null;
    const wire = findById(sheet.wires, v.wireId);
    if (wire && (v.moved[0] || v.moved[1])) {
      const final = movedPts(v);
      wire.pts = v.orig.map(p => [p[0], p[1]] as Pt);   // 되돌린 뒤 한 단계로 다시 적용
      edit(setWirePts(v.wireId, final));
    } else commit();
  } else if (drag) {
    const { moved: total, follow } = drag;
    drag = null;
    connectPreview = [];
    if (total[0] || total[1]) {
      // 최종 모양을 먼저 계산해 두고
      const finals = follow.translated(total);
      // 끄는 동안 직접 움직인 것을 시작 상태로 되돌린 뒤
      transform(selRefs(), { move: [-total[0], -total[1]] }).apply(sheet);
      for (const a of follow.attach) {
        const wire = findById(sheet.wires, a.wireId);
        // 끼워 넣은 꺾점이 없는 **문서 그대로**의 모양으로 되돌린다.
        // 여기서 되돌린 것이 setWirePts 가 '되돌리기용 이전 값' 으로 집어 가는 값이다
        if (wire) wire.pts = a.docPts.map(p => [p[0], p[1]] as Pt);
      }
      // 한 단계로 다시 적용한다 (설계서: 끌기 한 번 = 실행 취소 한 단계)
      edit(batch("Move", [
        transform(selRefs(), { move: total }, "Move"),
        ...finals.map(f => setWirePts(f.id, f.pts)),
      ]));
    } else commit();
  } else if (box) {
    const hits = refsInBox(box.from, box.to).map(refKey);
    box = null;
    // 끌기 시작 때 Shift 를 누르고 있었으면 기존 선택에 더한다
    if (!down?.shift) selection.clear();
    for (const k of hits) selection.add(k);
    renderProps();
  }
  // 오른쪽 버튼을 끌지 않고 뗐으면 메뉴다 (끌었으면 화면 이동이었다)
  if (down?.button === 2 && !down.moved) openCtx(down.at, toWorld(vp, down.at));
  down = null; pan = null;
  overlayDirty = true;
});
stage.addEventListener("contextmenu", e => e.preventDefault());

/**
 * 부품을 더블클릭하면 값 칸으로 바로 간다 (설계서 사용자 흐름 4단계).
 * 값 고치기는 제일 자주 하는 일인데, 오른쪽 패널까지 마우스를 옮겨야 하면 손이 많이 간다.
 */
/*
 * 그리던 배선을 끝낸다.
 *
 * 예전에는 핀이나 다른 배선에 **닿았을 때만** 끝났다. 빈 자리에 끊어 두고 싶으면
 * 방법이 없어서 Esc 로 버리는 수밖에 없었다 — 끝이 떠 있는 배선은 □ 로 표시되니
 * 사용자가 못 보고 지나칠 일도 아니다. Enter 와 더블클릭으로 끝낼 수 있게 한다.
 *
 * 잇따른 같은 점은 버린다. 더블클릭이면 두 번째 누름이 같은 자리에 한 점을 더 얹는다.
 */
function finishWire() {
  if (!wireDraft) return;
  const pts = wireDraft.filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
  if (pts.length >= 2) edit(addWire({ id: uid(), pts }), []);
  wireDraft = null;
  overlayDirty = true;
}

stage.addEventListener("dblclick", e => {
  if (tool === "wire" && wireDraft) { finishWire(); return; }
  if (tool !== "select") return;
  const hit = hitTest(toWorld(vp, local(e)));
  if (!hit || hit.kind !== "part") return;
  setSelection([refKey(hit)]);
  renderProps();
  overlayDirty = true;
  // 지정자 다음 칸이 첫 파라미터다
  const inputs = document.querySelectorAll<HTMLInputElement>("#propbody input");
  (inputs[1] ?? inputs[0])?.select();
});
stage.addEventListener("wheel", e => {
  e.preventDefault();
  // Shift+휠은 가로 이동 (설계서 1절). 트랙패드가 보내는 가로 성분도 같이 받는다
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) / vp.scale;
    vp = { scale: vp.scale, at: [vp.at[0] + dx, vp.at[1]] };
  } else {
    vp = zoomAt(vp, local(e), wheelFactor(e, P), P);
  }
  staticDirty = overlayDirty = true;
}, { passive: false });



function del() {
  // 선분 하나로 좁혀 뒀으면 그 선분만 지운다. 배선은 둘로 갈라진다 (설계서 2절)
  if (segSel) {
    const wire = findById(sheet.wires, segSel!.wireId);
    if (wire) {
      const made: Wire[] = splitWire(wire.pts, segSel.i).map(pts => ({ id: uid(), pts }));
      segSel = null;
      edit(batch("Delete segment", [
        removeObjects([{ kind: "wire", id: wire.id }]),
        ...(made.length ? [addObjects([], made, [], [])] : []),
      ]), made.map(w => refKey({ kind: "wire", id: w.id })));
      return;
    }
    segSel = null;
  }
  if (!selection.size) return;
  edit(removeObjects(selRefs()), []);
}

/** 배선 wireId 에서 w 아래에 있는 선분 번호. 없으면 null */
function segmentAt(wireId: Id, w: Pt): number | null {
  const wire = findById(sheet.wires, wireId);
  if (!wire) return null;
  const m = 6 / vp.scale;
  for (let k = 0; k < wire.pts.length - 1; k++) {
    if (distToSeg(w, wire.pts[k], wire.pts[k + 1]) <= m) return k;
  }
  return null;
}

/**
 * 골라 둔 배선에서 w 가 잡은 부분. 꺾점이 먼저고, 그다음이 좁혀 둔 선분이다.
 * 꺾점을 먼저 보는 이유: 꺾점은 늘 선분 위에 있어서, 선분이 이기면 꺾점을 못 잡는다.
 */
function wirePartAt(w: Pt): typeof vdrag {
  const m = 7 / vp.scale;
  const grab = (wire: Wire, pts: number[]): NonNullable<typeof vdrag> =>
    ({ wireId: wire.id, pts, orig: wire.pts.map(p => [p[0], p[1]] as Pt), from: w, moved: [0, 0] });
  for (const r of selRefs()) {
    if (r.kind !== "wire") continue;
    const wire = findById(sheet.wires, r.id);
    if (!wire) continue;
    for (let k = 0; k < wire.pts.length; k++) {
      if (Math.abs(wire.pts[k][0] - w[0]) <= m && Math.abs(wire.pts[k][1] - w[1]) <= m) return grab(wire, [k]);
    }
    if (segSel?.wireId === wire.id && segmentAt(wire.id, w) === segSel.i) {
      return grab(wire, [segSel.i, segSel.i + 1]);
    }
  }
  return null;
}

/** 끌고 있는 꺾점들을 옮긴 모양 */
const movedPts = (v: NonNullable<typeof vdrag>): Pt[] =>
  v.orig.map((p, k) => (v.pts.includes(k) ? [p[0] + v.moved[0], p[1] + v.moved[1]] as Pt : p));

/**
 * 회전·대칭. 하나만 골랐으면 제자리에서, 여러 개면 선택 전체의 가운데를 중심으로 돈다.
 * 설계서 12-1 대로 배선이 섞인 선택도 돌린다 (Pro 는 못 돌린다).
 */
function applyXform(xf: Xform, label: string) {
  // 끄는 중에는 문서가 기록 없이 움직여 있다. 그 위에 기록을 얹으면 놓을 때 되돌릴 자리가 틀어진다
  if (!selection.size || drag || vdrag) return;
  const refs = selRefs();
  const one = selOnePart();
  const x = one ? { ...xf, center: one.at } : xf;
  // 붙은 배선도 따라온다 (doc/ops.ts). 같이 고른 배선은 통째로 같이 움직인다
  const moving = new Set<Id>(refs.filter(r => r.kind === "wire").map(r => r.id));
  edit(xformCommand(sheet, project.library, index, refs, x, label, moving));
}
const rotate = () => applyXform({ rotate: 90 }, "Rotate");
const flipX = () => applyXform({ flip: "x" }, "Flip horizontal");
const flipY = () => applyXform({ flip: "y" }, "Flip vertical");

/**
 * 넷 강조 (E20). 고른 배선·핀이 속한 넷을 회로도 전체에서 밝힌다.
 * Shift+H 로 끈다.
 */
function toggleHighlight(clear: boolean) {
  if (clear) { highlightNet = null; staticDirty = true; renderStatus(); return; }
  for (const r of selRefs()) {
    let at: Pt | null = null;
    if (r.kind === "wire") at = findById(sheet.wires, r.id)?.pts[0] ?? null;
    else if (r.kind === "probe") at = findById(sheet.probes, r.id)?.at ?? null;
    else if (r.kind === "label") at = findById(sheet.labels, r.id)?.at ?? null;
    else if (r.kind === "part") {
      const p = findById(sheet.parts, r.id);
      const lib = p && project.library[p.lib];
      if (p && lib && lib.symbol.pins.length) at = pinAt(p, lib, 0);
    }
    const net = at && ex.netAt(at);
    if (net) { highlightNet = net; staticDirty = true; renderStatus(); return; }
  }
  highlightNet = null;
  staticDirty = true;
  renderStatus();
}

const selectAll = () => {
  setSelection([
    ...sheet.parts.map(p => "part:" + p.id),
    ...sheet.wires.map(w => "wire:" + w.id),
    ...sheet.labels.map(l => "label:" + l.id),
    ...sheet.probes.map(p => "probe:" + p.id),
  ]);
  renderProps(); overlayDirty = true;
};

/** 방향키로 격자 한 칸씩. Shift 를 누르면 열 칸 */
function nudge(dx: number, dy: number, big: boolean) {
  if (!selection.size || drag || vdrag) return;
  const k = big ? 10 : 1;
  const d: Pt = [dx * GRID * k, dy * GRID * k];
  // 방향키도 끌기와 같은 이동이다. 붙은 배선이 안 따라오면 연결이 조용히 끊긴다
  const follow = followSelection().translated(d).map(f => setWirePts(f.id, f.pts));
  const move = transform(selRefs(), { move: d }, "Move");
  edit(follow.length ? batch("Move", [move, ...follow]) : move);
}

// ── 복사·붙여넣기 (E13) ───────────────────────────────────────────────
/**
 * 클립보드는 앱 안에만 둔다. 설계서대로 같은 브라우저 안에서만 동작한다.
 * 붙여넣을 때 id 를 새로 만들고 지정자도 다음 번호를 받는다.
 */
let clipboard: { parts: Part[]; wires: Wire[]; labels: NetLabel[]; probes: Probe[] } | null = null;

function copySelection(cut: boolean) {
  if (!selection.size) return;
  const refs = selRefs();
  const has = (kind: string, id: Id) => refs.some(r => r.kind === kind && r.id === id);
  clipboard = {
    parts: sheet.parts.filter(p => has("part", p.id)).map(p => structuredClone(p)),
    wires: sheet.wires.filter(w => has("wire", w.id)).map(w => structuredClone(w)),
    labels: sheet.labels.filter(l => has("label", l.id)).map(l => structuredClone(l)),
    probes: sheet.probes.filter(p => has("probe", p.id)).map(p => structuredClone(p)),
  };
  if (cut) edit(removeObjects(refs), []);
}

function paste() {
  if (!clipboard) return;
  // 원래 자리에서 한 칸씩 어긋나게 놓아 겹쳐 보이지 않게 한다 (O-36 전까지 잠정)
  const off: Pt = [GRID, GRID];
  const used: Record<string, number> = {};
  const parts = clipboard.parts.map(p => {
    const lib = ensureInLibrary(project.library, p.lib);
    // 붙여넣는 것들끼리도 번호가 겹치지 않게 센다
    const n = (used[lib.refPrefix] = (used[lib.refPrefix] ?? 0) + 1);
    let ref = nextRef(lib.refPrefix);
    const base = Number(/(\d+)$/.exec(ref)?.[1] ?? 1);
    ref = lib.refPrefix + (base + n - 1);
    return { ...p, id: uid(), ref, at: [p.at[0] + off[0], p.at[1] + off[1]] as Pt };
  });
  const wires = clipboard.wires.map(w =>
    ({ ...w, id: uid(), pts: w.pts.map(p => [p[0] + off[0], p[1] + off[1]] as Pt) }));
  const labels = clipboard.labels.map(l =>
    ({ ...l, id: uid(), at: [l.at[0] + off[0], l.at[1] + off[1]] as Pt }));
  const probes = clipboard.probes.map((p: Probe) =>
    ({ ...p, id: uid(), at: [p.at[0] + off[0], p.at[1] + off[1]] as Pt }));

  const keys = [
    ...parts.map(p => "part:" + p.id), ...wires.map(w => "wire:" + w.id),
    ...labels.map(l => "label:" + l.id), ...probes.map(p => "probe:" + p.id),
  ];
  edit(addObjects(parts, wires, labels, probes), keys);
}

/** 수동 접합점 (E04). 이미 있는 자리를 누르면 뗀다 */
function toggleJunction(at: Pt) {
  const i = sheet.junctions.findIndex(p => p[0] === at[0] && p[1] === at[1]);
  if (i >= 0) { edit(removeJunction(at), []); return; }
  edit(addJunction(at), []);
}

// ── 패널 ──────────────────────────────────────────────────────────────
function setTool(t: Tool, lib?: string) {
  tool = t;
  placing = t === "place" ? lib ?? null : null;
  if (t !== "wire") wireDraft = null;
  if (t !== "line" && t !== "rect") noteDraft = null;
  if (t !== "place") { placeRot = 0; placeMirror = false; }
  if (t !== "select") { selection.clear(); hover = null; }
  stage.style.cursor = t === "select" ? "default" : "crosshair";
  // 상태 표시줄의 '지금 도구에서 쓰는 키' 도 같이 바꾼다 (설계서 9절)
  syncToolbar(); renderProps(); renderStatus(); overlayDirty = true;
}

function syncToolbar() {
  const map: Record<string, Tool> = {
    "t-select": "select", "t-wire": "wire", "t-label": "label", "t-gnd": "gnd", "t-probe": "probe",
    "t-junction": "junction", "t-nc": "nc", "t-power": "power", "t-spice": "spice",
    "t-text": "text", "t-line": "line", "t-rect": "rect",
  };
  for (const [id, t] of Object.entries(map)) $(id).classList.toggle("on", tool === t);
  for (const el of document.querySelectorAll<HTMLButtonElement>(".libitem")) {
    el.classList.toggle("on", tool === "place" && placing === el.dataset.lib);
  }
}

const palette = $("palette");
/*
 * 왼쪽 부품 목록. 부품 라이브러리 창(Shift+F)과 같은 목차(src/lib/catalog.ts)를 쓴다 —
 * 라이브러리(수동 소자 · 아날로그 · SKY130 · 기호)마다 접히고, 안에서는 칸 이름을 작게 적는다.
 * 부품이 서른을 넘어서 찾는 것이 저항인데 반도체 여섯 줄을 지나치는 일이 잦다. 세로로 긴 폰에서
 * 특히 그래서, 접은 상태는 창 설정과 같이 남는다. 넓게 보고 고를 때는 'Library' 단추로 창을 연다.
 */
for (const lib of LIBRARIES) {
  const box = document.createElement("div");
  box.className = "libgroup";
  box.dataset.cat = lib.name;
  const h = document.createElement("button");
  h.type = "button";
  h.className = "libcat";
  h.textContent = lib.name;
  h.title = lib.blurb;
  h.onclick = () => {
    const closed = box.classList.toggle("closed");
    if (closed) libClosed.add(lib.name); else libClosed.delete(lib.name);
    h.setAttribute("aria-expanded", String(!closed));
    saveLayout();
  };
  const body = document.createElement("div");
  body.className = "libitems";
  for (const group of lib.groups) {
    // 칸이 하나뿐이면 라이브러리 이름과 같은 말을 두 번 적게 된다
    if (lib.groups.length > 1) {
      const sub = document.createElement("div");
      sub.className = "libsub";
      sub.textContent = group.name;
      body.appendChild(sub);
    }
    for (const id of group.parts) {
      const b = document.createElement("button");
      b.className = "libitem";
      b.dataset.lib = id;
      b.textContent = BUILTIN[id].name;
      b.title = ABOUT[id]?.text ?? BUILTIN[id].name;
      b.onclick = () => setTool("place", id);
      // 캔버스로 끌어다 놓기 (설계서 E01 · 3절). 클릭 배치와 같은 길로 들어간다
      b.draggable = true;
      b.ondragstart = e => { e.dataTransfer?.setData("text/melange-lib", id); };
      body.appendChild(b);
    }
  }
  box.append(h, body);
  palette.appendChild(box);
}
$("open-lib").onclick = openLib;

/** 저장된 '접어 둠' 을 화면에 입힌다. 목록을 만든 뒤에 불린다 */
function applyLibGroups() {
  for (const box of document.querySelectorAll<HTMLElement>(".libgroup")) {
    const closed = libClosed.has(box.dataset.cat ?? "");
    box.classList.toggle("closed", closed);
    box.querySelector(".libcat")?.setAttribute("aria-expanded", String(!closed));
  }
}

$("t-select").onclick = () => setTool("select");
$("t-wire").onclick = () => setTool("wire");
$("t-label").onclick = () => setTool("label");
$("t-gnd").onclick = () => setTool("gnd");
$("t-probe").onclick = () => setTool("probe");
$("t-junction").onclick = () => setTool("junction");
$("t-nc").onclick = () => setTool("nc");
$("t-power").onclick = () => setTool("power");
$("t-spice").onclick = () => setTool("spice");
$("t-text").onclick = () => setTool("text");
$("t-line").onclick = () => setTool("line");
$("t-rect").onclick = () => setTool("rect");
$("t-flipx").onclick = flipX;
$("t-flipy").onclick = flipY;
$("t-redo").onclick = redo;
$("t-del").onclick = del;
$("t-rot").onclick = rotate;
$("t-undo").onclick = undo;
$("t-fit").onclick = () => fit();
$("t-run").onclick = run;
$<HTMLInputElement>("file").onchange = e => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void openFile(f).catch(err => alert("Could not open: " + err.message));
  (e.target as HTMLInputElement).value = "";   // 같은 파일을 다시 골라도 열리게
};

/** 속성 패널의 입력 칸 하나 */
function makeField(
  body: HTMLElement, label: string, unit: string, value: string,
  on: (v: string) => void, placeholder?: string,
) {
  const l = document.createElement("label");
  l.className = "f";
  const row = document.createElement("span");
  row.className = "row";
  const a = document.createElement("span"); a.textContent = label;
  const b = document.createElement("span"); b.textContent = unit;
  row.append(a, b);
  const i = document.createElement("input");
  i.value = value;
  if (placeholder) i.placeholder = placeholder;
  i.onchange = () => on(i.value.trim());
  l.append(row, i);
  body.appendChild(l);
}

/** 지정자·값 글자 위치 고르개 (E17). 고른 부품 전부에 한 번에 적용한다 */
function addTextSlotPicker(body: HTMLElement, parts: Part[]) {
  const head = document.createElement("h2");
  head.textContent = "Text position";
  body.appendChild(head);
  const bar = document.createElement("div");
  bar.className = "seg";
  bar.style.cssText = "display:flex;gap:4px;flex-wrap:wrap";
  for (const [name, slot] of Object.entries(TEXT_SLOTS)) {
    const b = document.createElement("button");
    b.textContent = name;
    b.style.fontSize = "11px";
    b.onclick = () => edit(setTextAt(parts.map(p => p.id), slot));
    bar.appendChild(b);
  }
  body.appendChild(bar);
}

function renderProps() {
  const body = $("propbody");
  const selected = selOnePart();
  layoutSwitch?.circuitSelection(selParts().map(p => p.ref));

  if (!selection.size) {
    // 고른 것이 없을 때는 프로젝트 이름을 둔다 (설계서 대조표 105번).
    // 이름은 .sp 제목 줄과 내보낼 파일 이름이 된다
    body.className = "";
    body.innerHTML = "";
    const l = document.createElement("label");
    l.className = "f";
    const row = document.createElement("span");
    row.className = "row";
    const a = document.createElement("span"); a.textContent = "Project name";
    row.append(a);
    const i = document.createElement("input");
    i.value = project.name;
    i.onchange = () => {
      project.name = i.value.trim() || "untitled";
      autosave.touch(project);
      renderTab();
    };
    l.append(row, i);
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "Nothing selected. Pick anything on the canvas and its properties show up here";
    body.append(l, note);
    return;
  }

  body.className = "";
  body.innerHTML = "";

  /*
   * SPICE 지시문 블록 하나를 골랐으면 글자를 그대로 고치게 한다 (설계서 E33).
   * 줄 단위로 쪼개 명령에 넣는다 — 한 번 고치면 한 단계다.
   */
  const one = selection.size === 1 ? parseRef([...selection][0]) : null;
  if (one?.kind === "spice") {
    const block = findById(sheet.spice, one.id);
    if (block) {
      const h = document.createElement("div");
      h.className = "title";
      h.textContent = "SPICE directive";
      const ta = document.createElement("textarea");
      ta.value = block.lines.join("\n");
      ta.rows = Math.max(4, Math.min(16, block.lines.length + 2));
      ta.spellcheck = false;
      ta.onchange = () => {
        const lines = ta.value.replace(/\r/g, "").split("\n");
        edit(setSpiceBlock(block.id, { lines }));
        renderProps();
      };
      const lab = document.createElement("label");
      lab.className = "chk";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = block.active;
      cb.onchange = () => { edit(setSpiceBlock(block.id, { active: cb.checked })); renderProps(); };
      lab.append(cb, document.createTextNode(" Include in netlist (off = commented out)"));
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = "Lines the schematic does not draw, such as .model · .param · .include";
      body.append(h, ta, lab, note);
      return;
    }
  }

  /*
   * 배선·넷 라벨·프로브 하나를 고르면 **그 자리의 넷**을 보여 준다.
   *
   * 넷 이름은 넷리스트의 노드 이름이자 파형 범례에 뜨는 이름이다. v(out) 이 어느 줄인지
   * 묻는 일이 잦으니, 고른 것이 무슨 넷이고 거기 무엇이 붙어 있는지 여기서 바로 읽히게 한다.
   */
  if (one && (one.kind === "wire" || one.kind === "label" || one.kind === "probe")) {
    const lbl = one.kind === "label" ? findById(sheet.labels, one.id) ?? null : null;
    const at =
      one.kind === "wire" ? findById(sheet.wires, one.id)?.pts[0] :
      one.kind === "probe" ? findById(sheet.probes, one.id)?.at : lbl?.at;
    const net = at ? ex.netAt(at) : null;
    if (at && net) {
      const h = document.createElement("div");
      h.className = "title";
      h.textContent = `Net · ${net}`;
      body.appendChild(h);

      if (lbl) {
        makeField(body, "Net label", "", lbl.name, v => {
          if (!/^[A-Za-z]\w*$/.test(v)) {
            alert("A name must start with a letter and use only letters, digits and underscores");
            renderProps();
            return;
          }
          edit(renameLabel(lbl.id, v));
          renderProps();
        });
      } else {
        const b = document.createElement("button");
        b.className = "btn";
        b.style.marginBottom = "8px";
        b.textContent = "Name this net…";
        b.onclick = () => { nameNetAt(at); renderProps(); };
        body.appendChild(b);
      }

      // 이 넷에 걸린 핀들. 핀 이름을 그대로 쓴다 — 회로도에 적히는 것과 같은 이름이다
      const pins: string[] = [];
      for (const p of sheet.parts) {
        const pl = project.library[p.lib];
        if (!pl) continue;
        for (const pin of pl.symbol.pins) {
          if (ex.pinNet.get(p.id + ":" + pin.id) === net) pins.push(`${p.ref}.${pin.name}`);
        }
      }
      pins.sort();
      const d = document.createElement("div");
      d.className = "note";
      d.innerHTML = pins.length
        ? `<b>${pins.length} pins on this net</b><br>${pins.join(" · ")}`
        : "No pin is on this net yet";
      body.appendChild(d);

      const hint = document.createElement("div");
      hint.className = "note";
      hint.textContent = net === "0"
        ? "Node 0 is ground. SPICE always calls it 0."
        : "This is the node name in the netlist and in the waveform legend.";
      body.appendChild(hint);
      return;
    }
  }

  // 여러 개를 골랐으면 종류별 개수만 보여 준다. 같이 고치는 기능은 아직 없다
  if (!selected) {
    const counts: Record<string, number> = {};
    for (const r of selRefs()) {
      const k = { part: "Parts", wire: "Wires", label: "Labels", probe: "Probes", spice: "Directives", note: "Notes" }[r.kind];
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const d = document.createElement("div");
    d.innerHTML = `<b>${selection.size} selected</b><br><span style="color:var(--mut)">` +
      Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ") + "</span>";
    body.appendChild(d);

    // 고른 부품이 모두 같은 종류면 값을 한꺼번에 고칠 수 있다 (E16)
    const parts = selParts();
    const libs = new Set(parts.map(p => p.lib));
    if (parts.length > 1 && libs.size === 1) {
      const lib = project.library[parts[0].lib];
      const head = document.createElement("h2");
      head.textContent = `Edit all ${parts.length} ${lib.name}`;
      body.appendChild(head);

      for (const prm of lib.params) {
        const values = new Set(parts.map(p => p.params[prm.key] ?? ""));
        const common = values.size === 1 ? [...values][0] : "";
        makeField(body, prm.label, prm.unit, common, v => {
          if (!v) return;
          edit(batch("Change value", parts.map(p => setParam(p.id, prm.key, v))));
        }, values.size > 1 ? "(multiple)" : undefined);
      }
    }

    if (parts.length) addTextSlotPicker(body, parts);

    const hint = document.createElement("div");
    hint.className = "empty";
    hint.style.marginTop = "10px";
    hint.textContent = "Space rotate · X/Y flip · Del delete · Ctrl+C/V copy";
    body.appendChild(hint);
    return;
  }

  const lib = project.library[selected.lib];
  const title = document.createElement("div");
  title.style.cssText = "font-weight:600;margin-bottom:8px";
  title.textContent = `${selected.ref} · ${lib.name}`;
  body.appendChild(title);

  const field = (label: string, unit: string, value: string, on: (v: string) => void) => {
    const l = document.createElement("label");
    l.className = "f";
    const row = document.createElement("span");
    row.className = "row";
    const a = document.createElement("span"); a.textContent = label;
    const b = document.createElement("span"); b.textContent = unit;
    row.append(a, b);
    const i = document.createElement("input");
    i.value = value;
    i.onchange = () => on(i.value.trim());
    l.append(row, i);
    body.appendChild(l);
  };

  field("Designator", "", selected.ref, v => { if (v && v !== selected!.ref) edit(setRef(selected!.id, v)); });
  for (const prm of lib.params) {
    field(prm.label, prm.unit, selected.params[prm.key] ?? "", v => {
      if (v !== (selected!.params[prm.key] ?? "")) edit(setParam(selected!.id, prm.key, v));
    });
  }

  addTextSlotPicker(body, [selected]);

  if (lib.spice) {
    const pre = document.createElement("pre");
    pre.style.cssText = "margin-top:10px;font-size:11px;color:var(--mut);white-space:pre-wrap";
    const line = lib.spice.template.replace(/\{(\w+)\}/g, (_, k: string) => {
      if (k === "ref") return selected!.ref;
      const pin = lib.symbol.pins.find(p => p.id === k);
      if (pin) return ex.pinNet.get(selected!.id + ":" + pin.id) ?? "?";
      return selected!.params[k] ?? "?";
    });
    pre.textContent = line;
    body.appendChild(pre);
  }
}

function renderSim() {
  const body = $("simbody");
  body.innerHTML = "";
  shownSim = JSON.stringify(project.sim);
  shownMeas = JSON.stringify(project.meas ?? []);

  // 해석 종류 고르기. 바꾸면 그 종류의 기본값으로 갈아끼운다
  const pick = document.createElement("select");
  pick.style.marginBottom = "6px";
  for (const k of ["tran", "op", "dc", "ac", "noise", "tf"] as const) {
    const o = document.createElement("option");
    o.value = k; o.textContent = SIM_KIND_LABEL[k];
    o.selected = project.sim.kind === k;
    pick.appendChild(o);
  }
  pick.onchange = () => {
    const next = defaultSim(pick.value as SimSettings["kind"]);
    // 쓸어 올릴 전원은 회로에 실제로 있는 이름으로 채운다. 기본값 V1 이 없는 회로면
    // 엔진이 "존재하지 않는 소자" 로 죽는데, 고른 직후에는 이유를 알기 어렵다
    if (next.kind === "dc") {
      const v = orderedParts(sheet, project.library)
        .find(p => project.library[p.lib].spice!.element === "V");
      if (v) next.source = spiceName(v.ref, "V");
    }
    // 잡음 · 전달 함수는 입력 전원과 출력 넷을 적는다. 같은 이유로 회로에 있는 이름으로 채운다 —
    // 입력은 신호원(직류 전원이 아닌 것)을, 출력은 out 을 먼저 고른다 (계산기 본보기와 같은 순서)
    if (next.kind === "noise" || next.kind === "tf") {
      const v = signalSource();
      if (v) next.src = v;
      next.out = exampleNet();
    }
    // 커서 · 확대 범위 · 지난 결과를 버리는 일은 커밋이 한다 (syncProjectViews) — 실행 취소로 종류가
    // 돌아가도 같은 일이 일어나야 해서다
    changeSim(next);
    renderSim(); renderTab();
  };
  body.appendChild(pick);

  const sim = project.sim;
  const field = (label: string, key: string, hint?: string, after?: () => void) => {
    const l = document.createElement("label");
    l.className = "f";
    const row = document.createElement("span");
    row.className = "row";
    const a = document.createElement("span"); a.textContent = label;
    row.append(a);
    if (hint) { const b = document.createElement("span"); b.textContent = hint; row.append(b); }
    const i = document.createElement("input");
    i.value = String((sim as Record<string, unknown>)[key] ?? "");
    i.onchange = () => {
      // 전원 이름을 고쳤을 수 있다. 없는 이름이면 문제 목록에 바로 뜬다 (커밋이 다시 검사한다)
      changeSim({ ...project.sim, [key]: i.value.trim() } as SimSettings);
      after?.();
    };
    l.append(row, i);
    body.appendChild(l);
  };
  const sweepField = () => {
    const s2 = sim as { sweep?: string };
    const l = document.createElement("label");
    l.className = "f";
    const row = document.createElement("span"); row.className = "row";
    const a = document.createElement("span"); a.textContent = "Sweep";
    row.append(a);
    const sel = document.createElement("select");
    sel.style.width = "100%";
    for (const [v, t] of [["dec", "Decade"], ["oct", "Octave"], ["lin", "Linear"]] as const) {
      const o = document.createElement("option");
      o.value = v; o.textContent = t; o.selected = s2.sweep === v;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      changeSim({ ...project.sim, sweep: sel.value } as SimSettings);
    };
    l.append(row, sel);
    body.appendChild(l);
    field("Points", "points", "/span"); field("Start freq", "fstart", "Hz"); field("Stop freq", "fstop", "Hz");
  };
  const note = (text: string) => {
    const d = document.createElement("div");
    d.className = "note";
    d.textContent = text;
    body.appendChild(d);
  };

  if (sim.kind === "tran") {
    field("Stop time", "tstop"); field("Max step", "tmax"); field("Start saving", "tstart");
  } else if (sim.kind === "dc") {
    // 쓸어 올리는 것이 전압원이면 V, 전류원이면 A, temp 면 °C 다. 전원을 바꾸면 단위 글자도 따라 바뀌게 다시 그린다
    const src = sim.source.trim();
    const unit = /^temp$/i.test(src) ? "°C" : /^i/i.test(src) ? "A" : "V";
    field("Source to sweep", "source", "V1 · temp", renderSim);
    field("From", "start", unit); field("To", "stop", unit); field("Step", "step", unit);
  } else if (sim.kind === "ac") {
    sweepField();
  } else if (sim.kind === "noise") {
    field("Output", "out", "net · v(a,b)");
    field("Input source", "src", "V1");
    sweepField();
    note("Gives the output noise density and the same referred to the input source, in V/√Hz. " +
      "Integrate them in the Calculator tab — rmsnoise(onoise, 1, 1g).");
  } else if (sim.kind === "tf") {
    field("Output", "out", "net · v(a,b) · i(V1)");
    field("Input source", "src", "V1");
    note("Gives the small-signal DC gain from the source to the output, the resistance the source sees, " +
      "and the resistance looking into the output.");
  } else {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "The operating point has nothing to set";
    body.appendChild(d);
  }

  renderMeasEditor(body);
}

/**
 * 본보기에 쓸 출력 넷. **이 회로에 있는 넷 이름**으로 채운다 — v(out) 으로 고정해 두면
 * out 이 없는 회로에서는 첫 측정이 반드시 실패하고, 왜 실패했는지도 안 보인다.
 * (해석 종류를 고를 때 쓸어 올릴 전원을 실제 이름으로 채우는 것과 같은 이유다)
 *
 * 고르는 순서: out -> 프로브 -> 이름 붙은 첫 넷. 재고 싶은 것은 거의 언제나 출력이다. 이름 붙은
 * 첫 넷을 그냥 쓰면 RC 저역통과에서 v(in) 이 뽑힌다 — 신호원을 재는 본보기는 아무것도 안 알려 준다.
 */
function exampleNet(): string {
  const named = [...ex.nets.keys()].filter(n => n !== "0" && !/^[0-9]+$/.test(n));
  const probed = sheet.probes.map(p => ex.netAt(p.at)).filter((n): n is string => !!n && n !== "0");
  return named.find(n => /^v?out$/i.test(n)) ?? probed[0] ?? named[0] ?? "out";
}

/** 회로도의 전압원들: SPICE 이름, + 단자의 넷, 직류 전원인가, AC 크기가 0 이 아닌가 */
function voltageSources(): Array<{ name: string; net: string; dc: boolean; ac: boolean }> {
  return orderedParts(sheet, project.library)
    .filter(p => project.library[p.lib].spice!.element === "V")
    .map(p => ({
      name: spiceName(p.ref, "V"),
      net: (ex.pinNet.get(p.id + ":p") ?? "").toLowerCase(),
      dc: project.library[p.lib].id === "vdc",
      ac: (parseEng(p.params.ac ?? "1") ?? 1) !== 0,
    }));
}

/**
 * 입력 신호원으로 볼 전압원. 파형이 있는 전원(사인 · 펄스)이 먼저고, 전부 직류 전원이면 AC 크기가
 * 0 이 아닌 것이다 — 바이어스와 전원에 AC 0 을 적어 둔 회로에서는 그것이 입력이다 (5T OTA 데모).
 * 계산기의 본보기도 같은 순서로 고른다 (src/calc/metrics.ts hints).
 */
function signalSource(): string | undefined {
  const vs = voltageSources();
  const withAc = vs.filter(v => v.ac);
  return (vs.find(v => !v.dc) ?? (withAc.length && withAc.length < vs.length ? withAc[0] : undefined) ?? vs[0])?.name;
}

/**
 * 자동 측정 (.meas) 편집기.
 *
 * 해석 설정 바로 아래에 둔다 — 무엇을 어떻게 돌릴지와 무엇을 잴지는 한 묶음이다.
 * 줄은 **원문 그대로** 들고 다닌다. 틀을 씌우면 ngspice 가 받는 문법의 대부분이 막힌다.
 * 앞의 `.meas` 는 넷리스트로 나갈 때 우리가 붙이므로 안 적어도 된다.
 */
function renderMeasEditor(host: HTMLElement) {
  const list = project.meas ?? [];
  const kind = project.sim.kind;

  const head = document.createElement("h2");
  head.textContent = "Measurements";
  host.appendChild(head);

  // 줄을 고치는 것만으로 패널을 다시 그리면 입력 칸이 사라져 초점을 잃는다.
  // 개수가 바뀔 때만 다시 그린다 (해석 설정 칸들도 같은 방식이다). 바꾸는 것은 명령이라 실행 취소된다
  const change = (next: string[], rebuild: boolean) => {
    shownMeas = JSON.stringify(next);
    edit(setMeas(project, next));
    if (rebuild) renderSim();
  };
  const now = () => [...(project.meas ?? [])];

  list.forEach((line, i) => {
    const row = document.createElement("div");
    row.className = "measrow";
    const inp = document.createElement("input");
    inp.value = line;
    inp.spellcheck = false;
    inp.placeholder = "tran vpeak MAX v(out)";
    // 패널이 좁아 긴 줄은 잘린다. 그대로 띄워 줘야 무엇을 적어 뒀는지 보인다
    inp.title = line || "<analysis> <name> <what to measure>";
    inp.onchange = () => {
      const v = inp.value.trim();
      const next = now();
      if (!v) { next.splice(i, 1); change(next, true); return; }   // 비우면 지운 것으로 본다
      next[i] = v;
      change(next, false);
    };
    const del = document.createElement("button");
    del.className = "btn";
    del.textContent = "×";
    del.title = "Remove this measurement";
    del.onclick = () => { const next = now(); next.splice(i, 1); change(next, true); };
    row.append(inp, del);
    host.appendChild(row);
  });

  const add = document.createElement("button");
  add.className = "btn";
  add.textContent = "Add measurement";
  add.onclick = () => {
    const net = exampleNet();
    const a = kind === "ac" ? "ac" : kind === "dc" ? "dc" : "tran";
    change([...now(), a + " vpeak MAX v(" + net + ")"], true);
  };
  host.appendChild(add);

  const note = document.createElement("div");
  note.className = "note";
  if (kind === "op" || kind === "tf") {
    // .meas 는 쓸어 올린 결과에서 값을 고른다. 동작점 · 전달 함수는 점 하나라 고를 것이 없다
    note.textContent = (kind === "op" ? "The operating point" : "A transfer function") +
      " has no sweep to measure. These lines run with a transient, DC or AC analysis.";
  } else if (kind === "noise") {
    // ngspice 의 .meas 는 tran · ac · dc · sp 만 읽는다. 잡음은 계산기가 적분한다
    note.textContent = "ngspice's .meas does not read noise results. Use the Calculator tab — rmsnoise(onoise, f1, f2).";
  } else {
    const other = list.filter(l => {
      const w = l.trim().replace(/^\.meas(ure)?\s+/i, "").split(/\s+/)[0]?.toLowerCase();
      return w && /^(tran|ac|dc|sp|tf|noise)$/.test(w) && w !== kind;
    }).length;
    note.textContent = other
      ? other + " of these name another analysis than " + SIM_KIND_LABEL[kind] + ", so ngspice will not measure them."
      : "ngspice measures these after the run. Results appear in the Measure tab.";
  }
  host.appendChild(note);
}

/** 지금 도구에서 쓸 수 있는 키 (설계서 12-8). 처음 쓰는 사람이 안내 없이 쓰게 하려는 것 */
const TOOL_HINTS: Record<Tool, string> = {
  select: "Drag to move · Space rotate · X/Y flip · H highlight net · Del delete · double-click for value",
  place: "Click to place · Space rotate · X/Y flip · Shift+click to repeat · Esc cancels",
  wire: "Click to turn · Shift for a straight run · ends on a pin · Esc cancels",
  label: "Click a wire or a pin",
  gnd: "Click to place · Shift+click to repeat",
  power: "Click and it asks for a name",
  probe: "Click a net · click again to remove",
  junction: "Click a crossing · click again to remove",
  nc: "Click a pin end · click again to remove",
  spice: "Click to drop a SPICE directive block",
  text: "Click and it asks for the text",
  line: "Click twice to draw a line · Esc cancels",
  rect: "Click twice to draw a rectangle · Esc cancels",
};

function renderStatus() {
  const errs = externalNetlist ? 0 : issues.filter(i => i.level === "error").length;
  const warns = externalNetlist ? 0 : issues.length - errs;
  $("status").textContent = simProgress ||
    (externalNetlist ? "External .sp · " : "") +
    `parts ${sheet.parts.length} · wires ${sheet.wires.length} · nets ${ex.netCount}` +
    (errs ? ` · errors ${errs}` : "") + (warns ? ` · warnings ${warns}` : "") +
    (highlightNet ? ` · highlighting ${highlightNet}` : "");
  $<HTMLButtonElement>("t-run").disabled = running;
  // 돌고 있는 동안 캔버스 테두리가 숨을 쉰다
  stage.classList.toggle("running", running);
  const runLabel = $("t-run").querySelector("span");
  if (runLabel) runLabel.textContent = running ? "Running…" : "Run";
  // 오래 걸리는 일은 상태 줄이 좁은 화면에서 숨으므로 버튼에도 적는다
  $("t-run").title = simProgress || "Run simulation (F8)";
}

// ── 부품 라이브러리 창 (설계서 E01 · 3절: Shift+F) ────────────────────
/*
 * 부품이 서른 가지를 넘으면 왼쪽 목록을 눈으로 훑는 것이 느려진다. 라이브러리를 고르고, 이름이나
 * 낱말로 좁히고, 심볼과 SPICE 줄을 보고 고르는 창을 둔다 (src/ui/library.ts). 예전의 작은 찾기 창이
 * 하던 일(몇 글자 치고 Enter)은 그대로 된다 — 열면 찾기 칸에 초점이 있다.
 */
function openLib() {
  closeFind();
  closeCtx();
  closeMenu();
  openLibrary({
    place: id => setTool("place", id),
    closed: () => stage.focus(),
  });
}

// ── 오른쪽 버튼 메뉴 (설계서 1·2절) ───────────────────────────────────
/*
 * 오른쪽 버튼은 '길게 눌러 끌면 화면 이동', '그냥 클릭하면 메뉴' 다.
 * 끌었는지는 pointerup 에서 down.moved 로 안다 — 그래서 contextmenu 이벤트가 아니라
 * 우리 포인터 처리 쪽에서 연다.
 */
let ctx: HTMLElement | null = null;

function closeCtx() { ctx?.remove(); ctx = null; }

function openCtx(screen: Pt, at: Pt) {
  closeCtx();
  const m = document.createElement("div");
  m.id = "ctx";
  const hit = hitTest(at);
  const add = (label: string, run: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onmousedown = e => { e.preventDefault(); closeCtx(); run(); overlayDirty = true; };
    m.appendChild(b);
  };
  const sep = () => { if (m.childElementCount) m.appendChild(document.createElement("hr")); };

  /*
   * 어시스턴트에게 묻기. 누른 부품, 아니면 고른 부품들, 아니면 누른 자리의 넷에 대해 — 물음은 사람이 맺는다
   * (입력 칸에 "About R1 (Resistor 1k): " 까지 적어 두고 초점을 준다). 무엇을 물을지는 사람마다 다르다.
   */
  const subject = askSubject(hit, ex.netAt(snapPt(at)));
  if (subject) add(`Ask the assistant about ${subject.label}…`, () => prefillAssistant(subject.text));

  if (hit?.kind === "wire") {
    sep();
    const i = segmentAt(hit.id, at);
    if (i !== null) add("Select segment", () => { setSelection([refKey(hit)]); segSel = { wireId: hit.id, i }; renderProps(); });
    add("Select wire", () => { setSelection([refKey(hit)]); segSel = null; renderProps(); });
    add("Select net", () => { selectNet(at); });
  }
  const net = ex.netAt(snapPt(at));
  if (net) {
    sep();
    add(`Name net (${net})…`, () => nameNetAt(snapPt(at)));
    add(`Highlight net (${net})`, () => { highlightNet = net; staticDirty = true; renderStatus(); });
  }
  if (highlightNet) add("Clear highlight", () => { highlightNet = null; staticDirty = true; renderStatus(); });

  if (selParts().length >= 2) {
    sep();
    add("Align left", () => alignParts("left"));
    add("Align right", () => alignParts("right"));
    add("Align top", () => alignParts("top"));
    add("Align bottom", () => alignParts("bottom"));
    add("Center vertically", () => alignParts("cx"));
    add("Center horizontally", () => alignParts("cy"));
    if (selParts().length >= 3) {
      add("Distribute horizontally (Ctrl+Shift+H)", () => distributeParts("h"));
      add("Distribute vertically (Ctrl+Shift+E)", () => distributeParts("v"));
    }
  }
  if (selection.size) {
    sep();
    add("Zoom to selection", () => fit(selRefs()));
    add("Rotate", rotate);
    add("Delete", del);
  }
  sep();
  add("Zoom to fit", () => fit());
  add("Delete by kind…", openDeleteBox);
  add("Renumber designators", openReannotate);
  add("Export PNG", openPngExport);

  document.body.appendChild(m);
  ctx = m;
  // 화면 밖으로 나가지 않게 민다
  const r = stage.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(r.left + screen[0], innerWidth - w - 6) + "px";
  m.style.top = Math.min(r.top + screen[1], innerHeight - h - 6) + "px";
}

/** 누른 자리의 넷에 속한 배선을 모두 고른다 (설계서 2절 '넷 선택') */
function selectNet(at: Pt) {
  const net = ex.netAt(snapPt(at));
  if (!net) return;
  const keys: string[] = [];
  for (const w of sheet.wires) {
    if (w.pts.some(p => ex.netAt(p) === net)) keys.push(refKey({ kind: "wire", id: w.id }));
  }
  setSelection(keys);
  segSel = null;
  renderProps();
}

addEventListener("pointerdown", e => {
  // 메뉴·찾기 창 밖을 누르면 닫는다
  if (ctx && !ctx.contains(e.target as Node)) closeCtx();
  if (finderBox && !finderBox.contains(e.target as Node)) closeFind();
  if (delBox && !delBox.contains(e.target as Node)) closeDeleteBox();
}, true);

// ── 라이브러리에서 캔버스로 끌어다 놓기 (설계서 E01 · 3절) ─────────────
/*
 * 놓는 자리는 클릭 배치와 같은 규칙으로 격자에 붙인다. 캔버스 밖에서 떼면 아무 일도 없다.
 * 끌어 오는 중에 Space/X/Y 로 돌리는 것까지는 하지 않는다 — 끌기 중에는 키 초점이
 * 캔버스에 없어서, 놓은 뒤에 돌리는 쪽이 확실하다.
 */
stage.addEventListener("dragover", e => {
  if (!e.dataTransfer?.types.includes("text/melange-lib")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  stage.classList.add("dropping");
});
stage.addEventListener("dragleave", e => {
  if (e.target === stage) stage.classList.remove("dropping");
});
stage.addEventListener("drop", e => {
  stage.classList.remove("dropping");
  const id = e.dataTransfer?.getData("text/melange-lib");
  if (!id || !BUILTIN[id]) return;
  e.preventDefault();
  const at = snapPt(toWorld(vp, local(e)));
  const part = newPart(id, at);
  edit(addPart(part), [refKey({ kind: "part", id: part.id })]);
  setTool("select");
  setSelection([refKey({ kind: "part", id: part.id })]);
  renderProps();
  overlayDirty = true;
});

// ── 주석 글자·선·사각형 (설계서 E32) ─────────────────────────────────
/*
 * 선·사각형은 배선처럼 두 번 눌러 그린다 — 첫 클릭이 한 쪽, 둘째 클릭이 반대쪽이다.
 * 끌어서 그리지 않는 이유는 배선과 손놀림을 같게 두려는 것이다.
 */
let noteDraft: { kind: "line" | "rect"; from: Pt } | null = null;

function startNote(kind: "text" | "line" | "rect", at: Pt) {
  if (kind === "text") {
    const text = prompt("Note text", "Note");
    if (!text) return;
    const note: Note = { id: uid(), kind: "text", pts: [at], text };
    edit(addObjects([], [], [], [], [], [note]), [refKey({ kind: "note", id: note.id })]);
    setTool("select");
    setSelection([refKey({ kind: "note", id: note.id })]);
    renderProps();
    return;
  }
  if (!noteDraft) { noteDraft = { kind, from: at }; return; }
  const note: Note = { id: uid(), kind: noteDraft.kind, pts: [noteDraft.from, at] };
  noteDraft = null;
  // 길이가 0 이면 그리지 않는다 — 두 번 같은 자리를 누른 것은 취소로 본다
  if (note.pts[0][0] === note.pts[1][0] && note.pts[0][1] === note.pts[1][1]) { setTool("select"); return; }
  edit(addObjects([], [], [], [], [], [note]), [refKey({ kind: "note", id: note.id })]);
  setTool("select");
  setSelection([refKey({ kind: "note", id: note.id })]);
  renderProps();
}

// ── 정렬·분배 (설계서 E30 · 5절) ─────────────────────────────────────
/*
 * 정렬 대상은 **부품만**이다 (배선·핀은 아니다). 옮긴 뒤에도 핀이 격자 위에 있고
 * 연결이 끊기지 않아야 한다 — 그래서 붙은 배선을 끌기와 같은 방식으로 따라오게 한다.
 * 기준은 부품 원점이다. 심볼마다 크기가 달라 테두리로 맞추면 원점이 격자를 벗어난다.
 */
function moveParts(moves: Array<{ part: Part; to: Pt }>, label: string) {
  // 붙은 배선이 끌기와 같은 길로 따라온다 (doc/ops.ts). 정렬은 부품만 옮기니 선택에 든 배선도 늘여서 따라온다
  const cmd = moveCommand(sheet, project.library, index, moves, label);
  if (cmd) edit(cmd);
}

function alignParts(kind: AlignKind) {
  const ps = selParts();
  if (ps.length < 2) { alert("Pick at least two parts"); return; }
  const to = alignTargets(ps.map(p => p.at), kind);
  moveParts(ps.map((part, i) => ({ part, to: to[i] })), "Align");
}

/** 가로·세로 같은 간격으로 (설계서 5절: 부품 3개 이상) */
function distributeParts(axis: "h" | "v") {
  const ps = selParts();
  if (ps.length < 3) { alert("Pick at least three parts"); return; }
  const to = distributeTargets(ps.map(p => p.at), axis);
  moveParts(ps.map((part, i) => ({ part, to: to[i] })), "Distribute");
}

// ── 지정자 재부여 (설계서 E31) ───────────────────────────────────────
/*
 * 접두어마다 따로 센다 (R1 R2 … C1 C2 …). 범위·순서·시작 번호를 고른다.
 * 순서는 읽는 순서를 기본으로 둔다 — 위에서 아래로, 같은 줄은 왼쪽에서 오른쪽으로.
 */
function reannotate(scope: "all" | "sel", order: AnnotateOrder, start: number) {
  const target = scope === "sel" ? selParts() : sheet.parts;
  const parts = target.filter(p => project.library[p.lib]?.spice);
  if (!parts.length) { alert("No parts to give designators to"); return; }

  const cmds: Command[] = [];
  for (const { part, ref } of annotate(
    parts.map(p => ({ part: p, at: p.at, prefix: project.library[p.lib].refPrefix })), order, start,
  )) {
    if (ref !== part.part.ref) cmds.push(setRef(part.part.id, ref));
  }
  if (!cmds.length) { alert("No designator would change"); return; }
  edit(batch("Renumber designators", cmds));
  renderProps();
}

function openReannotate() {
  const order = confirm(
    "Renumber designators.\n\n[OK] top to bottom (left first within a row)\n[Cancel] left to right (top first within a column)",
  ) ? "rowFirst" : "colFirst";
  const n = prompt("Start number", "1");
  if (n === null) return;
  const start = Math.max(1, Math.floor(Number(n) || 1));
  const scope = selParts().length >= 2 && confirm("Apply to the selected parts only?\n\n[OK] selection only\n[Cancel] the whole sheet")
    ? "sel" : "all";
  reannotate(scope, order, start);
}

// ── 찾기·바꾸기 (설계서 E29) ─────────────────────────────────────────
/*
 * 지정자·값·넷 이름을 한 번에 찾는다. 결과를 누르면 그 자리로 화면이 가고 선택된다.
 * 바꾸기는 찾은 글자만 갈아 끼운다 — 칸 전체를 덮어쓰면 "1k 를 2k 로" 같은 일을
 * 하려다 다른 값까지 날린다.
 */
interface Hit { ref: Ref; where: string; text: string; at: Pt; apply(to: string): Command | null }

function findAll(q: string): Hit[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const out: Hit[] = [];
  // 찾은 글자를 정규식 특수문자까지 그대로 다룬다 ( "R1(a)" 같은 이름도 찾을 수 있게 )
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, c => "\\" + c);
  const swap = (s: string, to: string) => s.replace(new RegExp(esc(needle), "gi"), () => to);

  for (const p of sheet.parts) {
    if (p.ref.toLowerCase().includes(needle)) {
      out.push({
        ref: { kind: "part", id: p.id }, where: "Designator", text: p.ref, at: p.at,
        apply: to => setRef(p.id, swap(p.ref, to)),
      });
    }
    for (const [k, v] of Object.entries(p.params)) {
      if (String(v).toLowerCase().includes(needle)) {
        out.push({
          ref: { kind: "part", id: p.id }, where: `${p.ref} · ${k}`, text: v, at: p.at,
          apply: to => setParam(p.id, k, swap(v, to)),
        });
      }
    }
  }
  for (const l of sheet.labels) {
    if (l.name.toLowerCase().includes(needle)) {
      out.push({
        ref: { kind: "label", id: l.id }, where: l.kind === "power" ? "Supply" : "Net label", text: l.name, at: l.at,
        apply: to => renameLabel(l.id, swap(l.name, to)),
      });
    }
  }
  return out;
}

/** 화면 가운데로 가져온다. 배율은 그대로 둔다 — 찾을 때마다 확대가 튀면 어지럽다 */
function centerOn(at: Pt) {
  vp = { scale: vp.scale, at: [at[0] - W / vp.scale / 2, at[1] - H / vp.scale / 2] };
  staticDirty = overlayDirty = true;
}

let finderBox: HTMLElement | null = null;

function openFind() {
  closeLibrary();
  if (finderBox) { finderBox.querySelector("input")!.focus(); return; }
  const box = document.createElement("div");
  box.id = "finder";
  const q = document.createElement("input");
  q.placeholder = "Find designator · value · net name";
  const rep = document.createElement("input");
  rep.placeholder = "Replacement (empty = find only)";
  const list = document.createElement("div");
  list.className = "flist";
  const bar = document.createElement("div");
  bar.className = "frow";
  const btn = document.createElement("button");
  btn.textContent = "Replace all";
  bar.append(btn);
  box.append(q, rep, list, bar);
  document.body.appendChild(box);
  finderBox = box;

  let hits: Hit[] = [];
  const draw = () => {
    hits = findAll(q.value);
    list.innerHTML = "";
    if (!q.value.trim()) return;
    if (!hits.length) {
      const d = document.createElement("div");
      d.className = "fitem";
      d.textContent = "Nothing found";
      list.appendChild(d);
      return;
    }
    for (const h of hits.slice(0, 40)) {
      const b = document.createElement("button");
      b.className = "fitem";
      b.innerHTML = `<span>${h.text}</span><span class="mut">${h.where}</span>`;
      b.onmousedown = e => {
        e.preventDefault();
        setSelection([refKey(h.ref)]);
        centerOn(h.at);
        renderProps();
        overlayDirty = true;
      };
      list.appendChild(b);
    }
  };
  q.oninput = draw;
  q.onkeydown = e => { if (e.key === "Escape") { closeFind(); e.preventDefault(); } e.stopPropagation(); };
  rep.onkeydown = e => { if (e.key === "Escape") { closeFind(); e.preventDefault(); } e.stopPropagation(); };
  btn.onclick = () => {
    const to = rep.value;
    if (!hits.length || !to) return;
    const cmds = hits.map(h => h.apply(to)).filter((c): c is Command => !!c);
    if (cmds.length) edit(batch("Replace", cmds));
    draw();
    renderProps();
  };
  draw();
  q.focus();
}

function closeFind() { finderBox?.remove(); finderBox = null; stage.focus(); }

// ── PNG 내보내기 (설계서 E35) ────────────────────────────────────────
/*
 * 화면에 그리는 것과 **같은 함수**로 그린다. 따로 그리면 둘이 어긋나서,
 * 내보낸 그림에만 없는 요소가 생긴다.
 */
type Box = [number, number, number, number];

/**
 * 그린 것을 감싸는 월드 상자. parts 를 주면 그 부품들만. 아무것도 없으면 null.
 *
 * 부품 상자(partBounds)는 핀으로만 잰다 — 지정자 · 값 글자와 핀 밖으로 나온 몸통(접지의 막대)은 그 밖에
 * 있다. 글자 자리를 더하고 둘레에 여유를 둔다. 예전에는 PNG 의 맨 위 지정자가 반쯤 잘렸다.
 */
function drawingBox(parts?: readonly Part[]): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Pt) => {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  };
  for (const p of parts ?? sheet.parts) {
    const lib = project.library[p.lib];
    if (!lib) continue;
    const [a, b] = R.partBounds(p, lib);
    add(a); add(b);
    if (lib.id === "gnd") continue;
    const slot = p.textAt ?? DEFAULT_TEXT_AT;
    // 글자는 자리를 가운데로 놓인다. 폭은 지정자 · 값 몇 글자만큼
    for (const o of [slot.ref, slot.value]) {
      add([p.at[0] + o[0] - 12, p.at[1] + o[1] - 6]);
      add([p.at[0] + o[0] + 12, p.at[1] + o[1] + 6]);
    }
  }
  if (!parts) {
    for (const wi of sheet.wires) wi.pts.forEach(add);
    for (const l of sheet.labels) add(l.at);
    for (const n of sheet.notes) n.pts.forEach(add);
    for (const b of sheet.spice) add(b.at);
  }
  const m = GRID;
  return isFinite(x0) ? [x0 - m, y0 - m, x1 + m, y1 + m] : null;
}

/**
 * 시트를 Canvas 2D 로 그린다 — PNG 내보내기와 어시스턴트가 보는 그림이 이 길 하나다.
 * box 는 그릴 월드 영역, scale 은 월드 한 칸의 px, pad 는 둘레의 여백(px).
 *
 * 도형은 화면과 **같은 도형 목록**(src/render/scene.ts)에서 그린다. 화면은 GPU 가, 여기서는
 * Canvas 2D 가 그릴 뿐 무엇을 그리는지는 한 곳에서 정해진다. 글자도 화면의 글자 층과 같은
 * 함수다. 순서도 화면과 같다: 배선 -> 부품 -> 접합점 -> 글자.
 */
function renderSheet(
  box: Readonly<Box>, scale: number,
  opt: { pad?: number; transparent?: boolean; pinNames?: boolean; netNames?: boolean; probes?: boolean } = {},
): HTMLCanvasElement {
  const pad = opt.pad ?? 0;
  // 화면 그대로 내보낼 때 1234 / 배율 × 배율 이 1234.0000001 이 되어 한 줄 더 생기지 않게
  const w = Math.max(1, Math.ceil((box[2] - box[0]) * scale - 1e-6) + pad * 2);
  const h = Math.max(1, Math.ceil((box[3] - box[1]) * scale - 1e-6) + pad * 2);
  const view: Viewport = { scale, at: [box[0] - pad / scale, box[1] - pad / scale] };
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const g = cv.getContext("2d")!;
  if (!opt.transparent) {
    // 화면 바탕은 유리 뒤가 비치는 투명이라 그대로 쓰면 빈 그림이 된다.
    // 내보낼 때는 불투명한 판 색을 깐다
    g.fillStyle = R.css("--png-bg") || "#12151b";
    g.fillRect(0, 0, w, h);
  }
  const t = R.theme();
  const all = new Scene();
  all.apply(new SheetIndex().sync(sheet, project.library), project.library);
  all.flush();
  all.setJunctions([...ex.junctions, ...sheet.junctions]);
  drawScene2D(g, view, all, { colors: styleColors(t) });
  for (const p of sheet.parts) {
    const lib = project.library[p.lib];
    if (lib) R.drawPartText(g, view, p, lib, t, false, !!opt.pinNames);
  }
  R.drawLabels(g, view, sheet.labels, t);
  // 넷 이름은 라벨 뒤에 (화면의 글자 층과 같은 차례)
  if (opt.netNames) R.drawNetNames(g, view, R.netNameSpots(ex.nets), t);
  R.drawSpiceBlocks(g, view, sheet.spice, t);
  R.drawNotes(g, view, sheet.notes, t);
  if (opt.probes) R.drawProbes(g, view, sheet.probes, p => ex.netAt(p), () => false, t);
  return cv;
}

/** 어시스턴트가 보는 그림의 긴 변 (px). 모델들이 이보다 크면 줄여서 읽는다 */
const PICTURE_SIDE = 1568;

/**
 * 어시스턴트가 보는 회로도 — PNG 와 같은 그림에 넷 이름 · 핀 이름 · 프로브를 더한다. 글이 넷리스트의
 * 이름으로 말하므로 그림에도 그 이름이 있어야 둘을 맞춰 본다. parts 를 주면 그 둘레만 크게.
 */
function schematicPicture(partIds?: readonly string[]): Picture | null {
  const chosen = partIds?.map(id => findById(sheet.parts, id)).filter((p): p is Part => !!p);
  let box = drawingBox(chosen?.length ? chosen : undefined);
  if (!box) return null;
  if (chosen?.length) {
    // 이어진 배선 · 라벨 · 옆 부품이 보이게 둘레를 넉넉히
    const m = 6 * GRID;
    box = [box[0] - m, box[1] - m, box[2] + m, box[3] + m];
  }
  const pad = 24;
  const span = Math.max(box[2] - box[0], box[3] - box[1], 1);
  // PNG 내보내기와 같은 3배가 위 끝이다. 그보다 키워도 글자는 13px 에서 멈춘다 (drawPartText)
  const scale = Math.min(3, (PICTURE_SIDE - pad * 2) / span);
  const cv = renderSheet(box, scale, { pad, pinNames: true, netNames: true, probes: true });
  return {
    url: cv.toDataURL("image/png"), width: cv.width, height: cv.height,
    ...(scale < 1.2 ? { note: scale <= 0.9
      ? "The drawing is too large to read in one picture: designators and values are left out. Pass parts to look at a region."
      : "The drawing is large and the text is small. Pass parts to look at a region." } : {}),
  };
}

function exportPng(whole: boolean, transparent: boolean) {
  let cv: HTMLCanvasElement;
  if (whole) {
    const box = drawingBox();
    if (!box) { alert("There is nothing drawn"); return; }
    cv = renderSheet(box, 3, { pad: 20, transparent });
  } else {
    cv = renderSheet([vp.at[0], vp.at[1], vp.at[0] + Math.round(W) / vp.scale, vp.at[1] + Math.round(H) / vp.scale], vp.scale, { transparent });
  }

  cv.toBlob(blob => {
    if (!blob) { alert("Could not make the image"); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (project.name || "circuit") + ".png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
}

function openPngExport() {
  const whole = confirm("Export as PNG.\n\n[OK] everything drawn (3× size)\n[Cancel] the visible area");
  const transparent = confirm("Transparent background?\n\n[OK] transparent\n[Cancel] fill the background");
  exportPng(whole, transparent);
}

// ── 종류로 삭제 · 전체 삭제 (설계서 E11 · 8절) ───────────────────────
/*
 * 배선만 전부 지우고 다시 긋는 식의 일이 흔한데, 하나씩 고르면 오래 걸린다.
 * 지우기 전에 종류마다 몇 개인지 보여 주고, 한 번에 한 단계로 지운다.
 */
const KIND_LABEL: Array<{ kind: ObjKind; name: string; count: () => number }> = [
  { kind: "part", name: "Parts", count: () => sheet.parts.length },
  { kind: "wire", name: "Wires", count: () => sheet.wires.length },
  { kind: "label", name: "Net labels & supplies", count: () => sheet.labels.length },
  { kind: "probe", name: "Probes", count: () => sheet.probes.length },
  { kind: "note", name: "Notes", count: () => sheet.notes.length },
  { kind: "spice", name: "Directive blocks", count: () => sheet.spice.length },
];

function allRefs(kinds: ObjKind[]): Ref[] {
  const out: Ref[] = [];
  for (const k of kinds) {
    const arr = k === "part" ? sheet.parts
      : k === "wire" ? sheet.wires
      : k === "label" ? sheet.labels
      : k === "probe" ? sheet.probes
      : k === "note" ? sheet.notes
      : sheet.spice;
    for (const o of arr) out.push({ kind: k, id: o.id });
  }
  return out;
}

function deleteKinds(kinds: ObjKind[]) {
  const refs = allRefs(kinds);
  if (!refs.length) return;
  // 수동 접합점은 객체가 아니라 좌표다. 배선을 다 지우면 같이 치운다
  const cmds: Command[] = [removeObjects(refs)];
  if (kinds.includes("wire")) {
    for (const j of [...sheet.junctions]) cmds.push(removeJunction(j));
  }
  edit(batch("Delete by kind", cmds), []);
  renderProps();
}

let delBox: HTMLElement | null = null;
function closeDeleteBox() { delBox?.remove(); delBox = null; }

function openDeleteBox() {
  closeDeleteBox();
  const box = document.createElement("div");
  box.id = "finder";
  const h = document.createElement("div");
  h.className = "title";
  h.textContent = "Delete by kind";
  const list = document.createElement("div");
  list.className = "flist";
  const boxes: Array<{ kind: ObjKind; el: HTMLInputElement }> = [];
  for (const k of KIND_LABEL) {
    const n = k.count();
    const l = document.createElement("label");
    l.className = "chk";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.disabled = n === 0;
    l.append(cb, document.createTextNode(` ${k.name} ${n}`));
    list.appendChild(l);
    boxes.push({ kind: k.kind, el: cb });
  }
  const bar = document.createElement("div");
  bar.className = "frow";
  const all = document.createElement("button");
  all.textContent = "Delete all";
  const go = document.createElement("button");
  go.textContent = "Delete selected";
  bar.append(all, go);
  box.append(h, list, bar);
  document.body.appendChild(box);
  delBox = box;

  all.onclick = () => {
    if (!confirm("This clears everything on the sheet. Undo (Ctrl+Z) brings it back.")) return;
    closeDeleteBox();
    deleteKinds(KIND_LABEL.map(k => k.kind));
  };
  go.onclick = () => {
    const kinds = boxes.filter(b => b.el.checked).map(b => b.kind);
    closeDeleteBox();
    if (kinds.length) deleteKinds(kinds);
  };
}

// ── 라벨 이름 번호 올리기 (설계서 E06 · 6절) ─────────────────────────
/*
 * 라벨을 연달아 붙일 때 이름을 매번 다 치면 손이 많이 간다. 끝 숫자를 올려 주되,
 * 이미 쓰고 있는 이름은 건너뛴다 — 같은 이름은 같은 넷이라 모르고 이으면 회로가 바뀐다.
 */
let lastLabelName = "net1";

function bumpName(s: string): string {
  const m = /^(.*?)(\d+)$/.exec(s);
  return m ? m[1] + (Number(m[2]) + 1) : s + "1";
}

/**
 * 그 자리의 넷에 이름을 준다.
 *
 * 넷 이름은 넷 라벨에서 나온다 (연결 규칙 8). 그래서 '이름 주기' 는 그 자리에 라벨을
 * 놓는 일이고, 이미 라벨이 있으면 **이름만 바꾼다** — 안 그러면 같은 점에 라벨이
 * 겹겹이 쌓여 "한 넷에 라벨이 여럿" 경고만 는다.
 */
function nameNetAt(at: Pt) {
  const cur = ex.netAt(at);
  const name = prompt("Net name (starts with a letter; letters, digits, underscore)",
                      cur && /^[A-Za-z]\w*$/.test(cur) ? cur : nextLabelName());
  if (name === null) return;
  if (!/^[A-Za-z]\w*$/.test(name)) {
    alert("A name must start with a letter and use only letters, digits and underscores");
    return;
  }
  lastLabelName = name;
  const hit = sheet.labels.find(l => l.at[0] === at[0] && l.at[1] === at[1]);
  edit(hit ? renameLabel(hit.id, name) : addLabel({ id: uid(), name, at, kind: "label" }), []);
}

function nextLabelName(): string {
  const used = new Set(sheet.labels.map(l => l.name.toLowerCase()));
  let name = lastLabelName;
  for (let i = 0; i < 1000 && used.has(name.toLowerCase()); i++) name = bumpName(name);
  return name;
}

// ── 배선 위에 부품 끼우기 (설계서 연결 규칙 4) ───────────────────────
/*
 * 배선 위에 저항을 놓으면 EasyEDA Std 는 배선을 끊고 저항 양 끝에 다시 잇는다.
 * 안 끊으면 부품이 자기 양 끝을 **한 노드로 묶은** 채 얹혀 — 그리기에는 멀쩡해 보이는데
 * 넷리스트에서는 부품이 단락된다. 조용히 틀리는 쪽이라 놓을 때 바로 끊는다.
 *
 * 핀 한 개만 걸린 경우는 그대로 둔다. 그건 T 자로 닿은 것이라 이어야 맞다.
 */
function spliceCommandsFor(part: Part): Command[] {
  const lib = project.library[part.lib];
  if (!lib || lib.symbol.pins.length < 2) return [];
  const pins = lib.symbol.pins.map((_, i) => pinAt(part, lib, i));
  const cmds: Command[] = [];

  for (const w of sheet.wires) {
    if (w.pts.length < 2) continue;
    // 핀이 배선의 몇 번째 선분 위에, 그 선분의 어디쯤 있는지
    const hits: Array<{ seg: number; t: number; at: Pt }> = [];
    for (const p of pins) {
      for (let i = 0; i < w.pts.length - 1; i++) {
        if (!onSegment(p, w.pts[i], w.pts[i + 1])) continue;
        const a = w.pts[i], b = w.pts[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        hits.push({ seg: i, t: Math.hypot(p[0] - a[0], p[1] - a[1]) / len, at: p });
        break;
      }
    }
    if (hits.length < 2) continue;

    hits.sort((x, y) => x.seg - y.seg || x.t - y.t);
    const first = hits[0], last = hits[hits.length - 1];
    if (first.seg === last.seg && first.t === last.t) continue;   // 같은 점이면 끊을 것이 없다

    const same = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];
    const head: Pt[] = [...w.pts.slice(0, first.seg + 1), first.at];
    const tail: Pt[] = [last.at, ...w.pts.slice(last.seg + 1)];
    const clean = (pts: Pt[]) => pts.filter((p, i) => i === 0 || !same(p, pts[i - 1]));

    const made = [clean(head), clean(tail)]
      .filter(pts => pts.length >= 2)
      .map(pts => ({ id: uid(), pts }));

    cmds.push(removeObjects([{ kind: "wire", id: w.id }]));
    if (made.length) cmds.push(addObjects([], made, [], [], [], []));
  }
  return cmds;
}

// ── 패널 크기 조절 (설계서 대조표 17번) ──────────────────────────────
/*
 * 그리드 칸 크기를 CSS 변수로 두고 가름대를 끌어 바꾼다. 캔버스는 ResizeObserver 가
 * 이미 보고 있어서 따로 알릴 것이 없다. 크기는 자동 저장과 함께 저장소에 남는다 —
 * 매번 다시 맞추게 하면 안 쓰느니만 못하다.
 */
const LAYOUT_KEY = "melange.layout";

function applyLayout(v: Record<string, string>) {
  for (const [k, val] of Object.entries(v)) document.documentElement.style.setProperty(k, val);
}

function saveLayout() {
  const s = document.documentElement.style;
  const v: Record<string, string> = {};
  for (const k of ["--lib-w", "--props-w", "--ai-w", "--bottom-h"]) {
    const got = s.getPropertyValue(k);
    if (got) v[k] = got;
  }
  const c = document.documentElement.classList;
  const state = {
    vars: v,
    panels,
    theme: c.contains("dark") ? "dark" : c.contains("light") ? "light" : "",
    solid: c.contains("solid"),
    grid: showGrid,
    pinNames: showPinNames,
    netNames: showNetNames,
    libClosed: [...libClosed],
    mode: uiMode,
  };
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(state)); } catch { /* 저장 못 해도 쓴다 */ }
}

/** 지난번 화면 설정. 패널·테마까지 같이 되살린다 */
function restoreLayout() {
  let v: Record<string, unknown>;
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (!saved) return;
    v = JSON.parse(saved);
  } catch { return; }           // 깨진 값이면 기본값으로 간다

  applyLayout((v.vars ?? v) as Record<string, string>);
  const p = v.panels as typeof panels | undefined;
  if (p) { panels.lib = p.lib !== false; panels.props = p.props !== false; panels.bottom = p.bottom !== false; panels.ai = p.ai === true; }
  if (v.mode === "simple" || v.mode === "edit") uiMode = v.mode;
  if (v.theme === "dark" || v.theme === "light") document.documentElement.classList.add(v.theme);
  if (typeof v.solid === "boolean") glass = !v.solid;
  if (typeof v.grid === "boolean") showGrid = v.grid;
  if (typeof v.pinNames === "boolean") showPinNames = v.pinNames;
  if (typeof v.netNames === "boolean") showNetNames = v.netNames;
  if (Array.isArray(v.libClosed)) for (const k of v.libClosed) if (typeof k === "string") libClosed.add(k);
  // 여기는 setTheme 을 안 거치고 클래스만 붙인다. 버튼 아이콘은 따로 맞춰 줘야 한다
  syncTheme();
  applyLibGroups();
}

function dragSplit(el: HTMLElement, axis: "x" | "y", varName: string, min: number, max: number, invert: boolean) {
  el.addEventListener("pointerdown", e => {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* 캡처 없이도 된다 */ }
    el.classList.add("on");
    const start = axis === "x" ? e.clientX : e.clientY;
    const base = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(varName))
      || (axis === "x" ? 150 : 278);
    const move = (ev: PointerEvent) => {
      const d = (axis === "x" ? ev.clientX : ev.clientY) - start;
      const next = Math.max(min, Math.min(max, base + (invert ? -d : d)));
      document.documentElement.style.setProperty(varName, next + "px");
    };
    const up = () => {
      el.classList.remove("on");
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      saveLayout();
      resize();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  });
}

dragSplit($("split-lib"), "x", "--lib-w", 110, 400, false);
dragSplit($("split-props"), "x", "--props-w", 170, 520, true);
dragSplit($("split-ai"), "x", "--ai-w", 260, 720, true);
dragSplit($("split-bottom"), "y", "--bottom-h", 120, 600, true);

// ── 좁은 화면과 손가락 입력 ───────────────────────────────────────────
/*
 * 좁은 화면에서는 옆 패널이 서랍이 된다 (CSS 의 max-width: 900px). 여는 버튼은
 * 툴바에 있고 넓은 화면에서는 숨는다. 캔버스를 누르면 닫는다 — 서랍이 덮고 있는
 * 상태에서 회로도를 만지려다 서랍만 다시 눌리는 일이 없게.
 */
stampIcons();

const drawer = (btnId: string, panelId: string, other: string) => {
  $(btnId).onclick = () => {
    const panel = $(panelId);
    $(other).classList.remove("open");
    $("ai").classList.remove("open");
    $("t-ai").classList.remove("on");
    panel.classList.toggle("open");
    $(btnId).classList.toggle("on", panel.classList.contains("open"));
    $(other === "lib" ? "t-lib" : "t-props").classList.remove("on");
    resize();
  };
};
drawer("t-lib", "lib", "props");
drawer("t-props", "props", "lib");

stage.addEventListener("pointerdown", () => {
  for (const [b, p] of [["t-lib", "lib"], ["t-props", "props"], ["t-ai", "ai"]] as const) {
    if ($(p).classList.contains("open")) { $(p).classList.remove("open"); $(b).classList.remove("on"); }
  }
}, true);

/*
 * 두 손가락 제스처 — 벌리면 확대, 같이 끌면 화면 이동 (설계서 1절의 트랙패드 항목과 같은 뜻).
 *
 * 포인터 하나짜리 경로(선택·배선)는 그대로 두고, 두 번째 손가락이 닿는 순간부터
 * 가로채 제스처로만 쓴다. 손가락을 떼면 끌던 것이 없던 일이 되도록 취소 신호를 보낸다.
 */
const touches = new Map<number, Pt>();
let gesture: { dist: number; mid: Pt; scale: number } | null = null;

const midOf = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const gap = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;

stage.addEventListener("pointerdown", e => {
  if (e.pointerType !== "touch") return;
  touches.set(e.pointerId, local(e));
  if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    gesture = { dist: gap(a, b), mid: midOf(a, b), scale: vp.scale };
    // 한 손가락으로 시작했던 끌기·배선은 없던 일로 한다
    cancelDrag();
    down = null; box = null; pan = null;
    wireDraft = null;
    overlayDirty = true;
  }
});

stage.addEventListener("pointermove", e => {
  if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
  touches.set(e.pointerId, local(e));
  if (!gesture || touches.size < 2) return;
  const [a, b] = [...touches.values()];
  const d = gap(a, b), m = midOf(a, b);

  // 손가락 사이가 벌어진 만큼 확대하고, 가운데가 움직인 만큼 화면을 민다
  const want = Math.max(P.zoomMin, Math.min(P.zoomMax, gesture.scale * (d / gesture.dist)));
  const before = toWorld({ scale: vp.scale, at: vp.at }, m);
  vp = { scale: want, at: vp.at };
  const after = toWorld(vp, m);
  vp = { scale: want, at: [vp.at[0] + before[0] - after[0], vp.at[1] + before[1] - after[1]] };

  const dm: Pt = [m[0] - gesture.mid[0], m[1] - gesture.mid[1]];
  vp = { scale: vp.scale, at: [vp.at[0] - dm[0] / vp.scale, vp.at[1] - dm[1] / vp.scale] };
  gesture.mid = m;
  staticDirty = overlayDirty = true;
});

const endTouch = (e: PointerEvent) => {
  if (e.pointerType !== "touch") return;
  touches.delete(e.pointerId);
  if (touches.size < 2) gesture = null;
};
stage.addEventListener("pointerup", endTouch);
stage.addEventListener("pointercancel", endTouch);

// ── 단축키 ───────────────────────────────────────────────────────────
/*
 * 키 배정을 표로 둔다. 예전에는 if 사슬이라 "지금 무슨 키가 무엇을 하는지" 를
 * 코드에서 읽어야 했고, 사용자가 바꿀 길도 없었다. 표로 두면 도움말과 설정 창이
 * 같은 자료를 읽고, 바꾼 것은 저장된다.
 *
 * 키는 **물리 키**(KeyboardEvent.code)로 적는다 — 한글 상태에서도 그대로 동작한다.
 */
interface KeyAction { id: string; label: string; group: string; def: string; run(): void }

/** 이벤트를 "Ctrl+Shift+KeyW" 같은 글자로 */
function combo(e: KeyboardEvent): string {
  const p: string[] = [];
  if (e.ctrlKey || e.metaKey) p.push("Ctrl");
  if (e.altKey) p.push("Alt");
  if (e.shiftKey) p.push("Shift");
  p.push(e.code);
  return p.join("+");
}

/** 사람이 읽는 꼴. KeyW -> W, Space -> Space */
export function keyLabel(c: string): string {
  return c.split("+").map(k =>
    k.startsWith("Key") ? k.slice(3)
    : k.startsWith("Digit") ? k.slice(5)
    : k === "Delete" ? "Del"
    : k).join("+");
}

const KEY_ACTIONS: KeyAction[] = [
  { id: "tool.select", group: "Tools", label: "Select", def: "Escape", run: () => setTool("select") },
  { id: "tool.wire", group: "Tools", label: "Wires", def: "KeyW", run: () => setTool("wire") },
  { id: "tool.label", group: "Tools", label: "Net label", def: "KeyN", run: () => setTool("label") },
  { id: "tool.gnd", group: "Tools", label: "GND", def: "KeyG", run: () => setTool("gnd") },
  { id: "tool.power", group: "Tools", label: "Supply symbol", def: "Shift+KeyG", run: () => setTool("power") },
  { id: "tool.probe", group: "Tools", label: "Voltage probe", def: "KeyP", run: () => setTool("probe") },
  { id: "tool.junction", group: "Tools", label: "Junction", def: "Alt+KeyJ", run: () => setTool("junction") },
  { id: "tool.nc", group: "Tools", label: "No-connect", def: "KeyQ", run: () => setTool("nc") },
  { id: "tool.spice", group: "Tools", label: "SPICE directive", def: "KeyD", run: () => setTool("spice") },
  { id: "tool.text", group: "Tools", label: "Text", def: "KeyT", run: () => setTool("text") },
  { id: "tool.line", group: "Tools", label: "Line", def: "Alt+KeyL", run: () => setTool("line") },
  { id: "tool.rect", group: "Tools", label: "Rectangle", def: "KeyR", run: () => setTool("rect") },

  { id: "edit.undo", group: "Edit", label: "Undo", def: "Ctrl+KeyZ", run: undo },
  { id: "edit.redo", group: "Edit", label: "Redo", def: "Ctrl+KeyY", run: redo },
  { id: "edit.redo2", group: "Edit", label: "Redo (alt)", def: "Ctrl+Shift+KeyZ", run: redo },
  { id: "edit.copy", group: "Edit", label: "Copy", def: "Ctrl+KeyC", run: () => copySelection(false) },
  { id: "edit.cut", group: "Edit", label: "Cut", def: "Ctrl+KeyX", run: () => copySelection(true) },
  { id: "edit.paste", group: "Edit", label: "Paste", def: "Ctrl+KeyV", run: paste },
  { id: "edit.all", group: "Edit", label: "Select all", def: "Ctrl+KeyA", run: selectAll },
  { id: "edit.find", group: "Edit", label: "Find & replace", def: "Ctrl+KeyF", run: openFind },
  { id: "edit.rotate", group: "Edit", label: "Rotate", def: "Space", run: rotate },
  { id: "edit.flipx", group: "Edit", label: "Flip horizontal", def: "KeyX", run: flipX },
  { id: "edit.flipy", group: "Edit", label: "Flip vertical", def: "KeyY", run: flipY },
  { id: "edit.del", group: "Edit", label: "Delete", def: "Delete", run: del },

  { id: "arr.distH", group: "Arrange", label: "Distribute horizontally", def: "Ctrl+Shift+KeyH", run: () => distributeParts("h") },
  { id: "arr.distV", group: "Arrange", label: "Distribute vertically", def: "Ctrl+Shift+KeyE", run: () => distributeParts("v") },

  { id: "view.fit", group: "View", label: "Zoom to fit", def: "KeyK", run: () => fit() },
  { id: "view.fitSel", group: "View", label: "Zoom to selection", def: "Shift+KeyK", run: () => fit(selection.size ? selRefs() : undefined) },
  { id: "view.highlight", group: "View", label: "Highlight net", def: "KeyH", run: () => toggleHighlight(false) },
  { id: "view.unhighlight", group: "View", label: "Clear highlight", def: "Shift+KeyH", run: () => toggleHighlight(true) },
  { id: "view.ai", group: "View", label: "Assistant panel", def: "Shift+KeyA", run: () => toggleAssistant() },

  { id: "file.new", group: "File", label: "New project", def: "Shift+KeyN", run: () => newProject() },
  { id: "file.open", group: "File", label: "Open", def: "Ctrl+KeyO", run: () => $<HTMLInputElement>("file").click() },
  { id: "file.save", group: "File", label: "Save now", def: "Ctrl+KeyS", run: () => { void autosave.flush(project); } },
  { id: "file.parts", group: "File", label: "Component library", def: "Shift+KeyF", run: openLib },

  { id: "sim.run", group: "Simulation", label: "Run", def: "F8", run: () => { void run(); } },
];

const KEYS_STORE = "melange.keys";
/** 사용자가 바꾼 것만 담는다. 나머지는 기본값 */
let keyOverride: Record<string, string> = {};
try { keyOverride = JSON.parse(localStorage.getItem(KEYS_STORE) || "{}"); } catch { keyOverride = {}; }

const keyOf = (a: KeyAction) => keyOverride[a.id] ?? a.def;
function bindings(): Map<string, KeyAction> {
  const m = new Map<string, KeyAction>();
  for (const a of KEY_ACTIONS) m.set(keyOf(a), a);   // 뒤에 온 것이 이긴다
  return m;
}
let BOUND = bindings();

function saveKeys() {
  try { localStorage.setItem(KEYS_STORE, JSON.stringify(keyOverride)); } catch { /* 저장 못 해도 쓴다 */ }
  BOUND = bindings();
}

addEventListener("keydown", e => {
  const el = e.target as HTMLElement;
  if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA") return;
  if (e.isComposing) return;              // 한글 조합 중에는 넘긴다
  if (layoutSwitch?.ownsKeys()) return;   // Placement · Layout 편집기가 키를 받고 있다
  const c = e.code;

  /*
   * 상황에 따라 뜻이 달라지는 키들. 표보다 먼저 본다 —
   * 배치 중의 Space 는 '놓을 방향' 이지 '회전' 이 아니다.
   */
  if (tool === "place" && (c === "Space" || c === "KeyX" || c === "KeyY")) {
    if (c === "Space") placeRot = ((placeRot + 90) % 360) as typeof placeRot;
    else {
      // 대칭은 회전과 같이 움직여야 그림과 핀이 안 어긋난다 (transform 과 같은 규칙)
      placeRot = (((360 - placeRot) % 360) + (c === "KeyY" ? 180 : 0)) % 360 as typeof placeRot;
      placeMirror = !placeMirror;
    }
  }
  // 배선 중 Enter 는 지금 자리에서 끝낸다. 핀에 안 닿아도 끊어 둘 수 있어야 한다
  else if ((c === "Enter" || c === "NumpadEnter") && wireDraft) finishWire();
  // 배선 중 Backspace 는 마지막 꺾점을 무른다 (설계서 4절 O-18)
  else if (c === "Backspace" && wireDraft) {
    wireDraft.pop();
    if (!wireDraft.length) wireDraft = null;
  }
  else if (c === "Backspace") del();
  // 선분 하나가 골라져 있으면 Tab 이 배선 전체로 넓힌다 (설계서 2절)
  else if (c === "Tab" && segSel) { segSel = null; renderProps(); }
  // 끄는 중의 Esc 는 끌기를 없던 일로 한다 (예전에는 선택만 비워서, 놓을 때 되돌릴 대상이 없어
  // 옮겨진 채로 남았다)
  else if (c === "Escape" && (drag || vdrag)) cancelDrag();
  else if (c === "Escape" && (wireDraft || noteDraft || selection.size)) {
    if (wireDraft) wireDraft = null;
    else if (noteDraft) { noteDraft = null; setTool("select"); }
    else { selection.clear(); renderProps(); }
  }
  else if (c.startsWith("Arrow")) {
    const d: Record<string, Pt> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    if (!d[c]) return;
    nudge(d[c][0], d[c][1], e.shiftKey);
  }
  else {
    const action = BOUND.get(combo(e));
    if (!action) {
      // 배정 안 된 Ctrl 조합은 브라우저에 넘긴다 (새 탭·새로 고침 등)
      return;
    }
    action.run();
  }
  e.preventDefault();
  overlayDirty = true;
});

// ── 도움말 · 단축키 설정 · 라이선스 창 ───────────────────────────────
let sheetBox: HTMLElement | null = null;
function closeSheet() { sheetBox?.remove(); sheetBox = null; }

/** 가운데 뜨는 큰 창. 도움말·단축키·라이선스가 같이 쓴다 */
function openSheet(title: string, build: (body: HTMLElement) => void) {
  closeSheet();
  const box = document.createElement("div");
  box.id = "sheet";
  const head = document.createElement("div");
  head.className = "sheet-head";
  const h = document.createElement("b");
  h.textContent = title;
  const x = document.createElement("button");
  x.className = "btn";
  x.textContent = "Close";
  x.onclick = closeSheet;
  head.append(h, x);
  const body = document.createElement("div");
  body.className = "sheet-body";
  build(body);
  box.append(head, body);
  document.body.appendChild(box);
  sheetBox = box;
  refract(box, { band: 26, strength: 12 });
}

addEventListener("pointerdown", e => {
  if (sheetBox && !sheetBox.contains(e.target as Node)) closeSheet();
}, true);

function openHelp() {
  openSheet("How to use", body => {
    const rows: Array<[string, string]> = [
      ["Placing parts", "Pick one in the left list and click the canvas · or drag it out of the list"],
      ["Component library", "Shift+F (or Library above the parts list) · libraries on the left, parts in the middle, symbol and SPICE line on the right · type to search, ↑ ↓ to move, Enter to place"],
      ["Placing several", "Shift+click"],
      ["Wires", "W starts one · click to turn · it ends on a pin · Shift keeps it straight · Backspace undoes a turn"],
      ["From a loose pin", "Click a pin end with the select tool and a wire starts there"],
      ["Editing wires", "Pick a wire to see its corner handles · click again for a single segment · Tab widens the pick"],
      ["Moving", "Drag · arrow keys (Shift for 10 steps) · Space rotates · attached wires follow and re-route"],
      ["A part on a wire", "Drop it on a wire and it splits the wire and slots in"],
      ["The view", "Wheel zooms · Shift+wheel pans sideways · right-drag pans · two fingers on touch"],
      ["Menus", "Right-click without dragging for the menu"],
      ["Changing a value", "Double-click a part to jump to its value field"],
      ["Waveform cursors", "Click the waveform for A · Shift+click for B · double-click clears"],
      ["Calculator", "The Calculator tab post-processes the last run with expressions — db20(v(out)/v(in)), gm(M1)/id(M1), thd(v(out)) · Metrics lists performance metrics by textbook chapter · Help › Calculator reference lists every function"],
      ["Assistant", "Shift+A or the Assistant button · connect OpenRouter with your own key · it draws, wires and simulates, and each request undoes as one step · it sends your messages and a description of the circuit to OpenRouter, only when you use it"],
      ["Assistant extras", "Right-click a part: Ask the assistant about it · the paperclip (or paste, or drop) attaches a picture, such as a photo of a circuit drawn on paper · the memo button keeps notes that new conversations start from · the token line opens the usage log"],
      ["Simple · Edit", "The two buttons at the left of the toolbar — Simple keeps the schematic, the assistant and the results; Edit is the full editor"],
    ];
    const t = document.createElement("table");
    t.className = "help";
    for (const [k, v] of rows) {
      const tr = document.createElement("tr");
      const a = document.createElement("th"); a.textContent = k;
      const b = document.createElement("td"); b.textContent = v;
      tr.append(a, b); t.appendChild(tr);
    }
    body.appendChild(t);
    // 소스와 문제 신고는 저장소에서 (새 탭. 그리던 회로가 남아 있게)
    const more = document.createElement("p");
    more.className = "sheet-foot";
    const a = document.createElement("a");
    a.href = REPO_URL; a.target = "_blank"; a.rel = "noopener";
    a.textContent = "github.com/washclever/melange";
    more.append("Source, issues and the full write-up: ", a);
    body.appendChild(more);
  });
}

/** 소스 저장소. 도움말 창과 Help 메뉴가 같이 쓴다 */
const REPO_URL = "https://github.com/washclever/melange";

function openKeys() {
  openSheet("Shortcuts", body => {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "Click a row, then press the new key. Esc cancels, Del restores the default.";
    body.appendChild(note);

    let waiting: { a: KeyAction; btn: HTMLElement } | null = null;
    const draw = () => {
      body.querySelectorAll("table").forEach(t => t.remove());
      let group = "";
      let t: HTMLTableElement | null = null;
      for (const a of KEY_ACTIONS) {
        if (a.group !== group) {
          group = a.group;
          const h = document.createElement("table");
          h.className = "help keys";
          const cap = document.createElement("caption");
          cap.textContent = group;
          h.appendChild(cap);
          body.appendChild(h);
          t = h;
        }
        const tr = document.createElement("tr");
        const name = document.createElement("th");
        name.textContent = a.label;
        const td = document.createElement("td");
        const btn = document.createElement("button");
        btn.className = "btn keycap";
        btn.textContent = waiting?.a.id === a.id ? "Press a key…" : keyLabel(keyOf(a));
        if (keyOverride[a.id]) btn.classList.add("changed");
        btn.onclick = () => { waiting = { a, btn }; draw(); };
        td.appendChild(btn);
        tr.append(name, td);
        t!.appendChild(tr);
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (!waiting || !sheetBox) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") { waiting = null; draw(); return; }
      if (e.code === "Delete") { delete keyOverride[waiting.a.id]; waiting = null; saveKeys(); draw(); return; }
      if (["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(e.code)) return;
      keyOverride[waiting.a.id] = combo(e);
      waiting = null;
      saveKeys();
      draw();
    };
    addEventListener("keydown", onKey, true);
    // 창이 닫히면 듣기를 멈춘다
    new MutationObserver((_, ob) => {
      if (!document.body.contains(body)) { removeEventListener("keydown", onKey, true); ob.disconnect(); }
    }).observe(document.body, { childList: true });

    draw();
  });
}

function openLicense() {
  openSheet("Licenses", body => {
    const pre = document.createElement("pre");
    pre.textContent = "Reading…";
    body.appendChild(pre);
    fetch("THIRD-PARTY.md")
      .then(r => r.ok ? r.text() : Promise.reject(new Error(String(r.status))))
      .then(t => { pre.textContent = t; })
      .catch(() => {
        pre.textContent =
          "Could not read the third-party notices. See THIRD-PARTY.md in the repository.\n\n" +
          "Melange is MIT licensed; the simulation engine is eecircuit-engine (MIT) and\n" +
          "the ngspice inside it (Modified BSD, among other licenses).";
      });
  });
}

// ── 메뉴 막대 · 패널 켜고 끄기 · 테마 ────────────────────────────────
/*
 * 편집기의 모든 명령이 툴바에 박혀 있으면 자주 쓰는 것이 묻힌다. 툴바에는 **모드**
 * (지금 무엇을 그리는 중인가)만 두고, 한 번 누르면 끝나는 **명령**은 메뉴로 보낸다.
 * 단축키 글자도 메뉴에 적어 두어서, 눌러 보고 외우는 길이 생긴다.
 */
type MenuItem = "-" | { header: string } | {
  label: string;
  key?: string;
  run(): void;
  /** 켜짐 표시(체크)를 보여 줄 항목 */
  on?(): boolean;
  enabled?(): boolean;
};

/** 보이는 패널. 바꾸면 저장한다 — 매번 다시 끄게 하면 안 쓰느니만 못하다 */
const panels = { lib: true, props: true, bottom: true, ai: false };

/** 옆 패널이 서랍이 되는 좁은 화면인가 (CSS 의 max-width: 900px 와 같다). 함수 선언이라 어디서 불러도 된다 */
function narrow(): boolean { return matchMedia("(max-width: 900px)").matches; }

function applyPanels() {
  const c = document.documentElement.classList;
  c.toggle("no-lib", !panels.lib);
  c.toggle("no-props", !panels.props);
  c.toggle("no-bottom", !panels.bottom);
  c.toggle("no-ai", !panels.ai);
  if (!narrow()) $("t-ai").classList.toggle("on", panels.ai);
  saveLayout();
  resize();
  staticDirty = overlayDirty = true;
}

/*
 * 간편 모드 · 편집 모드. 간편 모드는 회로도 · 어시스턴트 · 결과만 둔다 — 부품 목록과 속성 패널을
 * 숨기고, 아래 패널은 파형 · 측정 · 계산기 탭만 남긴다 (넷리스트 · 로그 · 문제는 편집 모드에서).
 * 어시스턴트에게 말로 시키고 결과를 보는 쓰임새다. 편집 모드는 지금까지의 편집기 그대로다.
 */
let uiMode: "simple" | "edit" = "edit";
const SIMPLE_HIDDEN = new Set<string>(["net", "log", "issue"]);

function applyMode() {
  const simple = uiMode === "simple";
  document.documentElement.classList.toggle("simple", simple);
  for (const [id, on] of [["m-simple", simple], ["m-edit", !simple]] as const) {
    $(id).classList.toggle("on", on);
    $(id).setAttribute("aria-pressed", String(on));
  }
  if (simple) for (const [b, p] of [["t-lib", "lib"], ["t-props", "props"]] as const) { $(p).classList.remove("open"); $(b).classList.remove("on"); }
  renderTab();
  resize();
  staticDirty = overlayDirty = true;
}

function setMode(m: "simple" | "edit") {
  if (m === uiMode) return;
  uiMode = m;
  applyMode();
  saveLayout();
  // 간편 모드는 어시스턴트와 함께 쓰는 모드다. 넓은 화면에서는 칸을 열어 둔다 (좁은 화면에서는 서랍이라 누를 때 연다)
  if (m === "simple" && !narrow()) showAssistant(true);
}

/** 밝게 / 어둡게. 고르지 않았으면 바탕 화면 설정을 따른다 */
function systemDark() { return !matchMedia("(prefers-color-scheme: light)").matches; }
function isDark() {
  const c = document.documentElement.classList;
  return c.contains("dark") || (!c.contains("light") && systemDark());
}
function setTheme(dark: boolean) {
  const c = document.documentElement.classList;
  c.toggle("dark", dark);
  c.toggle("light", !dark);
  saveLayout();
  syncTheme();
  // 캔버스 색은 CSS 변수에서 읽어 간다. 테마가 바뀌면 전부 다시 그려야 한다
  staticDirty = overlayDirty = true;
  renderTab();
}

/*
 * 맨 위 오른쪽의 테마 버튼.
 *
 * 보기 메뉴에도 있지만 하루에도 몇 번씩 누르는 것이라 두 번 들어가게 둘 일이 아니다.
 * 아이콘은 **지금 상태가 아니라 누르면 갈 곳**을 그린다 — 어두우면 해, 밝으면 달.
 * 요소를 변수에 담지 않고 매번 찾는 것은, setTheme 이 저장된 설정을 되살리는 길에서
 * 이 코드보다 먼저 불릴 수 있어서다.
 */
function syncTheme() {
  const b = document.getElementById("t-theme");
  if (!b) return;
  const dark = isDark();
  b.innerHTML = icon(dark ? "sun" : "moon", 15);
  b.title = dark ? "Light theme" : "Dark theme";
  b.setAttribute("aria-label", b.title);
  b.setAttribute("aria-pressed", String(!dark));
}

const MENUS: Array<{ name: string; items: MenuItem[] }> = [
  {
    name: "File",
    items: [
      { label: "New project", key: "Shift+N", run: newProject },
      { label: "Open…", key: "Ctrl+O", run: () => $<HTMLInputElement>("file").click() },
      "-",
      { label: "Component library…", key: "Shift+F", run: openLib },
      "-",
      { label: "SPICE netlist (.sp)", run: () => { void doExport(); } },
      { label: "Project file (.json)", run: () => download((project.name || "circuit") + ".json", serialize(project)) },
      { label: "Image (.png)", run: openPngExport },
    ],
  },
  {
    name: "Edit",
    items: [
      { label: "Undo", key: "Ctrl+Z", run: undo },
      { label: "Redo", key: "Ctrl+Y", run: redo },
      "-",
      { label: "Copy", key: "Ctrl+C", run: () => copySelection(false), enabled: () => selection.size > 0 },
      { label: "Cut", key: "Ctrl+X", run: () => copySelection(true), enabled: () => selection.size > 0 },
      { label: "Paste", key: "Ctrl+V", run: paste },
      { label: "Delete", key: "Del", run: del, enabled: () => selection.size > 0 },
      "-",
      { label: "Select all", key: "Ctrl+A", run: selectAll },
      { label: "Find & replace…", key: "Ctrl+F", run: openFind },
      "-",
      { label: "Delete by kind…", run: openDeleteBox },
      { label: "Renumber designators…", run: openReannotate },
    ],
  },
  {
    name: "Arrange",
    items: [
      { label: "Rotate", key: "Space", run: rotate, enabled: () => selection.size > 0 },
      { label: "Flip horizontal", key: "X", run: flipX, enabled: () => selection.size > 0 },
      { label: "Flip vertical", key: "Y", run: flipY, enabled: () => selection.size > 0 },
      "-",
      { label: "Align left", run: () => alignParts("left"), enabled: () => selParts().length >= 2 },
      { label: "Align right", run: () => alignParts("right"), enabled: () => selParts().length >= 2 },
      { label: "Align top", run: () => alignParts("top"), enabled: () => selParts().length >= 2 },
      { label: "Align bottom", run: () => alignParts("bottom"), enabled: () => selParts().length >= 2 },
      { label: "Center vertically", run: () => alignParts("cx"), enabled: () => selParts().length >= 2 },
      { label: "Center horizontally", run: () => alignParts("cy"), enabled: () => selParts().length >= 2 },
      "-",
      { label: "Distribute horizontally", key: "Ctrl+Shift+H", run: () => distributeParts("h"), enabled: () => selParts().length >= 3 },
      { label: "Distribute vertically", key: "Ctrl+Shift+E", run: () => distributeParts("v"), enabled: () => selParts().length >= 3 },
    ],
  },
  {
    name: "View",
    items: [
      { label: "Zoom to fit", key: "K", run: () => fit() },
      { label: "Zoom to selection", key: "Shift+K", run: () => fit(selRefs()), enabled: () => selection.size > 0 },
      "-",
      { label: "Simple mode", run: () => setMode(uiMode === "simple" ? "edit" : "simple"), on: () => uiMode === "simple" },
      { label: "Assistant panel", key: "Shift+A", run: () => toggleAssistant(), on: () => assistantVisible() },
      { label: "Parts panel", run: () => { panels.lib = !panels.lib; applyPanels(); }, on: () => panels.lib, enabled: () => uiMode === "edit" },
      { label: "Properties panel", run: () => { panels.props = !panels.props; applyPanels(); }, on: () => panels.props, enabled: () => uiMode === "edit" },
      { label: "Bottom panel", run: () => { panels.bottom = !panels.bottom; applyPanels(); }, on: () => panels.bottom },
      "-",
      { label: "Grid", run: () => { showGrid = !showGrid; staticDirty = true; saveLayout(); }, on: () => showGrid },
      { label: "Pin names", run: () => { showPinNames = !showPinNames; staticDirty = true; saveLayout(); }, on: () => showPinNames },
      { label: "Net names", run: () => { showNetNames = !showNetNames; staticDirty = true; saveLayout(); }, on: () => showNetNames },
      { label: "Dark theme", run: () => setTheme(!isDark()), on: () => isDark() },
      { label: "Glass effect", run: () => { glass = !glass; applyGlass(); }, on: () => glass },
    ],
  },
  {
    name: "Examples",
    items: [
      ...DEMOS.map((d): MenuItem => ({
        label: d.name,
        run: () => loadDemo(d),
      })),
      "-",
      // ALIGN-public 의 예제를 SKY130 으로 — 회로도를 열고 Placement 를 옆에 띄운다 (src/layout/examples)
      { header: "Layout — ALIGN examples (SKY130)" },
      ...LAYOUT_EXAMPLE_MENU.map((e): MenuItem => ({ label: e.title, run: () => loadLayoutExample(e.id) })),
    ],
  },
  {
    name: "Simulation",
    items: [
      { label: "Run", key: "F8", run: () => { void run(); } },
      "-",
      { label: "Waveform", run: () => { tab = "wave"; renderTab(); }, on: () => tab === "wave" },
      { label: "Netlist", run: () => { tab = "net"; renderTab(); }, on: () => tab === "net", enabled: () => uiMode === "edit" },
      { label: "Log", run: () => { tab = "log"; renderTab(); }, on: () => tab === "log", enabled: () => uiMode === "edit" },
      { label: "Issues", run: () => { tab = "issue"; renderTab(); }, on: () => tab === "issue", enabled: () => uiMode === "edit" },
      { label: "Measure", run: () => { tab = "meas"; renderTab(); }, on: () => tab === "meas" },
      { label: "Calculator", run: () => { tab = "calc"; renderTab(); }, on: () => tab === "calc" },
    ],
  },
  {
    name: "Help",
    items: [
      { label: "How to use…", run: openHelp },
      { label: "Shortcuts…", run: openKeys },
      { label: "Calculator reference…", run: () => { void loadCalc().then(m => openSheet("Calculator reference", m.buildCalcHelp)); } },
      "-",
      { label: "Melange on GitHub", run: () => { window.open(REPO_URL, "_blank", "noopener"); } },
      { label: "Licenses & third-party notices…", run: openLicense },
    ],
  },
];

/*
 * 유리 효과 끄기 — 블러를 못 쓰는 기기나, 투명을 줄이도록 설정한 사람을 위해.
 * morglay 와 같은 방식으로 :root 에 solid 를 건다.
 */
let glass = CSS.supports("backdrop-filter", "blur(1px)")
  && !matchMedia("(prefers-reduced-transparency: reduce)").matches;
function applyGlass() {
  document.documentElement.classList.toggle("solid", !glass);
  saveLayout();
}

let openMenu: { name: string; el: HTMLElement; btn: HTMLElement } | null = null;

function closeMenu() {
  openMenu?.el.remove();
  openMenu?.btn.classList.remove("on");
  openMenu = null;
}

function showMenu(name: string, btn: HTMLElement) {
  closeMenu();
  const def = MENUS.find(m => m.name === name)!;
  const el = document.createElement("div");
  el.className = "menu";
  for (const item of def.items) {
    if (item === "-") { el.appendChild(document.createElement("hr")); continue; }
    if ("header" in item) { const h = document.createElement("div"); h.className = "mh"; h.textContent = item.header; el.appendChild(h); continue; }
    const b = document.createElement("button");
    const tick = item.on ? (item.on() ? "✓" : "") : "";
    b.innerHTML = `<span><span class="tick">${tick}</span>${item.label}</span>` +
      (item.key ? `<span class="k">${item.key}</span>` : "");
    if (item.enabled && !item.enabled()) b.disabled = true;
    b.onmousedown = e => {
      e.preventDefault();
      if (b.disabled) return;
      // 체크 항목은 메뉴를 열어 둔 채로 바로 반영한다 (여러 개를 연달아 켜고 끈다)
      const keep = !!item.on;
      item.run();
      if (keep) showMenu(name, btn);
      else { closeMenu(); overlayDirty = true; }
    };
    el.appendChild(b);
  }
  document.body.appendChild(el);
  const r = btn.getBoundingClientRect();
  el.style.left = Math.min(r.left, innerWidth - el.offsetWidth - 6) + "px";
  el.style.top = r.bottom + 4 + "px";
  btn.classList.add("on");
  openMenu = { name, el, btn };
}

{
  const bar = $("menus");
  for (const m of MENUS) {
    const b = document.createElement("button");
    b.textContent = m.name;
    b.onmousedown = e => {
      e.preventDefault();
      if (openMenu?.name === m.name) closeMenu(); else showMenu(m.name, b);
    };
    // 하나가 열려 있으면 지나가기만 해도 바뀐다 (보통의 메뉴 막대처럼)
    b.onmouseenter = () => { if (openMenu && openMenu.name !== m.name) showMenu(m.name, b); };
    bar.appendChild(b);
  }

  $("t-theme").onclick = () => setTheme(!isDark());
  syncTheme();

  /*
   * 편집기 전환 — 테마 버튼 바로 왼쪽. 레이아웃 쪽은 회로도를 읽기만 한다 (snapshot) — 넷리스트로 바꾸는 일
   * (src/layout/bridge.ts) 과 앞단·배치·배선은 그쪽 덩어리 안에서 한다. 고른 것은 양쪽으로 따라간다.
   */
  // 메뉴 막대 오른쪽 끝: [Circuit ▾ Placement ▾ Layout] [AI] [테마]
  layoutSwitch = createLayoutSwitch($("menubar"), $("t-ai"), {
    snapshot: () => ({ sheet, library: project.library, ex, name: project.name }),
    version: () => docRev,
    selectParts: (refs) => {
      const want = new Set(refs);
      setSelection(sheet.parts.filter(p => want.has(p.ref)).map(p => refKey({ kind: "part", id: p.id })));
      staticDirty = overlayDirty = true;
      renderProps();
    },
    highlightNet: (name) => { highlightNet = name; staticDirty = true; renderStatus(); },
    onLayoutChange: () => { staticDirty = overlayDirty = true; },
  });
  // 회로 쪽을 누르면 단축키가 다시 회로도로 온다 (여럿을 같이 볼 때)
  for (const id of ["toolbar", "mid", "bottom"]) $(id).addEventListener("pointerdown", () => layoutSwitch?.circuitActive(), true);

  /*
   * 아무 쪽도 고르지 않았으면 바탕 화면을 따라간다. 그럴 때 OS 가 밝기를 바꾸면
   * CSS 는 알아서 넘어가지만 캔버스는 색을 변수에서 **읽어 가 둔** 상태라 안 바뀐다.
   */
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    const c = document.documentElement.classList;
    if (c.contains("dark") || c.contains("light")) return;  // 직접 고른 쪽이 이긴다
    syncTheme();
    staticDirty = overlayDirty = true;
    renderTab();
  });
}

addEventListener("pointerdown", e => {
  if (openMenu && !openMenu.el.contains(e.target as Node) && !$("menubar").contains(e.target as Node)) closeMenu();
}, true);
addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); });

/*
 * 떠 있는 창은 바깥을 누르거나 Close 로만 닫혔다. 모달에서 Esc 는 손이 먼저 가는 자리다.
 * 캡처 단계에서 가로채야 한다 — 아래 단계의 키 처리가 먼저 돌면 창은 그대로인데
 * 선택만 풀린다.
 */
addEventListener("keydown", e => {
  if (e.key !== "Escape" || !sheetBox) return;
  closeSheet();
  e.preventDefault();
  e.stopPropagation();
}, true);

restoreLayout();
applyGlass();
applyPanels();

/*
 * 유리 표면에 굴절을 건다. 요소마다 크기에 맞는 변위 지도를 만들어야 해서
 * CSS 만으로는 안 된다 (src/ui/glass.ts). 못 거는 브라우저에서는 블러·림만 남는다.
 */
// 캔버스(stage)는 뺀다 — 그림이 늘 바뀌는 면에 걸면 입력이 늦게 따라온다
for (const [id, band] of [["toolbar", 18], ["lib", 22],
                          ["props", 22], ["bottom", 24]] as const) {
  refract($(id), { band, strength: Math.round(band * 0.6) });
}

// ── 하단 탭 ───────────────────────────────────────────────────────────
const TABS = ["wave", "net", "log", "issue", "meas", "calc"] as const;
let tab: (typeof TABS)[number] = "wave";
/** 파형 탭에 잡음 스펙트럼을 그리고 있으면 그 그래프 (탭을 다시 지을 때 관찰자를 끊는다) */
let noisePlot: PlotView | null = null;
for (const t of TABS) {
  $("tab-" + t).onclick = () => { tab = t; renderTab(); };
}

/**
 * 편집할 때마다 아래 탭을 바로 다시 짓지 않는다. 넷리스트 탭은 넷리스트를 통째로 다시
 * 만들고(부품 5만 개에서 150 ms), 문제 탭은 문제마다 줄을 만들고, 파형 탭은 파형을 다시
 * 그린다. 편집이 이어지는 동안은 미뤘다가 손이 멈춘 뒤 한 번만 짓는다.
 */
let tabTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTab() {
  // 계산기는 지난 실행의 결과만 본다. 회로도를 고칠 때마다 다시 지으면 적던 식의 초점이 날아간다
  if (tab === "calc") return;
  if (tab === "log" || tab === "meas") { renderTab(); return; }   // 문서와 상관없는 가벼운 탭
  if (tabTimer) clearTimeout(tabTimer);
  tabTimer = setTimeout(() => { tabTimer = null; renderTab(); }, 120);
}

function renderTab() {
  if (tabTimer) { clearTimeout(tabTimer); tabTimer = null; }
  // 간편 모드의 아래 패널에는 파형 · 측정 · 계산기만 있다. 숨은 탭을 가리키고 있으면 파형으로
  if (uiMode === "simple" && SIMPLE_HIDDEN.has(tab)) tab = "wave";
  for (const t of TABS) $("tab-" + t).classList.toggle("on", tab === t);
  // 좁은 화면에서는 탭 줄이 옆으로 스크롤된다. 메뉴로 고른 탭이 줄 밖에 있으면 보이게 끌어온다
  $("tab-" + tab).scrollIntoView?.({ block: "nearest", inline: "nearest" });
  const body = $("tabbody");
  calcMod?.closePop();
  noisePlot?.destroy();
  noisePlot = null;
  body.innerHTML = "";
  waveEls = null;

  if (tab === "calc") {
    if (calcMod) { calcMod.renderCalc(body, calcHost); return; }
    // 계산기를 처음 연다. 본체를 받아서 다시 그린다 — 그 사이 다른 탭으로 갔으면 그냥 둔다
    body.innerHTML = '<div class="empty">Loading the calculator…</div>';
    loadCalc().then(
      () => { if (tab === "calc") renderTab(); },
      () => { if (tab === "calc") $("tabbody").innerHTML = '<div class="empty">The calculator could not be loaded — check the connection and open the tab again.</div>'; },
    );
    return;
  }

  if (tab === "net") {
    if (externalNetlist) {
      const note = document.createElement("div");
      note.className = "empty";
      note.style.marginBottom = "6px";
      note.textContent = "This uses the external .sp as is. Editing the schematic does not change this netlist.";
      body.appendChild(note);
    }
    const pre = document.createElement("pre");
    pre.textContent = currentNetlist();
    body.appendChild(pre);
  } else if (tab === "log") {
    if (lastRunError) body.appendChild(askButton("Ask the assistant why", whyFailedPrompt(), "Why did the simulation fail?"));
    const pre = document.createElement("pre");
    pre.textContent = simLog || "Not run yet";
    body.appendChild(pre);
  } else if (tab === "meas") {
    /*
     * 측정값은 숫자라 그래프가 아니라 표다. 곡선으로는 "상승시간이 몇이냐" 에
     * 답할 수 없고, 그 답을 눈으로 읽으려고 커서를 두 번 찍는 것이 이 기능의 자리다.
     */
    if (!project.meas?.length) {
      body.innerHTML =
        '<div class="empty">No measurements yet. Add them in the Simulation panel on the right' +
        ' — for example <code>tran trise TRIG v(out) VAL=0.1 RISE=1 TARG v(out) VAL=0.9 RISE=1</code>.</div>';
      return;
    }
    if (!measures.length) {
      body.innerHTML = '<div class="empty">Run (F8) and the measured values show up here</div>';
      return;
    }
    /*
     * 표는 DOM 으로 짓는다. 설명 칸에 들어가는 글은 **엔진이 준 것**이라
     * innerHTML 로 넣으면 ngspice 가 식을 되뱉을 때 ('v(out) < 1' 같은) 표가 깨진다.
     */
    const table = document.createElement("table");
    const head = document.createElement("tr");
    for (const h of ["Name", "Value", "Detail"]) {
      const th = document.createElement("th");
      th.textContent = h;
      if (h === "Detail") th.style.textAlign = "left";   // 아래 칸이 왼쪽 정렬이다
      head.appendChild(th);
    }
    table.appendChild(head);
    for (const m of measures) {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = m.name;
      const val = document.createElement("td");
      val.textContent = formatMeasure(m);
      if (m.value === null) val.style.color = "var(--mut)";   // 'failed' 가 숫자처럼 보이면 안 된다
      const det = document.createElement("td");
      det.textContent = m.detail;
      det.style.color = "var(--mut)";
      det.style.textAlign = "left";
      tr.append(name, val, det);
      table.appendChild(tr);
    }
    body.appendChild(table);
    const failed = measures.filter(m => m.value === null).length;
    if (failed) {
      const d = document.createElement("div");
      d.className = "note";
      d.textContent = failed + " of them did not produce a value — check the Log tab for what ngspice said.";
      body.appendChild(d);
    }
  } else if (tab === "issue") {
    if (!issues.length) { body.innerHTML = '<div class="empty">No issues</div>'; return; }
    if (issues.some(i => i.level === "error")) {
      body.appendChild(askButton("Ask the assistant to fix these",
        "The pre-run check reports these problems:\n" + issues.map(i => `- ${i.level}: ${i.message}`).join("\n") +
        "\nFind the cause in the circuit and fix it, then run the simulation to confirm.",
        "Fix the problems the pre-run check reports"));
    }
    for (const i of issues) {
      const d = document.createElement("div");
      d.className = "issue " + i.level;
      d.innerHTML = `<b>${i.level === "error" ? "Error" : "Warning"}</b> — ${i.message}`;
      if (i.partId) {
        d.style.cursor = "pointer";
        d.onclick = () => {
          const p = findById(sheet.parts, i.partId!);
          if (!p) return;
          setSelection(["part:" + p.id]);
          vp = { scale: Math.max(vp.scale, 3), at: [p.at[0] - W / 2 / Math.max(vp.scale, 3), p.at[1] - H / 2 / Math.max(vp.scale, 3)] };
          staticDirty = overlayDirty = true; renderProps();
        };
      }
      body.appendChild(d);
    }
  } else if (uiMode === "simple" && lastRunError) {
    // 간편 모드에는 로그 탭이 없다. 실패한 까닭을 파형 자리에 보여 준다
    const d = document.createElement("div");
    d.className = "issue error";
    d.textContent = lastRunError;
    body.append(askButton("Ask the assistant why", whyFailedPrompt(), "Why did the simulation fail?"), d);
  } else if (traces?.some(t => t.name.toLowerCase() === "onoise_spectrum")) {
    // 잡음 스펙트럼은 계산기와 같은 그래프로 그린다. 그 본체를 아직 안 받았으면 받아서 다시 그린다
    if (calcMod) renderNoise(body, traces, calcMod);
    else {
      body.innerHTML = '<div class="empty">Loading the plot…</div>';
      loadCalc().then(
        () => { if (tab === "wave") renderTab(); },
        () => { if (tab === "wave") $("tabbody").innerHTML = '<div class="empty">The plot could not be loaded — check the connection and run again.</div>'; },
      );
    }
  } else {
    // 설계서 화면 그림처럼 파형 오른쪽에 측정값을 붙인다
    const row = document.createElement("div");
    row.id = "waverow";
    const left = document.createElement("div");
    left.id = "wavecol";
    const cv = document.createElement("canvas");
    cv.id = "wave";
    const legend = document.createElement("div");
    legend.className = "legend";
    left.append(cv, legend);
    const readout = document.createElement("div");
    readout.id = "readout";
    row.append(left, readout);
    body.appendChild(row);
    waveEls = { cv, legend, readout };
    attachCursors(cv);
    watchWaveSize(cv);
    drawWave(cv, legend, readout);
  }
}

const COLORS = ["--t1", "--t2", "--t3", "--t4", "--t5"];

// ── 파형 커서 (설계서 M3 파형 패널, 사용자 흐름 8단계) ────────────────
/** 커서 두 개의 시간 (초). null 이면 아직 안 놓았다 */
let curA: number | null = null;
let curB: number | null = null;
/**
 * 파형에서 지금 보고 있는 범위. null 이면 전체다.
 *
 * 가로는 **fwd 공간**(AC 는 log10, 나머지는 값 그대로)에 둔다. 화면 x 는 fwd 공간에서
 * 선형이라, 상자로 끈 자리를 범위로 바꾸는 계산이 곱셈 하나로 끝난다. 세로는 값 그대로다.
 */
let waveView: { x0: number; x1: number; y0: number; y1: number } | null = null;
/** 상자로 끄는 중일 때 그 상자 (화면 px). 그림만을 위한 것이다 */
let zoomBox: { x0: number; y0: number; x1: number; y1: number } | null = null;

/** 마지막으로 그린 그래프의 기하. 화면 좌표를 값으로 되돌리는 데 쓴다 */
let plot: {
  pad: { l: number; r: number; t: number; b: number };
  w: number; h: number;
  /** 가로 0~1 을 값으로 (fwd 를 되돌린 뒤) */
  toValue: (frac: number) => number;
  /** 보고 있는 범위와 데이터 전체 범위 (가로는 fwd 공간) */
  a0: number; a1: number; fullA0: number; fullA1: number;
  y0: number; y1: number; fullY0: number; fullY1: number;
  /** fwd 공간 값 <-> 실제 값 */
  fwd: (v: number) => number;
  inv: (a: number) => number;
} | null = null;

/** 파형을 전체 범위로 되돌린다. 해석이 바뀌면 축이 달라지므로 꼭 불러야 한다 */
function resetWaveView() { waveView = null; zoomBox = null; }
/**
 * 지금 화면에 있는 파형 요소들. 커서를 움직일 때 renderTab() 으로 탭을 통째로 다시
 * 만들면 캔버스가 새 것으로 바뀌어, 끌던 중이면 포인터 이벤트가 떨어져 나간 요소로 간다.
 * 그래서 제자리에서 다시 그린다.
 */
let waveEls: { cv: HTMLCanvasElement; legend: HTMLElement; readout: HTMLElement } | null = null;
const redrawWave = () => { if (waveEls) drawWave(waveEls.cv, waveEls.legend, waveEls.readout); };

/*
 * 아래 패널을 끌어 키우면 파형도 같이 커진다.
 *
 * 가름대를 끄는 동안 크기 변화가 쏟아지므로 프레임마다 한 번으로 묶는다. 다시 그릴 때
 * 바꾸는 것은 캔버스의 그림 버퍼뿐이고 CSS 자리는 그대로라, 관찰자가 스스로를 다시
 * 부르는 고리는 생기지 않는다.
 */
let waveRO: ResizeObserver | null = null;
let wavePending = false;
function watchWaveSize(cv: HTMLCanvasElement) {
  waveRO?.disconnect();
  waveRO = new ResizeObserver(() => {
    if (wavePending) return;
    wavePending = true;
    requestAnimationFrame(() => { wavePending = false; if (waveEls?.cv === cv) redrawWave(); });
  });
  waveRO.observe(cv);
}

/** 시간 배열에서 t 에 가장 가까운 칸. 커서는 실제 샘플에 붙는다 */
function sampleAt(time: Float64Array, t: number): number {
  let lo = 0, hi = time.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (time[mid] < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(time[lo - 1] - t) <= Math.abs(time[lo] - t)) lo--;
  return lo;
}

/**
 * 클릭으로 커서를 놓는다. 그냥 클릭은 A, Shift+클릭은 B.
 * 누른 채 끌면 그 커서가 따라오므로 값을 보며 맞출 수 있다.
 */
function attachCursors(cv: HTMLCanvasElement) {
  /** 포인터의 캔버스 안 좌표 (CSS px) */
  const local = (e: PointerEvent | WheelEvent): Pt => {
    const r = cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  /** 화면 x -> 가로축 값 */
  const valueAt = (sx: number): number | null => {
    if (!plot) return null;
    const span = plot.w - plot.pad.l - plot.pad.r;
    if (span <= 0) return null;
    return plot.toValue(Math.max(0, Math.min(1, (sx - plot.pad.l) / span)));
  };
  /** 화면 x -> fwd 공간 (자르지 않는다. 상자 확대에 쓴다) */
  const fwdAt = (sx: number): number | null => {
    if (!plot) return null;
    const span = plot.w - plot.pad.l - plot.pad.r;
    if (span <= 0) return null;
    return plot.a0 + ((sx - plot.pad.l) / span) * (plot.a1 - plot.a0);
  };
  /** 화면 y -> 세로 값 */
  const valueY = (sy: number): number | null => {
    if (!plot) return null;
    const span = plot.h - plot.pad.t - plot.pad.b;
    if (span <= 0) return null;
    return plot.y1 - ((sy - plot.pad.t) / span) * (plot.y1 - plot.y0);
  };
  /** 그 x 에 커서 손잡이가 있는가. 있으면 끌어 옮기는 쪽이다 */
  const cursorNear = (sx: number): "A" | "B" | null => {
    if (!plot) return null;
    const span = plot.w - plot.pad.l - plot.pad.r;
    const sxOf = (t: number) =>
      plot!.pad.l + (plot!.a1 > plot!.a0 ? (plot!.fwd(t) - plot!.a0) / (plot!.a1 - plot!.a0) : 0) * span;
    for (const [name, t] of [["A", curA], ["B", curB]] as const) {
      if (t !== null && Math.abs(sxOf(t) - sx) <= 6) return name;
    }
    return null;
  };

  /*
   * 한 번 누른 것이 커서 놓기인지 확대 상자인지는 **움직인 뒤에야** 갈린다.
   * 이미 있는 커서 손잡이를 집었으면 그건 커서를 끄는 것이고, 빈 자리에서 끌면 확대,
   * 끌지 않고 떼면 커서 놓기다. 어느 쪽도 다른 쪽을 막지 않는다.
   */
  let grab: { at: Pt; cursor: "A" | "B" | null; moved: boolean } | null = null;

  cv.addEventListener("pointerdown", e => {
    if (!plot || e.button !== 0) return;
    const at = local(e);
    try { cv.setPointerCapture(e.pointerId); } catch { /* 캡처 없이도 된다 */ }
    grab = { at, cursor: cursorNear(at[0]), moved: false };
    if (grab.cursor) {                       // 손잡이를 집었으면 바로 끌기로 간다
      const t = valueAt(at[0]);
      if (t !== null) { if (grab.cursor === "A") curA = t; else curB = t; redrawWave(); }
    }
  });

  cv.addEventListener("pointermove", e => {
    if (!grab || !plot) return;
    const at = local(e);
    if (!grab.moved && Math.hypot(at[0] - grab.at[0], at[1] - grab.at[1]) < 4) return;
    grab.moved = true;
    if (grab.cursor) {
      const t = valueAt(at[0]);
      if (t !== null) { if (grab.cursor === "A") curA = t; else curB = t; redrawWave(); }
    } else {
      zoomBox = { x0: grab.at[0], y0: grab.at[1], x1: at[0], y1: at[1] };
      redrawWave();
    }
  });

  cv.addEventListener("pointerup", e => {
    if (!grab || !plot) { grab = null; return; }
    const at = local(e);
    const g0 = grab;
    grab = null;
    if (g0.cursor) return;                   // 커서를 끌던 것이면 끝
    if (!g0.moved) {                         // 끌지 않았으면 커서를 놓는다
      const t = valueAt(at[0]);
      if (t !== null) { if (e.shiftKey) curB = t; else curA = t; redrawWave(); }
      return;
    }
    zoomBox = null;
    /*
     * 상자가 너무 납작하면 그 축은 그대로 둔다. 가로로만 긋는 일이 잦은데, 그때 세로까지
     * 바늘구멍으로 좁히면 파형이 사라진 것처럼 보인다.
     */
    const wide = Math.abs(at[0] - g0.at[0]) >= 8;
    const tall = Math.abs(at[1] - g0.at[1]) >= 8;
    if (!wide && !tall) { redrawWave(); return; }
    const x0 = fwdAt(Math.min(g0.at[0], at[0])), x1 = fwdAt(Math.max(g0.at[0], at[0]));
    const y1 = valueY(Math.min(g0.at[1], at[1])), y0 = valueY(Math.max(g0.at[1], at[1]));
    if (x0 === null || x1 === null || y0 === null || y1 === null) { redrawWave(); return; }
    setWaveView(wide ? x0 : plot.a0, wide ? x1 : plot.a1, tall ? y0 : plot.y0, tall ? y1 : plot.y1);
    redrawWave();
  });

  cv.addEventListener("pointercancel", () => { grab = null; zoomBox = null; redrawWave(); });

  /*
   * 휠은 가로 확대, Shift+휠은 가로 이동 — 회로도 캔버스와 같은 손놀림이다.
   * 포인터가 가리키는 값이 제자리에 남도록 중심을 잡는다.
   */
  cv.addEventListener("wheel", e => {
    if (!plot) return;
    e.preventDefault();
    const [sx] = local(e);
    const span = plot.a1 - plot.a0;
    if (!(span > 0)) return;
    if (e.shiftKey) {
      const step = span * 0.15 * Math.sign(e.deltaY || e.deltaX || 1);
      setWaveView(plot.a0 + step, plot.a1 + step, plot.y0, plot.y1);
    } else {
      const f = Math.max(0, Math.min(1, (sx - plot.pad.l) / (plot.w - plot.pad.l - plot.pad.r)));
      const anchor = plot.a0 + span * f;
      const k = e.deltaY < 0 ? 1 / 1.25 : 1.25;
      setWaveView(anchor - (anchor - plot.a0) * k, anchor + (plot.a1 - anchor) * k, plot.y0, plot.y1);
    }
    redrawWave();
  }, { passive: false });

  /*
   * 더블클릭은 **먼저 확대를 되돌린다.** 확대해 놓고 전체를 보려는 손이 먼저이고,
   * 커서를 치우는 것은 그다음이다. 전체를 보고 있을 때만 커서를 지운다.
   */
  cv.addEventListener("dblclick", () => {
    if (waveView) resetWaveView(); else curA = curB = null;
    redrawWave();
  });
  cv.style.cursor = "crosshair";
}

/**
 * 보는 범위를 넣는다. 데이터 밖으로는 안 나가고, 너무 좁히지도 않는다.
 * 전체와 같아지면 아예 비워 둔다 — 그래야 눈금이 원래 값으로 돌아오고
 * '전체 보기' 단추도 사라진다.
 */
function setWaveView(x0: number, x1: number, y0: number, y1: number) {
  if (!plot) return;
  const { fullA0, fullA1, fullY0, fullY1 } = plot;
  const wSpan = Math.max(x1 - x0, (fullA1 - fullA0) * 1e-4);
  let nx0 = x0, nx1 = x0 + wSpan;
  if (nx1 - nx0 >= fullA1 - fullA0) { nx0 = fullA0; nx1 = fullA1; }
  else if (nx0 < fullA0) { nx1 += fullA0 - nx0; nx0 = fullA0; }
  else if (nx1 > fullA1) { nx0 -= nx1 - fullA1; nx1 = fullA1; }

  const hSpan = Math.max(y1 - y0, (fullY1 - fullY0) * 1e-4);
  let ny0 = y0, ny1 = y0 + hSpan;
  if (ny1 - ny0 >= fullY1 - fullY0) { ny0 = fullY0; ny1 = fullY1; }
  else if (ny0 < fullY0) { ny1 += fullY0 - ny0; ny0 = fullY0; }
  else if (ny1 > fullY1) { ny0 -= ny1 - fullY1; ny1 = fullY1; }

  const full = nx0 === fullA0 && nx1 === fullA1 && ny0 === fullY0 && ny1 === fullY1;
  waveView = full ? null : { x0: nx0, x1: nx1, y0: ny0, y1: ny1 };
}

const fmtTime = (s: number): string =>
  Math.abs(s) >= 1e-3 ? (s * 1e3).toFixed(3) + " ms"
  : Math.abs(s) >= 1e-6 ? (s * 1e6).toFixed(2) + " µs"
  : (s * 1e9).toFixed(1) + " ns";

const fmtFreq = (hz: number): string => {
  // 10배 간격은 곱해서 만들어져 1 MHz 가 999999.9999... 로 온다.
  // 그대로 보면 "1000 kHz" 가 되어 눈금이 한 자리 길어진다
  const f = Number(hz.toPrecision(6));
  return f >= 1e6 ? (f / 1e6).toFixed(f >= 1e7 ? 0 : 1) + " MHz"
    : f >= 1e3 ? (f / 1e3).toFixed(f >= 1e4 ? 0 : 1) + " kHz"
    : f.toFixed(f >= 100 ? 0 : 1) + " Hz";
};

/**
 * 시간 눈금 글자. 단위와 자릿수를 **보이는 폭에서 한 번** 고르고 모든 눈금이 같이 쓴다.
 * 예전에는 늘 ms 였다 — 20 ns 짜리 래치 파형의 눈금이 전부 "0.00 ms" 로 적혔다.
 */
function timeTicks(span: number, ticks: number): (v: number) => string {
  const s = Math.abs(span) || 1e-3;
  const [k, u] = s >= 1 ? [1, "s"] : s >= 1e-3 ? [1e3, "ms"] : s >= 1e-6 ? [1e6, "µs"] : s >= 1e-9 ? [1e9, "ns"] : [1e12, "ps"];
  const step = (s * k) / Math.max(1, ticks);
  const d = Math.min(3, Math.max(1, Math.ceil(-Math.log10(step)) + 1));
  return v => (v * k).toFixed(d) + " " + u;
}

/** 가로축 눈금 글자. 해석 종류에 맞는 단위로 (시간은 timeTicks 가 고른 단위) */
function axisLabel(v: number, kind: "time" | "freq" | "sweep", time: (v: number) => string = fmtTime): string {
  if (kind === "time") return time(v);
  if (kind === "freq") return fmtFreq(v);
  // 전압을 쓸어 올린 축은 예전 그대로 적는다. 온도 · 전류를 쓸었으면 그 단위로
  if (sweepUnit === "V") return v.toFixed(2) + " V";
  return sweepUnit === "°C" ? Number(v.toFixed(2)) + " °C" : eng(v, sweepUnit, 3);
}

/**
 * DC 스윕의 가로축 단위. ngspice 는 쓸어 올린 것에 따라 축 이름을 달리 준다:
 * 전압원 v(v-sweep) · 전류원 i(i-sweep) · 온도 temp-sweep (`.dc temp -40 125 5`).
 */
let sweepUnit = "V";

/**
 * 전달 함수(.tf)의 결과 셋을 표로. 이름이 v(transfer_function) · v(v2#input_impedance) 꼴이라
 * 동작점 표에 그대로 두면 전압처럼 읽히고 단위도 틀린다.
 */
function tfTable(ts: readonly Trace[]): string | null {
  const find = (re: RegExp) => ts.find(t => re.test(t.name.toLowerCase()));
  const gain = find(/^v\(transfer_function\)$/);
  if (!gain) return null;
  const rin = find(/#input_impedance\)$/);
  const rout = find(/^v\(output_impedance_at_|#output_impedance\)$/);
  const unit = tfGainUnit(ts.map(t => t.name));
  const g = gain.values[0];
  const rows: Array<[string, string]> = [[
    unit === "Ω" ? "Transresistance" : unit === "S" ? "Transconductance" : "Gain",
    unit ? eng(g, unit, 6) : Number(g.toPrecision(6)) + (g !== 0 ? `  (${(20 * Math.log10(Math.abs(g))).toFixed(2)} dB)` : ""),
  ]];
  // 열린 단자(게이트)에 ngspice 는 1e20 Ω 을 준다. 숫자로 적으면 값처럼 읽힌다
  const ohms = (v: number) => (Math.abs(v) >= 1e18 ? "∞ (open)" : eng(v, "Ω", 6));
  if (rin) rows.push(["Input resistance", ohms(rin.values[0])]);
  if (rout) rows.push(["Output resistance", ohms(rout.values[0])]);
  return "<table><tr><th>Transfer function</th><th>Value</th></tr>" +
    rows.map(([n, v]) => `<tr><td>${n}</td><td class="v">${v}</td></tr>`).join("") + "</table>";
}

/** 화면 밖에 정한 크기로 그리는 파형 (어시스턴트가 보는 그림). 커서 · 확대 상자는 그리지 않는다 */
interface WaveShot {
  w: number;
  h: number;
  /** 이것들만 그린다 (없으면 파형 탭과 같은 것) */
  only?: Trace[];
  /** 가로 범위 (실제 값). 세로는 그 범위 안의 값에 맞춘다 */
  from?: number;
  to?: number;
}

/** 그래프로 그렸으면 그린 줄기들과 가로 범위. 표(동작점 · .tf)거나 그릴 것이 없으면 null */
type WaveDrawn = { series: Array<{ name: string; color: string }>; axis: string; from: number; to: number } | null;

/**
 * 파형을 그린다. shot 을 주면 화면 밖의 캔버스에 그린다 — 화면의 확대 · 커서 상태(plot)는 건드리지 않는다.
 */
function drawWave(cv: HTMLCanvasElement, legend: HTMLElement, readout: HTMLElement, shot?: WaveShot): WaveDrawn {
  if (!shot) return paintWave(cv, legend, readout);
  const keep = plot;
  try { return paintWave(cv, legend, readout, shot); } finally { plot = keep; }
}

function paintWave(cv: HTMLCanvasElement, legend: HTMLElement, readout: HTMLElement, shot?: WaveShot): WaveDrawn {
  if (!traces) { legend.textContent = "Run (F8) and the waveform shows up here"; readout.textContent = ""; return null; }
  /*
   * 가로축은 해석 종류마다 다르다 (설계서 'DC·AC 확장').
   *   과도   time        선형, ms
   *   AC     frequency   로그, Hz
   *   DC 스윕 v(v-sweep)  선형, V   — ngspice 가 쓸어 올린 값을 이 이름으로 준다
   * 축 이름으로 알아내므로 외부 .sp 를 돌려도 맞게 잡힌다.
   */
  const axis =
    traces.find(t => t.name.toLowerCase() === "time") ??
    traces.find(t => t.name.toLowerCase() === "frequency") ??
    traces.find(t => /sweep/i.test(t.name));
  const axisKind: "time" | "freq" | "sweep" =
    axis?.name.toLowerCase() === "time" ? "time"
    : axis?.name.toLowerCase() === "frequency" ? "freq" : "sweep";
  const time = axis?.values;
  const an = axis?.name.toLowerCase() ?? "";
  sweepUnit = an === "temp-sweep" ? "°C" : an.startsWith("i(") ? "A" : "V";

  const tf = tfTable(traces);
  if (tf) {
    plot = null;
    cv.style.display = "none";
    legend.textContent = "Transfer function (.tf)";
    readout.className = "";
    readout.innerHTML = tf;
    return null;
  }

  // 프로브를 꽂았으면 그 넷만 그리고 색도 프로브 색을 쓴다 (E24).
  // 하나도 없으면 모든 노드 전압을 보여 준다. 결과를 전부 들고 있어서
  // 실행이 끝난 뒤 프로브를 꽂아도 다시 돌리지 않고 바로 그려진다.
  // 가로축 자신은 뺀다 — DC 스윕의 축 이름이 v(v-sweep) 이라 전압처럼 보인다
  /*
   * 서브회로 **안쪽** 노드는 뺀다.
   *
   * SKY130 소자는 .subckt 라서 ngspice 가 `v(m.x1.msky130_fd_pr__pfet_01v8#body)` 같은
   * 내부 노드까지 결과에 담아 준다. 인버터 하나에 그런 줄기가 여섯이라, 그대로 그리면
   * 정작 보고 싶은 v(in)·v(out) 이 묻힌다. 우리가 넷에 붙이는 이름은 늘 영문자·숫자·
   * 밑줄뿐이므로, 점이나 # 가 든 이름은 엔진이 만든 내부 노드다.
   */
  // 계산기가 물은 소자 값도 뺀다 — 엔진이 v(@m1[vds]) 처럼 전압 모양의 이름으로 돌려준다
  const all = traces.filter(t =>
    t !== axis && /^v\(/i.test(t.name) && !/[.#@]/.test(t.name.slice(2, -1)));
  const probed = externalNetlist ? [] : sheet.probes
    .map(p => ({ color: p.color, net: ex.netAt(p.at) }))
    .filter((x): x is { color: string; net: string } => !!x.net)
    .map(x => ({ color: x.color, trace: all.find(t => t.name.toLowerCase() === `v(${x.net.toLowerCase()})`) }))
    .filter((x): x is { color: string; trace: Trace } => !!x.trace);
  /*
   * 프로브가 없으면 노드 전압을 다 그리되 **MAX_TRACES 개까지만.** 노드가 수천 개인 회로에서
   * 전부 그리면 커서를 움직일 때마다 수천 줄을 다시 긋고(1만 줄에 0.6초), 범례가 화면을 덮고,
   * 무엇보다 겹친 선 수천 개는 아무것도 보여 주지 않는다. 몇 개만 그렸는지 범례에 적는다.
   */
  const shown = probed.length ? [] : all.slice(0, shot ? 8 : MAX_TRACES);
  const vs: Array<{ color: string; trace: Trace }> = shot?.only
    ? shot.only.map((t, i) => ({ color: COLORS[i % COLORS.length], trace: t }))
    : probed.length
    ? probed
    : shown.map((t, i) => ({ color: COLORS[i % COLORS.length], trace: t }));
  if (!vs.length) { plot = null; legend.textContent = "There is no voltage to show"; readout.textContent = ""; return null; }

  /*
   * DC 동작점은 점 하나라 그래프가 의미 없다. 표로 보여 준다.
   * .op 결과에는 가로축 벡터가 아예 없어서 축이 아니라 점 개수로 판정한다.
   * 프로브가 없으면 전류까지 같이 보여 준다 — 동작점에서는 그게 보고 싶은 값이다.
   */
  const points = vs[0].trace.values.length;
  if (points <= 1) {
    plot = null;
    cv.style.display = "none";
    legend.textContent = "DC operating point";
    readout.className = "";
    const rows = probed.length
      ? vs.map(({ trace, color }) => ({ name: trace.name, color, v: trace.values[0] }))
      : traces.filter(t => t !== axis && /^[vi]\(/i.test(t.name) && !t.name.includes("@"))
          .map((t, i) => ({ name: t.name, color: COLORS[i % COLORS.length], v: t.values[0] }));
    readout.innerHTML = "<table><tr><th>Name</th><th>Value</th></tr>" +
      rows.map(r =>
        `<tr><td><span class="sw" style="background:${R.css(r.color) || r.color}"></span>${r.name}</td>` +
        `<td class="v">${r.v.toPrecision(6)} ${/^i\(/i.test(r.name) ? "A" : "V"}</td></tr>`).join("") +
      "</table>";
    return null;
  }
  if (!time) { plot = null; legend.textContent = "Could not find the x-axis vector"; readout.textContent = ""; return null; }
  cv.style.display = "";

  /*
   * 크기는 **CSS 가 정한 자리에서 읽어 온다.** 예전에는 높이가 200px 상수여서
   * 아래 패널을 키워도 파형은 그대로였다. 캔버스의 width·height 속성은 그림 버퍼일
   * 뿐이고, 화면에서 차지하는 자리는 CSS 가 정한다 — 둘을 맞춰 줘야 안 흐려진다.
   */
  const dpr = shot ? 1 : window.devicePixelRatio || 1;
  const w = shot?.w ?? (cv.clientWidth || 600), h = shot?.h ?? (cv.clientHeight || 200);
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  // 따로 그리는 그림은 세로 눈금 글자가 길다 (53.1 mV)
  const pad = { l: shot ? 74 : 50, r: shot ? 16 : 10, t: 18, b: 24 };
  const tMin = time[0], tMax = time[time.length - 1];
  // AC 는 10배마다 같은 간격이어야 보기 좋다. 로그는 0 이하를 못 받으니 막아 둔다
  const useLog = axisKind === "freq" && tMin > 0 && tMax > tMin;
  const fwd = (v: number) => useLog ? Math.log10(Math.max(v, tMin)) : v;
  const inv = (a: number) => useLog ? Math.pow(10, a) : a;
  const fullA0 = fwd(tMin), fullA1 = fwd(tMax);
  /*
   * 보는 범위. 화면은 확대해 둔 범위(waveView)를 — 넣을 때 이미 데이터 안으로 눌러 두었다. 따로 그리는
   * 그림은 받은 가로 범위를 보고, 세로는 그 범위 안의 값에 맞춘다 (울림을 보려고 좁혔는데 세로가 전체
   * 범위면 납작하다).
   */
  let view = shot ? null : waveView;
  if (shot && (shot.from !== undefined || shot.to !== undefined)) {
    const x0 = fwd(Math.max(tMin, shot.from ?? tMin)), x1 = fwd(Math.min(tMax, shot.to ?? tMax));
    let lo = Infinity, hi = -Infinity;
    for (const { trace } of vs) {
      for (let i = 0; i < time.length; i++) {
        const a = fwd(time[i]);
        if (a < x0 || a > x1) continue;
        const v = trace.values[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!(hi >= lo)) { lo = 0; hi = 1; }
    const m = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1e-3;
    if (x1 > x0) view = { x0, x1, y0: lo - m, y1: hi + m };
  }
  const a0 = view ? view.x0 : fullA0;
  const a1 = view ? view.x1 : fullA1;
  /*
   * 세로축 범위. AC 크기나 0~5 V 를 쓸어 올린 DC 스윕처럼 값이 다 양수면
   * 아래 절반이 통째로 빈다. 음수가 있을 때만 0 을 가운데 둔다.
   */
  let hi = -Infinity, lo = Infinity;
  for (const { trace } of vs) {
    const r = traceRange(trace);
    hi = Math.max(hi, r.hi);
    lo = Math.min(lo, r.lo);
  }
  const signed = lo < 0;
  const span = Math.max(Math.abs(hi), signed ? Math.abs(lo) : 0, 1e-9);
  const fullTop = Math.ceil(span * 10) / 10 || 1;
  const fullBottom = signed ? -fullTop : 0;
  const top = view ? view.y1 : fullTop;
  const bottom = view ? view.y0 : fullBottom;

  const X = (s: number) => pad.l + (a1 > a0 ? (fwd(s) - a0) / (a1 - a0) : 0) * (w - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v - bottom) / (top - bottom)) * (h - pad.t - pad.b);
  const half = (n: number) => Math.round(n) + 0.5;
  /*
   * 세로 눈금 글자. 화면은 예전 그대로다. 따로 그리는 그림은 범위에 맞는 자릿수로 — 5 V 위의 10 mV 물결을
   * 좁혀 보면 "5.0 V" 셋이 아니라 4.990 · 5.000 · 5.010 이어야 읽힌다. 전류만 그렸으면 A 다.
   */
  const unit = vs.every(x => /^i\(/i.test(x.trace.name)) ? "A" : "V";
  const digits = Math.min(6, Math.max(2, Math.ceil(Math.log10(Math.max(Math.abs(top), Math.abs(bottom)) / ((top - bottom) / 2 || 1))) + 2));
  const fmtV = (v: number) => (shot ? eng(Math.abs(v) < (top - bottom) * 1e-9 ? 0 : v, unit, digits)
    : (Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2)) + " V");

  g.clearRect(0, 0, w, h);
  g.strokeStyle = R.css("--line"); g.fillStyle = R.css("--mut");
  g.lineWidth = 1; g.font = "11px ui-monospace, Consolas, monospace";
  /*
   * 가로 눈금선. 보는 범위의 위·가운데·아래에 긋고, 0 이 그 사이에 있으면 하나 더 긋는다.
   * 확대하지 않았을 때는 예전과 똑같은 자리가 나온다 — 음수가 있으면 가운데가 0 이고,
   * 다 양수면 바닥이 0 이다.
   */
  const yLines = [bottom, (bottom + top) / 2, top];
  if (bottom < 0 && top > 0 && !yLines.some(v => v === 0)) yLines.push(0);
  for (const gv of yLines) {
    const y = half(Y(gv));
    g.globalAlpha = gv === 0 ? 1 : 0.45;
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
    g.globalAlpha = 1;
    g.textAlign = "right"; g.textBaseline = "middle";
    g.fillText(fmtV(gv), pad.l - 6, y);
  }
  /*
   * 눈금 수는 **폭을 보고 정한다.** 다섯으로 고정해 두었더니 폰에서 "0.00 V0.36 V" 처럼
   * 글자끼리 붙어 읽을 수가 없었다. 눈금 하나에 70 px 쯤은 있어야 한다.
   */
  const ticks = Math.max(2, Math.min(5, Math.floor((w - pad.l - pad.r) / 70)));
  const tLabel = timeTicks((view ? inv(a1) - inv(a0) : tMax - tMin), ticks);
  for (let i = 0; i <= ticks; i++) {
    // 끝 눈금은 계산값 대신 실제 양끝을 쓴다 — 로그 되돌리기 오차로 999999.9 Hz 가 되면
    // "1000 kHz" 라고 적히고 가장자리에서 잘린다
    // 확대 중이면 양 끝도 보는 범위의 끝이다. 전체를 볼 때만 원래 값을 그대로 쓴다
    const v = i === 0 ? (view ? inv(a0) : tMin)
      : i === ticks ? (view ? inv(a1) : tMax)
      : inv(a0 + ((a1 - a0) * i) / ticks);
    const x = half(X(v));
    g.globalAlpha = 0.45;
    g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, h - pad.b); g.stroke();
    g.globalAlpha = 1;
    // 양 끝 글자는 가운데 맞추면 캔버스 밖으로 반쯤 나간다
    g.textAlign = i === 0 ? "left" : i === ticks ? "right" : "center";
    g.textBaseline = "top";
    g.fillText(axisLabel(v, axisKind, tLabel), i === 0 ? x - 2 : i === ticks ? x + 2 : x, h - pad.b + 5);
  }

  legend.innerHTML = "";
  // 확대하면 보는 범위 밖의 선이 눈금과 글자 위로 삐져나온다. 그림 영역으로 자른다
  const clipPlot = () => {
    g.save();
    g.beginPath();
    g.rect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b);
    g.clip();
  };
  const viewKey = [w, h, a0, a1, top, bottom, pad.l, pad.r].join(",");
  for (const { trace, color: token } of vs) {
    const color = R.css(token) || token;
    clipPlot();
    g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath();
    const path = tracePath(time, trace, X, Y, viewKey);
    for (let k = 0; k < path.length; k += 2) {
      if (k) g.lineTo(path[k], path[k + 1]); else g.moveTo(path[k], path[k + 1]);
    }
    g.stroke();
    g.restore();

    const el = document.createElement("span");
    // 사인 피팅은 시간축 데이터에서만 뜻이 있다. AC·DC 스윕에서는 재지 않는다
    const amp = axisKind === "time" ? measureAmp(time, trace.values) : null;
    el.innerHTML = `<span class="sw" style="background:${color}"></span>${trace.name}` +
      (amp ? ` ${amp.toFixed(4)} V` : "");
    legend.appendChild(el);
  }
  if (probed.length) {
    const note = document.createElement("span");
    note.textContent = `${probed.length} probes`;
    legend.appendChild(note);
  } else if (all.length > shown.length) {
    const note = document.createElement("span");
    note.textContent = `${shown.length} of ${all.length} nodes — probe the ones to show`;
    legend.appendChild(note);
  }
  if (waveView && !shot) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Reset zoom";
    b.onclick = () => { resetWaveView(); redrawWave(); };
    legend.appendChild(b);
  }

  const drawn: WaveDrawn = {
    series: vs.map(({ trace, color }) => ({ name: trace.name, color: R.css(color) || color })),
    axis: axis?.name ?? "x", from: inv(a0), to: inv(a1),
  };
  if (shot) return drawn;

  // ── 커서 A·B (설계서 사용자 흐름 8단계: "커서 두 개로 진폭과 시간차를 잰다")
  plot = {
    pad, w, h,
    toValue: (f: number) => inv(a0 + (a1 - a0) * f),
    a0, a1, fullA0, fullA1,
    y0: bottom, y1: top, fullY0: fullBottom, fullY1: fullTop,
    fwd, inv,
  };
  const marks: Array<{ name: "A" | "B"; t: number; i: number }> = [];
  for (const [name, t] of [["A", curA], ["B", curB]] as const) {
    if (t === null) continue;
    const i = sampleAt(time, t);
    marks.push({ name, t: time[i], i });
  }

  for (const m of marks) {
    const x = half(X(m.t));
    g.strokeStyle = R.css("--highlight");
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, h - pad.b); g.stroke();
    g.setLineDash([]);
    // 손잡이와 이름
    g.fillStyle = R.css("--highlight");
    g.beginPath();
    g.moveTo(x, pad.t); g.lineTo(x - 5, pad.t - 6); g.lineTo(x + 5, pad.t - 6);
    g.closePath(); g.fill();
    g.font = "10px ui-monospace, Consolas, monospace";
    g.textAlign = "center"; g.textBaseline = "bottom";
    g.fillText(m.name, x, pad.t - 7);
    // 각 선과 만나는 점
    clipPlot();
    for (const { trace, color: token } of vs) {
      g.fillStyle = R.css(token) || token;
      g.beginPath(); g.arc(X(m.t), Y(trace.values[m.i]), 3, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }

  // 끌고 있는 확대 상자
  if (zoomBox) {
    const x = Math.min(zoomBox.x0, zoomBox.x1), y = Math.min(zoomBox.y0, zoomBox.y1);
    const bw = Math.abs(zoomBox.x1 - zoomBox.x0), bh = Math.abs(zoomBox.y1 - zoomBox.y0);
    g.strokeStyle = R.css("--highlight");
    g.fillStyle = R.css("--highlight");
    g.globalAlpha = 0.12;
    g.fillRect(x, y, bw, bh);
    g.globalAlpha = 1;
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    g.strokeRect(half(x), half(y), bw, bh);
    g.setLineDash([]);
  }

  renderReadout(readout, marks, vs, axisKind);
  return drawn;
}

/**
 * 어시스턴트가 보는 파형 — 파형 탭과 같은 그림을 정한 크기로 그리고, 범례를 그림 위에 적는다 (화면의
 * 범례는 HTML 이라 캔버스에 없다).
 */
function wavePicture(opt: { signals?: string[]; from?: number; to?: number }): WavePicture | { error: string } {
  if (!traces) return { error: lastRunError ? `The last run failed: ${lastRunError.split("\n")[0]}` : "Nothing has run yet." };
  if (traces.some(t => t.name.toLowerCase() === "onoise_spectrum")) return { error: "Noise spectra are not drawn here — use read_trace." };
  const only = opt.signals?.map(n => traces!.find(t => t.name === n)).filter((t): t is Trace => !!t);
  const w = 960, h = 420, top = 30;
  const graph = document.createElement("canvas");
  const legend = document.createElement("div"), readout = document.createElement("div");
  const drawn = drawWave(graph, legend, readout, { w, h, only: only?.length ? only : undefined, from: opt.from, to: opt.to });
  if (!drawn) return { error: `${legend.textContent || "The result is not a plot"} — use get_results.` };
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h + top;
  const g = cv.getContext("2d")!;
  g.fillStyle = R.css("--png-bg") || "#12151b";
  g.fillRect(0, 0, cv.width, cv.height);
  g.font = "12px ui-sans-serif, system-ui, sans-serif";
  g.textBaseline = "middle";
  let x = 50;
  for (const sr of drawn.series) {
    g.fillStyle = sr.color;
    g.fillRect(x, top / 2 - 2, 16, 4);
    g.fillStyle = R.theme().text;
    g.fillText(sr.name, x + 21, top / 2);
    x += 21 + g.measureText(sr.name).width + 18;
  }
  g.drawImage(graph, 0, top);
  return { url: cv.toDataURL("image/png"), width: cv.width, height: cv.height, shown: drawn.series.map(x => x.name), axis: drawn.axis, from: drawn.from, to: drawn.to };
}

/** 커서 자리의 값과 차이를 표로 보여 준다 */
function renderReadout(
  el: HTMLElement,
  marks: Array<{ name: "A" | "B"; t: number; i: number }>,
  vs: Array<{ color: string; trace: Trace }>,
  axisKind: "time" | "freq" | "sweep",
) {
  if (!marks.length) {
    el.className = "empty";
    el.textContent = "Drag a box to zoom · wheel zooms, Shift+wheel pans · double-click resets."
      + " Click for cursor A, Shift+click for B.";
    return;
  }
  el.className = "";
  const A = marks.find(m => m.name === "A");
  const B = marks.find(m => m.name === "B");

  const head = ["Net", ...(A ? ["A"] : []), ...(B ? ["B"] : []), ...(A && B ? ["ΔV"] : [])];
  // AC 결과는 크기와 위상이 한 쌍이다. 크기만 적으면 반쪽이라 각도를 같이 붙인다
  const cell = (t: Trace, i: number) =>
    t.values[i].toFixed(4) + " V" + (t.phaseDeg ? ` ∠${t.phaseDeg[i].toFixed(1)}°` : "");
  const rows = vs.map(({ trace, color }) => {
    const c = R.css(color) || color;
    const cells = [`<span class="sw" style="background:${c}"></span>${trace.name}`];
    if (A) cells.push(cell(trace, A.i));
    if (B) cells.push(cell(trace, B.i));
    if (A && B) cells.push((trace.values[B.i] - trace.values[A.i]).toFixed(4) + " V");
    return cells;
  });

  let html = "<table><tr>" + head.map(h => `<th>${h}</th>`).join("") + "</tr>";
  for (const r of rows) html += "<tr>" + r.map((c, i) => `<td${i ? ' class="v"' : ""}>${c}</td>`).join("") + "</tr>";
  // 시간 줄
  const axisName = { time: "Time", freq: "Frequency", sweep: "Sweep" }[axisKind];
  const fmtAxis = (v: number) => axisLabel(v, axisKind);
  const timeCells = [axisName];
  if (A) timeCells.push(fmtAxis(A.t));
  if (B) timeCells.push(fmtAxis(B.t));
  if (A && B) timeCells.push("Δ " + (axisKind === "time" ? fmtTime(B.t - A.t) : fmtAxis(B.t - A.t)));
  html += "<tr>" + timeCells.map((c, i) => `<td${i ? ' class="v"' : ""}>${c}</td>`).join("") + "</tr></table>";
  el.innerHTML = html;
}

/** 사인원이 하나면 그 주파수로 진폭을 재서 범례에 보여 준다 */
/** 프로브가 없을 때 그리는 노드 전압의 최대 개수 (drawWave) */
const MAX_TRACES = 40;

/*
 * 결과는 실행마다 새 배열이라, 배열 하나에 대해 한 번 구한 값은 다시 구할 필요가 없다.
 * 커서를 끌면 파형을 매 프레임 다시 그리는데, 예전에는 그때마다 모든 점을 다시 훑어 범위를
 * 구하고 사인 맞추기를 다시 했다.
 */
const rangeCache = new WeakMap<Trace, { lo: number; hi: number }>();
function traceRange(t: Trace): { lo: number; hi: number } {
  let r = rangeCache.get(t);
  if (!r) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < t.values.length; i++) { const v = t.values[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    rangeCache.set(t, r = { lo, hi });
  }
  return r;
}

/**
 * 한 줄을 그릴 점들 (화면 px). 점이 그림 폭의 두 배보다 많으면 **픽셀 열마다 처음·최소·최대·
 * 마지막** 네 점만 남긴다 — 그 열에서 선이 덮는 픽셀이 그대로라 모양이 바뀌지 않고, 긋는 수가
 * 점 수가 아니라 화면 폭을 따른다 (점 100만 개짜리 과도 해석도 열 수천 개). 보는 범위가 같으면
 * 다시 구하지 않는다.
 */
const pathCache = new WeakMap<Trace, { key: string; path: Float64Array }>();
function tracePath(time: Float64Array, t: Trace, X: (v: number) => number, Y: (v: number) => number, key: string): Float64Array {
  const hit = pathCache.get(t);
  if (hit && hit.key === key) return hit.path;
  const n = time.length, v = t.values;
  const out: number[] = [];
  const width = Math.abs(X(time[n - 1]) - X(time[0]));
  if (n <= width * 2) {
    for (let k = 0; k < n; k++) out.push(X(time[k]), Y(v[k]));
  } else {
    let col = NaN, fx = 0, fy = 0, lx = 0, ly = 0, mn = 0, mx = 0, kmn = 0, kmx = 0;
    const flush = () => {
      out.push(fx, fy);
      const c = Math.floor(fx) + 0.5;
      if (kmn < kmx) out.push(c, mn, c, mx); else out.push(c, mx, c, mn);
      out.push(lx, ly);
    };
    for (let k = 0; k < n; k++) {
      const x = X(time[k]), y = Y(v[k]), c = Math.floor(x);
      if (c !== col) {
        if (k) flush();
        col = c; fx = lx = x; fy = ly = mn = mx = y; kmn = kmx = k;
      } else {
        lx = x; ly = y;
        if (y < mn) { mn = y; kmn = k; }
        if (y > mx) { mx = y; kmx = k; }
      }
    }
    if (n) flush();
  }
  const path = Float64Array.from(out);
  pathCache.set(t, { key, path });
  return path;
}

const ampCache = new WeakMap<Float64Array, { f: number; amp: number | null }>();
function measureAmp(time: Float64Array, v: Float64Array): number | null {
  // 외부 .sp 는 회로도가 없으므로 넷리스트 텍스트에서 주파수를 읽는다
  const f = externalNetlist
    ? sineFreq(externalNetlist)
    : parseEng(sheet.parts.find(p => project.library[p.lib]?.id === "vsin")?.params.freq);
  if (!f) return null;
  const hit = ampCache.get(v);
  if (hit && hit.f === f) return hit.amp;
  const amp = fitAmp(time, v, f);
  ampCache.set(v, { f, amp });
  return amp;
}

function fitAmp(time: Float64Array, v: Float64Array, f: number): number | null {
  const tEnd = time[time.length - 1];
  const from = Math.min(tEnd * 0.2, 10 / f);
  try {
    const fit = fitSine(time, v, f, { from, to: tEnd });
    /*
     * 잔차가 크면 사인이 아니다 (정류·클리핑된 파형). 그때 진폭은 '기본파 성분' 이지
     * 파형의 크기가 아니라서, 그냥 '진폭' 이라고 적으면 틀린 값으로 읽힌다. 안 적는다.
     */
    return fit.rmsResidual > 0.05 * fit.amplitude ? null : fit.amplitude;
  } catch { return null; }
}

// ── .sp 입출력 (E22 · E23 · E28) ──────────────────────────────────────
/**
 * 외부 .sp 를 열었을 때 그 본문. 회로도로는 그리지 않고(E34 는 M4) 그대로 돌린다.
 * null 이면 회로도에서 만든 넷리스트를 쓴다.
 */
let externalNetlist: string | null = null;

function currentNetlist(): string {
  return externalNetlist ?? buildNetlist(sheet, project.library, ex, project.sim, project.name, project.meas);
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function doExport() {
  if (externalNetlist) { download((project.name || "circuit") + ".sp", externalNetlist); return; }
  const sp = await exportSp(project, buildNetlist(sheet, project.library, ex, project.sim, project.name, project.meas));
  download((project.name || "circuit") + ".sp", sp);
}

/**
 * 외부 .sp 를 회로도로 바꿔 연다 (설계서 E34).
 * 옮긴 것과 보존한 것, 경고를 로그 탭에 남긴다 — 무엇이 그려지고 무엇이 안 그려졌는지
 * 알아야 결과를 믿을 수 있다.
 */
function importExternal(text: string) {
  const r = spToProject(text);
  replaceProject(r.project);
  externalNetlist = null;
  simLog = `Turned the external .sp into a schematic — ${r.placed} parts.\n` +
    (r.kept.length
      ? `\n${r.kept.length} lines had no part to map to and were kept in a SPICE directive block:\n` +
        r.kept.map(l => "  " + l).join("\n")
      : "\nEvery line became a part.") +
    (r.warnings.length ? "\n\n" + r.warnings.map(w => "· " + w).join("\n") : "");
  tab = r.warnings.length || r.kept.length ? "log" : "wave";
  fit();
  renderTab(); renderStatus();
}

/** 빈 시트로 새로 시작한다 (설계서 대조표 102번) */
function newProject() {
  if (sheet.parts.length || sheet.wires.length) {
    if (!confirm("Throw away this schematic and start over?\n\nThe autosave is cleared too.")) return;
  }
  replaceProject(emptyProject("untitled"));
  history.clear();
  void autosave.flush(project);
  renderSim();
  fit();
}

async function openFile(f: File) {
  const text = await f.text();

  // .json 은 프로젝트 파일
  if (f.name.endsWith(".json")) {
    replaceProject(JSON.parse(text));
    fit();
    return;
  }

  const loaded = await parseSp(text);
  if (loaded.kind === "external") {
    const scan = scanSp(text);
    // 회로도로 그릴지 넷리스트 그대로 돌릴지 고르게 한다 (설계서 E34 · 불러오기 동작)
    if (confirm(
      `Opened the external .sp "${loaded.title}" — ${scan.lines.length} device and directive lines.\n\n` +
      "[OK] open it as a schematic (auto-placed; lines that cannot move are kept in a directive block)\n" +
      "[Cancel] keep the netlist as text (run the text only)",
    )) {
      importExternal(text);
      return;
    }
    externalNetlist = runnable(loaded.title, loaded.body);
    traces = null;
    simLog = `Opened the external netlist "${loaded.title}".\n` +
      `${scan.lines.length} device and directive lines, ${scan.analyses.length} analyses` +
      (scan.unsupported.length
        ? `\n\n${scan.unsupported.length} lines are not handled yet (kept as is and run):\n` +
          scan.unsupported.map(l => "  " + l).join("\n")
        : "") +
      `\n\nIt runs as is from the Netlist tab. To turn it into a schematic, open it again and press [OK].`;
    tab = "net";
    renderTab(); renderStatus();
    return;
  }

  if (loaded.kind === "drifted") {
    const useSchematic = confirm(
      "This .sp came from here, but the netlist body has changed.\n\n" +
      "[OK] restore the schematic (the text edits are dropped)\n" +
      "[Cancel] use the changed netlist (it then asks whether to redraw the schematic)",
    );
    if (!useSchematic) {
      // 바뀐 텍스트를 기준으로 회로도를 새로 그릴 수도 있다 (설계서 불러오기 동작 M4)
      if (confirm("Redraw the changed netlist as a schematic?\n\n[OK] redraw it with auto-placement\n[Cancel] run the text as is")) {
        importExternal(runnable(loaded.project.name, loaded.body));
        return;
      }
      externalNetlist = runnable(loaded.project.name, loaded.body);
      traces = null;
      simLog = "The netlist body does not match the schematic, so the text is used.\n" +
        `stored hash ${loaded.storedHash.slice(0, 12)}…\n` +
        `actual hash ${loaded.actualHash.slice(0, 12)}…`;
      tab = "net";
      renderTab(); renderStatus();
      return;
    }
  }

  replaceProject(loaded.project);
  fit();
}

// ── 실행 ──────────────────────────────────────────────────────────────
/*
 * 워커와는 sim-client 로 주고받는다. 요청마다 번호가 붙고 답을 기다릴 수 있다 — 실행 버튼과
 * 어시스턴트가 같은 길로 돌리고, 결과는 어느 쪽이 돌렸든 같은 자리(파형 · 측정 · 계산기)에 그려진다.
 */
const sims = new SimClient(() => new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" }));

/**
 * 문서 번호. 커밋마다 하나씩 오른다. 결과에는 돌릴 때의 번호를 적어 두어, 결과가 지금 회로의
 * 것인지(그 뒤로 고친 것이 없는지) 안다 — 어시스턴트가 낡은 결과를 지금 회로의 것으로 읽지 않게.
 */
let docRev = 0;

/** 실행 결과를 화면의 상태로 옮긴다. 누가 돌렸든 같다 */
function applyResult(resp: SimResponse, job: RunJob) {
  if (!resp.ok) {
    measures = [];
    simLog = resp.stopped ? "The simulation was stopped." : translateError(resp.error ?? "");
    lastRunError = simLog;
    tab = "log";
  } else {
    lastRunError = "";
    traces = resp.traces!;
    measures = resp.measures ?? [];
    simLog = (job.note ? job.note + "\n\n" : "") + (resp.log ?? "");
    // 계산기가 읽을 재료. 계산기용 모양(calcRun)은 계산기를 쓸 때 여기서 만든다 (calcHost.run)
    lastResult = { traces, job, measures, unavailable: resp.unavailable ?? [] };
    calcRun = null;
    calcMod?.calcInvalidate();
    // 새 결과는 축의 범위가 다르다. 예전에 확대해 둔 자리를 그대로 쓰면 엉뚱한 데를 본다
    resetWaveView();
    // 측정이나 계산기를 보고 있던 사람은 그것을 보러 돌린 것이다. 거기서 끌어내지 않는다
    if (!(tab === "meas" && measures.length) && tab !== "calc") tab = "wave";
  }
  renderTab(); renderStatus();
}

/** 지난 실행이 실패했으면 그 이유 (간편 모드의 파형 탭이 로그 탭 대신 보여 준다) */
let lastRunError = "";

/**
 * 시뮬레이션을 돌리고 끝날 때까지 기다린다. 실행 전 검사에 걸리면 돌리지 않고 그 문제들을
 * 돌려준다 — 알림 창은 실행 버튼(run)만 띄운다. 어시스턴트는 문제를 글로 받아 고친다.
 */
async function simulate(): Promise<RunOutcome> {
  // 외부 넷리스트를 쓰는 중이면 회로도 검사는 건너뛴다 (E28: .sp 바로 실행)
  if (!externalNetlist) {
    const errs = issues.filter(i => i.level === "error");
    if (errs.length) return { ok: false, stage: "check", issues: errs };
  }
  running = true; renderStatus();
  /*
   * 계산기 줄이 있으면 계산기를 먼저 받는다 — 그 식들이 읽는 소자 값을 이번 실행에 저장해야 한다.
   * 못 받았으면(연결이 끊겼다) 그것 없이 돌린다. 계산기 때문에 시뮬레이션까지 막을 일은 아니다.
   */
  if (!calcMod && (project.calc ?? []).some(l => l.trim())) await loadCalc().catch(() => undefined);
  // 잡음 해석의 결과는 계산기의 그래프로 그린다. 도는 동안 미리 받아 둔다 (못 받으면 그릴 때 다시 받는다)
  if (!calcMod && project.sim.kind === "noise") loadCalc().catch(() => {});
  const job = runJob();
  const resp = await sims.run({ netlist: job.netlist, fallback: job.fallback }, text => {
    simProgress = text; renderStatus();
  });
  simProgress = "";
  running = sims.busy;
  applyResult(resp, job);
  if (resp.ok) return { ok: true, runMs: resp.runMs };
  return { ok: false, stage: resp.stopped ? "stopped" : "engine", error: simLog };
}

/** 실행 버튼 (F8). 문제가 있으면 문제 탭을 열고 알린다 */
function run() {
  if (running) return;
  if (!externalNetlist) {
    const errs = issues.filter(i => i.level === "error");
    if (errs.length) {
      tab = "issue"; renderTab();
      alert("Fix the errors before running:\n" + errs.map(e => "· " + e.message).join("\n"));
      return;
    }
  }
  void simulate();
}

/** 엔진에 보낸 실행 하나. 결과가 돌아왔을 때 그 넷리스트의 소자 표와 해석 종류를 알아야 한다 */
interface RunJob {
  netlist: string;
  /**
   * 계산기가 물은 저장 줄을 통째로 뺀 넷리스트. 엔진에 없는 것을 물어 멈추면 워커는 먼저 그 벡터만
   * 빼고 다시 돌리고, 그것으로 안 되면 이것으로 돌린다 (src/sim-run.ts runWithFallback).
   */
  fallback?: string;
  kind: string | undefined;
  /** 계산기가 저장해 달라고 한 벡터 */
  requested: string[];
  refs: Map<string, string>;
  inoiseUnit: string;
  /** 이번 실행에서 저장을 줄였다면 그 말 (로그 맨 위에 붙인다) */
  note: string;
  /** 돌린 때의 문서 번호 (docRev) */
  rev: number;
}

/** 넷리스트 글의 해석 종류 (외부 .sp 는 해석 설정이 글 안에 있다) */
function analysisKind(netlist: string): Kind | undefined {
  let kind: Kind | undefined;
  for (const m of netlist.matchAll(/^[ \t]*\.(tran|ac|dc|op|noise|tf)\b/gim)) kind = m[1].toLowerCase() as Kind;
  return kind;
}

/**
 * 회로도의 지정자 -> 넷리스트의 SPICE 이름. op-amp U1 은 EU1 으로, SKY130 의 M1 은 XM1 으로 나간다.
 * 계산기에서는 회로도에 보이는 이름으로 부른다 — gm(M1).
 */
function refMap(): Map<string, string> {
  const m = new Map<string, string>();
  if (externalNetlist) return m;
  for (const p of sheet.parts) {
    const sp = project.library[p.lib]?.spice;
    if (sp) m.set(p.ref, spiceName(p.ref, sp.element));
  }
  return m;
}

/**
 * 실제로 엔진에 보내는 넷리스트. 넷리스트 탭·내보내기와 같고, 끝에 실행할 때만 쓰는 줄이
 * 붙는다 — 무엇을 저장할지(.save, src/net/netlist.ts savePlan)와 어느 행렬 풀이기를 쓸지.
 * 내보낸 .sp 에는 붙지 않는다: 데스크톱 ngspice 에서는 예전처럼 전부 저장하고 기본 풀이기를 쓴다.
 *
 * 계산기 식이 읽는 것(소자의 gm · gds …, 가지 전류)도 여기서 저장 줄에 보탠다. ngspice 는 소자
 * 값을 물어야만 저장한다.
 */
function runJob(): RunJob {
  const base = currentNetlist();
  const refs = refMap();
  const nets = new Set(externalNetlist ? [] : [...ex.netNames()].map(n => n.toLowerCase()));
  const kind = externalNetlist ? analysisKind(base) : project.sim.kind;
  const extra = calcMod ? calcMod.calcSaves(project.calc ?? [], calcMod.parseDevices(base, refs), nets, kind) : [];
  // 잡음 해석의 입력이 전류원이면 입력 환산 잡음은 전류 밀도다
  const src = /^[ \t]*\.noise\s+\S+\s+(\S+)/im.exec(base)?.[1] ?? "";
  const job: RunJob = {
    netlist: base, kind, requested: extra, refs, inoiseUnit: /^i/i.test(src) ? "A/√Hz" : "V/√Hz", note: "", rev: docRev,
  };
  if (externalNetlist) {
    // 외부 넷리스트는 저장을 줄이지 않는다. 계산기 것만 보탠다 — 제 .save 가 있으면 그 옆에, 없으면 all 과 함께
    if (extra.length) {
      const own = /^[ \t]*\.save\b/im.test(base);
      job.netlist = beforeEnd(base, chunked([...(own ? [] : ["all"]), ...extra]));
      job.fallback = base;
    }
    return job;
  }
  const probed = sheet.probes.map(p => ex.netAt(p.at)).filter((n): n is string => !!n);
  const plan = savePlan(ex.netNames(), probed, project.meas ?? [], sheet.spice, project.sim.kind, extra);
  job.note = plan.note;
  job.netlist = beforeEnd(base, [...plan.lines, ...solverLines()]);
  if (extra.length) {
    const plain = savePlan(ex.netNames(), probed, project.meas ?? [], sheet.spice, project.sim.kind);
    job.fallback = beforeEnd(base, [...plain.lines, ...solverLines()]);
  }
  return job;
}

// ── 계산기 (src/calc/ · src/ui/calc-panel.ts) ─────────────────────────
/**
 * 지금 회로의 이름들 — 계산기의 본보기 식을 채우고 신호 목록을 만든다. 넷리스트 글에서 읽으므로
 * 회로도든 외부 .sp 든 같은 길이다.
 */
function calcNames(): Names {
  const devs = calcMod ? [...calcMod.parseDevices(currentNetlist(), refMap()).byName.values()] : [];
  const list = (k: string) => devs.filter(d => d.kind === k).map(d => d.ref ?? d.name);
  const nets = externalNetlist
    ? [...new Set(devs.flatMap(d => d.nodes))]
    : [...ex.netNames()].map(n => n.toLowerCase());
  const sim = project.sim;
  return {
    nets: nets.filter(n => n !== "0" && n !== "?"),
    probed: externalNetlist ? [] : sheet.probes.map(p => ex.netAt(p.at)).filter((n): n is string => !!n).map(n => n.toLowerCase()),
    mos: list("mos"), bjt: list("bjt"), diodes: list("diode"),
    // 회로도가 있으면 거기서 읽는다 — AC 크기는 넷리스트에 늘 적히는 것이 아니다 (AC · 잡음 해석일 때만)
    vsrc: externalNetlist
      ? devs.filter(d => d.kind === "vsrc").map(d => ({ name: d.ref ?? d.name, net: d.nodes[0] ?? "", dc: d.dc !== false }))
      : voltageSources(),
    currents: [...list("ind"), ...list("isrc")],
    tstop: sim.kind === "tran" ? parseEng(sim.tstop) ?? undefined : undefined,
    sweep: sim.kind === "dc" ? [parseEng(sim.start) ?? 0, parseEng(sim.stop) ?? 5] : undefined,
    // 회로가 밝힌 자리 (레이아웃 예제) — 넷 이름으로 짐작하는 것보다 먼저다
    roles: externalNetlist ? undefined : project.calcRoles,
  };
}

const calcHost: CalcHost = {
  rows: () => project.calc ?? [],
  // 실행 취소 단계가 된다. 계산기 탭은 이미 그 줄을 보여 준다 — 커밋이 탭을 다시 짓지 않게 적어 둔다
  setRows: rows => { shownCalc = JSON.stringify(rows); edit(setCalc(project, rows)); },
  /*
   * 소자 표는 **돌린 그 넷리스트**에서 만든다 — 결과가 돌아온 뒤에 회로도를 고쳤을 수 있고,
   * gm(M1) 의 M1 은 돌린 회로의 M1 이어야 한다.
   */
  run: () => {
    if (!calcRun && lastResult && calcMod) {
      const { traces: ts, job, measures: ms, unavailable } = lastResult;
      calcRun = calcMod.runFromTraces(ts, {
        kind: job?.kind,
        devices: job ? calcMod.parseDevices(job.netlist, job.refs) : undefined,
        measures: ms,
        unavailable,
        requested: job?.requested,
        inoiseUnit: job?.inoiseUnit,
      });
    }
    return calcRun;
  },
  kept: () => keptRuns,
  keep: name => { const r = calcHost.run(); if (r) keptRuns.set(name, r); },
  drop: name => { keptRuns.delete(name); },
  names: calcNames,
  simKind: () => (externalNetlist ? analysisKind(externalNetlist) : undefined) ?? project.sim.kind,
  css: R.css,
  isRunKey: e => BOUND.get(combo(e))?.id === "sim.run",
  rerun: () => { void run(); },
};

/**
 * 잡음 해석의 결과 — 출력 잡음 밀도와 입력 환산 잡음 밀도. 파형 탭의 그림은 세로가 선형이라
 * 1/f 잡음이 왼쪽 끝에 바늘처럼 서고 나머지는 바닥에 붙는다. 양쪽 다 로그라야 1/f 가 직선으로,
 * 열잡음이 평평한 바닥으로 읽힌다 (Razavi 그림 7.27). 계산기 탭과 같은 그래프를 쓴다.
 */
function renderNoise(body: HTMLElement, ts: readonly Trace[], mod: CalcModule) {
  const box = document.createElement("div");
  box.id = "noiseview";
  body.appendChild(box);
  const freq = ts.find(t => t.name.toLowerCase() === "frequency")?.values;
  // 입력이 전류원이면 입력 환산 잡음은 전류 밀도다
  const inUnit = lastResult?.job?.inoiseUnit ?? "V/√Hz";
  const src: PlotSource = {
    logX: null, logY: null,
    auto: { logX: true, logY: true },
    empty: "The noise analysis returned no spectra",
    xunit: () => "Hz",
    css: R.css,
    note: () => "integrate in the Calculator tab: rmsnoise(onoise, f1, f2)",
    series: () => {
      const out: Series[] = [];
      const add = (key: string, name: string, token: string, unit: string) => {
        const v = ts.find(t => t.name.toLowerCase() === key)?.values;
        if (v && freq) out.push({ name, color: R.css(token), x: freq, y: v, unit });
      };
      add("onoise_spectrum", "Output noise", "--t1", "V/√Hz");
      add("inoise_spectrum", "Input-referred noise", "--t2", inUnit);
      return out;
    },
  };
  noisePlot = mod.mountPlot(box, src);
}

/**
 * 행렬 풀이기. ngspice 기본은 Sparse 1.3 이고, 배포하는 엔진에는 KLU 도 들어 있다.
 * 잰 것 (같은 회로, .save 로 노드 2개만 저장):
 *
 *   SKY130 인버터  100단 (BSIM4  200개)   6.5 s ->   6.5 s   (같다)
 *   SKY130 인버터  300단 (BSIM4  600개)  24.4 s ->  22.2 s
 *   SKY130 인버터  500단 (BSIM4 1000개)  46.3 s ->  39.8 s
 *   SKY130 인버터 1000단 (BSIM4 2000개) 162.7 s -> 101.5 s
 *   RC 사다리 10,000단                     6.2 s ->   7.1 s   (느려진다)
 *   level-1 CMOS 인버터 1000단            11.3 s ->  11.8 s
 *
 * 내부 노드가 많은 서브회로 소자(SKY130)가 많을 때만 이긴다. 작은 회로는 그대로 둔다 —
 * 결과의 마지막 자리까지 예전과 같게.
 */
const KLU_FROM_SKY130 = 400;
function solverLines(): string[] {
  let sky = 0;
  for (const p of sheet.parts) if (SKY130_IDS.includes(project.library[p.lib]?.id ?? "")) sky++;
  return sky >= KLU_FROM_SKY130 ? [".options klu"] : [];
}

/** ngspice 메시지를 사람 말로 (설계서 '오류 번역' 의 축소판) */
function translateError(raw: string): string {
  const s = raw.toLowerCase();
  let hint = "";
  if (s.includes("singular")) hint = "Some net has no path to GND. Check the ground symbols.\n\n";
  else if (s.includes("timestep too small")) hint = "The solver did not converge. Lower the max step or check the circuit.\n\n";
  else if (s.includes("unknown") && s.includes("model")) hint = "A model could not be found.\n\n";
  return hint + raw;
}

// ── 어시스턴트 (src/ai/) ─────────────────────────────────────────────
/*
 * 어시스턴트는 OpenRouter 의 모델로 회로를 같이 만든다. 본체(대화 · 도구 · 패널)는 첫 화면에 싣지
 * 않고 패널을 처음 열 때 받는다 — 키를 넣고 쓰는 사람만 쓴다. 편집기는 이 경계(AssistantHost)로만
 * 건넨다: 어시스턴트의 편집도 edit() 을 거쳐 사람의 편집과 같은 기록 · 자동 저장 · 넷 추출을 탄다.
 */
const assistantHost: AssistantHost = {
  project: () => project,
  sheet: () => sheet,
  library: () => project.library,
  extraction: () => ex,
  index: () => index,
  issues: () => issues,
  netlist: () => currentNetlist(),
  external: () => externalNetlist !== null,
  selection: () => [...selection],
  results: () => (lastResult
    ? { traces: lastResult.traces, measures: lastResult.measures, kind: lastResult.job?.kind, current: lastResult.job?.rev === docRev, log: simLog }
    : null),
  lastError: () => lastRunError,
  projectKey: () => sheet.id,
  edit: (cmd, group) => edit(cmd, [...selection], group),
  undoGroup: () => history.undoGroup,
  undo: () => undo(),
  simulate: () => simulate(),
  stopSimulation: () => { sims.stop(); },
  calcValues: async () => {
    const m = await loadCalc().catch(() => null);
    if (!m) return null;
    return m.evaluateRows(project.calc ?? [], calcHost.run(), keptRuns)
      .map(r => ({ src: r.src, name: r.name, text: m.describe(r), error: r.error, warnings: r.warnings }));
  },
  calcReference: async category => (await loadCalc()).referenceText(category),
  show: (keys, net) => {
    const refs = keys.map(parseRef).filter(r => r.kind === "part" && findById(sheet.parts, r.id));
    if (refs.length || !net) setSelection(refs.map(refKey));
    if (refs.length) fit(refs);
    if (net !== undefined) highlightNet = net;
    staticDirty = overlayDirty = true;
    renderProps(); renderStatus();
  },
  schematicImage: ({ parts }) => schematicPicture(parts),
  waveformImage: opt => wavePicture(opt),
  onChange: fn => { docWatchers.add(fn); return () => { docWatchers.delete(fn); }; },
  // 레이아웃 (Placement · Layout) — 전환 단추가 덩어리를 받아 손잡이를 준다
  layout: () => layoutSwitch ? layoutSwitch.control() : Promise.reject(new Error("The layout editors are not set up.")),
  layoutBrief: () => layoutSwitch?.brief() ?? null,
};

let assistant: AssistantPanel | null = null;
let assistantLoading: Promise<AssistantPanel> | null = null;

function loadAssistant(): Promise<AssistantPanel> {
  assistantLoading ??= import("./ai/assistant.ts").then(
    m => (assistant = m.mountAssistant($("ai"), assistantHost, { close: () => showAssistant(false), stage })),
    err => {
      assistantLoading = null;    // 받다 끊겼으면 다음에 다시 받게 한다
      $("ai").innerHTML = '<div class="ai-boot">The assistant could not be loaded — check the connection and open it again.</div>';
      throw err;
    },
  );
  return assistantLoading;
}

/** 어시스턴트 칸이 보이는가. 좁은 화면에서는 서랍이 열렸는가 */
function assistantVisible(): boolean {
  return narrow() ? $("ai").classList.contains("open") : panels.ai;
}

/** 어시스턴트 칸을 열거나 닫는다. 좁은 화면에서는 서랍이다 (다른 서랍은 닫는다) */
function showAssistant(on: boolean) {
  if (narrow()) {
    for (const [b, p] of [["t-lib", "lib"], ["t-props", "props"]] as const) { $(p).classList.remove("open"); $(b).classList.remove("on"); }
    $("ai").classList.toggle("open", on);
    $("t-ai").classList.toggle("on", on);
    resize();
  } else {
    panels.ai = on;
    applyPanels();
  }
  if (on) loadAssistant().then(p => p.shown(), () => {});
  else stage.focus();
}

const toggleAssistant = () => showAssistant(!assistantVisible());

/** 오른쪽 버튼 메뉴의 '어시스턴트에게 묻기' 가 가리킬 것: 누른 부품, 고른 부품들, 아니면 누른 넷 */
function askSubject(hit: Ref | null, net: string | null): { label: string; text: string } | null {
  const clicked = hit?.kind === "part" ? findById(sheet.parts, hit.id) : undefined;
  const parts = clicked ? [clicked] : selParts();
  if (parts.length) {
    const label = parts.slice(0, 3).map(p => p.ref).join(", ") + (parts.length > 3 ? ` +${parts.length - 3}` : "");
    const desc = parts.slice(0, 6).map(p => {
      const lib = project.library[p.lib];
      const value = p.params.value ?? "";
      return `${p.ref} (${lib?.name ?? p.lib}${value ? " " + value : ""})`;
    }).join(", ") + (parts.length > 6 ? ` and ${parts.length - 6} more` : "");
    return { label, text: `About ${desc}: ` };
  }
  if (net) return { label: `net ${net}`, text: `About the net ${net}: ` };
  return null;
}

/** 어시스턴트를 열고 입력 칸에 물음의 앞부분을 적어 둔다 */
function prefillAssistant(text: string) {
  showAssistant(true);
  loadAssistant().then(p => p.prefill(text), () => {});
}

/** 어시스턴트에게 묻는다 (문제 탭 · 로그 탭의 버튼) */
function askAssistant(text: string, shown: string) {
  showAssistant(true);
  loadAssistant().then(p => p.ask(text, shown), () => {});
}

function askButton(label: string, text: string, shown: string): HTMLElement {
  const b = document.createElement("button");
  b.className = "btn ask";
  b.type = "button";
  b.innerHTML = icon("assistant", 13) + `<span>${label}</span>`;
  b.onclick = () => askAssistant(text, shown);
  return b;
}

const whyFailedPrompt = () =>
  "The last simulation failed with this message:\n" + lastRunError.slice(0, 3000) +
  "\nFind the cause in the circuit or the analysis settings, fix it, and run the simulation again to confirm.";

$("t-ai").onclick = toggleAssistant;
$("m-simple").onclick = () => setMode("simple");
$("m-edit").onclick = () => setMode("edit");

// ── 시작 ──────────────────────────────────────────────────────────────
applyMode();
/*
 * 지난번에 어시스턴트를 열어 두었거나, OpenRouter 연결 화면에서 막 돌아왔으면(?code= — 키를 받아야
 * 한다) 첫 화면을 그린 뒤에 어시스턴트를 받는다. 검증 값의 이름은 src/ai/openrouter.ts 와 같다.
 */
{
  let returning = false;
  try { returning = new URLSearchParams(location.search).has("code") && !!sessionStorage.getItem("melange.openrouter-pkce"); } catch { /* 없다 */ }
  if (returning) setTimeout(() => showAssistant(true), 0);
  else if (panels.ai && !narrow()) setTimeout(() => { loadAssistant().then(p => p.shown(), () => {}); }, 0);
}
resize();
renderSim();
commit();
syncToolbar();
requestAnimationFrame(frame);

// 지난번에 그리던 것을 되살린다. 저장소를 못 읽어도 빈 시트로 계속 간다
void AutoSave.load().then(saved => {
  if (!saved) return;
  replaceProject(saved);
  renderSim();
  fit();
});

// 탭을 떠날 때 남은 변경을 밀어 넣는다 (2초 타이머를 기다리지 않도록)
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void autosave.flush(project);
});
