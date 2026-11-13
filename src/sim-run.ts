/**
 * runSim 을 부르되, 엔진이 결과 없이 멈추면 기다리지 않는다.
 *
 * 이 엔진 빌드는 해석이 통째로 실패해서 쓸 벡터가 하나도 없으면 getError() 에
 *
 *     Error during 'write': no writable vector found.
 *
 * 를 남기고 **약속(Promise)을 영영 풀지 않는다.** 그러면 앱은 'Running…' 에서 멈춰 다시는 실행되지
 * 않는다. 아무것도 전압을 정하지 않는 넷이 그렇게 만든다 — 이은 것이 op-amp 입력뿐인 넷, 동작
 * 전원(B)의 식이 읽는 없는 넷 같은 것. 실행 전 검사가 흔한 경우를 먼저 막지만(src/net/netlist.ts),
 * 지시문 블록의 줄처럼 검사가 못 보는 곳에서도 생기므로 실행하는 쪽에서도 지킨다.
 *
 * 돌아가는 동안 메시지를 짧은 간격으로 들여다보다가 그 줄이 보이면 실패로 끝낸다. 멈춘 인스턴스는
 * 다시 쓸 수 없다 (같은 인스턴스로 다시 돌리면 그것도 멈춘다 — 재 봤다). 부르는 쪽이 새로 만든다.
 *
 * 같은 식으로 끝나지 않는 경우가 하나 더 있다. ngspice 가 스스로 끝내 버릴 때다:
 *
 *     strtod: Invalid argument
 *     ERROR: fatal error in ngspice, exit(1)
 *
 * 모델 카드의 계수 이름이 그 레벨에 없는 것일 때 이렇게 된다 (외부 .sp 에서 본다). 엔진은 exit 를
 * 부르고 약속은 그대로 남는다. 같은 자리에서 잡는다.
 */
export const STUCK = /no writable vector found|fatal error in ngspice/i;
const FATAL = /fatal error in ngspice/i;

/** 엔진이 결과 없이 멈췄다. lines 는 그때까지 쌓인 메시지다 */
export class EngineStuck extends Error {
  // 매개변수 속성(constructor(readonly lines …))은 쓰지 않는다 — 테스트를 돌리는 Node 의 타입 지우기가 못 읽는다
  readonly lines: string[];
  constructor(lines: string[]) {
    super("The simulation stopped without a result");
    this.name = "EngineStuck";
    this.lines = lines;
  }
}

export interface Runnable<T> { runSim(): Promise<T>; getError?(): string[] }

export async function runGuarded<T>(sim: Runnable<T>, pollMs = 150): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watch = new Promise<never>((_, reject) => {
    const tick = () => {
      const lines = (sim.getError?.() ?? []).map(String);
      if (lines.some(l => STUCK.test(l))) reject(new EngineStuck(lines));
      else timer = setTimeout(tick, pollMs);
    };
    timer = setTimeout(tick, pollMs);
  });
  try {
    return await Promise.race([sim.runSim(), watch]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 멈춘 실행을 사람 말로. ngspice 가 남긴 줄 가운데 원인을 가리키는 것(어느 노드가 특이한지)만 추린다 —
 * 'gmin stepping failed' 같은 과정 보고 스무 줄은 원인을 찾는 데 도움이 안 된다.
 */
export function stuckMessage(lines: readonly string[]): string {
  // ngspice 가 스스로 끝냈다. 떠 있는 넷 이야기는 여기 맞지 않는다 — 그 앞에 남긴 말을 그대로 보여 준다
  if (lines.some(l => FATAL.test(l))) {
    const said = lines.map(l => l.trim()).filter(l => l && !FATAL.test(l));
    return "ngspice gave up on this netlist" + (said.length ? ":\n" + said.join("\n") : ".") +
      "\n\nA device or model line has something it cannot read — often a model parameter that level does not have.";
  }
  const nodes = new Set<string>();
  for (const l of lines) {
    const m = /check node\s+(\S+)/i.exec(l);
    if (m) nodes.add(m[1]);
  }
  const where = nodes.size ? ` (ngspice points at: ${[...nodes].join(", ")})` : "";
  return "ngspice stopped without producing a result" + where + ".\n" +
    "Some net has nothing that sets its voltage — for example a net that only an op-amp, " +
    "controlled-source or comparator input reads. Connect it, or tie it to a source.";
}

/**
 * 멈춘 실행의 메시지에서 '그런 벡터는 없다' 고 한 이름들.
 *
 *     Warning from checkvalid: vector @m1[vth] is not available or has zero length.
 *
 * .save 에 엔진이 모르는 소자 파라미터를 하나라도 적으면 그 줄 다음에 'no writable vector found' 가
 * 오고 실행이 멈춘다. 계산기가 물은 것이면 그것만 빼고 다시 돌릴 수 있다 (src/sim.worker.ts).
 */
export function missingVectors(lines: readonly string[]): string[] {
  /*
   * 해석 자체가 실패했으면(떠 있는 노드 · 수렴 실패) 저장할 것이 **아무것도** 없어서, ngspice 는 저장 줄의
   * 첫 벡터를 '없다' 고 한다. 그 벡터 탓이 아니다 — 빼고 다시 돌려도 똑같이 멈춘다.
   */
  if (lines.some(l => /simulation\(s\) aborted/i.test(l))) return [];
  const out: string[] = [];
  for (const l of lines) {
    /*
     * 소자 파라미터(@소자[이름])만 본다. 같은 문장이 **떠 있는 노드**에도 나오기 때문이다 —
     * 'vector a is not available' 은 넷 a 를 아무것도 구동하지 않는다는 뜻이고, 저장 줄을 빼고 다시
     * 돌려도 똑같이 멈춘다. 그것까지 '계산기가 물은 것' 으로 읽으면 헛되이 한 번 더 돈다.
     */
    const m = /vector\s+(@\S+\[\w+\])\s+is not available/i.exec(l);
    if (m && !out.includes(m[1].toLowerCase())) out.push(m[1].toLowerCase());
  }
  return out;
}

/** 넷리스트를 받아 돌리는 엔진 */
export interface Engine<T> extends Runnable<T> { setNetList(netlist: string): void }

export interface FallbackRun<T, E> {
  result: T;
  /** 실제로 결과를 낸 넷리스트 (다시 돌렸으면 fallback) */
  netlist: string;
  /** 엔진에 없어서 빼고 다시 돌린 벡터. 비었으면 한 번에 됐다 */
  unavailable: string[];
  /** 결과를 낸 엔진 (다시 돌렸으면 새 엔진이다) */
  engine: E;
}

/** 저장 줄(.save)에서 그 벡터들만 뺀 넷리스트. 비게 된 줄은 줄째 뺀다 */
export function withoutSaves(netlist: string, names: readonly string[]): string {
  const drop = new Set(names.map(n => n.toLowerCase()));
  const out: string[] = [];
  for (const line of netlist.split("\n")) {
    if (!/^\s*\.save\b/i.test(line)) { out.push(line); continue; }
    const kept = line.trim().split(/\s+/).filter((t, i) => i === 0 || !drop.has(t.toLowerCase()));
    if (kept.length > 1) out.push(kept.join(" "));
  }
  return out.join("\n");
}

/** 없는 벡터를 하나씩 빼 가며 다시 돌리는 횟수. 넘으면 계산기 줄을 통째로 뺀 넷리스트로 간다 */
const MAX_RETRIES = 4;

/**
 * 돌리되, 저장해 달라고 한 벡터가 엔진에 없어서 멈췄으면 **그 벡터만 빼고** 다시 돌린다.
 *
 * 계산기는 모델마다 있는 이름만 묻지만(src/calc/devices.ts), 표가 모르는 모델이나 사용자가 직접 적은
 * @소자[이름] 은 걸러 낼 수 없다. 그 한 줄 때문에 파형까지 잃으면 안 된다 — 측정 하나의 실패가
 * 실행의 실패가 아닌 것과 같다 (src/sim-log.ts). 그리고 그 하나 때문에 **다른 소자 값까지** 잃어도
 * 안 된다: 계산기 줄을 통째로 빼면 gm(M1) 까지 "다시 실행하라" 가 되는데, 다시 실행해도 똑같다.
 *
 * ngspice 는 없는 벡터를 한 번에 하나씩만 알려 준다. 그래서 알려 준 것을 빼고 다시 돌리기를 몇 번
 * 되풀이한다. 그래도 안 되면 fallback(계산기 줄이 하나도 없는 넷리스트)으로 간다.
 *
 * 멈춘 엔진은 다시 쓸 수 없으므로 fresh 가 새 엔진을 띄워 준다. 다른 까닭으로 멈췄으면(떠 있는 노드)
 * EngineStuck 을 그대로 던진다 — 그때의 엔진도 버려야 한다.
 */
export async function runWithFallback<T, E extends Engine<T>>(
  engine: E, netlist: string, fallback: string | undefined,
  fresh: (unavailable: string[]) => Promise<E>,
): Promise<FallbackRun<T, E>> {
  const unavailable: string[] = [];
  for (let attempt = 0; ; attempt++) {
    engine.setNetList(netlist);
    try {
      return { result: await runGuarded(engine), netlist, unavailable, engine };
    } catch (err) {
      if (!(err instanceof EngineStuck)) throw err;
      const missing = missingVectors(err.lines).filter(m => !unavailable.includes(m));
      if (!missing.length) throw err;                       // 계산기 탓이 아니다
      unavailable.push(...missing);
      const trimmed = withoutSaves(netlist, missing);
      // 뺄 것이 저장 줄에 없었거나(사용자의 .control 같은 다른 길로 물었다) 너무 여러 번이면 통째로 뺀 것으로
      const next = trimmed !== netlist && attempt < MAX_RETRIES ? trimmed : fallback;
      if (!next || next === netlist) throw err;
      netlist = next;
      engine = await fresh(unavailable);
    }
  }
}
