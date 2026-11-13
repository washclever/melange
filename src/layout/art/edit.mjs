/** 그린 트랙 고치기 — PCB 편집기에서 트랙을 고치듯. 토막을 끌면 그 곧은 줄이 옆 트랙으로 옮겨 가고, 거기 붙은 이웃 줄은
 *  늘거나 줄어 붙은 채로 남는다. 꺾는 점(비아)을 끌면 그 점에서 만나는 두 줄이 같이 옮겨 가고, 끝이 빈 토막은 그 끝을 늘이고 줄인다.
 *
 *  IC 금속이 PCB 와 다른 점 — 특히 비아:
 *    - 층마다 방향이 하나라 토막은 제 방향으로만 늘고, 옮길 때는 그 층의 트랙(Pitch)으로만 간다
 *    - 비아는 이웃한 두 층만 잇고(Vk: Mk–Mk+1), 두 층의 트랙이 만나는 점에만 선다. 줄이 옮겨 가면 그 위의 비아도 같이 옮겨 가
 *      새 교차점에 서고, 거기 붙은 이웃 층의 줄이 그만큼 늘거나 준다 (따라가기)
 *    - 따라갈 수 없는 것 — 셀의 핀, 아래로 쌓인 비아, 가운데로 지나가는 줄, 걷어 낼 자리에 또 붙은 것 — 에 붙어 있으면 그 자리는
 *      그대로 두고 이웃 층으로 짧은 토막(jog)과 비아를 더해 이어 둔다 (붙들기). PCB 에서 패드에 붙은 트랙 끝을 끌면 끝이 패드에
 *      남는 것과 같다
 *    - 층을 바꾸면(met1 ↔ met3 처럼 방향이 같은 층으로) 붙은 곳마다 비아를 그 층까지 다시 쌓는다 — PCB 의 관통 비아와 달리
 *      한 층씩이다
 *
 *  줄(run)은 같은 넷 · 같은 층 · 같은 트랙에서 이어진 토막들이다 — 배선기는 한 줄을 겹치는 여러 토막으로 내고, 비아 앞뒤로
 *  끊긴 토막을 그 비아의 금속으로만 잇기도 하고, 같은 비아를 겹쳐 내기도 한다. 그런 토막은 한 줄로, 겹친 비아는 하나로 본다.
 *  비아가 자리를 떠날 때 그 금속이 메우던 틈은 짧은 토막으로 메워 둔다.
 *  결과는 doc.apply 가 받는 { add, del } 한 칸이다 — 되돌리기 한 번에 통째로 돌아온다. 옮긴 것은 번호를 그대로 두고(고른 것이
 *  남는다), 새로 생긴 토막 · 비아는 번호를 미리 붙인다 (art.next 부터). 다른 넷에 닿는지는 부르는 쪽이 draw.judge 로 본다.
 *  near(layer, box) 는 그 자리의 도형 [{ from: "base"|"art", netName, layer, rect }] (track.mjs 의 색인) — 셀의 도형만 읽는다.
 */
import { metal, via, viaOf, above, below, snap, tracksIn, wireRect, viaShapes, touch } from "./rules.mjs";
import { climb } from "./draw.mjs";

const EPS = 1;                                         // nm — 배선기의 좌표는 반 nm 까지 온다
const isV = (L) => metal(L).dir === "v";
/** 토막이 서 있는 트랙의 축 (세로 층은 x), 토막이 뻗는 축 */
export const acrossOf = (L) => (isV(L) ? "x" : "y");
export const alongOf = (L) => (isV(L) ? "y" : "x");
export const trackOf = (w) => (isV(w.layer) ? w.x0 : w.y0);
export function spanOf(w) {
  const a = isV(w.layer) ? [w.y0, w.y1] : [w.x0, w.x1];
  return [Math.min(a[0], a[1]), Math.max(a[0], a[1])];
}
const wireAt = (net, L, t, a, b, id) =>
  (isV(L) ? { id, net, layer: L, x0: t, y0: a, x1: t, y1: b } : { id, net, layer: L, x0: a, y0: t, x1: b, y1: t });
/** 층 L 의 트랙 t 위, a 의 점 */
const pt = (L, t, a) => (isV(L) ? { x: t, y: a } : { x: a, y: t });
const withSpan = (w, lo, hi) => (isV(w.layer) ? { ...w, y0: lo, y1: hi } : { ...w, x0: lo, x1: hi });
const withTrack = (w, t) => (isV(w.layer) ? { ...w, x0: t, x1: t } : { ...w, y0: t, y1: t });
const viaLayers = (v) => { const V = via(v.layer); return V ? [V.lo, V.hi] : []; };
const otherSide = (v, L) => { const [a, b] = viaLayers(v); return a === L ? b : b === L ? a : null; };
/** 비아의 그 층 쪽 금속 */
const padOf = (v, L) => viaShapes(v).find((s) => s.layer === L && s.role !== "cut")?.rect ?? null;
const sameNetBase = (near, net, L, rect) => (rect ? near(L, rect).filter((s) => s.from === "base" && s.netName === net) : []);
const samePoint = (a, b) => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;
/** 그 층의 트랙 t, [a, b] 구간의 금속 사각형 */
const spanRect = (L, t, a, b) => { const h = metal(L).width / 2; return isV(L) ? [t - h, a, t + h, b] : [a, t - h, b, t + h]; };

// ---------------------------------------------------------------- 고치는 판 (art 를 그대로 두고 사본에서)

function board(art) { return { wires: art.wires.slice(), vias: art.vias.slice(), next: art.next }; }
const id = (B) => B.next++;
function put(B, o) {
  const list = "x0" in o ? B.wires : B.vias;
  const i = list.findIndex((q) => q.id === o.id);
  if (i >= 0) list[i] = o; else list.push(o);
}
function drop(B, ids) {
  const gone = new Set(ids);
  B.wires = B.wires.filter((q) => !gone.has(q.id));
  B.vias = B.vias.filter((q) => !gone.has(q.id));
}
/** 고치며 생긴 비아가 같은 넷 · 같은 층 · 같은 점의 다른 비아와 겹치면 뺀다 — 손대지 않은 비아(배선기가 겹쳐 낸 것까지)는 그대로 */
function dedupe(B, art) {
  const key = (v) => `${v.net}|${v.layer}|${Math.round(v.x)}|${Math.round(v.y)}`;
  const orig = new Map(art.vias.map((v) => [v.id, JSON.stringify(v)]));
  const touched = (v) => orig.get(v.id) !== JSON.stringify(v);
  const have = new Set(B.vias.filter((v) => !touched(v)).map(key));
  const out = [];
  for (const v of [...B.vias].sort((a, b) => a.id - b.id)) {
    if (!touched(v)) { out.push(v); continue; }
    const k = key(v);
    if (have.has(k)) continue;
    have.add(k);
    out.push(v);
  }
  B.vias = out;
}
/** 처음(art)과 판(B)의 차이 -> { add, del, next } — 바뀐 것은 같은 번호로 지우고 다시 넣는다 */
function diff(art, B) {
  const o = new Map([...art.wires, ...art.vias].map((x) => [x.id, x]));
  const f = new Map([...B.wires, ...B.vias].map((x) => [x.id, x]));
  const del = [], add = { wires: [], vias: [] };
  for (const [k, x] of o) if (!f.has(k) || JSON.stringify(f.get(k)) !== JSON.stringify(x)) del.push(k);
  for (const [k, x] of f) if (!o.has(k) || JSON.stringify(o.get(k)) !== JSON.stringify(x)) ("x0" in x ? add.wires : add.vias).push(x);
  return { add, del, next: B.next };
}
const stats = () => ({ moved: 0, followed: 0, jogs: 0, left: [] });

/** [a, b] 를 토막들이 빈틈없이 덮나 */
function covers(wires, a, b) {
  let reach = null;
  for (const [lo, hi] of wires.map(spanOf).sort((p, q) => p[0] - q[0])) {
    if (reach === null) { if (lo > a + EPS) return false; reach = hi; }
    else if (lo > reach + EPS) break;
    else reach = Math.max(reach, hi);
    if (reach >= b - EPS) return true;
  }
  return reach !== null && reach >= b - EPS;
}

/**
 * 곧은 줄 — 그 토막과 같은 넷 · 같은 층 · 같은 트랙에서 이어진 토막들. 겹치거나 닿는 토막, 그리고 그 트랙 위 비아의 그 층 쪽
 * 금속으로 이어진 토막까지 (배선기는 한 줄을 비아 앞뒤로 끊어, 끊긴 틈을 비아의 금속이 메우게 내기도 한다)
 */
export function runOf(art, wid) {
  const w0 = art.wires.find((w) => w.id === wid);
  if (!w0 || !metal(w0.layer)) return null;
  const L = w0.layer, c = trackOf(w0), ax = acrossOf(L), al = alongOf(L);
  const same = art.wires.filter((w) => w.net === w0.net && w.layer === L && Math.abs(trackOf(w) - c) <= EPS);
  const pads = art.vias.filter((v) => v.net === w0.net && otherSide(v, L) && Math.abs(v[ax] - c) <= EPS).map((v) => {
    const r = padOf(v, L);
    return al === "y" ? [r[1], r[3]] : [r[0], r[2]];
  });
  let [lo, hi] = spanOf(w0), reachLo = lo, reachHi = hi;
  const ids = new Set([w0.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [a, b] of pads) {
      if (a <= reachHi + EPS && b >= reachLo - EPS && (a < reachLo || b > reachHi)) { reachLo = Math.min(reachLo, a); reachHi = Math.max(reachHi, b); grew = true; }
    }
    for (const w of same) {
      if (ids.has(w.id)) continue;
      const [a, b] = spanOf(w);
      if (a <= reachHi + EPS && b >= reachLo - EPS) {
        ids.add(w.id); lo = Math.min(lo, a); hi = Math.max(hi, b);
        reachLo = Math.min(reachLo, a); reachHi = Math.max(reachHi, b); grew = true;
      }
    }
  }
  return { layer: L, net: w0.net, c, lo, hi, ids };
}

/** 줄 위의 비아 — 그 층과 이웃 층을 잇는, 중심이 그 트랙 위이고 그 층 쪽 금속이 줄에 닿는 것 (배선기는 비아를 줄 끝 조금
 *  너머에도 둔다 — 금속은 겹친다) */
function viasOnRun(B, run) {
  const L = run.layer, ax = acrossOf(L), al = alongOf(L);
  return B.vias.filter((v) => {
    if (v.net !== run.net || !otherSide(v, L) || Math.abs(v[ax] - run.c) > EPS) return false;
    const pad = padOf(v, L), reach = pad ? (al === "y" ? (pad[3] - pad[1]) / 2 : (pad[2] - pad[0]) / 2) : 0;
    return v[al] >= run.lo - reach - EPS && v[al] <= run.hi + reach + EPS;
  });
}
/** 비아 v 가 L 쪽에서 줄 말고 잇는 것이 있나 — 같은 점의 다른 비아(L 을 지나 쌓인 것), 셀의 도형 */
function heldOnL(B, near, v, L) {
  return B.vias.some((u) => u.id !== v.id && u.layer !== v.layer && u.net === v.net && samePoint(u, v) && viaLayers(u).includes(L)) ||
    sameNetBase(near, v.net, L, padOf(v, L)).length > 0;
}
/** 같은 넷 · 같은 층 · 같은 점의 비아 (배선기는 모듈을 합치며 같은 비아를 겹쳐 낸다) — 하나로 본다 */
const twinOf = (a, b) => a.id !== b.id && a.layer === b.layer && a.net === b.net && samePoint(a, b);

/**
 * 비아 v 의 O 층 쪽 금속이 옛 점(c)에서 새 점(c2)까지 닿게 한다. c · c2 는 O 가 뻗는 축의 좌표 (줄의 트랙).
 *   따라가기 — O 의 줄이 그 점에서 끝나고 같은 점에 다른 것(쌓인 비아 · 셀 도형)이 없으면, 줄의 끝을 같이 옮긴다. 안으로 당길 때는
 *              걷어 낼 자리에 다른 비아 · 셀 도형이 붙어 있지 않아야 하고, keepOld(옛 점의 비아가 남는다)면 당기지 않는다
 *   붙들기   — 아니면 O 층의 짧은 토막으로 잇는다 (이미 O 의 금속이 덮고 있으면 그대로)
 */
function reachOnO(B, near, v, O, c, c2, keepOld, st) {
  const L = otherSide(v, O), ax = acrossOf(O), al = alongOf(O), P = { x: v.x, y: v.y }, d = c2 - c;
  const padO = padOf(v, O);
  const reach = padO ? (al === "y" ? (padO[3] - padO[1]) / 2 : (padO[2] - padO[0]) / 2) : 0;
  const onTrack = B.wires.filter((w) => w.net === v.net && w.layer === O && Math.abs(trackOf(w) - P[ax]) <= EPS);
  const runs = [], seen = new Set();
  for (const w of onTrack) {
    const [lo, hi] = spanOf(w);
    if (seen.has(w.id) || P[al] < lo - reach || P[al] > hi + reach) continue;
    const r = runOf(B, w.id);
    r.ids.forEach((k) => seen.add(k));
    runs.push(r);
  }
  const stack = B.vias.some((u) => u.id !== v.id && u.layer !== v.layer && u.net === v.net && samePoint(u, P) && viaLayers(u).includes(O));
  if (runs.length === 1 && !stack && !sameNetBase(near, v.net, O, padO).length) {
    const R = runs[0], tolE = Math.max(reach, metal(L).pitch / 2);
    const dLo = Math.abs(c - R.lo), dHi = Math.abs(R.hi - c);
    const atLo = dLo <= tolE && dLo <= dHi, atHi = !atLo && dHi <= tolE;
    if (atLo || atHi) {
      const e = atLo ? R.lo : R.hi, e2 = e + d, outward = atLo ? d < 0 : d > 0;
      const ws = B.wires.filter((w) => R.ids.has(w.id));
      if (outward) {
        // 끝에 닿은 토막을 그만큼 늘인다
        for (const w of ws) {
          const [lo, hi] = spanOf(w);
          if (atLo && Math.abs(lo - e) <= EPS) put(B, withSpan(w, e2, hi));
          if (atHi && Math.abs(hi - e) <= EPS) put(B, withSpan(w, lo, e2));
        }
        st.followed++;
        return true;
      }
      // 안으로 — 걷어 낼 구간 (옛 끝에서 새 점 바로 앞까지)에 다른 것이 없고 새 점이 줄 안이면 끝을 당긴다
      const cut = atLo ? [R.lo, c2 - EPS] : [c2 + EPS, R.hi];
      const inside = atLo ? c2 < R.hi - EPS : c2 > R.lo + EPS;
      const others = B.vias.some((u) => u.id !== v.id && !twinOf(u, v) && u.net === v.net && viaLayers(u).includes(O) && Math.abs(u[ax] - P[ax]) <= EPS &&
        u[al] >= cut[0] - reach && u[al] <= cut[1]) || sameNetBase(near, v.net, O, spanRect(O, P[ax], atLo ? R.lo : e2, atLo ? e2 : R.hi)).length > 0;
      if (!keepOld && inside && !others) {
        for (const w of ws) {
          const [lo, hi] = spanOf(w), nlo = atLo ? Math.max(lo, e2) : lo, nhi = atLo ? hi : Math.min(hi, e2);
          if (nhi - nlo < EPS) drop(B, [w.id]);
          else if (nlo !== lo || nhi !== hi) put(B, withSpan(w, nlo, nhi));
        }
        st.followed++;
        return true;
      }
    }
  }
  // 붙들린다 — O 층으로 c -> c2 (이미 O 의 금속이 덮고 있으면 그대로)
  const lo = Math.min(c, c2), hi = Math.max(c, c2);
  if (!covers(onTrack, lo, hi)) { put(B, wireAt(v.net, O, P[ax], lo, hi, id(B))); st.jogs++; }
  return false;
}

/**
 * 비아가 그 자리를 떠날 때 — 그 비아의 O 층 쪽 금속이 O 의 두 토막 사이 틈을 메우고 있었으면(배선기가 그렇게 낸다) 그 자리를 같은
 * 넷의 짧은 토막으로 메워 둔다. 안 그러면 O 의 줄이 거기서 끊긴다.
 */
function keepBridge(B, v, O, st) {
  const ax = acrossOf(O), al = alongOf(O), pad = padOf(v, O);
  if (!pad) return;
  const [p0, p1] = al === "y" ? [pad[1], pad[3]] : [pad[0], pad[2]];
  const touching = B.wires.filter((w) => {
    if (w.net !== v.net || w.layer !== O || Math.abs(trackOf(w) - v[ax]) > EPS) return false;
    const [lo, hi] = spanOf(w);
    return lo <= p1 + EPS && hi >= p0 - EPS;
  });
  if (touching.length < 2) return;
  const lo = Math.min(...touching.map((w) => spanOf(w)[0])), hi = Math.max(...touching.map((w) => spanOf(w)[1]));
  if (covers(touching, lo, hi)) return;
  put(B, wireAt(v.net, O, v[ax], p0, p1, id(B)));
  st.jogs++;
}

/** 줄이 비아 없이 L 층에서 닿던 셀의 도형 — 그 위에서 이웃 층(T)으로 내려 새 트랙까지 짧은 토막으로 잇는다 */
function holdPins(B, near, run, origWires, c2, st, keptVias) {
  const L = run.layer, al = alongOf(L), T = above(L) ?? below(L), V = T && viaOf(L, T), seen = new Set();
  for (const w of origWires) {
    for (const s of sameNetBase(near, run.net, L, wireRect(w))) {
      const key = s.rect.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      if (keptVias.some((v) => touch(padOf(v, L), s.rect))) continue;          // 남은 비아가 그 핀 위에서 잇는다
      const sl = al === "y" ? [s.rect[1], s.rect[3]] : [s.rect[0], s.rect[2]];
      const ts = V ? tracksIn(T, Math.max(sl[0], run.lo), Math.min(sl[1], run.hi)) : [];
      if (!ts.length) { st.left.push(run.net); continue; }
      const a = ts[Math.floor(ts.length / 2)];
      put(B, { id: id(B), net: run.net, layer: V, ...pt(L, run.c, a) });
      put(B, { id: id(B), net: run.net, layer: V, ...pt(L, c2, a) });
      put(B, wireAt(run.net, T, a, Math.min(run.c, c2), Math.max(run.c, c2), id(B)));
      st.jogs++;
    }
  }
}

/** 판 위에서 줄 하나를 트랙 c2 로 (dragRun 의 속) */
function moveRun(B, near, run, c2, st) {
  const L = run.layer, ax = acrossOf(L), c = run.c;
  const orig = B.wires.filter((w) => run.ids.has(w.id));
  const vias = viasOnRun(B, run);
  for (const w of orig) { put(B, withTrack(w, c2)); st.moved++; }
  const kept = [], done = [];
  for (const v of vias) {
    const twin = done.find((u) => twinOf(u, v));
    if (twin) { if (!twin.keep) put(B, { ...v, [ax]: c2 }); continue; }      // 겹친 비아는 먼저 것을 따라간다
    const O = otherSide(v, L), keep = heldOnL(B, near, v, L);
    const followed = reachOnO(B, near, v, O, c, c2, keep, st);
    if (keep) { kept.push(v); put(B, { id: id(B), net: v.net, layer: v.layer, x: v.x, y: v.y, [ax]: c2 }); }
    else { if (!followed) keepBridge(B, v, O, st); put(B, { ...v, [ax]: c2 }); }
    done.push({ ...v, keep });
  }
  holdPins(B, near, run, orig, c2, st, kept);
}

/**
 * 곧은 줄을 그 층의 트랙 t (가장 가까운 트랙으로 붙인다) 로 옮긴다.
 * @returns {null | { add, del, next, moved, followed, jogs, left }}  left: 이어 두지 못한 셀 도형의 넷
 */
export function dragRun(art, near, run, t) {
  if (!run) return null;
  const c2 = snap(run.layer, t);
  if (Math.abs(c2 - run.c) < EPS) return null;
  const B = board(art), st = stats();
  moveRun(B, near, run, c2, st);
  dedupe(B, art);
  return { ...diff(art, B), ...st };
}

/** 토막 끝의 사정 — 비어 있나, 비아가 있나 (그 끝에서 반 트랙 안에 그 층의 비아) */
export function endInfo(art, near, w, which) {
  const L = w.layer, al = alongOf(L), ax = acrossOf(L);
  const e = (al === "y" ? [w.y0, w.y1] : [w.x0, w.x1])[which];
  const P = pt(L, trackOf(w), e), tolE = metal(L).pitch / 2;
  const viaHere = art.vias.find((v) => v.net === w.net && viaLayers(v).includes(L) && Math.abs(v[ax] - P[ax]) <= EPS && Math.abs(v[al] - e) <= tolE);
  if (viaHere) return { free: false, via: viaHere, at: P };
  const box = [P.x - EPS, P.y - EPS, P.x + EPS, P.y + EPS];
  const wireHere = art.wires.some((q) => q.id !== w.id && q.net === w.net && q.layer === L && touch(wireRect(q), box));
  return { free: !wireHere && !sameNetBase(near, w.net, L, box).length, via: null, at: P };
}

/** 빈 끝을 a 로 (이웃 층의 트랙에 붙인다 — 나중에 거기서 비아로 꺾을 수 있게) */
export function stretchEnd(art, near, wid, which, a) {
  const w = art.wires.find((q) => q.id === wid);
  if (!w) return null;
  const L = w.layer, T = above(L) ?? below(L), al = alongOf(L);
  const a2 = T ? snap(T, a) : Math.round(a);
  const ends = al === "y" ? [w.y0, w.y1] : [w.x0, w.x1];
  if (Math.abs(a2 - ends[which]) < EPS || Math.abs(a2 - ends[1 - which]) < EPS) return null;
  const B = board(art);
  put(B, { ...w, [al + which]: a2 });
  return { ...diff(art, B), ...stats(), moved: 1 };
}

/**
 * 비아(꺾는 점)를 p 로 — 그 점에서 만나는 두 줄을 각자의 트랙으로 옮긴다 (세로 층의 줄은 x 로, 가로 층의 줄은 y 로).
 * 한쪽에 줄이 없으면 (핀 위 · 쌓인 비아) 그 축으로는 안 움직인다.
 */
export function dragVia(art, near, vid, p) {
  const v0 = art.vias.find((v) => v.id === vid);
  if (!v0) return null;
  const B = board(art), st = stats();
  let pos = { x: v0.x, y: v0.y }, any = false;
  for (const L of viaLayers(v0)) {
    if (!metal(L)) continue;
    const ax = acrossOf(L), al = alongOf(L), target = snap(L, p[ax]);
    if (Math.abs(target - pos[ax]) < EPS) continue;
    const reach = metal(L).pitch / 2;
    const w = B.wires.find((q) => q.net === v0.net && q.layer === L && Math.abs(trackOf(q) - pos[ax]) <= EPS &&
      pos[al] >= spanOf(q)[0] - reach && pos[al] <= spanOf(q)[1] + reach);
    if (!w) continue;
    moveRun(B, near, runOf(B, w.id), target, st);
    pos = { ...pos, [ax]: target };
    any = true;
  }
  if (!any) return null;
  dedupe(B, art);
  return { ...diff(art, B), ...st, at: pos };
}

/** 고른 것을 한 트랙씩 (화살표 키) — 줄은 제 트랙을 가로질러서만, 비아는 그 방향의 층의 트랙으로 */
export function nudge(art, near, ids, dx, dy) {
  const B = board(art), st = stats(), seen = new Set();
  let any = false;
  for (const k of ids) {
    const v = B.vias.find((q) => q.id === k);
    if (v) {
      for (const L of viaLayers(v)) {
        if (!metal(L)) continue;
        const step = isV(L) ? dx : dy;
        if (!step) continue;
        const ax = acrossOf(L), al = alongOf(L), reach = metal(L).pitch / 2;
        const cur = B.vias.find((q) => q.id === k) ?? v;
        const w = B.wires.find((q) => q.net === v.net && q.layer === L && Math.abs(trackOf(q) - cur[ax]) <= EPS &&
          cur[al] >= spanOf(q)[0] - reach && cur[al] <= spanOf(q)[1] + reach);
        if (!w) continue;
        const run = runOf(B, w.id);
        moveRun(B, near, run, snap(L, run.c + step * metal(L).pitch), st);
        any = true;
      }
      continue;
    }
    const w = B.wires.find((q) => q.id === k);
    if (!w || !metal(w.layer)) continue;
    const step = isV(w.layer) ? dx : dy;
    if (!step) continue;
    const run = runOf(B, k), key = `${run.layer}|${run.net}|${run.c}|${run.lo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    moveRun(B, near, run, snap(run.layer, run.c + step * metal(run.layer).pitch), st);
    any = true;
  }
  if (!any) return null;
  dedupe(B, art);
  return { ...diff(art, B), ...st };
}

/** 같은 방향의 다른 층들 (li1 ↔ met2 ↔ met4, met1 ↔ met3) — 층 바꾸기가 갈 수 있는 곳 */
export function sameDirectionLayers(L) {
  const out = [];
  for (let k = 1; k <= 9; k++) { const M = `M${k}`; if (M !== L && metal(M) && metal(M).dir === metal(L).dir) out.push(M); }
  return out;
}

/** 판 위에서 줄 하나를 같은 방향의 층 L2 로 (changeLayer 의 속) */
function relayer(B, near, run, L2, st) {
  const L = run.layer, ax = acrossOf(L), al = alongOf(L), c = run.c, c2 = snap(L2, c);
  const orig = B.wires.filter((w) => run.ids.has(w.id));
  const vias = viasOnRun(B, run);
  for (const w of orig) { const n = { ...withTrack(w, c2), layer: L2 }; delete n.w; put(B, n); st.moved++; }   // 폭은 새 층의 폭
  const moved = () => B.wires.filter((w) => run.ids.has(w.id));
  const stackTo = (net, at, from, toward) => {
    const cl = climb(net, at, from, L2, toward);
    for (const w of cl.wires) put(B, { ...w, id: id(B) });
    for (const v of cl.vias) if (v) put(B, { ...v, id: id(B) });
    st.jogs += cl.wires.length;
    // 쌓는 길에 꺾였으면 마지막 비아가 줄 끝 너머에 설 수 있다 — 줄을 거기까지 늘인다
    const e = cl.at[al], ws = moved();
    if (!ws.length || ws.some((w) => { const [lo, hi] = spanOf(w); return e >= lo - EPS && e <= hi + EPS; })) return;
    const far = ws.reduce((b, w) => (Math.min(Math.abs(spanOf(w)[0] - e), Math.abs(spanOf(w)[1] - e)) < Math.min(Math.abs(spanOf(b)[0] - e), Math.abs(spanOf(b)[1] - e)) ? w : b));
    const [lo, hi] = spanOf(far);
    put(B, withSpan(far, Math.min(lo, e), Math.max(hi, e)));
  };
  const done = [];
  for (const v of vias) {
    const twin = done.find((u) => twinOf(u, v));
    if (twin) { if (!twin.keep) drop(B, [v.id]); continue; }
    const O = otherSide(v, L), keep = heldOnL(B, near, v, L);
    const followed = Math.abs(c2 - c) >= EPS && reachOnO(B, near, v, O, c, c2, keep, st);
    if (!keep) { if (!followed) keepBridge(B, v, O, st); drop(B, [v.id]); }
    stackTo(v.net, { x: v.x, y: v.y, [ax]: c2 }, O, { x: v.x, y: v.y, [ax]: c2 });
    done.push({ ...v, keep });
  }
  // 같은 층에서 닿던 셀의 도형 — 그 위에서 L2 까지 쌓는다
  const T = above(L) ?? below(L), seen = new Set();
  for (const w of orig) {
    for (const s of sameNetBase(near, run.net, L, wireRect(w))) {
      const key = s.rect.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      const sl = al === "y" ? [s.rect[1], s.rect[3]] : [s.rect[0], s.rect[2]];
      const ts = T ? tracksIn(T, Math.max(sl[0], run.lo), Math.min(sl[1], run.hi)) : [];
      if (!ts.length) { st.left.push(run.net); continue; }
      const a = ts[Math.floor(ts.length / 2)];
      stackTo(run.net, pt(L, c, a), L, pt(L, c2, a));
    }
  }
}

/**
 * 곧은 줄을 같은 방향의 층 L2 로 — 트랙은 L2 의 가장 가까운 트랙, 붙은 곳마다 그 자리의 층에서 L2 까지 비아를 쌓는다.
 * 쌓는 길에 트랙이 그 점을 안 지나면 가장 가까운 트랙까지 짧게 꺾는다 (draw.climb).
 */
export function changeLayer(art, near, run, L2) {
  if (!run || !metal(L2) || L2 === run.layer || metal(L2).dir !== metal(run.layer).dir) return null;
  const B = board(art), st = stats();
  relayer(B, near, run, L2, st);
  dedupe(B, art);
  return { ...diff(art, B), ...st };
}

/** 고른 토막들(의 줄)을 L2 로 */
export function changeLayerOf(art, near, ids, L2) {
  const B = board(art), st = stats(), seen = new Set();
  let any = false;
  for (const k of ids) {
    if (!B.wires.some((w) => w.id === k)) continue;
    const run = runOf(B, k);
    if (!run || run.layer === L2 || !metal(L2) || metal(L2).dir !== metal(run.layer).dir) continue;
    const key = `${run.layer}|${run.net}|${run.c}|${run.lo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    relayer(B, near, run, L2, st);
    any = true;
  }
  if (!any) return null;
  dedupe(B, art);
  return { ...diff(art, B), ...st };
}
