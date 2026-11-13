/**
 * 레이아웃 도구 — 회로도의 트랜지스터를 SKY130 레이아웃으로: 회로도 읽기 -> 자동 배치 -> 배치 고치기 -> 자동 배선 ->
 * 배선 고치기. Placement · Layout 편집기가 하는 것을 같은 함수로 한다 (src/layout/ui/ai.mjs 의 LayoutControl). 사용자는
 * 편집기 화면에서 그것을 보고, 편집기의 되돌리기로 되돌린다.
 *
 * 레이아웃 덩어리는 처음 쓸 때 받는다 (host.layout()). 이 파일은 어시스턴트 덩어리에 들고, 레이아웃 본체를 값으로
 * 가져오지 않는다 — 타입만.
 */
import { ToolError } from "./circuit.ts";
import { S, list, num, text, type Json, type Tool, type ToolContext } from "./tool-kit.ts";
import type { LayoutControl, LayoutView, PlacementEdit, RoutingAction } from "./host.ts";

async function L(ctx: ToolContext): Promise<LayoutControl> {
  if (!ctx.host.layout) throw new ToolError("The Placement and Layout editors are not available here.");
  return ctx.host.layout();
}

/** 레이아웃이 던진 "할 수 없다" 는 모델에게 그 말 그대로 */
async function run<T>(f: () => Promise<T> | T): Promise<T> {
  try { return await f(); }
  catch (e) {
    if ((e as Error)?.name === "LayoutError") throw new ToolError((e as Error).message);
    throw e;
  }
}

const sizeOf = (p: Json | null | undefined) => (p?.size_nm ? `${p.size_nm[0]} x ${p.size_nm[1]} nm` : "");
const routeLine = (r: Json | null | undefined) =>
  !r ? "" : r.routed ? `DRC/LVS ${r.drc_lvs_errors}${r.open_nets?.length ? ` · open ${r.open_nets.length}` : ""}` : "routing failed";

const ACTIONS: RoutingAction[] = ["connect_net", "connect_all", "route_unfinished", "delete_net", "undo", "redo"];
const VIEWS: LayoutView[] = ["circuit", "placement", "layout", "circuit+placement", "placement+layout", "all"];

export const layoutTools: Tool[] = [
  {
    name: "layout_status",
    description: "Read the SKY130 layout of the circuit: what was read from the schematic (transistors, pins, notes on sizes changed for the cells), " +
      "the blocks the layout front end grouped them into (current mirror, differential pair, single transistor … with variants and symmetry), " +
      "the placement (size, HPWL, each block's position x, y, size, flip, variant, locked) and the routing (DRC/LVS errors, open nets, nets with length). " +
      "Coordinates and sizes are in nm.",
    async run(ctx) {
      const s = (await L(ctx)).status() as Json;
      return { data: s, summary: s.placement ? `${sizeOf(s.placement)}${s.routing ? " · " + routeLine(s.routing) : ""}` : "not placed" };
    },
  },
  {
    name: "layout_read_schematic",
    description: "Read the schematic again for the layout: its transistors (SKY130 nFET/pFET/pFET HVT, generic NMOS/PMOS) become blocks. " +
      "Other parts stay out; nets they touch become pins. If the layout netlist did not change, the placement and routing are kept; if it did, they are cleared.",
    async run(ctx) {
      const r = await run(async () => (await L(ctx)).read({ signal: ctx.signal })) as Json;
      return { data: r, summary: `${(r.blocks as unknown[] | undefined)?.length ?? 0} blocks` };
    },
  },
  {
    name: "layout_place",
    description: "Place the blocks automatically (reads the schematic first if it changed). The placer picks variants, flips and positions on the " +
      "routing grid and keeps symmetry. Takes seconds to a minute. Shows the Placement editor if it is not on screen.",
    params: {
      effort: { type: "string", enum: ["fast", "normal", "wide"], description: "How many starting points to try: fast 48, normal 96 (default), wide 288" },
      wirelength_weight: S.num("Weight of wirelength against area when choosing between candidates: 1 = equal (default), 2 = shorter wires matter twice as much, 0.5 = smaller area matters more"),
    },
    async run(ctx) {
      const a = ctx.args;
      const effort = a.effort === undefined ? undefined : text(a.effort, "effort", 10) as "fast" | "normal" | "wide";
      if (effort && !["fast", "normal", "wide"].includes(effort)) throw new ToolError('effort must be "fast", "normal" or "wide".');
      const w = a.wirelength_weight === undefined ? undefined : num(a.wirelength_weight, "wirelength_weight");
      const r = await run(async () => (await L(ctx)).place({ effort, wirelengthWeight: w, signal: ctx.signal })) as Json;
      return { data: r, summary: `placed ${sizeOf(r.placement)}` };
    },
  },
  {
    name: "layout_edit_placement",
    description: "Change the placement by hand, like dragging in the Placement editor: move blocks (absolute lower-left x, y or relative dx, dy, in nm), " +
      "flip them (cells only mirror; they cannot rotate), pick another variant, lock them, or swap two blocks. Mirror pairs move and flip together " +
      "(their symmetry constraint holds). Then the placement is settled: overlaps removed and snapped to the grid, keeping the relative order you set. " +
      "Editing the placement clears the routing — route again afterwards.",
    params: {
      edits: {
        type: "array",
        description: "Edits, applied in order",
        items: {
          type: "object",
          properties: {
            block: S.str("Block name, e.g. X_MX3_MX4"),
            x: S.num("New lower-left x (nm)"), y: S.num("New lower-left y (nm)"),
            dx: S.num("Move by dx (nm)"), dy: S.num("Move by dy (nm)"),
            flip: { type: "string", enum: ["x", "y", "xy"], description: "Mirror the block: x (left-right), y (up-down), xy (both = 180°)" },
            variant: S.str("Another variant of the block (layout_status lists other_variants)"),
            lock: S.bool("Lock (true) or unlock (false) — a locked block stays where it is when settling"),
          },
          required: ["block"],
        },
      },
      swap: S.strs("Two block names whose positions to swap"),
      settle: S.bool("Settle afterwards (default true)"),
      optimize: S.bool("After settling, re-choose variants exhaustively for this arrangement (Optimize, keep topology). Default false"),
    },
    async run(ctx) {
      const a = ctx.args;
      const edits = list<PlacementEdit>(a.edits, "edits");
      const swap = a.swap === undefined ? null : list<string>(a.swap, "swap").map(s => text(s, "swap"));
      if (!edits.length && !swap && !a.optimize) throw new ToolError("Give edits, swap or optimize.");
      const r = await run(async () => (await L(ctx)).editPlacement({
        edits, swap, settle: a.settle === undefined ? true : !!a.settle, optimize: !!a.optimize, signal: ctx.signal,
      })) as Json;
      return { data: r, summary: `${(r.done as unknown[]).length} edit${(r.done as unknown[]).length === 1 ? "" : "s"} · ${sizeOf(r.placement)}` };
    },
  },
  {
    name: "layout_route",
    description: "Auto route with the ALIGN router (optional — tracks can also be drawn like a person does, see layout_fix_routing), then check DRC/LVS. " +
      "Its tracks become ordinary tracks in the Layout editor that the user can edit. By default nets that are already fully drawn are kept and the router " +
      "avoids them; keep_drawn false replaces every track. Settles unsettled placement edits first. Aim for 0 DRC/LVS errors and no open nets.",
    params: { keep_drawn: S.bool("Keep the nets that are already fully connected by drawn tracks (default true)") },
    async run(ctx) {
      const r = await run(async () => (await L(ctx)).route({ keepDrawn: ctx.args.keep_drawn === undefined ? true : !!ctx.args.keep_drawn, signal: ctx.signal })) as Json;
      return { data: r, summary: routeLine(r.routing as Json) };
    },
  },
  {
    name: "layout_fix_routing",
    description: "Draw and fix tracks in the Layout editor, the way a person does there: connect_net draws tracks along the net's ratsnest (from a pin, " +
      "an L on the met2/met3 pair or another pair, a via where it turns; only where nothing is shorted and no spacing rule is broken), connect_all does " +
      "that for every open net, route_unfinished lets the router route the nets that are not finished and keeps the finished ones, delete_net removes " +
      "a net's tracks, undo, redo. Every action rechecks DRC/LVS and returns the new state.",
    params: {
      action: { type: "string", enum: ACTIONS, description: "What to do" },
      net: S.str("The net (needed for connect_net and delete_net)"),
    },
    required: ["action"],
    async run(ctx) {
      const action = text(ctx.args.action, "action", 40) as RoutingAction;
      if (!ACTIONS.includes(action)) throw new ToolError(`action must be one of ${ACTIONS.join(", ")}.`);
      const net = ctx.args.net === undefined || ctx.args.net === null ? undefined : text(ctx.args.net, "net", 200);
      const r = await run(async () => (await L(ctx)).fixRouting({ action, net, signal: ctx.signal })) as Json;
      return { data: r, summary: `${action.replace(/_/g, " ")}${net ? " " + net : ""} · ${routeLine(r.routing as Json)}` };
    },
  },
  {
    name: "layout_show",
    description: "Show editors and point at things for the user: view puts editors on screen (the assistant stays on the right), net highlights a net " +
      "in the layout and on the schematic (null clears it), blocks selects blocks (and their transistors on the schematic).",
    params: {
      view: { type: "string", enum: VIEWS, description: "Which editors to show" },
      net: { type: ["string", "null"], description: "Net to highlight, or null to clear" },
      blocks: S.strs("Blocks to select"),
    },
    async run(ctx) {
      const a = ctx.args;
      const view = a.view === undefined ? undefined : text(a.view, "view", 40) as LayoutView;
      if (view && !VIEWS.includes(view)) throw new ToolError(`view must be one of ${VIEWS.join(", ")}.`);
      const blocks = a.blocks === undefined ? undefined : list<string>(a.blocks, "blocks").map(b => text(b, "blocks"));
      const net = a.net === null ? null : a.net === undefined ? undefined : text(a.net, "net", 200);
      const r = await run(async () => (await L(ctx)).show({ view, net, blocks }));
      return { data: r, summary: view ?? (net ? `net ${net}` : blocks?.join(", ") ?? "") };
    },
  },
  {
    name: "view_layout",
    description: "Look at the Placement or Layout editor as a picture (shows it if needed). For checking how blocks are arranged or where wires run; " +
      "layout_status stays the source of truth for numbers.",
    params: { editor: { type: "string", enum: ["placement", "layout"], description: "Which editor (default layout)" } },
    needs: "vision",
    async run(ctx) {
      const editor = ctx.args.editor === "placement" ? "placement" : "layout";
      const pic = await run(async () => (await L(ctx)).image({ editor }));
      if ("error" in pic) throw new ToolError(pic.error);
      return { data: { editor, width: pic.width, height: pic.height, note: pic.note }, summary: `looked at ${editor}`, images: [pic] };
    },
  },
];
