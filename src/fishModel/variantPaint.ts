// Client for the painter workers: paints a species' colour maps off the main thread. Two jobs:
//  - a variant's colour maps (body albedo, fin sheet, pectoral sheet), returned as WebGL-flipped
//    ImageBitmaps ready to upload; the worker also reads the variant's saved skin (fetch + decode) and
//    encodes the cache PNG, so the main thread only posts the finished PNG back to the server;
//  - a species' base (variant 0) skin and fin relief maps when the skin cache doesn't have them, returned
//    as the cache's PNGs and as bitmaps decoded from those PNGs exactly as a cache hit decodes them, so
//    a fish built from them is the same as one built from the cache.
import type { Species } from '../species/types.js';
import type { SkinMapName } from './skinCache.js';

export interface VariantCache { readonly metaUrl: string; readonly skinUrl: string; readonly key: string }

export interface VariantPaint {
  skin?: ImageBitmap;
  skinPng?: Blob;
  /** The skin's mean colour (0..1), from the cache meta or computed in the worker when painted. */
  skinAvg?: readonly [number, number, number];
  fins: ImageBitmap;
  pect: ImageBitmap;
}

/** A species' variant-0 skin and fin relief maps, painted in a worker. */
export interface BasePaint {
  readonly img: Record<SkinMapName, ImageBitmap>;
  readonly png: Record<SkinMapName, Blob>;
  readonly skinAvg: readonly [number, number, number];
}

// The worker entry is bundled next to the app chunks (web/build/fishModel/variantPainter.worker.js);
// a document-relative URL keeps the path independent of which chunk this module lands in.
const WORKER_URL = 'build/fishModel/variantPainter.worker.js';
/** Startup paints several species at once; more workers than this only compete with the main thread. */
const MAX_WORKERS = 4;

interface Reply {
  readonly id: number;
  readonly error?: string;
  readonly skin?: ImageBitmap; readonly skinPng?: Blob; readonly avg?: readonly [number, number, number];
  readonly fins?: ImageBitmap; readonly pect?: ImageBitmap;
  readonly img?: Record<SkinMapName, ImageBitmap>; readonly png?: Record<SkinMapName, Blob>;
}
interface Pending { readonly ok: (r: Reply) => void; readonly fail: (e: Error) => void; readonly slot: Slot }
interface Slot { worker: Worker | null; busy: number }

const slots: Slot[] = [];
let nextId = 1;
const pending = new Map<number, Pending>();

function poolSize(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}

function startWorker(slot: Slot): Worker {
  const worker = new Worker(WORKER_URL, { type: 'module' });
  worker.onmessage = (e: MessageEvent<Reply>) => {
    const reply = e.data;
    const p = pending.get(reply.id);
    pending.delete(reply.id);
    if (!p) return;
    p.slot.busy--;
    if (reply.error) p.fail(new Error(reply.error));
    else p.ok(reply);
  };
  worker.onerror = (e: ErrorEvent) => {
    // A worker that failed to load (no message: the script fetch or module evaluation failed) is dead and
    // would never answer again, so later requests would hang; drop it and let the next one start afresh.
    const err = new Error(e.message || 'painter worker failed to load');
    for (const [id, p] of pending) if (p.slot === slot) { pending.delete(id); p.fail(err); }
    slot.busy = 0;
    worker.terminate();
    slot.worker = null;
  };
  return worker;
}

/** Posts a job to the least busy worker of the pool (starting it if needed). */
function post(msg: Record<string, unknown>): Promise<Reply> {
  while (slots.length < poolSize()) slots.push({ worker: null, busy: 0 });
  const slot = slots.reduce((a, b) => (b.busy < a.busy ? b : a));
  slot.worker ??= startWorker(slot);
  const worker = slot.worker;
  const id = nextId++;
  slot.busy++;
  return new Promise<Reply>((ok, fail) => {
    pending.set(id, { ok, fail, slot });
    worker.postMessage({ id, ...msg });
  });
}

/** Produces the variant's colour maps; `cache` lets the worker read a saved skin instead of painting it. */
export async function paintVariantMaps(sp: Species, cache: VariantCache | null): Promise<VariantPaint> {
  const reply = await post({ kind: 'variant', sp, cache });
  if (!reply.skin || !reply.fins || !reply.pect) throw new Error('variant paint failed');
  const maps: VariantPaint = { skin: reply.skin, fins: reply.fins, pect: reply.pect };
  if (reply.skinPng) maps.skinPng = reply.skinPng;
  if (reply.avg) maps.skinAvg = reply.avg;
  return maps;
}

/** Paints a species' variant-0 skin and fin relief maps (what the skin cache holds) in a worker. */
export async function paintBaseMaps(sp: Species): Promise<BasePaint> {
  if (typeof OffscreenCanvas === 'undefined' || typeof Worker === 'undefined') throw new Error('no OffscreenCanvas worker');
  const reply = await post({ kind: 'base', sp });
  if (!reply.img || !reply.png || !reply.avg) throw new Error('base paint failed');
  return { img: reply.img, png: reply.png, skinAvg: reply.avg };
}
