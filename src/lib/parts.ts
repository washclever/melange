/**
 * 내장 부품 라이브러리.
 *
 * 부품 하나 = 심볼 + SPICE 매핑 + 속성. 설계서 '부품 라이브러리' 의 JSON 구조를
 * TypeScript 상수로 둔 것이고, 프로젝트 파일에는 쓴 것만 사본으로 복사된다.
 *
 * 심볼 도형은 IEC/ANSI 표준 기호를 우리가 직접 좌표로 적은 것이다 (다른 EDA 의 심볼 그림·부품
 * 데이터는 쓰지 않는다). 핀 오프셋은 모두 격자(10) 배수여서 회전해도 핀이 격자 위에 남고, 핀마다
 * 핀에서 시작하는 다리 선이 있어서 배선이 따라올 때 어느 쪽으로 나가야 하는지 안다 (doc/follow.ts).
 *
 * 묶음은 둘이다 — 수동 소자(Passive)와 아날로그(Analog). 둘 다 **이상적인** 소자다: 제조사 모델이
 * 아니라 SPICE 기본 소자(R C L K T · V I · E G F H · B · S)와 교과서 값의 일반 모델이다. 어느 묶음의
 * 어느 칸에 보이는지는 src/lib/catalog.ts 가 정한다.
 */
import type { LibPart, Pt, Shape } from "../doc/types.ts";

// ── 도형 도우미 ───────────────────────────────────────────────────────
/** 화살촉. poly 는 선으로만 그려지므로 닫힌 삼각형으로 둔다 */
const arrow = (tip: Pt, from: Pt, size = 4): Shape => {
  const dx = tip[0] - from[0], dy = tip[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;          // 진행 방향
  const bx = tip[0] - ux * size, by = tip[1] - uy * size;
  const wx = -uy * size * 0.5, wy = ux * size * 0.5;   // 수직 방향
  return { poly: [tip, [bx + wx, by + wy], [bx - wx, by - wy], tip] };
};

/**
 * 타원(원)의 호를 점으로. 호 도형은 두지 않는다 (doc/types.ts Shape) — 점마다 transform 을 거쳐야
 * 핀 좌표와 그림이 절대 어긋나지 않는다. a0 -> a1 (라디안, y 가 아래로 자라는 화면 기준)
 */
const arcPts = (cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n: number): Pt[] =>
  Array.from({ length: n + 1 }, (_, i): Pt => {
    const t = a0 + ((a1 - a0) * i) / n;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
  });

/** 전원 공통 심볼: 원 + 위아래 리드 */
const sourceGraphics = (inner: Shape[]): Shape[] => [
  { line: [[0, -20], [0, -10]] },
  { circle: { c: [0, 0], r: 10 } },
  { line: [[0, 10], [0, 20]] },
  ...inner,
];

/** 사인 한 주기 (원 안에 넣는 그림). x0 부터 너비 w, 진폭 a */
const sineGlyph = (x0: number, w: number, a: number): Shape =>
  ({ poly: Array.from({ length: 17 }, (_, i): Pt => [x0 + (i * w) / 16, -a * Math.sin((i / 16) * Math.PI * 2)]) });

/** 위를 보는 전류 화살표. 전류가 **위 핀으로 나간다** (SPICE 의 n- 쪽) */
const upArrow = (x: number, y0: number, y1: number): Shape[] =>
  [{ line: [[x, y0], [x, y1 + 4]] }, arrow([x, y1], [x, y1 + 4])];

// ── 수동 소자 (Passive) ──────────────────────────────────────────────
export const RESISTOR: LibPart = {
  id: "r", name: "Resistor", category: "Passive", refPrefix: "R",
  symbol: {
    pins: [{ id: "1", name: "1", at: [-20, 0] }, { id: "2", name: "2", at: [20, 0] }],
    graphics: [
      { line: [[-20, 0], [-10, 0]] },
      { rect: [-10, -5, 20, 10] },
      { line: [[10, 0], [20, 0]] },
    ],
  },
  params: [{ key: "value", label: "Resistor", unit: "Ω", default: "1k" }],
  spice: { element: "R", template: "{ref} {1} {2} {value}" },
};

/**
 * 가변 저항 (3단자). 저항 둘로 내보낸다 — 1 과 와이퍼 사이가 R·pos, 와이퍼와 2 사이가 R·(1-pos).
 *
 * 값은 SPICE 의 중괄호 식으로 넘긴다 ({10k*0.3}). ngspice 가 계산하므로 R 이나 위치를 바꿔도 줄이
 * 맞다. 끝에 붙이면 저항이 0 이 되는데, ngspice 는 0 Ω 을 1e-12 Ω 으로 바꾸고는 **틀린 전류**를
 * 낸다 (1 V / 1 kΩ 이 0.98 mA 로 나왔다). 그래서 1 mΩ 아래로는 내리지 않는다.
 */
export const POTENTIOMETER: LibPart = {
  id: "pot", name: "Potentiometer", category: "Passive", refPrefix: "RV",
  symbol: {
    pins: [
      { id: "1", name: "1", at: [-20, 0] },
      { id: "w", name: "W", at: [0, -20] },
      { id: "2", name: "2", at: [20, 0] },
    ],
    graphics: [
      { line: [[-20, 0], [-10, 0]] },
      { rect: [-10, -5, 20, 10] },
      { line: [[10, 0], [20, 0]] },
      // 와이퍼: 위에서 내려와 몸통을 짚는 화살
      { line: [[0, -20], [0, -9]] },
      arrow([0, -5], [0, -9]),
    ],
  },
  // 와이퍼 선이 기본 지정자 자리(위 가운데)를 지나므로 지정자는 오른쪽 위에 둔다. W 글자는 왼쪽에 적힌다
  textAt: { ref: [16, -12], value: [0, 16] },
  params: [
    { key: "value", label: "Resistance", unit: "Ω", default: "10k" },
    { key: "pos", label: "Wiper position", unit: "", default: "0.5", min: 0, max: 1 },
  ],
  spice: {
    element: "R",
    template: "{ref}_a {1} {w} {max({value}*{pos},1m)}\n{ref}_b {w} {2} {max({value}*(1-{pos}),1m)}",
  },
};

export const CAPACITOR: LibPart = {
  id: "c", name: "Capacitor", category: "Passive", refPrefix: "C",
  symbol: {
    pins: [{ id: "1", name: "1", at: [0, -20] }, { id: "2", name: "2", at: [0, 20] }],
    graphics: [
      { line: [[0, -20], [0, -3]] },
      { line: [[-9, -3], [9, -3]] },
      { line: [[-9, 3], [9, 3]] },
      { line: [[0, 3], [0, 20]] },
    ],
  },
  params: [{ key: "value", label: "Capacitance", unit: "F", default: "100n" }],
  spice: { element: "C", template: "{ref} {1} {2} {value}" },
};

/**
 * 극성 커패시터 (전해). SPICE 로는 보통 커패시터와 같은 한 줄이다 — 극성은 그림과 핀 이름에만 있다.
 * 곧은 판이 +, 굽은 판이 - 다. 굽은 판은 중심 (0, 18) 반지름 15 인 원의 호다: 양 끝이 (±9, 6),
 * 가운데가 (0, 3) 이라 아래 리드와 만난다.
 */
const PLATE_HALF = Math.atan2(12, 9);
export const CAPACITOR_POL: LibPart = {
  id: "cpol", name: "Polarized capacitor", category: "Passive", refPrefix: "C",
  symbol: {
    pins: [{ id: "p", name: "+", at: [0, -20] }, { id: "n", name: "-", at: [0, 20] }],
    graphics: [
      { line: [[0, -20], [0, -3]] },
      { line: [[-9, -3], [9, -3]] },
      { poly: arcPts(0, 18, 15, 15, Math.PI + PLATE_HALF, 2 * Math.PI - PLATE_HALF, 12) },
      { line: [[0, 3], [0, 20]] },
      // + 표시 (곧은 판 쪽)
      { line: [[5, -9], [9, -9]] }, { line: [[7, -11], [7, -7]] },
    ],
  },
  params: [{ key: "value", label: "Capacitance", unit: "F", default: "10u" }],
  spice: { element: "C", template: "{ref} {p} {n} {value}" },
};

export const INDUCTOR: LibPart = {
  id: "l", name: "Inductor", category: "Passive", refPrefix: "L",
  symbol: {
    pins: [{ id: "1", name: "1", at: [-20, 0] }, { id: "2", name: "2", at: [20, 0] }],
    graphics: [
      { line: [[-20, 0], [-12, 0]] },
      // 위로 솟은 반원 두 개를 폴리라인으로 근사한다
      ...[-6, 6].map(cx => ({
        poly: Array.from({ length: 13 }, (_, i): Pt => {
          const t = Math.PI - (i / 12) * Math.PI;
          return [cx + 6 * Math.cos(t), -6 * Math.sin(t)];
        }),
      })),
      { line: [[12, 0], [20, 0]] },
    ],
  },
  params: [{ key: "value", label: "Inductance", unit: "H", default: "10u" }],
  spice: { element: "L", template: "{ref} {1} {2} {value}" },
};

/** 세로 코일: (x, y0) 에서 아래로 반원 n 개. dir 쪽(-1 왼쪽, +1 오른쪽)으로 부푼다 */
const coil = (x: number, y0: number, humps: number, r: number, dir: -1 | 1): Shape[] =>
  Array.from({ length: humps }, (_, h) => ({
    poly: arcPts(x, y0 + r + h * 2 * r, dir * r, r, -Math.PI / 2, Math.PI / 2, 8),
  }));

/**
 * 변압기 — 결합 인덕터 둘. 내보내면 세 줄이다:
 *
 *   LT1_p 1차+ 1차- Lp
 *   LT1_s 2차+ 2차- Ls
 *   KLT1 LT1_p LT1_s k
 *
 * 권선비는 √(Ls/Lp) 다 (1 mH : 4 mH 면 1:2). k = 1 이 완전 결합이고, 기본값은 수치가 편하도록
 * 그보다 조금 작은 0.999 다. 1 을 넘으면 ngspice 가 오류 대신 1e293 같은 값을 내므로 검사가 막는다.
 * 점(•)이 찍힌 끝이 각 인덕터 줄의 첫 노드다 — 두 점에서 전압이 같은 방향으로 움직인다.
 */
export const TRANSFORMER: LibPart = {
  id: "xfmr", name: "Transformer", category: "Passive", refPrefix: "T",
  symbol: {
    pins: [
      { id: "p1", name: "1", at: [-20, -20] },
      { id: "p2", name: "2", at: [-20, 20] },
      { id: "s1", name: "3", at: [20, -20] },
      { id: "s2", name: "4", at: [20, 20] },
    ],
    graphics: [
      { line: [[-20, -20], [-6, -20]] }, { line: [[-6, -20], [-6, -12]] },
      { line: [[-20, 20], [-6, 20]] }, { line: [[-6, 20], [-6, 12]] },
      { line: [[20, -20], [6, -20]] }, { line: [[6, -20], [6, -12]] },
      { line: [[20, 20], [6, 20]] }, { line: [[6, 20], [6, 12]] },
      ...coil(-6, -12, 4, 3, -1),
      ...coil(6, -12, 4, 3, 1),
      // 철심
      { line: [[-2, -12], [-2, 12]] }, { line: [[2, -12], [2, 12]] },
      // 극성 점. 채운 도형이 없어서 고리 둘을 겹쳐 점처럼 보이게 한다
      ...[-12, 12].flatMap((x): Shape[] => [{ circle: { c: [x, -15], r: 1.1 } }, { circle: { c: [x, -15], r: 0.4 } }]),
    ],
  },
  params: [
    { key: "lp", label: "Primary inductance", unit: "H", default: "1m" },
    { key: "ls", label: "Secondary inductance", unit: "H", default: "1m" },
    { key: "k", label: "Coupling k", unit: "", default: "0.999", min: 0, max: 1 },
  ],
  spice: {
    element: "L",
    template: "{ref}_p {p1} {p2} {lp}\n{ref}_s {s1} {s2} {ls}\nK{ref} {ref}_p {ref}_s {k}",
  },
};

/**
 * 손실 없는 전송선 (SPICE T). 포트 둘, 포트마다 신호선과 귀선. Z0 와 지연 TD 만 있다.
 * 관(동축선) 모양으로 그리고, 귀선은 관의 아래(실드)에 붙인다.
 */
export const TLINE: LibPart = {
  id: "tline", name: "Transmission line", category: "Passive", refPrefix: "TL",
  symbol: {
    pins: [
      { id: "a", name: "1", at: [-30, 0] },
      { id: "ar", name: "2", at: [-30, 10] },
      { id: "b", name: "3", at: [30, 0] },
      { id: "br", name: "4", at: [30, 10] },
    ],
    graphics: [
      { line: [[-30, 0], [-19, 0]] },
      { line: [[19, 0], [30, 0]] },
      { line: [[-16, -5], [16, -5]] },
      { line: [[-16, 5], [16, 5]] },
      { poly: arcPts(-16, 0, 3, 5, 0, 2 * Math.PI, 16) },
      { poly: arcPts(16, 0, 3, 5, -Math.PI / 2, Math.PI / 2, 8) },
      { line: [[-30, 10], [-12, 10]] }, { line: [[-12, 10], [-12, 5]] },
      { line: [[30, 10], [12, 10]] }, { line: [[12, 10], [12, 5]] },
    ],
  },
  params: [
    { key: "value", label: "Impedance Z0", unit: "Ω", default: "50" },
    { key: "td", label: "Delay", unit: "s", default: "1n" },
  ],
  spice: { element: "T", template: "{ref} {a} {ar} {b} {br} Z0={value} TD={td}" },
};

// ── 아날로그: 독립 전원 ───────────────────────────────────────────────
export const VSIN: LibPart = {
  id: "vsin", name: "Sine voltage", category: "Analog", refPrefix: "V",
  symbol: {
    pins: [{ id: "p", name: "+", at: [0, -20] }, { id: "n", name: "-", at: [0, 20] }],
    graphics: sourceGraphics([
      // 사인 한 주기
      { poly: Array.from({ length: 17 }, (_, i): Pt => [-6 + (i * 12) / 16, -3.5 * Math.sin((i / 16) * Math.PI * 2)]) },
    ]),
  },
  params: [
    { key: "vo", label: "Offset", unit: "V", default: "0" },
    { key: "va", label: "Amplitude", unit: "V", default: "1" },
    { key: "freq", label: "Frequency", unit: "Hz", default: "1k" },
    { key: "td", label: "Delay", unit: "s", default: "0" },
    { key: "theta", label: "Damping", unit: "1/s", default: "0" },
    { key: "phase", label: "Phase", unit: "deg", default: "0" },
    { key: "ac", label: "AC mag", unit: "V", default: "1" },
  ],
  spice: { element: "V", template: "{ref} {p} {n} {acspec}SIN({vo} {va} {freq} {td} {theta} {phase})" },
};

export const VDC: LibPart = {
  id: "vdc", name: "DC voltage", category: "Analog", refPrefix: "V",
  symbol: {
    pins: [{ id: "p", name: "+", at: [0, -20] }, { id: "n", name: "-", at: [0, 20] }],
    graphics: sourceGraphics([
      { line: [[-4, -4], [4, -4]] }, { line: [[0, -8], [0, 0]] },   // +
      { line: [[-4, 5], [4, 5]] },                                   // −
    ]),
  },
  params: [
    { key: "dc", label: "Voltage", unit: "V", default: "5" },
    { key: "ac", label: "AC mag", unit: "V", default: "1" },
  ],
  spice: { element: "V", template: "{ref} {p} {n} DC {dc} {acspec}" },
};

export const VPULSE: LibPart = {
  id: "vpulse", name: "Pulse voltage", category: "Analog", refPrefix: "V",
  symbol: {
    pins: [{ id: "p", name: "+", at: [0, -20] }, { id: "n", name: "-", at: [0, 20] }],
    graphics: sourceGraphics([
      { poly: [[-6, 3], [-6, -3], [0, -3], [0, 3], [6, 3]] },
    ]),
  },
  params: [
    { key: "v1", label: "Low", unit: "V", default: "0" },
    { key: "v2", label: "High", unit: "V", default: "5" },
    { key: "td", label: "Delay", unit: "s", default: "0" },
    { key: "tr", label: "Rise", unit: "s", default: "1n" },
    { key: "tf", label: "Fall", unit: "s", default: "1n" },
    { key: "pw", label: "Width", unit: "s", default: "0.5m" },
    { key: "per", label: "Period", unit: "s", default: "1m" },
    { key: "ac", label: "AC mag", unit: "V", default: "1" },
  ],
  spice: { element: "V", template: "{ref} {p} {n} {acspec}PULSE({v1} {v2} {td} {tr} {tf} {pw} {per})" },
};

/**
 * 구간 선형(PWL) 전압원. '시간 값' 쌍을 공백으로 늘어놓은 글자를 그대로 넘긴다 —
 * 0 0 1m 1 2m 0 이면 0 에서 1 ms 동안 1 V 로 오르고 2 ms 에 0 으로 내려온다.
 */
export const VPWL: LibPart = {
  id: "vpwl", name: "PWL voltage", category: "Analog", refPrefix: "V",
  symbol: {
    pins: [{ id: "p", name: "+", at: [0, -20] }, { id: "n", name: "-", at: [0, 20] }],
    graphics: sourceGraphics([
      { poly: [[-7, 3], [-4, -4], [0, -4], [3, 3], [7, 0]] },
    ]),
  },
  params: [
    { key: "points", label: "Time value pairs", unit: "s V", default: "0 0 1m 1 2m 0" },
    { key: "ac", label: "AC mag", unit: "V", default: "1" },
  ],
  spice: { element: "V", template: "{ref} {p} {n} {acspec}PWL({points})" },
};

/*
 * 전류원. SPICE 의 `I n+ n- 값` 은 전류가 n+ 에서 소자를 지나 n- 로 **나간다.** 그래서 n+ 를
 * 아래, n- 를 위에 두고 화살표를 위로 그린다 — 아래를 접지에 놓으면 위 핀으로 전류가 나와 부하에
 * 양의 전압이 걸린다. 그림과 넷리스트가 같은 말을 한다.
 *
 * 직류 전류원의 AC 크기는 기본 0 이다. 직류 전류원은 대개 바이어스(꼬리 전류)라, AC 해석에서
 * 1 A 를 흘려 넣으면 입력 대신 바이어스가 신호가 된다. 신호용인 사인·펄스는 전압원처럼 1 이다.
 */
const currentPins = (): LibPart["symbol"]["pins"] =>
  [{ id: "p", name: "1", at: [0, 20] }, { id: "n", name: "2", at: [0, -20] }];

export const IDC: LibPart = {
  id: "idc", name: "DC current", category: "Analog", refPrefix: "I",
  symbol: { pins: currentPins(), graphics: sourceGraphics(upArrow(0, 7, -7)) },
  params: [
    { key: "dc", label: "Current", unit: "A", default: "1m" },
    { key: "ac", label: "AC mag", unit: "A", default: "0" },
  ],
  spice: { element: "I", template: "{ref} {p} {n} DC {dc} {acspec}" },
};

export const ISIN: LibPart = {
  id: "isin", name: "Sine current", category: "Analog", refPrefix: "I",
  symbol: { pins: currentPins(), graphics: sourceGraphics([...upArrow(-4, 7, -7), sineGlyph(0, 7, 2.5)]) },
  params: [
    { key: "vo", label: "Offset", unit: "A", default: "0" },
    { key: "va", label: "Amplitude", unit: "A", default: "1m" },
    { key: "freq", label: "Frequency", unit: "Hz", default: "1k" },
    { key: "td", label: "Delay", unit: "s", default: "0" },
    { key: "theta", label: "Damping", unit: "1/s", default: "0" },
    { key: "phase", label: "Phase", unit: "deg", default: "0" },
    { key: "ac", label: "AC mag", unit: "A", default: "1" },
  ],
  spice: { element: "I", template: "{ref} {p} {n} {acspec}SIN({vo} {va} {freq} {td} {theta} {phase})" },
};

export const IPULSE: LibPart = {
  id: "ipulse", name: "Pulse current", category: "Analog", refPrefix: "I",
  symbol: {
    pins: currentPins(),
    graphics: sourceGraphics([...upArrow(-4, 7, -7), { poly: [[0, 3], [2, 3], [2, -3], [5, -3], [5, 3], [7, 3]] }]),
  },
  params: [
    { key: "v1", label: "Low", unit: "A", default: "0" },
    { key: "v2", label: "High", unit: "A", default: "1m" },
    { key: "td", label: "Delay", unit: "s", default: "0" },
    { key: "tr", label: "Rise", unit: "s", default: "1n" },
    { key: "tf", label: "Fall", unit: "s", default: "1n" },
    { key: "pw", label: "Width", unit: "s", default: "0.5m" },
    { key: "per", label: "Period", unit: "s", default: "1m" },
    { key: "ac", label: "AC mag", unit: "A", default: "1" },
  ],
  spice: { element: "I", template: "{ref} {p} {n} {acspec}PULSE({v1} {v2} {td} {tr} {tf} {pw} {per})" },
};

// ── 아날로그: 제어 전원 (E · G · H · F) ───────────────────────────────
/*
 * 넷이 같은 몸을 쓴다: 왼쪽이 제어 단자 C+·C-, 오른쪽이 마름모(의존 전원의 표준 기호)와 출력.
 * 출력이 전압이면 마름모 안에 +/-, 전류면 위를 보는 화살표다 (독립 전류원과 같은 약속 —
 * 전류가 위 핀으로 나간다).
 *
 * 전류 제어(H·F)는 제어 단자 사이에 0 V 전원을 넣어 그 전류를 잰다. 그래서 C+ 에서 C- 로
 * 이어진 선을 그린다 — 실제로 단락이다. 넷리스트에는 두 줄이 나간다:
 *
 *   VF1_s C+ C- 0
 *   F1 출력- 출력+ VF1_s 이득
 */
const DIAMOND: Shape = { poly: [[10, -10], [17, 0], [10, 10], [3, 0], [10, -10]] };
const OUT_LEADS: Shape[] = [{ line: [[10, -20], [10, -10]] }, { line: [[10, 20], [10, 10]] }];
const PLUS_MINUS: Shape[] = [
  { line: [[8, -5], [12, -5]] }, { line: [[10, -7], [10, -3]] },   // +
  { line: [[8, 5], [12, 5]] },                                       // −
];
/*
 * 이 넷(과 스위치)은 핀 이름을 회로도에 적지 않는다 (hideName). 원점에서 비스듬한 자리의 핀이라
 * 이름 글자가 지정자 위나 제어 선 위에 내려앉는다 — 극성은 그림으로 보여 준다: 마름모 안의 +/-,
 * 화살표, 제어 단자 사이의 +/-. 이름은 문제 목록에서 쓰인다 ("E1: input C+ is not driven").
 */
/** 전압을 읽는 제어 단자: 열린 두 단자와 그 사이의 +/- */
const V_SENSE: Shape[] = [
  { line: [[-20, -10], [-12, -10]] }, { line: [[-20, 10], [-12, 10]] },
  { line: [[-17, -5], [-13, -5]] }, { line: [[-15, -7], [-15, -3]] },   // +
  { line: [[-17, 5], [-13, 5]] },                                         // −
];
/** 전류를 읽는 제어 단자: C+ 로 들어와 C- 로 나가는 길 (아래로 흐르는 화살표) */
const I_SENSE: Shape[] = [
  { line: [[-20, -10], [-10, -10]] }, { line: [[-10, -10], [-10, 10]] }, { line: [[-10, 10], [-20, 10]] },
  arrow([-10, 3], [-10, -1]),
];
const CTRL_PINS = [
  { id: "cp", name: "C+", at: [-20, -10] as Pt, hideName: true },
  { id: "cn", name: "C-", at: [-20, 10] as Pt, hideName: true },
];
/** 전압 출력: 위가 +. 전류 출력: SPICE n+ 가 아래 (전류가 위 핀으로 나간다) */
const V_OUT_PINS = [
  { id: "p", name: "+", at: [10, -20] as Pt, hideName: true },
  { id: "n", name: "-", at: [10, 20] as Pt, hideName: true },
];
const I_OUT_PINS = [
  { id: "p", name: "1", at: [10, 20] as Pt, hideName: true },
  { id: "n", name: "2", at: [10, -20] as Pt, hideName: true },
];

export const VCVS: LibPart = {
  id: "vcvs", name: "VCVS", category: "Analog", refPrefix: "E",
  symbol: { pins: [...V_OUT_PINS, ...CTRL_PINS], graphics: [...V_SENSE, ...OUT_LEADS, DIAMOND, ...PLUS_MINUS] },
  params: [{ key: "value", label: "Voltage gain", unit: "V/V", default: "10" }],
  spice: { element: "E", template: "{ref} {p} {n} {cp} {cn} {value}" },
};

export const VCCS: LibPart = {
  id: "vccs", name: "VCCS", category: "Analog", refPrefix: "G",
  symbol: { pins: [...I_OUT_PINS, ...CTRL_PINS], graphics: [...V_SENSE, ...OUT_LEADS, DIAMOND, ...upArrow(10, 6, -6)] },
  params: [{ key: "value", label: "Transconductance", unit: "S", default: "1m" }],
  spice: { element: "G", template: "{ref} {p} {n} {cp} {cn} {value}" },
};

export const CCVS: LibPart = {
  id: "ccvs", name: "CCVS", category: "Analog", refPrefix: "H",
  symbol: { pins: [...V_OUT_PINS, ...CTRL_PINS], graphics: [...I_SENSE, ...OUT_LEADS, DIAMOND, ...PLUS_MINUS] },
  params: [{ key: "value", label: "Transresistance", unit: "Ω", default: "1k" }],
  spice: { element: "H", template: "V{ref}_s {cp} {cn} 0\n{ref} {p} {n} V{ref}_s {value}" },
};

export const CCCS: LibPart = {
  id: "cccs", name: "CCCS", category: "Analog", refPrefix: "F",
  symbol: { pins: [...I_OUT_PINS, ...CTRL_PINS], graphics: [...I_SENSE, ...OUT_LEADS, DIAMOND, ...upArrow(10, 6, -6)] },
  params: [{ key: "value", label: "Current gain", unit: "A/A", default: "10" }],
  spice: { element: "F", template: "V{ref}_s {cp} {cn} 0\n{ref} {p} {n} V{ref}_s {value}" },
};

// ── 아날로그: 증폭기 · 비교기 ─────────────────────────────────────────
/** op-amp 모양의 삼각형과 입력 표시. 비교기도 같은 몸이다 */
const AMP_BODY: Shape[] = [
  { line: [[-20, -10], [-12, -10]] },
  { line: [[-20, 10], [-12, 10]] },
  { line: [[12, 0], [20, 0]] },
  { poly: [[-12, -16], [-12, 16], [12, 0], [-12, -16]] },
  // - 표시
  { line: [[-9, -10], [-5, -10]] },
  // + 표시
  { line: [[-9, 10], [-5, 10]] },
  { line: [[-7, 8], [-7, 12]] },
];
const AMP_PINS = (): LibPart["symbol"]["pins"] => [
  { id: "inn", name: "-", at: [-20, -10] },
  { id: "inp", name: "+", at: [-20, 10] },
  { id: "out", name: "out", at: [20, 0] },
];

/**
 * 이상 op-amp. 전압제어 전압원(E 소자) 하나로 만든다.
 *
 *   E 문법: Exxx n+ n- nc+ nc- gain  ->  V(n+,n-) = gain * V(nc+,nc-)
 *   우리 줄: {ref} {out} 0 {inp} {inn} {gain}
 *
 * 출력이 노드 0 기준이라 심볼은 핀 셋(+, -, 출력)이고 넷리스트는 노드 넷이다.
 * 지정자 접두어가 U 라서 SPICE 이름은 EU1 이 된다 (설계서 내보내기 규칙 4).
 *
 * 반전 증폭기로 그리기 쉽도록 - 입력을 위, + 입력을 아래에 둔다.
 */
export const OPAMP: LibPart = {
  id: "opamp", name: "Ideal op-amp", category: "Analog", refPrefix: "U",
  symbol: { pins: AMP_PINS(), graphics: AMP_BODY },
  params: [{ key: "gain", label: "Gain", unit: "V/V", default: "1e6" }],
  spice: { element: "E", template: "{ref} {out} 0 {inp} {inn} {gain}" },
};

/**
 * 이상 비교기. 동작 전원(B) 하나로, 출력이 low 와 high 사이를 tanh 로 넘어간다:
 *
 *   V(out) = low + (high - low) · (1 + tanh(2.2 · (V+ - V-) / 폭)) / 2
 *
 * 폭(transition width)은 출력이 10 % 에서 90 % 로 넘어가는 입력 차다. 계단으로 자르지 않는 것은
 * ngspice 가 불연속에서 시간 간격을 끝없이 줄이다 멈추기 때문이다. 1 mV 면 5 V 를 넘기는 데
 * 기울기가 5,500 V/V 라 회로에서는 계단과 다르지 않고, 풀이는 순하다.
 */
export const COMPARATOR: LibPart = {
  id: "comparator", name: "Comparator", category: "Analog", refPrefix: "U",
  symbol: {
    pins: AMP_PINS(),
    // 몸 안에 계단 하나 — op-amp 와 한눈에 갈리게
    graphics: [...AMP_BODY, { poly: [[-3, 3], [1, 3], [1, -3], [5, -3]] }],
  },
  params: [
    { key: "vhigh", label: "Output high", unit: "V", default: "5" },
    { key: "vlow", label: "Output low", unit: "V", default: "0" },
    { key: "width", label: "Transition width", unit: "V", default: "1m", min: 1e-12 },
  ],
  spice: {
    element: "B",
    template: "{ref} {out} 0 V={vlow}+({vhigh}-{vlow})*(1+tanh(2.2*(V({inp})-V({inn}))/{width}))/2",
  },
};

// ── 아날로그: 스위치 ──────────────────────────────────────────────────
/**
 * 전압 제어 스위치 (SPICE S). 제어 전압 V(C+, C-) 가 문턱 + 히스테리시스를 넘으면 닫히고
 * (RON), 문턱 - 히스테리시스 아래로 내려가면 열린다 (ROFF). 그 사이에서는 상태를 유지한다.
 *
 * 모델 줄을 부품마다 따로 낸다 (.model S1_MOD SW(...)). 다이오드처럼 모델 이름을 속성으로 열면
 * 스위치 둘의 문턱을 다르게 줄 때마다 이름까지 바꿔야 한다 — 스위치의 모델 이름은 아무 뜻이 없다.
 *
 * 그림은 제어 전원과 같은 결이다: 왼쪽이 제어 단자, 오른쪽이 세로로 선 스위치, 그 사이를 점선이
 * 잇는다 (기계적 연동).
 */
export const VSWITCH: LibPart = {
  id: "vswitch", name: "Controlled switch", category: "Analog", refPrefix: "S",
  symbol: {
    pins: [
      { id: "1", name: "1", at: [10, -20] },
      { id: "2", name: "2", at: [10, 20] },
      ...CTRL_PINS,
    ],
    graphics: [
      ...V_SENSE,
      { rect: [-12, -13, 6, 26] },
      // 점선 연동
      { line: [[-4, 0], [-2, 0]] }, { line: [[0, 0], [2, 0]] }, { line: [[4, 0], [6, 0]] },
      // 스위치: 위 접점, 열린 날
      { line: [[10, -20], [10, -8]] },
      { line: [[8, -8], [12, -8]] },
      { line: [[10, 20], [10, 8]] },
      { line: [[10, 8], [4, -6]] },
    ],
  },
  params: [
    { key: "vt", label: "Threshold", unit: "V", default: "2.5" },
    { key: "vh", label: "Hysteresis", unit: "V", default: "0", min: 0 },
    { key: "ron", label: "On resistance", unit: "Ω", default: "1" },
    { key: "roff", label: "Off resistance", unit: "Ω", default: "1meg" },
  ],
  spice: {
    element: "S",
    template: "{ref} {1} {2} {cp} {cn} {ref}_MOD",
    model: ".model {ref}_MOD SW(VT={vt} VH={vh} RON={ron} ROFF={roff})",
  },
};

// ── 아날로그: 동작(behavioral) ────────────────────────────────────────
/** 아날로그 곱셈기. V(out) = k · V(X) · V(Y). 출력은 노드 0 기준 (op-amp 와 같다) */
export const MULTIPLIER: LibPart = {
  id: "mult", name: "Multiplier", category: "Analog", refPrefix: "U",
  symbol: {
    pins: [
      { id: "x", name: "X", at: [-20, -10] },
      { id: "y", name: "Y", at: [-20, 10] },
      { id: "out", name: "out", at: [20, 0] },
    ],
    graphics: [
      // 입력 리드는 원(반지름 12)의 가장자리까지
      { line: [[-20, -10], [-Math.sqrt(44), -10]] },
      { line: [[-20, 10], [-Math.sqrt(44), 10]] },
      { line: [[12, 0], [20, 0]] },
      { circle: { c: [0, 0], r: 12 } },
      { line: [[-5, -5], [5, 5]] }, { line: [[-5, 5], [5, -5]] },
    ],
  },
  params: [{ key: "value", label: "Gain k", unit: "1/V", default: "1" }],
  spice: { element: "B", template: "{ref} {out} 0 V={value}*V({x})*V({y})" },
};

/**
 * 동작 전압원 (SPICE B). 식을 그대로 넘긴다 — V(넷) 으로 넷 전압을, time 으로 시간을 읽는다.
 * 기본 식은 아무 넷도 읽지 않는 1 kHz 사인이라 놓자마자 돈다.
 *
 * 식이 **없는 넷**이나 아무것도 구동하지 않는 넷을 읽으면 이 엔진은 결과 없이 멈춘다.
 * 실행 전 검사가 식 안의 V(…) 를 읽어 먼저 막는다 (src/net/netlist.ts).
 */
export const BEHAVIORAL: LibPart = {
  id: "bv", name: "Behavioral source", category: "Analog", refPrefix: "B",
  symbol: {
    pins: [{ id: "p", name: "+", at: [0, -20] }, { id: "n", name: "-", at: [0, 20] }],
    graphics: sourceGraphics([
      // 아무 꼴이나 되는 곡선 — 지수로 차오르는 모양
      { poly: Array.from({ length: 13 }, (_, i): Pt => [-6 + i, 4 - 8 * (1 - Math.exp(-i / 3.5))]) },
    ]),
  },
  params: [{ key: "value", label: "Expression", unit: "V", default: "sin(2*pi*1k*time)" }],
  spice: { element: "B", template: "{ref} {p} {n} V={value}" },
};

// ── 반도체 (설계서 '부품 라이브러리' 표) ──────────────────────────────
/*
 * 제조사 SPICE 모델은 재배포 조건이 제각각이라 넣지 않는다 (설계서 위험 절).
 * 대신 교과서 값으로 만든 일반 모델을 두고, 모델 이름과 주요 계수를 속성으로 연다.
 * 모델 줄은 쓴 부품의 것만, 중복 없이 한 번씩 넷리스트에 들어간다.
 */

export const DIODE: LibPart = {
  id: "d", name: "Diode", category: "Analog", refPrefix: "D",
  symbol: {
    pins: [{ id: "a", name: "A", at: [-20, 0] }, { id: "k", name: "K", at: [20, 0] }],
    graphics: [
      { line: [[-20, 0], [-6, 0]] },
      { poly: [[-6, -7], [-6, 7], [6, 0], [-6, -7]] },   // 삼각형 (양극 쪽)
      { line: [[6, -7], [6, 7]] },                        // 막대 (음극 쪽)
      { line: [[6, 0], [20, 0]] },
    ],
  },
  params: [
    { key: "model", label: "Model name", unit: "", default: "DGEN" },
    { key: "is", label: "Sat. current", unit: "A", default: "1e-14" },
    { key: "n", label: "Emission coef.", unit: "", default: "1" },
  ],
  spice: {
    element: "D",
    template: "{ref} {a} {k} {model}",
    model: ".model {model} D(IS={is} N={n})",
  },
};

/**
 * 제너 다이오드. 다이오드에 항복 전압(BV)과 그때의 전류(IBV)를 더한 일반 모델이다.
 * 거꾸로 쓴다 — 음극(K)을 높은 쪽에 두면 K-A 사이가 BV 근처에 묶인다.
 * 음극 막대의 양 끝을 꺾어 보통 다이오드와 갈리게 그린다.
 */
export const ZENER: LibPart = {
  id: "zener", name: "Zener diode", category: "Analog", refPrefix: "D",
  symbol: {
    pins: [{ id: "a", name: "A", at: [-20, 0] }, { id: "k", name: "K", at: [20, 0] }],
    graphics: [
      { line: [[-20, 0], [-6, 0]] },
      { poly: [[-6, -7], [-6, 7], [6, 0], [-6, -7]] },
      { line: [[6, -7], [6, 7]] },
      { line: [[6, -7], [3, -9]] }, { line: [[6, 7], [9, 9]] },
      { line: [[6, 0], [20, 0]] },
    ],
  },
  params: [
    { key: "model", label: "Model name", unit: "", default: "DZGEN" },
    { key: "bv", label: "Breakdown voltage", unit: "V", default: "5.1" },
    { key: "ibv", label: "Current at BV", unit: "A", default: "1m" },
    { key: "is", label: "Sat. current", unit: "A", default: "1e-14" },
    { key: "n", label: "Emission coef.", unit: "", default: "1" },
  ],
  spice: {
    element: "D",
    template: "{ref} {a} {k} {model}",
    model: ".model {model} D(IS={is} N={n} BV={bv} IBV={ibv})",
  },
};

/**
 * BJT. 수직으로 놓고 베이스가 왼쪽이다 (C 위, E 아래).
 * NPN 은 이미터 화살표가 밖으로, PNP 는 베이스 쪽으로 향한다.
 */
const bjtGraphics = (npn: boolean): Shape[] => [
  { line: [[-20, 0], [-8, 0]] },
  { line: [[-8, -8], [-8, 8]] },                 // 베이스 막대
  { line: [[-8, -5], [0, -12]] }, { line: [[0, -12], [0, -20]] },
  { line: [[-8, 5], [0, 12]] }, { line: [[0, 12], [0, 20]] },
  npn ? arrow([0, 12], [-8, 5]) : arrow([-8, 5], [0, 12]),
  { circle: { c: [-2, 0], r: 14 } },
];

const bjt = (id: string, name: string, kind: "NPN" | "PNP", model: string): LibPart => ({
  id, name, category: "Analog", refPrefix: "Q",
  symbol: {
    pins: [
      { id: "c", name: "C", at: [0, -20] },
      { id: "b", name: "B", at: [-20, 0] },
      { id: "e", name: "E", at: [0, 20] },
    ],
    graphics: bjtGraphics(kind === "NPN"),
  },
  params: [
    { key: "model", label: "Model name", unit: "", default: model },
    { key: "is", label: "Sat. current", unit: "A", default: "1e-16" },
    { key: "bf", label: "Current gain βF", unit: "", default: "100" },
  ],
  spice: {
    element: "Q",
    template: "{ref} {c} {b} {e} {model}",
    model: `.model {model} ${kind}(IS={is} BF={bf})`,
  },
});

export const NPN = bjt("npn", "NPN transistor", "NPN", "QNGEN");
export const PNP = bjt("pnp", "PNP transistor", "PNP", "QPGEN");

/**
 * MOSFET (level 1). 게이트가 왼쪽, 드레인 위, 소스 아래.
 *
 * 몸통(bulk)은 핀으로 빼지 않고 넷리스트에서 소스에 묶는다. 낱개 부품은 실제로
 * 그렇게 만들어져 있고, 몸통을 0 에 묶으면 소스가 접지가 아닐 때 기판 효과가 끼거나
 * (PMOS 는) 아예 틀린 회로가 된다. 설계서 표는 네 번째 노드를 0 으로 적었지만
 * 같은 줄이 핀을 D·G·S·B 로 적어 둬서, 둘 중 맞는 쪽을 골랐다.
 */
const mosGraphics = (nmos: boolean): Shape[] => [
  { line: [[-20, 0], [-12, 0]] },
  { line: [[-12, -10], [-12, 10]] },             // 게이트 막대
  // 채널 (증가형이라 끊어 그린다)
  { line: [[-6, -10], [-6, -4]] }, { line: [[-6, -2], [-6, 2] ] }, { line: [[-6, 4], [-6, 10]] },
  { line: [[-6, -7], [0, -7]] }, { line: [[0, -7], [0, -20]] },
  { line: [[-6, 7], [0, 7]] }, { line: [[0, 7], [0, 20]] },
  // 몸통 화살표 — 소스에 묶여 있다는 표시로 소스 쪽 선까지 잇는다
  { line: [[-6, 0], [0, 0]] }, { line: [[0, 0], [0, 7]] },
  nmos ? arrow([-6, 0], [0, 0]) : arrow([0, 0], [-6, 0]),
];

const mos = (id: string, name: string, kind: "NMOS" | "PMOS", model: string, vto: string): LibPart => ({
  id, name, category: "Analog", refPrefix: "M",
  symbol: {
    pins: [
      { id: "d", name: "D", at: [0, -20] },
      { id: "g", name: "G", at: [-20, 0] },
      { id: "s", name: "S", at: [0, 20] },
    ],
    graphics: mosGraphics(kind === "NMOS"),
  },
  params: [
    { key: "model", label: "Model name", unit: "", default: model },
    { key: "vto", label: "Threshold", unit: "V", default: vto },
    { key: "kp", label: "Transconductance", unit: "A/V²", default: "20u" },
    /*
     * 채널 길이 변조. 0 으로 두면 포화 영역의 출력 저항이 무한대라, CMOS 인버터처럼
     * 이득이 무한인 자리에서 해가 정해지지 않는다 — DC 스윕이 전환점에서 -5e6 V 로
     * 튄다. 교과서 값을 기본으로 둬서 전달 특성이 제대로 그려지게 한다.
     */
    { key: "lambda", label: "Ch. modulation", unit: "1/V", default: "0.02" },
    { key: "w", label: "Ch. width", unit: "m", default: "100u" },
    { key: "l", label: "Ch. length", unit: "m", default: "10u" },
  ],
  spice: {
    element: "M",
    // 네 번째 노드가 몸통이다. 소스와 같은 노드로 적는다
    template: "{ref} {d} {g} {s} {s} {model} W={w} L={l}",
    model: `.model {model} ${kind}(VTO={vto} KP={kp} LAMBDA={lambda})`,
  },
});

export const NMOS = mos("nmos", "NMOS", "NMOS", "MNGEN", "2");
export const PMOS = mos("pmos", "PMOS", "PMOS", "MPGEN", "-2");

/*
 * SKY130 공정 소자.
 *
 * 위의 일반 MOS 는 교과서 수식(레벨 1)이라 전달 특성의 모양만 맞는다. 이쪽은 SkyWater
 * 130 nm 공정의 **실제 BSIM4 카드**다 — 엔진 번들에 같이 들어 있는 모델 파일을 쓴다.
 *
 * 소자가 아니라 **서브회로**라서 줄이 `X` 로 시작하고 노드가 넷이다(d g s b). 우리 심볼은
 * 핀이 D·G·S 뿐이라 몸통은 일반 MOS 와 같이 소스에 묶는다.
 *
 * W·L 은 **미터**다. 모델 파일의 `.option scale` 이 주석이라 숫자가 그대로 미터로 읽힌다.
 * 기본값 1.26u / 0.15u 는 bin 0 (L 145~155 n, W 1.255~1.265 u) 한가운데다 — 범위를 벗어난
 * 값을 넣으면 ngspice 가 맞는 bin 을 못 찾아 'no such model' 로 죽는다.
 */
const sky = (id: string, name: string, sub: string, nmosShape: boolean): LibPart => ({
  id, name, category: "SKY130", refPrefix: "X",
  symbol: {
    pins: [
      { id: "d", name: "D", at: [0, -20] },
      { id: "g", name: "G", at: [-20, 0] },
      { id: "s", name: "S", at: [0, 20] },
    ],
    graphics: mosGraphics(nmosShape),
  },
  params: [
    { key: "w", label: "Ch. width", unit: "m", default: "1.26u" },
    { key: "l", label: "Ch. length", unit: "m", default: "0.15u" },
    /** 핑거 수. 넓은 소자를 여러 갈래로 나눠 그린 것과 같다 */
    { key: "nf", label: "Fingers", unit: "", default: "1" },
    /** 병렬로 몇 개인가 */
    { key: "mult", label: "Multiplier", unit: "", default: "1" },
  ],
  spice: {
    element: "X",
    // 네 번째 노드가 몸통이다. 소스와 같은 노드로 적는다.
    // 배수는 m= 이다 — ngspice 가 서브회로를 그만큼 병렬로 둔다. 모델의 mult 는 미스매치 통계(sqrt(l*w*mult))에만
    // 쓰이고 소자를 곱하지 않는다: mult= 만 적으면 배수 4 도 한 개로 돈다. 통계가 맞게 둘 다 적는다
    template: `{ref} {d} {g} {s} {s} ${sub} W={w} L={l} nf={nf} mult={mult} m={mult}`,
  },
});

export const SKY130_NFET = sky("sky130_nfet", "SKY130 nFET 1.8 V", "sky130_fd_pr__nfet_01v8", true);
export const SKY130_PFET = sky("sky130_pfet", "SKY130 pFET 1.8 V", "sky130_fd_pr__pfet_01v8", false);
export const SKY130_PFET_HVT =
  sky("sky130_pfet_hvt", "SKY130 pFET HVT", "sky130_fd_pr__pfet_01v8_hvt", false);

/** 이 부품은 SKY130 모델 파일이 있어야 돈다. 넷리스트와 워커가 같이 본다 */
export const SKY130_IDS = ["sky130_nfet", "sky130_pfet", "sky130_pfet_hvt"];


/** GND 는 넷리스트에 줄을 내지 않는다. 닿은 넷이 노드 0 이 될 뿐이다 */
export const GND: LibPart = {
  id: "gnd", name: "Ground", category: "Symbols", refPrefix: "GND",
  symbol: {
    pins: [{ id: "1", name: "1", at: [0, 0] }],
    graphics: [
      { line: [[0, 0], [0, 8]] },
      { line: [[-8, 8], [8, 8]] },
      { line: [[-5, 12], [5, 12]] },
      { line: [[-2, 16], [2, 16]] },
    ],
  },
  params: [],
};

export const BUILTIN: Record<string, LibPart> = {
  r: RESISTOR, pot: POTENTIOMETER, c: CAPACITOR, cpol: CAPACITOR_POL, l: INDUCTOR,
  xfmr: TRANSFORMER, tline: TLINE,
  vsin: VSIN, vdc: VDC, vpulse: VPULSE, vpwl: VPWL,
  idc: IDC, isin: ISIN, ipulse: IPULSE,
  vcvs: VCVS, vccs: VCCS, ccvs: CCVS, cccs: CCCS,
  opamp: OPAMP, comparator: COMPARATOR, vswitch: VSWITCH, mult: MULTIPLIER, bv: BEHAVIORAL,
  d: DIODE, zener: ZENER, npn: NPN, pnp: PNP, nmos: NMOS, pmos: PMOS,
  gnd: GND,
  sky130_nfet: SKY130_NFET, sky130_pfet: SKY130_PFET, sky130_pfet_hvt: SKY130_PFET_HVT,
};

/** 부품을 처음 놓을 때 정의 사본을 프로젝트 라이브러리에 넣는다 */
export function ensureInLibrary(library: Record<string, LibPart>, libId: string): LibPart {
  if (!library[libId]) library[libId] = structuredClone(BUILTIN[libId]);
  return library[libId];
}

/** 기본 파라미터 값 */
export function defaultParams(lib: LibPart): Record<string, string> {
  return Object.fromEntries(lib.params.map(p => [p.key, p.default]));
}
