/**
 * ALIGN 예제의 테스트벤치 — 열고 Run 을 누르면 바로 돈다. 데모(src/lib/demos.ts)처럼 해석 · 프로브 · 계산기 줄을 같이 둔다.
 *
 * ALIGN 의 예제는 회로만 있다 (전원 · 입력 · 해석이 없다). 여기서 SKY130 1.8 V 로 바이어스를 다시 잡았다: 전류로 바이어스하는
 * 핀(다이오드로 묶인 트랜지스터의 드레인)에는 전류원, 게이트만 닿는 핀에는 전압원, 출력에는 부하. 테스트벤치는 원래
 * 서브회로의 핀에만 닿는다 — 레이아웃은 테스트벤치가 없을 때와 같다.
 *
 * L 이 150 nm (ALIGN 의 SKY130 셀) 라 소자 하나의 이득 gm·ro 가 10 안팎이다 — 한 단 증폭기의 이득이 20 dB 남짓인 까닭이다.
 *
 * 계산기 줄의 소자 이름은 회로도의 것이다 ("X" + 넷리스트의 이름, 계층은 _ 로 이어 붙인다: XI0_MN0). 해석의 source 에 "@넷" 을
 * 적으면 그 넷에 단 전원의 이름이 된다. 전원 전압원은 늘 V1 이다 (가장 먼저 놓는다).
 * tools/e2e-layout-examples.ts 가 예제마다 이 줄들을 엔진으로 돌려 값이 나오고 기대한 범위에 드는지 본다 (CHECKS).
 */
import type { Bench } from "./build.ts";

/**
 * 열린 이득을 재는 단일 출력 OTA: 출력을 반전 입력으로 DC 만 되먹인다 (1 GΩ, 반전 입력에서 접지로 1 F). DC 에서는
 * 폴로어라 출력이 입력의 공통 모드에 앉고 (되먹임 없이 열어 두면 두 거울 길의 어긋남이 출력을 레일로 민다), 1 Hz 위에서는
 * 반전 입력이 AC 로 접지라 열린 이득이다.
 */
const DC_FEEDBACK = (out: string, inn: string, cl: string) => [
  { net: out, lib: "c" as const, value: cl },
  { net: out, lib: "r" as const, value: "1G", to: inn },
  { net: inn, lib: "c" as const, value: "1" },
];
const AC = (fstart: string, fstop: string) => ({ kind: "ac" as const, sweep: "dec" as const, points: "20", fstart, fstop });
const TRAN = (tstop: string, tmax: string) => ({ kind: "tran" as const, tstop, tmax, tstart: "0" });
/** 클럭: 10 ns 주기, 4 ns 동안 높다 (1 ns 에 처음 오른다) */
const CLK = { v1: "0", v2: "1.8", td: "1n", tr: "50p", tf: "50p", pw: "4n", per: "10n" };
/** 입력을 +10 mV -> -10 mV 로 (데모의 StrongARM 과 같다): 7.5 ns 에 바뀐다 */
const STEP10 = (cm: number) => ({ v1: (cm + 0.01).toFixed(2), v2: (cm - 0.01).toFixed(2), td: "7.5n", tr: "100p", tf: "100p", pw: "10n", per: "20n" });

export const BENCHES: Record<string, Bench> = {
  five_transistor_ota: {
    sources: [
      { net: "vip", lib: "vdc", params: { dc: "1.1", ac: "1" } },
      { net: "vbias", lib: "vdc", params: { dc: "0.75", ac: "0" } },
    ],
    loads: DC_FEEDBACK("von", "vin", "1p"),
    sim: AC("1k", "10G"),
    probes: ["von"],
    calc: [
      "bode = db20(v(von)/v(vip))",
      "phi = phase(v(von)/v(vip))",
      "a0 = dcgain(v(von)/v(vip))",
      "gm(XMN2)/(gds(XMN2) + gds(XMP4))   # by hand: gm1·(ro2 ‖ ro4)",
      "fu = ugf(v(von)/v(vip))",
      "gm(XMN2)/(2*pi*1pF)   # by hand: gm1/CL",
      "pm(v(von)/v(vip))",
      "gmid(XMN2)   # input pair gm/ID",
      "satmargin(XMN1)   # tail VDS − VDS,sat: positive is saturated",
      "id(XMN1)   # tail current",
    ],
    roles: { out: "von", "in": "vip", inp: "vip", inn: "vin", m: "XMN2", m2: "XMP4" },
  },

  five_transistor_ota_high_frequency: {
    sources: [
      { net: "vinp_ota", lib: "vdc", params: { dc: "1.1", ac: "1" } },
      { net: "id_ota", lib: "idc", params: { dc: "20u", ac: "0" } },
    ],
    loads: DC_FEEDBACK("vout_ota", "vinn_ota", "100f"),
    sim: AC("1k", "100G"),
    probes: ["vout_ota"],
    calc: [
      "bode = db20(v(vout_ota)/v(vinp_ota))",
      "phi = phase(v(vout_ota)/v(vinp_ota))",
      "a0 = dcgain(v(vout_ota)/v(vinp_ota))",
      "gm(XM1)/(gds(XM1) + gds(XM5))   # by hand: gm1·(ro1 ‖ ro5)",
      "fu = ugf(v(vout_ota)/v(vinp_ota))",
      "gm(XM1)/(2*pi*100fF)   # by hand: gm1/CL — the wide devices add their own capacitance, so fu is lower",
      "pm(v(vout_ota)/v(vinp_ota))",
      "gmid(XM1)   # input pair gm/ID",
      "ft(XM1)   # input pair fT",
      "id(XM2)/id(XM3)   # tail mirror ratio",
    ],
    roles: { out: "vout_ota", "in": "vinp_ota", inp: "vinp_ota", inn: "vinn_ota", m: "XM1", m2: "XM5" },
  },

  common_source: {
    sources: [{ net: "vin", lib: "vdc", params: { dc: "0.9", ac: "0" } }],
    sim: { kind: "dc", source: "@vin", start: "0", stop: "1.8", step: "0.01" },
    probes: ["vop"],
    calc: [
      "gain = deriv(v(vop))",
      "avpk = ymin(gain)   # steepest slope (inverting)",
      "value(gain, 1.0)",
      "value(-gm(XMN0)/(gm(XMP0) + gds(XMP0) + gds(XMN0)), 1.0)   # by hand: the diode load is 1/gm2",
      "vm = cross(v(vop) - v(vin), 0)   # switching point, where vop = vin",
      "swing(v(vop), 0.5)   # output range where the gain stays above half its peak",
      "value(id(XMN0), 1.0)   # bias current at vin = 1 V",
    ],
    roles: { out: "vop", "in": "vin", m: "XMN0", m2: "XMP0" },
  },

  telescopic_ota: {
    sources: [
      { net: "vinp", lib: "vdc", params: { dc: "1.0", ac: "1" } },
      { net: "vinn", lib: "vdc", params: { dc: "1.0", ac: "0" } },
      { net: "id", lib: "idc", params: { dc: "50u", ac: "0" } },
      { net: "vbiasn", lib: "vdc", params: { dc: "1.3", ac: "0" } },
      { net: "vbiasp1", lib: "vdc", params: { dc: "0.7", ac: "0" } },
      // 출력 공통 모드 되먹임 (이상적인 CMFB): 두 출력의 평균이 0.9 V 보다 높으면 pFET 전류원의 게이트를 올린다
      { net: "vbiasp2", lib: "bv", params: { value: "1.0 + 10*((v(voutp) + v(voutn))/2 - 0.9)" } },
    ],
    loads: [{ net: "voutp", lib: "c", value: "500f" }, { net: "voutn", lib: "c", value: "500f" }],
    sim: AC("1k", "10G"),
    probes: ["voutp", "voutn"],
    calc: [
      "h = (v(voutp) - v(voutn))/v(vinp)   # differential output over the input",
      "bode = db20(h)",
      "phi = phase(h)",
      "a0 = dcgain(h)",
      "gm(XM3)/(gds(XM3)*gds(XM5)/(gm(XM5) + gmb(XM5)) + gds(XM9)*gds(XM7)/(gm(XM7) + gmb(XM7)))   # by hand: gm1·(Rdown ‖ Rup), R ≈ (gm + gmb)·ro²",
      "fu = ugf(h)",
      "gm(XM3)/(2*pi*500fF)   # by hand: gm1/CL",
      "pm(h)",
      "satmargin(XM5)   # n cascode: positive is saturated",
      "satmargin(XM7)   # p cascode",
      "id(XM2)   # tail current",
    ],
    roles: { out: "voutn", outp: "voutp", outn: "voutn", "in": "vinp", inp: "vinp", inn: "vinn", m: "XM3", m2: "XM5" },
  },

  telescopic_ota_with_bias: {
    sources: [
      { net: "vinp", lib: "vdc", params: { dc: "1.0", ac: "1" } },
      { net: "d1", lib: "idc", params: { dc: "20u", ac: "0" } },
    ],
    loads: DC_FEEDBACK("vout", "vinn", "1p"),
    sim: AC("1k", "10G"),
    probes: ["vout"],
    calc: [
      "bode = db20(v(vout)/v(vinp))",
      "phi = phase(v(vout)/v(vinp))",
      "a0 = dcgain(v(vout)/v(vinp))",
      "fu = ugf(v(vout)/v(vinp))",
      "gm(XM0)/(2*pi*1pF)   # by hand: gm1/CL (the input device is a stack of two)",
      "pm(v(vout)/v(vinp))",
      "id(XM4)   # tail current",
      "id(XM4)/20uA   # tail over the 20 µA into d1",
      "satmargin(XM8)   # n cascode at the output",
      "satmargin(XM7)   # p cascode at the output",
    ],
    roles: { out: "vout", "in": "vinp", inp: "vinp", inn: "vinn", m: "XM0", m2: "XM4" },
  },

  current_mirror_ota: {
    sources: [
      { net: "vinp", lib: "vdc", params: { dc: "1.0", ac: "1" } },
      { net: "id", lib: "idc", params: { dc: "20u", ac: "0" } },
    ],
    loads: DC_FEEDBACK("voutp", "vinn", "1p"),
    sim: AC("1k", "10G"),
    probes: ["voutp"],
    calc: [
      "bode = db20(v(voutp)/v(vinp))",
      "phi = phase(v(voutp)/v(vinp))",
      "a0 = dcgain(v(voutp)/v(vinp))",
      "mirror = id(XM18)/id(XM19)   # current gain B of the output mirror",
      "fu = ugf(v(voutp)/v(vinp))",
      "gm(XM15)*mirror/(2*pi*1pF)   # by hand: B·gm1/CL",
      "pm(v(voutp)/v(vinp))",
      "gmid(XM15)   # input pair gm/ID",
      "id(XM16)   # tail current",
    ],
    roles: { out: "voutp", "in": "vinp", inp: "vinp", inn: "vinn", m: "XM19", m2: "XM18" },
  },

  cascode_current_mirror_ota: {
    sources: [
      { net: "vinp", lib: "vdc", params: { dc: "1.0", ac: "1" } },
      { net: "id", lib: "idc", params: { dc: "20u", ac: "0" } },
      // 캐스코드 게이트: 넷리스트는 다이오드 둘을 쌓아 만든다 (FinFET 의 낮은 문턱에 맞춘 것). SKY130 의 문턱(0.7 V)으로는
      // 너무 높게 서서 캐스코드가 선형으로 빠진다 — 전압으로 준다
      { net: "vbiasn", lib: "vdc", params: { dc: "1.1", ac: "0" } },
      { net: "vbiasp", lib: "vdc", params: { dc: "0.6", ac: "0" } },
    ],
    loads: DC_FEEDBACK("voutp", "vinn", "1p"),
    sim: AC("1k", "10G"),
    probes: ["voutp"],
    calc: [
      "bode = db20(v(voutp)/v(vinp))",
      "phi = phase(v(voutp)/v(vinp))",
      "a0 = dcgain(v(voutp)/v(vinp))",
      "mirror = id(XM18)/id(XM19)   # current gain B of the output mirror",
      "fu = ugf(v(voutp)/v(vinp))",
      "gm(XM15)*mirror/(2*pi*1pF)   # by hand: B·gm1/CL",
      "pm(v(voutp)/v(vinp))",
      "satmargin(XM25)   # n cascode at the output: positive is saturated",
      "satmargin(XM23)   # p cascode at the output",
      "id(XM16)   # tail current",
    ],
    roles: { out: "voutp", "in": "vinp", inp: "vinp", inn: "vinn", m: "XM19", m2: "XM18" },
  },

  high_speed_comparator: {
    sources: [
      { net: "clk", lib: "vpulse", params: CLK },
      { net: "vip", lib: "vpulse", params: STEP10(1.0) },
      { net: "vin", lib: "vdc", params: { dc: "1.0", ac: "0" } },
    ],
    loads: [{ net: "vop", lib: "c", value: "20f" }, { net: "von", lib: "c", value: "20f" }],
    sim: TRAN("20n", "10p"),
    probes: ["clk", "vop", "von"],
    calc: [
      "d = v(vop) - v(von)",
      "value(d, 4.5n)   # vip − vin = +10 mV",
      "value(d, 14.5n)   # vip − vin = −10 mV",
      "value(v(vop) + v(von), 0.9n)   # reset: both outputs low",
      "t1 = delay(v(clk), abs(d), rise, rise, 0.9, 0.9)   # clock to decision, +10 mV",
      "t2 = delay(clip(v(clk), 10n, 20n), clip(abs(d), 10n, 20n), rise, rise, 0.9, 0.9)   # −10 mV: the same, the circuit is symmetric",
      "p = mean(power(V1))",
      "p*period(v(clk))   # energy per decision",
    ],
    roles: { out: "vop", outp: "vop", outn: "von", "in": "vip", inp: "vip", inn: "vin", ctrl: "clk", m: "XMN1", m2: "XMN2" },
  },

  double_tail_sense_amplifier: {
    sources: [
      { net: "clk", lib: "vpulse", params: CLK },
      { net: "clk_b", lib: "vpulse", params: { ...CLK, v1: "1.8", v2: "0" } },
      { net: "vip", lib: "vpulse", params: STEP10(1.0) },
      { net: "vin", lib: "vdc", params: { dc: "1.0", ac: "0" } },
    ],
    loads: [{ net: "vop", lib: "c", value: "20f" }, { net: "von", lib: "c", value: "20f" }],
    sim: TRAN("20n", "10p"),
    probes: ["clk", "vop", "von"],
    calc: [
      "d = v(vop) - v(von)",
      "value(d, 4.5n)   # vip − vin = +10 mV",
      "value(d, 14.5n)   # vip − vin = −10 mV",
      "value(v(vop) + v(von), 0.9n)   # reset: both outputs low",
      "t1 = delay(v(clk), abs(d), rise, rise, 0.9, 0.9)   # clock to decision, +10 mV",
      "t2 = delay(clip(v(clk), 10n, 20n), clip(abs(d), 10n, 20n), rise, rise, 0.9, 0.9)   # −10 mV",
      "ymax(clip(abs(v(din) - v(dip)), 1n, 1.5n))   # first stage: the difference it hands the latch",
      "p = mean(power(V1))",
      "p*period(v(clk))   # energy per decision",
    ],
    roles: { out: "vop", outp: "vop", outn: "von", "in": "vip", inp: "vip", inn: "vin", ctrl: "clk", m: "XMIN_P", m2: "XMIN_N" },
  },

  comparator1: {
    sources: [
      { net: "cki", lib: "vpulse", params: CLK },
      { net: "ap", lib: "vpulse", params: STEP10(1.0) },
      { net: "an", lib: "vdc", params: { dc: "1.0", ac: "0" } },
      { net: "bp", lib: "vdc", params: { dc: "1.0", ac: "0" } },
      { net: "bn", lib: "vdc", params: { dc: "1.0", ac: "0" } },
    ],
    loads: [{ net: "op", lib: "c", value: "10f" }, { net: "on", lib: "c", value: "10f" }],
    sim: TRAN("20n", "10p"),
    probes: ["cki", "op", "on", "rdy"],
    calc: [
      "d = v(op) - v(on)",
      "value(d, 4.5n)   # ap − an = +10 mV",
      "value(d, 14.5n)   # ap − an = −10 mV",
      "value(v(rdy), 0.9n)   # reset: not ready",
      "tdec = delay(v(cki), abs(d), rise, rise, 0.9, 0.9)   # clock to decision",
      "trdy = delay(v(cki), v(rdy), rise, rise, 0.9, 0.9)   # clock to ready (the NAND of op and on)",
      "p = mean(power(V1))",
      "p*period(v(cki))   # energy per decision",
    ],
    roles: { out: "op", outp: "op", outn: "on", "in": "ap", inp: "ap", inn: "an", ctrl: "cki", m: "XI1_M7", m2: "XI1_M5" },
  },

  inverter_current_starved: {
    pins: ["clk"],
    sources: [
      { net: "vin", lib: "vpulse", params: { v1: "0", v2: "1.8", td: "1n", tr: "50p", tf: "50p", pw: "5n", per: "10n" } },
      { net: "vip", lib: "vpulse", params: { v1: "0", v2: "1.8", td: "1n", tr: "50p", tf: "50p", pw: "5n", per: "10n" } },
      // 전류를 조이는 pFET 의 게이트 (넷리스트에서는 핀이 아니라 비어 있다 — 여기서 핀으로 낸다)
      { net: "clk", lib: "vdc", params: { dc: "0.8", ac: "0" } },
    ],
    loads: [{ net: "vop", lib: "c", value: "20f" }, { net: "von", lib: "c", value: "20f" }],
    sim: TRAN("20n", "10p"),
    probes: ["vin", "vop", "von"],
    calc: [
      "tp = delay(v(vin), v(vop), fall, rise, 0.9, 0.9)   # plain inverter, pull-up",
      "ts = delay(v(vip), v(von), fall, rise, 0.9, 0.9)   # starved pull-up",
      "ts/tp   # how much the starving slows the rising edge",
      "delay(v(vip), v(von), rise, fall, 0.9, 0.9)   # pull-down, not starved",
      "ymax(abs(id(XMMP3)))   # peak current through the starving pFET",
    ],
    roles: { out: "von", "in": "vip", ctrl: "clk", m: "XMMP3", m2: "XMMN1" },
  },

  ring_oscillator: {
    sources: [
      // 단의 전원 — 0 에서 1 ns 동안 올려 링을 깨운다 (모두 같은 전압에서 시작하면 고르게 선 채 서 있을 수 있다)
      { net: "vctl", lib: "vpulse", params: { v1: "0", v2: "1.8", td: "0", tr: "1n", tf: "1n", pw: "1", per: "2" } },
    ],
    sim: TRAN("30n", "5p"),
    probes: ["vo"],
    calc: [
      "f = freq(clip(v(vo), 10n, 30n), 0.9)   # after start-up",
      "1/(2*5*f)   # stage delay: f = 1/(2·N·td), N = 5",
      "duty(clip(v(vo), 10n, 30n))",
      "pp(clip(v(vo), 10n, 30n))   # swing",
      "p = mean(power(V2), 10n, 30n)",
      "p/f   # energy per cycle",
    ],
    roles: { out: "vo", ctrl: "vctl", m: "XI0_MN0", m2: "XI0_MP0" },
  },

  vco_type2_65: {
    sources: [
      { net: "o<1>", lib: "vpulse", params: { v1: "0", v2: "1.8", td: "2n", tr: "50p", tf: "50p", pw: "10n", per: "20n" } },
      { net: "vbias", lib: "vdc", params: { dc: "0.5", ac: "0" } },
    ],
    sim: TRAN("40n", "10p"),
    probes: ["o<1>", "o<2>", "op<1>"],
    calc: [
      "t8 = delay(v(o<1>), v(op<1>), rise, rise, 0.9, 0.9)   # 8 stages",
      "t8/8   # mean stage delay",
      "delay(v(o<1>), v(o<2>), rise, fall, 0.9, 0.9)   # one stage, pull-down",
      "delay(v(o<1>), v(o<2>), fall, rise, 0.9, 0.9)   # one stage, pull-up through vbias",
      "risetime(v(o<5>))",
      "falltime(v(o<5>))",
    ],
    roles: { out: "op<1>", "in": "o<1>", ctrl: "vbias" },
  },

  linear_equalizer: {
    // 소스 사이의 열화 (degeneration): R 길(s0, R3 + R4)과 C 길(s3, C3 · C4). 넷리스트의 C 는 치수(w=Csw)라 1 pF 로 두고,
    // R 은 100 Ω 에서 500 Ω 으로 — FinFET 의 gm 에 맞춘 100 Ω 으로는 SKY130 의 gm 에서 끌어올림이 1 dB 도 안 된다
    values: { C3: "1p", C4: "1p", R3: "500", R4: "500" },
    sources: [
      { net: "vin1", lib: "vdc", params: { dc: "1.2", ac: "1" } },
      { net: "vin2", lib: "vdc", params: { dc: "1.2", ac: "0" } },
      { net: "vmirror_ctle", lib: "idc", params: { dc: "500u", ac: "0" } },
      { net: "s0_ctle", lib: "vdc", params: { dc: "1.8", ac: "0" } },
      { net: "s3_ctle", lib: "vdc", params: { dc: "1.8", ac: "0" } },
    ],
    loads: [{ net: "vout_ctle1", lib: "c", value: "50f" }, { net: "vout_ctle2", lib: "c", value: "50f" }],
    sim: AC("1meg", "100G"),
    probes: ["vout_ctle1", "vout_ctle2"],
    calc: [
      "h = (v(vout_ctle2) - v(vout_ctle1))/v(vin1)   # differential output over the input",
      "bode = db20(h)",
      "phi = phase(h)",
      "a0 = dcgain(h)",
      "fz = 1/(2*pi*1kohm*0.5pF)   # by hand: the degeneration zero — R3 + R4 against C3 in series with C4",
      "peaking(h)",
      "ymax(abs(h))/a0   # boost",
      "f3db(h)",
    ],
    roles: { out: "vout_ctle2", outp: "vout_ctle2", outn: "vout_ctle1", "in": "vin1", inp: "vin1", inn: "vin2" },
  },

  variable_gain_amplifier: {
    sources: [
      { net: "vin1", lib: "vdc", params: { dc: "1.2", ac: "1" } },
      { net: "vin2", lib: "vdc", params: { dc: "1.2", ac: "0" } },
      { net: "vmirror_vga", lib: "idc", params: { dc: "400u", ac: "0" } },
      // 이득 단계: 켠 조각(s0 ~ s3)만큼 입력쌍이 늘어 이득이 오른다 — 둘이면 3.6 dB, 넷 다 켜면 9 dB
      { net: "s0", lib: "vdc", params: { dc: "1.8", ac: "0" } },
      { net: "s1", lib: "vdc", params: { dc: "1.8", ac: "0" } },
      { net: "s2", lib: "vdc", params: { dc: "0", ac: "0" } },
      { net: "s3", lib: "vdc", params: { dc: "0", ac: "0" } },
    ],
    loads: [{ net: "vout_vga1", lib: "c", value: "50f" }, { net: "vout_vga2", lib: "c", value: "50f" }],
    sim: AC("1meg", "100G"),
    probes: ["vout_vga1", "vout_vga2"],
    calc: [
      "h = (v(vout_vga2) - v(vout_vga1))/v(vin1)   # differential output over the input",
      "bode = db20(h)",
      "phi = phase(h)",
      "a0 = dcgain(h)",
      "(gm(XM00) + gm(XM10))/(1/400ohm + gds(XM00) + gds(XM10))   # by hand: slices 0 and 1 are on, (gm0 + gm1)·(RL ‖ ro)",
      "gm(XM20)   # slice 2 is off (s2 = 0 V)",
      "f3db(h)",
      "gbw(h)",
    ],
    roles: { out: "vout_vga2", outp: "vout_vga2", outn: "vout_vga1", "in": "vin1", inp: "vin1", inn: "vin2", m: "XM00", m2: "XM10" },
  },

  single_to_differential_converter: {
    values: { C0: "10p", C1: "10p", C2: "10p" },
    sources: [
      { net: "vin", lib: "vdc", params: { dc: "0", ac: "1" } },
      { net: "vb", lib: "vdc", params: { dc: "1.0", ac: "0" } },
    ],
    loads: [{ net: "vout_sdc1", lib: "r", value: "10k" }, { net: "vout_sdc2", lib: "r", value: "10k" }],
    sim: AC("1k", "10G"),
    probes: ["vout_sdc1", "vout_sdc2"],
    calc: [
      "g1 = db20(v(vout_sdc1)/v(vin))",
      "g2 = db20(v(vout_sdc2)/v(vin))",
      "value(g1, 10meg)",
      "value(g2, 10meg)",
      "value(phase(v(vout_sdc1)/v(vout_sdc2)), 10meg)   # opposite phase",
      "value(db20((v(vout_sdc1) - v(vout_sdc2))/v(vin)), 10meg)   # differential gain",
      "1/(2*pi*20kohm*10pF)   # by hand: the input high-pass, C0 into the 20 kΩ bias resistor",
      "value(g1, 100k)   # below it",
    ],
    roles: { out: "vout_sdc1", outp: "vout_sdc1", outn: "vout_sdc2", "in": "vin" },
  },

  unity_gain_buffers: {
    // 기준 전압을 받아 그대로 내는 DC 버퍼 둘 (보상이 없어 계단에는 LS 쪽이 출렁인다 — DC 로 본다). HS 의 입력을 쓸어
    // 올리며 출력이 기울기 1 로 따라가는지, LS 는 0.6 V 에 둔 채 그 오차를 본다
    sources: [
      { net: "vbias_an", lib: "vdc", params: { dc: "0.8", ac: "0" } },
      { net: "vref_hs", lib: "vdc", params: { dc: "1.2", ac: "0" } },
      { net: "vref_ls", lib: "vdc", params: { dc: "0.6", ac: "0" } },
    ],
    // 출력단은 한쪽으로만 민다 (HS 는 pFET 이 위로, LS 는 nFET 이 아래로) — 반대쪽은 부하가 당긴다
    loads: [{ net: "vo_hs", lib: "r", value: "20k" }, { net: "vo_ls", lib: "r", value: "20k", to: "vcc" }],
    sim: { kind: "dc", source: "@vref_hs", start: "0.8", stop: "1.6", step: "0.01" },
    probes: ["vref_hs", "vo_hs", "vo_ls"],
    calc: [
      "e = v(vo_hs) - v(vref_hs)",
      "value(e, 1.2)   # high-side error at 1.2 V",
      "slope(v(vo_hs), 1.2)   # unity gain",
      "value(v(vo_ls) - v(vref_ls), 1.2)   # low-side error at 0.6 V",
      "swing(v(vo_hs), 0.9)   # input range over which the high side follows",
    ],
    roles: { out: "vo_hs", "in": "vref_hs" },
  },

  powertrain_binary: {
    // on_d[k] 은 낮을 때 켜진다 (pFET). 10 ns 마다 코드가 하나씩 오른다: 비트 k 는 주기 2^(k+1) × 10 ns
    sources: [0, 1, 2, 3, 4, 5].map((k) => ({
      net: `on_d[${k}]`, lib: "vpulse" as const,
      params: { v1: "1.8", v2: "0", td: `${10 * 2 ** k}n`, tr: "100p", tf: "100p", pw: `${10 * 2 ** k - 0.1}n`, per: `${20 * 2 ** k}n` },
    })),
    // 가벼운 부하 (1 kΩ) — 스위치가 선형 영역에 있어야 저항으로 읽힌다
    loads: [{ net: "vout", lib: "r", value: "1k" }],
    sim: TRAN("640n", "1n"),
    probes: ["vout"],
    calc: [
      "r = (1.8 - v(vout))*1k/v(vout)",
      "value(r, 15n)   # code 1: one cell",
      "value(r, 25n)   # code 2",
      "value(r, 85n)   # code 8",
      "value(r, 635n)   # code 63: all cells",
      "value(r, 15n)/value(r, 635n)   # one cell over all of them (63 if the switches were ideal)",
    ],
    roles: { out: "vout" },
  },
};
