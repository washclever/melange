/**
 * 시트 색인 — 무엇이 바뀌었나 · 어디에 있나.
 *
 * 편집 한 번마다 예전에는 시트 전체를 다시 계산했다. 넷 추출을 다시 하고, 화면을 통째로
 * 다시 그리고, 마우스가 움직일 때마다 부품과 배선을 전부 훑어 스냅 후보를 찾았다. 부품 1만
 * 개에서는 그 하나하나가 수십~수백 ms 였다.
 *
 * 이 색인은 커밋할 때마다 시트를 지난번 모습과 **값이 아니라 참조로** 비교해 바뀐 객체만
 * 골라낸다. 명령은 좌표를 늘 새 배열로 바꿔 끼우지 제자리에서 고치지 않으므로(history.ts),
 * 참조가 같으면 모양도 같다. 골라낸 것만 격자 칸에서 빼고 다시 넣는다. 그 결과로
 *
 *  - 연결에 닿는 것이 하나도 안 바뀌었으면 넷 추출을 건너뛴다 (값 고치기, 지정자, 주석…)
 *  - 그리기 쪽은 바뀐 객체만 다시 만든다 (src/render/scene.ts)
 *  - 히트 테스트·스냅·박스 선택·화면 밖 걸러내기는 칸으로 묻는다
 *
 * 비교는 객체 수만큼 돌지만 참조 몇 개를 견주는 것뿐이라 5만 개에서도 몇 ms 다.
 */
import { transform, type Id, type LibPart, type NetLabel, type Part, type Probe, type Pt, type Sheet, type Wire } from "./types.ts";
import { PairMap } from "../net/spatial.ts";

export type IndexedKind = "part" | "wire" | "label" | "probe";

export interface Entry {
  kind: IndexedKind;
  obj: Part | Wire | NetLabel | Probe;
  /** 시트 배열에서의 자리. '위에 그려진 것부터' 고를 때 쓴다 */
  index: number;
  /** 월드 좌표 경계 상자 (부품은 도형과 핀을 다 덮는다. 글자는 넣지 않는다) */
  x0: number; y0: number; x1: number; y1: number;
  /** 지난번 모습 — 바뀌었는지 참조로 견준다 */
  s1: unknown; s2: unknown; s3: unknown; s4: unknown; s5: unknown; s6: unknown;
  gen: number;
  mark: number;
  /** 같은 id 의 두 번째 객체 (깨진 문서). 색인 표에는 없다 */
  dupe?: boolean;
  /** 증분 넷 추출이 이 객체에 대해 들고 있는 입력 (src/net/incremental.ts). 다른 쪽은 쓰지 않는다 */
  ext?: unknown;
}

export interface SyncResult {
  /** 넷 추출을 다시 해야 하는가 — 부품 자리·회전·종류, 배선 모양, 라벨, 수동 접합점, 순서 */
  connectivity: boolean;
  /** 모양이 바뀌었거나 새로 생긴 객체 */
  changed: Entry[];
  /** 없어진 객체 */
  removed: Entry[];
  /** 문서를 통째로 갈아끼웠다 (새로 열기·데모). 그리기 쪽은 전부 다시 만든다 */
  reset: boolean;
}

/** 칸 한 변 (10 mil 단위). 160 = 1.6 인치. 화면 하나(배율 하한 0.25)가 대략 30×20 칸이다 */
export const INDEX_CELL = 160;
/** 칸을 이보다 많이 덮는 객체(아주 긴 배선)는 칸에 넣지 않고 늘 후보로 낸다 */
const MAX_CELLS = 64;

const cell = (v: number) => Math.floor(v / INDEX_CELL);

/** 라이브러리 심볼의 회전·대칭별 경계 상자 (원점 기준). 심볼마다 여덟 가지뿐이라 기억해 둔다 */
const localBoxes = new WeakMap<LibPart, Map<number, [number, number, number, number]>>();
export function symbolBox(lib: LibPart, rot: Part["rot"], mirror: boolean): [number, number, number, number] {
  let m = localBoxes.get(lib);
  if (!m) localBoxes.set(lib, m = new Map());
  const k = rot * 2 + (mirror ? 1 : 0);
  let b = m.get(k);
  if (b) return b;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Pt) => {
    const v = transform(p, rot, mirror);
    if (!v) return;                                   // 이상한 회전값 — 상자를 키우지 않는다
    x0 = Math.min(x0, v[0]); y0 = Math.min(y0, v[1]);
    x1 = Math.max(x1, v[0]); y1 = Math.max(y1, v[1]);
  };
  for (const s of lib.symbol.graphics) {
    if ("line" in s) { add(s.line[0]); add(s.line[1]); }
    else if ("poly" in s) s.poly.forEach(add);
    else if ("rect" in s) {
      const [x, y, w, h] = s.rect;
      add([x, y]); add([x + w, y]); add([x + w, y + h]); add([x, y + h]);
    } else {
      const { c, r } = s.circle;
      add([c[0] - r, c[1] - r]); add([c[0] + r, c[1] + r]); add([c[0] - r, c[1] + r]); add([c[0] + r, c[1] - r]);
    }
  }
  for (const p of lib.symbol.pins) add(p.at);
  // 핀 하나짜리(GND)처럼 납작한 기호도 집을 수 있게 (partBounds 와 같은 ±8)
  if (!isFinite(x0)) { x0 = y0 = -8; x1 = y1 = 8; }
  if (x0 === x1) { x0 -= 8; x1 += 8; }
  if (y0 === y1) { y0 -= 8; y1 += 8; }
  b = [x0, y0, x1, y1];
  m.set(k, b);
  return b;
}

export class SheetIndex {
  private sheet: Sheet | null = null;
  private readonly maps: Record<IndexedKind, Map<Id, Entry>> = {
    part: new Map(), wire: new Map(), label: new Map(), probe: new Map(),
  };
  /** 같은 id 가 둘 이상인 객체 (깨진 문서). 칸에는 안 넣고 늘 후보로 낸다 */
  private dupes: Entry[] = [];
  /** 시트 배열 순서 그대로의 항목들 (증분 넷 추출이 시트 순서로 돈다) */
  readonly ordered: Record<IndexedKind, Entry[]> = { part: [], wire: [], label: [], probe: [] };
  /** 같은 id 가 둘 이상 있었나 (그런 문서는 증분 추출이 통째로 다시 한다) */
  get hasDupes(): boolean { return this.dupes.length > 0; }
  private cells = new PairMap(1024);
  private lists: Entry[][] = [];
  private big = new Set<Entry>();
  private gen = 0;
  private stamp = 0;
  private junctionSnap: Pt[] = [];
  private libSnap = new Map<string, LibPart>();

  /** 지금 시트를 지난번과 견주어 색인을 맞추고, 무엇이 바뀌었는지 알려 준다 */
  sync(sheet: Sheet, library: Record<string, LibPart>): SyncResult {
    const reset = sheet !== this.sheet;
    if (reset) this.clear(sheet);
    const gen = ++this.gen;
    const changed: Entry[] = [], removed: Entry[] = [];
    let connectivity = reset;

    // 라이브러리 항목이 바뀌면 그 종류를 쓰는 부품은 모양이 바뀐다 (항목 참조를 부품마다 견준다)
    let libChanged = false;
    const keys = Object.keys(library);
    if (keys.length !== this.libSnap.size || keys.some(k => this.libSnap.get(k) !== library[k])) {
      libChanged = true;
      this.libSnap = new Map(keys.map(k => [k, library[k]]));
    }
    if (libChanged) connectivity = true;

    this.dupes = [];
    /**
     * sameNets 가 거짓이면 연결에 닿는 변화(넷 추출을 다시 한다), sameLook 만 거짓이면
     * 그림만 바뀐 것(미연결 표시 따위)이다.
     */
    const visit = <T extends Part | Wire | NetLabel | Probe>(
      kind: IndexedKind, arr: T[],
      sameNets: (e: Entry, o: T) => boolean, remember: (e: Entry, o: T) => void,
      box: (o: T) => [number, number, number, number],
      affectsNets: boolean,
      sameLook: (e: Entry, o: T) => boolean = () => true,
    ) => {
      const map = this.maps[kind];
      const prev = this.ordered[kind];
      const ord: Entry[] = new Array(arr.length);
      this.ordered[kind] = ord;
      let order = false;
      for (let i = 0; i < arr.length; i++) {
        const o = arr[i];
        // 자리가 그대로면 지난번 항목을 바로 쓴다 (id 로 찾지 않는다 — 대부분의 편집에서 그렇다)
        const pe = prev[i];
        let e = pe !== undefined && pe.obj === o && !pe.dupe && pe.gen !== gen ? pe : map.get(o.id);
        if (e && e.gen === gen) {
          // 같은 id 가 또 나왔다. 칸 색인에서는 빼고 늘 후보로 둔다 — 틀린 답보다는 느린 답
          const d = this.makeEntry(kind, o, i, box(o));
          d.gen = gen;
          d.dupe = true;
          this.dupes.push(d);
          ord[i] = d;
          if (affectsNets) connectivity = true;
          continue;
        }
        if (!e) {
          e = this.makeEntry(kind, o, i, box(o));
          remember(e, o);
          e.gen = gen;
          map.set(o.id, e);
          this.insert(e);
          changed.push(e);
          ord[i] = e;
          if (affectsNets) connectivity = true;
          continue;
        }
        ord[i] = e;
        e.gen = gen;
        if (e.index !== i) { e.index = i; order = true; }
        if (e.obj !== o || !sameNets(e, o)) {
          this.remove(e);
          e.obj = o;
          [e.x0, e.y0, e.x1, e.y1] = box(o);
          remember(e, o);
          this.insert(e);
          changed.push(e);
          if (affectsNets) connectivity = true;
        } else if (!sameLook(e, o)) {
          remember(e, o);
          changed.push(e);
        }
      }
      // 이번에 못 본 것은 지워진 것이다 (개수가 맞으면 훑을 것도 없다)
      if (map.size > arr.length || this.dupes.length) {
        for (const [id, e] of map) {
          if (e.gen === gen) continue;
          map.delete(id);
          this.remove(e);
          removed.push(e);
          if (affectsNets) connectivity = true;
        }
      }
      // 순서는 넷 이름을 정한다 (자동 이름은 union 순서를 따른다)
      if (order && affectsNets) connectivity = true;
    };

    visit<Part>("part", sheet.parts,
      // 라이브러리에 없는 부품은 넷 추출이 지정자를 넣어 경고를 내므로, 그때만 지정자도 본다
      (e, p) => e.s1 === p.at && e.s2 === p.rot && e.s3 === p.mirror && e.s4 === library[p.lib]
        && p.lib === e.s6 && (!!library[p.lib] || e.s5 === p.ref),
      (e, p) => { e.s1 = p.at; e.s2 = p.rot; e.s3 = p.mirror; e.s4 = library[p.lib]; e.s5 = library[p.lib] ? p.nc : p.ref; e.s6 = p.lib; },
      p => {
        const lib = library[p.lib];
        if (!lib) return [p.at[0] - 8, p.at[1] - 8, p.at[0] + 8, p.at[1] + 8];
        const [a, b, c, d] = symbolBox(lib, p.rot, p.mirror);
        return [p.at[0] + a, p.at[1] + b, p.at[0] + c, p.at[1] + d];
      }, true,
      // 미연결 표시(nc)는 넷을 바꾸지 않지만 그림은 바꾼다
      (e, p) => !library[p.lib] || e.s5 === p.nc);
    visit<Wire>("wire", sheet.wires,
      (e, w) => e.s1 === w.pts,
      (e, w) => { e.s1 = w.pts; },
      w => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of w.pts) {
          if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
        }
        return isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0];
      }, true);
    visit<NetLabel>("label", sheet.labels,
      (e, l) => e.s1 === l.at && e.s2 === l.name && e.s3 === l.kind,
      (e, l) => { e.s1 = l.at; e.s2 = l.name; e.s3 = l.kind; },
      // 히트 테스트는 이름 길이만큼 오른쪽, 위아래 8 칸 (app.ts hitTest 와 같은 상자)
      l => [l.at[0], l.at[1] - 8, l.at[0] + l.name.length * 5 + 6, l.at[1] + 8], true);
    visit<Probe>("probe", sheet.probes,
      (e, p) => e.s1 === p.at,
      (e, p) => { e.s1 = p.at; },
      p => [p.at[0], p.at[1], p.at[0], p.at[1]], false);

    // 수동 접합점: 칸에는 넣지 않는다 (적고, 그리기 쪽이 따로 다룬다). 연결만 본다
    const js = sheet.junctions;
    if (js.length !== this.junctionSnap.length || js.some((j, i) => j !== this.junctionSnap[i])) {
      connectivity = true;
      this.junctionSnap = js.slice();
    }

    return { connectivity, changed, removed, reset };
  }

  /** 그 객체의 색인 항목 (그리기 쪽이 '끄는 중' 표시에 쓴다) */
  entry(kind: IndexedKind, id: Id): Entry | undefined {
    return this.maps[kind].get(id);
  }

  /** id 로 찾기. 시트 배열을 훑지 않는다 (sync 한 뒤의 상태) */
  get<T extends Part | Wire | NetLabel | Probe>(kind: IndexedKind, id: Id): T | undefined {
    return this.maps[kind].get(id)?.obj as T | undefined;
  }

  /** 상자와 겹칠 수 있는 객체들. 정확한 판정은 부르는 쪽이 한다. 순서는 정해져 있지 않다 */
  query(x0: number, y0: number, x1: number, y1: number, kinds?: ReadonlySet<IndexedKind>): Entry[] {
    const out: Entry[] = [];
    const mark = ++this.stamp;
    const take = (e: Entry) => {
      if (e.mark === mark) return;
      e.mark = mark;
      if (kinds && !kinds.has(e.kind)) return;
      if (e.x1 < x0 || e.x0 > x1 || e.y1 < y0 || e.y0 > y1) return;
      out.push(e);
    };
    const cx0 = cell(x0), cx1 = cell(x1), cy0 = cell(y0), cy1 = cell(y1);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > this.lists.length * 4) {
      // 상자가 아주 크면 칸을 도는 것보다 다 보는 게 빠르다
      for (const kind of ["part", "wire", "label", "probe"] as const) for (const e of this.maps[kind].values()) take(e);
    } else {
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
        const c = this.cells.get(cx, cy);
        if (c >= 0) for (const e of this.lists[c]) take(e);
      }
      for (const e of this.big) take(e);
    }
    for (const e of this.dupes) take(e);
    return out;
  }

  private clear(sheet: Sheet) {
    this.sheet = sheet;
    for (const m of Object.values(this.maps)) m.clear();
    for (const k of Object.keys(this.ordered) as IndexedKind[]) this.ordered[k] = [];
    this.cells = new PairMap(1024);
    this.lists = [];
    this.big.clear();
    this.dupes = [];
    this.junctionSnap = [];
    this.libSnap = new Map();
  }

  private makeEntry(kind: IndexedKind, obj: Entry["obj"], index: number, b: [number, number, number, number]): Entry {
    return {
      kind, obj, index, x0: b[0], y0: b[1], x1: b[2], y1: b[3],
      s1: undefined, s2: undefined, s3: undefined, s4: undefined, s5: undefined, s6: undefined, gen: 0, mark: 0,
    };
  }

  private insert(e: Entry) {
    const cx0 = cell(e.x0), cx1 = cell(e.x1), cy0 = cell(e.y0), cy1 = cell(e.y1);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > MAX_CELLS || !isFinite(cx0 + cx1 + cy0 + cy1)) { this.big.add(e); return; }
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const c = this.cells.getOrSet(cx, cy, this.lists.length);
      if (c === this.lists.length) this.lists.push([e]); else this.lists[c].push(e);
    }
  }

  private remove(e: Entry) {
    if (this.big.delete(e)) return;
    const cx0 = cell(e.x0), cx1 = cell(e.x1), cy0 = cell(e.y0), cy1 = cell(e.y1);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const c = this.cells.get(cx, cy);
      if (c < 0) continue;
      const list = this.lists[c];
      const i = list.indexOf(e);
      if (i >= 0) { list[i] = list[list.length - 1]; list.pop(); }
    }
  }
}
