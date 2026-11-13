/**
 * 부품을 옮기거나 돌릴 때 붙은 배선이 따라오게 한다 (설계서 E09).
 *
 * 끌기·방향키·정렬·회전·대칭이 모두 이 길을 쓴다. 예전에는 회전에 이 길이 없어서
 * 부품을 돌리면 배선이 제자리에 남고 연결이 끊겼다.
 *
 * ── 무엇을 지키고 무엇을 다시 놓는가
 *
 * 배선을 '지킬 자리' 에서 끊어 본다. 지킬 자리는 **다른 것이 붙어 있는 점**이다 — 다른
 * 배선의 끝이나 꺾점, 움직이지 않는 핀, 넷 라벨, 프로브, 수동 접합점. 그런 점을 옮기면
 * 연결이 바뀌거나 라벨이 넷에서 떨어진다. 움직이는 핀과 지킬 자리 사이의 구간만 버리고,
 * 그 사이를 격자 위 최단 경로로 다시 찾는다 (src/doc/route.ts).
 *
 * 그래서 예전처럼 꺾점이 쌓이지 않는다. 부품을 이리저리 옮기거나 한 바퀴 돌려 놓아도
 * 다시 놓는 구간은 매번 '지금 자리에서의 최단 경로' 이고, 끝 모양은 지나온 길과 상관없다.
 *
 * 움직이는 핀 둘 사이의 구간은 둘이 같이 움직이므로(같은 끌기, 같은 회전) 모양째 옮긴다.
 *
 * 끌기 중에는 매 프레임 **끌기 시작 때의 모양에서** 다시 계산한다 (누적하지 않는다).
 */
import { GRID, pinAt, samePt, transform as xformVec, type Id, type LibPart, type NetLabel, type Part, type Probe, type Pt, type Sheet, type Wire } from "./types.ts";
import { SheetIndex, symbolBox, type IndexedKind } from "./sheet-index.ts";
import { CellMap, dirOf, dirOfVec, route } from "./route.ts";

export interface PartPose { at: Pt; rot: Part["rot"]; mirror: boolean }

/** 배선 위의 마디. 꺾점 번호(i)는 origPts 기준 */
interface Key {
  i: number;
  /** 움직이는 핀이면 그 핀의 옛 자리 키, 지킬 자리면 null */
  pin: string | null;
  /** 지킬 자리이고 움직이지 않는 핀이 거기 있으면 그 핀이 바깥을 보는 방향 */
  out: number;
}

export interface Attachment {
  wireId: Id;
  /** 문서에 들어 있는 그대로의 모양. 끌기를 한 단계로 묶을 때 여기로 되돌린다 */
  docPts: Pt[];
  /** 움직이는 핀과 지킬 자리를 꺾점으로 끼워 넣은 모양 */
  origPts: Pt[];
  /** 배선 순서대로의 마디. 처음과 끝은 늘 배선의 양 끝이다 */
  keys: Key[];
}

const ALL: ReadonlySet<IndexedKind> = new Set<IndexedKind>(["part", "wire", "label", "probe"]);
const ptKey = (p: Pt) => p[0] + "," + p[1];

/** 점이 선분 위에 있는가 (끝 포함). 정수 좌표라 외적이 정확하다 */
function onSeg(p: Pt, a: Pt, b: Pt): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (cross !== 0) return false;
  return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0])
    && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
}
const onWire = (p: Pt, pts: readonly Pt[]) => {
  for (let i = 0; i < pts.length - 1; i++) if (onSeg(p, pts[i], pts[i + 1])) return true;
  return pts.length === 1 && samePt(p, pts[0]);
};

// ── 핀이 바깥을 보는 방향 ─────────────────────────────────────────────
const localOut = new WeakMap<LibPart, Pt[]>();

/**
 * 핀이 기호 바깥을 보는 방향 (기호 좌표, 단위 벡터). 핀에서 시작하는 선(핀 다리)이 있으면
 * 다리 안쪽 끝에서 핀 쪽이다. 없으면 기호 상자 가운데에서 핀 쪽의 더 먼 축.
 */
export function pinOut(lib: LibPart, i: number): Pt {
  let a = localOut.get(lib);
  if (!a) {
    a = lib.symbol.pins.map(p => outward(lib, p.at));
    localOut.set(lib, a);
  }
  return a[i] ?? [0, 0];
}

function outward(lib: LibPart, at: Pt): Pt {
  for (const s of lib.symbol.graphics) {
    if (!("line" in s)) continue;
    const [p, q] = s.line;
    const other = samePt(p, at) ? q : samePt(q, at) ? p : null;
    if (!other) continue;
    const v: Pt = [Math.sign(at[0] - other[0]), Math.sign(at[1] - other[1])];
    if ((v[0] === 0) !== (v[1] === 0)) return v;
  }
  const [x0, y0, x1, y1] = symbolBox(lib, 0, false);
  const dx = at[0] - (x0 + x1) / 2, dy = at[1] - (y0 + y1) / 2;
  if (Math.abs(dx) > Math.abs(dy)) return [Math.sign(dx), 0];
  if (Math.abs(dy) > Math.abs(dx)) return [0, Math.sign(dy)];
  return [0, 0];
}

/** 그 자세에서 핀이 바깥을 보는 방향 (0..3, 없으면 -1). 어시스턴트의 배선 잇기도 쓴다 (doc/wiring.ts) */
export function pinDir(lib: LibPart, i: number, pose: PartPose): number {
  return dirOfVec(xformVec(pinOut(lib, i), pose.rot, pose.mirror));
}

function pinPos(lib: LibPart, i: number, pose: PartPose): Pt {
  return pinAt({ at: pose.at, rot: pose.rot, mirror: pose.mirror } as Part, lib, i);
}

/**
 * 기호의 몸통 상자와 핀 다리 (기호 좌표, 회전 전).
 *
 * 몸통 상자에는 핀 다리를 넣지 않는다. 다리까지 덮는 상자(symbolBox)를 막으면 다리 끝의
 * 핀 바로 옆 칸까지 막혀서, 상자 모서리에 붙은 핀(op-amp 출력)은 들어갈 길이 하나뿐이 된다 —
 * 그 길을 다른 배선이 쓰고 있으면 아예 못 들어가고, 꺾임 하나로 대신 그은 선이 부품을
 * 가로질렀다. 다리는 따로 막는다 (다리를 가로지르는 배선도 핀에 닿은 것처럼 보인다).
 */
const bodies = new WeakMap<LibPart, { box: [number, number, number, number]; legs: Array<[Pt, Pt]> }>();
function bodyOf(lib: LibPart) {
  let b = bodies.get(lib);
  if (b) return b;
  const pins = lib.symbol.pins.map(p => p.at);
  const legs: Array<[Pt, Pt]> = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Pt) => {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  };
  for (const s of lib.symbol.graphics) {
    if ("line" in s) {
      const [p, q] = s.line;
      if (pins.some(a => samePt(a, p) || samePt(a, q))) { legs.push([p, q]); continue; }
      add(p); add(q);
    } else if ("poly" in s) s.poly.forEach(add);
    else if ("rect" in s) {
      const [x, y, w, h] = s.rect;
      add([x, y]); add([x + w, y + h]);
    } else {
      const { c, r } = s.circle;
      add([c[0] - r, c[1] - r]); add([c[0] + r, c[1] + r]);
    }
  }
  // 다리 말고는 그림이 없는 기호면 핀까지 덮는 상자를 쓴다
  if (!isFinite(x0)) [x0, y0, x1, y1] = symbolBox(lib, 0, false);
  b = { box: [x0, y0, x1, y1], legs };
  bodies.set(lib, b);
  return b;
}

/** 부품 하나를 장애물로: 몸통 안의 격자점, 핀 다리 위의 격자점, 핀 */
export function drawPart(map: CellMap, lib: LibPart, pose: PartPose): void {
  const { box, legs } = bodyOf(lib);
  const w = (p: Pt): Pt => {
    const v = xformVec(p, pose.rot, pose.mirror);
    return [pose.at[0] + v[0], pose.at[1] + v[1]];
  };
  const a = w([box[0], box[1]]), b = w([box[2], box[3]]);
  map.box(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
  for (const [p, q] of legs) {
    const s = w(p), e = w(q);
    if (s[0] === e[0] || s[1] === e[1]) map.box(Math.min(s[0], e[0]), Math.min(s[1], e[1]), Math.max(s[0], e[0]), Math.max(s[1], e[1]));
  }
  for (let i = 0; i < lib.symbol.pins.length; i++) {
    const p = pinPos(lib, i, pose);
    map.point(p[0], p[1]);
  }
}

/** 배선 위에 놓인 점들을 꺾점으로 끼워 넣는다. 이미 꺾점인 점은 그대로 */
function weave(pts: Pt[], points: Pt[]): Pt[] {
  const out = pts.map(p => [p[0], p[1]] as Pt);
  for (const p of points) {
    if (out.some(q => samePt(q, p))) continue;
    for (let i = 0; i < out.length - 1; i++) {
      if (onSeg(p, out[i], out[i + 1])) { out.splice(i + 1, 0, [p[0], p[1]]); break; }
    }
  }
  return out;
}

const opposite = (d: number) => (d < 0 ? -1 : (d + 2) & 3);

export interface FollowInput {
  sheet: Sheet;
  library: Record<string, LibPart>;
  /** 움직이는 부품 */
  parts: Part[];
  /** 선택에 들어 있어 통째로 같이 움직이는 배선. 늘이지 않는다 (설계서 명세 5) */
  movingWires?: ReadonlySet<Id>;
  /** 움직이기 전 자리의 색인. 없으면 만든다 */
  index?: SheetIndex;
}

/**
 * 한 번의 옮기기(끌기 한 번, 회전 한 번)에 붙은 배선들.
 *
 * 만들 때 움직이기 전 문서를 읽는다. 끌기 중에는 문서가 바뀌어 있어도 되는데, 움직이는
 * 부품과 붙은 배선은 처음 읽은 모양만 쓰고, 나머지는 끌기 동안 바뀌지 않기 때문이다.
 */
export class Follow {
  readonly attach: Attachment[] = [];
  /** 옛 핀 자리 -> 그 핀 */
  private readonly pins = new Map<string, { part: Part; lib: LibPart; i: number }>();
  /** 움직이는 부품의 처음 자세 */
  private readonly orig = new Map<Id, PartPose>();
  private readonly lib: Record<string, LibPart>;
  private readonly parts: Part[];
  /** 움직이지 않는 것 (처음 묻는 칸 묶음마다 색인에서 채운다) */
  private readonly world: CellMap;
  /** 따라오는 배선 중 그대로 남는 구간 */
  private readonly keep = new CellMap();
  /** 같이 움직이는 배선의 처음 모양 */
  private readonly wiresOrig: Pt[][] = [];
  /** 끌기(평행 이동)용: 처음 자세의 움직이는 것들. 이동량만큼 비켜서 읽는다 */
  private movingAtStart: CellMap | null = null;

  constructor(inp: FollowInput) {
    const { sheet, library } = inp;
    this.lib = library;
    this.parts = inp.parts;
    const movingWires = inp.movingWires ?? new Set<Id>();
    let index = inp.index;
    if (!index) { index = new SheetIndex(); index.sync(sheet, library); }
    const idx = index;

    const movingIds = new Set<Id>();
    for (const part of inp.parts) {
      const lib = library[part.lib];
      movingIds.add(part.id);
      this.orig.set(part.id, { at: [part.at[0], part.at[1]], rot: part.rot, mirror: part.mirror });
      if (!lib) continue;
      for (let i = 0; i < lib.symbol.pins.length; i++) {
        const k = ptKey(pinAt(part, lib, i));
        if (!this.pins.has(k)) this.pins.set(k, { part, lib, i });
      }
    }
    for (const w of sheet.wires) if (movingWires.has(w.id)) this.wiresOrig.push(w.pts.map(p => [p[0], p[1]] as Pt));

    // ── 움직이는 핀에 닿은 배선 (시트 순서)
    const KW = new Set<IndexedKind>(["wire"]);
    let pool: Wire[];
    if (this.pins.size > 2000) pool = sheet.wires;
    else {
      const seen = new Map<Wire, number>();
      for (const k of this.pins.keys()) {
        const [x, y] = k.split(",").map(Number);
        for (const e of idx.query(x, y, x, y, KW)) if (!seen.has(e.obj as Wire)) seen.set(e.obj as Wire, e.index);
      }
      pool = [...seen.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]);
    }
    const attachedIds = new Set<Id>();
    const candidates: Wire[] = [];
    for (const w of pool) {
      if (movingWires.has(w.id) || w.pts.length < 2) continue;
      if (w.pts.some((_, i) => i < w.pts.length - 1 && [...this.pinsOn(w.pts[i], w.pts[i + 1])].length > 0)) {
        candidates.push(w);
        attachedIds.add(w.id);
      }
    }

    // ── 움직이지 않는 세상. 붙은 배선·움직이는 것은 뺀다
    this.world = new CellMap((x0, y0, x1, y1) => {
      for (const e of idx.query(x0, y0, x1, y1, ALL)) {
        if (e.kind === "part") {
          const p = e.obj as Part, lib = library[p.lib];
          if (lib && !movingIds.has(p.id)) drawPart(this.world, lib, p);
        } else if (e.kind === "wire") {
          const w = e.obj as Wire;
          if (!attachedIds.has(w.id) && !movingWires.has(w.id)) this.world.wire(w.pts);
        } else {
          const o = e.obj as NetLabel | Probe;
          this.world.point(o.at[0], o.at[1]);
        }
      }
    });
    for (const j of sheet.junctions) this.world.point(j[0], j[1]);

    // ── 배선마다 지킬 자리와 움직이는 핀
    /*
     * 핀 자리에 다른 것도 붙어 있으면 (배선 여럿이 핀에서 만나거나, 핀 위에 라벨이 있으면)
     * 그 자리는 그대로 두고 **배선 하나만** 거기서 새 핀 자리까지 늘인다. 붙은 배선마다 따로
     * 늘이면 같은 두 점 사이에 길이 여러 갈래로 생겨 고리가 된다.
     */
    const carried = new Set<string>();
    for (const w of candidates) {
      const a = this.plan(w, idx, movingIds, movingWires, sheet.junctions);
      a.keys = a.keys.filter((k, j) => {
        if (k.pin === null) return true;
        const pinned = a.keys.some((o, m) => m !== j && o.i === k.i && o.pin === null);
        if (!pinned) return true;
        if (carried.has(k.pin)) return false;
        carried.add(k.pin);
        return true;
      });
      this.attach.push(a);
      // 그대로 남는 구간은 다른 배선이 비켜 가야 한다
      for (let k = 0; k < a.keys.length - 1; k++) {
        if (a.keys[k].pin === null && a.keys[k + 1].pin === null) {
          this.keep.wire(a.origPts.slice(a.keys[k].i, a.keys[k + 1].i + 1));
        }
      }
    }
  }

  /** 선분 a-b 위에 있는 움직이는 핀의 옛 자리 */
  private *pinsOn(a: Pt, b: Pt): Generator<Pt> {
    if (this.pins.size <= 64) {
      for (const k of this.pins.keys()) {
        const p = k.split(",").map(Number) as Pt;
        if (onSeg(p, a, b)) yield p;
      }
      return;
    }
    // 핀이 많으면 선분 위 격자점을 훑는다 (선분이 길면 핀을 훑는다)
    const len = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    if (len / 10 > this.pins.size || (a[0] !== b[0] && a[1] !== b[1])) {
      for (const k of this.pins.keys()) {
        const p = k.split(",").map(Number) as Pt;
        if (onSeg(p, a, b)) yield p;
      }
      return;
    }
    const steps = Math.max(1, len);
    const sx = Math.sign(b[0] - a[0]), sy = Math.sign(b[1] - a[1]);
    for (let s = 0; s <= steps; s++) {
      const p: Pt = [a[0] + sx * s, a[1] + sy * s];
      if (this.pins.has(ptKey(p))) yield p;
    }
  }

  private plan(w: Wire, idx: SheetIndex, movingIds: Set<Id>, movingWires: ReadonlySet<Id>, junctions: Pt[]): Attachment {
    const docPts = w.pts.map(p => [p[0], p[1]] as Pt);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of docPts) {
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    }

    // 다른 것이 붙어 있는 자리 (움직이지 않는 것만)
    const anchors: Pt[] = [];
    const fixedPin = new Map<string, number>();     // 그 자리에 있는 움직이지 않는 핀의 바깥 방향
    const add = (p: Pt) => { if (onWire(p, docPts)) anchors.push([p[0], p[1]]); };
    for (const e of idx.query(x0, y0, x1, y1, ALL)) {
      if (e.kind === "part") {
        const part = e.obj as Part, lib = this.lib[part.lib];
        if (!lib || movingIds.has(part.id)) continue;
        for (let i = 0; i < lib.symbol.pins.length; i++) {
          const p = pinAt(part, lib, i);
          if (!onWire(p, docPts)) continue;
          anchors.push(p);
          fixedPin.set(ptKey(p), pinDir(lib, i, part));
        }
      } else if (e.kind === "wire") {
        const o = e.obj as Wire;
        if (o.id === w.id || movingWires.has(o.id) || o.pts.length < 2) continue;
        for (const p of o.pts) add(p);
        // 이 배선의 꺾점이 저 배선 위에 놓인 자리 (T 자의 반대쪽)
        for (const p of docPts) if (onWire(p, o.pts)) anchors.push([p[0], p[1]]);
      } else {
        add((e.obj as NetLabel | Probe).at);
      }
    }
    for (const j of junctions) add(j);

    const moving: Pt[] = [];
    for (let i = 0; i < docPts.length - 1; i++) for (const p of this.pinsOn(docPts[i], docPts[i + 1])) moving.push(p);

    const origPts = weave(docPts, [...moving, ...anchors]);
    const n = origPts.length - 1;
    const anchorSet = new Set(anchors.map(ptKey));
    const movingSet = new Set(moving.map(ptKey));
    const keys: Key[] = [];
    origPts.forEach((p, i) => {
      const k = ptKey(p);
      const isPin = movingSet.has(k), isAnchor = anchorSet.has(k) || ((i === 0 || i === n) && !isPin);
      const fixed: Key = { i, pin: null, out: fixedPin.get(k) ?? -1 };
      const mov: Key = { i, pin: k, out: -1 };
      // 한 자리에 둘 다 있으면 (핀 위의 라벨) 배선의 끝 쪽에 핀을 둔다
      if (isPin && isAnchor) keys.push(...(i === 0 ? [mov, fixed] : [fixed, mov]));
      else if (isPin) keys.push(mov);
      else if (isAnchor) keys.push(fixed);
    });
    return { wireId: w.id, docPts, origPts, keys };
  }

  /**
   * 움직인 뒤의 붙은 배선 모양.
   *
   * pose 는 움직이는 부품의 새 자세. rigid 는 움직이는 것 전부에 같은 변환을 했을 때 그 점
   * 변환 (평행 이동, 회전, 대칭) — 움직이는 핀 둘 사이의 구간을 모양째 옮기는 데 쓴다.
   * translate 를 주면 끌기다: 부품이 모두 그만큼 평행 이동했다 (장애물을 다시 그리지 않는다).
   */
  shapes(pose: (part: Part) => PartPose, rigid?: (p: Pt) => Pt, translate?: Pt): Array<{ id: Id; pts: Pt[] }> {
    if (!this.attach.length) return [];
    // 움직인 핀의 새 자리와 방향
    const moved = new Map<string, { at: Pt; dir: number }>();
    for (const a of this.attach) {
      for (const k of a.keys) {
        if (k.pin === null || moved.has(k.pin)) continue;
        const pin = this.pins.get(k.pin)!;
        const ps = pose(pin.part);
        moved.set(k.pin, { at: pinPos(pin.lib, pin.i, ps), dir: pinDir(pin.lib, pin.i, ps) });
      }
    }

    // 움직이는 것들 (부품 몸통·핀, 같이 움직이는 배선)
    let movingAt: (gx: number, gy: number) => number;
    if (translate) {
      if (!this.movingAtStart) this.movingAtStart = this.drawMoving(p => this.orig.get(p.id)!, q => q);
      const m = this.movingAtStart, ox = translate[0] / GRID, oy = translate[1] / GRID;
      movingAt = Number.isInteger(ox) && Number.isInteger(oy) ? (gx, gy) => m.at(gx - ox, gy - oy) : () => 0;
    } else {
      const m = this.drawMoving(pose, rigid ?? (q => q));
      movingAt = (gx, gy) => m.at(gx, gy);
    }
    const routed = new CellMap();
    const flags = (gx: number, gy: number) =>
      this.world.at(gx, gy) | this.keep.at(gx, gy) | movingAt(gx, gy) | routed.at(gx, gy);

    // 1) 구간마다: 그대로 · 모양째 옮기기는 바로 정하고, 다시 찾을 구간은 남겨 둔다
    type Span = { pts: Pt[] | null; a: Key; b: Key };
    const plans = this.attach.map(a => {
      const to = (k: Key): Pt => (k.pin === null ? a.origPts[k.i] : moved.get(k.pin)!.at);
      const spans: Span[] = [];
      for (let s = 0; s < a.keys.length - 1; s++) {
        const ka = a.keys[s], kb = a.keys[s + 1];
        const seg = a.origPts.slice(ka.i, kb.i + 1);
        let pts: Pt[] | null = null;
        if (ka.pin === null && kb.pin === null) pts = seg;
        else if (ka.pin !== null && kb.pin !== null) {
          const fa = a.origPts[ka.i], fb = a.origPts[kb.i], ta = to(ka), tb = to(kb);
          if (rigid && samePt(rigid(fa), ta) && samePt(rigid(fb), tb)) pts = seg.map(rigid);
          else if (ta[0] - fa[0] === tb[0] - fb[0] && ta[1] - fa[1] === tb[1] - fb[1]) {
            pts = seg.map(p => [p[0] + ta[0] - fa[0], p[1] + ta[1] - fa[1]] as Pt);
          }
          if (pts) routed.wire(pts);
        }
        spans.push({ pts, a: ka, b: kb });
      }
      return { a, to, spans };
    });

    // 2) 남은 구간을 최단 경로로. 먼저 놓은 배선은 뒤 배선의 장애물이 된다
    const out: Array<{ id: Id; pts: Pt[] }> = [];
    for (const { a, to, spans } of plans) {
      const n = a.origPts.length - 1;
      const res: Pt[] = [to(a.keys[0])];
      spans.forEach((sp, s) => {
        let pts = sp.pts;
        if (!pts) {
          const from = res[res.length - 1], dest = to(sp.b);
          const ia = sp.a.i, ib = sp.b.i;
          const last = res.length >= 2 ? dirOf(res[res.length - 2], from) : -1;
          const dirA = sp.a.pin !== null ? moved.get(sp.a.pin)!.dir : sp.a.out;
          const dirB = sp.b.pin !== null ? moved.get(sp.b.pin)!.dir : sp.b.out;
          const next = spans[s + 1];
          const ends = {
            inDir: last,
            // 핀이면 바깥으로, 지킬 자리면 원래 나가던 쪽으로
            outDir: dirA >= 0 ? dirA : sp.a.pin === null && ib > ia ? dirOf(a.origPts[ia], a.origPts[ia + 1]) : -1,
            arriveDir: dirB >= 0 ? opposite(dirB) : sp.b.pin === null && ib > ia ? dirOf(a.origPts[ib - 1], a.origPts[ib]) : -1,
            onDir: sp.b.pin === null && ib < n && next?.pts && next.a.pin === null && next.b.pin === null
              ? dirOf(a.origPts[ib], a.origPts[ib + 1]) : -1,
          };
          /*
           * 길이 없으면 그 구간은 원래 모양 그대로 둔다 — 핀이 배선에서 떨어진 것이 보인다
           * (떠 있는 핀 ○, 끊긴 배선 끝 □). 예전처럼 꺾임 하나로 그어 버리면 부품을 가로질러
           * 다른 핀을 밟고 조용히 단락될 수 있었다.
           */
          pts = route(from, dest, flags, ends) ?? (samePt(from, a.origPts[ia]) ? a.origPts.slice(ia, ib + 1) : [from, a.origPts[ia]]);
          routed.wire(pts);
        }
        for (let k = 1; k < pts.length; k++) res.push([pts[k][0], pts[k][1]]);
        if (pts.length && !samePt(res[res.length - 1], pts[pts.length - 1])) res.push(pts[pts.length - 1]);
      });
      out.push({ id: a.wireId, pts: simplify(res) });
    }
    return out;
  }

  /** 끌기·방향키: 움직이는 것이 모두 d 만큼 평행 이동했을 때 */
  translated(d: Pt): Array<{ id: Id; pts: Pt[] }> {
    return this.shapes(
      p => {
        const o = this.orig.get(p.id)!;
        return { at: [o.at[0] + d[0], o.at[1] + d[1]], rot: o.rot, mirror: o.mirror };
      },
      q => [q[0] + d[0], q[1] + d[1]],
      d,
    );
  }

  /** 움직이는 부품(몸통·핀)과 같이 움직이는 배선을 그 자세로 */
  private drawMoving(pose: (part: Part) => PartPose, mapPt: (p: Pt) => Pt): CellMap {
    const m = new CellMap();
    for (const part of this.parts) {
      const lib = this.lib[part.lib];
      if (lib) drawPart(m, lib, pose(part));
    }
    for (const pts of this.wiresOrig) m.wire(pts.map(mapPt));
    return m;
  }
}

/**
 * 길이 0짜리 선분과 일직선으로 이어진 꺾점을 정리한다.
 * 다시 놓은 구간과 지킨 구간이 이어지는 자리에 생기는 군더더기를 문서에 남기지 않는다.
 */
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    if (out.length && samePt(out[out.length - 1], p)) continue;   // 같은 점 반복
    out.push([p[0], p[1]]);
  }
  // 가운데 점이 양옆과 일직선이고 그 사이에 있으면 뺀다 (정수 외적으로 정확히 판정)
  for (let i = 1; i < out.length - 1; ) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const between = Math.min(a[0], c[0]) <= b[0] && b[0] <= Math.max(a[0], c[0])
      && Math.min(a[1], c[1]) <= b[1] && b[1] <= Math.max(a[1], c[1]);
    if (cross === 0 && between) out.splice(i, 1);
    else i++;
  }
  return out;
}
