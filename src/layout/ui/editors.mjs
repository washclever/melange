/** 편집기 묶음 — Placement 편집기(placement/edit.mjs)와 레이아웃 편집기(layout/track.mjs)를 앱에 붙인다.
 *
 *  main.mjs 가 **따로, 필요할 때** 받는다 — 못 받아도 예제 목록과 보기는 그대로 돈다 (옛 판이 캐시에 남은 경우 등).
 *  편집기는 화면을 모른다. 작업 공간이 자기 화면 변환을 알려 주고(setMap), 편집기가 바꾼 것을 소식으로 듣는다:
 *    edit   (작업 공간 이름)   상태가 바뀌었다 — 패널과 캔버스를 다시
 *    redraw (작업 공간 이름)   캔버스만 다시
 *    hint   (작업 공간 이름)   커서 아래 / 하는 일 한 줄 (상태 막대)
 *
 *  선택 연동: 한 편집기에서 고른 블록 · 넷을 앱의 selection 으로 알리고, 다른 작업 공간(회로 포함)에서 고른 것을 받아 온다.
 */
import { createPlacementEditor } from "./placement/edit.mjs";
import { createTrackEditor } from "./layout/track.mjs";

export function createEditors(app) {
  const hints = { placement: "", layout: "" };
  const maps = { placement: null, layout: null };            // 작업 공간 -> () => {m} (지금 화면 변환)
  let echo = false;                                           // 받아 온 선택을 다시 내보내지 않게
  const mk = (which) => ({
    app,
    design: () => app.design(),
    map: () => { try { return maps[which]?.() ?? null; } catch { return null; } },
    changed: () => app.emit("edit", which),
    redraw: () => app.emit("redraw", which),
    hint: (t) => { if (hints[which] === t) return; hints[which] = t; app.emit("hint", which); },
    status: (html) => app.setStatus(html),
    pushed: () => {},
    selected: (kind, v) => {
      if (echo) return;
      if (kind === "block") app.select(v?.length ? { kind: "block", names: v } : null, which);
      else app.select(v ? { kind: "net", name: v } : null, which);
    },
  });
  const placement = createPlacementEditor(mk("placement"));
  const track = createTrackEditor(mk("layout"));

  // 다른 작업 공간에서 고른 것 — 연동이 켜져 있으면 따라 고른다
  app.bus.on("selection", (sel) => {
    if (!app.state.link || !sel) return;
    echo = true;
    try {
      if (sel.from !== "placement" && sel.kind === "block" && placement.pl.model) placement.selectNames(sel.names);
      if (sel.from !== "placement" && sel.kind === "net" && placement.pl.sel.size) placement.clearSelection();
      if (sel.from !== "layout" && sel.kind === "net") track.selectNet(sel.name);
    } finally { echo = false; }
  });
  // 배치가 바뀌면 그린 것의 연결 · 검사를 다시 센다 (그린 것은 그대로 둔다 — PCB 에서 부품을 옮겨도 트랙이 남듯)
  app.bus.on("placement", () => { if (app.state.ours) track.checkSoon(400); });

  return {
    placement, track,
    hint: (which) => hints[which] ?? "",
    setMap: (which, fn) => { maps[which] = fn; },
    // 앱이 부르는 것
    placed: (d) => { placement.pl.orig = d; placement.placed(d); },
    /** 자동 배선이 끝났다 — 그 결과를 그린 것으로 (keep: 그대로 둘 넷) */
    routed: (m, opts = {}) => { if (m?.drawn) track.importRouted(m.drawn, opts.keep ?? new Set()); },
    fixedVariants: () => placement.fixedVariants(),
    wiresEdited: () => track.art().hist.length > 0,
  };
}
