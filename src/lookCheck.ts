// Look check, run on the tank page with ?check=look (headless: tools/check.ts look). Steps the tank as
// the live loop does, at 30 Hz, and at each requested moment renders a frame and saves it to
// out/look-<tag>-<t>s.png, plus close-ups (out/look-<tag>-<t>s-<what>.png) of
//   station   the cleaning station (cleaner and client)
//   <species> the first fish of that species
//   fanworm   the most open feather-duster worm
//   <name>    a scenery piece by its object name (rock_a, coral_table, ...)
// URL options: &at=5,30 (seconds), &close=station,cleanerwrasse, &tag=name, &night=1 (lights off).
// Reports { files, stats } to /__done, stats per frame: mean luminance and saturation, so looks can be
// compared over time without opening the pictures.
import * as THREE from 'three';
import type { AquariumHandle } from './app/handle.js';
import { context2d } from './util.js';
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

interface FrameStats { t: number; lum: number; sat: number }

export async function main(aq: AquariumHandle): Promise<void> {
  const { world, renderer } = aq;
  const q = new URLSearchParams(location.search);
  const at = (q.get('at') || '5,30').split(',').map(Number).sort((a, b) => a - b);
  const close = (q.get('close') || 'station').split(',').filter(Boolean);
  const tag = q.get('tag') || 'tank';
  if (q.get('night') === '1') aq.setLight(0);
  aq.fitCanvas();
  if (q.get('series')) return series(aq, Number(q.get('series')), Number(q.get('dt') || DT));
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

function closeUp(aq: AquariumHandle, what: string, canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  const target = closeUpTarget(aq, what);
  if (!target) return null;
  const v = target.pos.clone().project(aq.camera), W = canvas.width, H = canvas.height;
  const s = Math.round(H * (target.worm ? WORM_CLOSE_UP_FRACTION : CLOSE_UP_FRACTION));
  const x = Math.round(((v.x + 1) / 2) * W - s / 2), y = Math.round(((1 - v.y) / 2) * H - s / 2);
  const c = document.createElement('canvas');
  c.width = c.height = CLOSE_UP_PX;
  context2d(c).drawImage(canvas, Math.max(0, Math.min(W - s, x)), Math.max(0, Math.min(H - s, y)), s, s, 0, 0, CLOSE_UP_PX, CLOSE_UP_PX);
  return c;
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
