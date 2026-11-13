/**
 * 스파이크 B — 손맛이 파라미터 표로 통제되는지 확인한다.
 * 문서 모델도 실행 취소도 넷 추출도 없다. 오직 "딱 붙는가".
 */
import { DEFAULT_PROFILE, PRESETS, type FeelProfile } from "./feel/profile.ts";
import { resolveSnap, snapRadiusPx, type Pt, type SnapTarget } from "./feel/snap.ts";
import { toScreen, toWorld, zoomAt, wheelFactor, type Viewport } from "./feel/viewport.ts";

const GRID = 10; // 월드 단위 (= 100 mil)
let P: FeelProfile = { ...DEFAULT_PROFILE };

// ── 데모 씬 ────────────────────────────────────────────────────────────
type PartKind = "R" | "C" | "V";
interface Part { id: string; kind: PartKind; at: Pt; rot: 0 | 90 }

const PINS: Record<PartKind, Pt[]> = {
  R: [[-20, 0], [20, 0]],
  C: [[0, -20], [0, 20]],
  V: [[0, -20], [0, 20]],
};

const parts: Part[] = [
  { id: "V1", kind: "V", at: [-60, 0], rot: 0 },
  { id: "R1", kind: "R", at: [0, -40], rot: 0 },
  { id: "C1", kind: "C", at: [60, 0], rot: 0 },
  { id: "R2", kind: "R", at: [0, 60], rot: 0 },
  { id: "R3", kind: "R", at: [120, -40], rot: 0 },
  { id: "C2", kind: "C", at: [180, 0], rot: 0 },
  { id: "R4", kind: "R", at: [120, 60], rot: 0 },
  { id: "V2", kind: "V", at: [-60, 100], rot: 0 },
];

const wires: Pt[][] = [
  [[-60, -20], [-60, -40], [-20, -40]],
  [[20, -40], [60, -40], [60, -20]],
  [[60, 20], [60, 60], [20, 60]],
];

const rot = (p: Pt, r: 0 | 90): Pt => (r === 0 ? p : [-p[1], p[0]]);

const pinWorld = (pt: Part, i: number): Pt => {
  const r = rot(PINS[pt.kind][i], pt.rot);
  return [pt.at[0] + r[0], pt.at[1] + r[1]];
};

function closestOnSeg(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  if (L === 0) return a;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L));
  return [a[0] + t * dx, a[1] + t * dy];
}

function onSeg(p: Pt, a: Pt, b: Pt): boolean {
  const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
  if (Math.abs(cross) > 1e-9) return false;
  return p[0] >= Math.min(a[0], b[0]) - 1e-9 && p[0] <= Math.max(a[0], b[0]) + 1e-9
    && p[1] >= Math.min(a[1], b[1]) - 1e-9 && p[1] <= Math.max(a[1], b[1]) + 1e-9;
}

/** 커서 주변의 스냅 후보. 진짜 구현에서는 공간 색인이 이 역할을 한다 */
function candidatesNear(c: Pt, radWorld: number): SnapTarget[] {
  const out: SnapTarget[] = [];
  const near = (p: Pt) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= radWorld * 3;
  for (const pt of parts) {
    for (let i = 0; i < PINS[pt.kind].length; i++) {
      const w = pinWorld(pt, i);
      if (near(w)) out.push({ kind: "pin", at: w, ref: pt.id + "." + i });
    }
  }
  wires.forEach((w, wi) => {
    for (const e of [w[0], w[w.length - 1]]) {
      if (near(e)) out.push({ kind: "wireEnd", at: e, ref: "w" + wi + ".end." + e[0] + "," + e[1] });
    }
    for (let i = 0; i < w.length - 1; i++) {
      const q = closestOnSeg(c, w[i], w[i + 1]);
      // 선분 위의 점도 격자에 맞춘다 — 설계서상 꺾점은 항상 격자 위다
      const g: Pt = [Math.round(q[0] / GRID) * GRID, Math.round(q[1] / GRID) * GRID];
      if (near(g) && onSeg(g, w[i], w[i + 1])) out.push({ kind: "wireSeg", at: g, ref: "w" + wi + ".s" + i });
    }
  });
  return out;
}

// ── 상태 ──────────────────────────────────────────────────────────────
let vp: Viewport = { at: [-200, -120], scale: 2 };
let tool: "select" | "wire" = "select";
let cursorScreen: Pt = [0, 0];
let snap: SnapTarget | null = null;
let snapLostAt = 0, lastSnapRef = "";
let hoverPart: Part | null = null;
let drag: { part: Part; grabWorld: Pt; origin: Pt } | null = null;
let pan: { from: Pt; at: Pt } | null = null;
let down: { screen: Pt; button: number; moved: boolean } | null = null;
let wireDraft: Pt[] | null = null;
let bendMode: "h" | "v" = "h";

// 계측
let moveStamp = 0, latency = 0;
let flick: number[] = [], frames: number[] = [];
let staticDirty = true, overlayDirty = true;

const stage = document.getElementById("stage") as HTMLDivElement;
const cvS = document.getElementById("static") as HTMLCanvasElement;
const cvO = document.getElementById("overlay") as HTMLCanvasElement;
const gS = cvS.getContext("2d")!, gO = cvO.getContext("2d")!;
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = window.devicePixelRatio || 1;
  W = stage.clientWidth; H = stage.clientHeight;
  for (const c of [cvS, cvO]) {
    c.width = Math.round(W * DPR);
    c.height = Math.round(H * DPR);
  }
  gS.setTransform(DPR, 0, 0, DPR, 0, 0);
  gO.setTransform(DPR, 0, 0, DPR, 0, 0);
  staticDirty = overlayDirty = true;
  // 모듈이 실행되는 시점에는 flex 레이아웃이 아직 안 잡혀 clientWidth 가 0 이다.
  // 실제 크기를 처음 받았을 때 맞춤을 건다.
  if (!fitted && W > 0 && H > 0) { fitted = true; fitAll(); }
}
let fitted = false;
new ResizeObserver(resize).observe(stage);

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const half = (n: number) => Math.round(n) + 0.5;
const lw = (base: number) => Math.max(base, base * Math.min(vp.scale / 2, 2));

// ── 정적 레이어: 문서가 바뀔 때만 그린다 ────────────────────────────────
function drawStatic() {
  gS.clearRect(0, 0, W, H);
  const gridPx = GRID * vp.scale;
  const o = toScreen(vp, [0, 0]);

  if (gridPx >= 6) {
    gS.fillStyle = css("--grid2");
    const x0 = ((o[0] % gridPx) + gridPx) % gridPx;
    const y0 = ((o[1] % gridPx) + gridPx) % gridPx;
    for (let x = x0; x < W; x += gridPx) {
      for (let y = y0; y < H; y += gridPx) gS.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
  }

  gS.strokeStyle = css("--grid");
  gS.lineWidth = 1;
  gS.beginPath();
  gS.moveTo(half(o[0]), 0); gS.lineTo(half(o[0]), H);
  gS.moveTo(0, half(o[1])); gS.lineTo(W, half(o[1]));
  gS.stroke();

  gS.strokeStyle = css("--wire");
  gS.lineWidth = lw(1.4);
  gS.lineJoin = "round"; gS.lineCap = "round";
  for (const w of wires) {
    gS.beginPath();
    w.forEach((p, i) => {
      const s = toScreen(vp, p);
      if (i) gS.lineTo(s[0], s[1]); else gS.moveTo(s[0], s[1]);
    });
    gS.stroke();
  }

  for (const p of parts) drawPart(gS, p, css("--part"));
}

function drawPart(g: CanvasRenderingContext2D, pt: Part, color: string) {
  const s = vp.scale;
  const c = toScreen(vp, pt.at);
  g.save();
  g.translate(c[0], c[1]);
  if (pt.rot) g.rotate(Math.PI / 2);
  g.strokeStyle = color;
  g.lineWidth = lw(1.3);
  g.lineCap = "round";
  g.beginPath();
  if (pt.kind === "R") {
    g.moveTo(-20 * s, 0); g.lineTo(-10 * s, 0);
    g.rect(-10 * s, -5 * s, 20 * s, 10 * s);
    g.moveTo(10 * s, 0); g.lineTo(20 * s, 0);
  } else if (pt.kind === "C") {
    g.moveTo(0, -20 * s); g.lineTo(0, -3 * s);
    g.moveTo(-9 * s, -3 * s); g.lineTo(9 * s, -3 * s);
    g.moveTo(-9 * s, 3 * s); g.lineTo(9 * s, 3 * s);
    g.moveTo(0, 3 * s); g.lineTo(0, 20 * s);
  } else {
    g.moveTo(0, -20 * s); g.lineTo(0, -10 * s);
    g.moveTo(0, 10 * s); g.lineTo(0, 20 * s);
    // arc 는 현재 점에서 호 시작점까지 선을 잇는다. 시작점으로 옮겨 그 선을 없앤다
    g.moveTo(10 * s, 0);
    g.arc(0, 0, 10 * s, 0, Math.PI * 2);
  }
  g.stroke();
  g.restore();

  g.fillStyle = css("--pin");
  for (let i = 0; i < PINS[pt.kind].length; i++) {
    const w = toScreen(vp, pinWorld(pt, i));
    g.beginPath();
    g.arc(w[0], w[1], Math.max(1.5, lw(1.6)), 0, Math.PI * 2);
    g.fill();
  }

  if (s > 1.2) {
    g.fillStyle = css("--mut");
    g.font = Math.min(13, 5.5 * s) + "px ui-sans-serif, system-ui";
    g.textAlign = "center"; g.textBaseline = "bottom";
    g.fillText(pt.id, c[0], c[1] - 11 * s);
  }
}

/** 꺾임 방향에 히스테리시스를 준다. 대각선에서 커서를 흔들 때 펄럭이지 않게 */
function bendPath(from: Pt, to: Pt): Pt[] {
  const dx = Math.abs(to[0] - from[0]) * vp.scale;
  const dy = Math.abs(to[1] - from[1]) * vp.scale;
  if (bendMode === "h" && dy - dx > P.bendAxisHysteresisPx) bendMode = "v";
  else if (bendMode === "v" && dx - dy > P.bendAxisHysteresisPx) bendMode = "h";
  const corner: Pt = bendMode === "h" ? [to[0], from[1]] : [from[0], to[1]];
  return [corner, to];
}

// ── 오버레이: 커서가 움직일 때만. 회로는 다시 안 그린다 ──────────────────
function drawOverlay(now: number) {
  gO.clearRect(0, 0, W, H);

  if (drag) drawPart(gO, drag.part, css("--snap"));
  else if (hoverPart) drawPart(gO, hoverPart, css("--snap"));

  if (wireDraft && snap) {
    const pts = [...wireDraft, ...bendPath(wireDraft[wireDraft.length - 1], snap.at)];
    gO.strokeStyle = css("--wire");
    gO.globalAlpha = 0.55;
    gO.lineWidth = lw(1.4);
    gO.lineJoin = "round"; gO.lineCap = "round";
    gO.beginPath();
    pts.forEach((p, i) => {
      const s = toScreen(vp, p);
      if (i) gO.lineTo(s[0], s[1]); else gO.moveTo(s[0], s[1]);
    });
    gO.stroke();
    gO.globalAlpha = 1;
  }

  // 스냅 표시 — 위치는 보간하지 않고, 사라질 때만 페이드
  let alpha = 1;
  let shown: SnapTarget | null = snap;
  if (!snap && lastSnapRef) {
    const t = now - snapLostAt;
    if (t < P.snapIndicatorFadeOutMs) alpha = 1 - t / P.snapIndicatorFadeOutMs;
    else { lastSnapRef = ""; shown = null; alpha = 0; }
  }

  if (shown && alpha > 0) {
    const s = toScreen(vp, shown.at);
    const r = snapRadiusPx(P, GRID * vp.scale);
    gO.globalAlpha = alpha;
    gO.strokeStyle = shown.kind === "grid" ? css("--mut") : css("--snap");
    gO.lineWidth = 1.5;
    gO.beginPath();
    gO.arc(s[0], s[1], shown.kind === "grid" ? 3.5 : 6, 0, Math.PI * 2);
    gO.stroke();
    if (shown.kind !== "grid") {
      gO.globalAlpha = alpha * 0.18;
      gO.beginPath();
      gO.arc(s[0], s[1], r, 0, Math.PI * 2);
      gO.stroke();
      gO.globalAlpha = alpha;
      gO.fillStyle = css("--snap");
      gO.font = "10px ui-monospace, Consolas, monospace";
      gO.textAlign = "left"; gO.textBaseline = "bottom";
      gO.fillText(shown.kind, s[0] + 9, s[1] - 6);
    }
    gO.globalAlpha = 1;
  }
}

// ── 입력 ──────────────────────────────────────────────────────────────
const local = (e: PointerEvent | WheelEvent): Pt => {
  const r = stage.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function updateSnap() {
  const world = toWorld(vp, cursorScreen);
  const radWorld = snapRadiusPx(P, GRID * vp.scale) / vp.scale;
  const res = resolveSnap(world, candidatesNear(world, radWorld), snap, P, vp.scale, GRID);
  if (snap && res.target.ref !== snap.ref) flick.push(performance.now());
  snap = res.target;
  lastSnapRef = res.target.ref;
}

stage.addEventListener("pointerdown", (e) => {
  stage.setPointerCapture(e.pointerId);
  down = { screen: local(e), button: e.button, moved: false };
  if (e.button === 0 && tool === "wire") {
    cursorScreen = local(e);
    updateSnap();
    if (!wireDraft) {
      wireDraft = [snap!.at];
    } else {
      wireDraft.push(...bendPath(wireDraft[wireDraft.length - 1], snap!.at));
      if (snap!.kind === "pin" || snap!.kind === "wireEnd") {
        wires.push(wireDraft);
        wireDraft = null;
        staticDirty = true;
      }
    }
    overlayDirty = true;
  }
});

stage.addEventListener("pointermove", (e) => {
  moveStamp = e.timeStamp;
  cursorScreen = local(e);

  if (down && !down.moved && dist(cursorScreen, down.screen) > P.dragThresholdPx) {
    down.moved = true;
    if (down.button === 2 || down.button === 1) {
      pan = { from: down.screen, at: [vp.at[0], vp.at[1]] };
    } else if (down.button === 0 && tool === "select" && hoverPart) {
      drag = { part: hoverPart, grabWorld: toWorld(vp, down.screen), origin: [hoverPart.at[0], hoverPart.at[1]] };
    }
  }

  if (pan) {
    const dx = cursorScreen[0] - pan.from[0], dy = cursorScreen[1] - pan.from[1];
    vp = { scale: vp.scale, at: [pan.at[0] - dx / vp.scale, pan.at[1] - dy / vp.scale] };
    staticDirty = overlayDirty = true;
    return;
  }

  updateSnap();

  if (drag) {
    // 원점을 격자에 맞춘다 — 핀 오프셋이 격자 배수라 핀도 격자 위에 남는다
    const g = toWorld(vp, cursorScreen);
    const dxw = g[0] - drag.grabWorld[0], dyw = g[1] - drag.grabWorld[1];
    drag.part.at = [
      Math.round((drag.origin[0] + dxw) / GRID) * GRID,
      Math.round((drag.origin[1] + dyw) / GRID) * GRID,
    ];
    staticDirty = true;
  } else {
    const w = toWorld(vp, cursorScreen);
    const r = 14 / vp.scale;
    hoverPart = parts.find((p) =>
      Math.abs(p.at[0] - w[0]) < 20 + r && Math.abs(p.at[1] - w[1]) < 14 + r) ?? null;
  }
  overlayDirty = true;
});

stage.addEventListener("pointerup", () => {
  down = null;
  pan = null;
  if (drag) { drag = null; staticDirty = true; }
  overlayDirty = true;
});

stage.addEventListener("contextmenu", (e) => e.preventDefault());

stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  vp = zoomAt(vp, local(e), wheelFactor(e, P), P);
  staticDirty = overlayDirty = true;
}, { passive: false });

addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement)?.tagName === "INPUT") return;
  // 물리 키로 판정 — 한글 상태에서도 동작한다
  if (e.code === "KeyW") { tool = "wire"; wireDraft = null; }
  else if (e.code === "Escape") { if (wireDraft) wireDraft = null; else tool = "select"; }
  else if (e.code === "KeyK") fitAll();
  else return;
  stage.style.cursor = tool === "wire" ? "crosshair" : "default";
  overlayDirty = true;
});

function fitAll() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Pt) => {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  };
  for (const p of parts) for (let i = 0; i < PINS[p.kind].length; i++) add(pinWorld(p, i));
  for (const w of wires) w.forEach(add);
  const m = 50;
  const scale = Math.max(P.zoomMin, Math.min(P.zoomMax,
    Math.min((W - m * 2) / (x1 - x0), (H - m * 2) / (y1 - y0))));
  vp = { scale, at: [x0 - (W / scale - (x1 - x0)) / 2, y0 - (H / scale - (y1 - y0)) / 2] };
  staticDirty = overlayDirty = true;
}

// ── 프레임 ────────────────────────────────────────────────────────────
function frame(now: number) {
  if (staticDirty) { drawStatic(); staticDirty = false; }
  if (overlayDirty) {
    drawOverlay(now);
    if (moveStamp) { latency = now - moveStamp; moveStamp = 0; }
    overlayDirty = false;
  }
  frames.push(now);
  while (frames.length && now - frames[0] > 1000) frames.shift();
  while (flick.length && now - flick[0] > 1000) flick.shift();
  updateStats();
  requestAnimationFrame(frame);
}

// ── 패널 ──────────────────────────────────────────────────────────────
const SLIDERS: Array<[keyof FeelProfile, string, number, number, number]> = [
  ["snapRadiusPx", "Snap radius", 4, 24, 1],
  ["snapBreakMultiplier", "Hysteresis factor", 1, 3, 0.1],
  ["snapTierBonusPx", "Tier bonus", 0, 20, 1],
  ["dragThresholdPx", "Drag threshold", 1, 12, 1],
  ["bendAxisHysteresisPx", "Corner hysteresis", 0, 20, 1],
  ["snapIndicatorFadeOutMs", "Marker fade-out", 0, 400, 10],
  ["zoomStepPerNotch", "Wheel step zoom", 1.05, 1.4, 0.01],
];

const slidersEl = document.getElementById("sliders")!;
const hystEl = document.getElementById("hyst") as HTMLInputElement;
let hystSaved = DEFAULT_PROFILE.snapBreakMultiplier;

function buildSliders() {
  slidersEl.innerHTML = "";
  for (const [key, label, min, max, step] of SLIDERS) {
    const l = document.createElement("label");
    const row = document.createElement("span");
    row.className = "row";
    const name = document.createElement("span");
    name.textContent = label;
    const val = document.createElement("b");
    val.textContent = String(P[key]);
    row.append(name, val);
    const r = document.createElement("input");
    r.type = "range";
    r.min = String(min); r.max = String(max); r.step = String(step);
    r.value = String(P[key]);
    r.oninput = () => {
      (P as unknown as Record<string, number>)[key] = parseFloat(r.value);
      val.textContent = r.value;
      if (key === "snapBreakMultiplier") {
        hystSaved = P.snapBreakMultiplier;
        hystEl.checked = P.snapBreakMultiplier > 1;
      }
      overlayDirty = true;
    };
    l.append(row, r);
    slidersEl.appendChild(l);
  }
}
buildSliders();

const presetsEl = document.getElementById("presets")!;
for (const name of Object.keys(PRESETS)) {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = () => {
    P = { ...PRESETS[name] };
    hystSaved = P.snapBreakMultiplier;
    hystEl.checked = P.snapBreakMultiplier > 1;
    buildSliders();
    Array.from(presetsEl.children).forEach((c) => c.classList.toggle("on", c === b));
    overlayDirty = true;
  };
  if (name === "Default") b.classList.add("on");
  presetsEl.appendChild(b);
}

hystEl.onchange = () => {
  if (hystEl.checked) P.snapBreakMultiplier = hystSaved > 1 ? hystSaved : 1.8;
  else { hystSaved = P.snapBreakMultiplier; P.snapBreakMultiplier = 1.0; }
  buildSliders();
  overlayDirty = true;
};

const statsEl = document.getElementById("stats")!;
function updateStats() {
  const r = snapRadiusPx(P, GRID * vp.scale);
  statsEl.innerHTML =
    '<tr><td>Input→screen</td><td' + (latency > 16 ? ' class="warn"' : "") + ">" + latency.toFixed(1) + " ms</td></tr>" +
    "<tr><td>fps</td><td>" + frames.length + "</td></tr>" +
    '<tr><td>Snap flips (1 s)</td><td' + (flick.length > 3 ? ' class="warn"' : "") + ">" + flick.length + "</td></tr>" +
    "<tr><td>Effective radius</td><td>" + r.toFixed(1) + " px</td></tr>" +
    "<tr><td>Zoom</td><td>" + vp.scale.toFixed(2) + "× (grid " + (GRID * vp.scale).toFixed(0) + " px)</td></tr>" +
    "<tr><td>Snap target</td><td>" + (snap ? snap.kind : "—") + "</td></tr>" +
    "<tr><td>Tool</td><td>" + (tool === "wire" ? "Wire (W)" : "Select") + "</td></tr>";
}

resize();
requestAnimationFrame(frame);
