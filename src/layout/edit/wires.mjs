/** 배선기(PnRDB)의 금속 · 비아 모양 — 레이아웃 편집기가 다 그린 넷을 배선기에 고정 넷으로 넘길 때 쓴다 (art/import.mjs).
 *
 *  배선기(alignroute.wasm)는 넷마다 path_metal(층의 선호 방향으로 곧은 토막)과 path_via(층을 바꾸는 자리)를 받고 낸다.
 *  고정 넷은 그 모양 그대로 장애물로 심는다 (route/pipeline.mjs 의 freezeNets). 단위는 PnRDB(nm 의 2 배)다.
 */
import { readPdkJson } from "../route/align/drc.mjs";
import { PDK } from "../pdk/pdk.mjs";

export const DRC = readPdkJson(PDK);

const pt0 = () => ({ x: 0, y: 0 });
const box0 = () => ({ LL: pt0(), UR: pt0() });

/** 비아 모형으로 비아 하나 (path_via 항목) — 배선기의 ConvertToViaPnRDB_Placed_Placed 와 같은 모양 */
export function viaAt(model, x, y, drc = DRC) {
  const vm = drc.Via_model[model];
  const name = (i) => drc.Metal_info[i]?.name ?? "";
  const rect = (pts) => ({ LL: { x: x + pts[0].x, y: y + pts[0].y }, UR: { x: x + pts[1].x, y: y + pts[1].y } });
  const c = (metal, pts) => ({ metal, originBox: box0(), originCenter: pt0(), placedBox: rect(pts), placedCenter: { x, y } });
  return { model_index: model, originpos: pt0(), placedpos: { x, y },
           UpperMetalRect: c(name(vm.UpperIdx), vm.UpperRect), LowerMetalRect: c(name(vm.LowerIdx), vm.LowerRect), ViaRect: c(vm.name, vm.ViaRect) };
}
