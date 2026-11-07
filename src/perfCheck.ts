// ?check=perf (npm run check -- perf --gpu=1): what a frame costs and where. Times present() (the draw
// only, no simulation), waiting for the GPU: gl.finish() on WebGL, queue.onSubmittedWorkDone() on
// WebGPU. Each comparison alternates its two settings batch by batch and reports both medians and their
// ratio, so a machine busy with other work slows both alike: compare the ratios, not the milliseconds.
//   reef       with and without the reef (what its triangles and materials cost)
//   fishLod    the fish bodies' levels of detail on and off (lod.ts)
//   res        full and half the pixels (fill-rate and post-processing share)
// and the triangles drawn per frame in each case.
import { setLodEnabled } from './lod.js';
import { pendingSkinSave, pendingVariantCount, startIdleVariantPainting } from './fishModel.js';
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
  const q = new URLSearchParams(location.search);
  if (q.get('hitch') === '1') return hitch(aq);
  if (q.get('lum') === '1') return lum(aq);
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

/** ?hitch=1: run the live loop with deferred variant painting and report the worst frame / long task. */
async function hitch(aq: AquariumHandle): Promise<void> {
  const q = new URLSearchParams(location.search);
  const maxSeconds = Number(q.get('seconds') || 45);
  const { step, present, fitCanvas } = aq;
  fitCanvas();

  // Warm up past shader compilation before observing: the first present() compiles every program
  // (several seconds headless), which is startup, not the variant painting being measured here.
  const WARM_UP = 15, SETTLE = 45;
  for (let i = 0; i < WARM_UP; i++) { step(STEP); present(); }
  const paintStart = performance.now();

  const longTasks: { start: number; dur: number }[] = [];
  if (typeof PerformanceObserver === 'function') {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ entryTypes: ['longtask'] });
    } catch { /* longtask unavailable */ }
  }

  if (q.get('novariants') !== '1') startIdleVariantPainting();   // ?novariants=1: the baseline to compare

  const gaps: number[] = [];
  let last = performance.now();
  let hadPending = false;
  let idleFrames = 0;
  let maxStep = 0, maxPresent = 0;

  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      const t0 = performance.now();
      step(STEP);
      const t1 = performance.now();
      present();
      const t2 = performance.now();
      maxStep = Math.max(maxStep, t1 - t0);
      maxPresent = Math.max(maxPresent, t2 - t1);
      if (pendingVariantCount() > 0) { hadPending = true; idleFrames = 0; }
      else if (hadPending) idleFrames++;
      if (hadPending && idleFrames >= SETTLE) { resolve(); return; }
      if (now - paintStart > maxSeconds * 1000) { resolve(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const loopEnd = performance.now();

  await pendingSkinSave().catch(() => undefined);   // a cold run must finish writing its variant skins

  const maxGap = gaps.reduce((a, b) => Math.max(a, b), 0);
  const duringLoop = longTasks.filter((t) => t.start < loopEnd).map((t) => Math.round(t.dur));
  const report = {
    seconds: Math.round((performance.now() - paintStart) / 100) / 10,
    frames: gaps.length,
    worstFrameMs: +maxGap.toFixed(1),
    worstLongTaskMs: duringLoop.length ? +Math.max(...duringLoop).toFixed(1) : 0,
    maxStepMs: +maxStep.toFixed(1),
    maxPresentMs: +maxPresent.toFixed(1),
    longTasks: duringLoop.length,
    longTasksOver50: duringLoop.filter((d) => d > 50).length,
    pending: pendingVariantCount(),
  };
  console.info('perf hitch', JSON.stringify(report));
  await fetch('/__done', { method: 'POST', body: JSON.stringify(report, null, 1) }).catch(() => undefined);
}

/**
 * ?lum=1: sample the mean frame luminance every frame over ?seconds (default 20), reading a small
 * centre region of the tone-mapped canvas back (fast enough to catch single-frame flashes). Driven on
 * rAF (like the live page), so the deferred variant painter can swap its textures while it runs.
 */
async function lum(aq: AquariumHandle): Promise<void> {
  const q = new URLSearchParams(location.search);
  const seconds = Number(q.get('seconds') || 20);
  const { renderer, step, present, fitCanvas, world } = aq;
  const gl = renderer.getContext();
  fitCanvas();
  for (let i = 0; i < WARM_UP_FRAMES; i++) { step(STEP); present(); }   // compile and settle
  // Downscale the drawing buffer so present() runs fast enough to see single-frame flashes.
  const lumres = Number(q.get('lumres') || 1);
  if (lumres > 1) {
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    renderer.setPixelRatio(renderer.getPixelRatio() / lumres);
    renderer.setSize(w, h, false);
  }
  if (q.get('variants') !== '0') startIdleVariantPainting();   // match the live page's periodic variant swaps
  const RW = 96, RH = 54;
  const buf = new Uint8Array(RW * RH * 4);
  const samples: { t: number; lum: number; light: number; exposure: number; pending: number }[] = [];
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const tick = (now: number): void => {
      if (now - start >= seconds * 1000) { resolve(); return; }
      const t = +((now - start) / 1000).toFixed(3);
      step(STEP);
      present();
      const w = renderer.domElement.width, h = renderer.domElement.height;
      const full = q.get('lumfull') === '1';   // the whole frame, not just the centre patch
      const fw = full ? w : RW, fh = full ? h : RH;
      const px = full ? new Uint8Array(fw * fh * 4) : buf;
      gl.readPixels(full ? 0 : Math.max(0, (w - RW) >> 1), full ? 0 : Math.max(0, (h - RH) >> 1), fw, fh, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += 0.2126 * (px[i] ?? 0) + 0.7152 * (px[i + 1] ?? 0) + 0.0722 * (px[i + 2] ?? 0);
      samples.push({ t, lum: sum / (fw * fh) / 255, light: world.light, exposure: renderer.toneMappingExposure, pending: pendingVariantCount() });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const lums = samples.map((s) => s.lum).sort((a, b) => a - b);
  const median = lums[Math.floor(lums.length / 2)] ?? 0;
  const report = {
    seconds,
    size: [renderer.domElement.width, renderer.domElement.height],
    region: [RW, RH],
    count: samples.length,
    min: lums[0],
    max: lums[lums.length - 1],
    median,
    mean: lums.reduce((a, b) => a + b, 0) / lums.length,
    spikes: samples.filter((s) => s.lum > median * 1.12 || s.lum < median * 0.88),
    series: samples,
  };
  console.info('perf lum', JSON.stringify(report));
  const bins: number[][] = [];
  for (const s of samples) (bins[Math.floor(s.t * 2)] ??= []).push(s.lum);
  console.info('lumbins', bins.map((b) => (b.reduce((a, x) => a + x, 0) / b.length).toFixed(3)).join(' '),
    'min', lums[0]?.toFixed(3), 'max', lums[lums.length - 1]?.toFixed(3), 'n', samples.length);
  await fetch('/__done', { method: 'POST', body: JSON.stringify(report, null, 1) }).catch(() => undefined);
}
