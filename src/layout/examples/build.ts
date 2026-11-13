/**
 * ALIGN 예제 -> melange 프로젝트 (SKY130 회로도). Examples 메뉴의 레이아웃 예제가 이것으로 열린다.
 *
 * 넷리스트를 펼쳐(align.ts) 트랜지스터를 SKY130 부품으로 놓고 넷을 배선으로 잇는다 — 어시스턴트의 connect 와 같은
 * doc/wiring.ts 의 connectPins 라, 배선이 다른 것을 건드리지 않고, 길이 없으면 넷 라벨로 잇는다. 접지는 GND 기호,
 * 전원은 전원 기호, 원래 서브회로의 핀은 넷 라벨이다.
 *
 * **레이아웃 블록의 핀은 시트의 layoutPins 다** — 원래 서브회로의 핀 그대로. 길이 없어 라벨로 이은 안쪽 넷이
 * 핀이 되지 않게 (브리지는 layoutPins 가 있으면 이름표로 핀을 정하지 않는다).
 *
 * 놓는 자리: 직렬로 쌓인 트랜지스터를 한 기둥으로 (pFET 위, nFET 아래), 기둥은 넷리스트 차례. R · C 는 맨 아래 줄.
 * 크기: FinFET 의 핀 수를 SKY130 셀의 핀 수로 (W = 핀 × 210 nm × nf), L 은 0.15 µm — 레이아웃 브리지가 쓰는 그대로다.
 */
import { readAlign, flattenAlign, toSky130 } from "./align.ts";
import { builder } from "../../lib/demos.ts";
import { connectPins, connectToNet, type PinRef } from "../../doc/wiring.ts";
import { SheetIndex } from "../../doc/sheet-index.ts";
import { PROBE_COLORS, pinAt, uid, type Part, type Project, type SimSettings } from "../../doc/types.ts";
import { extractNets } from "../../net/extract.ts";

const COLS = 10, DX = 160, DY = 100;

export interface AlignExampleSpec {
  id: string;
  /** 메뉴와 프로젝트의 이름 */
  title: string;
  /** ALIGN-public examples/ 의 넷리스트 */
  sp: string;
  /** <이름>.const.json (PowerPorts · GroundPorts 만 쓴다) */
  constraints: Array<Record<string, unknown>>;
  /** 한 줄 설명 */
  about: string;
  /** 테스트벤치 — 열고 Run 을 누르면 바로 돈다 (benches.ts) */
  bench?: Bench;
  /** 원래 핀 수 -> SKY130 단위의 핀 수 (align.ts binSizes 가 고르는 것 대신) */
  units?: Record<number, number>;
  /** 넷리스트 맨 바깥 .param 을 바꾼다 (이름 -> 값) — ALIGN 을 다른 파라미터로 돌리는 것과 같다 */
  params?: Record<string, string>;
}

/**
 * 테스트벤치. 원래 서브회로의 핀에만 단다 — 안쪽 넷에 달면 그 넷이 레이아웃 핀이 된다 (브리지는 트랜지스터 말고 다른
 * 부품이 닿은 넷을 핀으로 둔다). 넷 이름은 넷리스트의 것 (대소문자 무관). 부품은 회로 왼쪽에 한 줄로 선다.
 */
export interface Bench {
  /** 전원 전압 (기본 1.8 V) */
  vdd?: string;
  /** 전원 말고 다는 것. idc 는 from(기본: 전원)에서 net 으로 흘러드는 전류, bv 는 net 의 전압이 식 (params.value) */
  sources: Array<{ net: string; lib: "vdc" | "vpulse" | "vsin" | "idc" | "bv"; params: Record<string, string>; from?: string }>;
  /** 부하 — net 에서 to(기본: 접지)로 */
  loads?: Array<{ net: string; lib: "c" | "r"; value: string; to?: string }>;
  /** 넷리스트에 값이 없거나 치수로만 적힌 R · C (소자 이름 -> 값) */
  values?: Record<string, string>;
  /** 레이아웃 핀으로 더할 넷 — 원래 넷리스트가 핀으로 내지 않은 게이트 */
  pins?: string[];
  sim: SimSettings;
  /** 파형 패널이 그리는 넷 */
  probes: string[];
  /** 계산기 줄 */
  calc: string[];
  /**
   * 계산기 본보기(Metrics)의 자리 — out · in · outp · outn · inp · inn · m · m2 · ctrl · ref (src/calc/metrics.ts hints). 넷은 넷리스트의
   * 이름, 소자는 회로도의 이름 (XMN2). 안 적으면 supply 는 전원 전압원, vdd 는 전원 넷, vin 은 in 에 단 전원이다
   */
  roles?: Record<string, string>;
}

const um = (m: number) => `${Number((m * 1e6).toPrecision(4))}u`;
const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();

export function buildAlignExample(spec: AlignExampleSpec): Project {
  const net = readAlign(spec.sp);
  for (const [k, v] of Object.entries(spec.params ?? {})) net.globals[k.toUpperCase()] = v;
  const flat = flattenAlign(net, spec.id);
  const sky = toSky130(flat, spec.constraints, net.models, spec.units);
  const b = builder(spec.title);
  const { project, sheet } = b;
  const lib = project.library;

  // ---------------------------------------------------------------- 놓기
  // 직렬로 쌓인 트랜지스터(드레인-소스 넷을 둘만 쓰는 짝)를 한 기둥으로 — 위에서부터 pFET, 그 아래 nFET. 교과서의
  // 그림처럼 전원 쪽이 위, 접지 쪽이 아래다. 게이트는 다 왼쪽 (pFET 은 뒤집고 거울). 기둥은 넷리스트 차례로 왼쪽부터,
  // 한 줄에 COLS 개씩 띠를 이룬다. R · C 는 맨 아래 줄.
  const mos = sky.devices.filter((d: any) => d.kind === "M");
  const passives = sky.devices.filter((d: any) => d.kind !== "M");
  const rails = new Set([...sky.power, ...sky.ground]);
  const topNet = (d: any) => (d.type === "n" ? d.nodes[0] : d.nodes[2]);     // nFET 은 드레인이 위, pFET 은 소스가 위
  const botNet = (d: any) => (d.type === "n" ? d.nodes[2] : d.nodes[0]);
  const uses = new Map<string, number>();                                    // 드레인 · 소스 · R · C 단자 수
  for (const d of mos) for (const n of [d.nodes[0], d.nodes[2]]) uses.set(n, (uses.get(n) ?? 0) + 1);
  for (const d of passives) for (const n of d.nodes) uses.set(n, (uses.get(n) ?? 0) + 1);
  const below = new Map<any, any>(), above = new Map<any, any>();
  for (const a of mos) {
    const n = botNet(a);
    if (rails.has(n) || uses.get(n) !== 2) continue;
    const b2 = mos.find((q: any) => q !== a && topNet(q) === n && !above.has(q) && !(a.type === "n" && q.type === "p"));
    if (b2 && !below.has(a)) { below.set(a, b2); above.set(b2, a); }
  }
  const order = new Map(mos.map((d: any, i: number) => [d, i]));
  const chains: any[][] = [];
  const seen = new Set<any>();
  for (const d of mos) {
    if (above.has(d) || seen.has(d)) continue;
    const c: any[] = [];
    for (let q = d; q && !seen.has(q); q = below.get(q)) { seen.add(q); c.push(q); }
    chains.push(c);
  }
  for (const d of mos) if (!seen.has(d)) { seen.add(d); chains.push([d]); }  // 고리 (드물다)
  chains.sort((x, y) => Math.min(...x.map((d) => order.get(d)!)) - Math.min(...y.map((d) => order.get(d)!)));
  const placed: Array<{ dev: any; part: Part }> = [];
  const put = (d: any, at: [number, number]) => {
    let part: Part;
    if (d.kind === "M") {
      const libId = d.type === "n" ? "sky130_nfet" : d.hvt ? "sky130_pfet_hvt" : "sky130_pfet";
      part = b.part(libId, at, { w: um(d.wTotal), l: "0.15u", nf: String(d.nf), mult: String(d.m) }, d.type === "p" ? 180 : 0, d.type === "p");
    } else {
      const given = spec.bench?.values?.[d.name];
      part = b.part(d.kind === "R" ? "r" : "c", at, { value: given ?? (d.value != null ? String(d.value) : d.kind === "R" ? "1k" : "1p") }, 90);
    }
    part.ref = (d.kind === "M" ? "X" : d.kind) + ident(d.kind === "M" ? d.name : d.name.slice(1));
    placed.push({ dev: d, part });
  };
  let y0 = 0;
  for (let i = 0; i < chains.length; i += COLS) {
    const band = chains.slice(i, i + COLS);
    const up = Math.max(0, ...band.map((c) => c.filter((d) => d.type === "p").length));
    const down = Math.max(0, ...band.map((c) => c.filter((d) => d.type === "n").length));
    const mid = y0 + up * DY;
    band.forEach((c, k) => {
      const ps = c.filter((d) => d.type === "p"), ns = c.filter((d) => d.type === "n");
      ps.forEach((d, j) => put(d, [k * DX, mid - (ps.length - j) * DY]));
      ns.forEach((d, j) => put(d, [k * DX, mid + j * DY]));
    });
    y0 = mid + down * DY + DY;
  }
  passives.forEach((d: any, i: number) => put(d, [(i % COLS) * DX, y0 + Math.floor(i / COLS) * DY]));

  // ---------------------------------------------------------------- 잇기
  const pinOf = (part: Part, id: string): PinRef => {
    const l = lib[part.lib];
    return { part, lib: l, i: l.symbol.pins.findIndex((p) => p.id === id) };
  };
  const pinsByNet = new Map<string, PinRef[]>();
  for (const { dev, part } of placed) {
    const ids = dev.kind === "M" ? ["d", "g", "s"] : ["1", "2"];
    ids.forEach((pid, k) => {
      const n = dev.nodes[k];
      if (!pinsByNet.has(n)) pinsByNet.set(n, []);
      pinsByNet.get(n)!.push(pinOf(part, pid));
    });
  }
  const ground = new Set(sky.ground.map((n: string) => n.toUpperCase()));
  const power = new Set(sky.power.map((n: string) => n.toUpperCase()));
  const ports = new Set([...sky.ports, ...(spec.bench?.pins ?? [])].map((n: string) => n.toUpperCase()));
  const index = new SheetIndex();
  const sync = () => index.sync(sheet, lib);
  sync();
  const apply = (w: { cmd: { apply(s: typeof sheet): void } } | string | null) => {
    if (w && typeof w !== "string") { w.cmd.apply(sheet); sync(); }
  };
  const name = (n: string) => (n === "0" ? "0" : n.toLowerCase());
  const where = (p: PinRef) => { const l = p.lib.symbol.pins[p.i].at; return [p.part.at[0] + l[0], p.part.at[1] + l[1]]; };

  // 안쪽 넷과 핀 넷 — 가까운 핀부터 배선으로 (최소 신장 트리 차례)
  for (const [n, pins] of pinsByNet) {
    if (ground.has(n) || power.has(n) || pins.length < 2) continue;
    const done = [pins[0]], rest = pins.slice(1);
    while (rest.length) {
      let bi = 0, bj = 0, bd = Infinity;
      for (let i = 0; i < rest.length; i++) {
        const [x, y] = where(rest[i]);
        for (let j = 0; j < done.length; j++) {
          const [u, v] = where(done[j]);
          const d = Math.abs(x - u) + Math.abs(y - v);
          if (d < bd) { bd = d; bi = i; bj = j; }
        }
      }
      const p = rest.splice(bi, 1)[0];
      apply(connectPins(sheet, lib, index, done[bj], p, name(n)));
      done.push(p);
    }
  }
  // 원래 서브회로의 핀 — 넷 라벨 (이미 그 이름이면 그대로)
  for (const n of ports) {
    if (ground.has(n) || power.has(n)) continue;
    const p = pinsByNet.get(n)?.[0];
    if (p) apply(connectToNet(sheet, lib, index, p, name(n), "label"));
  }
  // 접지와 전원 — 핀마다 기호
  for (const [n, pins] of pinsByNet) {
    if (ground.has(n)) for (const p of pins) apply(connectToNet(sheet, lib, index, p, "0"));
    else if (power.has(n)) for (const p of pins) apply(connectToNet(sheet, lib, index, p, name(n), "power"));
  }

  // 레이아웃 블록의 핀 = 원래 서브회로의 핀 (전원 · 접지는 브리지가 늘 핀으로 둔다)
  sheet.layoutPins = [...ports].filter((n) => !ground.has(n) && !power.has(n) && pinsByNet.has(n)).map(name);

  // ---------------------------------------------------------------- 테스트벤치
  if (spec.bench) {
    const tb = spec.bench, supply = [...power][0];
    const left = Math.min(0, ...sheet.parts.map((q) => q.at[0])) - 2 * DX;
    let row = 0;
    const at = (): [number, number] => [left - Math.floor(row / 8) * DX, (row++ % 8) * DY];
    /** 핀 하나를 넷에: 접지는 GND 기호, 전원은 전원 기호, 나머지는 넷 라벨 */
    const tie = (part: Part, pin: string, n: string) => {
      const N = n.toUpperCase();
      const ref = pinOf(part, pin);
      if (n === "0" || ground.has(N)) apply(connectToNet(sheet, lib, index, ref, "0"));
      else if (power.has(N)) apply(connectToNet(sheet, lib, index, ref, name(N), "power"));
      else apply(connectToNet(sheet, lib, index, ref, name(N), "label"));
    };
    /** 두 핀짜리 부품 — 심볼의 첫 핀을 first 에, 둘째 핀을 second 에 */
    const put2 = (libId: string, params: Record<string, string>, first: string, second: string, rot: 0 | 90 | 180 = 0) => {
      const part = b.part(libId, at(), params, rot);
      // 회로의 R · C 는 넷리스트의 이름을 쓴다 (C3 ...) — 겹치면 다음 빈 번호로
      const pre = part.ref.replace(/\d+$/, "");
      for (let k = Number(part.ref.slice(pre.length)) || 1; sheet.parts.some((q) => q !== part && q.ref === part.ref); k++) part.ref = pre + k;
      sync();
      const pins = lib[libId].symbol.pins;
      tie(part, pins[0].id, first);
      tie(part, pins[1].id, second);
      return part;
    };
    const benchParts: Array<{ net: string; part: Part }> = [];
    if (supply) benchParts.push({ net: supply, part: put2("vdc", { dc: tb.vdd ?? "1.8", ac: "0" }, supply, "0") });
    for (const src of tb.sources) {
      // 전류원은 첫 핀에서 둘째 핀으로 흘린다 — 뒤집어 세우면 첫 핀이 위: 위(from)에서 아래(net)로 흘러든다
      const part = src.lib === "idc" ? put2("idc", src.params, src.from ?? supply ?? "0", src.net, 180) : put2(src.lib, src.params, src.net, "0");
      benchParts.push({ net: (src.lib === "idc" && src.net === "0" ? src.from! : src.net).toUpperCase(), part });
    }
    for (const ld of tb.loads ?? []) put2(ld.lib, { value: ld.value }, ld.net, ld.to ?? "0", 90);
    // 프로브: 그 넷에 닿은 핀 자리에 (왼쪽 부품부터 — 테스트벤치가 회로의 왼쪽이라 찾기 쉽다)
    const nets = extractNets(sheet, lib);
    const ex = new Map<string, [number, number]>();
    for (const part of [...sheet.parts].sort((a, c) => a.at[0] - c.at[0] || a.at[1] - c.at[1])) {
      const l = lib[part.lib];
      l.symbol.pins.forEach((pin, i) => {
        const n = nets.pinNet.get(part.id + ":" + pin.id)?.toUpperCase();
        if (n && !ex.has(n)) ex.set(n, pinAt(part, l, i) as [number, number]);
      });
    }
    for (const n of tb.probes) {
      const pt = ex.get(n.toUpperCase());
      if (pt) sheet.probes.push({ id: uid(), at: pt, color: PROBE_COLORS[sheet.probes.length % PROBE_COLORS.length] });
    }
    // 해석의 전원 이름: "@넷" 은 그 넷에 단 테스트벤치 전원의 이름으로 (부품 이름은 놓는 차례로 붙는다)
    const sim = { ...tb.sim } as Record<string, string>;
    for (const k of ["source", "src"]) {
      const v = sim[k];
      if (!v?.startsWith("@")) continue;
      const want = v.slice(1).toUpperCase();
      const hit = benchParts.find((q) => q.net === want);
      if (hit) sim[k] = hit.part.ref;
    }
    project.sim = sim as unknown as SimSettings;
    project.calc = [...tb.calc];
    // 계산기 본보기의 자리: 넷은 소문자로, 전원 · 입력의 전압원은 놓은 부품의 이름으로
    const sourceOn = (n: string) => benchParts.find((q) => q.net === n.toUpperCase())?.part.ref;
    const roles: Record<string, string> = {};
    for (const [k, v] of Object.entries(tb.roles ?? {})) roles[k] = /^X/.test(v) ? v : name(v.toUpperCase());
    if (supply) { roles.vdd ??= name(supply); roles.supply ??= sourceOn(supply) ?? "V1"; }
    if (roles.in && !roles.vin) { const v = sourceOn(roles.in); if (v) roles.vin = v; }
    if (Object.keys(roles).length) project.calcRoles = roles;
  }
  const top = Math.min(0, ...sheet.parts.map((p) => p.at[1])) - 80;
  sheet.notes.push({
    id: uid(), kind: "text", pts: [[-20, top]],
    text: `${spec.about} — ALIGN-public examples/${spec.id}, converted to SKY130 (FinFET fins -> SKY130 fins, L 150 nm). ` +
      "Placement: Auto place. Layout: Auto route.",
  });
  if (sky.notes.length) sheet.notes.push({ id: uid(), kind: "text", pts: [[-20, top + 20]], text: sky.notes.join(" · ") });
  return project;
}
