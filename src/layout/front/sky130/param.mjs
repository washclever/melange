/** SKY130 원시 소자 변수 — ALIGN-pdk-sky130 의 SKY130_PDK/gen_param.py 의 JS 판.
 *
 *  원시 소자(SubCircuit) 하나를 받아 셀 생성기에 줄 인자를 만들고, 모양(x_cells x y_cells)이 다른
 *  변형들을 primitives 에 더한다: "<이름>_X<x>_Y<y>".
 *
 *    MOS   W 를 핀 수(NFIN)로, NF x M 을 단위 셀 수로. 단위 셀 수의 약수 쌍이 변형이 된다
 *          (12 개가 넘으면 가로세로비 0.5, 1, 2 에 가까운 셋만). 비가 다른 거울 쌍은 그 비를 정확히
 *          나타내는 열 수만 남긴다.
 *    CAP / RES  아직 옮기지 않았다 (SKY130 예제와 melange 회로의 트랜지스터만 다룬다)
 *
 *  파이썬과 같게: 변형 쌍은 파이썬 집합 순서로 돈다 (PySet), 소자 변수 dict 는 제자리에서 바뀐다
 *  (NFIN 이 정수로, PARALLEL > 1 이면 M 이 M x PARALLEL 로).
 */
import { PySet, pyCmp, pyEq } from "../py.mjs";

/** int(str) — 파이썬처럼 정수 모양만 받는다 */
export function pyInt(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`int(${v})`);
    return Math.trunc(v);
  }
  const s = String(v).trim();
  if (!/^[+-]?\d+(_\d+)*$/.test(s)) throw new Error(`not an integer: ${JSON.stringify(v)}`);
  return Number(s.replace(/_/g, ""));
}

/** float(str) */
export function pyFloat(v) {
  if (typeof v === "number") return v;
  const s = String(v).trim().replace(/_/g, "");
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) throw new Error(`not a number: ${JSON.stringify(v)}`);
  return Number(s);
}

const deepcopy = (x) => structuredClone(x);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** 가로세로비를 셋으로 줄인다 (쌍이 12 개를 넘을 때) */
function limitPairs(pairs) {
  const list = [...pairs];
  if (list.length <= 12) return pairs;
  const out = [];
  for (const l of [-0.3, 0, 0.3]) {
    let best = null;
    for (const [x, y] of list) {
      const key = [Math.abs(Math.log10(y) - Math.log10(x) - l), [x, y]];
      if (best == null || pyCmp(key, best) < 0) best = key;
    }
    out.push(best[1]);
  }
  return out;
}

/**
 * add_primitive — 변형을 primitives(삽입 순서가 있는 객체)에 더한다.
 * @param {Record<string, any>} primitives
 */
export function addPrimitive(primitives, blockName, blockArgs) {
  if (has(primitives, blockName)) {
    // ALIGN 은 다르면 경고만 한다
    return;
  }
  if (has(blockArgs, "x_cells") && has(blockArgs, "y_cells")) {
    const x = blockArgs.x_cells, y0 = blockArgs.y_cells;
    let pairs = new PySet();
    const m = x * y0;
    const ySqrt = Math.floor(Math.sqrt(x * y0));
    for (let y = ySqrt; y > 0; y--) {
      if (m % y === 0) {
        pairs.add([y, Math.floor(m / y)]);
        pairs.add([Math.floor(m / y), y]);
      }
      if (y === 1) break;
    }
    pairs = limitPairs(pairs);
    const mv = blockArgs.parameters || {};
    if (Object.keys(mv).length === 2) {
      const fpair = Object.values(mv).map((v) => pyInt(v.NF ?? 1) * pyInt(v.M ?? 1));
      if (fpair[0] !== fpair[1]) {
        const tot = fpair[0] + fpair[1], fs = Math.min(...fpair);
        const ok = [...pairs].filter(([nx]) => (nx * fs) % tot === 0 && nx * fs >= tot);
        pairs = ok.length ? ok : [[blockArgs.x_cells, blockArgs.y_cells]];
      }
    }
    for (const [nx, ny] of pairs) {
      const cn = `${blockName}_X${nx}_Y${ny}`;
      if (has(primitives, cn)) continue;
      const p = deepcopy(blockArgs);
      p.x_cells = nx;
      p.y_cells = ny;
      p.abstract_template_name = blockName;
      p.concrete_template_name = cn;
      primitives[cn] = p;
    }
  } else {
    primitives[blockName] = blockArgs;
    blockArgs.abstract_template_name = blockName;
    blockArgs.concrete_template_name = blockName;
  }
}

/**
 * gen_param(subckt, primitives, pdk_dir)
 * @param {{name:string, generator:{name:string}, elements:Array<{name:string, model:string, parameters:Record<string,any>}>}} subckt
 * @param {Record<string, any>} primitives
 * @param {{design_info: object}} pdk
 */
export function genParam(subckt, primitives, pdk) {
  const blockName = subckt.name;
  const generatorName = subckt.generator.name;
  const design = pdk.design_info;
  if (generatorName === "CAP" || generatorName === "RES")
    throw new Error(`${blockName}: ${generatorName} cells are not supported yet (transistors only)`);
  if (!generatorName.includes("MOS")) throw new Error(`unknown generator ${generatorName}`);

  let vt = [];
  if (design.vt_type) vt = design.vt_type.map((v) => v.toUpperCase()).filter((v) => subckt.elements[0].model.includes(v));
  /** @type {Record<string, Record<string, any>>} */
  const mvalues = {};
  for (const e of subckt.elements) mvalues[e.name] = e.parameters;
  const names = Object.keys(mvalues);
  const dev = names[0];

  let size;
  for (const key of names) {
    const W = pyFloat(mvalues[key].W);
    if (Math.trunc(W * 1e9) % design.Fin_pitch !== 0)
      throw new Error(`${blockName}, ${key}: W is not a multiple of the fin pitch (${design.Fin_pitch} nm) (${mvalues[key].W})`);
    size = Math.trunc((W * 1e9) / design.Fin_pitch);
    mvalues[key].NFIN = size;
  }
  if (has(mvalues[dev], "NF")) {
    for (const key of names) {
      if (!pyInt(mvalues[key].NF)) throw new Error(`${key}: bad NF ${mvalues[key].NF}`);
      if (pyInt(mvalues[key].NF) % 2 !== 0) throw new Error(`${blockName}, ${key}: NF must be even (${mvalues[key].NF})`);
    }
  }
  if (has(mvalues[dev], "M")) {
    for (const key of names) {
      if (!pyInt(mvalues[key].M)) throw new Error(`${key}: bad M ${mvalues[key].M}`);
      if (has(mvalues[key], "PARALLEL") && pyInt(mvalues[key].PARALLEL) > 1) {
        mvalues[key].PARALLEL = pyInt(mvalues[key].PARALLEL);
        mvalues[key].M = pyInt(mvalues[key].M) * mvalues[key].PARALLEL;
      }
    }
    size = 0;
  }

  let xval, yval;
  for (const key of names) {
    if (pyInt(mvalues[dev].NFIN) !== pyInt(mvalues[key].NFIN)) throw new Error(`${blockName}: the devices must have the same W`);
    if (!has(mvalues[key], "NF") || !has(mvalues[key], "M")) throw new Error(`${blockName}, ${key}: NF and M are required`);
    size += pyInt(mvalues[key].NF) * pyInt(mvalues[key].M);
  }
  const noUnits = Math.ceil(size / (2 * names.length));
  let squareY = ["DP", "_S"].some((s) => blockName.includes(s)) && Math.floor(Math.sqrt(noUnits / 3)) >= 1
    ? Math.floor(Math.sqrt(noUnits / 3)) : Math.floor(Math.sqrt(noUnits));
  if (squareY === 0) throw new Error(`${blockName}: no unit cell`);
  while (noUnits % squareY !== 0) squareY--;
  yval = squareY;
  xval = Math.trunc(noUnits / squareY);

  if (names.length === 2) {
    const f0 = pyInt(mvalues[names[0]].NF) * pyInt(mvalues[names[0]].M);
    const f1 = pyInt(mvalues[names[1]].NF) * pyInt(mvalues[names[1]].M);
    if (f0 !== f1) {
      // 비가 다른 거울 쌍: x_cells 가 단위 셀 총수를 그대로 갖게 한다
      yval = 1;
      xval = Math.ceil(size / 2);
    }
  }

  const blockArgs = { primitive: "MOS", value: mvalues[dev].NFIN, x_cells: xval, y_cells: yval, parameters: mvalues };
  if (has(mvalues[dev], "STACK") && pyInt(mvalues[dev].STACK) > 1) blockArgs.stack = pyInt(mvalues[dev].STACK);
  if (vt.length) blockArgs.vt_type = vt[0];
  addPrimitive(primitives, blockName, blockArgs);
  return true;
}

export { pyEq };
