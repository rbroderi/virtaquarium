// Deferred variant painting: fish start on their species' variant-0 textures (shared, so startup stays
// fast); the variants a stock actually uses are painted one per idle slice after the first frames, then
// their colour maps are swapped onto the fish.
import type { Species } from '../species/types.js';
import type { FishModel } from './model.js';
import { speciesAssets } from './assets.js';
import { applyVariantMaps } from './builder.js';

interface PendingVariant { sp: Species; variant: number; models: FishModel[] }

const pending = new Map<string, PendingVariant>();
let order: string[] = [];
let startedAt = 0;

/** Queues a fish to receive its variant's colour maps once they are painted. */
export function requestVariant(sp: Species, variant: number, model: FishModel): void {
  if (variant <= 0) return;
  const key = `${sp.id}:${variant}`;
  let group = pending.get(key);
  if (!group) { group = { sp, variant, models: [] }; pending.set(key, group); order.push(key); }
  group.models.push(model);
}

/** Paints and swaps the next queued species+variant, if any. Returns true when it did. */
function paintNext(): boolean {
  const key = order.shift();
  if (key === undefined) return false;
  const group = pending.get(key);
  pending.delete(key);
  if (!group) return false;
  const a = speciesAssets(group.sp, group.variant);
  for (const m of group.models) applyVariantMaps(m, a);
  return true;
}

/** Paints and swaps every queued variant now (used by checks that need them before a frame). */
export function paintPendingVariants(): void {
  while (paintNext());
}

/** Paints the queued variants one per idle slice, so they never block the tank's first frames. */
export function startIdleVariantPainting(): void {
  if (order.length === 0) return;
  startedAt = performance.now();
  const step = (): void => {
    paintNext();
    if (order.length === 0) {
      console.info(`Variants swapped in after ${Math.round(performance.now() - startedAt)} ms`);
      return;
    }
    schedule();
  };
  const schedule = (): void => {
    const g = globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
    if (g.requestIdleCallback) g.requestIdleCallback(() => step(), { timeout: 1000 });
    else setTimeout(step, 50);
  };
  schedule();
}
