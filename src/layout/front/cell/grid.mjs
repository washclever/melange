/** 격자 — ALIGN cell_fabric/grid.py 의 JS 판.
 *
 *  격자는 (좌표, 속성) 줄의 목록 한 주기다. 격자 번호는 정수 하나(줄 번호를 이어 센 것) 또는 [주기, 줄]
 *  이고, value() 가 실제 좌표를 준다. 줄마다 "합법" 여부가 있어 도형의 끝이 앉을 수 있는 곳을 정한다.
 *
 *    CenteredGrid             offset, offset+pitch/2(합법), offset+pitch
 *    CenterLineGrid           금속 중심선 — 속성은 [폭, 색]
 *    UncoloredCenterLineGrid  같은 폭의 중심선 repeat+1 줄
 *    ColoredCenterLineGrid    색이 번갈아 드는 중심선
 *    EnclosureGrid            도형 끝: offset, +stop(합법), +pitch/2, +pitch-stop(합법), +pitch
 *    SingleGrid               모든 줄이 합법
 */
import { divmod, fdiv } from "../py.mjs";

export class Grid {
  constructor() {
    /** @type {Array<[number, any]>} */
    this.grid = [];
    /** @type {Set<number>} */
    this.legalIndices = new Set();
  }
  semantic() {
    if (!(this.n > 0)) throw new Error("the grid has only one line");
  }
  addGridLine(value, isLegal, attrs = null) {
    this.grid.push([value, attrs]);
    if (isLegal) this.legalIndices.add(this.grid.length - 1);
  }
  copyShift(shift = null) {
    const g = Object.create(Object.getPrototypeOf(this));
    Object.assign(g, this);
    if (shift != null) g.grid = this.grid.map(([c, a]) => [c + shift, a]);
    return g;
  }
  get n() { return this.grid.length - 1; }
  get period() { return this.grid[this.grid.length - 1][0] - this.grid[0][0]; }

  /** 실제 좌표 -> 그 좌표를 감싸는 두 격자 번호 [[q, 아래 줄], [q, 위 줄]] (줄 위면 둘이 같다) */
  inverseBounds(physical) {
    const offset = this.grid[0][0];
    const [q, r] = divmod(physical - offset, this.period);
    const mono = this.grid.map((v, i) => [i, v[0]]).sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < mono.length; i++) {
      const [idx, val] = mono[i];
      if (val - offset === r) return [[q, idx], [q, idx]];
      if (val - offset > r) {
        const prev = mono[i - 1 >= 0 ? i - 1 : mono.length - 1][0];
        return [[q, prev], [q, idx]];
      }
    }
    return null;
  }

  /** 합법 줄로 — direction -1 이면 아래로, 1 이면 위로 */
  snapToLegal(idx, direction) {
    if (idx.length !== 2 || this.legalIndices.size === 0 || (direction !== 1 && direction !== -1))
      throw new Error("snapToLegal: bad argument");
    const all = [...this.legalIndices];
    const legal = all.filter((x) => (direction === -1 ? x <= idx[1] : x >= idx[1]));
    const pick = (xs) => (direction === -1 ? Math.max(...xs) : Math.min(...xs));
    if (legal.length > 0) return [idx[0], pick(legal)];
    return [idx[0] + direction, pick(all)];
  }

  /** 격자 번호 -> [실제 좌표, 속성]. check 면 합법 줄이어야 한다 */
  value(idx, check = true) {
    const n = this.n;
    if (!(n > 0)) throw new Error("the grid has only one line");
    const v = Array.isArray(idx) ? idx[0] * n + idx[1] : idx;
    const [whole, fract] = divmod(v, n);
    if (check && !this.legalIndices.has(fract))
      throw new Error(`grid index ${JSON.stringify(idx)} is not a legal line (n ${n}, line ${fract}, legal ${[...this.legalIndices]})`);
    const [c, attrs] = this.grid[fract];
    return [c + whole * this.period, attrs];
  }
}

export class CenteredGrid extends Grid {
  constructor({ pitch, offset = 0 }) {
    super();
    this.addGridLine(offset, false);
    this.addGridLine(offset + fdiv(pitch, 2), true);
    this.addGridLine(offset + pitch, false);
  }
}

export class CenterLineGrid extends Grid {
  addCenterLine(value, width, isLegal = true, color = null) {
    if (width % 2 !== 0) throw new Error(`centerline width ${width} is odd`);
    this.addGridLine(value, isLegal, [width, color]);
  }
  semantic() {
    super.semantic();
    const a = this.grid[0][1], b = this.grid[this.grid.length - 1][1];
    if (a[0] !== b[0] || a[1] !== b[1]) throw new Error("the first and last lines of a centerline grid differ in width or color");
  }
}

export class UncoloredCenterLineGrid extends CenterLineGrid {
  constructor({ pitch, width, offset = 0, repeat = 1 }) {
    super();
    for (let i = 0; i <= repeat; i++) this.addCenterLine(offset + i * pitch, width);
    this.semantic();
  }
}

export class ColoredCenterLineGrid extends CenterLineGrid {
  constructor({ colors, pitch, width, offset = 0, repeat = null }) {
    if (colors.length % 2 !== 0) throw new Error("odd number of colors");
    super();
    let c = colors;
    if (repeat != null) {
      c = [];
      while (c.length < repeat) c.push(...colors);
      c = c.slice(0, repeat);
    }
    [...c, c[0]].forEach((color, idx) => this.addCenterLine(offset + idx * pitch, width, true, color));
    this.semantic();
  }
}

export class EnclosureGrid extends Grid {
  constructor({ pitch, offset = 0, stoppoint }) {
    super();
    this.addGridLine(offset, false);
    this.addGridLine(offset + stoppoint, true);
    this.addGridLine(offset + fdiv(pitch, 2), false);
    this.addGridLine(offset + pitch - stoppoint, true);
    this.addGridLine(offset + pitch, false);
    this.semantic();
  }
}

export class SingleGrid extends Grid {
  constructor({ pitch, offset = 0, repeat = 1 }) {
    super();
    for (let i = 0; i <= repeat; i++) this.addGridLine(offset + i * pitch, true);
    this.semantic();
  }
}
