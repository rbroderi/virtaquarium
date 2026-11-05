// Feather-duster worms (Sabellastarte, Sabellidae): a leathery tube stuck in the rock with a crown of
// feathery radioles fanned out of it into a funnel to filter the water. They are famously shy: a shadow,
// a fish brushing past or a tap on the glass and the crown snaps shut and vanishes into the tube in a
// fraction of a second (giant-axon escape reflex), then creeps back out over half a minute or so.
//
// Sizes (1 unit = 12.5 cm): crown 5-10 cm across, radioles ~4 cm, 30-50 per crown in two lobes; the
// tube shows 3-8 cm above the rock and is ~1 cm thick.
//
// Drawing: one InstancedMesh of radioles for all worms (each a ribbon with a feathery alpha texture:
// the pinnules either side of the rachis, banded brown and cream), one merged mesh of tubes. The
// instance matrix puts each radiole in its worm's frame (y up the tube, x out from the axis at its angle
// round the crown); the vertex shader flares and curls it out, and folds and pulls it in by the worm's
// uRetract. Static when open, so the Roku backdrop bake shows them open.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addCaustics, waterUniforms } from './water.js';
import { addTranslucency } from './softSkin.js';
import { makeCanvas } from './util.js';

const MAX = 24;            // worms (uniform array size)
const RADIOLES = 44;

// The radiole texture: a rachis up the middle, pinnules angled up either side (alpha), colour bands
// along its length. u across (0..1), v along (0 base .. 1 tip).
function radioleTexture(rng, bands) {
  const W = 64, H = 256, c = makeCanvas(W, H), g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  for (let y = 0; y < H; y += 4) {
    const v = 1 - y / H, k = Math.floor(v * bands.n + 0.35 * Math.sin(v * 9));
    const col = bands.colors[((k % bands.colors.length) + bands.colors.length) % bands.colors.length];
    // Pinnules: fine filaments, longest a third of the way up, thinning to the tip.
    const reach = (W / 2 - 2) * Math.sin(Math.PI * Math.min(1, v * 1.25 + 0.05)) ** 0.7 * (0.85 + 0.15 * rng());
    g.strokeStyle = col; g.globalAlpha = 0.75; g.lineWidth = 1.2;
    for (const s of [-1, 1]) {
      g.beginPath(); g.moveTo(W / 2, y); g.lineTo(W / 2 + s * reach, y - reach * 0.45); g.stroke();
    }
  }
  // The rachis, darker and solid.
  g.globalAlpha = 1; g.fillStyle = bands.rachis; g.fillRect(W / 2 - 2, 0, 4, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// Ribbon: x across (-0.5..0.5), y along (0..1); the shader shapes it.
function ribbon() {
  const g = new THREE.PlaneGeometry(1, 1, 1, 10);
  g.translate(0, 0.5, 0);
  return g;
}

// Where the worms live: points on rock faces that look up or out (not under ledges, not buried), in a
// few clusters, found by marching down through the rock field from above.
function findSites(rng, field, heightAt, { width, count, avoid }) {
  const sites = [], n = new THREE.Vector3(), p = new THREE.Vector3();
  const clusters = [];
  for (let tries = 0; clusters.length < Math.ceil(count / 4) && tries < 400; tries++) {
    const x = (rng() - 0.5) * width * 0.8, z = -1.6 + rng() * 2.8;
    const h = heightAt(x, z);
    if (h < 0.9 || h > 4.2 || avoid.some((a) => Math.hypot(a.x - x, a.z - z) < a.r)) continue;
    if (clusters.some((c) => Math.hypot(c.x - x, c.z - z) < 1.6)) continue;
    clusters.push({ x, z });
  }
  for (const c of clusters) {
    let made = 0;
    for (let tries = 0; made < 4 + Math.floor(rng() * 3) && tries < 80 && sites.length < count; tries++) {
      const x = c.x + (rng() - 0.5) * 0.8, z = c.z + (rng() - 0.5) * 0.8;
      // Down from above to the surface; then a step in along the side to find faces as well as tops.
      let y = heightAt(x, z) + 0.5, d = 1;
      for (let i = 0; i < 60 && (d = field.dist(x, y, z)) > 0.01; i++) y -= Math.max(0.01, d * 0.8);
      if (d > 0.05) continue;
      field.normal(x, y, z, n);
      if (n.y < -0.1 || n.z < -0.4) continue;            // under an overhang, or facing the back wall
      p.set(x, y, z);
      if (sites.some((s) => s.pos.distanceTo(p) < 0.12)) continue;
      // The tube leans between the face's normal and up (they grow towards the light and the flow).
      const axis = n.clone().multiplyScalar(0.6).add(new THREE.Vector3(0, 1, 0.25).multiplyScalar(0.7)).normalize();
      axis.x += (rng() - 0.5) * 0.3; axis.normalize();
      sites.push({ pos: p.clone(), axis, size: 0.7 + rng() * 0.6 });
      made++;
    }
  }
  return sites;
}

const PALETTES = [
  { colors: ['#7a4a2a', '#e8dcc4', '#9a5e34', '#efe6d2'], rachis: '#5a3420', n: 9 },      // brown and cream bands
  { colors: ['#6a2a5a', '#d8c0d8', '#8a3a70'], rachis: '#4a1a3a', n: 7 },                 // purple-tinged
  { colors: ['#c07a3a', '#f0e0c0', '#a86a30'], rachis: '#7a4a24', n: 8 },                 // tan
];

export class FanWorms {
  constructor(rng, field, heightAt, opts) {
    this.group = new THREE.Group();
    this.group.name = 'fanWorms';
    this.group.userData.noHeight = true;   // fish brush through the crowns (and the worms duck)
    if (!field) { this.worms = []; return; }
    const sites = findSites(rng, field, heightAt, { count: Math.min(MAX, opts.count ?? 14), ...opts });
    this.uRetract = { value: new Float32Array(MAX) };
    this.worms = sites.map((s, i) => ({ ...s, i, retract: 0, wait: 0, crown: null }));

    const tubes = [], up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion(), m = new THREE.Matrix4();
    const crowns = this.worms.map(() => []);
    for (const w of this.worms) {
      // Tube: a slightly flaring, crooked leathery cylinder, sunk into the rock, its mouth TUBE above it.
      const len = 0.42 * w.size, r = 0.035 * w.size;
      const g = new THREE.CylinderGeometry(r * 1.1, r * 0.9, len, 10, 6, true);
      g.translate(0, len / 2 - len * 0.35, 0);
      const pos = g.attributes.position;
      for (let k = 0; k < pos.count; k++) {
        const yy = pos.getY(k);
        pos.setX(k, pos.getX(k) * (1 + 0.12 * Math.sin(yy * 60 + w.i)) + 0.01 * Math.sin(yy * 9 + w.i));
      }
      g.computeVertexNormals();
      q.setFromUnitVectors(up, w.axis);
      g.applyQuaternion(q);
      g.translate(w.pos.x, w.pos.y, w.pos.z);
      const col = new THREE.Color().setHSL(0.08 + 0.03 * Math.sin(w.i * 3.1), 0.25, 0.32 + 0.06 * Math.sin(w.i));
      const cs = new Float32Array(pos.count * 3);
      for (let k = 0; k < pos.count; k++) col.toArray(cs, k * 3);
      g.setAttribute('color', new THREE.BufferAttribute(cs, 3));
      tubes.push(g);
      w.mouth = w.pos.clone().addScaledVector(w.axis, len * 0.65);
      w.frame = new THREE.Quaternion().setFromUnitVectors(up, w.axis);
    }
    if (tubes.length) {
      const mat = addCaustics(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }));
      const tubeMesh = new THREE.Mesh(mergeGeometries(tubes), mat);
      tubeMesh.castShadow = tubeMesh.receiveShadow = true;
      this.group.add(tubeMesh);
    }

    // Crowns: radioles per palette (one InstancedMesh each, sharing the shader).
    const byPal = PALETTES.map(() => []);
    this.worms.forEach((w) => byPal[w.i % PALETTES.length].push(w));
    const rot = new THREE.Quaternion(), scl = new THREE.Vector3();
    byPal.forEach((ws, pi) => {
      if (!ws.length) return;
      const n = ws.length * RADIOLES, geo = ribbon();
      const aWorm = new Float32Array(n), aLen = new Float32Array(n);
      const mesh = new THREE.InstancedMesh(geo, this.crownMaterial(radioleTexture(rng, PALETTES[pi]), pi), n);
      let k = 0;
      for (const w of ws) {
        for (let j = 0; j < RADIOLES; j++, k++) {
          // Two lobes (the crown is split at the front and back), radioles packed round each.
          const lobe = j < RADIOLES / 2 ? 0 : 1, t = (j % (RADIOLES / 2)) / (RADIOLES / 2 - 1);
          const ang = lobe * Math.PI + 0.25 + t * (Math.PI - 0.5) + (rng() - 0.5) * 0.06;
          rot.setFromAxisAngle(up, ang).premultiply(w.frame);
          m.compose(w.mouth, rot, scl.setScalar(w.size));
          mesh.setMatrixAt(k, m);
          aWorm[k] = w.i;
          aLen[k] = 0.3 * (0.85 + 0.3 * rng()) * (1 - 0.15 * Math.abs(t - 0.5));
        }
      }
      geo.setAttribute('aWorm', new THREE.InstancedBufferAttribute(aWorm, 1));
      geo.setAttribute('aLen', new THREE.InstancedBufferAttribute(aLen, 1));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      this.group.add(mesh);
    });
  }

  crownMaterial(tex, pi) {
    const mat = addTranslucency(addCaustics(new THREE.MeshStandardMaterial({
      // Blended, not cut out: the pinnules are finer than a pixel at tank distance, and their mip-averaged
      // alpha (a gauzy veil, as a real crown looks) would fall under any alpha test and vanish.
      map: tex, transparent: true, depthWrite: false, alphaTest: 0.03, side: THREE.DoubleSide, roughness: 0.6,
    })), { wrap: 0.6, back: 0.8, tint: [1.0, 0.75, 0.55], thin: 0.9 });
    const prev = mat.onBeforeCompile, uR = this.uRetract;
    mat.onBeforeCompile = (shader, r) => {
      prev(shader, r);
      shader.uniforms.uRetract = uR;
      shader.uniforms.uTime = waterUniforms.uTime;
      // Radiole shape, in its worm's frame (y up the tube, x out from the axis at this radiole's angle):
      // it leaves the mouth flared FLARE from the axis and curls further out towards the tip, its width
      // (z) round the crown. Retracting (r 0..1) closes the flare, bundles the radioles and pulls them
      // down into the tube. Water sways the open crown gently.
      shader.vertexShader = `uniform float uRetract[${MAX}];\nuniform float uTime;\nattribute float aWorm;\nattribute float aLen;\n` + shader.vertexShader
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

  // Startle and recover: a fish rushing by within reach, anything coming very close, a passing shadow
  // (a fish just over the crown) or a tap at the glass near it. Shut takes ~0.15 s; reopening waits a
  // few seconds, then takes ~20-40 s, slower after repeated scares.
  update(dt, world) {
    if (!this.worms.length) return;
    const v = world.viewer;
    for (const w of this.worms) {
      // Habituation: a worm scared over and over (a resident fish's shelter beside it) lets things come
      // closer before it ducks, and forgets over a few minutes.
      const reach = 1 - 0.55 * (w.shy || 0);
      let scare = false;
      for (const f of world.fish) {
        const d = f.pos.distanceTo(w.mouth), L = f.size;
        if (d < (0.2 + 0.5 * L) * reach || (d < (0.8 + L) * reach && f.speed > 1.2 * L)) { scare = true; break; }
      }
      if (!scare) for (const c of world.critters) if (c.pos && c.pos.distanceTo(w.mouth) < 1.0) { scare = true; break; }
      if (!scare && v && v.activity > 0.6 && Math.hypot(v.pos.x - w.mouth.x, v.pos.y - w.mouth.y) < 1.2 && w.mouth.z > 0) scare = true;
      if (scare) { w.wait = 4 + 6 * w.shy; w.shy = Math.min(1, (w.shy || 0) + 0.25); }
      w.shy = Math.max(0, (w.shy || 0) - dt / 120);
      if (w.wait > 0) {
        w.wait -= dt;
        w.retract = Math.min(1, w.retract + dt / 0.15);
      } else {
        w.retract = Math.max(0, w.retract - dt / (20 + 20 * (w.shy || 0)));
      }
      this.uRetract.value[w.i] = w.retract;
    }
  }
}
