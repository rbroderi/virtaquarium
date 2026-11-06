// Procedural canvas textures for the reef: sand grain, rock pores and crust, the sea fan's lattice.
import * as THREE from 'three';
import { clamp, context2d, makeCanvas, range, type Rng } from '../util.js';
import { organicPass, type OrganicOptions } from '../core/organic.js';

/** Straight sea-fan branches bend and thicken unevenly. */
const SEA_FAN_ORGANIC: OrganicOptions = { warp: [[6, 6, 6, 6], [20, 20, 2, 2]], mottle: { cellsX: 6, cellsY: 6, value: 0.06, chroma: 0.03 } };

const BYTE_MAX = 255;

/** Speckled sand: per-texel brightness jitter with rare dark and bright grains. */
export function grainTexture(rng: Rng, size: number, base: readonly [number, number, number], spread: number, repeat: number): THREE.CanvasTexture {
  const c = makeCanvas(size, size), g = context2d(c);
  const img = g.createImageData(size, size);
  const [r0, g0, b0] = base;
  for (let i = 0; i < size * size; i++) {
    const k = (rng() - 0.5) * spread + (rng() < 0.03 ? -60 : 0) + (rng() < 0.02 ? 50 : 0);
    img.data[i * 4] = clamp(r0 + k, 0, BYTE_MAX);
    img.data[i * 4 + 1] = clamp(g0 + k * 0.95, 0, BYTE_MAX);
    img.data[i * 4 + 2] = clamp(b0 + k * 0.9, 0, BYTE_MAX);
    img.data[i * 4 + 3] = BYTE_MAX;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Height map of the rock's pores (bump and parallax, see parallax.ts: bright high, dark deep): a gently
 * undulating surface pitted with bowls, each with a slightly raised lip, some deep, most shallow. Drawn
 * wrapped, so the tile repeats without seams.
 */
export function poreTexture(rng: Rng): THREE.CanvasTexture {
  const s = 512, c = makeCanvas(s, s), g = context2d(c);
  g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, s, s);
  const blob = (x: number, y: number, r: number, inner: string, outer: string): void => {
    for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) {
      if (x + ox + r < 0 || x + ox - r > s || y + oy + r < 0 || y + oy - r > s) continue;
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, inner); gr.addColorStop(1, outer);
      g.fillStyle = gr; g.beginPath(); g.arc(x + ox, y + oy, r, 0, Math.PI * 2); g.fill();
    }
  };
  // Low undulation first, then the pits.
  for (let i = 0; i < 60; i++) blob(rng() * s, rng() * s, 30 + rng() * 60, `rgba(${rng() < 0.5 ? '200,200,200' : '70,70,70'},0.18)`, 'rgba(128,128,128,0)');
  for (let i = 0; i < 2200; i++) {
    const x = rng() * s, y = rng() * s, r = Math.pow(rng(), 3) * 10 + 1.2, d = 0.35 + rng() * 0.6;
    blob(x, y, r * 1.35, 'rgba(190,190,190,0.35)', 'rgba(190,190,190,0)');                         // the lip
    blob(x, y, r, `rgba(12,12,12,${d})`, `rgba(12,12,12,${d * 0.25})`);                              // the bowl
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 2);
  return t;
}

/** High-frequency surface detail for live rock: pores, coralline crust, encrusting algae, sponge flecks. */
export function rockDetailTexture(rng: Rng): THREE.CanvasTexture {
  const s = 1024, c = makeCanvas(s, s), g = context2d(c);
  g.fillStyle = '#d8d2c8'; g.fillRect(0, 0, s, s);
  const blot = (n: number, rMin: number, rMax: number, cols: readonly string[], a: number): void => {
    for (let i = 0; i < n; i++) {
      const x = rng() * s, y = rng() * s, r = rMin + Math.pow(rng(), 2) * (rMax - rMin);
      g.fillStyle = cols[Math.floor(rng() * cols.length)] ?? '#000000';
      g.globalAlpha = a * (0.5 + rng() * 0.5);
      g.beginPath();
      for (let k = 0; k < 9; k++) { const t = (k / 9) * Math.PI * 2, rr = r * (0.6 + rng() * 0.6); g.lineTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr); }
      g.fill();
    }
  };
  blot(500, 6, 40, ['#b58fb4', '#c99ab0', '#9c7aa8'], 0.35);    // coralline algae crust
  blot(300, 4, 22, ['#a7a37a', '#8f9a6a'], 0.3);                // turf / encrusting algae
  blot(2500, 1, 5, ['#3a3029', '#2a221e'], 0.55);             // pores
  blot(800, 1, 3, ['#f2ece0', '#e8c9a8'], 0.5);               // sponge / calcareous flecks
  blot(80, 3, 9, ['#d8573a', '#e0a030'], 0.45);               // small sponges
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 2);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** The gorgonian's branching lattice, drawn as a recursive tree with short cross links. */
export function seaFanTexture(rng: Rng): THREE.CanvasTexture {
  const W = 512, H = 512, c = makeCanvas(W, H), g = context2d(c);
  g.lineCap = 'round';
  const branch = (x: number, y: number, a: number, len: number, w: number, d: number): void => {
    const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
    g.strokeStyle = `rgba(${200 + d * 6},${95 + d * 10},${55 + d * 5},0.95)`;
    g.lineWidth = w;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
    if (d <= 0 || y2 < 10) return;
    branch(x2, y2, a + range(rng, -0.5, -0.1), len * 0.82, w * 0.75, d - 1);
    branch(x2, y2, a + range(rng, 0.1, 0.5), len * 0.82, w * 0.75, d - 1);
  };
  branch(W / 2, H, -Math.PI / 2, 90, 12, 8);
  // Mesh-like cross links
  g.strokeStyle = 'rgba(210,110,70,0.35)'; g.lineWidth = 1;
  for (let i = 0; i < 400; i++) {
    const x = rng() * W, y = rng() * H * 0.85;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + range(rng, -14, 14), y + range(rng, -14, 14)); g.stroke();
  }
  organicPass(g, W, H, rng, SEA_FAN_ORGANIC);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
