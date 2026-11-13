/** 캔버스 색 — CSS 토큰(styles/layout.css 의 .lyt)을 한 번 읽어 둔다.
 *
 *  getComputedStyle 은 스타일 재계산을 강제한다. 블록마다 부르면 한 프레임이 수백 ms 로 늘어진다 — 한 번 읽어두고 테마가
 *  바뀔 때만 다시 읽는다 (watchTheme). 창마다 따로 읽는다 (새 창은 그 창의 문서에서).
 */
const KEYS = {
  sunk: "--sunk", ink: "--ink", faint: "--faint", muted: "--muted", hair: "--hair", line: "--line", axis: "--axis",
  block: "--block", blockLine: "--block-line", ours: "--ours", canvas: "--canvas", grid: "--grid", gridMajor: "--grid-major",
  probe: "--probe", panel: "--panel",
};
export function readPalette(doc = document) {
  // 토큰은 편집기 자리(.lyt)에 있다 — :root 의 같은 이름(--line, --grid, --axis ...)은 회로도의 것이다
  const cs = doc.defaultView.getComputedStyle(doc.querySelector(".lyt") ?? doc.documentElement);
  const pal = {};
  for (const [k, v] of Object.entries(KEYS)) pal[k] = cs.getPropertyValue(v).trim();
  pal.canvas ||= pal.sunk;
  pal.grid ||= pal.hair;
  pal.gridMajor ||= pal.line;
  pal.probe ||= pal.axis;
  pal.bad = cs.getPropertyValue("--bad").trim() || "#c8302f";                     // 겹침·규칙 위반·검사기 오류
  return pal;
}
