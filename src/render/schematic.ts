/**
 * 회로도 렌더러. 캔버스 두 장을 쓴다.
 *   - 정적 층: 문서가 바뀔 때만 다시 그린다 (격자 · 배선 · 부품 · 접합점 · 라벨)
 *   - 오버레이 층: 커서가 움직일 때만 (호버 · 선택 · 스냅 · 미리보기)
 * 나누지 않으면 커서를 움직일 때마다 회로 전체를 다시 그리게 된다.
 */
import {
  DEFAULT_TEXT_AT, pinAt, transform,
  type LibPart, type NetLabel, type Note, type Part, type Probe, type Pt, type SpiceBlock, type Wire,
} from "../doc/types.ts";
import { toScreen, type Viewport } from "../feel/viewport.ts";

export interface Theme {
  grid: string; gridBold: string; axis: string; wire: string; part: string; pin: string;
  text: string; muted: string; select: string; junction: string; label: string;
  loose: string; highlight: string; connect: string; bad: string;
}

export const css = (n: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export const theme = (): Theme => ({
  grid: css("--grid"), gridBold: css("--grid-bold"),
  axis: css("--axis"), wire: css("--wire"), part: css("--part"),
  pin: css("--pin"), text: css("--fg"), muted: css("--mut"), select: css("--select"),
  junction: css("--junction"), label: css("--label"),
  loose: css("--loose"), highlight: css("--highlight"), connect: css("--connect"),
  bad: css("--bad"),
});

/** 1 px 선을 픽셀 경계 사이에 놓아 흐려지지 않게 한다 */
const half = (n: number) => Math.round(n) + 0.5;

/** 선 두께는 배율에 따라 조금만 굵어진다. 월드 단위로 두면 확대할 때 뭉개진다 */
const lw = (vp: Viewport, base: number) => Math.max(base, base * Math.min(vp.scale / 2, 2));

/** 부품 심볼. 회전·대칭은 점마다 transform 을 적용해 핀 좌표 계산과 어긋나지 않게 한다 */
export function drawPart(
  g: CanvasRenderingContext2D, vp: Viewport, part: Part, lib: LibPart, color: string, t: Theme,
  /** 지정자가 겹쳤는가 (설계서 E18: 중복이면 빨간 표시) */
  badRef = false,
  /** 핀 이름을 같이 그릴지 */
  showPins = false,
) {
  const T = (p: Pt): Pt => {
    const v = transform(p, part.rot, part.mirror);
    return toScreen(vp, [part.at[0] + v[0], part.at[1] + v[1]]);
  };
  g.strokeStyle = color;
  g.lineWidth = lw(vp, 1.3);
  g.lineCap = "round";
  g.lineJoin = "round";
  g.beginPath();
  for (const s of lib.symbol.graphics) {
    if ("line" in s) {
      const a = T(s.line[0]), b = T(s.line[1]);
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
    } else if ("poly" in s) {
      s.poly.forEach((p, i) => { const q = T(p); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); });
    } else if ("rect" in s) {
      const [x, y, w, h] = s.rect;
      const pts: Pt[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      pts.forEach((p, i) => { const q = T(p); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); });
      g.closePath();
    } else {
      const c = T(s.circle.c), r = s.circle.r * vp.scale;
      g.moveTo(c[0] + r, c[1]);                 // arc 앞에 선이 끌려오지 않게
      g.arc(c[0], c[1], r, 0, Math.PI * 2);
    }
  }
  g.stroke();

  // 핀 점
  g.fillStyle = t.pin;
  lib.symbol.pins.forEach((_, i) => {
    const s = toScreen(vp, pinAt(part, lib, i));
    g.beginPath();
    g.arc(s[0], s[1], Math.max(1.5, lw(vp, 1.6)), 0, Math.PI * 2);
    g.fill();
  });

  // 미연결 표시 (E05): 핀 끝에 X 를 그린다
  if (part.nc?.length) {
    g.strokeStyle = t.junction;
    g.lineWidth = lw(vp, 1.4);
    for (const pinId of part.nc) {
      const i = lib.symbol.pins.findIndex(p => p.id === pinId);
      if (i < 0) continue;
      const s = toScreen(vp, pinAt(part, lib, i));
      const r = Math.max(3, 3 * Math.min(vp.scale / 2, 2));
      g.beginPath();
      g.moveTo(s[0] - r, s[1] - r); g.lineTo(s[0] + r, s[1] + r);
      g.moveTo(s[0] + r, s[1] - r); g.lineTo(s[0] - r, s[1] + r);
      g.stroke();
    }
  }

  drawPartText(g, vp, part, lib, t, badRef, showPins);
}

/**
 * 부품의 글자 — 핀 이름, 지정자, 값. 도형은 GPU 가 그리고(src/render/scene.ts) 글자는
 * 글자 층(Canvas 2D)이 화면에 보이는 부품만 골라 그린다. 선택 강조(오버레이)는 drawPart 로
 * 도형과 글자를 같이 그린다.
 */
export function drawPartText(
  g: CanvasRenderingContext2D, vp: Viewport, part: Part, lib: LibPart, t: Theme,
  badRef = false, showPins = false,
) {
  /*
   * 핀 이름. **숫자만인 이름은 건너뛴다** — 저항의 1·2 는 적어 봐야 아무 말도 안 하면서
   * 그림만 어지럽힌다. 뜻이 있는 것은 트랜지스터의 B·C·E, MOS 의 D·G·S, op-amp 의 +·− 다.
   *
   * 자리는 핀에서 **안쪽으로 들이고 옆으로 비킨 곳**이다. 핀 바로 위에 적으면 리드선과
   * 겹치고, 바깥에 적으면 옆 부품과 부딪힌다. 글자 자체는 돌리지 않는다 — 부품을 뒤집어도
   * 이름은 똑바로 읽혀야 한다.
   */
  if (showPins && vp.scale > 0.6) {
    /*
     * 크기에 **바닥**을 둔다. 예전에는 4.3 × 배율이라, 보이기 시작하는 문턱에서 6px 이었다
     * — 나타나는 순간부터 이미 못 읽는 크기였고, 그래서 폰에서 전체 맞춤을 하면
     * (배율 ≈ 1.0) 핀 이름이 아예 없는 것처럼 보였다.
     */
    const size = Math.max(9, Math.min(11, 4.6 * vp.scale));
    g.font = size + "px ui-sans-serif, system-ui";
    g.textAlign = "center";
    g.textBaseline = "middle";
    // 핀 점 색(--pin)은 글자로 쓰기엔 어둡다. 값 글자와 같은 --mut 를 쓴다
    g.fillStyle = t.muted;
    /*
     * 비키는 거리도 **화면 기준**이다. 월드 좌표로 밀면 축소할 때 글자만 그대로인데
     * 거리는 같이 줄어 리드선 위에 올라앉는다. 방향은 핀에서 부품 원점 쪽으로 — 화면
     * 좌표에서 구하므로 회전·대칭이 저절로 따라온다.
     */
    const o = toScreen(vp, part.at);
    for (const pin of lib.symbol.pins) {
      if (!pin.name || pin.hideName || /^\d+$/.test(pin.name)) continue;
      const v = transform(pin.at, part.rot, part.mirror);
      const s = toScreen(vp, [part.at[0] + v[0], part.at[1] + v[1]]);
      const dx = o[0] - s[0], dy = o[1] - s[1];
      const len = Math.hypot(dx, dy);
      if (!len) continue;                       // 원점에 있는 핀(접지)은 비킬 방향이 없다
      const ux = dx / len, uy = dy / len;
      /*
       * 비키는 거리는 **화면 기준과 월드 기준 중 큰 쪽**이다.
       *
       * 화면 기준만 쓰면 확대했을 때 글자가 핀에 붙어 **지정자와 겹친다** (지정자는
       * 월드 16칸 자리에 있으니 확대하면 멀어지는데, 핀 이름만 제자리에 남는다).
       * 월드 기준만 쓰면 축소했을 때 리드선 위에 올라앉는다. 둘 다 피하려면 큰 쪽이다.
       */
      const inPx = Math.max(size * 0.95, 8 * vp.scale);
      const sidePx = Math.max(size * 0.75, 6 * vp.scale);
      g.fillText(pin.name, s[0] + ux * inPx - uy * sidePx, s[1] + uy * inPx + ux * sidePx);
    }
  }

  // 지정자와 값. 위치는 부품마다 정할 수 있다 (E17)
  /*
   * 지정자와 값도 같은 함정에 걸려 있었다 — 문턱 1.1 에서 크기가 6px 이고, 폰에서
   * 전체 맞춤이면 배율이 1.0 쯤이라 **R1·C1 이 통째로 안 보였다.** 자리는 월드 좌표라
   * (E17 의 '글자 위치') 문턱을 너무 낮추면 심볼 위로 올라앉으므로 0.9 까지만 내린다.
   */
  if (vp.scale > 0.9 && lib.id !== "gnd") {
    const slot = part.textAt ?? DEFAULT_TEXT_AT;
    const size = Math.max(10, Math.min(13, 5.5 * vp.scale));
    g.font = size + "px ui-sans-serif, system-ui";
    g.textAlign = "center";
    g.textBaseline = "middle";

    const refAt = toScreen(vp, [part.at[0] + slot.ref[0], part.at[1] + slot.ref[1]]);
    g.fillStyle = badRef ? t.bad : t.text;
    g.fillText(part.ref, refAt[0], refAt[1]);

    const v = part.params.value ?? part.params.va ?? part.params.dc ?? "";
    if (v) {
      const vAt = toScreen(vp, [part.at[0] + slot.value[0], part.at[1] + slot.value[1]]);
      g.fillStyle = t.muted;
      g.fillText(v, vAt[0], vAt[1]);
    }
  }
}

export function drawWires(g: CanvasRenderingContext2D, vp: Viewport, wires: Iterable<Wire>, t: Theme) {
  g.strokeStyle = t.wire;
  g.lineWidth = lw(vp, 1.4);
  g.lineJoin = "round";
  g.lineCap = "round";
  for (const w of wires) {
    if (w.pts.length < 2) continue;
    g.beginPath();
    w.pts.forEach((p, i) => { const s = toScreen(vp, p); if (i) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]); });
    g.stroke();
  }
}

/**
 * 넷 이름. 넷마다 **한 번만** 적는다.
 *
 * 닿는 곳마다 적으면 회로도가 글자로 덮인다. 한 넷에 하나면 "이 줄이 넷리스트에서
 * 무슨 이름인가" 를 묻는 데 충분하다 — 자동 이름(N001)이 어디로 갔는지 볼 때가 그렇다.
 *
 * 자리는 그 넷에서 가장 위, 같으면 가장 왼쪽 점이다. 아무 점이나 고르면 다시 그릴 때마다
 * 글자가 옮겨 다닌다.
 */
export function drawNetNames(
  g: CanvasRenderingContext2D, vp: Viewport, names: Iterable<[string, Pt]>, t: Theme,
) {
  if (vp.scale < 0.6) return;
  // 핀 이름과 같은 이유로 바닥을 둔다. 읽을 수 없는 크기로 그릴 바에는 안 그리는 게 낫다
  const size = Math.max(9, Math.min(11, 4.6 * vp.scale));
  g.font = size + "px ui-sans-serif, system-ui";
  g.textAlign = "left";
  g.textBaseline = "bottom";
  g.fillStyle = t.label;
  for (const [name, best] of names) {
    const s = toScreen(vp, best);
    g.fillText(name, s[0] + 5, s[1] - 4);
  }
}

/** 넷마다 이름을 적을 자리: 가장 위, 같으면 가장 왼쪽 점 (다시 그릴 때 글자가 옮겨 다니지 않게) */
export function netNameSpots(nets: Map<string, Pt[]>): Array<[string, Pt]> {
  const out: Array<[string, Pt]> = [];
  for (const [name, pts] of nets) {
    if (!pts.length) continue;
    let best = pts[0];
    for (const p of pts) if (p[1] < best[1] || (p[1] === best[1] && p[0] < best[0])) best = p;
    out.push([name, best]);
  }
  return out;
}

export function drawJunctions(g: CanvasRenderingContext2D, vp: Viewport, pts: Pt[], t: Theme) {
  g.fillStyle = t.junction;
  for (const p of pts) {
    const s = toScreen(vp, p);
    g.beginPath();
    g.arc(s[0], s[1], Math.max(2.2, lw(vp, 2.4)), 0, Math.PI * 2);
    g.fill();
  }
}

export function drawLabels(g: CanvasRenderingContext2D, vp: Viewport, labels: Iterable<NetLabel>, t: Theme) {
  const size = Math.min(13, 5.5 * vp.scale);
  g.font = size + "px ui-monospace, Consolas, monospace";
  g.lineCap = "round";

  for (const l of labels) {
    const s = toScreen(vp, l.at);
    if (l.kind === "power") {
      // 전원 기호: 핀에서 위로 선 하나와 가로 막대. 넷 라벨과 한눈에 구분되게 한다
      const h = Math.max(8, 8 * Math.min(vp.scale / 2, 2));
      const w = Math.max(7, 7 * Math.min(vp.scale / 2, 2));
      g.strokeStyle = t.label;
      g.lineWidth = Math.max(1.4, 1.4 * Math.min(vp.scale / 2, 2));
      g.beginPath();
      g.moveTo(s[0], s[1]); g.lineTo(s[0], s[1] - h);
      g.moveTo(s[0] - w, s[1] - h); g.lineTo(s[0] + w, s[1] - h);
      g.stroke();
      g.fillStyle = t.label;
      g.textAlign = "center"; g.textBaseline = "bottom";
      g.fillText(l.name, s[0], s[1] - h - 3);
    } else {
      g.fillStyle = t.label;
      g.textAlign = "left"; g.textBaseline = "bottom";
      g.fillText(l.name, s[0] + 5, s[1] - 4);
    }
  }
}

/**
 * 전압 프로브 (E24). 꽂은 자리에 자기 색으로 그린다 — 파형 선 색과 같아서
 * 어느 선이 어느 넷인지 범례를 안 봐도 알 수 있다.
 */
export function drawProbes(
  g: CanvasRenderingContext2D, vp: Viewport, probes: Iterable<Probe>,
  netOf: (p: Pt) => string | null, labelledAt: (p: Pt) => boolean, t: Theme,
) {
  for (const pr of probes) {
    const s = toScreen(vp, pr.at);
    const color = css(pr.color) || pr.color;
    const r = Math.max(3.5, lw(vp, 3.6));

    // 꽂은 점
    g.fillStyle = color;
    g.beginPath(); g.arc(s[0], s[1], r, 0, Math.PI * 2); g.fill();

    // 비스듬한 손잡이
    g.strokeStyle = color;
    g.lineWidth = lw(vp, 1.6);
    g.lineCap = "round";
    const len = Math.max(10, 7 * vp.scale);
    g.beginPath();
    g.moveTo(s[0] + r * 0.7, s[1] - r * 0.7);
    g.lineTo(s[0] + r * 0.7 + len, s[1] - r * 0.7 - len);
    g.stroke();

    // 같은 자리에 넷 라벨이 이미 있으면 이름을 또 쓰지 않는다 — 글자가 겹친다
    const labelled = labelledAt(pr.at);
    if (vp.scale > 1.1 && !labelled) {
      const name = netOf(pr.at);
      if (name) {
        g.fillStyle = color;
        g.font = Math.min(12, 5 * vp.scale) + "px ui-monospace, Consolas, monospace";
        g.textAlign = "left"; g.textBaseline = "bottom";
        g.fillText(name, s[0] + r * 0.7 + len + 3, s[1] - r * 0.7 - len + 4);
      }
    }
  }
}

/**
 * 끝나지 않은 곳을 표시한다 (설계서 12-7, KiCad 방식).
 *   ○ 아무것도 안 붙은 핀 끝
 *   □ 어디로도 이어지지 않은 배선 끝
 * 연결되면 사라지므로, 회로를 그리다 빠뜨린 곳이 눈에 바로 띈다.
 */
export function drawLooseMarks(
  g: CanvasRenderingContext2D, vp: Viewport, pins: Pt[], ends: Pt[], t: Theme,
) {
  if (vp.scale < 0.8) return;         // 너무 작으면 점만 찍혀 지저분하다
  g.strokeStyle = t.loose;
  g.lineWidth = Math.max(1, lw(vp, 1.1));

  const r = Math.max(2.5, 2.6 * Math.min(vp.scale / 2, 2));
  for (const p of pins) {
    const s = toScreen(vp, p);
    g.beginPath();
    g.arc(s[0], s[1], r, 0, Math.PI * 2);
    g.stroke();
  }
  for (const p of ends) {
    const s = toScreen(vp, p);
    g.strokeRect(half(s[0] - r), half(s[1] - r), r * 2, r * 2);
  }
}

/** 넷 강조 (E20). 그 넷에 속한 배선을 통째로 다른 색으로 덧그린다 */
export function drawNetHighlight(
  g: CanvasRenderingContext2D, vp: Viewport, wires: Iterable<Wire>,
  isOnNet: (p: Pt) => boolean, t: Theme,
) {
  g.strokeStyle = t.highlight;
  g.lineWidth = Math.max(3, 3 * Math.min(vp.scale / 2, 2));
  g.lineJoin = "round";
  g.lineCap = "round";
  g.globalAlpha = 0.5;
  for (const w of wires) {
    if (w.pts.length < 2 || !isOnNet(w.pts[0])) continue;
    g.beginPath();
    w.pts.forEach((p, i) => { const s = toScreen(vp, p); if (i) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]); });
    g.stroke();
  }
  g.globalAlpha = 1;
}

/**
 * 주석 글자·선·사각형 (설계서 E32).
 *
 * 회로가 아니라 설명이라, 배선·부품과 한눈에 갈리도록 흐린 색으로 그린다.
 * 넷 추출과 넷리스트는 이것들을 아예 보지 않는다.
 */
export function drawNotes(g: CanvasRenderingContext2D, vp: Viewport, notes: Iterable<Note>, t: Theme) {
  g.strokeStyle = t.muted;
  g.fillStyle = t.muted;
  g.lineWidth = lw(vp, 1);
  g.lineCap = "butt";
  const size = Math.max(8, Math.min(16, 6 * vp.scale));
  g.font = size + "px system-ui, sans-serif";
  g.textAlign = "left";
  g.textBaseline = "alphabetic";

  for (const n of notes) {
    const a = toScreen(vp, n.pts[0] ?? [0, 0]);
    if (n.kind === "text") {
      g.fillText(n.text ?? "", a[0], a[1]);
    } else if (n.kind === "line") {
      const b = toScreen(vp, n.pts[1] ?? n.pts[0]);
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    } else {
      const b = toScreen(vp, n.pts[1] ?? n.pts[0]);
      g.strokeRect(half(Math.min(a[0], b[0])), half(Math.min(a[1], b[1])),
                   Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    }
  }
}

/** 주석의 화면 좌표 네모. 클릭 판정과 선택 표시가 같은 값을 쓴다 */
export function noteBounds(n: Note, vp: Viewport, g?: CanvasRenderingContext2D): [Pt, Pt] {
  const a = toScreen(vp, n.pts[0] ?? [0, 0]);
  if (n.kind === "text") {
    const size = Math.max(8, Math.min(16, 6 * vp.scale));
    // 글자 폭은 캔버스에 물어본다. 없으면 어림잡는다 (판정이 조금 커질 뿐이다)
    let w = (n.text ?? "").length * size * 0.55;
    if (g) { g.font = size + "px system-ui, sans-serif"; w = g.measureText(n.text ?? "").width; }
    return [[a[0] - 2, a[1] - size], [a[0] + w + 2, a[1] + size * 0.3]];
  }
  const b = toScreen(vp, n.pts[1] ?? n.pts[0]);
  return [[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]];
}

/**
 * SPICE 지시문 블록 (설계서 E33). 글자 그대로 보여 주는 상자다.
 *
 * 글자 크기는 화면 배율을 따르되 위아래로 묶어 둔다 — 많이 줄였을 때 글자가 뭉개지면
 * 상자가 어디 있는지만 보이면 되고, 많이 키웠을 때 한 줄이 화면을 넘지 않게 한다.
 */
export function drawSpiceBlocks(g: CanvasRenderingContext2D, vp: Viewport, blocks: Iterable<SpiceBlock>, t: Theme) {
  for (const b of blocks) {
    const [a] = blockBounds(b, vp);
    const size = blockFont(vp);
    g.font = size + "px ui-monospace, Consolas, monospace";
    g.textAlign = "left"; g.textBaseline = "top";
    const [, bb] = blockBounds(b, vp);
    g.strokeStyle = t.muted;
    g.setLineDash(b.active ? [] : [4, 3]);      // 꺼 둔 블록은 점선
    g.lineWidth = 1;
    g.strokeRect(Math.round(a[0]) + 0.5, Math.round(a[1]) + 0.5, bb[0] - a[0], bb[1] - a[1]);
    g.setLineDash([]);
    g.fillStyle = b.active ? t.label : t.muted;
    const lines = b.lines.length ? b.lines : ["(empty directive)"];
    lines.forEach((line, i) => g.fillText(line, a[0] + 5, a[1] + 4 + i * (size + 2)));
  }
}

/** 블록 글자 크기 (화면 픽셀) */
export const blockFont = (vp: Viewport): number => Math.max(7, Math.min(12, 5 * vp.scale));

/** 블록의 화면 좌표 네모. 글자 길이에서 나오므로 그리기와 클릭 판정이 같은 값을 쓴다 */
export function blockBounds(b: SpiceBlock, vp: Viewport): [Pt, Pt] {
  const size = blockFont(vp);
  const a = toScreen(vp, b.at);
  const lines = b.lines.length ? b.lines : ["(empty directive)"];
  const cols = Math.max(...lines.map((l: string) => l.length), 8);
  return [a, [a[0] + cols * size * 0.62 + 10, a[1] + lines.length * (size + 2) + 8]];
}

/**
 * 끄는 중에 새로 붙을 연결을 미리 보여 준다 (설계서 12-4).
 * 끌다가 엉뚱한 핀에 붙는 문제(FR1)에 대한 답이라, 놓기 전에 결과가 보여야 한다.
 */
export function drawConnectPreview(g: CanvasRenderingContext2D, vp: Viewport, pts: Pt[], t: Theme) {
  g.strokeStyle = t.connect;
  g.lineWidth = 2;
  for (const p of pts) {
    const s = toScreen(vp, p);
    const r = Math.max(6, 6 * Math.min(vp.scale / 2, 2));
    g.beginPath();
    g.arc(s[0], s[1], r, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(s[0], s[1], r * 0.35, 0, Math.PI * 2);
    g.fillStyle = t.connect;
    g.fill();
  }
}

/** 선택 표시: 부품을 감싸는 점선 상자 */
export function drawSelection(
  g: CanvasRenderingContext2D, vp: Viewport, part: Part, lib: LibPart, t: Theme,
) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Pt) => {
    const v = transform(p, part.rot, part.mirror);
    x0 = Math.min(x0, v[0]); y0 = Math.min(y0, v[1]);
    x1 = Math.max(x1, v[0]); y1 = Math.max(y1, v[1]);
  };
  for (const s of lib.symbol.graphics) {
    if ("line" in s) { add(s.line[0]); add(s.line[1]); }
    else if ("poly" in s) s.poly.forEach(add);
    else if ("rect" in s) { add([s.rect[0], s.rect[1]]); add([s.rect[0] + s.rect[2], s.rect[1] + s.rect[3]]); }
    else { add([s.circle.c[0] - s.circle.r, s.circle.c[1] - s.circle.r]); add([s.circle.c[0] + s.circle.r, s.circle.c[1] + s.circle.r]); }
  }
  for (const p of lib.symbol.pins) add(p.at);
  const a = toScreen(vp, [part.at[0] + x0, part.at[1] + y0]);
  const b = toScreen(vp, [part.at[0] + x1, part.at[1] + y1]);
  const m = 4;
  g.strokeStyle = t.select;
  g.lineWidth = 1;
  g.setLineDash([4, 3]);
  g.strokeRect(half(Math.min(a[0], b[0]) - m), half(Math.min(a[1], b[1]) - m),
    Math.abs(b[0] - a[0]) + m * 2, Math.abs(b[1] - a[1]) + m * 2);
  g.setLineDash([]);
}

/** 부품의 대략적인 히트 박스 (월드 단위) */
export function partBounds(part: Part, lib: LibPart): [Pt, Pt] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of lib.symbol.pins) {
    const v = transform(p.at, part.rot, part.mirror);
    x0 = Math.min(x0, v[0]); y0 = Math.min(y0, v[1]);
    x1 = Math.max(x1, v[0]); y1 = Math.max(y1, v[1]);
  }
  // 핀이 하나뿐인 기호(GND)는 몸통 크기를 따로 봐준다
  if (x0 === x1) { x0 -= 8; x1 += 8; }
  if (y0 === y1) { y0 -= 8; y1 += 8; }
  return [[part.at[0] + x0, part.at[1] + y0], [part.at[0] + x1, part.at[1] + y1]];
}
