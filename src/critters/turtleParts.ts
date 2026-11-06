// The turtle's textures and flipper shape.
import * as THREE from 'three';
import { range, clamp, lerp, makeCanvas, context2d, Noise, type Rng } from '../util.js';
import { canvasTexture } from './shared.js';
import { organicPass, type OrganicOptions } from '../core/organic.js';

/** The scute seams wander instead of running as straight Voronoi edges. */
const CARAPACE_ORGANIC: OrganicOptions = { warp: [[6, 6, 10, 10], [20, 20, 3, 3]], mottle: { cellsX: 6, cellsY: 6, value: 0.06, chroma: 0.03 } };
/** Strong enough that the hexagons become uneven polygons, as a turtle's head scales are. */
const SCALE_ORGANIC: OrganicOptions = { warp: [[4, 4, 7, 7], [12, 12, 2.5, 2.5]], mottle: { cellsX: 4, cellsY: 4, value: 0.08, chroma: 0.03 }, wrapX: true, wrapY: true };

type Scute = readonly [cx: number, cy: number, r: number];

/** Scute centres in planform coordinates (x along the body, y across), unit carapace. */
function scuteCentres(): Scute[] {
  const scutes: Scute[] = [];
  const VERTEBRALS = 5, COSTALS = 4, MARGINALS = 12;
  for (let i = 0; i < VERTEBRALS; i++) scutes.push([lerp(0.78, 0.2, i / (VERTEBRALS - 1)), 0.5, 0.11]);
  for (const s of [1, -1]) for (let i = 0; i < COSTALS; i++) scutes.push([lerp(0.7, 0.28, i / (COSTALS - 1)), 0.5 + s * 0.24, 0.12]);
  for (const s of [1, -1]) for (let i = 0; i < MARGINALS; i++) {
    const a = lerp(-1.35, 1.35, i / (MARGINALS - 1));
    scutes.push([0.5 + Math.sin(a) * 0.44, 0.5 + s * Math.cos(a) * 0.43, 0.05]);
  }
  return scutes;
}

/**
 * The carapace: five vertebral, four pairs of costal and the marginal scutes, each with the radiating
 * orange-brown streaks of a juvenile.
 */
export function carapaceTex(rng: Rng): THREE.CanvasTexture {
  const S = 1024, c = makeCanvas(S, S), g = context2d(c), n = new Noise(rng);
  g.fillStyle = '#6a3a1e'; g.fillRect(0, 0, S, S);
  const scutes = scuteCentres();
  const dark = [62, 40, 22] as const, amber = [170, 100, 48] as const, seamC = [168, 140, 104] as const;
  // Voronoi cells: each pixel belongs to the nearest scute; streaks radiate from its centre.
  const img = g.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    let b1 = 9, b2 = 9, bi = 0;
    scutes.forEach(([cx, cy, r], i) => {
      const dd = Math.hypot(u - cx, (v - cy) * 1.05) / (r + 0.06);
      if (dd < b1) { b2 = b1; b1 = dd; bi = i; } else if (dd < b2) b2 = dd;
    });
    const [cx, cy] = scutes[bi] ?? [0.5, 0.5, 0];
    // Dark olive-brown scutes; irregular amber streaks radiate from each scute's growth centre, broken
    // up by noise so they read as a juvenile's sunburst, not a regular star.
    const ang = Math.atan2(v - cy, u - cx), wav = n.noise2(u * 40, v * 40);
    const streak = Math.pow(0.5 + 0.5 * Math.sin(ang * (8 + (bi % 3)) + wav * 7), 2) * (0.25 + 0.75 * n.noise2(u * 9 + bi, v * 9));   // ~8-10 broad, broken streaks per scute
    const seam = clamp((b2 - b1) * 16, 0, 1);
    const centre = clamp(1 - b1 * 1.3, 0, 1);
    const k = (y * S + x) * 4;
    const t = clamp(streak * (0.5 + 0.6 * b1) + centre * 0.25, 0, 1);
    let r = lerp(dark[0], amber[0], t), gg = lerp(dark[1], amber[1], t), bb = lerp(dark[2], amber[2], t);
    r = lerp(seamC[0], r, seam); gg = lerp(seamC[1], gg, seam); bb = lerp(seamC[2], bb, seam);
    d[k] = r; d[k + 1] = gg; d[k + 2] = bb; d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  organicPass(g, S, S, rng, CARAPACE_ORGANIC);
  return canvasTexture(c);
}

const SCALE_COLOURS: readonly string[] = ['#3a2614', '#4a3018', '#2e1e10', '#54381c'];

/** Dark brown polygonal scales with thin pale seams between them (head and flippers). */
export function scaleTex(rng: Rng): THREE.CanvasTexture {
  const S = 256, c = makeCanvas(S, S), g = context2d(c);
  g.fillStyle = '#b8a888'; g.fillRect(0, 0, S, S);
  const N = 12, cell = S / N, SIDES = 6;
  for (let gy = -1; gy <= N; gy++) for (let gx = -1; gx <= N; gx++) {
    const x = (gx + 0.5 + (gy & 1) * 0.5 + range(rng, -0.15, 0.15)) * cell, y = (gy + 0.5 + range(rng, -0.15, 0.15)) * cell, r = cell * range(rng, 0.52, 0.6);
    g.fillStyle = SCALE_COLOURS[(gx * 7 + gy * 3) & 3] ?? '#3a2614';
    g.beginPath();
    for (let k = 0; k < SIDES; k++) { const a = (k / SIDES) * Math.PI * 2 + 0.5 + rng() * 0.2; g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); }
    g.fill();
  }
  organicPass(g, S, S, rng, SCALE_ORGANIC);
  const t = canvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1.4, 1.4);
  return t;
}

/** A flattened, tapering paddle pivoting at its root (out along +z). */
export function paddle(len: number, wid: number, sweep: number): THREE.SphereGeometry {
  const g = new THREE.SphereGeometry(1, 24, 12);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = (z + 1) / 2;   // 0 root .. 1 tip (out along +z)
    const w = wid * (0.55 + 0.75 * Math.sin(Math.PI * Math.min(1, t * 1.3))) * (1 - 0.45 * t) * Math.sqrt(Math.max(0, 1 - z * z) + 0.02);
    p.setXYZ(i, x * w - t * t * sweep, y * 0.12 * wid * (1 - 0.6 * t), (z + 1) * 0.5 * len);
  }
  g.computeVertexNormals();
  return g;
}
