// Pectoral fins: planform, ray layout, the painted membrane and the cupped, pleated 3D surface.
import * as THREE from 'three';
import { mulberry32, makeCanvas, context2d } from '../util.js';
import { organicPass } from '../core/organic.js';
import { VARIANT_SEED_STRIDE } from './variant.js';
import type { Pectoral, Species } from '../species/types.js';
import type { P2, P3, Profile } from './profile.js';
import type { TubeSpec } from './fins.js';
import { attribute } from './section.js';

/** Painted pectoral texture width; widths below were tuned at TUNED_WIDTH. */
const PECT_TEX_W = 512;
const TUNED_WIDTH = 256;
const FAN_RAYS = 17, BLADE_RAYS = 11;
const DEFAULT_RAY_RADIUS = 0.004;
const BAND_SPACING = 0.03;

/** A species' pectoral, or an error for the finless (only called where sp.pectoral was checked). */
export function pectoralOf(sp: Species): Pectoral {
  if (!sp.pectoral) throw new Error(`${sp.id} has no pectoral fins`);
  return sp.pectoral;
}

interface PectShape { fan: boolean; round: boolean; spread: number; yk: number }

// Pectoral planform: 'fan' (lionfish wings), 'round' (broad paddle) or the default narrow blade.
// spread: angle the rays cover; yk: vertical squash of the ray fan on the texture.
function pectShape(p: Pectoral): PectShape {
  const fan = p.kind === 'fan', round = p.kind === 'round';
  return { fan, round, spread: fan ? 2.3 : round ? 1.7 : 0.9, yk: fan ? 0.5 : round ? 0.6 : 1 };
}
// Pectoral ray count: from the species' meristics when known.
const pectoralRays = (sp: Species): number => (sp.anatomy?.pectoralRays ?? (pectoralOf(sp).kind === 'fan' ? FAN_RAYS : BLADE_RAYS)) - 1;
// Fan pectoral ray lengths (fraction of p.len): longest in the middle of the fan, slightly irregular.
const fanLen = (sp: Species, i: number): number => { const n = pectoralRays(sp); return 0.8 + 0.15 * Math.sin(Math.PI * (0.2 + (0.7 * i) / n)) + 0.04 * Math.sin(i * 1.7); };
const pectBands = (sp: Species, i: number): number => Math.max(3, Math.round((fanLen(sp, i) * pectoralOf(sp).len) / BAND_SPACING));

// Pleat and cup of the pectoral surface at (x, y) in its own plane (base at the origin, x outwards).
function pectZ(sp: Species, x: number, y: number): number {
  const p = pectoralOf(sp), { spread, yk } = pectShape(p), pw = p.len, n = pectoralRays(sp);
  const r = Math.hypot(x, y) / pw, a = Math.atan2(y / yk, Math.max(1e-4, x));
  return 0.03 * pw * r * Math.cos(Math.PI * (a / spread + 0.5) * n) + 0.12 * pw * r * r;
}

// Side view of a fan pectoral as the lab poses it (opened by `open` rad about the vertical), for
// silhouette fitting: the fan dominates a lionfish's outline.
export function pectoralOutline(sp: Species, prof: Profile, open = 0.9): P2[] {   // as lab.ts poses fans
  const p = pectoralOf(sp), { spread, yk } = pectShape(p), n = pectoralRays(sp), pw = p.len;
  const px = prof.x(p.u), py = prof.centre(p.u) - p.v * prof.half(p.u), k = Math.cos(open);
  const pts: P2[] = [[px, py + 0.01]];
  for (let i = 0; i <= n; i++) {
    const a = -spread / 2 + (spread * i) / n, r = fanLen(sp, i) * pw;
    pts.push([px - Math.cos(a) * r * k, py - Math.sin(a) * r * yk]);
  }
  pts.push([px, py - 0.01]);
  return pts;
}

// Fan pectoral rays as tubes, in the fin's own space (the canvas y runs down, so geometry y = -canvas y).
export function pectoralTubes(sp: Species): TubeSpec[] {
  const p = pectoralOf(sp), { fan, spread, yk } = pectShape(p);
  if (!fan) return [];
  const n = pectoralRays(sp), pw = p.len, out: TubeSpec[] = [];
  for (let i = 0; i <= n; i++) {
    const a = -spread / 2 + (spread * i) / n, L = fanLen(sp, i), pts: P3[] = [];
    for (let q = 0; q <= 6; q++) {
      const r = (L * q) / 6, x = Math.cos(a) * r * pw, y = -Math.sin(a) * r * yk * pw;
      pts.push([x, y, pectZ(sp, x, y)]);
    }
    out.push({ pts, r0: p.rayR ?? DEFAULT_RAY_RADIUS, r1: (p.rayR ?? DEFAULT_RAY_RADIUS) * 0.25, color: p.rayColor || p.fill, stripes: p.stripes, nb: p.stripes ? pectBands(sp, i) : 0 });
  }
  return out;
}

export function paintPectoral(sp: Species): HTMLCanvasElement {
  const p = pectoralOf(sp), { fan, round, spread, yk } = pectShape(p);
  const W = PECT_TEX_W, H = fan || round ? PECT_TEX_W : PECT_TEX_W / 2, K = W / TUNED_WIDTH;
  const c = makeCanvas(W, H), g = context2d(c);
  // Base at left-centre; fin extends to the right. The free margin is traced separately from the base
  // so a pigmented edge follows only the margin.
  g.translate(0, H / 2);
  // Rounded paddle (damselfishes): the rays' tips lie on a broad arc; the outer rays are shorter.
  const arc = (first: boolean): void => {
    for (let i = 0; i <= 24; i++) {
      const a = -spread / 2 + (spread * i) / 24, r = W * (0.97 - 0.14 * (a / (spread / 2)) ** 2);
      if (i || !first) g.lineTo(Math.cos(a) * r, Math.sin(a) * r * yk);
      else g.moveTo(Math.cos(a) * r, Math.sin(a) * r * yk);
    }
  };
  const margin = (free = false): void => {
    if (round) {
      if (free) { arc(true); return; }
      g.moveTo(0, -H * 0.07); arc(false); g.lineTo(0, H * 0.07);
    } else if (fan) {
      // Through each ray tip, the membrane incised deeply between them so the tips stand free.
      const nr = pectoralRays(sp), ang = (i: number): number => -spread / 2 + (spread * i) / nr;
      const pt = (a: number, r: number): P2 => [Math.cos(a) * r * W, Math.sin(a) * r * W * yk];
      g.moveTo(0, -H * 0.06);
      for (let i = 0; i <= nr; i++) {
        g.lineTo(...pt(ang(i), fanLen(sp, i)));
        if (i < nr) g.lineTo(...pt(ang(i + 0.5), (p.web ?? 0.62) * Math.min(fanLen(sp, i), fanLen(sp, i + 1))));
      }
      g.lineTo(0, H * 0.06);
    } else {
      g.moveTo(0, -H * 0.18);
      g.bezierCurveTo(W * 0.4, -H * 0.5, W * 0.95, -H * 0.2, W * 0.98, 0);
      g.bezierCurveTo(W * 0.9, H * 0.2, W * 0.4, H * 0.35, 0, H * 0.18);
    }
  };
  g.beginPath(); margin(); g.closePath();
  g.fillStyle = p.fill; g.fill();
  g.save(); g.clip();
  // Membrane thinning from base to margin, as on the median fins.
  const a0 = Math.min(0.85, (p.alpha ?? 0.6) + 0.05);
  g.globalCompositeOperation = 'destination-out';
  const mg = g.createRadialGradient(0, 0, 0, 0, 0, W);
  for (let s = 0; s <= 4; s++) mg.addColorStop(s / 4, `rgba(0,0,0,${1 - a0 * (1 - 0.38 * (s / 4) ** 2)})`);
  g.fillStyle = mg; g.fillRect(0, -H / 2, W, H);
  g.globalCompositeOperation = 'source-over';
  const n = pectoralRays(sp), a0r = -spread / 2, span = spread;
  const dir = (a: number, r: number): P2 => [Math.cos(a) * r, Math.sin(a) * r * yk];
  for (let i = 0; i <= n; i++) {
    const a = a0r + (span * i) / n;
    if (fan) {
      // The rays are 3D tubes (pectoralTubes); the membrane takes a narrow banded flag along each.
      const L = fanLen(sp, i) * W, nb = pectBands(sp, i);
      g.lineWidth = ((p.flag ?? 0.012) / p.len) * W;
      for (let q = 0; q < nb; q++) {
        g.strokeStyle = q % 2 && p.stripes ? p.stripes : p.fill;
        g.beginPath(); g.moveTo(...dir(a, (L * q) / nb)); g.lineTo(...dir(a, (L * (q + 1)) / nb)); g.stroke();
      }
    } else {
      // Jointed soft rays (the first is simple), branching at about half their length.
      g.setLineDash([0.12 * W, 0.006 * W]);
      g.strokeStyle = 'rgba(0,0,0,0.2)'; g.lineWidth = 1.5 * K;
      const br = i > 0 ? 0.5 : 1;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(...dir(a, W * br)); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 0.7 * K;
      const [hx, hy] = dir(a, W * br);
      g.beginPath(); g.moveTo(0, 1.2 * K); g.lineTo(hx, hy + 1.2 * K); g.stroke();
      if (br < 1) {
        g.strokeStyle = 'rgba(0,0,0,0.16)'; g.lineWidth = 1.1 * K;
        for (const s of [-1, 1]) { g.beginPath(); g.moveTo(...dir(a, W * br)); g.lineTo(...dir(a + (s * 0.22 * span) / n, W)); g.stroke(); }
      }
      g.setLineDash([]);
    }
  }
  if (p.spots) {
    g.fillStyle = p.spots;
    const rng = mulberry32(sp.id.length * 17 + 3 + (sp.variant ?? 0) * VARIANT_SEED_STRIDE);
    const sr = ((p.spotR ?? 0.006) / p.len) * W;
    for (let i = 0; i < (p.spotN ?? 60); i++) {
      const a = a0r + span * rng(), r = W * (0.15 + 0.75 * rng());
      g.beginPath(); g.arc(...dir(a, r), sr * (0.6 + 0.8 * rng()), 0, Math.PI * 2); g.fill();
    }
  }
  if (p.edge) {
    // edgeW in body lengths (TL), like the median fins; drawn on the free margin only.
    const ew = ((p.edgeW ?? 0.006 * p.len) / p.len) * W;
    g.globalAlpha = 0.95; g.strokeStyle = p.edge; g.lineWidth = 2 * ew;
    g.beginPath(); margin(true); g.stroke();
  }
  g.restore();
  // Bands, spots and margin wander a little and the colour is patchy (core/organic.ts); small, so the
  // painted outline stays on the fin's shape.
  organicPass(g, W, H, mulberry32(sp.id.length * PECT_ORGANIC_SEED.perIdChar + PECT_ORGANIC_SEED.offset + (sp.variant ?? 0) * VARIANT_SEED_STRIDE), PECT_ORGANIC);
  return c;
}

const PECT_ORGANIC_SEED = { perIdChar: 313, offset: 9 } as const;
const PECT_ORGANIC = {
  warp: [[4, 4, 3, 3], [14, 14, 1, 1]],
  mottle: { cellsX: 4, cellsY: 4, value: 0.05, chroma: 0.02 },
} as const;

// Pectoral fin: rays fan out from the base; pleated like the median fins and slightly cupped.
export function pectoralGeometry(sp: Species): THREE.BufferGeometry {
  const p = pectoralOf(sp), { fan, round } = pectShape(p);
  const pw = p.len, ph = fan || round ? p.len : p.len * 0.5;
  const g = fan ? new THREE.PlaneGeometry(pw, ph, 64, 64) : new THREE.PlaneGeometry(pw, ph, 28, 18);   // fans: pleats fine enough for every ray
  g.translate(pw / 2, 0, 0);
  const pos = attribute(g, 'position');
  // The ray angle as painted is atan2(y / yk, x) (the texture squashes the fan vertically by yk).
  for (let i = 0; i < pos.count; i++) pos.setZ(i, pectZ(sp, pos.getX(i), pos.getY(i)));
  g.computeVertexNormals();
  return g;
}
