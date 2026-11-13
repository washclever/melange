/** 기본 캔버스 — ALIGN primitive/default/canvas.py 의 DefaultCanvas.
 *
 *  PDK 의 금속마다 Wire 생성기(m1, m2, ...)를, 위아래가 모두 금속인 비아마다 Via 생성기(v1, v2, ...)를
 *  만든다. 금속 끝점 격자(spg)는 이웃 금속 중 피치가 작은 쪽의 트랙에 맞추고, 끝을 비아 덮는 길이만큼
 *  늘린다 (_getViaExt). 셀 생성기(MOS 등)는 이 위에 FEOL 층 생성기를 더한다.
 */
import { Canvas } from "./canvas.mjs";
import { Region, Via, Wire } from "./gen.mjs";
import { ColoredCenterLineGrid, EnclosureGrid, UncoloredCenterLineGrid } from "./grid.mjs";
import { fdiv } from "../py.mjs";

const first = (v) => (Array.isArray(v) ? v[0] : v);

export class DefaultCanvas extends Canvas {
  /** @param {import("./pdk.mjs").Pdk} pdk */
  constructor(pdk) {
    super(pdk);
    for (const [layer, info] of this.pdk.items()) {
      if (layer.startsWith("M")) this._createMetal(layer, info);
      else if (layer.startsWith("V")) this._createVia(layer, info);
    }
    this.boundary = this.addGen(new Region("boundary", "Boundary", { h_grid: this.m2.clg, v_grid: this.m1.clg }));
  }

  _metalWidth(layer) { return first(this.pdk.get(layer).Width); }
  _metalPitch(layer) { return first(this.pdk.get(layer).Pitch); }
  _metalOffset(layer) { return first(this.pdk.get(layer).Offset); }

  /** 금속이 비아를 덮어야 하는 길이 — 비아 폭의 반 + 덮개 */
  _getViaExt(metal, via) {
    const v = this.pdk.get(via);
    const enc = v.Stack[0] === metal ? v.VencA_L : v.VencA_H;
    const width = this.pdk.get(metal).Direction === "h" ? v.WidthX : v.WidthY;
    return fdiv(width, 2) + enc;
  }

  _findAdjoiningLayers(layer) {
    let pm = null, pv = null, nv = null, nm = null;
    for (const [v, [m0, m1]] of this.pdk.get_via_stack()) {
      if (layer === m0) { nv = v; nm = m1; }
      else if (layer === m1) { pv = v; pm = m0; }
    }
    if (nm == null && pm == null) throw new Error(`no layer connects to ${layer}`);
    return [pm, pv, nv, nm];
  }

  _createMetal(layer, info) {
    if (Array.isArray(info.Width)) {
      const one = {};
      for (const [k, v] of Object.entries(info)) one[k] = ["Pitch", "Width", "MinL", "MaxL"].includes(k) ? v[0] : v;
      return this._createMetal(layer, one);
    }
    const base = layer.split("_")[0];
    const [pm, pv, nv, nm] = this._findAdjoiningLayers(base);
    let pitch, stop, offset;
    if (nm == null) [pitch, stop, offset] = [this._metalPitch(pm), this._getViaExt(base, pv), this._metalOffset(pm)];
    else if (pm == null) [pitch, stop, offset] = [this._metalPitch(nm), this._getViaExt(base, nv), this._metalOffset(nm)];
    else {
      const pp = this._metalPitch(pm), np = this._metalPitch(nm);
      if (pp <= np) [pitch, stop, offset] = [pp, this._getViaExt(base, pv), this._metalOffset(pm)];
      else [pitch, stop, offset] = [np, this._getViaExt(base, nv), this._metalOffset(nm)];
    }
    const nmLower = layer.toLowerCase();
    const colors = info.Color ?? [];
    const clg = colors.length === 0
      ? new UncoloredCenterLineGrid({ pitch: this._metalPitch(base), width: this._metalWidth(base), offset: this._metalOffset(base) })
      : new ColoredCenterLineGrid({ colors, pitch: this._metalPitch(base), width: this._metalWidth(base), offset: this._metalOffset(base) });
    this[nmLower] = this.addGen(new Wire(nmLower, base, info.Direction, { clg, spg: new EnclosureGrid({ pitch, offset, stoppoint: stop }) }));
  }

  _createVia(layer, info) {
    if (info.Stack.some((x) => x == null)) return;
    const [a, b] = info.Stack;
    let h_clg, v_clg, h_ext, v_ext;
    if (this.pdk.get(a).Direction === "h") {
      if (this.pdk.get(b).Direction !== "v") throw new Error(`${info.Stack} are both horizontal`);
      h_clg = this[a.toLowerCase()].clg; v_clg = this[b.toLowerCase()].clg;
      h_ext = this._getViaExt(a, layer); v_ext = this._getViaExt(b, layer);
    } else {
      if (this.pdk.get(b).Direction !== "h") throw new Error(`${info.Stack} are both vertical`);
      v_clg = this[a.toLowerCase()].clg; h_clg = this[b.toLowerCase()].clg;
      v_ext = this._getViaExt(a, layer); h_ext = this._getViaExt(b, layer);
    }
    this[layer.toLowerCase()] = this.addGen(new Via(layer.toLowerCase(), layer, {
      h_clg, v_clg, WidthX: info.WidthX, WidthY: info.WidthY, h_ext, v_ext,
    }));
  }
}
