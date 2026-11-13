/**
 * 유리 표면 — 굴절까지 하는 쪽.
 *
 * `backdrop-filter: blur()` 만으로는 **서리 낀 유리**지 유리가 아니다. 블러는 픽셀을
 * 흐릴 뿐 **옮기지 않아서**, 진짜 유리의 특징인 가장자리 굴절(lensing)이 안 나온다.
 * 굴절은 SVG 의 feDisplacementMap 으로만 된다 — 변위 지도의 R·G 채널이 픽셀을
 * 가로·세로로 밀어 준다.
 *
 * 지도는 **둥근 사각형의 거리장(SDF)에서 뽑은 표면 법선**이다. 가운데는 (128,128) 로
 * 평평해 아무 일도 없고, 테두리로 갈수록 바깥을 향한 기울기가 커진다 — 가장자리에서만
 * 뒤 배경이 휘어, 유리판 가장자리가 두꺼워 보이는 그 느낌이 난다.
 *
 * 걸린 것들 (조사한 글들이 공통으로 짚는 함정):
 *  - 지도의 **알파는 255 여야 한다.** 크로미움이 PNG 를 알파로 미리 곱해 디코딩해서,
 *    알파 0 인 지도는 전부 0 으로 읽혀 화면이 통째로 밀린다.
 *  - 필터 영역을 요소 밖까지 넓히지 않으면 밀린 픽셀이 잘린다.
 *  - 크로미움은 **필터를 id 로 캐시한다.** 같은 id 로 내용을 바꿔도 옛 것이 남는다.
 *    크기가 바뀌면 새 id 로 만든다.
 *  - `backdrop-filter: url(#id)` 는 크로미움에서만 돈다. 사파리·파이어폭스는 블러까지만.
 */

export interface GlassOptions {
  /** 굴절이 생기는 가장자리 띠의 폭 (CSS px) */
  band?: number;
  /** 픽셀을 미는 세기 (CSS px) */
  strength?: number;
  /** 모서리 둥글기 (CSS px). 요소의 border-radius 와 맞춘다 */
  radius?: number;
}

/** 이 브라우저가 backdrop-filter 안에서 SVG 필터를 받아 주는가 */
export const canRefract = (): boolean => {
  try { return CSS.supports("backdrop-filter", "url(#_)"); } catch { return false; }
};

let host: SVGSVGElement | null = null;
let seq = 0;

function svgHost(): SVGSVGElement {
  if (host) return host;
  host = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  host.setAttribute("width", "0");
  host.setAttribute("height", "0");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:absolute;width:0;height:0;pointer-events:none";
  document.body.appendChild(host);
  return host;
}

/**
 * 둥근 사각형 가장자리의 변위 지도.
 *
 * 각 픽셀에서 테두리까지의 거리를 재고, 띠 안이면 바깥을 향한 단위 법선에 세기를 곱해
 * R·G 에 싣는다. 세기는 테두리에서 가장 크고 띠 안쪽에서 0 으로 떨어진다 —
 * 그래야 가운데의 회로도가 멀쩡하고 가장자리만 휜다.
 */
export function displacementMap(w: number, h: number, radius: number, band: number): string {
  /*
   * 긴 변을 256 으로 줄여 만든다. 지도는 부드러운 그림이라 늘려도 티가 안 나는데,
   * 원래 크기로 만들면 픽셀마다 거리장을 네 번 재느라 큰 패널에서 수십 ms 가 걸린다.
   */
  const k = Math.min(1, 256 / Math.max(w, h));
  const sx = Math.max(0.08, k);
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w * sx));
  cv.height = Math.max(1, Math.round(h * sx));
  w = cv.width; h = cv.height; radius *= sx; band *= sx;
  const g = cv.getContext("2d")!;
  const img = g.createImageData(cv.width, cv.height);
  const d = img.data;

  const r = Math.min(radius, Math.min(w, h) / 2);
  // 둥근 사각형의 부호 있는 거리. 안쪽이 음수다
  const sdf = (x: number, y: number) => {
    const qx = Math.abs(x - w / 2) - (w / 2 - r);
    const qy = Math.abs(y - h / 2) - (h / 2 - r);
    const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
  };

  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4;
      const px = x + 0.5, py = y + 0.5;
      const dist = sdf(px, py);          // 테두리 안쪽이면 음수
      const u = -dist;                   // 테두리에서 안쪽으로 들어온 거리
      let nx = 0, ny = 0;
      if (u >= 0 && u < band) {
        // 법선은 거리장의 기울기다. 가운데 차분으로 구한다
        const e = 1;
        const gx = sdf(px + e, py) - sdf(px - e, py);
        const gy = sdf(px, py + e) - sdf(px, py - e);
        const len = Math.hypot(gx, gy) || 1;
        // 테두리에서 1, 띠 안쪽 끝에서 0. 제곱이라 안쪽으로 빠르게 사그라든다
        const t = 1 - u / band;
        const m = t * t;
        nx = (gx / len) * m;
        ny = (gy / len) * m;
      }
      d[i] = Math.round(128 + nx * 127);
      d[i + 1] = Math.round(128 + ny * 127);
      d[i + 2] = 128;
      d[i + 3] = 255;                    // 알파 0 이면 크로미움이 전부 0 으로 읽는다
    }
  }
  g.putImageData(img, 0, 0);
  return cv.toDataURL("image/png");
}

/**
 * 요소에 굴절을 건다. 크기가 바뀌면 지도와 필터를 새로 만든다.
 * 굴절을 못 쓰는 브라우저에서는 아무 일도 하지 않는다 — CSS 쪽 블러·림이 그대로 남는다.
 */
export function refract(el: HTMLElement, opts: GlassOptions = {}): () => void {
  if (!canRefract()) return () => {};
  const wantBand = opts.band ?? 22;
  const wantStrength = opts.strength ?? 14;

  let filter: SVGFilterElement | null = null;
  let last = "";

  const build = () => {
    const w = el.clientWidth, h = el.clientHeight;
    if (w < 8 || h < 8) return;
    const radius = opts.radius ?? (parseFloat(getComputedStyle(el).borderTopLeftRadius) || 12);
    /*
     * 얇은 막대에서는 띠를 줄인다. 띠가 높이의 절반을 넘으면 위아래가 가운데서 만나
     * **표면 전체가 비탈**이 되고, 글자까지 휘어 읽기 나빠진다.
     */
    const band = Math.max(4, Math.min(wantBand, Math.min(w, h) / 3));
    const strength = Math.min(wantStrength, band * 0.7);
    const key = `${w}x${h}x${radius}`;
    if (key === last) return;
    last = key;

    // 크로미움은 필터를 id 로 캐시한다. 같은 id 를 다시 쓰면 옛 것이 나온다
    const id = `lg${++seq}`;
    const ns = "http://www.w3.org/2000/svg";
    const f = document.createElementNS(ns, "filter");
    f.setAttribute("id", id);
    f.setAttribute("filterUnits", "userSpaceOnUse");
    f.setAttribute("color-interpolation-filters", "sRGB");
    // 밀린 픽셀이 잘리지 않게 영역을 요소 밖까지 넓힌다
    const pad = strength * 2;
    f.setAttribute("x", String(-pad));
    f.setAttribute("y", String(-pad));
    f.setAttribute("width", String(w + pad * 2));
    f.setAttribute("height", String(h + pad * 2));

    const im = document.createElementNS(ns, "feImage");
    im.setAttribute("href", displacementMap(w, h, radius, band));
    im.setAttribute("x", "0");
    im.setAttribute("y", "0");
    im.setAttribute("width", String(w));
    im.setAttribute("height", String(h));
    im.setAttribute("preserveAspectRatio", "none");
    im.setAttribute("result", "map");

    const dm = document.createElementNS(ns, "feDisplacementMap");
    dm.setAttribute("in", "SourceGraphic");
    dm.setAttribute("in2", "map");
    dm.setAttribute("scale", String(strength));
    dm.setAttribute("xChannelSelector", "R");
    dm.setAttribute("yChannelSelector", "G");
    dm.setAttribute("result", "disp");

    // 지도 자체가 화면에 섞여 나오지 않게 결과만 내보낸다
    const merge = document.createElementNS(ns, "feMerge");
    const node = document.createElementNS(ns, "feMergeNode");
    node.setAttribute("in", "disp");
    merge.appendChild(node);

    f.append(im, dm, merge);
    svgHost().appendChild(f);
    filter?.remove();
    filter = f;

    el.style.setProperty("--lens", `url(#${id})`);
  };

  build();
  const ro = new ResizeObserver(() => build());
  ro.observe(el);
  return () => { ro.disconnect(); filter?.remove(); el.style.removeProperty("--lens"); };
}
