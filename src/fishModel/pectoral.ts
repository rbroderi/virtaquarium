// Pectoral fins: planform, ray layout, the painted membrane and the cupped, pleated 3D surface.
import * as THREE from 'three';
import { mulberry32, makeCanvas, context2d } from '../util.js';
import { organicPass } from '../core/organic.js';
import { VARIANT_SEED_STRIDE } from './variant.js';
import type { Pectoral, Species } from '../species/types.js';
import { outlineCurve, type P2, type P3, type Profile } from './profile.js';
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
// Fan pectoral ray lengths (fraction of p.len): p.rayLen when given (top ray 0 .. bottom ray 1), else
// longest in the middle of the fan; slightly irregular either way.
const fanLen = (sp: Species, i: number): number => {
  const p = pectoralOf(sp), n = pectoralRays(sp), rl = p.rayLen, jitter = (p.rayJitter ?? 0.04) * Math.sin(i * 1.7);
  return rl ? Math.min(1, outlineCurve(rl)(i / n) + jitter) : 0.8 + 0.15 * Math.sin(Math.PI * (0.2 + (0.7 * i) / n)) + jitter;
};
// Fan rays rise from a short vertical base, not one point (in fractions of the fin length, canvas y down):
// spread evenly along it, so the rays don't bunch into a hub where they meet the body.
const FAN_BASE = 0.085;
const FAN_ROOT = 0.15;   // flags start, and ray tubes reach full thickness, this far out (share of the ray)
const fanBase = (a: number, spread: number): number => FAN_BASE * (a / (spread / 2));
// A fan's rays lie in its squashed plane (y scaled by yk), so equal steps of the unsquashed angle bunch the
// middle rays and splay the outer ones. Space them evenly as seen instead: ray i's angle, and the share
// (0 top .. 1 bottom) of the fan at angle a.
const fanSee = (spread: number, yk: number): number => Math.atan(yk * Math.tan(spread / 2));
const fanAngle = (i: number, n: number, spread: number, yk: number): number => {
  const m = fanSee(spread, yk);
  return Math.atan(Math.tan(-m + (2 * m * i) / n) / yk);
};
const fanShare = (a: number, spread: number, yk: number): number => Math.atan(yk * Math.tan(a)) / (2 * fanSee(spread, yk)) + 0.5;
const pectBands = (sp: Species, i: number): number => Math.max(3, Math.round((fanLen(sp, i) * pectoralOf(sp).len) / BAND_SPACING));

// Pleat and cup of the pectoral surface at (x, y) in its own plane (base at the origin, x outwards).
function pectZ(sp: Species, x: number, y: number): number {
  const p = pectoralOf(sp), { spread, yk } = pectShape(p), pw = p.len, n = pectoralRays(sp);
  const r = Math.hypot(x, y) / pw;
  // The ray through (x, y): fan rays rise from a short base (fanBase), so solve for the angle whose ray
  // passes here, keeping each pleat's crest on its ray.
  let a = Math.atan2(y / yk, Math.max(1e-4, x));
  if (pectShape(p).fan) for (let k = 0; k < 6; k++) a = Math.max(-spread / 2, Math.min(spread / 2, Math.atan2((y / pw + fanBase(-a, spread)) / yk, Math.max(1e-4, x / pw))));
  const t = pectShape(p).fan ? fanShare(a, spread, yk) : a / spread + 0.5;
  // cone: the middle rays lean out of the plane (the outer ones stay), so the fan is a shallow cone that
  // never collapses to a line seen edge-on.
  const cone = (p.cone ?? 0) * pw * r * (1 - (2 * t - 1) ** 2);
  return 0.03 * (p.pleat ?? 1) * pw * r * Math.cos(Math.PI * t * n) + 0.12 * pw * r * r + cone;
}

// Side view of a fan pectoral as the lab poses it (opened by `open` rad about the vertical), for
// silhouette fitting: the fan dominates a lionfish's outline.
export function pectoralOutline(sp: Species, prof: Profile, open = 0.9): P2[] {   // as lab.ts poses fans
  const p = pectoralOf(sp), { spread, yk } = pectShape(p), n = pectoralRays(sp), pw = p.len;
  const px = prof.x(p.u), py = prof.centre(p.u) - p.v * prof.half(p.u), k = Math.cos(open);
  const pts: P2[] = [[px, py + 0.01]];
  for (let i = 0; i <= n; i++) {
    const a = fanAngle(i, n, spread, yk), r = fanLen(sp, i) * pw;
    pts.push([px - Math.cos(a) * r * k, py - Math.sin(a) * r * yk - fanBase(a, spread) * pw]);
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
    const a = fanAngle(i, n, spread, yk), L = fanLen(sp, i), pts: P3[] = [];
    for (let q = 0; q <= 6; q++) {
      const r = (L * q) / 6, x = Math.cos(a) * r * pw, y = -(Math.sin(a) * r * yk + fanBase(a, spread)) * pw;
      pts.push([x, y, pectZ(sp, x, y)]);
    }
    out.push({ pts, r0: p.rayR ?? DEFAULT_RAY_RADIUS, r1: (p.rayR ?? DEFAULT_RAY_RADIUS) * 0.25, color: p.rayColor || p.fill, stripes: p.stripes, nb: p.stripes ? pectBands(sp, i) : 0, root: FAN_ROOT });
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
  const n = pectoralRays(sp), a0r = -spread / 2, span = spread;
  const ang = (i: number): number => (fan ? fanAngle(i, n, spread, yk) : a0r + (span * i) / n);
  const dir = (a: number, r: number): P2 => [Math.cos(a) * r, Math.sin(a) * r * yk + (fan ? fanBase(a, spread) * W : 0)];
  // A fan ray's membrane strap on the canvas: its length L (px, along the ray parameter r), unit
  // direction, k (canvas length per unit of r), half-width at share t of L, and the point at r offset
  // by `side` half-widths across it (-1 the upper edge, +1 the lower; canvas y runs down).
  // A pointed strap (flagPoint) closes over its last stretch as a half-ellipse, sqrt(1 - u^2): a rounded
  // lance end, not a needle. flagSwell widens it just before, so the end reads as a leaf.
  const hw0 = ((p.flag ?? 0.012) / p.len) * W / 2, tip = p.flagTip ?? 1, pt = p.flagPoint ?? 0, sw = p.flagSwell ?? 0;
  const point = (t: number): number => {
    if (pt <= 0) return 1;
    const u = Math.min(1, Math.max(0, (t - 1 + pt) / pt)), b = (t - 1 + pt) / (2.5 * pt);
    return Math.sqrt(1 - u * u) * (1 + sw * Math.exp(-b * b));
  };
  const strap = (i: number): { L: number; dx: number; dy: number; k: number; hw: (t: number) => number; at: (r: number, side: number) => P2 } => {
    const a = ang(i), L = fanLen(sp, i) * W, k = Math.hypot(Math.cos(a), Math.sin(a) * yk);
    const dx = Math.cos(a) / k, dy = (Math.sin(a) * yk) / k, hw = (t: number): number => hw0 * (1 - (1 - tip) * Math.min(1, t)) * point(t);
    return { L, dx, dy, k, hw, at: (r, side) => { const [x, y] = dir(a, r), h = side * hw(r / L); return [x - dy * h, y + dx * h]; } };
  };
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
      // Round each strap's edges and rounded tip; between straps the membrane runs out to the web depth,
      // incised there so the straps stand free beyond it.
      const nr = pectoralRays(sp), web = p.web ?? 0.62;
      g.moveTo(0, -H * (FAN_BASE + 0.015));
      for (let i = 0; i <= nr; i++) {
        const s = strap(i), L = s.L;
        const rIn = i > 0 ? web * Math.min(L, strap(i - 1).L) : 0, rOut = i < nr ? web * Math.min(L, strap(i + 1).L) : 0;
        const hTip = s.hw(1), rc = Math.max(rIn, L - hTip / s.k);
        if (i > 0) {   // the notch: a shallow curve from the last strap's lower edge to this one's upper edge
          const prev = strap(i - 1), [qx, qy] = prev.at(rIn, 1), [ux, uy] = s.at(rIn, -1);
          const [mx, my] = dir(ang(i - 0.5), rIn * 0.96);
          g.lineTo(qx, qy); g.quadraticCurveTo(mx, my, ux, uy);
        }
        g.lineTo(...s.at(rIn, -1));
        if (pt > 0) {   // pointed: follow the narrowing edges out to the point and back
          const r0 = Math.max(rIn, L * (1 - 5 * pt));   // from before the swell
          g.lineTo(...s.at(r0, -1));
          for (let q = 1; q <= 20; q++) g.lineTo(...s.at(r0 + ((L - r0) * Math.sin((Math.PI / 2) * q / 20)), -1));
          for (let q = 19; q >= 0; q--) g.lineTo(...s.at(r0 + ((L - r0) * Math.sin((Math.PI / 2) * q / 20)), 1));
        } else {
          g.lineTo(...s.at(rc, -1));
          const [cx, cy] = s.at(rc, 0), th = Math.atan2(s.dy, s.dx);
          g.arc(cx, cy, hTip, th - Math.PI / 2, th + Math.PI / 2);
        }
        g.lineTo(...s.at(rOut, 1));
      }
      g.lineTo(0, H * (FAN_BASE + 0.015));
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
  for (let i = 0; i <= n; i++) {
    const a = ang(i);
    if (fan) {
      // The rays are 3D tubes (pectoralTubes); the membrane takes a banded strap along each, tapering
      // to its tip (the margin clips it round).
      const s = strap(i), L = s.L, nb = pectBands(sp, i);
      for (let q = 0; q < nb; q++) {
        g.fillStyle = q % 2 && p.stripes ? p.stripes : p.fill;
        const r0 = Math.max((L * q) / nb, L * FAN_ROOT), r1 = q === nb - 1 ? L * 1.05 : (L * (q + 1)) / nb;
        if (r1 > r0) {
          // Follow the strap's curved edges (swell, rounded end) rather than a straight quad.
          const re = pt > 0 ? Math.min(r1, L) : r1, m = pt > 0 ? 10 : 1;
          g.beginPath(); g.moveTo(...s.at(r0, -1));
          for (let j = 1; j <= m; j++) g.lineTo(...s.at(r0 + ((re - r0) * j) / m, -1));
          for (let j = m; j >= 0; j--) g.lineTo(...s.at(r0 + ((re - r0) * j) / m, 1));
          g.closePath(); g.fill();
        }
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
