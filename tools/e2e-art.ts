// 레이아웃 편집기의 그리기 (src/layout/art/) — 배치만으로 셀을 놓고, 손으로 긋고, 자동 배선은 고를 수 있다.
//
// 예제마다 회로도 -> 레이아웃 넷리스트 -> 앞단 -> 배치 (편집기가 받는 것과 같다) 뒤:
//   1. 바탕 — 배선기 없이 셀을 놓는다. 여러 블록에 걸친 넷이 열려 있고, 검사기는 그 넷들의 OPEN 만 센다
//   2. 자동 배선을 그린 것으로 — 배선기의 도형을 토막 · 비아로 바꿔 같은 검사기로 보면 배선기 자신의 검사와 같이 0
//   3. 손으로 — 래츠네스트 한 줄마다 핀에서 L 을 그어(art/draw.mjs, 사람이 마우스로 긋는 것과 같은 셈) 단락도 경고도
//      없는 것만 남긴다. 그은 것에서는 DRC 오류가 하나도 안 나온다 (남는 것은 아직 안 이은 넷의 OPEN)
//   4. 남은 넷만 자동 — 다 그린 넷을 고정으로 넘기면 그 넷은 한 점도 안 바뀌고 나머지가 이어져 0
//   5. 좌표는 nm 정수 (배선기가 정수만 받는다), GDS 를 쓴다
//   6. 고치기 (art/edit.mjs) — 자동 배선한 판에서 줄을 옆 트랙으로, 비아(꺾는 점)를, 층을 바꿔 본다. 단락이 아닌 것은 다 이어진 채로
//      남고, 미리 보기에 경고가 없던 것은 DRC 도 0, 되돌리기 한 번이면 처음과 같다
//   node tools/e2e-art.ts [id ...]
import fs from "node:fs";
import { layoutExample } from "../src/layout/examples/index.ts";
import { extractNets } from "../src/net/extract.ts";
import { layoutNetlist } from "../src/layout/bridge.ts";
import { runFrontEnd } from "../src/layout/front/index.mjs";
import { runJob } from "../src/layout/place/job.mjs";
import { routeSession, sessionOutput } from "../src/layout/route/pipeline.mjs";
import { loadAlignRouter } from "../src/layout/route/alignroute.mjs";
import { composeBase } from "../src/layout/art/base.mjs";
import { analyze } from "../src/layout/art/connect.mjs";
import { createArt, apply, shapesOf, undo } from "../src/layout/art/doc.mjs";
import { checkArt, gdsArt } from "../src/layout/art/check.mjs";
import { routedShapes, shapesToArt, frozenPaths } from "../src/layout/art/import.mjs";
import { startOn, planL, judge } from "../src/layout/art/draw.mjs";
import { touch, metal, via } from "../src/layout/art/rules.mjs";
import { runOf, dragRun, dragVia, changeLayerOf, sameDirectionLayers, nudge, stretchEnd, endInfo } from "../src/layout/art/edit.mjs";
import { PLACE_DEFAULTS } from "../src/layout/place/defaults.mjs";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};
const openOf = (an: any) => [...an.nets].filter(([, s]: any) => s.comps > 1).map(([n]: any) => n);
const router = await loadAlignRouter(fs.readFileSync(new URL("../src/layout/route/alignroute.wasm", import.meta.url)));
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ["five_transistor_ota", "comparator1", "telescopic_ota"];

for (const id of ids) {
  console.log(`\n=== ${id}`);
  const pr = layoutExample(id), sh = pr.sheets[0];
  const nl = layoutNetlist(sh, pr.library, extractNets(sh, pr.library), { name: pr.name });
  const { blob } = runFrontEnd(nl.text, nl.top, { userConstraints: nl.constraints });
  let placed: any = null;
  await runJob({ name: nl.top, blob, ...PLACE_DEFAULTS, gpu: false }, (m: any) => { if (m.type === "done") placed = m; });
  const placement = {
    bbox: [0, 0, Math.round(placed.bbox[2] - placed.bbox[0]), Math.round(placed.bbox[3] - placed.bbox[1])],
    instances: placed.rects.map((r: any) => ({ name: r.name, concrete: r.concrete, oX: Math.round(r.sx > 0 ? r.x : r.x + r.w), oY: Math.round(r.sy > 0 ? r.y : r.y + r.h), sX: r.sx > 0 ? 1 : -1, sY: r.sy > 0 ? 1 : -1 })),
    subModules: placed.subModules ?? [],
  };

  // 1. 바탕
  const base = composeBase(blob, placement);
  const empty = analyze(base, []);
  const open0 = openOf(empty);
  const ck0 = checkArt(base, []);
  ok(base.pins.length > 0 && open0.length > 0 && ck0.errors.length === open0.length && ck0.errors.every((e) => e.startsWith("OPEN")),
     "배치만으로 셀을 놓는다 — 열린 넷만 OPEN", `블록 ${base.blocks.length} · 핀 ${base.pins.length} · 열린 넷 ${open0.length} · 래츠네스트 ${empty.ratsnest.length}`);

  // 2. 자동 배선 -> 그린 것
  const design = { topology: blob.topology, primitives: blob.primitives };
  const s1 = await routeSession({ design, leaves: blob.leaves, placement, router });
  const conv = shapesToArt(routedShapes(s1));
  const auto = createArt();
  apply(auto, { add: conv }, "auto route");
  const autoDrawn = shapesOf(auto, base), autoAn = analyze(base, autoDrawn);
  const ckA = checkArt(base, autoDrawn);
  ok(sessionOutput(s1).errors.length === 0 && ckA.errors.length === 0 && !openOf(autoAn).length && !autoAn.shorts.length,
     "자동 배선의 결과를 토막 · 비아로 — 같은 검사기로 0", `토막 ${conv.wires.length} · 비아 ${conv.vias.length} · 열린 넷 ${openOf(autoAn).length} · 단락 ${autoAn.shorts.length}`);

  // 3. 손으로 (단락 · 경고가 없는 L 만)
  const art = createArt();
  const index = (layer: string, box: number[]) => [...base.shapes, ...shapesOf(art)].filter((s: any) => s.layer === layer && s.netName != null && touch(s.rect, box));
  const PAIRS = [["M3", "M4"], ["M2", "M3"], ["M4", "M3"]];
  let lines = 0;
  for (let round = 0; round < 8; round++) {
    const an = analyze(base, shapesOf(art, base));
    let drew = false;
    for (const r of an.ratsnest) {
      const pinAt = (pt: number[]) => [...base.pins, ...shapesOf(art)].find((p: any) => p.netName === r.net && p.role !== "cut" && p.rect[0] <= pt[0] && pt[0] <= p.rect[2] && p.rect[1] <= pt[1] && pt[1] <= p.rect[3]);
      const A = pinAt(r.a), B = pinAt(r.b);
      if (!A || !B) continue;
      for (const [L, O] of PAIRS) for (const firstA of [true, false]) {
        if (drew) break;
        const s = startOn(A, { x: r.a[0], y: r.a[1] }, L, O);
        if ("error" in s) continue;
        const pl = planL(s.net, s.at, L, O, { x: r.b[0], y: r.b[1] }, { firstA, target: B });
        const all = { wires: [...s.pre.wires, ...pl.wires], vias: [...s.pre.vias, ...pl.vias] };
        const j = judge(all, index);
        if (pl.joined && !j.shorts.length && !j.warns.length) { apply(art, { add: all }, `track ${r.net}`); lines++; drew = true; }
      }
      if (drew) break;
    }
    if (!drew) break;
  }
  const drawn = shapesOf(art, base), an = analyze(base, drawn), ck = checkArt(base, drawn);
  const left = openOf(an);
  ok(lines > 0 && ck.errors.every((e) => e.startsWith("OPEN")) && ck.errors.length === left.length && !an.shorts.length,
     "손으로 그은 L 에서는 DRC 오류가 없다 (남은 것은 안 이은 넷의 OPEN)", `그은 줄 ${lines} · 열린 넷 ${open0.length} -> ${left.length} · 검사기 ${ck.errors.length}`);
  const ints = [...art.wires.flatMap((w: any) => [w.x0, w.y0, w.x1, w.y1]), ...art.vias.flatMap((v: any) => [v.x, v.y])].every(Number.isInteger);
  ok(ints, "좌표는 nm 정수");
  if (id === "five_transistor_ota") ok(left.length === 0 && ck.errors.length === 0, "5T OTA 는 손으로 다 이어 DRC/LVS 0", `${art.wires.length} 토막 · ${art.vias.length} 비아`);
  const n = art.hist.length;
  undo(art);
  ok(art.hist.length === n - 1 && art.fut.length === 1, "되돌리기 — 트랙 하나씩");

  // 4. 남은 넷만 자동 (다 그린 넷은 고정)
  const art2 = createArt();
  apply(art2, { add: { wires: art.wires, vias: art.vias } }, "hand");
  const an2 = analyze(base, shapesOf(art2, base));
  const keep = new Set([...an2.nets].filter(([net, q]: any) => q.comps <= 1 && art2.wires.some((w: any) => w.net === net) && !net.includes("/")).map(([net]: any) => net));
  const key = () => JSON.stringify(art2.wires.filter((w: any) => keep.has(w.net)).map((w: any) => [w.net, w.layer, w.x0, w.y0, w.x1, w.y1]).sort());
  const before = key();
  const s2 = await routeSession({ design, leaves: blob.leaves, placement, router, frozen: frozenPaths(art2, keep) });
  const c2 = shapesToArt(routedShapes(s2));
  apply(art2, { add: { wires: c2.wires.filter((w: any) => !keep.has(w.net)), vias: c2.vias.filter((v: any) => !keep.has(v.net)) },
                del: [...art2.wires, ...art2.vias].filter((o: any) => !keep.has(o.net)).map((o: any) => o.id) }, "the rest");
  const d2 = shapesOf(art2, base), ck2 = checkArt(base, d2);
  ok(key() === before && ck2.errors.length === 0 && !openOf(analyze(base, d2)).length,
     "남은 넷만 자동 — 그린 넷은 그대로, 나머지가 이어져 0", `그대로 둔 넷 ${keep.size} (${[...keep].slice(0, 6).join(" ")}) · 검사기 ${ck2.errors.length}`);

  // 5. GDS
  const gds = gdsArt(ck2, nl.top);
  ok(gds.length > 1000 && gds[0] === 0 && gds[1] === 6 && gds[2] === 0 && gds[3] === 2, "GDS (HEADER 레코드로 시작)", `${(gds.length / 1024).toFixed(0)} KB`);

  // 6. 고치기 — 자동 배선한 판(auto)에서
  (base as any).byLayer = new Map();
  for (const sh of base.shapes) if (sh.netName != null) ((base as any).byLayer.get(sh.layer) ?? (base as any).byLayer.set(sh.layer, []).get(sh.layer)).push(sh);
  const named = base.shapes.filter((q: any) => q.netName != null && (metal(q.layer) || via(q.layer))).map((q: any) => ({ ...q, from: "base" }));
  const nearOf = (a: any) => { const all = [...named, ...shapesOf(a, base).map((q: any) => ({ ...q, from: "art" }))]; return (L: string, box: number[]) => all.filter((q: any) => q.layer === L && touch(q.rect, box)); };
  const artKey = (a: any) => JSON.stringify([[...a.wires].sort((p: any, q: any) => p.id - q.id), [...a.vias].sort((p: any, q: any) => p.id - q.id)]);
  const tally = { tried: 0, short: 0, kept: 0, opened: 0, drcNoWarn: 0, warned: 0, undo: 0, followed: 0, jogs: 0 };
  const attempt = (e: any, label: string) => {
    if (!e) return;
    tally.tried++;
    const near = nearOf(auto), j = judge(e.add, near);
    if (j.shorts.length) { tally.short++; return; }
    const before = artKey(auto);
    apply(auto, { add: e.add, del: e.del }, label);
    const d6 = shapesOf(auto, base), an6 = analyze(base, d6);
    if (openOf(an6).length || an6.shorts.length) tally.opened++; else tally.kept++;
    if (j.warns.length) tally.warned++;
    else if (checkArt(base, d6).errors.length) tally.drcNoWarn++;
    tally.followed += e.followed; tally.jogs += e.jogs;
    undo(auto);
    if (artKey(auto) === before) tally.undo++;
  };
  const runs = new Map<string, any>();
  for (const w of auto.wires) { const r = runOf(auto, w.id)!; runs.set(`${r.layer}|${r.net}|${r.c}|${r.lo}`, r); }
  for (const r of [...runs.values()].slice(0, 40)) for (const k of [1, -1]) attempt(dragRun(auto, nearOf(auto), r, r.c + k * metal(r.layer).pitch), "move");
  const movedRuns = tally.kept;
  for (const v of auto.vias.slice(0, 40)) attempt(dragVia(auto, nearOf(auto), v.id, { x: v.x + 430, y: v.y + 420 }), "via");
  for (const r of [...runs.values()].slice(0, 30)) for (const L2 of sameDirectionLayers(r.layer)) attempt(changeLayerOf(auto, nearOf(auto), [...r.ids], L2), "layer");
  for (const w of auto.wires.slice(0, 20)) attempt(nudge(auto, nearOf(auto), [w.id], 1, 1), "nudge");
  const done = tally.tried - tally.short;
  ok(done > 10 && movedRuns > 3 && tally.opened === 0 && tally.drcNoWarn === 0 && tally.undo === done,
     "고치기 — 단락이 아닌 것은 다 이어진 채, 경고 없던 것은 DRC 0, 되돌리기 한 번에 처음과 같다",
     `${tally.tried}번 (단락으로 막힘 ${tally.short}) · 이어진 채 ${tally.kept} · 끊김 ${tally.opened} · 경고 ${tally.warned} · 경고 없이 DRC ${tally.drcNoWarn} · 따라감 ${tally.followed} · jog ${tally.jogs}`);
  // 빈 끝 늘이기 — 줄 끝에 아무것도 없는 토막을 만들어
  const stub = auto.wires.find((w: any) => metal(w.layer).dir === "h" && [0, 1].some((which) => endInfo(auto, nearOf(auto), w, which).free));
  if (stub) {
    const which = endInfo(auto, nearOf(auto), stub, 0).free ? 0 : 1, e0 = which ? stub.x1 : stub.x0;
    const e = stretchEnd(auto, nearOf(auto), stub.id, which, e0 + (which ? 1 : -1) * 2 * 430);
    ok(!!e && e.add.wires.length === 1 && e.del.length === 1, "빈 끝 늘이기 — 그 토막 하나만", e ? `${stub.layer} ${e0} -> ${which ? e.add.wires[0].x1 : e.add.wires[0].x0}` : "없음");
  }
}

console.log(fail ? `\nFAIL ${fail}` : "\nALL PASS");
process.exit(fail ? 1 : 0);
