/** 내려받기 — 전부 이 자리에서 만든 것이다. 저장소에 미리 넣어둔 산출물을 걸지 않는다 (그러면 배치·배선을 안 돌리고도
 *  결과를 받게 되고, 그건 이 페이지가 하는 일이 아니다).
 *
 *  손으로 고친 배치의 산출물은 -edited, 손으로 고친 배선은 -wires 로 이름을 가른다 — 배치기·배선기가 낸 그대로가 아니다.
 */

import { placeGrid } from "../../pdk/pdk.mjs";

/** 내려받을 배치 JSON — 배선기에 넘기는 원점(oX, oY)과 화면 좌표(x, y, w, h)를 같이, 하위 모듈까지 담는다 */
export function placementJson(ours, top) {
  return {
    top, bbox: ours.bbox, grid: ours.grid ?? placeGrid(),
    subModules: ours.subModules ?? [],
    instances: ours.rects.map((r) => ({
      name: r.name, concrete: r.concrete,
      oX: Math.round(r.sx > 0 ? r.x : r.x + r.w),
      oY: Math.round(r.sy > 0 ? r.y : r.y + r.h),
      sX: r.sx > 0 ? 1 : -1, sY: r.sy > 0 ? 1 : -1,
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.w), h: Math.round(r.h),
    })),
    quality: { area: ours.area, hpwl: ours.hpwl, overlap: ours.overlap, resid: ours.resid, offgrid: ours.offgrid, orderBad: ours.orderBad },
    // 손으로 고친 배치면 몇 번 고쳤는지와 고정한 variant — 0 이면 배치기가 낸 그대로다
    edited: ours.edited ?? 0, fixedVariants: ours.fixedVariants ?? null,
  };
}

/** 지금 내려받을 것들 [{file, label, blob}] — 배치가 있으면 배치 JSON, 그린 판이 있으면 그 GDS 와 DRC/LVS 보고까지 */
export function artifacts({ name, ours, drawn, wiresEdited }) {
  const out = [];
  if (!ours) return out;
  const base = (name || "design") + (ours.edited ? "-edited" : "");
  const nm = base + (wiresEdited ? "-wires" : "");
  if (drawn?.gds && (drawn.wires || drawn.vias))
    out.push({ file: nm + ".gds", label: "GDS (KLayout) — cells and tracks", blob: new Blob([drawn.gds], { type: "application/octet-stream" }) });
  else if (drawn?.gds)
    out.push({ file: base + "-cells.gds", label: "GDS (KLayout) — placed cells, no tracks yet", blob: new Blob([drawn.gds], { type: "application/octet-stream" }) });
  out.push({ file: base + ".place.json", label: "Placement (coordinates, variants, flips)",
             blob: new Blob([JSON.stringify(placementJson(ours, name), null, 1)], { type: "application/json" }) });
  // 보고는 트랙이 생긴 뒤부터 (그 전에는 넷마다 OPEN 뿐이다)
  if (drawn && (drawn.wires || drawn.vias)) out.push({ file: nm + ".errors.txt", label: "DRC/LVS report (text)", blob: new Blob([(drawn.errors ?? []).join("\n") || "(no errors)\n"], { type: "text/plain" }) });
  return out;
}
