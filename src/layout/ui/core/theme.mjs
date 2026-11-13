/** 테마 — melange 의 것을 따른다 (<html class="dark|light">, 고르지 않았으면 운영체제 설정).
 *
 *  레이아웃 화면은 캔버스 색을 CSS 변수에서 읽어 두므로, 테마가 바뀌면 다시 읽어야 한다 — watchTheme 이 알려 준다.
 *  새 창도 같은 클래스를 받아 따라간다 (shell 이 연 창의 클래스를 옮긴다).
 */
export function currentTheme(doc = document) {
  const c = doc.documentElement.classList;
  if (c.contains("dark")) return "dark";
  if (c.contains("light")) return "light";
  return doc.defaultView.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** 테마가 바뀌면 cb() — 멈추는 함수를 돌려준다 */
export function watchTheme(doc, cb) {
  let last = currentTheme(doc);
  const check = () => { const t = currentTheme(doc); if (t !== last) { last = t; cb(t); } };
  const mo = new doc.defaultView.MutationObserver(check);
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ["class"] });
  const mq = doc.defaultView.matchMedia("(prefers-color-scheme: light)");
  mq.addEventListener("change", check);
  return () => { mo.disconnect(); mq.removeEventListener("change", check); };
}
