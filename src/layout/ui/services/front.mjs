/** 앞단 — 레이아웃 넷리스트를 원시 소자와 셀 도형으로 (워커에서, ../../front 를 ALIGN 을 JS 로 옮긴 것).
 *
 *    run({ text, top, userConstraints }) -> Promise<{ blob, groups, ms }>
 *
 *  보통 회로는 수십 ~ 수백 ms 다. 워커가 서지 않으면 메인 스레드에서 같은 함수를 부른다.
 */
export function createFront() {
  let worker = null;

  async function onMain(msg) {
    const { runFrontEnd } = await import("../../front/index.mjs");
    const t0 = performance.now();
    const { blob, groups } = runFrontEnd(msg.text, msg.top, { userConstraints: msg.userConstraints });
    return { blob, groups, ms: performance.now() - t0 };
  }

  function run(msg) {
    return new Promise((resolve, reject) => {
      const main = (why) => {
        console.warn("Front-end worker unavailable — running on the main thread:", why);
        worker = null;
        onMain(msg).then(resolve, reject);
      };
      try { worker ??= new Worker(new URL("../../workers/layout-front.worker.mjs", import.meta.url), { type: "module" }); }
      catch (err) { main(err.message); return; }
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "error") reject(new Error(m.msg.split("\n")[0]));
        else resolve(m);
      };
      worker.onerror = (ev) => { ev.preventDefault?.(); main(ev.message || "worker error"); };
      worker.postMessage(msg);
    });
  }
  return { run };
}

/** 설계 요약 — 블록·모듈 수 (도구 막대와 상태 줄) */
export function summarize(blob, name = null) {
  const mods = blob?.topology?.modules ?? [];
  const top = mods.find((m) => m.name === name) ?? mods.at(-1);
  return { modules: mods.length, blocks: top?.instances?.length ?? 0, top: top?.name ?? "", variants: Object.keys(blob?.primitives ?? {}).length };
}
