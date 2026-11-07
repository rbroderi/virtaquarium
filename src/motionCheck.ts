// Motion checks, run on the tank page with ?check=motion (report in the console, in window.motionCheck,
// and POSTed to /__done for a headless run). The tank is stepped at 30 Hz for two simulated minutes
// without drawing, and for every fish it measures
//   - jumps: the fastest climb, in body lengths per second (a snap up a coral head shows as a spike);
//   - jitter: up-down reversals of over 2% of a body length that come within half a second of each
//     other (bobbing over branching coral);
// and for each eel, frames where a node of its body (with the head lift the shader adds) is inside a
// cave roof, and where a node of the body as drawn is inside the rock field (eelBodyInRock).
// It also samples shoal structure, shelter use and the cleaning station (checks/motionStats.ts).
// Also fish-fish body overlaps and fish against the drawn rock (checks/bodyContacts.ts; &truth=0 skips the latter).
// &probe=10,60: at those seconds, log the eel's chain nodes with the rock distance and the meshes there.
import { CAVE_RANGE } from './brain/caveClock.js';
import * as THREE from 'three';
import type { AquariumHandle } from './app/handle.js';
import type { Fish } from './fish.js';
import type { World } from './world.js';
import { postDone } from './checks/report.js';
import { FishOverlapTally, RockTruthTally } from './checks/bodyContacts.js';
import { CleaningTally, EelTally, ShoalSampler, spineNodes, type FishStats } from './checks/motionStats.js';

const STEPS_PER_SECOND = 30;
const DT = 1 / STEPS_PER_SECOND;
const DEFAULT_SECONDS = 120;
const SECONDS_PER_MINUTE = 60;
/** A reversal counts as jitter when the swing is over this share of a body length ... */
const JITTER_SWING = 0.02;
/** ... and comes within this many steps of the last one. */
const JITTER_STEPS = 15;
const VY_EPSILON = 1e-4;
/** A fish's centre this deep in rock (body lengths) counts as inside it. */
const IN_ROCK_DEPTH = 0.1;
/** Clownfish: deep in the host anemone means within this reach of its column axis ... */
const HOST_DEEP_RADIUS = 0.35;
/** ... and between this far below and above the disc centre (world units). */
const HOST_DEEP_BELOW = 0.3, HOST_DEEP_ABOVE = 0.5;
/** Near the host means within this distance of the anemone's centre. */
const HOST_NEAR = 2.5;
/** Fish that have lost to a rival this often keep a truce. */
const TRUCE_LOSSES = 2;
const PROBE_TEXT_LIMIT = 200;


/** Logs the eel's chain nodes with the rock distance and the meshes there. */
function probe(world: World): void {
  const eel = world.fish.find((f) => f.spine);
  const nodes = eel ? spineNodes(eel) : null;
  if (!eel || !nodes) return;
  console.log('PROBE lift', eel.model.uniforms.uLift.value.toFixed(2), 'pitch', eel.pitch.toFixed(2), 'hf at pos', world.reefHeight(eel.pos.x, eel.pos.z).toFixed(2));
  console.log('PROBE caves', JSON.stringify(world.reef.caves.map((c) => ({ x: c.x, z: c.z, yaw: c.yaw, ground: c.ground, mouth: c.mouth }))));
  console.log('PROBE eel', JSON.stringify({ pos: eel.pos, dir: eel.dir, home: eel.brain.home, mode: eel.brain.mode }));
  nodes.forEach((p, i) => {
    const hits: string[] = [];
    world.reef.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const b = new THREE.Box3().setFromObject(o);
      if (!b.containsPoint(p)) return;
      const path: string[] = [];
      for (let q: THREE.Object3D | null = o; q && q !== world.reef.group; q = q.parent) path.push(q.name || q.type);
      hits.push(path.join('<') + (o.userData['noHeight'] ? ' [noH]' : '') + (o.userData['solid'] ? ' [solid]' : ''));
    });
    console.log('PROBE node', i, p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2), 'd', world.rockDist(p).toFixed(2), 'hf', world.reefHeight(p.x, p.z).toFixed(2),
      'roof', JSON.stringify(world.roofAt(p.x, p.z)), hits.join(' | ').slice(0, PROBE_TEXT_LIMIT));
  });
}

/** Climb and jitter for one fish this step. */
function trackClimb(s: FishStats, n: number, y = s.f.pos.y): void {
  const f = s.f, L = f.size, vy = (y - s.y) / DT;
  s.rise = Math.max(s.rise, vy / L);
  // A reversal: the climb changes sign. Count it when the swing since the last one is big and quick.
  if (Math.sign(vy) !== Math.sign(s.vy) && Math.abs(vy) > VY_EPSILON) {
    if (s.ext && Math.abs(y - s.ext.y) > JITTER_SWING * L && n - s.ext.n < JITTER_STEPS) {
      s.jitter++;
      const why = f.brain.mode + (f.brain.sheltered ? '/sheltered' : '') + (f.brain.crowding > 0 ? '/crowded' : '');
      (s.jitterBy ??= {})[why] = (s.jitterBy[why] ?? 0) + 1;
    }
    s.ext = { y, n };
  }
  s.y = y;
  s.vy = vy;
}

export async function main(aq: AquariumHandle): Promise<void> {
  const { world } = aq;
  const qs = new URLSearchParams(location.search);
  const frames = STEPS_PER_SECOND * Number(qs.get('seconds') ?? DEFAULT_SECONDS);
  const stats: FishStats[] = world.fish.map((f) => ({ f, y: f.pos.y, vy: 0, ext: null, rise: 0, jitter: 0, inRock: 0, last: f.pos.clone(), maxStep: 0 }));
  // The same wobble count on the drawn position (Fish.present smooths the collision pushes).
  const drawn: FishStats[] = world.fish.map((f) => ({ f, y: f.pos.y, vy: 0, ext: null, rise: 0, jitter: 0, inRock: 0, last: f.pos.clone(), maxStep: 0 }));
  const eels = new Map(world.fish.filter((f) => f.spine).map((f) => [f, new EelTally()] as const));
  // Clownfish hosting: how much of the run each spends deep in the tentacles, near the host, and in
  // the host behaviour (so a change to its weight can be checked against how it actually swims).
  const hostAn = world.reef.anemones[0] ?? null;
  const hostFish = hostAn ? world.fish.filter((f) => f.sp.brain.host) : [];
  const hostTallies = new Map(hostFish.map((f) => [f, { deep: 0, near: 0, mode: 0 }]));
  const cleaning = world.station ? new CleaningTally(world.station) : null;
  const shoals = new ShoalSampler(world.fish);
  const overlaps = new FishOverlapTally(world.fish);
  const truth = qs.get('truth') === '0' ? null : new RockTruthTally(world);
  if (qs.get('night') === '1') aq.setLight(0);
  if (qs.has('light')) aq.setLight(Number(qs.get('light')));   // e.g. 0.35: dusk, when lionfish hunt
  const probeAt = (qs.get('probe') || '').split(',').filter(Boolean).map((s) => Math.round(Number(s) * STEPS_PER_SECOND));

  let updateMs = 0;
  const lurkFrames = new Map<Fish, number>();
  for (let n = 0; n < frames; n++) {
    if (probeAt.includes(n)) { console.log('PROBE t', n / STEPS_PER_SECOND); probe(world); }
    if (n % STEPS_PER_SECOND === 0) shoals.sample(world.fish);
    const t0 = performance.now();
    world.update(DT);
    updateMs += performance.now() - t0;
    for (const c of aq.critters) c.update(DT, world);
    if (hostAn) for (const f of hostFish) {
      const tally = hostTallies.get(f);
      if (!tally) continue;
      const flat = Math.hypot(f.pos.x - hostAn.pos.x, f.pos.z - hostAn.pos.z);
      if (flat < HOST_DEEP_RADIUS && f.pos.y > hostAn.pos.y - HOST_DEEP_BELOW && f.pos.y < hostAn.pos.y + HOST_DEEP_ABOVE) tally.deep++;
      if (f.pos.distanceTo(hostAn.pos) < HOST_NEAR) tally.near++;
      if (f.brain.mode === 'host') tally.mode++;
    }
    cleaning?.step(DT);
    overlaps.step();
    truth?.step(world);
    for (const s of drawn) trackClimb(s, n, s.f.model.position.y);
    for (const s of stats) {
      trackClimb(s, n);
      const f = s.f;
      // The largest step, as a speed: a jump shows as a spike well over the species' burst speed.
      s.maxStep = Math.max(s.maxStep, f.pos.distanceTo(s.last) / DT / f.size);
      s.last.copy(f.pos);
      if (!f.spine && world.rockDist(f.pos) < -IN_ROCK_DEPTH * f.size) s.inRock++;
      eels.get(f)?.step(f, world);
      if (f.spine && f.brain.mode === 'lurk' && f.pos.distanceTo(f.brain.home) < CAVE_RANGE) lurkFrames.set(f, (lurkFrames.get(f) ?? 0) + 1);
    }
  }

  const minutes = (frames * DT) / SECONDS_PER_MINUTE;
  const rows = stats.map((s) => {
    const eel = eels.get(s.f);
    return {
      fish: s.f.name || s.f.sp.id, species: s.f.sp.id, riseBLs: +s.rise.toFixed(2), jitterPerMin: +(s.jitter / minutes).toFixed(1), jitterBy: s.jitterBy, inRockFrames: s.inRock,
      maxStepBLs: +s.maxStep.toFixed(2), burstBLs: s.f.sp.swim.burstBL, limitedSteps: s.f.limitedSteps,
      ...(eel ? eel.row() : {}),
    };
  });
  const perMinute = (count: (f: Fish) => number): number => +(world.fish.reduce((a, f) => a + count(f), 0) / minutes).toFixed(1);
  const eelRows = [...eels.values()];
  const sum = {
    fish: rows.length,
    maxRiseBLs: Math.max(...rows.map((r) => r.riseBLs)),
    meanJitterPerMin: +(rows.reduce((a, r) => a + r.jitterPerMin, 0) / rows.length).toFixed(2),
    // The same on the drawn position, which is what shows.
    drawnJitterPerMin: +(drawn.reduce((a, s) => a + s.jitter, 0) / drawn.length / minutes).toFixed(2),
    inRockFrames: rows.reduce((a, r) => a + r.inRockFrames, 0),
    // Fastest step relative to the fish's burst speed (over 1 means it moved faster than it can swim),
    // and the steps the global step limit cut short.
    maxStepOverBurst: Math.max(...rows.map((r) => r.maxStepBLs / r.burstBLs)),
    limitedSteps: rows.reduce((a, r) => a + r.limitedSteps, 0),
    eelRoofFrames: eelRows.map((e) => e.roof),
    // Share of frames each eel spent lurking in its cave (target 0.9 by day, 0.6 at night: brain/caveClock.ts).
    eelCaveShare: [...eels.keys()].map((f) => +((lurkFrames.get(f) ?? 0) / frames).toFixed(2)),
    // Eel body nodes inside the rock field (any node > 0.08 deep), of all frames.
    eelBodyInRock: eelRows.map((e) => e.summary()),
    // Fish bodies (axis + elliptical section) into each other, cleaner and client excepted.
    // Mean wall time of one world step (fish, brains, collision), ms: compare runs interleaved.
    updateMs: +(updateMs / frames).toFixed(3),
    fishOverlap: overlaps.summary(minutes),
    // Snout, middle and peduncle against the rock as drawn (BVH), and the field's error there.
    rockTruth: truth?.summary() ?? null,
    // Fear passed on by a neighbour's flight (brain _perceive), per simulated minute.
    contagionPerMin: perMinute((f) => f.brain.contagions),
    firstHandPerMin: perMinute((f) => f.brain.firstHand),
    shoals: shoals.summary(),
    shelteredShare: shoals.shelteredShare(),
    // Clownfish hosting, per fish, as a share of the run frames: deep among the tentacles, near the
    // host, and in the host behaviour (target roughly a quarter deep, most of it near; host.ts).
    hostStay: [...hostTallies].map(([f, t]) => ({
      fish: f.name || f.sp.id, deep: +(t.deep / frames).toFixed(2), near: +(t.near / frames).toFixed(2), host: +(t.mode / frames).toFixed(2),
    })),
    lionfishStrikes: world.fish.reduce((a, f) => a + f.brain.strikes, 0),
    truces: world.fish.reduce((a, f) => a + [...(f.brain.lostTo?.values() ?? [])].filter((k) => k >= TRUCE_LOSSES).length, 0),
    ...(cleaning ? { cleaning: cleaning.summary() } : {}),
  };
  Reflect.set(window, 'motionCheck', { sum, rows });   // debugging hook, as the JS build exposed it
  console.table(rows);
  console.log('motion check', sum);
  await postDone(JSON.stringify({ sum, rows }));
}
