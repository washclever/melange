/**
 * 회로도 -> 레이아웃 넷리스트. melange 의 시트 하나를 앞단(src/layout/front)이 읽는 SKY130 .subckt 로 바꾼다.
 *
 * 레이아웃에 들어가는 것은 **트랜지스터뿐**이다:
 *
 *   SKY130 nFET / pFET / pFET HVT   그대로 (sky130_fd_pr__nfet_01v8 ...)
 *   일반 NMOS / PMOS                SKY130 nFET / pFET 로 바꿔 그린다 (교과서 모델이라 크기만 가져간다 — 알림)
 *   그 밖 (신호원, R, C, op-amp...) 빠진다. 그 소자에 닿은 넷은 블록의 핀이 된다
 *
 * 크기: ALIGN 의 SKY130 셀은 핀(fin) 피치 210 nm 로 폭을 재고 핑거 수가 짝수여야 한다. 시뮬레이션의 W 는 핑거 전체
 * 폭이므로 핑거 하나의 폭 = W / nf 로 나눠 핀 수로 맞춘다 (2 ~ 12 핀). nf 가 홀수면 둘로 쪼개고, 핑거가 너무 넓으면
 * 핑거를 늘린다. L 은 셀이 150 nm 로 고정이다. 바뀐 것은 notes 로 알린다.
 *
 * 몸통: melange 의 기호에는 몸통 핀이 없어 시뮬레이션은 소스에 묶는다. 실리콘에서는 nFET 의 몸통이 기판(접지),
 * pFET 은 n 우물(전원)이라 기본은 그쪽에 묶는다 (body: "source" 를 주면 시뮬레이션과 같게).
 *
 * 핀: 빠진 소자에 닿은 넷, 이름표·전원 기호가 붙은 넷, 접지. 트랜지스터끼리만 잇는 이름 없는 넷은 안쪽 넷이다.
 * 시트가 핀을 정해 두었으면(sheet.layoutPins — ALIGN 예제) 이름표 대신 그 목록이다.
 * 전원·접지는 PowerPorts·GroundPorts 제약으로 같이 보낸다 (D/S 바로잡기와 대칭 찾기가 그것을 기준으로 한다).
 */
import type { Sheet, Part } from "../doc/types.ts";
import type { LibPart } from "../lib/parts.ts";
import type { Extraction } from "../net/extract.ts";
import { parseEng } from "../doc/units.ts";

export interface LayoutNetlist {
  /** 앞단에 줄 SPICE (.subckt 하나) */
  text: string;
  /** 맨 위 서브회로 이름 */
  top: string;
  /** { 서브회로: [제약...] } — ALIGN 의 <서브회로>.const.json 과 같은 꼴 */
  constraints: Record<string, object[]>;
  /** 부품 지정자 -> 레이아웃 소자 이름 (대문자) */
  devices: Record<string, string>;
  /** 레이아웃 넷 이름(대문자) -> 회로도 넷 이름 */
  nets: Record<string, string>;
  /** 블록의 핀 (레이아웃 넷 이름) */
  ports: string[];
  /** 레이아웃에서 빠진 부품 지정자 */
  excluded: string[];
  /** 사용자에게 알릴 것 (바뀐 크기, 바꿔 그린 모델...) */
  notes: string[];
}

export interface BridgeOptions {
  /** 몸통을 어디에 묶나 — "rails"(기본: nFET 은 접지, pFET 은 전원) | "source"(시뮬레이션과 같게) */
  body?: "rails" | "source";
  /** 서브회로 이름 (없으면 "melange") */
  name?: string;
}

const FIN = 210e-9;                         // ALIGN-pdk-sky130 의 Fin_pitch
const MAX_FIN = 12, MIN_FIN = 2;            // 셀 높이 28 핀에 위아래 더미 8 핀씩
const MODELS: Record<string, { model: string; n: boolean; generic?: boolean }> = {
  sky130_nfet: { model: "sky130_fd_pr__nfet_01v8", n: true },
  sky130_pfet: { model: "sky130_fd_pr__pfet_01v8", n: false },
  sky130_pfet_hvt: { model: "sky130_fd_pr__pfet_01v8_hvt", n: false },
  nmos: { model: "sky130_fd_pr__nfet_01v8", n: true, generic: true },
  pmos: { model: "sky130_fd_pr__pfet_01v8", n: false, generic: true },
};
/** 앞단의 모델 이름 (서브회로 이름과 겹치면 안 된다) */
const RESERVED = new Set(["NMOS", "PMOS", "CAP", "RES", "IND", ...Object.values(MODELS).map((m) => m.model.toUpperCase()),
  "SKY130_FD_PR__PFET_01V8_LVT", "SKY130_FD_PR__NFET_01V8_LVT", "SKY130_FD_PR__NFET_01V8_HVT", "NMOS_RVT", "PMOS_RVT",
  "NMOS_LVT", "PMOS_LVT", "NMOS_HVT", "PMOS_HVT", "NFET", "PFET", "RESISTOR", "INDUCTOR"]);

/** SPICE 식별자로 (토큰 문자: 공백 { } ( ) = ; * 는 안 된다). 대문자로 */
const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase() || "_";
const nm = (m: number) => `${Math.round(m * 1e9)}e-9`;

/** 이 부품이 레이아웃 트랜지스터인가 */
export function layoutModel(part: Part, library: Record<string, LibPart>) {
  return MODELS[library[part.lib]?.id ?? part.lib] ?? null;
}

/** 핑거 폭을 핀 수로: [핑거 수(짝수), 핑거당 핀] */
export function quantize(totalW: number, nf: number): [number, number] {
  let fingers = Math.max(1, Math.round(nf));
  if (fingers % 2) fingers *= 2;
  let fins = Math.round(totalW / fingers / FIN);
  while (fins > MAX_FIN) { fingers *= 2; fins = Math.round(totalW / fingers / FIN); }
  return [fingers, Math.max(MIN_FIN, fins)];
}

export function layoutNetlist(sheet: Sheet, library: Record<string, LibPart>, ex: Extraction, opts: BridgeOptions = {}): LayoutNetlist {
  const body = opts.body ?? "rails";
  const notes: string[] = [];
  // 같은 종류의 알림은 한 줄로 (부품 이름만 늘어놓는다)
  const groups = new Map<string, string[]>();
  const group = (k: string, ref: string) => { const g = groups.get(k); if (g) g.push(ref); else groups.set(k, [ref]); };
  const fets: Part[] = [], others: Part[] = [];
  for (const p of sheet.parts) {
    if (!library[p.lib]?.spice) continue;              // 기호(GND 등)
    (layoutModel(p, library) ? fets : others).push(p);
  }
  if (!fets.length) throw new Error("There are no transistors on this sheet to lay out.");

  // 넷 이름: 회로도 이름 -> 레이아웃 이름 (식별자로, 접지는 VSS)
  const netOf = new Map<string, string>(), used = new Set<string>();
  const layoutNet = (net: string): string => {
    let v = netOf.get(net);
    if (v) return v;
    let base = net === "0" ? "VSS" : ident(net);
    if (/^\d/.test(base)) base = "N" + base;
    v = base;
    for (let k = 1; used.has(v); k++) v = `${base}_${k}`;
    used.add(v);
    netOf.set(net, v);
    return v;
  };
  // 이름이 정해진 넷부터 이름을 잡는다 (접지·전원·이름표가 이름을 지키게)
  const labelled = new Set<string>(), power = new Set<string>();
  for (const l of sheet.labels) {
    const net = ex.netAt(l.at);
    if (!net) continue;
    labelled.add(net);
    if (l.kind === "power") power.add(net);
  }
  const pinNet = (p: Part, pin: string) => ex.pinNet.get(p.id + ":" + pin) ?? null;
  const fetNets = new Set<string>();
  for (const p of fets) for (const pin of ["d", "g", "s"]) { const n = pinNet(p, pin); if (n) fetNets.add(n); }
  const hasGnd = fetNets.has("0");
  if (hasGnd) layoutNet("0");
  for (const n of [...fetNets].filter((n) => labelled.has(n)).sort()) layoutNet(n);

  // 전원 기호가 없으면, 접지에 음극이 닿은 직류 전압원 가운데 pFET 의 소스에 닿은 것을 전원으로 본다
  // (입력 바이어스처럼 게이트에만 닿은 전압원은 전원이 아니다). pFET 이 없으면 가장 높은 것 하나
  if (!power.size) {
    const pSources = new Set(fets.filter((p) => !layoutModel(p, library)!.n).map((p) => pinNet(p, "s")).filter(Boolean));
    const cands: Array<[string, number]> = [];
    for (const p of others) {
      if ((library[p.lib]?.id ?? p.lib) !== "vdc") continue;
      const pos = pinNet(p, "p"), neg = pinNet(p, "n"), v = parseEng(p.params.dc);
      if (pos && neg === "0" && v != null && v > 0 && fetNets.has(pos)) cands.push([pos, v]);
    }
    const onP = cands.filter(([n]) => pSources.has(n));
    if (onP.length) for (const [n] of onP) power.add(n);
    else if (cands.length && !pSources.size) power.add(cands.sort((a, b) => b[1] - a[1])[0][0]);
  }
  const touchedByOthers = new Set<string>();
  for (const p of others) for (const pin of library[p.lib].symbol.pins) { const n = pinNet(p, pin.id); if (n) touchedByOthers.add(n); }

  const ports: string[] = [];
  // 시트가 핀을 정해 두었으면(layoutPins) 그것 — 넷 라벨은 핀을 정하지 않는다. 트랜지스터가 아닌 부품에 닿은 넷은 늘 핀이다
  const explicit = sheet.layoutPins?.length ? new Set(sheet.layoutPins.map((n) => n.toLowerCase())) : null;
  const isPort = (n: string) => n === "0" || power.has(n) || touchedByOthers.has(n) ||
    (explicit ? explicit.has(n.toLowerCase()) : labelled.has(n));
  for (const n of fetNets) if (isPort(n)) ports.push(layoutNet(n));
  ports.sort();
  const gndName = hasGnd ? layoutNet("0") : null;
  const pwrNames = [...power].filter((n) => fetNets.has(n)).map(layoutNet).sort();

  // 소자 줄
  const devices: Record<string, string> = {}, takenDev = new Set<string>();
  const lines: string[] = [];
  for (const p of [...fets].sort((a, b) => a.ref.localeCompare(b.ref, "en", { numeric: true }))) {
    const m = layoutModel(p, library)!;
    // SPICE 는 첫 글자로 소자를 가린다 — 트랜지스터는 M 으로 시작해야 한다 (겹치면 _1, _2 …)
    const base = ident(p.ref).startsWith("M") ? ident(p.ref) : "M" + ident(p.ref);
    let dn = base;
    for (let k = 1; takenDev.has(dn); k++) dn = `${base}_${k}`;
    takenDev.add(dn);
    devices[p.ref] = dn;
    const d = pinNet(p, "d"), g = pinNet(p, "g"), s = pinNet(p, "s");
    if (!d || !g || !s) throw new Error(`${p.ref}: a pin is not connected.`);
    let b = s;
    if (body === "rails") {
      if (m.n && hasGnd) b = "0";
      else if (!m.n && pwrNames.length) b = [...power].find((n) => fetNets.has(n))!;
    }
    const w = parseEng(p.params.w), l = parseEng(p.params.l);
    const nf = parseEng(p.params.nf) ?? 1, mult = Math.max(1, Math.round(parseEng(p.params.mult) ?? 1));
    if (w == null || w <= 0) throw new Error(`${p.ref}: channel width "${p.params.w}" is not a number.`);
    const [fingers, fins] = quantize(w, nf);
    const real = fingers * fins * FIN;
    if (Math.abs(real - w) / w > 0.01)
      notes.push(`${p.ref}: width ${fmt(w)} drawn as ${fingers} fingers x ${fins} fins = ${fmt(real)} (fin pitch 210 nm).`);
    else if (fingers !== Math.round(nf)) group("fingers", p.ref);
    if (l != null && Math.abs(l - 150e-9) > 1e-12) group(`L ${fmt(l)}`, p.ref);
    if (m.generic) group(m.n ? "generic NMOS" : "generic PMOS", p.ref);
    lines.push(`${dn} ${layoutNet(d)} ${layoutNet(g)} ${layoutNet(s)} ${layoutNet(b)} ${m.model} w=${nm(fins * FIN)} l=150e-9 nf=${fingers} m=${mult}`);
  }
  // 몸통 넷이 핀에 없으면 (rails 로 묶었는데 원래 트랜지스터가 안 닿던 넷) 핀으로 더한다
  for (const n of [gndName, ...pwrNames]) if (n && !ports.includes(n)) ports.push(n);

  let top = ident(opts.name ?? "melange");
  if (RESERVED.has(top) || /^\d/.test(top)) top = "LAYOUT_" + top;
  for (const [k, refs] of groups) {
    const who = refs.join(", ");
    if (k === "fingers") notes.push(`${who}: drawn with an even finger count (the cells need one).`);
    else if (k.startsWith("L ")) notes.push(`${who}: ${k} — the SKY130 cells are drawn at L = 150 nm.`);
    else notes.push(`${who}: ${k} drawn as the SKY130 ${k.endsWith("NMOS") ? "nFET" : "pFET"}.`);
  }
  const excluded = others.map((p) => p.ref);
  if (excluded.length) notes.push(`Not in the layout (not transistors): ${excluded.join(", ")}.`);
  if (!ports.length) throw new Error("The transistors have no connection to the rest of the circuit (no pins).");

  const constraints: object[] = [];
  if (pwrNames.length) constraints.push({ constraint: "PowerPorts", ports: pwrNames });
  if (gndName) constraints.push({ constraint: "GroundPorts", ports: [gndName] });
  const text = [`.subckt ${top} ${ports.join(" ")}`, ...lines, `.ends ${top}`, ""].join("\n");
  const nets: Record<string, string> = {};
  for (const [k, v] of netOf) nets[v] = k;
  return { text, top, constraints: constraints.length ? { [top]: constraints } : {}, devices, nets, ports, excluded, notes };
}

function fmt(m: number) {
  const u = m * 1e6;
  return u >= 1 ? `${+u.toFixed(3)} um` : `${+(m * 1e9).toFixed(1)} nm`;
}
