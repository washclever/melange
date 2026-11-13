/** 트랙 그리기의 셈 — PCB 편집기의 트랙 도구처럼: 핀에서 시작해 커서를 따라 L 자로 긋고, 누르면 꺾는 자리가 정해진다.
 *
 *  IC 금속은 층마다 방향이 하나라(rules.mjs) L 의 두 토막은 두 층에 놓인다: 지금 층(A)의 방향으로 긋는 토막은 A 에, 수직
 *  토막은 짝 층(B — 방향이 다른 이웃, partner)에, 꺾는 점에 비아. PCB 에서 층을 바꾸면 비아가 생기는 것과 같은 모양이다.
 *
 *    시작     커서 아래의 넷 도형(핀 · 그린 토막 · 비아)에서. 그 도형이 A 가 아니면 그 자리에서 A 까지 비아를 쌓는다
 *    L        firstA = true 면 A 토막 다음 B 토막, false 면 B 먼저 (Space 로 바꾼다). 커서가 A 의 트랙 위면 곧은 토막 하나
 *    점       모든 점은 두 층의 트랙이 만나는 곳 — 거기에 비아가 선다. 꺾는 점의 좌표는 커서를 각 층의 트랙에 붙인 것
 *    붙기     커서가 같은 넷의 도형 위면 끝을 그 도형의 중심선 위에 둔다 — 층이 다르면 끝에 비아를 쌓는다
 *    단락     다른 넷의 금속에 닿으면 그을 수 없다 (short). 끝단 간격 · 비아 간격은 경고만 (warn) — 마지막 판정은 검사기다
 *
 *  좌표 nm. 결과의 wires / vias 에는 id 가 없다 (doc.apply 가 붙인다).
 */
import { metal, via, viaOf, above, below, snap, tracksIn, wireRect, viaShapes, viaFits, touch } from "./rules.mjs";

/** 짝 층 — 핀이 있는 met1 · met2 와 그 위 met3 을 오가게: li1-met1, met1-met2, met2-met3, met3-met2, met4-met3 */
export function partner(layer) {
  const m = metal(layer);
  if (!m) return null;
  if (layer === "M4") return below("M4");
  return above(layer) ?? below(layer);
}

const along = (layer) => (metal(layer).dir === "v" ? "y" : "x");
const across = (layer) => (metal(layer).dir === "v" ? "x" : "y");

/** 한 층 위의 토막 (두 점이 그 층의 방향으로 늘어서야 한다) */
function wireOn(layer, net, a, b) {
  if (a.x === b.x && a.y === b.y) return null;
  return { net, layer, x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}
function viaAt(a, b, net, p) {
  const v = viaOf(a, b);
  return v ? { net, layer: v, x: p.x, y: p.y } : null;
}

/**
 * from 층의 점 p 에서 to 층까지 비아를 쌓는다 (한 층씩). 다음 층의 트랙이 p 를 지나지 않으면 지금 층에서 가장 가까운
 * 트랙까지 짧게 긋고 쌓는다 (toward 쪽으로). -> { wires, vias, at }
 */
export function climb(net, p, from, to, toward = p) {
  const wires = [], vias = [];
  let cur = from, at = { ...p };
  while (cur !== to) {
    const next = metal(to).k > metal(cur).k ? above(cur) : below(cur);
    if (!next) break;
    // next 층의 트랙은 next 의 방향과 나란한 줄 — 그 줄의 좌표는 next 의 across 축이다
    const ax = across(next), want = snap(next, toward[ax]);
    const t = at[ax] === snap(next, at[ax]) ? at[ax] : nearestToward(next, at[ax], want);
    if (t !== at[ax]) {
      const q = { ...at, [ax]: t };
      const w = wireOn(cur, net, at, q);
      if (w) wires.push(w);
      at = q;
    }
    vias.push(viaAt(cur, next, net, at));
    cur = next;
  }
  return { wires, vias, at };
}
function nearestToward(layer, v, want) {
  const a = snap(layer, v);
  if (a === v) return v;
  return want >= v ? Math.max(a, v) === a ? a : a + metal(layer).pitch : Math.min(a, v) === a ? a : a - metal(layer).pitch;
}

/**
 * 시작점 — 커서 아래의 도형 hit({layer, rect, netName}) 에서 층 짝 (layer, other) 으로 그을 수 있는 점.
 * -> { net, at, pre: {wires, vias} } | { error }
 */
export function startOn(hit, cursor, layer, other = partner(layer)) {
  if (!hit?.netName) return { error: "Start on a pin, a track or a via." };
  if (!metal(hit.layer)) return { error: `${hit.layer} is not a routing layer.` };
  // 도형의 중심선 위, 커서에 가까운 곳. 그 자리에 설 것(같은 층이면 짝 층, 아니면 지금 층)의 트랙에 붙인다
  const r = hit.rect, ax = across(hit.layer), al = along(hit.layer);
  const center = ax === "x" ? (r[0] + r[2]) / 2 : (r[1] + r[3]) / 2;
  const lo = al === "x" ? r[0] : r[1], hi = al === "x" ? r[2] : r[3];
  const guide = hit.layer === layer ? other : layer;
  const ticks = guide && across(guide) === al ? tracksIn(guide, lo, hi) : [];
  const want = cursor[al];
  // 트랙이 도형 안을 안 지나면 (짧은 핀) 커서 자리 — 좌표는 늘 nm 정수 (배선기가 정수만 받는다)
  const t = ticks.length ? ticks.reduce((b, v) => (Math.abs(v - want) < Math.abs(b - want) ? v : b)) : Math.round(Math.max(lo, Math.min(hi, want)));
  const at = { [ax]: center, [al]: t };
  if (hit.layer === layer) return { net: hit.netName, at, pre: { wires: [], vias: [] } };
  const c = climb(hit.netName, at, hit.layer, layer, cursor);
  return { net: hit.netName, at: c.at, pre: { wires: c.wires, vias: c.vias } };
}

/** 끝을 붙일 수 있는 도형인가 — 짝 층(A · B)이거나 그 이웃이면. 어느 층으로 끝내는지 (finish) */
export function finishFor(target, A, B) {
  if (!target || !metal(target.layer)) return null;
  if (target.layer === A || target.layer === B) return target.layer;
  if (viaOf(target.layer, A)) return A;
  if (B && viaOf(target.layer, B)) return B;
  return null;
}

/**
 * L 자 한 번 — 점 p(층 A)에서 커서 c 쪽으로, 짝 층 B 와 함께.
 * o.firstA   A 토막이 먼저 (기본). false 면 B 토막 먼저 (Space)
 * o.target   같은 넷의 도형 { layer, rect } — 끝을 그 위에 둔다 (finishFor 가 받는 것만)
 * -> { wires, vias, end: {x, y}, layer: 끝 층, joined: target 에 닿았나 }
 */
export function planL(net, p, A, B, c, { firstA = true, target = null } = {}) {
  const aA = along(A), xA = across(A);                         // A 의 진행 축, A 의 트랙 축 (B 의 진행 축)
  const finish = finishFor(target, A, B);
  const g = {};
  if (finish) {
    // 끝: 도형의 중심선 위, 끝 층의 트랙이 도형을 가로지르는 곳 (같은 층이면 중심선을 따라 커서에 가까운 곳)
    const r = target.rect, tx = across(target.layer), ta = along(target.layer);
    const center = tx === "x" ? (r[0] + r[2]) / 2 : (r[1] + r[3]) / 2;
    const lo = ta === "x" ? r[0] : r[1], hi = ta === "x" ? r[2] : r[3];
    g[tx] = center;
    if (finish === target.layer) {
      // 같은 층으로 이어 붙인다: 지금 점이 이미 도형의 범위 안이면 그 자리에서 (비아 하나로), 아니면 커서 쪽 끝으로
      const other = finish === A ? B : A;
      g[ta] = p[ta] >= lo && p[ta] <= hi ? p[ta] : other ? clampTrack(other, c[ta], lo, hi) : Math.round(Math.max(lo, Math.min(hi, c[ta])));
    } else g[ta] = clampTrack(finish, c[ta], lo, hi);
  } else {
    g[xA] = snap(A, c[xA]);
    g[aA] = B ? snap(B, c[aA]) : Math.round(c[aA]);
  }
  const wires = [], vias = [];
  const push = (w) => { if (w) wires.push(w); };
  let first = firstA;
  if (finish === B && g[xA] !== p[xA]) first = true;                     // B 로 끝내려면 A 먼저
  if (finish === A && g[xA] !== p[xA]) first = false;                    // A 로 끝내려면 B 먼저
  let last = A;
  if (!B || g[xA] === p[xA]) {
    push(wireOn(A, net, p, { ...p, [aA]: g[aA] }));                   // 곧은 토막 (A 의 트랙 위)
  } else if (first) {
    const k = { ...p, [aA]: g[aA] };
    push(wireOn(A, net, p, k));
    vias.push(viaAt(A, B, net, k));
    push(wireOn(B, net, k, { ...k, [xA]: g[xA] }));
    last = B;
  } else {
    vias.push(viaAt(A, B, net, p));
    const k = { ...p, [xA]: g[xA] };
    push(wireOn(B, net, p, k));
    vias.push(viaAt(B, A, net, k));
    push(wireOn(A, net, k, { ...k, [aA]: g[aA] }));
  }
  const end = { x: g.x, y: g.y };
  let joined = false;
  if (finish) {
    if (target.layer !== last) {
      const v = viaAt(last, target.layer, net, end);
      if (v) { vias.push(v); last = target.layer; }
      else if (finish !== last) { vias.push(viaAt(last, finish, net, end)); const v2 = viaAt(finish, target.layer, net, end); if (v2) { vias.push(v2); last = target.layer; } }
    }
    joined = last === target.layer;
  }
  return { wires, vias: vias.filter(Boolean), end, layer: last, joined };
}
function clampTrack(layer, v, lo, hi) {
  const ts = tracksIn(layer, lo, hi);
  if (!ts.length) return Math.round(Math.max(lo, Math.min(hi, v)));
  return ts.reduce((b, t) => (Math.abs(t - v) < Math.abs(b - v) ? t : b));
}

/** 그린 것의 사각형 (검사용) */
export function shapesOfPlan(plan) {
  const out = [];
  for (const w of plan.wires) out.push({ layer: w.layer, rect: wireRect(w), netName: w.net });
  for (const v of plan.vias) for (const s of viaShapes(v)) out.push({ layer: s.layer, rect: s.rect, netName: v.net, role: s.role });
  return out;
}

/**
 * 그을 수 있나 — 다른 넷의 금속에 닿으면 단락 (막는다), 같은 트랙의 다른 넷과 끝이 EndToEnd 보다 가깝거나 비아끼리 너무
 * 가까우면 경고. index: (layer, rect) -> 근처 도형 [{layer, rect, netName}]
 */
export function judge(plan, index) {
  const shorts = [], warns = [];
  for (const s of shapesOfPlan(plan)) {
    const m = metal(s.layer), V = via(s.layer);
    const pad = m ? m.e2e : V ? Math.max(V.sx, V.sy) : 0;
    const box = [s.rect[0] - pad, s.rect[1] - pad, s.rect[2] + pad, s.rect[3] + pad];
    for (const o of index(s.layer, box)) {
      if (o.netName === s.netName) continue;
      if (touch(o.rect, s.rect)) { if (m) shorts.push({ layer: s.layer, rect: o.rect, net: o.netName }); continue; }
      if (m) {
        // 같은 트랙(중심선이 같다)에서 끝끼리
        const ax = m.dir === "v" ? 0 : 1;
        const c1 = (s.rect[ax] + s.rect[ax + 2]) / 2, c2 = (o.rect[ax] + o.rect[ax + 2]) / 2;
        if (c1 === c2) warns.push({ layer: s.layer, rect: o.rect, net: o.netName, what: "end-to-end" });
      } else if (V) {
        const dx = Math.max(o.rect[0] - s.rect[2], s.rect[0] - o.rect[2]), dy = Math.max(o.rect[1] - s.rect[3], s.rect[1] - o.rect[3]);
        if (dx < V.sx && dy < V.sy) warns.push({ layer: s.layer, rect: o.rect, net: o.netName, what: "via spacing" });
      }
    }
  }
  return { shorts, warns };
}

/** 비아가 이 점에 서나 (그리기 도중 층 바꾸기) */
export const fits = (a, b, p) => { const v = viaOf(a, b); return !!v && viaFits(v, p.x, p.y); };
