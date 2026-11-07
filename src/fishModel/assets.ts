// Everything a species' procedural fish is built from (geometry, painted maps, textures), made once per
// species and shared by every fish of it.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeCanvas, context2d } from '../util.js';
import type { Species } from '../species/types.js';
import { makeProfile, type Profile } from './profile.js';
import { paintSkin } from './skin.js';
import { paintFins, type TexImage, type TubeSpec } from './fins.js';
import { finMesh, tubeGeometry, appendageTubes } from './meshes.js';
import { paintPectoral, pectoralGeometry, pectoralTubes } from './pectoral.js';
import { eyeGeometry, paintEye, paintEyeRing } from './eye.js';
import { bodyGeometry } from './bodyGeometry.js';
import { detailFor, type SkinDetail } from './detail.js';
import { skinCache, skinKey } from './skinCache.js';
import { variantSpecies } from './variant.js';
import { paintVariantMaps } from './variantPaint.js';

/** The painted canvases a species' textures were made from (the Roku bake and lab read them). */
export interface SpeciesCanvases { skin: TexImage; fins: HTMLCanvasElement; pect: HTMLCanvasElement }

export interface SpeciesAssets {
  prof: Profile;
  bodyGeo: THREE.BufferGeometry;
  finGeo: THREE.BufferGeometry;
  pectGeo: THREE.BufferGeometry | null;
  tubeGeo: THREE.BufferGeometry | null;
  pectTubeGeo: THREE.BufferGeometry | null;
  skinTex: THREE.Texture;
  normalTex: THREE.Texture;
  iridTex: THREE.Texture;
  crTex: THREE.Texture;
  skinAvg: THREE.Color;
  detail: SkinDetail;
  eyeRingTex: THREE.Texture;
  finTex: THREE.Texture;
  finNormalTex: THREE.Texture;
  finDataTex: THREE.Texture;
  pectTex: THREE.Texture;
  eyeTex: THREE.Texture;
  eyeGeos: THREE.BufferGeometry[];
  canvases: SpeciesCanvases;
}

/** The skin's mean colour is taken from this small a reduction. */
const AVG_W = 8, AVG_H = 4;
/** The flank is often seen at grazing angles (three clamps to what the GPU has). */
const TEXTURE_ANISOTROPY = 16;

const isBitmap = (c: TexImage): c is ImageBitmap => typeof ImageBitmap !== 'undefined' && c instanceof ImageBitmap;

function texture(c: TexImage, srgb = true): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (isBitmap(c)) t.flipY = false;   // flipped when decoded
  t.anisotropy = TEXTURE_ANISOTROPY;
  return t;
}

// The skin's mean colour (for the velvet sheen of minute-scaled species), from an 8 x 4 reduction made
// by halving (each step an exact 2 x 2 average; one drawImage straight down to 8 x 4 point-samples a
// few texels, and differently for an <img>, a canvas and a bitmap).
function meanColour(map: TexImage): THREE.Color {
  let src: TexImage = map, w = src.width, h = src.height;
  while (w > AVG_W || h > AVG_H) {
    const nw = Math.max(AVG_W, w >> 1), nh = Math.max(AVG_H, h >> 1), half = makeCanvas(nw, nh), hg = context2d(half);
    hg.imageSmoothingQuality = 'low';
    hg.drawImage(src, 0, 0, nw, nh);
    src = half; w = nw; h = nh;
  }
  const t = makeCanvas(AVG_W, AVG_H), tg = context2d(t, { willReadFrequently: true });
  tg.drawImage(src, 0, 0, AVG_W, AVG_H);
  const px = tg.getImageData(0, 0, AVG_W, AVG_H).data, s = [0, 0, 0];
  const n = AVG_W * AVG_H;
  for (let i = 0; i < px.length; i += 4) for (let ch = 0; ch < 3; ch++) s[ch] = (s[ch] ?? 0) + (px[i + ch] ?? 0) / 255 / n;
  return new THREE.Color().setRGB(s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, THREE.SRGBColorSpace);
}

function mergedTubes(list: TubeSpec[]): THREE.BufferGeometry | null {
  return list.length ? mergeGeometries(list.map((d) => tubeGeometry(d))) : null;
}

const cache = new Map<string, SpeciesAssets>();

export function speciesAssets(sp: Species, variant = 0): SpeciesAssets {
  const cacheKey = `${sp.id}:${variant}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const vsp = variantSpecies(sp, variant);
  const prof = makeProfile(vsp.body);
  // Only variant 0 reads/writes the saved skin cache (its keys and files are unchanged); other variants
  // are painted live and share textures through this module's in-memory cache.
  const hit = variant === 0 ? skinCache.get(sp.id) : undefined;
  const key = hit ? hit.key : variant === 0 ? skinKey(vsp) : '';
  const fins = paintFins(vsp, prof, !!hit);
  let skin: Record<'map' | 'normal' | 'irid' | 'cr', TexImage>;
  if (hit) {
    skin = { map: hit.img.skin, normal: hit.img.normal, irid: hit.img.irid, cr: hit.img.cr };
    fins.normal = hit.img.finNormal; fins.data = hit.img.finData;
  } else {
    const painted = paintSkin(vsp, prof);   // painted live: every map is a canvas
    skin = painted;
    if (variant === 0 && fins.normal instanceof HTMLCanvasElement && fins.data instanceof HTMLCanvasElement) {
      skinCache.save(vsp, key, { skin: painted.map, normal: painted.normal, irid: painted.irid, cr: painted.cr, finNormal: fins.normal, finData: fins.data });
    }
  }
  const finNormal = fins.normal, finData = fins.data;
  if (!finNormal || !finData) throw new Error(`${sp.id}: fin relief maps missing`);
  const avg = meanColour(skin.map);
  const pect = vsp.pectoral ? paintPectoral(vsp) : makeCanvas(4, 4);
  const eye = paintEye(vsp);
  const finGeo = mergeGeometries(fins.meshes.flatMap((m) => {
    const geo = finMesh(m, fins);
    return m.xforms ? m.xforms.map((x) => geo.clone().applyMatrix4(x)) : [geo];
  }));
  const pectGeo = vsp.pectoral ? pectoralGeometry(vsp) : null;
  const assets: SpeciesAssets = {
    prof,
    bodyGeo: bodyGeometry(prof, vsp),
    finGeo, pectGeo,
    tubeGeo: mergedTubes([...fins.tubes, ...appendageTubes(vsp, prof)]), pectTubeGeo: mergedTubes(vsp.pectoral ? pectoralTubes(vsp) : []),
    skinTex: texture(skin.map), normalTex: texture(skin.normal, false), iridTex: texture(skin.irid, false), crTex: texture(skin.cr, false), skinAvg: avg, detail: detailFor(vsp, prof),
    eyeRingTex: texture(paintEyeRing(vsp), false), finTex: texture(fins.canvas), finNormalTex: texture(finNormal, false), finDataTex: texture(finData, false), pectTex: texture(pect), eyeTex: texture(eye),
    eyeGeos: [1, -1].map((side) => eyeGeometry(prof, vsp, side)),
    canvases: { skin: skin.map, fins: fins.canvas, pect },
  };
  cache.set(cacheKey, assets);
  return assets;
}

/** A variant's colour maps, ready to swap onto fish built from variant 0. */
export interface VariantMaps {
  readonly skinTex: THREE.Texture;
  readonly finTex: THREE.Texture;
  readonly pectTex: THREE.Texture;
  readonly skinAvg: THREE.Color;
}

/**
 * A variant's colour maps, ready to swap onto fish built from variant 0. The body albedo comes from the
 * variant's saved skin cache when present (decoded off the main thread); otherwise it is painted, along
 * with the fin and pectoral sheets, in a worker so the main thread never runs a long paint. Every bitmap
 * arrives flipped to WebGL's origin, so it uploads with the same flipY=false as the cached maps.
 */
/**
 * A variant's colour maps, ready to swap onto fish built from variant 0. The worker reads the variant's
 * saved skin cache when present (fetch + decode off the main thread); otherwise it paints the skin, fin
 * and pectoral sheets and encodes the cache PNG, all off the main thread. Every bitmap arrives flipped to
 * WebGL's origin, so it uploads with the same flipY=false as the cached maps.
 */
export async function variantColourMaps(sp: Species, variant: number): Promise<VariantMaps> {
  const vsp = variantSpecies(sp, variant);
  const cache = skinCache.variantUrls(vsp, variant);
  const key = cache ? cache.key : skinKey(vsp);
  const painted = await paintVariantMaps(vsp, cache);
  if (!painted.skin) throw new Error(`${sp.id} variant ${variant}: no skin painted`);
  skinCache.saveVariant(sp, variant, key, painted.skinPng ?? null, painted.skinAvg);
  return {
    skinTex: texture(painted.skin),
    finTex: texture(painted.fins),
    pectTex: texture(painted.pect),
    skinAvg: painted.skinAvg
      ? new THREE.Color().setRGB(painted.skinAvg[0], painted.skinAvg[1], painted.skinAvg[2], THREE.SRGBColorSpace)
      : meanColour(painted.skin),
  };
}
