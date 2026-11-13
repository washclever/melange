// ngspice WASM 을 별도 스레드에서 돌린다.
// 이 엔진 빌드는 단일 스레드라 SharedArrayBuffer 를 쓰지 않는다
// => COOP/COEP 헤더가 필요 없고 GitHub Pages 같은 정적 호스팅에 그대로 올라간다.
// spice.wasm 은 postinstall 에서 엔진 번들의 base64 를 꺼내 만든 파일이다 (tools/extract-wasm.mjs).
// Vite 가 에셋으로 내보내고 base 에 맞는 URL 을 준다. vite.config.ts 의 strip-inline-wasm 이
// 엔진 쪽 로더를 이 전역을 읽도록 바꿔 둔다 — 그래서 20 MB 짜리 base64 가 번들에서 빠진다.
import spiceWasmUrl from "./vendor/spice.wasm?url";
(globalThis as Record<string, unknown>).__SPICE_WASM_URL__ = new URL(spiceWasmUrl, self.location.href).href;

import { Simulation } from "eecircuit-engine";
import { diagnose } from "./sim-log.ts";
import { toTraces, type Trace } from "./sim-values.ts";
import { measureNames, parseMeasures, type Measurement } from "./sim-measure.ts";
import { EngineStuck, runWithFallback, stuckMessage } from "./sim-run.ts";

export interface SimRequest {
  /**
   * 요청 번호. 답(진행 알림 포함)에 그대로 붙여 돌려준다 — 앱은 멈춘 요청의 늦은 답을 이것으로
   * 걸러 낸다 (src/sim-client.ts).
   */
  id?: number;
  netlist: string;
  /**
   * 계산기가 물은 .save 줄을 뺀 같은 넷리스트. 엔진이 모르는 벡터(없는 소자 파라미터)를 하나라도
   * 물으면 실행 전체가 결과 없이 멈추는데, 그때 이것으로 한 번 더 돌린다 — 계산기 식 하나 때문에
   * 파형까지 잃지 않게 (src/calc/devices.ts).
   */
  fallback?: string;
}
export type { Trace } from "./sim-values.ts";

export interface SimResponse {
  /** 받은 요청의 번호 */
  id?: number;
  ok: boolean;
  /** 앱이 멈췄다 (워커를 끝냈다). 워커는 이것을 보내지 않는다 — 앱이 스스로 만든다 */
  stopped?: boolean;
  /** 아직 결과가 아니라 "뭘 하고 있는지" 를 알리는 말. 받는 쪽은 상태만 바꾼다 */
  progress?: string;
  traces?: Trace[];
  initMs?: number;
  runMs?: number;
  log?: string;
  /** .meas 로 잰 값들. 없으면 빈 배열 */
  measures?: Measurement[];
  /** 엔진에 없어서 빼고 다시 돌린 벡터 (계산기가 그 이유를 보여 준다) */
  unavailable?: string[];
  error?: string;
}

let sim: Simulation | null = null;
let initMs = 0;

/*
 * SKY130 모델 카드.
 *
 * 빌드가 엔진 번들에서 이 본문을 걷어내므로(2.18 MB), 엔진이 올리는 파일은 빈 껍데기다.
 * 같은 본문을 별도 에셋으로 두고 **PDK 소자를 처음 만났을 때만** 받아서 가상 파일
 * 시스템에 덮어 쓴다. R·C 만 돌리는 사람은 끝까지 안 받는다.
 *
 * 엔진이 Module 을 내주는 통로가 __getSpiceModuleForTests 하나뿐이라 그걸 쓴다.
 * 이름이 'ForTests' 지만 d.ts 에 공개돼 있고, 이게 FS 에 닿는 유일한 길이다.
 */
/** 엔진 FS 의 자리 -> 그 내용을 담은 에셋. 소자별로 쪼개 두었다 */
const SKY130_ASSETS: Record<string, () => Promise<{ default: string }>> = {
  "/sky130-common.spice": () => import("./vendor/sky130-common.spice?url"),
  "/sky130-nfet.spice": () => import("./vendor/sky130-nfet.spice?url"),
  "/sky130-pfet.spice": () => import("./vendor/sky130-pfet.spice?url"),
  "/sky130-pfet-hvt.spice": () => import("./vendor/sky130-pfet-hvt.spice?url"),
};
const loaded = new Set<string>();

/** 넷리스트가 부르는 모델 파일들. 우리가 넣은 .include 줄만 본다 */
function neededModels(netlist: string): string[] {
  const out: string[] = [];
  for (const line of netlist.split("\n")) {
    const t = line.trim();
    if (!t.toLowerCase().startsWith(".include ")) continue;
    const p = t.slice(".include ".length).trim();
    if (SKY130_ASSETS[p] && !out.includes(p)) out.push(p);
  }
  return out;
}

async function ensureSky130(s: Simulation, paths: string[]) {
  const todo = paths.filter(p => !loaded.has(p));
  if (!todo.length) return;
  const mod = (s as unknown as { __getSpiceModuleForTests(): { FS?: { writeFile(p: string, d: string): void } } | null })
    .__getSpiceModuleForTests();
  const FS = mod?.FS;
  if (!FS?.writeFile) throw new Error("The engine did not expose its file system, so the SKY130 models cannot be loaded");
  for (const path of todo) {
    const url = new URL((await SKY130_ASSETS[path]()).default, self.location.href).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not fetch ${path} (${res.status})`);
    const text = await res.text();
    if (!text.trim()) throw new Error(`${path} came back empty`);
    FS.writeFile(path, text);
    loaded.add(path);
  }
}

self.onmessage = async (e: MessageEvent<SimRequest>) => {
  const id = e.data.id;
  try {
    if (!sim) {
      const t0 = performance.now();
      sim = new Simulation();
      await sim.start();
      initMs = performance.now() - t0;
    }
    /*
     * 넷리스트가 모델 파일을 부르면 그때 받아서 올린다.
     *
     * 처음 한 번은 **몇 초** 걸린다 — 2.2 MB 를 받는 건 금방이지만 ngspice 가 그걸
     * 읽는 데 시간이 든다. 아무 말도 없으면 멈춘 것처럼 보이므로 먼저 알린다.
     */
    const models = neededModels(e.data.netlist);
    const fresh = models.filter(p => !loaded.has(p));
    if (fresh.length) {
      self.postMessage({ id, ok: true, progress: "Loading the SKY130 process models — first run only" });
    }
    if (models.length) await ensureSky130(sim, models);

    /*
     * 측정값은 결과 벡터가 아니라 getInfo() 의 글자로 온다. 엔진이 회차마다 글을
     * 쌓아 두는지 확실치 않아, **실행 전후를 비교해 이번에 늘어난 부분만** 읽는다.
     * 쌓지 않고 매번 새로 쓰는 엔진이면 앞부분이 안 맞으므로 전체를 쓴다.
     */
    const t1 = performance.now();
    let infoBefore = sim.getInfo?.() ?? "";
    let res: any, netlist: string, unavailable: string[];
    try {
      /*
       * 계산기가 물은 벡터 중에 엔진에 없는 것이 있으면 그 줄을 뺀 넷리스트로 한 번 더 돌린다
       * (src/sim-run.ts). 새 엔진이라 처음 띄우는 값(~80 ms)과 SKY130 모델 다시 올리기가 든다 —
       * 실패한 경우에만 낸다.
       */
      const out = await runWithFallback<any, Simulation>(sim, e.data.netlist, e.data.fallback, async missing => {
        self.postMessage({ id, ok: true, progress: "Running again without " + missing.join(", ") });
        loaded.clear();
        const next = new Simulation();
        await next.start();
        sim = next;
        if (models.length) await ensureSky130(next, models);
        infoBefore = next.getInfo?.() ?? "";
        return next;
      });
      ({ result: res, netlist, unavailable } = out);
    } catch (err) {
      if (!(err instanceof EngineStuck)) throw err;
      // 멈춘 인스턴스는 다시 못 쓴다. 다음 실행이 새로 띄우고, 모델 파일도 새 파일 시스템에 다시 올린다
      sim = null;
      loaded.clear();
      throw new Error(stuckMessage(err.lines));
    }
    const runMs = performance.now() - t1;

    // ngspice 는 치명적이지 않은 안내도 getError() 에 섞어 넣는다.
    // 메시지 종류와 '결과가 나왔는가' 를 같이 봐야 한다 (src/sim-log.ts)
    const hasData = Array.isArray(res?.data) && res.data.length > 0
      && res.data.some((d: any) => d?.values?.length > 0);
    const d = diagnose(sim.getError?.() ?? [], hasData);
    if (d.fatal) throw new Error(d.message);

    // 평평한 Float64Array 로 만들어 transferable 로 넘긴다.
    // 구조화 복제로 넘기면 결과가 클 때 복사 비용을 그대로 낸다.
    // AC 해석의 복소수 처리는 src/sim-values.ts 에 있다
    const traces: Trace[] = toTraces(res.data);

    const infoAfter = sim.getInfo?.() ?? "";
    const infoNew = infoAfter.startsWith(infoBefore) ? infoAfter.slice(infoBefore.length) : infoAfter;
    const measures = parseMeasures(infoNew || infoAfter, measureNames(netlist));

    const retried = unavailable.length
      ? [`ngspice has no ${unavailable.join(", ")} — the run was repeated without the calculator's request for ${unavailable.length === 1 ? "it" : "them"}.`]
      : [];
    const log = [...retried, infoAfter, ...d.notes].filter(Boolean).join("\n");
    const resp: SimResponse = { id, ok: true, traces, initMs, runMs, log, measures, unavailable };
    const buffers = traces.flatMap(t => t.phaseDeg ? [t.values.buffer, t.phaseDeg.buffer] : [t.values.buffer]);
    (self as any).postMessage(resp, buffers);
  } catch (err: any) {
    (self as any).postMessage({ id, ok: false, error: String(err?.message ?? err) } as SimResponse);
  }
};
