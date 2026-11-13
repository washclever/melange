/** 배치 — 배치기를 워커에서 돌린다 (../../workers/layout-place.worker.mjs -> ../../place/job.mjs).
 *
 *  회로 하나가 수 초 ~ 수십 초라 메인 스레드면 화면이 언다. 모듈 워커가 서지 않는 브라우저(구형 사파리 등)에서는
 *  워커가 조용히 죽을 수 있어, 워커가 안 뜨거나 첫 소식이 없으면 같은 코드를 메인 스레드에서 돌린다.
 *
 *    run(msg, handle)        배치 한 판. handle 이 {type: start|progress|frame|done|error} 를 받는다
 *    retry(msg, onProgress)  편집기의 위상 유지 variant 다시 고르기 (kind: "retry") — Promise
 */
const newWorker = () => new Worker(new URL("../../workers/layout-place.worker.mjs", import.meta.url), { type: "module" });

export function createPlacement({ say = () => {} } = {}) {
  let worker = null;

  function run(msg, handle) {
    let spoke = false, fell = false;
    const fallback = async (why) => {
      if (spoke || fell) return;
      fell = true;
      worker?.terminate(); worker = null;
      console.warn("Module workers are unavailable — placing on the main thread:", why);
      say("This browser cannot run module workers — placing on the main thread (the page pauses until it ends).", true);
      try {
        const { runJob } = await import("../../place/job.mjs");
        await new Promise((r) => setTimeout(r, 60));
        await runJob(msg, handle);
      } catch (err) { handle({ type: "error", msg: err.message }); }
    };
    try {
      worker?.terminate();
      worker = newWorker();
    } catch (err) { fallback(err.message); return; }
    worker.onmessage = (e) => { spoke = true; handle(e.data); };
    worker.onerror = (e) => { e.preventDefault?.(); fallback(e.message || "worker error"); };
    worker.postMessage(msg);
    setTimeout(() => fallback("no first message"), 6000);
  }

  function stop() { worker?.terminate(); worker = null; }

  let editWorker = null;
  function retry(msg, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const take = (m) => {
        if (m.type === "progress") onProgress(m);
        else if (m.type === "error") reject(new Error(m.msg.split("\n")[0]));
        else if (m.type === "retry") resolve(m);
      };
      const main = async (why) => {
        console.warn("Edit worker unavailable — running on the main thread:", why);
        editWorker = null;
        try { const { runEdit } = await import("../../place/job.mjs"); runEdit(msg, take); } catch (e) { reject(e); }
      };
      try { editWorker ??= newWorker(); }
      catch (err) { main(err.message); return; }
      editWorker.onmessage = (ev) => take(ev.data);
      editWorker.onerror = (ev) => { ev.preventDefault?.(); main(ev.message || "worker error"); };
      editWorker.postMessage(msg);
    });
  }

  return { run, retry, stop };
}
