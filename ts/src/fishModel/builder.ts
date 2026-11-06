// ---------- assembled model (cached per species) ----------
import * as THREE from 'three';
import { clamp } from '../util.js';
import type { Species } from '../species/types.js';
import { gillOf, mouthOf } from './profile.js';
import { IN_WATER_IOR, makeSwimMaterial, swimUniforms, type SwimUniforms, type Tissue } from './swimShader.js';
import { speciesAssets, type SpeciesCanvases } from './assets.js';
import { buildCustomModel, customModelFor, type NormalisedModel } from './customModels.js';
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

// finDepth: fins write depth (and cut out below 15% alpha, under the faintest fringe), set before building fish. The photo camera
// needs it so translucent fins focus with the body; otherwise fins don't write depth, which avoids
// sorting artefacts between overlapping membranes.
export const fishRender = { finDepth: false };

export interface BuildFishOptions {
  /** A model from loadFishModel. */
  model?: NormalisedModel | null;
  /** Ignore models.json for this species. */
  procedural?: boolean;
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
  const a = speciesAssets(sp);
  const hinge = new THREE.Vector2(9, 9);
  const uniforms: SwimUniforms = swimUniforms({
    uFinH: { value: a.prof.H }, uXPed: { value: a.prof.xPed },
    uAnguil: { value: sp.swim.mode === 'anguilliform' ? 1 : 0 },
    uGape: { value: 0 }, uHinge: { value: hinge }, uNight: { value: 0 },
    uErect: { value: 1 },   // erectile spines as drawn (fish.ts raises and lowers them)
  });
  const erect = sp.fins.some((f) => f.kind === 'spines');
  const M = mouthOf(sp);   // the lower jaw hinges at the corner of the mouth
  hinge.set(a.prof.x(M.u), a.prof.centre(M.u) - M.v * a.prof.half(M.u));
  const bodyTissue: Tissue = { kind: 'body', sizeMM: sp.size * MM_PER_UNIT, jaw: true, cover: !!gillOf(sp), night: sp.night, detail: a.detail, packed: true };
  const bodyMat = makeSwimMaterial(new THREE.MeshPhysicalMaterial({
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
    iridescenceThicknessRange: sp.irid?.range ?? (sp.iridescent ? [310, 370] : [200, 620]),
  }), uniforms, bodyTissue);
  const alphaTest = fishRender.finDepth ? FIN_DEPTH_ALPHA_TEST : FIN_ALPHA_TEST;
  // Raised rays (normalMap), rays glossier than the membrane (roughnessMap G x 1) and thicker (thickMap R).
  const finMat = makeSwimMaterial(new THREE.MeshPhysicalMaterial({
    map: a.finTex, normalMap: a.finNormalTex, roughnessMap: a.finDataTex, transparent: true, side: THREE.DoubleSide,
    depthWrite: fishRender.finDepth, roughness: 1, alphaTest, ior: IN_WATER_IOR,
  }), uniforms, { kind: 'fin', thickMM: FIN_MEMBRANE_THICKNESS * sp.size * THICKNESS_SCALE, thickMap: a.finDataTex, erect });
  // Pectorals move on their own pivots, so the body wave is off for them (zero uniforms); they
  // still get the membrane light transport, and each bends along its rays (its own uPBend, so a
  // material each side; both share one program).
  const p = sp.pectoral, rowed = !!p && p.kind !== 'fan';
  const stillFor = (): SwimUniforms => swimUniforms({ uAmp: { value: 0 }, uFlutter: { value: 0 }, uFinH: { value: 1 }, uXPed: { value: -9 }, uPBend: { value: new THREE.Vector3(0, 0, p ? p.len : 1) } });
  const pectMatFor = (u: SwimUniforms): THREE.MeshPhysicalMaterial => makeSwimMaterial(new THREE.MeshPhysicalMaterial({
    map: a.pectTex, transparent: true, side: THREE.DoubleSide, depthWrite: fishRender.finDepth, roughness: 0.45, alphaTest, ior: IN_WATER_IOR,
  }), u, { kind: 'fin', thickMM: FIN_MEMBRANE_THICKNESS * sp.size * THICKNESS_SCALE, pect: rowed });

  const pects: PectoralPivot[] = [];
  const group = new FishModel({ uniforms, pects, fan: p?.kind === 'fan', custom: false });
  const body = new THREE.Mesh(a.bodyGeo, bodyMat);
  const fins = new THREE.Mesh(a.finGeo, finMat);
  fins.renderOrder = 1;
  group.add(fins, body);
  // Spines, free rays and tentacles: solid, glossy, banded by vertex colour; thin enough to glow when backlit.
  const tubeMat = (u: SwimUniforms, jaw = false, extra: Partial<Tissue> = {}): THREE.MeshPhysicalMaterial =>
    makeSwimMaterial(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, ior: IN_WATER_IOR }), u, { kind: 'fin', thickMM: TUBE_THICKNESS * sp.size * THICKNESS_SCALE, jaw, ...extra });
  if (a.tubeGeo) group.add(new THREE.Mesh(a.tubeGeo, tubeMat(uniforms, true, { erect })));   // chin lappets ride on the lower jaw

  if (p && a.pectGeo) {
    for (const side of [1, -1]) {
      const px = a.prof.x(p.u), py = a.prof.centre(p.u) - p.v * a.prof.half(p.u), pz = a.prof.width(p.u);
      const still = stillFor();
      const m = new THREE.Mesh(a.pectGeo, pectMatFor(still));
      m.renderOrder = 2;
      m.rotation.y = Math.PI; // point backwards
      if (a.pectTubeGeo) m.add(new THREE.Mesh(a.pectTubeGeo, tubeMat(still, false, { pect: rowed })));
      const pivot = new PectoralPivot(side, m, still.uPBend);
      pivot.position.set(px, py, side * pz * 0.9);
      group.add(pivot);
      pects.push(pivot);
    }
  }

  // Cornea: smooth, but its index (~1.376) nearly matches water, so in the tank it barely reflects.
  // The spherical lens behind it (n ~1.67 at the core) bulges through the pupil and reflects ~1.2%
  // against water, 30 times the skin: that is the catchlight in every photo. A thin clearcoat (fixed
  // F0 0.04 x 0.3) gives it.
  const eyeMat = makeSwimMaterial(new THREE.MeshPhysicalMaterial({
    map: a.eyeTex, roughness: 0.1, ior: IN_WATER_IOR, clearcoat: 0.3, clearcoatRoughness: 0.04,
    // The iris' reflective iridophore ring round the pupil (moves with the gaze, as the map does).
    iridescence: 0.3, iridescenceIOR: 1.8, iridescenceThicknessRange: [260, 420], iridescenceMap: a.eyeRingTex,
  }), uniforms);
  // Eye movement: the eyeball turns under a nearly flush cornea, so the iris and pupil slide across the
  // cap. uGaze = (forward, up) in texture units, set per fish in fish.ts (saccades and counter-rolling).
  const gaze = { value: new THREE.Vector2() };
  uniforms.uGaze = gaze;
  a.eyeTex.wrapS = a.eyeTex.wrapT = a.eyeRingTex.wrapS = a.eyeRingTex.wrapT = THREE.ClampToEdgeWrapping;
  addGaze(eyeMat, gaze);
  for (const geo of a.eyeGeos) group.add(new THREE.Mesh(geo, eyeMat));
  return group;
}

export function speciesCanvases(sp: Species): SpeciesCanvases { return speciesAssets(sp).canvases; }
