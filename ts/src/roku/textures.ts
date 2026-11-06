// Texture memory as the Roku keeps it. A bitmap is resident while any Poster's uri points at it,
// visible or not, and freed when the last one is cleared, so the channel must clear the uri of every
// poster it isn't showing (Roku's advice) rather than just hiding it. Bitmaps cost 4 bytes a pixel
// whatever the file size. Each frame the player says what it wants, by priority (TexturePriority).
// Wants are granted in priority order while they fit the budget; anything not granted is freed (its
// poster's uri cleared). A load takes `latency` ms, so 'next' covers the gap; a shown page that isn't
// ready is drawn with the nearest page that is (a miss). Every load is a PNG decode on the device, so
// 'nearby' pages don't churn: one already held outranks a new one, and a new one starts only with 10%
// of the budget spare, one per frame.

export const TexturePriority = {
  /** backdrop, foreground, one fallback angle per species */
  pinned: 0,
  /** the angles and water frames being drawn now */
  shown: 1,
  /** what a turn or the water loop reaches within a fraction of a second */
  next: 2,
  /** neighbouring angles, if there is room */
  nearby: 3,
} as const;
export type TexturePriority = (typeof TexturePriority)[keyof typeof TexturePriority];

export const BYTES_PER_MB = 1e6;
const HELD_NEARBY_RANK = 2.5;        // a held 'nearby' page ranks just above new ones
const SPECULATIVE_HEADROOM = 0.9;    // a new 'nearby' load needs 10% of the budget spare
const SPECULATIVE_LOADS_PER_FRAME = 1;

interface Resident { readonly bytes: number; readonly img: HTMLImageElement; ready: boolean }
interface Want { readonly bytes: number; prio: TexturePriority }

export class TextureBudget {
  private readonly budget: number;
  private readonly resident = new Map<string, Resident>();
  private readonly wants = new Map<string, Want>();
  /** Bytes held now. */
  used = 0;
  /** Of `used`, what is shown or about to be (priorities pinned..next). */
  need = 0;
  peak = 0;
  loads = 0;
  misses = 0;

  constructor(
    budgetMB: number,
    private readonly latencyMs: number,
    private readonly assetBase: string,
    private readonly onMissing: (url: string) => void,
  ) {
    this.budget = budgetMB * BYTES_PER_MB;
  }

  get bitmapCount(): number {
    return this.resident.size;
  }

  want(url: string, bytes: number, prio: TexturePriority): void {
    const w = this.wants.get(url);
    if (!w) this.wants.set(url, { bytes, prio });
    else if (prio < w.prio) w.prio = prio;
  }

  get(url: string): HTMLImageElement | null {
    const e = this.resident.get(url);
    return e && e.ready ? e.img : null;
  }

  /** Grant this frame's wants, free the rest, start loads. */
  update(): void {
    const keep = this.grant();
    this.release(keep);
    this.load(keep);
    this.peak = Math.max(this.peak, this.used);
    this.wants.clear();
  }

  private rank([url, w]: readonly [string, Want]): number {
    return w.prio === TexturePriority.nearby && this.resident.has(url) ? HELD_NEARBY_RANK : w.prio;
  }

  private grant(): Set<string> {
    const order = [...this.wants].sort((a, b) => this.rank(a) - this.rank(b));
    const keep = new Set<string>();
    let total = 0, speculative = 0;
    for (const [url, w] of order) {
      if (w.prio > TexturePriority.pinned && total + w.bytes > this.budget) continue;
      const isNewNearby = w.prio === TexturePriority.nearby && !this.resident.has(url);
      if (isNewNearby && (speculative >= SPECULATIVE_LOADS_PER_FRAME || total + w.bytes > this.budget * SPECULATIVE_HEADROOM)) continue;
      if (isNewNearby) speculative++;
      keep.add(url);
      total += w.bytes;
    }
    this.need = order.reduce((s, [url, w]) => s + (w.prio <= TexturePriority.next && keep.has(url) ? w.bytes : 0), 0);
    return keep;
  }

  private release(keep: ReadonlySet<string>): void {
    for (const [url, e] of this.resident) {
      if (keep.has(url)) continue;
      e.img.onload = e.img.onerror = null;   // clearing src fires onerror in the browser
      e.img.src = '';   // the Roku: poster.uri = ""
      this.resident.delete(url);
      this.used -= e.bytes;
    }
  }

  private load(keep: ReadonlySet<string>): void {
    for (const url of keep) {
      const w = this.wants.get(url);
      if (this.resident.has(url) || !w) continue;
      const e: Resident = { bytes: w.bytes, img: new Image(), ready: false };
      e.img.onload = () => setTimeout(() => { e.ready = true; }, this.latencyMs);
      e.img.onerror = () => this.onMissing(url);
      e.img.src = this.assetBase + url;
      this.resident.set(url, e);
      this.used += e.bytes;
      this.loads++;
    }
  }
}
