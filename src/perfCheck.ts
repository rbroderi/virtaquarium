// ?check=perf (npm run check -- perf --gpu=1): what a frame costs and where. Times present() (the draw
// only, no simulation) with gl.finish() around it. Each comparison alternates its two settings batch by
// batch and reports both medians and their ratio, so a machine busy with other work slows both alike:
// compare the ratios, not the milliseconds.
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

export async function main(aq: AquariumHandle): Promise<void> {
  if (new URLSearchParams(location.search).get('hitch') === '1') return hitch(aq);
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
