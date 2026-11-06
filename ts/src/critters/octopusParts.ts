// The octopus's textures and its arms: a tube along a chain of points, rebuilt in place each frame,
// with two staggered rows of suckers.
import * as THREE from 'three';
import { range, clamp, lerp, makeCanvas, context2d, Noise, mulberry32, type Rng } from '../util.js';
import { organicPass, type OrganicOptions } from '../core/organic.js';
import { canvasTexture } from './shared.js';

const FULL_CIRCLE = 7;   // > 2 PI: canvas arcs drawn as whole discs

/** The skin's own warp seed, so the body's and the arms' copies of the skin warp alike; the texture tiles. */
const SKIN_WARP_SEED = 91;
const SKIN_ORGANIC: OrganicOptions = { warp: [[8, 4, 5, 3], [24, 12, 2, 1]], mottle: { cellsX: 8, cellsY: 4, value: 0.06, chroma: 0.03 }, wrapX: true, wrapY: true };

/** Red-brown skin with a net of grooves and pale spots; armSpots adds the arms' bold white spots. */
export function octoSkin(rng: Rng, armSpots = 0): THREE.CanvasTexture {
  const W = 512, H = 256, c = makeCanvas(W, H), g = context2d(c), n = new Noise(rng);
  const img = g.createImageData(W, H), d = img.data;
  const base = [150, 58, 34] as const, darkc = [88, 30, 20] as const;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const m = n.fbm(x / 22, y / 22, 3), p = n.noise2(x / 4, y / 4);
    const k = (y * W + x) * 4;
    // A net of dark grooves between raised patches (ridged noise: lines where the noise crosses 0.5).
    const rid = 1 - Math.abs(2 * n.noise2(x / 6 + 40, y / 6) - 1), net = clamp((rid - 0.88) / 0.1, 0, 1) * 0.35;
    const t = clamp((m - 0.45) * 3, 0, 1);
    const sh = (0.85 + 0.3 * p) * (1 - net);
    d[k] = lerp(base[0], darkc[0], t) * sh;
    d[k + 1] = lerp(base[1], darkc[1], t) * sh;
    d[k + 2] = lerp(base[2], darkc[2], t) * sh;
    d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = 'rgba(245,200,170,0.55)';
  const PALE_SPOTS = 260;
  for (let i = 0; i < PALE_SPOTS; i++) { g.beginPath(); g.arc(rng() * W, rng() * H, range(rng, 1, 3), 0, FULL_CIRCLE); g.fill(); }
  // Bold white spots, densest on the arms (the left quarter of the texture is the arms' strip).
  g.fillStyle = 'rgba(248,240,232,0.85)';
  for (let i = 0; i < armSpots; i++) { g.beginPath(); g.ellipse(rng() * W * 0.25, rng() * H, range(rng, 2, 4.5), range(rng, 1.5, 3), rng() * 3, 0, FULL_CIRCLE); g.fill(); }
  organicPass(g, W, H, mulberry32(SKIN_WARP_SEED), SKIN_ORGANIC);
  const t = canvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * An octopus eye: a pale ring round a golden iris with a horizontal bar pupil, drawn where the
 * sphere's +x side faces (the centre of the texture).
 */
export function octoEyeTex(): THREE.CanvasTexture {
  const W = 256, H = 128, c = makeCanvas(W, H), g = context2d(c);
  g.fillStyle = '#8a4a30'; g.fillRect(0, 0, W, H);   // skin round the eye
  const cx = W / 2, cy = H / 2;
  g.fillStyle = '#d8c8b0'; g.beginPath(); g.ellipse(cx, cy, 30, 34, 0, 0, FULL_CIRCLE); g.fill();
  const gr = g.createRadialGradient(cx, cy, 2, cx, cy, 24);
  gr.addColorStop(0, '#d8b070'); gr.addColorStop(1, '#a07a48');
  g.fillStyle = gr; g.beginPath(); g.ellipse(cx, cy, 22, 26, 0, 0, FULL_CIRCLE); g.fill();
  g.fillStyle = '#0a0806'; g.fillRect(cx - 4, cy - 15, 8, 30);   // the bar (texture v runs down the sphere: vertical here is horizontal on the eye)
  return canvasTexture(c);
}

/** Papillae: soft raised bumps. */
export function octoBump(rng: Rng): THREE.CanvasTexture {
  const s = 256, c = makeCanvas(s, s), g = context2d(c);
  g.fillStyle = '#808080'; g.fillRect(0, 0, s, s);
  const BUMPS = 1400;
  for (let i = 0; i < BUMPS; i++) {
    const x = rng() * s, y = rng() * s, r = range(rng, 1, 4);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, FULL_CIRCLE); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// A sucker: a shallow cupped lathe (rim and dimple) standing on the arm's oral face, its base sunk
// into the arm. 0.03 across at the root (M = 1); the instance matrices scale and place it.
export const SUCKER_R = 0.03, SUCKERS_PER_ARM = 36;
const SUCKER_SEGMENTS = 8;
export function suckerGeometry(): THREE.LatheGeometry {
  const prof: readonly (readonly [number, number])[] = [[1.0, -0.5], [1.0, 0.2], [0.86, 0.52], [0.6, 0.5], [0.38, 0.28], [0.0, 0.2]];
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r * SUCKER_R, y * SUCKER_R)), SUCKER_SEGMENTS);
  g.deleteAttribute('uv');
  return g;
}

// The tube's section isn't round: the oral (sucker) side, facing the ground, is broad and flat (a
// superellipse), the aboral side domed. The taper is a curve (quick thinning near the root, long and
// slender after) closed by a rounded tip, and the normals follow the section and the taper. Two rings
// per chain segment (Catmull-Rom between the points), so the coils read smooth.
const ARM_RING = 16, ARM_SUB = 2;
const ARM_CAP: readonly number[] = [0.55, 1.0, 1.35];   // cap rings' angles over the tip
const ORAL_N = 3.5, ORAL_H = 0.6, ABORAL_H = 0.95;      // section: half-depths per radius ...
export const ARM_W = 1.05;                              // ... and half-width per radius
const NEVER_CULL_RADIUS = 1e3;
const TAPER_POWER = 1.6;

/**
 * The section per unit radius, once: x across (along Bn), y towards the ground (Nn), and its normal.
 * The oral side is a superellipse, flat and broad; the aboral side an ellipse.
 */
const ARM_SEC = ((): Float32Array => {
  const S = new Float32Array(ARM_RING * 4), e = 2 / ORAL_N;
  for (let j = 0; j < ARM_RING; j++) {
    const b = (j / ARM_RING) * Math.PI * 2, cs = Math.cos(b), sn = Math.sin(b);
    let x: number, y: number, gx: number, gy: number;
    if (cs > 0) {
      x = ARM_W * Math.sign(sn) * Math.abs(sn) ** e; y = ORAL_H * cs ** e;
      gx = Math.sign(x) * Math.abs(x / ARM_W) ** (ORAL_N - 1) / ARM_W; gy = (y / ORAL_H) ** (ORAL_N - 1) / ORAL_H;
    } else { x = ARM_W * sn; y = ABORAL_H * cs; gx = x / (ARM_W * ARM_W); gy = y / (ABORAL_H * ABORAL_H); }
    const gl = Math.hypot(gx, gy) || 1;
    S.set([x, y, gx / gl, gy / gl], 4 * j);
  }
  return S;
})();

const val = (a: ArrayLike<number>, i: number): number => a[i] ?? 0;
const _v = new THREE.Vector3(), _w = new THREE.Vector3();

function pointAt(pts: readonly THREE.Vector3[], i: number): THREE.Vector3 {
  const p = pts[i];
  if (!p) throw new RangeError(`arm point ${i} out of range`);
  return p;
}

/** A tube along a chain of points (the octopus's local frame), with its share of the sucker instances. */
export class ArmTube {
  readonly n: number;
  readonly r0: number;
  readonly r1: number;
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  /** The chain, root to tip, in the octopus's local frame. */
  readonly pts: THREE.Vector3[];
  /** Last frame's world positions (Octopus.update tows them). */
  readonly prevW: THREE.Vector3[] = [];
  /** The arm's place in the ring round the mouth (rad), length, coil and wave phase. */
  angle = 0;
  len = 0;
  curl = 1;
  ph = 0;
  /** Rest length of one segment (set each frame, read by the untangle). */
  seg = 0;
  private readonly suckers: THREE.InstancedMesh;
  private readonly first: number;
  private readonly nr: number;
  private readonly rings: number;
  private readonly centres: Float32Array;   // ring centres ...
  private readonly frames: Float32Array;    // ... and frames (T, Nn, Bn), for the suckers

  constructor(n: number, r0: number, r1: number, mat: THREE.Material, suckers: THREE.InstancedMesh, first: number) {
    this.n = n; this.r0 = r0; this.r1 = r1;
    this.suckers = suckers; this.first = first;   // its instances: first .. first + SUCKERS_PER_ARM
    const ring = ARM_RING, nr = (n - 1) * ARM_SUB + 1, rings = nr + ARM_CAP.length, count = rings * ring + 1, g = new THREE.BufferGeometry();
    this.nr = nr; this.rings = rings;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const col = new Float32Array(count * 3), uv = new Float32Array(count * 2), thin = new Float32Array(count), idx: number[] = [];
    for (let i = 0; i < rings; i++) for (let j = 0; j < ring; j++) {
      const f = Math.min(1, i / (nr - 1)), k = i * ring + j, cs = Math.cos((j / ring) * Math.PI * 2);
      uv[2 * k] = j / ring * 0.25; uv[2 * k + 1] = f * 2;
      thin[k] = 0.1 + 0.9 * f ** 1.5;   // thin and translucent towards the tip
      // the oral face paler (no painted stripes: the suckers are real now)
      const pale = 0.45 * clamp(cs, 0, 1) ** 2;
      col[3 * k] = lerp(1, 2.0, pale); col[3 * k + 1] = lerp(1, 2.7, pale); col[3 * k + 2] = lerp(1, 3.0, pale);
      // (wound to face out: the old tube faced in, and showed its far wall's inside)
      if (i < rings - 1) { const a = k, b = i * ring + (j + 1) % ring; idx.push(a, b, a + ring, b, b + ring, a + ring); }
      else idx.push(k, i * ring + (j + 1) % ring, count - 1);   // the tip's last fan
    }
    col.fill(1, (count - 1) * 3); thin[count - 1] = 1;
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aThin', new THREE.BufferAttribute(thin, 1));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), NEVER_CULL_RADIUS);
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.pts = Array.from({ length: n }, () => new THREE.Vector3());
    this.centres = new Float32Array(nr * 3); this.frames = new Float32Array(nr * 9);
  }

  /** Radius at f (0 root .. 1 tip). */
  rAt(f: number): number { return this.r1 + (this.r0 - this.r1) * (1 - f) ** TAPER_POWER; }

  /** Rebuild the tube from pts; 'down' is the local direction of the ground. */
  build(down: THREE.Vector3): void {
    this.computeCentres();
    const T = this.buildRings(down);
    this.buildTip(T);
    const g = this.mesh.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('normal').needsUpdate = true;
    this.placeSuckers();
  }

  /** Centres: through the chain's points, Catmull-Rom between. */
  private computeCentres(): void {
    const C = this.centres, pts = this.pts, n = this.n;
    for (let i = 0; i < this.nr; i++) {
      const s = Math.floor(i / ARM_SUB), t = (i % ARM_SUB) / ARM_SUB;
      const p0 = pointAt(pts, Math.max(0, s - 1)), p1 = pointAt(pts, s), p2 = pointAt(pts, Math.min(n - 1, s + 1)), p3 = pointAt(pts, Math.min(n - 1, s + 2));
      const t2 = t * t, t3 = t2 * t;
      const w0 = 0.5 * (-t + 2 * t2 - t3), w1 = 0.5 * (2 - 5 * t2 + 3 * t3), w2 = 0.5 * (t + 4 * t2 - 3 * t3), w3 = 0.5 * (t3 - t2);   // Catmull-Rom weights
      C[3 * i] = w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x;
      C[3 * i + 1] = w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y;
      C[3 * i + 2] = w0 * p0.z + w1 * p1.z + w2 * p2.z + w3 * p3.z;
    }
  }

  /** The rings and the rounded cap over the tip; returns the last tangent. */
  private buildRings(down: THREE.Vector3): THREE.Vector3 {
    const g = this.mesh.geometry, P = g.getAttribute('position').array, N = g.getAttribute('normal').array;
    const nr = this.nr, ring = ARM_RING, C = this.centres, F = this.frames, S = ARM_SEC;
    const T = new THREE.Vector3(), Nn = new THREE.Vector3(), Bn = new THREE.Vector3(), c = new THREE.Vector3(), o = new THREE.Vector3(), q = new THREE.Vector3();
    const L = this.seg / ARM_SUB || 1e-3;   // a ring's spacing, for the taper's slope
    for (let i = 0; i < this.rings; i++) {
      const ic = Math.min(i, nr - 1), cap = i - ic;   // cap: 1.. on the rings over the tip
      if (!cap) {
        const a = Math.max(0, ic - 1), b = Math.min(nr - 1, ic + 1);
        T.set(val(C, 3 * b) - val(C, 3 * a), val(C, 3 * b + 1) - val(C, 3 * a + 1), val(C, 3 * b + 2) - val(C, 3 * a + 2)).normalize();
        // Towards the ground, across the arm; where the arm hangs nearly straight down that is ill
        // defined, so the last ring's carries on (else the ring flips over and the tube folds shut).
        _w.copy(down).addScaledVector(T, -down.dot(T));
        if (i > 0 && _w.lengthSq() < 0.09) _w.copy(Nn).addScaledVector(T, -Nn.dot(T));
        Nn.copy(_w).normalize();
        if (Nn.lengthSq() < 1e-6) Nn.set(1, 0, 0);
        Bn.crossVectors(T, Nn);
        F.set([T.x, T.y, T.z, Nn.x, Nn.y, Nn.z, Bn.x, Bn.y, Bn.z], 9 * ic);
      }
      const f = ic / (nr - 1), r = this.rAt(f), slope = (this.rAt(Math.min(1, f + 0.02)) - this.rAt(Math.max(0, f - 0.02))) / (0.04 * (nr - 1) * L);
      // over the tip: a rounded cap, the section shrinking on a quarter circle
      const ang = cap ? ARM_CAP[cap - 1] ?? 0 : 0, sc = Math.cos(ang), ahead = r * Math.sin(ang);
      c.set(val(C, 3 * ic), val(C, 3 * ic + 1), val(C, 3 * ic + 2)).addScaledVector(T, ahead);
      for (let j = 0; j < ring; j++) {
        const x = val(S, 4 * j), y = val(S, 4 * j + 1);
        o.copy(Nn).multiplyScalar(y).addScaledVector(Bn, x);
        q.copy(Nn).multiplyScalar(val(S, 4 * j + 3)).addScaledVector(Bn, val(S, 4 * j + 2));
        if (cap) q.multiplyScalar(sc).addScaledVector(T, Math.sin(ang));
        else q.addScaledVector(T, -slope).normalize();   // the taper tilts the skin forward
        const k = (i * ring + j) * 3;
        P[k] = c.x + o.x * r * sc; P[k + 1] = c.y + o.y * r * sc; P[k + 2] = c.z + o.z * r * sc;
        N[k] = q.x; N[k + 1] = q.y; N[k + 2] = q.z;
      }
    }
    return T;
  }

  /** The tip's point. */
  private buildTip(T: THREE.Vector3): void {
    const g = this.mesh.geometry, P = g.getAttribute('position').array, N = g.getAttribute('normal').array;
    const C = this.centres, last = 3 * (this.nr - 1), k = (this.rings * ARM_RING) * 3, r1 = this.rAt(1);
    P[k] = val(C, last) + T.x * r1; P[k + 1] = val(C, last + 1) + T.y * r1; P[k + 2] = val(C, last + 2) + T.z * r1;
    N[k] = T.x; N[k + 1] = T.y; N[k + 2] = T.z;
  }

  /**
   * Two staggered rows on the oral face, shrinking to the tip, each cup standing on the face (its
   * axis along Nn, out of the sucker side), placed from the ring frames just built.
   */
  private placeSuckers(): void {
    const S = this.suckers, m = S.instanceMatrix.array, C = this.centres, F = this.frames, nr = this.nr;
    for (let k = 0; k < SUCKERS_PER_ARM; k++) {
      const f = 0.05 + 0.88 * (k / (SUCKERS_PER_ARM - 1)) ** 1.15, side = k % 2 ? 1 : -1;
      const x = f * (nr - 1), i0 = Math.min(nr - 2, Math.floor(x)), t = x - i0, r = this.rAt(f);
      const at = (o: number): number => val(F, 9 * i0 + o) + (val(F, 9 * (i0 + 1) + o) - val(F, 9 * i0 + o)) * t;
      const ct = (d: number): number => val(C, 3 * i0 + d) + (val(C, 3 * (i0 + 1) + d) - val(C, 3 * i0 + d)) * t;
      _v.set(at(3), at(4), at(5)).normalize(); _w.set(at(6), at(7), at(8)).normalize();   // Nn, Bn
      const s = (0.34 * r) / SUCKER_R, lat = 0.42 * ARM_W * r, up = 0.58 * r;   // on the flat face, ~0.4 of the way out
      const o = 16 * (this.first + k);
      // columns: Bn, Nn (the cup's axis), Bn x Nn (= -T: a right-handed frame, so the cup isn't mirrored)
      const tx = _w.y * _v.z - _w.z * _v.y, ty = _w.z * _v.x - _w.x * _v.z, tz = _w.x * _v.y - _w.y * _v.x;
      m.set([_w.x * s, _w.y * s, _w.z * s, 0, _v.x * s, _v.y * s, _v.z * s, 0, tx * s, ty * s, tz * s, 0,
        ct(0) + _w.x * lat * side + _v.x * up, ct(1) + _w.y * lat * side + _v.y * up, ct(2) + _w.z * lat * side + _v.z * up, 1], o);
    }
    S.instanceMatrix.needsUpdate = true;
    S.boundingBox = null;   // (recomputed only if asked: the shape check)
  }
}
