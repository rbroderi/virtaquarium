// Feather-duster worms (Sabellastarte, Sabellidae): a leathery tube stuck in the rock with a crown of
// feathery radioles fanned out of it into a funnel to filter the water. They are famously shy: a shadow,
// a fish brushing past or a tap on the glass and the crown snaps shut and vanishes into the tube in a
// fraction of a second (giant-axon escape reflex), then creeps back out over half a minute or so.
//
// Sizes (1 unit = 12.5 cm): crown 5-10 cm across, radioles ~4 cm, 30-50 per crown in two lobes; the
// tube shows 3-8 cm above the rock and is ~1 cm thick.
//
// Drawing: one InstancedMesh of radioles per palette (each a ribbon with a feathery alpha texture:
// the pinnules either side of the rachis, banded brown and cream), one merged mesh of tubes. The
// instance matrix puts each radiole in its worm's frame (y up the tube, x out from the axis at its angle
// round the crown); the vertex shader flares and curls it out, and folds and pulls it in by the worm's
// uRetract. Static when open, so the Roku backdrop bake shows them open.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addCaustics, waterUniforms } from './water.js';
import { addTranslucency } from './softSkin.js';
import { makeCanvas, context2d, type Rng } from './util.js';
import { organicPass, type OrganicOptions } from './core/organic.js';
import type { SolidField } from './rockField.js';
import { markNoHeight } from './reef/flags.js';
import { gpuActive, tsl, type Tsl } from './webgpu/tsl.js';
import { waterTimeNode } from './webgpu/timeUniform.js';
import type { Node, ShaderNodeObject, UniformArrayNode, UniformNode } from 'three/webgpu';

/** Worms (the uRetract uniform array's size). */
const MAX_WORMS = 24;
const RADIOLES = 44;
const DEFAULT_COUNT = 14;
const WORMS_PER_CLUSTER = 4;
const UP = new THREE.Vector3(0, 1, 0);

// Where worms may settle.
const SITE = {
  minHeight: 0.9, maxHeight: 4.2,       // rock top height range for a cluster
  clusterSpacing: 1.6, clusterTries: 400,
  clusterSpread: 0.8, siteTries: 80, siteSpacing: 0.12,
  marchSteps: 60, surfaceEps: 0.01, surfaceTolerance: 0.05,
} as const;

// Startle and recovery (s, units).
const STARTLE = {
  closeReach: 0.2, closePerLength: 0.5,   // anything this near ducks it
  rushReach: 0.8, rushSpeedPerLength: 1.2,
  critterReach: 1.0,
  viewerActivity: 0.6, viewerReach: 1.2,
  shutSeconds: 0.15,
  waitBase: 4, waitShy: 6,
  shyStep: 0.25, forgetSeconds: 120,
  reopenBase: 20, reopenShy: 20,
  habituatedReach: 0.55,
} as const;

interface RadioleBands {
  readonly colors: readonly string[];
  readonly rachis: string;
  readonly n: number;
}

const PALETTES: readonly RadioleBands[] = [
  { colors: ['#7a4a2a', '#e8dcc4', '#9a5e34', '#efe6d2'], rachis: '#5a3420', n: 9 },      // brown and cream bands
  { colors: ['#6a2a5a', '#d8c0d8', '#8a3a70'], rachis: '#4a1a3a', n: 7 },                 // purple-tinged
  { colors: ['#c07a3a', '#f0e0c0', '#a86a30'], rachis: '#7a4a24', n: 8 },                 // tan
];

export interface FanWormSite {
  readonly pos: THREE.Vector3;
  readonly axis: THREE.Vector3;
  readonly size: number;
}

export interface FanWorm extends FanWormSite {
  readonly i: number;
  retract: number;
  wait: number;
  shy: number;
  /** The tube's opening, where the crown sits. */
  mouth: THREE.Vector3;
  /** Rotates the worm frame's +y onto the tube axis. */
  frame: THREE.Quaternion;
}

export interface FanWormOptions {
  readonly width: number;
  readonly count?: number;
  /** Circles on the sand to keep clear of (the anemone's rock). */
  readonly avoid: readonly { readonly x: number; readonly z: number; readonly r: number }[];
}

/** What a startle check reads from the world (dependency inversion: world.ts satisfies it). */
export interface FanWormWorld {
  readonly fish: readonly { readonly pos: THREE.Vector3; readonly size: number; readonly speed: number }[];
  readonly critters: readonly { readonly pos?: THREE.Vector3 | null }[];
  readonly viewer?: { readonly pos: THREE.Vector3; readonly activity: number } | null;
}

export type HeightSampler = (x: number, z: number) => number;

/**
 * The radiole texture: a rachis up the middle, pinnules angled up either side (alpha), colour bands
 * along its length. u across (0..1), v along (0 base .. 1 tip).
 */
/** The colour bands' edges and the rachis wander a little. */
const RADIOLE_ORGANIC: OrganicOptions = { warp: [[2, 8, 1.5, 3]], mottle: { cellsX: 2, cellsY: 6, value: 0.07, chroma: 0.04 } };

function radioleTexture(rng: Rng, bands: RadioleBands): THREE.CanvasTexture {
  const W = 64, H = 256, c = makeCanvas(W, H), g = context2d(c);
  g.clearRect(0, 0, W, H);
  for (let y = 0; y < H; y += 4) {
    const v = 1 - y / H, k = Math.floor(v * bands.n + 0.35 * Math.sin(v * 9));
    const col = bands.colors[((k % bands.colors.length) + bands.colors.length) % bands.colors.length] ?? bands.rachis;
    // Pinnules: fine filaments, longest a third of the way up, thinning to the tip.
    const reach = (W / 2 - 2) * Math.sin(Math.PI * Math.min(1, v * 1.25 + 0.05)) ** 0.7 * (0.85 + 0.15 * rng());
    g.strokeStyle = col; g.globalAlpha = 0.75; g.lineWidth = 1.2;
    for (const s of [-1, 1]) {
      g.beginPath(); g.moveTo(W / 2, y); g.lineTo(W / 2 + s * reach, y - reach * 0.45); g.stroke();
    }
  }
  // The rachis, darker and solid.
  g.globalAlpha = 1; g.fillStyle = bands.rachis; g.fillRect(W / 2 - 2, 0, 4, H);
  organicPass(g, W, H, rng, RADIOLE_ORGANIC);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Ribbon: x across (-0.5..0.5), y along (0..1); the shader shapes it. */
function ribbon(): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(1, 1, 1, 10);
  g.translate(0, 0.5, 0);
  return g;
}

/** Cluster centres on rock tops of the right height, apart from each other and the avoided spots. */
function findClusters(rng: Rng, heightAt: HeightSampler, count: number, options: FanWormOptions): { x: number; z: number }[] {
  const clusters: { x: number; z: number }[] = [];
  for (let tries = 0; clusters.length < Math.ceil(count / WORMS_PER_CLUSTER) && tries < SITE.clusterTries; tries++) {
    const x = (rng() - 0.5) * options.width * 0.8, z = -1.6 + rng() * 2.8;
    const h = heightAt(x, z);
    if (h < SITE.minHeight || h > SITE.maxHeight || options.avoid.some((a) => Math.hypot(a.x - x, a.z - z) < a.r)) continue;
    if (clusters.some((c) => Math.hypot(c.x - x, c.z - z) < SITE.clusterSpacing)) continue;
    clusters.push({ x, z });
  }
  return clusters;
}

/**
 * Where the worms live: points on rock faces that look up or out (not under ledges, not buried), in a
 * few clusters, found by marching down through the rock field from above.
 */
function findSites(rng: Rng, field: SolidField, heightAt: HeightSampler, count: number, options: FanWormOptions): FanWormSite[] {
  const sites: FanWormSite[] = [], n = new THREE.Vector3(), p = new THREE.Vector3();
  for (const c of findClusters(rng, heightAt, count, options)) {
    let made = 0;
    for (let tries = 0; made < 4 + Math.floor(rng() * 3) && tries < SITE.siteTries && sites.length < count; tries++) {
      const x = c.x + (rng() - 0.5) * SITE.clusterSpread, z = c.z + (rng() - 0.5) * SITE.clusterSpread;
      // Down from above to the surface; then a step in along the side to find faces as well as tops.
      let y = heightAt(x, z) + 0.5, d = 1;
      for (let i = 0; i < SITE.marchSteps && (d = field.dist(x, y, z)) > SITE.surfaceEps; i++) y -= Math.max(0.01, d * 0.8);
      if (d > SITE.surfaceTolerance) continue;
      field.normal(x, y, z, n);
      if (n.y < -0.1 || n.z < -0.4) continue;            // under an overhang, or facing the back wall
      p.set(x, y, z);
      if (sites.some((s) => s.pos.distanceTo(p) < SITE.siteSpacing)) continue;
      // The tube leans between the face's normal and up (they grow towards the light and the flow).
      const axis = n.clone().multiplyScalar(0.6).add(new THREE.Vector3(0, 1, 0.25).multiplyScalar(0.7)).normalize();
      axis.x += (rng() - 0.5) * 0.3; axis.normalize();
      sites.push({ pos: p.clone(), axis, size: 0.7 + rng() * 0.6 });
      made++;
    }
  }
  return sites;
}

/** Tube: a slightly flaring, crooked leathery cylinder, sunk into the rock; sets the worm's mouth. */
function tubeGeometry(w: FanWorm): THREE.BufferGeometry {
  const len = 0.42 * w.size, r = 0.035 * w.size;
  const g = new THREE.CylinderGeometry(r * 1.1, r * 0.9, len, 10, 6, true);
  g.translate(0, len / 2 - len * 0.35, 0);
  const pos = g.getAttribute('position');
  for (let k = 0; k < pos.count; k++) {
    const yy = pos.getY(k);
    pos.setX(k, pos.getX(k) * (1 + 0.12 * Math.sin(yy * 60 + w.i)) + 0.01 * Math.sin(yy * 9 + w.i));
  }
  g.computeVertexNormals();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, w.axis));
  g.translate(w.pos.x, w.pos.y, w.pos.z);
  const col = new THREE.Color().setHSL(0.08 + 0.03 * Math.sin(w.i * 3.1), 0.25, 0.32 + 0.06 * Math.sin(w.i));
  const cs = new Float32Array(pos.count * 3);
  for (let k = 0; k < pos.count; k++) col.toArray(cs, k * 3);
  g.setAttribute('color', new THREE.BufferAttribute(cs, 3));
  w.mouth = w.pos.clone().addScaledVector(w.axis, len * 0.65);
  w.frame = new THREE.Quaternion().setFromUnitVectors(UP, w.axis);
  return g;
}

export class FanWorms {
  readonly group = new THREE.Group();
  readonly worms: FanWorm[];
  private readonly uRetract = { value: new Float32Array(MAX_WORMS) };

  constructor(rng: Rng, field: SolidField | null, heightAt: HeightSampler, options: FanWormOptions) {
    this.group.name = 'fanWorms';
    markNoHeight(this.group);   // fish brush through the crowns (and the worms duck)
    if (!field) { this.worms = []; return; }
    const sites = findSites(rng, field, heightAt, Math.min(MAX_WORMS, options.count ?? DEFAULT_COUNT), options);
    this.worms = sites.map((s, i) => ({ ...s, i, retract: 0, wait: 0, shy: 0, mouth: s.pos.clone(), frame: new THREE.Quaternion() }));
    this.addTubes();
    this.addCrowns(rng);
  }

  private addTubes(): void {
    const tubes = this.worms.map(tubeGeometry);
    if (!tubes.length) return;
    const mat = addCaustics(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }));
    const tubeMesh = new THREE.Mesh(mergeGeometries(tubes), mat);
    tubeMesh.castShadow = tubeMesh.receiveShadow = true;
    this.group.add(tubeMesh);
  }

  /** Crowns: radioles per palette (one InstancedMesh each, sharing the shader). */
  private addCrowns(rng: Rng): void {
    const byPalette: FanWorm[][] = PALETTES.map(() => []);
    this.worms.forEach((w) => byPalette[w.i % PALETTES.length]?.push(w));
    const rot = new THREE.Quaternion(), scl = new THREE.Vector3(), m = new THREE.Matrix4();
    byPalette.forEach((ws, pi) => {
      const palette = PALETTES[pi];
      if (!ws.length || !palette) return;
      const n = ws.length * RADIOLES, geo = ribbon();
      const aWorm = new Float32Array(n), aLen = new Float32Array(n), aPhase = new Float32Array(n);
      const tex = radioleTexture(rng, palette);
      const mesh = new THREE.InstancedMesh(geo, gpuActive() ? this.crownNodeMaterial(tex) : this.crownMaterial(tex), n);
      const half = RADIOLES / 2;
      let k = 0;
      for (const w of ws) {
        for (let j = 0; j < RADIOLES; j++, k++) {
          // Two lobes (the crown is split at the front and back), radioles packed round each.
          const lobe = j < half ? 0 : 1, t = (j % half) / (half - 1);
          const ang = lobe * Math.PI + 0.25 + t * (Math.PI - 0.5) + (rng() - 0.5) * 0.06;
          rot.setFromAxisAngle(UP, ang).premultiply(w.frame);
          m.compose(w.mouth, rot, scl.setScalar(w.size));
          mesh.setMatrixAt(k, m);
          aWorm[k] = w.i;
          aLen[k] = 0.3 * (0.85 + 0.3 * rng()) * (1 - 0.15 * Math.abs(t - 0.5));
          aPhase[k] = w.mouth.x;
        }
      }
      geo.setAttribute('aWorm', new THREE.InstancedBufferAttribute(aWorm, 1));
      geo.setAttribute('aLen', new THREE.InstancedBufferAttribute(aLen, 1));
      geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(aPhase, 1));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      this.group.add(mesh);
    });
  }

  private crownMaterial(tex: THREE.Texture): THREE.MeshStandardMaterial {
    const mat = addTranslucency(addCaustics(new THREE.MeshStandardMaterial({
      // Blended, not cut out: the pinnules are finer than a pixel at tank distance, and their mip-averaged
      // alpha (a gauzy veil, as a real crown looks) would fall under any alpha test and vanish.
      map: tex, transparent: true, depthWrite: false, alphaTest: 0.03, side: THREE.DoubleSide, roughness: 0.6,
    })), { wrap: 0.6, back: 0.8, tint: [1.0, 0.75, 0.55], thin: 0.9 });
    const prev = mat.onBeforeCompile.bind(mat), uR = this.uRetract;
    mat.onBeforeCompile = (shader, r) => {
      prev(shader, r);
      shader.uniforms['uRetract'] = uR;
      shader.uniforms['uTime'] = waterUniforms.uTime;
      // Radiole shape, in its worm's frame (y up the tube, x out from the axis at this radiole's angle):
      // it leaves the mouth flared FLARE from the axis and curls further out towards the tip, its width
      // (z) round the crown. Retracting (r 0..1) closes the flare, bundles the radioles and pulls them
      // down into the tube. Water sways the open crown gently.
      shader.vertexShader = `uniform float uRetract[${MAX_WORMS}];\nuniform float uTime;\nattribute float aWorm;\nattribute float aLen;\n` + shader.vertexShader
        .replace('#include <beginnormal_vertex>', `
          float rr = uRetract[int(aWorm + 0.5)];
          float hh = position.y;
          float sw = (1.0 - rr) * 0.08 * sin(uTime * 0.9 + aWorm * 2.1 + instanceMatrix[3].x * 3.0);
          float ang = mix(0.75, 0.05, rr) + mix(0.55, 0.1, rr) * hh + sw * hh;
          vec3 objectNormal = vec3(cos(ang), -sin(ang), 0.0);`)
        .replace('#include <begin_vertex>', `
          float a0 = mix(0.75, 0.05, rr) + sw * 0.5, a1 = ang;
          float am = 0.5 * (a0 + a1);   // mean direction along the curl, for the arc's chord
          vec3 transformed = vec3(sin(am), cos(am), 0.0) * hh * aLen + vec3(0.0, 0.0, position.x * mix(0.04, 0.015, rr) * (1.0 - 0.55 * hh));
          transformed.y -= rr * (aLen * 1.1);   // into the tube`);
    };
    mat.customProgramCacheKey = () => 'fanworm';
    return mat;
  }

  /** The crown under WebGPU: the same base material plus a TSL vertex deformation (WebGPURenderer never
   *  runs onBeforeCompile GLSL, so the radioles would otherwise stay folded flat at the tube mouth). */
  private crownNodeMaterial(tex: THREE.Texture): InstanceType<Tsl['MeshStandardNodeMaterial']> {
    const t = tsl();
    const uRetract = t.uniformArray(this.uRetract.value as unknown as unknown[], 'float');
    const mat = new t.MeshStandardNodeMaterial({
      // See crownMaterial(): blended, not cut out, so the mip-averaged pinnule alpha stays gauzy.
      map: tex, transparent: true, depthWrite: false, alphaTest: 0.03, side: THREE.DoubleSide, roughness: 0.6,
    });
    mat.positionNode = this.crownPositionNode(uRetract, waterTimeNode());
    return mat;
  }

  /** TSL port of the radiole flare/curl/fold in crownMaterial()'s begin_vertex patch. */
  private crownPositionNode(
    uRetract: ShaderNodeObject<UniformArrayNode>,
    uTime: ShaderNodeObject<UniformNode<number>>,
  ): Node {
    const t = tsl();
    return t.Fn(() => {
      const p = t.positionLocal.toVar();
      const aWorm = t.attribute('aWorm', 'float');
      const aLen = t.attribute('aLen', 'float');
      const aPhase = t.attribute('aPhase', 'float');
      const rr = uRetract.element(t.int(aWorm.add(t.float(0.5))));
      const hh = p.y;
      // Water sways the open crown gently; aPhase de-correlates worms across the tank (the GLSL reads
      // instanceMatrix[3].x, which is not a TSL node, so the mouth x is carried on an attribute).
      const sw = t.float(1).sub(rr).mul(t.float(0.08))
        .mul(t.sin(uTime.mul(t.float(0.9)).add(aWorm.mul(t.float(2.1))).add(aPhase.mul(t.float(3.0)))));
      const ang = t.mix(t.float(0.75), t.float(0.05), rr)
        .add(t.mix(t.float(0.55), t.float(0.1), rr).mul(hh))
        .add(sw.mul(hh));
      const a0 = t.mix(t.float(0.75), t.float(0.05), rr).add(sw.mul(t.float(0.5)));
      const am = a0.add(ang).mul(t.float(0.5));   // mean direction along the curl, for the arc's chord
      const out = t.vec3(t.sin(am), t.cos(am), t.float(0)).mul(hh).mul(aLen)
        .add(t.vec3(t.float(0), t.float(0), p.x.mul(t.mix(t.float(0.04), t.float(0.015), rr)).mul(t.float(1).sub(t.float(0.55).mul(hh)))))
        .toVar();
      out.y.assign(out.y.sub(rr.mul(aLen.mul(t.float(1.1)))));   // pulled into the tube
      return out;
    })();
  }

  /** True when something near this worm should make it duck. */
  private startled(w: FanWorm, world: FanWormWorld): boolean {
    // Habituation: a worm scared over and over (a resident fish's shelter beside it) lets things come
    // closer before it ducks, and forgets over a few minutes.
    const reach = 1 - STARTLE.habituatedReach * w.shy;
    for (const f of world.fish) {
      const d = f.pos.distanceTo(w.mouth), L = f.size;
      if (d < (STARTLE.closeReach + STARTLE.closePerLength * L) * reach || (d < (STARTLE.rushReach + L) * reach && f.speed > STARTLE.rushSpeedPerLength * L)) return true;
    }
    for (const c of world.critters) if (c.pos && c.pos.distanceTo(w.mouth) < STARTLE.critterReach) return true;
    const v = world.viewer;
    return Boolean(v && v.activity > STARTLE.viewerActivity && Math.hypot(v.pos.x - w.mouth.x, v.pos.y - w.mouth.y) < STARTLE.viewerReach && w.mouth.z > 0);
  }

  /**
   * Startle and recover: a fish rushing by within reach, anything coming very close, a passing shadow
   * (a fish just over the crown) or a tap at the glass near it. Shut takes ~0.15 s; reopening waits a
   * few seconds, then takes ~20-40 s, slower after repeated scares.
   */
  update(dt: number, world: FanWormWorld): void {
    if (!this.worms.length) return;
    for (const w of this.worms) {
      if (this.startled(w, world)) { w.wait = STARTLE.waitBase + STARTLE.waitShy * w.shy; w.shy = Math.min(1, w.shy + STARTLE.shyStep); }
      w.shy = Math.max(0, w.shy - dt / STARTLE.forgetSeconds);
      if (w.wait > 0) {
        w.wait -= dt;
        w.retract = Math.min(1, w.retract + dt / STARTLE.shutSeconds);
      } else {
        w.retract = Math.max(0, w.retract - dt / (STARTLE.reopenBase + STARTLE.reopenShy * w.shy));
      }
      this.uRetract.value[w.i] = w.retract;
    }
  }
}
