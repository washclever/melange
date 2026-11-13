/** 내려받기 메뉴 — 두 편집기 도구 줄의 "Download" 단추. 앱이 지금 가진 산출물(app.downloads(): 배치 JSON, 배선 뒤에는
 *  GDS·배선 기하·검사 보고)을 늘어놓고, 누르면 그 파일을 받는다. 새 창에서도 그 창의 문서에 붙는다.
 *
 *    downloadMenu(doc, app, anchor)
 */
import { esc, popover } from "../core/dom.mjs";

export function downloadMenu(doc, app, anchor) {
  const items = app.downloads();
  const html = `<div class="mh">Download</div>` + (items.length
    ? items.map((x, i) => `<button type="button" class="mi" data-i="${i}" title="${esc(x.file)}">${esc(x.label)}<small>${esc(x.file)}</small></button>`).join("")
    : `<p class="empty">Nothing yet — Auto place first. The GDS comes after Auto route.</p>`);
  popover(doc, html, {
    anchor, align: "right", className: "pop menu",
    onClick: (ev, close) => {
      const b = ev.target.closest("[data-i]");
      if (!b) return;
      close();
      save(doc, items[Number(b.dataset.i)]);
    },
  });
}

function save(doc, { file, blob }) {
  const U = (doc.defaultView ?? globalThis).URL;
  const url = U.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url; a.download = file; a.hidden = true;
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => U.revokeObjectURL(url), 2000);
}
