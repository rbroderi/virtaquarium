// Host: a clownfish weaving around its anemone's tentacles. It holds a slow cycle: short forays out
// above and around the crown, time weaving through the upper tentacles, and shorter, deeper snuggles;
// a scare drives it down among the tentacles. The organism itself is outside this file (reef/anemone).
import { clamp } from '../../util.js';
import type { Behaviour } from '../behaviour.js';

/** Smooth 0..1 ramp, for the hosting cycle's phases. */
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export const host: Behaviour = {
  mode: 'host',

  score: ({ species: sp, drives: d }) => (sp.host ? 0.75 + d.fear * 0.8 - d.boredom * 0.3 : 0),

  steer({ brain, me, world, dt, dir, pos, pace, out }) {
    const an = world.anemoneFor(me);
    if (!an) {   // no anemone in this tank: drift on
      dir.copy(me.dir);
      return;
    }
    brain.orbit += dt * (0.4 + brain.drives.fear);
    // ~20 s cycle: from a foray above the crown, down through the upper tentacles, and briefly in
    // deep. Fear pins it among the tentacles (the closer-in-when-scared part).
    const fear = clamp(brain.drives.fear * 2, 0, 1);
    const cycle = Math.sin(brain.orbit * 0.7);
    const foray = smoothstep(0.2, 0.9, cycle) * (1 - fear);
    const snug = Math.min(1, smoothstep(0.35, 0.9, -cycle) * 0.55 + fear);
    // The ring it weaves along sits at the crown's rim, not on the column; the foray takes it out to
    // about twice the crown's reach and above the tips.
    const ring = an.radius * (0.7 + 0.2 * Math.sin(brain.orbit * 0.9));
    const r = ring * (1 + 2.2 * foray) * (1 - 0.65 * snug);
    const y = an.pos.y + an.radius * (0.66 + 0.16 * Math.sin(brain.orbit * 1.3) + 1.5 * foray - 0.45 * snug);
    const x = an.pos.x + Math.cos(brain.orbit) * r, z = an.pos.z + Math.sin(brain.orbit) * r * 0.7;
    const floor = world.reefHeight(x, z) + me.size * 0.55;
    brain.target.set(x, clamp(y, floor, world.bounds.y1 - 0.4), z);
    dir.subVectors(brain.target, pos);
    const dist = dir.length();
    dir.normalize();
    out.speed = dist > 1.5 ? pace.host[0] : pace.host[1] + dist * 0.1;
    out.clearance = 0.05;
  },
};
