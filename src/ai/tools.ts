/**
 * 어시스턴트의 도구 — 한 목록에 모은다. 모델에게 보낼 정의(toolSpecs)와 실행(runTool)이 같은 목록을
 * 본다. 도구 하나는 이름 · 설명 · 인자(JSON 스키마) · 실행 함수다 (tool-kit.ts).
 *
 * 실행이 던진 ToolError 는 그 말 그대로 모델에게 돌아간다 — 모델이 인자를 고쳐 다시 부르게.
 * 다른 오류도 모델에게 돌아가지만 콘솔에도 남긴다 (도구의 버그다).
 */
import type { AssistantHost } from "./host.ts";
import type { AISettings } from "./settings.ts";
import type { ToolSpec } from "./openrouter.ts";
import { ToolError } from "./circuit.ts";
import type { Tool, ToolContext, ToolResult } from "./tool-kit.ts";
import { circuitTools } from "./tools-circuit.ts";
import { simTools } from "./tools-sim.ts";
import { layoutTools } from "./tools-layout.ts";

export const TOOLS: Tool[] = [...circuitTools, ...simTools, ...layoutTools];
const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

/** 설정이나 모델 때문에 모델에게 보이지 않는 도구 */
function hidden(t: Tool, s: AISettings, vision: boolean): boolean {
  if (t.needs === "simulate") return !s.allowSimulate;
  if (t.needs === "vision") return !vision || !s.pictures;
  return false;
}

/** 지금 쓸 수 없는 까닭 (쓸 수 있으면 빈 글) */
function unavailable(t: Tool, host: AssistantHost, s: AISettings, vision: boolean): string {
  if (t.needs === "simulate" && !s.allowSimulate) return "Running simulations is turned off in the assistant settings. Tell the user what you would run.";
  if (t.needs === "vision" && !vision) return "The current model cannot read pictures. Use get_circuit, get_results and read_trace instead.";
  if (t.needs === "vision" && !s.pictures) return "Looking at pictures is turned off in the assistant settings. Use get_circuit, get_results and read_trace instead.";
  if (t.edits && host.external()) {
    return "An external netlist is open as text, so the schematic is not what runs and editing it would not change the simulation. " +
      "Tell the user; they can reopen the .sp and turn it into a schematic.";
  }
  return "";
}

/**
 * 모델에게 보낼 도구 정의. 설정이 끈 것과 모델이 못 쓰는 것(그림)은 뺀다 (편집 도구는 남긴다 — 왜 안
 * 되는지 들어야 한다)
 */
export function toolSpecs(s: AISettings, vision = false): ToolSpec[] {
  return TOOLS.filter(t => !hidden(t, s, vision)).map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: { type: "object", properties: t.params ?? {}, required: t.required ?? [] },
    },
  }));
}

/** 도구 하나를 실행한다. 실패도 결과다 — { error } 로 모델에게 돌아간다 */
export async function runTool(name: string, ctx: ToolContext): Promise<ToolResult> {
  try {
    const t = BY_NAME.get(name);
    if (!t) throw new ToolError(`There is no tool "${name}".`);
    const why = unavailable(t, ctx.host, ctx.settings, !!ctx.vision);
    if (why) throw new ToolError(why);
    return await t.run(ctx);
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "AbortError") throw e;
    const message = e instanceof ToolError ? e.message : `${(e as Error)?.name || "Error"}: ${(e as Error)?.message || e}`;
    if (!(e instanceof ToolError)) console.error("[assistant] tool failed", name, e);
    return { data: { error: message }, summary: "error" };
  }
}

