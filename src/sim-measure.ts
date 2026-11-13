/**
 * `.meas` 결과 읽기.
 *
 * ngspice 는 측정값을 결과 벡터가 아니라 **글자로** 뱉는다 (`getInfo()`).
 * 벡터가 아니라서 파형에 그릴 수는 없고, 대신 이름 붙은 수치로 표에 적는다 —
 * "상승시간이 몇이야" 같은 질문의 답은 곡선이 아니라 숫자다.
 *
 * 글자를 파싱해 쓰는 것이라 **엔진 판이 올라가며 모양이 바뀌면 조용히 깨진다.**
 * 그래서 우리가 물어본 이름만 찾고, 못 찾으면 '실패' 로 남긴다 —
 * 엉뚱한 줄을 측정값으로 읽어 숫자를 지어내는 것보다 비어 있는 쪽이 낫다.
 */

export interface Measurement {
  name: string;
  /** 못 읽었으면 null. 측정 자체가 실패한 경우도 포함한다 */
  value: number | null;
  /** targ=… trig=… at=… 처럼 뒤에 붙는 설명. 없으면 빈 글자 */
  detail: string;
}

/**
 * 넷리스트의 `.meas` 줄에서 결과 이름을 뽑는다.
 *
 *   .meas tran trise TRIG v(out) VAL=0.1 ...   ->  trise
 *
 * 세 번째 낱말이 이름이다 (`.meas` · 해석 종류 · 이름). ngspice 는 이름을 소문자로
 * 돌려주므로 비교도 소문자로 한다.
 */
export function measureNames(netlist: string): string[] {
  const out: string[] = [];
  for (const raw of netlist.split(/\r?\n/)) {
    const t = raw.trim();
    if (!/^\.meas(ure)?\b/i.test(t)) continue;
    const w = t.split(/\s+/);
    const name = w[2]?.toLowerCase();
    if (name && /^[a-z_]\w*$/.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 측정이 실패한 이유. 이름 -> 이유.
 *
 *     Error: measure  nope  find(AT) : out of interval
 *       -> nope : "find(AT) : out of interval"
 *
 * 'failed' 라고만 적어 두면 식을 어디서 고쳐야 할지 알 수 없다. 이유까지 같이 보여 준다.
 * (이 줄이 실행 전체를 실패로 만들지 않도록 거르는 일은 src/sim-log.ts 에서 한다)
 */
function failReasons(lines: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of lines) {
    const m = /^\s*error\s*:\s*measure\s+(\S+)\s+(.+)$/i.exec(raw);
    if (m) out.set(m[1].toLowerCase(), m[2].trim());
  }
  return out;
}

/**
 * getInfo() 가 뱉은 글자에서 그 이름들의 값을 찾는다.
 *
 * 같은 이름이 여러 번 보이면 **마지막 것**을 쓴다. 엔진이 회차마다 글을 쌓아 두면
 * 앞쪽은 지난 실행의 값이기 때문이다.
 */
export function parseMeasures(info: string, names: string[]): Measurement[] {
  const lines = info.split(/\r?\n/);
  const reasons = failReasons(lines);
  return names.map(name => {
    let value: number | null = null;
    let detail = "";
    for (const raw of lines) {
      const t = raw.trim();
      if (!t.toLowerCase().startsWith(name)) continue;
      // 이름 바로 뒤가 '=' 여야 한다. vfinal 과 vfinal2 를 가르는 자리다
      const rest = t.slice(name.length).trimStart();
      if (!rest.startsWith("=")) continue;
      const after = rest.slice(1).trim();
      const first = after.split(/\s+/)[0] ?? "";
      const n = Number(first);
      value = Number.isFinite(n) ? n : null;
      detail = after.slice(first.length).trim();
      // 계속 돌아 마지막 것으로 덮는다
    }
    if (value === null) detail = reasons.get(name) ?? detail;
    return { name, value, detail };
  });
}

/** 표에 적을 글자. 단위는 측정마다 달라서 공학 표기로만 다듬는다 */
export function formatMeasure(m: Measurement): string {
  if (m.value === null) return "failed";
  const a = Math.abs(m.value);
  if (a === 0) return "0";
  if (a >= 1e-3 && a < 1e6) return Number(m.value.toPrecision(6)).toString();
  return m.value.toExponential(4);
}
