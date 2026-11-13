/**
 * 레이아웃 예제의 목록 — Examples 메뉴의 "Layout — ALIGN examples (SKY130)" 에 보이는 이름. ALIGN-public 의 examples/ 의 회로를
 * SKY130 회로도로 옮긴 것이다 (src/layout/examples/). 메뉴에 이름을 보이려고 이것만 첫 화면에 싣고, 설명 · 넷리스트 ·
 * 회로도를 만드는 것은 고를 때 레이아웃 청크로 받는다 (src/layout/examples/index.ts).
 */
export const LAYOUT_EXAMPLE_MENU: Array<{ id: string; title: string }> = [
  { id: "five_transistor_ota", title: "Five-transistor OTA" },
  { id: "five_transistor_ota_high_frequency", title: "Five-transistor OTA, high frequency" },
  { id: "common_source", title: "Common-source amplifier" },
  { id: "telescopic_ota", title: "Telescopic OTA" },
  { id: "telescopic_ota_with_bias", title: "Telescopic OTA with bias" },
  { id: "current_mirror_ota", title: "Current-mirror OTA" },
  { id: "cascode_current_mirror_ota", title: "Cascode current-mirror OTA" },
  { id: "high_speed_comparator", title: "High-speed comparator" },
  { id: "double_tail_sense_amplifier", title: "Double-tail sense amplifier" },
  { id: "comparator1", title: "Comparator with ready logic" },
  { id: "inverter_current_starved", title: "Current-starved inverter" },
  { id: "ring_oscillator", title: "Ring oscillator" },
  { id: "vco_type2_65", title: "VCO" },
  { id: "linear_equalizer", title: "Linear equalizer" },
  { id: "variable_gain_amplifier", title: "Variable-gain amplifier" },
  { id: "single_to_differential_converter", title: "Single-to-differential converter" },
  { id: "unity_gain_buffers", title: "Unity-gain buffers" },
  { id: "powertrain_binary", title: "Power train, binary weighted" },
];
