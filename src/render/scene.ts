/**
 * 정적 층의 도형 — 화면이 아니라 **월드 좌표**로 담아 둔다.
 *
 * 예전 렌더러는 화면이 움직일 때마다 시트의 모든 부품과 배선을 Canvas 2D 로 다시 그렸다.
 * 부품 1만 개에서 한 프레임에 15~50 ms 였고, 그 시간의 대부분은 픽셀이 아니라 객체마다
 * 부르는 beginPath·stroke 와 좌표 변환이었다. 여기서는 도형을 월드 좌표의 숫자 배열로 한 번
 * 만들어 GPU 에 올려 두고(src/render/gpu.ts), 이동·확대는 변환 값 하나만 바꿔 다시 그린다.
 *
 * 도형은 세 가지뿐이다:
 *   선분  — 양 끝(월드) + 화면 px 오프셋. 배선·심볼 선·미연결 X 표시
 *   원판  — 중심(월드) + 반지름(화면 px). 핀 점·접합점
 *   고리  — 중심(월드) + 반지름(월드) + 두께(화면 px). 심볼의 원
 * 굵기와 반지름은 배율을 따라 조금 굵어진다(예전 lw() 와 같은 k = max(1, min(배율/2, 2))) —
 * 그 계산은 그릴 때 셰이더가 한다. 그래서 배율이 바뀌어도 이 배열은 그대로다.
 *
 * **바뀐 것만 다시 만든다.** 객체는 덩어리(chunk) 단위로 묶여 있고, 시트 색인이 알려 준 바뀐
 * 객체의 덩어리만 다시 채워 올린다. 끄는 중인 객체는 덩어리에서 잠시 빼고(live) 매 프레임 따로
 * 만든다 — 1만 개 시트에서 부품 하나를 끄는 동안 1만 개를 다시 만들지 않는다.
 *
 * PNG 내보내기도 이 도형을 Canvas 2D 로 그린다(drawScene2D). 화면과 내보내기가 **같은 도형
 * 목록**에서 나오므로, 예전 원칙("같은 함수로 그린다 — 따로 그리면 내보낸 그림에만 빠지는 것이
 * 생긴다")이 그대로 지켜진다. 다른 것은 래스터 방식뿐이다.
 */
import { pinAt, transform, type LibPart, type Part, type Pt, type Wire } from "../doc/types.ts";
import type { Entry } from "../doc/sheet-index.ts";

/** 도형 종류(스타일). 색과 굵기는 그릴 때 정한다 */
export const STYLE = {
  wire: 0,
  part: 1,
  pin: 2,
  nc: 3,
  junction: 4,
} as const;

/** 스타일별 기본 굵기·반지름 (CSS px, 배율 k 를 곱하기 전). 예전 drawPart/drawWires 의 숫자다 */
export const BASE = [1.4, 1.3, 1.6, 1.4, 2.4] as const;

/** 선분 한 개 = 9 개의 float: ax ay bx by  oax oay obx oby  style */
export const SEG = 9;
/** 원판 한 개 = 4 개: cx cy  rBase  style */
export const DISC = 4;
/** 고리 한 개 = 4 개: cx cy  rWorld  style  (두께는 그 스타일의 굵기) */
export const RING = 4;

/** 늘어나는 Float32Array. 넣는 쪽이 개수를 알고 있으므로 가변 인자를 쓰지 않는다 */
export class Buf {
  data = new Float32Array(256);
  length = 0;
  private room(n: number) {
    if (this.length + n <= this.data.length) return;
    let cap = this.data.length * 2;
    while (cap < this.length + n) cap *= 2;
    const d = new Float32Array(cap);
    d.set(this.data.subarray(0, this.length));
    this.data = d;
  }
  push4(a: number, b: number, c: number, d: number) {
    this.room(4);
    const v = this.data; let i = this.length;
    v[i++] = a; v[i++] = b; v[i++] = c; v[i++] = d;
    this.length = i;
  }
  push9(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, k: number) {
    this.room(9);
    const v = this.data; let i = this.length;
    v[i++] = a; v[i++] = b; v[i++] = c; v[i++] = d; v[i++] = e; v[i++] = f; v[i++] = g; v[i++] = h; v[i++] = k;
    this.length = i;
  }
  clear() { this.length = 0; }
  view(): Float32Array { return this.data.subarray(0, this.length); }
}

/** 도형 묶음. 덩어리 하나, 끄는 중인 층, 접합점 층이 각각 하나씩 가진다 */
export class Prims {
  /** 배선·심볼 선 (아래 층) */
  seg = new Buf();
  /** 미연결 X 처럼 핀 점 **위**에 와야 하는 선 */
  segTop = new Buf();
  disc = new Buf();
  ring = new Buf();
  clear() { this.seg.clear(); this.segTop.clear(); this.disc.clear(); this.ring.clear(); }
  /** 바뀔 때마다 늘어난다. GPU 쪽이 이 값으로 다시 올릴지 정한다 */
  version = 0;
}

const seg = (b: Buf, a: Pt, c: Pt, style: number) => b.push9(a[0], a[1], c[0], c[1], 0, 0, 0, 0, style);

/** 부품 하나의 도형. 예전 drawPart 가 그리던 선·원·핀 점·미연결 X 와 같다 (글자는 글자 층) */
export function emitPart(part: Part, lib: LibPart, out: Prims): void {
  const T = (p: Pt): Pt => {
    const v = transform(p, part.rot, part.mirror);
    return [part.at[0] + v[0], part.at[1] + v[1]];
  };
  const S = STYLE.part;
  for (const s of lib.symbol.graphics) {
    if ("line" in s) seg(out.seg, T(s.line[0]), T(s.line[1]), S);
    else if ("poly" in s) {
      for (let i = 1; i < s.poly.length; i++) seg(out.seg, T(s.poly[i - 1]), T(s.poly[i]), S);
    } else if ("rect" in s) {
      const [x, y, w, h] = s.rect;
      const c = [T([x, y]), T([x + w, y]), T([x + w, y + h]), T([x, y + h])];
      for (let i = 0; i < 4; i++) seg(out.seg, c[i], c[(i + 1) % 4], S);
    } else {
      const c = T(s.circle.c);
      out.ring.push4(c[0], c[1], s.circle.r, S);
    }
  }
  lib.symbol.pins.forEach((_, i) => {
    const p = pinAt(part, lib, i);
    out.disc.push4(p[0], p[1], BASE[STYLE.pin], STYLE.pin);
  });
  // 미연결 표시 (E05): 핀 끝의 X. 크기는 화면 px 로 3k — 오프셋으로 담는다
  for (const pinId of part.nc ?? []) {
    const i = lib.symbol.pins.findIndex(p => p.id === pinId);
    if (i < 0) continue;
    const p = pinAt(part, lib, i);
    out.segTop.push9(p[0], p[1], p[0], p[1], -3, -3, 3, 3, STYLE.nc);
    out.segTop.push9(p[0], p[1], p[0], p[1], 3, -3, -3, 3, STYLE.nc);
  }
}

/** 배선 하나. 점이 둘 미만이면 예전처럼 그리지 않는다 */
export function emitWire(w: Wire, out: Prims): void {
  if (w.pts.length < 2) return;
  for (let i = 1; i < w.pts.length; i++) seg(out.seg, w.pts[i - 1], w.pts[i], STYLE.wire);
}

export function emitJunctions(pts: Iterable<Pt>, out: Prims): void {
  for (const p of pts) out.disc.push4(p[0], p[1], BASE[STYLE.junction], STYLE.junction);
}

/** 덩어리 하나에 넣는 객체 수. 바뀐 객체가 있으면 이만큼을 다시 만든다 */
export const CHUNK = 1024;

interface Chunk { members: Set<Entry>; prims: Prims; dirty: boolean }

/**
 * 시트 전체의 정적 도형을 덩어리로 나눠 들고 있다.
 *
 * 부품과 배선은 덩어리를 따로 쓴다 — 그리는 순서가 '배선 먼저, 부품 다음' 이라서다.
 */
export class Scene {
  readonly wires: Chunk[] = [];
  readonly parts: Chunk[] = [];
  private where = new Map<Entry, Chunk>();
  /** 빈자리가 생긴 덩어리. 새 객체는 여기부터 채운다 (덩어리를 매번 찾아 훑지 않는다) */
  private spare = { wire: [] as Chunk[], part: [] as Chunk[] };
  /** 끄는 중이라 덩어리에서 뺀 객체. 매 프레임 live 에 따로 만든다 */
  private liveSet = new Set<Entry>();
  readonly live = new Prims();
  readonly junctions = new Prims();
  private library: Record<string, LibPart> = {};

  /** 시트 색인이 알려 준 변화만 반영한다 (덩어리를 '다시 만들 것' 으로 표시만 하고, 만들기는 flush 에서) */
  apply(change: { changed: Entry[]; removed: Entry[]; reset: boolean }, library: Record<string, LibPart>): void {
    this.library = library;
    if (change.reset) {
      this.wires.length = 0; this.parts.length = 0;
      this.where.clear(); this.liveSet.clear();
      this.spare = { wire: [], part: [] };
    }
    for (const e of change.removed) {
      const c = this.where.get(e);
      if (!c) continue;
      if (c.members.size === CHUNK) this.spare[e.kind as "wire" | "part"].push(c);
      c.members.delete(e);
      c.dirty = true;
      this.where.delete(e);
      this.liveSet.delete(e);
    }
    for (const e of change.changed) {
      if (e.kind !== "part" && e.kind !== "wire") continue;
      let c = this.where.get(e);
      if (!c) {
        const pool = e.kind === "wire" ? this.wires : this.parts;
        const spare = this.spare[e.kind];
        while (spare.length && spare[spare.length - 1].members.size >= CHUNK) spare.pop();
        c = spare.length ? spare[spare.length - 1] : pool[pool.length - 1];
        if (!c || c.members.size >= CHUNK) { c = { members: new Set(), prims: new Prims(), dirty: true }; pool.push(c); }
        c.members.add(e);
        this.where.set(e, c);
      }
      c.dirty = true;
    }
  }

  /** 다시 만들 덩어리를 채운다. 실제로 다시 만든 덩어리 수를 준다 (측정용) */
  flush(): number {
    let n = 0;
    for (const pool of [this.wires, this.parts]) {
      for (const c of pool) {
        if (!c.dirty) continue;
        c.dirty = false;
        c.prims.clear();
        for (const e of c.members) if (!this.liveSet.has(e)) this.emit(e, c.prims);
        c.prims.version++;
        n++;
      }
    }
    return n;
  }

  /**
   * 끄기 시작·끝. 끄는 동안 움직이는 객체는 덩어리에서 빼서, 매 프레임 그것들만 다시 만든다.
   * 빼고 넣을 때만 그 객체들이 든 덩어리를 한 번씩 다시 만든다.
   */
  setLive(entries: Iterable<Entry> | null): void {
    const next = new Set(entries ?? []);
    for (const e of this.liveSet) if (!next.has(e)) { const c = this.where.get(e); if (c) c.dirty = true; }
    for (const e of next) if (!this.liveSet.has(e)) { const c = this.where.get(e); if (c) c.dirty = true; }
    this.liveSet = next;
    this.buildLive();
  }

  /** 끄는 중인 객체를 지금 자리로 다시 만든다 (끄는 동안 매 프레임) */
  buildLive(): void {
    this.live.clear();
    // 배선 먼저, 부품 다음 — 덩어리를 그리는 순서와 같다
    for (const e of this.liveSet) if (e.kind === "wire") this.emit(e, this.live);
    for (const e of this.liveSet) if (e.kind === "part") this.emit(e, this.live);
    this.live.version++;
  }

  get hasLive(): boolean { return this.liveSet.size > 0; }

  setJunctions(pts: Iterable<Pt>): void {
    this.junctions.clear();
    emitJunctions(pts, this.junctions);
    this.junctions.version++;
  }

  private emit(e: Entry, out: Prims) {
    if (e.kind === "wire") emitWire(e.obj as Wire, out);
    else {
      const part = e.obj as Part;
      const lib = this.library[part.lib];
      if (lib) emitPart(part, lib, out);
    }
  }
}

// ── 2D 로 그리기 (PNG 내보내기) ───────────────────────────────────────
export interface Look {
  /** 스타일별 색 (CSS 색 문자열) */
  colors: string[];
}

/** 배율이 굵기에 주는 몫. 예전 lw() 와 같다: lw(base) = base · k */
export const thick = (scale: number) => Math.max(1, Math.min(scale / 2, 2));

/**
 * 도형 묶음을 Canvas 2D 로 그린다. 화면은 GPU 가 같은 도형을 그린다.
 * 순서도 GPU 와 같다: 선분 -> 고리 -> 원판 -> 위층 선분.
 */
export function drawPrims2D(
  g: CanvasRenderingContext2D, view: { at: Pt; scale: number }, p: Prims, look: Look,
): void {
  const k = thick(view.scale);
  const X = (x: number) => (x - view.at[0]) * view.scale;
  const Y = (y: number) => (y - view.at[1]) * view.scale;
  g.lineCap = "round"; g.lineJoin = "round";

  const segs = (b: Buf) => {
    const d = b.data;
    // 같은 스타일이 이어지는 동안은 한 경로로 모아 한 번에 긋는다
    let cur = -1;
    for (let i = 0; i < b.length; i += SEG) {
      const st = d[i + 8];
      if (st !== cur) {
        if (cur >= 0) g.stroke();
        cur = st;
        g.strokeStyle = look.colors[st];
        g.lineWidth = BASE[st] * k;
        g.beginPath();
      }
      g.moveTo(X(d[i]) + d[i + 4] * k, Y(d[i + 1]) + d[i + 5] * k);
      g.lineTo(X(d[i + 2]) + d[i + 6] * k, Y(d[i + 3]) + d[i + 7] * k);
    }
    if (cur >= 0) g.stroke();
  };
  segs(p.seg);
  {
    const d = p.ring.data;
    for (let i = 0; i < p.ring.length; i += RING) {
      const st = d[i + 3];
      g.strokeStyle = look.colors[st];
      g.lineWidth = BASE[st] * k;
      const r = d[i + 2] * view.scale;
      g.beginPath();
      g.arc(X(d[i]), Y(d[i + 1]), r, 0, Math.PI * 2);
      g.stroke();
    }
  }
  {
    const d = p.disc.data;
    let cur = -1;
    for (let i = 0; i < p.disc.length; i += DISC) {
      const st = d[i + 3];
      if (st !== cur) {
        if (cur >= 0) g.fill();
        cur = st;
        g.fillStyle = look.colors[st];
        g.beginPath();
      }
      const x = X(d[i]), y = Y(d[i + 1]), r = d[i + 2] * k;
      g.moveTo(x + r, y);
      g.arc(x, y, r, 0, Math.PI * 2);
    }
    if (cur >= 0) g.fill();
  }
  segs(p.segTop);
}

/** 장면 전체를 2D 로 (내보내기용). 화면과 같은 순서: 배선 -> 부품 -> 접합점 */
export function drawScene2D(g: CanvasRenderingContext2D, view: { at: Pt; scale: number }, scene: Scene, look: Look): void {
  for (const c of scene.wires) drawPrims2D(g, view, c.prims, look);
  for (const c of scene.parts) drawPrims2D(g, view, c.prims, look);
  drawPrims2D(g, view, scene.junctions, look);
}
