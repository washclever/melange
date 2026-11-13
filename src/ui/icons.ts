/**
 * 툴바 아이콘.
 *
 * 직접 그린 16×16 선 아이콘이다. 다른 EDA 의 아이콘을 쓰지 않는 것이 이 프로젝트의
 * 전제라(README 라이선스 절), 외부 아이콘 세트도 들이지 않고 여기서 패스로 둔다.
 * 글자 크기를 따라가도록 stroke 는 currentColor 다.
 */
const P: Record<string, string> = {
  // 도구
  select: "M3.5 2.2l8.6 6.6-3.9.7 2 3.9-1.7.9-2-3.9-3 2.7z",
  wire: "M2 11.5h3.5l3-7h5.5",
  label: "M2.5 5.5h6.5l3.5 2.5-3.5 2.5H2.5z",
  gnd: "M8 3v4.5M3.5 7.5h9M5.5 10.5h5M7 13h2",
  power: "M8 13.5V6M5 9l3-3 3 3M3.5 3h9",
  probe: "M10.5 2.5l3 3-5.5 5.5-4 1 1-4z",
  junction: "M8 2v12M2 8h12",
  nc: "M4 4l8 8M12 4l-8 8",
  // 주석
  spice: "M5.5 3.5L2 8l3.5 4.5M10.5 3.5L14 8l-3.5 4.5",
  text: "M3.5 3.5h9M8 3.5v9M6 12.5h4",
  line: "M2.5 13.5L13.5 2.5",
  rect: "M2.5 4h11v8h-11z",
  // 편집
  del: "M2.5 4.5h11M6 4.5V2.5h4v2M4.5 4.5l.8 9h5.4l.8-9",
  rot: "M13 8a5 5 0 1 1-1.6-3.7M13.5 1.8V5h-3.2",
  flipx: "M8 1.8v12.4M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3",
  flipy: "M1.8 8h12.4M5 5.5L8 2.5l3 3M5 10.5l3 3 3-3",
  copy: "M5.5 5.5h8v8h-8zM2.5 10.5v-8h8",
  paste: "M5.5 2.5h5v2h-5zM3 4.5h10v9H3z",
  undo: "M3 8.5A5 5 0 1 1 8 13.5M2.5 4.5v4h4",
  redo: "M13 8.5A5 5 0 1 0 8 13.5M13.5 4.5v4h-4",
  // 보기·파일
  fit: "M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3",
  open: "M2 4h4l1.5 2H14v7.5H2z",
  down: "M8 2.5v7.5M5 7.5l3 3 3-3M3 13.5h10",
  run: "M5 3l7.5 5L5 13z",
  // 테마. 누르면 넘어갈 쪽을 그린다 — 어두우면 해, 밝으면 달
  sun: "M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 1 0 0-5.6M8 1.4v1.6M8 13v1.6" +
       "M1.4 8h1.6M13 8h1.6M3.3 3.3l1.15 1.15M11.55 11.55l1.15 1.15" +
       "M12.7 3.3l-1.15 1.15M4.45 11.55L3.3 12.7",
  moon: "M13.2 10.1A5.7 5.7 0 0 1 5.9 2.8a5.7 5.7 0 1 0 7.3 7.3z",
  // 패널 (모바일)
  parts: "M2.5 2.5h5v5h-5zM8.5 8.5h5v5h-5zM8.5 2.5h5v5h-5z",
  // 부품 라이브러리 창: 책꽂이 — 선 책 둘과 기운 책 하나
  library: "M3 2.5v10.5M6 2.5v10.5M8.8 3.4l3.4 9.6M1.8 13.5h12.4",
  props: "M3 4.5h10M3 8h10M3 11.5h10M6 2.8v3.4M10.5 6.3v3.4M5 9.8v3.4",
  // 어시스턴트: 말풍선 안에 반짝임 (네 갈래)
  assistant: "M2.5 3h11v7.5H8.5l-3.5 2.8v-2.8H2.5zM8 4.6v4.2M5.9 6.7h4.2",
  // 대화 창
  send: "M2.5 8h10M8.8 4.3L12.5 8l-3.7 3.7",
  plus: "M8 3v10M3 8h10",
  gear: "M8 5.7a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 1 0 0-4.6M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2" +
        "M3.6 3.6L5 5M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4",
  close: "M4 4l8 8M12 4l-8 8",
  // 긴 대화 줄이기: 줄이 짧아진다
  compact: "M3 4h10M3 8h7M3 12h4",
  // 그림 붙이기: 클립
  attach: "M10.8 5.2L6.1 9.9a1.5 1.5 0 0 0 2.1 2.1l5-5a3 3 0 0 0-4.2-4.2l-5.1 5.1a4.4 4.4 0 0 0 6.2 6.2l3.4-3.4",
  // 프로젝트 메모: 접힌 귀퉁이와 줄
  memo: "M3.5 2.5h6.5l2.5 2.5v8.5h-9zM10 2.5V5h2.5M5.5 8h5M5.5 10.5h5",
};

/** 아이콘 하나의 SVG. size 는 화면 픽셀 */
export function icon(name: string, size = 16): string {
  const d = P[name];
  if (!d) return "";
  const fill = name === "select" || name === "run" ? "currentColor" : "none";
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" ` +
    `fill="${fill}" stroke="currentColor" stroke-width="1.4" ` +
    `stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
}

/** data-icon 이 붙은 요소를 전부 채운다. 글자가 있으면 아이콘을 앞에 끼운다 */
export function stampIcons(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    const name = el.dataset.icon!;
    const svg = icon(name, Number(el.dataset.iconSize) || 16);
    if (!svg) continue;
    el.insertAdjacentHTML("afterbegin", svg);
    delete el.dataset.icon;
  }
}
