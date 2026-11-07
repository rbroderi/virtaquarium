// ?check=perf (npm run check -- perf --gpu=1): what a frame costs and where. Times present() (the draw
// only, no simulation), waiting for the GPU: gl.finish() on WebGL, queue.onSubmittedWorkDone() on
// WebGPU. Each comparison alternates its two settings batch by batch and reports both medians and their
// ratio, so a machine busy with other work slows both alike: compare the ratios, not the milliseconds.
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

/** The GPU queue behind a WebGPURenderer (none on WebGL). */
interface GpuQueue { onSubmittedWorkDone(): Promise<void> }
interface GpuBackend { readonly device?: { readonly queue?: GpuQueue } }

export async function main(aq: AquariumHandle): Promise<void> {
  const { renderer, reef, present, step } = aq;
  const isGpu = (renderer as unknown as { isWebGPURenderer?: boolean }).isWebGPURenderer === true;
  const gl = isGpu ? null : renderer.getContext();
  const queue = isGpu ? (renderer as unknown as { backend?: GpuBackend }).backend?.device?.queue ?? null : null;
  // Wait until the GPU has finished the submitted frames (WebGL: gl.finish(); WebGPU: work done).
  const finish = async (): Promise<void> => {
    if (queue) await queue.onSubmittedWorkDone();
    else gl?.finish();
  };
  const draw = async (): Promise<void> => { await present(); };
  aq.fitCanvas();
  for (let i = 0; i < WARM_UP_FRAMES; i++) { step(STEP); await draw(); }   // compile and settle
  await finish();

  const batch = async (): Promise<number> => {
    await finish();
    const t0 = performance.now();
    for (let i = 0; i < FRAMES_PER_BATCH; i++) await draw();
    await finish();
    return (performance.now() - t0) / FRAMES_PER_BATCH;
  };
  const triangles = async (): Promise<number> => {
    renderer.info.autoReset = false;
    renderer.info.reset();
    await draw();
    const t = renderer.info.render.triangles;
    renderer.info.autoReset = true;
    return t;
  };
  const compare = async (on: () => void, off: () => void): Promise<Comparison> => {
    const A: number[] = [], B: number[] = [];
    on(); const trisOn = await triangles();
    off(); const trisOff = await triangles();
    for (let i = 0; i < BATCHES; i++) { on(); A.push(await batch()); off(); B.push(await batch()); }
    on();
    const a = median(A), b = median(B);
    return { msOn: +a.toFixed(DECIMALS_MS), msOff: +b.toFixed(DECIMALS_MS), ratio: +(a / b).toFixed(DECIMALS_RATIO), trisOn, trisOff };
  };

  const pixelRatio = renderer.getPixelRatio(), w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  const resolution = (k: number) => (): void => { renderer.setPixelRatio(pixelRatio * k); renderer.setSize(w, h, false); };
  const report = {
    size: [renderer.domElement.width, renderer.domElement.height],
    renderer: isGpu ? 'webgpu' : 'webgl',
    fishLod: await compare(() => setLodEnabled(true), () => setLodEnabled(false)),
    reef: await compare(() => { reef.group.visible = true; }, () => { reef.group.visible = false; }),
    res: await compare(resolution(1), resolution(Math.SQRT1_2)),
    gpu: isGpu ? 'WebGPU' : gpuName(gl as WebGLRenderingContext),
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
