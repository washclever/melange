/**
 * 어시스턴트가 회로를 이을 때 쓰는 기하 — 핀과 핀을 배선으로, 핀을 넷 이름으로, 부품을 빈 자리에.
 *
 * 모델은 연결(넷)로 말하고 좌표는 여기서 정한다. 언어 모델에게 "R1 의 2번 핀이 어느 좌표인가" 를
 * 맞히게 하면 격자에서 한 칸 어긋나고, 한 칸 어긋난 배선은 **다른 핀을 밟아 조용히 단락된다**
 * (규칙 3: 선분 중간에 놓인 핀은 연결이다). 그래서 이 파일의 약속은 하나다:
 *
 *   **요청하지 않은 연결은 만들지 않는다.**
 *
 *  - 배선은 doc/route.ts 의 경로 찾기로 긋는다. 지나가면 연결이 바뀌는 칸은 아예 못 지난다.
 *  - 그어 본 뒤 넷을 통째로 다시 추출해 **두 핀의 넷만 합쳐졌는지** 견준다. 경로 찾기가 놓친
 *    것이 있어도 여기서 걸린다. 다르면 긋지 않는다.
 *  - 길이 없거나 확인에 걸리면 넷 라벨로 잇는다 (짧은 꼬리 + 같은 이름의 라벨). 외부 .sp 를
 *    회로도로 옮길 때(io/import-sp.ts)와 같은 방법이다.
 *
 * 순수한 계산이라 캔버스 없이 시험한다 (tools/verify-ai-tools.ts).
 */
import { drawPart, pinDir } from "./follow.ts";
import { addLabel, addPart, addWire, batch, removeObjects, type Command, type Ref } from "./history.ts";
import { CellMap, BLOCK, EDGE_H, EDGE_V, NOBEND, POINT, route, type RouteEnds } from "./route.ts";
import { SheetIndex, symbolBox, type IndexedKind } from "./sheet-index.ts";
import {
  GRID, pinAt, samePt, uid,
  type Id, type LibPart, type NetLabel, type Part, type Probe, type Pt, type Sheet, type Wire,
} from "./types.ts";
import { extractNets, onSegment } from "../net/extract.ts";
import { makePart } from "./ops.ts";

const ALL = new Set<IndexedKind>(["part", "wire", "label", "probe"]);
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

/** 부품의 핀 하나 */
export interface PinRef { part: Part; lib: LibPart; i: number }

/** 핀의 시트 좌표 */
export const pinPoint = (p: PinRef): Pt => pinAt(p.part, p.lib, p.i);

/** 핀이 바깥을 보는 방향 (0 오른쪽 1 아래 2 왼쪽 3 위, 모르면 -1) */
export const pinOutDir = (p: PinRef): number => pinDir(p.lib, p.i, p.part);

/**
 * 시트 전체를 장애물로 — 부품 몸통 · 핀 · 배선 · 라벨 · 프로브 · 접합점. 칸 묶음을 처음 물을 때
 * 색인에서 그 자리 것만 채운다 (doc/follow.ts 의 '움직이지 않는 세상' 과 같은 방식).
 */
export function obstacles(sheet: Sheet, library: Record<string, LibPart>, index: SheetIndex): CellMap {
  const map: CellMap = new CellMap((x0, y0, x1, y1) => {
    for (const e of index.query(x0, y0, x1, y1, ALL)) {
      if (e.kind === "part") {
        const p = e.obj as Part, lib = library[p.lib];
        if (lib) drawPart(map, lib, p);
      } else if (e.kind === "wire") map.wire((e.obj as Wire).pts);
      else {
        const o = e.obj as NetLabel | Probe;
        map.point(o.at[0], o.at[1]);
      }
    }
  });
  for (const j of sheet.junctions) map.point(j[0], j[1]);
  return map;
}

// ── 연결이 바뀌었는지 ─────────────────────────────────────────────────
/** 핀 ("partId:pinId") -> 넷 이름. 문서를 통째로 다시 추출한다 */
export const pinNets = (sheet: Sheet, library: Record<string, LibPart>): Map<string, string> =>
  extractNets(sheet, library).pinNet;

/**
 * after 가 before 에서 **넷 merge 들만** 합친 것인가. merge 에 든 넷들은 하나로 합쳐져도 되고
 * (합쳐져야 하는지는 부르는 쪽이 따로 본다), 그 밖의 넷은 하나도 나뉘거나 합쳐지면 안 된다.
 *
 * 넷 이름으로 견주지 않는다. 자동 이름(N001…)은 연결이 바뀌면 번호가 밀린다 — 옛 넷이 새 넷으로
 * 하나씩 옮겨 갔는지(나뉘지 않았는지)와 새 넷마다 옛 넷이 몇 개 들어왔는지(합쳐지지 않았는지)를 본다.
 * after 에만 있는 핀(새로 놓은 GND)은 보지 않는다.
 */
export function onlyMerged(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, merge: ReadonlySet<string>): boolean {
  const fwd = new Map<string, string>();
  const back = new Map<string, Set<string>>();
  for (const [pin, old] of before) {
    const now = after.get(pin);
    if (now === undefined) return false;           // 핀이 사라졌다 — 잇기가 할 일이 아니다
    const seen = fwd.get(old);
    if (seen !== undefined && seen !== now) return false;   // 한 넷이 갈라졌다
    fwd.set(old, now);
    let olds = back.get(now);
    if (!olds) back.set(now, olds = new Set());
    olds.add(old);
  }
  for (const olds of back.values()) {
    if (olds.size <= 1) continue;
    for (const o of olds) if (!merge.has(o)) return false;   // 부탁하지 않은 넷이 합쳐졌다
  }
  return true;
}

/** 명령을 시험 삼아 적용해 보고 되돌린다. 그 사이의 핀 -> 넷을 돌려준다 */
function trial(sheet: Sheet, library: Record<string, LibPart>, cmd: Command): Map<string, string> {
  cmd.apply(sheet);
  try { return pinNets(sheet, library); } finally { cmd.revert(sheet); }
}

// ── 핀과 핀 잇기 ──────────────────────────────────────────────────────
export interface Wiring {
  cmd: Command;
  /** wire: 배선 하나로 · label: 넷 라벨로 (길이 없었다) */
  via: "wire" | "label";
  /** 라벨로 이었으면 그 이름 */
  name?: string;
}

/**
 * 두 핀을 잇는 명령. 이미 같은 넷이면 null. 배선으로 못 이으면 넷 라벨로 잇는다 —
 * 라벨 이름은 두 넷 가운데 이미 사람이 붙인 이름이 있으면 그것, 없으면 fallbackName.
 */
export function connectPins(
  sheet: Sheet, library: Record<string, LibPart>, index: SheetIndex,
  a: PinRef, b: PinRef, fallbackName: string,
): Wiring | null {
  const before = pinNets(sheet, library);
  const ka = a.part.id + ":" + a.lib.symbol.pins[a.i].id, kb = b.part.id + ":" + b.lib.symbol.pins[b.i].id;
  const na = before.get(ka), nb = before.get(kb);
  if (na !== undefined && na === nb) return null;
  const merge = new Set([na, nb].filter((n): n is string => n !== undefined));

  const from = pinPoint(a), to = pinPoint(b);
  const map = obstacles(sheet, library, index);
  const da = pinOutDir(a), db = pinOutDir(b);
  const ends: RouteEnds = { inDir: -1, outDir: da, arriveDir: db >= 0 ? (db + 2) & 3 : -1, onDir: -1 };
  const path = route(from, to, (gx, gy) => map.at(gx, gy), ends);
  if (path && path.length >= 2) {
    const cmd = addWire({ id: uid(), pts: path });
    const after = trial(sheet, library, cmd);
    if (onlyMerged(before, after, merge) && after.get(ka) === after.get(kb)) return { cmd, via: "wire" };
  }

  // 라벨로. 두 넷 가운데 사람이 이름을 붙인 쪽이 있으면 그 이름을 쓴다 (다른 이름을 하나 더 붙이면 넷이 둘로 읽힌다)
  const named = [na, nb].find(n => n !== undefined && isUserName(n));
  const name = named ?? fallbackName;
  const parts: Command[] = [];
  let idx = index;
  try {
    for (const [p, net] of [[a, na], [b, nb]] as const) {
      if (net !== undefined && net.toLowerCase() === name.toLowerCase()) continue;   // 이미 그 이름이다
      const c = nameNet(sheet, library, idx, p, name, "label");
      if (!c) return null;
      /*
       * 다음 쪽의 자리를 찾을 때 이쪽에 단 것이 장애물이어야 한다 — 잠시 적용해 둔다. 장애물은 새 색인으로
       * 본다: 앱의 색인을 여기서 맞추면 화면 · 증분 넷 추출이 받을 '바뀐 것' 을 가로챈다.
       */
      c.apply(sheet);
      parts.push(c);
      idx = new SheetIndex();
      idx.sync(sheet, library);
    }
  } finally {
    for (let i = parts.length - 1; i >= 0; i--) parts[i].revert(sheet);
  }
  const cmd = batch("Connect", parts);
  const after = trial(sheet, library, cmd);
  // 그 이름의 넷이 이미 다른 데 있으면 그것도 합쳐진다. 그건 이름을 고른 쪽의 뜻이다
  const target = after.get(ka);
  const alsoNamed = [...before.values()].filter(n => n.toLowerCase() === name.toLowerCase());
  if (!onlyMerged(before, after, new Set([...merge, ...alsoNamed])) || target === undefined || after.get(kb) !== target) return null;
  return { cmd, via: "label", name };
}

/**
 * 핀을 이름 있는 넷에. 넷 0 (접지)이면 GND 기호를, 아니면 꼬리 + 라벨(또는 전원 기호)을 단다.
 * 이미 그 넷이면 null. 둘 곳이 없거나, 달아 본 결과가 그 핀의 넷과 그 이름의 넷 말고 다른 것을
 * 합치면 실패로 본다 (Wiring 대신 문자열 이유를 돌려준다).
 */
export function connectToNet(
  sheet: Sheet, library: Record<string, LibPart>, index: SheetIndex,
  p: PinRef, name: string, kind: "label" | "power" = "label",
): Wiring | string | null {
  const before = pinNets(sheet, library);
  const key = p.part.id + ":" + p.lib.symbol.pins[p.i].id;
  const net = before.get(key);
  const ground = name === "0" || /^gnd$/i.test(name);
  const target = ground ? "0" : name;
  if (net !== undefined && net.toLowerCase() === target.toLowerCase()) return null;
  // 접지는 GND 기호가 먼저다 (앱의 G 도구와 같은 모양). 둘 데가 없으면 접지 라벨로
  if (ground) {
    const g = groundPin(sheet, library, index, p);
    if (g && accepts(sheet, library, before, g, key, "0")) return { cmd: g, via: "wire", name: "0" };
  }
  const cmd = nameNet(sheet, library, index, p, ground ? "GND" : name, ground ? "gnd" : kind);
  if (!cmd) return "there is no spot next to the pin or on its wires for a label that would not touch something else";
  return { cmd, via: "label", name: target };
}

/** 명령을 적용하면 그 핀이 target 넷에 가고, 그 핀의 넷과 target 넷 말고는 아무것도 합쳐지지 않는가 */
function accepts(
  sheet: Sheet, library: Record<string, LibPart>, before: ReadonlyMap<string, string>,
  cmd: Command, key: string, target: string,
): boolean {
  const after = trial(sheet, library, cmd);
  const net = before.get(key);
  const merge = new Set([...(net !== undefined ? [net] : []), ...[...before.values()].filter(n => n.toLowerCase() === target.toLowerCase())]);
  return onlyMerged(before, after, merge) && (after.get(key) ?? "").toLowerCase() === target.toLowerCase();
}

/**
 * 핀의 넷에 이름을 붙이는 명령. 자리를 이 순서로 찾고, 붙여 봐서 다른 넷이 안 합쳐지는 첫 자리를 쓴다:
 *  1) 핀에서 바깥으로 짧은 꼬리 + 그 끝의 라벨
 *  2) 그 핀에 이미 닿은 배선 위의 격자점 (핀에서 가까운 것부터) — 사람이 라벨을 다는 자리다
 *  3) 핀 바로 위
 * 라벨의 종류가 gnd 면 넷 0 이 된다.
 */
export function nameNet(
  sheet: Sheet, library: Record<string, LibPart>, index: SheetIndex,
  p: PinRef, name: string, kind: NetLabel["kind"],
): Command | null {
  const before = pinNets(sheet, library);
  const key = p.part.id + ":" + p.lib.symbol.pins[p.i].id;
  const target = kind === "gnd" ? "0" : name;
  const at = pinPoint(p);
  const tries: Array<() => Command | null> = [
    () => labelStub(obstacles(sheet, library, index), p, name, kind),
    ...wirePoints(sheet, at, 6).map(q => () => addLabel({ id: uid(), name, at: q, kind })),
    () => addLabel({ id: uid(), name, at: [at[0], at[1]], kind }),
  ];
  for (const t of tries) {
    const cmd = t();
    if (cmd && accepts(sheet, library, before, cmd, key, target)) return cmd;
  }
  return null;
}

/** 점 at 에 닿은 배선들 위의 격자점, at 에서 배선을 따라 가까운 순으로 (at 자신은 뺀다) */
function wirePoints(sheet: Sheet, at: Pt, limit: number): Pt[] {
  const out: Array<{ p: Pt; d: number }> = [];
  for (const w of sheet.wires) {
    const k = w.pts.findIndex(q => samePt(q, at));
    const touches = k >= 0 || w.pts.some((_, i) => i < w.pts.length - 1 && onSegment(at, w.pts[i], w.pts[i + 1]));
    if (!touches) continue;
    // 배선을 따라 점들을 훑어 at 으로부터의 거리(배선 길이로)를 잰다
    let walked = 0;
    const along: Array<{ p: Pt; s: number }> = [];
    for (let i = 0; i < w.pts.length - 1; i++) {
      const a = w.pts[i], b = w.pts[i + 1];
      const len = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
      if (a[0] !== b[0] && a[1] !== b[1]) { walked += len; continue; }   // 비스듬한 선분은 건너뛴다
      const steps = Math.round(len / GRID);
      for (let s = 0; s <= steps; s++) {
        const q: Pt = [a[0] + Math.sign(b[0] - a[0]) * s * GRID, a[1] + Math.sign(b[1] - a[1]) * s * GRID];
        along.push({ p: q, s: walked + s * GRID });
      }
      walked += len;
    }
    const base = along.find(x => samePt(x.p, at))?.s ?? 0;
    for (const x of along) if (!samePt(x.p, at)) out.push({ p: x.p, d: Math.abs(x.s - base) });
  }
  out.sort((a, b) => a.d - b.d);
  const seen = new Set<string>();
  const res: Pt[] = [];
  for (const o of out) {
    const k = o.p[0] + "," + o.p[1];
    if (seen.has(k)) continue;
    seen.add(k);
    res.push(o.p);
    if (res.length >= limit) break;
  }
  return res;
}

/** 사람이 붙인 넷 이름인가 (자동 이름 N001 · 접지 0 이 아닌 것) */
export const isUserName = (net: string): boolean => net !== "0" && !/^N\d{3,}$/i.test(net);

/**
 * 핀에서 바깥으로 짧은 꼬리를 빼고 그 끝에 넷 라벨을 단다. 꼬리 끝과 지나는 칸이 비어 있는
 * 길이를 2 · 3 · 4 · 1 칸 순으로 찾는다. 못 찾으면 null.
 */
export function labelStub(map: CellMap, p: PinRef, name: string, kind: NetLabel["kind"] = "label"): Command | null {
  const end = stubEnd(map, p);
  if (!end) return null;
  const at = pinPoint(p);
  return batch("Net label", [
    addWire({ id: uid(), pts: [at, end] }),
    addLabel({ id: uid(), name, at: end, kind }),
  ]);
}

/** 꼬리 끝 자리 (핀의 바깥 방향). 다른 방향은 보지 않는다 — 꼬리가 부품을 가로지르면 안 된다 */
function stubEnd(map: CellMap, p: PinRef, lengths = [2, 3, 4, 1], room = 0): Pt | null {
  const d = pinOutDir(p);
  if (d < 0) return null;
  const at = pinPoint(p);
  const gx = at[0] / GRID, gy = at[1] / GRID;
  if (!Number.isInteger(gx) || !Number.isInteger(gy)) return null;
  for (const n of lengths) {
    let ok = true;
    for (let k = 1; k <= n + room && ok; k++) {
      const x = gx + DX[d] * k, y = gy + DY[d] * k;
      const f = map.at(x, y);
      // 지나는 칸: 연결점 · 몸통이 없고, 그 칸으로 가는 변을 다른 배선이 쓰지 않는다
      if (f & BLOCK) ok = false;
      const ex = d === 0 ? map.at(x - 1, y) & EDGE_H : d === 2 ? f & EDGE_H : d === 1 ? map.at(x, y - 1) & EDGE_V : f & EDGE_V;
      if (k <= n && ex) ok = false;
      // 꼬리 끝(과 그 너머의 여유 칸)에는 지나가는 배선도 없어야 한다 — 끝에 단 라벨이 그 배선에 붙는다
      if (k >= n && (f & (NOBEND | POINT))) ok = false;
    }
    if (ok) return [at[0] + DX[d] * n * GRID, at[1] + DY[d] * n * GRID];
  }
  return null;
}

/**
 * 핀을 접지에. 꼬리를 빼고 그 끝에 GND 기호를 바깥을 향하게 놓는다 (기호가 부품 쪽으로 오지 않게).
 * 앱의 G 도구가 놓는 것과 같은 GND 부품이다.
 */
export function groundPin(sheet: Sheet, library: Record<string, LibPart>, index: SheetIndex, p: PinRef): Command | null {
  const map = obstacles(sheet, library, index);
  // GND 기호는 핀에서 1.6 칸 뻗는다. 그 자리도 비어 있어야 한다
  const end = stubEnd(map, p, [2, 3, 4], 2);
  if (!end) return null;
  const d = pinOutDir(p);
  // 기호는 회전 0 에서 아래(+y)로 뻗는다. 바깥 방향으로 뻗게 돌린다
  const rot = (d === 1 ? 0 : d === 3 ? 180 : d === 0 ? 90 : 270) as Part["rot"];
  const gnd = makePart(library, sheet, "gnd", end, rot);
  return batch("Ground", [addWire({ id: uid(), pts: [pinPoint(p), end] }), addPart(gnd)]);
}

// ── 부품 놓을 자리 ────────────────────────────────────────────────────
/**
 * 부품을 놓아도 되는 자리인가. 핀이 기존 넷(핀 · 배선 · 라벨)에 닿으면 그 자리에서 연결이 생기고,
 * 몸통이 다른 부품 · 배선 · 라벨과 겹치면 읽을 수 없다. 둘 다 피한다.
 * taken 은 같은 요청에서 먼저 정한 핀 자리 (아직 문서에 없다).
 */
export function fits(
  sheet: Sheet, library: Record<string, LibPart>, index: SheetIndex, netAt: (p: Pt) => string | null,
  lib: LibPart, at: Pt, rot: Part["rot"], mirror: boolean, taken: ReadonlySet<string> = new Set(),
): boolean {
  const probe = { at, rot, mirror } as Part;
  for (let i = 0; i < lib.symbol.pins.length; i++) {
    const p = pinAt(probe, lib, i);
    if (netAt(p) !== null || taken.has(p[0] + "," + p[1])) return false;
  }
  const [x0, y0, x1, y1] = symbolBox(lib, rot, mirror);
  // 두 칸 여유 — 지정자 · 값 글자가 기호 위아래 1.6 칸에 적힌다. 한 칸이면 이웃 부품의 글자와 겹친다
  const m = 2 * GRID;
  const hits = index.query(at[0] + x0 - m, at[1] + y0 - m, at[0] + x1 + m, at[1] + y1 + m, ALL);
  for (const e of hits) {
    if (e.kind === "part") return false;
    if (e.kind === "wire") {
      // 상자를 실제로 지나는 배선만 (상자 근처를 스치는 것은 색인이 넓게 준 것이다)
      const w = e.obj as Wire;
      for (let k = 0; k < w.pts.length - 1; k++) {
        if (segHitsBox(w.pts[k], w.pts[k + 1], at[0] + x0 - m, at[1] + y0 - m, at[0] + x1 + m, at[1] + y1 + m)) return false;
      }
    } else {
      const o = e.obj as NetLabel | Probe;
      if (o.at[0] >= at[0] + x0 - m && o.at[0] <= at[0] + x1 + m && o.at[1] >= at[1] + y0 - m && o.at[1] <= at[1] + y1 + m) return false;
    }
  }
  return true;
}

function segHitsBox(a: Pt, b: Pt, x0: number, y0: number, x1: number, y1: number): boolean {
  // 가로 · 세로 선분만 정확히 본다. 비스듬한 선분은 상자로 어림한다
  const lx = Math.min(a[0], b[0]), hx = Math.max(a[0], b[0]), ly = Math.min(a[1], b[1]), hy = Math.max(a[1], b[1]);
  return hx >= x0 && lx <= x1 && hy >= y0 && ly <= y1;
}

/**
 * want 에서 가장 가까운 놓을 수 있는 자리. 바깥으로 한 겹씩 넓혀 가며 찾는다 (격자 단위).
 * 반경 안에 없으면 null.
 */
export function findSpot(
  sheet: Sheet, library: Record<string, LibPart>, index: SheetIndex, netAt: (p: Pt) => string | null,
  lib: LibPart, want: Pt, rot: Part["rot"], mirror: boolean, taken: ReadonlySet<string> = new Set(), radius = 30,
): Pt | null {
  for (let r = 0; r <= radius; r++) {
    // 한 겹의 자리를 가까운 순으로 (같으면 오른쪽 · 아래가 먼저 — 회로는 왼쪽에서 오른쪽으로 읽힌다)
    const ring: Pt[] = [];
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        ring.push([dx, dy]);
      }
    }
    ring.sort((p, q) => (p[0] ** 2 + p[1] ** 2) - (q[0] ** 2 + q[1] ** 2) || q[0] - p[0] || q[1] - p[1]);
    for (const [dx, dy] of ring) {
      const at: Pt = [want[0] + dx * GRID, want[1] + dy * GRID];
      if (fits(sheet, library, index, netAt, lib, at, rot, mirror, taken)) return at;
    }
  }
  return null;
}

/** 시트에 그려진 것 전부의 경계 상자. 비었으면 null */
export function contentBox(sheet: Sheet, library: Record<string, LibPart>): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  };
  for (const p of sheet.parts) {
    const lib = library[p.lib];
    if (!lib) continue;
    const [a, b, c, d] = symbolBox(lib, p.rot, p.mirror);
    add(p.at[0] + a, p.at[1] + b); add(p.at[0] + c, p.at[1] + d);
  }
  for (const w of sheet.wires) for (const p of w.pts) add(p[0], p[1]);
  for (const l of sheet.labels) add(l.at[0], l.at[1]);
  for (const b of sheet.spice) add(b.at[0], b.at[1]);
  return isFinite(x0) ? [x0, y0, x1, y1] : null;
}

// ── 지우기 ────────────────────────────────────────────────────────────
/**
 * 부품을 지우는 명령. 지운 핀에 매달려 남는 배선도 같이 지운다 — 다만 **빼도 다른 연결이 그대로인**
 * 배선만이다. 지운 부품의 핀에서 다른 두 부품 사이를 지나던 배선은 남긴다 (빼면 그 둘이 끊긴다).
 */
export function deleteParts(sheet: Sheet, library: Record<string, LibPart>, parts: readonly Part[], extra: Ref[] = []): Command {
  const refs: Ref[] = [...parts.map(p => ({ kind: "part" as const, id: p.id })), ...extra];
  const pins: Pt[] = [];
  for (const p of parts) {
    const lib = library[p.lib];
    if (lib) for (let i = 0; i < lib.symbol.pins.length; i++) pins.push(pinAt(p, lib, i));
  }
  const touches = (w: Wire) => pins.some(q => w.pts.some((_, k) => k < w.pts.length - 1 && onSegment(q, w.pts[k], w.pts[k + 1])) || w.pts.some(p => samePt(p, q)));
  const candidates = sheet.wires.filter(touches);
  if (!candidates.length) return removeObjects(refs);

  // 부품을 지운 문서에서, 배선을 하나씩 빼 보며 연결이 그대로인지 본다
  const drop: Id[] = [];
  const cuts: Command[] = [];
  const base = removeObjects(refs);
  base.apply(sheet);
  try {
    let now = pinNets(sheet, library);
    for (const w of candidates) {
      const cut = removeObjects([{ kind: "wire", id: w.id }]);
      cut.apply(sheet);
      const after = pinNets(sheet, library);
      // 남은 핀들의 넷이 그대로다 (나뉘지도 합쳐지지도 않았다)
      if (onlyMerged(now, after, new Set()) && onlyMerged(after, now, new Set())) {
        drop.push(w.id);       // 빼 둔 채로 다음 것을 본다 (줄줄이 매달린 배선)
        cuts.push(cut);
        now = after;
      } else cut.revert(sheet);
    }
  } finally {
    // 넣은 역순으로 되돌려야 배열 순서가 처음과 같다
    for (let i = cuts.length - 1; i >= 0; i--) cuts[i].revert(sheet);
    base.revert(sheet);
  }
  return removeObjects([...refs, ...drop.map(id => ({ kind: "wire" as const, id }))]);
}
