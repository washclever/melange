/**
 * 작은 그래프. 계산기 탭의 파형과, 파형 탭의 잡음 스펙트럼이 같이 쓴다.
 *
 * 파형 탭의 그림(src/app.ts drawWave)과 따로 둔 까닭: 그쪽은 실행 결과의 한 축에 묶여 있다 — 가로는
 * 해석이 정한 축이고 세로는 전압이다. 계산기의 결과는 축이 제각각이다. 과도 해석에서 fft() 를 하면
 * 가로가 주파수가 되고, db20() 은 dB, 잡음 밀도는 세로까지 로그라야 읽힌다(1/f 가 직선이 된다).
 *
 * 그리는 함수는 상태를 두지 않는다. 그릴 것을 받아 그리고, 화면 좌표를 값으로 되돌릴 기하를 돌려준다.
 */
import { eng } from "../calc/format.ts";

export interface Series {
  name: string;
  /** CSS 색 (변수 이름이 아니라 값) */
  color: string;
  x: Float64Array;
  y: Float64Array;
  /** 이어진 곡선이 아니라 점들 (sample · periods). 점을 찍고 옅은 선으로 잇는다 */
  points?: boolean;
  unit: string;
  /** 오른쪽 세로축에 올린다 (왼쪽 축과 단위가 다른 줄기 — 이득 옆의 위상) */
  right?: boolean;
}

export interface PlotOpts {
  logX: boolean;
  logY: boolean;
  xunit: string;
  /** 커서 자리 (x 값). 없으면 null */
  hover: number | null;
  colors: { line: string; text: string; cursor: string };
}

export interface PlotGeom {
  /** 캔버스 안의 화면 x(px) -> x 값. 그림 영역 밖이면 null */
  xAt(px: number): number | null;
}

/** 1 · 2 · 5 로 떨어지는 눈금 */
function niceTicks(lo: number, hi: number, count: number): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}

/** 로그 눈금: 10의 거듭제곱. 범위가 넓으면 몇 칸씩 건너뛴다 */
function decadeTicks(lo: number, hi: number, count: number): number[] {
  const a = Math.ceil(lo - 1e-9), b = Math.floor(hi + 1e-9);
  const every = Math.max(1, Math.ceil((b - a + 1) / Math.max(1, count)));
  const out: number[] = [];
  for (let e = a; e <= b; e += every) out.push(e);
  return out;
}

const finite = (v: number): boolean => Number.isFinite(v);

/** 값의 범위. 로그 축이면 양수만 본다 */
function extent(series: readonly Series[], pick: (s: Series) => Float64Array, log: boolean): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (const s of series) {
    const a = pick(s);
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (!finite(v) || (log && !(v > 0))) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** 로그 축을 쓸 수 있는가: 양수 값이 있고 범위가 한 자리 수 이상 */
export function canLog(series: readonly Series[], pick: (s: Series) => Float64Array): boolean {
  const e = extent(series, pick, true);
  return !!e && e[1] > e[0];
}

/**
 * 한 줄기를 그릴 화면 점들. 점이 그림 폭의 두 배보다 많으면 픽셀 열마다 처음 · 최소 · 최대 · 마지막만
 * 남긴다 (파형 탭의 tracePath 와 같은 생각 — 그 열에서 선이 덮는 픽셀이 그대로다).
 */
function path(s: Series, X: (v: number) => number, Y: (v: number) => number, width: number): number[] {
  const n = Math.min(s.x.length, s.y.length);
  const out: number[] = [];
  if (n <= width * 2) {
    for (let k = 0; k < n; k++) {
      const x = X(s.x[k]), y = Y(s.y[k]);
      out.push(x, y);
    }
    return out;
  }
  let col = NaN, fx = 0, fy = 0, lx = 0, ly = 0, mn = 0, mx = 0, kmn = 0, kmx = 0, open = false;
  const flush = () => {
    out.push(fx, fy);
    const c = Math.floor(fx) + 0.5;
    if (kmn < kmx) out.push(c, mn, c, mx); else out.push(c, mx, c, mn);
    out.push(lx, ly);
  };
  for (let k = 0; k < n; k++) {
    const x = X(s.x[k]), y = Y(s.y[k]);
    if (!finite(x) || !finite(y)) continue;
    const c = Math.floor(x);
    if (c !== col) {
      if (open) flush();
      col = c; fx = lx = x; fy = ly = mn = mx = y; kmn = kmx = k; open = true;
    } else {
      lx = x; ly = y;
      if (y < mn) { mn = y; kmn = k; }
      if (y > mx) { mx = y; kmx = k; }
    }
  }
  if (open) flush();
  return out;
}

/** 세로축 하나의 눈금자 */
interface Scale { y0: number; y1: number; log: boolean; unit: string; ticks: number[] }

/** 줄기들의 값 범위로 세로 눈금자를 만든다 */
function makeScale(series: readonly Series[], log: boolean, unit: string, h: number): Scale | null {
  const ey = extent(series, s => s.y, log);
  if (!ey) return null;
  const f = (v: number) => (log ? Math.log10(v) : v);
  let y0 = f(ey[0]), y1 = f(ey[1]);
  if (y1 === y0) {
    // 평평한 선: 값의 크기만큼 위아래를 연다 (0 이면 ±1)
    const d = log ? 0.5 : Math.abs(y0) * 0.1 || 1;
    y0 -= d; y1 += d;
  } else if (!log) {
    const m = (y1 - y0) * 0.06;
    // 0 에서 시작하는 양수 데이터는 바닥을 0 에 붙인다 — 스펙트럼 · 크기가 떠 보이지 않게
    y0 = ey[0] >= 0 && ey[0] < (y1 - y0) * 0.25 ? 0 : y0 - m;
    y1 += m;
  } else { const m = 0.05 * (y1 - y0); y0 -= m; y1 += m; }
  const count = Math.max(2, Math.floor(h / 34));
  return { y0, y1, log, unit, ticks: log ? decadeTicks(y0, y1, count) : niceTicks(y0, y1, count) };
}

export function drawPlot(cv: HTMLCanvasElement, series: readonly Series[], o: PlotOpts): PlotGeom | null {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 400, h = cv.clientHeight || 180;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const g = cv.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!series.length) return null;

  const ex = extent(series, s => s.x, o.logX);
  if (!ex) return null;
  /*
   * 세로축은 둘까지: 왼쪽과 오른쪽. 이득(dB)과 위상(°)을 한 화면에 보는 보드 선도가 그 쓰임새다.
   * 로그 눈금은 왼쪽 축에만 건다 — 오른쪽에 오는 것은 위상처럼 0 을 지나는 값이다.
   */
  const left = series.filter(s => !s.right), right = series.filter(s => s.right);
  const unitOf = (ss: readonly Series[]) => { const u = new Set(ss.map(s => s.unit)); return u.size === 1 ? [...u][0] : ""; };
  const scL = makeScale(left.length ? left : right, o.logY && left.length > 0, unitOf(left.length ? left : right), h);
  const scR = left.length && right.length ? makeScale(right, false, unitOf(right), h) : null;
  if (!scL) return null;

  const fx = (v: number) => (o.logX ? Math.log10(v) : v);
  let x0 = fx(ex[0]), x1 = fx(ex[1]);
  if (x1 === x0) { x0 -= 0.5; x1 += 0.5; }

  g.font = "11px ui-monospace, Consolas, monospace";
  const label = (sc: Scale, t: number) => eng(sc.log ? Math.pow(10, t) : t, sc.unit, 3);
  const widest = (sc: Scale | null) => (sc ? Math.max(30, ...sc.ticks.map(t => g.measureText(label(sc, t)).width)) : 0);
  const pad = { l: Math.ceil(widest(scL)) + 10, r: scR ? Math.ceil(widest(scR)) + 10 : 12, t: 8, b: 22 };
  const pw = Math.max(10, w - pad.l - pad.r), ph = Math.max(10, h - pad.t - pad.b);
  const X = (v: number) => pad.l + ((fx(v) - x0) / (x1 - x0)) * pw;
  const yPx = (sc: Scale, t: number) => pad.t + (1 - (t - sc.y0) / (sc.y1 - sc.y0)) * ph;
  const Yof = (s: Series) => {
    const sc = s.right && scR ? scR : scL;
    return (v: number) => yPx(sc, sc.log ? Math.log10(v) : v);
  };
  const half = (v: number) => Math.round(v) + 0.5;

  // 눈금선과 글자. 가로 눈금선은 왼쪽 축의 것만 긋는다 — 두 축의 선을 다 그으면 어느 선이 어느 축인지 모른다
  g.lineWidth = 1;
  g.strokeStyle = o.colors.line;
  g.fillStyle = o.colors.text;
  g.textBaseline = "middle";
  g.textAlign = "right";
  for (const t of scL.ticks) {
    const y = half(yPx(scL, t));
    if (y < pad.t - 1 || y > pad.t + ph + 1) continue;
    g.globalAlpha = !scL.log && t === 0 ? 1 : 0.45;
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(pad.l + pw, y); g.stroke();
    g.globalAlpha = 1;
    g.fillText(label(scL, t), pad.l - 6, y);
  }
  if (scR) {
    g.textAlign = "left";
    for (const t of scR.ticks) {
      const y = half(yPx(scR, t));
      if (y < pad.t - 1 || y > pad.t + ph + 1) continue;
      g.beginPath(); g.moveTo(pad.l + pw, y); g.lineTo(pad.l + pw + 4, y); g.stroke();
      g.fillText(label(scR, t), pad.l + pw + 6, y);
    }
  }
  const xCount = Math.max(2, Math.min(8, Math.floor(pw / 80)));
  const xTicks = o.logX ? decadeTicks(x0, x1, xCount) : niceTicks(x0, x1, xCount);
  g.textBaseline = "top";
  const xLabels: Array<{ x: number; text: string; align: CanvasTextAlign; from: number; to: number }> = [];
  for (const t of xTicks) {
    const x = half(pad.l + ((t - x0) / (x1 - x0)) * pw);
    if (x < pad.l - 1 || x > pad.l + pw + 1) continue;
    g.globalAlpha = 0.45;
    g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, pad.t + ph); g.stroke();
    g.globalAlpha = 1;
    // 양 끝 글자는 가운데 맞추면 캔버스 밖으로 반쯤 나간다
    const align: CanvasTextAlign = x - pad.l < 24 ? "left" : pad.l + pw - x < 24 ? "right" : "center";
    const text = eng(o.logX ? Math.pow(10, t) : t, o.xunit, 3);
    const w = g.measureText(text).width;
    const from = align === "left" ? x : align === "right" ? x - w : x - w / 2;
    xLabels.push({ x, text, align, from, to: from + w });
  }
  /*
   * 끝 글자를 안쪽으로 붙이면 바로 앞 글자와 겹칠 수 있다 (좁은 그래프에 0.5 V 간격이면 "4.50 V5.00 V").
   * 겹치는 글자는 뺀다. 끝 글자는 축의 끝값이라 남기고, 그 앞 것을 뺀다
   */
  const shown = xLabels.map(() => true);
  let last = -1;
  for (let i = 0; i < xLabels.length; i++) {
    if (last >= 0 && xLabels[i].from < xLabels[last].to + 6) {
      if (i < xLabels.length - 1) { shown[i] = false; continue; }
      shown[last] = false;
    }
    last = i;
  }
  xLabels.forEach((l, i) => {
    if (!shown[i]) return;
    g.textAlign = l.align;
    g.fillText(l.text, l.x, pad.t + ph + 5);
  });
  // 테두리
  g.globalAlpha = 0.6;
  g.strokeRect(half(pad.l), half(pad.t), pw, ph);
  g.globalAlpha = 1;

  // 줄기
  g.save();
  g.beginPath();
  g.rect(pad.l, pad.t, pw, ph);
  g.clip();
  for (const s of series) {
    const Y = Yof(s);
    const p = path(s, X, Y, pw);
    g.strokeStyle = s.color;
    g.fillStyle = s.color;
    g.lineWidth = s.points ? 1 : 1.5;
    g.globalAlpha = s.points ? 0.45 : 1;
    g.beginPath();
    let pen = false;
    for (let k = 0; k < p.length; k += 2) {
      // 로그 축에서 0 이하인 점은 그릴 자리가 없다. 그 자리에서 선을 끊는다
      if (!finite(p[k]) || !finite(p[k + 1])) { pen = false; continue; }
      if (pen) g.lineTo(p[k], p[k + 1]); else g.moveTo(p[k], p[k + 1]);
      pen = true;
    }
    g.stroke();
    g.globalAlpha = 1;
    if (s.points && s.x.length <= pw) {
      for (let k = 0; k < s.x.length; k++) {
        const px = X(s.x[k]), py = Y(s.y[k]);
        if (!finite(px) || !finite(py)) continue;
        g.beginPath(); g.arc(px, py, 2.2, 0, Math.PI * 2); g.fill();
      }
    }
  }
  // 커서: 세로 선과, 줄기마다 그 자리의 점
  if (o.hover !== null && finite(fx(o.hover))) {
    const x = half(X(o.hover));
    g.strokeStyle = o.colors.cursor;
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, pad.t + ph); g.stroke();
    g.setLineDash([]);
    for (const s of series) {
      const v = sampleAt(s, o.hover, o.logX);
      const py = v === null ? NaN : Yof(s)(v);
      if (!finite(py)) continue;
      g.fillStyle = s.color;
      g.beginPath(); g.arc(X(o.hover), py, 3, 0, Math.PI * 2); g.fill();
    }
  }
  g.restore();

  return {
    xAt(px: number): number | null {
      if (px < pad.l || px > pad.l + pw) return null;
      const a = x0 + ((px - pad.l) / pw) * (x1 - x0);
      return o.logX ? Math.pow(10, a) : a;
    },
  };
}

/** 줄기의 x 에서의 값 (보간). 점 묶음은 가장 가까운 점. 범위 밖이면 null */
export function sampleAt(s: Series, x: number, logX: boolean): number | null {
  const n = Math.min(s.x.length, s.y.length);
  if (!n) return null;
  const up = s.x[n - 1] >= s.x[0];
  const lo = up ? s.x[0] : s.x[n - 1], hi = up ? s.x[n - 1] : s.x[0];
  if (x < lo || x > hi) return null;
  let a = 0, b = n - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (up ? s.x[m] <= x : s.x[m] >= x) a = m; else b = m;
  }
  if (s.points || b === a) return Math.abs(s.x[a] - x) <= Math.abs(s.x[b] - x) ? s.y[a] : s.y[b];
  const xa = s.x[a], xb = s.x[b];
  if (xb === xa) return s.y[b];
  const f = logX && xa > 0 && xb > 0 && x > 0 ? Math.log(x / xa) / Math.log(xb / xa) : (x - xa) / (xb - xa);
  return s.y[a] + (s.y[b] - s.y[a]) * f;
}

// ── 캔버스 · 범례 · 커서 읽기를 한 묶음으로 ───────────────────────────
export interface PlotView {
  /** 줄기나 설정이 바뀌었다 */
  redraw(): void;
  /** 화면에서 떼어 낼 때 (관찰자를 끊는다) */
  destroy(): void;
}

export interface PlotSource {
  series(): Series[];
  xunit(): string;
  /** 로그 축을 쓸지. null 이면 자동 (auto 가 정한다) */
  logX: boolean | null;
  logY: boolean | null;
  auto: { logX: boolean; logY: boolean };
  /** 줄기가 없을 때 대신 적을 말 */
  empty: string;
  /** 범례 끝에 덧붙일 말 (그리지 못한 줄기가 있다는 것 같은) */
  note?(): string;
  css(token: string): string;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/**
 * host 안에 그래프를 차린다: 범례 줄(로그 축 단추 포함) · 캔버스 · 커서 자리의 값.
 * 크기가 바뀌면 다시 그린다. 커서를 따라 다시 그릴 때 요소를 새로 만들지 않는다 — 끌던 중에
 * 캔버스가 바뀌면 포인터 이벤트가 떨어져 나간다 (파형 탭이 같은 일을 겪었다).
 */
export function mountPlot(host: HTMLElement, src: PlotSource): PlotView {
  host.innerHTML = "";
  const bar = el("div", "plot-bar");
  const legend = el("div", "legend");
  const tools = el("div", "plot-tools");
  const bx = el("button", "btn", "log x"), by = el("button", "btn", "log y");
  bx.type = by.type = "button";
  bx.title = "Logarithmic x axis";
  by.title = "Logarithmic y axis";
  tools.append(bx, by);
  bar.append(legend, tools);
  const cv = el("canvas", "plot");
  const readout = el("div", "plot-read");
  host.append(bar, cv, readout);

  const coarse = matchMedia("(pointer: coarse)").matches;
  let hover: number | null = null;
  let geom: PlotGeom | null = null;
  let shown: Series[] = [];
  let useLogX = false;

  const draw = () => {
    shown = src.series();
    const leftOnes = shown.some(s => !s.right) ? shown.filter(s => !s.right) : shown;
    const okX = canLog(shown, s => s.x), okY = canLog(leftOnes, s => s.y);
    useLogX = okX && (src.logX ?? src.auto.logX);
    const useLogY = okY && (src.logY ?? src.auto.logY);
    bx.classList.toggle("on", useLogX);
    by.classList.toggle("on", useLogY);
    bx.disabled = !okX;
    by.disabled = !okY;
    tools.style.display = shown.length ? "" : "none";
    geom = drawPlot(cv, shown, {
      logX: useLogX, logY: useLogY, xunit: src.xunit(), hover,
      colors: { line: src.css("--line"), text: src.css("--mut"), cursor: src.css("--highlight") },
    });
    legend.innerHTML = "";
    if (!shown.length) legend.textContent = src.empty;
    for (const s of shown) {
      const item = el("span");
      const sw = el("span", "sw");
      sw.style.background = s.color;
      item.append(sw, document.createTextNode(s.name + (s.right ? " (right axis)" : "")));
      legend.appendChild(item);
    }
    const note = src.note?.();
    if (note) legend.appendChild(el("span", "", note));
    // 커서 자리의 값
    readout.innerHTML = "";
    if (hover === null || !shown.length) {
      readout.textContent = !shown.length ? "" : coarse ? "Drag across the plot to read values" : "Move over the plot to read values";
      return;
    }
    readout.appendChild(el("span", "", "x = " + eng(hover, src.xunit(), 5)));
    for (const s of shown) {
      const v = sampleAt(s, hover, useLogX);
      if (v === null) continue;
      const item = el("span");
      const sw = el("span", "sw");
      sw.style.background = s.color;
      item.append(sw, document.createTextNode(eng(v, s.unit, 5)));
      readout.appendChild(item);
    }
  };

  bx.onclick = () => { src.logX = !(src.logX ?? src.auto.logX); draw(); };
  by.onclick = () => { src.logY = !(src.logY ?? src.auto.logY); draw(); };
  cv.onpointermove = e => {
    const r = cv.getBoundingClientRect();
    const x = geom?.xAt(e.clientX - r.left) ?? null;
    if (x === hover) return;
    hover = x;
    draw();
  };
  cv.onpointerleave = () => { if (hover !== null) { hover = null; draw(); } };

  let pending = false;
  const ro = new ResizeObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; if (cv.isConnected) draw(); });
  });
  ro.observe(cv);
  draw();
  return { redraw: draw, destroy: () => ro.disconnect() };
}
