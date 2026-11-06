// ---- Skin texture cache (models/skins/, git-ignored) ----
// Painting a species' skin (the scale lattice, pigment, normal and sheen maps) and its fins' relief
// maps takes ~1 s. The results are saved as lossless PNGs and reused while nothing that made them has
// changed: the key hashes the species' look (everything but behaviour) and the source of the painters,
// so editing either repaints. loadSkinCache() reads the saved maps before fish are built; species
// painted live are saved back when the page is served locally (tools/serve.ts accepts the POST).
import { isRecord } from '../util.js';
import type { Species } from '../species/types.js';
import { cellHash, gillOf, gillU, makeProfile, mouthOf, naresOf } from './profile.js';
import { applyShade, paintSkin } from './skin.js';
import { caudalOutline, finMaps, finOutline, paintFins, pelvicOutline, type TexImage } from './fins.js';

const SKIN_CACHE_VERSION = 1;
export const SKIN_MAPS = ['skin', 'normal', 'irid', 'cr', 'finNormal', 'finData'] as const;
export type SkinMapName = (typeof SKIN_MAPS)[number];
export type SkinImages = Record<SkinMapName, TexImage>;

/** A cache hit: the key it was saved under and its decoded maps. */
export interface SkinCacheHit { key: string; img: SkinImages }

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
  paintSkin, paintFins, finMaps, applyShade, makeProfile, gillU, gillOf, naresOf, mouthOf, finOutline, caudalOutline, pelvicOutline, cellHash,
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
  private saveBase: string | null = null;

  get(id: string): SkinCacheHit | undefined {
    return this.hits.get(id);
  }

  async load(species: readonly Species[], base: string): Promise<void> {
    const local = LOCAL_HOSTS.includes(location.hostname);
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
    void Promise.all(SKIN_MAPS.map((n) => new Promise<Blob | null>((ok) => canvases[n].toBlob(ok, 'image/png')).then((b) => post(`${sp.id}-${n}.png`, b))))
      .then(() => post(`${sp.id}.json`, JSON.stringify({ key })));   // last, so a half-written set never matches
  }
}

export const skinCache = new SkinCache();

export const loadSkinCache = (species: readonly Species[], base = './models/skins/'): Promise<void> => skinCache.load(species, base);
