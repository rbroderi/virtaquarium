// Always-on reflexes, applied after the active behaviour has steered: personal space, critters, the
// glass, the reef ahead and the rock in 3D, and keeping to the middle of a shelter's gap.
import * as THREE from 'three';
import { clamp } from '../util.js';
import type { Brain } from '../brain.js';
import type { Fish } from '../fish.js';
import type { SwimWorld } from '../world/ports.js';

/** A rival's territory a twice-beaten fish keeps out of (radius). */
const TRUCE_RADIUS = 2.6;
const DEFEATS_FOR_TRUCE = 2;
/** Margin kept from the side glass, back glass, front glass and surface. */
const SIDE_MARGIN = 0.9;
const BACK_MARGIN = 0.5;
const FRONT_MARGIN = 0.4;
const TOP_MARGIN = 0.4;
/** The remembered reef top ahead sinks back this fast (units/s) once past it. */
const REEF_MEMORY_SINK = 0.6;
/** Fractions of the look-ahead reach sampled for the reef top. */
const LOOK_AHEAD = [0.33, 0.67, 1] as const;
const ROCK_PROBES = [0.5, 1] as const;
/** Room the eel wants from rock ahead (it threads gaps the others go round). */
const EEL_ROCK_ROOM = 0.4;

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _a = new THREE.Vector3(), _n = new THREE.Vector3();

/** Adds the reflexes to the heading the behaviour asked for (dir). */
export function applyReflexes(brain: Brain, me: Fish, world: SwimWorld, dt: number, dir: THREE.Vector3, clearance: number): void {
  // A lurking eel holds its crevice: other fish keep clear of it, and the reef ahead of the mouth is
  // open water it does not need to climb over.
  const anchored = brain.mode === 'lurk';
  keepTruce(brain, me, dir);
  if (!anchored) keepPersonalSpace(brain, me, world, dir);
  avoidGlass(me.pos, world, dir);
  if (keepInShelter(brain, me, dir)) return;
  avoidReef(brain, me, world, dt, dir, clearance, anchored);
}

/** Keep out of the territory of a fish that has beaten this one twice (it yields at the boundary). */
function keepTruce(brain: Brain, me: Fish, dir: THREE.Vector3): void {
  if (!brain.lostTo || brain.mode === 'feed' || brain.mode === 'pose') return;
  for (const [o, n] of brain.lostTo) {
    if (n < DEFEATS_FOR_TRUCE) continue;
    _a.subVectors(me.pos, o.brain.home);
    const d = _a.length(), R = TRUCE_RADIUS;
    if (d < R && d > 1e-3) dir.addScaledVector(_a, ((R - d) / R) * 1.2 / d);
  }
}

/** Other fish, and the critters (given a wide berth). A cleaner and its client touch on purpose. */
function keepPersonalSpace(brain: Brain, me: Fish, world: SwimWorld, dir: THREE.Vector3): void {
  const pos = me.pos;
  for (const o of world.fish) {
    if (o === me) continue;
    if ((brain.mode === 'clean' && o === brain.focus) || (brain.posing && o.sp.brain.cleaner)) continue;
    _v.subVectors(pos, o.pos);
    const dist = _v.length(), min = (me.size + o.size) * 0.45;
    if (dist < min && dist > 1e-4) dir.addScaledVector(_v, ((min - dist) / min) * 2.5 / dist);
  }
  for (const o of world.critters) {
    _v.subVectors(pos, o.pos);
    const dist = _v.length(), min = o.radius + me.size * 0.5;
    if (dist < min && dist > 1e-4) dir.addScaledVector(_v, ((min - dist) / min) * 3 / dist);
  }
}

function avoidGlass(pos: THREE.Vector3, world: SwimWorld, dir: THREE.Vector3): void {
  const B = world.bounds, m = SIDE_MARGIN;
  if (pos.x < B.x0 + m) dir.x += (B.x0 + m - pos.x) * 2;
  if (pos.x > B.x1 - m) dir.x -= (pos.x - B.x1 + m) * 2;
  if (pos.z < B.z0 + BACK_MARGIN) dir.z += (B.z0 + BACK_MARGIN - pos.z) * 3;
  if (pos.z > B.z1 - FRONT_MARGIN) dir.z -= (pos.z - B.z1 + FRONT_MARGIN) * 3;
  if (pos.y > B.y1 - TOP_MARGIN) dir.y -= (pos.y - B.y1 + TOP_MARGIN) * 3;
}

/**
 * In (or at the mouth of) its shelter, resting or hiding, the fish may be under the rock's top: it
 * keeps between the gap's floor and roof instead (fish.ts lets it below the height field too). With
 * hysteresis: once in, the fish counts as in until clearly out, or it flips between this and the reef
 * reflex at the edge and bobs. Returns true when sheltered (the reef reflex is then skipped).
 */
function keepInShelter(brain: Brain, me: Fish, dir: THREE.Vector3): boolean {
  const sh = brain.shelter, pos = me.pos;
  const was = brain.sheltered === sh, extra = was ? 0.8 : 0.4;
  brain.sheltered = sh && (brain.mode === 'rest' || brain.mode === 'flee') && pos.y < sh.top + (was ? 0.25 : 0)
    && Math.hypot(pos.x - sh.pos.x, (pos.z - sh.pos.z) * (sh.kind === 'ledge' ? 0.6 : 1)) < sh.r + extra ? sh : null;
  if (!brain.sheltered || !sh) return false;
  // Ease to the middle of the gap (hard limits either side made it bob between them).
  const mid = clamp(sh.pos.y, sh.floor + me.size * 0.15, sh.top - me.size * 0.25);
  dir.y = dir.y * 0.3 + (mid - pos.y) * 1.5;
  brain.reefSeen = undefined;
  return true;
}

/**
 * Look ahead for rock: the highest reef along the next second or so of travel, so a fish starts its
 * climb before a coral head rather than at its foot. Over branching coral the height field is bumpy
 * cell to cell, so the remembered top sinks back slowly and the fish glides level across instead of
 * bobbing into every gap. Then the rock in 3D (rockField.ts): rock on the path a moment ahead turns the
 * fish off it along the surface normal there, so it goes round a boulder's flank as readily as over it.
 */
function avoidReef(brain: Brain, me: Fish, world: SwimWorld, dt: number, dir: THREE.Vector3, clearance: number, anchored: boolean): void {
  const pos = me.pos;
  const reach = 0.3 + Math.max(0, me.speed) * 1.2, hd = Math.hypot(me.dir.x, me.dir.z) || 1;
  // A lurking eel's middle (pos) lies in the rock behind its cave (fish.ts inBurrow): what must stay
  // above the reef is its head, out of the mouth.
  const at = anchored && me.spine ? _w.copy(pos).addScaledVector(me.dir, 0.5 * me.size) : pos;
  let top = world.reefHeight(at.x, at.z);
  for (const k of LOOK_AHEAD) top = Math.max(top, world.reefHeight(at.x + (me.dir.x / hd) * reach * k, at.z + (me.dir.z / hd) * reach * k));
  const seen = brain.reefSeen ?? -Infinity;
  brain.reefSeen = top >= seen ? top : Math.max(top, seen - REEF_MEMORY_SINK * dt);
  const ahead = brain.reefSeen + clearance;
  const below = world.reefHeight(at.x, at.z) + clearance;
  if (at.y < below) dir.y += (below - at.y) * 4 + 0.5;
  else if (pos.y < ahead && !anchored) dir.y += (ahead - pos.y) * 1.5;
  if (anchored) return;
  if (!me.spine) {
    const want = me.size * 0.6 + clearance;
    for (const k of ROCK_PROBES) {
      _v.copy(pos).addScaledVector(me.dir, reach * k);
      const d = world.rockDist(_v);
      if (d < want) dir.addScaledVector(world.rockNormal(_v, _n), ((want - d) / want) * 2 / k);
    }
  } else {
    // The eel looks ahead from its head (pos is the middle of its body), and wants less room than a body
    // length. Not into its own burrow, which it backs into.
    for (const k of ROCK_PROBES) {
      _v.copy(pos).addScaledVector(me.dir, 0.5 * me.size + reach * k);
      if (me.inBurrow(_v)) continue;
      const d = world.rockDist(_v);
      if (d < EEL_ROCK_ROOM) dir.addScaledVector(world.rockNormal(_v, _n), ((EEL_ROCK_ROOM - d) / EEL_ROCK_ROOM) * 2 / k);
    }
  }
}
