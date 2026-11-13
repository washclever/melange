/** 레이아웃 층 표 — 색, 묶음, 그리는 차례, 보이기.
 *
 *  층 키는 ALIGN 의 이름이다 (M1..M6, V0..V5 — 배선기·검사기·도형이 다 이 이름을 쓴다). 화면에는 SKY130 이름을 보인다
 *  (lname: M1 = li1, M2 = met1 …). 배선 결과(geo.terminals)는 층별 사각형이다 (telescopic_ota 하나가 1,057 개). 금속·비아·소자층이 섞여 있어 다 그리면
 *  아무것도 안 보인다 — 층마다, 묶음마다 껐다 켠다. 색은 층 순서를 따라간다: 아래(소자)는 차갑고 위(상위 금속)로 갈수록
 *  따뜻하게. 실제 파운드리 색표가 아니라 읽기 위한 이 프로젝트의 색이다.
 *
 *  오브젝트 층은 도형이 아니라 편집기가 덧그리는 것이다 (블록 윤곽, 플라이라인, 오류 표식, 격자).
 */
import { PDK, layerName } from "../../pdk/pdk.mjs";

export const LAYERS = [
  { key: "M1", color: "#4a7fb5", group: "metal" },      // li1
  { key: "M2", color: "#3f9a76", group: "metal" },      // met1
  { key: "M3", color: "#c98a2e", group: "metal" },      // met2
  { key: "M4", color: "#a8577f", group: "metal" },      // met3
  { key: "M5", color: "#5aa7bf", group: "metal" },      // met4
  { key: "M6", color: "#b5603a", group: "metal" },      // met5
  { key: "V0", color: "#7a6a58", group: "via" },        // licon1
  { key: "V1", color: "#7a6a58", group: "via" },        // mcon
  { key: "V2", color: "#7a6a58", group: "via" },        // via
  { key: "V3", color: "#7a6a58", group: "via" },        // via2
  { key: "V4", color: "#7a6a58", group: "via" },        // via3
  { key: "V5", color: "#7a6a58", group: "via" },        // via4
  { key: "Poly", color: "#9c3b3b", group: "device" },
  { key: "Active", color: "#6f9455", group: "device" }, // diff
  { key: "Tap", color: "#5d8d87", group: "device" },
  { key: "Npc", color: "#8a7fa8", group: "device" },
  { key: "Lvt", color: "#b08b4f", group: "well" },      // lvtn
  { key: "Hvt", color: "#a37446", group: "well" },      // hvtp (ALIGN 표의 GDS 번호는 자리표시 970/0)
  { key: "Nwell", color: "#556677", group: "well" },
  { key: "Nselect", color: "#4f6b5a", group: "well" },  // nsdm
  { key: "Pselect", color: "#6b5a4f", group: "well" },  // psdm
];

/** 화면의 층 이름 — SKY130 이름 (M1 -> li1, M2 -> met1, V0 -> licon1 …). ALIGN 의 M1 은 SKY130 의 met1 이 아니다 */
export const lname = (key) => layerName(key);
/** 마우스를 올렸을 때 — 두 이름 다 */
export const ltitle = (key) => { const n = layerName(key); return n === key ? key : `${n} (ALIGN ${key})`; };
/** 금속 층의 방향 — "v" 세로 · "h" 가로. 이 PDK 는 금속마다 한 방향이다 (PCB 와 다른 점) */
const DIR = new Map(PDK.Abstraction.filter((l) => /^M\d+$/.test(l.Layer)).map((l) => [l.Layer, l.Direction === "V" ? "v" : "h"]));
export const ldir = (key) => DIR.get(key) ?? null;
/** 방향 표시 — ↕ 세로 · ↔ 가로 */
export const larrow = (key) => (DIR.get(key) === "v" ? "↕" : DIR.get(key) === "h" ? "↔" : "");
/** Vk 는 Mk 와 Mk+1 사이 (V0 은 소자층과 M1 사이) */
export const viaBetween = (v) => { const k = Number(v.slice(1)); return [k ? "M" + k : null, "M" + (k + 1)]; };
const span = (keys) => { const n = keys.map(lname); return n.length > 2 ? `${n[0]}, ${n[1]}–${n.at(-1)}` : n.join(", "); };
export const GROUPS = [
  ["object", "Objects"],
  ["metal", `Metal ${span(["M1", "M2", "M3", "M4", "M5", "M6"])}`],
  ["via", `Vias ${span(["V0", "V1", "V2", "V3", "V4", "V5"])}`],
  ["device", "Device layers"],
  ["well", "Wells · implants"],
];
/** 오브젝트 층 — 도형이 아니라 덧그리는 것 */
export const OBJECTS = [
  { key: "blocks", label: "Block outlines", group: "object" },
  { key: "names", label: "Block names", group: "object" },
  { key: "fly", label: "Flylines (opens)", group: "object" },
  { key: "marks", label: "Error markers", group: "object" },
  { key: "grid", label: "Grid", group: "object" },
];
export const COLOR = new Map(LAYERS.map((l) => [l.key, l.color]));
export const GROUP_OF = new Map(LAYERS.map((l) => [l.key, l.group]));
/** 그리는 차례: 웰 -> 소자 -> 금속(아래부터, 지금 층은 맨 위) -> 비아 */
export const ORDER = ["well", "device", "metal", "via"];
export const ALPHA = { well: 0.16, device: 0.42, metal: 0.78, via: 0.9 };

/** 처음 보이는 것 — 웰은 꺼 둔다 (블록 전체를 덮는다) */
export function defaultVisible() {
  return new Set([...LAYERS.filter((l) => l.group !== "well").map((l) => l.key), ...OBJECTS.map((o) => o.key)]);
}
