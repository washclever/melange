/**
 * 편집기 전환 — 메뉴 막대 오른쪽, 테마 버튼 왼쪽의 [Circuit ▾ Placement ▾ Layout].
 *
 * 이것만 첫 화면에 실린다. 이름이나 삼각형을 처음 누를 때 레이아웃 덩어리(shell.mjs — 앞단·배치기·배선기·편집기)를
 * 받는다 — 회로도만 그리는 사람은 받지 않는다.
 *
 *   이름        그 편집기 하나만 보인다 (새 창에 있으면 그 창으로)
 *   ▾ (사이)    양옆 둘을 좌우로 · 위아래로 · 셋 다 · 새 창으로 · 새 창 합치기 · 선택 연동
 */
import type { LayoutShell, LayoutHostBase } from "./shell.mjs";
import type { LayoutControl } from "../../ai/host.ts";

const NAMES = [["circuit", "Circuit"], ["placement", "Placement"], ["layout", "Layout"]] as const;
const CARET = '<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 7 6-7z" fill="currentColor"/></svg>';

export interface LayoutSwitch {
  /** 레이아웃 편집기가 지금 단축키를 받는가 (회로도의 키 처리는 비켜 준다) */
  ownsKeys(): boolean;
  /** 회로도에서 고른 부품이 바뀌었다 */
  circuitSelection(refs: string[]): void;
  /** 회로가 눌렸다 (단축키를 회로도로) */
  circuitActive(): void;
  /** 어시스턴트가 레이아웃을 다루는 손잡이 — 처음이면 레이아웃 덩어리를 받는다 */
  control(): Promise<LayoutControl>;
  /** 레이아웃을 받았으면 그 한 줄 요약 (어시스턴트의 상황 설명), 아니면 null */
  brief(): string | null;
}

export function createLayoutSwitch(bar: HTMLElement, before: HTMLElement, host: LayoutHostBase): LayoutSwitch {
  const el = document.createElement("div");
  el.id = "ws-switch";
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", "Editors");
  el.innerHTML = NAMES.map(([id, label], i) =>
    `<button type="button" class="ws-name" data-ws="${id}" title="${label} editor">${label}</button>` +
    (i < NAMES.length - 1 ? `<button type="button" class="ws-caret" data-pair="${i}" title="Show ${label} and ${NAMES[i + 1][1]} together, or in a new window" aria-label="View options">${CARET}</button>` : "")).join("");
  bar.insertBefore(el, before);

  let shell: LayoutShell | null = null;
  let loading: Promise<LayoutShell> | null = null;
  const selWatchers: Array<(refs: string[]) => void> = [];
  let lastSel = "";

  function paint() {
    const v = shell?.view();
    for (const b of el.querySelectorAll<HTMLButtonElement>(".ws-name")) {
      const id = b.dataset.ws!;
      const s = v?.[id] ?? { shown: id === "circuit", active: id === "circuit", popped: false };
      b.classList.toggle("on", s.shown);
      b.classList.toggle("active", s.shown && s.active && Object.values(v ?? {}).filter((x) => x.shown).length > 1);
      b.classList.toggle("out", s.popped);
      b.setAttribute("aria-pressed", String(s.shown));
    }
  }

  const load = () => (loading ??= import("./shell.mjs").then((M) => {
    shell = M.createShell(document, {
      ...host,
      onSelection: (cb) => { selWatchers.push(cb); },
      refreshSwitch: paint,
    });
    paint();
    return shell;
  }).catch((e) => {
    loading = null;
    console.error("[layout editors failed to load]", e);
    const st = document.getElementById("status");
    if (st) st.textContent = "Layout editors failed to load — " + (e as Error).message;
    throw e;
  }));

  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const name = t.closest<HTMLButtonElement>(".ws-name");
    const caret = t.closest<HTMLButtonElement>(".ws-caret");
    if (name) {
      const id = name.dataset.ws!;
      if (id === "circuit" && !shell) return;
      load().then((s) => s.show(id), () => {});
    } else if (caret) {
      load().then((s) => s.pairMenu(Number(caret.dataset.pair), caret), () => {});
    }
  });
  paint();

  return {
    ownsKeys: () => shell?.ownsKeys() ?? false,
    circuitSelection(refs) {
      if (!shell) return;
      const k = refs.join("\u0000");
      if (k === lastSel) return;
      lastSel = k;
      for (const f of selWatchers) f(refs);
    },
    circuitActive: () => shell?.activate("circuit"),
    control: () => load().then((s) => s.control),
    brief: () => shell?.control.brief() ?? null,
  };
}
