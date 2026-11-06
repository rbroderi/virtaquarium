// The body mesh: rings lofted along the profile, with the nose dome, the gape (a hinged lower jaw), the
// gill cover's free margin and head relief (ridges, grooves, lips and the tang's scalpel sheath).
import * as THREE from 'three';
import { clamp, lerp } from '../util.js';
import type { Ridge, Species } from '../species/types.js';
import { gillOf, mouthOf, smooth01, type Gill, type P2, type Profile } from './profile.js';
import { attribute, coverAt, flankZ } from './section.js';

/** Rings along the body (more for species with head ridges) and vertices round each. */
const RINGS_PLAIN = 140, RINGS_FINE = 170, RING_VERTICES = 112;
/** The body-side rings of the gill margin sit this far (u) behind it. */
const GILL_GAP = 0.0025;
/** The nose dome's length along x over its height (1: a hemisphere). */
const DOME_ROUNDNESS = 0.8;
const DOME_RINGS = 7;
/** Gape vertices ease towards the mouth line over this many ring vertices. */
const GAPE_EASE = 10;

/** A seam ring on the gill margin: the cover's edge, the opening's far side, or the skin behind. */
interface Seam { slit?: boolean; back?: boolean }
/** The four rings on the gill margin, front to back: cover face, opening start, opening far side, skin. */
const GILL_SEAMS: readonly Seam[] = [{}, { slit: true }, { slit: true, back: true }, { back: true }];

// Head relief (sp.ridges): ridges (h > 0) and grooves (h < 0) drawn on the side view as segments from
// (u0, v0) to (u1, v1) (v as for the eye), w wide and h high (TL), raised along the section's radius:
// the lionfish's bony suborbital stay and brow, the triggerfish's groove before the eye and its lips.
function reliefOf(sp: Species, prof: Profile): (x: number, y: number) => number {
  const P = (u: number, v: number): P2 => [prof.x(u), prof.centre(u) - v * prof.half(u)];
  const S = sp.scalpel, len = sp.body.len;
  const all: Ridge[] = [...(sp.ridges || []), ...(S ? [{ u0: S.u - S.len * 0.35, v0: S.v, u1: S.u + S.len * 0.35, v1: S.v, w: S.len * len * 0.12, h: S.len * len * 0.05 }] : [])];
  const R = all.map((r) => ({ ...r, a: P(r.u0, r.v0), b: P(r.u1 ?? r.u0, r.v1 ?? r.v0) }));
  return (x, y) => {
    let d = 0;
    for (const r of R) {
      const ex = r.b[0] - r.a[0], ey = r.b[1] - r.a[1], L2 = ex * ex + ey * ey;
      const t = L2 > 0 ? clamp(((x - r.a[0]) * ex + (y - r.a[1]) * ey) / L2, 0, 1) : 0;
      const dx = x - r.a[0] - t * ex, dy = y - r.a[1] - t * ey;
      d += r.h * Math.exp(-(dx * dx + dy * dy) / (r.w * r.w));
    }
    return d;
  };
}

export function bodyGeometry(prof: Profile, sp: Species): THREE.BufferGeometry {
  const fine = !!sp.ridges, NU = fine ? RINGS_FINE : RINGS_PLAIN, NA = RING_VERTICES;
  const relief = reliefOf(sp, prof);
  const len = sp.body.len, G = gillOf(sp), M = mouthOf(sp);
  const gill = (): Gill => { if (!G) throw new Error(`${sp.id} has no gill cover`); return G; };
  const us: number[] = [];
  for (let i = 0; i <= NU; i++) { const t = i / NU; us.push(t * t * 0.35 + t * 0.65); }
  // Ring angles (th = 0 is the dorsal midline, texture v = -cos th): closer together on the flanks,
  // where the mouth, eye and gill margin are, than over the back and belly.
  const thAt = (a: number): number => { const t = a / NA; return Math.PI * 2 * t - 0.12 * Math.sin(Math.PI * 4 * t); };
  // The gape: every ring has a vertex on it each side (index iL on +z, NA - iL on -z), the angles
  // round it eased so the line falls on that vertex; ahead of the corner of the mouth the vertex is
  // doubled twice over (upper lip, its inner face, the lower lip's inner face, lower lip), so the jaws
  // part along a clean seam and the band between the inner faces is the inside of the mouth.
  const lineV = (u: number): number => lerp(M.v0, M.v, clamp(u / M.u, 0, 1));
  const th0 = Math.acos(-lineV(M.u * 0.5));
  let iL = 1;
  for (let a = 1; a < NA / 2; a++) if (Math.abs(thAt(a) - th0) < Math.abs(thAt(iL) - th0)) iL = a;
  const W = GAPE_EASE, angle = (a: number, u: number): number => {
    const d = Math.acos(clamp(-lineV(u), -1, 1)) - thAt(iL);
    const w = (k: number): number => Math.max(0, 1 - Math.abs(a - k) / W);
    return thAt(a) + d * w(iL) - d * w(NA - iL);   // mirrored on the -z side
  };
  // Near the gill margin the rings bend to follow its bow, so none crosses it; the body-side rings of
  // the margin sit GAP behind it, and the rings behind those stay behind.
  const backU = (v: number): number => gill().edge(v) + GILL_GAP * gill().fade(v);
  const bendU = (u: number, v: number): number => {
    if (!G) return u;
    const b = u - (G.u - G.edge(v)) * Math.max(0, 1 - Math.abs(u - G.u) / 0.08);
    return u > G.u ? Math.max(b, backU(v) + 0.001) : b;
  };
  // Lips: raised either side of the gape, with a crease along it, fading out past the corner.
  const mw = Math.min(0.004 + 0.05 * M.u, 0.12 * prof.half(M.u));
  // sc: the nose dome's shrink at this ring; the lips shrink with it and meet at the tip (at full size
  // they climbed the shrinking dome, a dark V over the mouth head-on).
  const lips = (u: number, v: number, h: number, sc = 1): number => {
    const t = ((u - M.u) * len) / mw;
    if (t > 1.5) return 0;
    const w = mw * Math.min(1, sc), dy = (v - lineV(u)) * h;
    const lip = Math.exp(-(((dy - w) / (0.7 * w)) ** 2)) + Math.exp(-(((dy + w) / (0.7 * w)) ** 2));
    return (0.4 * lip - 0.35 * Math.exp(-((dy / (0.45 * w)) ** 2))) * w * (1 - smooth01(t + 0.5));
  };
  const R = NA + 6;   // vertices per ring: NA round it, and the three extra copies on the gape each side
  const pos: number[] = [], uv: number[] = [], thick: number[] = [], idx: number[] = [], jaw: number[] = [], jawG: number[] = [], cov: number[] = [], slit: number[] = [];
  // One ring at body position u0, or a ring of the nose dome (capX: its x; the section at uSec
  // shrunk by scale, while u0 places the mouth, jaw and texture). seam: the rings on the gill margin,
  // { cover, slit, back }: the cover's edge (twice: its outer face and the start of the gill opening)
  // and, GAP behind and a little sunk, the body's (the opening's far side, then skin).
  const ringOf = (u0: number, scale = 1, capX: number | null = null, seam: Seam | null = null, uSec: number | null = null): void => {
    const mouthRing = (seam ? gill().u : u0) < M.u;
    // The lower jaw's share of the swing eases off over the last 30% before the corner, so the chin
    // and throat skin stretch smoothly there instead of creasing against the head behind.
    const wj = mouthRing ? 1 - smooth01((u0 - 0.7 * M.u) / (0.3 * M.u)) : 0;
    // and how fast it eases (per unit x), for the shader to tilt the normals to match
    const tj = (u0 - 0.7 * M.u) / (0.3 * M.u);
    const wjG = mouthRing && capX == null && tj > 0 && tj < 1 ? (6 * tj * (1 - tj)) / (0.3 * M.u) / len : 0;
    // dv: texture offset for the lips' inner faces, so the inside of the mouth maps the skin just above
    // and below the gape (shown darkened, FISH_COVER) rather than one stretched row of it.
    const put = (a: number, jw: number, sl: number, dv = 0): void => {
      const v = -Math.cos(thAt(a));   // which part of the gill margin this vertex sits on
      const u = seam ? (seam.back ? backU(v) : gill().edge(v)) : capX != null ? u0 : bendU(u0, v);
      const th = angle(a, u), cy = Math.cos(th), vv = -cy;
      const us_ = uSec ?? u, h = prof.half(us_) * scale, yc = prof.centre(us_), x = capX ?? prof.x(u);
      let y = yc + cy * h, z = flankZ(sp, prof, us_, vv, seam ? !seam.back : undefined) * scale;
      if (seam?.back && seam.slit) z *= 1 - 0.04 * gill().fade(vv);   // the gill chamber is sunk under the cover
      const k = 1 + (relief(x, y) + lips(u, vv, h, scale)) / Math.max(Math.hypot(y - yc, z), 2 * mw * Math.min(1, scale), 1e-3);
      y = yc + (y - yc) * k; z *= k;
      pos.push(x, y, Math.sign(Math.sin(th)) * z);
      uv.push(u, clamp((1 + cy) / 2 + dv, 0, 1));
      // Tissue a backlight has to pass through: across the body on the flanks, but no less than most
      // of the section's smaller axis at the back, belly and nose, where the distance to the midplane
      // falls to nothing yet the light still crosses the whole body (they glowed as thin lines).
      thick.push(2 * Math.max(z, 0.8 * Math.min(prof.width(us_), prof.half(us_))));
      jaw.push(jw);
      jawG.push(jw > 0 ? wjG : 0);
      // How much of the breathing flare (fish.ts) a point takes: most at the cover's margin.
      const c = capX != null || seam?.back ? 0 : coverAt(G, u, vv, seam ? true : undefined);
      cov.push(c * c);
      slit.push(sl);
    };
    const gs = seam?.slit ? 1 : 0, mi = mouthRing ? 1 : gs, mj = wj, MV = mouthRing ? 0.05 : 0;
    for (let a = 0; a < NA; a++) {
      const lower = a > iL && a < NA - iL ? wj : 0;
      if (a === iL) {
        // Down the +z side: upper lip, its inner face, the lower lip's inner face, the lower lip
        // (texture v rises dorsally).
        put(a, 0, gs); put(a, 0, mi, MV); put(a, mj, mi, -MV); put(a, mj, gs);
      } else if (a === NA - iL) {
        // Back up the -z side: lower lip first.
        put(a, mj, gs); put(a, mj, mi, -MV); put(a, 0, mi, MV); put(a, 0, gs);
      } else put(a, lower, gs);
    }
  };
  const tip = (u: number): void => { thick.push(1.6 * Math.min(prof.width(u), prof.half(u))); jaw.push(0); jawG.push(0); cov.push(0); slit.push(0); };
  // Nose: an elliptical dome taking over from the head at uS, where the head's surface still slopes
  // gently enough to round over (most heads rise almost vertically from a blunt front at u = 0, and a
  // cap set on that front sat on it as a separate knob with a crease round it). The dome leaves the
  // head at its own slope, so there is no crease, and closes at the tip; its rings shrink the section
  // at uS while carrying the mouth, jaw and texture on from u = uS to 0.
  const dh = (u: number): number => (prof.half(u + 1e-3) - prof.half(Math.max(0, u - 1e-3))) / (u + 1e-3 - Math.max(0, u - 1e-3));
  const ROUND = DOME_ROUNDNESS;
  const domeAt = (u: number): { r: number; t: number } => { const r = prof.half(u); return { r, t: (dh(u) / len / r) * ROUND * r }; };   // t: tan of where the dome joins
  let uS = 0;
  for (let u = 0; u < Math.min(0.06, 0.7 * M.u + 0.01); u += 0.002) { uS = u; if (domeAt(u).t < Math.tan(1.0)) break; }
  const { r: rS, t: tS } = domeAt(uS);
  const phi0 = Math.atan(Math.max(0, tS)), aX = (ROUND * rS) / Math.cos(phi0);   // x semi-axis of the dome's ellipse
  const domeLen = aX * (1 - Math.sin(phi0)), xS = prof.x(uS), DOME = DOME_RINGS;
  // The snout tip, four times over: for the upper jaw's skin, the lower jaw's (it moves with it), and
  // the inner faces of each, which close the front of the open mouth.
  for (const [jw, sl] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
    // (the inner copies map the skin either side of the gape, as the lips' inner faces do)
    pos.push(xS + domeLen, prof.centre(uS), 0); uv.push(0, sl ? clamp((1 - M.v0) / 2 + (jw ? -0.05 : 0.05), 0, 1) : 0.5); tip(uS);
    jaw[jaw.length - 1] = jw; slit[slit.length - 1] = sl;
  }
  let rings = 0;
  for (let k = DOME; k >= 1; k--, rings++) {
    const phi = phi0 + (k / (DOME + 1)) * (Math.PI / 2 - phi0);
    ringOf(uS * (1 - k / (DOME + 1)), Math.cos(phi) / Math.cos(phi0), xS + aX * (Math.sin(phi) - Math.sin(phi0)), null, uS);
  }
  const slitRings: number[] = [];
  let seamed = !G;
  for (const u of [uS, ...us.filter((u) => u > uS + 1e-4)]) {
    if (!seamed && G && u > G.u) {
      for (const seam of GILL_SEAMS) {
        if (seam.slit) slitRings.push(rings);
        ringOf(G.u, 1, null, seam); rings++;
      }
      seamed = true;
    }
    ringOf(u); rings++;
  }
  const tailIdx = pos.length / 3;
  pos.push(prof.x(1) - 0.004, prof.centre(1), 0); uv.push(1, 0.5); tip(1);
  const ring = (i: number): number => 4 + i * R;
  const isJaw = (i: number): boolean => (jaw[i] ?? 0) > 0;
  // Fan from the tip: upper-jaw pairs to the upper tip, lower-jaw pairs to the lower, and a pair that
  // spans the gape (an inner face of each lip) to both inner tips.
  for (let a = 0; a < R; a++) {
    const p = ring(0) + a, q = ring(0) + ((a + 1) % R), jp = isJaw(p), jq = isJaw(q);
    if (jp === jq) idx.push(jp ? 1 : 0, q, p);
    else if (jq) idx.push(3, q, p, 3, p, 2);   // down the +z side: upper (p) to lower (q)
    else idx.push(2, q, p, 2, p, 3);           // back up the -z side
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let a = 0; a < R; a++) {
      const a1 = (a + 1) % R;
      const p0 = ring(i) + a, p1 = ring(i) + a1, p2 = ring(i + 1) + a, p3 = ring(i + 1) + a1;
      idx.push(p0, p1, p2, p1, p3, p2);
    }
  }
  const last = ring(rings - 1);
  for (let a = 0; a < R; a++) idx.push(last + a, last + ((a + 1) % R), tailIdx);
  // The rings run around +x, so the triangles above wind inwards; flip them so faces point outwards.
  for (let t = 0; t < idx.length; t += 3) { const k = idx[t + 1] ?? 0; idx[t + 1] = idx[t + 2] ?? 0; idx[t + 2] = k; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aThick', new THREE.Float32BufferAttribute(thick, 1));
  g.setAttribute('aJaw', new THREE.Float32BufferAttribute(jaw, 1));
  g.setAttribute('aJawG', new THREE.Float32BufferAttribute(jawG, 1));
  g.setAttribute('aCover', new THREE.Float32BufferAttribute(cov, 1));
  g.setAttribute('aSlit', new THREE.Float32BufferAttribute(slit, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Coincident copies (the gape, the gill margin) have no normal of their own where the faces between
  // them have no width: take a neighbour's, along the ring and then across the gill margin.
  const n = attribute(g, 'normal'), bad = (i: number): boolean => Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) < 0.5;
  const copy = (i: number, j: number): void => { n.setXYZ(i, n.getX(j), n.getY(j), n.getZ(j)); };
  for (const i of [1, 2, 3]) if (bad(i)) copy(i, 0);   // the tip's copies
  slitRings.forEach((r, k) => { for (let a = 0; a < R; a++) if (bad(ring(r) + a)) copy(ring(r) + a, ring(k ? r + 1 : r - 1) + a); });
  for (let i = 0; i < rings; i++) {
    for (let a = 0; a < R; a++) if (bad(ring(i) + a)) copy(ring(i) + a, ring(i) + ((a + R - 1) % R));
    for (let a = R - 1; a >= 0; a--) if (bad(ring(i) + a)) copy(ring(i) + a, ring(i) + ((a + 1) % R));
  }
  return g;
}
