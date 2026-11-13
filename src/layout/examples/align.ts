/** ALIGN 예제 넷리스트 읽기 — ALIGN-public 의 examples/ (BSD-3-Clause, THIRD-PARTY.md) 는 FinFET 모의 공정으로 적혀 있다.
 *
 *    readAlign(text)               .subckt · .param · .model · 소자 · 인스턴스를 읽는다 (계층 그대로)
 *    flattenAlign(net, top?)       맨 위 서브회로를 펼친다 — 하위 인스턴스를 풀어 소자 하나하나로, 파라미터는 값으로
 *    toSky130(flat, constraints)   SKY130 으로 옮긴다: FinFET 의 핀(nfin) 수는 SKY130 셀의 핀(210 nm 피치) 수로, L 은
 *                                  150 nm. 크기는 SKY130 모델이 있는 W 로 맞춘다 (binned). 전원 · 접지 넷을 정한다
 *
 *  ALIGN 의 문법에서 쓰는 것만 읽는다: 줄 잇기(끝의 \ 와 앞의 +), // 와 * 주석, nf= _par0 처럼 = 뒤의 빈칸, 이름으로
 *  된 파라미터(인스턴스의 값 > 서브회로의 .param > 바깥 .param), o<1> 같은 버스 이름. 이름은 대소문자를 가리지 않는다
 *  (ALIGN 처럼 대문자로 둔다).
 */

const NUM = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(meg|mil|[fpnumkgt])?[a-z]*$/i;
const SCALE = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9, t: 1e12, mil: 25.4e-6 };
const GLOBAL_GND = new Set(["0", "GND", "GND!", "VSS!"]);

/** 넷리스트 글 -> 줄 (주석 빼고 이어 붙인 것) */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\/\/.*$/, "").replace(/\s\$.*$/, "").trim();
    if (!l || l.startsWith("*")) continue;
    if (l.startsWith("+") && out.length) { out[out.length - 1] += " " + l.slice(1).trim(); continue; }
    if (out.length && out[out.length - 1].endsWith("\\")) { out[out.length - 1] = out[out.length - 1].slice(0, -1) + " " + l; continue; }
    out.push(l);
  }
  // 끝에 남은 \ 도 지운다
  return out.map((l) => l.replace(/\\$/, "").trim());
}

/** 토큰 — "nf= _par2" 처럼 = 둘레의 빈칸을 붙인다 */
const tokensOf = (line: string): string[] => line.replace(/\s*=\s*/g, "=").split(/\s+/).filter(Boolean);
const kv = (toks: string[]): Record<string, string> => Object.fromEntries(toks.filter((t) => t.includes("=")).map((t) => { const i = t.indexOf("="); return [t.slice(0, i).toUpperCase(), t.slice(i + 1)]; }));

export interface AlignSubckt { name: string; ports: string[]; params: Record<string, string>; devices: any[]; instances: any[] }
export interface AlignNetlist { subckts: Map<string, AlignSubckt>; globals: Record<string, string>; models: Record<string, string>; order: string[] }

export function readAlign(text: string): AlignNetlist {
  const subckts = new Map<string, AlignSubckt>(), globals: Record<string, string> = {}, models: Record<string, string> = {}, order: string[] = [];
  let cur: AlignSubckt | null = null;
  const top: AlignSubckt = { name: "TOP", ports: [], params: {}, devices: [], instances: [] };
  for (const line of logicalLines(text)) {
    const t = tokensOf(line);
    const head = t[0].toLowerCase();
    if (head === ".param") { Object.assign(cur ? cur.params : globals, kv(t.slice(1))); continue; }
    if (head === ".model") { if (t[1]) models[t[1].toUpperCase()] = (t[2] ?? "").toLowerCase(); continue; }
    if (head === ".subckt") {
      const rest = t.slice(2), cut = rest.findIndex((x) => x.includes("="));
      cur = { name: t[1].toUpperCase(), ports: (cut < 0 ? rest : rest.slice(0, cut)).map((p) => p.toUpperCase()),
              params: cut < 0 ? {} : kv(rest.slice(cut)), devices: [], instances: [] };
      subckts.set(cur.name, cur); order.push(cur.name);
      continue;
    }
    if (head === ".ends") { cur = null; continue; }
    if (head.startsWith(".")) continue;                       // .end .include .option .global …
    const into = cur ?? top;
    const name = t[0].toUpperCase(), kind = name[0];
    if (kind === "M") {
      if (t.length < 6) continue;
      into.devices.push({ name, kind: "M", nodes: t.slice(1, 5).map((n) => n.toUpperCase()), model: t[5].toUpperCase(), params: kv(t.slice(6)) });
    } else if (kind === "R" || kind === "C") {
      if (t.length < 3) continue;
      // 값: R= · C= 가 있으면 그것, 없으면 위치 인자 중 수나 파라미터 이름으로 풀리는 첫 것 (펼칠 때 고른다 —
      // "R1 a b resistor r=rl" 의 resistor 는 모델 이름이다)
      const pos = t.slice(3).filter((x) => !x.includes("="));
      into.devices.push({ name, kind, nodes: t.slice(1, 3).map((n) => n.toUpperCase()), values: pos, params: kv(t.slice(3)) });
    } else if (kind === "X") {
      const cut = t.findIndex((x, i) => i > 0 && x.includes("="));
      const body = cut < 0 ? t.slice(1) : t.slice(1, cut);
      into.instances.push({ name, nodes: body.slice(0, -1).map((n) => n.toUpperCase()), sub: (body.at(-1) ?? "").toUpperCase(), params: cut < 0 ? {} : kv(t.slice(cut)) });
    }
  }
  if (top.devices.length || top.instances.length) { subckts.set("TOP", top); order.push("TOP"); }
  return { subckts, globals, models, order };
}

/** 맨 위 — 누구의 인스턴스도 아닌 서브회로. 여럿이면 이름이 hint 와 같은 것, 아니면 소자가 가장 많이 펼쳐지는 것 */
export function topOf(net: AlignNetlist, hint: string | null = null): string {
  const used = new Set<string>();
  for (const s of net.subckts.values()) for (const x of s.instances) used.add(x.sub);
  const roots = net.order.filter((n) => !used.has(n));
  const h = hint?.toUpperCase();
  if (h && roots.includes(h)) return h;
  if (h) { const m = roots.find((r) => r.replace(/[^A-Z0-9]/g, "") === h.replace(/[^A-Z0-9]/g, "")); if (m) return m; }
  const size = (n: string, seen = new Set<string>()): number => {
    const s = net.subckts.get(n);
    if (!s || seen.has(n)) return 0;
    seen.add(n);
    return s.devices.length + s.instances.reduce((a: number, x: any) => a + size(x.sub, new Set(seen)), 0);
  };
  return roots.sort((a, b) => size(b) - size(a))[0] ?? net.order[net.order.length - 1];
}

/** 값 하나 — 수(SPICE 접미사)거나 파라미터 이름 */
function valueOf(v: unknown, scope: Array<Record<string, string>>, depth = 0): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/^'|'$/g, "").replace(/^\{|\}$/g, "");
  const m = NUM.exec(s);
  if (m) return Number(m[1]) * (m[2] ? SCALE[m[2].toLowerCase() as keyof typeof SCALE] : 1);
  if (depth > 20) return null;
  const k = s.toUpperCase();
  for (const sc of scope) if (k in sc) return valueOf(sc[k], scope.slice(scope.indexOf(sc) + 1), depth + 1);
  return null;
}

/**
 * 펼치기. 하위 인스턴스의 소자는 "<인스턴스>_<소자>", 안쪽 넷은 "<인스턴스>_<넷>" 이 된다. 접지(0, gnd!)는 그대로.
 * 돌려주는 것: { top, ports, devices: [{name, kind, nodes, model?, nfin, nf, m, w, value?}], unknown: [하위 회로 이름] }
 */
export interface FlatAlign { top: string; ports: string[]; devices: any[]; unknown: string[] }

export function flattenAlign(net: AlignNetlist, topName: string | null = null): FlatAlign {
  const top = topOf(net, topName);
  const root = net.subckts.get(top)!;
  const devices: any[] = [], unknown = new Set<string>();
  // over: 이 인스턴스가 넘긴 값 — 서브회로 안의 .param 보다 앞선다 (그 .param 은 기본값이다, ALIGN 처럼).
  // mult: 인스턴스의 m — SPICE 처럼 안의 소자를 다 그만큼 병렬로 (안에서 m 을 이름으로 쓰면 값으로 넘어가고 곱하지 않는다)
  const walk = (sub: AlignSubckt, prefix: string, netMap: Map<string, string>, scope: Array<Record<string, string>>,
                over: Record<string, string> = {}, mult = 1): void => {
    const mapNet = (n: string): string => netMap.get(n) ?? (GLOBAL_GND.has(n) ? n : prefix + n);
    const local = [over, sub.params, ...scope];
    for (const d of sub.devices) {
      const nodes = d.nodes.map(mapNet);
      if (d.kind === "M") {
        const p = d.params, num = (k: string, dflt: number | null) => { const v = valueOf(p[k], local); return v == null ? dflt : v; };
        devices.push({ name: prefix + d.name, kind: "M", nodes, model: d.model, nfin: num("NFIN", null), nf: num("NF", 1), m: num("M", 1)! * mult, w: num("W", null), l: num("L", null) });
      } else {
        const named = valueOf(d.params[d.kind === "R" ? "R" : "C"], local);
        const value = named ?? d.values.map((v: string) => valueOf(v, local)).find((v: number | null) => v != null) ?? null;
        devices.push({ name: prefix + d.name, kind: d.kind, nodes, value });
      }
    }
    for (const x of sub.instances) {
      const child = net.subckts.get(x.sub);
      if (!child) { unknown.add(x.sub); continue; }
      const map = new Map(child.ports.map((p: string, i: number) => [p, mapNet(x.nodes[i] ?? `${x.name}_${p}`)]));
      // 인스턴스의 값은 지금 자리에서 셈한 값으로 넘긴다 (nf=_par0 의 _par0 은 부르는 쪽의 것)
      const given: Record<string, string> = Object.fromEntries(Object.entries(x.params as Record<string, string>).map(([k, v]) => { const n = valueOf(v, local); return [k, n == null ? v : String(n)]; }));
      const usesM = [...child.devices, ...child.instances].some((c: any) => /^M$/i.test(String(c.params?.M ?? "")));
      const xm = !usesM && given.M != null ? Math.max(1, Math.round(Number(given.M))) : 1;
      walk(child, `${prefix}${x.name.replace(/^X(?=.)/, "")}_`, map, scope, given, mult * xm);
    }
  };
  walk(root, "", new Map(root.ports.map((p) => [p, p])), [net.globals]);
  return { top, ports: root.ports, devices, unknown: [...unknown] };
}

/** 모델 이름 -> n · p (모르면 null) */
export function mosType(model: string, models: Record<string, string> = {}): "n" | "p" | null {
  const t = models[model];
  if (t === "nmos") return "n";
  if (t === "pmos") return "p";
  const s = model.toLowerCase();
  if (/nfet|nmos/.test(s) || /^n/.test(s)) return "n";
  if (/pfet|pmos/.test(s) || /^p/.test(s)) return "p";
  return null;
}

const FIN = 210e-9;

/**
 * SKY130 로. FinFET 의 nfin(핑거 하나의 핀 수)은 SKY130 셀의 핀 수로 옮긴다 — 셀은 210 nm 피치의 2 ~ 12 핀이다
 * (모자라면 2, 넘치면 핑거를 늘린다: 레이아웃 브리지의 quantize 가 한다). W 는 핑거 전체 폭 = 핀 × 210 nm × nf.
 * 전원 · 접지: const.json 의 PowerPorts · GroundPorts, 없으면 이름으로 (vdd·vcc / vss·gnd·0).
 */
export interface Sky130Design { top: string; ports: string[]; devices: any[]; power: string[]; ground: string[]; notes: string[] }

/**
 * 시뮬레이션이 되는 크기로. SKY130 모델은 L 150 nm 에서 정해진 W 에만 있고(bin), 엔진은 핑거 전체 폭 W 로 bin 을
 * 고른다 (W/nf 가 아니다 — 2.52 µm · nf 2 는 bin 이 없어 멈춘다). 셀의 핀 피치(210 nm)로 그려지는 폭과 bin 이 겹치는
 * 것: 핀 2 · 3 · 4 × 핑거 2 = 0.84 · 1.26 · 1.68 µm 와 핀 2 × 핑거 4 = 1.68 µm (딱 맞다), 핀 12 × 핑거 2 = 5.04 µm
 * (모델은 5 µm 의 bin, 0.8 % — 브리지는 1 % 안이라 말없이 그린다).
 *
 * 핀 수는 원래 핀 수마다 하나로 정한다 — ALIGN 은 거울 · 차동쌍처럼 한 블록에 드는 소자의 핀 수가 같아야 그린다. 원래가
 * 2 · 3 · 4 · 12 핀이면 그대로, 아니면 그 핀 수의 소자가 다 전체 폭(핀 × 핑거 × 배수) 10 % 안에 드는 가장 큰 단위
 * (핑거가 가장 적다), 없으면 가장 덜 틀리는 것. 핑거 수는 그 폭이 bin 이면 그대로, 아니면 2 로 두고 배수로 폭을 맞춘다.
 */
const UNIT_FINS = [12, 4, 3, 2];
const binW = (fins: number, nf: number): number | null =>
  fins === 12 && nf === 2 ? 5e-6 : [4, 6, 8].includes(fins * nf) && fins >= 2 ? fins * nf * FIN : null;

function sizeTo(f: number, nf: number, m: number, fp: number): { fins: number; nf: number; m: number; wTotal: number } {
  if (fp === f && nf % 2 === 0 && binW(f, nf) != null) return { fins: f, nf, m, wTotal: binW(f, nf)! };
  const c = Math.max(1, Math.round((f * nf * m) / (2 * fp)));
  return { fins: fp, nf: 2, m: c, wTotal: binW(fp, 2)! };
}

function unitFins(f: number, devs: Array<{ nf: number; m: number }>): number {
  if (UNIT_FINS.includes(f)) return f;
  let best = 2, bestErr = Infinity;
  for (const fp of UNIT_FINS) {
    const err = Math.max(...devs.map((d) => {
      const k = f * d.nf * d.m, s = sizeTo(f, d.nf, d.m, fp);
      return Math.abs(s.fins * s.nf * s.m - k) / k;
    }));
    if (err <= 0.1) return fp;
    if (err < bestErr - 1e-9) { best = fp; bestErr = err; }
  }
  return best;
}

/** 소자들의 크기를 SKY130 bin 으로 (fins · nf · m · wTotal 을 고쳐 쓴다) */
export function binSizes(devs: Array<{ fins: number; nf: number; m: number; wTotal?: number }>, units: Record<number, number> = {}): void {
  const byFins = new Map<number, typeof devs>();
  for (const d of devs) { if (!byFins.has(d.fins)) byFins.set(d.fins, []); byFins.get(d.fins)!.push(d); }
  for (const [f, ds] of byFins) {
    const fp = units[f] ?? unitFins(f, ds);
    for (const d of ds) Object.assign(d, sizeTo(f, d.nf, d.m, fp));
  }
}

export function toSky130(flat: FlatAlign, constraints: Array<Record<string, any>> = [], models: Record<string, string> = {},
                         units: Record<number, number> = {}): Sky130Design {
  const power = new Set<string>(), ground = new Set<string>();
  for (const c of constraints ?? []) {
    if (c.constraint === "PowerPorts") for (const p of c.ports ?? []) power.add(String(p).toUpperCase());
    if (c.constraint === "GroundPorts") for (const p of c.ports ?? []) ground.add(String(p).toUpperCase());
  }
  const nets = new Set<string>(flat.devices.flatMap((d: any) => d.nodes));
  if (!power.size) for (const n of nets) if (/^(VDD|VCC|AVDD|DVDD)\w*$/.test(n)) power.add(n);
  if (!ground.size) for (const n of nets) if (/^(VSS|GND|AVSS|DVSS|0)\w*$/.test(n) || GLOBAL_GND.has(n)) ground.add(n);
  const notes: string[] = [];
  const devices = flat.devices.map((d: any) => {
    if (d.kind !== "M") return d;
    const type = mosType(d.model, models);
    if (!type) { notes.push(`${d.name}: model ${d.model} is neither n nor p — left out`); return null; }
    let fins = d.nfin != null ? Math.round(d.nfin) : d.w != null ? Math.round(d.w / FIN) : 2;
    fins = Math.max(1, fins);
    const nf = Math.max(1, Math.round(d.nf ?? 1)), m = Math.max(1, Math.round(d.m ?? 1));
    const hvt = /hvt/i.test(d.model) && type === "p";
    if (hvt) notes.push(`${d.name}: drawn as a standard pFET — SKY130 has no HVT pFET model at L = 150 nm`);
    return { ...d, type, hvt: false, fins, nf, m };
  }).filter(Boolean);
  binSizes(devices.filter((d: any) => d.kind === "M"), units);
  return { top: flat.top, ports: flat.ports, devices, power: [...power], ground: [...ground], notes };
}
