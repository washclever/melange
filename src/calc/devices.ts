/**
 * 소자의 동작점 값 — gm · gds · vth · Cgg … — 을 ngspice 에서 꺼내는 길.
 *
 * ngspice 는 이런 값을 기본으로 저장하지 않는다. `.save @m1[gm]` 처럼 하나씩 물어야 하고, 결과는
 * 시간(과도) · 스윕(DC) · 점 하나(.op)를 따라가는 벡터로 온다. 그래서 계산기 식이 gm(M1) 을 쓰면
 * 다음 실행에 그 줄을 붙인다 (src/net/netlist.ts savePlan 의 extra).
 *
 * **그 모델에 없는 이름을 물으면 둘 중 하나가 된다 — 둘 다 나쁘다** (이 엔진에 하나씩 물어 재 봤다):
 *
 *   실행 전체가 멈춘다   `vector @m1[cgg] is not available` 다음 `no writable vector found` 를 남기고
 *                        결과를 돌려주지 않는다. 레벨 1 의 cgg, BSIM3 의 cgb, 아무 모델의 오타가 그렇다
 *   0 이 온다            레벨 1 의 vth, BSIM 의 von · gmb 는 **다른 값과 같이 물으면** 오류 없이 0 으로
 *                        온다 (혼자 물으면 멈춘다). 문턱 전압 0 V 는 그럴듯해 보여서 더 나쁘다
 *
 * 그래서 모델마다 실제로 있는 이름만 묻는다:
 *
 *   레벨 1 · 2 · 3 MOS   문턱은 von. vth · cgg 가 없다 (cgg 는 cgs + cgd + cgb 로 만든다)
 *   BSIM3 (레벨 8 · 49)  문턱은 vth, 총 게이트 용량 cgg. von · cgb 가 없다
 *   BSIM4 (레벨 14 · 54) 문턱은 vth, cgg · cgb 다 있다. von 이 없다. SKY130 이 이것이다
 *   BJT                  vce · ft · beta 가 없다 — vbe - vbc, gm/2π(Cπ+Cμ), ic/ib 로 만든다
 *
 * 표가 모르는 모델(다른 레벨, 외부 .sp 가 .include 로 부른 카드)에서는 이름이 계열마다 다른 값(문턱 ·
 * 게이트 용량)을 **짐작하지 않는다** — op(M1, 이름) 으로 그 모델의 이름을 직접 적게 한다. 그렇게 물은
 * 것이 없어서 실행이 멈추면 워커가 그 벡터만 빼고 다시 돌린다 (src/sim-run.ts).
 *
 * 부호. ngspice 는 PMOS 의 vgs · vds · id 를 **크기로**(양수로) 돌려주는데, 레벨 1 의 von · vdsat 은
 * 음수 그대로다. BSIM 은 다 양수다. 교과서처럼 |VGS| · |VTH| 로 맞추려고 PMOS 의 문턱 · 포화 전압은
 * 절댓값을 쓴다. BJT 는 PNP 의 전류를 부호 그대로 주므로 극성을 곱해 정방향을 양수로 만든다.
 * BSIM 의 cgs · cgd 는 상호 용량이라 음수로 오는데, 교과서의 Cgs 는 양수라 이것도 절댓값이다.
 */

export type DevKind = "mos" | "bjt" | "diode" | "res" | "cap" | "ind" | "vsrc" | "isrc" | "other";
export type Family = "classic" | "bsim3" | "bsim4" | null;

export interface Device {
  /** 넷리스트에 적힌 SPICE 이름 (M1, XM1, EU1 …) */
  name: string;
  kind: DevKind;
  /** @…[…] 안에 들어갈 경로 (소문자). SKY130 은 서브회로 안의 MOSFET 이다 */
  path: string;
  /** MOSFET 의 모델 계열. 모르면 null */
  family: Family;
  /** +1 NMOS · NPN, -1 PMOS · PNP, 0 모름 */
  polarity: 1 | -1 | 0;
  model: string;
  /** i(이름) 가지 전류 벡터가 있는가 (V · L · E · H · 전압형 B) */
  branch: boolean;
  /** 회로도의 지정자 (U1 처럼 SPICE 이름과 다를 때) */
  ref?: string;
  /** 소자 줄의 처음 두 노드 (소문자). 전원이 어느 넷을 구동하는지 아는 데 쓴다 */
  nodes: string[];
  /** 전압원 · 전류원이 직류뿐인가 (SIN · PULSE · PWL 같은 파형이 없다) */
  dc?: boolean;
}

export interface DeviceTable {
  /** 소문자 SPICE 이름 -> 소자 */
  byName: Map<string, Device>;
  /** 소문자 지정자 -> 소문자 SPICE 이름 */
  refs: Map<string, string>;
}

export const emptyDevices = (): DeviceTable => ({ byName: new Map(), refs: new Map() });

/** 모델 계열마다 실제로 있는 파라미터. 이 엔진에 하나씩 물어본 결과다 (위 설명) */
const PARAMS: Record<string, readonly string[]> = {
  "mos:classic": ["id", "is", "ig", "ib", "gm", "gds", "gmbs", "gmb", "vgs", "vds", "vbs", "von", "vdsat",
    "cgs", "cgd", "cgb", "cbd", "cbs", "ibd", "ibs", "gbd", "gbs", "w", "l"],
  // BSIM3 에는 cgb 가 없다 (물으면 멈춘다). 나머지는 BSIM4 와 이름이 같다
  "mos:bsim3": ["id", "gm", "gds", "gmbs", "vgs", "vds", "vbs", "vth", "vdsat", "cgs", "cgd", "cgg",
    "cdd", "cdg", "cds", "cbd", "cbs", "qg", "ibd", "ibs", "w", "l", "gbd", "gbs"],
  "mos:bsim4": ["id", "gm", "gds", "gmbs", "vgs", "vds", "vbs", "vth", "vdsat", "cgs", "cgd", "cgb", "cgg",
    "cdd", "cdg", "cds", "cbb", "cbd", "cbs", "cbg", "csg", "css", "csd", "qg", "qd", "qs", "qb",
    "isub", "igidl", "ibd", "ibs", "w", "l", "gbd", "gbs"],
  bjt: ["ic", "ib", "ie", "is", "gm", "gpi", "gmu", "go", "gx", "cpi", "cmu", "cbx", "vbe", "vbc", "p", "qbe", "qbc"],
  diode: ["id", "gd", "cd", "vd", "c", "p", "charge"],
  res: ["i", "p", "r"],
  cap: ["i", "p", "c"],
  ind: ["i", "p"],
  vsrc: ["i", "p"],
  isrc: ["c", "v", "p"],
};

/** 이 소자에게 물어도 되는 이름들. null 이면 모른다 (표에 없는 모델) */
export function allowedParams(d: Device): readonly string[] | null {
  if (d.kind === "mos") return d.family ? PARAMS["mos:" + d.family] : null;
  return PARAMS[d.kind] ?? null;
}

/** 파라미터 이름의 단위 */
export const PARAM_UNIT: Record<string, string> = {
  id: "A", is: "A", ig: "A", ib: "A", ic: "A", ie: "A", ibd: "A", ibs: "A", isub: "A", igidl: "A", i: "A", c: "A",
  gm: "S", gds: "S", gmbs: "S", gmb: "S", gpi: "S", gmu: "S", go: "S", gx: "S", gd: "S", gbd: "S", gbs: "S",
  vgs: "V", vds: "V", vbs: "V", vth: "V", von: "V", vdsat: "V", vbe: "V", vbc: "V", vd: "V", v: "V",
  cgs: "F", cgd: "F", cgb: "F", cgg: "F", cdd: "F", cdg: "F", cds: "F", cbb: "F", cbd: "F", cbs: "F", cbg: "F",
  csg: "F", css: "F", csd: "F", cpi: "F", cmu: "F", cbx: "F", cd: "F",
  qg: "C", qd: "C", qs: "C", qb: "C", qbe: "C", qbc: "C", charge: "C",
  p: "W", r: "Ω", w: "m", l: "m",
};

// ── 넷리스트에서 소자 표 만들기 ───────────────────────────────────────
/** 이어진 줄(+)을 붙이고 주석 · .subckt 안쪽 · .end 뒤를 뺀 실제 줄 */
function logicalLines(netlist: string): string[] {
  const out: string[] = [];
  const raw = netlist.split(/\r?\n/);
  for (let i = 1; i < raw.length; i++) {          // 첫 줄은 제목이다 (SPICE 규칙)
    const t = raw[i].trim();
    if (!t || t.startsWith("*")) continue;
    if (/^\.end\b/i.test(t)) break;
    if (t.startsWith("+") && out.length) { out[out.length - 1] += " " + t.slice(1).trim(); continue; }
    out.push(t);
  }
  return out;
}

const MOS_LEVEL_CLASSIC = new Set([1, 2, 3]);
const MOS_LEVEL_BSIM3 = new Set([8, 49]);
const MOS_LEVEL_BSIM4 = new Set([14, 54]);

/**
 * 넷리스트 글에서 소자 표를 만든다. 회로도에서 만든 넷리스트든 외부 .sp 든 같은 길이다 —
 * 그래야 외부 .sp 를 돌려도 gm(M1) 이 된다.
 *
 * refs 는 회로도의 지정자 -> SPICE 이름 (op-amp U1 은 EU1 으로 나간다). 사용자가 회로도에서 보는
 * 이름으로 부를 수 있게 한다.
 */
export function parseDevices(netlist: string, refs?: ReadonlyMap<string, string>): DeviceTable {
  const lines = logicalLines(netlist);
  const models = new Map<string, { type: string; level: number | null }>();
  for (const l of lines) {
    const m = /^\.model\s+(\S+)\s+([a-z]+)\s*\(?(.*)$/i.exec(l);
    if (!m) continue;
    const lv = /\blevel\s*=\s*([\d.]+)/i.exec(m[3]);
    models.set(m[1].toLowerCase(), { type: m[2].toLowerCase(), level: lv ? Number(lv[1]) : null });
  }
  const byName = new Map<string, Device>();
  let depth = 0;
  for (const l of lines) {
    if (/^\.subckt\b/i.test(l)) { depth++; continue; }
    if (/^\.ends\b/i.test(l)) { depth = Math.max(0, depth - 1); continue; }
    if (depth || l.startsWith(".")) continue;
    const tok = l.split(/\s+/);
    const name = tok[0];
    const key = name.toLowerCase();
    const letter = key[0];
    // 노드 수는 소자마다 다르다: M 은 넷(d g s b), Q 는 셋, X 는 서브회로 이름 앞까지, 나머지는 둘
    const nodeCount = letter === "m" ? 4 : letter === "q" ? 3 : 2;
    const dev: Device = {
      name, kind: "other", path: key, family: null, polarity: 0, model: "", branch: false,
      nodes: tok.slice(1, 1 + nodeCount).map(t => t.toLowerCase()),
    };
    if (letter === "m") {
      const model = tok[5] ?? "";
      const info = models.get(model.toLowerCase());
      dev.kind = "mos";
      dev.model = model;
      dev.polarity = info?.type === "pmos" ? -1 : info?.type === "nmos" ? 1 : 0;
      if (info) {
        const lv = info.level ?? 1;
        dev.family = MOS_LEVEL_CLASSIC.has(lv) ? "classic" : MOS_LEVEL_BSIM3.has(lv) ? "bsim3" : MOS_LEVEL_BSIM4.has(lv) ? "bsim4" : null;
      }
    } else if (letter === "x") {
      // 서브회로 이름은 파라미터(이름=값) 바로 앞의 낱말이다
      const firstParam = tok.findIndex((t, i) => i > 0 && t.includes("="));
      const sub = (firstParam > 0 ? tok[firstParam - 1] : tok[tok.length - 1]) ?? "";
      dev.nodes = tok.slice(1, (firstParam > 0 ? firstParam : tok.length) - 1).map(t => t.toLowerCase());
      const sky = /^sky130_fd_pr__([np])fet\w*$/i.exec(sub);
      if (sky) {
        dev.kind = "mos";
        dev.family = "bsim4";
        dev.polarity = sky[1].toLowerCase() === "n" ? 1 : -1;
        dev.model = sub;
        dev.path = `m.${key}.m${sub.toLowerCase()}`;
      }
    } else if (letter === "q") {
      const cand = [tok[4], tok[5]].find(t => t && models.has(t.toLowerCase())) ?? tok[4] ?? "";
      const info = models.get(cand.toLowerCase());
      dev.kind = "bjt";
      dev.model = cand;
      dev.polarity = info?.type === "pnp" ? -1 : info?.type === "npn" ? 1 : 0;
    } else if (letter === "d") {
      dev.kind = "diode";
      dev.model = tok[3] ?? "";
    } else if (letter === "r") dev.kind = "res";
    else if (letter === "c") dev.kind = "cap";
    else if (letter === "l") { dev.kind = "ind"; dev.branch = true; }
    else if (letter === "v" || letter === "i") {
      dev.kind = letter === "v" ? "vsrc" : "isrc";
      dev.branch = letter === "v";
      dev.dc = !/\b(sin|pulse|pwl|exp|sffm|am)\s*\(/i.test(l);
    }
    else if (letter === "e" || letter === "h") dev.branch = true;
    else if (letter === "b") dev.branch = /\bv\s*=/i.test(l);
    byName.set(key, dev);
  }
  const refMap = new Map<string, string>();
  for (const [r, s] of refs ?? []) {
    const d = byName.get(s.toLowerCase());
    if (!d) continue;
    refMap.set(r.toLowerCase(), s.toLowerCase());
    if (r.toLowerCase() !== s.toLowerCase()) d.ref = r;
  }
  return { byName, refs: refMap };
}

/**
 * 사용자가 부른 이름으로 소자를 찾는다. SPICE 이름 그대로 -> 회로도 지정자 -> 앞에 소자 문자를
 * 붙인 이름 (외부 .sp 의 XM1 을 M1 으로 불러도 찾게).
 */
export function findDevice(t: DeviceTable, name: string): Device | null {
  const k = name.trim().toLowerCase();
  const direct = t.byName.get(k);
  if (direct) return direct;
  const viaRef = t.refs.get(k);
  if (viaRef) return t.byName.get(viaRef) ?? null;
  for (const p of "xmqdrclvieb") {
    const d = t.byName.get(p + k);
    if (d) return d;
  }
  return null;
}

/** 오류 문구에 넣을 후보 이름. 같은 종류만, 지정자가 있으면 지정자로 */
export function deviceNames(t: DeviceTable, kinds?: readonly DevKind[]): string[] {
  const out: string[] = [];
  for (const d of t.byName.values()) {
    if (kinds && !kinds.includes(d.kind)) continue;
    out.push(d.ref ?? d.name);
  }
  return out;
}

export const vecName = (d: Device, p: string): string => `@${d.path}[${p}]`;

// ── 소자 함수 ─────────────────────────────────────────────────────────
/**
 * gm(M1) 같은 함수 하나. needs 는 엔진에 물을 파라미터, calc 는 그 값들로 결과를 만든다.
 * calc 는 파라미터 값(같은 축 위의 배열이거나 점 하나)을 받아 수를 돌려주는 점 단위 함수다 —
 * 과도 · DC 스윕이면 축을 따라 한 점씩 불리고, .op 면 한 번 불린다.
 */
export interface DevFn {
  doc: string;
  kinds: readonly DevKind[];
  unit: string;
  /** MOSFET 모델 계열마다 읽는 이름이 다르다 (문턱 · 게이트 용량). 계열을 모르면 짐작하지 않고 막는다 */
  byFamily?: boolean;
  needs(d: Device): string[];
  calc(d: Device, v: (p: string) => number): number;
}

const pol = (d: Device): number => (d.polarity === 0 ? 1 : d.polarity);
/** 문턱 전압 이름: 레벨 1~3 은 von, 나머지는 vth */
const vthName = (d: Device): string => (d.family === "classic" ? "von" : "vth");
/** 교과서 부호의 문턱 · 포화 전압: NMOS 는 그대로, PMOS(와 모르는 것)는 크기 */
const mag = (d: Device, x: number): number => (d.polarity === 1 ? x : Math.abs(x));
const one = (p: string) => () => [p];

const MOS = ["mos"] as const, BJT = ["bjt"] as const;

export const DEVICE_FNS: Record<string, DevFn> = {
  // MOSFET · 다이오드 공용
  id: { doc: "Drain current (diode: forward current)", kinds: ["mos", "diode"], unit: "A", needs: one("id"), calc: (_d, v) => v("id") },
  gm: {
    doc: "Transconductance ∂ID/∂VGS (BJT: ∂IC/∂VBE)", kinds: ["mos", "bjt"], unit: "S",
    needs: one("gm"), calc: (_d, v) => v("gm"),
  },
  gds: { doc: "Output conductance ∂ID/∂VDS", kinds: MOS, unit: "S", needs: one("gds"), calc: (_d, v) => v("gds") },
  ro: {
    doc: "Output resistance: 1/gds (BJT: 1/go)", kinds: ["mos", "bjt"], unit: "Ω",
    needs: d => [d.kind === "bjt" ? "go" : "gds"], calc: (d, v) => 1 / v(d.kind === "bjt" ? "go" : "gds"),
  },
  gmb: { doc: "Body transconductance ∂ID/∂VBS", kinds: MOS, unit: "S", needs: one("gmbs"), calc: (_d, v) => v("gmbs") },
  vgs: { doc: "Gate–source voltage (PMOS: |VGS|)", kinds: MOS, unit: "V", needs: one("vgs"), calc: (_d, v) => v("vgs") },
  vds: { doc: "Drain–source voltage (PMOS: |VDS|)", kinds: MOS, unit: "V", needs: one("vds"), calc: (_d, v) => v("vds") },
  vbs: { doc: "Bulk–source voltage", kinds: MOS, unit: "V", needs: one("vbs"), calc: (_d, v) => v("vbs") },
  vth: {
    doc: "Threshold voltage (PMOS: |VTH|)", kinds: MOS, unit: "V", byFamily: true,
    needs: d => [vthName(d)], calc: (d, v) => mag(d, v(vthName(d))),
  },
  vdsat: { doc: "Saturation voltage VDS,sat (PMOS: |VDS,sat|)", kinds: MOS, unit: "V", needs: one("vdsat"), calc: (d, v) => mag(d, v("vdsat")) },
  vov: {
    doc: "Overdrive VGS − VTH", kinds: MOS, unit: "V", byFamily: true,
    needs: d => ["vgs", vthName(d)], calc: (d, v) => v("vgs") - mag(d, v(vthName(d))),
  },
  satmargin: {
    doc: "VDS − VDS,sat — positive means saturation", kinds: MOS, unit: "V",
    needs: () => ["vds", "vdsat"], calc: (d, v) => v("vds") - mag(d, v("vdsat")),
  },
  cgs: { doc: "Gate–source capacitance (magnitude)", kinds: MOS, unit: "F", needs: one("cgs"), calc: (_d, v) => Math.abs(v("cgs")) },
  cgd: { doc: "Gate–drain capacitance (magnitude)", kinds: MOS, unit: "F", needs: one("cgd"), calc: (_d, v) => Math.abs(v("cgd")) },
  cgb: { doc: "Gate–bulk capacitance (magnitude)", kinds: MOS, unit: "F", needs: one("cgb"), calc: (_d, v) => Math.abs(v("cgb")) },
  cgg: {
    doc: "Total gate capacitance (level 1–3: Cgs + Cgd + Cgb)", kinds: MOS, unit: "F", byFamily: true,
    needs: d => (d.family === "classic" ? ["cgs", "cgd", "cgb"] : ["cgg"]),
    calc: (d, v) => (d.family === "classic" ? Math.abs(v("cgs")) + Math.abs(v("cgd")) + Math.abs(v("cgb")) : Math.abs(v("cgg"))),
  },
  ft: {
    doc: "Transit frequency gm/(2π·Cgg) (BJT: gm/(2π(Cπ+Cμ)))", kinds: ["mos", "bjt"], unit: "Hz", byFamily: true,
    needs: d => d.kind === "bjt" ? ["gm", "cpi", "cmu"] : ["gm", ...(d.family === "classic" ? ["cgs", "cgd", "cgb"] : ["cgg"])],
    calc: (d, v) => {
      const c = d.kind === "bjt" ? v("cpi") + v("cmu")
        : d.family === "classic" ? Math.abs(v("cgs")) + Math.abs(v("cgd")) + Math.abs(v("cgb")) : Math.abs(v("cgg"));
      return v("gm") / (2 * Math.PI * c);
    },
  },
  gmid: {
    doc: "Transconductance efficiency gm/ID (BJT: gm/IC)", kinds: ["mos", "bjt"], unit: "V⁻¹",
    needs: d => (d.kind === "bjt" ? ["gm", "ic"] : ["gm", "id"]),
    calc: (d, v) => v("gm") / Math.abs(v(d.kind === "bjt" ? "ic" : "id")),
  },
  gmro: {
    doc: "Intrinsic gain gm·ro", kinds: ["mos", "bjt"], unit: "",
    needs: d => (d.kind === "bjt" ? ["gm", "go"] : ["gm", "gds"]),
    calc: (d, v) => v("gm") / v(d.kind === "bjt" ? "go" : "gds"),
  },
  w: { doc: "Channel width", kinds: MOS, unit: "m", needs: one("w"), calc: (_d, v) => v("w") },
  l: { doc: "Channel length", kinds: MOS, unit: "m", needs: one("l"), calc: (_d, v) => v("l") },

  // BJT
  ic: { doc: "Collector current (PNP: magnitude in the forward direction)", kinds: BJT, unit: "A", needs: one("ic"), calc: (d, v) => pol(d) * v("ic") },
  ib: { doc: "Base current", kinds: BJT, unit: "A", needs: one("ib"), calc: (d, v) => pol(d) * v("ib") },
  ie: { doc: "Emitter current (out of the emitter for an NPN)", kinds: BJT, unit: "A", needs: one("ie"), calc: (d, v) => -pol(d) * v("ie") },
  gpi: { doc: "Input conductance gπ", kinds: BJT, unit: "S", needs: one("gpi"), calc: (_d, v) => v("gpi") },
  rpi: { doc: "Input resistance rπ = 1/gπ", kinds: BJT, unit: "Ω", needs: one("gpi"), calc: (_d, v) => 1 / v("gpi") },
  go: { doc: "Output conductance", kinds: BJT, unit: "S", needs: one("go"), calc: (_d, v) => v("go") },
  gmu: { doc: "Base–collector conductance gμ", kinds: BJT, unit: "S", needs: one("gmu"), calc: (_d, v) => v("gmu") },
  cpi: { doc: "Base–emitter capacitance Cπ", kinds: BJT, unit: "F", needs: one("cpi"), calc: (_d, v) => v("cpi") },
  cmu: { doc: "Base–collector capacitance Cμ", kinds: BJT, unit: "F", needs: one("cmu"), calc: (_d, v) => v("cmu") },
  vbe: { doc: "Base–emitter voltage (PNP: |VBE|)", kinds: BJT, unit: "V", needs: one("vbe"), calc: (_d, v) => v("vbe") },
  vbc: { doc: "Base–collector voltage", kinds: BJT, unit: "V", needs: one("vbc"), calc: (_d, v) => v("vbc") },
  vce: { doc: "Collector–emitter voltage VBE − VBC", kinds: BJT, unit: "V", needs: () => ["vbe", "vbc"], calc: (_d, v) => v("vbe") - v("vbc") },
  beta: { doc: "Current gain IC/IB", kinds: BJT, unit: "", needs: () => ["ic", "ib"], calc: (_d, v) => v("ic") / v("ib") },

  // 다이오드
  gd: { doc: "Diode small-signal conductance", kinds: ["diode"], unit: "S", needs: one("gd"), calc: (_d, v) => v("gd") },
  rd: { doc: "Diode small-signal resistance 1/gd", kinds: ["diode"], unit: "Ω", needs: one("gd"), calc: (_d, v) => 1 / v("gd") },
  cd: { doc: "Diode capacitance", kinds: ["diode"], unit: "F", needs: one("cd"), calc: (_d, v) => v("cd") },
  vd: { doc: "Diode voltage", kinds: ["diode"], unit: "V", needs: one("vd"), calc: (_d, v) => v("vd") },

  power: {
    doc: "Power: dissipated by a part, delivered by a source", kinds: ["mos", "bjt", "diode", "res", "cap", "ind", "vsrc", "isrc"], unit: "W",
    needs: d => d.kind === "mos" ? ["id", "vds"] : d.kind === "diode" ? ["id", "vd"] : ["p"],
    calc: (d, v) => d.kind === "mos" ? Math.abs(v("id") * v("vds"))
      : d.kind === "diode" ? v("id") * v("vd")
      : d.kind === "vsrc" || d.kind === "isrc" ? -v("p") : v("p"),
  },
};

/** 함수 이름 (계산기 파서가 인자를 식이 아니라 이름으로 읽을 함수들) */
export const DEVICE_FN_NAMES = new Set([...Object.keys(DEVICE_FNS), "op"]);

/**
 * i(이름) 를 무엇으로 읽는가. 가지 전류 벡터가 있으면 그것, 없으면 소자 파라미터.
 * 가지 전류는 ngspice 가 쓴 부호 그대로다 (전압원은 + 단자로 들어가는 쪽이 양수).
 */
export function currentOf(d: Device): { vector: string } | { param: string } | null {
  if (d.branch) return { vector: `i(${d.name.toLowerCase()})` };
  switch (d.kind) {
    case "res": case "cap": return { param: "i" };
    case "mos": return { param: "id" };
    case "bjt": return { param: "ic" };
    case "diode": return { param: "id" };
    case "isrc": return { param: "c" };
    default: return null;
  }
}

/** 이 소자 함수가 엔진에 물을 벡터 이름들. 물으면 안 되는 이름이면 null 과 이유 */
export function deviceNeeds(fn: string, d: Device, param?: string): { vectors: string[] } | { error: string } {
  if (fn === "op") {
    if (!param) return { error: "op(device, parameter) needs a parameter name" };
    const p = param.toLowerCase();
    const ok = allowedParams(d);
    if (ok && !ok.includes(p)) return { error: badParam(d, p) };
    return { vectors: [vecName(d, p)] };
  }
  const f = DEVICE_FNS[fn];
  if (!f) return { error: `Unknown device function ${fn}` };
  if (!f.kinds.includes(d.kind)) return { error: `${fn}() does not apply to ${kindWord(d)} ${d.ref ?? d.name}` };
  if (f.byFamily && d.kind === "mos" && !d.family) {
    const who = d.ref ?? d.name;
    return {
      error: `${fn}() needs to know the model family, and ${who}'s model${d.model ? " " + d.model : ""} is not one the calculator ` +
        `knows (level 1–3, BSIM3, BSIM4) — they name this value differently. Read the model's own name: op(${who}, vth) or op(${who}, von)`,
    };
  }
  const ok = allowedParams(d);
  const ps = f.needs(d);
  for (const p of ps) if (ok && !ok.includes(p)) return { error: badParam(d, p) };
  return { vectors: ps.map(p => vecName(d, p)) };
}

export function badParam(d: Device, p: string): string {
  const ok = allowedParams(d) ?? [];
  const hint = d.kind === "mos" && d.family === "classic" && p === "vth" ? " — level 1–3 models call the threshold von (vth() reads it for you)"
    : d.kind === "mos" && d.family !== "classic" && p === "von" ? " — BSIM models call the threshold vth"
    : "";
  return `ngspice's ${familyWord(d)} has no "${p}"${hint}. It has: ${ok.join(", ")}`;
}

export function kindWord(d: Device): string {
  return ({ mos: "MOSFET", bjt: "BJT", diode: "diode", res: "resistor", cap: "capacitor", ind: "inductor",
    vsrc: "voltage source", isrc: "current source", other: "part" } as const)[d.kind];
}

function familyWord(d: Device): string {
  if (d.kind === "mos") return d.family === "classic" ? "level 1–3 MOSFET" : d.family === "bsim3" ? "BSIM3 MOSFET" : d.family === "bsim4" ? "BSIM4 MOSFET" : "MOSFET";
  return kindWord(d);
}
