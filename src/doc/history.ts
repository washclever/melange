/**
 * 명령 패턴과 실행 취소 (설계서 E12, '구현 시 고려할 것' 7번).
 *
 * 편집은 전부 명령으로 한다. 명령은 문서 변경분과 그 역을 알고 있고,
 * 실행 취소는 역을 적용한다. 문서를 명령 밖에서 직접 바꾸면 실행 취소가 깨지므로
 * 앱 코드는 sheet 를 직접 건드리지 않는다.
 *
 * 한 단계의 크기는 설계서가 정한 대로다 — 끌기 한 번, 값 입력 한 번이 한 단계.
 * 취소하면 선택도 그때로 되돌린다. 한 번 끈 것을 여러 번 눌러 되돌리지 않게 하려는 것이다.
 *
 * 스냅샷을 쌓지 않는 이유: 부품 1,000개 시트에서 편집마다 문서 전체를 직렬화하면
 * 메모리와 시간이 선형으로 늘고, 되돌린 뒤 객체 동일성이 깨져 선택이 풀린다.
 */
import {
  GRID,
  type Id, type NetLabel, type Note, type Part, type Probe, type Project, type Pt, type Sheet,
  type SimSettings, type SpiceBlock, type Wire,
} from "./types.ts";

export interface Command {
  /** 실행 취소 안내에 보일 이름 */
  readonly label: string;
  apply(sheet: Sheet): void;
  revert(sheet: Sheet): void;
}

// ── 객체 참조 ─────────────────────────────────────────────────────────
/** 시트 위의 무엇이든 가리키는 참조. 선택은 이것들의 모음이다 */
export type ObjKind = "part" | "wire" | "label" | "probe" | "spice" | "note";
export interface Ref { kind: ObjKind; id: Id }

export const refKey = (r: Ref): string => r.kind + ":" + r.id;
export const parseRef = (k: string): Ref => {
  const i = k.indexOf(":");
  return { kind: k.slice(0, i) as ObjKind, id: k.slice(i + 1) };
};

/** 선택 상태. 실행 취소가 선택까지 되돌리려고 기록해 둔다 */
export type SelSnapshot = string[];

const bucket = (s: Sheet, k: ObjKind) =>
  k === "part" ? s.parts
  : k === "wire" ? s.wires
  : k === "label" ? s.labels
  : k === "spice" ? s.spice
  : k === "note" ? s.notes
  : s.probes;

/**
 * 배열에서 id 로 객체를 찾는다.
 *
 * 예전에는 Array.find 라서 고른 것 S 개를 옮기거나 지우면 S × N 이었다 — 부품 1만 개를
 * 전부 골라 지우는 데 0.5초, 2만 개면 2초. 배열마다 'id -> 자리' 표를 만들어 두고,
 * 찾은 자리에 **그 id 의 객체가 아직 있는지** 확인한 뒤 돌려준다. 확인을 통과하면 그 객체는
 * 지금 배열 안에 있다는 뜻이라 틀린 답이 나올 수 없다. 통과하지 못하면(넣거나 빼서 자리가
 * 밀렸으면) 표를 다시 만든다. 없는 id 를 물으면 매번 다시 만드는데, 그런 일은 드물다
 * (지운 것을 가리키는 선택은 지우는 순간 비운다).
 */
const idTables = new WeakMap<object[], Map<Id, number>>();
export function findById<T extends { id: Id }>(arr: T[], id: Id): T | undefined {
  const t = idTables.get(arr);
  if (t) {
    const i = t.get(id);
    if (i !== undefined && arr[i]?.id === id) return arr[i];
  }
  const fresh = new Map<Id, number>();
  // 같은 id 가 둘이면 Array.find 처럼 앞의 것이 이기도록 뒤에서부터 채운다
  for (let i = arr.length - 1; i >= 0; i--) fresh.set(arr[i].id, i);
  idTables.set(arr, fresh);
  const i = fresh.get(id);
  return i === undefined ? undefined : arr[i];
}

/** 참조가 가리키는 객체. 없으면 undefined */
export function resolve(sheet: Sheet, r: Ref): { at?: Pt; pts?: Pt[]; rot?: Part["rot"]; mirror?: boolean } | undefined {
  return findById(bucket(sheet, r.kind) as Array<{ id: Id }>, r.id) as never;
}

// ── 기하 변환 ─────────────────────────────────────────────────────────
export interface Xform {
  /** 평행 이동 */
  move?: Pt;
  /** 반시계 회전. center 를 중심으로 돈다 */
  rotate?: 90 | 180 | 270;
  /** "x" 는 좌우(세로축 기준), "y" 는 상하(가로축 기준) */
  flip?: "x" | "y";
  /** 회전·대칭의 중심. 없으면 각 부품의 원점 */
  center?: Pt;
}

/** 점 하나에 변환을 적용한다 */
function movePoint(p: Pt, xf: Xform, c: Pt): Pt {
  if (xf.move) return [p[0] + xf.move[0], p[1] + xf.move[1]];
  const r: Pt = [p[0] - c[0], p[1] - c[1]];
  let q: Pt;
  if (xf.rotate) q = rotateVec(r, xf.rotate);
  else if (xf.flip === "x") q = [-r[0], r[1]];
  else if (xf.flip === "y") q = [r[0], -r[1]];
  else q = r;
  return [c[0] + q[0], c[1] + q[1]];
}

/** 반시계 90도씩. 화면 좌표(y 아래)에서 왼쪽으로 도는 방향이다 */
function rotateVec(p: Pt, deg: 90 | 180 | 270): Pt {
  switch (deg) {
    case 90: return [p[1], -p[0]];
    case 180: return [-p[0], -p[1]];
    case 270: return [-p[1], p[0]];
  }
}

/**
 * 부품의 (rot, mirror) 에 대칭을 반영한다.
 *
 * 핀 좌표는 transform(local, rot, mirror) = R_rot(S_mirror(local)) 로 구한다.
 * 세로축 대칭은 결과 x 를 뒤집는 것이고, 그렇게 되려면
 *   mirror' = !mirror,  rot' = (360 - rot) % 360
 * 이어야 한다. 가로축 대칭은 거기에 180도를 더한 것과 같다.
 * 이걸 틀리면 핀 위치와 그림이 어긋나서 연결이 조용히 바뀐다.
 */
function flipPart(rot: Part["rot"], mirror: boolean, axis: "x" | "y"): { rot: Part["rot"]; mirror: boolean } {
  const base = ((360 - rot) % 360) as Part["rot"];
  const r = axis === "x" ? base : (((base + 180) % 360) as Part["rot"]);
  return { rot: r, mirror: !mirror };
}

interface ObjState { key: string; at?: Pt; pts?: Pt[]; rot?: Part["rot"]; mirror?: boolean }

/**
 * 선택한 것들을 한 번에 옮기거나 돌리거나 뒤집는다.
 *
 * 바뀌기 전 상태를 apply 할 때 '해당 객체만' 담아 둔다. 문서 전체 스냅샷이 아니라
 * 선택한 몇 개뿐이라 끌기 한 번에 쌓이는 메모리가 선택 크기에 비례한다.
 */
/** 회전·대칭의 중심. 주지 않았으면 선택 전체의 경계 상자 가운데를 격자에 맞춰 쓴다 */
function xformCenter(sheet: Sheet, refs: Ref[], xf: Xform): Pt {
  if (xf.center) return xf.center;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Pt) => {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  };
  for (const r of refs) {
    const o = resolve(sheet, r) as { at?: Pt; pts?: Pt[] } | undefined;
    if (!o) continue;
    if (o.pts) o.pts.forEach(add); else if (o.at) add(o.at);
  }
  if (!isFinite(x0)) return [0, 0];
  return [Math.round((x0 + x1) / 2 / GRID) * GRID, Math.round((y0 + y1) / 2 / GRID) * GRID];
}

/**
 * transform(refs, xf) 가 점 하나를 어디로 보내는지. 붙은 배선이 따라올 때, 움직이는 핀 둘
 * 사이의 구간을 모양째 옮기는 데 쓴다. 중심을 transform 과 같은 방법으로 잡는다.
 */
export function xformPoint(sheet: Sheet, refs: Ref[], xf: Xform): (p: Pt) => Pt {
  const c = xformCenter(sheet, refs, xf);
  return p => movePoint(p, xf, c);
}

export function transform(refs: Ref[], xf: Xform, label = "Move"): Command {
  let before: ObjState[] = [];

  return {
    label,
    apply(sheet) {
      const c = xformCenter(sheet, refs, xf);
      before = [];
      for (const r of refs) {
        const o = resolve(sheet, r) as
          { at?: Pt; pts?: Pt[]; rot?: Part["rot"]; mirror?: boolean } | undefined;
        if (!o) continue;
        before.push({
          key: refKey(r),
          at: o.at ? [o.at[0], o.at[1]] : undefined,
          pts: o.pts ? o.pts.map(p => [p[0], p[1]] as Pt) : undefined,
          rot: o.rot, mirror: o.mirror,
        });
        if (o.pts) o.pts = o.pts.map(p => movePoint(p, xf, c));
        if (o.at) o.at = movePoint(o.at, xf, c);
        if (r.kind === "part" && o.rot !== undefined) {
          if (xf.rotate) o.rot = (((o.rot + xf.rotate) % 360) as Part["rot"]);
          else if (xf.flip) {
            const f = flipPart(o.rot, o.mirror ?? false, xf.flip);
            o.rot = f.rot; o.mirror = f.mirror;
          }
        }
      }
    },
    revert(sheet) {
      for (const b of before) {
        const o = resolve(sheet, parseRef(b.key)) as
          { at?: Pt; pts?: Pt[]; rot?: Part["rot"]; mirror?: boolean } | undefined;
        if (!o) continue;
        if (b.at) o.at = [b.at[0], b.at[1]];
        if (b.pts) o.pts = b.pts.map(p => [p[0], p[1]] as Pt);
        if (b.rot !== undefined) o.rot = b.rot;
        if (b.mirror !== undefined) o.mirror = b.mirror;
      }
    },
  };
}

/** 참조가 가리키는 것을 지운다. 종류를 가리지 않는다 */
export function removeObjects(refs: Ref[]): Command {
  /** 종류마다, 지우기 전 배열에서의 자리 순으로 */
  let removed = new Map<ObjKind, Array<{ index: number; obj: unknown }>>();
  return {
    label: "Delete",
    apply(sheet) {
      removed = new Map();
      /*
       * 종류마다 지울 id 를 모아 배열을 **한 번만** 훑는다. 예전에는 참조마다 findIndex +
       * splice 라 S 개를 지우면 S × N — 부품 1만 개를 전부 지우는 데 0.5초였다.
       *
       * 자리는 지우기 전 배열 기준으로 적는다. 예전에는 하나 지울 때마다 줄어든 배열의 자리를
       * 적어서, 앞쪽부터 고른 것을 지웠다 되돌리면 **순서가 뒤섞였다** ([A,B,C] 에서 A·C 를
       * 지우고 되돌리면 [A,C,B]). 순서는 넷 이름(N001...)을 정하므로, 되돌렸는데 넷리스트가
       * 달라지는 조용한 버그였다.
       */
      const byKind = new Map<ObjKind, Set<Id>>();
      for (const r of refs) {
        const set = byKind.get(r.kind);
        if (set) set.add(r.id); else byKind.set(r.kind, new Set([r.id]));
      }
      for (const [kind, ids] of byKind) {
        const arr = bucket(sheet, kind) as Array<{ id: Id }>;
        const out: Array<{ index: number; obj: unknown }> = [];
        let w = 0;
        for (let i = 0; i < arr.length; i++) {
          const o = arr[i];
          // 같은 id 가 둘이면 예전처럼 앞의 하나만 지운다
          if (ids.has(o.id)) { out.push({ index: i, obj: o }); ids.delete(o.id); } else arr[w++] = o;
        }
        arr.length = w;
        if (out.length) removed.set(kind, out);
      }
    },
    revert(sheet) {
      // 원래 자리 순으로 하나씩 끼워 넣은 배열을 한 번에 만든다 (splice 를 S 번 하면 다시 S × N)
      for (const [kind, items] of removed) {
        const arr = bucket(sheet, kind) as unknown[];
        const merged: unknown[] = new Array(arr.length + items.length);
        let a = 0, k = 0;
        for (let i = 0; i < merged.length; i++) {
          merged[i] = k < items.length && items[k].index === i ? items[k++].obj : arr[a++];
        }
        for (let i = 0; i < merged.length; i++) arr[i] = merged[i];
      }
    },
  };
}

/** 여러 객체를 한 번에 넣는다 (붙여넣기) */
export function addObjects(
  parts: Part[], wires: Wire[], labels: NetLabel[], probes: Probe[],
  blocks: SpiceBlock[] = [], notes: Note[] = [],
): Command {
  return {
    label: "Paste",
    apply(s) {
      s.parts.push(...parts); s.wires.push(...wires); s.labels.push(...labels);
      s.probes.push(...probes); s.spice.push(...blocks); s.notes.push(...notes);
    },
    revert(s) {
      // 한 번 훑어 거른다. 넣은 것마다 findIndex + splice 면 큰 붙여넣기를 되돌릴 때 S × N 이다
      const drop = <T extends { id: Id }>(arr: T[], items: T[]) => {
        if (!items.length) return;
        const ids = new Set(items.map(it => it.id));
        let w = 0;
        for (let i = 0; i < arr.length; i++) {
          if (ids.has(arr[i].id)) ids.delete(arr[i].id); else arr[w++] = arr[i];
        }
        arr.length = w;
      };
      drop(s.parts, parts); drop(s.wires, wires); drop(s.labels, labels);
      drop(s.probes, probes); drop(s.spice, blocks); drop(s.notes, notes);
    },
  };
}

/** 지시문 블록의 줄이나 켜짐 상태를 바꾼다 (설계서 E33) */
export function setSpiceBlock(id: Id, next: { lines?: string[]; active?: boolean }): Command {
  let prev: { lines: string[]; active: boolean } | undefined;
  return {
    label: "Edit directive",
    apply(s) {
      const b = findById(s.spice, id);
      if (!b) return;
      prev = { lines: [...b.lines], active: b.active };
      if (next.lines) b.lines = [...next.lines];
      if (next.active !== undefined) b.active = next.active;
    },
    revert(s) {
      const b = findById(s.spice, id);
      if (b && prev) { b.lines = [...prev.lines]; b.active = prev.active; }
    },
  };
}

/**
 * 명령을 실행한 뒤, 의미를 잃은 수동 접합점을 같은 단계에서 치운다 (설계서 12-6).
 *
 * 배선을 지우거나 옮기면 교차가 사라지는데, 그 자리의 접합점을 손으로 지워야 하는 게
 * EasyEDA 의 불만(FR2)이었다. 한 단계로 묶어야 취소했을 때 접합점도 같이 돌아온다 —
 * 따로 처리하면 '배선 지우기' 를 취소했는데 접합점만 안 돌아온다.
 *
 * 치울 대상은 실행한 **뒤에야** 알 수 있으므로 apply 안에서 계산한다.
 */
export function withJunctionCleanup(cmd: Command, stale: (sheet: Sheet) => Pt[]): Command {
  let removed: Pt[] = [];
  return {
    label: cmd.label,
    apply(s) {
      cmd.apply(s);
      removed = stale(s);
      for (const j of removed) {
        const i = s.junctions.findIndex(p => p[0] === j[0] && p[1] === j[1]);
        if (i >= 0) s.junctions.splice(i, 1);
      }
    },
    revert(s) {
      for (const j of removed) s.junctions.push([j[0], j[1]]);
      cmd.revert(s);
    },
  };
}

/** 수동 접합점 (E04) */
export function addJunction(at: Pt): Command {
  return {
    label: "Junction",
    apply(s) { s.junctions.push([at[0], at[1]]); },
    revert(s) {
      const i = s.junctions.findIndex(p => p[0] === at[0] && p[1] === at[1]);
      if (i >= 0) s.junctions.splice(i, 1);
    },
  };
}

export function removeJunction(at: Pt): Command {
  let index = -1;
  return {
    label: "Remove junction",
    apply(s) {
      index = s.junctions.findIndex(p => p[0] === at[0] && p[1] === at[1]);
      if (index >= 0) s.junctions.splice(index, 1);
    },
    revert(s) { if (index >= 0) s.junctions.splice(index, 0, [at[0], at[1]]); },
  };
}

const indexOfId = <T extends { id: Id }>(arr: T[], id: Id): number => arr.findIndex(x => x.id === id);

// ── 부품 ──────────────────────────────────────────────────────────────
export const addPart = (part: Part): Command => ({
  label: "Place part",
  apply: s => { s.parts.push(part); },
  revert: s => { const i = indexOfId(s.parts, part.id); if (i >= 0) s.parts.splice(i, 1); },
});

/** 지웠다 되돌릴 때 원래 자리에 다시 넣으려고 위치를 기억한다 */
export function removePart(id: Id): Command {
  let removed: Part | undefined;
  let index = -1;
  return {
    label: "Delete part",
    apply(s) { index = indexOfId(s.parts, id); if (index >= 0) removed = s.parts.splice(index, 1)[0]; },
    revert(s) { if (removed && index >= 0) s.parts.splice(index, 0, removed); },
  };
}

/**
 * 바뀌기 전 값은 호출하는 쪽에서 받지 않고 apply 할 때 직접 읽는다.
 *
 * 'from' 을 인자로 받으면 호출하는 쪽이 낡은 값을 넘겼을 때 되돌리기가 조용히
 * 문서를 망가뜨린다 — 취소했는데 엉뚱한 값이 되고, 그때는 원인을 찾기 어렵다.
 * apply 시점에 읽으면 그 가능성이 아예 없고, 다시 실행할 때도 그 시점의 값을 잡는다.
 */
function fieldCommand<T>(
  label: string, id: Id,
  read: (p: Part) => T,
  write: (p: Part, v: T) => void,
  to: T,
): Command {
  let prev: T | undefined;
  return {
    label,
    apply(s) { const p = findById(s.parts, id); if (p) { prev = read(p); write(p, to); } },
    revert(s) { const p = findById(s.parts, id); if (p && prev !== undefined) write(p, prev); },
  };
}

export const movePart = (id: Id, to: Pt): Command =>
  fieldCommand<Pt>("Move part", id, p => [p.at[0], p.at[1]], (p, v) => { p.at = [v[0], v[1]]; }, [to[0], to[1]]);

export const rotatePart = (id: Id, to: Part["rot"]): Command =>
  fieldCommand<Part["rot"]>("Rotate", id, p => p.rot, (p, v) => { p.rot = v; }, to);

export const setParam = (id: Id, key: string, to: string): Command =>
  fieldCommand<string>("Change value", id, p => p.params[key] ?? "", (p, v) => { p.params[key] = v; }, to);

export const setRef = (id: Id, to: string): Command =>
  fieldCommand<string>("Change designator", id, p => p.ref, (p, v) => { p.ref = v; }, to);

// ── 배선 · 라벨 · 프로브 ──────────────────────────────────────────────
export const addWire = (wire: Wire): Command => ({
  label: "Wires",
  apply: s => { s.wires.push(wire); },
  revert: s => { const i = indexOfId(s.wires, wire.id); if (i >= 0) s.wires.splice(i, 1); },
});

/** 핀의 미연결 표시를 켜고 끈다 (E05) */
export function toggleNc(id: Id, pinId: string): Command {
  return {
    label: "No-connect",
    apply(s) {
      const p = findById(s.parts, id);
      if (!p) return;
      const list = p.nc ?? [];
      p.nc = list.includes(pinId) ? list.filter(x => x !== pinId) : [...list, pinId];
      if (!p.nc.length) delete p.nc;
    },
    revert(s) { this.apply(s); },   // 토글이라 자기 자신이 역이다
  };
}

/** 지정자·값 글자 위치 (E17). 여러 부품에 한 번에 적용한다 */
export function setTextAt(ids: Id[], at: { ref: Pt; value: Pt }): Command {
  let before: Array<{ id: Id; at?: { ref: Pt; value: Pt } }> = [];
  return {
    label: "Text position",
    apply(s) {
      before = [];
      for (const id of ids) {
        const p = findById(s.parts, id);
        if (!p) continue;
        before.push({ id, at: p.textAt });
        p.textAt = { ref: [at.ref[0], at.ref[1]], value: [at.value[0], at.value[1]] };
      }
    },
    revert(s) {
      for (const b of before) {
        const p = findById(s.parts, b.id);
        if (!p) continue;
        if (b.at) p.textAt = b.at; else delete p.textAt;
      }
    },
  };
}

/** 배선 모양을 통째로 바꾼다. 고무줄이 끌기 끝에 결과를 한 번에 적용할 때 쓴다 */
/**
 * 선분 하나를 뺀 나머지 조각들 (설계서 2절 '선분 하나' 삭제).
 *
 * 가운데 선분을 빼면 배선이 둘로 갈라지고, 양 끝 선분을 빼면 하나만 남는다.
 * 점이 하나뿐인 조각은 배선이 아니므로 버린다 — 그대로 두면 길이 0짜리 배선이 남아
 * 넷 추출이 '끝나지 않은 배선 끝' 으로 잡는다.
 */
export function splitWire(pts: readonly Pt[], i: number): Pt[][] {
  return [pts.slice(0, i + 1), pts.slice(i + 1)]
    .filter(part => part.length >= 2)
    .map(part => part.map(p => [p[0], p[1]] as Pt));
}

export function setWirePts(id: Id, pts: Pt[]): Command {
  let prev: Pt[] | undefined;
  const next = pts.map(p => [p[0], p[1]] as Pt);
  return {
    label: "Adjust wire",
    apply(s) {
      const w = findById(s.wires, id);
      if (!w) return;
      prev = w.pts.map(p => [p[0], p[1]] as Pt);
      w.pts = next.map(p => [p[0], p[1]] as Pt);
    },
    revert(s) {
      const w = findById(s.wires, id);
      if (w && prev) w.pts = prev.map(p => [p[0], p[1]] as Pt);
    },
  };
}

export function removeWire(id: Id): Command {
  let removed: Wire | undefined;
  let index = -1;
  return {
    label: "Delete wire",
    apply(s) { index = indexOfId(s.wires, id); if (index >= 0) removed = s.wires.splice(index, 1)[0]; },
    revert(s) { if (removed && index >= 0) s.wires.splice(index, 0, removed); },
  };
}

export const addLabel = (label: NetLabel): Command => ({
  label: "Net label",
  apply: s => { s.labels.push(label); },
  revert: s => { const i = indexOfId(s.labels, label.id); if (i >= 0) s.labels.splice(i, 1); },
});

/** 넷 라벨·전원 기호의 이름 (설계서 E29 바꾸기) */
export function renameLabel(id: Id, to: string): Command {
  let prev = "";
  return {
    label: "Rename",
    apply(s) { const l = findById(s.labels, id); if (l) { prev = l.name; l.name = to; } },
    revert(s) { const l = findById(s.labels, id); if (l) l.name = prev; },
  };
}

export function removeLabel(id: Id): Command {
  let removed: NetLabel | undefined;
  let index = -1;
  return {
    label: "Delete label",
    apply(s) { index = indexOfId(s.labels, id); if (index >= 0) removed = s.labels.splice(index, 1)[0]; },
    revert(s) { if (removed && index >= 0) s.labels.splice(index, 0, removed); },
  };
}

export const addProbe = (probe: Probe): Command => ({
  label: "Probes",
  apply: s => { s.probes.push(probe); },
  revert: s => { const i = indexOfId(s.probes, probe.id); if (i >= 0) s.probes.splice(i, 1); },
});

export function removeProbe(id: Id): Command {
  let removed: Probe | undefined;
  let index = -1;
  return {
    label: "Remove probe",
    apply(s) { index = indexOfId(s.probes, id); if (index >= 0) removed = s.probes.splice(index, 1)[0]; },
    revert(s) { if (removed && index >= 0) s.probes.splice(index, 0, removed); },
  };
}

/** 여러 명령을 한 단계로 묶는다. 되돌릴 때는 역순이어야 한다 */
export const batch = (label: string, cmds: Command[]): Command => ({
  label,
  apply: s => { for (const c of cmds) c.apply(s); },
  revert: s => { for (let i = cmds.length - 1; i >= 0; i--) cmds[i].revert(s); },
});

// ── 프로젝트의 값 ─────────────────────────────────────────────────────
/*
 * 해석 설정 · .meas · 계산기 줄은 시트가 아니라 프로젝트에 있다. 예전에는 패널이 그 값을 직접
 * 바꿔서 실행 취소 기록에 남지 않았다 — 그러면 "어시스턴트가 한 일 되돌리기" 가 회로만 되돌리고
 * 해석 설정은 바뀐 채로 둔다. 같은 명령으로 바꿔 Ctrl+Z 가 같이 되돌리게 한다.
 *
 * 명령은 프로젝트를 잡아 둔다 (apply 가 받는 sheet 는 쓰지 않는다). 프로젝트를 갈아끼우면
 * 기록을 통째로 버리므로(History.clear) 옛 프로젝트를 잡은 명령이 남지 않는다.
 * 바뀌기 전 값은 다른 명령처럼 apply 할 때 읽는다.
 */
export function setSim(project: Project, next: SimSettings): Command {
  const to = structuredClone(next);
  let prev: SimSettings | undefined;
  return {
    label: "Analysis settings",
    apply() { prev = project.sim; project.sim = structuredClone(to); },
    revert() { if (prev) project.sim = prev; },
  };
}

/** .meas 줄을 통째로 바꾼다 */
export function setMeas(project: Project, lines: readonly string[]): Command {
  const to = [...lines];
  let prev: string[] | undefined;
  return {
    label: "Measurements",
    apply() { prev = project.meas ? [...project.meas] : []; project.meas = [...to]; },
    revert() { if (prev) project.meas = [...prev]; },
  };
}

/** 계산기 줄을 통째로 바꾼다 */
export function setCalc(project: Project, rows: readonly string[]): Command {
  const to = [...rows];
  let prev: string[] | undefined;
  return {
    label: "Calculator",
    apply() { prev = project.calc ? [...project.calc] : []; project.calc = [...to]; },
    revert() { if (prev) project.calc = [...prev]; },
  };
}

// ── 기록 ──────────────────────────────────────────────────────────────
/**
 * 명령 여러 개를 한 단계로 모으는 꼬리표 — 어시스턴트의 요청 하나가 하나다.
 *
 * 같은 꼬리표의 명령이 **잇달아** 오면 맨 위 단계에 붙인다. 그 사이에 사람이 손으로 고친 것이
 * 끼면 그것은 따로 한 단계가 되고, 그 뒤의 어시스턴트 명령은 새 단계로 시작한다 — 실행 취소는
 * 늘 일어난 순서의 역순이라, 끼어든 손 편집과 섞여 문서가 틀어질 일이 없다.
 *
 * 꼬리표는 명령마다 부르는 쪽이 붙인다. '지금 어시스턴트가 일하는 중' 같은 전역 상태로 정하면
 * 그동안 사람이 한 편집까지 어시스턴트 단계로 빨려 들어간다.
 */
export interface Group { id: string; label: string }

interface Entry {
  /** 이 단계의 명령들 (적용한 순서) */
  cmds: Command[];
  label: string;
  /** 명령 전후의 선택. 취소하면 선택도 그때로 되돌린다 */
  selBefore: SelSnapshot;
  selAfter: SelSnapshot;
  group?: string;
}

export class History {
  private past: Entry[] = [];
  private future: Entry[] = [];
  // 생성자 파라미터 프로퍼티는 node 의 타입 스트립 모드가 못 읽어서 필드로 둔다
  private readonly limit: number;

  constructor(limit = 200) { this.limit = limit; }

  /**
   * 명령을 실행하고 기록에 쌓는다. 새 편집은 '다시 실행' 가지를 버린다.
   * group 을 주면, 맨 위 단계가 같은 꼬리표일 때 그 단계에 붙인다.
   */
  run(sheet: Sheet, cmd: Command, selBefore: SelSnapshot, selAfter: SelSnapshot, group?: Group): void {
    cmd.apply(sheet);
    const top = this.past.at(-1);
    if (group && top?.group === group.id) {
      top.cmds.push(cmd);
      top.selAfter = selAfter;
    } else {
      this.past.push({ cmds: [cmd], label: group?.label ?? cmd.label, selBefore, selAfter, group: group?.id });
      if (this.past.length > this.limit) this.past.shift();
    }
    this.future.length = 0;
  }

  /** 되돌린다. 복원할 선택을 준다 (없으면 undefined) */
  undo(sheet: Sheet): SelSnapshot | undefined {
    const e = this.past.pop();
    if (!e) return undefined;
    for (let i = e.cmds.length - 1; i >= 0; i--) e.cmds[i].revert(sheet);
    this.future.push(e);
    return e.selBefore;
  }

  /** 다시 실행한다. 복원할 선택을 준다 (없으면 undefined) */
  redo(sheet: Sheet): SelSnapshot | undefined {
    const e = this.future.pop();
    if (!e) return undefined;
    for (const c of e.cmds) c.apply(sheet);
    this.past.push(e);
    return e.selAfter;
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get undoLabel(): string | null { return this.past.at(-1)?.label ?? null; }
  get redoLabel(): string | null { return this.future.at(-1)?.label ?? null; }
  /** 맨 위 단계의 꼬리표 (손 편집이면 undefined) */
  get undoGroup(): string | undefined { return this.past.at(-1)?.group; }
  get depth(): number { return this.past.length; }

  /** 문서를 통째로 갈아끼울 때(새로 열기 등) 기록을 버린다 */
  clear(): void { this.past.length = 0; this.future.length = 0; }
}
