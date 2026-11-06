// Surface waves.
//
// The surface of an aquarium has no wind waves. What ripples it is roughness stirred up by the pumps,
// carried along by slow surface currents (a few cm/s) while it slowly re-forms (Taylor's
// frozen-turbulence picture), instead of racing across at free-wave phase speeds (30-90 cm/s here).
// A tank has several such sources at once, so the surface is a sum of wave trains, each drifting its
// own way at its own speed:
//   - the return pump's outflow: fine roughness carried along the front (+x);
//   - a powerhead across the back, and the gyre returning the other way: longer, slower swells;
//   - ripples bounced off the glass: short, weak, any direction, hardly drifting (they shimmer in place).
// Where the trains cross, their caustic networks overlap and mix: broad bright bands from the swells
// sweep one way while the fine net slides another, as in a real tank.
// Wave vectors sit on a lattice of the tile, so the field (and its caustics) repeats seamlessly every
// WAVE_TILE units. Wavelengths run 5-50 cm with ~2% slope each (rms slope ~0.07).
import * as THREE from 'three';
import { mulberry32, TAU } from '../util.js';
import { METRES_PER_UNIT } from './medium.js';

/** Units (0.5 m). */
export const WAVE_TILE = 4.0;

/**
 * drift: surface current carrying the train (m/s); dir/spread: wave-vector heading and spread (rad);
 * n: lattice wavenumber range (wavelength = 50 cm / n); amp: slope scale, set so each train focuses
 * about the same share of the light (no single drift direction dominates the caustics).
 */
interface WaveTrain {
  readonly count: number;
  readonly drift: readonly [number, number];
  readonly dir: number;
  readonly spread: number;
  readonly n: readonly [number, number];
  readonly amp: number;
}

const TRAINS: readonly WaveTrain[] = [
  { count: 10, drift: [0.03, 0.008], dir: 0, spread: 0.9, n: [3, 10], amp: 0.5 },          // pump outflow
  { count: 6, drift: [-0.018, -0.01], dir: 2.7, spread: 0.6, n: [1, 4], amp: 1.55 },       // returning gyre
  { count: 6, drift: [0.006, -0.022], dir: -1.5, spread: 0.7, n: [2, 6], amp: 0.9 },       // powerhead
  { count: 6, drift: [0.002, 0.003], dir: 0, spread: Math.PI, n: [5, 11], amp: 0.5 },      // reflections
];

const WAVE_SEED = 911;
const WAVENUMBER_SKEW = 1.3;        // favours the low end of each train's wavenumber range
const SLOPE_PER_WAVE = 0.02;
const REFERENCE_WAVENUMBER = 5;
const EVOLVE_MIN = 0.08, EVOLVE_SPREAD = 0.25;
const AMP_JITTER_MIN = 0.7, AMP_JITTER_SPREAD = 0.6;

interface Wave { readonly kx: number; readonly kz: number; readonly amp: number; readonly omega: number; readonly phi: number }

export const WAVE_COUNT = TRAINS.reduce((sum, t) => sum + t.count, 0);

function generateWaves(): Wave[] {
  const rng = mulberry32(WAVE_SEED), out: Wave[] = [], seen = new Set<string>();
  for (const train of TRAINS) {
    for (let made = 0; made < train.count;) {
      const n = train.n[0] + Math.pow(rng(), WAVENUMBER_SKEW) * (train.n[1] - train.n[0]);
      const a = train.dir + (rng() * 2 - 1) * train.spread;
      const nx = Math.round(n * Math.cos(a)), nz = Math.round(n * Math.sin(a));
      // One wave per lattice vector (a +k/-k pair would just be a single wave too).
      if ((!nx && !nz) || seen.has(nx + ',' + nz) || seen.has(-nx + ',' + -nz)) continue;
      seen.add(nx + ',' + nz);
      made++;
      const kx = (TAU * nx) / WAVE_TILE, kz = (TAU * nz) / WAVE_TILE, k = Math.hypot(kx, kz);
      // Advection by the train's current (k . U) plus slow re-forming: seconds for ripples, longer for swells.
      const advect = (kx * train.drift[0] + kz * train.drift[1]) / METRES_PER_UNIT;
      const evolve = (rng() < 0.5 ? -1 : 1) * (EVOLVE_MIN + EVOLVE_SPREAD * rng()) * Math.sqrt(Math.hypot(nx, nz) / REFERENCE_WAVENUMBER);
      out.push({
        kx, kz,
        amp: (SLOPE_PER_WAVE * train.amp * (AMP_JITTER_MIN + AMP_JITTER_SPREAD * rng())) / k,
        omega: advect + evolve,
        phi: rng() * Math.PI * 2,   // (kept as in the JS build: bit-identical phases)
      });
    }
  }
  return out;
}

const WAVES: readonly Wave[] = generateWaves();

export const waveUniforms: { uWaves: THREE.IUniform<THREE.Vector4[]>; uSunAir: THREE.IUniform<THREE.Vector3> } = {
  uWaves: { value: WAVES.map((w) => new THREE.Vector4(w.kx, w.kz, w.amp, w.phi)) },
  uSunAir: { value: new THREE.Vector3(0, -1, 0) },   // direction the light travels above the surface
};

/** Advance the waves to time t (phases are wrapped in double precision on the CPU). */
export function updateWaves(t: number): void {
  const uniform = waveUniforms.uWaves.value;
  WAVES.forEach((w, i) => {
    const v = uniform[i];
    if (v) v.w = (w.phi + w.omega * t) % TAU;
  });
}

const WATER_IOR = 1.34;
const MAX_SIN_AIR = 0.995;
const VERTICAL_EPSILON = 1e-6;

/**
 * Light set up as an underwater direction (as three.js lights are) -> the direction it travels in
 * air before refracting at the surface (inverse Snell's law).
 */
export function setSunDirection(dirTowardsLight: THREE.Vector3): void {
  const d = dirTowardsLight.clone().normalize(), h = Math.hypot(d.x, d.z);
  const sinAir = Math.min(MAX_SIN_AIR, h * WATER_IOR);
  const cosAir = Math.sqrt(1 - sinAir * sinAir);
  const sx = h > VERTICAL_EPSILON ? d.x / h : 0, sz = h > VERTICAL_EPSILON ? d.z / h : 0;
  waveUniforms.uSunAir.value.set(-sx * sinAir, -cosAir, -sz * sinAir);
}

export const WAVE_GLSL = /* glsl */`
#define NWAVES ${WAVE_COUNT}
uniform vec4 uWaves[NWAVES];
vec2 waveGrad(vec2 p) {
  vec2 g = vec2(0.0);
  for (int i = 0; i < NWAVES; i++) { vec4 w = uWaves[i]; g += w.z * w.xy * cos(dot(w.xy, p) - w.w); }
  return g;
}
`;
