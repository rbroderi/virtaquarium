// Shape checks for the critters, run on the tank page with ?check=critters (report in the console, on
// screen and in window.critterCheck). Each critter is voxelised as it stands, over a run of frames
// of its own behaviour and in its extreme poses (a jet, a strike), and must be
//   - one piece: its parts, taken together, form a single connected solid (nothing floats loose);
//   - water tight: filled as a container, the water fills the whole animal. A part's inside must be
//     closed off from the outside by the parts round it, so the inside of a part sits sealed under
//     its skin (a gap where two parts were meant to meet lets the outside in);
//   - free of clipping: no part runs into another, except at the joints the critter lists as
//     attachments (critter.joins, [partA, partB] by mesh name, 'arm*' matching any 'arm...').
// Parts are the critter's meshes; a double-sided mesh is a sheet (a fin skirt, a web): it has no
// inside of its own, but must still join the body and not cut through another part.
import * as THREE from 'three';
import type { AquariumHandle } from './app/handle.js';
import type { Critter, JoinRule } from './critters.js';
import { cellAt, cellIndex, cellOf, flood, surfaceCells, type Cell3, type VoxelGrid } from './checks/voxel.js';

/** Voxels along the critter's longest side. */
const RES = 180;
/** Grid margin around the critter's box, in cells (before and after). */
const GRID_MARGIN_BEFORE = 2, GRID_PAD = 5;
/** Pieces and clips of this many voxels or fewer are grid noise. */
const NOISE_VOXELS = 2;
/** Skin points sampled per part (about). */
const SKIN_SAMPLES = 600;
/** Probe depth under the skin, in cells, and how far a part counts as thin. */
const UNDER_SKIN_CELLS = 1.2, THIN_CELLS = 3;
/** A real leak wets most of a part's skin; a few wet points are the grid's aliasing at thin edges. */
const LEAK_SHARE = 0.15;
const SKIN_EPSILON = 1e-4;
const STEP_DT = 1 / 30;
const DEFAULT_SECONDS = 12, DEFAULT_EVERY = 1.5, MODE_SECONDS = 6;
/** A forced mode holds this long (s). */
const HOLD_MODE = 1e3;
const JET_FRAMES = 36, JET_CHECK_EVERY = 6;
const STRIKE_POSES = [0.3, 0.2, 0.1] as const;
const JET_FROM = new THREE.Vector3(1, 0, 0.5);
const REPORT_FAILS_SHOWN = 6;

interface Part {
  readonly mesh: THREE.Mesh;
  readonly name: string;
  readonly sheet: boolean;
  surf: Uint32Array;
  inside: Uint32Array;
}

export interface Leak { part: string; wet: number }
export interface Clip { pair: string; voxels: number }
export interface ShapeResult { pieces: number; loose: string[]; leaks: Leak[]; clips: Clip[]; voxel: number }

/** The last check's parts and grid, for poking at a failure in the console. */
export const shapeDebug: { last: { parts: readonly Part[]; grid: VoxelGrid } | null } = { last: null };

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _p = new THREE.Vector3(), _n = new THREE.Vector3();

function isSheet(mesh: THREE.Mesh): boolean {
  const material: unknown = mesh.material;
  return (material instanceof THREE.Material && material.side === THREE.DoubleSide) || !!mesh.userData['sheet'];
}

function partsOf(model: THREE.Object3D): Part[] {
  const parts: Part[] = [];
  model.updateMatrixWorld(true);
  model.traverseVisible((o) => {
    if (!(o instanceof THREE.Mesh) || !o.geometry.getAttribute('position')) return;
    // vertices the shader builds (the octopus's arms) are written out for the check
    const sync: unknown = o.userData['syncGeometry'];
    if (typeof sync === 'function') sync();
    o.geometry.computeBoundingBox();   // arms and skirts are rebuilt each frame: a cached box is stale
    parts.push({ mesh: o, name: o.name || 'unnamed', sheet: isSheet(o), surf: new Uint32Array(0), inside: new Uint32Array(0) });
  });
  return parts;
}

const matches = (pat: string, name: string): boolean => (pat.endsWith('*') ? name.startsWith(pat.slice(0, -1)) : name === pat);
const joined = (joins: readonly JoinRule[], a: string, b: string): boolean =>
  joins.some(([p, q]) => (matches(p, a) && matches(q, b)) || (matches(p, b) && matches(q, a)));

function makeGrid(parts: readonly Part[]): VoxelGrid {
  const box = new THREE.Box3();
  for (const P of parts) box.expandByObject(P.mesh);
  const size = box.getSize(new THREE.Vector3()), h = Math.max(size.x, size.y, size.z) / RES;
  return {
    o: box.min.clone().subScalar(GRID_MARGIN_BEFORE * h), h,
    nx: Math.ceil(size.x / h) + GRID_PAD, ny: Math.ceil(size.y / h) + GRID_PAD, nz: Math.ceil(size.z / h) + GRID_PAD,
  };
}

/** 26-connected pieces of the solid (everything the water can't reach): a piece id per cell, and sizes. */
function solidPieces(grid: VoxelGrid, water: Uint8Array): { comp: Int32Array; sizes: number[] } {
  const { nx, ny, nz } = grid, N = water.length;
  const comp = new Int32Array(N).fill(-1), sizes: number[] = [], q = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (water[s] || (comp[s] ?? 0) >= 0) continue;
    const id = sizes.length;
    let qn = 0;
    comp[s] = id; q[qn++] = s;
    for (let qi = 0; qi < qn; qi++) {
      const [x, y, z] = cellOf(grid, q[qi] ?? 0);
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
        const k = X + nx * (Y + ny * Z);
        if (!water[k] && (comp[k] ?? 0) < 0) { comp[k] = id; q[qn++] = k; }
      }
    }
    sizes.push(qn);
  }
  return { comp, sizes };
}

/** Points just under each part's skin must be sealed from the water (where the part is thick enough). */
function findLeaks(parts: readonly Part[], grid: VoxelGrid, water: Uint8Array): Leak[] {
  const leaks: Leak[] = [], ray = new THREE.Raycaster(), both = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  for (const P of parts) {
    if (P.sheet) continue;
    const g = P.mesh.geometry, pos = g.getAttribute('position'), nor = g.getAttribute('normal');
    if (!nor) continue;
    const nm = new THREE.Matrix3().getNormalMatrix(P.mesh.matrixWorld), step = Math.max(1, Math.floor(pos.count / SKIN_SAMPLES));
    const material = P.mesh.material;
    P.mesh.material = both;
    let n = 0, wet = 0;
    for (let i = 0; i < pos.count; i += step) {
      _p.fromBufferAttribute(pos, i).applyMatrix4(P.mesh.matrixWorld);
      _n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      ray.set(_a.copy(_p).addScaledVector(_n, -SKIN_EPSILON), _b.copy(_n).negate());
      ray.far = THIN_CELLS * grid.h;
      if (ray.intersectObject(P.mesh, false).length) continue;
      _p.addScaledVector(_n, -UNDER_SKIN_CELLS * grid.h);
      n++;
      if (water[cellAt(grid, _p)]) wet++;
    }
    P.mesh.material = material;
    if (n && wet / n > LEAK_SHARE) leaks.push({ part: P.name, wet: +(wet / n).toFixed(3) });
  }
  return leaks;
}

/** Each part's own inside: flooded round its own surface alone, within its own box. */
function computeInsides(parts: readonly Part[], grid: VoxelGrid, N: number): void {
  for (const P of parts) {
    if (P.sheet) { P.inside = new Uint32Array(0); continue; }
    const lo: Cell3 = [Infinity, Infinity, Infinity], hi: Cell3 = [0, 0, 0];
    for (const k of P.surf) {
      const c = cellOf(grid, k);
      for (let d = 0; d < 3; d++) {
        lo[d] = Math.min(lo[d] ?? Infinity, (c[d] ?? 0) - 1);
        hi[d] = Math.max(hi[d] ?? 0, (c[d] ?? 0) + 2);
      }
    }
    const own = new Uint8Array(N);
    for (const k of P.surf) own[k] = 1;
    const wet = flood(grid, own, lo, hi), ins: number[] = [];
    for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) {
      const k = cellIndex(grid, x, y, z);
      if (!wet[k] && !own[k]) ins.push(k);
    }
    P.inside = Uint32Array.from(ins);
  }
}

/**
 * Two parts clip where the skin of one runs inside the other, unless that is hidden inside a third
 * (arms crossing inside the head they grow from). Only A's inside deeper than a cell under its skin
 * counts: nearer, the grid can't tell a clip from two skins just apart.
 */
function findClips(parts: readonly Part[], grid: VoxelGrid, joins: readonly JoinRule[], N: number): Clip[] {
  const { nx, ny } = grid;
  const mark = new Int32Array(N).fill(-1), skin = new Int32Array(N).fill(-1), within = new Uint8Array(N), clip = new Map<string, number>();
  for (const P of parts) for (const k of P.inside) within[k] = (within[k] ?? 0) + 1;
  const D = [1, -1, nx, -nx, nx * ny, -nx * ny];
  parts.forEach((A, i) => {
    for (const k of A.surf) skin[k] = i;
    for (const k of A.inside) if (D.every((d) => skin[k + d] !== i)) mark[k] = i;
    parts.forEach((B, j) => {
      if (j === i || joined(joins, A.name, B.name)) return;
      let n = 0;
      for (const k of B.surf) if (mark[k] === i && within[k] === 1) n++;
      const key = i < j ? `${A.name}/${B.name}` : `${B.name}/${A.name}`;
      if (n > NOISE_VOXELS) clip.set(key, Math.max(n, clip.get(key) || 0));
    });
  });
  return [...clip].map(([pair, voxels]) => ({ pair, voxels }));
}

/** One check of a critter as it stands now. */
export function checkShape(critter: Pick<Critter, 'model' | 'joins'>): ShapeResult {
  const parts = partsOf(critter.model), joins = critter.joins;
  const grid = makeGrid(parts), N = grid.nx * grid.ny * grid.nz;
  for (const P of parts) P.surf = surfaceCells(P.mesh, grid);

  // The whole animal: the water flooded in round every part; what it can't reach is the animal.
  const wall = new Uint8Array(N);
  for (const P of parts) for (const k of P.surf) wall[k] = 1;
  const water = flood(grid, wall, [0, 0, 0], [grid.nx, grid.ny, grid.nz]);

  const { comp, sizes } = solidPieces(grid, water);
  const main = sizes.indexOf(Math.max(...sizes));
  // Every part with skin in a piece other than the main one (a gap cuts it off, or it floats).
  const loose = parts.filter((P) => {
    for (const k of P.surf) {
      const c = comp[k] ?? -1;
      if (c !== main && (sizes[c] ?? 0) > NOISE_VOXELS) return true;
    }
    return false;
  }).map((P) => P.name);

  const leaks = findLeaks(parts, grid, water);
  computeInsides(parts, grid, N);
  const clips = findClips(parts, grid, joins, N);
  shapeDebug.last = { parts, grid };
  return { pieces: sizes.filter((s) => s > NOISE_VOXELS).length, loose, leaks, clips, voxel: +grid.h.toFixed(4) };
}

const ok = (r: ShapeResult): boolean => r.pieces === 1 && !r.loose.length && !r.leaks.length && !r.clips.length;

export interface Fail extends ShapeResult { at: string }
export interface CritterReport { critter: string; checks: number; fails: Fail[] }

const nextTask = (): Promise<void> => new Promise((r) => setTimeout(r));

async function checkCritter(c: Critter, aq: AquariumHandle, seconds: number, every: number): Promise<CritterReport> {
  const { world } = aq, fails: Fail[] = [];
  let checks = 0;
  const check = (label: string): void => {
    checks++;
    const r = checkShape(c);
    if (!ok(r)) fails.push({ at: label, ...r });
  };
  const run = async (label: string, secs: number): Promise<void> => {
    for (let t = 0, next = every; t < secs; t += STEP_DT) {
      c.update(STEP_DT, world);
      if (t >= next) { check(`${label} ${t.toFixed(1)}s`); next += every; await nextTask(); }
    }
  };
  await run('as is', seconds);
  for (const [mode, go] of c.checkVisits) {
    c.mode = mode; c.modeT = HOLD_MODE;
    c.target = go ? c.pos.clone().add(new THREE.Vector3(...go)) : c.pos.clone();
    await run(mode, MODE_SECONDS);
  }
  c.modeT = 0;
  // Extreme poses: a jet (its own start: a jet out of a den goes out of its mouth), and the tentacles
  // shot out through a strike.
  if (c.startle) {
    c.startle(world, c.pos.clone().add(JET_FROM));
    for (let i = 1; i <= JET_FRAMES; i++) { c.update(STEP_DT, world); if (i % JET_CHECK_EVERY === 0) check(`jet +${i}`); }
  }
  if (c.forceStrike) for (const s of STRIKE_POSES) { c.forceStrike(s + STEP_DT); c.update(STEP_DT, world); check(`strike ${s}`); }
  const critter = c.displayName;
  console.log(`critter check: ${critter} done, ${fails.length} failed`);
  return { critter, checks, fails };
}

/** Runs every critter in the tank through its behaviours and its extreme poses, checking as it goes. */
export async function runCritterChecks(aq: AquariumHandle, { seconds = DEFAULT_SECONDS, every = DEFAULT_EVERY } = {}): Promise<CritterReport[]> {
  const report: CritterReport[] = [];
  for (const c of aq.critters) report.push(await checkCritter(c, aq, seconds, every));
  return report;
}

function reportLines(report: readonly CritterReport[]): string[] {
  return report.map((r) => `${r.fails.length ? 'FAIL' : 'ok  '} ${r.critter}: ${r.fails.length} of ${r.checks} checks failed` +
    r.fails.slice(0, REPORT_FAILS_SHOWN).map((f) => `\n     ${f.at}: pieces ${f.pieces}` + (f.loose.length ? `, loose ${f.loose.join(' ')}` : '') +
      (f.leaks.length ? `, leaks ${f.leaks.map((l) => `${l.part} ${l.wet}`).join(' ')}` : '') +
      (f.clips.length ? `, clips ${f.clips.map((x) => `${x.pair} ${x.voxels}`).join(' ')}` : '')).join(''));
}

/** The ?check=critters entry point: run, then print the report. */
export async function main(aq: AquariumHandle): Promise<void> {
  const report = await runCritterChecks(aq);
  Reflect.set(window, 'critterCheck', report);   // debugging hook, as the JS build exposed it
  const lines = reportLines(report);
  console.log('critter shape check\n' + lines.join('\n'));
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;left:8px;top:8px;z-index:20;margin:0;padding:8px;background:#000c;color:#fff;font:12px monospace;max-width:96vw;white-space:pre-wrap';
  pre.textContent = lines.join('\n');
  document.body.appendChild(pre);
}
