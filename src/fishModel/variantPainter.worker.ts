// Paints a variant's colour maps (body albedo, fin sheet, pectoral sheet) off the main thread, on
// OffscreenCanvas. The painters below only use canvas 2D, pure TS and three's math classes, so they run
// unchanged in a worker; the one thing they need that a worker lacks is a DOM canvas factory, which the
// shim below supplies (makeCanvas/context2d in core/canvas.ts reach it through document.createElement).
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

interface PaintRequest { readonly id: number; readonly sp: Species; readonly needSkin: boolean }
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
function skinMean(canvas: OffscreenCanvas): [number, number, number] {
  const W = 8, H = 4;
  let src: OffscreenCanvas = canvas;
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

async function paint(sp: Species, needSkin: boolean): Promise<{ skin?: ImageBitmap; skinPng?: Blob; avg?: [number, number, number]; fins: ImageBitmap; pect: ImageBitmap }> {
  const prof = makeProfile(sp.body);
  const skin = needSkin ? paintSkin(sp, prof) : null;
  const fins = paintFins(sp, prof, true);
  const pect = sp.pectoral ? paintPectoral(sp) : new OffscreenCanvas(4, 4);
  const avg = skin ? skinMean(skin.map as unknown as OffscreenCanvas) : undefined;
  // The PNG is encoded in the worker too: canvas.toBlob/PNG encoding would otherwise block the main
  // thread (a 2048x1024 skin takes several seconds), which is exactly the hitch this worker exists to
  // avoid. The saved PNG is upright; the texture bitmap is flipped, and cached loads flip once on decode.
  const skinPng = skin ? await (skin.map as unknown as OffscreenCanvas).convertToBlob({ type: 'image/png' }) : undefined;
  const [skinBmp, finsBmp, pectBmp] = await Promise.all([
    skin ? flippedBitmap(skin.map) : Promise.resolve(undefined),
    flippedBitmap(fins.canvas),
    flippedBitmap(pect),
  ]);
  const result: { skin?: ImageBitmap; skinPng?: Blob; avg?: [number, number, number]; fins: ImageBitmap; pect: ImageBitmap } = { fins: finsBmp, pect: pectBmp };
  if (skinBmp) result.skin = skinBmp;
  if (skinPng) result.skinPng = skinPng;
  if (avg) result.avg = avg;
  return result;
}

self.onmessage = (e: MessageEvent<PaintRequest>): void => {
  const { id, sp, needSkin } = e.data;
  paint(sp, needSkin).then(
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
