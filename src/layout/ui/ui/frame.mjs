/** 작업 공간 틀 — 위에 도구 줄, 가운데 캔버스, 양옆 패널, 아래 상태 막대. 세 작업 공간(회로·Placement·레이아웃)이 같이 쓴다.
 *
 *    const f = createFrame(root, { id: "layout", left: true, right: true })
 *    f.tools / f.left / f.right / f.status / f.canvas / f.stage   채울 자리
 *    f.section(side, key, title, { open })   접히는 패널 칸 하나 — 몸통 요소를 돌려준다 (펼침은 기억한다)
 *    f.togglePanel("left" | "right")          패널 숨기기·보이기 (좁은 화면에서는 캔버스 위에 뜬다)
 *
 *  좁으면(760 px 아래) 패널은 처음에 숨고, 도구 줄의 패널 단추로 캔버스 위에 띄운다.
 */
import { icon } from "../core/dom.mjs";

const KEY = "alg.panes";
const loadOpen = () => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } };
const saveOpen = (m) => { try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* 기억 못 해도 된다 */ } };

export function createFrame(root, { id, left = true, right = true, label = "" } = {}) {
  const doc = root.ownerDocument;
  root.innerHTML = `
    <div class="ws" data-ws="${id}" aria-label="${label}">
      <div class="ws-tools" role="toolbar"></div>
      <div class="ws-body">
        ${left ? '<aside class="ws-side ws-left"></aside>' : ""}
        <div class="ws-stage"><canvas class="ws-canvas" tabindex="0"></canvas><div class="ws-float"></div></div>
        ${right ? '<aside class="ws-side ws-right"></aside>' : ""}
      </div>
      <div class="ws-status"></div>
    </div>`;
  const ws = root.querySelector(".ws");
  const q = (s) => ws.querySelector(s);
  const open = loadOpen();
  const f = {
    root, ws, doc,
    tools: q(".ws-tools"), left: q(".ws-left"), right: q(".ws-right"), stage: q(".ws-stage"), canvas: q(".ws-canvas"),
    float: q(".ws-float"), status: q(".ws-status"),
    section(side, key, title, { open: dflt = true, actions = "" } = {}) {
      const host = side === "left" ? f.left : f.right;
      const sec = doc.createElement("section");
      sec.className = "pane";
      sec.dataset.key = key;
      const k = `${id}.${key}`;
      const isOpen = open[k] ?? dflt;
      sec.classList.toggle("shut", !isOpen);
      sec.innerHTML = `<h3 class="pane-h"><button type="button" class="pane-t" aria-expanded="${isOpen}"><span class="chev"></span>${title}</button><span class="pane-a">${actions}</span></h3><div class="pane-b"></div>`;
      sec.querySelector(".pane-t").addEventListener("click", () => {
        const now = sec.classList.toggle("shut");
        sec.querySelector(".pane-t").setAttribute("aria-expanded", String(!now));
        open[k] = !now; saveOpen(open);
      });
      host.append(sec);
      return sec.querySelector(".pane-b");
    },
    togglePanel(side) {
      const narrow = ws.classList.contains("narrow");
      const cls = narrow ? `show-${side}` : `no-${side}`;
      ws.classList.toggle(cls);
      if (narrow) ws.classList.remove(`show-${side === "left" ? "right" : "left"}`);
      f.onPanels?.();
    },
    panelShown(side) {
      return ws.classList.contains("narrow") ? ws.classList.contains(`show-${side}`) : !ws.classList.contains(`no-${side}`);
    },
    /** 도구 줄 오른쪽 끝의 패널 단추 둘 */
    panelButtons() {
      return (left ? `<button type="button" class="tb icon" data-panel="left" title="Left panel">${icon("pleft")}</button>` : "") +
             (right ? `<button type="button" class="tb icon" data-panel="right" title="Right panel">${icon("pright")}</button>` : "");
    },
    destroy() { ro?.disconnect(); },
  };
  f.tools.addEventListener("click", (e) => {
    const b = e.target.closest("[data-panel]");
    if (b) f.togglePanel(b.dataset.panel);
  });
  // 좁으면 패널이 캔버스 위에 뜬다 (처음엔 숨긴 채)
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
    const narrow = ws.clientWidth < 760;
    if (narrow !== ws.classList.contains("narrow")) { ws.classList.toggle("narrow", narrow); ws.classList.remove("show-left", "show-right"); f.onPanels?.(); }
  }) : null;
  ro?.observe(ws);
  return f;
}

/** 도구 줄 단추 하나 — 아이콘과 글자, 단축키 */
export function tb(act, label, { ic = null, key = null, title = "", pressed = null, disabled = false, cls = "", data = {}, id = null } = {}) {
  const attrs = Object.entries(data).map(([k, v]) => ` data-${k}="${v}"`).join("");
  return `<button type="button" class="tb ${cls}"${id ? ` id="${id}"` : ""} data-act="${act}"${attrs}${pressed == null ? "" : ` aria-pressed="${pressed}"`}${disabled ? " disabled" : ""} title="${title}${key ? ` (${key})` : ""}">` +
         `${ic ? icon(ic) : ""}<span class="tl">${label}</span>${key ? `<kbd>${key}</kbd>` : ""}</button>`;
}
export const sep = '<span class="tsep" aria-hidden="true"></span>';
