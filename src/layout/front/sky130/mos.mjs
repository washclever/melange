/** SKY130 트랜지스터 셀 — ALIGN-pdk-sky130 의 SKY130_PDK/mos.py (MOSGenerator) 의 JS 판.
 *
 *  단위 셀 하나는 게이트(폴리) 몇 줄과 그 양옆의 확산 접점이다. 단위 셀을 x_cells x y_cells 로 깔고
 *  (패턴에 따라 소자 A/B 를 섞는다), 단자마다 M1 을 세우고 M2 트랙으로 묶은 뒤, 넷마다 M3(또는 M2)
 *  핀을 낸다.
 *
 *    단위 셀 높이   height(핀 수, 기본 28) x Fin 피치 = M2 트랙 m2PerUnitCell 개
 *    게이트 수      2 x gate x stack (+ 양쪽 더미 gateDummy, 확산을 나누지 않을 때)
 *    접점           G: 셀 위쪽 M1 + li 접점(va), S/D: 게이트 사이 M1 + 확산 접점(v0)
 *    몸체           bodyswitch=1 이면 맨 위 줄 위에 탭(Tap) 과 접점
 *    패턴           0 소자 하나, 1 공통 중심(CC), 2 엇갈림(ID), 3 전류 거울, 4 반반(NCC), 또는 열마다 지정
 *
 *  파이썬의 집합 순서는 py.mjs 의 PySet 으로 맞춘다 (트랙 배정과 도형 순서가 같아진다).
 */
import { DefaultCanvas } from "../cell/default.mjs";
import { Region, Via, Wire } from "../cell/gen.mjs";
import { CenteredGrid, CenterLineGrid, EnclosureGrid, SingleGrid, UncoloredCenterLineGrid } from "../cell/grid.mjs";
import { PySet, fdiv } from "../py.mjs";
import { Pdk } from "../cell/pdk.mjs";

/** 파이썬 defaultdict(lambda: defaultdict(list)) 를 Map 두 겹으로 */
function list2(m, a, b) {
  let x = m.get(a);
  if (!x) { x = new Map(); m.set(a, x); }
  let y = x.get(b);
  if (!y) { y = []; x.set(b, y); }
  return y;
}

export class MOSGenerator extends DefaultCanvas {
  /**
   * @param {import("../cell/pdk.mjs").Pdk} pdk
   * @param {number} height  단위 셀 핀 수
   * @param {number} fin     소자 핀 수
   * @param {number} gate    게이트 쌍 수 (보통 1)
   * @param {number} gateDummy
   * @param {number} shared_diff  1 이면 이웃 셀이 확산을 나눈다
   * @param {number} stack
   * @param {number} bodyswitch
   */
  constructor(pdk, height, fin, gate, gateDummy, shared_diff, stack, bodyswitch) {
    super(pdk);
    const P = (l) => this.pdk.get(l);
    this.finsPerUnitCell = height;
    if (height % 4 !== 0) throw new Error(`cell height (${height} fins) is not a multiple of 4`);
    if ((height * P("Fin").Pitch) % P("M2").Pitch !== 0) throw new Error("cell height is not a multiple of the M2 pitch");
    this.m2PerUnitCell = fdiv(height * P("Fin").Pitch, P("M2").Pitch);
    this.unitCellHeight = this.m2PerUnitCell * P("M2").Pitch;
    this.shared_diff = shared_diff;
    this.stack = stack;
    this.bodyswitch = bodyswitch;
    this.gateDummy = gateDummy;
    this.gate = 2 * gate * stack;
    this.gatesPerUnitCell = this.gate + 2 * gateDummy * (1 - shared_diff);
    this.finDummy = fdiv(height - fin, 2);
    if (this.finDummy < 8) throw new Error("too many device fins for the cell height");
    if (!(fin > 1)) throw new Error("the device needs more than one fin");
    if (!(gateDummy > 0)) throw new Error("gateDummy > 0");
    const polyPitch = P("Poly").Pitch;
    this.unitCellLength = this.gatesPerUnitCell * polyPitch;
    this.activeOffset = fdiv(this.unitCellHeight, 2) - fdiv(P("Fin").Pitch, 2);
    this.activeWidth = P("Fin").Pitch * fin;
    this.activePitch = this.unitCellHeight;
    this.RVTWidth = this.activeWidth + 2 * P("Active").active_enclosure;

    let stoppoint = P("Active").activePolyExTracks * P("M2").Pitch;
    this.pl = this.addGen(new Wire("pl", "Poly", "v", {
      clg: new UncoloredCenterLineGrid({ pitch: polyPitch, width: P("Poly").Width, offset: P("Poly").Offset }),
      spg: new EnclosureGrid({ pitch: this.unitCellHeight, offset: P("M2").Offset, stoppoint }),
    }));
    const finClg = () => new UncoloredCenterLineGrid({ pitch: P("Fin").Pitch, width: P("Fin").Width, offset: P("Fin").Offset });
    this.fin = this.addGen(new Wire("fin", "Fin", "h", { clg: finClg(), spg: new SingleGrid({ offset: 0, pitch: this.unitCellLength }) }));
    this.fin_diff = this.addGen(new Wire("fin_diff", "Fin", "h", { clg: finClg(), spg: new SingleGrid({ offset: 0, pitch: polyPitch }) }));

    const sd = this.shared_diff;
    let offset = gateDummy * polyPitch + P("Poly").Offset - fdiv(polyPitch, 2);
    stoppoint = gateDummy * polyPitch + P("Poly").Offset - P("Active").poly_enclosure;
    this.active = this.addGen(new Wire("active", "Active", "h", {
      clg: new UncoloredCenterLineGrid({ pitch: this.activePitch, width: this.activeWidth, offset: this.activeOffset }),
      spg: new EnclosureGrid({ pitch: this.unitCellLength, offset: offset * sd, stoppoint: stoppoint - offset * sd }),
    }));

    stoppoint = gateDummy * polyPitch + P("Poly").Offset - P("Pc").Ext - fdiv(P("Poly").Width, 2);
    this.pc = this.addGen(new Wire("pc", "Poly", "h", {
      clg: new UncoloredCenterLineGrid({ pitch: P("M2").Pitch, width: P("Pc").Width, offset: P("M2").Pitch }),
      spg: new EnclosureGrid({ pitch: this.unitCellLength, offset: offset * sd, stoppoint: stoppoint - offset * sd }),
    }));

    this.Tap = this.addGen(new Wire("Tap", "Tap", "v", {
      clg: new UncoloredCenterLineGrid({ pitch: P("M1").Pitch, width: P("Tap").Width, offset: P("M1").Offset }),
      spg: new EnclosureGrid({ pitch: P("M2").Pitch, offset: 0, stoppoint: fdiv(P("M2").Width, 2) + P("V1").VencA_L }),
    }));

    stoppoint = gateDummy * polyPitch + P("Poly").Offset - P("Npc").Ext - fdiv(P("Poly").Width, 2);
    this.Npc = this.addGen(new Wire("Npc", "Npc", "h", {
      clg: new UncoloredCenterLineGrid({ pitch: P("M2").Pitch, width: P("Npc").Width, offset: P("M2").Pitch }),
      spg: new EnclosureGrid({ pitch: this.unitCellLength, offset: offset * sd, stoppoint: stoppoint - offset * sd }),
    }));

    const region = (nm, layer) => this.addGen(new Region(nm, layer, {
      v_grid: new CenteredGrid({ offset: fdiv(polyPitch, 2), pitch: polyPitch }), h_grid: this.fin.clg,
    }));
    this.nselect = region("nselect", "Nselect");
    this.pselect = region("pselect", "Pselect");
    this.nwell = region("nwell", "Nwell");

    const V0 = P("V0");
    this.va = this.addGen(new Via("va", "V0", { h_clg: this.m2.clg, v_clg: this.m1.clg, WidthX: V0.WidthX, WidthY: V0.WidthY }));
    this.v0 = this.addGen(new Via("v0", "V0", { h_clg: new CenterLineGrid(), v_clg: this.m1.clg, WidthX: V0.WidthX, WidthY: V0.WidthY }));

    // 아래 LVT/HVT 의 끝점은 파이썬과 같이 바로 위 Npc 의 stoppoint 를 쓴다
    const vt = (nm, layer) => this.addGen(new Wire(nm, layer, "h", {
      clg: new UncoloredCenterLineGrid({ pitch: this.activePitch, width: this.RVTWidth, offset: this.activeOffset }),
      spg: new EnclosureGrid({ pitch: this.unitCellLength, offset: 0, stoppoint }),
    }));
    const vtDiff = (nm, layer) => this.addGen(new Wire(nm, layer, "h", {
      clg: new UncoloredCenterLineGrid({ pitch: this.activePitch, width: this.RVTWidth, offset: this.activeOffset }),
      spg: new SingleGrid({ pitch: polyPitch, offset: (gateDummy - 1) * polyPitch + fdiv(polyPitch, 2) }),
    }));
    this.LVT = vt("LVT", "Lvt");
    this.LVT_diff = vtDiff("LVT_diff", "Lvt");
    this.HVT = vt("HVT", "Hvt");
    this.HVT_diff = vtDiff("HVT_diff", "Hvt");

    this.v0.h_clg.addCenterLine(0, V0.WidthY, false);
    const v0pitch = V0.WidthY + V0.SpaceY;
    const v0Offset = this.activeOffset - fdiv(this.activeWidth, 2) + V0.VencA_L + fdiv(V0.WidthY, 2);
    let v0n = Math.floor((this.activeWidth - 2 * V0.VencA_L - V0.WidthY) / v0pitch + 1);
    v0n = Math.max(v0n, 1);
    v0n = v0n < 4 ? v0n : v0n - 1; // M1 이 V0 를 덮는 규칙 때문에 (ALIGN 과 같다)
    for (let i = 0; i < v0n; i++) this.v0.h_clg.addCenterLine(i * v0pitch + v0Offset, V0.WidthY, true);
    this.v0.h_clg.addCenterLine(this.unitCellHeight, V0.WidthY, false);
  }

  _addMOS(x, y, x_cells, vt_type, name = "M1", reflect = false, parameters = {}) {
    void reflect;
    const fullname = `${name}_X${x}_Y${y}`;
    Object.assign(this.subinst(fullname).parameters, parameters);
    const grid_y0 = y * this.m2PerUnitCell + 1;
    const grid_y1 = (y + 1) * this.m2PerUnitCell - 5;

    const connectDiffusion = (i, pin) => {
      this.addWire(this.m1, null, i, [grid_y0, -1], [grid_y1, 1]);
      for (let j = 1; j < this.v0.h_clg.n; j++) this.addVia(this.v0, `${fullname}:${pin}`, i, [y, j]);
      list2(this._xpins, name, pin).push(i);
    };

    // FEOL
    this.addWire(this.active, null, y, [x, 1], [x + 1, -1]);
    for (let i = 0; i < this.gate; i++) this.addWire(this.pl, null, i + this.gatesPerUnitCell * x + this.gateDummy, [y, 1], [y + 1, -1]);

    const vtLayer = (wire, diff) => {
      if (this.shared_diff === 0) this.addWire(wire, null, y, [x, 1], [x + 1, -1]);
      else if (this.shared_diff === 1 && x === x_cells - 1) this.addWire(diff, null, y, 0, this.gate * x_cells + 1);
    };
    if (vt_type === "RVT") { /* 따로 그릴 층이 없다 */ }
    else if (vt_type === "LVT") vtLayer(this.LVT, this.LVT_diff);
    else if (vt_type === "HVT") vtLayer(this.HVT, this.HVT_diff);
    else throw new Error(`threshold voltage type ${vt_type} is not supported`);

    // 게이트
    const gate_x = this.gateDummy * this.shared_diff + x * this.gatesPerUnitCell + fdiv(this.gatesPerUnitCell, 2);
    this.addWire(this.m1, null, gate_x, [grid_y1 + 1, -1], [grid_y1 + 3, 1]);
    this.addWire(this.pc, null, grid_y1 + 1, [x, 1], [x + 1, -1]);
    this.addVia(this.va, `${fullname}:G`, gate_x, grid_y1 + 2);
    list2(this._xpins, name, "G").push(gate_x);

    // 소스·드레인
    let [center, side] = this.gate % 4 === 0 ? ["S", "D"] : ["D", "S"];
    if (this.stack > 1) center = "D";
    connectDiffusion(gate_x, center);
    const half = fdiv(this.gate, 2);
    for (let xt = 1; xt <= half; xt++) {
      let terminal = xt % 2 === 0 ? center : side;
      if (this.stack > 1 && xt !== half) continue;
      if (this.stack > 1) terminal = "S";
      connectDiffusion(gate_x - xt, terminal);
      connectDiffusion(gate_x + xt, terminal);
    }
  }

  /** 한 줄(y)의 단자를 M2 트랙으로 묶는다 — 넷마다, 그 넷의 단자 종류마다 트랙 하나 */
  _connectDevicePins(y, y_cells, connections) {
    const grid_y1 = (y + 1) * this.m2PerUnitCell - 5;
    let gate_track = 0, diff_track = 1;
    for (const [net, conn] of connections) {
      const contactsx = new PySet();
      for (const [inst, pins] of this._xpins) {
        for (const [pin, tracks] of pins) {
          if (!conn.some(([i, p]) => i === inst && p === pin)) continue;
          for (const track of tracks) contactsx.add([track, pin]);
        }
      }
      const pins = new PySet();
      for (const x of contactsx) pins.add(x[1]);
      for (const pin of pins) {
        const contacts = new PySet();
        for (const x of contactsx) if (x[1] === pin) contacts.add(x[0]);
        for (let j = 0; j < this.minvias; j++) {
          let track;
          if (pin === "G") { track = grid_y1 + 2 + gate_track; gate_track++; }
          else if (pin === "B") {
            if (y !== y_cells - 1) continue;
            track = y_cells * this.m2PerUnitCell + fdiv(this.pdk.get("Active").Body_nfin, 4);
          } else { track = y * this.m2PerUnitCell + connections.size * j + diff_track; diff_track++; }
          this.addWireAndViaSet(net, this.m2, this.v1, track, contacts);
          let m = this._nets.get(net);
          if (!m) { m = new Map(); this._nets.set(net, m); }
          m.set(track, contacts);
        }
      }
    }
  }

  /** 넷마다 핀 — M2 트랙이 하나면 M2 핀, 여럿이면 M3 로 묶은 핀 */
  _connectNets(x_cells) {
    const center = fdiv(x_cells * this.gatesPerUnitCell, 2);
    const terminators = (tracks) => {
      let minx = Math.min(...tracks), maxx = Math.max(...tracks);
      const minL = 2, L = maxx - minx;
      if (center - fdiv(minL, 2) <= minx && maxx <= center + fdiv(minL, 2)) [minx, maxx] = [center - fdiv(minL, 2), center + fdiv(minL, 2)];
      else if (L < minL) [minx, maxx] = minx >= center ? [minx - (minL - L), maxx] : [minx, maxx + (minL - L)];
      return [minx, maxx];
    };
    const nNets = this._nets.size;
    const m3start = this.shared_diff + fdiv(x_cells * this.gatesPerUnitCell - nNets * this.minvias, 2) + 2;
    let track = 1;
    for (const [net, conn] of this._nets) {
      for (let j = 0; j < this.minvias; j++) {
        const cur = m3start + nNets * j + track;
        const contacts = [...conn.keys()];
        if (contacts.length === 1) {
          const i = contacts[0];
          const [minx, maxx] = terminators([...conn.get(i)]);
          this.addWire(this.m2, net, i, [minx, -1], [maxx, 1], { netType: "pin" });
        } else {
          this.addWireAndViaSet(net, this.m3, this.v2, cur, contacts, { netType: "pin" });
          if (Math.max(...contacts) - Math.min(...contacts) < 2) {
            const miny = Math.min(...contacts), maxy = miny + 2;
            this.addWire(this.m3, net, cur, [miny, -1], [maxy, 1], { netType: "pin" });
          }
          for (const [i, locs] of conn) {
            const [minx, maxx] = terminators([...locs, cur]);
            this.addWire(this.m2, net, i, [minx, -1], [maxx, 1]);
          }
        }
      }
      track++;
    }
  }

  _addBodyContact(x, y, x_cells, yloc = null, name = "M1") {
    const fullname = `${name}_X${x}_Y${y}`;
    if (yloc != null) y = yloc;
    const h = this.m2PerUnitCell, gu = this.gatesPerUnitCell;
    const gate_x = this.gateDummy * this.shared_diff + x * gu + fdiv(gu, 2);
    list2(this._xpins, name, "B").push(gate_x);
    const bt = (y + 1) * h + fdiv(this.pdk.get("Active").Body_nfin, 4);
    this.addWire(this.m1, null, gate_x, [bt - 1, -1], [bt + 1, 1]);
    this.addVia(this.va, `${fullname}:B`, gate_x, bt);
    this.addWire(this.Tap, null, gate_x, [bt - 1, -1], [bt + 1, 1]);
  }

  /**
   * @param {Map<string, Array<[string, string]>>} connections  넷 -> [[소자, 단자], ...]
   */
  _addMOSArray(x_cells, y_cells, pattern, vt_type, connections, minvias = 1, parameters = {}) {
    if (minvias * connections.size > this.m2PerUnitCell - 1) this.minvias = fdiv(this.m2PerUnitCell - 1, connections.size);
    else this.minvias = minvias;
    const names = pattern === 0 ? ["M1"] : ["M1", "M2"];
    this._nets = new Map();
    for (let y = 0; y < y_cells; y++) {
      this._xpins = new Map();
      for (let x = 0; x < x_cells; x++) {
        let k, reflect = false;
        if (Array.isArray(pattern)) k = pattern[x];
        else if (pattern === 0) k = 0;
        else if (pattern === 1) { k = (fdiv(x, 2) % 2 + x % 2 + y % 2) % 2; reflect = x >= fdiv(x_cells, 2); }
        else if (pattern === 2) k = (x % 2 + y % 2) % 2;
        else if (pattern === 3) { const d = fdiv(x_cells, 2) - x; k = d >= 0 && d <= 1 ? 0 : 1; }
        else if (pattern === 4) k = x < fdiv(x_cells, 2) ? 0 : 1;
        else throw new Error(`unknown pattern ${pattern} (x_cells ${x_cells})`);
        this._addMOS(x, y, x_cells, vt_type, names[k], reflect, parameters);
        if (this.bodyswitch === 1) this._addBodyContact(x, y, x_cells, y_cells - 1, names[k]);
      }
      this._connectDevicePins(y, y_cells, connections);
    }
    this._connectNets(x_cells, y_cells);
  }

  _regionX1(x_cells) { return [x_cells * this.gatesPerUnitCell + 2 * this.gateDummy * this.shared_diff - 1, -1]; }

  addNMOSArray(x_cells, y_cells, pattern, vt_type, connections, parameters = {}) {
    this._addMOSArray(x_cells, y_cells, pattern, vt_type, connections, 1, parameters);
    const top = y_cells * this.finsPerUnitCell;
    this.addRegion(this.nselect, null, [1, -1], 0, this._regionX1(x_cells), top);
    if (this.bodyswitch === 1)
      this.addRegion(this.pselect, null, [1, -1], top, this._regionX1(x_cells), top + this.bodyswitch * this.pdk.get("Active").Body_nfin);
  }

  addPMOSArray(x_cells, y_cells, pattern, vt_type, connections, parameters = {}) {
    this._addMOSArray(x_cells, y_cells, pattern, vt_type, connections, 1, parameters);
    const top = y_cells * this.finsPerUnitCell, body = top + this.bodyswitch * this.pdk.get("Active").Body_nfin;
    this.addRegion(this.pselect, null, [1, -1], 0, this._regionX1(x_cells), top);
    this.addRegion(this.nwell, null, [1, -1], 0, this._regionX1(x_cells), body);
    if (this.bodyswitch === 1) this.addRegion(this.nselect, null, [1, -1], top, this._regionX1(x_cells), body);
  }
}

/** 검사기 캔버스의 층 — ALIGN 의 PnR 검사기는 PDK 의 MOSGenerator 캔버스로 층을 본다 (생성기 순서, 처음 것이 이긴다).
 *  layers: [[층, 'h'|'v'|'*'], ...], regions: 건너뛰는 영역 층 */
export function canvasLayers(layersJson) {
  const g = new MOSGenerator(new Pdk(layersJson), 28, 4, 1, 3, 1, 1, 1);
  const layers = [], regions = ["boundary", "Rboundary"];
  const seen = new Set();
  for (const gen of g.generators.values()) {
    if (gen instanceof Region) { if (!regions.includes(gen.layer)) regions.push(gen.layer); continue; }
    if (seen.has(gen.layer)) continue;
    seen.add(gen.layer);
    layers.push([gen.layer, gen instanceof Via ? "*" : gen.direction]);
  }
  return { layers, regions };
}
