/** 자동 배선의 결과를 그린 것으로 — 배선기가 낸 금속 · 비아를 손으로 그린 것과 같은 토막 · 비아로 바꾼다.
 *
 *  배선기는 모듈마다(하위 모듈 먼저) 배선하고, 부모는 하위 모듈의 결과를 블록 도형으로 받는다 (route/pipeline.mjs).
 *  여기서는 같은 차례로 합성하되 리프 셀의 도형은 뺀다 — 셀은 바탕(base.mjs)이 낸다. 그러면 맨 위 좌표 · 맨 위 넷 이름의
 *  배선만 남는다 (하위 모듈 안의 배선까지).
 *
 *    금속 사각형 -> wire (중심선 두 끝, 폭이 층의 폭과 다르면 w)
 *    비아 컷     -> via (가운데 점). 그 비아가 내는 아래 · 위 금속과 같거나 그 안에 드는 금속 사각형은 버린다
 */
import { viewerBlocks, viewerFaMap, viewerWires } from "../route/align/wires.mjs";
import { composeModule } from "../route/compose.mjs";
import { metal, via, viaShapes, wireRect } from "./rules.mjs";
import { DRC, viaAt } from "../edit/wires.mjs";

const RESULTS = /^(\.\/|)Results\/(\S+)\.gds$/;

/** 배선 세션 -> 맨 위 좌표의 배선 도형 [{ layer, rect, netName }] */
export function routedShapes(session) {
  const outs = new Map();
  let top = null;
  for (const m of session.res.modules) {
    const node = m.node, power = new Set(node.PowerNets.map((n) => n.name));
    const blocks = [];
    for (const b of viewerBlocks(node)) {
      if (b.isLeaf) continue;
      const mm = RESULTS.exec(b.gdsFile ?? ""), sub = mm && outs.get(mm[2]);
      if (!sub) throw new Error(`${node.name}: no wires for sub-module block ${b.name}`);
      blocks.push({ name: b.name, tr: b.tr, terminals: sub });
    }
    const comp = composeModule({ blocks, faMap: viewerFaMap(node), powerNets: power, wires: viewerWires(node) });
    outs.set(`${m.name}_${m.sel}`, comp.terminals);
    if (m.isTop) top = comp.terminals;
  }
  if (!top) throw new Error("the routing has no top module");
  return top;
}

const inside = (a, b) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];

/** 배선 도형 -> { wires, vias } (id 없이 — doc.apply 가 붙인다). 모르는 층(그릴 수 없는 층)은 others 로 */
export function shapesToArt(shapes) {
  const vias = [], wires = [], others = [];
  for (const s of shapes) {
    if (!via(s.layer)) continue;
    vias.push({ net: s.netName, layer: s.layer, x: (s.rect[0] + s.rect[2]) / 2, y: (s.rect[1] + s.rect[3]) / 2 });
  }
  const pads = new Map();        // 층|넷 -> [사각형]
  for (const v of vias) for (const sh of viaShapes(v)) {
    if (sh.role === "cut") continue;
    const k = `${sh.layer}|${v.net}`;
    (pads.get(k) ?? pads.set(k, []).get(k)).push(sh.rect);
  }
  for (const s of shapes) {
    if (via(s.layer)) continue;
    const m = metal(s.layer);
    if (!m) { others.push(s); continue; }
    if ((pads.get(`${s.layer}|${s.netName}`) ?? []).some((r) => inside(s.rect, r))) continue;
    const r = s.rect;
    const w = m.dir === "v"
      ? { net: s.netName, layer: s.layer, x0: (r[0] + r[2]) / 2, y0: r[1], x1: (r[0] + r[2]) / 2, y1: r[3], w: r[2] - r[0] }
      : { net: s.netName, layer: s.layer, x0: r[0], y0: (r[1] + r[3]) / 2, x1: r[2], y1: (r[1] + r[3]) / 2, w: r[3] - r[1] };
    if (w.w === m.width) delete w.w;
    wires.push(w);
  }
  return { wires, vias, others };
}

// ---------------------------------------------------------------- 그린 것 -> 배선기의 고정 넷

const metalIdx = new Map(DRC.Metal_info.map((m, i) => [m.name, i]));
const viaIdx = new Map(DRC.Via_model.map((v, i) => [v.name, i]));
const box0 = () => ({ LL: { x: 0, y: 0 }, UR: { x: 0, y: 0 } });

/**
 * 손으로 다 이은 넷을 배선기에 고정으로 넘길 모양 [{ net, path_metal, path_via }] — PnRDB 단위(nm 의 2 배).
 * 배선기는 그 넷을 다시 배선하지 않고 그 도형을 장애물로 본다 (route/pipeline.mjs 의 freezeNets).
 */
export function frozenPaths(art, nets) {
  const out = [];
  for (const net of nets) {
    const path_metal = art.wires.filter((w) => w.net === net).map((w) => {
      const r = wireRect(w).map((v) => Math.round(2 * v)), vert = metal(w.layer).dir === "v";       // 배선기는 정수만 받는다
      return {
        MetalIdx: metalIdx.get(w.layer), width: 2 * (w.w ?? metal(w.layer).width),
        LinePoint: (vert ? [{ x: w.x0, y: Math.min(w.y0, w.y1) }, { x: w.x0, y: Math.max(w.y0, w.y1) }]
                         : [{ x: Math.min(w.x0, w.x1), y: w.y0 }, { x: Math.max(w.x0, w.x1), y: w.y0 }]).map((q) => ({ x: Math.round(2 * q.x), y: Math.round(2 * q.y) })),
        MetalRect: { metal: w.layer, originBox: box0(), originCenter: { x: 0, y: 0 },
                     placedBox: { LL: { x: r[0], y: r[1] }, UR: { x: r[2], y: r[3] } },
                     placedCenter: { x: Math.trunc((r[0] + r[2]) / 2), y: Math.trunc((r[1] + r[3]) / 2) } },
      };
    });
    const path_via = art.vias.filter((v) => v.net === net && viaIdx.has(v.layer)).map((v) => viaAt(viaIdx.get(v.layer), Math.round(2 * v.x), Math.round(2 * v.y), DRC));
    if (path_metal.length || path_via.length) out.push({ net, path_metal, path_via });
  }
  return out;
}
