// Paints a variant's colour maps (body albedo, fin sheet, pectoral sheet) off the main thread, on
// OffscreenCanvas, and also reads the variant's saved skin cache (fetch + ImageBitmap decode) here, so
// no decode, mean-colour readback or PNG encode ever runs on the main thread. The painters below only
// use canvas 2D, pure TS and three's math classes, so they run unchanged in a worker; the one thing they
// need that a worker lacks is a DOM canvas factory, which the shim below supplies.
import { makeProfile } from './profile.js';
import { paintSkin } from './skin.js';
import { paintFins } from './fins.js';
import { paintPectoral } from './pectoral.js';
import type { Species } from '../species/types.js';

// OffscreenCanvas stands in for document.createElement('canvas'); makeCanvas sets width/height afterwards.
const canvasShim = {
  createElement(tag: string): OffscreenCanvas {
    if (tag !== 'canvas') throw new Error(`variantPainter worker: cannot create <${tag}>`);
    return new OffscreenCanvas(1, 1);
  },
};
(globalThis as { document?: unknown }).document = canvasShim;

interface VariantCache { readonly metaUrl: string; readonly skinUrl: string; readonly key: string }
interface PaintRequest { readonly id: number; readonly sp: Species; readonly cache: VariantCache | null }
interface PaintReply {
  readonly id: number;
  readonly skin?: ImageBitmap;
  readonly skinPng?: Blob;
  readonly avg?: readonly [number, number, number];
  readonly fins?: ImageBitmap;
  readonly pect?: ImageBitmap;
  readonly error?: string;
}

// A bitmap flipped to WebGL's bottom-left origin, matching the cached PNGs' imageOrientation:'flipY'
// decode: the main thread uploads every bitmap with texture.flipY = false, so the two paths agree.
async function flippedBitmap(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<ImageBitmap> {
  const out = new OffscreenCanvas(canvas.width, canvas.height);
  const g = out.getContext('2d');
  if (!g) throw new Error('variantPainter worker: 2D canvas context unavailable');
  g.translate(0, canvas.height);
  g.scale(1, -1);
  g.drawImage(canvas, 0, 0);
  return createImageBitmap(out);
}

// The skin's mean colour (for the velvet sheen), averaged the same way assets.meanColour does, but here
// on the worker's OffscreenCanvas so reading the pixels never blocks the main thread.
function skinMean(canvas: OffscreenCanvas | ImageBitmap): [number, number, number] {
  const W = 8, H = 4;
  let src: OffscreenCanvas | ImageBitmap = canvas;
  let w = canvas.width, h = canvas.height;
  while (w > W || h > H) {
    const nw = Math.max(W, w >> 1), nh = Math.max(H, h >> 1);
    const half = new OffscreenCanvas(nw, nh);
    const g = half.getContext('2d');
    if (!g) throw new Error('variantPainter worker: 2D canvas context unavailable');
    g.imageSmoothingQuality = 'low';
    g.drawImage(src, 0, 0, nw, nh);
    src = half; w = nw; h = nh;
  }
  const t = new OffscreenCanvas(W, H);
  const tg = t.getContext('2d', { willReadFrequently: true });
  if (!tg) throw new Error('variantPainter worker: 2D canvas context unavailable');
  tg.drawImage(src, 0, 0, W, H);
  const px = tg.getImageData(0, 0, W, H).data;
  const s = [0, 0, 0], n = W * H;
  for (let i = 0; i < px.length; i += 4) for (let ch = 0; ch < 3; ch++) s[ch] = (s[ch] ?? 0) + (px[i + ch] ?? 0) / 255 / n;
  return [s[0] ?? 0, s[1] ?? 0, s[2] ?? 0];
}

async function loadCachedSkin(cache: VariantCache): Promise<{ skin?: ImageBitmap; avg?: [number, number, number] }> {
  try {
    const r = await fetch(cache.metaUrl, { cache: 'no-cache' });
    if (!r.ok) return {};
    const meta: unknown = await r.json();
    if (!meta || typeof meta !== 'object' || (meta as { key?: unknown }).key !== cache.key) return {};
    const r2 = await fetch(cache.skinUrl);
    if (!r2.ok) return {};
    const skin = await createImageBitmap(await r2.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const m = (meta as { avg?: unknown }).avg;
    const avg = Array.isArray(m) && m.length === 3 && m.every((v) => typeof v === 'number') ? (m as [number, number, number]) : undefined;
    return { skin, ...(avg ? { avg } : {}) };
  } catch { return {}; }
}

async function paint(sp: Species, cache: VariantCache | null): Promise<{ skin?: ImageBitmap; skinPng?: Blob; avg?: [number, number, number]; fins: ImageBitmap; pect: ImageBitmap }> {
  const prof = makeProfile(sp.body);
  const fins = paintFins(sp, prof, true);
  const pect = sp.pectoral ? paintPectoral(sp) : new OffscreenCanvas(4, 4);

  let skin: ImageBitmap | undefined;
  let skinPng: Blob | undefined;
  let avg: [number, number, number] | undefined;
  const cached = cache ? await loadCachedSkin(cache) : {};
  if (cached.skin) {
    skin = cached.skin;
    avg = cached.avg ?? skinMean(cached.skin);   // cache files written before avg was saved
  } else {
    const painted = paintSkin(sp, prof);
    avg = skinMean(painted.map as unknown as OffscreenCanvas);
    skinPng = await (painted.map as unknown as OffscreenCanvas).convertToBlob({ type: 'image/png' });
    skin = await flippedBitmap(painted.map);
  }

  const [finsBmp, pectBmp] = await Promise.all([flippedBitmap(fins.canvas), flippedBitmap(pect)]);
  const result: { skin?: ImageBitmap; skinPng?: Blob; avg?: [number, number, number]; fins: ImageBitmap; pect: ImageBitmap } = { fins: finsBmp, pect: pectBmp };
  if (skin) result.skin = skin;
  if (skinPng) result.skinPng = skinPng;
  if (avg) result.avg = avg;
  return result;
}

self.onmessage = (e: MessageEvent<PaintRequest>): void => {
  const { id, sp, cache } = e.data;
  paint(sp, cache).then(
    (maps) => {
      const transfer: Transferable[] = [maps.fins, maps.pect];
      if (maps.skin) transfer.push(maps.skin);
      const reply: PaintReply = { id, fins: maps.fins, pect: maps.pect, ...(maps.skin ? { skin: maps.skin } : {}), ...(maps.skinPng ? { skinPng: maps.skinPng } : {}), ...(maps.avg ? { avg: maps.avg } : {}) };
      (self as unknown as Worker).postMessage(reply, transfer);
    },
    (err: unknown) => {
      (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies PaintReply);
    },
  );
};
