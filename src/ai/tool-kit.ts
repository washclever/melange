/**
 * 도구를 만드는 데 쓰는 것 — 도구의 모양, 실행할 때 받는 것, 인자 읽기, 스키마 조각.
 * 도구 목록(tools.ts)과 따로 둔다: 도구 모듈들이 이것을 가져오고 tools.ts 가 도구 모듈들을 가져온다.
 * 한 파일에 두면 서로 가져오는 고리가 생겨, 도구 목록을 만드는 순간 아직 없는 값을 읽는다.
 */
import type { Group } from "../doc/history.ts";
import type { AssistantHost, Picture } from "./host.ts";
import type { AISettings } from "./settings.ts";
import { ToolError } from "./circuit.ts";

export type Json = Record<string, any>;

export interface ToolContext {
  args: Json;
  host: AssistantHost;
  /** 이 요청의 꼬리표 — 편집이 실행 취소 한 단계로 묶인다 */
  group: Group;
  settings: AISettings;
  signal?: AbortSignal;
  /** 지금 모델이 그림을 읽는다 */
  vision?: boolean;
}

export interface ToolResult {
  /** 모델에게 돌려줄 값 (JSON 으로 보낸다) */
  data: unknown;
  /** 대화 창의 도구 줄에 보일 짧은 말 */
  summary?: string;
  /** 모델에게 보여 줄 그림 (agent.ts 가 도구 결과 뒤에 붙인다) */
  images?: Picture[];
}

export interface Tool {
  name: string;
  description: string;
  /** 인자 (JSON 스키마의 properties) */
  params?: Json;
  required?: string[];
  /** 회로를 바꾼다 — 외부 넷리스트를 텍스트로 연 동안은 거부한다 */
  edits?: boolean;
  /** 설정이 꺼져 있으면(vision: 그림을 못 읽는 모델이어도) 모델에게 보이지 않는다 */
  needs?: "simulate" | "vision";
  run(ctx: ToolContext): ToolResult | Promise<ToolResult>;
}

// ── 인자 읽기 ─────────────────────────────────────────────────────────
export function list<T = Json>(v: unknown, what: string): T[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ToolError(`${what} must be an array.`);
  return v as T[];
}

export function text(v: unknown, what: string, max = 4000): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") throw new ToolError(`${what} must be a string.`);
  return v.slice(0, max);
}

export function num(v: unknown, what: string): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ToolError(`${what} must be a number.`);
  return n;
}

export function point(v: unknown, what: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) throw new ToolError(`${what} must be [x, y] in grid units.`);
  return [Math.round(num(v[0], what)), Math.round(num(v[1], what))];
}

export function rotation(v: unknown, what = "rot"): 0 | 90 | 180 | 270 {
  if (v === undefined || v === null) return 0;
  const n = ((Math.round(num(v, what)) % 360) + 360) % 360;
  if (n !== 0 && n !== 90 && n !== 180 && n !== 270) throw new ToolError(`${what} must be 0, 90, 180 or 270.`);
  return n;
}

/** 스키마 조각 */
export const S = {
  str: (description: string) => ({ type: "string", description }),
  num: (description: string) => ({ type: "number", description }),
  bool: (description: string) => ({ type: "boolean", description }),
  strs: (description: string) => ({ type: "array", items: { type: "string" }, description }),
  xy: (description: string) => ({ type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description }),
  rot: () => ({ type: "number", enum: [0, 90, 180, 270], description: "Rotation, counterclockwise, in degrees" }),
};
