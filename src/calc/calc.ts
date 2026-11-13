/**
 * 계산기를 한 덩어리로 내보낸다 — 앱은 이것을 **필요할 때** 받는다 (dynamic import).
 *
 * 계산기는 실행 결과가 있어야 쓸모가 있다. 함수 표 · 성능지표 본보기 · 스펙트럼 계산까지 합쳐
 * 첫 화면 JS 의 1/3 쯤 되는데, 회로도를 그리러 온 사람이 그것을 먼저 받을 까닭이 없다. 계산기 탭을
 * 열거나, 계산기 줄이 있는 프로젝트를 돌릴 때 받는다 (spice.wasm 을 실행을 누를 때 받는 것과 같다).
 *
 * 앱이 타입만 쓰는 것(RunData · CalcHost · Names)은 여기를 거치지 않는다 — 타입은 번들에 남지 않는다.
 */
import { CATEGORIES, FUNCTIONS } from "./funcs.ts";

export { calcSaves, describe, evaluateRows, runFromTraces } from "./eval.ts";
export { parseDevices } from "./devices.ts";
export { buildCalcHelp, calcInvalidate, calcReset, closePop, renderCalc } from "../ui/calc-panel.ts";
// 그래프도 여기로 온다. 계산기 탭 말고는 파형 탭의 잡음 스펙트럼만 쓰는데, 그것도 잡음 해석을 돌린 뒤의 일이다
export { mountPlot } from "../ui/plot.ts";

/**
 * 함수 목록을 글로 — 어시스턴트가 읽는다 (src/ai/ 의 calc_reference). 도움말 창(buildCalcHelp)과
 * 같은 표에서 만든다. 분류를 주면 그것만 (대소문자 무관).
 */
export function referenceText(category?: string): string {
  const want = category?.trim().toLowerCase();
  const cats = want ? CATEGORIES.filter(c => c.toLowerCase() === want || c.toLowerCase().startsWith(want)) : CATEGORIES;
  if (!cats.length) return `No category "${category}". Categories: ${CATEGORIES.join(", ")}.`;
  return cats.map(c => `## ${c}\n` + FUNCTIONS.filter(f => f.cat === c).map(f => `${f.name}(${f.sig}) — ${f.doc}`).join("\n")).join("\n\n");
}
