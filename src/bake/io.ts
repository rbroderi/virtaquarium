// Output plumbing for the bake: the log, uploads to the dev server's /__save, and canvas helpers.
import { context2d, requireElement } from '../util.js';
import { OUT_DIR } from './config.js';

/** [x, y, w, h] in pixels. */
export type Rect = [number, number, number, number];

export type Log = (message: string) => void;

export function pageLog(): Log {
  const el = requireElement('log', HTMLDivElement);
  return (message) => {
    el.textContent += message + '\n';
    console.log(message);
  };
}

/** Writes one asset under roku/assets/. */
export async function saveAsset(path: string, body: Blob | string): Promise<void> {
  const res = await fetch('/__save?path=' + encodeURIComponent(OUT_DIR + path), { method: 'POST', body });
  if (!res.ok) throw new Error(`save ${path}: HTTP ${res.status}`);
}

export function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(`toBlob ${type} failed`))), type, quality);
  });
}

/** An alpha below this counts as empty. */
const ALPHA_EMPTY = 2;

/** Bounding box of the non-transparent pixels of `img`; [0, 0, 1, 1] if empty. */
export function alphaBox(img: ImageData): Rect {
  let x0 = img.width, y0 = img.height, x1 = 0, y1 = 0;
  const d = img.data;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if ((d[(y * img.width + x) * 4 + 3] ?? 0) < ALPHA_EMPTY) continue;
      if (x < x0) x0 = x;
      if (x >= x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y >= y1) y1 = y + 1;
    }
  }
  return x1 > x0 ? [x0, y0, x1 - x0, y1 - y0] : [0, 0, 1, 1];
}

export function blankCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function cropCanvas(src: HTMLCanvasElement, [x, y, w, h]: Rect): HTMLCanvasElement {
  const c = blankCanvas(w, h);
  context2d(c).drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}

/** A 2D context set up for reading back renders (high-quality downscaling of the supersampled frame). */
export function readbackContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = context2d(canvas, { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  return g;
}
