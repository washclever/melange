/** 소식통 — 이름 붙은 소식을 듣고 낸다. 앱의 상태가 바뀌면 그것을 보이는 쪽(작업 공간·패널·캔버스)이 듣고 다시 그린다.
 *
 *  새 창으로 띄운 작업 공간도 원래 창의 앱을 듣는다 (같은 출처의 다른 창 함수). 그 창이 닫히면 듣는 쪽이 죽으므로,
 *  듣는 쪽은 자기 창(owner)을 같이 주고 — 닫힌 창의 것은 낼 때 조용히 뺀다.
 *
 *    const off = bus.on("placement", fn, window)    "*" 는 모든 소식
 *    bus.emit("placement", payload)
 */
export function createBus() {
  const subs = new Map();          // type -> Map(fn -> owner)
  const on = (type, fn, owner = null) => {
    if (!subs.has(type)) subs.set(type, new Map());
    subs.get(type).set(fn, owner);
    return () => subs.get(type)?.delete(fn);
  };
  const call = (set, payload, type) => {
    for (const [fn, owner] of [...set]) {
      let closed = false;
      try { closed = !!owner?.closed; } catch { closed = true; }
      if (closed) { set.delete(fn); continue; }
      try { fn(payload, type); }
      catch (e) { console.error(`[bus ${type}]`, e); }
    }
  };
  return {
    on,
    emit(type, payload) {
      const a = subs.get(type), b = subs.get("*");
      if (a) call(a, payload, type);
      if (b) call(b, payload, type);
    },
    /** 한 창이 등록한 것을 다 뺀다 (그 창이 내려갈 때) */
    dropOwner(owner) { for (const m of subs.values()) for (const [fn, o] of [...m]) if (o === owner) m.delete(fn); },
  };
}
