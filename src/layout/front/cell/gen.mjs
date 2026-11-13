/** 도형 생성기 — ALIGN cell_fabric/generators.py 의 JS 판.
 *
 *    Wire    한 방향 금속(또는 FEOL 층) 줄: 중심선 격자(clg) 위 한 줄을 끝점 격자(spg) 두 점 사이로
 *    Region  두 격자의 네 점으로 정한 사각형 (선택 층, 우물)
 *    Via     가로·세로 중심선의 교차점에 놓는 사각형 — 위아래 금속이 비아를 덮는 길이(ext)도 안다
 *
 *  segment() 는 { netName, layer, rect, netType } 를 낸다 (rect 는 [x0, y0, x1, y1], 아직 정렬 전).
 */
import { fdiv } from "../py.mjs";

const NET_TYPES = ["drawing", "pin", "blockage"];

export class Wire {
  constructor(nm, layer, direction, { clg, spg }) {
    if (direction !== "v" && direction !== "h") throw new Error(`Wire ${nm}: bad direction ${direction}`);
    this.nm = nm;
    this.layer = layer;
    this.direction = direction;
    this.clg = clg;
    this.spg = spg;
  }
  segment(netName, center, bIdx, eIdx, { bS = null, eS = null, netType = "drawing" } = {}) {
    const [c, [w, clr]] = this.clg.value(center);
    const c0 = c - fdiv(w, 2), c1 = c + fdiv(w, 2);
    const bPhys = (bS ?? this.spg).value(bIdx)[0];
    const ePhys = (eS ?? this.spg).value(eIdx)[0];
    const rect = this.direction === "h" ? [bPhys, c0, ePhys, c1] : [c0, bPhys, c1, ePhys];
    const data = { netName, layer: this.layer, rect };
    if (clr != null) data.color = clr;
    if (NET_TYPES.includes(netType)) data.netType = netType;
    return data;
  }
}

export class Region {
  constructor(nm, layer, { h_grid, v_grid }) {
    this.nm = nm;
    this.layer = layer;
    this.h_grid = h_grid;
    this.v_grid = v_grid;
  }
  physical_x(gx) { return this.v_grid.value(gx)[0]; }
  physical_y(gy) { return this.h_grid.value(gy)[0]; }
  segment(netName, x0, y0, x1, y1, netType = "drawing") {
    const rect = [this.physical_x(x0), this.physical_y(y0), this.physical_x(x1), this.physical_y(y1)];
    const data = { netName, layer: this.layer, rect };
    if (NET_TYPES.includes(netType)) data.netType = netType;
    return data;
  }
}

export class Via {
  constructor(nm, layer, { h_clg, v_clg, WidthX = null, WidthY = null, h_ext = null, v_ext = null }) {
    this.nm = nm;
    this.layer = layer;
    this.h_clg = h_clg;
    this.v_clg = v_clg;
    this.WidthX = WidthX ?? (v_clg ? v_clg.grid[0][1][0] : 2);
    this.WidthY = WidthY ?? (h_clg ? h_clg.grid[0][1][0] : 2);
    this.h_ext = h_ext ?? fdiv(this.WidthX, 2);
    this.v_ext = v_ext ?? fdiv(this.WidthY, 2);
  }
  physical_xs(p) {
    const c = this.v_clg.value(p)[0];
    return [c - fdiv(this.WidthX, 2), c + fdiv(this.WidthX, 2)];
  }
  physical_ys(p) {
    const c = this.h_clg.value(p)[0];
    return [c - fdiv(this.WidthY, 2), c + fdiv(this.WidthY, 2)];
  }
  segment(netName, cx, cy, netType = "drawing") {
    const [x0, x1] = this.physical_xs(cx);
    const [y0, y1] = this.physical_ys(cy);
    const data = { netName, layer: this.layer, rect: [x0, y0, x1, y1] };
    if (NET_TYPES.includes(netType)) data.netType = netType;
    return data;
  }
  /** 비아 중심에서 그 방향 금속 끝까지 (금속이 비아를 덮어야 하는 길이) */
  center_to_metal_edge(direction) {
    if (direction !== "h" && direction !== "v") throw new Error(`bad direction ${direction}`);
    return direction === "h" ? this.h_ext : this.v_ext;
  }
}
