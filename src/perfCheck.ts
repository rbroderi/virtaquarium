// ?check=perf (npm run check -- perf --gpu=1): what a frame costs and where. Times present() (the draw
// only, no simulation) with gl.finish() around it. Each comparison alternates its two settings batch by
// batch and reports both medians and their ratio, so a machine busy with other work slows both alike:
// compare the ratios, not the milliseconds.
//   reef       with and without the reef (what its triangles and materials cost)
//   fishLod    the fish bodies' levels of detail on and off (lod.ts)
//   res        full and half the pixels (fill-rate and post-processing share)
// and the triangles drawn per frame in each case.
import { setLodEnabled } from './lod.js';
import type { AquariumHandle } from './app/handle.js';

const WARM_UP_FRAMES = 30;
const STEP = 1 / 30;
const BATCHES = 10;
const FRAMES_PER_BATCH = 10;
const DECIMALS_MS = 1, DECIMALS_RATIO = 3;

interface Comparison { msOn: number; msOff: number; ratio: number; trisOn: number; trisOff: number }

const median = (a: readonly number[]): number => a.slice().sort((x, y) => x - y)[a.length >> 1] ?? 0;

export async function main(aq: AquariumHandle): Promise<void> {
  const { renderer, reef, present, step } = aq;
  const gl = renderer.getContext();
  aq.fitCanvas();
  for (let i = 0; i < WARM_UP_FRAMES; i++) { step(STEP); present(); }   // compile and settle
  gl.finish();

  const batch = (): number => {
    gl.finish();
    const t0 = performance.now();
    for (let i = 0; i < FRAMES_PER_BATCH; i++) present();
    gl.finish();
    return (performance.now() - t0) / FRAMES_PER_BATCH;
  };
  const triangles = (): number => {
    renderer.info.autoReset = false;
    renderer.info.reset();
    present();
    const t = renderer.info.render.triangles;
    renderer.info.autoReset = true;
    return t;
  };
  const compare = (on: () => void, off: () => void): Comparison => {
    const A: number[] = [], B: number[] = [];
    on(); const trisOn = triangles();
    off(); const trisOff = triangles();
    for (let i = 0; i < BATCHES; i++) { on(); A.push(batch()); off(); B.push(batch()); }
    on();
    const a = median(A), b = median(B);
    return { msOn: +a.toFixed(DECIMALS_MS), msOff: +b.toFixed(DECIMALS_MS), ratio: +(a / b).toFixed(DECIMALS_RATIO), trisOn, trisOff };
  };

  const pixelRatio = renderer.getPixelRatio(), w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  const resolution = (k: number) => (): void => { renderer.setPixelRatio(pixelRatio * k); renderer.setSize(w, h, false); };
  const report = {
    size: [renderer.domElement.width, renderer.domElement.height],
    fishLod: compare(() => setLodEnabled(true), () => setLodEnabled(false)),
    reef: compare(() => { reef.group.visible = true; }, () => { reef.group.visible = false; }),
    res: compare(resolution(1), resolution(Math.SQRT1_2)),
    gpu: gpuName(gl),
  };
  resolution(1)();
  console.info('perf', JSON.stringify(report));
  await fetch('/__done', { method: 'POST', body: JSON.stringify(report, null, 1) }).catch(() => undefined);
}

function gpuName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  if (!ext) return '?';
  const name: unknown = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  return typeof name === 'string' ? name : '?';
}
