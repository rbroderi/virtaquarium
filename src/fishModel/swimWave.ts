// The swim shader's body wave (SWIM_GLSL spineH, liftY) on the CPU, so parts that are not deformed by
// the shader (the pectorals, which turn on their own pivots) can ride on the body as it bends: each
// pectoral's base moves with the midline at its station and turns with the body's local heading. Without
// this the body swayed under fins held still in space, and the lionfish's big fans looked detached.
import * as THREE from 'three';
import type { SwimUniforms } from './swimShader.js';
import type { PectoralPivot } from './model.js';

/** Must match SWIM_GLSL. */
const SPINE_POINTS = 12, SPINE_STEPS = SPINE_POINTS - 1;
const SLOPE_DX = 0.005;

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** uSpine at x (component 0: lateral z, 1: vertical y), interpolated as spineAt() does. */
function spineAt(u: SwimUniforms, x: number, c: 0 | 1): number {
  const f = Math.min(Math.max((0.5 - x) * SPINE_STEPS, 0), SPINE_STEPS - 1e-3), i = Math.floor(f), a = u.uSpine.value;
  return mix(a[i * 2 + c] ?? 0, a[(i + 1) * 2 + c] ?? 0, f - i);
}

/** Lateral offset of the body midline at x (+0.5 snout .. -0.5 tail tip): spineH(). */
export function spineH(u: SwimUniforms, xIn: number): number {
  const x = Math.max(xIn, -0.55), s = 0.5 - x, an = u.uAnguil.value;
  const env = mix(0.02 - 0.06 * s + 0.2 * s * s, 0.03 + 0.07 * s, an);
  const lag = (0.8 + u.uCup.value) * (1 - an) * (1 - smoothstep(u.uXPed.value - 0.12, u.uXPed.value + 0.02, x));
  const bend = mix(u.uBendTail.value, u.uBend.value, smoothstep(-0.3, 0.2, x));
  const chain = u.uSpineOn.value ? u.uSpineOn.value * spineAt(u, x, 0) : 0;
  return u.uAmp.value * env * Math.sin(u.uPhase.value + x * mix(6.6, 10.5, an) - lag) + bend * (x - 0.05) * (x - 0.05) * 2 + chain;
}

/** Vertical lift of the midline at x: liftY(). */
export function liftY(u: SwimUniforms, x: number): number {
  const d = Math.max(0, x - 0.1);
  return u.uLift.value * d * d * 2.5 + (u.uSpineOn.value ? u.uSpineOn.value * spineAt(u, x, 1) : 0);
}

const _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);

/**
 * Carries a posed pectoral with the body wave: call after posing it (posePectoral / posePectoralFan).
 * The shader moves a body point (x, y, z) to (x - z sin T, y + lift, h + z cos T), with h the midline
 * offset and T its heading at x; the fin's base does the same, and the fin turns by T with the body.
 */
export function mountPectoral(p: PectoralPivot, u: SwimUniforms): void {
  const r = p.rest, h = spineH(u, r.x);
  const t = Math.atan((spineH(u, r.x + SLOPE_DX) - h) / SLOPE_DX), sT = Math.sin(t), cT = Math.cos(t);
  p.position.set(r.x - r.z * sT, r.y + liftY(u, r.x), h + r.z * cT);
  p.quaternion.premultiply(_q.setFromAxisAngle(_up, -t));
}
