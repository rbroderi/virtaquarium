// ---------- assembled model (cached per species) ----------
import * as THREE from 'three';
import { clamp } from '../util.js';
import type { Species } from '../species/types.js';
import { gillOf, mouthOf } from './profile.js';
import { IN_WATER_IOR, swimUniforms, type SwimUniforms, type Tissue } from './swimShader.js';
import { swimMaterialFor } from './swimNodes.js';
import { fishRender } from './renderMode.js';
import { speciesAssets, type SpeciesCanvases, type VariantMaps } from './assets.js';
import { buildCustomModel, customModelFor, type NormalisedModel } from './customModels.js';
import { useLods, type LodWeights } from '../lod.js';

// Levels of detail (lod.ts): the body is ~36k triangles at every size, several to a pixel on a small
// fish, three times a frame (view, shadow map, motion-blur velocity). The weights put each attribute's
// error in body lengths, as the position's is: u runs along the length (x 2 for margin, the texture
// has sharp stripes), v round the girth, about a third of it (x 6); the jaw and gill weights 1. The
// gape and the gill margin are seams, so they are locked.
const BODY_LOD_WEIGHTS: LodWeights = { normal: 1, uv: [2, 6], aJaw: 1, aJawG: 1, aCover: 1, aSlit: 1, aThick: 0 };
import { FishModel, PectoralPivot } from './model.js';

/** Pectoral tips' lag behind the stroke (fin lengths), tuned in the lab (setPectLag). */
const DEFAULT_PECT_LAG = 0.22;
const pectTuning = { lag: DEFAULT_PECT_LAG };
export function setPectLag(v: number): void { pectTuning.lag = v; }   // lab tuning

/** Fish units per mm of specimen size (1 unit = 125 mm). */
const MM_PER_UNIT = 125;
/** Tissue thickness (mm) of a fin membrane and of a tube (spine, ray), per unit of size, times THICKNESS_SCALE. */
const FIN_MEMBRANE_THICKNESS = 0.15, TUBE_THICKNESS = 0.8, THICKNESS_SCALE = 8;
/** Fins cut out below this alpha when they write depth (under the faintest fringe). */
const FIN_DEPTH_ALPHA_TEST = 0.15, FIN_ALPHA_TEST = 0.01;

// Labriform pectoral stroke for one fin pivot at stroke phase `ph`: abduction (opening, sin rising) is
// the recovery, when the fin feathers (turns its chord edge-on to the flow) and its rays partly
// collapse; on the power stroke back towards the body it is flat and fully spread.
// open: opening angle (rad); flap: roll of the stroke plane (rad).
// The rays are flexible: the fin bends along them, its tips trailing the stroke (the opening angle
// follows sin(ph), so its rate follows cos(ph)), most at the trailing edge, as in high-speed video of
// labriform swimmers (the tips lag the base by ~1/8 of a stroke). In the fin's space +z faces the body
// while the fin is open (the mesh is turned to point back), so while it opens (cos ph > 0) the tips
// bend towards the body, and away from it on the power stroke.
export function posePectoral(p: PectoralPivot, ph: number, open: number, flap: number): void {
  const s = p.side, rec = Math.max(0, Math.cos(ph)), fin = p.fin;
  p.rotation.set(0, s * open, flap);
  fin.rotation.x = s * 0.6 * rec;
  fin.scale.y = 1 - 0.25 * rec;
  if (p.uPBend) p.uPBend.value.x = pectTuning.lag * s * Math.cos(ph) * clamp(open * 2, 0.4, 1);
}

/** Rest pose of a fan pectoral (rad): roll about the body axis, opening about the vertical, stroke-plane roll. */
export interface FanPose { readonly roll: number; readonly yaw: number; readonly flap: number }
/** As held in the tank: spread out and slightly down, like wings. */
export const FAN_POSE: FanPose = { roll: 0.25, yaw: 0.75, flap: 0.35 };
/** Up-down beat (rad) at rest and the extra when working; the opening's sway (rad). */
const FAN_BEAT = 0.1, FAN_BEAT_WORK = 0.14, FAN_SWAY = 0.06;
/** Ripple amplitude (fin lengths) at rest and the extra when working; ripples per beat (whole, so loops close). */
const FAN_RIPPLE = 0.025, FAN_RIPPLE_WORK = 0.035, FAN_RIPPLES_PER_BEAT = 2;
/** The tips' lag behind the beat, as a share of the rowed fins' lag. */
const FAN_LAG_SHARE = 0.5;
/** Fully folded: the share of the opening lost, and of the beat. Fans keep enough of their opening that
 * the swept-back rays (cupped toward the body) stay clear of the flank. */
const FAN_FOLD_YAW = 0.4, FAN_FOLD_STILL = 0.6;

// Lionfish fan pectorals don't row. Held spread like wings, they beat gently up and down, the tips
// trailing the beat, while undulations run across the fan from the leading rays to the trailing ones
// (the membrane between the long free rays ripples). `ph`: beat phase (rad); `beat`: effort, 0 idle .. 1
// working (hovering against the current, turning, stalking). `fold`: 0 spread .. 1 swept back along the
// flanks, as the fans are carried at speed (the water presses them back and the beat dies down).
export function posePectoralFan(p: PectoralPivot, ph: number, beat: number, pose: FanPose = FAN_POSE, fold = 0): void {
  const s = p.side, b = clamp(beat, 0, 1), f = clamp(fold, 0, 1), still = 1 - FAN_FOLD_STILL * f;
  const yaw = pose.yaw * (1 - FAN_FOLD_YAW * f), roll = pose.roll * (1 - f);
  p.rotation.set(s * (roll + (FAN_BEAT + FAN_BEAT_WORK * b) * still * Math.sin(ph)), s * (yaw + FAN_SWAY * Math.cos(ph)), pose.flap * (1 - f));
  if (p.uPBend) p.uPBend.value.x = FAN_LAG_SHARE * pectTuning.lag * s * Math.cos(ph) * (0.5 + 0.5 * b);
  if (p.uPWave) p.uPWave.value.set(ph * FAN_RIPPLES_PER_BEAT, s * (FAN_RIPPLE + FAN_RIPPLE_WORK * b));
}

// finDepth: fins write depth (and cut out below 15% alpha, under the faintest fringe), set before building fish. The photo camera
// needs it so translucent fins focus with the body; otherwise fins don't write depth, which avoids
// sorting artefacts between overlapping membranes.
export { fishRender } from './renderMode.js';

export interface BuildFishOptions {
  /** A model from loadFishModel. */
  model?: NormalisedModel | null;
  /** Ignore models.json for this species. */
  procedural?: boolean;
  /** Look variant 0..VARIANT_COUNT-1 (0: the catalogued reference look). */
  variant?: number;
}

/** The eye material's gaze: the iris and pupil slide across the cap (uGaze set per fish in fish.ts). */
function addGaze(eyeMat: THREE.MeshPhysicalMaterial, gaze: THREE.IUniform<THREE.Vector2>): void {
  const prev = eyeMat.onBeforeCompile.bind(eyeMat), prevKey = eyeMat.customProgramCacheKey.bind(eyeMat);
  eyeMat.onBeforeCompile = (s, r) => {
    prev(s, r);
    s.uniforms['uGaze'] = gaze;
    s.vertexShader = 'attribute float eyeSide;\nvarying float vEyeSide;\n' + s.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n  vEyeSide = eyeSide;');
    s.fragmentShader = 'uniform vec2 uGaze;\nvarying float vEyeSide;\n' + s.fragmentShader.replace('#include <map_fragment>', `
        #ifdef USE_MAP
          diffuseColor *= texture2D(map, vMapUv + vec2(uGaze.x * vEyeSide, -uGaze.y));
        #endif`).replace('texture2D( iridescenceMap, vIridescenceMapUv )', 'texture2D( iridescenceMap, vIridescenceMapUv + vec2(uGaze.x * vEyeSide, -uGaze.y) )');
  };
  eyeMat.customProgramCacheKey = () => prevKey() + '-eye';
}

export function buildFishModel(sp: Species, opts: BuildFishOptions = {}): FishModel {
  if (opts.model) return buildCustomModel(sp, opts.model);
  const customModel = opts.procedural ? undefined : customModelFor(sp.id);
  if (customModel) return buildCustomModel(sp, customModel);
  const a = speciesAssets(sp, opts.variant ?? 0);
  const hinge = new THREE.Vector2(9, 9);
  const uniforms: SwimUniforms = swimUniforms({
    uFinH: { value: a.prof.H }, uXPed: { value: a.prof.xPed },
    uAnguil: { value: sp.swim.mode === 'anguilliform' ? 1 : 0 },
    uGape: { value: 0 }, uHinge: { value: hinge }, uNight: { value: 0 },
    uErect: { value: 1 },   // erectile spines as drawn (fish.ts raises and lowers them)
    // The eyes turn under a nearly flush cornea: uGaze slides the iris and ring across the cap
    // (set per fish in fish.ts; saccades and counter-rolling).
    uGaze: { value: new THREE.Vector2() },
  });
  const erect = sp.fins.some((f) => f.kind === 'spines');
  const M = mouthOf(sp);   // the lower jaw hinges at the corner of the mouth
  hinge.set(a.prof.x(M.u), a.prof.centre(M.u) - M.v * a.prof.half(M.u));
  const bodyTissue: Tissue = { kind: 'body', sizeMM: sp.size * MM_PER_UNIT, jaw: true, cover: !!gillOf(sp), night: sp.night, detail: a.detail, packed: true };
  /** One entry point for either backend: TSL node materials under WebGPU, GLSL-patched ones under WebGL. */
  const swimMat = (params: THREE.MeshPhysicalMaterialParameters, u: SwimUniforms, tissue: Tissue | null = null, gaze = false): THREE.Material => {
    return swimMaterialFor(params, u, tissue, fishRender.gpu, gaze);
  };
  const bodyParams: THREE.MeshPhysicalMaterialParameters = {
    // Packed maps, each read through one sampler (the fish shader is at the GPU's 16 texture units with the
    // caustics and reef light): iridescenceMap R = strength, G = film thickness; roughnessMap G =
    // roughness (smooth exposed field, rough comb margins, velvet minute scales), R = cavity (the groove
    // under each free margin, the nostril pits). makeSwimMaterial's `packed` reads the second channels.
    map: a.skinTex, normalMap: a.normalTex, iridescenceMap: a.iridTex,
    roughnessMap: a.crTex, roughness: 1, metalness: 0.0, ior: IN_WATER_IOR,
    // Minute ctenoid scales (velvet): their spinules retro-reflect a little (a low sheen in the body's
    // own colour; any stronger and the fish turns milky).
    ...(a.detail.kind === 'velvet' ? { sheen: 0.15, sheenRoughness: 0.6, sheenColor: a.skinAvg.clone().multiplyScalar(0.6) } : {}),
    // Scales overlap in rows along the body, so a light's glint stretches along the flank rather than
    // sitting as a round spot (the body UV's u runs nose to tail, so the tangent is the body axis).
    anisotropy: sp.body.scales === 0 ? 0 : 0.45,
    // Guanine platelet stacks. Silvery and white skin: stack spacing varies widely from scale to scale
    // (hues average out near neutral). Structural colour (sp.iridescent: the chromis' blue-green):
    // regular stacks in a narrow band. sp.irid = { range: [nm, nm], strength } overrides.
    iridescence: sp.irid?.strength ?? (sp.iridescent ? 1.0 : 0.35), iridescenceIOR: 1.8,
    iridescenceThicknessMinimum: (sp.irid?.range ?? (sp.iridescent ? [310, 370] : [200, 620]))[0],
    iridescenceThicknessMaximum: (sp.irid?.range ?? (sp.iridescent ? [310, 370] : [200, 620]))[1],
  };
  const bodyMat = swimMat(bodyParams, uniforms, bodyTissue);
  bodyMat.userData['fishPart'] = 'body';   // applyVariantMaps swaps this material's albedo
  const alphaTest = fishRender.finDepth ? FIN_DEPTH_ALPHA_TEST : FIN_ALPHA_TEST;
  // Raised rays (normalMap), rays glossier than the membrane (roughnessMap G x 1) and thicker (thickMap R).
  const finMat = swimMat({
    map: a.finTex, normalMap: a.finNormalTex, roughnessMap: a.finDataTex, transparent: true, side: THREE.DoubleSide,
    depthWrite: fishRender.finDepth, roughness: 1, alphaTest, ior: IN_WATER_IOR,
  }, uniforms, { kind: 'fin', thickMM: FIN_MEMBRANE_THICKNESS * sp.size * THICKNESS_SCALE, thickMap: a.finDataTex, erect });
  finMat.userData['fishPart'] = 'fin';   // applyVariantMaps swaps this material's colour sheet
  // Pectorals move on their own pivots, so the body wave is off for them (zero uniforms); they
  // still get the membrane light transport, and each bends along its rays (its own uPBend, so a
  // material each side; both share one program). Fans also ripple (uPWave).
  const p = sp.pectoral;
  const stillFor = (): SwimUniforms => swimUniforms({
    uAmp: { value: 0 }, uFlutter: { value: 0 }, uFinH: { value: 1 }, uXPed: { value: -9 },
    uPBend: { value: new THREE.Vector3(0, 0, p ? p.len : 1) }, uPWave: { value: new THREE.Vector2() },
  });
  const pectMatFor = (u: SwimUniforms): THREE.Material => {
    const m = swimMat({
      map: a.pectTex, transparent: true, side: THREE.DoubleSide, depthWrite: fishRender.finDepth, roughness: 0.45, alphaTest, ior: IN_WATER_IOR,
    }, u, { kind: 'fin', thickMM: FIN_MEMBRANE_THICKNESS * sp.size * THICKNESS_SCALE, pect: true });
    m.userData['fishPart'] = 'pect';   // applyVariantMaps swaps this material's colour sheet
    return m;
  };

  const pects: PectoralPivot[] = [];
  const group = new FishModel({ uniforms, pects, fan: p?.kind === 'fan', custom: false });
  const body = new THREE.Mesh(a.bodyGeo, bodyMat);
  useLods(body, BODY_LOD_WEIGHTS);
  const fins = new THREE.Mesh(a.finGeo, finMat);
  fins.renderOrder = 1;
  group.add(fins, body);
  // Spines, free rays and tentacles: solid, glossy, banded by vertex colour; thin enough to glow when backlit.
  const tubeMat = (u: SwimUniforms, jaw = false, extra: Partial<Tissue> = {}): THREE.Material =>
    swimMat({ vertexColors: true, roughness: 0.38, ior: IN_WATER_IOR }, u, { kind: 'fin', thickMM: TUBE_THICKNESS * sp.size * THICKNESS_SCALE, jaw, ...extra });
  if (a.tubeGeo) group.add(new THREE.Mesh(a.tubeGeo, tubeMat(uniforms, true, { erect })));   // chin lappets ride on the lower jaw

  if (p && a.pectGeo) {
    for (const side of [1, -1]) {
      const px = a.prof.x(p.u), py = a.prof.centre(p.u) - p.v * a.prof.half(p.u), pz = a.prof.width(p.u);
      const still = stillFor();
      const m = new THREE.Mesh(a.pectGeo, pectMatFor(still));
      m.renderOrder = 2;
      m.rotation.y = Math.PI; // point backwards
      // The pivots mirror each other's pose; a fan's shape out of its plane (cup, cone, pleats) must be
      // mirrored too, or the far fan cups the other way.
      if (p.kind === 'fan' && side < 0) m.scale.z = -1;
      if (a.pectTubeGeo) m.add(new THREE.Mesh(a.pectTubeGeo, tubeMat(still, false, { pect: true })));
      const pivot = new PectoralPivot(side, m, still.uPBend, still.uPWave);
      pivot.position.set(px, py, side * pz * 0.9);
      pivot.rest.copy(pivot.position);
      group.add(pivot);
      pects.push(pivot);
    }
  }

  // Cornea: smooth, but its index (~1.376) nearly matches water, so in the tank it barely reflects.
  // The spherical lens behind it (n ~1.67 at the core) bulges through the pupil and reflects ~1.2%
  // against water, 30 times the skin: that is the catchlight in every photo. A thin clearcoat (fixed
  // F0 0.04 x 0.3) gives it.
  const eyeMat = swimMat({
    map: a.eyeTex, roughness: 0.1, ior: IN_WATER_IOR, clearcoat: 0.3, clearcoatRoughness: 0.04,
    // The iris' reflective iridophore ring round the pupil (moves with the gaze, as the map does).
    iridescence: 0.3, iridescenceIOR: 1.8, iridescenceThicknessMinimum: 260, iridescenceThicknessMaximum: 420, iridescenceMap: a.eyeRingTex,
  }, uniforms, null, true);
  // Eye movement: the eyeball turns under a nearly flush cornea, so the iris and pupil slide across the
  // cap. uGaze = (forward, up) in texture units, set per fish in fish.ts (saccades and counter-rolling).
  const gaze = uniforms.uGaze!;
  a.eyeTex.wrapS = a.eyeTex.wrapT = a.eyeRingTex.wrapS = a.eyeRingTex.wrapT = THREE.ClampToEdgeWrapping;
  if (!fishRender.gpu) addGaze(eyeMat as THREE.MeshPhysicalMaterial, gaze);
  for (const geo of a.eyeGeos) group.add(new THREE.Mesh(geo, eyeMat));
  return group;
}

export function speciesCanvases(sp: Species): SpeciesCanvases { return speciesAssets(sp, 0).canvases; }

/** Swaps the colour maps (body albedo, fin sheet, pectoral sheet) of a built fish to a variant's. */
export function applyVariantMaps(model: FishModel, maps: VariantMaps): void {
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const mat = mesh.material as THREE.MeshPhysicalMaterial | undefined;
    if (!mat) return;
    const part = mat.userData['fishPart'];
    if (part === 'body') {
      mat.map = maps.skinTex;
      if (mat.sheen) mat.sheenColor.copy(maps.skinAvg).multiplyScalar(0.6);
    } else if (part === 'fin') {
      mat.map = maps.finTex;
    } else if (part === 'pect') {
      mat.map = maps.pectTex;
    } else return;
    mat.needsUpdate = true;
  });
}

/** Swaps one colour map, so a variant's textures reach the GPU a map per frame rather than all at once. */
export function applyVariantPart(model: FishModel, part: 'body' | 'fin' | 'pect', maps: VariantMaps): void {
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const mat = mesh.material as THREE.MeshPhysicalMaterial | undefined;
    if (!mat || mat.userData['fishPart'] !== part) return;
    if (part === 'body') {
      mat.map = maps.skinTex;
      if (mat.sheen) mat.sheenColor.copy(maps.skinAvg).multiplyScalar(0.6);
    } else {
      mat.map = part === 'fin' ? maps.finTex : maps.pectTex;
    }
    mat.needsUpdate = true;
  });
}
