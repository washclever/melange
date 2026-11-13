/**
 * 넷리스트 생성과 실행 전 검사.
 *
 * 넷 추출 결과로 노드 이름을 정하고, 부품마다 라이브러리 템플릿을 채운다.
 * 템플릿의 {ref} 는 지정자, {핀id} 는 그 핀이 속한 노드, 그 밖의 {키} 는 파라미터다.
 */
import type { LibParam, LibPart, Part, Sheet, SimSettings, SpiceBlock } from "../doc/types.ts";
import { asciiTitle, parseEng } from "../doc/units.ts";
import { SKY130_IDS } from "../lib/parts.ts";
import { SKY130_BINS } from "../vendor/sky130-bins.ts";
import type { Extraction } from "./extract.ts";

export interface Issue {
  level: "error" | "warning";
  message: string;
  /** 문제가 있는 부품 id. 누르면 그 위치로 가기 위한 것 */
  partId?: string;
}

/** 실행 전 검사 (설계서 E26) */
export function checkCircuit(
  sheet: Sheet,
  library: Record<string, LibPart>,
  ex: Extraction,
): Issue[] {
  const out: Issue[] = [];

  /*
   * 떠 있는 핀 판정. 넷 추출이 union-find 에서 바로 구해 두었으면(ex.floating) 그것을 쓴다 —
   * 넷 이름별 표를 만드는 것만으로 부품 5만 개에서 편집마다 100 ms 였다. 없으면 예전처럼 센다.
   */
  const fast = ex.floating;
  const pinsOnNet = new Map<string, number>();
  if (!fast) for (const n of ex.pinNet.values()) pinsOnNet.set(n, (pinsOnNet.get(n) ?? 0) + 1);

  /*
   * GND 없음.
   *
   * 넷리스트는 회로도 + SPICE 지시문 블록(E33)이다. 외부 .sp 를 불러오면 접지가
   * 보존한 줄에만 있을 수 있어서, 회로도만 보고 "GND 가 없다" 고 막으면 멀쩡한
   * 회로를 못 돌린다. 블록에 노드 0 을 쓰는 줄이 있으면 접지가 있는 것으로 본다.
   */
  const groundInBlocks = (sheet.spice ?? []).some(b =>
    b.active && b.lines.some(l => !l.trim().startsWith(".") && /(^|\s)0(\s|$)/.test(l)));
  if (ex.netSize("0") === 0 && !groundInBlocks) {
    out.push({ level: "error", message: "There is no GND. Place a ground symbol" });
  }

  // 지정자 중복
  const seen = new Map<string, number>();
  for (const p of sheet.parts) {
    if (library[p.lib]?.id === "gnd") continue;
    seen.set(p.ref, (seen.get(p.ref) ?? 0) + 1);
  }
  for (const [ref, n] of seen) {
    if (n > 1) out.push({ level: "error", message: `${n} parts share the designator ${ref}` });
  }

  /** 입력 핀(sensePins)과 동작 전원의 식이 읽는 넷. 부품을 훑는 김에 모아 두고 끝에서 본다 */
  const inputs: Array<{ part: Part; what: string; net: string | undefined; key?: string; expr?: boolean }> = [];

  for (const part of sheet.parts) {
    const lib = library[part.lib];
    if (!lib) continue;

    // 값 없음
    for (const prm of lib.params) {
      const v = (part.params[prm.key] ?? "").trim();
      if (!v) {
        out.push({ level: "error", message: `${part.ref}: ${prm.label} is empty`, partId: part.id });
      } else if (/^[\d.]+M$/.test(v)) {
        // SPICE 에서 M 은 milli 다. 메가를 뜻했다면 meg 이어야 한다
        out.push({
          level: "warning",
          message: `In ${part.ref}'s value "${v}", M means milli (1e-3). For mega write ${v.slice(0, -1)}meg`,
          partId: part.id,
        });
      } else if (prm.min !== undefined || prm.max !== undefined) {
        // 범위 밖. 결합 계수 1.2 는 ngspice 가 오류 대신 1e293 같은 숫자를 낸다
        const x = parseEng(v);
        if (x !== null && ((prm.min !== undefined && x < prm.min) || (prm.max !== undefined && x > prm.max))) {
          out.push({ level: "error", message: `${part.ref}: ${prm.label} must be ${rangeText(prm)} (it is ${v})`, partId: part.id });
        }
      }
    }

    /*
     * 입력과 감지 단자. 아래의 '떠 있는 핀' 판정이 continue 로 부품을 건너뛰므로 그보다 먼저 본다 —
     * 뒤에 두면 넷 추출이 떠 있는 핀을 바로 알려 주는 길(fast)과 예전 길의 결과가 달라진다.
     */
    const sense = sensePins(lib);
    for (const pin of lib.symbol.pins) {
      if (!sense.has(pin.id) || part.nc?.includes(pin.id)) continue;
      const key = part.id + ":" + pin.id;
      const net = ex.pinNet.get(key);
      if (net !== "0") inputs.push({ part, what: `input ${pin.name}`, net, key });
    }
    if (lib.spice?.element === "B") {
      for (const prm of lib.params) {
        for (const node of exprNodes(part.params[prm.key] ?? "")) inputs.push({ part, what: `V(${node})`, net: node, expr: true });
      }
    }
    // 전류를 재는 0 V 전원(F·H 의 제어 단자)의 양 끝이 한 넷이면 행렬이 특이해진다
    for (const [a, b] of shortPorts(lib)) {
      const na = ex.pinNet.get(part.id + ":" + a), nb = ex.pinNet.get(part.id + ":" + b);
      if (na !== undefined && na === nb) {
        const name = (id: string) => lib.symbol.pins.find(p => p.id === id)?.name ?? id;
        out.push({
          level: "error",
          message: `${part.ref}: control pins ${name(a)} and ${name(b)} are on the same net (short) — the current between them is undefined`,
          partId: part.id,
        });
      }
    }

    /*
     * SKY130 소자는 치수마다 다른 모델 bin 을 쓴다. 어느 bin 에도 안 걸리는 W·L 을 주면
     * ngspice 가 소자 줄에서 죽는데, 로그에는 모델 이름도 없는 긴 줄 하나만 남아 원인을
     * 알기 어렵다. 먼저 잡고 **가장 가까운 쓸 수 있는 값**을 알려 준다.
     */
    const sub = sky130Subckt(lib);
    if (sub) {
      const w = parseEng(part.params.w), l = parseEng(part.params.l);
      const bins = SKY130_BINS[sub];
      if (bins && w !== null && l !== null && !bins.some(b => l >= b[0] && l <= b[1] && w >= b[2] && w <= b[3])) {
        const forL = bins.filter(b => l >= b[0] && l <= b[1]);
        const hint = forL.length
          ? `W must be one of: ${widthList(forL)}`
          : `L must be one of: ${lengthList(bins)}`;
        out.push({
          level: "error",
          message: `${part.ref}: the SKY130 model has no bin for W=${part.params.w} L=${part.params.l}. ${hint}`,
          partId: part.id,
        });
      }
    }

    // 떠 있는 핀 — 그 넷에 자기 말고 아무것도 없으면 떠 있는 것이다.
    // 미연결 표시(E05)를 붙인 핀은 일부러 비워 둔 것이므로 경고에서 뺀다
    if (fast && !fast.parts.has(part.id)) continue;   // 이 부품엔 떠 있는 핀이 없다
    lib.symbol.pins.forEach(pin => {
      if (part.nc?.includes(pin.id)) return;
      if (sense.has(pin.id)) return;                  // 입력은 경고가 아니라 오류다 (아래)
      let floating: boolean;
      if (fast) floating = fast.pins.has(part.id + ":" + pin.id);
      else {
        const net = ex.pinNet.get(part.id + ":" + pin.id);
        const coords = net ? ex.netSize(net) : 0;
        const pins = net ? (pinsOnNet.get(net) ?? 0) : 0;
        floating = !net || (pins <= 1 && coords <= 1);
      }
      if (floating) {
        out.push({
          level: "warning",
          message: `${part.ref}: pin ${pin.name} is floating`,
          partId: part.id,
        });
      }
    });
  }

  /*
   * 아무것도 구동하지 않는 넷을 읽는 입력 (op-amp·제어 전원의 입력, 동작 전원의 V(넷)).
   *
   * 입력은 전류를 받지 않으니, 그 넷에 입력만 붙어 있으면 무엇도 전압을 정하지 않는다. ngspice 는
   * 이런 회로를 못 풀고, 이 엔진 빌드에서는 **실행이 끝나지 않는다** — 'no writable vector found'
   * 를 남기고 결과도 오류도 돌려주지 않는다. 그래서 떠 있는 입력은 경고가 아니라 오류다.
   * (그래도 새어 나간 경우는 워커가 멈춘 엔진을 알아채고 끝낸다 — src/sim-run.ts)
   *
   * 다른 핀이 하나라도 붙어 있으면 구동되는 것으로 본다. 커패시터 하나뿐인 넷처럼 직류로는 떠
   * 있어도 ngspice 는 풀어 낸다 (재 봤다). 지시문 블록의 소자 줄이 그 이름을 쓰면 그것도 믿는다 —
   * 외부 .sp 를 옮긴 회로에서는 그 줄이 넷을 구동한다.
   */
  if (inputs.length) {
    const byLower = new Map<string, string>();
    for (const n of ex.netNames()) byLower.set(n.toLowerCase(), n);
    const resolve = (i: (typeof inputs)[number]) => i.expr ? byLower.get(i.net!.toLowerCase()) : i.net;
    const want = new Set<string>();
    for (const i of inputs) { const n = resolve(i); if (n !== undefined) want.add(n); }
    const inputKeys = new Set(inputs.map(i => i.key).filter((k): k is string => !!k));
    const driven = new Set<string>();
    if (want.size) for (const [k, net] of ex.pinNet) if (want.has(net) && !inputKeys.has(k)) driven.add(net);
    const inBlocks = blockNodes(sheet.spice ?? []);
    for (const i of inputs) {
      const net = resolve(i);
      if (net === "0" || (net !== undefined && driven.has(net)) || inBlocks.has((net ?? i.net ?? "").toLowerCase())) continue;
      out.push({
        level: "error",
        message: i.expr
          ? net === undefined
            ? `${i.part.ref}: the expression reads ${i.what}, but no net is named ${i.net}`
            : `${i.part.ref}: the expression reads ${i.what}, and nothing drives that net`
          : `${i.part.ref}: ${i.what} is not driven by anything — ngspice cannot solve a net that only inputs read`,
        partId: i.part.id,
      });
    }
  }

  /*
   * 같은 모델 이름에 계수를 다르게 넣으면 .model 줄이 두 개 나간다.
   * ngspice 는 오류 없이 하나를 골라 쓰므로 — 조용히 다른 회로가 된다.
   * 모델 이름은 SPICE 에서 대소문자를 가리지 않는다.
   *
   * 모델 이름을 속성으로 여는 부품(다이오드·트랜지스터)만 본다. 스위치처럼 부품마다 제 이름의
   * 모델을 내는 부품({ref}_MOD)은 겹칠 일이 없다.
   */
  const models = new Map<string, string>();
  for (const part of sheet.parts) {
    const lib = library[part.lib];
    if (!lib || !lib.params.some(p => p.key === "model")) continue;
    const line = modelLine(part, lib);
    if (!line) continue;
    const name = (part.params.model ?? "").toUpperCase();
    const prev = models.get(name);
    if (prev === undefined) models.set(name, line);
    else if (prev !== line) {
      out.push({
        level: "error",
        message: `Model ${part.params.model} has different coefficients per part. Give them separate names`,
        partId: part.id,
      });
    }
  }

  /*
   * 전압원끼리 직접 병렬 (설계서 E26).
   *
   * 같은 두 노드에 전압원이 둘 붙으면 행렬이 특이해져 ngspice 가 풀지 못한다.
   * 오류 메시지는 노드 이름만 가리켜서 원인을 알기 어렵다 — 여기서 먼저 잡는다.
   * 양 끝이 같은 노드인 전압원(스스로 단락)도 같은 이유로 막는다.
   */
  const vPairs = new Map<string, string[]>();
  for (const part of sheet.parts) {
    const lib = library[part.lib];
    if (lib?.spice?.element !== "V") continue;
    const nets = lib.symbol.pins.map(p => ex.pinNet.get(part.id + ":" + p.id) ?? "?");
    if (nets.length !== 2 || nets.includes("?")) continue;
    if (nets[0] === nets[1]) {
      out.push({ level: "error", message: `${part.ref} has both ends on the same net (short)`, partId: part.id });
      continue;
    }
    const k = [...nets].sort().join("|");
    const others = vPairs.get(k) ?? [];
    if (others.length) {
      out.push({
        level: "error",
        message: `${part.ref} and ${others.join(", ")} sit directly in parallel across the same two nodes`,
        partId: part.id,
      });
    }
    vPairs.set(k, [...others, part.ref]);
  }

  /*
   * 아무것도 회로를 구동하지 않는다 — 독립 전원(V · I)도 동작 전원(B)도 없고 지시문 블록에도 전원 줄이 없다. 돌리면 모든
   * 전압이 0 인 결과가 오류 없이 나와 고장처럼 보인다 (전원 기호는 넷 이름일 뿐 전압을 정하지 않는다). 레이아웃 예제를
   * 테스트벤치가 생기기 전에 열어 두어 자동 저장된 것이 이렇다 — 그때는 메뉴에서 다시 열라고 알린다.
   */
  const driving = (e: string | undefined) => e === "V" || e === "I" || e === "B";
  const sourceInBlocks = (sheet.spice ?? []).some(b => b.active && b.lines.some(l => /^\s*[vib]\w*\s/i.test(l)));
  if (sheet.parts.some(p => library[p.lib]?.spice) && !sheet.parts.some(p => driving(library[p.lib]?.spice?.element)) && !sourceInBlocks) {
    const align = sheet.notes.some(n => (n.text ?? "").includes("ALIGN-public examples/"));
    out.push({
      level: "warning",
      message: "No source drives the circuit, so every voltage will be 0. Add a supply and an input" +
        (align ? " — this ALIGN example was saved before it had a test bench; open it again from Examples (Layout — ALIGN examples)" : ""),
    });
  }

  for (const w of ex.warnings) out.push({ level: "warning", message: w });
  return out;
}

/**
 * 잡음 · 전달 함수의 출력. 넷 이름만 적으면 v(넷) 으로 싼다 — v(a,b) · i(Vx) 는 그대로 둔다.
 * 패널에는 "out" 만 적게 하는 편이 편하고, 차동 출력이나 전류 출력도 막지 않으려는 것이다.
 */
export function outputSpec(out: string): string {
  const t = out.trim();
  return /^[vi]\s*\(/i.test(t) ? t.replace(/\s+/g, "") : `v(${t})`;
}

/** 해석 줄. 인자 순서는 ngspice 문법 그대로다 */
function analysisLine(sim: SimSettings): string {
  switch (sim.kind) {
    // .tran tstep tstop tstart tmax
    case "tran": return `.tran ${sim.tmax} ${sim.tstop} ${sim.tstart} ${sim.tmax}`;
    case "op": return ".op";
    // .dc 소스 시작 끝 간격
    case "dc": return `.dc ${sim.source} ${sim.start} ${sim.stop} ${sim.step}`;
    // .ac dec|oct|lin 점수 시작주파수 끝주파수
    case "ac": return `.ac ${sim.sweep} ${sim.points} ${sim.fstart} ${sim.fstop}`;
    // .noise 출력 입력전원 dec|oct|lin 점수 시작 끝
    case "noise": return `.noise ${outputSpec(sim.out)} ${sim.src} ${sim.sweep} ${sim.points} ${sim.fstart} ${sim.fstop}`;
    // .tf 출력 입력전원
    case "tf": return `.tf ${outputSpec(sim.out)} ${sim.src}`;
  }
}

/**
 * AC · 잡음 해석일 때만 전압원에 AC 크기를 적는다.
 *
 * 한 소자 줄에 DC·AC 스펙과 과도 스펙을 같이 쓸 수 있어서
 * (`V1 in 0 AC 1 SIN(...)`), 같은 회로로 두 해석을 다 돌릴 수 있다.
 * 그래도 과도 해석 넷리스트에는 넣지 않는다 — 설계서에 적힌 데모 넷리스트와
 * 글자 하나까지 같아야 .sp 왕복과 데스크톱 ngspice 대조가 그대로 유지된다.
 *
 * 잡음 해석은 입력 전원에 AC 크기가 **반드시** 있어야 한다. 없으면 ngspice 가 'Noise input source
 * has no AC value' 를 남기고 해석을 건너뛴다. 바이어스용 직류 전류원처럼 AC 가 0 인 전원을 입력으로
 * 골랐으면 그것만 1 로 올린다. 다른 전원의 AC 크기는 잡음 결과에 아무 영향이 없다 (재 봤다).
 */
function acSpec(sim: SimSettings, part: Part, name: string): string {
  if (sim.kind !== "ac" && sim.kind !== "noise") return "";
  let ac = part.params.ac ?? "1";
  if (sim.kind === "noise" && name.toUpperCase() === sim.src.trim().toUpperCase() && !(parseEng(ac) ?? 0)) ac = "1";
  return `AC ${ac} `;
}

/**
 * 부품 하나가 필요로 하는 .model 줄. 모델이 없는 부품이면 null.
 *
 * 모델 틀에는 노드가 들어가지 않고 계수만 들어간다 — 그래서 넷 추출 결과 없이도
 * 만들 수 있고, 실행 전 검사에서 같은 이름의 모델끼리 비교하는 데 쓴다.
 */
export function modelLine(part: Part, lib: LibPart): string | null {
  const tpl = lib.spice?.model;
  if (!tpl) return null;
  return tpl
    // {ref} 는 소자 줄과 같은 이름이다. 부품마다 제 모델을 내는 부품(스위치: {ref}_MOD)이 쓴다
    .replace(/\{(\w+)\}/g, (_, k: string) => k === "ref" ? spiceName(part.ref, lib.spice!.element) : part.params[k] ?? "?")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 부품 하나가 넷리스트에 내는 소자 줄들.
 *
 * 틀에 줄바꿈이 있으면 줄마다 따로 채운다 (LibPart.spice.template). 줄바꿈이 없는 틀은 예전과
 * 글자 하나까지 같은 줄 하나를 낸다 — .sp 왕복과 데스크톱 ngspice 대조가 그 같음에 기대고 있다.
 *
 * node 는 핀 id 를 노드 이름으로 바꾼다. 넷리스트는 넷 추출 결과를 넘기고, 부품 라이브러리 창의
 * 미리보기는 핀 이름을 넘긴다. 같은 함수라서 미리보기가 실제로 나갈 줄과 어긋날 수 없다.
 */
export function deviceLines(
  part: Part, lib: LibPart, node: (pinId: string) => string, sim: SimSettings,
): string[] {
  const spice = lib.spice;
  if (!spice) return [];
  return spice.template.split("\n").map(tpl => tpl.replace(/\{(\w+)\}/g, (_, k: string) => {
    if (k === "ref") return spiceName(part.ref, spice.element);
    if (k === "acspec") return acSpec(sim, part, spiceName(part.ref, spice.element));
    if (lib.symbol.pins.some(p => p.id === k)) return node(k);
    return part.params[k] ?? "?";
  }).replace(/\s+/g, " ").trim()).filter(l => l);
}

/**
 * 입력 핀 — 전압만 읽고 전류는 받지 않는 핀. 틀에서 읽는다:
 *   E·G 줄의 3·4번째 노드 (제어 단자). 이상 op-amp 도 E 라서 +·- 입력이 여기 든다
 *   B 줄의 V({핀}) (비교기·곱셈기의 입력)
 *
 * 핀에 표시를 달지 않고 틀에서 읽는 것은, 프로젝트 파일에 든 **예전 사본**에도 맞게 하려는 것이다.
 * 표시를 달면 예전에 저장한 op-amp 는 표시가 없어 검사를 빠져나간다.
 */
const senseCache = new WeakMap<LibPart, Set<string>>();
export function sensePins(lib: LibPart): Set<string> {
  let s = senseCache.get(lib);
  if (s) return s;
  s = new Set();
  const pins = new Set(lib.symbol.pins.map(p => p.id));
  const placeholder = (tok: string | undefined) => /^\{(\w+)\}$/.exec(tok ?? "")?.[1];
  for (const line of (lib.spice?.template ?? "").split("\n")) {
    const el = lineElement(line, lib);
    if (el === "E" || el === "G") {
      const t = line.trim().split(/\s+/);
      for (const id of [placeholder(t[3]), placeholder(t[4])]) if (id && pins.has(id)) s.add(id);
    } else if (el === "B") {
      for (const m of line.matchAll(/\bv\s*\(\s*\{(\w+)\}\s*(?:,\s*\{(\w+)\}\s*)?\)/gi)) {
        for (const id of [m[1], m[2]]) if (id && pins.has(id)) s.add(id);
      }
    }
  }
  senseCache.set(lib, s);
  return s;
}

/**
 * 감지용 0 V 전원의 두 핀 (F·H 의 제어 단자). 틀에서 'V' 로 시작하는 덧붙은 줄이다 (V{ref}_s).
 * 둘이 한 넷이면 전원이 제 자리에서 단락돼 행렬이 특이해진다.
 */
function shortPorts(lib: LibPart): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of (lib.spice?.template ?? "").split("\n")) {
    const t = line.trim().split(/\s+/);
    if (!/^V\{ref\}/i.test(t[0] ?? "")) continue;
    const a = /^\{(\w+)\}$/.exec(t[1] ?? "")?.[1], b = /^\{(\w+)\}$/.exec(t[2] ?? "")?.[1];
    if (a && b) out.push([a, b]);
  }
  return out;
}

/** 틀 한 줄의 소자 문자. {ref} 로 시작하면 부품의 문자, 아니면 앞에 적힌 글자 (V{ref}_s, K{ref}) */
function lineElement(line: string, lib: LibPart): string {
  const head = line.trim();
  return (head.startsWith("{") ? lib.spice?.element ?? "" : head[0] ?? "").toUpperCase();
}

/** 식이 읽는 노드: V(in) · V(a,b). 0 은 접지라 뺀다 */
export function exprNodes(expr: string): string[] {
  const out: string[] = [];
  for (const m of expr.matchAll(/\bv\s*\(\s*([^(),\s]+)\s*(?:,\s*([^(),\s]+)\s*)?\)/gi)) {
    for (const n of [m[1], m[2]]) if (n && n !== "0" && !out.includes(n)) out.push(n);
  }
  return out;
}

/** 켜 둔 지시문 블록의 소자 줄이 쓰는 이름들 (소문자). 거친 어림이다 — 소자 이름 뒤의 낱말 전부 */
function blockNodes(blocks: readonly SpiceBlock[]): Set<string> {
  const out = new Set<string>();
  for (const b of blocks) {
    if (!b.active) continue;
    for (const raw of b.lines) {
      const t = raw.trim();
      if (!t || t.startsWith("*") || t.startsWith(".") || t.startsWith("+")) continue;
      for (const w of t.split(/\s+/).slice(1)) out.add(w.toLowerCase());
    }
  }
  return out;
}

const rangeText = (p: LibParam): string =>
  p.min !== undefined && p.max !== undefined ? `between ${p.min} and ${p.max}`
  : p.min !== undefined ? `at least ${p.min}` : `at most ${p.max}`;

/**
 * 줄 순서 (설계서 내보내기 규칙 3): 신호원 -> 수동 소자 -> 제어 전원 -> 반도체.
 * 같은 종류 안에서는 지정자 번호 순. 순서가 고정이라 같은 회로는 늘 같은 파일이 된다.
 *
 * 전송선(T)은 수동 소자 끝에, 제어 전원 넷(E G F H)과 동작 전원(B)은 그다음, 스위치(S)는
 * 반도체 앞이다. 예전에 있던 글자들끼리의 순서는 그대로라 예전 회로의 넷리스트는 바뀌지 않는다.
 */
const ELEMENT_ORDER = ["V", "I", "R", "C", "L", "T", "E", "G", "F", "H", "B", "S", "D", "Q", "M", "X"];

/**
 * SKY130 모델 파일들. 엔진의 가상 파일 시스템에서의 자리다.
 *
 * **소자별로 쪼개 둔다** (tools/extract-sky130.mjs). 한 덩어리였을 때는 nFET 하나 쓰는
 * 회로도 2.29 MB 를 통째로 읽었는데, 그중 1.23 MB 가 쓰지도 않는 hvt 의 bin 198개였다.
 * 쓰는 것만 부르면 nFET 회로는 0.62 MB, 인버터는 1.05 MB 만 읽는다.
 */
export const SKY130_COMMON = "/sky130-common.spice";
export const SKY130_FILES: Record<string, string> = {
  sky130_fd_pr__nfet_01v8: "/sky130-nfet.spice",
  sky130_fd_pr__pfet_01v8: "/sky130-pfet.spice",
  sky130_fd_pr__pfet_01v8_hvt: "/sky130-pfet-hvt.spice",
};

/** 이 부품이 SKY130 서브회로라면 그 이름. 템플릿에 적힌 것을 그대로 읽는다 */
function sky130Subckt(lib: LibPart): string | null {
  if (!SKY130_IDS.includes(lib.id)) return null;
  return /\b(sky130_fd_pr__\w+)/.exec(lib.spice?.template ?? "")?.[1]?.toLowerCase() ?? null;
}

/** 미터를 보기 좋은 µm 으로. 0.15e-6 -> 0.15u */
const um = (m: number) => `${Number((m * 1e6).toPrecision(4))}u`;

/** 쓸 수 있는 치수를 작은 것부터 적는다. 섞여 있으면 눈으로 고르기 힘들다 */
const sizeList = (bins: Array<[number, number, number, number]>, lo: 0 | 2) =>
  [...new Set(bins.map(b => (b[lo] + b[lo + 1]) / 2))].sort((a, b) => a - b).map(um).join(", ");
const widthList = (bins: Array<[number, number, number, number]>) => sizeList(bins, 2);
const lengthList = (bins: Array<[number, number, number, number]>) => sizeList(bins, 0);

/** 이 시트가 불러야 하는 모델 파일들. SKY130 을 안 쓰면 빈 배열이다 */
export function sky130Includes(sheet: Sheet, library: Record<string, LibPart>): string[] {
  const subs = new Set<string>();
  for (const p of sheet.parts) {
    const lib = library[p.lib];
    const sub = lib && sky130Subckt(lib);
    if (sub && SKY130_FILES[sub]) subs.add(sub);
  }
  if (!subs.size) return [];
  // 공용 파라미터가 먼저다. 그다음은 이름순이라 같은 회로는 늘 같은 파일이 된다
  return [SKY130_COMMON, ...[...subs].sort().map(x => SKY130_FILES[x])];
}

/** 이 시트가 SKY130 공정 소자를 쓰는가 */
export function usesSky130(sheet: Sheet, library: Record<string, LibPart>): boolean {
  return sheet.parts.some(p => SKY130_IDS.includes(library[p.lib]?.id ?? p.lib));
}

/**
 * SPICE 이름 (규칙 4): 지정자가 소자 문자로 시작하면 그대로, 아니면 앞에 붙인다.
 * op-amp U1 -> EU1
 */
export function spiceName(ref: string, element: string): string {
  return ref.toUpperCase().startsWith(element.toUpperCase()) ? ref : element + ref;
}

/** 지정자 끝의 숫자. 없으면 0 */
const refNumber = (ref: string): number => Number(/(\d+)$/.exec(ref)?.[1] ?? 0);

/** 설계서 규칙 3 의 순서로 부품을 정렬한다 */
export function orderedParts(sheet: Sheet, library: Record<string, LibPart>) {
  return sheet.parts
    .filter(p => library[p.lib]?.spice)
    .sort((a, b) => {
      const ea = library[a.lib].spice!.element, eb = library[b.lib].spice!.element;
      const ia = ELEMENT_ORDER.indexOf(ea), ib = ELEMENT_ORDER.indexOf(eb);
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      const na = refNumber(a.ref), nb = refNumber(b.ref);
      if (na !== nb) return na - nb;
      return a.ref.localeCompare(b.ref, "en");
    });
}

export function buildNetlist(
  sheet: Sheet,
  library: Record<string, LibPart>,
  ex: Extraction,
  sim: SimSettings,
  title = "melange",
  /** .meas 줄 (ngspice 자동 측정). 해석 줄 뒤, .end 앞에 그대로 나간다 */
  meas: readonly string[] = [],
): string {
  const lines: string[] = [`* ${asciiTitle(title)} - generated`];

  /*
   * SKY130 소자를 하나라도 쓰면 모델 파일을 불러 와야 한다.
   *
   * 파일은 워커가 가상 파일 시스템에 올려 둔다 (SKY130_FILES). 쓰는 소자 것만 부른다.
   * 서브회로 이름을 풀어야 하니 **소자 줄보다 앞**에 둔다. 쓰지 않으면 줄도 안 나가므로
   * 저항 하나짜리 회로의 넷리스트는 예전과 글자 하나까지 같다.
   */
  for (const f of sky130Includes(sheet, library)) lines.push(`.include ${f}`);

  for (const part of orderedParts(sheet, library)) {
    // 노드 이름은 소문자 (규칙 5). GND 는 0
    const node = (pinId: string) => (ex.pinNet.get(part.id + ":" + pinId) ?? "?").toLowerCase();
    lines.push(...deviceLines(part, library[part.lib], node, sim));
  }

  /*
   * 미연결 표시를 붙인 핀은 혼자인 노드라 그대로 두면 ngspice 가 떠 있는 노드로 실패한다.
   * 그래서 그 노드에서 0 으로 가는 1 TΩ 저항을 자동으로 넣는다 (설계서 내보내기 규칙 6).
   * 이름을 밑줄로 시작해 사용자 지정자와 겹치지 않게 한다.
   */
  let ncCount = 0;
  for (const part of sheet.parts) {
    const lib = library[part.lib];
    if (!lib?.spice || !part.nc?.length) continue;
    for (const pinId of part.nc) {
      const net = ex.pinNet.get(part.id + ":" + pinId);
      if (!net || net === "0") continue;
      lines.push(`R_nc${++ncCount} ${net.toLowerCase()} 0 1T`);
    }
  }

  /*
   * 쓴 .model 줄 (설계서 내보내기 규칙 7: 소자 줄 다음, 해석 줄 앞).
   * 같은 모델을 여러 부품이 써도 한 번만 적고, 이름순이라 같은 회로는 늘 같은 파일이 된다.
   */
  const models = new Set<string>();
  for (const part of orderedParts(sheet, library)) {
    const line = modelLine(part, library[part.lib]);
    if (line) models.add(line);
  }
  lines.push(...[...models].sort());

  /*
   * SPICE 지시문 블록 (설계서 E33 · 내보내기 규칙 7). 모델 줄 다음, 해석 줄 앞.
   * 꺼 둔 블록은 지우지 않고 줄마다 `*` 를 붙여 주석으로 내보낸다.
   * 원문 그대로 나가야 하므로 여기서는 공백도 건드리지 않는다.
   */
  for (const block of sheet.spice ?? []) {
    for (const line of block.lines) {
      if (!line.trim()) continue;
      lines.push(block.active ? line : "* " + line);
    }
  }

  lines.push(analysisLine(sim));
  /*
   * 자동 측정은 **해석 줄 다음**이다. ngspice 가 해석을 돌린 결과에서 재는 것이라
   * 순서가 뒤바뀌면 잴 파형이 아직 없다. 빈 줄은 내보내지 않는다.
   */
  for (const m of meas) {
    const t = m.trim();
    if (t) lines.push(/^\.meas(ure)?\b/i.test(t) ? t : ".meas " + t);
  }
  lines.push(".end");
  return lines.join("\n");
}

// ── 실행할 때만 붙이는 줄 ─────────────────────────────────────────────
/**
 * 실행에 무엇을 저장할지 (.save).
 *
 * `.save` 가 없으면 ngspice 는 **모든** 노드 전압과 가지 전류를 시간점마다 저장하고, 그 전부가
 * 엔진 안 벡터 -> out.raw -> JS 배열 -> Float64Array 로 서너 번 복사된다. 엔진의 WASM 힙은
 * 2 GB 가 끝이다. 잰 것:
 *
 *   SKY130 인버터 300단 (BSIM4 600개)  29.1 s · 1.1 GB  ->  24.4 s · 0.5 GB  (벡터 2,105 -> 305)
 *   RC 사다리 10,000단                 23.9 s · 1.8 GB  ->   6.2 s · 0.5 GB  (프로브한 넷만)
 *
 * SKY130 소자는 서브회로라 인버터 하나마다 내부 노드가 여섯씩 딸려 오는데, 파형 패널은 이름에
 * 점이나 # 이 든 것을 어차피 버린다. 그래서 기본은 **최상위 넷 전압 전부** 다 — 실행한 뒤에
 * 프로브를 꽂아도 다시 돌리지 않고 그려진다는 약속(E24)은 그대로다.
 *
 * 넷이 아주 많으면(MANY_NETS 이상) 최상위 넷만으로도 수백 MB 다. 프로브가 있으면 그때는 프로브한
 * 넷만 저장하고, 그렇게 했다는 것을 알린다 — 다른 넷을 보려면 프로브를 꽂고 다시 돌려야 한다.
 *
 * DC 동작점(.op)은 줄이지 않는다. 점 하나라 줄일 것도 없고, 프로브가 없으면 표에 **가지 전류까지**
 * 보여 주는데(동작점에서는 그게 보고 싶은 값이다) 전압만 저장하면 그 줄이 사라진다.
 *
 * 무엇을 저장할지 확신할 수 없으면 줄을 붙이지 않는다 (예전처럼 전부 저장):
 *  - 지시문 블록에 소자 줄이 있다 — 회로도에 없는 노드가 생긴다 (외부 .sp 를 옮긴 경우)
 *  - 지시문 블록에 출력을 정하는 줄(.save .probe .print .control …)이 있다 — 사용자의 뜻이다
 *  - .meas 가 par('…') 처럼 우리가 읽지 못하는 식을 쓴다
 */
export const MANY_NETS = 2000;

export interface SavePlan {
  /** .end 앞에 넣을 줄. 비었으면 예전처럼 전부 저장한다 */
  lines: string[];
  /** 로그에 남길 한 줄 (무엇을 왜 줄였는지). 비었으면 말할 것이 없다 */
  note: string;
}

export function savePlan(
  netNames: Iterable<string>, probed: readonly string[], meas: readonly string[],
  blocks: readonly SpiceBlock[], kind: SimSettings["kind"] = "tran",
  /**
   * 계산기가 읽는 벡터 (src/calc/eval.ts calcSaves). 소자 파라미터(@m1[gm])는 ngspice 가 기본으로
   * 저장하지 않으므로, 전부 저장하는 경우에도 따로 적어야 한다.
   */
  extra: readonly string[] = [],
): SavePlan {
  const none: SavePlan = { lines: [], note: "" };
  /*
   * 다 저장하는 경우에 덧붙일 때는 `.save all` 로 시작한다. `.save @m1[gm]` 만 적으면 ngspice 는
   * **그것만** 저장한다 — .op 표의 전압이 사라지고, 잡음 해석은 스펙트럼을 잃고, .tf 는 아예 해석을
   * 건너뛴다 ('no data saved for transfer function analysis'). 재 봤다.
   */
  const noteFor = (n: number) => (n ? `Also saved ${n} value${n === 1 ? "" : "s"} the calculator reads.` : "");
  const extraNote = noteFor(extra.length);
  // all 은 노드 전압과 가지 전류를 이미 품는다. 따로 적을 것은 소자 값(@…)뿐이다 — 없으면 줄도 없다
  const special = extra.filter(e => e.startsWith("@"));
  const all = (): SavePlan => (special.length ? { lines: chunked(["all", ...special]), note: noteFor(special.length) } : none);
  let device = false, output = false, userSave = false;
  for (const b of blocks) {
    if (!b.active) continue;
    for (const raw of b.lines) {
      const t = raw.trim().toLowerCase();
      if (!t || t.startsWith("*")) continue;
      if (!t.startsWith(".")) device = true;                                   // 소자 줄
      else if (/^\.save\b/.test(t)) userSave = true;
      else if (/^\.(probe|print|plot|control|endc|four|meas|measure|options?)\b/.test(t)) output = true;
    }
  }
  // 사용자가 .save 를 적었으면 그 뜻대로 — 계산기 것만 보탠다 (all 을 붙이면 사용자의 거름을 덮는다)
  if (userSave) return extra.length ? { lines: chunked([...extra]), note: extraNote } : none;
  if (kind === "op" || kind === "noise" || kind === "tf") return all();
  if (device || output) return all();
  // .meas 가 읽는 벡터. v(a) · v(a,b) · vdb(a) 따위는 노드 전압, i(v1) · idb(…) 는 가지 전류다
  const want = new Set<string>();
  for (const m of meas) {
    if (/par\s*\(/i.test(m)) return all();
    for (const [, fn, inner] of m.matchAll(/\b([vi][a-z]*)\s*\(\s*([^()]*?)\s*\)/gi)) {
      const nodes = inner.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
      if (fn[0].toLowerCase() === "i") { if (nodes[0]) want.add(`i(${nodes[0]})`); }
      else for (const n of nodes) if (n !== "0") want.add(`v(${n})`);
    }
  }
  const nets = [...netNames].map(n => n.toLowerCase()).filter(n => n !== "0");
  let note = "";
  let keep: string[];
  if (nets.length >= MANY_NETS && probed.length) {
    keep = [...new Set(probed.map(n => n.toLowerCase()).filter(n => n !== "0"))].map(n => `v(${n})`);
    note = `Saved only the ${keep.length} probed net${keep.length === 1 ? "" : "s"} out of ${nets.length} ` +
      "— a large circuit. To see another net, probe it and run again.";
  } else {
    keep = nets.map(n => `v(${n})`);
  }
  for (const w of want) if (!keep.includes(w)) keep.push(w);
  for (const w of extra) if (!keep.includes(w)) keep.push(w);
  if (!keep.length) return none;
  return { lines: chunked(keep), note: [note, extraNote].filter(Boolean).join(" ") };
}

/** 한 줄이 끝없이 길어지지 않게 나눈다 (ngspice 는 .save 줄을 이어 붙여 받는다) */
export function chunked(keep: readonly string[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < keep.length; i += 24) lines.push(".save " + keep.slice(i, i + 24).join(" "));
  return lines;
}

/**
 * 해석 설정이 회로에 맞는가. DC 스윕 · 잡음 · 전달 함수는 회로의 **전원 이름**을 적는데, 없는 이름이면
 * ngspice 는 해석을 건너뛰고 엉뚱한 줄에서 오류를 낸다. 미리 잡는다. DC 스윕의 temp 는 온도다.
 */
export function checkAnalysis(sim: SimSettings, sheet: Sheet, library: Record<string, LibPart>): Issue[] {
  const name = sim.kind === "dc" ? sim.source : sim.kind === "noise" || sim.kind === "tf" ? sim.src : null;
  if (name === null) return [];
  const want = name.trim().toUpperCase();
  if (sim.kind === "dc" && want === "TEMP") return [];
  const sources: string[] = [];
  for (const p of sheet.parts) {
    const el = library[p.lib]?.spice?.element;
    if (el === "V" || el === "I") sources.push(spiceName(p.ref, el).toUpperCase());
  }
  // 지시문 블록의 V · I 줄도 전원이다 (외부 .sp 를 옮긴 회로)
  for (const b of sheet.spice ?? []) {
    if (!b.active) continue;
    for (const l of b.lines) {
      const h = l.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
      if (/^[VI]/.test(h)) sources.push(h);
    }
  }
  if (!want) return [{ level: "error", message: `The ${sim.kind === "dc" ? "DC sweep" : sim.kind === "noise" ? "noise analysis" : "transfer function"} needs a source name` }];
  if (sources.includes(want)) return [];
  const what = sim.kind === "dc" ? "sweeps" : "takes its input from";
  return [{
    level: "error",
    message: `The analysis ${what} ${name}, but there is no source by that name` +
      (sources.length ? ` — sources: ${sources.join(", ")}` : "") + (sim.kind === "dc" ? " (or temp for temperature)" : ""),
  }];
}

/** 넷리스트의 .end 바로 앞에 줄을 넣는다 */
export function beforeEnd(netlist: string, lines: readonly string[]): string {
  if (!lines.length) return netlist;
  const at = netlist.lastIndexOf("\n.end");
  return at < 0 ? netlist + "\n" + lines.join("\n") : netlist.slice(0, at) + "\n" + lines.join("\n") + netlist.slice(at);
}
