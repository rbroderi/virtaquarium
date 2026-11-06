// Keeping the octopus's arms out of one another and out of its body.
//
// The arms are towed each on its own, so nothing stops them passing through one another, or the
// body: points of different arms nearer the other's segments than their radii are pushed apart,
// and segments out of the sac, the eye turrets and the eyes, each arm keeping its length. (Their
// roots, inside the oral disc, are left merged.) Solved by turns (position-based): the contacts,
// then each segment back to its length (both ends giving, the root held), until nothing touches.
// The towing carries on from the result, so each frame starts from the last one's settled pose and
// a few passes do. On flat arrays, with the segments binned in a coarse grid so each point meets
// only those near it: it runs every frame.
import * as THREE from 'three';
import { clamp } from '../util.js';
import { ARM_W, type ArmTube } from './octopusParts.js';

/** A part the arms keep clear of: a sphere of radius r in the object's own (scaled) frame. */
export interface ArmObstacle {
  readonly object: THREE.Object3D;
  readonly radius: number;
}

const GRID = 32;                 // cells to a side about the body
const PASSES = 6;
const ROOT_POINTS = 4;           // an arm's first few points can be root (merged in the disc)
const FIRST_DISC_CHECKED = 5;    // points from here on keep outside the disc's rim
const GAP_PER_MANTLE = 0.01;     // clearance kept between surfaces, per unit mantle scale

interface ObstacleFrame { readonly to: readonly number[]; readonly from: ArrayLike<number>; readonly r: number; readonly sc: number }

const _mInv = new THREE.Matrix4();
const val = (a: ArrayLike<number>, i: number): number => a[i] ?? 0;

export class ArmUntangler {
  private X = new Float64Array(0);   // points, flat xyz
  private R = new Float64Array(0);   // half-widths
  private L = new Float64Array(0);   // rest lengths of the segment ending at each point
  private root = new Uint8Array(0);
  private readonly head = new Int32Array(GRID * GRID * GRID);
  private next = new Int32Array(0);
  private hits = 0;

  /** Untangle `arms` (in the model's frame) against the obstacles and the oral disc stand-in. */
  solve(arms: readonly ArmTube[], obstacles: readonly ArmObstacle[], disc: THREE.Object3D, mantleScale: number): void {
    const first = arms[0];
    if (!first) return;
    const NA = arms.length, n = first.n, N = NA * n;
    this.ensureCapacity(N);
    this.load(arms, n);
    const gap = GAP_PER_MANTLE * mantleScale;
    const OB = obstacles.map(({ object: o, radius: r }) => ({ to: _mInv.copy(o.matrix).invert().elements.slice(), from: o.matrix.elements, r, sc: Math.min(o.scale.x, o.scale.y, o.scale.z) }));
    const reach = first.r0 * 2 + gap;
    let maxL = 0;
    for (let k = 0; k < N; k++) if (k % n) maxL = Math.max(maxL, val(this.L, k));
    const cellSize = reach + 1.5 * maxL;
    for (let pass = 0; pass < PASSES; pass++) {
      this.hits = 0;
      this.markRoots(N, n, disc);
      this.binSegments(N, n, cellSize);
      this.pushApartArms(N, n, cellSize, reach, gap);
      this.keepOut(OB, NA, n, disc, gap);
      this.restoreLengths(NA, n);
      if (!this.hits) break;
    }
    this.keepOut(OB, NA, n, disc, gap);
    this.store(arms, n);
  }

  private ensureCapacity(N: number): void {
    if (this.R.length === N) return;
    this.X = new Float64Array(N * 3); this.R = new Float64Array(N); this.L = new Float64Array(N);
    this.root = new Uint8Array(N); this.next = new Int32Array(N);
  }

  private load(arms: readonly ArmTube[], n: number): void {
    const { X, R, L } = this;
    arms.forEach((a, A) => {
      for (let i = 0; i < n; i++) {
        const k = A * n + i, q = a.pts[i];
        if (!q) continue;
        X[3 * k] = q.x; X[3 * k + 1] = q.y; X[3 * k + 2] = q.z;
        R[k] = a.rAt(i / (n - 1)) * ARM_W;   // the section's half-width (its widest)
        L[k] = a.seg;   // segment i-1..i, at its rest length (towed, it can bunch up)
      }
    });
  }

  private store(arms: readonly ArmTube[], n: number): void {
    const X = this.X;
    arms.forEach((a, A) => {
      for (let i = 1; i < n; i++) { const k = A * n + i; a.pts[i]?.set(val(X, 3 * k), val(X, 3 * k + 1), val(X, 3 * k + 2)); }
    });
  }

  /**
   * The roots: an arm's first few points while within the oral disc, where they merge. Roots don't
   * meet roots; anything else (an arm coiled back under the body) meets them all the same.
   */
  private markRoots(N: number, n: number, D: THREE.Object3D): void {
    const X = this.X;
    for (let k = 0; k < N; k++) {
      const x = val(X, 3 * k) / D.scale.x, y = (val(X, 3 * k + 1) - D.position.y) / D.scale.y, z = val(X, 3 * k + 2) / D.scale.z;
      this.root[k] = k % n <= ROOT_POINTS && x * x + y * y + z * z < 1 ? 1 : 0;
    }
  }

  private cell(v: number, cellSize: number): number {
    return Math.min(GRID - 1, Math.max(0, Math.floor(v / cellSize) + GRID / 2));
  }

  /** Bin each segment k..k+1 (from point 1 on) by its middle. */
  private binSegments(N: number, n: number, cs: number): void {
    const X = this.X, head = this.head, next = this.next;
    head.fill(-1);
    for (let k = 0; k < N; k++) {
      const i = k % n;
      if (i < 1 || i > n - 2) continue;
      const c = this.cell((val(X, 3 * k) + val(X, 3 * k + 3)) / 2, cs) + GRID * (this.cell((val(X, 3 * k + 1) + val(X, 3 * k + 4)) / 2, cs) + GRID * this.cell((val(X, 3 * k + 2) + val(X, 3 * k + 5)) / 2, cs));
      next[k] = val(head, c); head[c] = k;
    }
  }

  private near2(k: number, j: number, l: number, reach: number): boolean {
    const X = this.X;
    const dx = val(X, 3 * k) - val(X, 3 * j), dy = val(X, 3 * k + 1) - val(X, 3 * j + 1), dz = val(X, 3 * k + 2) - val(X, 3 * j + 2);
    return dx * dx + dy * dy + dz * dz < (reach + l) ** 2;
  }

  private pushApartArms(N: number, n: number, cs: number, reach: number, gap: number): void {
    const X = this.X, root = this.root, L = this.L, head = this.head, next = this.next;
    for (let k = 0; k < N; k++) {
      if (k % n < 1) continue;
      const A = Math.floor(k / n), cx = this.cell(val(X, 3 * k), cs), cy = this.cell(val(X, 3 * k + 1), cs), cz = this.cell(val(X, 3 * k + 2), cs);
      for (let z = Math.max(0, cz - 1); z <= Math.min(GRID - 1, cz + 1); z++) for (let y = Math.max(0, cy - 1); y <= Math.min(GRID - 1, cy + 1); y++) for (let x = Math.max(0, cx - 1); x <= Math.min(GRID - 1, cx + 1); x++)
        for (let j = val(head, x + GRID * (y + GRID * z)); j >= 0; j = val(next, j))
          if (Math.floor(j / n) !== A && !(root[k] && (root[j] || root[j + 1])) && this.near2(k, j, val(L, j + 1) + (k % n < n - 1 ? val(L, k + 1) / 2 : 0), reach)) {
            this.push(k, j, 0, gap);
            // and the middle of the segment it starts (two segments crossing middle to middle
            // come nearer than either's ends do)
            if (k % n < n - 1 && !(root[k + 1] && (root[j] || root[j + 1]))) this.push(k, j, 0.5, gap);
          }
    }
  }

  /** The point s along k..k+1 (s 0: point k itself) against segment j..j+1. */
  private push(k: number, j: number, s: number, gap: number): void {
    const X = this.X, R = this.R, root = this.root, tol = gap;
    const q = s ? 3 : 0;
    const px = val(X, 3 * k) + (val(X, 3 * k + q) - val(X, 3 * k)) * s, py = val(X, 3 * k + 1) + (val(X, 3 * k + 1 + q) - val(X, 3 * k + 1)) * s, pz = val(X, 3 * k + 2) + (val(X, 3 * k + 2 + q) - val(X, 3 * k + 2)) * s;
    const ax = val(X, 3 * j), ay = val(X, 3 * j + 1), az = val(X, 3 * j + 2);
    const ex = val(X, 3 * j + 3) - ax, ey = val(X, 3 * j + 4) - ay, ez = val(X, 3 * j + 5) - az;
    const t = clamp(((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / Math.max(ex * ex + ey * ey + ez * ez, 1e-12), 0, 1);
    let dx = px - ax - ex * t, dy = py - ay - ey * t, dz = pz - az - ez * t;
    const Rk = val(R, k), Rj = val(R, j);
    const need = Rk + (s ? (val(R, k + 1) - Rk) * s : 0) + Rj + (val(R, j + 1) - Rj) * t + gap, d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= need * need) return;
    const d = Math.sqrt(d2);
    if (need - d > tol) this.hits++;
    if (d < 1e-9) { dx = 0; dy = 1; dz = 0; } else { dx /= d; dy /= d; dz /= d; }
    // shared, except that a root is stiff (held at its base): what meets one does all the giving
    const wk = root[k] || (s && root[k + 1]) ? 0 : root[j] || root[j + 1] ? 1 : 0.5, mk = (need - d) * wk, m = (need - d) * (1 - wk), m0 = m * (1 - t), m1 = m * t;
    const add = (o: number, by: number): void => { X[o] = val(X, o) + by; };
    if (s) {   // a segment's middle: both its ends move, so that it moves by mk
      const w = mk / ((1 - s) ** 2 + s * s), w0 = w * (1 - s), w1 = w * s;
      add(3 * k, dx * w0); add(3 * k + 1, dy * w0); add(3 * k + 2, dz * w0);
      add(3 * k + 3, dx * w1); add(3 * k + 4, dy * w1); add(3 * k + 5, dz * w1);
    } else { add(3 * k, dx * mk); add(3 * k + 1, dy * mk); add(3 * k + 2, dz * mk); }
    add(3 * j, -dx * m0); add(3 * j + 1, -dy * m0); add(3 * j + 2, -dz * m0);
    add(3 * j + 3, -dx * m1); add(3 * j + 4, -dy * m1); add(3 * j + 5, -dz * m1);
  }

  private keepOut(OB: readonly ObstacleFrame[], NA: number, n: number, D: THREE.Object3D, gap: number): void {
    const X = this.X, R = this.R, root = this.root, tol = gap;
    for (const { to: T, from: F, r, sc } of OB) for (let A = 0; A < NA; A++) for (let i = 1; i < n; i++) {
      // the segment's nearest point to the obstacle's centre (a segment can cut a corner its two
      // ends keep clear of): both ends move out by what it lacks (only the far one at the root)
      const k0 = A * n + i - 1, k1 = k0 + 1, a0 = 3 * k0, a1 = 3 * k1;
      if (root[k0] && root[k1]) continue;   // the root, merged into the disc (and so the body)
      const tf = (o: number, a: number): number => val(T, o) * val(X, a) + val(T, o + 4) * val(X, a + 1) + val(T, o + 8) * val(X, a + 2) + val(T, o + 12);
      const s0x = tf(0, a0), s0y = tf(1, a0), s0z = tf(2, a0);
      const s1x = tf(0, a1), s1y = tf(1, a1), s1z = tf(2, a1);
      const ex = s1x - s0x, ey = s1y - s0y, ez = s1z - s0z;
      const t = clamp(-(s0x * ex + s0y * ey + s0z * ez) / Math.max(ex * ex + ey * ey + ez * ez, 1e-12), 0, 1);
      const cx = s0x + ex * t, cy = s0y + ey * t, cz = s0z + ez * t, d = Math.hypot(cx, cy, cz);
      const R0 = val(R, k0), need = r + (R0 + (val(R, k1) - R0) * t + gap) / sc;
      if (d >= need || d < 1e-9) continue;
      if ((need - d) * sc > tol) this.hits++;
      const f = (need - d) / d, mx = cx * f, my = cy * f, mz = cz * f;
      const put = (o: number, x: number, y: number, z: number): void => {
        X[o] = val(F, 0) * x + val(F, 4) * y + val(F, 8) * z + val(F, 12);
        X[o + 1] = val(F, 1) * x + val(F, 5) * y + val(F, 9) * z + val(F, 13);
        X[o + 2] = val(F, 2) * x + val(F, 6) * y + val(F, 10) * z + val(F, 14);
      };
      if (i > 1) put(a0, s0x + mx, s0y + my, s0z + mz);
      put(a1, s1x + mx, s1y + my, s1z + mz);
    }
    // Nor can an arm, past its root, coil under the oral disc: there it would be squeezed between
    // the floor and the other arms' roots. Below the disc's top it keeps outside the disc's rim.
    const top = D.position.y + D.scale.y;
    for (let A = 0; A < NA; A++) for (let i = FIRST_DISC_CHECKED; i < n; i++) {
      const a = 3 * (A * n + i);
      if (val(X, a + 1) >= top) continue;
      const rho = Math.hypot(val(X, a), val(X, a + 2)), need = D.scale.x + val(R, A * n + i) + gap;
      if (rho >= need) continue;
      if (need - rho > tol) this.hits++;
      const f = rho > 1e-9 ? need / rho : 1;
      if (rho > 1e-9) { X[a] = val(X, a) * f; X[a + 2] = val(X, a + 2) * f; } else X[a] = need;
    }
  }

  /** Each segment back to its rest length (both ends giving, the root held). */
  private restoreLengths(NA: number, n: number): void {
    const X = this.X, L = this.L;
    for (let A = 0; A < NA; A++) for (let i = 1; i < n; i++) {
      const k = A * n + i, a1 = 3 * k, a0 = a1 - 3;
      const ex = val(X, a1) - val(X, a0), ey = val(X, a1 + 1) - val(X, a0 + 1), ez = val(X, a1 + 2) - val(X, a0 + 2), l = Math.hypot(ex, ey, ez);
      const f = (l - val(L, k)) / Math.max(l, 1e-9), w1 = i === 1 ? f : f / 2, w0 = i === 1 ? 0 : f / 2;
      X[a1] = val(X, a1) - ex * w1; X[a1 + 1] = val(X, a1 + 1) - ey * w1; X[a1 + 2] = val(X, a1 + 2) - ez * w1;
      X[a0] = val(X, a0) + ex * w0; X[a0 + 1] = val(X, a0 + 1) + ey * w0; X[a0 + 2] = val(X, a0 + 2) + ez * w0;
    }
  }
}
