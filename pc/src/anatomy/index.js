// Fitted anatomy (tools/fit-anatomy.mjs) merged over the hand-written species in species.js.
// Each file holds body profile parameters, per-fin outlines (by index into sp.fins), the caudal spread and
// band positions and widths (by index into sp.pattern).
import clownfish from './clownfish.js';

const FITTED = { clownfish };

export function applyFitted(species) {
  for (const sp of species) {
    const f = FITTED[sp.id];
    if (!f) continue;
    Object.assign(sp.body, f.body);
    f.fins.forEach((fin, i) => { if (sp.fins[i]) Object.assign(sp.fins[i], fin); });
    Object.assign(sp.caudal, f.caudal);
    for (const b of f.bands || []) if (sp.pattern[b.index]?.op === 'band') Object.assign(sp.pattern[b.index], { u: b.u, w: b.w });
    sp.fitted = true;
  }
}
