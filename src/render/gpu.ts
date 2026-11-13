/**
 * 정적 층을 WebGPU 로 그린다 (도형은 src/render/scene.ts).
 *
 * 도형은 월드 좌표로 GPU 버퍼에 올라가 있고, 화면 변환·굵기·안티에일리어싱은 셰이더가 한다.
 * 그래서 화면을 옮기거나 확대할 때 CPU 가 하는 일은 변환 값(유니폼) 하나를 쓰는 것뿐이고,
 * 프레임 비용이 시트 크기와 거의 상관이 없다. 편집하면 바뀐 덩어리의 버퍼만 다시 올린다.
 *
 * 선은 선분마다 사각형 하나(인스턴스)로 그리고, 픽셀 중심에서 선분까지의 거리로 덮인 정도를
 * 구한다 — 끝이 둥근 선(Canvas 의 lineCap round)이 되고, 이어진 선분은 저절로 둥글게 이어진다.
 * 원판·고리도 같은 방식이다. 섞기는 미리 곱한 알파(premultiplied)라, 캔버스 뒤의 유리 판이
 * 예전처럼 비친다. 색 공간은 sRGB 텍스처가 아닌 보통 텍스처라 Canvas 2D 와 같은 곳에서 섞인다.
 *
 * 격자 점은 버퍼 없이 인스턴스 번호로 정점 셰이더가 자리를 만든다. 예전에는 점 하나마다
 * fillRect 를 불렀다(배율 0.5 에서 3만 번).
 *
 * WebGPU 가 없는 브라우저는 다루지 않는다 (그러기로 했다). create() 가 이유를 담아 던진다.
 *
 * 그리는 곳은 보통 캔버스지만, 진단용으로 두 가지를 더 둔다 (주소에 ?gpu=…):
 *   readback  — 텍스처에 그린 뒤 픽셀을 읽어 같은 캔버스의 2D 문맥에 옮긴다. GPU 가 없는
 *               헤드리스 브라우저(SwiftShader)는 WebGPU 캔버스를 화면에 올리는 순간 장치를
 *               잃는다 — 그런 곳에서도 스크린샷으로 그림을 확인하려는 것이다.
 *   offscreen — 텍스처에 그리고 끝. 메인 스레드가 한 프레임에 쓰는 시간만 잰다.
 */
import { BASE, STYLE, type Prims, type Scene } from "./scene.ts";
import { GRID } from "../doc/types.ts";

/** 스냅 한 칸 */
const GRID_UNITS = GRID;
/** 굵은 점은 이만큼의 칸마다 */
export const MAJOR_EVERY = 5;

const SHADER = /* wgsl */ `
struct U {
  at: vec4f,      // atI.xy (정수 부분), atF.xy (소수 부분) — 큰 좌표에서 f32 를 아끼려고 나눈다
  p: vec4f,       // scale, dpr, k(굵기 배율), 0
  size: vec4f,    // 캔버스 장치 px 너비·높이, 보통 점·굵은 점 한 변 (장치 px)
  g0: vec4f,      // 격자: x0, y0, 간격(css px), 열 수
  g1: vec4f,      // 보통 점 수, 굵은 점 x0, y0, 간격
  g2: vec4f,      // 굵은 점 열 수, 굵은 점 수, 축 x(css), 축 y(css)
  colors: array<vec4f, 8>,   // 미리 곱한 색: wire part pin nc junction grid gridBold axis
  base: array<vec4f, 2>,     // 스타일별 기본 굵기·반지름 (css px)
};
@group(0) @binding(0) var<uniform> u: U;

fn dev(w: vec2f) -> vec2f { return ((w - u.at.xy) - u.at.zw) * u.p.x * u.p.y; }
fn clip(d: vec2f) -> vec4f { return vec4f(d.x / u.size.x * 2.0 - 1.0, 1.0 - d.y / u.size.y * 2.0, 0.0, 1.0); }
fn baseOf(st: u32) -> f32 { return u.base[st / 4u][st % 4u]; }
fn corner(vi: u32) -> vec2f {
  // 사각형 두 삼각형: (-,-) (+,-) (-,+)  (-,+) (+,-) (+,+)
  var c = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
                          vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  return c[vi];
}

// ── 선분 ──────────────────────────────────────────────────────────────
struct SegOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) a: vec2f,
  @location(1) @interpolate(flat) b: vec2f,
  @location(2) @interpolate(flat) hw: f32,
  @location(3) @interpolate(flat) st: u32,
};
@vertex fn vsSeg(@builtin(vertex_index) vi: u32,
                 @location(0) ab: vec4f, @location(1) off: vec4f, @location(2) style: f32) -> SegOut {
  let k = u.p.z; let dpr = u.p.y;
  let st = u32(style + 0.5);
  let A = dev(ab.xy) + off.xy * k * dpr;
  let B = dev(ab.zw) + off.zw * k * dpr;
  let hw = baseOf(st) * k * dpr * 0.5;
  let pad = hw + 1.0;
  let d = B - A;
  let len = length(d);
  var dir = vec2f(1.0, 0.0);
  if (len > 1e-6) { dir = d / len; }
  let nrm = vec2f(-dir.y, dir.x);
  let c = corner(vi);
  let along = select(A - dir * pad, B + dir * pad, c.x > 0.0);
  var o: SegOut;
  o.pos = clip(along + nrm * pad * c.y);
  o.a = A; o.b = B; o.hw = hw; o.st = st;
  return o;
}
@fragment fn fsSeg(i: SegOut) -> @location(0) vec4f {
  let p = i.pos.xy;
  let ab = i.b - i.a;
  let l2 = dot(ab, ab);
  var t = 0.0;
  if (l2 > 0.0) { t = clamp(dot(p - i.a, ab) / l2, 0.0, 1.0); }
  let d = length(p - (i.a + ab * t));
  let cov = clamp(i.hw + 0.5 - d, 0.0, 1.0);
  if (cov <= 0.0) { discard; }
  return u.colors[i.st] * cov;
}

// ── 원판 (핀 점·접합점) ───────────────────────────────────────────────
struct DiscOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) c: vec2f,
  @location(1) @interpolate(flat) r: f32,
  @location(2) @interpolate(flat) st: u32,
};
@vertex fn vsDisc(@builtin(vertex_index) vi: u32, @location(0) cr: vec4f) -> DiscOut {
  let st = u32(cr.w + 0.5);
  let C = dev(cr.xy);
  let r = cr.z * u.p.z * u.p.y;
  var o: DiscOut;
  o.pos = clip(C + corner(vi) * (r + 1.0));
  o.c = C; o.r = r; o.st = st;
  return o;
}
@fragment fn fsDisc(i: DiscOut) -> @location(0) vec4f {
  let cov = clamp(i.r + 0.5 - length(i.pos.xy - i.c), 0.0, 1.0);
  if (cov <= 0.0) { discard; }
  return u.colors[i.st] * cov;
}

// ── 고리 (심볼의 원: 반지름은 월드, 두께는 화면) ──────────────────────
struct RingOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) c: vec2f,
  @location(1) @interpolate(flat) r: f32,
  @location(2) @interpolate(flat) hw: f32,
  @location(3) @interpolate(flat) st: u32,
};
@vertex fn vsRing(@builtin(vertex_index) vi: u32, @location(0) cr: vec4f) -> RingOut {
  let st = u32(cr.w + 0.5);
  let C = dev(cr.xy);
  let R = cr.z * u.p.x * u.p.y;
  let hw = baseOf(st) * u.p.z * u.p.y * 0.5;
  var o: RingOut;
  o.pos = clip(C + corner(vi) * (R + hw + 1.0));
  o.c = C; o.r = R; o.hw = hw; o.st = st;
  return o;
}
@fragment fn fsRing(i: RingOut) -> @location(0) vec4f {
  let cov = clamp(i.hw + 0.5 - abs(length(i.pos.xy - i.c) - i.r), 0.0, 1.0);
  if (cov <= 0.0) { discard; }
  return u.colors[i.st] * cov;
}

// ── 격자 점과 축 — 버퍼 없이 인스턴스 번호로 자리를 만든다 ────────────
struct GridOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) ci: u32 };
@vertex fn vsGrid(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GridOut {
  let dpr = u.p.y;
  let n1 = u32(u.g1.x); let n2 = u32(u.g2.y);
  var lo = vec2f(0.0); var hi = vec2f(0.0); var ci = 5u;
  if (ii < n1) {
    // 보통 점: 격자점 한가운데에 놓은 정사각형. 장치 픽셀 경계에 맞춘다 (반쯤 걸치면 흐려진다)
    let cols = u32(u.g0.w);
    let x = u.g0.x + f32(ii % cols) * u.g0.z;
    let y = u.g0.y + f32(ii / cols) * u.g0.z;
    let s = u.size.z;
    lo = vec2f(round(x * dpr - s * 0.5), round(y * dpr - s * 0.5)); hi = lo + vec2f(s);
  } else if (ii < n1 + n2) {
    // 굵은 점: 다섯 칸마다
    let j = ii - n1;
    let cols = u32(u.g2.x);
    let x = u.g1.y + f32(j % cols) * u.g1.w;
    let y = u.g1.z + f32(j / cols) * u.g1.w;
    let s = u.size.w;
    lo = vec2f(round(x * dpr - s * 0.5), round(y * dpr - s * 0.5)); hi = lo + vec2f(s);
    ci = 6u;
  } else if (ii == n1 + n2) {
    // 세로축: 1 css px 굵기
    lo = vec2f(u.g2.z * dpr, 0.0); hi = vec2f((u.g2.z + 1.0) * dpr, u.size.y); ci = 7u;
  } else {
    lo = vec2f(0.0, u.g2.w * dpr); hi = vec2f(u.size.x, (u.g2.w + 1.0) * dpr); ci = 7u;
  }
  let c = corner(vi) * 0.5 + vec2f(0.5);
  var o: GridOut;
  o.pos = clip(mix(lo, hi, c));
  o.ci = ci;
  return o;
}
@fragment fn fsGrid(i: GridOut) -> @location(0) vec4f { return u.colors[i.ci]; }
`;

/** 스타일 순서대로의 색 (CSS 문자열) + 격자 */
export interface GpuColors { styles: string[]; grid: string; gridBold: string; axis: string }

export interface GpuView { at: [number, number]; scale: number }

export type GpuTarget = "canvas" | "readback" | "offscreen";

interface Uploaded { version: number; seg: Slot; segTop: Slot; disc: Slot; ring: Slot }
interface Slot { buf: GPUBuffer | null; size: number; count: number }

/** CSS 색 -> 미리 곱한 RGBA (0..1). 캔버스에게 해석을 맡겨 어떤 표기든 받는다 */
const parser = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
const colorCache = new Map<string, [number, number, number, number]>();
export function rgba(css: string): [number, number, number, number] {
  const hit = colorCache.get(css);
  if (hit) return hit;
  let out: [number, number, number, number] = [0, 0, 0, 1];
  if (parser) {
    parser.fillStyle = "#000";
    parser.fillStyle = css;
    const s = String(parser.fillStyle);
    if (s.startsWith("#")) {
      out = [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255, 1];
    } else {
      const m = s.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
      out = [m[0] / 255, m[1] / 255, m[2] / 255, m[3] ?? 1];
    }
  }
  const pre: [number, number, number, number] = [out[0] * out[3], out[1] * out[3], out[2] * out[3], out[3]];
  colorCache.set(css, pre);
  return pre;
}

export class GpuLayer {
  private device: GPUDevice;
  private ctx: GPUCanvasContext | null;
  private format: GPUTextureFormat;
  private readonly target: GpuTarget;
  /** readback·offscreen 일 때 그리는 텍스처 */
  private tex: GPUTexture | null = null;
  private g2: CanvasRenderingContext2D | null = null;
  private reading = false;
  private readAgain = false;
  /** readback 이 끝나 2D 캔버스에 옮겼을 때 (그사이 그린 프레임이 있으면 다시 그리게 한다) */
  onReadback: () => void = () => {};
  private uniform: GPUBuffer;
  private bind: GPUBindGroup;
  private pSeg!: GPURenderPipeline;
  private pDisc!: GPURenderPipeline;
  private pRing!: GPURenderPipeline;
  private pGrid!: GPURenderPipeline;
  private uploaded = new WeakMap<Prims, Uploaded>();
  private u = new Float32Array(4 * (6 + 8 + 2));
  /** 장치를 잃었을 때 부른다 (다시 만들고 전부 다시 올려야 한다) */
  onLost: (reason: string) => void = () => {};
  readonly adapterInfo: string;

  /**
   * 어댑터를 붙잡아 둔다. 놓으면 가비지 수집과 함께 장치가 끊긴다 ("A valid external Instance
   * reference no longer exists") — 장치만 들고 있으면 될 것 같지만 Chrome 에서는 아니었다.
   */
  private readonly adapter: GPUAdapter;

  private constructor(
    adapter: GPUAdapter, device: GPUDevice, ctx: GPUCanvasContext | null, format: GPUTextureFormat,
    info: string, target: GpuTarget, g2: CanvasRenderingContext2D | null,
  ) {
    this.adapter = adapter;
    this.device = device; this.ctx = ctx; this.format = format; this.adapterInfo = info;
    this.target = target; this.g2 = g2;
    this.uniform = device.createBuffer({ size: this.u.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ code: SHADER });
    const layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
    });
    this.bind = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniform } }] });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const blend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const make = (vs: string, fs: string, buffers: GPUVertexBufferLayout[]) => device.createRenderPipeline({
      layout: pl,
      vertex: { module, entryPoint: vs, buffers },
      fragment: { module, entryPoint: fs, targets: [{ format, blend }] },
      primitive: { topology: "triangle-list" },
    });
    this.pSeg = make("vsSeg", "fsSeg", [{
      arrayStride: 36, stepMode: "instance",
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x4" },
        { shaderLocation: 1, offset: 16, format: "float32x4" },
        { shaderLocation: 2, offset: 32, format: "float32" },
      ],
    }]);
    const v4: GPUVertexBufferLayout[] = [{ arrayStride: 16, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }] }];
    this.pDisc = make("vsDisc", "fsDisc", v4);
    this.pRing = make("vsRing", "fsRing", v4);
    this.pGrid = make("vsGrid", "fsGrid", []);
  }

  static async create(canvas: HTMLCanvasElement, target: GpuTarget = "canvas"): Promise<GpuLayer> {
    if (!("gpu" in navigator) || !navigator.gpu) throw new Error("This browser does not support WebGPU");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("WebGPU is present but no graphics adapter is available");
    const device = await adapter.requestDevice();
    let ctx: GPUCanvasContext | null = null, g2: CanvasRenderingContext2D | null = null;
    let format: GPUTextureFormat = "rgba8unorm";
    if (target === "canvas") {
      ctx = canvas.getContext("webgpu");
      if (!ctx) throw new Error("Could not get a WebGPU context for the canvas");
      format = navigator.gpu.getPreferredCanvasFormat();
      ctx.configure({ device, format, alphaMode: "premultiplied" });
    } else if (target === "readback") {
      g2 = canvas.getContext("2d");
    }
    const info = [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.description].filter(Boolean).join(" ");
    const layer = new GpuLayer(adapter, device, ctx, format, info, target, g2);
    void device.lost.then(l => layer.onLost(l.message || l.reason || "device lost"));
    return layer;
  }

  /** 도형 묶음을 GPU 로 (바뀌었을 때만) */
  private upload(p: Prims): Uploaded {
    let up = this.uploaded.get(p);
    if (!up) {
      const slot = (): Slot => ({ buf: null, size: 0, count: 0 });
      up = { version: -1, seg: slot(), segTop: slot(), disc: slot(), ring: slot() };
      this.uploaded.set(p, up);
    }
    if (up.version === p.version) return up;
    up.version = p.version;
    const put = (slot: Slot, data: Float32Array, stride: number) => {
      slot.count = data.length / stride;
      if (!data.length) return;
      if (!slot.buf || slot.size < data.byteLength) {
        slot.buf?.destroy();
        // 조금 넉넉히 잡아 두면 객체 하나 더할 때마다 버퍼를 새로 만들지 않는다
        slot.size = Math.ceil(data.byteLength * 1.25 / 4) * 4;
        slot.buf = this.device.createBuffer({ size: slot.size, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      }
      this.device.queue.writeBuffer(slot.buf, 0, data.buffer, data.byteOffset, data.byteLength);
    };
    put(up.seg, p.seg.view(), 9);
    put(up.segTop, p.segTop.view(), 9);
    put(up.disc, p.disc.view(), 4);
    put(up.ring, p.ring.view(), 4);
    return up;
  }

  /**
   * 한 프레임. W·H 는 css px, dpr 은 장치 배율. showGrid 가 거짓이면 격자 점만 빼고 축은 그린다.
   */
  draw(scene: Scene, view: GpuView, W: number, H: number, dpr: number, colors: GpuColors, showGrid: boolean): void {
    const u = this.u;
    const atI = [Math.floor(view.at[0]), Math.floor(view.at[1])];
    u.set([atI[0], atI[1], view.at[0] - atI[0], view.at[1] - atI[1]], 0);
    const k = Math.max(1, Math.min(view.scale / 2, 2));
    u.set([view.scale, dpr, k, 0], 4);
    /*
     * 격자. **점 하나가 스냅 한 칸(100 mil)이다** — 부품의 핀과 배선 꺾점은 늘 점 위에 놓인다.
     * 예전에는 점이 1 px 에 옅어서 거의 안 보였고, 눈에 띄는 것은 열 칸마다의 굵은 점뿐이라
     * 핀이 '점 사이' 에 놓이는 것처럼 보였다. 지금은 점을 키우고 진하게 하고(확대할수록 2 px),
     * 굵은 점은 다섯 칸마다 둔다 — 칸을 셀 때 눈이 붙잡을 자리가 가깝다.
     */
    const gp = GRID_UNITS * view.scale;              // 스냅 한 칸 (css px)
    const ox = (0 - view.at[0]) * view.scale, oy = (0 - view.at[1]) * view.scale;
    let n1 = 0, n2 = 0, cols = 1, bcols = 1;
    let x0 = 0, y0 = 0, bx = 0, by = 0;
    const bp = gp * MAJOR_EVERY;
    // 점이 6 px 보다 촘촘해지면 그물이 되어 회로도를 가린다. 그때는 굵은 점만 남긴다
    if (showGrid && gp >= 6) {
      x0 = ((ox % gp) + gp) % gp; y0 = ((oy % gp) + gp) % gp;
      cols = Math.max(0, Math.ceil((W - x0) / gp));
      const rows = Math.max(0, Math.ceil((H - y0) / gp));
      n1 = cols * rows;
    }
    if (showGrid && bp >= 18) {
      bx = ((ox % bp) + bp) % bp; by = ((oy % bp) + bp) % bp;
      bcols = Math.max(0, Math.ceil((W - bx) / bp));
      n2 = bcols * Math.max(0, Math.ceil((H - by) / bp));
    }
    const minor = Math.max(1, Math.round((gp >= 24 ? 2 : gp >= 12 ? 1.5 : 1) * dpr));
    const major = Math.max(2, Math.round((gp >= 12 ? 3 : 2.5) * dpr));
    u.set([Math.round(W * dpr), Math.round(H * dpr), minor, major], 8);
    u.set([x0, y0, gp, Math.max(cols, 1)], 12);
    u.set([n1, bx, by, bp], 16);
    // 축: 예전 half(o) = round(o)+0.5 에 굵기 1 이면 [round(o), round(o)+1) 을 덮는다
    u.set([Math.max(bcols, 1), n2, Math.round(ox), Math.round(oy)], 20);
    const cs = [...colors.styles, colors.grid, colors.gridBold, colors.axis];
    for (let i = 0; i < 8; i++) u.set(rgba(cs[i] ?? "#000"), 24 + i * 4);
    const base = new Float32Array(8);
    BASE.forEach((b, i) => { base[i] = b; });
    u.set(base, 56);
    this.device.queue.writeBuffer(this.uniform, 0, u.buffer, 0, u.byteLength);

    const devW = Math.max(1, Math.round(W * dpr)), devH = Math.max(1, Math.round(H * dpr));
    let target: GPUTexture;
    if (this.ctx) target = this.ctx.getCurrentTexture();
    else {
      if (!this.tex || this.tex.width !== devW || this.tex.height !== devH) {
        this.tex?.destroy();
        this.tex = this.device.createTexture({
          size: [devW, devH], format: this.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
      }
      target = this.tex;
    }
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: target.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store",
      }],
    });
    pass.setBindGroup(0, this.bind);

    pass.setPipeline(this.pGrid);
    pass.draw(6, n1 + n2 + 2);

    // 순서: 배선 -> 부품 선 -> 부품 원 -> 핀 점 -> 미연결 X -> 끄는 중인 것 -> 접합점
    const draws = (list: Prims[], what: "seg" | "ring" | "disc" | "segTop") => {
      const pipe = what === "ring" ? this.pRing : what === "disc" ? this.pDisc : this.pSeg;
      pass.setPipeline(pipe);
      for (const p of list) {
        const up = this.upload(p);
        const slot = up[what];
        if (!slot.count || !slot.buf) continue;
        pass.setVertexBuffer(0, slot.buf);
        pass.draw(6, slot.count);
      }
    };
    const wires = scene.wires.map(c => c.prims), parts = scene.parts.map(c => c.prims);
    draws(wires, "seg");
    draws(parts, "seg");
    draws(parts, "ring");
    draws(parts, "disc");
    draws(parts, "segTop");
    if (scene.hasLive) for (const what of ["seg", "ring", "disc", "segTop"] as const) draws([scene.live], what);
    draws([scene.junctions], "disc");
    pass.end();
    this.device.queue.submit([enc.finish()]);
    if (this.target === "readback") void this.readback(target);
  }

  /** 진단용: 그린 텍스처를 읽어 캔버스의 2D 문맥에 옮긴다 (미리 곱한 알파를 풀어서) */
  private async readback(tex: GPUTexture) {
    if (this.reading) { this.readAgain = true; return; }
    this.reading = true;
    const w = tex.width, h = tex.height, row = Math.ceil(w * 4 / 256) * 256;
    const buf = this.device.createBuffer({ size: row * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: row }, [w, h]);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * row + x * 4, o = (y * w + x) * 4, a = src[i + 3];
      img.data[o + 3] = a;
      if (a) for (let c = 0; c < 3; c++) img.data[o + c] = Math.min(255, Math.round(src[i + c] * 255 / a));
    }
    buf.unmap(); buf.destroy();
    this.g2?.putImageData(img, 0, 0);
    this.reading = false;
    if (this.readAgain) { this.readAgain = false; this.onReadback(); }
  }
}

/** 스타일 순서의 테마 색 (STYLE 의 순서와 같다) */
export const styleColors = (t: { wire: string; part: string; pin: string; junction: string }): string[] => {
  const out: string[] = [];
  out[STYLE.wire] = t.wire;
  out[STYLE.part] = t.part;
  out[STYLE.pin] = t.pin;
  out[STYLE.nc] = t.junction;
  out[STYLE.junction] = t.junction;
  return out;
};
