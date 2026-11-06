// Scalar helpers shared by every module.

export const TAU = Math.PI * 2;
export const DEG_TO_RAD = Math.PI / 180;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Cubic Hermite ease, 0..1 -> 0..1 with zero slope at both ends. */
export const smooth = (t: number): number => t * t * (3 - 2 * t);

/** The same angle in (-PI, PI]. */
export function wrapAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}
