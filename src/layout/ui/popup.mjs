/** 새 창 (layout.html?ws=placement|layout) — 연 창의 레이아웃 앱에 붙어 그 편집기 하나를 이 창에 그린다.
 *
 *  상태·워커·이력은 연 창에 있다 (window.opener.__melangeLayout). 이 창은 화면만 그린다 — 그래서 두 창이 같은 배치·배선을
 *  보고, 한쪽에서 고친 것이 다른 쪽에 바로 보인다. 연 창의 스타일(테마 변수)과 밝기를 그대로 옮겨 온다.
 */
import "./styles/layout.css";

const ws = new URLSearchParams(location.search).get("ws");
const opener = window.opener;
const api = (() => { try { return opener?.__melangeLayout ?? null; } catch { return null; } })();
const root = document.getElementById("lyt-popup-root");

if (!api || !["placement", "layout"].includes(ws)) {
  root.innerHTML = '<p class="loadfail">Open this window from Melange — the ▾ menu next to Placement or Layout, "Open in a new window".</p>';
} else {
  for (const n of opener.document.querySelectorAll('style, link[rel="stylesheet"]')) document.head.append(n.cloneNode(true));
  const sync = () => { document.documentElement.className = opener.document.documentElement.className; };
  sync();
  new opener.MutationObserver(sync).observe(opener.document.documentElement, { attributes: true, attributeFilter: ["class"] });
  document.title = `Melange — ${ws === "placement" ? "Placement" : "Layout"}`;
  api.mountPopup(ws, root, window).catch((e) => {
    root.innerHTML = `<p class="loadfail">The editor failed to load — ${String(e?.message ?? e)}</p>`;
  });
  opener.addEventListener("beforeunload", () => window.close());
}
