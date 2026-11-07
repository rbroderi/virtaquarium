// Look check, run on the tank page with ?check=look (headless: tools/check.ts look). Steps the tank as
// the live loop does, at 30 Hz, and at each requested moment renders a frame and saves it to
// out/look-<tag>-<t>s.png, plus close-ups (out/look-<tag>-<t>s-<what>.png) of
//   station   the cleaning station (cleaner and client)
//   <species> the first fish of that species
//   fanworm   the most open feather-duster worm
//   <name>    a scenery piece by its object name (rock_a, coral_table, ...)
// URL options: &at=5,30 (seconds), &close=station,cleanerwrasse, &tag=name, &night=1 (lights off),
// &light=0.35 (fixed level), &hour=18 (jump the clock to an hour, for dawn/dusk/night colour).
// Reports { files, stats } to /__done, stats per frame: mean luminance and saturation, so looks can be
// compared over time without opening the pictures.
import * as THREE from 'three';
import type { AquariumHandle } from './app/handle.js';
import type { Fish } from './fish.js';
import { context2d } from './util.js';
import { paintPendingVariants } from './fishModel.js';
import { fishUniforms } from './reef/fishPush.js';
import { canvasToBlob, postDone, saveFile, CHECK_OUT_DIR } from './checks/report.js';

const DT = 1 / 30;
const CLOSE_UP_PX = 512;
/** Close-up crop as a fraction of the frame height: the worm's is tighter. */
const CLOSE_UP_FRACTION = 0.35, WORM_CLOSE_UP_FRACTION = 0.14;
/** Worms further back than this are hidden by the reef. */
const WORM_MIN_Z = -0.5;
const MEASURE_DOWNSCALE = 8;
const LUMA = [0.2126, 0.7152, 0.0722] as const;
const STATS_DIGITS = 3;
/** How many fish of one species the variant strip shows side by side (one per distinct variant). */
const VARIANTS_COUNT = 6;
/** Cell size (px) of each fish in the variant strip. */
const VARIANT_CELL_PX = 320;
/** Crop fraction of frame height for each variant cell (tight: one fish nearly fills its cell). */
const VARIANT_CROP_FRACTION = 0.09;
/** Seconds the tank runs before the variant strip is captured (fish settle into a natural pose). */
const VARIANT_SETTLE_S = 5;

interface FrameStats { t: number; lum: number; sat: number }

export async function main(aq: AquariumHandle): Promise<void> {
  const { world, renderer } = aq;
  const q = new URLSearchParams(location.search);
  const at = (q.get('at') || '5,30').split(',').map(Number).sort((a, b) => a - b);
  const close = (q.get('close') || 'station').split(',').filter(Boolean);
  const tag = q.get('tag') || 'tank';
  if (q.get('night') === '1') aq.setLight(0);
  if (q.has('light')) aq.setLight(Number(q.get('light')));   // e.g. 0.35: dusk
  if (q.has('hour')) {
    const hour = Number(q.get('hour'));
    if (Number.isFinite(hour)) {
      aq.daylight.jumpTo(hour);   // e.g. 19: golden dusk with the real sun colour
      // Jump the light level too: the loop eases the level towards the clock over ~30 s, so an early
      // frame would still be mid-transition. An explicit --light/--night keeps its override.
      if (!q.has('light') && q.get('night') !== '1') aq.setLight(aq.daylight.level());
    }
  }
  aq.fitCanvas();
  const variantSpeciesId = q.get('variants');
  if (variantSpeciesId) return variants(aq, variantSpeciesId);
  if (q.get('series')) return series(aq, Number(q.get('series')), Number(q.get('dt') || DT));
  if (q.get('frames')) return frameSeries(aq, Number(q.get('frames')), Number(q.get('dt') || DT), Number(q.get('warm') || 0), tag, Number(q.get('every') ?? 1));
  const canvas = renderer.domElement, files: string[] = [], stats: FrameStats[] = [];
  let t = 0;
  for (const target of at) {
    for (; t < target - 1e-6; t += DT) aq.step(DT);
    aq.present();
    const name = `look-${tag}-${target}s`;
    files.push(await saveFile(`${CHECK_OUT_DIR}${name}.png`, await canvasToBlob(canvas)));
    stats.push({ t: target, ...measure(canvas) });
    for (const what of close) {
      const shot = closeUp(aq, what, canvas);
      if (shot) files.push(await saveFile(`${CHECK_OUT_DIR}${name}-${what}.png`, await canvasToBlob(shot)));
    }
  }
  const station = world.station && { client: world.station.client?.sp.id || null, cleaner: world.station.cleaner?.brain.thought };
  const report = { files, stats, station };
  console.log('look check', JSON.stringify(report));
  await postDone(JSON.stringify(report));
}

/** The point a close-up centres on, or null if `what` isn't in the tank. */
function closeUpTarget(aq: AquariumHandle, what: string): { pos: THREE.Vector3; worm: boolean } | null {
  const { world } = aq;
  if (what === 'station') return world.station ? { pos: world.station.pos, worm: false } : null;
  if (what === 'fanworm') {
    // The most open feather-duster worm in front of the camera.
    const worm = (aq.reef.fanWorms?.worms ?? []).filter((w) => w.mouth.z > WORM_MIN_Z).sort((a, b) => a.retract - b.retract)[0];
    if (worm) return { pos: worm.mouth, worm: true };
  }
  const fish = world.fish.find((f) => f.sp.id === what);
  // (An eel's pos is not on its body, which lies along its path: centre on the middle of the body.)
  const mid = fish?.spine?.nodes[Math.floor(fish.spine.nodes.length / 2)];
  if (fish) return { pos: mid ?? fish.pos, worm: false };
  // A scenery piece by name: the front of its box.
  const piece = aq.scene.getObjectByName(what);   // depth-first, first match (as a traverse would find)
  if (!piece) return null;
  const box = new THREE.Box3().setFromObject(piece);
  return { pos: box.getCenter(new THREE.Vector3()).setZ(box.max.z), worm: false };
}

/** A square crop of the rendered frame centred on a world point, scaled to `size` px. */
function cropSquare(aq: AquariumHandle, pos: THREE.Vector3, canvas: HTMLCanvasElement, size: number, fraction: number): HTMLCanvasElement {
  const v = pos.clone().project(aq.camera), W = canvas.width, H = canvas.height;
  const s = Math.round(H * fraction);
  const x = Math.round(((v.x + 1) / 2) * W - s / 2), y = Math.round(((1 - v.y) / 2) * H - s / 2);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  context2d(c).drawImage(canvas, Math.max(0, Math.min(W - s, x)), Math.max(0, Math.min(H - s, y)), s, s, 0, 0, size, size);
  return c;
}

function closeUp(aq: AquariumHandle, what: string, canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  const target = closeUpTarget(aq, what);
  if (!target) return null;
  return cropSquare(aq, target.pos, canvas, CLOSE_UP_PX, target.worm ? WORM_CLOSE_UP_FRACTION : CLOSE_UP_FRACTION);
}

/** A row of close-ups of one species: each distinct variant first, then further fish up to VARIANTS_COUNT. */
function variantStrip(aq: AquariumHandle, species: string, canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  const seen = new Set<number>(), fish: Fish[] = [];
  for (const f of aq.world.fish) if (f.sp.id === species && !seen.has(f.variant)) { seen.add(f.variant); fish.push(f); }
  for (const f of aq.world.fish) {
    if (fish.length >= VARIANTS_COUNT) break;
    if (f.sp.id === species && !fish.includes(f)) fish.push(f);
  }
  const chosen = fish.slice(0, VARIANTS_COUNT);
  if (!chosen.length) return null;
  const out = document.createElement('canvas');
  out.width = VARIANT_CELL_PX * chosen.length;
  out.height = VARIANT_CELL_PX;
  const g = context2d(out);
  chosen.forEach((f, i) => g.drawImage(cropSquare(aq, f.pos, canvas, VARIANT_CELL_PX, VARIANT_CROP_FRACTION), i * VARIANT_CELL_PX, 0));
  return out;
}

/** ?variants=<species>: one side-by-side strip of that shoaling species' individuals, out/look-variants.png. */
async function variants(aq: AquariumHandle, species: string): Promise<void> {
  const canvas = aq.renderer.domElement;
  for (let t = 0; t < VARIANT_SETTLE_S; t += DT) aq.step(DT);
  const paintStart = performance.now();
  await paintPendingVariants();   // a check steps the tank itself, so paint and swap any variant still pending
  const swapMs = Math.round(performance.now() - paintStart);
  aq.present();
  const strip = variantStrip(aq, species, canvas);
  if (!strip) {
    console.log('look check variants', JSON.stringify({ error: `no fish of species ${species}` }));
    await postDone(JSON.stringify({ error: `no fish of species ${species}` }));
    return;
  }
  const path = `${CHECK_OUT_DIR}look-variants.png`;
  await saveFile(path, await canvasToBlob(strip));
  console.log('look check variants', JSON.stringify({ file: path, fish: strip.width / VARIANT_CELL_PX, swapMs }));
  await postDone(JSON.stringify({ files: [path], stats: [] }));
}

/** Width (px) of each saved sequence frame (the drawing buffer is 1920 px wide headless). */
const FRAME_TILE_PX = 960;
/** Downscale for the grass silhouette read-back (fraction of the drawing buffer). */
const GRASS_MASK_SCALE = 2;
/** A grass pixel is anything the silhouette pass drew brighter than this (0..255 sum of rgb). */
const GRASS_PIXEL_MIN = 12;

interface FrameGrass { i: number; t: number; px: number; x0: number; y0: number; x1: number; y1: number; fish?: number; near?: number; str?: number }

/** The nearest fish to any sea-grass patch (horizontal units) and the strongest parting strength. */
function grassFish(aq: AquariumHandle, patches: THREE.Vector3[]): { fish: number; near: number; str: number } {
  let near = Infinity;
  for (const f of aq.world.fish) for (const p of patches) near = Math.min(near, Math.hypot(f.pos.x - p.x, f.pos.z - p.z));
  return { fish: fishUniforms.uFishCount.value, near: +near.toFixed(2), str: +Math.max(0, ...Array.from(fishUniforms.uFishVel.value).filter((_, k) => k % 4 === 3)).toFixed(2) };
}

/**
 * ?frames=N: a consecutive sequence of frames (with the pan, if ?pan=1), plus a per-frame measure of
 * the seagrass's screen footprint: the number of pixels its silhouette covers and its bounding box
 * (fractions of the frame). A frame where the grass swells or smears shows a spike in px and in the
 * box's size, and can be opened to see what happened.
 *
 * ?every=K writes out/frames-<tag>-<i>.png every K frames (0 writes none: a long sweep can be measured
 * first and the suspect frames captured in a second, short run). Each frame's spike score compares its
 * silhouette with the running median of +-SPIKE_WINDOW frames, so a slow change over a long sweep does
 * not hide a few bad frames.
 */
const SPIKE_WINDOW = 12;
/** Width (px) of the composite comparison image (1/8 of the headless drawing buffer). */
const DIFF_PX = 240;

interface FrameDiff { i: number; t: number; mean: number; blk: number }

/** A DIFF_PX-wide luminance copy of the finished (water + photo) frame, for frame-to-frame comparison. */
function downsample(canvas: HTMLCanvasElement, cv: HTMLCanvasElement): Uint8ClampedArray {
  cv.width = DIFF_PX; cv.height = Math.max(1, Math.round(DIFF_PX * canvas.height / canvas.width));
  const g = context2d(cv, { willReadFrequently: true });
  g.drawImage(canvas, 0, 0, cv.width, cv.height);
  return g.getImageData(0, 0, cv.width, cv.height).data;
}

async function frameSeries(aq: AquariumHandle, count: number, dt: number, warm: number, tag: string, every = 1): Promise<void> {
  const canvas = aq.renderer.domElement, files: string[] = [], series: FrameGrass[] = [], diffs: FrameDiff[] = [];
  const diffCanvas = document.createElement('canvas');
  let prev: Uint8ClampedArray | null = null;
  aq.reef.group.updateMatrixWorld(true);
  const patches: THREE.Vector3[] = [];
  aq.reef.group.traverse((o) => { if (o.name === 'seagrass') patches.push(o.getWorldPosition(new THREE.Vector3())); });
  for (let t = 0; t < warm - 1e-9; t += dt) aq.step(dt);
  for (let i = 0; i < count; i++) {
    aq.step(dt);
    aq.present();
    const cur = downsample(canvas, diffCanvas);
    const dw = diffCanvas.width, dh = diffCanvas.height;
    let mean = 0, blk = 0;
    if (prev) {
      // Mean and worst 8x8-block absolute luminance difference from the previous frame: a smooth pan
      // changes little, but a frame where the grass swells, smears or pops stands out.
      for (let by = 0; by < dh; by += 8) {
        for (let bx = 0; bx < dw; bx += 8) {
          let sum = 0, n = 0;
          for (let y = by; y < Math.min(dh, by + 8); y++) {
            for (let x = bx; x < Math.min(dw, bx + 8); x++) {
              const p = (y * dw + x) * 4;
              const dl = Math.abs((cur[p] ?? 0) * LUMA[0] + (cur[p + 1] ?? 0) * LUMA[1] + (cur[p + 2] ?? 0) * LUMA[2]
                - ((prev[p] ?? 0) * LUMA[0] + (prev[p + 1] ?? 0) * LUMA[1] + (prev[p + 2] ?? 0) * LUMA[2]));
              sum += dl; n++;
            }
          }
          const m = sum / Math.max(1, n);
          mean += m * n;
          if (m > blk) blk = m;
        }
      }
      mean /= dw * dh;
      diffs.push({ i, t: +(warm + i * dt).toFixed(3), mean: +mean.toFixed(3), blk: +blk.toFixed(3) });
    }
    prev = cur;
    if (every > 0 && i % every === 0) {
      const shot = document.createElement('canvas');
      shot.width = FRAME_TILE_PX; shot.height = Math.round(FRAME_TILE_PX * canvas.height / canvas.width);
      context2d(shot).drawImage(canvas, 0, 0, shot.width, shot.height);
      files.push(await saveFile(`${CHECK_OUT_DIR}frames-${tag}-${String(i).padStart(3, '0')}.png`, await canvasToBlob(shot)));
    }
    series.push({ i, t: +(warm + i * dt).toFixed(3), ...grassSilhouette(aq), ...grassFish(aq, patches) });
    if (i % 30 === 0) console.log('frames', i, JSON.stringify(series[series.length - 1]));
  }
  const medianOf = (v: number[]): number => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
  const around = (i: number, f: (s: FrameGrass) => number): number => {
    const lo = Math.max(0, i - SPIKE_WINDOW), hi = Math.min(series.length, i + SPIKE_WINDOW + 1);
    return medianOf(series.slice(lo, hi).map(f)) || 1;
  };
  const scored = series.map((s, i) => ({
    ...s,
    score: +(s.px / around(i, (f) => f.px)).toFixed(3),
    box: +(((s.x1 - s.x0) * (s.y1 - s.y0)) / around(i, (f) => (f.x1 - f.x0) * (f.y1 - f.y0))).toFixed(3),
    wide: +((s.x1 - s.x0) / around(i, (f) => f.x1 - f.x0)).toFixed(3),
    tall: +((s.y1 - s.y0) / around(i, (f) => f.y1 - f.y0)).toFixed(3),
  }));
  const spikes = scored.filter((f) => f.score > 1.35 || f.box > 1.5 || f.wide > 1.3 || f.tall > 1.3);
  const worst = scored.slice().sort((a, b) => Math.max(b.score, b.box) - Math.max(a.score, a.box)).slice(0, 8);
  const diffMedian = (i: number): { mean: number; blk: number } => {
    const lo = Math.max(0, i - SPIKE_WINDOW), hi = Math.min(diffs.length, i + SPIKE_WINDOW + 1);
    const win = diffs.slice(lo, hi);
    return { mean: medianOf(win.map((d) => d.mean)) || 1e-3, blk: medianOf(win.map((d) => d.blk)) || 1e-3 };
  };
  const jumpy = diffs.map((d, i) => {
    const m = diffMedian(i);
    return { ...d, meanRatio: +(d.mean / m.mean).toFixed(2), blkRatio: +(d.blk / m.blk).toFixed(2) };
  });
  const jumps = jumpy.filter((d) => d.meanRatio > 3 || d.blkRatio > 3).sort((a, b) => b.meanRatio - a.meanRatio);
  const worstDiff = diffs.slice().sort((a, b) => b.mean - a.mean).slice(0, 8);
  const report = { frames: count, files: files.length, spikes, worst, jumps, worstDiff, series };
  console.log('look frames', JSON.stringify({ ...report, series: undefined }));
  console.log('look frames series', JSON.stringify(series));
  await postDone(JSON.stringify(report));
}

/**
 * The seagrass's screen footprint: renders only the grass (straight to the canvas, at the current
 * camera) and reads back a downscaled mask. Bypasses the water/photo passes, so it measures the
 * blades' geometry and vertex-shader shape, not their lighting.
 */
function grassSilhouette(aq: AquariumHandle): { px: number; x0: number; y0: number; x1: number; y1: number } {
  const { scene, renderer, camera, reef } = aq;
  const saved: [THREE.Object3D, boolean][] = [];
  scene.traverse((o) => saved.push([o, o.visible]));
  scene.traverse((o) => { o.visible = false; });
  // Show the grass meshes and every ancestor up to the scene.
  reef.group.traverse((o) => {
    if (o.name !== 'seagrass') return;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) p.visible = true;
  });
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
  renderer.setRenderTarget(prevTarget);
  for (const [o, v] of saved) o.visible = v;
  const W = renderer.domElement.width, H = renderer.domElement.height;
  const w = Math.ceil(W / GRASS_MASK_SCALE), h = Math.ceil(H / GRASS_MASK_SCALE);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = context2d(c, { willReadFrequently: true });
  g.drawImage(renderer.domElement, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  let px = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      if ((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0) < GRASS_PIXEL_MIN) continue;
      px++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (px === 0) return { px, x0: 0, y0: 0, x1: 0, y1: 0 };
  return { px, x0: +(x0 / w).toFixed(4), y0: +(y0 / h).toFixed(4), x1: +((x1 + 1) / w).toFixed(4), y1: +((y1 + 1) / h).toFixed(4) };
}

/** Mean luminance and HSV saturation of the frame (0..1), from a 1/8-size copy. */
function measure(src: HTMLCanvasElement): { lum: number; sat: number } {
  const c = document.createElement('canvas');
  c.width = Math.ceil(src.width / MEASURE_DOWNSCALE);
  c.height = Math.ceil(src.height / MEASURE_DOWNSCALE);
  const g = context2d(c, { willReadFrequently: true });
  g.drawImage(src, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let lum = 0, sat = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = (d[i] ?? 0) / 255, gg = (d[i + 1] ?? 0) / 255, b = (d[i + 2] ?? 0) / 255, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    lum += LUMA[0] * r + LUMA[1] * gg + LUMA[2] * b;
    sat += mx > 0 ? (mx - mn) / mx : 0;
  }
  const n = d.length / 4;
  return { lum: +(lum / n).toFixed(STATS_DIGITS), sat: +(sat / n).toFixed(STATS_DIGITS) };
}

/** ?series=60: mean luminance of every frame over that many seconds (flicker hunting); reports the outliers. */
async function series(aq: AquariumHandle, seconds: number, dt: number): Promise<void> {
  const canvas = aq.renderer.domElement, lums: number[] = [], hdr: HdrStats[] = [];
  const frames = Math.round(seconds / dt), jitter = new URLSearchParams(location.search).get('jitter') === '1';
  const hide = new URLSearchParams(location.search).get('hide') ?? '';
  if (hide.includes('snow')) aq.snow.points.visible = false;
  if (hide.includes('fish')) for (const f of aq.world.fish) f.model.visible = false;
  for (let i = 0; i < frames; i++) {
    aq.step(jitter ? 0.008 + Math.random() * 0.042 : dt);
    aq.present();
    lums.push(measure(canvas).lum);
    hdr.push(hdrStats(aq));
  }
  const sorted = [...lums].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const spikes = lums.map((lum, i) => ({ i, t: +(i * dt).toFixed(2), lum })).filter((f) => f.lum > median * 1.15);
  const report = { frames, median, min: sorted[0], max: sorted[sorted.length - 1], spikes, lums: lums.map((l) => +l.toFixed(3)) };
  const hs = hdr.map((h, i) => ({ i, ...h })).sort((a, b) => b.max - a.max).slice(0, 12);
  const hm = [...hdr].map((h) => h.mean).sort((a, b) => a - b);
  console.log('look hdr', JSON.stringify({ meanMin: hm[0], meanMed: hm[Math.floor(hm.length / 2)], meanMax: hm[hm.length - 1], worst: hs.map((h) => JSON.stringify(h)), over64: hdr.filter((h) => h.over > 0).length, bad: hdr.filter((h) => h.bad > 0).length }));
  console.log('look series', JSON.stringify(report));
  await postDone(JSON.stringify({ frames, median, min: report.min, max: report.max, spikes }));
}

interface HdrStats { mean: number; max: number; over: number; bad: number; at?: string }

function halfToFloat(h: number): number {
  const e = (h >> 10) & 31, m = h & 1023, sgn = h & 0x8000 ? -1 : 1;
  if (e === 0) return sgn * m * 2 ** -24;
  if (e === 31) return m ? NaN : sgn * Infinity;
  return sgn * (1 + m / 1024) * 2 ** (e - 15);
}

/** Linear HDR statistics of the water renderer's scene target (what the shaft, blur and photo passes read). */
function hdrStats(aq: AquariumHandle): HdrStats {
  const t = aq.water.target, w = t.width, h = t.height, buf = new Uint16Array(w * h * 4);
  aq.renderer.readRenderTargetPixels(t, 0, 0, w, h, buf as unknown as Float32Array);
  let sum = 0, max = 0, over = 0, bad = 0, maxI = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const r = halfToFloat(buf[i] ?? 0), g = halfToFloat(buf[i + 1] ?? 0), b = halfToFloat(buf[i + 2] ?? 0);
    if (!Number.isFinite(r + g + b)) { bad++; continue; }
    const l = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
    sum += l;
    if (l > max) { max = l; maxI = i / 4; }
    if (l > 64) over++;
  }
  let at: string | undefined;
  if (max > 200) {
    const ray = new aq.THREE.Raycaster(), ndc = new aq.THREE.Vector2(((maxI % w) + 0.5) / w * 2 - 1, ((Math.floor(maxI / w) + 0.5) / h) * 2 - 1);
    ray.setFromCamera(ndc, aq.camera);
    const hit = ray.intersectObjects(aq.scene.children, true)[0];
    const o = hit?.object;
    at = o ? [o.name, o.parent?.name, (o as THREE.Mesh).material && ((o as THREE.Mesh).material as THREE.Material).type, ((o as THREE.Mesh).material as THREE.Material | undefined)?.name].join('/') : 'none';
  }
  return { mean: +(sum / (w * h)).toFixed(4), max: +max.toFixed(1), over, bad, ...(at ? { at } : {}) };
}
