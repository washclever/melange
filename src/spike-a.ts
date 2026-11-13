import { fitSine, phaseDiffDeg } from "./measure.ts";
import type { SimResponse, Trace } from "./sim.worker.ts";

const NETLIST = `* RC lowpass - generated
V1 in 0 SIN(0 1 1k 0 0 0)
R1 in out 1k
C1 out 0 100n
.tran 10u 5m 0 10u
.end`;

const F = 1000, R = 1e3, C = 100e-9;
const wRC = 2 * Math.PI * F * R * C;
const EXP_AMP = 1 / Math.sqrt(1 + wRC * wRC);
const EXP_PH = (-Math.atan(wRC) * 180) / Math.PI;
const WIN = { from: 1e-3, to: 5e-3 };   // 10*tau 지나고 정확히 4주기

const $ = (id: string) => document.getElementById(id)!;
$("netlist").textContent = NETLIST;
$("winnote").textContent = `Window ${WIN.from * 1e3}–${WIN.to * 1e3} ms (4 periods)`;

const worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
const t0 = performance.now();

worker.onmessage = (e: MessageEvent<SimResponse>) => {
  const r = e.data;
  if (!r.ok) { $("status").innerHTML = `<span class="fail">Run failed</span> — ${r.error}`; return; }

  const get = (n: string) => {
    const t = r.traces!.find(x => x.name.toLowerCase() === n.toLowerCase());
    if (!t) throw new Error(`${n} missing (present: ${r.traces!.map(x => x.name).join(", ")})`);
    return t.values;
  };
  const time = get("time"), vin = get("v(in)"), vout = get("v(out)");

  const fi = fitSine(time, vin, F, WIN);
  const fo = fitSine(time, vout, F, WIN);
  const ph = phaseDiffDeg(fo.phaseDeg, fi.phaseDeg);

  $("status").innerHTML =
    `Engine init <b>${r.initMs!.toFixed(0)} ms</b> · simulation <b>${r.runMs!.toFixed(1)} ms</b> · ` +
    `First waveform in <b>${(performance.now() - t0).toFixed(0)} ms</b> · ${time.length} points · ` +
    `Runs without COOP/COEP (crossOriginIsolated=${(self as any).crossOriginIsolated})`;

  renderTable([
    row("Input amplitude", fi.amplitude, 1.0, 0.01, "V"),
    row("Output amplitude", fo.amplitude, EXP_AMP, 0.01 * EXP_AMP, "V"),
    row("Phase shift", ph, EXP_PH, 1.0, "°"),
  ]);
  draw(time, vin, vout);
};

worker.postMessage({ netlist: NETLIST });

// ── 결과 표
type Row = { name: string; got: number; exp: number; tol: number; unit: string; ok: boolean };
const row = (name: string, got: number, exp: number, tol: number, unit: string): Row =>
  ({ name, got, exp, tol, unit, ok: Math.abs(got - exp) <= tol });

function renderTable(rows: Row[]) {
  $("results").innerHTML =
    `<tr><th>Item</th><th>Measured</th><th>Expected</th><th>Error</th><th>Tol.</th><th>Verdict</th></tr>` +
    rows.map(r => {
      const d = Math.abs(r.got - r.exp);
      return `<tr><td>${r.name}</td>` +
        `<td class="v">${r.got.toFixed(4)} ${r.unit}</td>` +
        `<td class="v">${r.exp.toFixed(4)}</td>` +
        `<td class="v">${d.toExponential(2)}</td>` +
        `<td class="v">±${r.tol.toPrecision(3)}</td>` +
        `<td class="${r.ok ? "pass" : "fail"}">${r.ok ? "PASS" : "FAIL"}</td></tr>`;
    }).join("");
}

// ── 파형. 스파이크라 확대·이동은 없고, devicePixelRatio 와 반픽셀 정렬만 지킨다
function draw(t: Float64Array, a: Float64Array, b: Float64Array) {
  const cv = $("wave") as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext("2d")!;
  g.scale(dpr, dpr);

  const css = getComputedStyle(document.documentElement);
  const pad = { l: 46, r: 12, t: 12, b: 26 };
  const tMax = t[t.length - 1];
  let vMax = 0;
  for (let i = 0; i < a.length; i++) vMax = Math.max(vMax, Math.abs(a[i]), Math.abs(b[i]));
  vMax = Math.ceil(vMax * 10) / 10;

  const X = (s: number) => pad.l + (s / tMax) * (w - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v + vMax) / (2 * vMax)) * (h - pad.t - pad.b);
  const half = (n: number) => Math.round(n) + 0.5;

  g.clearRect(0, 0, w, h);

  // 격자와 축
  g.strokeStyle = css.getPropertyValue("--line").trim() || "#ddd";
  g.fillStyle = css.getPropertyValue("--mut").trim() || "#666";
  g.lineWidth = 1;
  g.font = "11px ui-monospace, Consolas, monospace";
  for (let k = -1; k <= 1; k++) {
    const v = k * vMax, y = half(Y(v));
    g.globalAlpha = k === 0 ? 1 : 0.5;
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
    g.globalAlpha = 1;
    g.textAlign = "right"; g.textBaseline = "middle";
    g.fillText(v.toFixed(1) + " V", pad.l - 7, y);
  }
  g.globalAlpha = 0.5;
  for (let ms = 0; ms <= 5; ms++) {
    const x = half(X(ms * 1e-3));
    g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, h - pad.b); g.stroke();
    g.globalAlpha = 1;
    g.textAlign = "center"; g.textBaseline = "top";
    g.fillText(ms + " ms", x, h - pad.b + 6);
    g.globalAlpha = 0.5;
  }
  g.globalAlpha = 1;

  // 측정 구간 음영
  g.fillStyle = css.getPropertyValue("--fg").trim() || "#000";
  g.globalAlpha = 0.05;
  g.fillRect(X(WIN.from), pad.t, X(WIN.to) - X(WIN.from), h - pad.t - pad.b);
  g.globalAlpha = 1;

  const trace = (y: Float64Array, color: string) => {
    g.strokeStyle = color; g.lineWidth = 1.6; g.beginPath();
    for (let i = 0; i < t.length; i++) {
      const x = X(t[i]), yy = Y(y[i]);
      i === 0 ? g.moveTo(x, yy) : g.lineTo(x, yy);
    }
    g.stroke();
  };
  trace(a, css.getPropertyValue("--in").trim() || "#2563eb");
  trace(b, css.getPropertyValue("--out").trim() || "#dc2626");
}
