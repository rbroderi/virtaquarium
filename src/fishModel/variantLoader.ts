// Deferred variant painting: fish start on their species' variant-0 textures (shared, so startup stays
// fast). The colour maps a stock actually uses are produced asynchronously after the first frame — their
// skin albedo from the saved variant cache, their fin and pectoral sheets (and any uncached skin) in a
// worker — then the three textures are swapped onto the fish one map per frame, so neither the paint nor
// the GPU uploads ever block the main thread for long.
import type { Species } from '../species/types.js';
import type { FishModel } from './model.js';
import { variantColourMaps, type VariantMaps } from './assets.js';
import { applyVariantMaps, applyVariantPart } from './builder.js';

interface PendingVariant { sp: Species; variant: number; models: FishModel[] }

const pending = new Map<string, PendingVariant>();
let order: string[] = [];
let startedAt = 0;
let processing: Promise<void> | null = null;

/** Queues a fish to receive its variant's colour maps once they are painted. */
export function requestVariant(sp: Species, variant: number, model: FishModel): void {
  if (variant <= 0) return;
  const key = `${sp.id}:${variant}`;
  let group = pending.get(key);
  if (!group) { group = { sp, variant, models: [] }; pending.set(key, group); order.push(key); }
  group.models.push(model);
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Swaps the three colour maps one per frame, so each GPU upload is a frame apart. */
async function applyStaggered(models: FishModel[], maps: VariantMaps): Promise<void> {
  for (const part of ['body', 'fin', 'pect'] as const) {
    for (const m of models) applyVariantPart(m, part, maps);
    await nextFrame();
  }
}

async function produce(group: PendingVariant, staggered: boolean): Promise<void> {
  const maps = await variantColourMaps(group.sp, group.variant);
  if (staggered) await applyStaggered(group.models, maps);
  else for (const m of group.models) applyVariantMaps(m, maps);
}

/** Processes every queued variant; the live tank staggers uploads, checks apply them all at once. */
function processAll(staggered: boolean): Promise<void> {
  if (processing) return processing;
  processing = (async () => {
    if (!order.length) return;
    startedAt = performance.now();
    while (order.length) {
      const key = order.shift();
      if (key === undefined) break;
      const group = pending.get(key);
      pending.delete(key);
      if (!group) continue;
      try {
        await produce(group, staggered);
      } catch (err) {
        console.warn(`variant ${group.sp.id}:${group.variant} failed:`, err instanceof Error ? err.message : err);
      }
    }
    console.info(`Variants swapped in after ${Math.round(performance.now() - startedAt)} ms`);
  })().finally(() => { processing = null; });
  return processing;
}

/** Paints and swaps every queued variant now (used by checks that need them before a frame). */
export function paintPendingVariants(): Promise<void> {
  return processAll(false);
}

/** How many variants are still queued or being produced (1 while the current one is in flight). */
export function pendingVariantCount(): number {
  return order.length + (processing ? 1 : 0);
}

/** Starts producing the queued variants; the live tank calls this after its first frame. */
export function startIdleVariantPainting(): void {
  if (order.length === 0 || processing) return;
  void processAll(true);
}
