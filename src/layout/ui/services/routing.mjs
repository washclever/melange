/** 배선 — 배선 워커(../../workers/layout-route.worker.mjs: 배선 파이프라인 + alignroute.wasm)에 보낸다.
 *
 *    send({ design, leaves, placement })     배선 한 판 — 워커가 이 판의 세션을 쥔다
 *    send({ kind: "recheck", edits })        편집기의 재검사 — 배선기 없이 다시 검사·GDS
 *    send({ kind: "reroute", frozen })       고정 넷은 그대로, 나머지 다시 배선
 *
 *  워커가 안 서는 브라우저에서는 같은 코드를 메인 스레드에서 돌린다 (그때도 마지막 판의 세션을 여기서 쥔다).
 */
import wasmUrl from "../../route/alignroute.wasm?url";

export function createRouting({ say = () => {} } = {}) {
  let worker = null, mainSession = null, mainRouter = null;

  async function onMain(msg) {
    const [{ routeSession, sessionOutput, recheck, routeMessage }, { loadAlignRouter }] = await Promise.all(
      [import("../../route/pipeline.mjs"), import("../../route/alignroute.mjs")]);
    const t0 = performance.now();
    let out;
    if (msg.kind === "recheck") {
      if (!mainSession) throw new Error("No routing session — run Auto route first.");
      out = recheck(mainSession, msg.edits ?? []);
    } else {
      if (!mainRouter) {
        const r = await fetch(wasmUrl);
        if (!r.ok) throw new Error(`alignroute.wasm -> ${r.status}`);
        mainRouter = await loadAlignRouter(await r.arrayBuffer());
      }
      if (msg.kind === "reroute") {
        if (!mainSession) throw new Error("No routing session — run Auto route first.");
        mainSession = await routeSession({ design: mainSession.design, leaves: mainSession.lv, placement: mainSession.placement,
                                           router: mainRouter, say, frozen: msg.frozen ?? [] });
      } else mainSession = await routeSession({ ...msg, router: mainRouter, say });
      out = sessionOutput(mainSession);
    }
    return routeMessage(out, (performance.now() - t0) / 1000);
  }

  function send(msg) {
    return new Promise((resolve, reject) => {
      const main = (why) => {
        console.warn("Routing worker unavailable — routing on the main thread:", why);
        worker = null;
        onMain(msg).then(resolve, reject);
      };
      try { worker ??= new Worker(new URL("../../workers/layout-route.worker.mjs", import.meta.url), { type: "module" }); }
      catch (err) { main(err.message); return; }
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "log") say(m.text);
        else if (m.type === "error") { console.error("[routing]\n" + m.msg); reject(new Error(m.msg.split("\n")[0])); }
        else resolve(m);
      };
      worker.onerror = (ev) => { ev.preventDefault?.(); main(ev.message || "worker error"); };
      worker.postMessage(msg);
    });
  }
  return { send };
}

/** 배선기에 넘길 배치 — 화면 배치(ours)에서. oX 는 변환의 원점이다: sX=+1 이면 x, sX=-1 이면 x + w (oY 도 같다) */
export function routePlacement(ours) {
  return {
    bbox: [0, 0, Math.round(ours.bbox[2] - ours.bbox[0]), Math.round(ours.bbox[3] - ours.bbox[1])],
    instances: ours.rects.map((r) => ({
      name: r.name, concrete: r.concrete,
      oX: Math.round(r.sx > 0 ? r.x : r.x + r.w),
      oY: Math.round(r.sy > 0 ? r.y : r.y + r.h),
      sX: r.sx > 0 ? 1 : -1, sY: r.sy > 0 ? 1 : -1,
    })),
    subModules: ours.subModules ?? [],
  };
}
