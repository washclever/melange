/** 연결 — 바탕(셀)과 그린 것이 넷마다 몇 덩이로 이어졌는지, 덩이 사이 래츠네스트, 다른 넷끼리 닿은 곳(단락).
 *
 *  같은 층에서 닿는 금속은 이어진다. 비아의 컷은 그 아래 · 위 금속과 잇는다. 한 셀 안의 같은 넷 도형은 셀이 이미 잇는다고
 *  본다 (셀 생성기가 핀 막대와 소자를 안에서 잇는다 — 셀 안의 연결은 검사기가 본다). 다른 넷의 도형이 닿으면 단락이다
 *  (셀과 셀끼리는 보지 않는다 — 배치가 정한 것이라 그리기로 생기지 않는다).
 *
 *  래츠네스트: 넷의 덩이가 둘 이상이면 덩이 사이를 가장 가까운 두 점으로 잇는 최소 신장 트리 — PCB 편집기의 래츠네스트와
 *  같다. 그리면 그때마다 다시 센다 (analyze 는 수천 사각형에 몇 ms).
 */
import { metal, via, touch } from "./rules.mjs";

const CELL = 4000;

function grid() {
  const g = new Map();
  return {
    add(layer, rect, i) {
      for (let cx = Math.floor(rect[0] / CELL); cx <= Math.floor(rect[2] / CELL); cx++)
        for (let cy = Math.floor(rect[1] / CELL); cy <= Math.floor(rect[3] / CELL); cy++) {
          const k = `${layer}|${cx}|${cy}`;
          (g.get(k) ?? g.set(k, []).get(k)).push(i);
        }
    },
    near(layer, rect) {
      const out = new Set();
      for (let cx = Math.floor(rect[0] / CELL); cx <= Math.floor(rect[2] / CELL); cx++)
        for (let cy = Math.floor(rect[1] / CELL); cy <= Math.floor(rect[3] / CELL); cy++)
          for (const i of g.get(`${layer}|${cx}|${cy}`) ?? []) out.add(i);
      return out;
    },
  };
}

/** 사각형 사이의 가장 가까운 두 점과 거리 */
export function closest(a, b) {
  const px = a[2] < b[0] ? [a[2], b[0]] : b[2] < a[0] ? [a[0], b[2]] : (() => { const m = (Math.max(a[0], b[0]) + Math.min(a[2], b[2])) / 2; return [m, m]; })();
  const py = a[3] < b[1] ? [a[3], b[1]] : b[3] < a[1] ? [a[1], b[3]] : (() => { const m = (Math.max(a[1], b[1]) + Math.min(a[3], b[3])) / 2; return [m, m]; })();
  return { d: Math.hypot(px[1] - px[0], py[1] - py[0]), a: [px[0], py[0]], b: [px[1], py[1]] };
}

/**
 * @param {ReturnType<import("./base.mjs").composeBase>} base
 * @param {Array<{layer, rect, netName, id, role}>} drawn   doc.shapesOf(art) 의 결과
 * @returns {{ nets: Map<string, {pins:number, comps:number}>, ratsnest: Array<{net, a, b}>, shorts: Array<{a, b, layer, rect}>,
 *             compOf: (i) => number, shapes: Array }}
 */
export function analyze(base, drawn) {
  // 연결에 드는 것: 이름 있는 금속 (그릴 수 있는 층과 그 위) 과 비아 컷
  const all = [];
  for (const s of base.shapes) {
    if (s.netName == null) continue;
    if (!metal(s.layer) && !via(s.layer)) continue;
    all.push({ ...s, from: "base" });
  }
  const nBase = all.length;
  for (const s of drawn) all.push({ ...s, from: "art" });

  const parent = all.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };

  const G = grid();
  all.forEach((s, i) => G.add(s.layer, s.rect, i));
  const shorts = [], seenShort = new Set();
  const short = (i, j, layer) => {
    const k = i < j ? `${i}|${j}` : `${j}|${i}`;
    if (seenShort.has(k)) return;
    seenShort.add(k);
    const a = all[i].rect, b = all[j].rect;
    shorts.push({ a: all[i].netName, b: all[j].netName, layer, rect: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])],
                  ids: [all[i].id, all[j].id].filter((x) => x != null) });
  };

  // 셀 안의 같은 넷은 이어진 것으로
  const firstOf = new Map();
  for (let i = 0; i < nBase; i++) {
    const k = `${all[i].block}|${all[i].netName}`;
    if (firstOf.has(k)) union(i, firstOf.get(k)); else firstOf.set(k, i);
  }
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    // 같은 층 (셀끼리는 보지 않는다)
    for (const j of G.near(s.layer, s.rect)) {
      if (j <= i || (i < nBase && j < nBase)) continue;
      if (!touch(s.rect, all[j].rect)) continue;
      if (s.netName === all[j].netName) union(i, j);
      else if (metal(s.layer)) short(i, j, s.layer);
    }
    // 비아 컷 -> 아래 · 위 금속
    const V = via(s.layer);
    if (V && (s.from === "art" || i >= nBase)) {
      for (const L of [V.lo, V.hi]) {
        for (const j of G.near(L, s.rect)) {
          if (!touch(s.rect, all[j].rect)) continue;
          if (all[j].netName === s.netName) union(i, j);
          else short(i, j, L);
        }
      }
    }
  }
  // 바탕의 비아 컷도 (셀 안의 V1 · V2 가 핀 막대와 M1 을 잇는다 — 같은 셀이면 위에서 이미 이었다)

  // 넷마다 덩이
  const comps = new Map();          // net -> Map(root -> [index])
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    const isPin = s.from === "base" ? s.netType === "pin" : true;
    if (!isPin) continue;
    if (!comps.has(s.netName)) comps.set(s.netName, new Map());
    const m = comps.get(s.netName), r = find(i);
    (m.get(r) ?? m.set(r, []).get(r)).push(i);
  }
  const nets = new Map(), ratsnest = [];
  for (const [net, m] of comps) {
    const pins = [...m.values()].reduce((n, l) => n + l.filter((i) => i < nBase).length, 0);
    const groups = [...m.values()].filter((l) => l.some((i) => i < nBase));     // 핀이 있는 덩이만 (떠 있는 그림은 셈에 안 든다)
    nets.set(net, { pins, comps: groups.length });
    if (groups.length < 2) continue;
    // 최소 신장 트리 (Prim) — 덩이 사이 거리는 사각형 사이 가장 가까운 거리
    const dist = (A, B) => {
      let best = null;
      for (const i of A) for (const j of B) {
        const c = closest(all[i].rect, all[j].rect);
        if (!best || c.d < best.d) best = c;
      }
      return best;
    };
    const inTree = [groups[0]], rest = groups.slice(1);
    while (rest.length) {
      let bi = -1, bc = null;
      for (let k = 0; k < rest.length; k++) for (const T of inTree) {
        const c = dist(T, rest[k]);
        if (!bc || c.d < bc.d) { bc = c; bi = k; }
      }
      ratsnest.push({ net, a: bc.a, b: bc.b });
      inTree.push(rest.splice(bi, 1)[0]);
    }
  }
  return { nets, ratsnest, shorts, shapes: all, find, nBase };
}

/** 넷의 상태 한 줄 — 열린 덩이 수 (1 이면 다 이어졌다) */
export const openNets = (an) => [...an.nets].filter(([, s]) => s.comps > 1).map(([n]) => n);
