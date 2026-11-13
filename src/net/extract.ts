/**
 * 넷 추출 — 기하에서 전기적 연결을 뽑아낸다.
 *
 * 설계서 '연결 판정' 의 규칙을 구현한다:
 *  1) 배선 끝점이 핀 끝이나 다른 배선 끝점과 같은 좌표면 연결
 *  2) 배선 끝점이 다른 배선의 선분 중간에 놓이면 연결 + 자동 접합점
 *  3) 핀 끝이 배선의 선분 중간에 놓여도 연결 + 자동 접합점
 *  5) 두 배선이 십자로 겹치기만 하면 연결이 아니다 (수동 접합점이 있을 때만)
 *  6) 핀 끝끼리 같은 좌표면 배선 없이도 연결
 *  7) 이름이 같은 넷 라벨·전원 기호는 같은 넷. 대소문자 무시. GND 는 노드 0
 *  8) 이름 우선순위: 넷 라벨 > 전원 기호 > 자동 이름(N001...)
 *
 * 좌표가 전부 정수라서 '점이 선분 위에 있는가' 를 정수 외적으로 정확히 판정한다.
 * 부동소수점 오차로 연결이 끊기는 일이 구조적으로 없다.
 *
 * ── 다시 짠 이유
 *
 * 예전 구현은 점마다 "x,y" 문자열을 만들어 Map 의 키로 썼다. 부품 1만 개 시트에서 편집
 * 한 번에 270 ms 가 들었고, 대부분이 문자열을 만들고 해시하고 다시 쪼개는 일이었다.
 * 지금은 점마다 번호를 붙이고 union-find 를 번호 배열(Int32Array)로 돈다.
 *
 * **결과는 예전과 한 글자도 다르지 않아야 한다.** 자동 넷 이름은 넷의 대표점(union-find 의
 * 루트)을 좌표 문자열 순으로 줄 세워 붙이는데, 루트는 union 을 부른 순서로 정해진다.
 * 그래서 점을 등록하는 순서, 공간 색인이 후보를 내놓는 순서, union 의 인자 순서를 모두
 * 예전과 같게 두었다. tools/verify-extract.ts 가 얼려 둔 예전 구현과 무작위 회로 수백 개에서
 * 결과를 통째로 비교한다 — 이름이 하나라도 바뀌면 같은 회로의 넷리스트가 달라진다.
 */
import { type NetLabel, type Pt, type Sheet, type LibPart, pinAt } from "../doc/types.ts";
import { CELL, PairMap, PointIndex, cellOf } from "./spatial.ts";

export interface Extraction {
  /** "partId:pinId" -> 넷 이름 */
  pinNet: Map<string, string>;
  /**
   * 넷 이름 -> 그 넷에 속한 좌표들. **처음 읽을 때 만든다** — 점마다 배열을 새로 만드는
   * 일이라, 넷 이름 표시를 켜지 않은 대부분의 편집에서는 아무도 읽지 않는다.
   */
  nets: Map<string, Pt[]>;
  /** 넷 개수 (nets 를 만들지 않고 안다) */
  netCount: number;
  /** 그 넷에 속한 좌표 개수. 없는 넷이면 0 */
  netSize(name: string): number;
  /** 넷 이름 전부 (nets 를 만들지 않고) */
  netNames(): string[];
  /**
   * 떠 있는 핀 ("partId:pinId") 과 그런 핀이 하나라도 있는 부품. 실행 전 검사가 쓴다 — 그 넷에
   * 핀이 하나뿐이고 좌표도 하나뿐이면 떠 있는 것이다. 넷 이름별 표를 만들지 않고 union-find 에서
   * 바로 구한다. 핀 이름이 겹치는 깨진 문서에서는 없다 (검사가 예전 방식으로 센다).
   */
  floating?: { pins: Set<string>; parts: Set<string> };
  /** 자동 접합점. 저장하지 않고 매번 계산한다 */
  junctions: Pt[];
  warnings: string[];
  /**
   * 임의의 좌표가 어느 넷인지. 프로브가 꽂힌 자리를 넷으로 바꾸는 데 쓴다.
   * 연결점 위가 아니어도 배선 선분 위면 그 넷을 준다. 아무 데도 아니면 null.
   *
   * 배선은 **추출한 순간의 모양**으로 본다. 끄는 도중처럼 문서가 추출 뒤에 움직였을 때
   * 예전 구현은 연결점은 추출 시점으로, 선분 중간은 지금 모양으로 봐서 둘이 섞였다.
   */
  netAt(p: Pt): string | null;
  /**
   * 아무것도 안 붙은 핀 끝 (설계서 12-7). 작은 ○ 로 그려서 끝나지 않은 넷을 눈에 띄게 한다.
   * KiCad 방식이고, 포럼에서 "끝나지 않은 넷을 찾기 어렵다"는 불만(FR2)에 대한 답이다.
   */
  danglingPins: Pt[];
  /** 아무 데도 안 닿은 배선 끝 (설계서 12-7). 작은 □ 로 그린다 */
  looseEnds: Pt[];
  /**
   * 더 이상 교차가 없어 의미를 잃은 수동 접합점 (설계서 12-6).
   * 편집할 때 자동으로 치운다 — 남은 점을 손으로 지워야 하는 문제(FR2)를 없앤다.
   */
  staleJunctions: Pt[];
}

/** 점이 선분 위에 있는가 (끝점 포함). 좌표가 정수라 외적이 정확하다 */
export function onSegment(p: Pt, a: Pt, b: Pt): boolean {
  return onSegXY(p[0], p[1], a, b);
}

export function onSegXY(px: number, py: number, a: Pt, b: Pt): boolean {
  const cross = (px - a[0]) * (b[1] - a[1]) - (py - a[1]) * (b[0] - a[0]);
  if (cross !== 0) return false;
  return px >= Math.min(a[0], b[0]) && px <= Math.max(a[0], b[0])
    && py >= Math.min(a[1], b[1]) && py <= Math.max(a[1], b[1]);
}

// ── 넷 추출의 입력 ────────────────────────────────────────────────────
/*
 * 넷 추출은 두 단계로 나뉜다.
 *
 *  입력 만들기 — 좌표마다 번호를 붙이고(해시), 배선마다 '어느 점들을 지나는가' 를 찾는다(공간 색인).
 *  풀기(solve) — 그 번호들로 union 을 예전 순서 그대로 다시 하고, 이름을 붙이고, 결과를 만든다.
 *
 * 비싼 것은 앞쪽이다. 그래서 시트 전체를 한 번에 뽑는 extractNets 는 입력을 처음부터 만들고,
 * 편집마다 쓰는 증분 추출(src/net/incremental.ts)은 **바뀐 객체의 입력만** 다시 만든다. 풀기는
 * 둘이 같은 함수를 쓴다 — 그래서 둘의 결과가 같다는 것을 풀기 하나로 보장한다.
 */

/*
 * 입력은 객체마다 배열을 두지 않고 **이어 붙인 배열 + 시작 자리** 로 둔다. 배선이 15만 개면
 * 작은 Int32Array 15만 개를 만드는 비용만으로 넷 추출이 두 배 느려졌다.
 *
 *   wireAt[w] .. wireAt[w+1]   wireV  의 구간 — 배선 w 의 꺾점 번호 (점이 둘 미만이면 빈 구간)
 *   innerAt[w] .. innerAt[w+1] innerV 의 구간 — 배선 w 의 선분 **중간**에 놓인 점 번호
 *   pinAt[p] .. pinAt[p+1]     pinV   의 구간 — 부품 p 의 핀이 놓인 점 번호 (pinRefs 도 같은 자리)
 */
export interface Inputs {
  /** 번호표 크기. 증분 추출에서는 지금은 아무도 안 쓰는 번호(빈자리)도 들어 있다 */
  count: number;
  xs: Float64Array;
  ys: Float64Array;
  ids: PairMap;
  wireAt: Int32Array; wireV: Int32Array;
  innerAt: Int32Array; innerV: Int32Array;
  /** 부품마다: 라이브러리에 있는가, GND 기호인가, 지정자, 라이브러리 이름 (경고에 쓴다) */
  partOk: Uint8Array; partGnd: Uint8Array; partRef: string[]; partLib: string[];
  pinAt: Int32Array; pinV: Int32Array;
  /** "partId:pinId" — pinNet 의 키. pinV 와 같은 자리 */
  pinRefs: string[];
  /** 부품 id (부품마다) */
  partId: string[];
  labelPt: Int32Array; labelName: string[]; labelKind: NetLabel["kind"][];
  /** 수동 접합점의 점 번호, 시트 순서 */
  junctions: Int32Array;
  /** 수동 접합점 그 자체 (staleJunctions 는 이것을 걸러서 준다) */
  junctionPts: Pt[];
  /** 배선 모양 (netAt 의 '선분 중간' 조회용). 추출한 순간의 것 */
  wireGeom: Pt[][];
  /**
   * 점 번호 -> 좌표 배열을 다시 쓰고 싶으면 준다 (증분 추출). 결과 목록의 점은 읽기만 하므로
   * 편집마다 같은 배열을 줘도 된다. 없으면 매번 새로 만든다.
   */
  ptCache?: Pt[];
}

/** 선분 a-b 의 **중간**(끝 제외)에 놓인 점들을 out 에 더한다. 후보는 칸 색인이 준다 */
export function innerPoints(
  a: Pt, b: Pt, xs: Float64Array, ys: Float64Array,
  each: (x0: number, y0: number, x1: number, y1: number, fn: (id: number) => void) => void,
  out: number[],
): void {
  const ax = a[0], ay = a[1], bx = b[0], by = b[1];
  each(cellOf(Math.min(ax, bx)), cellOf(Math.min(ay, by)), cellOf(Math.max(ax, bx)), cellOf(Math.max(ay, by)), id => {
    const px = xs[id], py = ys[id];
    if ((px === ax && py === ay) || (px === bx && py === by)) return;   // 끝점은 가지 1 (풀기에서 센다)
    if (onSegXY(px, py, a, b)) out.push(id);
  });
}

export function extractNets(sheet: Sheet, library: Record<string, LibPart>): Extraction {
  // ── 점 번호표. 좌표가 같으면 같은 번호 (규칙 1, 6)
  let cap = sheet.labels.length + sheet.junctions.length + 16, wireTotal = 0, pinTotal = 0;
  for (const w of sheet.wires) if (w.pts.length >= 2) wireTotal += w.pts.length;
  for (const part of sheet.parts) pinTotal += library[part.lib]?.symbol.pins.length ?? 0;
  cap += wireTotal + pinTotal;
  const ids = new PairMap(cap);
  let xs = new Float64Array(cap), ys = new Float64Array(cap);
  let count = 0;
  const idOf = (x: number, y: number): number => {
    const i = ids.getOrSet(x, y, count);
    if (i === count) {
      if (count === xs.length) {
        const nx = new Float64Array(xs.length * 2), ny = new Float64Array(xs.length * 2);
        nx.set(xs); ny.set(ys); xs = nx; ys = ny;
      }
      xs[count] = x; ys[count] = y;
      count++;
    }
    return i;
  };

  const W = sheet.wires.length;
  const wireAt = new Int32Array(W + 1), wireV = new Int32Array(wireTotal);
  let q = 0;
  for (let w = 0; w < W; w++) {
    const pts = sheet.wires[w].pts;
    wireAt[w] = q;
    if (pts.length >= 2) for (const pt of pts) wireV[q++] = idOf(pt[0], pt[1]);
  }
  wireAt[W] = q;

  const P = sheet.parts.length;
  const partOk = new Uint8Array(P), partGnd = new Uint8Array(P);
  const partRef: string[] = new Array(P), partLib: string[] = new Array(P), partId: string[] = new Array(P);
  const pinAtArr = new Int32Array(P + 1), pinV = new Int32Array(pinTotal), pinRefs: string[] = new Array(pinTotal);
  q = 0;
  for (let k = 0; k < P; k++) {
    const part = sheet.parts[k], lib = library[part.lib];
    partRef[k] = part.ref; partLib[k] = part.lib; partId[k] = part.id;
    pinAtArr[k] = q;
    if (!lib) continue;
    partOk[k] = 1;
    partGnd[k] = lib.id === "gnd" ? 1 : 0;
    const pins = lib.symbol.pins;
    for (let i = 0; i < pins.length; i++) {
      const at = pinAt(part, lib, i);
      pinV[q] = idOf(at[0], at[1]);
      pinRefs[q] = part.id + ":" + pins[i].id;
      q++;
    }
  }
  pinAtArr[P] = q;

  const L = sheet.labels.length;
  const labelPt = new Int32Array(L), labelName: string[] = new Array(L), labelKind: NetLabel["kind"][] = new Array(L);
  for (let k = 0; k < L; k++) {
    const l = sheet.labels[k];
    labelPt[k] = idOf(l.at[0], l.at[1]); labelName[k] = l.name; labelKind[k] = l.kind;
  }
  const junctions = Int32Array.from(sheet.junctions, j => idOf(j[0], j[1]));

  // ── 선분 중간에 놓인 점 (규칙 2, 3). 칸 색인으로 선분이 닿는 칸의 점만 본다
  const index = new PointIndex(xs, ys, count);
  const each = (cx0: number, cy0: number, cx1: number, cy1: number, fn: (id: number) => void) => {
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const c = index.cell(cx, cy);
      if (c >= 0) for (let k = index.start[c], e = index.start[c + 1]; k < e; k++) fn(index.members[k]);
    }
  };
  const innerAt = new Int32Array(W + 1), inner: number[] = [];
  for (let w = 0; w < W; w++) {
    innerAt[w] = inner.length;
    const pts = sheet.wires[w].pts;
    if (pts.length >= 2) for (let i = 0; i < pts.length - 1; i++) innerPoints(pts[i], pts[i + 1], xs, ys, each, inner);
  }
  innerAt[W] = inner.length;

  return solve({
    count, xs, ys, ids, wireAt, wireV, innerAt, innerV: Int32Array.from(inner),
    partOk, partGnd, partRef, partLib, partId, pinAt: pinAtArr, pinV, pinRefs,
    labelPt, labelName, labelKind, junctions, junctionPts: sheet.junctions, wireGeom: sheet.wires.map(w => w.pts),
  });
}

/**
 * 작업용 배열 모음. 증분 추출은 편집마다 풀기를 하므로, 풀기 안에서만 쓰고 버리는 큰 배열
 * (union-find, 가지 수, 핀 목록…)을 매번 새로 잡으면 부품 5만 개에서 편집마다 수십 MB 를
 * 버리게 되고, 그 쓰레기 수거가 다음 프레임을 100 ms 씩 멈췄다. 같은 배열을 다시 쓴다.
 * 결과(Extraction)가 나중에 읽는 배열은 여기서 꺼내지 않는다 — 다음 편집이 덮어쓰기 때문이다.
 */
export class Scratch {
  private pool = new Map<string, Int32Array | Float64Array>();
  i32(name: string, n: number, fill: number): Int32Array {
    let a = this.pool.get(name) as Int32Array | undefined;
    if (!a || a.length < n) { a = new Int32Array(Math.max(n, Math.ceil((a?.length ?? 0) * 1.5), 64)); this.pool.set(name, a); }
    const v = a.subarray(0, n);
    v.fill(fill);
    return v;
  }
  f64(name: string, n: number): Float64Array {
    let a = this.pool.get(name) as Float64Array | undefined;
    if (!a || a.length < n) { a = new Float64Array(Math.max(n, Math.ceil((a?.length ?? 0) * 1.5), 64)); this.pool.set(name, a); }
    return a.subarray(0, n);
  }
}
const fresh = {
  i32: (_: string, n: number, fill: number) => { const a = new Int32Array(n); if (fill) a.fill(fill); return a; },
  f64: (_: string, n: number) => new Float64Array(n),
};

/**
 * 풀기 — union 을 예전 순서 그대로 하고 이름을 붙인다. 문자열도 해시도 거의 없이 배열만 돈다.
 *
 * union 순서: ① 배선마다(시트 순서) 꺾점을 첫 점에 ② 배선마다 선분 중간의 점을 첫 점에
 * ③ 이름이 같은 라벨끼리. union(a, b) 는 a 쪽 루트를 b 쪽 루트 밑에 단다. 한 배선 안에서는
 * 순서가 상관없다 — 모든 union 이 그 배선의 지금 루트 밑으로 들어가서 그 루트가 바뀌지 않는다.
 * 배선 사이의 순서와 단계 순서는 루트를 바꾸므로 예전 그대로다.
 */
export function solve(inp: Inputs, scratch?: Scratch): Extraction {
  const { count, xs, ys } = inp;
  const tmp = scratch ?? fresh;
  const warnings: string[] = [];
  const P = inp.partOk.length, W = inp.wireAt.length - 1, L = inp.labelPt.length;
  for (let k = 0; k < P; k++) if (!inp.partOk[k]) warnings.push(`${inp.partRef[k]}: ${inp.partLib[k]} is not in the library`);
  const { wireAt, wireV, innerAt, innerV, pinV } = inp;

  // ── 등록 순서 (예전 구현이 점을 처음 본 순서). 결과 목록의 순서가 이것을 따른다
  const seen = new Uint8Array(count);
  const order = new Int32Array(count);
  let n = 0;
  const reg = (i: number) => { if (!seen[i]) { seen[i] = 1; order[n++] = i; } };
  for (let k = 0; k < wireV.length; k++) reg(wireV[k]);
  for (let k = 0; k < pinV.length; k++) reg(pinV[k]);
  for (let k = 0; k < L; k++) reg(inp.labelPt[k]);
  for (let k = 0; k < inp.junctions.length; k++) reg(inp.junctions[k]);

  // ── union-find
  const parent = tmp.i32("parent", count, 0);
  for (let i = 0; i < count; i++) parent[i] = i;
  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) { const nx = parent[a]; parent[a] = r; a = nx; }   // 경로 압축
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // ① 하나의 폴리라인은 전체가 한 도체다
  for (let w = 0; w < W; w++) {
    const a = wireAt[w], b = wireAt[w + 1];
    if (b - a < 2) continue;
    const r = wireV[a];
    for (let k = a; k < b; k++) union(wireV[k], r);
  }
  // ② 선분 중간에 놓인 점 -> 연결 (규칙 2, 3). 십자 교차는 그 자리에 점이 없으면 아무 일도 없다 (규칙 5)
  for (let w = 0; w < W; w++) {
    if (wireAt[w + 1] - wireAt[w] < 2) continue;
    const r = wireV[wireAt[w]];
    for (let k = innerAt[w]; k < innerAt[w + 1]; k++) union(innerV[k], r);
  }

  /*
   * 가지 수. 선분마다 양 끝은 1 씩(길이 0 이면 그 점에 1), 중간을 지나는 점은 2. 핀 수를 더해
   * 3 이상이면 접합점, 핀 하나에 가지 0 이면 떠 있는 핀, 핀 없이 가지 1 이면 끊긴 배선 끝이다.
   */
  const branches = tmp.i32("branches", count, 0);
  for (let w = 0; w < W; w++) {
    const s0 = wireAt[w], s1 = wireAt[w + 1];
    if (s1 - s0 < 2) continue;
    for (let k = s0; k + 1 < s1; k++) {
      const a = wireV[k], b = wireV[k + 1];
      branches[a]++;
      if (b !== a) branches[b]++;
    }
    for (let k = innerAt[w]; k < innerAt[w + 1]; k++) branches[innerV[k]] += 2;
  }
  const pinCountAt = tmp.i32("pinCountAt", count, 0);
  for (let k = 0; k < pinV.length; k++) pinCountAt[pinV[k]]++;
  // 라벨이 놓인 점. 끝나지 않은 곳을 셀 때만 쓴다 (가지로는 세지 않는다 — 접합점이 아니다)
  const labelAtPt = tmp.i32("labelAtPt", count, 0);
  for (let k = 0; k < L; k++) labelAtPt[inp.labelPt[k]] = 1;

  // ③ 이름이 같은 라벨끼리 잇는다 (규칙 7). 대소문자 무시
  const byName = new Map<string, number[]>();
  for (let k = 0; k < L; k++) {
    const nm = inp.labelName[k].trim().toLowerCase();
    if (!nm) continue;
    const list = byName.get(nm);
    if (list) list.push(inp.labelPt[k]); else byName.set(nm, [inp.labelPt[k]]);
  }
  for (const list of byName.values()) for (let i = 1; i < list.length; i++) union(list[0], list[i]);

  // GND 기호의 핀도 묶는다
  const gndRoots = new Set<number>();
  for (let k = 0; k < P; k++) if (inp.partOk[k] && inp.partGnd[k] && inp.pinAt[k + 1] > inp.pinAt[k]) gndRoots.add(find(pinV[inp.pinAt[k]]));
  for (let k = 0; k < L; k++) if (inp.labelKind[k] === "gnd") gndRoots.add(find(inp.labelPt[k]));

  // ── 넷마다 이름을 정한다 (규칙 8)
  // 이름은 대소문자를 무시하므로 out 과 OUT 은 '다른 라벨 둘' 이 아니라 한 이름이다.
  // 소문자로 묶되 사용자가 처음 적은 철자를 그대로 쓴다.
  //
  // 이름 우선순위는 넷 라벨 > 전원 기호 > 자동 이름이다 (규칙 8). 한 넷에 둘 다 있으면
  // 넷 라벨이 이긴다 — 전원 기호는 VCC 처럼 넓게 퍼지는 이름이라, 그 자리에
  // 사용자가 따로 붙인 이름이 있으면 그쪽이 더 구체적인 의도다.
  const rootLabels = new Map<number, string[]>();
  const rootPower = new Map<number, string[]>();
  for (let k = 0; k < L; k++) {
    const name = inp.labelName[k], kind = inp.labelKind[k];
    if (kind === "gnd" || !name.trim()) continue;
    const bucket = kind === "power" ? rootPower : rootLabels;
    const r = find(inp.labelPt[k]);
    const list = bucket.get(r) ?? [];
    if (!list.some(x => x.toLowerCase() === name.toLowerCase())) list.push(name);
    bucket.set(r, list);
  }

  const used = new Set<string>(["0"]);
  for (const names of rootLabels.values()) for (const nm of names) used.add(nm.toLowerCase());
  for (const names of rootPower.values()) for (const nm of names) used.add(nm.toLowerCase());

  /** 루트 번호 -> 넷 이름 */
  const nameOf: (string | undefined)[] = new Array(count);
  for (const r of gndRoots) nameOf[r] = "0";

  /*
   * 자동 이름은 늘 새 번호라 자기들끼리는 겹칠 수 없다. 겹칠 수 있는 것은 사용자가
   * 'N012' 같은 라벨을 직접 붙였을 때뿐이라, 그런 라벨이 없으면 확인 자체를 건너뛴다.
   */
  const clash = [...used].some(nm => /^n\d+$/.test(nm));
  let auto = 0;
  const nextAuto = (): string => {
    let nm: string;
    do { auto++; nm = autoName(auto); } while (clash && used.has(nm.toLowerCase()));
    if (clash) used.add(nm.toLowerCase());
    return nm;
  };

  const rootOf = new Int32Array(count);
  const roots: number[] = [];
  const size = new Int32Array(count);          // 루트 번호 -> 그 넷의 점 수
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const r = find(i);
    rootOf[i] = r;
    if (size[r]++ === 0) roots.push(r);
  }

  for (const r of sortByKeyString(roots, xs, ys, tmp)) {
    if (nameOf[r] !== undefined) continue;
    // 넷 라벨이 있으면 그것, 없으면 전원 기호, 둘 다 없으면 자동 이름
    const labels = rootLabels.get(r) ?? rootPower.get(r);
    if (labels?.length) {
      // 사전순은 대소문자를 무시하고 비교한다. 안 그러면 UTF-16 순서 때문에
      // OUT 이 out 을 이기는 식으로 철자에 따라 결과가 달라진다
      const sorted = [...labels].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), "en"));
      if (sorted.length > 1) {
        warnings.push(`One net has several labels: ${sorted.join(", ")} → ${sorted[0]} is used`);
      }
      nameOf[r] = sorted[0];
    } else {
      nameOf[r] = nextAuto();
    }
  }
  const nameAt = (id: number) => nameOf[rootOf[id]]!;

  // ── 핀 -> 넷 이름. 예전 순서: 핀이 처음 놓인 점의 순서대로, 그 점의 핀은 놓인 순서대로
  const pinNet = new Map<string, string>();
  {
    const head = tmp.i32("head", count, -1), tail = tmp.i32("tail", count, -1);
    const next = tmp.i32("next", pinV.length, -1);
    const first: number[] = [];
    for (let q = 0; q < pinV.length; q++) {
      const id = pinV[q];
      if (head[id] < 0) { head[id] = q; first.push(id); } else next[tail[id]] = q;
      tail[id] = q;
    }
    for (const id of first) {
      const nm = nameAt(id);
      for (let k = head[id]; k >= 0; k = next[k]) pinNet.set(inp.pinRefs[k], nm);
    }
  }

  /*
   * 떠 있는 핀. 실행 전 검사의 규칙 그대로다: 그 넷에 핀이 하나 이하이고 좌표가 하나 이하.
   * 이름이 '0' 인 넷은 루트가 여럿일 수 있어(서로 안 이어진 GND 기호) 이름으로 더해서 본다.
   * 핀 이름("partId:pinId")이 겹치면 검사가 pinNet 으로 세는 값과 달라지므로 그때는 만들지 않는다.
   */
  let floating: { pins: Set<string>; parts: Set<string> } | undefined;
  if (pinNet.size === pinV.length) {
    const pinsOnRoot = tmp.i32("pinsOnRoot", count, 0);
    for (let q = 0; q < pinV.length; q++) pinsOnRoot[rootOf[pinV[q]]]++;
    let zeroSize = 0, zeroPins = 0;
    for (const r of roots) if (nameOf[r] === "0") { zeroSize += size[r]; zeroPins += pinsOnRoot[r]; }
    floating = { pins: new Set(), parts: new Set() };
    for (let k = 0; k < P; k++) {
      for (let q = inp.pinAt[k]; q < inp.pinAt[k + 1]; q++) {
        const r = rootOf[pinV[q]], zero = nameOf[r] === "0";
        if ((zero ? zeroPins : pinsOnRoot[r]) <= 1 && (zero ? zeroSize : size[r]) <= 1) {
          floating.pins.add(inp.pinRefs[q]);
          floating.parts.add(inp.partId[k]);
        }
      }
    }
  }

  /*
   * 넷 이름 -> 좌표 수. 이름 하나에 루트가 **여럿일 수 있다** — 서로 이어지지 않은
   * GND 기호 둘은 union-find 에서는 다른 집합이지만 둘 다 '0' 이다. 예전 nets 도 이름으로
   * 묶었으니 여기서도 이름으로 더한다.
   */
  let byNet: Map<string, number> | null = null;
  const netInfo = (name: string) => {
    if (!byNet) {
      byNet = new Map();
      for (const r of roots) {
        const nm = nameOf[r]!;
        byNet.set(nm, (byNet.get(nm) ?? 0) + size[r]);
      }
    }
    return byNet.get(name);
  };

  /*
   * 넷 -> 좌표. 예전과 같은 순서(점을 처음 본 순서)로 채운다. 넷 이름을 그리지 않는 한
   * 편집할 때마다 아무도 읽지 않으므로 처음 읽을 때 만든다.
   */
  let nets: Map<string, Pt[]> | null = null;
  const buildNets = (): Map<string, Pt[]> => {
    const m = new Map<string, Pt[]>();
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const nm = nameAt(i);
      const list = m.get(nm);
      if (list) list.push([xs[i], ys[i]]); else m.set(nm, [[xs[i], ys[i]]]);
    }
    return m;
  };

  /*
   * 자동 접합점(가지 3 이상)과 끝나지 않은 곳 (설계서 12-7).
   *   가지 0  — 배선이 전혀 안 닿은 핀
   *   가지 1  — 한쪽만 물린 배선 끝 (어디로도 이어지지 않음)
   * 핀이 둘 이상 겹친 자리는 배선 없이도 연결된 것이므로 (규칙 6) 떠 있는 게 아니다.
   * **넷 라벨이 놓인 자리도 끝난 곳이다** — 라벨이 이름으로 넷을 잇는다 (규칙 7). 짧은
   * 배선 끝에 clk·vdd 라벨을 다는 흔한 그림에서 끝마다 □ 가 찍혀, 다 이은 회로가 덜 그린
   * 것처럼 보였다.
   */
  const junctions: Pt[] = [];
  const danglingPins: Pt[] = [];
  const looseEnds: Pt[] = [];
  const cache = inp.ptCache;
  const ptOf = (i: number): Pt => cache ? (cache[i] ??= [xs[i], ys[i]]) : [xs[i], ys[i]];
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const wireBranches = branches[i], pins = pinCountAt[i];
    if (wireBranches + pins >= 3) junctions.push(ptOf(i));
    if (labelAtPt[i]) continue;
    if (pins > 0) {
      if (wireBranches === 0 && pins === 1) danglingPins.push(ptOf(i));
    } else if (wireBranches === 1) {
      looseEnds.push(ptOf(i));
    }
  }

  // ── 좌표 -> 넷 조회 (프로브용)
  /*
   * 연결점 위면 번호표로 바로 찾는다. 선분 중간이면 그 점을 지나는 배선 중 **시트 순서로
   * 가장 앞의 것**의 넷이다 — 예전 구현이 배선을 앞에서부터 훑어 처음 걸린 것을 준 것과 같다.
   * 선분 색인은 처음 물을 때 한 번만 만든다. 대부분의 조회(배선 꺾점, 핀)는 번호표에서 끝난다.
   */
  const ids = inp.ids, wirePts = inp.wireGeom;
  let segIndex: SegmentIndex | null = null;
  const netAt = (p: Pt): string | null => {
    const direct = ids.get(p[0], p[1]);
    if (direct >= 0 && direct < count && seen[direct]) return nameAt(direct);
    segIndex ??= new SegmentIndex(wirePts);
    const w = segIndex.firstWireAt(p);
    if (w < 0) return null;
    const first = ids.get(wirePts[w][0][0], wirePts[w][0][1]);
    return first >= 0 && first < count && seen[first] ? nameAt(first) : null;
  };

  // 수동 접합점은 배선이 둘 이상 지날 때만 의미가 있다. 가지가 3개 미만이면 치운다
  const staleJunctions: Pt[] = [];
  inp.junctionPts.forEach((j, k) => {
    const i = inp.junctions[k];
    if (branches[i] + pinCountAt[i] < 3) staleJunctions.push(j);
  });

  return {
    pinNet,
    get nets() { return (nets ??= buildNets()); },
    get netCount() { netInfo(""); return byNet!.size; },
    netSize: (name: string) => netInfo(name) ?? 0,
    netNames: () => { netInfo(""); return [...byNet!.keys()]; },
    floating,
    junctions, warnings, netAt, danglingPins, looseEnds, staleJunctions,
  };
}

/** 자동 넷 이름. 번호마다 한 번만 만든다 (편집할 때마다 수만 개를 다시 만들지 않는다) */
const autoNames: string[] = [];
function autoName(k: number): string {
  return autoNames[k] ??= "N" + String(k).padStart(3, "0");
}

function sortByKeyString(roots: number[], xs: Float64Array, ys: Float64Array, tmp: Pick<Scratch, "f64">): number[] {
  const rank = (vals: Float64Array): Map<number, number> => {
    const distinct = new Map<number, string>();
    for (const r of roots) { const v = vals[r]; if (!distinct.has(v)) distinct.set(v, String(v)); }
    const order = [...distinct].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    const out = new Map<number, number>();
    // 문자열이 같은 값(-0 과 0)은 같은 순위다 — 예전 키도 둘 다 "0" 이었다
    let k = -1, prev: string | null = null;
    for (const [v, s] of order) { if (s !== prev) { k++; prev = s; } out.set(v, k); }
    return out;
  };
  const rx = rank(xs), ry = rank(ys);
  const ny = ry.size + 1, n = roots.length;
  // 순위 쌍과 원래 자리를 숫자 하나로: (rx·ny + ry)·n + i. 2⁵³ 을 넘으면 비교 함수로 간다
  if ((rx.size + 1) * ny * Math.max(n, 1) < 2 ** 53) {
    const codes = tmp.f64("codes", n);
    for (let i = 0; i < n; i++) {
      const r = roots[i];
      codes[i] = (rx.get(xs[r])! * ny + ry.get(ys[r])!) * n + i;
    }
    codes.sort();
    return Array.from(codes, c => roots[c % n]);
  }
  return [...roots].sort((a, b) =>
    (rx.get(xs[a])! - rx.get(xs[b])!) || (ry.get(ys[a])! - ry.get(ys[b])!));
}

/**
 * 선분 색인 — '이 점을 지나는 배선' 을 묻는 netAt 의 뒷길.
 *
 * 선분을 경계 상자가 닿는 칸마다 넣는다. 아주 긴 대각선은 칸을 너무 많이 차지하므로
 * 따로 모아 두고 매번 직접 본다 (드물다 — 배선은 거의 늘 직각이다).
 */
class SegmentIndex {
  private cellOfKey = new PairMap(64);
  private lists: number[][] = [];
  /** [배선 번호, 선분 번호] 를 한 배열에 */
  private segs: number[] = [];
  private wide: number[] = [];
  private readonly wires: Pt[][];

  constructor(wires: Pt[][]) {
    this.wires = wires;
    for (let w = 0; w < wires.length; w++) {
      const pts = wires[w];
      for (let i = 0; i < pts.length - 1; i++) {
        const s = this.segs.length / 2;
        this.segs.push(w, i);
        const a = pts[i], b = pts[i + 1];
        const x0 = cellOf(Math.min(a[0], b[0])), x1 = cellOf(Math.max(a[0], b[0]));
        const y0 = cellOf(Math.min(a[1], b[1])), y1 = cellOf(Math.max(a[1], b[1]));
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) { this.wide.push(s); continue; }
        for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
          const c = this.cellOfKey.getOrSet(cx, cy, this.lists.length);
          if (c === this.lists.length) this.lists.push([s]); else this.lists[c].push(s);
        }
      }
    }
  }

  /** p 를 지나는 선분을 가진 배선 중 가장 앞 번호. 없으면 -1 */
  firstWireAt(p: Pt): number {
    let best = -1;
    const test = (s: number) => {
      const w = this.segs[s * 2], i = this.segs[s * 2 + 1];
      if (best >= 0 && w >= best) return;
      const pts = this.wires[w];
      if (onSegXY(p[0], p[1], pts[i], pts[i + 1])) best = w;
    };
    const c = this.cellOfKey.get(cellOf(p[0]), cellOf(p[1]));
    if (c >= 0) for (const s of this.lists[c]) test(s);
    for (const s of this.wide) test(s);
    return best;
  }
}

/** 칸 크기 (공간 색인과 같은 값). 렌더러의 색인이 같은 눈금을 쓰도록 내보낸다 */
export { CELL };
