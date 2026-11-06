// School: each fish follows local rules on its nearest few shoalmates (Herbert-Read et al. 2011, Katz
// et al. 2011): repulsion inside ~0.6 body lengths, attraction beyond ~1.5, matching the speed of those
// ahead, and only weak alignment. There is no shared goal: the shoal splits round a coral head and
// re-forms behind it on its own. It is held loosely to its home coral, over which chromis hover in a
// loose column (Fishelson et al. 1974), drifting about it.
import * as THREE from 'three';
import { clamp, range } from '../../util.js';
import type { Behaviour } from '../behaviour.js';

/** Inside this many body lengths shoalmates push apart; beyond ATTRACT they pull together. */
const REPEL_BL = 0.6;
const ATTRACT_BL = 1.5;
/** Schooling at least this strong shares the reef's shoal coral as home. */
const SHOAL_CORAL_SCHOOLING = 0.8;

const _sep = new THREE.Vector3(), _align = new THREE.Vector3(), _rel = new THREE.Vector3();

export const school: Behaviour = {
  mode: 'school',

  score: ({ brain, species: sp, personality: t, drives: d }) =>
    sp.school > 0 && brain.neighbors.length ? t.sociability * (0.5 + 0.6 * d.social) : 0,

  steer({ brain, me, world, dir, pos, species: sp, pace, out }) {
    const L = me.size;
    let ahead = 0, aheadSpeed = 0;
    _sep.set(0, 0, 0); _align.set(0, 0, 0);
    for (const n of brain.neighbors) {
      _rel.subVectors(n.pos, pos);
      const d = _rel.length() || 1e-3, dBL = d / L;
      if (dBL < REPEL_BL) _sep.addScaledVector(_rel, -(REPEL_BL - dBL) * 3 / d);
      else if (dBL > ATTRACT_BL) _sep.addScaledVector(_rel, Math.min(1, (dBL - ATTRACT_BL) * 0.4) / d);
      _align.add(n.dir);
      if (_rel.dot(me.dir) > 0) { ahead++; aheadSpeed += Math.max(0, n.speed); }
    }
    dir.copy(me.dir).multiplyScalar(0.8).add(_sep).addScaledVector(_align, 0.3 / Math.max(1, brain.neighbors.length));
    // Home: drift round it; pulled back harder the further the shoal strays.
    if (brain.targetTimer <= 0) {
      const coral = world.reef.shoalCoral;
      const c = coral && sp.school >= SHOAL_CORAL_SCHOOLING ? coral.pos : brain.home;
      brain.target.set(c.x + range(brain.rng, -2.2, 2.2), c.y + range(brain.rng, 0.3, 2.0), c.z + range(brain.rng, -0.8, 1.2));
      brain.target.y = Math.min(brain.target.y, world.bounds.y1 - 0.6);
      brain.targetTimer = range(brain.rng, 4, 9);
    }
    _rel.subVectors(brain.target, pos);
    dir.addScaledVector(_rel, clamp(_rel.length() / 4, 0.1, 0.8) / (_rel.length() || 1));
    const want = pace.school * sp.maxSpeed;
    out.speed = pace.school * (ahead ? clamp(aheadSpeed / ahead / want, 0.6, 1.4) : 0.9);
  },
};
