// Median and paired fins in side view: their outlines, the painted fin sheet (one texture through the
// midline holding the dorsal, anal, caudal and pelvic fins) and the relief maps of their rays.
import * as THREE from 'three';
import { clamp, lerp, mulberry32, makeCanvas, context2d } from '../util.js';
import type {
  CaudalBand, FinCount, FinLook, FinPaint, FinSpot, MembraneFin, Meristic, SpineFin, Species,
} from '../species/types.js';
import type { P2, P3, Profile } from './profile.js';

/** Fin sheet texture width (texels); the height follows the fins' extent. */
const SHEET_W = 2048;
const SHEET_X_MAX = 0.52;
const SHEET_X_MIN = -0.52;
const CAUDAL_PRINCIPAL_RAYS = 17;
const DEFAULT_SPINE_HEIGHTS = [0.7, 1, 1, 0.9, 0.7, 0.5, 0.35];
const DEFAULT_SPINE_LEAN: P2 = [25, 50];

/** Base and outer edge points of a fin at t (0 front .. 1 rear). */
export type Rays = (t: number) => [P2, P2];
/** (base x, base y, angle when lowered, angle when fully raised) of an erectile spine. */
export type Erect4 = [number, number, number, number];

/** A fin membrane to mesh in 3D (meshes.ts finMesh). */
export interface FinMeshSpec {
  rays: Rays;
  n: number;
  erect?: (t: number) => Erect4;
  xforms?: THREE.Matrix4[];
}

/** A tapered tube along a smooth path (meshes.ts tubeGeometry): spines, free rays, tentacles. */
export interface TubeSpec {
  pts: P3[];
  r0: number;
  r1: number;
  color: string;
  stripes?: string | undefined;
  nb?: number;
  flat?: number | undefined;
  shape?: 'leaf' | undefined;
  jaw?: boolean;
  erect?: Erect4;
}

/** A texture image: a painted canvas, or a cached map decoded as a bitmap or image. */
export type TexImage = HTMLCanvasElement | ImageBitmap | HTMLImageElement;

/** The painted fin sheet and what to mesh from it. */
export interface FinSheet {
  canvas: HTMLCanvasElement;
  xmin: number;
  xmax: number;
  ymax: number;
  meshes: FinMeshSpec[];
  tubes: TubeSpec[];
  /** Relief maps (absent when they come from the skin cache). */
  normal?: TexImage;
  data?: TexImage;
}

export interface SpinePlacement { u: number; b: P2; tip: P2; len: number; a: number }

export interface FinOutline { base: P2[]; outer: P2[]; sign: number }

export interface PelvicShape { outline: P2[]; rays: Rays; xforms: THREE.Matrix4[] }

/** Any fin drawn on the sheet: median fins, the caudal and the pelvics. */
interface SheetFin extends FinLook {
  paint?: FinPaint[];
  band?: CaudalBand;
  spot?: FinSpot;
}

interface RayCount { n?: number; spines?: number; simpleEnds?: boolean }

const pt = (arr: readonly P2[], i: number): P2 => arr[i] ?? [0, 0];

// Free-standing dorsal spines (the lionfish's venomous spines, the triggerfish's trigger): n spines from
// u0 to u1, each leaning back from vertical by lean[0]..lean[1] degrees (first to last); hs are relative
// heights from the first spine to the last (resampled to n), times h (TL).
export function spineLayout(prof: Profile, fin: SpineFin): SpinePlacement[] {
  const n = Math.max(2, fin.n), hs = fin.hs.length ? fin.hs : DEFAULT_SPINE_HEIGHTS, lean = fin.lean ?? DEFAULT_SPINE_LEAN;
  const out: SpinePlacement[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), u = lerp(fin.u0, fin.u1, t);
    const k = t * (hs.length - 1), j = Math.min(hs.length - 2, Math.floor(k));
    const len = fin.h * lerp(hs[j] ?? 0, hs[j + 1] ?? 0, k - j), a = THREE.MathUtils.degToRad(lerp(lean[0], lean[1], t));
    const b: P2 = [prof.x(u), prof.centre(u) + prof.half(u) * 0.85];
    out.push({ u, b, tip: [b[0] - Math.sin(a) * len, b[1] + Math.cos(a) * len], len, a });
  }
  return out;
}

export function finOutline(_sp: Species, prof: Profile, fin: MembraneFin | SpineFin): FinOutline {
  const sign = fin.pos === 'top' ? 1 : -1;
  const base: P2[] = [], outer: P2[] = [];
  for (let i = 0; i <= 14; i++) {
    const u = lerp(fin.u0, fin.u1, i / 14);
    base.push([prof.x(u), prof.centre(u) + sign * prof.half(u) * 0.85]);
  }
  if (fin.kind === 'spines') {
    // Side-view envelope: through the spine tips (photo traces fill the gaps between spines).
    for (const s of spineLayout(prof, fin)) outer.push(s.tip);
    outer.push([prof.x(fin.u1) - 0.01, prof.top(fin.u1) + 0.005]);
    return { base, outer, sign };
  }
  // [t, h, back]: back (optional) is how far behind its base the point lies, in place of sweep * h (a
  // filament running back past the tail).
  for (const [t, h, back] of fin.pts) {
    const u = lerp(fin.u0, fin.u1, t);
    outer.push([prof.x(u) - (back ?? (fin.sweep || 0) * h), prof.centre(u) + sign * (prof.half(u) + h)]);
  }
  return { base, outer, sign };
}

export function caudalOutline(sp: Species, prof: Profile): P2[] {
  const c = sp.caudal, xp = prof.xPed + 0.02, hp = prof.half(1) * 0.9, tip = c.tip ?? -0.5, L = xp - tip, s = c.spread;
  switch (c.type) {
    case 'forked': return [[xp, hp], [tip + L * 0.05, s], [tip, s * 1.05], [xp - L * 0.55, 0], [tip, -s * 1.05], [tip + L * 0.05, -s], [xp, -hp]];
    case 'lunate': return [[xp, hp], [xp - L * 0.6, s * 0.7], [tip, s * 1.1], [xp - L * 0.6, s * 0.25], [xp - L * 0.62, 0], [xp - L * 0.6, -s * 0.25], [tip, -s * 1.1], [xp - L * 0.6, -s * 0.7], [xp, -hp]];
    case 'truncate': return [[xp, hp], [tip + L * 0.1, s], [tip, s * 0.95], [tip + L * 0.04, 0], [tip, -s * 0.95], [tip + L * 0.1, -s], [xp, -hp]];
    default: { // round
      const pts: P2[] = [[xp, hp]];
      for (let i = 0; i <= 12; i++) {
        const a = Math.PI / 2 - (Math.PI * i) / 12;
        pts.push([xp - L * 0.35 - Math.cos(a) * L * 0.65, Math.sin(a) * s]);
      }
      pts.push([xp, -hp]);
      return pts;
    }
  }
}

/** The point at fraction t of the polyline's length. */
function along(pts: readonly P2[], t: number): P2 {
  let total = 0;
  const seg: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pt(pts, i), b = pt(pts, i - 1);
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    seg.push(d); total += d;
  }
  let target = clamp(t, 0, 1) * total;
  for (let i = 0; i < seg.length; i++) {
    const si = seg[i] ?? 0;
    if (target <= si || i === seg.length - 1) {
      const k = si > 0 ? clamp(target / si, 0, 1) : 0;
      const a = pt(pts, i), b = pt(pts, i + 1);
      return [lerp(a[0], b[0], k), lerp(a[1], b[1], k)];
    }
    target -= si;
  }
  return pt(pts, pts.length - 1);
}

function smoothPath(g: CanvasRenderingContext2D, pts: readonly P2[], close: boolean): void {
  const first = pt(pts, 0), last = pt(pts, pts.length - 1);
  g.moveTo(first[0], first[1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pt(pts, i), b = pt(pts, i + 1);
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    g.quadraticCurveTo(a[0], a[1], mx, my);
  }
  g.lineTo(last[0], last[1]);
  if (close) g.closePath();
}

function finFill(g: CanvasRenderingContext2D, fill: FinLook['fill'], x0: number, x1: number): string | CanvasGradient {
  if (!Array.isArray(fill)) return fill;
  const gr = g.createLinearGradient(x0, 0, x1, 0);
  for (const [t, col] of fill) gr.addColorStop(1 - t, col);
  return gr;
}

const lerp2 = (a: P2, b: P2, t: number): P2 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];

// cachedMaps: the relief maps come from the skin cache, so only the colour sheet and ray layout are made.
export function paintFins(sp: Species, prof: Profile, cachedMaps = false): FinSheet {
  // Bounds of everything drawn on the sheet.
  let ymax = prof.H * 1.25, xmin = SHEET_X_MIN;
  const fins = sp.fins.map((f) => finOutline(sp, prof, f));
  for (const f of fins) for (const p of f.outer) { ymax = Math.max(ymax, Math.abs(p[1]) + 0.03); xmin = Math.min(xmin, p[0] - 0.02); }
  const tail = caudalOutline(sp, prof);
  for (const p of tail) ymax = Math.max(ymax, Math.abs(p[1]) + 0.03);
  if (sp.pelvic) for (const p of pelvicOutline(sp, prof).outline) ymax = Math.max(ymax, Math.abs(p[1]) + 0.03);
  const xmax = SHEET_X_MAX, W = SHEET_W, H = Math.ceil((W * (2 * ymax)) / (xmax - xmin));
  const c = makeCanvas(W, H), g = context2d(c);
  const k = W / (xmax - xmin);
  g.setTransform(k, 0, 0, -k, -xmin * k, ymax * k);
  g.lineJoin = 'round';
  // Relief at half resolution, in the same layout: the rays are raised and stiffer than the membrane.
  // It becomes the fins' normal map, and their thickness (rays block more backlight: dark lines on a
  // glowing membrane) and roughness (finMaps below).
  const HW = W / 2, HH = Math.ceil(H / 2), hcv = makeCanvas(HW, HH), hg = context2d(hcv);
  hg.fillStyle = '#000'; hg.fillRect(0, 0, HW, HH);
  hg.setTransform(k / 2, 0, 0, -k / 2, (-xmin * k) / 2, (ymax * k) / 2);
  hg.lineCap = 'round'; hg.strokeStyle = '#fff';
  const rng = mulberry32(sp.id.length * 31 + 5);

  const meshes: FinMeshSpec[] = [];   // { rays, n }: ray field per fin, for the 3D membrane
  const tubes: TubeSpec[] = [];       // spines and rays modelled as tapered tubes (tubeGeometry)
  const drawFin = (spec: SheetFin, outlinePts: P2[], rays: Rays, mer: RayCount = {}, marginPts: P2[] | null = null): void => {
    g.save();
    g.beginPath(); smoothPath(g, outlinePts, true);
    const xs = outlinePts.map((p) => p[0]);
    g.fillStyle = finFill(g, spec.fill, Math.min(...xs), Math.max(...xs));
    g.fill();
    g.clip();
    g.globalAlpha = 1;
    const quad = (a: number, b: number): void => {
      const [a0, a1] = rays(a), [b0, b1] = rays(b);
      g.beginPath();
      g.moveTo(...a0); g.lineTo(...a1); g.lineTo(...b1); g.lineTo(...b0);
    };
    for (const pnt of spec.paint || []) {
      g.fillStyle = pnt.color;
      quad(pnt.t0, pnt.t1);
      g.closePath(); g.fill();
    }
    if (spec.band) {
      g.fillStyle = spec.band.color;
      quad(spec.band.t, spec.band.t + spec.band.w);
      g.fill();
    }
    if (spec.spots) {
      g.fillStyle = spec.spots;
      // spotR: mean spot radius (TL); spotN: how many.
      const sr = spec.spotR ?? 0.013;
      for (let i = 0; i < (spec.spotN ?? 40); i++) {
        const [a, b] = rays(rng());
        const t = rng();
        g.beginPath(); g.arc(lerp(a[0], b[0], t), lerp(a[1], b[1], t), sr * (0.6 + 0.8 * rng()), 0, Math.PI * 2); g.fill();
      }
    }
    if (spec.spot) {
      const [a, b] = rays(spec.spot.t);
      const px = lerp(a[0], b[0], spec.spot.h), py = lerp(a[1], b[1], spec.spot.h);
      if (spec.spot.ring) { g.fillStyle = spec.spot.ring; g.beginPath(); g.arc(px, py, spec.spot.r * 1.35, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = spec.spot.color; g.beginPath(); g.arc(px, py, spec.spot.r, 0, Math.PI * 2); g.fill();
    }
    // Ray count: from the species' meristics (spines + soft rays) when known, else by fin size.
    const n = mer.n ?? Math.round(clamp(10 + (Math.max(...xs) - Math.min(...xs)) * 18, 10, 20));
    const spines = mer.spines || 0;
    // Membrane: a thin pigmented film, densest at the base and thinning towards the free margin, so
    // more of the light behind it passes through near the edge.
    let bc: P2 = [0, 0], oc: P2 = [0, 0];
    for (let i = 0; i <= 8; i++) { const [a, b] = rays(i / 8); bc = [bc[0] + a[0] / 9, bc[1] + a[1] / 9]; oc = [oc[0] + b[0] / 9, oc[1] + b[1] / 9]; }
    // spec.solid: a thick, skin-covered fin fold (morays), opaque to the margin. spec.thin: how much the
    // film thins by the margin (0.38; tangs' fins stay nearly opaque).
    const a0 = spec.solid ? 1 : Math.min(0.95, (spec.alpha ?? 0.9) + 0.05);
    g.globalCompositeOperation = 'destination-out';
    const mg = g.createLinearGradient(bc[0], bc[1], oc[0], oc[1]);
    for (let s = 0; s <= 4; s++) mg.addColorStop(s / 4, `rgba(0,0,0,${spec.solid ? 0 : 1 - a0 * (1 - (spec.thin ?? 0.38) * (s / 4) ** 2)})`);
    g.fillStyle = mg; g.fillRect(-1, -1, 2, 2);
    // Spiny fins: the membrane is incised between the spine tips, which stand free.
    g.fillStyle = '#000';
    for (let i = 0; i < spines - 1 && i < n; i++) {
      const [ba, ta] = rays(i / n), [bb, tb] = rays((i + 1) / n);
      const deep: P2 = [lerp(lerp(ta[0], tb[0], 0.5), lerp(ba[0], bb[0], 0.5), 0.3), lerp(lerp(ta[1], tb[1], 0.5), lerp(ba[1], bb[1], 0.5), 0.3)];
      const out = (t: P2, b: P2): P2 => [t[0] + (t[0] - b[0]) * 0.3, t[1] + (t[1] - b[1]) * 0.3];
      g.beginPath(); g.moveTo(...ta); g.lineTo(...out(ta, ba)); g.lineTo(...out(tb, bb)); g.lineTo(...tb); g.lineTo(...deep); g.closePath(); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    // Fin rays, more opaque than the membrane, and raised (the relief layer: the light picks out their
    // edges as it really falls, rather than a painted lit edge that stays lit on the shadow side).
    // Spines are single, stiff and unjointed; soft rays (lepidotrichia) are jointed and branch towards
    // the margin (the outermost principal caudal rays stay simple).
    const rayCol = spec.rays || 'rgba(35,20,5,0.13)';
    const line = (a: P2, b: P2, w: number, col: string): void => {
      g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      if (spec.solid) return;   // a moray's skin-covered fin fold: smooth
      hg.lineWidth = w * 1.3; hg.globalAlpha = Math.min(1, g.globalAlpha * 1.4); hg.setLineDash(g.getLineDash());
      hg.beginPath(); hg.moveTo(a[0], a[1]); hg.lineTo(b[0], b[1]); hg.stroke();
    };
    for (let i = 0; i <= n; i++) {
      const t = i / n, [a, b] = rays(t);
      if (i < spines) {
        g.setLineDash([]);
        line(a, b, 0.0045, rayCol);
        continue;
      }
      g.setLineDash([0.035, 0.0012]);   // soft-ray joints
      const simple = mer.simpleEnds && (i === 0 || i === n);
      const m = simple ? b : lerp2(a, b, 0.55), q = lerp2(a, b, 0.2);
      g.globalAlpha = 0.35;   // rays crowd together at the base; they read fainter there
      line(a, q, 0.0026, rayCol);
      g.globalAlpha = 1;
      line(q, m, 0.0026, rayCol);
      if (!simple) for (const s of [-1, 1]) line(m, rays(clamp(t + (s * 0.22) / n, 0, 1))[1], 0.0018, rayCol);
    }
    g.setLineDash([]); hg.setLineDash([]); hg.globalAlpha = 1;
    g.restore();
    meshes.push({ rays, n });
    if (spec.edge) {
      // Pigmented margin (e.g. the clownfish's black submarginal band), edgeW wide, optionally with
      // a narrow translucent unpigmented fringe outside it. Only the free margin, not the base.
      const ew = spec.edgeW || 0.006, fw = spec.fringe ? spec.fringeW || 0.008 : 0;
      g.save();
      g.beginPath(); smoothPath(g, outlinePts, true); g.clip();
      g.beginPath(); smoothPath(g, marginPts || outlinePts, !marginPts);
      g.globalAlpha = 0.95;
      g.strokeStyle = spec.edge; g.lineWidth = 2 * (ew + fw); g.stroke();
      if (fw && spec.fringe) {
        g.globalAlpha = 1; g.lineWidth = 2 * fw;
        g.globalCompositeOperation = 'destination-out'; g.stroke();
        g.globalCompositeOperation = 'source-over'; g.strokeStyle = spec.fringe; g.stroke();
      }
      g.restore();
    }
  };
  const meristics = (name: Meristic | 'pelvic' | undefined): RayCount => {
    const m: FinCount | undefined = name ? sp.anatomy?.[name] : undefined;
    return m ? { spines: m.spines || 0, n: (m.spines || 0) + m.rays - 1 } : {};
  };

  // Caudal fin first (behind the body).
  {
    const xp = prof.xPed + 0.02;
    const edge = tail.slice(1, -1);
    const rays: Rays = (t) => [[xp, lerp(prof.half(1) * 0.8, -prof.half(1) * 0.8, t)], along(edge, t)];
    // 17 principal caudal rays (9 + 8, the outer two unbranched) in nearly all spiny-rayed fishes.
    drawFin(sp.caudal, tail, rays, { n: (sp.anatomy?.caudalRays ?? CAUDAL_PRINCIPAL_RAYS) - 1, simpleEnds: true }, tail);
  }

  sp.fins.forEach((spec, i) => {
    const f = fins[i];
    if (!f) return;
    if (spec.kind === 'spines') {
      paintSpineFin(g, prof, spec, meshes, tubes);
      return;
    }
    const outline = [...f.base, ...f.outer.slice().reverse()];
    const rays: Rays = (t) => {
      // Interpolate the outer edge at t.
      const pts = spec.pts;
      let j = 0;
      while (j < pts.length - 2 && (pts[j + 1]?.[0] ?? 0) < t) j++;
      const p0 = pts[j]?.[0] ?? 0, p1 = pts[j + 1]?.[0] ?? 0;
      const tt = clamp((t - p0) / Math.max(1e-6, p1 - p0), 0, 1);
      const o = lerp2(pt(f.outer, j), pt(f.outer, j + 1), tt);
      return [along(f.base, t), o];
    };
    drawFin(spec, outline, rays, meristics(spec.meristic), f.outer);
  });

  if (sp.pelvic) {
    // Paired pelvic fins: painted once in side view, meshed twice and splayed out from the belly.
    const pv = pelvicOutline(sp, prof);
    drawFin(sp.pelvic, pv.outline, pv.rays, meristics('pelvic'), pv.outline.slice(1, -1));   // distal margin, not the spine
    const lastMesh = meshes[meshes.length - 1];
    if (lastMesh) lastMesh.xforms = pv.xforms;
  }

  return { canvas: c, xmin, xmax, ymax, meshes, tubes, ...(cachedMaps ? {} : finMaps(hcv)) };
}

// Free spines (3D tubes, below) joined only near the base by a low, deeply incised web; each spine
// carries a membrane flag along its rear edge (lionfish), banded like the spine.
function paintSpineFin(g: CanvasRenderingContext2D, prof: Profile, spec: SpineFin, meshes: FinMeshSpec[], tubes: TubeSpec[]): void {
  const S = spineLayout(prof, spec), N = S.length;
  const spine = (i: number): SpinePlacement => {
    const s = S[i];
    if (!s) throw new RangeError(`spine ${i} of ${N}`);
    return s;
  };
  const at = (s: SpinePlacement, k: number): P2 => lerp2(s.b, s.tip, k);
  const rays: Rays = (t) => {
    const k = t * (N - 1), j = Math.min(N - 2, Math.floor(k)), q = k - j;
    const a = spine(j), b = spine(j + 1);
    return [lerp2(at(a, 0), at(b, 0), q), lerp2(at(a, 1), at(b, 1), q)];
  };
  const web = spec.web ?? 0.3, alpha = spec.alpha ?? 0.6;
  g.save();
  g.fillStyle = spec.fill; g.globalAlpha = alpha;
  g.beginPath(); g.moveTo(...spine(0).b);
  for (let i = 0; i < N; i++) {
    g.lineTo(...at(spine(i), web));
    if (i < N - 1) { const m = rays((i + 0.5) / (N - 1)); g.lineTo(lerp(m[0][0], m[1][0], web * 0.45), lerp(m[0][1], m[1][1], web * 0.45)); }
  }
  g.lineTo(...spine(N - 1).b); g.closePath(); g.fill();
  const flag = spec.flag ?? 0, fl = spec.flagLen ?? 0.85;
  for (const s of S) {
    if (!flag) break;
    const back: P2 = [-Math.cos(s.a), -Math.sin(s.a)], w = flag * s.len;
    const edge: P2[] = [];
    for (let q = 0; q <= 10; q++) {
      const k = (q / 10) * fl, p = at(s, k), ww = w * Math.sin(Math.PI * Math.min(1, (k / fl) * 0.85 + 0.15)) ** 0.6;
      edge.push([p[0] + back[0] * ww, p[1] + back[1] * ww]);
    }
    g.save();
    g.beginPath(); g.moveTo(...s.b); for (const p of edge) g.lineTo(...p); g.lineTo(...at(s, fl)); g.closePath();
    g.globalAlpha = alpha; g.fill(); g.clip();
    if (spec.stripes) {
      // Bands across spine and flag together, about one per 0.025 TL.
      const nb = Math.max(3, Math.round(s.len / 0.025));
      g.globalAlpha = 0.85; g.strokeStyle = spec.stripes; g.lineWidth = s.len / nb * 0.5;
      for (let q = 0; q < nb; q++) {
        const p = at(s, (q + 0.5) / nb);
        g.beginPath(); g.moveTo(...p); g.lineTo(p[0] + back[0] * w * 1.3, p[1] + back[1] * w * 1.3); g.stroke();
      }
    }
    g.restore();
  }
  g.restore();
  // Erectile spines: each turns about its base, back to `foldTo` (deg from vertical, flat along the
  // back) when lowered and forward by `raise` deg past its drawn lean when raised (FISH_ERECT). The
  // web between two spines turns with them, by the angle interpolated across it.
  const fold = THREE.MathUtils.degToRad(spec.foldTo ?? 86), raise = -THREE.MathUtils.degToRad(spec.raise ?? 10);
  const erect = (t: number): Erect4 => {
    const k = t * (N - 1), j = Math.min(N - 2, Math.floor(k)), q = k - j, b = rays(t)[0];
    return [b[0], b[1], fold - lerp(spine(j).a, spine(j + 1).a, q), raise];
  };
  meshes.push({ rays, n: N - 1, erect });
  // The spines themselves, on the membrane's pleat ridges (see finMesh) so they stay on the web.
  S.forEach((s, i) => {
    const z = 0.035 * s.len * Math.cos(Math.PI * i);
    const bend = spec.bend ?? 0.06, nrm: P2 = [Math.cos(s.a), Math.sin(s.a)];
    const mid = at(s, 0.5);
    tubes.push({
      pts: [[...s.b, 0], [mid[0] - nrm[0] * bend * s.len, mid[1] - nrm[1] * bend * s.len, z * 0.5], [...s.tip, z]],
      r0: spec.r ?? 0.005, r1: (spec.r ?? 0.005) * 0.2, color: spec.color || spec.fill, stripes: spec.stripes,
      nb: spec.stripes ? Math.max(3, Math.round(s.len / 0.025)) : 0,
      erect: [s.b[0], s.b[1], fold - s.a, raise],
    });
  });
}

/** Slope per texel of full relief (a ray ~3 texels wide: its flanks tilt ~25 degrees). */
const RAY_RELIEF_SLOPE = 0.9;

// From the fins' relief layer (white = ray): a tangent-space normal map (each ray a rounded ridge), and
// one data map, R = thickness (rays ~4x the membrane, read by the tissue light term) and G = roughness
// (rays 0.33, membrane 0.45; roughnessMap reads G).
export function finMaps(src: HTMLCanvasElement): { normal: HTMLCanvasElement; data: HTMLCanvasElement } {
  const w = src.width, h = src.height, soft = makeCanvas(w, h), sg = context2d(soft, { willReadFrequently: true });
  sg.filter = 'blur(1px)'; sg.drawImage(src, 0, 0); sg.filter = 'none';
  const H = sg.getImageData(0, 0, w, h).data, nImg = new ImageData(w, h), dImg = new ImageData(w, h);
  const at = (x: number, y: number): number => (H[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4] ?? 0) / 255;
  const S = RAY_RELIEF_SLOPE, nd = nImg.data, dd = dImg.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, hx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * S, hy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * S;
    const nx = -hx, ny = hy, inv = 1 / Math.sqrt(nx * nx + ny * ny + 1), r = at(x, y);
    nd[o] = (nx * inv * 0.5 + 0.5) * 255; nd[o + 1] = (ny * inv * 0.5 + 0.5) * 255; nd[o + 2] = (inv * 0.5 + 0.5) * 255; nd[o + 3] = 255;
    dd[o] = r * 255; dd[o + 1] = (0.45 - 0.12 * r) * 255; dd[o + 3] = 255;
  }
  const normal = makeCanvas(w, h), data = makeCanvas(w, h);
  context2d(normal).putImageData(nImg, 0, 0); context2d(data).putImageData(dImg, 0, 0);
  return { normal, data };
}

// Pelvic fin in side view: inserted on the belly just behind the pectoral base, the spine as its leading
// edge, rays fanning back and down. sp.pelvic: { u, len (TL), angle (deg below backwards), base, splay }.
export function pelvicOutline(sp: Species, prof: Profile): PelvicShape {
  const p = sp.pelvic;
  if (!p) throw new Error(`${sp.id} has no pelvic fins`);
  const len = sp.body.len, base = p.base ?? 0.03;
  const belly = (x: number): number => { const u = (0.5 - x) / len; return prof.centre(u) - prof.half(u) * 0.9; };
  const x0 = prof.x(p.u);
  const b = (t: number): P2 => { const x = x0 - t * base; return [x, belly(x)]; };
  // Ray direction and length across the fin: the spine is steep and shorter, the longest ray about a
  // third of the way back, the last rays shallow and short.
  const ang = (t: number): number => THREE.MathUtils.degToRad(lerp(p.angle + 22, p.angle - 18, t));
  const rlen = (t: number): number => p.len * (0.7 + 1.3725 * t - 1.4725 * t * t);
  const tip = (t: number): P2 => { const o = b(t), a = ang(t), r = rlen(t); return [o[0] - Math.cos(a) * r, o[1] - Math.sin(a) * r]; };
  const outer: P2[] = [];
  for (let i = 0; i <= 12; i++) outer.push(tip(i / 12));
  const outline = [b(0), ...outer, b(1)];
  const xforms = [1, -1].map((side) => {
    const by = b(0.5)[1], z = side * prof.width(p.u) * 0.35;
    return new THREE.Matrix4().makeTranslation(0, by, z)
      .multiply(new THREE.Matrix4().makeRotationX(-side * (p.splay ?? 0.35)))
      .multiply(new THREE.Matrix4().makeTranslation(0, -by, 0));
  });
  return { outline, rays: (t) => [b(t), tip(t)], xforms };
}
