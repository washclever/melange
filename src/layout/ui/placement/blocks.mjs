/** 앞단이 묶은 블록과 그 출처 (회로도) — Placement 왼쪽 패널의 "From the schematic" 칸과, 배치 전 블록 목록.
 *
 *    gloss(family)          ALIGN 원시 소자 이름 -> 짧은 설명 ("SCM_PMOS" -> "current mirror")
 *    frontBlocks(app)       맨 위 모듈의 블록들 [{ name, family, gloss, refs, variants, module, cons }]
 *    frontBlocksHtml(app)   배치 전 블록 목록 (표)
 *    sourceHtml(app)        회로도에서 읽은 것 — 이름 · 트랜지스터 수 · 핀 · 바뀐 것(notes) · 다시 읽기
 */
import { esc, icon } from "../core/dom.mjs";

// 앞에서부터 처음 맞는 것 (긴 이름이 먼저)
const GLOSS = [
  [/^DP_PAIR_/, "differential pair with load"],
  [/^DP_/, "differential pair"],
  [/^CCP_/, "cross-coupled pair"],
  [/^CASCODED_(SCM|CMC)_/, "cascode current mirror"],
  [/^CASCODED_CMB_/, "cascode mirror bank"],
  [/^SCM_/, "current mirror"],
  [/^CMB_/, "mirror bank"],
  [/^LSB_/, "mirror bank, separate sources"],
  [/^LS_/, "current mirror, separate sources"],
  [/^CMC_/, "matched pair, shared gate"],
  [/^DCL_/, "diode-connected transistor"],
  [/^DCAP_/, "MOS capacitor"],
  [/^DUMMY/, "dummy transistor"],
  [/^[NP]MOS_/, "transistor"],
  [/^INV/, "inverter"],
  [/^stage2_inv/, "two inverters"],
  [/^tgate/, "transmission gate"],
];

export function gloss(family) {
  for (const [re, g] of GLOSS) if (re.test(family)) return g;
  return "";
}

/** 블록 하나에 걸린 제약 (짧게) */
function consOf(name, constraints) {
  const out = [];
  for (const k of constraints ?? []) {
    if (k.constraint === "SymmetricBlocks") {
      const p = k.pairs.find((q) => q.includes(name));
      if (p) out.push(p.length > 1 ? `Sym ${k.direction} with ${p.find((x) => x !== name)}` : `Sym ${k.direction} (self)`);
    } else if ((k.constraint === "Order" || k.constraint === "Align") && k.instances?.includes(name)) {
      out.push(`${k.constraint} ${k.direction ?? k.line ?? ""}`.trim());
    }
  }
  return out;
}

export function frontBlocks(app) {
  const st = app.state, mods = st.blob?.topology?.modules ?? [];
  const top = mods.find((m) => m.name === st.key);
  if (!top) return [];
  const refOf = new Map(Object.entries(st.netlist?.devices ?? {}).map(([ref, dev]) => [dev, ref]));
  const prims = Object.values(st.blob.primitives ?? {});
  const modNames = new Set(mods.map((m) => m.name));
  return top.instances.map((i) => {
    const abs = i.abstract_template_name, module = modNames.has(abs);
    const family = module ? abs : abs.replace(/_\d+$/, "");
    return {
      name: i.instance_name, family, module,
      gloss: module ? "sub-circuit" : gloss(family),
      refs: app.devicesOf(i.instance_name).map((d) => refOf.get(d) ?? d),
      variants: module ? 0 : prims.filter((p) => p.abstract_template_name === abs).length,
      cons: consOf(i.instance_name, top.constraints),
    };
  });
}

export function frontBlocksHtml(app) {
  const st = app.state;
  const blocks = frontBlocks(app);
  if (!blocks.length) return `<p class="empty">${st.busy ? "Reading the schematic…" : "No blocks yet — Auto place reads the schematic and groups its transistors."}</p>`;
  const sel = st.selection?.kind === "block" ? new Set(st.selection.names) : new Set();
  const rows = blocks.map((b) => {
    const vars = b.module ? "module" : `${b.variants} variant${b.variants === 1 ? "" : "s"}`;
    const kind = `${esc(b.gloss || b.family)}<br><small>${[b.family, vars, ...b.cons].map(esc).join(" · ")}</small>`;
    return `<tr data-block="${esc(b.name)}" class="${sel.has(b.name) ? "on" : ""}" title="${esc(b.name)}: ${esc(b.refs.join(" "))}">` +
      `<td class="nm">${esc(b.name)}</td><td class="wrap">${kind}</td><td class="wrap">${esc(b.refs.join(" "))}</td></tr>`;
  }).join("");
  return `<table class="list"><thead><tr><th>Block</th><th>Kind</th><th>Parts</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function sourceHtml(app) {
  const st = app.state, nl = st.netlist;
  const row = (lab, body) => `<div class="prow"><span class="pl">${lab}</span><span class="pv">${body}</span></div>`;
  const btn = (label, title, cls = "") =>
    `<button type="button" class="pb ${cls}" data-act="rebuild"${st.busy ? " disabled" : ""} title="${title}">${icon("sync", 14)} ${label}</button>`;
  if (!st.blob || !nl) {
    return `<p class="hint">Auto place reads the schematic first: its transistors, drawn as SKY130 cells and grouped into blocks.</p>` +
      `<div class="pbtns">${btn("Read the schematic", "Group the transistors into blocks now, without placing them")}</div>`;
  }
  const stale = app.stale(), out = [];
  if (stale) out.push(`<p class="warn">The schematic changed since it was read — Auto place reads it again.</p>`);
  out.push(row("Circuit", esc(nl.top)));
  out.push(row("Transistors", `${Object.keys(nl.devices).length} in ${st.info?.blocks ?? 0} blocks`));
  out.push(row("Pins", esc(nl.ports.join(" "))));
  if (st.notes.length) out.push(`<ul class="notes">${st.notes.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`);
  out.push(`<div class="pbtns">${btn("Read again", "Rebuild the blocks from the schematic now. If the circuit changed, this clears the placement and routing.", stale ? "warn" : "")}</div>`);
  return out.join("");
}
