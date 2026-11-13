/**
 * 성능지표 본보기 — Razavi, "Design of Analog CMOS Integrated Circuits" (2판) 의 장을 따라 묶었다.
 *
 * 하나하나가 **고칠 수 있는 식**이다. 고르면 계산기 줄로 들어가고, 거기서부터는 여느 식과 같다 —
 * 넷 이름을 바꾸든 구간을 좁히든 다른 식에 끼워 넣든 사용자의 몫이다. 틀을 씌운 '측정 항목' 으로
 * 만들면 책에 없는 조합(차동 출력의 THD, 두 실행의 이득 비 …)을 못 잰다.
 *
 * 식 안의 {out} · {in} · {m} 같은 자리는 **이 회로에 실제로 있는 이름**으로 채운다 (hints).
 * 이름을 지어내면 첫 줄부터 '그런 넷 없음' 이 뜨고, 그게 본보기 탓인지 회로 탓인지 알 수 없다 —
 * 측정(.meas) 본보기를 회로의 넷 이름으로 채우는 것과 같은 이유다.
 *
 * 절 번호는 2판의 것이다. 정의가 책 안에서도 둘인 것(THD: 식 (14.10) 은 전력 비인데 바로 아래
 * 본문의 0.01 % = −80 dB 는 진폭 비다)은 doc 에 어느 쪽인지 적었다.
 */

export type Kind = "tran" | "op" | "dc" | "ac" | "noise" | "tf";

export interface Metric {
  /** 줄에 붙일 이름 (`a0 = …`). 겹치면 번호를 붙인다 */
  name: string;
  title: string;
  expr: string;
  /** 이 식이 뜻을 갖는 해석. 비었으면 실행 결과를 안 쓴다 (상수 계산) */
  needs: readonly Kind[];
  doc: string;
}

export interface Chapter {
  title: string;
  /** 책의 장 번호와 이름 */
  ref: string;
  metrics: Metric[];
}

const DEV: readonly Kind[] = ["op", "dc", "tran", "ac"];
const AC: readonly Kind[] = ["ac"];
const DC: readonly Kind[] = ["dc"];
const TRAN: readonly Kind[] = ["tran"];
const NOISE: readonly Kind[] = ["noise"];

export const CHAPTERS: Chapter[] = [
  {
    title: "MOS device", ref: "Ch. 2 · Basic MOS Device Physics",
    metrics: [
      { name: "gm", title: "Transconductance gm", expr: "gm({m})", needs: DEV,
        doc: "gm = ∂ID/∂VGS at the operating point (§2.2.3). On a DC sweep or a transient it is a curve." },
      { name: "ro", title: "Output resistance rO", expr: "ro({m})", needs: DEV,
        doc: "rO = 1/gds ≈ 1/(λ·ID), from channel-length modulation (§2.3, §2.4.3)." },
      { name: "av0", title: "Intrinsic gain gm·rO", expr: "gmro({m})", needs: DEV,
        doc: "The largest voltage gain a single transistor provides (§2.4.3, §3.3.3)." },
      { name: "vov", title: "Overdrive VGS − VTH", expr: "vov({m})", needs: DEV,
        doc: "The overdrive voltage; with the square law gm = 2·ID/(VGS − VTH). PMOS values are magnitudes." },
      { name: "vth", title: "Threshold voltage", expr: "vth({m})", needs: DEV,
        doc: "VTH at this bias, body effect included (§2.2.1, §2.3)." },
      { name: "sat", title: "Saturation margin VDS − VDS,sat", expr: "satmargin({m})", needs: DEV,
        doc: "Positive: the device is saturated. Negative: it is in the triode region (§2.2.2)." },
      { name: "eta", title: "Body-effect ratio gmb/gm", expr: "gmb({m})/gm({m})", needs: DEV,
        doc: "η = gmb/gm (§2.3). It sets how far a source follower's gain falls below 1." },
      { name: "cgg", title: "Gate capacitance", expr: "cgg({m})", needs: DEV,
        doc: "Total gate capacitance CGS + CGD + CGB (§2.4.2). Also cgs(), cgd(), cgb()." },
      { name: "ft", title: "Transit frequency fT", expr: "ft({m})", needs: DEV,
        doc: "fT = gm/(2π·Cgg): the frequency at which the small-signal current gain is unity (Problem 2.13; ≈ gm/(2π·CGS))." },
    ],
  },
  {
    title: "Single-stage amplifiers", ref: "Ch. 3 · Single-Stage Amplifiers",
    metrics: [
      { name: "av", title: "Gain across the input range", expr: "deriv(v({out}))", needs: DC,
        doc: "Av = ∂Vout/∂Vin, the slope of the DC transfer curve (§3.3.1). Sweep the input source with a DC sweep." },
      { name: "avpk", title: "Peak small-signal gain", expr: "ymax(abs(deriv(v({out}))))", needs: DC,
        doc: "The steepest slope of the transfer curve." },
      { name: "avq", title: "Gain at a bias point", expr: "slope(v({out}), {xmid})", needs: DC,
        doc: "The slope at one input voltage — edit the second argument to your bias." },
      { name: "swing", title: "Output swing", expr: "swing(v({out}), 0.5)", needs: DC,
        doc: "How far the output moves while the gain stays above half its peak (§3.3, §9.6). Tighten 0.5 toward 1 for a stricter range." },
      { name: "av_tf", title: "Gain (.tf)", expr: "tf_gain", needs: ["tf"],
        doc: "Small-signal DC gain from a transfer-function analysis." },
      { name: "rin", title: "Input resistance (.tf)", expr: "tf_rin", needs: ["tf"],
        doc: "Resistance seen by the input source (§3.2)." },
      { name: "rout", title: "Output resistance (.tf)", expr: "tf_rout", needs: ["tf"],
        doc: "Resistance seen looking into the output node (§3.2)." },
    ],
  },
  {
    title: "Differential amplifiers", ref: "Ch. 4 · Differential Amplifiers",
    metrics: [
      { name: "vod", title: "Differential output", expr: "v({outp},{outn})", needs: ["tran", "dc", "ac"],
        doc: "Vout1 − Vout2 (§4.1). v(a,b) is the difference of two nets." },
      { name: "adm", title: "Differential gain", expr: "dcgain(v({outp},{outn})/v({inp},{inn}))", needs: AC,
        doc: "ADM at low frequency (§4.2.2)." },
      { name: "cmrr", title: "CMRR (two kept runs)", expr: "db20(dcgain(dm.v({out})) / dcgain(cm.v({out})))", needs: AC,
        doc: "CMRR = |ADM/ACM|, eq. (4.55). Run an AC analysis with a differential input and Keep it as dm; " +
          "put the same AC signal on both inputs, run again and Keep it as cm." },
      { name: "vos", title: "Input offset", expr: "cross(v({outp},{outn}), 0)", needs: DC,
        doc: "The differential input at which the two outputs are equal, on a DC sweep of the input (§14.2)." },
      { name: "vicm", title: "Input range of a buffer", expr: "swing(v({out}), 0.9)", needs: DC,
        doc: "Sweep the input of a unity-gain buffer: the note gives the input range over which the gain stays within 10 % of its peak (§4.2.1, §9.8)." },
    ],
  },
  {
    title: "Current mirrors", ref: "Ch. 5 · Current Mirrors and Biasing Techniques",
    metrics: [
      { name: "ratio", title: "Copy ratio", expr: "id({m2})/id({m})", needs: DEV,
        doc: "Iout/IREF (§5.1). It departs from the W/L ratio when the two VDS differ." },
      { name: "rmir", title: "Mirror output resistance", expr: "1/slope(id({m2}), {xmid})", needs: DC,
        doc: "1/(∂Iout/∂Vout): sweep the voltage across the mirror's output (§5.2)." },
      { name: "vmin", title: "Compliance voltage", expr: "vdsat({m2})", needs: DEV,
        doc: "The output must stay above VDS,sat for the mirror to hold its current (§5.2)." },
    ],
  },
  {
    title: "Frequency response", ref: "Ch. 6 · Frequency Response of Amplifiers",
    metrics: [
      { name: "bode", title: "Bode magnitude", expr: "db20(v({out})/v({in}))", needs: AC,
        doc: "20·log10|H|. Dividing by v(in) keeps it right when the source's AC magnitude is not 1." },
      { name: "phi", title: "Bode phase", expr: "phase(v({out})/v({in}))", needs: AC,
        doc: "Phase in degrees, unwrapped so it runs past −180° without a jump." },
      { name: "a0", title: "Low-frequency gain A0", expr: "dcgain(v({out})/v({in}))", needs: AC,
        doc: "|H| at the first frequency of the sweep." },
      { name: "f3db", title: "−3 dB bandwidth", expr: "f3db(v({out})/v({in}))", needs: AC,
        doc: "Where |H| has fallen 3 dB below A0 — the dominant pole of a one-pole circuit (§6.1.2)." },
      { name: "fu", title: "Unity-gain frequency", expr: "ugf(v({out})/v({in}))", needs: AC,
        doc: "fu: where |H| falls through 1 (§9.1.1)." },
      { name: "gbw", title: "Gain-bandwidth product", expr: "gbw(v({out})/v({in}))", needs: AC,
        doc: "A0·f−3dB (§6.7). For a one-pole circuit it equals fu." },
      { name: "zin", title: "Input impedance", expr: "mag(v({in})/-i({vin}))", needs: AC,
        doc: "|Zin| seen by the input source, over frequency. i() of a voltage source flows into its + pin, hence the minus." },
    ],
  },
  {
    title: "Noise", ref: "Ch. 7 · Noise",
    metrics: [
      { name: "sout", title: "Output noise density", expr: "onoise", needs: NOISE,
        doc: "√(Vn,out²) in V/√Hz (§7.1.1). From a noise analysis." },
      { name: "sin", title: "Input-referred noise density", expr: "inoise", needs: NOISE,
        doc: "The output noise divided by the gain from the input source (§7.3)." },
      { name: "vnout", title: "Total output noise", expr: "rmsnoise(onoise)", needs: NOISE,
        doc: "√(∫ Vn,out² df) over the sweep, eq. (7.145). Add a band: rmsnoise(onoise, 20, 20k)." },
      { name: "vnin", title: "Input-referred RMS noise", expr: "rmsnoise(onoise)/ymax(onoise/inoise)", needs: NOISE,
        doc: "Integrate at the output, then divide by the mid-band gain — integrating the input-referred density instead diverges (§7.9)." },
      { name: "fc", title: "1/f corner frequency", expr: "fcorner(inoise)", needs: NOISE,
        doc: "Where flicker and thermal noise are equal (§7.2.2, Fig. 7.27)." },
      { name: "floor", title: "Thermal noise floor", expr: "ymin(inoise)", needs: NOISE,
        doc: "The flat part of the input-referred density." },
      { name: "bn", title: "Noise bandwidth", expr: "enbw(onoise)", needs: NOISE,
        doc: "Bn with V0²·Bn = ∫ Vn,out² df, eq. (7.146). A one-pole circuit gives π/2 times its pole (§7.8)." },
      { name: "snr", title: "Signal-to-noise ratio", expr: "snr(1/sqrt(2), rmsnoise(onoise))", needs: NOISE,
        doc: "SNR for a 1 V-amplitude sine (§7.1.4). Replace 1/sqrt(2) with your signal's RMS." },
      { name: "ktc", title: "kT/C noise", expr: "sqrt(kb*tnom/1pF)", needs: [],
        doc: "Total RMS noise of an RC circuit, and what a sampling switch leaves on its capacitor (§7.2.1, §13.2.3). Edit 1pF to your capacitor." },
      { name: "vnr", title: "Resistor thermal noise", expr: "sqrt(4*kb*tnom*1kohm)", needs: [],
        doc: "√(4kTR) in V/√Hz (§7.2.1). Edit 1kohm to your resistor." },
    ],
  },
  {
    title: "Feedback", ref: "Ch. 8 · Feedback",
    metrics: [
      { name: "acl", title: "Closed-loop gain", expr: "dcgain(v({out})/v({in}))", needs: AC,
        doc: "A/(1 + βA) (§8.1.1). Compare with 1/β to read the gain error." },
      { name: "t", title: "Loop gain (Middlebrook)", expr: "middlebrook(-tv.v(r)/tv.v(f), -ti.i(Vr)/ti.i(Vf))", needs: AC,
        doc: "§8.7: break nothing — inject a voltage in series with the loop (Keep as tv) and a current into the same point " +
          "(Keep as ti), and combine the two return ratios. Replace r, f, Vr, Vf with your return and forward nets and sense sources." },
      { name: "rcl", title: "Closed-loop output resistance (.tf)", expr: "tf_rout", needs: ["tf"],
        doc: "Feedback divides (voltage sensing) or multiplies (current sensing) the open-loop value by 1 + βA (§8.2)." },
    ],
  },
  {
    title: "Operational amplifiers", ref: "Ch. 9 · Operational Amplifiers",
    metrics: [
      { name: "a0", title: "Open-loop gain", expr: "dcgain(v({out})/v({in}))", needs: AC,
        doc: "§9.1.1. The result shows the ratio and dB." },
      { name: "fu", title: "Unity-gain bandwidth", expr: "ugf(v({out})/v({in}))", needs: AC,
        doc: "The small-signal bandwidth fu (§9.1.1)." },
      { name: "sr", title: "Slew rate", expr: "ymax(abs(deriv(v({out}))))", needs: TRAN,
        doc: "The slope of the ramp while the op amp slews (§9.9): the steepest slope of a large step. slewrate() gives the 10–90 % average instead." },
      { name: "ts", title: "Settling time (1 %)", expr: "settling(v({out}), 1)", needs: TRAN,
        doc: "Time to stay within 1 % of the final value (Example 9.2). A third argument sets the start time — the instant of the input step." },
      { name: "os", title: "Overshoot", expr: "overshoot(v({out}))", needs: TRAN,
        doc: "How far the step response passes its final value, as a fraction of the step (§10.3)." },
      { name: "swing", title: "Output swing", expr: "swing(v({out}), 0.5)", needs: DC,
        doc: "§9.6: the output range over which the gain holds up, on a DC sweep of the input." },
      { name: "psrr", title: "PSRR (two kept runs)", expr: "db20(dcgain(sig.v({out})) / dcgain(sup.v({out})))", needs: AC,
        doc: "Gain from the input divided by gain from the supply (§9.11). Run with AC on the input and Keep as sig; move the AC to the supply, run and Keep as sup." },
      { name: "pdd", title: "Power dissipation", expr: "mean(power({supply}))", needs: ["op", "tran", "dc"],
        doc: "Power delivered by the supply source (§9.1.1 trade-offs)." },
      { name: "idd", title: "Supply current", expr: "mean(-i({supply}))", needs: ["op", "tran", "dc"],
        doc: "Current drawn from the supply. i() of a voltage source flows into its + pin, hence the minus." },
    ],
  },
  {
    title: "Stability", ref: "Ch. 10 · Stability and Frequency Compensation",
    metrics: [
      { name: "pm", title: "Phase margin", expr: "pm(v({out})/v({in}))", needs: AC,
        doc: "PM = 180° + ∠βH at the gain crossover (§10.3). Give the loop gain — or the open-loop gain when β = 1." },
      { name: "gmg", title: "Gain margin", expr: "gainmargin(v({out})/v({in}))", needs: AC,
        doc: "How far |βH| is below 1 where the phase reaches −180° (§10.1)." },
      { name: "gx", title: "Gain crossover", expr: "ugf(v({out})/v({in}))", needs: AC,
        doc: "GX: where |βH| = 1 (§10.1)." },
      { name: "px", title: "Phase crossover", expr: "pcross(v({out})/v({in}))", needs: AC,
        doc: "PX: where ∠βH = −180° (§10.1). Stability needs GX below PX." },
      { name: "pk", title: "Closed-loop peaking", expr: "peaking(v({out})/v({in}))", needs: AC,
        doc: "Peaking of the closed-loop response: about 30 % (2.3 dB) at PM = 45°, none at 60° (§10.3)." },
    ],
  },
  {
    title: "Nanometer design", ref: "Ch. 11 · Nanometer Design Studies",
    metrics: [
      { name: "gmid", title: "gm/ID", expr: "gmid({m})", needs: DEV,
        doc: "Transconductance efficiency (§11.3, §11.4). 2/(VGS − VTH) for a square-law device." },
      { name: "jd", title: "Current density ID/W", expr: "id({m})/w({m})", needs: DEV,
        doc: "In A/m, which reads the same as µA/µm (§11.4)." },
      { name: "vdsmin", title: "VDS,min", expr: "vdsat({m})", needs: DEV,
        doc: "The smallest VDS that keeps the device saturated (§11.4.1)." },
      { name: "gmro", title: "Intrinsic gain vs bias", expr: "gmro({m})", needs: ["dc", "op"],
        doc: "On a DC sweep: how gm·rO changes with the swept voltage (§11.2)." },
    ],
  },
  {
    title: "Bandgap references", ref: "Ch. 12 · Bandgap References",
    metrics: [
      { name: "tc", title: "Temperature coefficient", expr: "tc(v({ref}))", needs: DC,
        doc: "(max − min)/(mean·ΔT) in ppm/°C over a temperature sweep — set the DC sweep's source to temp (§12.3)." },
      { name: "tc27", title: "TC at 27 °C", expr: "tc(v({ref}), 27)", needs: DC,
        doc: "(1/V)·∂V/∂T at one temperature, in ppm/°C." },
      { name: "vref", title: "Reference at 27 °C", expr: "value(v({ref}), 27)", needs: DC,
        doc: "The output at room temperature (§12.3.3)." },
      { name: "ptat", title: "PTAT slope", expr: "slope(v({ref}), 27)", needs: DC,
        doc: "∂V/∂T in V/°C: ≈ +0.087 mV/K per ln(n) for ΔVBE, ≈ −1.5 mV/K for VBE (§12.3)." },
      { name: "line", title: "Supply sensitivity", expr: "slope(v({ref}), {xmid})", needs: DC,
        doc: "∂Vref/∂VDD on a DC sweep of the supply (§12.2)." },
    ],
  },
  {
    title: "Switched-capacitor circuits", ref: "Ch. 13 · Introduction to Switched-Capacitor Circuits",
    metrics: [
      { name: "smp", title: "Sampled values", expr: "sample(v({out}), {tstep})", needs: TRAN,
        doc: "The output at regular instants. sample(w, step, from, to): set step to the clock period and from to the first sampling instant." },
      { name: "ts01", title: "Settling to 0.1 %", expr: "settling(v({out}), 0.1)", needs: TRAN,
        doc: "The time an amplifier needs each phase (§13.3.1). A third argument sets the start of the phase." },
      { name: "ped", title: "Hold pedestal", expr: "value(v({out}), {thalf}) - value(v({in}), {tq})", needs: TRAN,
        doc: "Charge injection and clock feedthrough: the held output minus the input at the sampling instant (§13.2.3). Edit the two times." },
      { name: "ron", title: "Switch on-resistance", expr: "ro({m})", needs: ["op", "dc", "tran"],
        doc: "1/gds of a switch in the triode region (§13.2.1); Ron·CH is the tracking time constant (§13.2.2)." },
      { name: "ktc", title: "kT/C noise", expr: "sqrt(kb*tnom/1pF)", needs: [],
        doc: "RMS noise left on the sampling capacitor (§13.2.3). Edit 1pF." },
    ],
  },
  {
    title: "Nonlinearity and mismatch", ref: "Ch. 14 · Nonlinearity and Mismatch",
    metrics: [
      { name: "nl", title: "Nonlinearity", expr: "nonlin(v({out}))", needs: DC,
        doc: "The largest deviation from the straight line through the end points, over the output span (§14.1.1, Fig. 14.4). Add a range: nonlin(w, x1, x2)." },
      { name: "thd", title: "Total harmonic distortion", expr: "thd(v({out}))", needs: TRAN,
        doc: "√(ΣAk²)/A1 for k ≥ 2 — the amplitude ratio; its square is the power ratio of eq. (14.10). Drive the input with a sine." },
      { name: "hd2", title: "HD2", expr: "hd(v({out}), 2)", needs: TRAN,
        doc: "Second harmonic over the fundamental. A differential circuit cancels it (§14.1.2)." },
      { name: "hd3", title: "HD3", expr: "hd(v({out}), 3)", needs: TRAN,
        doc: "Third harmonic over the fundamental; grows as the square of the amplitude (§14.1.1)." },
      { name: "spec", title: "Spectrum (dB)", expr: "db20(fft(v({out})))", needs: TRAN,
        doc: "Amplitude of each frequency in dBV. fft(w, from, to, n, window) — use a span of whole periods." },
      { name: "sfdr", title: "SFDR", expr: "sfdr(v({out}))", needs: TRAN,
        doc: "The fundamental over the largest harmonic, in dB." },
      { name: "vos", title: "Input offset", expr: "cross(v({outp},{outn}), 0)", needs: DC,
        doc: "The input that brings the differential output to zero (§14.2.1)." },
    ],
  },
  {
    title: "Oscillators", ref: "Ch. 15 · Oscillators",
    metrics: [
      { name: "fosc", title: "Oscillation frequency", expr: "freq(v({out}))", needs: TRAN,
        doc: "1/period, averaged over the cycles in the run (§15.1). Start the saved span after start-up for a cleaner value." },
      { name: "td", title: "Ring stage delay", expr: "period(v({out}))/(2*3)", needs: TRAN,
        doc: "fosc = 1/(2·N·TD) for an N-stage ring (§15.2). Edit 3 to your number of stages." },
      { name: "amp", title: "Amplitude", expr: "pp(v({out}))/2", needs: TRAN,
        doc: "Half the peak-to-peak swing." },
      { name: "duty", title: "Duty cycle", expr: "duty(v({out}))", needs: TRAN,
        doc: "Fraction of each period spent above the midpoint." },
      { name: "fvst", title: "Frequency over time", expr: "instfreq(v({out}))", needs: TRAN,
        doc: "1/period at each rising edge: start-up, and tuning when the control voltage moves." },
      { name: "kvco", title: "VCO gain (two kept runs)", expr: "(freq(b.v({out})) - freq(a.v({out}))) / 0.1", needs: TRAN,
        doc: "KVCO = Δf/ΔVcont, eq. (15.55), in Hz/V. Keep one run as a, raise the control voltage by 0.1 V, run and Keep as b." },
    ],
  },
  {
    title: "Phase-locked loops", ref: "Ch. 16 · Phase-Locked Loops",
    metrics: [
      { name: "tlock", title: "Lock time", expr: "settling(v({ctrl}), 1)", needs: TRAN,
        doc: "Time for the control voltage to stay within 1 % of its final value (§16.1.3)." },
      { name: "fout", title: "Output frequency over time", expr: "instfreq(v({out}))", needs: TRAN,
        doc: "The loop pulling the oscillator toward lock." },
      { name: "jit", title: "RMS period jitter", expr: "jitter(v({out}))", needs: TRAN,
        doc: "The standard deviation of the periods (§16.3.2)." },
      { name: "jpp", title: "Peak-to-peak period jitter", expr: "pp(periods(v({out})))", needs: TRAN,
        doc: "Longest minus shortest period. Clip to the locked part first: periods(clip(v(out), t1, t2))." },
      { name: "perr", title: "Phase error", expr: "delay(v({in}), v({out}), rise, rise)/period(v({in}))*360", needs: TRAN,
        doc: "Skew between reference and feedback edges, in degrees of the reference period (§16.1.1)." },
      { name: "rip", title: "Control-voltage ripple", expr: "pp(clip(v({ctrl}), {thalf}, {tstop}))", needs: TRAN,
        doc: "Ripple on the control line once locked (§16.3.1). Edit the span to the locked part." },
    ],
  },
  {
    title: "Short-channel effects", ref: "Ch. 17 · Short-Channel Effects and Device Models",
    metrics: [
      { name: "dibl", title: "DIBL", expr: "-slope(vth({m}), {xmid})", needs: DC,
        doc: "−∂VTH/∂VDS on a DC sweep of the drain voltage (§17.2.1)." },
      { name: "gmv", title: "gm vs gate voltage", expr: "gm({m})", needs: DC,
        doc: "On a DC sweep of VGS: gm stops rising linearly once the mobility degrades and the velocity saturates (§17.2.2, §17.2.3)." },
      { name: "rov", title: "rO vs drain voltage", expr: "ro({m})", needs: DC,
        doc: "On a DC sweep of VDS: the output impedance varies with VDS (§17.2.5)." },
    ],
  },
];

// ── 자리 채우기 ───────────────────────────────────────────────────────
/** 본보기를 채울 때 쓰는 회로의 이름들 */
export interface Names {
  /** 넷 이름 (소문자). 0 은 뺀다 */
  nets: readonly string[];
  /** 프로브를 꽂은 넷 */
  probed: readonly string[];
  /** MOSFET · BJT 의 이름 (회로도에서 보이는 지정자) */
  mos: readonly string[];
  bjt: readonly string[];
  /** 전압원: SPICE 이름, + 단자의 넷, 직류 전원인가, AC 크기가 0 이 아닌가 (모르면 비워 둔다) */
  vsrc: ReadonlyArray<{ name: string; net: string; dc: boolean; ac?: boolean }>;
  /** 다이오드, 그리고 i(이름) 으로 전류를 읽을 수 있는 그 밖의 소자 (인덕터 · 전류원 · 저항 …) */
  diodes?: readonly string[];
  currents?: readonly string[];
  /** 해석 설정에서 온 숫자 (SPICE 표기 글자). 없으면 본보기 값 */
  tstop?: number;
  sweep?: [number, number];
  /**
   * 회로가 스스로 밝힌 자리 (out · in · m …) — 이름으로 짐작하지 않고 이것을 쓴다. 레이아웃 예제처럼 넷 이름이 out · in 이
   * 아니고, in 으로 읽히는 넷(vin)이 반전 입력인 회로가 있다 (Project.calcRoles)
   */
  roles?: Readonly<Record<string, string>>;
}

/** 1.5e-3 -> "1.5m". 식에 넣을 숫자라 계산기 파서가 읽는 접미사만 쓴다 */
export function spiceNum(v: number): string {
  if (v === 0 || !Number.isFinite(v)) return "0";
  const a = Math.abs(v);
  const table: Array<[number, string]> = [[1e9, "g"], [1e6, "meg"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "u"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"]];
  for (const [k, s] of table) {
    if (a >= k * 0.9999) return String(Number((v / k).toPrecision(4))) + s;
  }
  return v.toExponential(3);
}

const pick = (nets: readonly string[], ...tests: RegExp[]): string | undefined => {
  for (const re of tests) {
    const hit = nets.find(n => re.test(n));
    if (hit) return hit;
  }
  return undefined;
};

/**
 * 자리마다 넣을 이름. 고르는 순서는 측정 본보기와 같다: 뜻이 분명한 이름(out · in · vdd) ->
 * 프로브 -> 이름 붙은 첫 넷. 숫자뿐인 넷(자동으로 붙은 이름)은 마지막 수단이다.
 */
export function hints(n: Names): Record<string, string> {
  const named = n.nets.filter(x => x !== "0" && !/^\d+$/.test(x));
  const all = named.length ? named : n.nets.filter(x => x !== "0");
  const out = pick(all, /^v?out$/, /^v?o$/) ?? n.probed.find(p => p !== "0") ?? pick(all, /out/) ?? all[0] ?? "out";
  /*
   * 신호원: 파형이 있는 전원(사인 · 펄스)이 먼저다. 전부 직류 전원이면 AC 크기가 0 이 아닌 것 — 바이어스와
   * 전원에 AC 0 을 적어 둔 회로(5T OTA 데모)에서는 그것이 입력이다. 전부 AC 를 싣고 있으면 가릴 수 없다.
   */
  const withAc = n.vsrc.filter(v => v.ac);
  const signal = n.vsrc.find(v => !v.dc) ?? (withAc.length && withAc.length < n.vsrc.length ? withAc[0] : undefined);
  const inn0 = pick(all, /^v?in$/, /^v?i$/, /^v?in_?p$/, /^v?inp$/) ?? (signal && signal.net !== "0" ? signal.net : undefined)
    ?? pick(all.filter(x => x !== out), /in/) ?? all.find(x => x !== out) ?? "in";
  const outp = pick(all, /^v?out_?p$/, /^v?o_?p$/, /^v?out_?plus$/, /^v?out1$/) ?? out;
  const outn = pick(all, /^v?out_?n$/, /^v?o_?n$/, /^v?out_?minus$/, /^v?out2$/) ?? "0";
  const inp = pick(all, /^v?in_?p$/, /^v?i_?p$/, /^v?in1$/) ?? inn0;
  const innn = pick(all, /^v?in_?n$/, /^v?i_?n$/, /^v?in2$/) ?? "0";
  const vdd = pick(all, /^a?vdd$/, /^vcc$/, /^v?supply$/, /vdd|vcc/) ?? "vdd";
  const supply = n.vsrc.find(v => v.net === vdd)?.name ?? n.vsrc.find(v => v.dc)?.name ?? n.vsrc[0]?.name ?? "V1";
  const vin = n.vsrc.find(v => v.net === inn0)?.name ?? signal?.name ?? n.vsrc.find(v => v.name !== supply)?.name ?? n.vsrc[0]?.name ?? "V1";
  const tstop = n.tstop ?? 5e-3;
  const [s0, s1] = n.sweep ?? [0, 5];
  const guessed: Record<string, string> = {
    out, in: inn0, outp, outn, inp, inn: innn, vdd, supply, vin,
    ref: pick(all, /^v?ref$/, /^v?bg$/, /ref|bg/) ?? out,
    ctrl: pick(all, /^v?c(on)?tr?l$/, /^vc$/, /ctrl|cont|tune/) ?? out,
    m: n.mos[0] ?? "M1",
    m2: n.mos[1] ?? n.mos[0] ?? "M2",
    q: n.bjt[0] ?? "Q1",
    tstop: spiceNum(tstop),
    thalf: spiceNum(tstop / 2),
    tq: spiceNum(tstop / 4),
    tstep: spiceNum(tstop / 20),
    xmid: spiceNum((s0 + s1) / 2),
  };
  // 회로가 밝힌 자리가 짐작보다 먼저다 (빈 값은 짐작을 남긴다)
  for (const [k, v] of Object.entries(n.roles ?? {})) if (v) guessed[k] = v;
  return guessed;
}

/** {자리} 를 채운다. 모르는 자리는 그대로 둔다 — 조용히 빈 글자가 되면 식이 다른 뜻이 된다 */
export function fill(expr: string, h: Record<string, string>): string {
  return expr.replace(/\{(\w+)\}/g, (all, k: string) => h[k] ?? all);
}

/** 이미 쓰인 이름을 피해 줄을 만든다: a0, a0_2, a0_3 … */
export function rowFor(m: Metric, h: Record<string, string>, taken: ReadonlySet<string>): string {
  let name = m.name;
  for (let i = 2; taken.has(name); i++) name = `${m.name}_${i}`;
  return `${name} = ${fill(m.expr, h)}`;
}
