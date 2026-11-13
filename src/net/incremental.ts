/**
 * 증분 넷 추출 — 편집할 때마다 **바뀐 객체의 입력만** 다시 만든다.
 *
 * 넷 추출(src/net/extract.ts)은 입력 만들기와 풀기로 나뉜다. 입력 만들기 — 좌표마다 번호를
 * 붙이는 해시, 배선마다 선분 중간에 놓인 점을 찾는 공간 질의, 핀 이름 문자열 — 가 비싸고,
 * 그 대부분은 편집 한 번에 거의 바뀌지 않는다. 여기서는 그것을 객체마다 들고 있다가 시트 색인이
 * 알려 준 바뀐 객체만 다시 만든다.
 *
 * 풀기는 extractNets 와 **같은 함수(solve)** 다. 자동 넷 이름은 union 순서로 정해지고 그 순서는
 * 시트 전체에 걸쳐 있어서 풀기는 매번 처음부터 한다 — 다만 해시도 문자열도 없이 번호 배열만
 * 돈다. 그래서 결과는 extractNets 를 처음부터 부른 것과 한 글자도 다르지 않다.
 * tools/verify-incremental.ts 가 무작위 편집(명령·실행 취소·다시 실행·문서 갈아끼우기)
 * 수백 번 동안 매번 둘을 통째로 견준다.
 *
 * 점 번호는 여러 객체가 같이 쓴다(배선 끝과 핀이 같은 자리). 그래서 번호마다 몇 객체가 쓰는지
 * 센다. 0 이 되면 그 점은 없어진 것이고, 0 에서 1 이 되면 새로 생긴 것이다. 점이 생기거나
 * 없어지면 그 자리를 지나는 다른 배선의 '선분 중간의 점' 이 바뀌므로, 그 배선만 다시 찾는다
 * (선분 색인으로 그 자리를 지나는 배선을 찾는다).
 */
import { pinAt, type LibPart, type NetLabel, type Part, type Pt, type Sheet, type Wire } from "../doc/types.ts";
import type { Entry, SheetIndex } from "../doc/sheet-index.ts";
import { PairMap, cellOf } from "./spatial.ts";
import { Scratch, extractNets, innerPoints, solve, type Extraction } from "./extract.ts";

/*
 * 객체마다의 입력은 시트 색인의 항목(Entry.ext)에 직접 단다 — 편집마다 시트 순서로 이어 붙일 때
 * 객체마다 Map 을 찾으면 그것만으로 몇 ms 다. gen 은 '이번 판' 의 것인지 가리는 표시다: 처음부터
 * 다시 만들 때 판이 바뀌므로, 항목에 남아 있던 예전 판의 입력은 없는 것으로 본다.
 */
interface WireRec { gen: number; pts: Pt[]; v: number[]; inner: number[]; dirty: boolean; cells: number[]; wide: boolean }
interface PartRec { gen: number; at: Pt; rot: number; mirror: boolean; lib: LibPart | undefined; libName: string; ref: string; ok: boolean; gnd: boolean; pins: number[]; refs: string[] }
interface LabelRec { gen: number; at: Pt; pt: number; name: string; kind: NetLabel["kind"] }

/** 선분 색인 칸을 이보다 많이 차지하는 배선(아주 긴 대각선)은 따로 둔다 */
const MAX_CELLS = 64;

export class IncrementalNets {
  private sheet: Sheet | null = null;
  // ── 점 번호표 (지금 쓰는 객체 수를 센다)
  private ids = new PairMap(1024);
  private xs = new Float64Array(1024);
  private ys = new Float64Array(1024);
  private refc = new Int32Array(1024);
  private count = 0;
  private live = 0;
  /** 점 칸 색인: 칸 -> 점 번호들. 없어진 점도 남아 있다 (쓸 때 refc 로 거른다) */
  private pcell = new PairMap(1024);
  private plists: number[][] = [];
  /** 선분 칸 색인: 칸 -> 그 칸을 지나는 배선들 */
  private scell = new PairMap(1024);
  private slists: Array<Set<WireRec>> = [];
  private wide = new Set<WireRec>();
  /** 지금 판. 처음부터 다시 만들 때마다 바뀐다 */
  private gen = 0;
  /** 점 번호 -> 그 좌표의 배열. 결과 목록(접합점 따위)이 편집마다 새 배열을 만들지 않게 */
  private ptCache: Pt[] = [];
  private junctionSnap: Pt[] = [];
  private junctionIds: number[] = [];
  /** 이번 갱신에서 생기거나 없어진 점 */
  private touched: number[] = [];
  /** '선분 중간의 점' 을 다시 찾을 배선 */
  private dirty: WireRec[] = [];
  /** 풀기에 넘길 작업용 배열 (편집마다 다시 쓴다) */
  private scratch = new Scratch();
  /** 측정용: 지난 갱신에서 다시 만든 객체 수, 처음부터 다시 했는지, 했다면 왜 */
  stats: { rebuilt: number; full: boolean; why: "" | "reset" | "dupes" | "recover" | "compact" } = { rebuilt: 0, full: false, why: "" };

  /**
   * 시트 색인을 맞춘 직후(sync) 부른다. 색인이 알려 준 바뀐 객체만 다시 만들고 풀어서 넷 추출
   * 결과를 준다. 같은 id 가 둘인 깨진 문서, 문서 교체, 빈자리가 너무 많아졌을 때는 처음부터 한다.
   */
  update(sheet: Sheet, library: Record<string, LibPart>, index: SheetIndex,
         change: { changed: Entry[]; removed: Entry[]; reset: boolean }): Extraction {
    if (index.hasDupes) {
      // 같은 id 가 둘이면 항목이 매번 새로 생겨 객체마다 들고 있을 수가 없다. 통째로 뽑는다
      this.sheet = null;
      this.stats = { rebuilt: sheet.parts.length + sheet.wires.length, full: true, why: "dupes" };
      return extractNets(sheet, library);
    }
    const why = change.reset ? "reset" : this.sheet === null && this.gen > 0 ? "recover"
      : sheet !== this.sheet ? "reset" : this.count > 4096 && this.live * 2 < this.count ? "compact" : "";
    const full = why !== "";
    let rebuilt = 0;
    if (full) {
      this.clear(sheet);
      for (const e of index.ordered.wire) { this.setWire(e); rebuilt++; }
      for (const e of index.ordered.part) { this.setPart(e, library); rebuilt++; }
      for (const e of index.ordered.label) this.setLabel(e);
    } else {
      for (const e of change.removed) {
        if (e.kind === "wire") this.dropWire(e);
        else if (e.kind === "part") this.dropPart(e);
        else if (e.kind === "label") this.dropLabel(e);
      }
      for (const e of change.changed) {
        if (e.kind === "wire") { if (this.setWire(e)) rebuilt++; }
        else if (e.kind === "part") { if (this.setPart(e, library)) rebuilt++; }
        else if (e.kind === "label") this.setLabel(e);
      }
    }
    // 수동 접합점: 몇 개 안 되므로 바뀌었으면 통째로
    const js = sheet.junctions;
    if (full || js.length !== this.junctionSnap.length || js.some((j, i) => j !== this.junctionSnap[i])) {
      for (const id of this.junctionIds) this.release(id);
      this.junctionIds = js.map(j => this.acquire(j[0], j[1]));
      this.junctionSnap = js.slice();
    }

    // 생기거나 없어진 점이 중간에 놓인 배선은 '선분 중간의 점' 을 다시 찾는다
    for (const id of this.touched) {
      const x = this.xs[id], y = this.ys[id];
      const c = this.scell.get(cellOf(x), cellOf(y));
      const check = (r: WireRec) => {
        if (r.dirty) return;
        for (let i = 0; i < r.pts.length - 1; i++) {
          const a = r.pts[i], b = r.pts[i + 1];
          if ((x === a[0] && y === a[1]) || (x === b[0] && y === b[1])) continue;
          if (onSeg(x, y, a, b)) { r.dirty = true; this.dirty.push(r); return; }
        }
      };
      if (c >= 0) for (const r of this.slists[c]) check(r);
      for (const r of this.wide) check(r);
    }
    this.touched.length = 0;
    const each = (cx0: number, cy0: number, cx1: number, cy1: number, fn: (id: number) => void) => {
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
        const c = this.pcell.get(cx, cy);
        if (c < 0) continue;
        for (const id of this.plists[c]) if (this.refc[id] > 0) fn(id);
      }
    };
    for (const r of this.dirty) {
      if (!r.dirty) continue;          // 그사이 지워진 배선 (dropWire 가 표시를 걷었다)
      r.dirty = false;
      r.inner.length = 0;
      if (r.v.length >= 2) for (let i = 0; i < r.pts.length - 1; i++) innerPoints(r.pts[i], r.pts[i + 1], this.xs, this.ys, each, r.inner);
    }
    this.dirty.length = 0;
    this.stats = { rebuilt, full, why };

    return solve(this.flatten(index), this.scratch);
  }

  /** 객체마다 든 입력을 시트 순서로 이어 붙인다 (풀기의 입력). 번호 배열을 복사할 뿐이다 */
  private flatten(index: SheetIndex) {
    const ow = index.ordered.wire, op = index.ordered.part, ol = index.ordered.label;
    let nv = 0, ni = 0, np = 0;
    const wr: WireRec[] = new Array(ow.length), pr: PartRec[] = new Array(op.length);
    for (let k = 0; k < ow.length; k++) { const r = wr[k] = this.rec<WireRec>(ow[k])!; nv += r.v.length; ni += r.inner.length; }
    for (let k = 0; k < op.length; k++) { const r = pr[k] = this.rec<PartRec>(op[k])!; np += r.pins.length; }
    const sc = this.scratch;
    const wireAt = sc.i32("wireAt", ow.length + 1, 0), wireV = sc.i32("wireV", nv, 0);
    const innerAt = sc.i32("innerAt", ow.length + 1, 0), innerV = sc.i32("innerV", ni, 0);
    let a = 0, b = 0;
    for (let k = 0; k < ow.length; k++) {
      const r = wr[k];
      wireAt[k] = a; innerAt[k] = b;
      for (const id of r.v) wireV[a++] = id;
      for (const id of r.inner) innerV[b++] = id;
    }
    wireAt[ow.length] = a; innerAt[ow.length] = b;
    const P = op.length;
    const partOk = new Uint8Array(P), partGnd = new Uint8Array(P);
    const partRef: string[] = new Array(P), partLib: string[] = new Array(P), partId: string[] = new Array(P);
    const pinAtArr = sc.i32("pinAt", P + 1, 0), pinV = sc.i32("pinV", np, 0), pinRefs: string[] = new Array(np);
    let q = 0;
    for (let k = 0; k < P; k++) {
      const r = pr[k];
      partOk[k] = r.ok ? 1 : 0; partGnd[k] = r.gnd ? 1 : 0; partRef[k] = r.ref; partLib[k] = r.libName;
      partId[k] = (op[k].obj as Part).id;
      pinAtArr[k] = q;
      for (let i = 0; i < r.pins.length; i++, q++) { pinV[q] = r.pins[i]; pinRefs[q] = r.refs[i]; }
    }
    pinAtArr[P] = q;
    const L = ol.length;
    const labelPt = new Int32Array(L), labelName: string[] = new Array(L), labelKind: NetLabel["kind"][] = new Array(L);
    for (let k = 0; k < L; k++) {
      const r = this.rec<LabelRec>(ol[k])!;
      labelPt[k] = r.pt; labelName[k] = r.name; labelKind[k] = r.kind;
    }
    return {
      count: this.count, xs: this.xs, ys: this.ys, ids: this.ids,
      wireAt, wireV, innerAt, innerV, partOk, partGnd, partRef, partLib, partId, pinAt: pinAtArr, pinV, pinRefs,
      labelPt, labelName, labelKind, junctions: Int32Array.from(this.junctionIds),
      junctionPts: this.junctionSnap, wireGeom: wr.map(r => r.pts), ptCache: this.ptCache,
    };
  }

  // ── 객체 하나씩 ──────────────────────────────────────────────────────
  private rec<T extends { gen: number }>(e: Entry): T | undefined {
    const r = e.ext as T | undefined;
    return r && r.gen === this.gen ? r : undefined;
  }

  /** 배선을 (다시) 만든다. 모양이 그대로면 아무것도 안 하고 false */
  private setWire(e: Entry): boolean {
    const w = e.obj as Wire;
    const old = this.rec<WireRec>(e);
    if (old && old.pts === w.pts) return false;
    if (old) this.dropWire(e);
    const v = w.pts.length >= 2 ? w.pts.map(p => this.acquire(p[0], p[1])) : [];
    const r: WireRec = { gen: this.gen, pts: w.pts, v, inner: [], dirty: true, cells: [], wide: false };
    e.ext = r;
    this.dirty.push(r);
    // 선분 색인에 넣는다 (다른 점이 이 배선의 중간에 생기거나 없어질 때 찾으려고)
    if (v.length >= 2) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of w.pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      const cx0 = cellOf(x0), cy0 = cellOf(y0), cx1 = cellOf(x1), cy1 = cellOf(y1);
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > MAX_CELLS || !isFinite(cx0 + cx1 + cy0 + cy1)) { r.wide = true; this.wide.add(r); }
      else {
        for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
          const c = this.scell.getOrSet(cx, cy, this.slists.length);
          if (c === this.slists.length) this.slists.push(new Set());
          this.slists[c].add(r);
          r.cells.push(c);
        }
      }
    }
    return true;
  }

  private dropWire(e: Entry) {
    const r = this.rec<WireRec>(e);
    if (!r) return;
    for (const id of r.v) this.release(id);
    for (const c of r.cells) this.slists[c].delete(r);
    if (r.wide) this.wide.delete(r);
    r.dirty = false;
    e.ext = undefined;
  }

  private setPart(e: Entry, library: Record<string, LibPart>): boolean {
    const p = e.obj as Part, lib = library[p.lib];
    const old = this.rec<PartRec>(e);
    // 넷에 닿는 것(자리·회전·대칭·라이브러리)이 그대로면 그대로 둔다. 지정자는 경고 글에만 쓰이므로
    // 고쳐 적기만 한다 (점을 놓았다 다시 잡으면 주변 배선까지 다시 찾게 된다)
    if (old && old.at === p.at && old.rot === p.rot && old.mirror === p.mirror && old.lib === lib && old.libName === p.lib) {
      old.ref = p.ref;
      return false;
    }
    if (old) this.dropPart(e);
    const r: PartRec = {
      gen: this.gen, at: p.at, rot: p.rot, mirror: p.mirror, lib, libName: p.lib, ref: p.ref,
      ok: !!lib, gnd: lib?.id === "gnd", pins: [], refs: [],
    };
    if (lib) lib.symbol.pins.forEach((pin, i) => {
      const at = pinAt(p, lib, i);
      r.pins.push(this.acquire(at[0], at[1]));
      r.refs.push(p.id + ":" + pin.id);
    });
    e.ext = r;
    return true;
  }

  private dropPart(e: Entry) {
    const r = this.rec<PartRec>(e);
    if (!r) return;
    for (const id of r.pins) this.release(id);
    e.ext = undefined;
  }

  private setLabel(e: Entry) {
    const l = e.obj as NetLabel;
    const old = this.rec<LabelRec>(e);
    if (old && old.at === l.at && old.name === l.name && old.kind === l.kind) return;
    if (old) this.dropLabel(e);
    e.ext = { gen: this.gen, at: l.at, pt: this.acquire(l.at[0], l.at[1]), name: l.name, kind: l.kind } satisfies LabelRec;
  }

  private dropLabel(e: Entry) {
    const r = this.rec<LabelRec>(e);
    if (!r) return;
    this.release(r.pt);
    e.ext = undefined;
  }

  // ── 점 번호표 ────────────────────────────────────────────────────────
  private acquire(x: number, y: number): number {
    const n = this.count;
    const id = this.ids.getOrSet(x, y, n);
    if (id === n) {
      if (n === this.xs.length) this.grow();
      this.xs[n] = x; this.ys[n] = y;
      this.count++;
      const c = this.pcell.getOrSet(cellOf(x), cellOf(y), this.plists.length);
      if (c === this.plists.length) this.plists.push([n]); else this.plists[c].push(n);
    }
    if (this.refc[id]++ === 0) { this.live++; this.touched.push(id); }
    return id;
  }

  private release(id: number) {
    if (--this.refc[id] === 0) { this.live--; this.touched.push(id); }
  }

  private grow() {
    const n = this.xs.length * 2;
    const xs = new Float64Array(n), ys = new Float64Array(n), rc = new Int32Array(n);
    xs.set(this.xs); ys.set(this.ys); rc.set(this.refc);
    this.xs = xs; this.ys = ys; this.refc = rc;
  }

  private clear(sheet: Sheet) {
    this.sheet = sheet;
    this.ids = new PairMap(1024);
    this.xs = new Float64Array(1024); this.ys = new Float64Array(1024); this.refc = new Int32Array(1024);
    this.count = 0; this.live = 0;
    this.pcell = new PairMap(1024); this.plists = [];
    this.scell = new PairMap(1024); this.slists = []; this.wide.clear();
    this.gen++;
    this.ptCache = [];
    this.junctionSnap = []; this.junctionIds = [];
    this.touched.length = 0; this.dirty.length = 0;
  }
}

function onSeg(px: number, py: number, a: Pt, b: Pt): boolean {
  if ((px - a[0]) * (b[1] - a[1]) - (py - a[1]) * (b[0] - a[0]) !== 0) return false;
  return px >= Math.min(a[0], b[0]) && px <= Math.max(a[0], b[0])
    && py >= Math.min(a[1], b[1]) && py <= Math.max(a[1], b[1]);
}
