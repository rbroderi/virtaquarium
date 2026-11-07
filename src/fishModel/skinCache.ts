// ---- Skin texture cache (models/skins/, git-ignored) ----
// Painting a species' skin (the scale lattice, pigment, normal and sheen maps) and its fins' relief
// maps takes ~1 s. The results are saved as lossless PNGs and reused while nothing that made them has
// changed: the key hashes the species' look (everything but behaviour) and the source of the painters,
// so editing either repaints. loadSkinCache() reads the saved maps before fish are built; species
// painted live are saved back when the page is served locally (tools/serve.ts accepts the POST).
import { isRecord } from '../util.js';
import type { Species } from '../species/types.js';
import { cellHash, gillOf, gillU, makeProfile, mouthOf, naresOf } from './profile.js';
import { applyShade, organicSkin, paintSkin } from './skin.js';
import { organicPass, roundCorners, valueNoise, wobble } from '../core/organic.js';
import { caudalOutline, finMaps, finOutline, paintFins, pelvicOutline, smoothPts, type TexImage } from './fins.js';

const SKIN_CACHE_VERSION = 1;
export const SKIN_MAPS = ['skin', 'normal', 'irid', 'cr', 'finNormal', 'finData'] as const;
export type SkinMapName = (typeof SKIN_MAPS)[number];
export type SkinImages = Record<SkinMapName, TexImage>;

/** A cache hit: the key it was saved under, its decoded maps, and (variants) the skin's mean colour. */
export interface SkinCacheHit { key: string; img: SkinImages; avg?: readonly [number, number, number] }

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const IMAGE_TIMEOUT_MS = 20000;
const FNV_OFFSET = 0x811c9dc5, FNV_PRIME = 0x01000193;
/** Fields that don't change a species' look, left out of its key. */
const BEHAVIOUR_FIELDS = ['brain', 'fact', 'name', 'sci', 'swim'];

// The maps are decoded as ImageBitmaps, off the main thread and all at once, flipped as the texture
// upload would flip them (WebGL ignores flipY for bitmaps), unpremultiplied and with no colour
// conversion (the PNGs carry no colour chunks), so the GPU gets the same texels as from an <img>,
// whose decode instead ran on the main thread when each texture was first uploaded.
const useBitmaps = (): boolean =>
  typeof createImageBitmap === 'function' && new URLSearchParams(globalThis.location?.search).get('skinbmp') !== '0';

const loadBitmap = async (url: string): Promise<ImageBitmap> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return createImageBitmap(await r.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
};

// onload, not decode(): decode() can wait indefinitely in a background tab.
const loadImage = (url: string): Promise<HTMLImageElement> => new Promise((ok, fail) => {
  const im = new Image();
  im.onload = () => ok(im); im.onerror = fail;
  setTimeout(() => fail(new Error('timeout')), IMAGE_TIMEOUT_MS);
  im.src = url;
});

/** The painters whose source is part of every key. */
const PAINTERS: readonly ((...args: never[]) => unknown)[] = [
  paintSkin, organicSkin, organicPass, valueNoise, wobble, roundCorners, smoothPts, paintFins, finMaps, applyShade, makeProfile, gillU, gillOf, naresOf, mouthOf, finOutline, caudalOutline, pelvicOutline, cellHash,
];

export function skinKey(sp: Species): string {
  const look = JSON.stringify(sp, (k: string, v: unknown) => (BEHAVIOUR_FIELDS.includes(k) ? undefined : v));
  const src = PAINTERS.map(String).join('');
  let h = FNV_OFFSET;
  for (const s of [String(SKIN_CACHE_VERSION), look, src]) for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), FNV_PRIME);
  return (h >>> 0).toString(16);
}

/** Saved skins by species id, and where live-painted skins are written back to (null: not local). */
class SkinCache {
  private readonly hits = new Map<string, SkinCacheHit>();
  private base: string | null = null;
  private saveBase: string | null = null;
  /** Chain of saves in flight (headless checks wait for it so nothing is dropped on exit). */
  private current: Promise<void> = Promise.resolve();

  /** Variants are stored apart from the variant-0 files under their own ids. */
  private static hitId(id: string, variant: number): string {
    return variant <= 0 ? id : `${id}:v${variant}`;
  }

  get(id: string, variant = 0): SkinCacheHit | undefined {
    return this.hits.get(SkinCache.hitId(id, variant));
  }

  /** Resolves when every skin save issued so far has finished (at once when none). */
  get pending(): Promise<void> {
    return this.current;
  }

  async load(species: readonly Species[], base: string): Promise<void> {
    const local = LOCAL_HOSTS.includes(location.hostname);
    this.base = base;
    this.saveBase = local ? new URL(base, location.href).pathname.replace(/^\//, '') : null;
    const bitmaps = useBitmaps();
    let hits = 0;
    await Promise.all(species.map(async (sp) => {
      const key = skinKey(sp);
      try {
        const r = await fetch(`${base}${sp.id}.json`, { cache: 'no-cache' });
        if (!r.ok) return;
        const meta: unknown = await r.json();
        if (!isRecord(meta) || meta['key'] !== key) return;
        const entries = await Promise.all(SKIN_MAPS.map(async (n): Promise<[SkinMapName, TexImage]> => {
          const url = `${base}${sp.id}-${n}.png?${key}`;
          return [n, bitmaps ? await loadBitmap(url) : await loadImage(url)];
        }));
        this.hits.set(sp.id, { key, img: Object.fromEntries(entries) as SkinImages });
        hits++;
      } catch { /* not cached (or unreadable): paint it live */ }
    }));
    console.log(`Skin cache: ${hits}/${species.length} species`);
  }

  save(sp: Species, key: string, canvases: Record<SkinMapName, HTMLCanvasElement>): void {
    const base = this.saveBase;
    if (!base) return;
    const post = (path: string, body: BodyInit | null): Promise<unknown> =>
      fetch(`/__save?path=${base}${path}`, { method: 'POST', body }).catch(() => undefined);
    const done = Promise.all(SKIN_MAPS.map((n) => new Promise<Blob | null>((ok) => canvases[n].toBlob(ok, 'image/png')).then((b) => post(`${sp.id}-${n}.png`, b))))
      .then(() => post(`${sp.id}.json`, JSON.stringify({ key })))   // last, so a half-written set never matches
      .then(() => undefined);
    this.current = this.current.then(() => done);
  }

  /** Fetches and decodes a variant's saved skin albedo, if present (its other maps are variant 0's). */
  async loadVariant(sp: Species, variant: number): Promise<SkinCacheHit | undefined> {
    const base = this.base;
    if (!base || variant <= 0) return undefined;
    const id = SkinCache.hitId(sp.id, variant);
    const cached = this.hits.get(id);
    if (cached) return cached;
    const key = skinKey(sp);
    try {
      const r = await fetch(`${base}${sp.id}-v${variant}.json`, { cache: 'no-cache' });
      if (!r.ok) return undefined;
      const meta: unknown = await r.json();
      if (!isRecord(meta) || meta['key'] !== key) return undefined;
      const bitmaps = useBitmaps();
      const skin = bitmaps
        ? await loadBitmap(`${base}${sp.id}-v${variant}-skin.png?${key}`)
        : await loadImage(`${base}${sp.id}-v${variant}-skin.png?${key}`);
      const avg = Array.isArray(meta['avg']) && meta['avg'].length === 3 && meta['avg'].every((v) => typeof v === 'number')
        ? (meta['avg'] as [number, number, number])
        : undefined;
      const hit: SkinCacheHit = { key, img: { skin } as SkinImages, ...(avg ? { avg } : {}) };
      this.hits.set(id, hit);
      return hit;
    } catch { return undefined; }
  }

  /** Saves a variant's painted skin albedo (its relief maps are shared with variant 0). */
  saveVariant(sp: Species, variant: number, key: string, skinPng: Blob | null, avg: readonly [number, number, number] | undefined): void {
    const base = this.saveBase;
    if (!base || variant <= 0 || !skinPng) return;
    const post = (path: string, body: BodyInit | null): Promise<unknown> =>
      fetch(`/__save?path=${base}${path}`, { method: 'POST', body }).catch(() => undefined);
    const done = (async () => {
      await post(`${sp.id}-v${variant}-skin.png`, skinPng);
      await post(`${sp.id}-v${variant}.json`, JSON.stringify(avg ? { key, avg } : { key }));   // last, so a half-written set never matches
    })();
    this.current = this.current.then(() => done).then(() => undefined);
  }
}

export const skinCache = new SkinCache();

export const pendingSkinSave = (): Promise<void> => skinCache.pending;

export const loadSkinCache = (species: readonly Species[], base = './models/skins/'): Promise<void> => skinCache.load(species, base);
