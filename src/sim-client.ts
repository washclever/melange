/**
 * 시뮬레이션 워커와 주고받기.
 *
 * 예전에는 워커의 답이 앱의 전역 변수를 곧바로 바꿨다. 실행 버튼 하나만 부르던 때는 그걸로 됐지만,
 * 이제 어시스턴트도 시뮬레이션을 돌리고 **그 결과를 기다려 읽는다** (src/ai/). 그래서 요청마다 번호를
 * 붙이고 답을 Promise 로 돌려준다. 실행 버튼과 어시스턴트가 같은 길을 쓴다 — 화면에 그려지는 결과와
 * 어시스턴트가 읽는 결과가 다를 수 없다.
 *
 * 실행은 한 번에 하나다 (엔진 인스턴스가 하나). 겹쳐 오면 앞의 것이 끝난 뒤에 돈다.
 *
 * 멈추기는 워커를 끝내는 것이다 — 도는 해석을 엔진 안에서 끊을 길이 없다. 다음 실행이 워커를 새로
 * 띄운다 (엔진 초기화 ~80 ms, SKY130 모델은 쓸 때 다시 올린다).
 */
import type { SimRequest, SimResponse } from "./sim.worker.ts";

/** 워커와 같은 모양의 것. 테스트는 가짜를 넣는다 */
export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<SimResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

interface Current {
  id: number;
  resolve: (r: SimResponse) => void;
  progress?: (text: string) => void;
}

export class SimClient {
  private worker: WorkerLike | null = null;
  private seq = 0;
  private current: Current | null = null;
  /** 기다리는 실행 수 (도는 것 포함) */
  private waiting = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly make: () => WorkerLike;

  constructor(make: () => WorkerLike) {
    this.make = make;
    // 워커는 처음부터 띄워 둔다. 예전과 같다 — 첫 실행 때 워커 스크립트를 받느라 늦지 않게
    this.ensure();
  }

  /** 돌거나 기다리는 실행이 있다 */
  get busy(): boolean { return this.waiting > 0; }

  /**
   * 넷리스트를 돌린다. 앞의 실행이 있으면 끝난 뒤에 돈다. 답은 늘 온다 — 실패도, 멈춤도
   * ok:false 의 답이다 (거부하지 않는다).
   */
  run(req: SimRequest, progress?: (text: string) => void): Promise<SimResponse> {
    this.waiting++;
    const job = this.queue.then(() => this.exec(req, progress));
    this.queue = job;
    return job.finally(() => { this.waiting--; });
  }

  /** 도는 실행을 멈춘다. 그 실행은 stopped 로 끝나고, 기다리던 것은 새 워커에서 돈다 */
  stop(): boolean {
    const c = this.current;
    if (!c) return false;
    this.drop();
    c.resolve({ ok: false, stopped: true, error: "The simulation was stopped." });
    return true;
  }

  private exec(req: SimRequest, progress?: (text: string) => void): Promise<SimResponse> {
    return new Promise<SimResponse>(resolve => {
      const id = ++this.seq;
      this.current = { id, resolve, progress };
      this.ensure().postMessage({ ...req, id } satisfies SimRequest);
    });
  }

  private ensure(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.make();
    w.onmessage = e => {
      const c = this.current;
      // 멈춘 요청의 늦은 답은 버린다 (번호가 다르다)
      if (!c || e.data.id !== c.id) return;
      if (e.data.progress) { c.progress?.(e.data.progress); return; }
      this.current = null;
      c.resolve(e.data);
    };
    w.onerror = e => {
      // 워커가 통째로 죽었다 (스크립트를 못 받았다 등). 다음 실행은 새로 띄운다
      const c = this.current;
      this.drop();
      c?.resolve({ ok: false, error: "The simulation worker failed: " + (e?.message || "unknown error") });
    };
    this.worker = w;
    return w;
  }

  private drop() {
    try { this.worker?.terminate(); } catch { /* 이미 끝났다 */ }
    this.worker = null;
    this.current = null;
  }
}
