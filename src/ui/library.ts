/**
 * 부품 라이브러리 창 (Shift+F).
 *
 * 세 칸이다. 왼쪽은 라이브러리(수동 소자 · 아날로그 · SKY130 · 기호)와 그 안의 칸, 가운데는 부품
 * 목록, 오른쪽은 고른 부품의 심볼과 속성 · 핀 · SPICE 줄. 큰 EDA 들의 라이브러리 창과 같은 쓰임새지만
 * 화면 구성은 이 앱의 것으로 새로 짰고, 다른 프로그램의 그림 · 문구 · 부품 데이터는 쓰지 않는다.
 *
 * 미리보기는 실제와 **같은 함수**로 만든다. 심볼은 회로도가 쓰는 drawPart, SPICE 줄은 넷리스트가 쓰는
 * deviceLines·modelLine 이다. 따로 그리면 언젠가 창에서 본 것과 놓은 것이 달라진다.
 *
 * 키보드만으로 끝까지 간다 — 열면 찾기 칸에 초점, 위·아래로 고르고 Enter 로 놓는다. Esc 는 닫기.
 * 줄을 캔버스로 끌어다 놓아도 된다 (왼쪽 목록과 같은 dataTransfer 형식이라 받는 쪽이 하나다).
 */
import type { LibPart, Part, Pt } from "../doc/types.ts";
import { symbolBox } from "../doc/sheet-index.ts";
import { defaultParams } from "../lib/parts.ts";
import { ABOUT, ENTRIES, LIBRARIES, elementLetters, search, type Entry } from "../lib/catalog.ts";
import { deviceLines, modelLine } from "../net/netlist.ts";
import { drawPart, theme } from "../render/schematic.ts";
import { toScreen, type Viewport } from "../feel/viewport.ts";
import { refract } from "./glass.ts";

export interface LibraryHost {
  /** 고른 부품으로 배치를 시작한다. 창은 그 전에 닫힌다 */
  place(id: string): void;
  /** 창이 닫혔다 (어떤 길로든). 초점을 캔버스로 돌려준다 */
  closed(): void;
}

/** 보는 범위. lib 이 null 이면 전부, group 이 null 이면 그 라이브러리 전부 */
interface Scope { lib: string | null; group: string | null }

/** 닫았다 다시 열어도 보던 자리 그대로다 */
const memory: { scope: Scope; query: string; pick: string } = {
  scope: { lib: null, group: null }, query: "", pick: "r",
};

let win: HTMLElement | null = null;
let undo: Array<() => void> = [];

export const libraryOpen = (): boolean => !!win;

export function closeLibrary(): void {
  if (!win) return;
  win.remove();
  win = null;
  for (const f of undo) f();
  undo = [];
  hostRef?.closed();
}

let hostRef: LibraryHost | null = null;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const inScope = (s: Scope): Entry[] =>
  ENTRIES.filter(e => (!s.lib || e.lib.id === s.lib) && (!s.group || e.group.name === s.group));

const scopeName = (s: Scope): string => {
  if (!s.lib) return "all parts";
  const lib = LIBRARIES.find(l => l.id === s.lib);
  return s.group ? `${lib?.name} › ${s.group}` : lib?.name ?? s.lib;
};

/** 목록의 '값' 칸에 한 줄로 — 그 부품의 가장 대표가 되는 속성 */
export function summary(p: LibPart): string {
  const d = defaultParams(p);
  const unit = (k: string) => p.params.find(x => x.key === k)?.unit ?? "";
  const f = (k: string) => (unit(k) ? `${d[k]} ${unit(k)}` : d[k]);
  if ("va" in d && "freq" in d) return `${f("va")} · ${f("freq")}`;
  if ("v1" in d && "v2" in d) return `${d.v1} → ${f("v2")}`;
  if ("vhigh" in d) return `${d.vlow} → ${f("vhigh")}`;
  if ("lp" in d) return `${d.lp} : ${f("ls")}`;
  if ("points" in d) return d.points;
  if ("bv" in d) return f("bv");
  if ("w" in d && "l" in d && !("model" in d)) return `W ${d.w} · L ${d.l}`;
  const first = p.params[0];
  return first ? f(first.key) : "—";
}

/** 미리보기 SPICE 줄의 노드 자리: <핀 이름> */
const nodeLabel = (lib: LibPart) => (pinId: string) =>
  `<${lib.symbol.pins.find(p => p.id === pinId)?.name ?? pinId}>`;

/** 미리보기에 쓰는 부품 하나 (원점에 그대로). 놓을 때와 같은 글자 자리를 쓴다 */
function previewPart(lib: LibPart): Part {
  return {
    id: "preview", lib: lib.id, ref: lib.refPrefix + "1", at: [0, 0], rot: 0, mirror: false, params: defaultParams(lib),
    ...(lib.textAt ? { textAt: lib.textAt } : {}),
  };
}

/**
 * 심볼을 캔버스에 맞춰 그린다. 회로도와 같은 격자 점 위에, 같은 drawPart 로.
 * 지정자·값 글자 자리(원점 위아래 16칸)까지 상자에 넣어야 글자가 잘리지 않는다.
 */
function drawSymbol(cv: HTMLCanvasElement, lib: LibPart): void {
  const w = cv.clientWidth, h = cv.clientHeight;
  if (w < 4 || h < 4) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const t = theme();

  let [x0, y0, x1, y1] = symbolBox(lib, 0, false);
  y0 = Math.min(y0, -20); y1 = Math.max(y1, 20);
  x0 = Math.min(x0, -10); x1 = Math.max(x1, 10);
  const pad = 22;
  const scale = Math.max(1.2, Math.min((w - 2 * pad) / (x1 - x0), (h - 2 * pad) / (y1 - y0), 5));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const vp: Viewport = { scale, at: [cx - w / 2 / scale, cy - h / 2 / scale] };

  // 격자 점 — 배치할 때와 같은 칸 (100 mil)
  g.fillStyle = t.grid;
  const step = 10;
  const gx0 = Math.ceil(vp.at[0] / step) * step, gy0 = Math.ceil(vp.at[1] / step) * step;
  const r = scale >= 2.4 ? 1 : 0.75;
  for (let x = gx0; x <= vp.at[0] + w / scale; x += step) {
    for (let y = gy0; y <= vp.at[1] + h / scale; y += step) {
      const s: Pt = toScreen(vp, [x, y]);
      g.fillRect(Math.round(s[0] * dpr) / dpr - r, Math.round(s[1] * dpr) / dpr - r, r * 2, r * 2);
    }
  }
  drawPart(g, vp, previewPart(lib), lib, t.part, t, false, true);
}

export function openLibrary(host: LibraryHost): void {
  if (win) { win.querySelector<HTMLInputElement>(".lw-search")?.focus(); return; }
  hostRef = host;

  const box = el("div");
  box.id = "libwin";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Component library");

  // ── 머리: 제목 · 찾기 · 닫기
  const head = el("div", "lw-head");
  const title = el("b", "", "Component library");
  const input = el("input", "lw-search");
  input.type = "search";
  input.placeholder = "Search parts — name, SPICE letter or keyword";
  input.value = memory.query;
  input.setAttribute("aria-label", "Search parts");
  input.spellcheck = false;
  const close = el("button", "btn", "Close");
  close.type = "button";
  close.onclick = () => closeLibrary();
  head.append(title, input, close);

  // ── 몸: 라이브러리 · 목록 · 정보
  const body = el("div", "lw-body");
  const tree = el("nav", "lw-tree");
  tree.setAttribute("aria-label", "Libraries");
  const list = el("div", "lw-list");
  const info = el("aside", "lw-info");
  body.append(tree, list, info);

  // ── 발: 도움말 · 놓기
  const foot = el("div", "lw-foot");
  const hint = el("p", "note", "Enter or double-click places the part · drag a row onto the canvas · ↑ ↓ to move");
  const count = el("span", "lw-count");
  const placeBtn = el("button", "btn primary", "Place");
  placeBtn.type = "button";
  foot.append(hint, count, placeBtn);

  box.append(head, body, foot);
  document.body.appendChild(box);
  win = box;

  /** 지금 목록에 보이는 부품 (순서대로). 위·아래 키가 이 안에서 움직인다 */
  let shown: Entry[] = [];

  const place = (id = memory.pick) => {
    // 목록에 보이는 것만 놓는다 — '맞는 것 없음' 일 때 Enter 가 가려진 예전 선택을 놓으면 안 된다
    if (!shown.some(e => e.id === id)) return;
    closeLibrary();
    host.place(id);
  };
  placeBtn.onclick = () => place();

  // ── 왼쪽: 라이브러리 나무
  const drawTree = () => {
    tree.innerHTML = "";
    const node = (label: string, n: number, scope: Scope, cls: string, sub = "") => {
      const b = el("button", "lw-node " + cls);
      b.type = "button";
      const name = el("span", "nm", label);
      b.append(name, el("span", "n", String(n)));
      if (sub) b.title = sub;
      const on = memory.scope.lib === scope.lib && memory.scope.group === scope.group;
      b.classList.toggle("on", on);
      b.setAttribute("aria-current", String(on));
      b.onclick = () => { memory.scope = scope; drawTree(); drawList(); };
      tree.appendChild(b);
    };
    node("All parts", ENTRIES.length, { lib: null, group: null }, "all");
    for (const lib of LIBRARIES) {
      const n = lib.groups.reduce((s, g) => s + g.parts.length, 0);
      node(lib.name, n, { lib: lib.id, group: null }, "lib", lib.blurb);
      // 칸이 하나뿐인 라이브러리는 칸을 따로 적지 않는다 (같은 것이 두 줄이 된다)
      if (lib.groups.length > 1) for (const g of lib.groups) node(g.name, g.parts.length, { lib: lib.id, group: g.name }, "grp");
    }
  };

  // ── 가운데: 부품 목록
  const drawList = () => {
    const q = input.value.trim();
    memory.query = input.value;
    const pool = inScope(memory.scope);
    shown = q ? search(q, pool) : pool;
    list.innerHTML = "";

    if (!shown.length) {
      const empty = el("div", "lw-empty");
      const everywhere = q && memory.scope.lib ? search(q, ENTRIES) : [];
      empty.textContent = `Nothing in ${scopeName(memory.scope)} matches “${q}”.`;
      if (everywhere.length) {
        const all = el("button", "btn", `Show ${everywhere.length} match${everywhere.length === 1 ? "" : "es"} in all parts`);
        all.type = "button";
        all.onclick = () => { memory.scope = { lib: null, group: null }; drawTree(); drawList(); input.focus(); };
        empty.append(el("br"), all);
      }
      list.appendChild(empty);
      count.textContent = "";
      drawInfo(null);
      return;
    }
    if (!shown.some(e => e.id === memory.pick)) memory.pick = shown[0].id;

    const table = el("table");
    const thead = el("thead");
    const hr = el("tr");
    for (const [h, cls] of [["Name", ""], ["Value", "v"], ["Ref", "ref"], ["SPICE", "el"]]) {
      const th = el("th", cls, h);
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    const tbody = el("tbody");
    // 찾는 중이 아니고 칸이 여럿이면 칸마다 머리 줄을 둔다. 찾는 중에는 맞는 순서라 칸을 이름 옆에 적는다
    const sections = !q && new Set(shown.map(e => e.lib.id + "/" + e.group.name)).size > 1;
    let last = "";
    for (const e of shown) {
      const sec = e.lib.id + "/" + e.group.name;
      if (sections && sec !== last) {
        last = sec;
        const tr = el("tr", "sec");
        const td = el("td", "", memory.scope.lib ? e.group.name : `${e.lib.name} › ${e.group.name}`);
        td.colSpan = 4;
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      const tr = el("tr", "row");
      tr.dataset.id = e.id;
      tr.draggable = true;
      tr.setAttribute("aria-selected", String(e.id === memory.pick));
      if (e.id === memory.pick) tr.classList.add("on");
      const name = el("td", "nm");
      name.append(document.createTextNode(e.part.name));
      if (q) name.append(el("span", "path", `${e.lib.name} › ${e.group.name}`));
      tr.append(name, el("td", "v", summary(e.part)), el("td", "ref", e.part.refPrefix), el("td", "el", elementLetters(e.part)));
      tr.title = ABOUT[e.id]?.text ?? "";
      tr.onclick = () => select(e.id, false);
      tr.ondblclick = () => place(e.id);
      tr.ondragstart = ev => {
        ev.dataTransfer?.setData("text/melange-lib", e.id);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
      };
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    list.appendChild(table);
    count.textContent = q ? `${shown.length} of ${pool.length}` : `${shown.length} part${shown.length === 1 ? "" : "s"}`;
    drawInfo(shown.find(e => e.id === memory.pick) ?? null);
    list.querySelector("tr.on")?.scrollIntoView({ block: "nearest" });
  };

  /** 줄 하나를 고른다. 목록 전체를 다시 짓지 않고 표시만 옮긴다 */
  const select = (id: string, scroll: boolean) => {
    memory.pick = id;
    for (const tr of list.querySelectorAll<HTMLElement>("tr.row")) {
      const on = tr.dataset.id === id;
      tr.classList.toggle("on", on);
      tr.setAttribute("aria-selected", String(on));
      if (on && scroll) tr.scrollIntoView({ block: "nearest" });
    }
    drawInfo(shown.find(e => e.id === id) ?? null);
  };

  // ── 오른쪽: 고른 부품
  let canvas: HTMLCanvasElement | null = null;
  let infoFor: Entry | null = null;
  const drawInfo = (e: Entry | null) => {
    infoFor = e;
    placeBtn.disabled = !e;
    info.innerHTML = "";
    canvas = null;
    if (!e) { info.appendChild(el("div", "lw-empty", "Pick a part to see its symbol")); return; }
    const lib = e.part;
    const about = ABOUT[e.id];

    const t = el("div", "lw-title");
    t.append(el("b", "", lib.name), el("span", "", `${e.lib.name} › ${e.group.name}`));
    info.appendChild(t);

    const sym = el("div", "lw-sym");
    canvas = el("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `Schematic symbol of the ${lib.name}`);
    sym.appendChild(canvas);
    info.appendChild(sym);

    if (about) info.appendChild(el("p", "lw-desc", about.text));

    // 속성
    info.appendChild(el("div", "lw-sec", "Properties"));
    const props = el("table", "lw-kv");
    const row = (k: string, v: string) => {
      const tr = el("tr");
      tr.append(el("th", "", k), el("td", "", v));
      props.appendChild(tr);
    };
    if (lib.spice) row("Designator", `${lib.refPrefix}1, ${lib.refPrefix}2, …`);
    for (const p of lib.params) {
      const range = p.min !== undefined && p.max !== undefined ? `  (${p.min} – ${p.max})` : "";
      row(p.label, (p.unit ? `${p.default} ${p.unit}` : p.default) + range);
    }
    if (!lib.params.length && !lib.spice) row("Net", "0 (ground)");
    info.appendChild(props);

    // 핀
    info.appendChild(el("div", "lw-sec", `Pins (${lib.symbol.pins.length})`));
    const pins = el("table", "lw-kv pins");
    for (const p of lib.symbol.pins) {
      const tr = el("tr");
      tr.append(el("th", "", p.name), el("td", "", about?.pins?.[p.id] ?? (lib.spice ? "Terminal" : "Connection")));
      pins.appendChild(tr);
    }
    info.appendChild(pins);

    // SPICE — 넷리스트와 같은 함수로
    info.appendChild(el("div", "lw-sec", "SPICE"));
    const part = previewPart(lib);
    const lines = deviceLines(part, lib, nodeLabel(lib), { kind: "tran", tstop: "1", tmax: "1", tstart: "0" });
    const model = modelLine(part, lib);
    const pre = el("pre");
    pre.textContent = lib.spice ? [...lines, ...(model ? [model] : [])].join("\n") : "(no netlist line — the net it touches becomes node 0)";
    info.appendChild(pre);
    if (lib.spice?.template.includes("{acspec}")) {
      info.appendChild(el("p", "note", "An AC analysis adds AC and the AC magnitude after the nodes. <pin> is replaced by the net on that pin."));
    } else if (lib.spice) {
      info.appendChild(el("p", "note", "<pin> is replaced by the net on that pin."));
    }

    requestAnimationFrame(() => { if (canvas && infoFor === e) drawSymbol(canvas, lib); });
  };

  // ── 키보드
  const move = (d: number) => {
    if (!shown.length) return;
    const i = shown.findIndex(e => e.id === memory.pick);
    const j = Math.max(0, Math.min(shown.length - 1, (i < 0 ? 0 : i) + d));
    select(shown[j].id, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!win) return;
    if (e.isComposing) return;
    const inside = win.contains(e.target as Node);
    if (e.key === "Escape") { closeLibrary(); }
    else if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "PageDown") move(8);
    else if (e.key === "PageUp") move(-8);
    else if (e.key === "Enter" && (!inside || e.target === input || (e.target as HTMLElement).tagName !== "BUTTON")) place();
    else {
      /*
       * 그 밖의 키는 창 뒤의 편집기로 보내지 않는다 — 나무의 단추에 초점이 있을 때 R 을 누르면
       * 사각형 도구가 켜지는 식이 된다. 글자는 찾기 칸으로 돌린다 (초점을 옮기면 그 키가 거기 찍힌다).
       */
      if (e.target !== input && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) input.focus();
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  addEventListener("keydown", onKey, true);
  undo.push(() => removeEventListener("keydown", onKey, true));

  // 창 밖을 누르면 닫는다 (다른 떠 있는 창과 같다). 캔버스로 끌어 놓는 것은 누름이 아니라 닫히지 않는다
  const onDown = (e: PointerEvent) => { if (win && !win.contains(e.target as Node)) closeLibrary(); };
  addEventListener("pointerdown", onDown, true);
  undo.push(() => removeEventListener("pointerdown", onDown, true));

  // 창 크기가 바뀌면 심볼을 다시 맞춘다
  const ro = new ResizeObserver(() => { if (canvas && infoFor) drawSymbol(canvas, infoFor.part); });
  ro.observe(info);
  undo.push(() => ro.disconnect());

  input.oninput = drawList;
  drawTree();
  drawList();
  undo.push(refract(box, { band: 26, strength: 12 }));
  input.focus();
  input.select();
}
