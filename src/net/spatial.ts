/**
 * 균일 격자 해시 공간 색인 (설계서 '구현 시 고려할 것' 4번).
 *
 * 넷 추출은 '어느 점이 이 선분 위에 있나' 를 선분마다 물어본다. 전체 점을 훑으면
 * 선분 × 점 이라 부품 1,000개에서 O(n²) 가 되고, 실제로 편집 한 번에 300 ms 가 걸렸다.
 * 점을 칸에 나눠 담아 두면 선분의 경계 상자가 닿는 칸만 보면 된다.
 *
 * 좌표가 전부 10 mil 단위 정수라 칸 번호가 정수 나눗셈으로 끝난다. 부동소수점이
 * 끼지 않으므로 같은 점이 두 칸에 걸치는 일이 없다.
 *
 * 칸 키가 충돌해도 결과는 틀리지 않는다 — 후보를 받은 뒤 어차피 정확한 판정을
 * 다시 하기 때문에, 충돌은 후보가 조금 늘어나는 비용일 뿐이다.
 *
 * **키는 문자열이 아니다.** 예전에는 "x,y" 문자열을 Map 의 키로 썼는데, 부품 1만 개
 * 시트에서 넷 추출 시간의 대부분이 문자열을 만들고 해시하고 다시 쪼개는 일이었다.
 * 정수 좌표 쌍을 바로 해시하는 표(PairMap)를 두고, 정수가 아닌 좌표만 예전처럼 문자열
 * 키로 떨어뜨린다. 어떤 입력에서도 결과는 같고, 흔한 경우만 빨라진다.
 */
import type { Pt } from "../doc/types.ts";

/**
 * 칸 한 변의 길이 (10 mil 단위). 격자 100 mil = 10 이므로 8칸짜리 칸이다.
 * 너무 작으면 긴 선분이 많은 칸을 지나고, 너무 크면 칸마다 점이 많아진다.
 */
export const CELL = 80;

export const cellOf = (v: number) => Math.floor(v / CELL);

/** 32비트 정수인가 (-0 은 0 과 같은 자리로 본다 — 문자열 키 "0,…" 와 같다) */
const isI32 = (v: number) => (v | 0) === v;

/**
 * 정수 좌표 쌍 -> 번호. 열린 주소법 해시표다.
 *
 * Map<number, …> 도 생각했지만 좌표 두 개를 숫자 하나로 접으면 2³¹ 을 넘어 힙 숫자가
 * 되고, 그 해시가 문자열만큼 느렸다. 정수 두 개를 Int32Array 에 그대로 두고 직접 섞는다.
 * 정수가 아닌 좌표(격자 밖 주석 따위가 섞인 문서)는 문자열 Map 으로 따로 받는다.
 */
export class PairMap {
  /**
   * 칸마다 [x, y, 번호+1, (빈자리)] 네 칸. 0 이면 빈 칸이라 새로 만든 배열이 곧 빈 표다.
   * 키와 값을 한 배열에 나란히 둔다 — 따로 두면 조회 한 번에 캐시를 세 번 놓친다
   * (부품 5만 개에서 표가 수십 MB 라 거의 매번 놓친다).
   */
  private slots: Int32Array;
  private mask: number;
  private used = 0;
  private other = new Map<string, number>();

  constructor(expected = 16) {
    let cap = 16;
    while (cap < expected * 2) cap <<= 1;
    this.slots = new Int32Array(cap * 4);
    this.mask = cap - 1;
  }

  private slot(x: number, y: number): number {
    let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y ^ 0x5bd1e995, 0x85ebca77);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 13;
    const s = this.slots, m = this.mask;
    let i = h & m;
    while (s[i * 4 + 2] !== 0 && (s[i * 4] !== x || s[i * 4 + 1] !== y)) i = (i + 1) & m;
    return i * 4;
  }

  get(x: number, y: number): number {
    if (!isI32(x) || !isI32(y)) return this.other.get(x + "," + y) ?? -1;
    return this.slots[this.slot(x, y) + 2] - 1;
  }

  /** 있으면 그 번호, 없으면 v 를 넣고 v. 넣었는지는 돌려준 값이 v 인지로 안다 */
  getOrSet(x: number, y: number, v: number): number {
    if (!isI32(x) || !isI32(y)) {
      const k = x + "," + y;
      const got = this.other.get(k);
      if (got !== undefined) return got;
      this.other.set(k, v);
      return v;
    }
    const i = this.slot(x, y), s = this.slots;
    if (s[i + 2] !== 0) return s[i + 2] - 1;
    s[i] = x; s[i + 1] = y; s[i + 2] = v + 1;
    if (++this.used * 2 > this.mask) this.grow();
    return v;
  }

  private grow() {
    const old = this.slots;
    this.slots = new Int32Array(old.length * 2);
    this.mask = (this.slots.length >> 2) - 1;
    for (let i = 0; i < old.length; i += 4) {
      if (old[i + 2] === 0) continue;
      const j = this.slot(old[i], old[i + 1]);
      this.slots[j] = old[i]; this.slots[j + 1] = old[i + 1]; this.slots[j + 2] = old[i + 2];
    }
  }
}

export class PointIndex {
  /** 칸 -> 칸 번호 */
  private cells: PairMap;
  /** 칸 번호 c 의 점들은 members[start[c] .. start[c+1]) 에 넣은 순서대로 있다 */
  readonly start: Int32Array;
  readonly members: Int32Array;
  private readonly xs: ArrayLike<number>;
  private readonly ys: ArrayLike<number>;
  readonly size: number;
  private readonly cellCount: number;

  /** 점 배열로 만든다. 번호는 넣은 순서다 */
  constructor(points: Iterable<Pt>);
  /** 좌표 배열 두 개로 만든다 (넷 추출이 쓰는 길 — 점마다 배열을 만들지 않는다) */
  constructor(xs: ArrayLike<number>, ys: ArrayLike<number>, count: number);
  constructor(a: Iterable<Pt> | ArrayLike<number>, b?: ArrayLike<number>, count?: number) {
    if (b === undefined) {
      const xs: number[] = [], ys: number[] = [];
      for (const p of a as Iterable<Pt>) { xs.push(p[0]); ys.push(p[1]); }
      this.xs = xs; this.ys = ys; this.size = xs.length;
    } else {
      this.xs = a as ArrayLike<number>; this.ys = b; this.size = count!;
    }
    const n = this.size;
    // 칸 번호를 매기고 (처음 본 순서), 칸마다 몇 개인지 센 뒤, 넣은 순서대로 채운다
    this.cells = new PairMap(Math.max(16, n >> 2));
    const cellOfPt = new Int32Array(n);
    let cellCount = 0;
    const counts: number[] = [];
    for (let i = 0; i < n; i++) {
      const c = this.cells.getOrSet(cellOf(this.xs[i]), cellOf(this.ys[i]), cellCount);
      if (c === cellCount) { cellCount++; counts.push(0); }
      cellOfPt[i] = c;
      counts[c]++;
    }
    this.cellCount = cellCount;
    this.start = new Int32Array(cellCount + 1);
    for (let c = 0; c < cellCount; c++) this.start[c + 1] = this.start[c] + counts[c];
    const fill = this.start.slice(0, cellCount);
    this.members = new Int32Array(n);
    for (let i = 0; i < n; i++) this.members[fill[cellOfPt[i]]++] = i;
  }

  /** 칸 (cx, cy) 의 번호. 비었으면 -1 */
  cell(cx: number, cy: number): number {
    return this.cells.get(cx, cy);
  }

  /**
   * 선분의 경계 상자가 닿는 칸의 점 번호를 돌려 준다. 실제로 선분 위인지는 호출하는 쪽에서
   * 정수 외적으로 확인한다 — 여기서는 후보를 줄이기만 한다.
   *
   * 순서가 정해져 있다: 칸은 x 먼저, 그 안에서 y, 칸 안에서는 넣은 순서. 넷 추출이 이 순서로
   * union 을 하고, union 순서가 넷의 대표점을 정하고, 대표점 순서가 자동 넷 이름(N001...)을
   * 정한다. 순서를 바꾸면 같은 회로가 다른 이름을 받는다.
   *
   * 가로·세로 선분이면 경계 상자가 칸 한 줄이라 딱 그 줄만 본다. 설계서상 꺾점은
   * 늘 격자 위이고 배선은 대부분 직각이라, 이 경우가 대부분이다.
   */
  eachNear(a: Pt, b: Pt, fn: (i: number) => void): void {
    const x0 = cellOf(Math.min(a[0], b[0])), x1 = cellOf(Math.max(a[0], b[0]));
    const y0 = cellOf(Math.min(a[1], b[1])), y1 = cellOf(Math.max(a[1], b[1]));
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const c = this.cells.get(cx, cy);
        if (c < 0) continue;
        for (let k = this.start[c], e = this.start[c + 1]; k < e; k++) fn(this.members[k]);
      }
    }
  }

  /** eachNear 와 같은 후보를 점으로 (검증용) */
  near(a: Pt, b: Pt): Pt[] {
    const out: Pt[] = [];
    this.eachNear(a, b, i => { out.push([this.xs[i], this.ys[i]]); });
    return out;
  }

  /** 그 점과 같은 칸에 있는 점들 */
  at(p: Pt): Pt[] {
    const c = this.cells.get(cellOf(p[0]), cellOf(p[1]));
    const out: Pt[] = [];
    if (c >= 0) for (let k = this.start[c]; k < this.start[c + 1]; k++) out.push([this.xs[this.members[k]], this.ys[this.members[k]]]);
    return out;
  }

  /** 칸마다 몇 개씩 들었는지 (색인이 실제로 일하고 있는지 보는 용도) */
  stats(): { cells: number; max: number; avg: number } {
    let max = 0;
    for (let c = 0; c < this.cellCount; c++) max = Math.max(max, this.start[c + 1] - this.start[c]);
    return { cells: this.cellCount, max, avg: this.cellCount ? this.size / this.cellCount : 0 };
  }
}
