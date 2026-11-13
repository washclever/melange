/** shell.mjs 의 겉모습 (switch.ts 가 타입만 본다 — 본체는 필요할 때 받는다) */
export interface LayoutSnapshot {
  sheet: unknown;
  library: unknown;
  ex: unknown;
  name: string;
}

/** melange 가 주는 것 */
export interface LayoutHostBase {
  /** 지금 회로도 (레이아웃 넷리스트를 만들 때 읽는다) */
  snapshot(): LayoutSnapshot;
  /** 회로도가 바뀔 때마다 늘어나는 수 */
  version(): number;
  /** 레이아웃에서 고른 블록의 부품을 회로도에서 고른다 */
  selectParts(refs: string[]): void;
  /** 레이아웃에서 고른 넷을 회로도에서 강조한다 (null 이면 끈다) */
  highlightNet(name: string | null): void;
  /** 회로 칸의 크기가 바뀌었다 */
  onLayoutChange(): void;
}

export interface LayoutHost extends LayoutHostBase {
  onSelection(cb: (refs: string[]) => void): void;
  refreshSwitch(): void;
}

export interface LayoutShell {
  /** 어시스턴트의 손잡이 */
  control: import("../../ai/host.ts").LayoutControl;
  show(id: string): void;
  pairMenu(i: number, anchor: HTMLElement): void;
  activate(id: string): void;
  view(): Record<string, { shown: boolean; active: boolean; popped: boolean }>;
  ownsKeys(): boolean;
}

export const WS: Array<{ id: string; label: string }>;
export function createShell(doc: Document, host: LayoutHost): LayoutShell;
