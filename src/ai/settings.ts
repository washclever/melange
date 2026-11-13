/**
 * 어시스턴트 설정과 OpenRouter 키. 이 브라우저에만 둔다.
 *
 * 키는 "이 기기에 기억" 을 켜면 localStorage, 끄면 이 탭의 sessionStorage 다. 저장 이름은 앱의 다른
 * 설정과 같은 결이다 (melange.layout · melange.keys). 저장소를 못 쓰면(사생활 보호 창) 이 탭에서만 쓴다.
 * node 의 검증(tools/verify-ai-*.ts)에서는 저장소가 없으니 기본값으로 돈다.
 */

export interface AISettings {
  /** OpenRouter 모델 id. 비었으면 목록을 받을 때 고른다 (openrouter.ts defaultModel) */
  model: string;
  temperature: number;
  /** 요청 하나에서 모델을 부르는 횟수의 한계 */
  maxSteps: number;
  /** 키를 이 기기에 기억한다 (아니면 이 탭에서만) */
  remember: boolean;
  /** 어시스턴트가 시뮬레이션을 돌려 볼 수 있다 */
  allowSimulate: boolean;
  /** 어시스턴트가 돌린 시뮬레이션을 기다리는 시간 (초). 넘으면 멈춘다 */
  simTimeout: number;
  /** Claude: 프롬프트 캐시를 한 시간 둔다 (캐시 쓰기 값이 더 든다) */
  cacheLong: boolean;
  /** 어시스턴트가 회로도 · 파형을 그림으로 볼 수 있다 (그림을 읽는 모델일 때만) */
  pictures: boolean;
  /** 요청이 끝나면 프로젝트 메모를 고쳐 둔다 (대화가 바뀌어도 이어지는 요약) */
  memo: boolean;
}

export const DEFAULTS: AISettings = {
  model: "",
  temperature: 0.3,
  maxSteps: 30,
  remember: true,
  allowSimulate: true,
  simTimeout: 120,
  cacheLong: false,
  pictures: true,
  memo: true,
};

const SETTINGS_KEY = "melange.ai";
const KEY_KEY = "melange.openrouter-key";

/** 저장소가 없거나 막혀 있으면 null (node · 사생활 보호 창) */
function store(kind: "local" | "session"): Storage | null {
  try {
    const s = kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
    return s ?? null;
  } catch { return null; }
}

const clamp = (v: unknown, lo: number, hi: number, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

/** 바깥에서 들어온 값(저장소 · 설정 창)을 받을 수 있는 모양으로 */
export function clean(v: Partial<AISettings>): AISettings {
  const d = DEFAULTS;
  return {
    model: typeof v.model === "string" ? v.model.trim() : d.model,
    temperature: clamp(v.temperature, 0, 1.5, d.temperature),
    maxSteps: Math.round(clamp(v.maxSteps, 1, 80, d.maxSteps)),
    remember: typeof v.remember === "boolean" ? v.remember : d.remember,
    allowSimulate: typeof v.allowSimulate === "boolean" ? v.allowSimulate : d.allowSimulate,
    simTimeout: Math.round(clamp(v.simTimeout, 5, 3600, d.simTimeout)),
    cacheLong: typeof v.cacheLong === "boolean" ? v.cacheLong : d.cacheLong,
    pictures: typeof v.pictures === "boolean" ? v.pictures : d.pictures,
    memo: typeof v.memo === "boolean" ? v.memo : d.memo,
  };
}

type Listener = (s: AISettings) => void;

export class SettingsStore {
  value: AISettings;
  private secret = "";
  private readonly listeners = new Set<Listener>();

  constructor() {
    let saved: Partial<AISettings> = {};
    try { saved = JSON.parse(store("local")?.getItem(SETTINGS_KEY) || "{}"); } catch { /* 깨진 값이면 기본값 */ }
    this.value = clean({ ...DEFAULTS, ...saved });
    try { this.secret = store("local")?.getItem(KEY_KEY) || store("session")?.getItem(KEY_KEY) || ""; } catch { /* 못 읽으면 없는 것 */ }
  }

  get key(): string { return this.secret; }

  set(patch: Partial<AISettings>): void {
    this.value = clean({ ...this.value, ...patch });
    try { store("local")?.setItem(SETTINGS_KEY, JSON.stringify(this.value)); } catch { /* 저장 못 해도 쓴다 */ }
    if (patch.remember !== undefined) this.keep();
    this.emit();
  }

  setKey(key: string): void {
    this.secret = key.trim();
    this.keep();
    this.emit();
  }

  /** 설정이 바뀔 때마다 부른다. 돌려준 함수를 부르면 끊는다 */
  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit() { for (const f of this.listeners) f(this.value); }

  /** 키를 '기억' 설정에 맞는 저장소 한 곳에만 둔다 */
  private keep() {
    try {
      store("local")?.removeItem(KEY_KEY);
      store("session")?.removeItem(KEY_KEY);
      if (this.secret) store(this.value.remember ? "local" : "session")?.setItem(KEY_KEY, this.secret);
    } catch { /* 저장 못 해도 이 탭에서는 쓴다 */ }
  }
}

export const settings = new SettingsStore();
