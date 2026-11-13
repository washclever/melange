/** Placement 편집기의 키 — 단축키를 바꾸려면 여기만 고친다. 회로도(melange)와 같은 뜻의 키는 같은 키다 (X·Y 반전,
 *  Ctrl+Z·Ctrl+Y, K 맞추기).
 *
 *  | 키                  | 하는 일 |
 *  |---------------------|---------|
 *  | 화살표              | 고른 블록을 한 격자 (SKY130 430 / 420 nm) 씩, Shift 면 열 격자 — 제약을 따라 |
 *  | X / Y               | x / y 반전 (거울 그룹 단위) — 셀은 돌릴 수 없고 뒤집기만 된다 |
 *  | L                   | 잠금 — 끌 때 그 자리에 둔다 |
 *  | S                   | 고른 두 블록의 자리 바꾸기 |
 *  | Enter               | 정리 (위상 유지) |
 *  | Ctrl+Z              | 되돌리기 |
 *  | Ctrl+Y, Ctrl+Shift+Z | 다시 실행 |
 *  | Esc                 | 고르기 해제 |
 *  | K, Home / + / -     | 화면 맞추기 / 확대 / 축소 |
 */
import { placeGrid } from "../../pdk/pdk.mjs";

export function placementKey(e, w) {
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (e.altKey) return false;
  if (ctrl && !(k === "z" || k === "Z" || k === "y" || k === "Y")) return false;
  if (k === "Home" || ((k === "k" || k === "K") && !ctrl)) { w.fit(); return true; }
  if ((k === "+" || k === "=") && !ctrl) { w.zoom(1.25); return true; }
  if ((k === "-" || k === "_") && !ctrl) { w.zoom(1 / 1.25); return true; }
  const P = w.ed()?.placement;
  if (!P?.pl.model || P.pl.busy) return false;
  const [gx, gy] = P.pl.model.grid ?? placeGrid();
  const mul = e.shiftKey ? 10 : 1;
  if (k === "ArrowLeft") P.nudge(-gx * mul, 0);
  else if (k === "ArrowRight") P.nudge(gx * mul, 0);
  else if (k === "ArrowUp") P.nudge(0, gy * mul);
  else if (k === "ArrowDown") P.nudge(0, -gy * mul);
  else if ((k === "z" || k === "Z") && ctrl && e.shiftKey) P.redo();
  else if ((k === "z" || k === "Z") && ctrl) P.undo();
  else if ((k === "y" || k === "Y") && ctrl) P.redo();
  else if (k === "x" || k === "X") P.flip("x");
  else if (k === "y" || k === "Y") P.flip("y");
  else if (k === "l" || k === "L") P.toggleLock();
  else if (k === "s" || k === "S") P.swap();
  else if (k === "Enter") P.settle();
  else if (k === "Escape") P.clearSelection();
  else return false;
  return true;
}
