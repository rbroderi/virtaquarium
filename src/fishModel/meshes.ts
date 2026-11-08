// 3D fin membranes and tubes (spines, free rays, tentacles and lappets).
import * as THREE from 'three';
import { lerp } from '../util.js';
import type { Species } from '../species/types.js';
import { mouthOf, type Profile } from './profile.js';
import { flankZ } from './section.js';
import type { Erect4, FinMeshSpec, FinSheet, TubeSpec } from './fins.js';

const MEMBRANE_ROWS = 10;
const TUBE_RINGS = 16;
const FROND_RINGS = 60;   // enough to carry the frond's scalloped edge
const FROND_LOBES = 7;
const DEFAULT_TUBE_SEGMENTS = 7;
const NO_ERECT: Erect4 = [0, 0, 0, 0];

// A fin membrane meshed on its rays: rows run from the base to the edge, and the membrane is
// fan-folded (rays on alternate ridges and valleys), which gives fins their pleated relief and
// broken-up highlights. UVs index the fin sheet texture, which is drawn in fish coordinates.
export function finMesh({ rays, n, erect, pleat = 1 }: FinMeshSpec, sheet: Pick<FinSheet, 'xmin' | 'xmax' | 'ymax'>): THREE.BufferGeometry {
  const NT = Math.max(24, n * 4), NS = MEMBRANE_ROWS, pos: number[] = [], uv: number[] = [], idx: number[] = [], er: number[] = [];
  for (let i = 0; i <= NT; i++) {
    const t = i / NT, [b, o] = rays(t), e = erect ? erect(t) : NO_ERECT;
    for (let j = 0; j <= NS; j++) er.push(...e);
    const ex = o[0] + (o[0] - b[0]) * 0.05, ey = o[1] + (o[1] - b[1]) * 0.05;   // overshoot; alpha trims it
    const L = Math.hypot(ex - b[0], ey - b[1]);
    for (let j = 0; j <= NS; j++) {
      const sj = j / NS, x = lerp(b[0], ex, sj), y = lerp(b[1], ey, sj);
      pos.push(x, y, 0.035 * pleat * L * sj * Math.cos(Math.PI * t * n));
      uv.push((x - sheet.xmin) / (sheet.xmax - sheet.xmin), (y + sheet.ymax) / (2 * sheet.ymax));
    }
  }
  for (let i = 0; i < NT; i++) {
    for (let j = 0; j < NS; j++) {
      const a = i * (NS + 1) + j, b = a + NS + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  // aErect: (base x, base y, angle when lowered, angle when fully raised) of an erectile spine and its
  // web, zero elsewhere (FISH_ERECT).
  g.setAttribute('aErect', new THREE.Float32BufferAttribute(er, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Tapered tube along a smooth path through d.pts (fish space): spines, free fin rays, tentacles.
// d: { pts, r0, r1, color, stripes?, nb? (bands), flat? (thickness across z / width), shape?: 'leaf' | 'frond', root? }.
// 'frond': a thin stalk opening into a flat blade whose two edges are scalloped out of step (the
// lionfish's supraocular tentacle).
// Bands are crisp: rings are doubled at each band boundary. Colours go in a vertex colour attribute.
export function tubeGeometry(d: TubeSpec, seg = DEFAULT_TUBE_SEGMENTS): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(d.pts.map((p) => new THREE.Vector3(...p)));
  const nb = d.nb || 0, ts: number[] = [];
  const rings = d.shape === 'frond' ? FROND_RINGS : TUBE_RINGS;
  for (let i = 0; i <= rings; i++) ts.push(i / rings);
  for (let q = 1; q < nb; q++) ts.push(q / nb - 1e-3, q / nb + 1e-3);
  ts.sort((a, b) => a - b);
  const ca = new THREE.Color(d.color), cb = new THREE.Color(d.stripes || d.color);
  const flat = d.flat ?? 1, pos: number[] = [], col: number[] = [], idx: number[] = [];
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), Z = new THREE.Vector3(0, 0, 1);
  for (const t of ts) {
    const p = curve.getPointAt(t);
    curve.getTangentAt(t, T);
    N.copy(Z).addScaledVector(T, -T.dot(Z));
    if (N.lengthSq() < 1e-6) N.set(0, 1, 0);
    N.normalize(); B.crossVectors(T, N);
    let r = d.shape === 'leaf' ? lerp(d.r0, d.r1, t) + d.r0 * 1.4 * Math.sin(Math.PI * t) ** 1.5 : lerp(d.r0, d.r1, t);
    if (d.root) { const k = Math.min(1, t / d.root); r *= 0.35 + 0.65 * k * k * (3 - 2 * k); }
    const blade = d.shape === 'frond' ? d.r0 * 3.2 * Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.2) / 0.8))) ** 0.8 : 0;
    const edge = (ph: number): number => r * (d.shape === 'frond' ? 0.55 : 1) + blade * (0.45 + 0.55 * Math.abs(Math.sin(Math.PI * (t * FROND_LOBES + ph))));
    const c = nb && Math.floor(t * nb) % 2 ? cb : ca;
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2, rk = blade ? edge(Math.sin(a) >= 0 ? 0 : 0.5) : r;
      pos.push(p.x + (N.x * flat * Math.cos(a) + B.x * Math.sin(a)) * rk, p.y + (N.y * flat * Math.cos(a) + B.y * Math.sin(a)) * rk, p.z + (N.z * flat * Math.cos(a) + B.z * Math.sin(a)) * rk);
      col.push(c.r, c.g, c.b);
    }
  }
  const R = ts.length;
  for (let i = 0; i < R - 1; i++) {
    for (let k = 0; k < seg; k++) {
      const a = i * seg + k, b = i * seg + ((k + 1) % seg);
      idx.push(a, b, a + seg, b, b + seg, a + seg);
    }
  }
  const tip = curve.getPointAt(1);
  pos.push(tip.x, tip.y, tip.z); col.push(...(nb && (nb - 1) % 2 ? cb : ca).toArray());
  for (let k = 0; k < seg; k++) idx.push((R - 1) * seg + k, (R - 1) * seg + ((k + 1) % seg), R * seg);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // On the lower jaw (d.jaw): swings down with it as the mouth opens (FISH_JAW).
  g.setAttribute('aJaw', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3).fill(d.jaw ? 1 : 0), 1));
  g.setAttribute('aJawG', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1));
  const er = new Float32Array((pos.length / 3) * 4);
  if (d.erect) for (let i = 0; i < er.length; i += 4) er.set(d.erect, i);
  g.setAttribute('aErect', new THREE.Float32BufferAttribute(er, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Paired appendages on the head and body (supraorbital tentacles, lappets), both sides:
// sp.appendages: [{ u, v (as the eye), len (TL), dir: [x, y, z out], r, flat, shape, color, stripes, nb, bend }].
export function appendageTubes(sp: Species, prof: Profile): TubeSpec[] {
  const out: TubeSpec[] = [], M = mouthOf(sp);
  for (const a of sp.appendages || []) {
    // Rooted on the lower jaw (below the gape, ahead of its corner): it moves with the jaw.
    const jaw = a.u < M.u && a.v > lerp(M.v0, M.v, a.u / M.u);
    for (const side of [1, -1]) {
      const x = prof.x(a.u), y = prof.centre(a.u) - a.v * prof.half(a.u);
      const z = side * flankZ(sp, prof, a.u, a.v);
      const d = new THREE.Vector3(a.dir[0], a.dir[1], side * a.dir[2]).normalize().multiplyScalar(a.len);
      const bend = a.bend ?? 0.15;
      // The base starts a quarter of the length inside the skin, so it grows out of it rather than
      // touching it at a point (a leaf-shaped lappet would otherwise sit on a thin stalk).
      const x0 = x - d.x * 0.25, y0 = y - d.y * 0.25, z0 = z - d.z * 0.25 - side * a.r;
      out.push({
        pts: [[x0, y0, z0], [x + d.x * 0.4 - bend * d.y * 0.4, y + d.y * 0.4 + bend * d.x * 0.4, z + d.z * 0.4], [x + d.x, y + d.y, z + d.z]],
        r0: a.r, r1: a.r * 0.15, flat: a.flat, shape: a.shape, color: a.color, stripes: a.stripes, nb: a.nb || 0, jaw,
      });
    }
  }
  return out;
}
