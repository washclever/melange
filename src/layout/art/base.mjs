/** 바탕 — 배치만으로 셀의 도형을 놓는다. 배선기 없이: 배치가 끝나면 바로 손으로 그릴 수 있게.
 *
 *  배치({bbox, instances, subModules} — services/routing.mjs 의 routePlacement)를 따라 내려가며 리프 셀(앞단의 leaves)을
 *  제자리에 옮긴다. 하위 모듈은 그 모듈의 배치(subModules)로 한 번 더 내려간다 — 하위 모듈의 안쪽도 펼쳐서 맨 위에서 다
 *  보인다 (PCB 처럼 한 판). 넷 이름은 인스턴스의 fa_map 으로 맨 위의 넷까지 올린다: 하위 모듈의 포트는 부르는 쪽의 넷,
 *  안에서만 쓰는 넷은 "<인스턴스 경로>/<넷>", 셀 안의 넷은 "<블록 경로>/<넷>" (route/compose.mjs 의 placeBlock 과 같은 규칙).
 *
 *  돌려주는 것은 검사기 · GDS 가 그대로 받는 모양이다 — composeModule 에 배선(wires)만 더하면 된다 (check.mjs).
 *
 *    blocks    [{ name, tr, terminals, subinsts }]   리프 셀 하나하나 (name 은 인스턴스 경로)
 *    faMap     "<블록>/<핀>" -> 넷
 *    powerNets 전역 전원 넷 (VDD, VSS)
 *    shapes    [{ layer, rect, netName, netType, block }]  놓인 도형 전부 (block 은 blocks 의 번호)
 *    pins      shapes 중 핀 (netType "pin")
 *    nets      넷 -> 그 넷의 핀 번호들
 */
import { unpackLeaf, readLeaves } from "../route/leaves.mjs";
import { placeBlock } from "../route/compose.mjs";

const compose = (p, q) => ({ oX: p.oX + p.sX * q.oX, oY: p.oY + p.sY * q.oY, sX: p.sX * q.sX, sY: p.sY * q.sY });
const ID = { oX: 0, oY: 0, sX: 1, sY: 1 };

/**
 * @param {{topology: object, leaves: object}} design   앞단 출력 (blob)
 * @param {{bbox: number[], instances: Array, subModules?: Array}} placement
 */
export function composeBase(design, placement) {
  const lv = design.leaves?.format ? readLeaves(design.leaves) : design.leaves;
  const mods = new Map(design.topology.modules.map((m) => [m.name, m]));
  const top = topName(design.topology, placement);
  const subByConcrete = new Map((placement.subModules ?? []).map((s) => [s.concrete, s]));
  const powerNets = new Set((design.topology.global_signals ?? []).map((g) => g.actual));
  const blocks = [], faMap = new Map();
  const unpacked = new Map();
  const leafOf = (cn) => { if (!unpacked.has(cn)) unpacked.set(cn, unpackLeaf(lv[cn])); return unpacked.get(cn); };

  // mod: 토폴로지의 모듈, insts: 그 모듈 안의 배치, tr: 모듈 -> 맨 위, path: 인스턴스 경로 접두, up: 모듈의 넷 -> 맨 위의 넷
  const walk = (mod, insts, tr, path, up) => {
    const byName = new Map(mod.instances.map((i) => [i.instance_name, i]));
    for (const q of insts) {
      const ti = byName.get(q.name);
      if (!ti) throw new Error(`${mod.name}: the placement names ${q.name}, which the design does not have`);
      const t2 = compose(tr, q), name = path + q.name;
      const fa = new Map(ti.fa_map.map((f) => [f.formal, up(f.actual)]));
      if (lv[q.concrete]) {
        const L = leafOf(q.concrete);
        for (const [formal, net] of fa) faMap.set(`${name}/${formal}`, net);
        blocks.push({ name, tr: t2, terminals: L.terminals, subinsts: L.subinsts, concrete: q.concrete });
        continue;
      }
      const sm = subByConcrete.get(q.concrete), sub = mods.get(ti.abstract_template_name) ?? mods.get(sm?.abstract);
      if (!sm || !sub) throw new Error(`${name}: no cell geometry or sub-module placement for ${q.concrete}`);
      // 하위 모듈의 넷: 포트면 부르는 쪽의 넷, 전역 전원은 그대로, 나머지는 그 인스턴스 안의 넷
      walk(sub, sm.instances, t2, name + "/", (n) => (fa.has(n) ? fa.get(n) : powerNets.has(n) ? n : `${name}/${n}`));
    }
  };
  walk(mods.get(top), placement.instances, ID, "", (n) => n);

  const shapes = [], pins = [], nets = new Map();
  blocks.forEach((b, bi) => {
    for (const t of placeBlock(b, faMap, powerNets)) {
      const s = { ...t, block: bi };
      shapes.push(s);
      if (t.netType === "pin" && t.netName != null) {
        pins.push(s);
        if (!nets.has(t.netName)) nets.set(t.netName, []);
        nets.get(t.netName).push(pins.length - 1);
      }
    }
  });
  return { top, blocks, faMap, powerNets, shapes, pins, nets, bbox: placement.bbox.slice() };
}

/** 맨 위 모듈 — 배치의 인스턴스를 다 가진 모듈 (route/hier.mjs topModule 은 토폴로지만 본다) */
function topName(topology, placement) {
  const names = new Set(placement.instances.map((q) => q.name));
  const hit = topology.modules.filter((m) => [...names].every((n) => m.instances.some((i) => i.instance_name === n)));
  if (!hit.length) throw new Error("No module holds the placed instances");
  return hit[hit.length - 1].name;
}
