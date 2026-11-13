/** 셀 생성기가 보는 PDK — ALIGN cell_fabric/pdk.py 의 Pdk.
 *
 *  layers.json 의 Abstraction 을 층 이름으로 찾게 한다. 금속의 Direction 은 소문자('v'/'h')로,
 *  "NA" 는 null 로 바꾼다 (ALIGN 과 같다). 순서는 layers.json 그대로다.
 */
export class Pdk {
  /** @param {{Abstraction: Array<object>, design_info?: object, ScaleFactor?: number}} layers */
  constructor(layers) {
    if (!layers?.Abstraction) throw new Error("the PDK has no Abstraction");
    /** @type {Map<string, object>} */
    this.layers = new Map();
    this.design_info = layers.design_info ?? {};
    this.ScaleFactor = layers.ScaleFactor ?? 1;
    for (const l of layers.Abstraction) {
      const name = l.Layer;
      if (this.layers.has(name)) throw new Error(`layer ${name} is defined twice`);
      if (!/^[A-Z]/.test(name)) throw new Error(`layer name ${name} must start with a capital letter`);
      const info = {};
      for (const [k, v] of Object.entries(l)) if (k !== "Layer") info[k] = v === "NA" ? null : v;
      if (name.startsWith("M")) {
        info.Direction = String(info.Direction).toLowerCase();
        if (info.Direction !== "v" && info.Direction !== "h") throw new Error(`${name}: bad direction ${info.Direction}`);
      } else if (name.startsWith("V")) {
        if (!Array.isArray(info.Stack) || info.Stack.length !== 2) throw new Error(`${name}: bad Stack`);
        for (const m of info.Stack) if (m != null && !this.layers.has(m)) throw new Error(`${name}: metal ${m} is not defined before it`);
      }
      this.layers.set(name, info);
    }
  }
  has(layer) { return this.layers.has(layer); }
  get(layer) {
    const l = this.layers.get(layer);
    if (!l) throw new Error(`layer ${layer} is not in the PDK`);
    return l;
  }
  items() { return this.layers.entries(); }
  /** [[비아, [아래 금속, 위 금속]], ...] — 정의 순서대로 */
  get_via_stack() {
    const out = [];
    for (const [l, info] of this.layers) if (l.startsWith("V")) out.push([l, [info.Stack[0], info.Stack[1]]]);
    return out;
  }
}
