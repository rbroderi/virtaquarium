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

export function speciesAssets(sp: Species): SpeciesAssets {
  const cached = cache.get(sp.id);
  if (cached) return cached;
  const prof = makeProfile(sp.body);
  const hit = skinCache.get(sp.id), key = hit ? hit.key : skinKey(sp);
  const fins = paintFins(sp, prof, !!hit);
  let skin: Record<'map' | 'normal' | 'irid' | 'cr', TexImage>;
  if (hit) {
    skin = { map: hit.img.skin, normal: hit.img.normal, irid: hit.img.irid, cr: hit.img.cr };
    fins.normal = hit.img.finNormal; fins.data = hit.img.finData;
  } else {
    const painted = paintSkin(sp, prof);   // painted live: every map is a canvas
    skin = painted;
    if (fins.normal instanceof HTMLCanvasElement && fins.data instanceof HTMLCanvasElement) {
      skinCache.save(sp, key, { skin: painted.map, normal: painted.normal, irid: painted.irid, cr: painted.cr, finNormal: fins.normal, finData: fins.data });
    }
  }
  const finNormal = fins.normal, finData = fins.data;
  if (!finNormal || !finData) throw new Error(`${sp.id}: fin relief maps missing`);
  const avg = meanColour(skin.map);
  const pect = sp.pectoral ? paintPectoral(sp) : makeCanvas(4, 4);
  const eye = paintEye(sp);
  const finGeo = mergeGeometries(fins.meshes.flatMap((m) => {
    const geo = finMesh(m, fins);
    return m.xforms ? m.xforms.map((x) => geo.clone().applyMatrix4(x)) : [geo];
  }));
  const pectGeo = sp.pectoral ? pectoralGeometry(sp) : null;
  const assets: SpeciesAssets = {
    prof,
    bodyGeo: bodyGeometry(prof, sp),
    finGeo, pectGeo,
    tubeGeo: mergedTubes([...fins.tubes, ...appendageTubes(sp, prof)]), pectTubeGeo: mergedTubes(sp.pectoral ? pectoralTubes(sp) : []),
    skinTex: texture(skin.map), normalTex: texture(skin.normal, false), iridTex: texture(skin.irid, false), crTex: texture(skin.cr, false), skinAvg: avg, detail: detailFor(sp, prof),
    eyeRingTex: texture(paintEyeRing(sp), false), finTex: texture(fins.canvas), finNormalTex: texture(finNormal, false), finDataTex: texture(finData, false), pectTex: texture(pect), eyeTex: texture(eye),
    eyeGeos: [1, -1].map((side) => eyeGeometry(prof, sp, side)),
    canvases: { skin: skin.map, fins: fins.canvas, pect },
  };
  cache.set(sp.id, assets);
  return assets;
}
