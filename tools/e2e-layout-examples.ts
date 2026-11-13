// ALIGN 예제를 끝까지 — 예제 회로도(src/layout/examples) -> 시뮬레이션 · 계산기 / 레이아웃 넷리스트 -> 앞단 -> 배치 ->
// 배선 -> DRC/LVS -> GDS.
//
// Examples 메뉴가 여는 것과 같은 회로도를 만들고, 앱이 부르는 것과 같은 함수를 차례로 부른다.
// 완료 기준: 테스트벤치가 돌아 계산기 줄이 다 값을 내고 대표 값이 회로로서 맞아야 하는 범위에 든다 (SIM — 이득 · 대역,
// 비교기가 ±10 mV 를 바로 가르는 것, 링이 도는 것 ...). 레이아웃은 기대한 DRC/LVS 오류 수 (src/layout/examples/index.ts
// 의 expect) 와 같고, 회로도의 트랜지스터가 다 블록에 들고, 원래 서브회로의 핀이 레이아웃 블록의 핀이다 (넷 라벨이나
// 테스트벤치 때문에 안쪽 넷이 핀이 되지 않는다).
//   node tools/e2e-layout-examples.ts [id ...]
import fs from "node:fs";
import { LAYOUT_EXAMPLES, layoutExample } from "../src/layout/examples/index.ts";
import { NETLISTS } from "../src/layout/examples/netlists.ts";
import { readAlign, flattenAlign, toSky130 } from "../src/layout/examples/align.ts";
import { extractNets } from "../src/net/extract.ts";
import { layoutNetlist } from "../src/layout/bridge.ts";
import { runFrontEnd } from "../src/layout/front/index.mjs";
import { runJob } from "../src/layout/place/job.mjs";
import { routeDesign } from "../src/layout/route/pipeline.mjs";
import { loadAlignRouter } from "../src/layout/route/alignroute.mjs";
import { BENCHES } from "../src/layout/examples/benches.ts";
import { formatValue } from "../src/calc/format.ts";
import { runCalc } from "./sim-harness.ts";
import { CHAPTERS, hints, rowFor } from "../src/calc/metrics.ts";
import { PLACE_DEFAULTS } from "../src/layout/place/defaults.mjs";

/**
 * 테스트벤치의 대표 값 — [계산기 줄 (이름이나 # 앞의 식), 아래, 위]. SKY130 tt 모델 1.8 V. 범위는 넉넉히: 모델이 조금 바뀌어도
 * 지나고, 바이어스가 틀어져 소자가 선형으로 빠지거나 회로가 서면 걸린다. near: [줄, 손계산 줄, 상대 오차] — 손계산이 맞는지.
 */
const SIM: Record<string, { in: Array<[string, number, number]>; near?: Array<[string, string, number]> }> = {
  five_transistor_ota: { in: [["a0", 6, 13], ["fu", 40e6, 200e6], ["pm(v(von)/v(vip))", 60, 120], ["satmargin(XMN1)", 0, 1.8]],
    near: [["a0", "gm(XMN2)/(gds(XMN2) + gds(XMP4))", 0.15], ["fu", "gm(XMN2)/(2*pi*1pF)", 0.2]] },
  five_transistor_ota_high_frequency: { in: [["a0", 7, 16], ["fu", 500e6, 3e9], ["pm(v(vout_ota)/v(vinp_ota))", 45, 120], ["id(XM2)/id(XM3)", 4, 9]],
    near: [["a0", "gm(XM1)/(gds(XM1) + gds(XM5))", 0.15]] },
  common_source: { in: [["value(gain, 1.0)", -2.5, -1], ["vm", 0.6, 1.0]],
    near: [["value(gain, 1.0)", "value(-gm(XMN0)/(gm(XMP0) + gds(XMP0) + gds(XMN0)), 1.0)", 0.02]] },
  telescopic_ota: { in: [["a0", 30, 150], ["fu", 40e6, 300e6], ["pm(h)", 60, 120], ["satmargin(XM5)", 0, 1.8], ["satmargin(XM7)", 0, 1.8]],
    near: [["a0", "gm(XM3)/(gds(XM3)*gds(XM5)/(gm(XM5) + gmb(XM5)) + gds(XM9)*gds(XM7)/(gm(XM7) + gmb(XM7)))", 0.2], ["fu", "gm(XM3)/(2*pi*500fF)", 0.25]] },
  telescopic_ota_with_bias: { in: [["a0", 100, 600], ["fu", 30e6, 300e6], ["pm(v(vout)/v(vinp))", 60, 120], ["id(XM4)/20uA", 2, 6]],
    near: [["fu", "gm(XM0)/(2*pi*1pF)", 0.3]] },
  current_mirror_ota: { in: [["a0", 10, 30], ["fu", 10e6, 100e6], ["pm(v(voutp)/v(vinp))", 60, 120]],
    near: [["fu", "gm(XM15)*mirror/(2*pi*1pF)", 0.3]] },
  cascode_current_mirror_ota: { in: [["a0", 50, 200], ["fu", 10e6, 100e6], ["pm(v(voutp)/v(vinp))", 60, 120], ["satmargin(XM25)", 0, 1.8], ["satmargin(XM23)", 0, 1.8]],
    near: [["fu", "gm(XM15)*mirror/(2*pi*1pF)", 0.45]] },
  high_speed_comparator: { in: [["value(d, 4.5n)", 1.7, 1.9], ["value(d, 14.5n)", -1.9, -1.7], ["t1", 50e-12, 600e-12], ["value(v(vop) + v(von), 0.9n)", -0.05, 0.05]],
    near: [["t1", "t2", 0.15]] },
  double_tail_sense_amplifier: { in: [["value(d, 4.5n)", 1.7, 1.9], ["value(d, 14.5n)", -1.9, -1.7], ["t1", 50e-12, 600e-12], ["value(v(vop) + v(von), 0.9n)", -0.05, 0.05]],
    near: [["t1", "t2", 0.15]] },
  comparator1: { in: [["value(d, 4.5n)", 1.7, 1.9], ["value(d, 14.5n)", -1.9, -1.7], ["value(v(rdy), 0.9n)", -0.05, 0.05], ["trdy", 50e-12, 1e-9], ["tdec", 50e-12, 1e-9]] },
  inverter_current_starved: { in: [["tp", 10e-12, 100e-12], ["ts", 50e-12, 500e-12], ["ts/tp", 2, 10]] },
  ring_oscillator: { in: [["f", 1e9, 10e9], ["duty(clip(v(vo), 10n, 30n))", 0.35, 0.65], ["pp(clip(v(vo), 10n, 30n))", 1.5, 2.5]] },
  vco_type2_65: { in: [["t8", 200e-12, 3e-9]] },
  linear_equalizer: { in: [["a0", 0.5, 1.5], ["peaking(h)", 2, 8], ["ymax(abs(h))/a0", 1.3, 2.5], ["fz", 200e6, 500e6]] },
  variable_gain_amplifier: { in: [["a0", 1.1, 2.5], ["f3db(h)", 2e9, 15e9], ["gm(XM20)", -1e-6, 1e-6]],
    near: [["a0", "(gm(XM00) + gm(XM10))/(1/400ohm + gds(XM00) + gds(XM10))", 0.05]] },
  single_to_differential_converter: { in: [["value(g1, 10meg)", -12, -3], ["value(g2, 10meg)", -12, -3], ["value(phase(v(vout_sdc1)/v(vout_sdc2)), 10meg)", 170, 190], ["value(g1, 100k)", -80, -25]] },
  unity_gain_buffers: { in: [["value(e, 1.2)", -0.05, 0.05], ["slope(v(vo_hs), 1.2)", 0.8, 1.05], ["value(v(vo_ls) - v(vref_ls), 1.2)", -0.05, 0.05]] },
  powertrain_binary: { in: [["value(r, 15n)", 60, 250], ["value(r, 635n)", 0.5, 5], ["value(r, 15n)/value(r, 635n)", 40, 100]] },
};

/** 본보기(Metrics)가 이 예제의 자리로 채워져, 해석에 맞는 본보기마다 없는 넷 · 소자를 부르지 않는다 (값이 안 나오는 것은 회로 탓일 수 있다) */
async function metricsCheck(pr: any) {
  const sh = pr.sheets[0], ex = extractNets(sh, pr.library);
  const names = {
    nets: [...ex.netNames()].map((n: string) => n.toLowerCase()).filter((n: string) => n !== "0"),
    probed: sh.probes.map((q: any) => ex.netAt(q.at)).filter(Boolean).map((n: string) => n.toLowerCase()),
    mos: sh.parts.filter((q: any) => /^sky130_[np]fet/.test(q.lib)).map((q: any) => q.ref), bjt: [], vsrc: [],
    roles: pr.calcRoles,
  };
  const h = hints(names);
  // 보관한 실행 둘을 읽는 본보기(CMRR · PSRR · KVCO · 고리 이득)는 빼고 — 한 번 돌린 것으로는 못 잰다
  const metrics = CHAPTERS.flatMap((c) => c.metrics).filter((m) => m.needs.includes(pr.sim.kind) && !/\b[a-z]+\.[vi]\(/.test(m.expr));
  const lines = metrics.map((m) => rowFor(m, h, new Set()));
  const r = await runCalc(pr, lines);
  if ("error" in r) return { lines, bad: [`${r.what}: ${r.error}`], valued: 0 };
  const bad = r.rows.filter((x) => x.error && /^No (net|device)/.test(x.error)).map((x) => `${x.src} -> ${x.error}`);
  return { lines, bad, valued: r.rows.filter((x) => x.value).length };
}

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

const simOnly = process.argv.includes("--sim");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const router = await loadAlignRouter(fs.readFileSync(new URL("../src/layout/route/alignroute.wasm", import.meta.url)));
const rows: string[] = [];

for (const ex of LAYOUT_EXAMPLES.filter((e: any) => !only.length || only.includes(e.id))) {
  console.log(`\n=== ${ex.title} (${ex.id})`);
  const t0 = performance.now();
  const pr = layoutExample(ex.id);
  const sheet = pr.sheets[0];

  // 테스트벤치 — 앱의 Run 과 같다. 줄이 다 값을 내고, 대표 값이 범위에 든다
  const sim = await runCalc(pr, pr.calc ?? []);
  const spec = SIM[ex.id];
  let simNote = "";
  if ("error" in sim) ok(false, `시뮬레이션 — ${sim.what}`, sim.error);
  else {
    const bad = sim.rows.filter((r) => !r.blank && (r.error || !r.value));
    const num = (key: string): number => {
      const r = sim.rows.find((x) => x.name === key || x.src.split("#")[0].trim() === key);
      return r?.value?.t === "num" ? r.value.re : NaN;
    };
    const shown = (key: string) => { const r = sim.rows.find((x) => x.name === key || x.src.split("#")[0].trim() === key); return r?.value ? formatValue(r.value) : "?"; };
    const out = (spec?.in ?? []).filter(([k, lo, hi]) => !(num(k) >= lo && num(k) <= hi));
    const off = (spec?.near ?? []).filter(([a, b, tol]) => !(Math.abs(num(a) / num(b) - 1) <= tol));
    ok(!!spec && pr.sim.kind === BENCHES[ex.id]?.sim.kind && bad.length === 0 && sim.unavailable.length === 0 && !out.length && !off.length,
       `시뮬레이션 (${pr.sim.kind}) — 계산기 ${sim.rows.length}줄이 다 값을 내고 대표 값이 범위에 든다`,
       [...bad.map((r) => `${r.src} -> ${r.error ?? "값 없음"}`),
        ...out.map(([k, lo, hi]) => `${k} = ${shown(k)} (범위 ${lo}..${hi})`),
        ...off.map(([a, b, tol]) => `${a} = ${shown(a)}, 손계산 ${shown(b)} (허용 ${tol * 100} %)`),
        ...sim.unavailable.map((u) => `엔진에 없다: ${u}`)].join(" / ") || (spec?.in ?? []).map(([k]) => `${k} ${shown(k)}`).join(" · "));
    simNote = (spec?.in ?? []).slice(0, 2).map(([k]) => `${k.length > 12 ? k.slice(0, 12) + "…" : k} ${shown(k)}`).join(", ");
  }
  const mc = await metricsCheck(pr);
  ok(mc.bad.length === 0 && mc.valued > 0, `계산기 본보기 — 이 회로의 자리로 채운 ${mc.lines.length}개가 있는 넷 · 소자만 부른다`,
     mc.bad.join(" / ") || `${mc.valued}개가 값을 낸다 · out ${pr.calcRoles?.out ?? "?"} · in ${pr.calcRoles?.in ?? "-"} · m ${pr.calcRoles?.m ?? "-"}`);
  if (simOnly) continue;
  const nl = layoutNetlist(sheet, pr.library, extractNets(sheet, pr.library), { name: pr.name });
  const fets = Object.keys(nl.devices).length;
  ok(fets === ex.transistors, "회로도 -> 레이아웃 넷리스트", `${fets} 트랜지스터 · 핀 ${nl.ports.join(" ")}`);
  // 핀: 원래 서브회로의 핀은 다 블록의 핀이고, 그 밖의 핀은 레이아웃에 안 드는 부품(R · C)에 닿은 넷이다 — 안쪽 넷은 핀이 아니다
  const net = readAlign(NETLISTS[ex.id].sp), sky = toSky130(flattenAlign(net, ex.id), NETLISTS[ex.id].constraints, net.models);
  const id = (n: string) => n.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
  const rails = new Set([...sky.power, ...sky.ground].map(id));
  const fetNets = new Set(sky.devices.filter((d: any) => d.kind === "M").flatMap((d: any) => d.nodes.slice(0, 3).map(id)));
  // 원래 서브회로의 핀 + 테스트벤치가 핀으로 낸 넷 (넷리스트가 비워 둔 게이트)
  const orig = [...sky.ports, ...(BENCHES[ex.id]?.pins ?? [])].map(id).filter((n) => fetNets.has(n) && !rails.has(n));
  const ex2 = extractNets(sheet, pr.library);
  const passiveNets = new Set<string>();
  for (const p of sheet.parts) if (p.lib === "r" || p.lib === "c") for (const k of ["1", "2"]) { const n = ex2.pinNet.get(p.id + ":" + k); if (n) passiveNets.add(n); }
  const extra = nl.ports.filter((p) => !orig.includes(p) && !rails.has(p) && !/^(VDD|VCC|VSS|GND)/.test(p));
  ok(orig.every((p) => nl.ports.includes(p)) && extra.every((p) => passiveNets.has(nl.nets[p])),
     "핀은 원래 서브회로의 핀 (+ R · C 에 닿은 넷) — 안쪽 넷은 핀이 아니다", nl.ports.join(" "));
  const { blob, groups } = runFrontEnd(nl.text, nl.top, { userConstraints: nl.constraints });
  const top = blob.topology.modules.find((m: any) => m.name === nl.top);
  // 블록마다 트랜지스터가 있고, 블록 목록에 없는 트랜지스터는 ALIGN 이 합친 것이다 — 직렬로 쌓은 짝 (같은 게이트, 소스-드레인이
  // 이어졌다) 이거나 병렬 (드레인 · 게이트 · 소스가 다 같다: 배수가 늘어난다)
  const covered = new Set(Object.values(groups).flatMap((g: any) => Object.values(g).flat()));
  const devs = nl.text.split("\n").filter((l) => /^M/.test(l)).map((l) => l.split(/\s+/));
  const joined = (q: string[], r: string[]) => q[2] === r[2] &&
    (q[3] === r[1] || q[1] === r[3] || (q[1] === r[1] && q[3] === r[3]) || (q[1] === r[3] && q[3] === r[1]));
  // 합친 것이 또 합쳐질 수 있다 (셋 이상 직렬 · 병렬) — 블록에 든 것에서부터 이웃을 따라 넓힌다
  const accounted = new Set(devs.filter((r) => covered.has(r[0])).map((r) => r[0]));
  for (let more = true; more;) {
    more = false;
    for (const r of devs) if (!accounted.has(r[0]) && devs.some((q) => accounted.has(q[0]) && joined(q, r))) { accounted.add(r[0]); more = true; }
  }
  const loose = devs.filter((r) => !accounted.has(r[0])).map((r) => r[0]);
  ok(!!top && top.instances.length > 0 && !loose.length, "앞단 — 트랜지스터가 다 블록에 든다 (직렬 · 병렬로 합친 것 포함)",
     `${top?.instances.length} 블록 · 모듈 ${blob.topology.modules.length} · 합친 것 ${devs.length - [...covered].filter((d) => devs.some((r) => r[0] === d)).length}${loose.length ? " · 빠짐 " + loose.join(" ") : ""}`);

  let placed: any = null, err = "";
  await runJob({ name: nl.top, blob, ...PLACE_DEFAULTS, gpu: false }, (m: any) => { if (m.type === "done") placed = m; if (m.type === "error") err = m.msg; });
  ok(!!placed, "배치", placed ? `${Math.round(placed.bbox[2] - placed.bbox[0])} x ${Math.round(placed.bbox[3] - placed.bbox[1])} nm · HPWL ${Math.round(placed.hpwl)}` : err.split("\n")[0]);
  if (!placed) continue;
  ok(placed.overlap < 1e-6 && placed.offgrid === 0, "겹침 0 · 격자 밖 0", `겹침 ${placed.overlap.toExponential(1)}`);
  const placement = {
    bbox: [0, 0, Math.round(placed.bbox[2] - placed.bbox[0]), Math.round(placed.bbox[3] - placed.bbox[1])],
    instances: placed.rects.map((r: any) => ({ name: r.name, concrete: r.concrete, oX: Math.round(r.sx > 0 ? r.x : r.x + r.w), oY: Math.round(r.sy > 0 ? r.y : r.y + r.h), sX: r.sx > 0 ? 1 : -1, sY: r.sy > 0 ? 1 : -1 })),
    subModules: placed.subModules ?? [],
  };
  const out = await routeDesign({ design: { topology: blob.topology, primitives: blob.primitives }, leaves: blob.leaves, placement, router });
  ok(out.errors.length === ex.expect, `배선 — DRC/LVS ${ex.expect}`, out.errors.length ? `${out.errors.length}: ${out.errors[0].slice(0, 120)}` : `넷 ${out.stats.nets} · GDS ${(out.gds.length / 1024).toFixed(0)} KB${out.room ? ` · 셀 사이에 길이 없어 둘레에 ${out.room.tracks} 트랙을 더 두고` : ""}`);
  const s = ((performance.now() - t0) / 1000).toFixed(1);
  rows.push(`${ex.id.padEnd(36)} ${String(fets).padStart(3)} FET ${String(top?.instances.length).padStart(3)} blk  ${`${Math.round(placed.bbox[2] - placed.bbox[0])}x${Math.round(placed.bbox[3] - placed.bbox[1])}`.padStart(12)} nm  DRC/LVS ${out.errors.length}  ${s} s  | ${simNote}`);
}

console.log("\n" + rows.join("\n"));
console.log(fail ? `\nFAIL ${fail}` : "\nALL PASS");
process.exit(fail ? 1 : 0);
