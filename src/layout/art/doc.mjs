/** 그린 것 — 배선 토막(wire)과 비아(via). PCB 편집기의 트랙 · 비아와 같다: 손으로 긋고, 고르고, 지운다.
 *
 *    wire  { id, net, layer, x0, y0, x1, y1, w? }   중심선 두 끝 (세로 층은 x0 = x1, 가로 층은 y0 = y1), 폭은 층의 폭
 *    via   { id, net, layer, x, y }                 Vk 하나 — 컷과 위아래 금속은 rules.viaShapes 가 낸다
 *
 *  자동 배선의 결과도 이 모양으로 들어온다 (import.mjs) — 손으로 그린 것과 똑같이 고치고 지운다.
 *  고칠 때마다 이력에 한 칸: 한 번의 그리기(여러 토막과 비아), 지우기, 자동 배선 한 판. 되돌리기는 그 칸을 통째로.
 *
 *  shapesOf(art, base) 가 검사기 · GDS · 연결 셈이 읽는 사각형을 낸다. 비아의 착지 패드가 같은 넷의 다른 금속과
 *  이어지지 않아 MinL 보다 짧으면 비아를 가운데 두고 MinL 까지 늘린다 (배선기가 비아를 쌓을 때와 같다).
 */
import { metal, wireRect, viaShapes, touch } from "./rules.mjs";

export function createArt() {
  return { wires: [], vias: [], next: 1, hist: [], fut: [], ver: 0 };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

/** 바꾸기 한 칸 — add: 더할 것 {wires, vias}, del: 지울 id 들. 이력에 남기고 판을 올린다 */
export function apply(art, { add = {}, del = [] }, label = "edit") {
  const gone = new Set(del);
  const removed = { wires: art.wires.filter((w) => gone.has(w.id)), vias: art.vias.filter((v) => gone.has(v.id)) };
  const added = { wires: (add.wires ?? []).map((w) => ({ ...w, id: w.id ?? art.next++ })),
                  vias: (add.vias ?? []).map((v) => ({ ...v, id: v.id ?? art.next++ })) };
  if (!removed.wires.length && !removed.vias.length && !added.wires.length && !added.vias.length) return null;
  // 고치기(edit.mjs)는 새 토막 · 비아에 번호를 미리 붙여 온다 — 다음 번호가 그것과 겹치지 않게
  for (const o of [...added.wires, ...added.vias]) if (typeof o.id === "number" && o.id >= art.next) art.next = o.id + 1;
  art.wires = art.wires.filter((w) => !gone.has(w.id)).concat(added.wires);
  art.vias = art.vias.filter((v) => !gone.has(v.id)).concat(added.vias);
  art.hist.push({ label, added: clone(added), removed: clone(removed) });
  art.fut.length = 0;
  art.ver++;
  return { added, removed };
}

function swap(art, step, back) {
  const out = back ? step.removed : step.added, gone = new Set([...(back ? step.added : step.removed).wires, ...(back ? step.added : step.removed).vias].map((o) => o.id));
  art.wires = art.wires.filter((w) => !gone.has(w.id)).concat(clone(out.wires));
  art.vias = art.vias.filter((v) => !gone.has(v.id)).concat(clone(out.vias));
  art.ver++;
}
export function undo(art) {
  const s = art.hist.pop();
  if (!s) return null;
  swap(art, s, true);
  art.fut.push(s);
  return s.label;
}
export function redo(art) {
  const s = art.fut.pop();
  if (!s) return null;
  swap(art, s, false);
  art.hist.push(s);
  return s.label;
}

/** 다 지운다 (이력에 한 칸) */
export function clearAll(art, label = "clear") {
  return apply(art, { del: [...art.wires.map((w) => w.id), ...art.vias.map((v) => v.id)] }, label);
}

/** 저장할 것 — 이력은 빼고 */
export const artJson = (art) => ({ wires: clone(art.wires), vias: clone(art.vias), next: art.next });
export function artFrom(j) {
  const a = createArt();
  a.wires = clone(j?.wires ?? []); a.vias = clone(j?.vias ?? []);
  a.next = Math.max(j?.next ?? 1, 1 + Math.max(0, ...a.wires.map((w) => w.id), ...a.vias.map((v) => v.id)));
  return a;
}

/**
 * 검사기 · GDS · 연결 셈이 읽는 사각형 [{ layer, rect, netName, netType: "drawing", id, role }].
 * role: "wire" | "cut" | "lo" | "hi" (비아의 아래 · 위 금속). base 를 주면 착지 패드가 바탕의 같은 넷 금속에 닿는지도 본다.
 */
export function shapesOf(art, base = null) {
  const out = [];
  for (const w of art.wires) out.push({ layer: w.layer, rect: wireRect(w), netName: w.net, netType: "drawing", id: w.id, role: "wire" });
  const pads = [];
  for (const v of art.vias) {
    for (const s of viaShapes(v)) {
      const t = { layer: s.layer, rect: s.rect, netName: v.net, netType: "drawing", id: v.id, role: s.role };
      out.push(t);
      if (s.role !== "cut") pads.push(t);
    }
  }
  // MinL: 같은 넷 · 같은 층 · 같은 트랙에서 패드와 이어진 금속을 모아 길이를 재고, 모자라면 패드를 늘린다
  const metalSame = (t) => {
    const m = metal(t.layer), list = out.filter((u) => u !== t && u.layer === t.layer && u.netName === t.netName && u.role !== "cut");
    if (base) for (const b of base.byLayer?.get(t.layer) ?? []) if (b.netName === t.netName) list.push(b);
    const c = m.dir === "v" ? (t.rect[0] + t.rect[2]) / 2 : (t.rect[1] + t.rect[3]) / 2;
    return list.filter((u) => (m.dir === "v" ? (u.rect[0] + u.rect[2]) / 2 : (u.rect[1] + u.rect[3]) / 2) === c);
  };
  for (const p of pads) {
    const m = metal(p.layer);
    if (!m || !m.minL) continue;
    const ax = m.dir === "v" ? 1 : 0;
    let lo = p.rect[ax], hiE = p.rect[ax + 2];
    // 이어진 것까지 넓힌다 (닿는 것을 따라)
    const same = metalSame(p);
    for (let grew = true; grew;) {
      grew = false;
      for (const u of same) {
        if (u.rect[ax] <= hiE && u.rect[ax + 2] >= lo && (u.rect[ax] < lo || u.rect[ax + 2] > hiE)) {
          lo = Math.min(lo, u.rect[ax]); hiE = Math.max(hiE, u.rect[ax + 2]); grew = true;
        }
      }
    }
    if (hiE - lo >= m.minL) continue;
    const mid = (p.rect[ax] + p.rect[ax + 2]) / 2, half = Math.ceil(m.minL / 2);
    p.rect = p.rect.slice();
    p.rect[ax] = Math.min(p.rect[ax], mid - half);
    p.rect[ax + 2] = Math.max(p.rect[ax + 2], mid + half);
  }
  return out;
}

/** id 로 찾기 */
export const wireById = (art, id) => art.wires.find((w) => w.id === id) ?? null;
export const viaById = (art, id) => art.vias.find((v) => v.id === id) ?? null;

/** 사각형에 닿는 그린 것 */
export function hitArt(art, layer, rect) {
  const out = [];
  for (const s of shapesOf(art)) if (s.layer === layer && touch(s.rect, rect)) out.push(s);
  return out;
}
