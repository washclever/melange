/**
 * ngspice 가 뱉은 메시지를 '진짜 실패' 와 '그냥 알림' 으로 가른다.
 *
 * `getError()` 라는 이름과 달리, ngspice 는 거기에 치명적이지 않은 안내도 섞어 넣는다.
 * 예를 들어 AC 해석을 돌리면 결과 101점이 멀쩡히 나오는데도 이런 줄이 같이 온다:
 *
 *     Note: v1: has no value, DC 0 assumed
 *
 * 이걸 그대로 실패로 처리하면 **잘 돈 시뮬레이션이 실패로 뜬다.** transient 에서도
 * 전압원에 DC 값을 안 적었거나 하면 같은 일이 난다 — 데모 회로가 그런 줄을 안 낼 뿐이다.
 *
 * 그래서 두 가지를 같이 본다:
 *   - 메시지의 종류 (Note/Warning 은 알림, 그 밖은 실패)
 *   - 결과 벡터가 실제로 나왔는가
 *
 * 둘을 같이 봐야 "경고만 나왔는데 결과도 비었다" 는 경우(떠 있는 노드 → singular matrix)를
 * 놓치지 않는다. ngspice 는 그 상황을 Warning 으로만 알리고 조용히 빈 결과를 준다.
 */

/** 치명적이지 않은 안내로 취급할 머리말 */
const INFO = /^\s*(note|warning|info)\s*:/i;

/*
 * 측정 하나가 실패한 것은 **시뮬레이션의 실패가 아니다.**
 *
 * `.meas` 가 조건에 걸리는 지점을 못 찾으면 ngspice 는 getError() 에 이렇게 적는다:
 *
 *     Error: measure  nope  find(AT) : out of interval
 *      .meas tran nope find v(out) at=9 failed!
 *
 * 머리말이 Error: 라 그냥 두면 512점이 멀쩡히 나온 실행을 통째로 버린다 —
 * 측정 식을 한 글자 잘못 적었을 때 파형까지 같이 사라진다는 뜻이다.
 * 그래서 이 두 모양만 알림으로 돌린다. 실패한 측정은 Measure 탭에 'failed' 로 남고
 * 이유도 거기 붙는다 (src/sim-measure.ts). 결과가 비었으면 아래 !hasData 가 잡는다.
 */
const MEASURE_FAIL = [
  /^\s*error\s*:\s*measure\b/i,
  /^\s*\.meas(ure)?\b.*failed!?\s*$/i,
];
const soft = (line: string) => INFO.test(line) || MEASURE_FAIL.some(re => re.test(line));

export interface SimDiagnosis {
  /** 실패로 볼 것인가 */
  fatal: boolean;
  /** 사용자에게 보일 메시지 (실패일 때) */
  message: string;
  /** 로그 탭에 남길 안내 줄들 */
  notes: string[];
}

export function diagnose(lines: readonly string[], hasData: boolean): SimDiagnosis {
  const notes: string[] = [];
  const hard: string[] = [];
  for (const raw of lines) {
    for (const line of String(raw).split("\n")) {
      if (!line.trim()) continue;
      (soft(line) ? notes : hard).push(line);
    }
  }

  // 치명적인 줄이 하나라도 있으면 실패
  if (hard.length) return { fatal: true, message: hard.join("\n"), notes };

  // 안내뿐이어도 결과가 비었으면 실패다 (떠 있는 노드가 이렇게 온다)
  if (!hasData) {
    return {
      fatal: true,
      message: notes.length
        ? notes.join("\n")
        : "The simulation produced no result",
      notes,
    };
  }

  return { fatal: false, message: "", notes };
}
