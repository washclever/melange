/** 캔버스 — ALIGN cell_fabric/canvas.py 와 remove_duplicates.py 의 JS 판.
 *
 *  생성기(Wire/Region/Via)로 도형을 쌓고, 마지막에 겹친 도형을 합치며 넷 이름을 퍼뜨린다:
 *
 *    addWire / addRegion / addVia     도형 하나
 *    addWireAndViaSet                 비아 여럿과, 그 비아들을 덮는 금속 한 줄
 *    computeBbox                      도형 전체의 외곽
 *    genData()                        { bbox, globalRoutes, globalRouteGrid, terminals, subinsts }
 *                                     (ALIGN writeJSON 이 쓰는 내용 — terminals 는 중복 제거 후)
 *
 *  중복 제거 (RemoveDuplicates): 층마다 같은 중심선(2 배 좌표)의 도형을 모아 끝을 따라 정렬하고,
 *  같은 폭으로 이어지거나 겹치면 하나로 합친다. 비아는 위아래 금속과 이어 넷 이름을 나눈다.
 *  "<소자>:<단자>" 이름의 도형은 소자 단자 표시로 남긴다 (검사기가 LVS 에 쓴다).
 *  출력 순서는 ALIGN 과 같다: 영역 층(선택 층, 우물) 먼저, 그다음 층마다·중심선마다.
 */
import { Region, Via, Wire } from "./gen.mjs";

// ---------------------------------------------------------------- 변환 (회전 없음)
export class Transformation {
  constructor(oX = 0, oY = 0, sX = 1, sY = 1) { Object.assign(this, { oX, oY, sX, sY }); }
  hitRect(r) {
    return [this.sX * r[0] + this.oX, this.sY * r[1] + this.oY, this.sX * r[2] + this.oX, this.sY * r[3] + this.oY];
  }
  postMult(A) {
    return new Transformation(this.sX * A.oX + this.oX, this.sY * A.oY + this.oY, this.sX * A.sX, this.sY * A.sY);
  }
}

const canonical = ([x0, y0, x1, y1]) => [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];

// ---------------------------------------------------------------- 캔버스
export class Canvas {
  constructor(pdk = null) {
    this.pdk = pdk;
    /** 소자 -> { parameters, pins } (파이썬 defaultdict 처럼, 처음 찾을 때 생긴다) */
    this.subinsts = new Map();
    this.terminals = [];
    /** @type {Map<string, Wire|Region|Via>} */
    this.generators = new Map();
    this.trStack = [new Transformation()];
    this.rd = null;
    this.bbox = null;
    this.layer_stack = pdk ? this._initializeLayerStack() : [["via1", ["M1", "M2"]], ["via2", ["M3", "M2"]]];
  }

  /** [[비아, [세로 금속, 가로 금속]], ...] */
  _initializeLayerStack() {
    const out = [];
    for (const [l, [pl, nl]] of this.pdk.get_via_stack()) {
      if (!l.startsWith("V")) continue;
      out.push(this.pdk.get(nl).Direction === "h" ? [l, [pl, nl]] : [l, [nl, pl]]);
    }
    return out;
  }

  subinst(name) {
    let s = this.subinsts.get(name);
    if (!s) {
      s = { parameters: {}, pins: new Map() };
      this.subinsts.set(name, s);
    }
    return s;
  }

  addGen(gen) {
    if (this.generators.has(gen.nm)) throw new Error(`generator ${gen.nm} already exists`);
    this.generators.set(gen.nm, gen);
    return gen;
  }

  transformAndAdd(s) {
    s.rect = canonical(this.trStack[this.trStack.length - 1].hitRect(s.rect));
    this.terminals.push(s);
  }

  addWire(wire, netName, c, bIdx, eIdx, { bS = null, eS = null, netType = "drawing" } = {}) {
    this.transformAndAdd(wire.segment(netName, c, bIdx, eIdx, { bS, eS, netType }));
  }
  addRegion(region, netName, x0, y0, x1, y1) {
    this.transformAndAdd(region.segment(netName, x0, y0, x1, y1, "drawing"));
  }
  addVia(via, netName, cx, cy) {
    this.transformAndAdd(via.segment(netName, cx, cy, "drawing"));
  }
  addWireAndViaSet(netName, wire, via, c, listOfIndices, { netType = "drawing" } = {}) {
    this.addWireAndMultiViaSet(netName, wire, c, [[via, listOfIndices]], { netType });
  }

  /** 비아들을 놓고, 그 비아들을 (덮는 길이까지) 감싸는 금속 한 줄을 합법 끝점으로 그린다 */
  addWireAndMultiViaSet(netName, wire, c, listOfPairs, { netType = "drawing" } = {}) {
    const dims = [], vias = [];
    for (const [via, idxs] of listOfPairs) {
      for (const idx of idxs) {
        dims.push((wire.direction === "h" ? via.v_clg : via.h_clg).value(idx, false)[0]);
        vias.push(via);
      }
    }
    if (dims.length === 0) throw new Error("addWireAndMultiViaSet: no vias");
    let mnP = Math.min(...dims), mxP = Math.max(...dims);
    mnP -= vias[dims.indexOf(mnP)].center_to_metal_edge(wire.direction);
    mxP += vias[dims.indexOf(mxP)].center_to_metal_edge(wire.direction);
    let mn = wire.spg.inverseBounds(mnP)[0];
    let mx = wire.spg.inverseBounds(mxP)[1];
    mn = wire.spg.snapToLegal(mn, -1);
    mx = wire.spg.snapToLegal(mx, 1);
    for (const [via, idxs] of listOfPairs) {
      for (const q of idxs) {
        if (wire.direction === "v") this.addVia(via, netName, c, q);
        else this.addVia(via, netName, q, c);
      }
    }
    this.addWire(wire, netName, c, mn, mx, { netType });
  }

  computeBbox() {
    if (this.bbox != null) return;
    let b = null;
    for (const t of this.terminals) {
      const r = t.rect;
      if (!b) b = r.slice();
      else {
        if (b[0] > r[0]) b[0] = r[0];
        if (b[1] > r[1]) b[1] = r[1];
        if (b[2] < r[2]) b[2] = r[2];
        if (b[3] < r[3]) b[3] = r[3];
      }
    }
    this.bbox = b ?? [null, null, null, null];
  }

  removeDuplicates({ allowOpens = false } = {}) {
    this.rd = new RemoveDuplicates(this, { allowOpens });
    return this.rd.removeDuplicates();
  }

  /** ALIGN gen_data() — writeJSON 이 쓰는 것 (DRC·PEX 는 기록만 하므로 돌리지 않는다) */
  genData() {
    this.computeBbox();
    const data = { bbox: this.bbox.slice(), globalRoutes: [], globalRouteGrid: [], terminals: this.removeDuplicates() };
    if (this.metadata) data.metadata = this.metadata;
    if (this.subinsts.size > 0) {
      data.subinsts = {};
      for (const [k, v] of this.subinsts) data.subinsts[k] = v.parameters;
    }
    return data;
  }
}

// ---------------------------------------------------------------- 중복 제거
class ScanlineRect {
  constructor() {
    this.dad = this;
    this.rect = null;
    this.netName = null;
    this.netType = null;
    this.terminal = null;
    this.isPorted = false;
  }
  root() {
    let r = this;
    while (r.dad !== r) r = r.dad;
    let x = this;
    while (x.dad !== x) { const next = x.dad; x.dad = r; x = next; }
    return r;
  }
  connect(other) { other.root().dad = this.root(); }
}

const touching = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);

class Scanline {
  constructor(indices, dIndex) {
    this.indices = indices;
    this.dIndex = dIndex;
    /** @type {ScanlineRect[]} */
    this.rects = [];
  }
  static newSlr(rect, netName, netType, isPorted) {
    const s = new ScanlineRect();
    s.rect = rect.slice();
    s.netType = netType;
    if (netName != null && netName.includes(":")) {
      const t = netName.split(":");
      if (t.length !== 2) throw new Error(`bad terminal name ${netName}`);
      s.terminal = t;
    } else s.netName = netName;
    s.isPorted = isPorted;
    return s;
  }
  merge(base, add) {
    base.rect[this.dIndex + 2] = Math.max(base.rect[this.dIndex + 2], add.rect[this.dIndex + 2]);
    base.isPorted = base.isPorted || add.isPorted;
  }
  findTouching(via) {
    for (const m of this.rects) if (touching(via.rect, m.rect)) return m;
    throw new Error(`no metal touches via ${JSON.stringify(via.rect)}`);
  }
}

const INDICES = { h: [[1, 3], 0], v: [[0, 2], 1], "*": [[0, 2], 1] };

export class RemoveDuplicates {
  constructor(canvas, { allowOpens = false } = {}) {
    this.canvas = canvas;
    this.allowOpens = allowOpens;
    this.shorts = [];
    this.opens = [];
    /** @type {Map<string, Map<number, Scanline>>} */
    this.store = new Map();
    this.layers = new Map();
    this.skip = new Set(["boundary", "Rboundary"]);
    for (const gen of canvas.generators.values()) {
      if (gen instanceof Region) this.skip.add(gen.layer);
      else if (gen instanceof Via) { if (!this.layers.has(gen.layer)) this.layers.set(gen.layer, "*"); }
      else if (gen instanceof Wire) { if (!this.layers.has(gen.layer)) this.layers.set(gen.layer, gen.direction); }
      else throw new Error(`unknown generator ${gen?.nm}`);
    }
  }

  /** 파이썬 defaultdict(dict) — 없는 층을 찾기만 해도 빈 칸이 생긴다 (출력 순서에는 영향이 없다) */
  lines(layer) {
    let m = this.store.get(layer);
    if (!m) { m = new Map(); this.store.set(layer, m); }
    return m;
  }

  centerlineTable() {
    const tbl = new Map();
    for (const d of this.canvas.terminals) {
      const { layer, rect, netName, netType } = d;
      const isPorted = String(netType).includes("pin");
      if (isPorted && netName == null) throw new Error(`pin rectangle ${JSON.stringify(rect)} (${layer}) has no net name`);
      if (this.skip.has(layer)) continue;
      const dir = this.layers.get(layer);
      if (dir === undefined) continue; // ALIGN 은 경고만 낸다
      const [idx] = INDICES[dir];
      const twice = rect[idx[0]] + rect[idx[1]];
      let byC = tbl.get(layer);
      if (!byC) { byC = new Map(); tbl.set(layer, byC); }
      let v = byC.get(twice);
      if (!v) { v = []; byC.set(twice, v); }
      v.push([rect, netName, netType, isPorted]);
    }
    return tbl;
  }

  buildScanLines(tbl) {
    for (const [layer, dir] of this.layers) {
      const byC = tbl.get(layer);
      if (!byC) continue;
      const [indices, dIndex] = INDICES[dir];
      for (const [twice, v] of byC) {
        const sl = new Scanline(indices, dIndex);
        this.lines(layer).set(twice, sl);
        let cur = null;
        const sorted = v.slice().sort((a, b) => a[0][dIndex] - b[0][dIndex]);
        for (const [rect, netName, netType, isPorted] of sorted) {
          const pot = Scanline.newSlr(rect, netName, netType, isPorted);
          if (sl.rects.length > 0 && rect[dIndex] <= cur.rect[dIndex + 2] && indices.every((i) => rect[i] === cur.rect[i])) {
            if (this.connectPair(layer, cur, pot)) {
              if (pot.netType !== "blockage" && cur.netType !== "blockage") sl.merge(cur, pot);
              else { sl.rects.push(pot); cur = pot; }
            } else { sl.rects.push(pot); cur = pot; }
          } else { sl.rects.push(pot); cur = pot; }
        }
      }
    }
  }

  connectPair(layer, a, b) {
    const n = this.shorts.length;
    if (a.netName == null) { a.netName = b.netName; a.connect(b); }
    else if (b.netName == null || a.netName === b.netName) { b.netName = a.netName; a.connect(b); }
    else this.shorts.push(`CONNECTPAIR ${layer} ${a.netName} ${b.netName}`);
    if (a.terminal == null && b.terminal == null) return n === this.shorts.length;
    if (a.terminal != null) this.pinSet(a.terminal).add(a);
    if (b.terminal != null) this.pinSet(b.terminal).add(b);
    return false;
  }

  pinSet([inst, pin]) {
    const s = this.canvas.subinst(inst);
    let p = s.pins.get(pin);
    if (!p) { p = new Set(); s.pins.set(pin, p); }
    return p;
  }

  shortsByVias() {
    for (const [via, [mv, mh]] of this.canvas.layer_stack) {
      if (mv == null && mh == null) continue;
      const vl = this.store.get(via);
      if (!vl) continue;
      for (const [twice, vsl] of vl) {
        if (mv != null) {
          const ml = this.lines(mv).get(twice);
          if (!ml) continue; // ALIGN: 경고 후 이 중심선은 건너뛴다 (가로 금속 쪽도)
          for (const vr of vsl.rects) this.connectPair(via, ml.findTouching(vr).root(), vr.root());
        }
        if (mh != null) {
          for (const vr of vsl.rects) {
            const ty = vr.rect[1] + vr.rect[3];
            const hl = this.lines(mh).get(ty);
            if (!hl) continue;
            this.connectPair(via, vr.root(), hl.findTouching(vr).root());
          }
        }
      }
    }
  }

  /** 넷 이름 없이 남은 단자 — ALIGN 은 열린 넷으로 적는다 (소자 표가 생기는 부수 효과만 따라 한다) */
  checkOpens() {
    for (const v of this.store.values()) {
      for (const sl of v.values()) {
        for (const s of sl.rects) {
          const nm = s.root().netName;
          if (nm == null && s.terminal != null) {
            this.pinSet(s.terminal).add(null);
            if (!this.allowOpens) this.opens.push(s.terminal.join(":"));
          }
        }
      }
    }
  }

  generateRectangles() {
    const out = [];
    for (const d of this.canvas.terminals) if (this.skip.has(d.layer)) out.push(d);
    for (const [layer, vv] of this.store) {
      for (const sl of vv.values()) {
        for (const s of sl.rects) {
          const t = { layer, netName: s.root().netName, rect: s.rect, netType: s.netType };
          if (s.isPorted) t.netType = "pin";
          if (s.terminal != null) t.terminal = s.terminal;
          out.push(t);
        }
      }
    }
    return out;
  }

  removeDuplicates() {
    this.buildScanLines(this.centerlineTable());
    this.shortsByVias();
    this.checkOpens();
    return this.generateRectangles();
  }
}
