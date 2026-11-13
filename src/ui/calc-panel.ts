/**
 * 계산기 탭 — 실행 결과를 식으로 후처리한다.
 *
 * 왼쪽은 식의 줄들, 오른쪽은 파형으로 나온 줄들의 그림이다. 줄은 한 칸짜리 입력이고 **글자 그대로**
 * 프로젝트에 남는다 (project.calc). 고르기 목록 셋(성능지표 · 신호 · 함수)은 글자를 대신 넣어 줄 뿐,
 * 넣은 뒤에는 손으로 적은 것과 같다 — 틀을 씌운 '측정 항목' 이 아니라 고칠 수 있는 식이다.
 *
 * 줄을 고칠 때 탭을 통째로 다시 짓지 않는다. 다시 지으면 입력 칸이 새 것으로 바뀌어 초점을 잃는다
 * (측정 편집기가 같은 이유로 그렇게 한다). 줄 수가 바뀔 때만 다시 짓고, 그때는 초점을 되돌려 놓는다.
 */
import { CONSTANTS, evaluateRows, type RowResult, type RunData } from "../calc/eval.ts";
import { DEVICE_FNS } from "../calc/devices.ts";
import { exact, formatValue } from "../calc/format.ts";
import { CATEGORIES, FNS, FUNCTIONS } from "../calc/funcs.ts";
import { CHAPTERS, hints, rowFor, type Kind, type Metric, type Names } from "../calc/metrics.ts";
import { SIGNAL_FNS, parseLine } from "../calc/parse.ts";
import { magnitude } from "../calc/wave.ts";
import { mountPlot, type PlotSource, type PlotView, type Series } from "./plot.ts";

export interface CalcHost {
  /** 프로젝트의 계산기 줄. 읽기만 한다 — 고칠 때는 사본을 setRows 로 넘긴다 */
  rows(): readonly string[];
  /** 줄을 이것으로 바꾼다 — 실행 취소 단계가 되고, 다음 실행이 필요한 것을 저장하게 한다 */
  setRows(rows: string[]): void;
  run(): RunData | null;
  kept(): ReadonlyMap<string, RunData>;
  keep(name: string): void;
  drop(name: string): void;
  /** 지금 회로의 이름들 (본보기를 채우고 신호 목록을 만드는 데 쓴다) */
  names(): Names;
  simKind(): Kind;
  css(token: string): string;
  /** 이 키가 '실행' 에 묶인 키인가 (기본 F8 — 사용자가 바꿀 수 있다) */
  isRunKey(e: KeyboardEvent): boolean;
  /** 시뮬레이션을 돌린다 */
  rerun(): void;
}

const COLORS = ["--t1", "--t2", "--t3", "--t4", "--t5"];
const KIND_TAG: Record<Kind, string> = { tran: "Transient", op: "Op point", dc: "DC sweep", ac: "AC", noise: "Noise", tf: ".tf" };
const KIND_LONG: Record<string, string> = {
  tran: "transient", op: "operating point", dc: "DC sweep", ac: "AC analysis", noise: "noise analysis", tf: "transfer function",
};

// ── 상태 ──────────────────────────────────────────────────────────────
let host: CalcHost | null = null;
let mount: HTMLElement | null = null;
let results: RowResult[] = [];
let stale = true;
/** 그리지 않기로 한 줄 (번호). 파형으로 나온 줄은 기본으로 그린다 — 넣자마자 보여야 한다 */
const hidden = new Set<number>();
/** 아직 줄이 되지 않은, 맨 아래 칸에 적던 글 */
let draft = "";
let view: PlotView | null = null;
let rowEls: Array<{ input: HTMLInputElement; check: HTMLInputElement; res: HTMLElement; val: HTMLElement; det: HTMLElement }> = [];
let newInput: HTMLInputElement | null = null;
/** 고르기 목록이 글자를 넣을 칸 — 마지막으로 초점이 있던 입력 */
let target: HTMLInputElement | null = null;
/** 그리지 못한 줄기 수 (가로축이 다르거나, 단위가 셋째인 것) */
let skipped = 0;
/** 줄 번호 -> 그 줄의 선 색 */
let rowColor = new Map<number, string>();

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** 실행 결과 · 보관한 실행 · 프로젝트가 바뀌었다. 다음에 그릴 때 다시 계산한다 */
export function calcInvalidate(): void {
  stale = true;
}

/** 프로젝트를 갈아끼웠다. 줄 번호에 매인 상태를 버린다 */
export function calcReset(): void {
  hidden.clear();
  draft = "";
  stale = true;
}

function evaluate(): RowResult[] {
  if (stale && host) {
    results = evaluateRows(host.rows(), host.run(), host.kept());
    stale = false;
  }
  return results;
}

/** 줄의 결과만 (테스트 · 다른 탭이 쓴다) */
export function calcResults(h: CalcHost): RowResult[] {
  host = h;
  return evaluate();
}

// ── 그림 ──────────────────────────────────────────────────────────────
const plotSrc: PlotSource = {
  logX: null, logY: null,
  auto: { logX: false, logY: false },
  empty: "",
  xunit: () => firstWave()?.xunit ?? "",
  css: t => host?.css(t) ?? "",
  note: () => (skipped ? `${skipped} more with another x axis or a third unit — untick rows to see ${skipped === 1 ? "it" : "them"}` : ""),
  series(): Series[] {
    const out: Series[] = [];
    rowColor = new Map();
    skipped = 0;
    const first = firstWave();
    if (!first || !host) return out;
    // AC · 잡음의 주파수 축은 로그가 자연스럽다. fft 의 스펙트럼은 0 Hz 부터라 선형으로 시작한다
    this.auto.logX = first.axis === "frequency";
    this.auto.logY = /√Hz|²\/Hz/.test(first.unit);
    /*
     * 세로축은 둘까지다: 첫 줄기의 단위가 왼쪽, 그다음에 처음 나오는 다른 단위가 오른쪽 (이득 dB 와
     * 위상 ° 의 보드 선도). 셋째 단위부터는 그리지 않는다 — 한 축에 올리면 큰 쪽만 보이고 나머지는
     * 바닥에 붙는다.
     */
    let rightUnit: string | null = null;
    results.forEach((r, i) => {
      const w = r.value;
      if (w?.t !== "wave" || hidden.has(i)) return;
      if (w.axis !== first.axis || w.xunit !== first.xunit) { skipped++; return; }
      if (w.unit !== first.unit) {
        rightUnit ??= w.unit;
        if (w.unit !== rightUnit) { skipped++; return; }
      }
      const color = host!.css(COLORS[out.length % COLORS.length]);
      rowColor.set(i, color);
      out.push({
        name: label(r) + (w.im ? " (magnitude)" : ""), color,
        x: w.x, y: w.im ? magnitude(w) : w.re, points: w.discrete, unit: w.unit,
        ...(w.unit !== first.unit ? { right: true } : {}),
      });
    });
    return out;
  },
};

/** 그릴 첫 파형. 가로축은 이것이 정한다 */
function firstWave() {
  for (let i = 0; i < results.length; i++) {
    const v = results[i].value;
    if (v?.t === "wave" && !hidden.has(i)) return v;
  }
  return null;
}

/** 범례에 적을 이름: 붙인 이름이 있으면 그것, 없으면 식 */
function label(r: RowResult): string {
  if (r.name) return r.name;
  const s = r.src.replace(/#.*$/, "").trim();
  return s.length > 34 ? s.slice(0, 33) + "…" : s;
}

// ── 줄 ────────────────────────────────────────────────────────────────
function paint(): void {
  const rs = evaluate();
  rowEls.forEach((e, i) => {
    const r = rs[i];
    e.val.className = "val";
    e.val.textContent = "";
    e.det.textContent = "";
    e.res.title = "";
    e.check.disabled = true;
    e.check.checked = false;
    e.check.style.accentColor = "";
    if (!r || r.blank) return;
    const warn = r.warnings.join(" · ");
    if (r.error) {
      // 실행 전에는 모든 줄이 '먼저 실행하라' 다. 오류처럼 칠하면 화면이 온통 경고다
      e.val.className = host?.run() ? "val err" : "val wave";
      e.val.textContent = r.error;
      e.res.title = r.error;
      return;
    }
    const v = r.value!;
    e.val.textContent = formatValue(v);
    if (v.t === "num") {
      e.det.textContent = [v.note, warn].filter(Boolean).join(" · ");
      e.res.title = [exact(v), v.note, warn].filter(Boolean).join("\n");
    } else if (v.t === "wave") {
      e.val.className = "val wave";
      e.det.textContent = warn;
      e.check.disabled = false;
      e.check.checked = !hidden.has(i);
      e.res.title = "Tick the box on the left to plot it";
    }
  });
  const plot = mount?.querySelector<HTMLElement>("#calc-plot");
  const any = rs.some(r => r.value?.t === "wave");
  if (plot) plot.style.display = any ? "" : "none";
  view?.redraw();
  // 체크 상자를 그 줄의 선 색으로 — 어느 줄이 어느 선인지 범례를 안 읽어도 보인다
  rowEls.forEach((e, i) => { e.check.style.accentColor = rowColor.get(i) ?? ""; });
}

/** 줄 i 를 text 로. 줄 수가 바뀌면(비워서 지웠다) 참 */
function commit(i: number, text: string): boolean {
  if (!host) return false;
  // 사본을 고쳐서 넘긴다. 앱은 바뀌기 전 값과 바뀐 값으로 실행 취소 단계를 만든다 (setCalc)
  const rows = [...host.rows()];
  if (text === rows[i]) return false;
  if (!text.trim()) { remove(i); return true; }
  rows[i] = text;
  host.setRows(rows);
  stale = true;
  paint();
  return false;
}

function remove(i: number): void {
  if (!host) return;
  const rows = [...host.rows()];
  rows.splice(i, 1);
  // 그리지 않기로 한 줄 번호를 한 칸씩 당긴다
  const next = new Set<number>();
  for (const h of hidden) if (h !== i) next.add(h > i ? h - 1 : h);
  hidden.clear();
  for (const h of next) hidden.add(h);
  host.setRows(rows);
  stale = true;
  rebuild(Math.min(i, rows.length));
}

/**
 * 줄을 하나 보탠다. 직접 적어 넣었으면 다음 줄을 이어 적게 맨 아래 칸에 초점을 두고(onward),
 * 본보기를 골라 넣었으면 그 줄에 둔다 — 넷 이름이나 구간을 고치기 좋게.
 */
function add(text: string, onward = true): void {
  if (!host || !text.trim()) return;
  const rows = [...host.rows()];
  rows.push(text.trim());
  host.setRows(rows);
  stale = true;
  rebuild(onward ? rows.length : rows.length - 1);
}

/** 탭을 다시 짓고 줄 i 에 초점을 준다 (i 가 줄 수와 같으면 새 줄 칸) */
function rebuild(focus?: number): void {
  if (!mount || !host) return;
  renderCalc(mount, host);
  if (focus !== undefined) focusRow(focus);
}

function focusRow(i: number): void {
  const inp = i >= rowEls.length ? newInput : rowEls[Math.max(0, i)]?.input;
  if (!inp) return;
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
  inp.scrollIntoView({ block: "nearest" });
}

/** 고르기 목록이 고른 글자를 커서 자리에 넣는다 */
function insert(text: string): void {
  const inp = target && target.isConnected ? target : newInput;
  if (!inp) return;
  const a = inp.selectionStart ?? inp.value.length, b = inp.selectionEnd ?? a;
  inp.value = inp.value.slice(0, a) + text + inp.value.slice(b);
  if (inp === newInput) draft = inp.value;
  inp.focus();
  // 함수는 괄호 안에 커서를 둔다: db20(|)
  const caret = a + (text.endsWith("()") ? text.length - 1 : text.length);
  inp.setSelectionRange(caret, caret);
}

// ── 그리기 ────────────────────────────────────────────────────────────
export function renderCalc(body: HTMLElement, h: CalcHost): void {
  host = h;
  mount = body;
  closePop();
  view?.destroy();
  view = null;
  body.innerHTML = "";
  const rows = h.rows();
  for (const i of [...hidden]) if (i >= rows.length) hidden.delete(i);

  const root = el("div");
  root.id = "calc";
  const main = el("div");
  main.id = "calc-main";

  // 위 줄: 고르기 목록 셋, 실행 보관
  const bar = el("div", "calc-bar");
  const mk = (text: string, title: string, open: (b: HTMLElement) => void) => {
    const b = el("button", "btn", text);
    b.type = "button";
    b.title = title;
    // mousedown 에서 막아야 입력 칸이 초점을 잃지 않는다 — 고른 글자가 들어갈 자리를 기억해야 한다
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => open(b);
    bar.appendChild(b);
    return b;
  };
  mk("Metrics", "Performance metrics by textbook chapter — each one is an expression you can edit", openMetrics);
  mk("Signals", "Nets, currents and device values of this circuit", openSignals);
  mk("Functions", "Everything the calculator can compute", openFunctions);
  bar.appendChild(el("span", "sp"));
  const run = h.run();
  const keep = mk("Keep run…", "Name the last run so later expressions can read it — dm.v(out). For metrics that take two runs: CMRR, PSRR, VCO gain", () => {
    const name = prompt(
      "Name for the last run (letters, digits, underscore).\n\nExpressions then read it as name.v(out), name.gm(M1), …",
      suggestKeep(h),
    );
    if (name === null) return;
    const bad = keepNameError(name.trim());
    if (bad) { alert(bad); return; }
    h.keep(name.trim().toLowerCase());
    stale = true;
    rebuild();
  });
  keep.disabled = !run;
  for (const [name, r] of h.kept()) {
    const chip = el("span", "chip", name);
    chip.title = `${KIND_LONG[r.kind] ?? r.kind} · ${r.vec.size} vectors — read it as ${name}.v(net)`;
    const x = el("button", "", "×");
    x.type = "button";
    x.title = "Forget this run";
    x.onclick = () => { h.drop(name); stale = true; rebuild(); };
    chip.appendChild(x);
    bar.appendChild(chip);
  }
  main.appendChild(bar);

  // 줄들
  const box = el("div", "calc-rows");
  rowEls = [];
  rows.forEach((text, i) => {
    const row = el("div", "calc-row");
    const check = el("input");
    check.type = "checkbox";
    check.title = "Plot this waveform";
    check.onchange = () => {
      if (check.checked) hidden.delete(i); else hidden.add(i);
      paint();
    };
    const inp = el("input", "expr");
    inp.value = text;
    inp.spellcheck = false;
    inp.autocomplete = "off";
    inp.autocapitalize = "off";
    inp.onfocus = () => { target = inp; };
    inp.onblur = () => { if (inp.isConnected && inp.value !== h.rows()[i]) commit(i, inp.value); };
    inp.onkeydown = e => {
      /*
       * 실행 키(F8)는 입력 칸 안에서도 듣는다. 앱의 단축키는 글자를 적는 중에는 꺼져 있어서, 그대로 두면
       * 식을 고치고 다시 돌리려 할 때마다 칸 밖을 한 번 눌러야 한다. 적던 것을 먼저 줄로 만든다 —
       * 그 줄이 읽는 소자 값을 이번 실행이 저장해야 한다.
       */
      if (h.isRunKey(e)) { e.preventDefault(); commit(i, inp.value); h.rerun(); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        if (!commit(i, inp.value)) focusRow(i + 1);
      } else if (e.key === "ArrowDown") { e.preventDefault(); focusRow(i + 1); }
      else if (e.key === "ArrowUp" && i > 0) { e.preventDefault(); focusRow(i - 1); }
      else if (e.key === "Escape") { inp.value = h.rows()[i]; inp.blur(); }
    };
    const res = el("div", "res");
    const val = el("span", "val"), det = el("span", "det");
    res.append(val, det);
    const del = el("button", "btn del", "×");
    del.type = "button";
    del.title = "Remove this row";
    del.onclick = () => remove(i);
    row.append(check, inp, res, del);
    box.appendChild(row);
    rowEls.push({ input: inp, check, res, val, det });
  });

  // 새 줄
  const row = el("div", "calc-row new");
  const plus = el("span", "plus", "+");
  newInput = el("input", "expr");
  newInput.value = draft;
  newInput.spellcheck = false;
  newInput.autocomplete = "off";
  newInput.autocapitalize = "off";
  newInput.placeholder = rows.length
    ? "Add an expression — Enter"
    : "Type an expression and press Enter — db20(v(out)/v(in)) · gm(M1)/id(M1) · thd(v(out))";
  const ni = newInput;
  ni.oninput = () => { draft = ni.value; };
  ni.onfocus = () => { target = ni; };
  ni.onkeydown = e => {
    if (h.isRunKey(e)) {
      e.preventDefault();
      const text = ni.value;
      draft = "";
      if (text.trim()) add(text);
      h.rerun();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const text = ni.value;
      draft = "";
      add(text);
    } else if (e.key === "ArrowUp" && rowEls.length) { e.preventDefault(); focusRow(rowEls.length - 1); }
  };
  const hint = el("div", "res");
  const hv = el("span", "val wave");
  hv.textContent = !run ? "Run (F8) and the results show up here"
    : rows.length ? "" : `Last run: ${KIND_LONG[run.kind] ?? run.kind} · pick from Metrics, or type`;
  hint.appendChild(hv);
  row.append(plus, ni, hint);
  box.appendChild(row);
  main.appendChild(box);

  const plot = el("div");
  plot.id = "calc-plot";
  root.append(main, plot);
  body.appendChild(root);

  evaluate();
  view = mountPlot(plot, plotSrc);
  paint();
}

/** 보관 이름의 본보기: dm · cm 처럼 본보기 식이 쓰는 이름 가운데 아직 없는 것, 다 있으면 run1 … */
function suggestKeep(h: CalcHost): string {
  const used = new Set(h.kept().keys());
  const wanted = new Set<string>();
  for (const src of h.rows()) for (const m of src.matchAll(/\b([A-Za-z_]\w*)\.(?=[A-Za-z_@])/g)) wanted.add(m[1].toLowerCase());
  for (const w of wanted) if (!used.has(w)) return w;
  for (let i = 1; ; i++) if (!used.has("run" + i)) return "run" + i;
}

function keepNameError(name: string): string | null {
  if (!/^[A-Za-z_]\w*$/.test(name)) return "Use a name that starts with a letter: letters, digits and underscore only.";
  const k = name.toLowerCase();
  if (FNS.has(k) || SIGNAL_FNS.has(k) || k in DEVICE_FNS || k in CONSTANTS || k === "op" || k === "vec") {
    return `"${name}" is already the name of a function or a constant — pick another.`;
  }
  return null;
}

// ── 고르기 목록 ───────────────────────────────────────────────────────
interface Item {
  title: string;
  /** 넣을 글자 (제목 옆에 고정폭으로 보인다) */
  code: string;
  doc?: string;
  tag?: string;
  dim?: boolean;
  pick(): void;
}
interface Group { title: string; sub?: string; items: Item[] }

let pop: HTMLElement | null = null;
let popCleanup: (() => void) | null = null;

export function closePop(): void {
  pop?.remove();
  pop = null;
  popCleanup?.();
  popCleanup = null;
}

/** 넘치면 다 그리지 않는다. 소자가 수백 개인 회로의 신호 목록이 그렇다 — 찾기 칸으로 좁힌다 */
const MAX_ITEMS = 250;

function openPop(anchor: HTMLElement, placeholder: string, groups: Group[]): void {
  closePop();
  const box = el("div");
  box.id = "calcpop";
  const search = el("input");
  search.placeholder = placeholder;
  search.spellcheck = false;
  search.autocomplete = "off";
  const list = el("div", "plist");
  box.append(search, list);
  let shown: Array<{ item: Item; node: HTMLElement }> = [];
  let cursor = 0;

  const mark = () => shown.forEach((s, i) => s.node.classList.toggle("on", i === cursor));
  const fill = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    list.innerHTML = "";
    shown = [];
    let hiddenCount = 0;
    for (const g of groups) {
      const hits = g.items.filter(it => {
        const hay = (g.title + " " + it.title + " " + it.code + " " + (it.doc ?? "") + " " + (it.tag ?? "")).toLowerCase();
        return words.every(w => hay.includes(w));
      });
      if (!hits.length) continue;
      const head = el("div", "phead", g.title);
      if (g.sub) head.appendChild(el("small", "", g.sub));
      list.appendChild(head);
      for (const it of hits) {
        if (shown.length >= MAX_ITEMS) { hiddenCount++; continue; }
        const b = el("button", "pitem" + (it.dim ? " dim" : ""));
        b.type = "button";
        const top = el("div", "top");
        const left = el("span");
        if (it.title) left.appendChild(el("b", "", it.title + "  "));
        left.appendChild(el("code", "", it.code));
        top.appendChild(left);
        if (it.tag) top.appendChild(el("span", "tag", it.tag));
        b.appendChild(top);
        if (it.doc) b.appendChild(el("div", "doc", it.doc));
        b.onmousedown = e => e.preventDefault();
        b.onclick = () => { closePop(); it.pick(); };
        list.appendChild(b);
        shown.push({ item: it, node: b });
      }
    }
    if (!shown.length) list.appendChild(el("div", "phead", "Nothing matches"));
    if (hiddenCount) list.appendChild(el("div", "phead", `${hiddenCount} more — type to narrow`));
    cursor = 0;
    mark();
  };
  search.oninput = fill;
  search.onkeydown = e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      cursor = (cursor + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
      mark();
      shown[cursor].node.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = shown[cursor]?.item;
      if (it) { closePop(); it.pick(); }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePop();
    }
  };
  document.body.appendChild(box);
  // 아래 패널은 화면 바닥에 있다. 위로 연다 — 자리가 모자라면 높이를 줄인다
  const r = anchor.getBoundingClientRect();
  const room = Math.max(160, r.top - 12);
  box.style.maxHeight = Math.min(460, room) + "px";
  box.style.left = Math.max(8, Math.min(r.left, innerWidth - box.offsetWidth - 8)) + "px";
  box.style.bottom = Math.max(8, innerHeight - r.top + 6) + "px";
  fill();
  pop = box;
  const outside = (e: PointerEvent) => { if (pop && !pop.contains(e.target as Node) && e.target !== anchor) closePop(); };
  addEventListener("pointerdown", outside, true);
  popCleanup = () => removeEventListener("pointerdown", outside, true);
  // 손가락으로 쓰는 화면에서는 자판이 목록을 덮는다. 찾기 칸에 초점을 주지 않는다
  if (!matchMedia("(pointer: coarse)").matches) search.focus();
}

function openMetrics(anchor: HTMLElement): void {
  if (!host) return;
  const h = host;
  const kind = h.simKind();
  const hs = hints(h.names());
  // 이미 쓰인 이름. 같은 본보기를 두 번 넣으면 a0, a0_2 … 가 된다
  const taken = new Set(h.rows().map(r => parseLine(r).name).filter((n): n is string => !!n));
  const groups: Group[] = CHAPTERS.map(c => ({
    title: c.title,
    sub: c.ref,
    items: c.metrics.map((m: Metric): Item => {
      const fits = !m.needs.length || m.needs.includes(kind);
      const tags = m.needs.length === 4 && m.needs.includes("op") ? "any run" : m.needs.map(k => KIND_TAG[k]).join(" · ");
      const line = rowFor(m, hs, new Set());
      return {
        title: m.title,
        code: line.slice(line.indexOf("=") + 2),
        doc: m.doc + (fits ? "" : ` — needs ${tags}; the analysis is set to ${KIND_TAG[kind]}.`),
        tag: tags || "no run",
        dim: !fits,
        pick: () => add(rowFor(m, hs, taken), false),
      };
    }),
  }));
  openPop(anchor, "Search metrics — gain, noise, phase margin, THD …", groups);
}

/** 소자 종류마다 신호 목록에 올릴 함수 (자주 쓰는 순서) */
const DEV_PICKS = {
  mos: ["gm", "gds", "ro", "id", "vgs", "vds", "vth", "vov", "vdsat", "satmargin", "gmid", "gmro", "ft", "cgg"],
  bjt: ["gm", "ic", "ib", "beta", "rpi", "ro", "vbe", "vce", "ft"],
  diode: ["id", "vd", "gd"],
} as const;

function openSignals(anchor: HTMLElement): void {
  if (!host) return;
  const n = host.names();
  const run = host.run();
  const put = (code: string, title = "", doc = ""): Item => ({ title, code, doc, pick: () => insert(code) });
  const groups: Group[] = [];
  if (run?.kind === "noise") {
    groups.push({ title: "Noise analysis", items: [
      put("onoise", "Output noise density", "V/√Hz, from the last run"),
      put("inoise", "Input-referred noise density", "The output noise divided by the gain from the input source"),
    ] });
  }
  if (run?.kind === "tf") {
    groups.push({ title: "Transfer function", items: [
      put("tf_gain", "Gain"), put("tf_rin", "Input resistance"), put("tf_rout", "Output resistance"),
    ] });
  }
  const nets = n.nets.filter(x => x !== "0");
  if (nets.length) groups.push({ title: "Node voltages", sub: "v(a,b) is the difference", items: nets.map(x => put(`v(${x})`)) });
  const cur = [...n.vsrc.map(v => v.name), ...(n.currents ?? [])];
  if (cur.length) groups.push({ title: "Currents", sub: "into the + pin of a source", items: cur.map(x => put(`i(${x})`)) });
  const devs: Array<[string, readonly string[], readonly string[]]> = [
    ["MOSFET", n.mos, DEV_PICKS.mos], ["BJT", n.bjt, DEV_PICKS.bjt], ["Diode", n.diodes ?? [], DEV_PICKS.diode],
  ];
  for (const [word, list, fns] of devs) {
    for (const d of list) {
      groups.push({ title: `${word} ${d}`, items: fns.map(f => put(`${f}(${d})`, "", DEVICE_FNS[f].doc)) });
    }
  }
  if (run?.x) {
    const ax = run.axis === "time" ? "time" : run.axis === "frequency" ? "frequency" : "sweep";
    groups.push({ title: "Axis", items: [put(ax, "", "The x axis of the last run, as a waveform")] });
  }
  if (run?.measures.size) {
    groups.push({ title: "Measurements (.meas)", items: [...run.measures.keys()].map(m => put(m)) });
  }
  const kept = [...host.kept().keys()];
  if (kept.length) {
    groups.push({ title: "Kept runs", sub: "prefix a signal: dm.v(out)", items: kept.map(k => put(k + ".", "", "Then a signal — v(net), i(name), gm(M1) …")) });
  }
  groups.push({ title: "Constants", items: Object.entries(CONSTANTS).map(([k, c]) => put(k, "", c.doc)) });
  openPop(anchor, "Search signals — a net, a part, gm …", groups);
}

/** 문법으로 받는 것들 (함수 표에 없다 — 파서가 직접 읽는다) */
const SYNTAX: Array<[string, string]> = [
  ["v(net)", "Voltage of a net. v(a,b) is v(a) − v(b)"],
  ["i(name)", "Current through a source, inductor, resistor, capacitor — or the drain / collector current of a transistor"],
  ["vdb(net)", "20·log10|v(net)|. Also vm (magnitude), vp (phase), vr and vi (real, imaginary) — and idb, im, ip, ir, ii"],
  ["@m1[gm]", "A device parameter by ngspice's own name. op(M1, cgg) does the same from the part's designator"],
  ["name.v(net)", "A signal from a kept run (Keep run…)"],
  ['vec("name")', "Any vector of the last run by its engine name"],
];

function openFunctions(anchor: HTMLElement): void {
  const fn = (name: string, sig: string, doc: string): Item => ({ title: "", code: `${name}(${sig})`, doc, pick: () => insert(name + "()") });
  const groups: Group[] = CATEGORIES.map(c => ({
    title: c,
    items: c === "Signals" ? SYNTAX.map(([code, doc]): Item => ({ title: "", code, doc, pick: () => insert(code.replace(/net|name|"name"/, "")) }))
      : c === "Device" ? [
        ...Object.entries(DEVICE_FNS).map(([name, f]) => fn(name, "part", f.doc)),
        fn("op", "part, parameter", "Any operating-point parameter ngspice has for that part"),
      ]
      : FUNCTIONS.filter(f => f.cat === c).map(f => fn(f.name, f.sig, f.doc)),
  }));
  openPop(anchor, "Search functions — fft, mean, settling, pm …", groups);
}

// ── 도움말 ────────────────────────────────────────────────────────────
/** 도움말 창의 내용. 함수 표는 계산기가 쓰는 바로 그 표에서 만든다 */
export function buildCalcHelp(body: HTMLElement): void {
  const p = (text: string) => { const e = el("p", "", text); e.style.margin = "0 0 10px"; e.style.lineHeight = "1.55"; body.appendChild(e); };
  const table = (title: string, rows: Array<[string, string]>) => {
    const h = el("div", "lw-sec", title);
    body.appendChild(h);
    const t = el("table", "help");
    for (const [a, b] of rows) {
      const tr = el("tr");
      const th = el("th");
      const code = el("code", "", a);
      code.style.font = "11.5px var(--mono)";
      th.appendChild(code);
      tr.append(th, el("td", "", b));
      t.appendChild(tr);
    }
    body.appendChild(t);
  };
  p("The Calculator tab post-processes the last run. Each row is one expression; a row that starts with a name " +
    "(a0 = …) can be used by the rows below it. Rows whose result is a waveform are plotted on the right.");
  p("Rows are kept with the project. Device values such as gm(M1) are not saved by ngspice unless asked, " +
    "so a new device expression shows its value after the next run.");
  table("Writing expressions", [
    ["10k  2.2meg  5m  1u  3n  1p", "Numbers take SPICE suffixes; M is milli, meg is mega"],
    ["1kohm  100nF  10mH  1kHz  5V  1mA  1mS",
      "A unit after a number goes with it: 1/(2*pi*1kohm*100nF) is in Hz. S is siemens, s seconds; 1F is 1 femto, as in SPICE. " +
      "A number without a unit is a pure number, and a unit the calculator cannot work out is left blank"],
    ["+  −  *  /  ^", "Arithmetic on numbers and waveforms, real or complex. Two waveforms on different grids are interpolated"],
    ["name = expr", "Name a result and use it in the rows below"],
    ["# text", "A comment"],
    ...SYNTAX,
    ["time  frequency  sweep", "The x axis of the last run"],
    ["onoise  inoise", "Noise densities of a noise analysis (V/√Hz)"],
    ["tf_gain  tf_rin  tf_rout", "The three results of a transfer-function analysis"],
    ...Object.entries(CONSTANTS).map(([k, c]): [string, string] => [k, c.doc]),
  ]);
  for (const c of CATEGORIES) {
    if (c === "Signals") continue;
    if (c === "Device") {
      table("Device values — gm(M1), by the part's designator", [
        ...Object.entries(DEVICE_FNS).map(([name, f]): [string, string] => [`${name}(part)`, f.doc]),
        ["op(part, parameter)", "Any operating-point parameter ngspice has for that part"],
      ]);
      continue;
    }
    table(c, FUNCTIONS.filter(f => f.cat === c).map((f): [string, string] => [`${f.name}(${f.sig})`, f.doc]));
  }
}
