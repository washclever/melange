/** 배선 워커 — ALIGN 배선기(Rust 로 옮겨 wasm 으로 빌드한 것)로 배선하고 DRC/LVS 를 보고 GDS 를 쓴다.
 *
 *    postMessage({ design: {topology, primitives}, leaves, placement, frozen? })
 *      -> { type: "log", text } (모듈마다) ... { type: "route", ... gds (ArrayBuffer) ... } | { type: "error", msg }
 *    { kind: "recheck", edits }   편집기의 재검사 — 배선기 없이 검사·GDS (워커가 마지막 판의 세션을 쥔다)
 *    { kind: "reroute", frozen }  고정 넷은 그대로, 나머지 다시 배선
 */
import { loadAlignRouter } from "../route/alignroute.mjs";
import { routeSession, sessionOutput, recheck, routeMessage } from "../route/pipeline.mjs";
import wasmUrl from "../route/alignroute.wasm?url";

let routerP = null;
const getRouter = () => (routerP ??= (async () => {
  const r = await fetch(wasmUrl);
  if (!r.ok) throw new Error(`alignroute.wasm -> ${r.status}`);
  return loadAlignRouter(await r.arrayBuffer());
})().catch((err) => { routerP = null; throw err; }));

let session = null;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    const t0 = performance.now();
    const say = (text) => postMessage({ type: "log", text });
    let out;
    if (msg.kind === "recheck") {
      if (!session) throw new Error("No routing session — run Auto route first.");
      out = recheck(session, msg.edits ?? []);
    } else if (msg.kind === "reroute") {
      if (!session) throw new Error("No routing session — run Auto route first.");
      session = await routeSession({ design: session.design, leaves: session.lv, placement: session.placement,
                                     router: await getRouter(), say, frozen: msg.frozen ?? [] });
      out = sessionOutput(session);
    } else {
      session = await routeSession({ ...msg, router: await getRouter(), say });
      out = sessionOutput(session);
    }
    const m = routeMessage(out, (performance.now() - t0) / 1000);
    postMessage(m, [m.gds]);
  } catch (err) {
    postMessage({ type: "error", msg: `${err?.message ?? err}\n${err?.stack ?? ""}`.slice(0, 1500) });
  }
};
