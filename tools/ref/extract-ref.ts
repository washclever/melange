// 기준 구현 — 문자열 키로 짠 예전 넷 추출을 그대로 얼려 둔 사본이다.
// src/net/extract.ts 를 빠르게 다시 짜면서 결과(넷 이름·순서·접합점까지)가 한 글자도
// 달라지지 않았는지 tools/verify-extract.ts 가 이것과 통째로 비교한다. 고치지 않는다.
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
 */
import { key, type Pt, type Sheet, type LibPart, pinAt } from "../../src/doc/types.ts";
import { PointIndex } from "./spatial-ref.ts";

export interface Extraction {
  /** "partId:pinId" -> 넷 이름 */
  pinNet: Map<string, string>;
  /** 넷 이름 -> 그 넷에 속한 좌표들 */
  nets: Map<string, Pt[]>;
  /** 자동 접합점. 저장하지 않고 매번 계산한다 */
  junctions: Pt[];
  warnings: string[];
  /**
   * 임의의 좌표가 어느 넷인지. 프로브가 꽂힌 자리를 넷으로 바꾸는 데 쓴다.
   * 연결점 위가 아니어도 배선 선분 위면 그 넷을 준다. 아무 데도 아니면 null.
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

// ── union-find ────────────────────────────────────────────────────────
class DSU {
  private p = new Map<string, string>();
  find(a: string): string {
    let r = this.p.get(a);
    if (r === undefined) { this.p.set(a, a); return a; }
    while (r !== this.p.get(r)!) r = this.p.get(r)!;
    // 경로 압축
    let c = a;
    while (c !== r) { const n = this.p.get(c)!; this.p.set(c, r); c = n; }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
  has(a: string): boolean { return this.p.has(a); }
  keys(): string[] { return [...this.p.keys()]; }
}

/** 점이 선분 위에 있는가 (끝점 포함). 좌표가 정수라 외적이 정확하다 */
export function onSegment(p: Pt, a: Pt, b: Pt): boolean {
  const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
  if (cross !== 0) return false;
  return p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
    && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}

const parseKey = (k: string): Pt => {
  const [x, y] = k.split(",");
  return [Number(x), Number(y)];
};

export function extractNetsRef(sheet: Sheet, library: Record<string, LibPart>): Extraction {
  const dsu = new DSU();
  const warnings: string[] = [];

  // 좌표 -> 그 자리에 있는 핀들
  const pinsAt = new Map<string, string[]>();

  // ── 1. 모든 연결점을 등록한다
  for (const w of sheet.wires) {
    if (w.pts.length < 2) continue;
    const root = key(w.pts[0]);
    // 하나의 폴리라인은 전체가 한 도체다
    for (const p of w.pts) dsu.union(key(p), root);
  }

  for (const part of sheet.parts) {
    const lib = library[part.lib];
    if (!lib) { warnings.push(`${part.ref}: ${part.lib} is not in the library`); continue; }
    lib.symbol.pins.forEach((pin, i) => {
      const at = pinAt(part, lib, i);
      const k = key(at);
      dsu.find(k);                       // 좌표가 같으면 자동으로 같은 집합 (규칙 1, 6)
      const list = pinsAt.get(k) ?? [];
      list.push(part.id + ":" + pin.id);
      pinsAt.set(k, list);
    });
  }

  for (const l of sheet.labels) dsu.find(key(l.at));
  for (const j of sheet.junctions) dsu.find(key(j));

  /*
   * ── 2. 선분 위에 놓인 점을 잇고, 같은 순회에서 가지 수도 센다.
   *
   * 십자 교차는 그 자리에 점이 없으면 아무 일도 안 일어난다 (규칙 5).
   *
   * 예전에는 선분마다 전체 점을 훑어 O(선분 × 점) 이었고, 부품 1,000개 시트에서
   * 편집 한 번에 300 ms 가 걸렸다. 공간 색인으로 선분이 닿는 칸의 점만 본다.
   * 접합점 세기도 여기서 같이 처리한다 — 어차피 같은 '점이 선분 위인가' 질문이라,
   * 따로 돌면 같은 O(n²) 를 한 번 더 내는 셈이었다.
   */
  const pts = dsu.keys().map(parseKey);
  const index = new PointIndex(pts);
  /** 좌표 -> 그 자리에 모인 가지 수. 3개 이상이면 접합점을 찍는다 */
  const branches = new Map<string, number>();
  const bump = (k: string, n: number) => branches.set(k, (branches.get(k) ?? 0) + n);

  for (const w of sheet.wires) {
    if (w.pts.length < 2) continue;
    const root = key(w.pts[0]);
    for (let i = 0; i < w.pts.length - 1; i++) {
      const a = w.pts[i], b = w.pts[i + 1];
      for (const p of index.near(a, b)) {
        if (!onSegment(p, a, b)) continue;
        const k = key(p);
        if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === b[0] && p[1] === b[1])) {
          bump(k, 1);                 // 선분의 끝에 걸친 점
        } else {
          dsu.union(k, root);         // 선분 중간 -> 연결 (규칙 2, 3)
          bump(k, 2);                 // 지나가는 배선은 가지 둘
        }
      }
    }
  }

  // ── 3. 이름이 같은 라벨끼리 잇는다 (규칙 7). 대소문자 무시
  const byName = new Map<string, string[]>();
  for (const l of sheet.labels) {
    const n = l.name.trim().toLowerCase();
    if (!n) continue;
    const list = byName.get(n) ?? [];
    list.push(key(l.at));
    byName.set(n, list);
  }
  for (const list of byName.values()) {
    for (let i = 1; i < list.length; i++) dsu.union(list[0], list[i]);
  }

  // GND 기호의 핀도 묶는다
  const gndRoots = new Set<string>();
  for (const part of sheet.parts) {
    const lib = library[part.lib];
    if (lib?.id === "gnd") gndRoots.add(dsu.find(key(pinAt(part, lib, 0))));
  }
  for (const l of sheet.labels) {
    if (l.kind === "gnd") gndRoots.add(dsu.find(key(l.at)));
  }

  // ── 4. 넷마다 이름을 정한다 (규칙 8)
  // 이름은 대소문자를 무시하므로 out 과 OUT 은 '다른 라벨 둘' 이 아니라 한 이름이다.
  // 소문자로 묶되 사용자가 처음 적은 철자를 그대로 쓴다.
  //
  // 이름 우선순위는 넷 라벨 > 전원 기호 > 자동 이름이다 (규칙 8). 한 넷에 둘 다 있으면
  // 넷 라벨이 이긴다 — 전원 기호는 VCC 처럼 넓게 퍼지는 이름이라, 그 자리에
  // 사용자가 따로 붙인 이름이 있으면 그쪽이 더 구체적인 의도다.
  const rootLabels = new Map<string, string[]>();
  const rootPower = new Map<string, string[]>();
  for (const l of sheet.labels) {
    if (l.kind === "gnd" || !l.name.trim()) continue;
    const bucket = l.kind === "power" ? rootPower : rootLabels;
    const r = dsu.find(key(l.at));
    const list = bucket.get(r) ?? [];
    if (!list.some(x => x.toLowerCase() === l.name.toLowerCase())) list.push(l.name);
    bucket.set(r, list);
  }

  const used = new Set<string>(["0"]);
  for (const names of rootLabels.values()) for (const n of names) used.add(n.toLowerCase());
  for (const names of rootPower.values()) for (const n of names) used.add(n.toLowerCase());

  const nameOf = new Map<string, string>();
  for (const r of gndRoots) nameOf.set(r, "0");

  let auto = 0;
  const nextAuto = (): string => {
    let n: string;
    do { auto++; n = "N" + String(auto).padStart(3, "0"); } while (used.has(n.toLowerCase()));
    used.add(n.toLowerCase());
    return n;
  };

  // 결과가 결정적이도록 루트를 정렬해 둔다
  const roots = [...new Set(dsu.keys().map(k => dsu.find(k)))].sort();
  for (const r of roots) {
    if (nameOf.has(r)) continue;
    // 넷 라벨이 있으면 그것, 없으면 전원 기호, 둘 다 없으면 자동 이름
    const labels = rootLabels.get(r) ?? rootPower.get(r);
    if (labels?.length) {
      // 사전순은 대소문자를 무시하고 비교한다. 안 그러면 UTF-16 순서 때문에
      // OUT 이 out 을 이기는 식으로 철자에 따라 결과가 달라진다
      const sorted = [...labels].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), "en"));
      if (sorted.length > 1) {
        warnings.push(`One net has several labels: ${sorted.join(", ")} → ${sorted[0]} is used`);
      }
      nameOf.set(r, sorted[0]);
    } else {
      nameOf.set(r, nextAuto());
    }
  }

  // ── 5. 핀 -> 넷 이름, 넷 -> 좌표
  const pinNet = new Map<string, string>();
  for (const [k, list] of pinsAt) {
    const n = nameOf.get(dsu.find(k))!;
    for (const id of list) pinNet.set(id, n);
  }

  const nets = new Map<string, Pt[]>();
  for (const k of dsu.keys()) {
    const n = nameOf.get(dsu.find(k))!;
    const list = nets.get(n) ?? [];
    list.push(parseKey(k));
    nets.set(n, list);
  }

  // ── 6. 자동 접합점: 한 점에 가지가 3개 이상 모이면 점을 찍는다.
  //     가지 수는 2번에서 이미 세어 두었고, 여기서는 핀 개수만 더한다
  const junctions: Pt[] = [];
  for (const k of dsu.keys()) {
    const total = (branches.get(k) ?? 0) + (pinsAt.get(k)?.length ?? 0);
    if (total >= 3) junctions.push(parseKey(k));
  }

  // ── 7. 좌표 -> 넷 조회 (프로브용)
  const nameByKey = new Map<string, string>();
  for (const k of dsu.keys()) nameByKey.set(k, nameOf.get(dsu.find(k))!);

  const netAt = (p: Pt): string | null => {
    const direct = nameByKey.get(key(p));
    if (direct !== undefined) return direct;
    // 연결점은 아니지만 배선 선분 위일 수 있다
    for (const w of sheet.wires) {
      for (let i = 0; i < w.pts.length - 1; i++) {
        if (onSegment(p, w.pts[i], w.pts[i + 1])) return nameByKey.get(key(w.pts[0])) ?? null;
      }
    }
    return null;
  };

  /*
   * ── 8. 끝나지 않은 곳과 의미를 잃은 접합점 (설계서 12-6, 12-7)
   *
   * 가지 수는 2번에서 이미 세어 두었으므로 여기서는 읽기만 한다.
   *   가지 0  — 배선이 전혀 안 닿은 핀
   *   가지 1  — 한쪽만 물린 배선 끝 (어디로도 이어지지 않음)
   * 핀이 둘 이상 겹친 자리는 배선 없이도 연결된 것이므로 (규칙 6) 떠 있는 게 아니다.
   */
  const danglingPins: Pt[] = [];
  const looseEnds: Pt[] = [];
  // 넷 라벨이 놓인 자리는 끝난 곳이다 (규칙 7). 얼려 둔 구현이지만 이 판정은 뜻을 바꿨으므로 같이 바꾼다
  const labelled = new Set(sheet.labels.map(l => key(l.at)));
  for (const k of dsu.keys()) {
    const wireBranches = branches.get(k) ?? 0;
    const pins = pinsAt.get(k)?.length ?? 0;
    if (labelled.has(k)) continue;
    if (pins > 0) {
      if (wireBranches === 0 && pins === 1) danglingPins.push(parseKey(k));
    } else if (wireBranches === 1) {
      looseEnds.push(parseKey(k));
    }
  }

  // 수동 접합점은 배선이 둘 이상 지날 때만 의미가 있다. 가지가 3개 미만이면 치운다
  const staleJunctions = sheet.junctions.filter(j => {
    const k = key(j);
    return ((branches.get(k) ?? 0) + (pinsAt.get(k)?.length ?? 0)) < 3;
  });

  return { pinNet, nets, junctions, warnings, netAt, danglingPins, looseEnds, staleJunctions };
}
