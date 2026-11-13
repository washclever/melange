/** 레이아웃 편집기의 키 — 단축키를 바꾸려면 여기만 고친다. PCB 편집기의 트랙 그리기에서 흔한 키를 따른다.
 *
 *  | 키                 | 하는 일 |
 *  |--------------------|---------|
 *  | W                  | 트랙 도구 (다시 누르면 고르기) |
 *  | V                  | 비아 도구. 그리는 중이면 그 자리에 비아를 두고 짝 층으로 |
 *  | S                  | 고르기 도구 |
 *  | M                  | 재기 |
 *  | 1 ~ 5              | 그리기 층 li1, met1 ~ met4. 그리는 중이면 그 자리에 비아를 쌓고 그 층으로 |
 *  | Space              | 그리는 중: L 의 꺾는 쪽을 바꾼다 (지금 층 먼저 / 짝 층 먼저) |
 *  | Backspace          | 그리는 중: 마지막 꺾점 무르기 / 고르기: 고른 것 지우기 |
 *  | Enter · Esc        | 그리는 중: 끝 (그린 것은 남는다) |
 *  | Esc                | 고른 것 풀기, 도구는 고르기로 |
 *  | Delete             | 고른 것 지우기 |
 *  | ← → ↑ ↓            | 고른 것을 한 트랙씩 — 줄은 제 트랙을 가로질러서만 (가로 층은 ↑ ↓, 세로 층은 ← →), 비아는 꺾는 점째로 |
 *  | Esc (끄는 중)      | 끌기를 그만둔다 (고친 것은 남지 않는다) |
 *  | H                  | 커서 아래 넷 밝히기 (회로도의 H 와 같다), 빈 곳이면 끈다 |
 *  | Ctrl+Z / Ctrl+Y    | 되돌리기 / 다시 (Ctrl+Shift+Z 도) |
 *  | K · Home           | 화면 맞추기 (회로도와 같은 K) |
 *  | + / -              | 확대 / 축소 |
 */
import { METALS } from "../../art/rules.mjs";

/** 키 하나 — 받았으면 true. w 는 작업 공간 (도구, 화면 맞추기, 재기 지우기, 밝히기) */
export function layoutKey(e, w) {
  const T = w.T(), k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (e.altKey) return false;
  if (ctrl && !/^[zZyY]$/.test(k)) return false;                         // 브라우저 단축키는 그대로
  if (k === "Home" || ((k === "k" || k === "K") && !ctrl)) { w.fit(); return true; }
  if ((k === "+" || k === "=") && !ctrl) { w.zoom(1.25); return true; }
  if ((k === "-" || k === "_") && !ctrl) { w.zoom(1 / 1.25); return true; }
  if (!T) return false;
  const te = T.te, drawing = !!te.draw;
  if (w.tool() === "measure") {
    if (k === "Escape") { if (!w.clearMeasure()) w.setTool("select"); return true; }
    if (k === "m" || k === "M") { w.setTool("select"); return true; }
  }
  if (ctrl && (k === "z" || k === "Z") && !e.shiftKey) { T.undo(); return true; }
  if (ctrl && ((k === "y" || k === "Y") || ((k === "z" || k === "Z") && e.shiftKey))) { T.redo(); return true; }
  if (/^[1-9]$/.test(k) && METALS[Number(k) - 1]) { T.setLayer(METALS[Number(k) - 1]); return true; }
  if (drawing) {
    if (k === " ") { T.flip(); return true; }
    if (k === "Backspace") { T.back(); return true; }
    if (k === "Enter" || k === "Escape") { T.finish(); return true; }
    if (k === "v" || k === "V") { if (te.draw.other) T.switchLayer(te.draw.other); return true; }
    return false;
  }
  if (k === "w" || k === "W") { w.setTool(te.tool === "track" ? "select" : "track"); return true; }
  if (k === "v" || k === "V") { w.setTool(te.tool === "via" ? "select" : "via"); return true; }
  if (k === "s" || k === "S") { w.setTool("select"); return true; }
  if (k === "m" || k === "M") { w.setTool("measure"); return true; }
  if (k === "h" || k === "H") { w.highlight(); return true; }
  if (k === "Delete" || k === "Backspace") return T.del();
  const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[k];
  if (arrow && te.sel.size) return T.nudgeSel(arrow[0], arrow[1]);
  if (k === "Escape") {
    if (T.cancelDrag()) return true;
    if (te.tool !== "select") { w.setTool("select"); return true; }
    if (te.sel.size || te.net) { T.clearSelection(); return true; }
    return false;
  }
  return false;
}
