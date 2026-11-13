// 레이아웃 흐름 전체 — 데모 회로도 -> 레이아웃 넷리스트 -> 앞단(원시 소자·셀) -> 배치 -> 배선 -> DRC/LVS -> GDS.
//
// 편집기 화면이 부르는 것과 같은 함수들을 node 에서 차례로 부른다 (워커 안에서 도는 것과 같은 코드).
// 완료 기준: SKY130 데모가 DRC/LVS 오류 없이 배선되고, GDS 에 SKY130 층(확산·폴리·li·금속·탭)이 다 있다.
import fs from "node:fs";
import { DEMOS } from "../src/lib/demos.ts";
import { extractNets } from "../src/net/extract.ts";
import { layoutNetlist } from "../src/layout/bridge.ts";
import { runFrontEnd } from "../src/layout/front/index.mjs";
import { runJob } from "../src/layout/place/job.mjs";
import { routeDesign } from "../src/layout/route/pipeline.mjs";
import { loadAlignRouter } from "../src/layout/route/alignroute.mjs";
import { PLACE_DEFAULTS } from "../src/layout/place/defaults.mjs";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};

/** GDS 의 (층, 자료형) 들 */
function gdsLayers(buf: Uint8Array) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Set<string>();
  let layer: number | null = null;
  for (let i = 0; i + 4 <= buf.length;) {
    const n = dv.getUint16(i), rt = buf[i + 2];
    if (n < 4) break;
    if (rt === 0x0d) layer = dv.getInt16(i + 4);
    if (rt === 0x0e && layer != null) out.add(`${layer}/${dv.getInt16(i + 4)}`);
    i += n;
  }
  return out;
}

const router = await loadAlignRouter(fs.readFileSync(new URL("../src/layout/route/alignroute.wasm", import.meta.url)));
const NEED = { "65/20": "diff", "66/20": "poly", "66/44": "licon", "67/20": "li1", "67/44": "mcon", "68/20": "met1", "65/44": "tap", "93/44": "nsdm", "94/20": "psdm" };

for (const id of ["inv-sky130", "ota-sky130"]) {
  const demo = DEMOS.find((d) => d.id === id);
  if (!demo) { ok(false, `데모 ${id} 가 없다`); continue; }
  console.log(`\n=== ${demo.name}`);
  const pr = demo.build();
  const sheet = pr.sheets[0];
  const nl = layoutNetlist(sheet, pr.library, extractNets(sheet, pr.library), { name: pr.name });
  ok(nl.text.startsWith(`.subckt ${nl.top} `), "레이아웃 넷리스트", `${Object.keys(nl.devices).length} 트랜지스터 · 핀 ${nl.ports.join(" ")}`);

  const t0 = performance.now();
  const { blob, groups } = runFrontEnd(nl.text, nl.top, { userConstraints: nl.constraints });
  const top = blob.topology.modules.find((m: any) => m.name === nl.top);
  ok(!!top && top.instances.length > 0, "앞단 — 원시 소자로 묶는다", `${top?.instances.map((i: any) => i.abstract_template_name.replace(/_\d+$/, "")).join(", ")} · ${(performance.now() - t0).toFixed(0)} ms`);
  const covered = new Set(Object.values(groups[nl.top] ?? {}).flat());
  ok(Object.values(nl.devices).every((d) => covered.has(d)), "모든 트랜지스터가 어느 블록엔가 든다");

  let placed: any = null, err = "";
  const t1 = performance.now();
  await runJob({ name: nl.top, blob, ...PLACE_DEFAULTS, gpu: false }, (m: any) => { if (m.type === "done") placed = m; if (m.type === "error") err = m.msg; });
  ok(!!placed && !err, "배치", placed ? `${Math.round(placed.bbox[2] - placed.bbox[0])} x ${Math.round(placed.bbox[3] - placed.bbox[1])} nm · 겹침 ${placed.overlap} · ${((performance.now() - t1) / 1000).toFixed(1)} s` : err.split("\n")[0]);
  if (!placed) continue;
  ok(placed.overlap === 0 && placed.offgrid === 0, "겹침 0 · 격자 밖 0");

  const placement = {
    bbox: [0, 0, Math.round(placed.bbox[2] - placed.bbox[0]), Math.round(placed.bbox[3] - placed.bbox[1])],
    instances: placed.rects.map((r: any) => ({ name: r.name, concrete: r.concrete, oX: Math.round(r.sx > 0 ? r.x : r.x + r.w), oY: Math.round(r.sy > 0 ? r.y : r.y + r.h), sX: r.sx > 0 ? 1 : -1, sY: r.sy > 0 ? 1 : -1 })),
    subModules: placed.subModules ?? [],
  };
  const out = await routeDesign({ design: { topology: blob.topology, primitives: blob.primitives }, leaves: blob.leaves, placement, router });
  ok(out.errors.length === 0, "배선 — DRC/LVS 오류 없음", out.errors.length ? out.errors[0].slice(0, 160) : `넷 ${out.stats.nets}`);
  const layers = gdsLayers(out.gds);
  const missing = Object.entries(NEED).filter(([k]) => !layers.has(k)).map(([, v]) => v);
  ok(missing.length === 0, "GDS 에 SKY130 층이 다 있다", missing.length ? "없음: " + missing.join(", ") : `${layers.size} 층 · ${(out.gds.length / 1024).toFixed(0)} KB`);
}

console.log(fail ? `\nFAIL ${fail}` : "\nALL PASS");
process.exit(fail ? 1 : 0);
