/**
 * 엔진 결과 벡터를 파형 패널이 쓰는 형태로 바꾼다.
 *
 * 과도·DC 스윕은 실수 배열이 오지만 AC 해석은 {real, img} 객체가 온다.
 * 그걸 모르고 Float64Array.from 하면 전부 NaN 이 되어, 오류 하나 없이
 * 빈 그래프만 나온다. 조용히 틀리는 쪽이라 변환을 따로 떼어 검증한다.
 */

/** 엔진이 주는 한 벡터. 값은 실수이거나 복소수다 */
export interface RawVector {
  name: string;
  values: ArrayLike<number> | ArrayLike<{ real?: number; img?: number }>;
}

/**
 * 결과 한 줄기. AC 해석은 복소수를 돌려주므로 values 에는 **크기**를 담고
 * 위상은 따로 둔다. 과도·DC 는 실수라 phase 가 없다.
 */
export interface Trace {
  name: string;
  values: Float64Array;
  /** AC 해석일 때만. 도 단위 */
  phaseDeg?: Float64Array;
}

const isComplex = (v: unknown): v is { real?: number; img?: number } =>
  typeof v === "object" && v !== null;

/**
 * 복소수 여부는 **결과 전체로** 판정한다.
 *
 * ngspice 의 AC 결과는 한 묶음이 통째로 복소수다. 벡터마다 따로 보면
 * 입력처럼 허수부가 늘 0 인 줄기만 위상이 빠져서, 표에 v(out) 은 각도가 있고
 * v(in) 은 없는 이상한 모양이 된다. 점마다 보면 더 나빠서, 위상이 딱 180° 인
 * 점(허수부 0, 실수부 음수)의 크기가 음수로 나온다.
 */
export function toTraces(data: readonly RawVector[]): Trace[] {
  const anyComplex = data.some(d => {
    const raw = d.values as ArrayLike<unknown>;
    return !(raw instanceof Float64Array) && raw.length > 0 && isComplex(raw[0]);
  });

  return data.map(d => {
    const raw = d.values as ArrayLike<unknown>;
    if (raw instanceof Float64Array) return { name: d.name, values: raw };

    // 복소수 묶음이 아니면 실수 그대로. 부호를 지킨다
    if (!anyComplex) {
      const re = new Float64Array(raw.length);
      for (let i = 0; i < raw.length; i++) re[i] = Number(raw[i]);
      return { name: d.name, values: re };
    }

    const mag = new Float64Array(raw.length);
    const ph = new Float64Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i];
      const re = isComplex(v) ? (v.real ?? 0) : Number(v);
      const im = isComplex(v) ? (v.img ?? 0) : 0;
      mag[i] = Math.hypot(re, im);
      ph[i] = (Math.atan2(im, re) * 180) / Math.PI;
    }
    return { name: d.name, values: mag, phaseDeg: ph };
  });
}

/**
 * 전달 함수(.tf) 결과의 벡터 이름들에서 이득의 단위를 읽는다.
 *
 * 이득은 입출력이 무엇이냐에 따라 뜻이 다르다: 전압 -> 전압 · 전류 -> 전류는 비율, 전류원 입력에
 * 전압 출력은 Ω(트랜스저항), 전압원 입력에 전류 출력은 S(트랜스컨덕턴스). ngspice 는 그것을 이름으로만
 * 알려 준다 — 입력이 전류원이면 `i1#input_impedance`, 출력이 전류면 `v1#output_impedance`
 * (전압 출력은 `output_impedance_at_v(out)`).
 */
export function tfGainUnit(names: readonly string[]): string {
  const ks = names.map(n => n.toLowerCase());
  const srcI = ks.some(k => /^v\(i[^#]*#input_impedance\)$/.test(k));
  const outI = ks.some(k => k.endsWith("#output_impedance)"));
  return srcI && !outI ? "Ω" : !srcI && outI ? "S" : "";
}
