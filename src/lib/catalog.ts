/**
 * 부품 라이브러리의 목차 — 어느 부품이 어느 묶음(라이브러리)의 어느 칸에 있는가, 그리고 사람이 읽는
 * 설명. 왼쪽 부품 목록과 부품 라이브러리 창(Shift+F)이 같이 읽는다.
 *
 * 부품 정의(src/lib/parts.ts)와 따로 두는 것은, 정의는 쓴 것만 **프로젝트 파일에 사본으로** 들어가기
 * 때문이다. 설명이나 찾기 낱말은 문서가 아니라 화면의 것이라 파일에 실을 이유가 없다.
 *
 * 설명은 우리 말로 새로 적었다. 다른 EDA 의 라이브러리 문구나 부품 데이터는 옮겨 오지 않았다.
 */
import type { LibPart } from "../doc/types.ts";
import { BUILTIN } from "./parts.ts";

export interface CatalogGroup { name: string; parts: string[] }
export interface Library {
  id: string;
  name: string;
  /** 왼쪽 목록에 이름과 같이 보일 한 줄 */
  blurb: string;
  groups: CatalogGroup[];
}

export const LIBRARIES: Library[] = [
  {
    id: "passive", name: "Passive",
    blurb: "Ideal resistors, capacitors, inductors and lines",
    groups: [
      { name: "Resistors", parts: ["r", "pot"] },
      { name: "Capacitors", parts: ["c", "cpol"] },
      { name: "Inductors & transformers", parts: ["l", "xfmr"] },
      { name: "Transmission lines", parts: ["tline"] },
    ],
  },
  {
    id: "analog", name: "Analog",
    blurb: "Ideal sources, controlled sources, amplifiers, switches and generic semiconductors",
    groups: [
      { name: "Voltage sources", parts: ["vdc", "vsin", "vpulse", "vpwl"] },
      { name: "Current sources", parts: ["idc", "isin", "ipulse"] },
      { name: "Controlled sources", parts: ["vcvs", "vccs", "ccvs", "cccs"] },
      { name: "Amplifiers", parts: ["opamp", "comparator"] },
      { name: "Switches", parts: ["vswitch"] },
      { name: "Behavioral", parts: ["mult", "bv"] },
      { name: "Diodes & transistors", parts: ["d", "zener", "npn", "pnp", "nmos", "pmos"] },
    ],
  },
  {
    id: "sky130", name: "SKY130",
    blurb: "SkyWater 130 nm process transistors (real BSIM4 models, typical corner)",
    groups: [{ name: "Transistors", parts: ["sky130_nfet", "sky130_pfet", "sky130_pfet_hvt"] }],
  },
  {
    id: "symbols", name: "Symbols",
    blurb: "Reference symbols",
    groups: [{ name: "Ground", parts: ["gnd"] }],
  },
];

/** 부품마다 한두 문장 설명, 찾기 낱말, 뜻이 안 보이는 핀의 역할 */
export interface About { text: string; keys?: string; pins?: Record<string, string> }

const SRC_PINS = { p: "Positive terminal", n: "Negative terminal" };
const I_PINS = { p: "Current enters (SPICE n+)", n: "Current leaves — arrow side (SPICE n−)" };
const V_SENSE_PINS = { cp: "Control +", cn: "Control −" };
const I_SENSE_PINS = { cp: "Sensed current enters", cn: "Sensed current leaves" };
const AMP = { inn: "Inverting input", inp: "Non-inverting input", out: "Output, referenced to ground" };
const BJT = { c: "Collector", b: "Base", e: "Emitter" };
const MOS = { d: "Drain", g: "Gate", s: "Source (the body is tied here)" };

export const ABOUT: Record<string, About> = {
  // 수동 소자
  r: { text: "Ideal linear resistor — Ohm's law, no noise or temperature dependence.", keys: "res ohm" },
  pot: {
    text: "Three-terminal resistor with a movable wiper. It is netlisted as two resistors that split the " +
      "total by the wiper position: 0 puts the wiper at pin 1, 1 at pin 2.",
    keys: "potentiometer trimmer variable resistor rheostat wiper divider",
    pins: { "1": "End 1", w: "Wiper", "2": "End 2" },
  },
  c: { text: "Ideal capacitor — no leakage and no series resistance.", keys: "cap" },
  cpol: {
    text: "Electrolytic-style capacitor. It simulates as an ideal capacitor; the + mark and the curved " +
      "plate only show which way it goes in.",
    keys: "electrolytic tantalum polarized polarised cap",
    pins: { p: "Positive (straight plate)", n: "Negative (curved plate)" },
  },
  l: { text: "Ideal inductor — no winding resistance and no saturation.", keys: "coil choke" },
  xfmr: {
    text: "Two coupled inductors. The turns ratio is √(Ls / Lp) and k is the coupling: 1 is a perfect " +
      "transformer, below 1 adds leakage. The dots mark the ends whose voltages rise together.",
    keys: "transformer coupled inductor mutual inductance isolation k",
    pins: { p1: "Primary, dotted end", p2: "Primary", s1: "Secondary, dotted end", s2: "Secondary" },
  },
  tline: {
    text: "Lossless transmission line with characteristic impedance Z0 and one-way delay TD. " +
      "Each port has a signal pin and a return pin.",
    keys: "coax cable delay line tline t-line",
    pins: { a: "Port A signal", ar: "Port A return", b: "Port B signal", br: "Port B return" },
  },

  // 독립 전원
  vdc: {
    text: "Ideal DC voltage source. 'AC mag' only matters in an AC analysis, where it is the stimulus.",
    keys: "battery supply dc constant", pins: SRC_PINS,
  },
  vsin: {
    text: "Sine wave: offset + amplitude · sin(2π·f·(t − delay) + phase), optionally damped.",
    keys: "ac sine sinusoid signal generator function", pins: SRC_PINS,
  },
  vpulse: {
    text: "Trapezoidal pulse train between a low and a high level, with rise, fall, width and period.",
    keys: "square clock step trapezoid", pins: SRC_PINS,
  },
  vpwl: {
    text: "Piecewise-linear voltage from time–value pairs. 0 0 1m 1 2m 0 rises to 1 V at 1 ms and " +
      "returns to 0 at 2 ms.",
    keys: "pwl ramp arbitrary waveform table", pins: SRC_PINS,
  },
  idc: {
    text: "Ideal DC current source. The current leaves through the pin the arrow points at. Its AC " +
      "magnitude defaults to 0, since a DC current source is usually a bias.",
    keys: "bias tail current sink", pins: I_PINS,
  },
  isin: { text: "Sine current with the same parameters as the sine voltage source, in amperes.", keys: "ac sine current", pins: I_PINS },
  ipulse: { text: "Pulse current between a low and a high level.", keys: "square clock current step", pins: I_PINS },

  // 제어 전원
  vcvs: {
    text: "Voltage-controlled voltage source: V(+, −) = gain · V(C+, C−). The control pins draw no current.",
    keys: "e dependent controlled voltage amplifier buffer",
    pins: { p: "Output +", n: "Output −", ...V_SENSE_PINS },
  },
  vccs: {
    text: "Voltage-controlled current source: I = gm · V(C+, C−), leaving through the top pin. " +
      "The gm of a small-signal transistor model.",
    keys: "g gm transconductance dependent controlled current",
    pins: { ...I_PINS, ...V_SENSE_PINS },
  },
  ccvs: {
    text: "Current-controlled voltage source: V(+, −) = rm · I, where I flows into C+ and out of C−. " +
      "The control pins are a short circuit that measures that current.",
    keys: "h transresistance transimpedance dependent controlled",
    pins: { p: "Output +", n: "Output −", ...I_SENSE_PINS },
  },
  cccs: {
    text: "Current-controlled current source: I = gain · I(C+ → C−), leaving through the top pin. " +
      "The control pins are a short circuit that measures that current.",
    keys: "f current mirror beta gain dependent controlled",
    pins: { ...I_PINS, ...I_SENSE_PINS },
  },

  // 증폭기 · 스위치 · 동작
  opamp: {
    text: "Ideal op-amp: output = gain · (V+ − V−), referenced to ground. No input current, no output " +
      "resistance — use it with feedback.",
    keys: "operational amplifier opamp op amp", pins: AMP,
  },
  comparator: {
    text: "Ideal comparator: the output moves from the low to the high level as V+ rises past V−, over " +
      "the transition width. No input current.",
    keys: "threshold detector level zero crossing", pins: AMP,
  },
  vswitch: {
    text: "Voltage-controlled switch. It closes (on resistance) when V(C+, C−) rises above threshold + " +
      "hysteresis and opens (off resistance) below threshold − hysteresis.",
    keys: "relay sw spst controlled switch",
    pins: { "1": "Switch terminal", "2": "Switch terminal", ...V_SENSE_PINS },
  },
  mult: {
    text: "Analog multiplier: V(out) = k · V(X) · V(Y), referenced to ground. For mixers, modulators " +
      "and squarers.",
    keys: "mixer modulator product multiply",
    pins: { x: "Input X", y: "Input Y", out: "Output, referenced to ground" },
  },
  bv: {
    text: "Voltage set by an expression. V(name) reads a net, time is the simulation time. " +
      "For example 2*V(in) or 1+0.5*sin(2*pi*50*time).",
    keys: "b arbitrary expression formula behavioural function", pins: SRC_PINS,
  },

  // 반도체
  d: { text: "Generic junction diode (Shockley equation) with editable saturation current and emission coefficient.", keys: "rectifier", pins: { a: "Anode", k: "Cathode" } },
  zener: {
    text: "Diode with reverse breakdown at BV. Put the cathode on the higher voltage to clamp or " +
      "regulate near BV.",
    keys: "regulator reference breakdown clamp", pins: { a: "Anode", k: "Cathode" },
  },
  npn: { text: "Generic NPN bipolar transistor with saturation current and βF exposed.", keys: "bjt", pins: BJT },
  pnp: { text: "Generic PNP bipolar transistor with saturation current and βF exposed.", keys: "bjt", pins: BJT },
  nmos: { text: "Level-1 n-channel MOSFET with textbook threshold, transconductance and channel-length modulation.", keys: "mosfet fet nfet", pins: MOS },
  pmos: { text: "Level-1 p-channel MOSFET with textbook threshold, transconductance and channel-length modulation.", keys: "mosfet fet pfet", pins: MOS },
  sky130_nfet: {
    text: "SkyWater 130 nm 1.8 V nFET — the foundry's BSIM4 model at the typical corner. W and L are in " +
      "metres and must fall in one of the model's size bins.",
    keys: "pdk process mosfet nmos", pins: MOS,
  },
  sky130_pfet: {
    text: "SkyWater 130 nm 1.8 V pFET — the foundry's BSIM4 model at the typical corner. W and L are in " +
      "metres and must fall in one of the model's size bins.",
    keys: "pdk process mosfet pmos", pins: MOS,
  },
  sky130_pfet_hvt: {
    text: "SkyWater 130 nm high-threshold pFET — weaker and less leaky than the standard pFET.",
    keys: "pdk process mosfet pmos hvt", pins: MOS,
  },

  gnd: { text: "Ground reference — the net it touches is node 0. Every circuit needs one.", keys: "earth reference 0" },
};

/** 왼쪽 패널에 보일 순서 — 목차 순서 그대로 */
export const PALETTE: string[] = LIBRARIES.flatMap(l => l.groups.flatMap(g => g.parts));

export interface Entry { id: string; part: LibPart; lib: Library; group: CatalogGroup }

/** 목차를 한 줄로 편 것 (목차 순서) */
export const ENTRIES: Entry[] = LIBRARIES.flatMap(lib =>
  lib.groups.flatMap(group => group.parts.map(id => ({ id, part: BUILTIN[id], lib, group }))));

export const entryOf = (id: string): Entry | undefined => ENTRIES.find(e => e.id === id);

/** SPICE 소자 문자들 (여러 줄을 내는 부품은 줄마다) */
export function elementLetters(part: LibPart): string {
  const t = part.spice?.template;
  if (!t) return "—";
  const letters: string[] = [];
  for (const line of t.split("\n")) {
    const head = line.trim();
    const el = (head.startsWith("{") ? part.spice!.element : head[0] ?? "").toUpperCase();
    if (el && !letters.includes(el)) letters.push(el);
  }
  return letters.join(" + ");
}

/** 찾을 때 보는 글자들 (소문자). 한 번만 만든다 */
const hay = new Map<string, string>();
function haystack(e: Entry): string {
  let h = hay.get(e.id);
  if (h === undefined) {
    const a = ABOUT[e.id];
    h = [e.part.name, e.id, e.part.refPrefix, elementLetters(e.part), e.lib.name, e.group.name, a?.keys ?? "", a?.text ?? ""]
      .join(" ").toLowerCase();
    hay.set(e.id, h);
  }
  return h;
}

/**
 * 찾기. 낱말을 모두 품은 부품만, 이름에 걸린 것이 앞에 오게 줄 세운다 (같으면 목차 순서).
 * "cur so" 처럼 낱말 머리만 쳐도 걸린다 — 낱말 하나하나가 글자 안 어디에든 있으면 된다.
 */
export function search(query: string, among: readonly Entry[] = ENTRIES): Entry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...among];
  const scored: Array<{ e: Entry; s: number; i: number }> = [];
  among.forEach((e, i) => {
    const h = haystack(e);
    if (!terms.every(t => h.includes(t))) return;
    const name = e.part.name.toLowerCase();
    const q = terms.join(" ");
    const s = name === q ? 0 : name.startsWith(q) ? 1 : terms.every(t => name.includes(t)) ? 2
      : e.id === q || e.part.refPrefix.toLowerCase() === q ? 2 : 3;
    scored.push({ e, s, i });
  });
  scored.sort((a, b) => a.s - b.s || a.i - b.i);
  return scored.map(x => x.e);
}
