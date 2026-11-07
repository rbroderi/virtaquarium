// The swim shader: a vertex wave that bends the body and fins along fish-space x, plus the tissue light
// transport, packed maps, skin detail, night colours, jaw, gill and erectile-spine options it composes
// into a three.js material through onBeforeCompile.
import * as THREE from 'three';
import { addCaustics } from '../water.js';
import type { NightColour } from '../species/types.js';
import type { SkinDetail } from './detail.js';

type Uniform<T> = THREE.IUniform<T>;

/** The swim shader's uniforms; the optional ones exist only on procedural fish (fish.ts checks them). */
export interface SwimUniforms {
  uPhase: Uniform<number>;
  uAmp: Uniform<number>;
  uFlutter: Uniform<number>;
  uFinH: Uniform<number>;
  uBend: Uniform<number>;
  uFinPhase: Uniform<number>;
  uXPed: Uniform<number>;
  uVent: Uniform<number>;
  uAnguil: Uniform<number>;
  uLift: Uniform<number>;
  uBendTail: Uniform<number>;
  uFold: Uniform<number>;
  uCup: Uniform<number>;
  /** 1: the body is drawn along uPath (the moray's path, fish/spineChain.ts) instead of the straight axis. */
  uPathOn: Uniform<number>;
  /** PATH_POINTS stations (x, y, z) in the model's frame, head to tail, evenly along the body. */
  uPath: Uniform<Float32Array>;
  /** Each station's up (x, y, z), carried down the body without flipping. */
  uPathUp: Uniform<Float32Array>;
  uGape?: Uniform<number>;
  uHinge?: Uniform<THREE.Vector2>;
  uNight?: Uniform<number>;
  uErect?: Uniform<number>;
  uGaze?: Uniform<THREE.Vector2>;
  uPBend?: Uniform<THREE.Vector3>;
  /** Pectoral ripple across the rays: x phase (rad), y amplitude (fin lengths, signed per side). */
  uPWave?: Uniform<THREE.Vector2>;
}

/** Light transport and shader options for one swim material. */
export interface Tissue {
  /** body: thickness from the aThick attribute; fin: a thin membrane. */
  kind: 'body' | 'fin';
  sizeMM?: number;
  thickMM?: number;
  /** The fin's data map, whose R holds ray thickness (read through roughnessMap). */
  thickMap?: THREE.Texture;
  jaw?: boolean;
  cover?: boolean;
  night?: NightColour | undefined;
  detail?: SkinDetail;
  packed?: boolean;
  erect?: boolean;
  pect?: boolean;
}

/** Path stations (uPath) at x = 0.5 .. -0.5: must match SPINE_NODES (fish/spineChain.ts) and SWIM_GLSL. */
export const PATH_POINTS = 24;

/** A straight body along the axis (uPath when nothing has set it yet). */
function straightPath(): Float32Array {
  const a = new Float32Array(PATH_POINTS * 3);
  for (let i = 0; i < PATH_POINTS; i++) a[i * 3] = 0.5 - i / (PATH_POINTS - 1);
  return a;
}

function pathUps(): Float32Array {
  const a = new Float32Array(PATH_POINTS * 3);
  for (let i = 0; i < PATH_POINTS; i++) a[i * 3 + 1] = 1;
  return a;
}

// The fish is submerged: its mucus (n ~1.38) meets water (n ~1.33), a relative index of ~1.04, so the
// surface reflects ~0.04% at normal incidence instead of the 4% three.js assumes for air. No clearcoat
// or sheen either; the visible shine of a fish in water comes from the guanine iridophores (iridescence).
export const IN_WATER_IOR = 1.04;

/** Brightest linear radiance a fish fragment may write (legit highlights are < ~10). */
const HDR_CLAMP = '16.0';

// The swim shader's uniforms (SWIM_GLSL) with their resting values; every swim material needs the full set.
export function swimUniforms(over: Partial<SwimUniforms> = {}): SwimUniforms {
  return {
    uPhase: { value: 0 }, uAmp: { value: 1 }, uFlutter: { value: 1 }, uFinH: { value: 1 }, uBend: { value: 0 }, uFinPhase: { value: 0 },
    uXPed: { value: -0.3 }, uVent: { value: 0 }, uAnguil: { value: 0 }, uLift: { value: 0 },
    uBendTail: { value: 0 }, uFold: { value: 0 }, uCup: { value: 0 }, uPathOn: { value: 0 }, uPath: { value: straightPath() }, uPathUp: { value: pathUps() },
    ...over,
  };
}

const withDefine = (defines: THREE.WebGLProgramParametersWithUniforms['defines'], name: string): Record<string, string | number | boolean> =>
  ({ ...defines, [name]: '' });

// Shared GLSL: lateral (z) displacement that grows towards the tail; fins also flutter.
const SWIM_GLSL = /* glsl */`
uniform float uPhase;
uniform float uAmp;
uniform float uFlutter;
uniform float uFinH;
uniform float uBend;
uniform float uFinPhase;
uniform float uXPed;    // x of the caudal peduncle (the caudal blade lags behind it)
uniform float uVent;    // opercular flare, 0..~0.04
uniform float uAnguil;  // 1 = anguilliform (eels): the whole body undulates
uniform float uLift;    // front of the body raised (an eel resting with its head up)
uniform float uBendTail; // the rear half's turn bend: a damped spring behind uBend, so the tail lags into a turn and overshoots out of it
uniform float uFold;    // dorsal and anal fins fold down and back (0 erect .. 1 folded at speed)
uniform float uCup;     // extra caudal lag when the tail works hard (the blade flexes more)
uniform float uPathOn;  // 1: the body is drawn along uPath (the moray), not bent about the straight axis
uniform vec3 uPath[24];   // stations (model space, body lengths) at x = 0.5 .. -0.5 in 23 equal steps
uniform vec3 uPathUp[24]; // each station's up
// The frame at body position x along the path: a Catmull-Rom curve through the stations (P), its
// tangent towards the head (T), and the up carried with it, square to T (U).
void pathFrame(float x, out vec3 P, out vec3 T, out vec3 U) {
  float f = clamp((0.5 - x) * 23.0, 0.0, 22.999);
  int i = int(f);
  float t = f - float(i);
  vec3 p1 = uPath[i], p2 = uPath[i + 1];
  vec3 p0 = i > 0 ? uPath[i - 1] : 2.0 * p1 - p2;
  vec3 p3 = i < 22 ? uPath[i + 2] : 2.0 * p2 - p1;
  vec3 c1 = p2 - p0, c2 = 2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3, c3 = 3.0 * (p1 - p2) + p3 - p0;
  P = p1 + 0.5 * t * (c1 + t * (c2 + t * c3));
  T = -normalize(c1 + t * (2.0 * c2 + 3.0 * t * c3) + vec3(1e-6, 0.0, 0.0));
  U = mix(uPathUp[i], uPathUp[i + 1], t);
  U = normalize(U - T * dot(U, T) + vec3(0.0, 1e-6, 0.0));
}
// Lateral offset of the spine (the body midline) at x; x runs from +0.5 (snout) to -0.5 (tail tip).
// Body wave h = A(s) sin(wt + kx): wavelength ~0.95 BL (carangiform-like), amplitude from a small head
// recoil (~0.02 BL) through a minimum ~0.15 BL behind the snout to ~0.1 BL at the tail tip at cruise.
// The caudal blade trails the peduncle by ~45 deg. uBend adds the curvature of a turn.
// Anguilliform: ~0.6 BL wavelength (1.5-2 waves on the body), amplitude ~0.03 BL at the head rising
// to ~0.1 BL at the tail, no separate caudal blade.
float spineH(float x) {
  x = max(x, -0.55);   // (a fin filament trailing past the tail follows the tail, not a wave grown on past it)
  float s = 0.5 - x;
  float env = mix(0.02 - 0.06 * s + 0.2 * s * s, 0.03 + 0.07 * s, uAnguil);
  float lag = (0.8 + uCup) * (1.0 - uAnguil) * (1.0 - smoothstep(uXPed - 0.12, uXPed + 0.02, x));
  float bend = mix(uBendTail, uBend, smoothstep(-0.3, 0.2, x));
  return uAmp * env * sin(uPhase + x * mix(6.6, 10.5, uAnguil) - lag) + bend * (x - 0.05) * (x - 0.05) * 2.0;
}
// Raise the front of the body, bending up ahead of x = 0.1.
float liftY(float x) { float d = max(0.0, x - 0.1); return uLift * d * d * 2.5; }
// Travelling wave along the dorsal/anal fins (head to tail), confined to the fins.
float finFlutter(vec3 p) {
  float fin = smoothstep(uFinH, uFinH + 0.15, abs(p.y));
  return uFlutter * fin * 0.018 * sin(uFinPhase + p.x * 14.0 + abs(p.y) * 6.0);
}
// Gill cover breathing: the rear of the operculum flares out and back (aCover: the share of the flare
// each body vertex takes, most at the margin; the rings behind the margin stay put, so the gill
// opening under it widens).
// Erectile spines (aErect, see finMesh): uErect 0 lowered flat along the back, 1 as drawn, 2 fully
// raised. At speed they fold back with the other median fins (uFold). Returns the turn about the base.
#ifdef FISH_ERECT
attribute vec4 aErect;
uniform float uErect;
float erectAngle() {
  float e = min(uErect, 2.0 - 1.8 * uFold);
  return e < 1.0 ? aErect.z * (1.0 - e) : aErect.w * (e - 1.0);
}
#endif
// Pectoral bending along the rays (a fin's own space: x out along the rays from the base, y across
// them, leading edge up). uPBend.x: the tips' lag behind the stroke (fin lengths of deflection), z: the
// fin's length. The rays bend progressively towards the tip, the stiff leading rays least.
#ifdef FISH_PECT
uniform vec3 uPBend;
float pectFlex(float y) { return 1.0 - 0.45 * clamp(y / (0.5 * uPBend.z), -1.0, 1.0); }
// A ripple running across the rays, from the leading (upper) rays to the trailing ones, growing towards
// the tips: the lionfish fan's undulating membrane. uPWave.x: phase, y: amplitude (fin lengths; 0 for
// rowed fins). About one wavelength spans the fan.
uniform vec2 uPWave;
const float PECT_WAVE_K = 2.6;
float pectWave(vec2 q) {
  float r = length(q) / uPBend.z;
  return uPWave.y * uPBend.z * r * r * sin(uPWave.x + PECT_WAVE_K * atan(q.y, max(q.x, 1e-4)));
}
#endif
#ifdef FISH_COVER
attribute float aCover;
float ventScale(vec3 p) { return 1.0 + uVent * 1.5 * aCover; }
#else
float ventScale(vec3 p) { return 1.0; }
#endif
`;

// Light transport through fish tissue (physically motivated, cheap enough for every fish):
//  - transmission: Beer-Lambert through the tissue thickness in mm; red survives furthest, so thin
//    parts (dorsal ridge, peduncle, fin bases, fins) glow warm when backlit, with a forward-scattering
//    lobe when looking towards the light;
//  - diffusion: subsurface scattering softens the terminator (wrapped Lambert, wider for red);
//  - ambient light arriving from behind (downwelling, water radiance) also passes through.
const TISSUE_GLSL = /* glsl */`
#ifdef FISH_TISSUE
{
  vec3 Nn = normal;
  vec3 Tt = exp(-uTissueSigma * tissueThickMM);
  vec3 alb = material.diffuseColor;
  // White pattern is a dense leucophore/iridophore layer that scatters light back before it reaches
  // the red-transmitting muscle, so white skin gets only a fifth of the tissue glow.
  float leu = 1.0 - 0.8 * smoothstep(0.55, 0.85, min(alb.r, min(alb.g, alb.b)));
  Tt *= leu;
  #if NUM_DIR_LIGHTS > 0
  for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
    vec3 L = directionalLights[i].direction;
    float ndl = dot(Nn, L);
    float back = saturate(-ndl);
    float lobe = pow(saturate(dot(geometryViewDir, -L)), 6.0);
    reflectedLight.directDiffuse += alb * Tt * directionalLights[i].color * RECIPROCAL_PI * back * (1.0 + 2.5 * lobe);
    vec3 wrapped = saturate((vec3(ndl) + uWrap) / (1.0 + uWrap));
    reflectedLight.directDiffuse += alb * directionalLights[i].color * RECIPROCAL_PI * max(wrapped - saturate(ndl), 0.0) * leu;
  }
  #endif
  vec3 backIrr = vec3(0.0);
  #if NUM_HEMI_LIGHTS > 0
  for (int i = 0; i < NUM_HEMI_LIGHTS; i++) backIrr += getHemisphereLightIrradiance(hemisphereLights[i], -Nn);
  #endif
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  backIrr += getIBLIrradiance(-Nn);
  #endif
  reflectedLight.indirectDiffuse += alb * Tt * backIrr * RECIPROCAL_PI;
}
#endif
`;

/** Extra shader-cache key for a tissue's options (materials with equal keys share a program). */
function tissueKey(tissue: Tissue | null): string {
  return 'swim-' + (tissue ? tissue.kind + (tissue.jaw ? '-jaw' : '') + (tissue.cover ? '-cover' : '') + (tissue.night ? '-night-' + tissue.night : '') + (tissue.thickMap ? '-thick' : '') + (tissue.detail ? '-detail' : '') + (tissue.packed ? '-packed' : '') + (tissue.erect ? '-erect' : '') + (tissue.pect ? '-pect' : '') : 'plain');
}

// tissue: null (plain), { kind: 'body', sizeMM } (thickness from the aThick attribute, fish units)
// or { kind: 'fin', thickMM } (thin membrane).
export function makeSwimMaterial<M extends THREE.Material>(base: M, uniforms: SwimUniforms, tissue: Tissue | null = null): M {
  base.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (tissue) {
      const body = tissue.kind === 'body';
      Object.assign(shader.uniforms, {
        // Absorption+scattering loss per mm of fish tissue (muscle/skin): blue-green die out first.
        uTissueSigma: { value: body ? new THREE.Vector3(0.38, 0.8, 1.05) : new THREE.Vector3(0.9, 1.4, 1.8) },
        uWrap: { value: body ? new THREE.Vector3(0.45, 0.22, 0.14) : new THREE.Vector3(0.0, 0.0, 0.0) },
        uSizeMM: { value: tissue.sizeMM || 100 },
        uThickMM: { value: tissue.thickMM || 0.2 },
      });
      shader.defines = withDefine(shader.defines, 'FISH_TISSUE');
      shader.vertexShader = (body ? 'attribute float aThick;\nvarying float vThick;\n' : '') + shader.vertexShader
        .replace('#include <fog_vertex>', '#include <fog_vertex>\n' + (body ? 'vThick = aThick;' : ''));
      shader.fragmentShader = 'uniform vec3 uTissueSigma;\nuniform vec3 uWrap;\nuniform float uSizeMM;\nuniform float uThickMM;\n' +
        (body ? 'varying float vThick;\n#define tissueThickMM (vThick * uSizeMM)\n'
          // A fin's rays are ~4x the membrane's thickness (thickMap R), so backlit they show dark on a glowing film.
          // (thickMap is the fin's roughnessMap, whose R holds it: read through that sampler, not a unit of its own.)
          : tissue.thickMap ? '#define tissueThickMM (uThickMM * mix(1.0, 4.0, texture2D(roughnessMap, vRoughnessMapUv).r))\n'
          : '#define tissueThickMM uThickMM\n') +
        shader.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + TISSUE_GLSL);
    }
    shader.vertexShader = SWIM_GLSL + shader.vertexShader
      .replace('#include <beginnormal_vertex>', `
        // Each cross-section is carried by the spine curve and turned to its tangent, so the body keeps
        // its length and the caudal blade pitches with the wave (instead of a sideways shear).
        float swH = spineH(position.x);
        float swT = atan((spineH(position.x + 0.005) - swH) / 0.005);
        float swC = cos(swT), swS = sin(swT);
        vec3 objectNormal = vec3(normal);
        #ifdef FISH_JAW
          // The jaw's shear (below) applied to its normals (inverse transpose of its x-derivative, with the
          // angle easing off along x by aJawG), so the lowered chin and the stretched throat are lit as
          // they now lie.
          { float a = -uGape * aJaw, k = uGape * aJawG, dx = position.x - uHinge.x;
            float dEx = cos(a) - 1.0 + dx * sin(a) * k, dDy = sin(a) - dx * cos(a) * k;   // da/dx = -k
            objectNormal.x = (objectNormal.x - dDy * objectNormal.y) / (1.0 + dEx); }
        #endif
        #ifdef FISH_ERECT
          { float a = erectAngle(), c = cos(a), s = sin(a);
            objectNormal.xy = vec2(c * objectNormal.x - s * objectNormal.y, s * objectNormal.x + c * objectNormal.y); }
        #endif
        #ifdef FISH_PECT
          { float r = clamp(position.x / uPBend.z, 0.0, 1.0);
            float dzdx = 2.0 * uPBend.x * r * pectFlex(position.y);
            float dzdy = abs(position.y) < 0.5 * uPBend.z ? -0.9 * uPBend.x * r * r : 0.0;
            objectNormal = vec3(objectNormal.x - dzdx * objectNormal.z, objectNormal.y - dzdy * objectNormal.z, objectNormal.z); }
          if (uPWave.y != 0.0) {
            const float E = 0.002;
            float wx = (pectWave(position.xy + vec2(E, 0.0)) - pectWave(position.xy - vec2(E, 0.0))) / (2.0 * E);
            float wy = (pectWave(position.xy + vec2(0.0, E)) - pectWave(position.xy - vec2(0.0, E))) / (2.0 * E);
            objectNormal = vec3(objectNormal.x - wx * objectNormal.z, objectNormal.y - wy * objectNormal.z, objectNormal.z);
          }
        #endif
        vec3 paP, paT, paU, paS;
        if (uPathOn > 0.5) {
          // Along the path: each cross-section turned into its station's frame.
          pathFrame(position.x, paP, paT, paU);
          paS = cross(paT, paU);
          objectNormal = paT * objectNormal.x + paU * objectNormal.y + paS * objectNormal.z;
        } else {
          objectNormal = vec3(objectNormal.x * swC - objectNormal.z * swS, objectNormal.y, objectNormal.x * swS + objectNormal.z * swC);
        }
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
          if (uPathOn > 0.5) objectTangent = paT * objectTangent.x + paU * objectTangent.y + paS * objectTangent.z;
        #endif`)
      .replace('#include <begin_vertex>', `
        vec3 p0 = position;
        #ifdef FISH_JAW
          // Lower jaw (aJaw: 1 on the jaw): drops as if turned down about the hinge at the corner of the
          // mouth, but each point moves as its lip does at the same x (a shear), so the chin's underside,
          // below the hinge, comes down with the lip instead of swinging back into the throat.
          { float a = -uGape * aJaw, dx = p0.x - uHinge.x;
            p0.x += dx * (cos(a) - 1.0); p0.y += dx * sin(a); }
        #endif
        float erSpine = 0.0;
        #ifdef FISH_ERECT
          // An erectile spine (and its web) turns about its base instead of folding with the soft fins.
          { float a = erectAngle(), c = cos(a), s = sin(a); vec2 d = p0.xy - aErect.xy;
            erSpine = step(1e-5, abs(aErect.z));
            p0.xy = mix(p0.xy, aErect.xy + vec2(c * d.x - s * d.y, s * d.x + c * d.y), erSpine); }
        #endif
        #ifdef FISH_PECT
          p0.z += uPBend.x * uPBend.z * pow(clamp(p0.x / uPBend.z, 0.0, 1.0), 2.0) * pectFlex(p0.y) + pectWave(p0.xy);
        #endif
        #ifdef FISH_FIN
          // Median fins fold: rays above the body lower and sweep back (not the caudal blade).
          { float over = abs(p0.y) - uFinH;
            if (over > 0.0 && p0.x > uXPed + 0.03 && erSpine == 0.0) {
              float k = uFold * smoothstep(0.0, 0.05, over);
              p0.y = sign(p0.y) * (uFinH + over * (1.0 - 0.55 * k));
              p0.x -= over * 0.35 * k;
            } }
        #endif
        vec3 transformed = p0;
        float swZ = p0.z * ventScale(p0) + finFlutter(p0);
        if (uPathOn > 0.5) {
          // The point at its own station on the path (past either end, straight on along the end's tangent).
          float xc = clamp(p0.x, -0.5, 0.5);
          pathFrame(xc, paP, paT, paU);
          transformed = paP + paT * (p0.x - xc) + paU * p0.y + cross(paT, paU) * swZ;
        } else {
          transformed.x = p0.x - swZ * swS;
          transformed.y = p0.y + liftY(p0.x);
          transformed.z = swH + swZ * swC;
        }`);
    // Specular anti-aliasing for the shading normal (scale-lattice normal map, ray relief): three's own
    // widening reads only the geometric normal, so a minified normal map's glints boil as isolated bright
    // pixels. Widen the lobe by the pixel footprint's normal variance (Toksvig; Filament's kernel),
    // capped, so the glint is spread over what the pixel actually covers. The anisotropy lobe is
    // computed just above, from the unwidened roughness, so it is rebuilt here too.
    //
    // At grazing incidence the footprint term alone is not enough: the pixel covers a long arc of the
    // body, so the mirror direction sweeps far more than a lobe width and one pixel can catch the whole
    // specular line (the "fireflies" on a fish's back rim, linear radiance ~4 against ~0.02 round it).
    // Add a grazing variance that only grows below NdotV ~0.4, i.e. where the lobe is under-sampled;
    // a body highlight at NdotV > 0.6 is untouched.
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
      { vec3 ndx = dFdx( normal ), ndy = dFdy( normal );
        float nVar = dot( ndx, ndx ) + dot( ndy, ndy );
        float nvA = saturate( dot( normal, normalize( vViewPosition ) ) );
        float graze = 1.0 - nvA;
        nVar += 0.20 * graze * graze * graze * graze;
        nVar = min( nVar, 0.30 );
        material.roughness = min( sqrt( material.roughness * material.roughness + nVar ), 1.0 );
        #ifdef USE_ANISOTROPY
          material.alphaT = mix( pow2( material.roughness ), 1.0, pow2( material.anisotropy ) );
        #endif
      }`);
    // Fade the normal-map detail towards the geometric normal at grazing angles: a silhouette pixel
    // covers a long swath of the map, and one minified texel's tilt is otherwise a lone glint on the rim.
    const NORMAL_EDGE_FADE = `
        { float nv = saturate( dot( normal, normalize( vViewPosition ) ) );
          normal = normalize( mix( nonPerturbedNormal, normal, smoothstep( 0.0, 0.35, nv ) ) ); }`;
    if (!tissue?.detail) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>${NORMAL_EDGE_FADE}`);
    }
    // Grazing specular guard. A silhouette pixel spans a long arc of the body, so the mirror direction
    // sweeps far past one specular lobe and a single pixel can catch a whole thin anisotropic highlight
    // (linear radiance ~4 against ~0.02 around it: the white specks on a fish's back rim). Sub-pixel
    // fish coverage also tends to zero there, so fade the specular over the outermost sliver only:
    // body highlights and scale detail at NdotV > 0.15 are untouched.
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      { float nvG = saturate( dot( normal, normalize( vViewPosition ) ) );
        float covG = smoothstep( 0.0, 0.15, nvG );
        outgoingLight -= ( reflectedLight.directSpecular + reflectedLight.indirectSpecular ) * ( 1.0 - covG ); }
      if (any(isnan(outgoingLight)) || any(isinf(outgoingLight))) outgoingLight = vec3(0.0);
      outgoingLight = clamp(outgoingLight, vec3(0.0), vec3(${HDR_CLAMP}));
      #include <opaque_fragment>`);
    if (tissue?.kind === 'fin') shader.defines = withDefine(shader.defines, 'FISH_FIN');
    if (tissue?.erect) shader.defines = withDefine(shader.defines, 'FISH_ERECT');
    if (tissue?.pect) shader.defines = withDefine(shader.defines, 'FISH_PECT');
    if (tissue?.packed) {
      // Second channels of the packed body maps (see buildFishModel): film thickness from the iridescence
      // map's G, and the cavity from the roughness map's R, applied as three's aoMap would (indirect
      // diffuse, sheen and specular occlusion), without a sampler each.
      shader.fragmentShader = shader.fragmentShader
        .replace('material.iridescenceThickness = iridescenceThicknessMaximum;',
          'material.iridescenceThickness = mix( iridescenceThicknessMinimum, iridescenceThicknessMaximum, texture2D( iridescenceMap, vIridescenceMapUv ).g );')
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        #ifdef USE_ROUGHNESSMAP
        { float ambientOcclusion = texture2D( roughnessMap, vRoughnessMapUv ).r;
          reflectedLight.indirectDiffuse *= ambientOcclusion;
          #if defined( USE_SHEEN )
            sheenSpecularIndirect *= ambientOcclusion;
          #endif
          #if defined( USE_ENVMAP ) && defined( STANDARD )
            float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
            reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
          #endif
        }
        #endif`);
    }
    if (tissue?.detail) {
      // Skin detail (detailTile): a tiling normal added to the body's own (UDN blend), faded out by the
      // tile's size on screen: fully there while a tile spans 40+ px, gone below ~12 px.
      const D = tissue.detail;
      Object.assign(shader.uniforms, { uDetail: { value: D.tex }, uDetailRep: { value: D.rep }, uDetailStr: { value: D.str } });
      shader.fragmentShader = 'uniform sampler2D uDetail;\nuniform vec2 uDetailRep;\nuniform float uDetailStr;\n' + shader.fragmentShader
        .replace('#include <normal_fragment_maps>', `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
          mapN.xy *= normalScale;
          { vec2 dUv = vNormalMapUv * uDetailRep;
            float fw = max(length(dFdx(dUv)), length(dFdy(dUv)));
            float k = uDetailStr * (1.0 - smoothstep(1.0 / 40.0, 1.0 / 12.0, fw));
            if (k > 0.001) { vec3 dN = texture2D(uDetail, dUv).xyz * 2.0 - 1.0; mapN = vec3(mapN.xy + dN.xy * k, mapN.z); } }
          normal = normalize( tbn * mapN );
        #else
          #include <normal_fragment_maps>
        #endif${NORMAL_EDGE_FADE}`);
    }
    if (tissue?.night) {
      // Night (and stress) colours: chromatophores contract or expand over minutes (Hobson 1972: at dusk
      // many diurnal reef fish pale or blotch, others darken). uNight 0..1, set in fish.js.
      //   pale: desaturates towards a light mottled grey (yellow tang's white night patch, blue tang's fade)
      //   dark: desaturates and darkens (chromis, idol)
      const pale = tissue.night === 'pale';
      shader.fragmentShader = 'uniform float uNight;\n' + shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        { float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          ${pale
    ? 'float blot = 0.5 + 0.5 * sin(vMapUv.x * 23.0 + sin(vMapUv.y * 9.0) * 2.0); vec3 night = mix(vec3(l), vec3(0.75 + 0.2 * blot), 0.45);'
    : 'vec3 night = vec3(l) * 0.45 + diffuseColor.rgb * 0.12;'}
          diffuseColor.rgb = mix(diffuseColor.rgb, night, uNight * 0.8); }`);
    }
    if (tissue?.jaw) {
      shader.defines = withDefine(shader.defines, 'FISH_JAW');
      shader.vertexShader = 'attribute float aJaw;\nattribute float aJawG;\nuniform float uGape;\nuniform vec2 uHinge;\n' + shader.vertexShader;
    }
    if (tissue?.cover) {
      // Inside the mouth and the gill opening (aSlit): the skin texture carried in, in shadow and
      // reddened (blood-rich lining and gills), so it reads as a cavity rather than a hole.
      shader.defines = withDefine(shader.defines, 'FISH_COVER');
      shader.vertexShader = 'attribute float aSlit;\nvarying float vSlit;\n' + shader.vertexShader
        .replace('vec3 transformed = p0;', 'vec3 transformed = p0;\n        vSlit = aSlit;');
      shader.fragmentShader = 'varying float vSlit;\n' + shader.fragmentShader
        .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.32, 0.16, 0.15) + vec3(0.03, 0.006, 0.008), vSlit);')
        // A cavity is shadowed: no sheen off its walls and little direct light (its walls facing the light
        // would otherwise stand out as pale bands); the skin shows faintly by the ambient light.
        .replace('#include <aomap_fragment>', 'reflectedLight.directSpecular *= 1.0 - vSlit;\n  reflectedLight.indirectSpecular *= 1.0 - vSlit;\n  reflectedLight.directDiffuse *= 1.0 - 0.85 * vSlit;\n  #include <aomap_fragment>');
    }
  };

  base.customProgramCacheKey = () => tissueKey(tissue);
  addCaustics(base);   // fish swim through the same focused light as the reef
  return base;
}
