/**
 * 격자 위 최단 경로 — 부품을 옮기거나 돌릴 때 붙은 배선을 다시 놓는 데 쓴다.
 *
 * 예전 고무줄(rubber.ts)은 원래 모양에 꺾점 하나를 더해 끝을 끌고 왔다. 한 번 끌 때는
 * 괜찮지만 끌기마다 꺾점이 쌓여서, 부품을 한 바퀴 돌려 놓으면 배선이 제 몸을 되밟거나
 * 부품 몸통을 가로질렀다. 몸통을 가로지르는 배선은 그 부품의 다른 핀을 선분 중간에 얹어
 * **넷리스트를 조용히 바꾼다** (규칙 3: 선분 중간에 놓인 핀은 연결이다).
 *
 * 그래서 경로를 고치지 않고 **다시 찾는다.** 비용은 길이 + 꺾임이고, 지나가면 연결이
 * 바뀌는 자리는 아예 못 지난다:
 *   - 부품 몸통 (핀에는 바깥에서만 들어온다)
 *   - 다른 것의 연결점 — 핀·배선 꺾점·라벨·접합점·프로브. 지나면 이어진다 (규칙 2·3)
 *   - 다른 배선과 겹치는 칸 — 겹치면 서로의 끝점이 상대 선분 위에 놓여 이어진다
 *   - 다른 배선의 선분 위에서 꺾기 — 꺾점이 그 선분 중간에 놓여 이어진다
 * 다른 배선을 십자로 건너는 것은 연결이 아니라서 (규칙 5) 지날 수 있다. 조금 비싸게만 둔다.
 *
 * 그렇게 해서 길이 없으면 (부품을 돌려 놓은 자리가 빽빽해서) 몸통만은 지나도 되는 것으로
 * 한 번 더 찾는다. 몸통을 가로지르는 선은 보기 싫지만 연결은 바꾸지 않는다. 그래도 없으면
 * null 이고, 부르는 쪽은 배선을 그대로 둔다 — 조용한 단락보다 눈에 보이는 끊김이 낫다.
 *
 * 순수한 계산이라 캔버스 없이 시험할 수 있다 (tools/verify-route.ts).
 */
import { GRID, type Pt } from "./types.ts";

/** 방향: 0 오른쪽(+x) 1 아래(+y) 2 왼쪽 3 위. 화면 좌표라 y 가 아래로 자란다. 없으면 -1 */
export type Dir = 0 | 1 | 2 | 3;
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

/** a 에서 b 로 가는 방향. 축이 안 맞거나 같은 점이면 -1 */
export function dirOf(a: Pt, b: Pt): number {
  if (a[1] === b[1] && a[0] !== b[0]) return b[0] > a[0] ? 0 : 2;
  if (a[0] === b[0] && a[1] !== b[1]) return b[1] > a[1] ? 1 : 3;
  return -1;
}

/** 벡터를 방향으로. 한 축만 0 이 아닐 때만 */
export function dirOfVec(v: Pt): number {
  return dirOf([0, 0], v);
}

// ── 격자점 표시 ───────────────────────────────────────────────────────
/** 부품 몸통이나 핀 다리 위. 보통은 못 지나고, 길이 아예 없을 때만 비싸게 지난다 */
export const BODY = 1;
/** 다른 것의 연결점 (핀·배선 꺾점·라벨·접합점·프로브). 절대 못 지난다 */
export const POINT = 16;
/** 둘 중 하나 */
export const BLOCK = BODY | POINT;
/** 꺾을 수 없다 (다른 배선의 선분 위). 곧게 지나는 것은 십자 교차라 된다 */
export const NOBEND = 2;
/** 이 점에서 오른쪽으로 한 칸을 다른 배선이 이미 지난다 */
export const EDGE_H = 4;
/** 이 점에서 아래로 한 칸 */
export const EDGE_V = 8;

/** 격자 번호 한 쌍을 수 하나로. ±2^21 칸(±2천만 단위)까지 겹치지 않는다 */
const OFF = 1 << 21;
const cellKey = (gx: number, gy: number) => (gx + OFF) * 4194304 + (gy + OFF);

const TILE = 32;

/**
 * 격자점마다 표시를 모아 둔다. fill 을 주면 처음 묻는 칸 묶음(32×32)마다 한 번씩 불러
 * 그 자리의 것을 채운다 — 시트 전체를 미리 그려 둘 필요가 없다.
 */
export class CellMap {
  private readonly cells = new Map<number, number>();
  private readonly tiles = new Set<number>();
  private readonly fill?: (x0: number, y0: number, x1: number, y1: number) => void;
  constructor(fill?: (x0: number, y0: number, x1: number, y1: number) => void) { this.fill = fill; }

  /** 격자 번호 (gx, gy) 의 표시 */
  at(gx: number, gy: number): number {
    if (this.fill) {
      const tx = Math.floor(gx / TILE), ty = Math.floor(gy / TILE), t = cellKey(tx, ty);
      if (!this.tiles.has(t)) {
        this.tiles.add(t);
        const s = TILE * GRID;
        // 한 칸 넓게 묻는다 — 칸 묶음 경계에 걸친 것을 놓치지 않게
        this.fill(tx * s - GRID, ty * s - GRID, (tx + 1) * s + GRID, (ty + 1) * s + GRID);
      }
    }
    return this.cells.get(cellKey(gx, gy)) ?? 0;
  }

  private or(gx: number, gy: number, f: number) {
    const k = cellKey(gx, gy);
    this.cells.set(k, (this.cells.get(k) ?? 0) | f);
  }

  /**
   * 연결점. 격자점이면 그 점을 막는다. 격자에서 벗어난 점(가져온 파일)은 그 점을 지나는
   * 격자 칸을 막는다 — 그 칸으로 가면 점이 선분 중간에 놓인다.
   */
  point(x: number, y: number): void {
    const gx = x / GRID, gy = y / GRID;
    const ix = Number.isInteger(gx), iy = Number.isInteger(gy);
    if (ix && iy) this.or(gx, gy, POINT);
    else if (iy) this.or(Math.floor(gx), gy, EDGE_H);
    else if (ix) this.or(gx, Math.floor(gy), EDGE_V);
  }

  /** 닫힌 상자 안의 격자점을 몸통으로 표시한다 */
  box(x0: number, y0: number, x1: number, y1: number): void {
    for (let gx = Math.ceil(x0 / GRID); gx * GRID <= x1; gx++) {
      for (let gy = Math.ceil(y0 / GRID); gy * GRID <= y1; gy++) this.or(gx, gy, BODY);
    }
  }

  /** 배선. 꺾점은 연결점, 선분이 덮는 칸은 겹치기 금지, 선분 위 격자점은 꺾기 금지 */
  wire(pts: readonly Pt[]): void {
    if (pts.length < 2) return;
    for (const p of pts) this.point(p[0], p[1]);
    for (let i = 0; i < pts.length - 1; i++) this.segment(pts[i], pts[i + 1]);
  }

  private segment(a: Pt, b: Pt): void {
    if (a[1] === b[1] && Number.isInteger(a[1] / GRID)) {
      const gy = a[1] / GRID, lo = Math.min(a[0], b[0]), hi = Math.max(a[0], b[0]);
      for (let gx = Math.floor(lo / GRID); gx * GRID < hi; gx++) {
        if (gx * GRID > lo) this.or(gx, gy, NOBEND);
        if ((gx + 1) * GRID > lo) this.or(gx, gy, EDGE_H);
      }
    } else if (a[0] === b[0] && Number.isInteger(a[0] / GRID)) {
      const gx = a[0] / GRID, lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
      for (let gy = Math.floor(lo / GRID); gy * GRID < hi; gy++) {
        if (gy * GRID > lo) this.or(gx, gy, NOBEND);
        if ((gy + 1) * GRID > lo) this.or(gx, gy, EDGE_V);
      }
    } else if (a[0] !== b[0] && a[1] !== b[1]) {
      // 대각선: 정확히 지나는 격자점만 (거기서 꺾으면 그 선분 위에 꺾점이 놓인다)
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const g = gcd(Math.abs(dx), Math.abs(dy));
      const sx = dx / g, sy = dy / g;
      for (let k = 1; k < g; k++) {
        const x = a[0] + sx * k, y = a[1] + sy * k;
        if (Number.isInteger(x / GRID) && Number.isInteger(y / GRID)) this.or(x / GRID, y / GRID, NOBEND);
      }
    }
    // 격자선 밖을 지나는 가로·세로 선분은 격자 경로와 십자로만 만난다 — 연결이 아니다
  }
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

// ── 경로 찾기 ─────────────────────────────────────────────────────────
/** 한 칸 = 1, 꺾임 하나 = BEND. 길이가 같으면 덜 꺾인 쪽, 세 칸 이상 돌아가야 꺾임 하나를 아낀다 */
export const BEND = 3;
/** 출발·도착 방향이 바라던 쪽이 아니면 */
export const PREF = 2;
/** 다른 배선을 십자로 건너면 */
export const CROSS = 1;
/** 두 번째 찾기에서 몸통 한 칸을 지나면 */
const THROUGH_BODY = 20;

export interface RouteEnds {
  /** 출발점에 들어와 있던 방향. 그대로 이어 나가면 꺾이지 않는다 */
  inDir: number;
  /** 출발점에서 나가기 좋은 방향 (핀이 바깥을 보는 쪽, 원래 나가던 쪽) */
  outDir: number;
  /** 도착점에 들어가기 좋은 방향 (핀 바깥에서 안쪽으로) */
  arriveDir: number;
  /** 도착점에서 이어 나갈 방향. 그 방향으로 들어가면 곧게 지나간다 */
  onDir: number;
}

export interface RouteOpts {
  /** 출발·도착을 감싼 상자에서 더 볼 칸 수 */
  margin?: number;
  /** 이만큼 넓혀 봐도 못 찾으면 포기한다 */
  maxNodes?: number;
}

// 탐색용 배열은 다시 쓴다. 끌기 매 프레임 배선마다 부르므로 쓰레기를 만들지 않는다.
// 상태는 (칸, 축) 이다 — 방향까지 나누면 배가 되는데, 제자리로 되도는 길은 어차피 최단이 아니다
let cap = 0;
let gCost = new Float32Array(0), parent = new Int32Array(0), seen = new Uint32Array(0);
let flagSeen = new Uint32Array(0), flagVal = new Uint8Array(0);
let gen = 0;
let heapF = new Float64Array(1024), heapS = new Int32Array(1024);

/** 이보다 큰 창은 잡지 않는다 (512×512). 메모리 6 MB 쯤 */
const MAX_CELLS = 1 << 18;

function ensure(cells: number) {
  if (cells <= cap) return;
  cap = Math.min(MAX_CELLS, Math.max(cells, cap * 2));
  gCost = new Float32Array(cap * 2); parent = new Int32Array(cap * 2); seen = new Uint32Array(cap * 2);
  flagSeen = new Uint32Array(cap); flagVal = new Uint8Array(cap);
  gen = 0;
}

/**
 * from 에서 to 까지 직각 경로. 꺾점만 담은 점 목록을 돌려준다 (from, ..., to).
 * 두 점 모두 격자 위여야 한다. 못 찾으면 null.
 *
 * flags(gx, gy) 는 격자 번호로 표시를 묻는다. 출발점과 도착점 자체의 표시는 보지 않는다 —
 * 출발점은 원래 배선이 붙어 있던 자리이고, 도착점은 사용자가 옮겨 놓은 핀이다.
 */
export function route(
  from: Pt, to: Pt, flags: (gx: number, gy: number) => number, ends: RouteEnds, opt: RouteOpts = {},
): Pt[] | null {
  const sx = from[0] / GRID, sy = from[1] / GRID, tx = to[0] / GRID, ty = to[1] / GRID;
  if (![sx, sy, tx, ty].every(Number.isInteger)) return null;
  if (sx === tx && sy === ty) return [[from[0], from[1]]];
  const area = (m: number) => (Math.abs(tx - sx) + 2 * m + 1) * (Math.abs(ty - sy) + 2 * m + 1);
  for (const through of [false, true]) {
    for (const m of [opt.margin ?? 6, 24]) {
      if (area(m) > MAX_CELLS) continue;
      const r = search(sx, sy, tx, ty, flags, ends, m, opt.maxNodes ?? 60000, through);
      if (r) return r;
    }
  }
  return null;
}

function search(
  sx: number, sy: number, tx: number, ty: number,
  flags: (gx: number, gy: number) => number, ends: RouteEnds, margin: number, maxNodes: number,
  through: boolean,
): Pt[] | null {
  const x0 = Math.min(sx, tx) - margin, y0 = Math.min(sy, ty) - margin;
  const W = Math.abs(tx - sx) + 2 * margin + 1, H = Math.abs(ty - sy) + 2 * margin + 1;
  ensure(W * H);
  if (++gen === 0xffffffff) { seen.fill(0); flagSeen.fill(0); gen = 1; }
  const G = gen;

  const flagAt = (c: number): number => {
    if (flagSeen[c] === G) return flagVal[c];
    const f = flags(x0 + (c % W), y0 + Math.floor(c / W));
    flagSeen[c] = G; flagVal[c] = f;
    return f;
  };
  const start = (sy - y0) * W + (sx - x0), goal = (ty - y0) * W + (tx - x0);
  const gxl = tx - x0, gyl = ty - y0;

  // 남은 길의 하한: 칸 수 + (축을 바꿔야 하면) 꺾임 하나
  const h = (c: number, axis: number): number => {
    const cx = c % W, cy = (c - cx) / W;
    const dx = gxl - cx, dy = gyl - cy;
    const turn = (dx !== 0 && dy !== 0) || (dx !== 0 && axis === 1) || (dy !== 0 && axis === 0);
    return Math.abs(dx) + Math.abs(dy) + (turn ? BEND : 0);
  };

  let n = 0;
  const push = (s: number, f: number) => {
    if (n === heapF.length) {
      const nf = new Float64Array(n * 2), ns = new Int32Array(n * 2);
      nf.set(heapF); ns.set(heapS); heapF = nf; heapS = ns;
    }
    let i = n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= f) break;
      heapF[i] = heapF[p]; heapS[i] = heapS[p]; i = p;
    }
    heapF[i] = f; heapS[i] = s;
  };
  const pop = (): number => {
    const top = heapS[0];
    const lf = heapF[--n], ls = heapS[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && heapF[c + 1] < heapF[c]) c++;
      if (heapF[c] >= lf) break;
      heapF[i] = heapF[c]; heapS[i] = heapS[c]; i = c;
    }
    heapF[i] = lf; heapS[i] = ls;
    return top;
  };

  /** c 에서 d 쪽으로 한 칸 갈 수 있으면 그 칸, 아니면 -1 */
  const step = (c: number, d: number): number => {
    const cx = c % W, cy = (c - cx) / W;
    const nx = cx + DX[d], ny = cy + DY[d];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) return -1;
    const nc = ny * W + nx;
    // 다른 배선과 겹치는 칸 (그 칸의 왼쪽·위 끝점에 표시가 있다)
    if (d === 0 && flagAt(c) & EDGE_H) return -1;
    if (d === 2 && flagAt(nc) & EDGE_H) return -1;
    if (d === 1 && flagAt(c) & EDGE_V) return -1;
    if (d === 3 && flagAt(nc) & EDGE_V) return -1;
    if (nc !== goal && nc !== start) {
      const f = flagAt(nc);
      if (f & POINT || (f & BODY && !through)) return -1;
    }
    return nc;
  };
  /** 그 칸에 들어가는 덤 비용: 몸통(두 번째 찾기), 십자 교차 */
  const enter = (nc: number, d: number): number => {
    if (nc === goal) return endCost(d);
    const f = flagAt(nc);
    return (f & NOBEND ? CROSS : 0) + (f & BODY ? THROUGH_BODY : 0);
  };

  const endCost = (d: number): number => {
    if (ends.arriveDir < 0 && ends.onDir < 0) return 0;
    return d === ends.arriveDir || d === ends.onDir ? 0 : PREF;
  };
  const relax = (s: number, g: number, from: number) => {
    if (seen[s] === G && gCost[s] <= g) return;
    seen[s] = G; gCost[s] = g; parent[s] = from;
    push(s, g + h(s >> 1, s & 1));
  };

  // 출발: 네 방향을 바로 넣는다. 들어온 방향을 잇거나 바라던 쪽이면 공짜
  for (let d = 0; d < 4; d++) {
    const nc = step(start, d);
    if (nc < 0) continue;
    let g = 1 + enter(nc, d);
    if (ends.inDir >= 0 || ends.outDir >= 0) g += d === ends.inDir || d === ends.outDir ? 0 : PREF;
    relax(nc * 2 + (d & 1), g, -1);
  }

  let expanded = 0;
  while (n > 0) {
    const s = pop();
    const c = s >> 1, axis = s & 1;
    if (c === goal) return trace(s, W, x0, y0, sx, sy);
    if (++expanded > maxNodes) return null;
    const g0 = gCost[s];
    const here = flagAt(c);
    for (let nd = 0; nd < 4; nd++) {
      const turn = (nd & 1) !== axis;
      // 다른 배선의 선분 위에서는 꺾지 않는다 (꺾점이 그 배선에 이어진다)
      if (turn && here & NOBEND) continue;
      const nc = step(c, nd);
      if (nc < 0) continue;
      relax(nc * 2 + (nd & 1), g0 + 1 + (turn ? BEND : 0) + enter(nc, nd), s);
    }
  }
  return null;
}

/** 거꾸로 따라가며 꺾점만 모은다 (축이 바뀌는 칸이 꺾점이다) */
function trace(s: number, W: number, x0: number, y0: number, sx: number, sy: number): Pt[] {
  const cellsRev: number[] = [], axesRev: number[] = [];
  for (let t = s; t >= 0; t = parent[t]) { cellsRev.push(t >> 1); axesRev.push(t & 1); }
  const pt = (c: number): Pt => [(x0 + (c % W)) * GRID, (y0 + Math.floor(c / W)) * GRID];
  const out: Pt[] = [[sx * GRID, sy * GRID]];
  for (let k = cellsRev.length - 1; k > 0; k--) {
    if (axesRev[k] !== axesRev[k - 1]) out.push(pt(cellsRev[k]));
  }
  out.push(pt(cellsRev[0]));
  return out;
}
