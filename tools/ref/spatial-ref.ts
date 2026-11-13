// 기준 구현 — 예전 문자열 키 공간 색인의 얼린 사본 (tools/ref/extract-ref.ts 가 쓴다). 고치지 않는다.
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
 */
import type { Pt } from "../../src/doc/types.ts";

/**
 * 칸 한 변의 길이 (10 mil 단위). 격자 100 mil = 10 이므로 8칸짜리 칸이다.
 * 너무 작으면 긴 선분이 많은 칸을 지나고, 너무 크면 칸마다 점이 많아진다.
 */
export const CELL = 80;

const cellOf = (v: number) => Math.floor(v / CELL);
const ckey = (cx: number, cy: number) => cx + "," + cy;

export class PointIndex {
  private cells = new Map<string, Pt[]>();
  readonly size: number;

  constructor(points: Iterable<Pt>) {
    let n = 0;
    for (const p of points) {
      const k = ckey(cellOf(p[0]), cellOf(p[1]));
      const list = this.cells.get(k);
      if (list) list.push(p); else this.cells.set(k, [p]);
      n++;
    }
    this.size = n;
  }

  /**
   * 선분의 경계 상자가 닿는 칸의 점들을 준다. 실제로 선분 위인지는 호출하는 쪽에서
   * 정수 외적으로 확인한다 — 여기서는 후보를 줄이기만 한다.
   *
   * 가로·세로 선분이면 경계 상자가 칸 한 줄이라 딱 그 줄만 본다. 설계서상 꺾점은
   * 늘 격자 위이고 배선은 대부분 직각이라, 이 경우가 대부분이다.
   */
  near(a: Pt, b: Pt): Pt[] {
    const x0 = cellOf(Math.min(a[0], b[0])), x1 = cellOf(Math.max(a[0], b[0]));
    const y0 = cellOf(Math.min(a[1], b[1])), y1 = cellOf(Math.max(a[1], b[1]));
    const out: Pt[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.cells.get(ckey(cx, cy));
        if (list) out.push(...list);
      }
    }
    return out;
  }

  /** 그 점과 같은 칸에 있는 점들 */
  at(p: Pt): Pt[] {
    return this.cells.get(ckey(cellOf(p[0]), cellOf(p[1]))) ?? [];
  }

  /** 칸마다 몇 개씩 들었는지 (색인이 실제로 일하고 있는지 보는 용도) */
  stats(): { cells: number; max: number; avg: number } {
    let max = 0, total = 0;
    for (const list of this.cells.values()) { max = Math.max(max, list.length); total += list.length; }
    return { cells: this.cells.size, max, avg: this.cells.size ? total / this.cells.size : 0 };
  }
}
