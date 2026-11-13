/** 검사와 GDS — 셀(바탕)과 그린 것을 합쳐 ALIGN 검사기로 DRC/LVS 를 보고, GDS 를 쓴다.
 *
 *  배선기 결과를 검사할 때와 같은 잣대다 (route/pipeline.mjs 의 checkModule): 블록 도형 다음에 배선 도형, 같은 넷이 같은
 *  트랙에서 끝단 간격보다 좁게 떨어지면 메운다 (healSameNetGaps), 맨 위라 색을 칠한다. 다른 점은 계층이 없다는 것 하나 —
 *  하위 모듈까지 펼쳐 한 판으로 본다 (손으로 그린 판이 그렇다).
 */
import { composeModule } from "../route/compose.mjs";
import { check, checkerRules, errorLines, healSameNetGaps } from "../route/check.mjs";
import { topGds } from "../route/gds.mjs";
import { PDK } from "../pdk/pdk.mjs";

const rules = checkerRules(PDK);
const metalOrVia = (w) => /^(M|V)\d+$/.test(w.layer);

/**
 * @param {ReturnType<import("./base.mjs").composeBase>} base
 * @param {Array<{layer, rect, netName}>} drawn   doc.shapesOf(art, base)
 * @returns {{ errors: string[], notes: string[], terminals: Array, bbox: number[] }}
 */
export function checkArt(base, drawn) {
  const wires = drawn.map((s) => ({ netName: s.netName, layer: s.layer, rect: s.rect.slice() }));
  const comp = composeModule({ blocks: base.blocks, faMap: base.faMap, powerNets: base.powerNets, wires });
  healSameNetGaps(comp.terminals, rules);
  const res = check(comp.terminals, rules, { netsAllowedToBeOpen: [], postprocess: true, subinsts: comp.subinsts });
  const hard = { ...res, differentWidths: res.differentWidths.filter(metalOrVia) };
  const notes = res.differentWidths.filter((w) => !metalOrVia(w)).map((w) => w.msg.replace(/:$/, ""));
  return { errors: errorLines(hard, []), notes, terminals: res.terminals, bbox: base.bbox.slice() };
}

/** 검사한 판의 GDS (바이트) */
export function gdsArt(checked, name, time) {
  return topGds({ name, terminals: checked.terminals, bbox: checked.bbox, time }, PDK);
}

/** 검사기 오류 줄에서 사각형들 (표식) — "[x0, y0, x1, y1]" 꼴을 다 줍는다 */
export function errorRects(line) {
  const out = [];
  for (const m of line.matchAll(/\[(-?\d+), (-?\d+), (-?\d+), (-?\d+)\]/g)) out.push(m.slice(1, 5).map(Number));
  return out;
}
