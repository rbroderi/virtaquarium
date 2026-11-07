// Client for the variant painter worker: paints a species' variant colour maps (body albedo, fin sheet,
// pectoral sheet) off the main thread and returns them as WebGL-flipped ImageBitmaps, ready to upload.
// The worker also reads the variant's saved skin cache (fetch + decode) and encodes the cache PNG, so the
// main thread only posts the finished PNG back to the server.
import type { Species } from '../species/types.js';

export interface VariantCache { readonly metaUrl: string; readonly skinUrl: string; readonly key: string }

export interface VariantPaint {
  skin?: ImageBitmap;
  skinPng?: Blob;
  /** The skin's mean colour (0..1), from the cache meta or computed in the worker when painted. */
  skinAvg?: readonly [number, number, number];
  fins: ImageBitmap;
  pect: ImageBitmap;
}

// The worker entry is bundled next to the app chunks (web/build/fishModel/variantPainter.worker.js);
// a document-relative URL keeps the path independent of which chunk this module lands in.
const WORKER_URL = 'build/fishModel/variantPainter.worker.js';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { ok: (p: VariantPaint) => void; fail: (e: Error) => void }>();

interface PaintReply { readonly id: number; readonly error?: string; readonly skin?: ImageBitmap; readonly skinPng?: Blob; readonly avg?: readonly [number, number, number]; readonly fins?: ImageBitmap; readonly pect?: ImageBitmap }

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(WORKER_URL, { type: 'module' });
  worker.onmessage = (e: MessageEvent<PaintReply>) => {
    const reply = e.data;
    const p = pending.get(reply.id);
    pending.delete(reply.id);
    if (!p) return;
    if (reply.error || !reply.skin || !reply.fins || !reply.pect) { p.fail(new Error(reply.error ?? 'variant paint failed')); return; }
    const maps: VariantPaint = { skin: reply.skin, fins: reply.fins, pect: reply.pect };
    if (reply.skinPng) maps.skinPng = reply.skinPng;
    if (reply.avg) maps.skinAvg = reply.avg;
    p.ok(maps);
  };
  worker.onerror = (e: ErrorEvent) => {
    const err = new Error(e.message || 'variant painter worker failed');
    for (const p of pending.values()) p.fail(err);
    pending.clear();
  };
  return worker;
}

/** Produces the variant's colour maps; `cache` lets the worker read a saved skin instead of painting it. */
export function paintVariantMaps(sp: Species, cache: VariantCache | null): Promise<VariantPaint> {
  const id = nextId++;
  return new Promise<VariantPaint>((ok, fail) => {
    pending.set(id, { ok, fail });
    ensureWorker().postMessage({ id, sp, cache });
  });
}
