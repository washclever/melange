/**
 * 레이아웃 예제를 연다 — 넷리스트(netlists.ts)를 SKY130 회로도로 (build.ts). 메뉴의 이름은 src/lib/layout-examples.ts.
 * 이 파일과 넷리스트는 레이아웃 청크에 든다: Examples 메뉴에서 고를 때 받는다.
 *
 * LAYOUT_EXAMPLES 는 검사(tools/e2e-layout-examples.ts)가 그대로 돈다: 회로도의 트랜지스터 수, 원래 서브회로의 핀이 레이아웃
 * 블록의 핀인지, 자동 배치 · 자동 배선 한 번 뒤의 DRC/LVS 오류 수(expect).
 */
import type { Project } from "../../doc/types.ts";
import { LAYOUT_EXAMPLE_MENU } from "../../lib/layout-examples.ts";
import { NETLISTS } from "./netlists.ts";
import { buildAlignExample } from "./build.ts";
import { BENCHES } from "./benches.ts";

/**
 * units · params: 레이아웃이 끝까지 가게 크기를 고친 예제 (어느 것이 왜인지는 줄마다). units 는 원래 핀 수 -> SKY130 단위의
 * 핀 수 (align.ts binSizes), params 는 넷리스트의 .param 을 바꾼다.
 */
const DETAILS: Record<string, { about: string; transistors: number; expect: number; units?: Record<number, number>; params?: Record<string, string> }> = {
  five_transistor_ota: { about: "Differential pair with a current-mirror load and a tail source", transistors: 5, expect: 0 },
  five_transistor_ota_high_frequency: { about: "5T OTA sized for bandwidth", transistors: 6, expect: 0 },
  common_source: { about: "Common-source stage with a pFET load", transistors: 2, expect: 0 },
  telescopic_ota: { about: "Fully differential telescopic cascode amplifier", transistors: 10, expect: 0 },
  telescopic_ota_with_bias: { about: "Telescopic OTA together with its bias network", transistors: 36, expect: 0 },
  // 5 · 7 · 10 핀 소자를 SKY130 의 3 핀 단위로 — 4 · 12 핀 단위로는 거울 쌍이 한 줄로 길게 서서 배선기가 길을 못 찾거나
  // VSS 하나가 끊긴다
  current_mirror_ota: { about: "OTA with current-mirror gain stages", transistors: 12, expect: 0, units: { 5: 3, 7: 3, 10: 3 } },
  cascode_current_mirror_ota: { about: "Current-mirror OTA with cascoded mirrors", transistors: 20, expect: 0 },
  high_speed_comparator: { about: "Clocked comparator: input pair, cross-coupled latch, output inverters", transistors: 15, expect: 0 },
  double_tail_sense_amplifier: { about: "Clocked double-tail latch comparator", transistors: 14, expect: 0 },
  // 6 핀 pFET 을 4 핀 단위로 — 3 핀 단위로는 넷 ON 하나가 끊긴다
  comparator1: { about: "Dynamic comparator with its clock and ready logic (hierarchical)", transistors: 22, expect: 0, units: { 6: 4 } },
  inverter_current_starved: { about: "Inverter with current-limiting bias devices", transistors: 7, expect: 0 },
  ring_oscillator: { about: "Five-stage inverter ring (hierarchical)", transistors: 10, expect: 0 },
  // 넷리스트는 단의 크기를 다른 회로(diff2sing)의 파라미터로 잡아 nFET 12 핀 x 12 핑거, pFET 10 핀 x 8 핑거다 — 그대로면
  // 배선기가 맨 위에서 길을 못 찾는다. 핑거를 둘씩으로
  vco_type2_65: { about: "Voltage-controlled delay stages of a ring VCO (hierarchical)", transistors: 32, expect: 0,
                  params: { fin_n_diff2sing: "2", fppp: "2" } },
  linear_equalizer: { about: "Continuous-time linear equalizer — its resistors and capacitors stay on the schematic", transistors: 12, expect: 0 },
  variable_gain_amplifier: { about: "Differential amplifier with switched gain settings", transistors: 17, expect: 0 },
  single_to_differential_converter: { about: "Converter around a stacked nFET pair, with resistors and capacitors on the schematic", transistors: 2, expect: 0 },
  unity_gain_buffers: { about: "Bank of unity-gain buffers (hierarchical)", transistors: 50, expect: 0 },
  powertrain_binary: { about: "Binary-weighted array of pFET power switches", transistors: 63, expect: 0 },
};

export interface LayoutExampleInfo { id: string; title: string; about: string; transistors: number; expect: number; units?: Record<number, number>; params?: Record<string, string> }

export const LAYOUT_EXAMPLES: LayoutExampleInfo[] = LAYOUT_EXAMPLE_MENU.map((m) => ({ ...m, ...DETAILS[m.id] }));

export function layoutExample(id: string): Project {
  const info = LAYOUT_EXAMPLES.find((e) => e.id === id);
  const n = NETLISTS[id];
  if (!info || !n) throw new Error(`There is no layout example "${id}".`);
  return buildAlignExample({ id, title: `${info.title} (ALIGN, SKY130)`, sp: n.sp, constraints: n.constraints, about: info.about, bench: BENCHES[id], units: info.units, params: info.params });
}
