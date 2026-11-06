// Masks of what covers the screen. The render is measured as a coverage mask: the scene is drawn over
// black and over white, so translucent fins count by how much they actually hide.
import * as THREE from 'three';
import { context2d, makeCanvas } from '../util.js';
import type { LabHost } from './labHost.js';

export interface Box { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
export interface CoverageMask { readonly w: number; readonly h: number; readonly mask: Uint8Array; readonly box: Box | null }

const RGBA = 4;
const RGB_SUM_MAX = 765;
// Low enough that faint membranes (lionfish caudal, alpha ~0.35) count, as they do in the traces.
const COVERED = 0.2;
const ALPHA_INSIDE = 127;
const BACKGROUNDS = [0x000000, 0xffffff] as const;

function renderOver(lab: LabHost, rt: THREE.WebGLRenderTarget, colour: number, w: number, h: number): Uint8Array {
  lab.scene.background = new THREE.Color(colour);
  lab.renderer.setRenderTarget(rt);
  lab.render();
  const buf = new Uint8Array(w * h * RGBA);
  lab.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  return buf;
}

export function coverageMask(lab: LabHost, w: number, h: number): CoverageMask {
  const { renderer, scene, backdrop, camera } = lab;
  // The lab's frame loop may not have run yet (e.g. right after load), so match the aspect here.
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const rt = new THREE.WebGLRenderTarget(w, h);
  const background = scene.background, backdropVisible = backdrop.visible;
  backdrop.visible = false;
  const [black, white] = BACKGROUNDS.map((c) => renderOver(lab, rt, c, w, h));
  renderer.setRenderTarget(null);
  scene.background = background;
  backdrop.visible = backdropVisible;
  rt.dispose();
  const mask = new Uint8Array(w * h);
  if (!black || !white) return { w, h, mask, box: null };
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w;   // GL rows are bottom-up
    for (let x = 0; x < w; x++) {
      const i = (src + x) * RGBA;
      let lift = 0;
      for (let c = 0; c < 3; c++) lift += (white[i + c] ?? 0) - (black[i + c] ?? 0);
      if (1 - lift / RGB_SUM_MAX < COVERED) continue;
      mask[y * w + x] = 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { w, h, mask, box: x1 < 0 ? null : { x0, y0, x1, y1 } };
}

/** The traced outline (already in CSS px) filled as a mask. */
export function outlineMask(points: readonly (readonly [number, number])[], w: number, h: number): Uint8Array {
  const g = context2d(makeCanvas(w, h), { willReadFrequently: true });
  g.beginPath();
  points.forEach(([u, v], i) => (i ? g.lineTo(u, v) : g.moveTo(u, v)));
  g.closePath();
  g.fillStyle = '#fff';
  g.fill();
  const d = g.getImageData(0, 0, w, h).data, mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = (d[i * RGBA + 3] ?? 0) > ALPHA_INSIDE ? 1 : 0;
  return mask;
}
