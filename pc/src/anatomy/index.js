// Fitted anatomy (tools/fit-anatomy.mjs) merged over the hand-written species in species.js.
// Each file holds body profile parameters, per-fin outlines (by index into sp.fins), the caudal spread and
// band positions and widths (by index into sp.pattern).
import clownfish from './clownfish.js';
import lionfish from './lionfish.js';
import clowntrigger from './clowntrigger.js';
import copperband from './copperband.js';
import bluetang from './bluetang.js';
import yellowtang from './yellowtang.js';
import moorishidol from './moorishidol.js';
import royalgramma from './royalgramma.js';
import emperorangel from './emperorangel.js';
import longnose from './longnose.js';
import chromis from './chromis.js';
import coralbeauty from './coralbeauty.js';

const FITTED = { clownfish, lionfish, clowntrigger, copperband, bluetang, yellowtang, moorishidol, royalgramma, emperorangel, longnose, chromis, coralbeauty };

// Linear-light gain on a species' saturated colours (pattern, fins), from the lab's white-referenced
// patch comparison; white and black pattern are left alone.
function gainHex(hex, gain) {
  const n = parseInt(hex.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mx = Math.max(...c), mn = Math.min(...c);
  if (mx < 40 || mn > 0.7 * mx) return hex;   // black or white: not pigment colour
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const enc = (v) => Math.round(255 * Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  return '#' + c.map((v, i) => enc(lin(v) * gain[i]).toString(16).padStart(2, '0')).join('');
}
function gainColours(sp, gain) {
  const g = (h) => (typeof h === 'string' && h[0] === '#' ? gainHex(h, gain) : h);
  for (const p of sp.pattern) { if (p.color) p.color = g(p.color); if (p.stops) p.stops = p.stops.map(([v, c]) => [v, g(c)]); }
  for (const f of sp.fins) f.fill = Array.isArray(f.fill) ? f.fill.map(([t, c]) => [t, g(c)]) : g(f.fill);
  sp.caudal.fill = g(sp.caudal.fill); if (sp.pectoral) sp.pectoral.fill = g(sp.pectoral.fill); sp.eye.iris = g(sp.eye.iris);
  if (sp.pelvic) sp.pelvic.fill = g(sp.pelvic.fill);
}

export function applyFitted(species) {
  for (const sp of species) {
    if (sp.albedoGain) gainColours(sp, sp.albedoGain);
    const f = FITTED[sp.id];
    if (!f) continue;
    // (shape below; colour above applies even without a shape fit)
    Object.assign(sp.body, f.body);
    f.fins.forEach((fin, i) => { if (sp.fins[i]) Object.assign(sp.fins[i], fin); });
    Object.assign(sp.caudal, f.caudal);
    if (f.pelvic && sp.pelvic) Object.assign(sp.pelvic, f.pelvic);
    if (f.pectoral) Object.assign(sp.pectoral, f.pectoral);
    for (const b of f.bands || []) if (sp.pattern[b.index]?.op === 'band') Object.assign(sp.pattern[b.index], { u: b.u, w: b.w });
    sp.fitted = true;
  }
}
