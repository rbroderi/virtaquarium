// Tallies for the motion check (motionCheck.ts): per-eel roof and rock clipping, shoal structure and
// shelter use, and cleaning-station sessions.
import * as THREE from 'three';
import type { Fish } from '../fish.js';
import type { World, Station } from '../world.js';
import type { Species } from '../species.js';

export interface FishStats {
  readonly f: Fish;
  y: number;
  vy: number;
  ext: { y: number; n: number } | null;
  rise: number;
  jitter: number;
  /** The wobbles by what the fish was doing (mode, /sheltered, /crowded). */
  jitterBy?: Record<string, number>;
  inRock: number;
  /** Position at the previous step, and the largest step taken, as a speed in body lengths per second. */
  readonly last: THREE.Vector3;
  maxStep: number;
}

/** The eel's body as drawn (head first, world space, with the head lift): its path's stations. */
export function spineNodes(f: Fish): readonly THREE.Vector3[] | null {
  return f.spine ? f.spine.nodes : null;
}

// The eel's burrow (as fish inBurrow, repeated here so the measure doesn't depend on the code it checks).
const BURROW_AHEAD = 0.25, BURROW_BEHIND = 0.55, BURROW_RADIUS = 0.35;
/** A node in the roof band: from this share of a body length under the roof's underside. */
const ROOF_TOLERANCE = 0.02;
/** A node more than a voxel of the rock field inside solid scenery is clipping. */
const VOXEL = 0.08;

function inBurrow(f: Fish, p: THREE.Vector3): boolean {
  const b = f.brain, L = f.size, D = b.lurkDir;
  if (!D) return false;
  const dx = p.x - b.home.x, dy = p.y - b.home.y, dz = p.z - b.home.z;
  const s = Math.min(BURROW_AHEAD * L, Math.max(-BURROW_BEHIND * L, dx * D.x + dy * D.y + dz * D.z));
  return (dx - D.x * s) ** 2 + (dy - D.y * s) ** 2 + (dz - D.z * s) ** 2 < BURROW_RADIUS * BURROW_RADIUS;
}

/** Per-eel counts of roof hits and body nodes in rock. */
export class EelTally {
  roof = 0;
  private bodyFrames = 0;
  private bodyIn = 0;
  private bodyDeep = 0;
  private bodyIdx: number[] = [];
  private readonly bodyModes: Record<string, number> = {};
  private burrowIn = 0;
  private burrowShallow = 0;
  private readonly node = new THREE.Vector3();

  step(f: Fish, world: World): void {
    const nodes = spineNodes(f);
    if (!nodes) return;
    const L = f.size;
    this.roof += nodes.some((p) => {
      const r = world.roofAt(p.x, p.z);
      return r && p.y > r.y - ROOF_TOLERANCE * L && p.y < r.top;
    }) ? 1 : 0;
    this.stepBody(f, world, nodes);
  }

  /**
   * The whole body in the rock field, where the shader draws it: each midline station of the path (as
   * written to uPath, read back through the model's frame). Nodes in the eel's burrow (the crevice behind
   * its cave, meant to be out of sight in the rock) are counted apart, with how many are shallow enough
   * to show through the surface.
   */
  private stepBody(f: Fish, world: World, nodes: readonly THREE.Vector3[]): void {
    const path = f.model.uniforms.uPath.value, P = this.node, N = nodes.length;
    f.model.updateMatrixWorld();
    let clipped = false;
    for (let i = 0; i < N; i++) {
      f.model.localToWorld(P.set(path[3 * i] ?? 0, path[3 * i + 1] ?? 0, path[3 * i + 2] ?? 0));
      const d = world.rockDist(P);
      if (inBurrow(f, P)) {
        if (d < 0) {
          this.burrowIn++;
          if (d > -VOXEL) this.burrowShallow++;
        }
        continue;
      }
      if (d < -VOXEL) {
        clipped = true;
        this.bodyIn++;
        this.bodyDeep = Math.max(this.bodyDeep, -d);
        if (!this.bodyIdx.length) this.bodyIdx = new Array<number>(N).fill(0);
        this.bodyIdx[i] = (this.bodyIdx[i] ?? 0) + 1;
      }
    }
    if (clipped) {
      this.bodyFrames++;
      this.bodyModes[f.brain.mode] = (this.bodyModes[f.brain.mode] ?? 0) + 1;
    }
  }

  row(): Record<string, unknown> {
    return {
      roofFrames: this.roof, bodyInRockFrames: this.bodyFrames, bodyInRockNodes: this.bodyIn, bodyDeepest: +this.bodyDeep.toFixed(2),
      bodyInRockModes: this.bodyModes, bodyInRockByNode: this.bodyIdx, burrowNodesInRock: this.burrowIn, burrowNodesShallow: this.burrowShallow,
    };
  }

  summary(): Record<string, unknown> {
    return {
      frames: this.bodyFrames, nodes: this.bodyIn, deepest: +this.bodyDeep.toFixed(2), modes: this.bodyModes,
      byNode: this.bodyIdx.join(' '), burrowIn: this.burrowIn, burrowShallow: this.burrowShallow,
    };
  }
}

/** Shoaling species need this much schooling drive, and this many fish, to be measured. */
const SHOAL_SCHOOL = 0.8, SHOAL_MIN_FISH = 4;
/** Fish within this many body lengths of each other count as one group. */
const GROUP_REACH = 2.5;

interface Shoal {
  readonly sp: Species;
  readonly fish: readonly Fish[];
  readonly nnd: number[];
  readonly pol: number[];
  readonly groups: number[];
}

const median = (a: readonly number[]): number => +(a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0).toFixed(2);

/**
 * Shoal structure, sampled once a second for each shoaling species with 4+ fish: median nearest-
 * neighbour distance (body lengths), polarisation (|mean heading|, 1 = all aligned), and the number of
 * subgroups. And the share of fish that are in their shelter.
 */
export class ShoalSampler {
  private readonly shoals: Shoal[];
  private shelteredSum = 0;
  private samples = 0;

  constructor(fish: readonly Fish[]) {
    this.shoals = [...new Set(fish.filter((f) => f.sp.brain.school >= SHOAL_SCHOOL).map((f) => f.sp))]
      .map((sp) => ({ sp, fish: fish.filter((f) => f.sp === sp), nnd: [], pol: [], groups: [] }))
      .filter((s) => s.fish.length >= SHOAL_MIN_FISH);
  }

  sample(all: readonly Fish[]): void {
    this.samples++;
    this.shelteredSum += all.filter((f) => f.brain.sheltered).length / all.length;
    for (const s of this.shoals) this.sampleShoal(s);
  }

  private sampleShoal(s: Shoal): void {
    const F = s.fish, L = F.reduce((a, f) => a + f.size, 0) / F.length;
    const nn = F.map((f) => Math.min(...F.filter((o) => o !== f).map((o) => o.pos.distanceTo(f.pos)))).sort((a, b) => a - b);
    s.nnd.push((nn[Math.floor(nn.length / 2)] ?? 0) / L);
    const heading = F.reduce((v, f) => v.add(f.dir), new THREE.Vector3());
    s.pol.push(heading.length() / F.length);
    s.groups.push(countGroups(F, GROUP_REACH * L));
  }

  summary(): { species: string; nndBL: number; polarisation: number; groupsMin: number; groupsMax: number }[] {
    return this.shoals.map((s) => ({
      species: s.sp.id, nndBL: median(s.nnd), polarisation: median(s.pol), groupsMin: Math.min(...s.groups), groupsMax: Math.max(...s.groups),
    }));
  }

  shelteredShare(): number {
    return +(this.shelteredSum / Math.max(1, this.samples)).toFixed(2);
  }
}

/** Connected groups of fish, linking any two closer than reach. */
function countGroups(F: readonly Fish[], reach: number): number {
  const group = new Array<number>(F.length).fill(-1);
  let g = 0;
  for (let i = 0; i < F.length; i++) {
    if ((group[i] ?? 0) >= 0) continue;
    const stack = [i];
    group[i] = g;
    while (stack.length) {
      const k = stack.pop() ?? 0, from = F[k];
      if (!from) continue;
      F.forEach((o, j) => {
        if ((group[j] ?? 0) < 0 && o.pos.distanceTo(from.pos) < reach) { group[j] = g; stack.push(j); }
      });
    }
    g++;
  }
  return g;
}

/**
 * Cleaning station: sessions (a client starts posing with the cleaner working on it), seconds of
 * cleaning, which clients came, and how many jolted away (the cleaner cheated or something scared them).
 */
export class CleaningTally {
  private sessions = 0;
  private seconds = 0;
  private readonly clients = new Set<string>();
  private jolts = 0;
  private was: Fish | null = null;

  constructor(private readonly station: Station) {}

  step(dt: number): void {
    const st = this.station, c = st.client;
    const on = c && c.brain.posing && st.cleaner?.brain.focus === c ? c : null;
    if (on && on !== this.was) { this.sessions++; this.clients.add(on.sp.id); }
    if (this.was && !on && this.was.brain.mode === 'flee') this.jolts++;
    if (on) this.seconds += dt;
    this.was = on;
  }

  summary(): { sessions: number; seconds: number; clients: string[]; jolts: number } {
    return { sessions: this.sessions, seconds: +this.seconds.toFixed(0), clients: [...this.clients], jolts: this.jolts };
  }
}
