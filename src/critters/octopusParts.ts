// The octopus's textures and its arms: a tube along a chain of points, with two staggered rows of
// suckers. The CPU works out each ring's centre and frame every frame (a few texels per ring, in one
// small float texture per octopus: ArmSpines); the vertex shader builds the tube's skin from them.
import * as THREE from 'three';
import { range, clamp, lerp, makeCanvas, context2d, Noise, mulberry32, type Rng } from '../util.js';
import { organicPass, type OrganicOptions } from '../core/organic.js';
import { canvasTexture, type ShaderHook } from './shared.js';
import type { Node, NodeObject, Tsl } from '../webgpu/tsl.js';

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

/** Texel rows per arm in the spine texture (A, B, C below). */
const SPINE_ROWS = 3;

/**
 * Every arm's rings for the vertex shader, one float texture per octopus: a column per ring (the
 * chain's rings, the cap's, then the tip's point) and three rows per arm:
 *   A = (centre, radius)          the ring's centre (moved ahead over the cap) and its scale;
 *   B = (T, tilt)                 the tangent, and how far the normals lean along it;
 *   C = (Nn, section weight)      towards the ground; the section normal's share (the cap's cosine).
 * A vertex is A.xyz + (Nn y + Bn x) A.w, its normal normalize((Nn ny + Bn nx) C.w + T B.w), with
 * (x, y, nx, ny) its place on the unit section (aSec) and Bn = T x Nn.
 */
export class ArmSpines {
  readonly width: number;
  readonly data: Float32Array;
  readonly texture: THREE.DataTexture;
  private depthMat: THREE.MeshDepthMaterial | null = null;

  constructor(arms: number, n: number) {
    this.width = (n - 1) * ARM_SUB + 1 + ARM_CAP.length + 1;
    this.data = new Float32Array(this.width * arms * SPINE_ROWS * 4);
    const tex = new THREE.DataTexture(this.data, this.width, arms * SPINE_ROWS, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.texture = tex;
  }

  /** WebGL: the arms' patch (vertices built from the texture), for the skin and the shadow's depth material. */
  readonly hook: ShaderHook = (shader) => {
    shader.uniforms['uArmSpine'] = { value: this.texture };
    shader.vertexShader = ARM_VERT_HEAD + shader.vertexShader
      .replace('#include <beginnormal_vertex>', ARM_NORMAL_GLSL)
      .replace('#include <begin_vertex>', ARM_POSITION_GLSL);
  };

  /** WebGL's shadow pass draws the stock depth material, which knows nothing of the texture: this one does. */
  depthMaterial(): THREE.MeshDepthMaterial {
    if (this.depthMat) return this.depthMat;
    const m = new THREE.MeshDepthMaterial();
    m.onBeforeCompile = this.hook;
    m.customProgramCacheKey = (): string => 'octo-arm-depth';
    this.depthMat = m;
    return m;
  }

  /** TSL: the local position (and, as a side effect, normalLocal) from the texture. */
  positionNode(t: Tsl): Node {
    const tex = this.texture;
    return t.Fn(() => {
      const aSec = t.attribute('aSec', 'vec4') as NodeObject, aRing = t.attribute('aRing', 'vec2') as NodeObject;
      const x = t.int(aRing.x.add(0.5)) as NodeObject, y = t.int(aRing.y.add(0.5)).mul(SPINE_ROWS) as NodeObject;
      const A = t.textureLoad(tex, t.ivec2(x, y)) as NodeObject;
      const B = t.textureLoad(tex, t.ivec2(x, y.add(1))) as NodeObject;
      const C = t.textureLoad(tex, t.ivec2(x, y.add(2))) as NodeObject;
      const Bn = t.cross(B.xyz, C.xyz) as NodeObject;
      t.normalLocal.assign(C.xyz.mul(aSec.w).add(Bn.mul(aSec.z)).mul(C.w).add(B.xyz.mul(B.w)).normalize());
      return A.xyz.add(C.xyz.mul(aSec.y).add(Bn.mul(aSec.x)).mul(A.w));
    })();
  }
}

const ARM_VERT_HEAD = `uniform highp sampler2D uArmSpine;
attribute vec4 aSec;
attribute vec2 aRing;
void armRing(out vec4 A, out vec4 B, out vec4 C) {
  ivec2 tc = ivec2(int(aRing.x + 0.5), int(aRing.y + 0.5) * ${SPINE_ROWS});
  A = texelFetch(uArmSpine, tc, 0);
  B = texelFetch(uArmSpine, tc + ivec2(0, 1), 0);
  C = texelFetch(uArmSpine, tc + ivec2(0, 2), 0);
}
`;
const ARM_NORMAL_GLSL = `vec4 anA, anB, anC; armRing(anA, anB, anC);
  vec3 objectNormal = normalize((anC.xyz * aSec.w + cross(anB.xyz, anC.xyz) * aSec.z) * anC.w + anB.xyz * anB.w);`;
const ARM_POSITION_GLSL = `vec4 apA, apB, apC; armRing(apA, apB, apC);
  vec3 transformed = apA.xyz + (apC.xyz * aSec.y + cross(apB.xyz, apC.xyz) * aSec.x) * apA.w;`;

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
  /** Its own reflex (Octopus.armReflex): how far it has swung off what it touched (rad, about the
   *  vertical) and how much it has drawn in (0..1). Both relax once it is clear. */
  shy = 0;
  pull = 0;
  private readonly suckers: THREE.InstancedMesh;
  private readonly first: number;
  private readonly spines: ArmSpines;
  /** This arm's first texel (floats) in spines.data. */
  private readonly base: number;
  private readonly nr: number;
  private readonly rings: number;
  private readonly centres: Float32Array;   // ring centres ...
  private readonly frames: Float32Array;    // ... and frames (T, Nn, Bn), for the suckers
  private readonly lastNn = new THREE.Vector3();

  constructor(n: number, r0: number, r1: number, mat: THREE.Material, suckers: THREE.InstancedMesh, first: number, spines: ArmSpines, row: number) {
    this.n = n; this.r0 = r0; this.r1 = r1;
    this.suckers = suckers; this.first = first;   // its instances: first .. first + SUCKERS_PER_ARM
    this.spines = spines; this.base = row * SPINE_ROWS * spines.width * 4;
    const ring = ARM_RING, nr = (n - 1) * ARM_SUB + 1, rings = nr + ARM_CAP.length, count = rings * ring + 1, g = new THREE.BufferGeometry();
    this.nr = nr; this.rings = rings;
    // position and normal are filled only on demand (syncVertices: the shape check reads them); the
    // shader builds the drawn ones from aSec (the vertex's place on the unit section) and aRing.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const col = new Float32Array(count * 3), uv = new Float32Array(count * 2), thin = new Float32Array(count), idx: number[] = [];
    const sec = new Float32Array(count * 4), ringOf = new Float32Array(count * 2);
    for (let i = 0; i < rings; i++) for (let j = 0; j < ring; j++) {
      const f = Math.min(1, i / (nr - 1)), k = i * ring + j, cs = Math.cos((j / ring) * Math.PI * 2);
      uv[2 * k] = j / ring * 0.25; uv[2 * k + 1] = f * 2;
      thin[k] = 0.1 + 0.9 * f ** 1.5;   // thin and translucent towards the tip
      sec.set(ARM_SEC.subarray(4 * j, 4 * j + 4), 4 * k);
      ringOf[2 * k] = i; ringOf[2 * k + 1] = row;
      // the oral face paler (no painted stripes: the suckers are real now)
      const pale = 0.45 * clamp(cs, 0, 1) ** 2;
      col[3 * k] = lerp(1, 2.0, pale); col[3 * k + 1] = lerp(1, 2.7, pale); col[3 * k + 2] = lerp(1, 3.0, pale);
      // (wound to face out: the old tube faced in, and showed its far wall's inside)
      if (i < rings - 1) { const a = k, b = i * ring + (j + 1) % ring; idx.push(a, b, a + ring, b, b + ring, a + ring); }
      else idx.push(k, i * ring + (j + 1) % ring, count - 1);   // the tip's last fan
    }
    col.fill(1, (count - 1) * 3); thin[count - 1] = 1;
    ringOf[2 * (count - 1)] = rings; ringOf[2 * (count - 1) + 1] = row;   // the tip's point: its own column, on the axis
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aThin', new THREE.BufferAttribute(thin, 1));
    g.setAttribute('aSec', new THREE.BufferAttribute(sec, 4));
    g.setAttribute('aRing', new THREE.BufferAttribute(ringOf, 2));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), NEVER_CULL_RADIUS);
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    // (critterCheck.ts calls this before it reads the vertices; JSON leaves functions out of the hashes)
    this.mesh.userData['syncGeometry'] = (): void => this.syncVertices();
    this.pts = Array.from({ length: n }, () => new THREE.Vector3());
    this.centres = new Float32Array(nr * 3); this.frames = new Float32Array(nr * 9);
  }

  /** Radius at f (0 root .. 1 tip). */
  rAt(f: number): number { return this.r1 + (this.r0 - this.r1) * (1 - f) ** TAPER_POWER; }

  /** Lay out the rings from pts (for the shader and the suckers); 'down' is the local direction of the ground. */
  build(down: THREE.Vector3): void {
    this.computeCentres();
    const T = this.buildRings(down);
    this.buildTip(T);
    this.spines.texture.needsUpdate = true;
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

  /** Writes one column of this arm's texels (ArmSpines: A, B, C). */
  private texel(col: number, a: THREE.Vector3, aw: number, b: THREE.Vector3, bw: number, c: THREE.Vector3, cw: number): void {
    const D = this.spines.data, row = this.spines.width * 4, k = this.base + col * 4;
    D[k] = a.x; D[k + 1] = a.y; D[k + 2] = a.z; D[k + 3] = aw;
    D[k + row] = b.x; D[k + row + 1] = b.y; D[k + row + 2] = b.z; D[k + row + 3] = bw;
    D[k + 2 * row] = c.x; D[k + 2 * row + 1] = c.y; D[k + 2 * row + 2] = c.z; D[k + 2 * row + 3] = cw;
  }

  /** The rings and the rounded cap over the tip, as texels; returns the last tangent. */
  private buildRings(down: THREE.Vector3): THREE.Vector3 {
    const nr = this.nr, C = this.centres, F = this.frames;
    const T = new THREE.Vector3(), Nn = new THREE.Vector3(), Bn = new THREE.Vector3(), c = new THREE.Vector3();
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
      // over the tip: a rounded cap, the section shrinking on a quarter circle (its normals turning
      // forward on it); along the arm the taper tilts the skin forward
      const ang = cap ? ARM_CAP[cap - 1] ?? 0 : 0, sc = Math.cos(ang), ahead = r * Math.sin(ang);
      c.set(val(C, 3 * ic), val(C, 3 * ic + 1), val(C, 3 * ic + 2)).addScaledVector(T, ahead);
      this.texel(i, c, r * sc, T, cap ? Math.sin(ang) : -slope, Nn, cap ? sc : 1);
    }
    this.lastNn.copy(Nn);
    return T;
  }

  /** The tip's point: a zero section on the axis, its normal straight ahead. */
  private buildTip(T: THREE.Vector3): void {
    const C = this.centres, last = 3 * (this.nr - 1);
    _v.set(val(C, last), val(C, last + 1), val(C, last + 2)).addScaledVector(T, this.rAt(1));
    this.texel(this.rings, _v, 0, T, 1, this.lastNn, 0);
  }

  /** The vertices as the shader builds them, into position and normal (for the checks that read them). */
  syncVertices(): void {
    const g = this.mesh.geometry, P = g.getAttribute('position'), N = g.getAttribute('normal');
    const sec = g.getAttribute('aSec').array, ringOf = g.getAttribute('aRing').array, D = this.spines.data, row = this.spines.width * 4;
    const pa = P.array, na = N.array;
    for (let v = 0; v < P.count; v++) {
      const k = this.base + val(ringOf, 2 * v) * 4, x = val(sec, 4 * v), y = val(sec, 4 * v + 1), nx = val(sec, 4 * v + 2), ny = val(sec, 4 * v + 3);
      const tx = val(D, k + row), ty = val(D, k + row + 1), tz = val(D, k + row + 2), tilt = val(D, k + row + 3);
      const gx = val(D, k + 2 * row), gy = val(D, k + 2 * row + 1), gz = val(D, k + 2 * row + 2), w = val(D, k + 2 * row + 3);
      const bx = ty * gz - tz * gy, by = tz * gx - tx * gz, bz = tx * gy - ty * gx;   // Bn = T x Nn
      const r = val(D, k + 3);
      pa[3 * v] = val(D, k) + (gx * y + bx * x) * r; pa[3 * v + 1] = val(D, k + 1) + (gy * y + by * x) * r; pa[3 * v + 2] = val(D, k + 2) + (gz * y + bz * x) * r;
      _v.set((gx * ny + bx * nx) * w + tx * tilt, (gy * ny + by * nx) * w + ty * tilt, (gz * ny + bz * nx) * w + tz * tilt).normalize();
      na[3 * v] = _v.x; na[3 * v + 1] = _v.y; na[3 * v + 2] = _v.z;
    }
    P.needsUpdate = true; N.needsUpdate = true;
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
