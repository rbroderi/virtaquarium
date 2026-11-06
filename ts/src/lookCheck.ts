// Look check, run on the tank page with ?check=look (headless: tools/check.ts look). Steps the tank as
// the live loop does, at 30 Hz, and at each requested moment renders a frame and saves it to
// ts/out/look-<tag>-<t>s.png, plus close-ups (ts/out/look-<tag>-<t>s-<what>.png) of
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
  if (fish) return { pos: fish.pos, worm: false };
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
