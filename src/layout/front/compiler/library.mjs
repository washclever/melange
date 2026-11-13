/** 모델·틀 라이브러리 읽기 — ALIGN compiler/read_library.py 의 JS 판.
 *
 *    readModels()   기본 모델 + SKY130 models.sp 를 읽은 파서 (회로 넷리스트를 이어서 읽는다)
 *    readLib()      그 위에 ALIGN 의 원시 소자 틀(basic/user template)을 읽은 라이브러리
 *    orderLib(lib)  틀을 찾는 순서: 소자가 많은 것, 넷이 적은 것, 모델 종류가 많은 것부터
 *    pdkGenerator(name)  PDK 가 이 이름의 생성기를 갖는가 (SKY130: MOS, CAP, RES, GUARD_RING)
 */
import { Library } from "./schema.mjs";
import { SpiceParser } from "./spice.mjs";
import { BASIC_TEMPLATE, USER_TEMPLATE, SKY130_MODELS } from "./templates.mjs";

/** ALIGN get_generator(name, SKY130_PDK) — PDK 패키지의 속성 이름(하위 모듈 cap/res/mos/guard_ring)과 맞으면 참 */
const PDK_MODULES = new Set(["cap", "res", "mos", "guard_ring"]);
const PDK_CLASSES = new Set(["CapGenerator", "ResGenerator", "MOSGenerator", "RingGenerator", "ViaArrayGenerator"]);
export function pdkGenerator(name) {
  const n = String(name);
  return PDK_CLASSES.has(n) || PDK_MODULES.has(n) || PDK_CLASSES.has(n.toLowerCase()) || PDK_MODULES.has(n.toLowerCase());
}

export function readModels() {
  const p = new SpiceParser(Library.withBuiltins());
  p.parse(SKY130_MODELS);
  return p;
}

export function readLib() {
  const p = readModels();
  p.parse(BASIC_TEMPLATE);
  p.parse(USER_TEMPLATE);
  for (const s of p.library) {
    if (s.kind !== "SubCircuit") continue;
    if (pdkGenerator(s.name)) s.addGenerator(s.name);
    else for (const c of s.constraints) if (c.constraint === "Generator" && c.name) s.addGenerator(c.name.toUpperCase());
  }
  return p.library;
}

export function orderLib(library) {
  const prims = library.items.filter((v) => v.kind === "SubCircuit");
  const key = (x) => [x.elements.length, 1 / x.nets.length, new Set(x.elements.map((e) => e.model)).size];
  const cmp = (a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  };
  // 파이썬 sort(reverse=True) 는 같은 것의 순서를 지킨다
  return prims.slice().sort((a, b) => cmp(b, a));
}
