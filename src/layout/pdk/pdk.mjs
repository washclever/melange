/** 공정 — 레이아웃 흐름 전체가 보는 PDK 하나와, 거기서 나오는 값들.
 *
 *  앞단(셀 그리기)·배치기(격자)·배선기·검사기·GDS·편집기가 모두 여기서 PDK 를 받는다. 다른 공정을 쓰려면 PDK 를
 *  바꾸면 된다 — 같은 모양(ALIGN 의 layers.json)이면 나머지는 그대로 돈다.
 *
 *    PDK            지금 공정 (SKY130)
 *    placeGrid()    배치 격자 [x, y] — 블록 원점이 이 배수에 앉아야 배선기가 받는다 (첫 세로 금속과 첫 가로 금속의 피치)
 *    layerName(l)   ALIGN 층 이름 -> 실제 공정의 층 이름 (화면에 보이는 것: M2 -> met1)
 */
import { SKY130 } from "./sky130.mjs";

export const PDK = SKY130;

const metals = () => PDK.Abstraction.filter((l) => /^M\d+$/.test(l.Layer));

/** 배치 격자 — 첫 세로 금속(x)과 첫 가로 금속(y)의 피치. SKY130 은 [430, 420] (FinFET 모의 PDK 는 [80, 84]) */
export function placeGrid(pdk = PDK) {
  return placeGridLayers(pdk).map((n) => pdk.Abstraction.find((l) => l.Layer === n).Pitch);
}

/** 배치 격자를 정하는 두 금속의 ALIGN 이름 [x, y] (SKY130: M1 = li1, M2 = met1) */
export function placeGridLayers(pdk = PDK) {
  const ms = pdk.Abstraction.filter((l) => /^M\d+$/.test(l.Layer));
  return [ms.find((l) => l.Direction === "V").Layer, ms.find((l) => l.Direction === "H").Layer];
}

/** SKY130 의 실제 층 이름 (GDS 번호로) — 화면과 내보내기에 쓴다. 모르는 층은 ALIGN 이름 그대로 */
const SKY_NAMES = new Map([
  ["66/20", "poly"], ["65/20", "diff"], ["65/44", "tap"], ["64/20", "nwell"], ["93/44", "nsdm"], ["94/20", "psdm"],
  ["95/20", "npc"], ["125/44", "lvtn"], ["66/44", "licon1"], ["67/20", "li1"], ["67/44", "mcon"], ["68/20", "met1"],
  ["68/44", "via"], ["69/20", "met2"], ["69/44", "via2"], ["70/20", "met3"], ["70/44", "via3"], ["71/20", "met4"],
  ["71/44", "via4"], ["72/20", "met5"], ["89/44", "capm"],
]);
const byLayer = new Map(PDK.Abstraction.map((l) => [l.Layer, l]));
export function layerName(layer) {
  const l = byLayer.get(layer);
  if (!l?.GdsLayerNo || !l.GdsDatatype) return layer;
  const dt = l.GdsDatatype.Draw ?? Object.values(l.GdsDatatype)[0];
  return SKY_NAMES.get(`${l.GdsLayerNo}/${dt}`) ?? layer;
}

/** 금속 층 이름 (아래부터) */
export const METALS = metals().map((l) => l.Layer);
