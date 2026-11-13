/**
 * 어시스턴트를 한 덩어리로 내보낸다 — 앱은 이것을 **필요할 때** 받는다 (dynamic import).
 *
 * 어시스턴트는 키를 넣고 쓰는 사람만 쓴다. 회로도를 그리러 온 사람의 첫 화면에 실을 까닭이 없다
 * (계산기를 계산기 탭을 열 때 받는 것과 같은 생각이다 — src/calc/calc.ts). 패널을 열 때, 또는
 * OpenRouter 연결 화면에서 돌아왔을 때 받는다. 모양을 쓰는 것(AssistantHost)은 타입이라 따로 온다.
 */
import "./panel.css";

export { mountAssistant, type AssistantPanel } from "./panel.ts";
export { settings } from "./settings.ts";
