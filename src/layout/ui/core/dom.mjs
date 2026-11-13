/** 작은 도구들 — 글자 다듬기와 아이콘. 패널·도구 줄이 같이 쓴다. */

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** 소자 이름의 긴 해시를 줄인다 (SCM_NMOS_54009245_X1_Y1 -> SCM_NMOS_X1_Y1) */
export const short = (c) => String(c ?? "—").replace(/_(\d{6,})_/, "_");
export const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : "—");
/** 큰 정수를 세 자리씩 */
export const num = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "—");

/** 아이콘 — 선으로 그린 작은 SVG (currentColor). 그림 글자(이모지)는 쓰지 않는다. */
const P = {
  select: '<path d="M5 3l14 8-6 1.6L10 19z"/>',
  wire: '<path d="M4 18h6V6h10"/><circle cx="4" cy="18" r="1.6"/><circle cx="20" cy="6" r="1.6"/>',
  measure: '<path d="M3 15l12-12 6 6-12 12z"/><path d="M7 11l2 2M10 8l2 2M13 5l2 2"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  via: '<rect x="6" y="6" width="12" height="12"/><path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  flipx: '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7L4 12l5 5zM15 7l5 5-5 5z"/>',
  flipy: '<path d="M3 12h18" stroke-dasharray="2 2"/><path d="M7 9l5-5 5 5zM7 15l5 5 5-5z"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  swap: '<path d="M4 8h14l-3-3M20 16H6l3 3"/>',
  settle: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/><path d="M13 7h5v3M11 17H6v-3"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  zoomin: '<circle cx="10" cy="10" r="6"/><path d="M14.5 14.5L20 20M10 7v6M7 10h6"/>',
  zoomout: '<circle cx="10" cy="10" r="6"/><path d="M14.5 14.5L20 20M7 10h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/>',
  caret: '<path d="M7 10l5 5 5-5z" fill="currentColor" stroke="none"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  route: '<path d="M5 19V9h7V5h7"/><path d="M5 19h4"/><circle cx="19" cy="5" r="1.6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 015 0c0 2-2.5 2-2.5 4M12 17v.5"/>',
  popout: '<rect x="4" y="6" width="12" height="12" rx="1"/><path d="M12 3h9v9M21 3l-9 9"/>',
  cols: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M12 4v16"/>',
  rows: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 12h18"/>',
  single: '<rect x="3" y="4" width="18" height="16" rx="1.5"/>',
  merge: '<path d="M4 4h7v7H4zM13 13h7v7h-7z"/><path d="M15 4h5v5M9 20H4v-5"/>',
  eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
  eyeoff: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z" opacity=".35"/><path d="M4 20L20 4"/>',
  pleft: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M9 4v16"/>',
  pright: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M15 4v16"/>',
  link: '<path d="M10 14a4 4 0 005.6 0l3-3a4 4 0 00-5.6-5.6l-1 1"/><path d="M14 10a4 4 0 00-5.6 0l-3 3a4 4 0 005.6 5.6l1-1"/>',
  plug: '<path d="M7 7l10 10M5 12l7 7M12 5l7 7"/><path d="M3 21l3-3M18 6l3-3"/>',
  pin: '<path d="M12 21v-6M7 4h10l-2 6 3 3H6l3-3z"/>',
  freeze: '<path d="M12 2v20M4.9 6l14.2 12M19.1 6L4.9 18"/>',
  ratsnest: '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="8" r="2"/><circle cx="11" cy="19" r="2"/><path d="M7 6.4l10 1.3M6 8.1l4 8.9M17.6 9.6l-5.2 7.8" stroke-dasharray="2 2.2"/>',
  sync: '<path d="M20 11a8 8 0 00-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0014.3 4.9L20 16M20 20v-4h-4"/>',
  sweep: '<path d="M4 20l7-7M9 9l6 6M14 4l6 6-5 5-6-6z"/>',
};
export function icon(name, size = 16) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ""}</svg>`;
}

/** 화면 밖을 누르면 닫히는 띄움 메뉴 — 버튼 아래(또는 점 (x, y))에 붙인다. 닫는 함수를 돌려준다. */
export function popover(doc, html, { anchor = null, x = 0, y = 0, align = "left", className = "pop", onClick = null } = {}) {
  const el = doc.createElement("div");
  // 레이아웃 편집기의 색 토큰은 .lyt-pop 에 있다 (styles/layout.css)
  el.className = className.split(" ").map((c) => (c === "pop" ? "pop lyt-pop" : c)).join(" ");
  el.innerHTML = html;
  el.setAttribute("role", "menu");
  doc.body.append(el);
  const W = doc.documentElement.clientWidth, H = doc.documentElement.clientHeight;
  const r = anchor ? anchor.getBoundingClientRect() : { left: x, right: x, bottom: y, top: y };
  const b = el.getBoundingClientRect();
  let left = align === "right" ? r.right - b.width : r.left;
  let top = r.bottom + 4;
  if (left + b.width > W - 6) left = W - b.width - 6;
  if (top + b.height > H - 6) top = Math.max(6, (anchor ? r.top - 4 : y) - b.height);
  el.style.left = Math.max(6, left) + "px"; el.style.top = top + "px";
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    el.remove();
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("keydown", key, true);
  };
  const outside = (e) => { if (!el.contains(e.target) && !anchor?.contains(e.target)) close(); };
  const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  doc.addEventListener("pointerdown", outside, true);
  doc.addEventListener("keydown", key, true);
  if (onClick) el.addEventListener("click", (e) => onClick(e, close));
  return { el, close };
}
