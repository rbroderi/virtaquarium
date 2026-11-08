// Species catalogue: anatomy (for mesh + texture generation) and temperament (for the brain).
//
// Anatomy is in normalised units where total length = 1, nose at x=+0.5, tail tip at x=-0.5.
// Body runs from u=0 (nose) to u=1 (caudal peduncle). Pattern coordinates are (u, v) where
// v=-1 is the dorsal (top) outline and v=+1 the ventral (bottom) outline at that u.
//
// Temperament values are 0..1. Sizes are real aquarium-specimen lengths in world units
// (1 unit = 12.5 cm); speeds come from the SWIM table at the bottom of this file.
//
// Species fitted to reference photos have their shape overridden by src/anatomy/<id>.ts.

import { applyFitted } from './anatomy/index.js';
import { DEG_TO_RAD } from './core/math.js';
import type { MotionTable, NightColour, Pace, SkinTable, Species, SpeciesDefinition, Swim, SwimTable } from './species/types.js';

export type * from './species/types.js';
const DEFINITIONS: SpeciesDefinition[] = [
  {
    id: 'clownfish', name: 'Ocellaris Clownfish', sci: 'Amphiprion ocellaris',
    fact: 'Lives among anemone tentacles, protected by a mucus coat that stops the sting.',
    size: 0.62, count: 3,
    // Published: body depth 2.1-2.4 in SL; D X-XI,13-17; A II,11-13; P 16-18; V I,5; LL 34-48; caudal
    // rounded (FishBase morphology, Allen 1991; Fishes of Australia). tools/fit-anatomy.ts fits the
    // silhouette to web/ref/clownfish within these bounds (src/anatomy/clownfish.ts).
    anatomy: { bodyDepthSL: [0.42, 0.48], dorsal: { spines: 11, rays: 15 }, anal: { spines: 2, rays: 12 }, pectoralRays: 17, pelvic: { spines: 1, rays: 5 } },
    // Linear gain on the orange (carotenoid) colours so body/white matches the reference photos (lab
    // white-referenced patches, median of 4 photos, 2026-11-04): photos ~(1.0, 0.145, 0.003) x white.
    albedoGain: [0.91, 0.6, 0.125],
    body: { len: 0.8, depth: 0.42, width: 0.42, m: 0.4, headP: 0.7, tailP: 1.3, ped: 0.45 },
    // Eye measured on krisp_side and spekking_side: orbit radius ~0.035 TL, dark inner iris to ~0.67 of
    // it, pupil ~0.46; the outer iris is orange like the head.
    eye: { u: 0.12, v: -0.28, r: 0.036, iris: '#f08a2a', irisR: 0.98, pupil: 0.46, fleck: '#2a1a10', fleckR: 0.68 },
    pattern: [
      { op: 'vgrad', stops: [[-1, '#f06e12'], [0, '#ff7a14'], [1, '#f7a050']] },
      { op: 'band', u: 0.2, w: 0.1, curve: -0.07, color: '#ffffff', edge: '#121212', ew: 0.007 },
      { op: 'band', u: 0.52, w: 0.1, curve: 0.06, color: '#ffffff', edge: '#121212', ew: 0.007 },
      { op: 'band', u: 0.93, w: 0.07, curve: 0, color: '#ffffff', edge: '#121212', ew: 0.007 },
    ],
    fins: [
      { pos: 'top', meristic: 'dorsal', u0: 0.3, u1: 0.96, pts: [[0, 0.04], [0.15, 0.12], [0.3, 0.1], [0.45, 0.06], [0.55, 0.11], [0.8, 0.12], [1, 0.03]], sweep: 0.2, fill: '#f7801f', edge: '#121212', edgeW: 0.018, fringe: 'rgba(235,240,245,0.22)', fringeW: 0.006 },
      { pos: 'bottom', meristic: 'anal', u0: 0.62, u1: 0.94, pts: [[0, 0.03], [0.3, 0.12], [0.7, 0.11], [1, 0.03]], sweep: 0.3, fill: '#f7801f', edge: '#121212', edgeW: 0.016, fringe: 'rgba(235,240,245,0.22)', fringeW: 0.006 },
    ],
    caudal: { type: 'round', spread: 0.17, fill: '#f7801f', edge: '#121212', edgeW: 0.022, fringe: 'rgba(235,240,245,0.25)', fringeW: 0.012 },
    pelvic: { u: 0.31, len: 0.16, angle: 38, base: 0.03, splay: 0.35, fill: '#f7801f', alpha: 0.9, edge: '#121212', edgeW: 0.014 },
    pectoral: { kind: 'round', u: 0.3, v: 0.15, len: 0.15, w: 0.08, fill: '#ff8a2a', alpha: 0.85, edge: '#121212', edgeW: 0.012 },
    brain: { maxSpeed: 1.2, turn: 4.0, zone: [0.45, 1.0], school: 0.3, grazer: 0.3, territorial: 0.5, boldness: 0.6, curiosity: 0.6, activity: 0.7, host: true, prey: true, tailHz: 5.0 },
  },
  {
    // bodyDepthSL below (bluetang..coralbeauty): approximate published body depth / SL ranges (FishBase
    // species summaries); they bound the shape fit (tools/fit-anatomy.ts).
    id: 'bluetang', name: 'Pacific Blue Tang', sci: 'Paracanthurus hepatus',
    fact: 'A grazing surgeonfish: the scalpel-like spine by its tail is used in territorial spats.',
    size: 1.05, count: 2,
    anatomy: { bodyDepthSL: [0.4, 0.5] },
    albedoGain: [0.96, 1.014, 0.975],   // lab patch comparison (chromaticity, 7 patches), half strength
    body: { len: 0.78, depth: 0.5, width: 0.3, m: 0.38, headP: 0.6, tailP: 1.2, ped: 0.3 },
    eye: { u: 0.1, v: -0.28, r: 0.04, iris: '#1a1a40' },
    mouth: { u: 0.05, v: 0.32, v0: 0.22 },   // small, low on the face
    // The caudal spine: a pale blade folded into a groove on the peduncle, where the yellow begins.
    scalpel: { u: 0.93, v: 0.0, len: 0.055, color: '#e8dc98' },
    pattern: [
      { op: 'vgrad', stops: [[-1, '#1d3db8'], [0, '#2b5fe6'], [1, '#4a86f5']] },
      { op: 'poly', color: '#0b0c1a', pts: [[0.1, -0.35], [0.25, -0.72], [0.5, -0.84], [0.75, -0.72], [0.9, -0.45], [0.97, -0.2], [0.97, 0.25], [0.88, 0.08], [0.78, 0.02], [0.65, 0.32], [0.48, 0.46], [0.32, 0.36], [0.33, 0.16], [0.45, 0.22], [0.58, 0.1], [0.66, -0.15], [0.62, -0.42], [0.48, -0.52], [0.33, -0.42], [0.2, -0.15]] },
      { op: 'poly', color: '#ffd21a', pts: [[0.97, -0.6], [1.02, -1], [1.02, 1], [0.97, 0.6]] },
    ],
    fins: [
      { pos: 'top', u0: 0.2, u1: 0.96, pts: [[0, 0.03], [0.2, 0.1], [0.6, 0.1], [0.9, 0.08], [1, 0.02]], sweep: 0.2, fill: '#2b5fe6', edge: '#0b0c1a', edgeW: 0.009 },
      { pos: 'bottom', u0: 0.5, u1: 0.96, pts: [[0, 0.03], [0.3, 0.1], [0.8, 0.08], [1, 0.02]], sweep: 0.2, fill: '#2b5fe6', edge: '#0b0c1a', edgeW: 0.009 },
    ],
    caudal: { type: 'lunate', spread: 0.2, fill: '#ffd21a', edge: '#0b0c1a', edgeW: 0.0105 },
    pectoral: { u: 0.28, v: 0.15, len: 0.15, w: 0.08, fill: '#f2d040', alpha: 0.8 },
    brain: { maxSpeed: 1.9, turn: 3.0, zone: [0.2, 0.8], school: 0.25, grazer: 0.7, territorial: 0.2, boldness: 0.4, curiosity: 0.5, activity: 0.8, tailHz: 3.0 },
  },
  {
    id: 'yellowtang', name: 'Yellow Tang', sci: 'Zebrasoma flavescens',
    fact: 'Spends most of the day grazing algae from rock, which keeps reefs healthy.',
    size: 0.95, count: 2,
    anatomy: { bodyDepthSL: [0.5, 0.6] },
    albedoGain: [0.917, 1.025, 0.978],   // lab patch comparison (chromaticity, 6 patches), half strength
    // Strongly compressed with a lens-shaped section (flank 1.7: thin, sharp-edged; the default for this
    // width, ~1.2, shades like a ball up close); the snout is a flattened cone filleted into the face, and
    // the head narrows to a wedge at the front (headW), as seen head-on.
    body: { len: 0.78, depth: 0.78, width: 0.2, flank: 1.7, m: 0.42, headP: 0.9, tailP: 1.6, ped: 0.22, snout: 0.06, snoutH: 0.05, snoutW: 0.55, snoutTip: 0.45, snoutBlend: 0.03, headW: 0.6 },
    eye: { u: 0.215, v: -0.55, r: 0.04, iris: '#2a2a20' },   // high under the steep forehead (viatour.jpg blend, with body.mouth)
    // The white caudal spine, folded into its groove on the peduncle (the tang's 'scalpel').
    scalpel: { u: 0.955, v: -0.02, len: 0.07, color: '#f6f4ec' },
    pattern: [
      { op: 'vgrad', stops: [[-1, '#ffe14a'], [0, '#ffd400'], [1, '#f2c000']] },
    ],
    fins: [
      // The fins are as opaque and saturated as the body (the photos), so body and fins read as one disc.
      { pos: 'top', u0: 0.18, u1: 0.96, pts: [[0, 0.05], [0.15, 0.22], [0.45, 0.25], [0.75, 0.2], [1, 0.03]], sweep: 0.25, fill: '#ffd400', rays: '#eec400', thin: 0.1 },
      { pos: 'bottom', u0: 0.45, u1: 0.96, pts: [[0, 0.03], [0.3, 0.2], [0.7, 0.18], [1, 0.03]], sweep: 0.25, fill: '#ffd400', rays: '#eec400', thin: 0.1 },
    ],
    caudal: { type: 'truncate', spread: 0.2, fill: '#ffd400', rays: '#eec400', thin: 0.15 },
    pectoral: { u: 0.32, v: 0.1, len: 0.14, w: 0.08, fill: '#ffe36a', alpha: 0.7 },
    brain: { maxSpeed: 1.7, turn: 3.0, zone: [0.3, 0.95], school: 0.3, grazer: 0.9, territorial: 0.3, boldness: 0.5, curiosity: 0.5, activity: 0.75, tailHz: 3.0 },
  },
  {
    id: 'moorishidol', name: 'Moorish Idol', sci: 'Zanclus cornutus',
    fact: 'Named by Moors who believed it a bringer of happiness; trails a long white dorsal filament.',
    size: 1.0, count: 2,
    anatomy: { bodyDepthSL: [0.7, 1.0] },
    albedoGain: [0.933, 1.015, 1.0],   // lab patch comparison (white-referenced, 6 patches), half strength
    // Shape measured off the side-on photos (zerpe.jpg): most of the idol's height is its dorsal and
    // anal fins; the body proper is about 0.8 SL deep, deepest just over halfway back.
    body: { len: 0.74, depth: 0.6, width: 0.2, m: 0.46, headP: 1.15, tailP: 1.2, ped: 0.16, snout: 0.19, snoutH: 0.034,
      snoutTip: 0.75, snoutBlend: 0.04 },   // the tube narrows to the mouth and runs smoothly into the steep face
    eye: { u: 0.35, v: -0.6, r: 0.03, iris: '#1a1a1a' },
    // Photo order from the snout: black lips, an orange saddle, a white face, the black head band
    // (the eye in it), yellow, the black rear band, a thin yellow strip, the white peduncle.
    pattern: [
      { op: 'vgrad', stops: [[-1, '#f7f4ea'], [1, '#ece5d2']] },
      { op: 'blob', u: 0.65, v: 0.0, ru: 0.12, rv: 1.4, color: '#f5d33a', soft: 0.6 },
      { op: 'band', u: 0.405, w: 0.27, curve: 0.03, color: '#151515', edge: '#ffffff', ew: 0.01 },
      { op: 'band', u: 0.83, w: 0.15, curve: 0.0, color: '#151515', edge: '#ffffff', ew: 0.01 },
      { op: 'band', u: 0.93, w: 0.035, curve: 0.0, color: '#f5d33a' },
      { op: 'band', u: 0.02, w: 0.05, curve: 0.0, color: '#151515' },
      { op: 'poly', color: '#f08a2a', pts: [[0.12, -1.1], [0.19, -1.1], [0.19, -0.2], [0.12, -0.2]] },
    ],
    fins: [
      // The dorsal rises off the back and sweeps straight back into the white filament, which trails
      // well past the tail; its rear edge runs down the back of the body to the peduncle. Points are
      // [t, h, back] off the photo outline.
      { pos: 'top', u0: 0.566, u1: 0.955, pts: [[0, 0.009, 0], [0.02, 0.035, 0.095], [0.04, 0.056, 0.2], [0.06, 0.072, 0.305], [0.08, 0.083, 0.445], [0.1, 0.082, 0.658], [0.12, 0.077, 0.834], [0.14, 0.078, 0.646], [0.16, 0.079, 0.422], [0.18, 0.068, 0.233], [0.2, 0.05, 0.167], [0.3, 0.023, 0.124], [0.5, 0.004, 0.085], [0.75, 0.003, 0.043], [1, 0.002, 0.005]],
        fill: '#f7f4ea', paint: [{ t0: 0.155, t1: 0.21, color: '#151515' }, { t0: 0.21, t1: 1, color: '#f5d33a' }] },
      // The anal: the same sweep below, black with a yellow rear edge.
      { pos: 'bottom', u0: 0.598, u1: 0.955, pts: [[0, 0.002, 0], [0.1, 0.01, 0.074], [0.2, 0.025, 0.141], [0.3, 0.008, 0.133], [0.5, 0.004, 0.091], [0.75, 0.003, 0.049], [1, 0.002, 0.008]],
        fill: '#f5d33a', paint: [{ t0: 0, t1: 0.3, color: '#151515' }] },
    ],
    caudal: { type: 'forked', spread: 0.105, tip: -0.44, fill: '#151515', edge: '#f7f4ea', edgeW: 0.0075 },
    pectoral: { u: 0.5, v: 0.1, len: 0.12, w: 0.07, fill: '#f7f4ea', alpha: 0.6 },
    brain: { maxSpeed: 1.4, turn: 2.5, zone: [0.2, 0.85], school: 0.45, grazer: 0.6, territorial: 0.1, boldness: 0.4, curiosity: 0.5, activity: 0.7, tailHz: 2.6 },
  },
  {
    id: 'lionfish', name: 'Red Lionfish', sci: 'Pterois volitans',
    fact: 'Hovers almost motionless, fanning venomous spines; an ambush hunter at dusk.',
    size: 1.45, count: 1,
    // Dorsal XIII + 11, anal III + 7, pectoral 14 unbranched rays, pelvic I + 5 (Schultz 1986; FishBase).
    anatomy: { bodyDepthSL: [0.28, 0.38], dorsalSoft: { spines: 0, rays: 11 }, anal: { spines: 3, rays: 7 }, pectoralRays: 14, pelvic: { spines: 1, rays: 5 } },
    albedoGain: [1.131, 0.8, 1.0],   // lab patch comparison (white-referenced, 4 patches), half strength
    // Proportions in SL (u runs over SL: len 0.765 TL, the caudal fin the other 0.235), from side-on photos
    // and renders of lionfish models: eye 0.06 across, its centre 0.25 behind the snout and almost on the
    // dorsal profile; gill margin about 0.38; supraocular tentacles about 0.2; the longest dorsal spines
    // 0.37-0.5 (1.1-1.7 body depths). mouth: the snout tip sits low; headW: a narrow, compressed face.
    // section: head-on the face is a blunt wedge, the cheeks widest and the forehead a narrow ridge
    // between the eyes (about half the cheek width).
    // outline: the trunk is level and the head hangs off it nose-down (snout about 0.14 TL below the trunk
    // axis, head centre about 0.06, the head and trunk axes about 15 deg apart). The back climbs in three
    // steps: a steep snout up to the brow (u 0.13), a flat nape over the eye (u 0.2-0.33), then the hump
    // under the spines (peak u 0.52, max depth 0.33 TL); the belly is one nearly straight line from the
    // chin to the anal fin; the body tapers concave to a peduncle about a third of the body depth.
    // widthCurve: from above the head is broadest across the cheeks (about 0.15 TL) and the trunk nearly
    // as broad, tapering to a narrow snout; egg: the head's section is broadest low (the cheeks), the
    // trunk's high (over the back). cover: the gill cover lies flush, its margin a soft edge.
    body: { len: 0.765, depth: 0.27, width: 0.42, m: 0.3, headP: 0.6, tailP: 1.0, ped: 0.33, mouth: -0.45, headW: 0.5,
      section: { u0: 0, u1: 0.34, ease: 0.07, lo: -0.6, hi: 0.2, round: 0.15, sharp: 0.8 },
      widthCurve: [[0, 0], [0.08, 0.1], [0.2, 0.5], [0.32, 0.55], [0.42, 0.4], [0.52, 0.25], [0.7, 0.1], [0.9, 0]],
      egg: [[0, 0.1], [0.28, 0.2], [0.42, 0], [0.55, -0.15], [0.8, -0.1], [1, 0]],
      cover: 0.012,
      outline: {
        top: [[0, -0.57], [0.016, -0.63], [0.033, -0.59], [0.065, -0.46], [0.098, -0.3], [0.131, -0.25], [0.163, -0.28], [0.196, -0.37],
          [0.261, -0.51], [0.327, -0.54], [0.392, -0.31], [0.458, -0.04], [0.523, 0.19], [0.588, 0.23], [0.654, 0.22], [0.719, 0.23],
          [0.784, 0.23], [0.85, 0.2], [0.915, 0.1], [0.961, 0.05], [1, 0.05]],
        bot: [[0, -0.405], [0.016, -0.27], [0.033, -0.24], [0.065, -0.195], [0.098, -0.19], [0.131, -0.21], [0.163, -0.2], [0.196, -0.19],
          [0.261, -0.16], [0.327, -0.14], [0.392, -0.13], [0.458, -0.2], [0.523, -0.23], [0.588, -0.23], [0.654, -0.22], [0.719, -0.18],
          [0.784, -0.15], [0.85, -0.12], [0.915, -0.1], [0.961, -0.1], [1, -0.11]],
      } },
    eye: { u: 0.25, v: -0.75, r: 0.024, iris: '#8a3a22', irisR: 0.98, pupil: 0.45, fleck: '#3a140a', fleckR: 0.8 },
    mouth: { u: 0.16, v: 0.85, v0: -0.3, lining: 0.018 },   // oblique, along the jaw edge, the corner under the front of the eye
    pattern: [
      { op: 'vgrad', stops: [[-1, '#f0e6dc'], [1, '#f8f2ea']] },
      // Body bars from the opercle back: broad red-brown, narrow pale gaps, leaning back at the top and
      // closer together towards the tail; some parted by a thin pale line, some forking into a Y over the back.
      { op: 'stripesV', u0: 0.31, u1: 1.0, n: 13, color: '#923f22', ratio: 0.64, lean: 10, dense: 0.3, split: [2, 6, 9], fork: [5], forkV: -0.4 },
      // Head lines at about twice the body's frequency, radiating from the eye: down and forward to the
      // lips, a broad bar straight down over the cheek, three back across the cheek to the preopercle,
      // and a few arcs over the forehead and nape.
      { op: 'rings', u: 0.25, v: -0.75, n: 3, r0: 0.04, dr: 0.022, w: 0.01, a0: -175, a1: -25, color: '#923f22', uMax: 0.35,
        spokes: [[90, 0.026], 112, 128, 144, 160, 176, 50, 66], spokeR0: 0.03, spokeR1: 0.2, spokeW: 0.011 },
      { op: 'blob', u: 0.45, v: 0.75, ru: 0.4, rv: 0.4, color: '#f5ece2', soft: 0.7 },
    ],
    // Mail-cheeked fish: a bony stay runs from under the eye back across the cheek to the preopercle, a
    // ridge arches over each eye and the lacrimal bone ridges the snout ahead of it.
    ridges: [
      { u0: 0.25, v0: -0.4, u1: 0.33, v1: -0.15, w: 0.008, h: 0.005 },   // suborbital stay
      { u0: 0.21, v0: -0.95, u1: 0.3, v1: -0.98, w: 0.007, h: 0.005 },   // supraorbital ridge
      { u0: 0.1, v0: -0.4, u1: 0.2, v1: -0.62, w: 0.006, h: 0.003 },   // lacrimal
      { u0: 0.31, v0: -0.4, u1: 0.33, v1: 0.45, w: 0.006, h: 0.003 },   // preopercle margin
    ],
    // A long, banded, leaf-like tentacle over each eye; fringed flaps hanging from the lacrimal over the
    // upper jaw and under the chin; short bony spines on the snout, over the eye, the nape and the
    // preopercle margin.
    appendages: [
      { u: 0.255, v: -0.97, len: 0.15, dir: [0.4, 1, 0.15], r: 0.0025, flat: 0.18, shape: 'frond', color: '#f2e8dc', stripes: '#8a3a1c', nb: 6, bend: -0.12 },
      { u: 0.13, v: 0.25, len: 0.03, dir: [0.35, -1, 0.5], r: 0.004, flat: 0.35, shape: 'leaf', color: '#efe3d6', stripes: '#8a3a1c', nb: 3 },
      { u: 0.04, v: 0.75, len: 0.016, dir: [0.3, -1, 0.4], r: 0.003, flat: 0.4, shape: 'leaf', color: '#efe3d6', stripes: '#8a3a1c', nb: 2 },
      { u: 0.12, v: 0.85, len: 0.014, dir: [0, -1, 0.5], r: 0.003, flat: 0.4, shape: 'leaf', color: '#efe3d6', stripes: '#8a3a1c', nb: 2 },
      { u: 0.1, v: -0.6, len: 0.012, dir: [0.6, 1, 0.3], r: 0.0018, color: '#f2e6d8', bend: 0 },   // nasal spine
      { u: 0.29, v: -0.98, len: 0.014, dir: [-0.4, 1, 0.3], r: 0.0018, color: '#f2e6d8', bend: 0 },   // supraocular spine
      { u: 0.33, v: -1.0, len: 0.016, dir: [-0.7, 1, 0.25], r: 0.002, color: '#f2e6d8', bend: 0 },   // parietal spine
      { u: 0.33, v: 0.2, len: 0.016, dir: [-1, -0.2, 0.4], r: 0.002, color: '#f2e6d8', bend: 0 },   // preopercular spines
      { u: 0.325, v: 0.5, len: 0.013, dir: [-1, -0.7, 0.4], r: 0.0018, color: '#f2e6d8', bend: 0 },
    ],
    // Venomous dorsal spines: carried up, flared further forward at a threat (and while stalking).
    erect: { rest: 1, alarm: 1.8 },
    fins: [
      // Spines from just behind the eye to 0.76; the soft dorsal and anal end at the peduncle.
      { pos: 'top', kind: 'spines', u0: 0.3, u1: 0.76, n: 13, h: 0.36, hs: [0.5, 0.8, 0.95, 1, 1, 0.96, 0.9, 0.8, 0.68, 0.55, 0.42, 0.3, 0.2], lean: [-12, 58], r: 0.0032, flag: 0.05, web: 0.25, fill: '#efe4d6', alpha: 0.75, color: '#f2e6d8', stripes: '#8a3a1c', raise: 15, foldTo: 82 },
      // Soft dorsal: about 0.17 SL high near its front, ending just ahead of the peduncle (side-on photos).
      { pos: 'top', meristic: 'dorsalSoft', u0: 0.76, u1: 0.97, pts: [[0, 0.08], [0.25, 0.13], [0.7, 0.11], [1, 0.03]], sweep: 0.2, fill: '#efe2d4', alpha: 0.4, spots: '#2a1a10', spotR: 0.0035, spotN: 120 },
      { pos: 'bottom', meristic: 'anal', u0: 0.75, u1: 0.94, pts: [[0, 0.03], [0.4, 0.14], [1, 0.03]], sweep: 0.3, fill: '#efe2d4', alpha: 0.45, spots: '#2a1a10', spotR: 0.0035, spotN: 90 },
    ],
    caudal: { type: 'round', spread: 0.16, fill: '#efe2d4', alpha: 0.35, spots: '#1a1410', spotR: 0.003, spotN: 220 },
    // Fans of 14 free, banded rays: the upper ones about 0.7-0.85 TL, the lowest about 0.35; membrane only
    // on the inner half. Held out like wings: the top ray swept about 25 deg back, the lowest straight back,
    // the fan's surface tilted about 45 deg down from the horizontal.
    pectoral: { kind: 'fan', u: 0.42, v: 0.15, len: 0.85, w: 0.3, fill: '#efe2d4', alpha: 0.6, stripes: '#8a3a1c', rayColor: '#f2e6d8', rayR: 0.0045, flag: 0.022, web: 0.5,
      rayLen: [[0, 0.86], [0.3, 1], [0.55, 0.86], [0.8, 0.6], [1, 0.42]], pose: { roll: 1.1, yaw: 0.55, flap: -0.2 },
      spots: '#20140c', spotR: 0.004, spotN: 50 },
    pelvic: { u: 0.41, len: 0.24, angle: 50, base: 0.03, splay: 0.4, fill: '#3a2a24', alpha: 0.85, spots: '#7d9ad6', spotR: 0.004, spotN: 50 },
    brain: { maxSpeed: 0.75, turn: 1.4, zone: [0.4, 1.0], school: 0, grazer: 0, territorial: 0.2, boldness: 0.95, curiosity: 0.4, activity: 0.3, hover: true, predator: true, nocturnal: true, tailHz: 1.5 },
  },
  {
    id: 'copperband', name: 'Copperband Butterflyfish', sci: 'Chelmon rostratus',
    fact: 'Uses its tweezer snout to pick tiny invertebrates from crevices; the false eyespot confuses predators.',
    size: 0.85, count: 1,
    albedoGain: [0.906, 1.179, 1.049],   // lab patch comparison (white-referenced, 28 patches), half strength
    body: { len: 0.76, depth: 0.6, width: 0.2, m: 0.45, headP: 1.1, tailP: 1.5, ped: 0.2, snout: 0.16, snoutH: 0.03,
      snoutTip: 0.85, snoutBlend: 0.03 },   // a beak of even thickness, filleted into the forehead
    eye: { u: 0.24, v: -0.3, r: 0.035, iris: '#222222' },
    pattern: [
      { op: 'vgrad', stops: [[-1, '#fbfaf3'], [1, '#efeadb']] },
      { op: 'band', u: 0.24, w: 0.07, curve: 0, color: '#f0861c', edge: '#2a1d14', ew: 0.012 },
      { op: 'band', u: 0.45, w: 0.12, curve: 0.03, color: '#f0861c', edge: '#2a1d14', ew: 0.012 },
      { op: 'band', u: 0.67, w: 0.12, curve: 0.03, color: '#f0861c', edge: '#2a1d14', ew: 0.012 },
      { op: 'band', u: 0.92, w: 0.07, curve: 0, color: '#1a1a1a', edge: '#f0861c', ew: 0.012 },
    ],
    fins: [
      { pos: 'top', u0: 0.3, u1: 0.96, pts: [[0, 0.04], [0.2, 0.18], [0.6, 0.22], [0.85, 0.18], [1, 0.04]], sweep: 0.35, fill: '#f2efe4', paint: [{ t0: 0.2, t1: 0.5, color: '#f0861c' }], spot: { t: 0.78, h: 0.55, r: 0.035, color: '#111111', ring: '#ffffff' } },
      { pos: 'bottom', u0: 0.55, u1: 0.96, pts: [[0, 0.04], [0.4, 0.18], [1, 0.04]], sweep: 0.3, fill: '#f2efe4', paint: [{ t0: 0.0, t1: 0.45, color: '#f0861c' }] },
    ],
    caudal: { type: 'truncate', spread: 0.16, fill: '#f2efe4', alpha: 0.55 },
    pectoral: { u: 0.38, v: 0.15, len: 0.11, w: 0.06, fill: '#f2efe4', alpha: 0.5 },
    brain: { maxSpeed: 1.2, turn: 3.0, zone: [0.5, 1.0], school: 0, grazer: 0.95, territorial: 0.2, boldness: 0.3, curiosity: 0.5, activity: 0.6, shy: 0.5, tailHz: 3.2 },
  },
  {
    id: 'royalgramma', name: 'Royal Gramma', sci: 'Gramma loreto',
    fact: 'Claims a crevice and defends it; often swims upside-down under ledges.',
    size: 0.5, count: 2,
    anatomy: { bodyDepthSL: [0.26, 0.36] },
    // Per-colour calibration (lab patches, 3 photos, 2026-11-04; half the median Lab difference, as a
    // linear gain): the purple is violet in every photo (b* -35 vs the render), the yellow a little richer.
    colourGain: [
      { hex: ['#b72aa6', '#9c2bb0', '#c23ab3'], gain: [0.923, 1.225, 1.505] },
      { hex: ['#ffcc1f', '#ffd52a'], gain: [0.946, 0.936, 0.5] },
    ],
    body: { len: 0.82, depth: 0.3, width: 0.5, m: 0.35, headP: 0.7, tailP: 1.0, ped: 0.5 },
    eye: { u: 0.1, v: -0.3, r: 0.05, iris: '#d0a020' },
    mouth: { u: 0.085, v: 0.22, v0: 0.0 },   // fairly large, oblique
    pattern: [
      { op: 'hgrad', stops: [[0, '#b72aa6'], [0.42, '#9c2bb0'], [0.56, '#ffcc1f'], [1, '#ffd52a']] },
      { op: 'poly', color: '#111111', pts: [[0, -0.42], [0.18, -0.32], [0.18, -0.24], [0, -0.3]] },
    ],
    fins: [
      { pos: 'top', u0: 0.2, u1: 0.96, pts: [[0, 0.03], [0.3, 0.08], [0.8, 0.1], [1, 0.03]], sweep: 0.2, fill: [[0, '#c23ab3'], [0.4, '#c23ab3'], [0.55, '#ffd52a'], [1, '#ffd52a']], spot: { t: 0.1, h: 0.5, r: 0.025, color: '#111111' } },
      { pos: 'bottom', u0: 0.5, u1: 0.96, pts: [[0, 0.03], [0.4, 0.1], [1, 0.03]], sweep: 0.2, fill: '#ffd52a' },
    ],
    caudal: { type: 'forked', spread: 0.15, fill: '#ffd52a' },
    pectoral: { u: 0.25, v: 0.15, len: 0.12, w: 0.06, fill: '#c23ab3', alpha: 0.6 },
    brain: { maxSpeed: 1.0, turn: 4.0, zone: [0.75, 1.0], school: 0, grazer: 0.3, territorial: 0.6, boldness: 0.2, curiosity: 0.4, activity: 0.6, shy: 0.9, prey: true, tailHz: 5.0 },
  },
  {
    id: 'clowntrigger', name: 'Clown Triggerfish', sci: 'Balistoides conspicillum',
    fact: 'Bold and inquisitive; locks itself into crevices with its "trigger" dorsal spine.',
    size: 1.15, count: 1,
    albedoGain: [1.02, 0.995, 0.889],   // lab patch comparison (white-referenced, 8 patches), half strength
    body: {
      len: 0.82, depth: 0.55, width: 0.36, m: 0.45, headP: 0.9, tailP: 1.2, ped: 0.3,
      // The head is boxed in bony plates: flat cheeks meeting the narrow nape and chin at rounded edges.
      section: { u0: 0.02, u1: 0.42, ease: 0.08, lo: -0.4, hi: 0.35, round: 0.16, sharp: 0.75 },
    },
    // Erectile spines: lowered into their groove at rest, locked upright when alarmed or wedged in a crevice.
    erect: { rest: 0.2, alarm: 2 },
    // Dorsal III + 25-27, anal 21-23, pectoral 14-15 (Randall 2005; FishBase).
    anatomy: { bodyDepthSL: [0.48, 0.56], dorsalSoft: { spines: 0, rays: 26 }, anal: { spines: 0, rays: 22 }, pectoralRays: 14 },
    eye: { u: 0.28, v: -0.38, r: 0.035, iris: '#3a3020' },
    mouth: { u: 0.04, v: 0.1, v0: 0.06 },   // small, at the end of the long snout
    // Plate-scaled head: a deep groove runs forward from the eye, the small terminal mouth has thick
    // lips, and the gill opening is a short slit above the pectoral base.
    ridges: [
      { u0: 0.12, v0: -0.28, u1: 0.25, v1: -0.36, w: 0.006, h: -0.003 },
      { u0: 0.006, v0: -0.4, u1: 0.006, v1: 0.4, w: 0.009, h: 0.005 },
      { u0: 0.36, v0: -0.12, u1: 0.37, v1: 0.12, w: 0.004, h: -0.0025 },
    ],
    // The pelvic fins are reduced to a single spine at the end of a movable belly flap.
    appendages: [{ u: 0.56, v: 0.97, len: 0.03, dir: [-1, -0.35, 0.1], r: 0.006, flat: 0.7, color: '#1c1a18' }],
    pattern: [
      { op: 'vgrad', stops: [[-1, '#101010'], [1, '#1c1c1c']] },
      { op: 'spots', n: 26, r: 0.024, color: '#e9c22a', u0: 0.3, u1: 0.78, v0: -0.85, v1: -0.15, seed: 3 },
      { op: 'spots', n: 14, r: 0.055, color: '#f5f5f0', u0: 0.25, u1: 0.85, v0: 0.15, v1: 0.95, seed: 7 },
      { op: 'band', u: 0.18, w: 0.045, curve: 0, color: '#f0c020' },
      { op: 'blob', u: 0.03, v: 0.0, ru: 0.06, rv: 0.6, color: '#ffb01c', soft: 0.2 },
    ],
    fins: [
      { pos: 'top', meristic: 'dorsalSoft', u0: 0.6, u1: 0.93, pts: [[0, 0.03], [0.2, 0.13], [1, 0.03]], sweep: 0.2, fill: '#8c8a94', alpha: 0.55, rays: 'rgba(20,20,28,0.35)' },
      // The trigger: a stout first spine locked upright by the second; folded flat into a groove at rest.
      { pos: 'top', kind: 'spines', u0: 0.4, u1: 0.47, n: 3, h: 0.08, hs: [1, 0.55, 0.2], lean: [70, 75], r: 0.0075, web: 0.9, fill: '#141414', alpha: 0.9, color: '#1c1a18', bend: 0.02, raise: 50, foldTo: 88 },
      { pos: 'bottom', meristic: 'anal', u0: 0.6, u1: 0.93, pts: [[0, 0.03], [0.2, 0.13], [1, 0.03]], sweep: 0.2, fill: '#8c8a94', alpha: 0.55, rays: 'rgba(20,20,28,0.35)' },
    ],
    caudal: { type: 'round', spread: 0.17, fill: '#141414', band: { t: 0.45, w: 0.25, color: '#e0e0d8' } },
    pectoral: { u: 0.38, v: 0.0, len: 0.1, w: 0.06, fill: '#e9c22a', alpha: 0.6 },
    brain: { maxSpeed: 1.6, turn: 3.0, zone: [0.3, 1.0], school: 0, grazer: 0.6, territorial: 0.9, boldness: 0.9, curiosity: 0.9, activity: 0.8, tailHz: 2.4 },
  },
  {
    id: 'emperorangel', name: 'Emperor Angelfish', sci: 'Pomacanthus imperator',
    fact: 'Juveniles wear white rings on blue; adults change completely into this striped livery.',
    size: 1.3, count: 1,
    anatomy: { bodyDepthSL: [0.52, 0.65] },
    albedoGain: [0.927, 0.943, 1.077],   // lab patch comparison (white-referenced, 12 patches), half strength
    body: { len: 0.8, depth: 0.62, width: 0.24, m: 0.45, headP: 1.0, tailP: 1.4, ped: 0.3 },
    eye: { u: 0.16, v: -0.3, r: 0.035, iris: '#202020' },
    mouth: { u: 0.05, v: 0.22, v0: 0.15 },
    pattern: [
      { op: 'vgrad', stops: [[-1, '#1b3aa8'], [0, '#1d43b8'], [1, '#253fa0']] },
      { op: 'stripesH', n: 11, color: '#ffd436', w: 0.05, tilt: 0.35, u0: 0.32, u1: 1.0 },
      { op: 'poly', color: '#9fb8e6', pts: [[0, -1.1], [0.12, -1.1], [0.12, 1.1], [0, 1.1]] },
      { op: 'band', u: 0.16, w: 0.07, curve: 0, color: '#111111', edge: '#6fa0ff', ew: 0.012 },
      { op: 'poly', color: '#0d1430', pts: [[0.25, -0.4], [0.34, -0.4], [0.34, 0.75], [0.25, 0.75]] },
    ],
    // The preopercular spine, strong and pale blue, at the corner of the cheek (all Pomacanthus).
    appendages: [{ u: 0.235, v: 0.5, len: 0.05, dir: [-1, -0.2, 0.3], r: 0.005, color: '#cfe2f4' }],
    fins: [
      { pos: 'top', u0: 0.3, u1: 0.96, pts: [[0, 0.04], [0.3, 0.12], [0.85, 0.13], [1, 0.03]], sweep: 0.3, fill: '#1d43b8', edge: '#7fb0ff', edgeW: 0.003 },
      { pos: 'bottom', u0: 0.5, u1: 0.96, pts: [[0, 0.04], [0.4, 0.13], [1, 0.03]], sweep: 0.3, fill: '#1a2f8a', edge: '#7fb0ff', edgeW: 0.003 },
    ],
    caudal: { type: 'round', spread: 0.16, fill: '#ffcc2a' },
    pectoral: { u: 0.36, v: 0.15, len: 0.12, w: 0.07, fill: '#ffcc2a', alpha: 0.7 },
    brain: { maxSpeed: 1.5, turn: 2.6, zone: [0.3, 0.95], school: 0, grazer: 0.7, territorial: 0.5, boldness: 0.7, curiosity: 0.8, activity: 0.7, tailHz: 2.4 },
  },
  {
    id: 'longnose', name: 'Yellow Longnose Butterflyfish', sci: 'Forcipiger flavissimus',
    fact: 'Its elongated snout reaches into coral branches to pluck tube-worm tentacles.',
    size: 0.8, count: 1,
    anatomy: { bodyDepthSL: [0.42, 0.56] },
    albedoGain: [1.026, 0.989, 1.031],   // lab patch comparison (chromaticity, 9 patches), half strength
    body: { len: 0.76, depth: 0.58, width: 0.2, m: 0.5, headP: 1.2, tailP: 1.5, ped: 0.2, snout: 0.22, snoutH: 0.025,
      snoutTip: 0.8, snoutBlend: 0.025 },   // the long beak barely tapers; it runs into a conical head
    eye: { u: 0.3, v: -0.35, r: 0.035, iris: '#202020' },
    pattern: [
      { op: 'vgrad', stops: [[-1, '#ffe21a'], [1, '#ffd200']] },
      // The hood ends 0.43 back from the beak tip, level with the dorsal origin (delso_kalakajoro38.jpg).
      { op: 'poly', color: '#141414', pts: [[0, -1.2], [0.43, -1.2], [0.43, -0.2], [0.3, -0.1], [0, 0.0]] },
      { op: 'poly', color: '#e8e8e0', pts: [[0, 0.0], [0.3, -0.1], [0.43, -0.2], [0.44, 1.2], [0, 1.2]] },
    ],
    fins: [
      { pos: 'top', u0: 0.35, u1: 0.96, pts: [[0, 0.04], [0.2, 0.18], [0.7, 0.2], [1, 0.04]], sweep: 0.3, fill: '#ffd800', rays: '#e8b800' },
      { pos: 'bottom', u0: 0.55, u1: 0.96, pts: [[0, 0.04], [0.4, 0.18], [1, 0.04]], sweep: 0.3, fill: '#ffd800', spot: { t: 0.8, h: 0.45, r: 0.03, color: '#111111' } },
    ],
    caudal: { type: 'truncate', spread: 0.15, fill: '#f0f0e8', alpha: 0.5 },
    pectoral: { u: 0.45, v: 0.15, len: 0.1, w: 0.06, fill: '#fff2a0', alpha: 0.5 },
    brain: { maxSpeed: 1.3, turn: 3.0, zone: [0.4, 1.0], school: 0.2, grazer: 0.85, territorial: 0.1, boldness: 0.5, curiosity: 0.5, activity: 0.65, tailHz: 3.2, perch: true },
  },
  {
    id: 'chromis', name: 'Blue-Green Chromis', sci: 'Chromis viridis',
    fact: 'Shoals of these damselfish hover above branching coral and dart into it when threatened.',
    size: 0.38, count: 9,
    anatomy: { bodyDepthSL: [0.42, 0.55] },
    // Per-colour calibration (lab patches, 2026-11-04): the iridescent body reads differently in each
    // photo, so all 9 back/body/belly patches are pooled (median Lab difference -1, -10, +5: greener).
    colourGain: [{ hex: ['#6fd8d0', '#8fe8df', '#c8f6ef', '#6fd8d4', '#7fe0d8', '#a0f0e8'], gain: [0.814, 1.007, 0.938] }],
    body: { len: 0.74, depth: 0.4, width: 0.42, m: 0.4, headP: 0.8, tailP: 1.2, ped: 0.3 },
    eye: { u: 0.12, v: -0.22, r: 0.055, iris: '#4a6a6a' },
    mouth: { u: 0.06, v: 0.15, v0: 0.0 },   // small, terminal, a little oblique
    pattern: [
      { op: 'vgrad', stops: [[-1, '#6fd8d0'], [0, '#8fe8df'], [1, '#c8f6ef']] },
    ],
    fins: [
      { pos: 'top', u0: 0.25, u1: 0.92, pts: [[0, 0.03], [0.2, 0.1], [1, 0.03]], sweep: 0.2, fill: '#6fd8d4', alpha: 0.5 },
      { pos: 'bottom', u0: 0.55, u1: 0.92, pts: [[0, 0.03], [0.3, 0.09], [1, 0.03]], sweep: 0.2, fill: '#6fd8d4', alpha: 0.5 },
    ],
    caudal: { type: 'forked', spread: 0.2, fill: '#7fe0d8', alpha: 0.6 },
    pectoral: { u: 0.28, v: 0.1, len: 0.12, w: 0.06, fill: '#a0f0e8', alpha: 0.4 },
    iridescent: true,
    brain: { maxSpeed: 1.5, turn: 5.0, zone: [0.15, 0.75], school: 1.0, grazer: 0.1, territorial: 0, boldness: 0.3, curiosity: 0.3, activity: 0.9, prey: true, tailHz: 6.5 },
  },
  {
    id: 'coralbeauty', name: 'Coral Beauty Angelfish', sci: 'Centropyge bispinosa',
    fact: 'A dwarf angelfish that rarely strays far from rockwork, darting between caves.',
    size: 0.6, count: 1,
    anatomy: { bodyDepthSL: [0.48, 0.6] },
    // Per-colour calibration (lab patches, 3 photos, 2026-11-04; half the median Lab difference): the
    // blue is darker and less red than rendered (5 patches), the orange flank lighter and yellower (2).
    colourGain: [
      { hex: ['#3c2a9a', '#5a2fa6', '#3a2890', '#3a2a8a', '#3a2a9a'], gain: [0.699, 0.837, 0.798] },
      { hex: ['#ff7a1a', '#ff9a4a'], gain: [1.215, 1.446, 1.611] },
    ],
    body: { len: 0.8, depth: 0.5, width: 0.32, m: 0.42, headP: 0.9, tailP: 1.3, ped: 0.35 },
    eye: { u: 0.14, v: -0.25, r: 0.045, iris: '#3a2a8a' },
    mouth: { u: 0.05, v: 0.2, v0: 0.12 },
    pattern: [
      { op: 'vgrad', stops: [[-1, '#3c2a9a'], [0, '#5a2fa6'], [1, '#3a2890']] },
      { op: 'blob', u: 0.45, v: 0.08, ru: 0.32, rv: 0.6, color: '#ff7a1a', soft: 0.55 },
      { op: 'stripesV', u0: 0.25, u1: 0.85, n: 11, color: '#3a2a8a', ratio: 0.15, alpha: 0.45 },
    ],
    // The preopercular spine at the corner of the cheek (Centropyge: 'two-spined angelfish').
    appendages: [{ u: 0.225, v: 0.5, len: 0.045, dir: [-1, -0.2, 0.3], r: 0.0045, color: '#4a48b8' }],
    fins: [
      { pos: 'top', u0: 0.28, u1: 0.96, pts: [[0, 0.04], [0.4, 0.12], [0.9, 0.12], [1, 0.03]], sweep: 0.25, fill: '#3a2a9a', edge: '#7fa0ff', edgeW: 0.0036 },
      { pos: 'bottom', u0: 0.55, u1: 0.96, pts: [[0, 0.04], [0.4, 0.12], [1, 0.03]], sweep: 0.25, fill: '#3a2a9a', edge: '#7fa0ff', edgeW: 0.0036 },
    ],
    caudal: { type: 'round', spread: 0.16, fill: '#3a2a9a' },
    pectoral: { u: 0.3, v: 0.12, len: 0.12, w: 0.07, fill: '#ff9a4a', alpha: 0.6 },
    brain: { maxSpeed: 1.1, turn: 4.0, zone: [0.6, 1.0], school: 0, grazer: 0.9, territorial: 0.4, boldness: 0.35, curiosity: 0.5, activity: 0.7, shy: 0.7, tailHz: 4.0 },
  },
  {
    id: 'moray', name: 'Snowflake Moray', sci: 'Echidna nebulosa',
    fact: 'Spends the day with its head out of a crevice, gulping water through its mouth; hunts crabs at night.',
    // 52.5 cm: adult aquarium size is commonly 50-75 cm (wild maximum ~1 m).
    size: 4.2, count: 1,
    // Anguilliform: no pectoral or pelvic fins, one continuous fin fold (dorsal from just ahead of the gill
    // opening, anal from the vent at mid-body) running round the tail; scaleless, mucus-covered skin.
    // Proportions from the side-on references (web/ref/moray): depth ~6.5% TL, head ~12% TL.
    body: { len: 0.97, depth: 0.065, width: 0.9, flank: 1, m: 0.3, headP: 0.32, tailP: 1.4, ped: 0.18, head: { u0: 0.01, u1: 0.075, u2: 0.16, depth: 0.28, top: 0.85, width: 0.6 } },
    eye: { u: 0.035, v: -0.55, r: 0.0065, iris: '#e8c020', irisR: 0.98, pupil: 0.5 },
    gill: false,
    // The gape runs back past the eye; the lower jaw hinges at its corner (fishModel jaw, fish.js breathing).
    mouth: { u: 0.065, v: 0.12, v0: 0.0, lining: 0.08 },
    pattern: [
      { op: 'vgrad', stops: [[-1, '#e9e5d8'], [1, '#f3f0e8']] },
      { op: 'blotches', u0: 0.04, u1: 1.0, n: 22, rows: [{ v: -0.5 }, { v: 0.45, du: 0.022 }], r: 0.013, color: '#161412', inner: '#e6c826', innerN: 4, speck: '#2a2520', speckN: 3000, speckR: 0.0011, seed: 5 },
      { op: 'blob', u: 0.0, v: 0.0, ru: 0.035, rv: 1.0, color: '#ecebe6', soft: 0.5 },   // pale snout
      { op: 'blob', u: 0.115, v: 0.25, ru: 0.004, rv: 0.08, color: '#101010', soft: 0.3 },   // gill opening
    ],
    // Tubular anterior nostrils at the tip of the snout.
    appendages: [{ u: 0.008, v: -0.05, len: 0.012, dir: [1, 0.3, 0.5], r: 0.0022, color: '#e8cc30' }],
    fins: [
      { pos: 'top', u0: 0.11, u1: 1.0, pts: [[0, 0.004], [0.1, 0.012], [0.9, 0.014], [1, 0.008]], sweep: 0, solid: true, fill: '#e8e4d8', alpha: 1, spots: '#161412', spotR: 0.0035, spotN: 160 },
      { pos: 'bottom', u0: 0.47, u1: 1.0, pts: [[0, 0.004], [0.1, 0.01], [0.9, 0.012], [1, 0.008]], sweep: 0, solid: true, fill: '#e8e4d8', alpha: 1, spots: '#161412', spotR: 0.0035, spotN: 90 },
    ],
    caudal: { type: 'round', spread: 0.018, solid: true, fill: '#e8e4d8', alpha: 1, spots: '#161412', spotR: 0.006, spotN: 8 },
    pectoral: null,
    brain: { maxSpeed: 0.6, turn: 1.5, zone: [0.9, 1.0], school: 0, grazer: 0, territorial: 0.3, boldness: 0.6, curiosity: 0.3, activity: 0.2, predator: true, nocturnal: true, lurker: true, tailHz: 1.0 },
  },
  {
    id: 'cleanerwrasse', name: 'Bluestreak Cleaner Wrasse', sci: 'Labroides dimidiatus',
    fact: 'Keeps a cleaning station: other fish queue up and hold still while it picks parasites off them.',
    // ~10 cm in aquaria (wild max 14 cm). Slender (depth ~22% SL), a black stripe from the snout through the
    // eye that widens to fill the tail, pale head and belly, electric blue over the rear of the back.
    size: 0.8, count: 1,
    anatomy: { bodyDepthSL: [0.2, 0.26] },
    body: { len: 0.84, depth: 0.22, width: 0.5, m: 0.38, headP: 0.75, tailP: 1.0, ped: 0.5 },
    eye: { u: 0.1, v: -0.12, r: 0.04, iris: '#1c2433' },
    mouth: { u: 0.03, v: 0.06, v0: 0.0 },   // small, terminal, thick-lipped picker
    pattern: [
      { op: 'vgrad', stops: [[-1, '#7f9ed8'], [-0.35, '#c9d6ea'], [0.3, '#eef1f5'], [1, '#f7f8f8']] },
      { op: 'blob', u: 0.78, v: -0.55, ru: 0.32, rv: 0.6, color: '#2d6ff0', soft: 0.6 },
      { op: 'poly', color: '#101116', pts: [[0, -0.05], [0.3, -0.13], [0.6, -0.22], [0.88, -0.34], [1.02, -0.42], [1.02, 0.42], [0.88, 0.32], [0.6, 0.18], [0.3, 0.1], [0, 0.04]] },
    ],
    fins: [
      { pos: 'top', u0: 0.22, u1: 0.95, pts: [[0, 0.03], [0.3, 0.07], [0.8, 0.08], [1, 0.03]], sweep: 0.15, fill: '#1b2238', alpha: 0.8, edge: '#4a8af0', edgeW: 0.006 },
      { pos: 'bottom', u0: 0.52, u1: 0.95, pts: [[0, 0.03], [0.4, 0.07], [1, 0.03]], sweep: 0.15, fill: '#1b2238', alpha: 0.8, edge: '#4a8af0', edgeW: 0.006 },
    ],
    caudal: { type: 'truncate', spread: 0.14, fill: '#121318', edge: '#4f8ff0', edgeW: 0.012 },
    pectoral: { u: 0.26, v: 0.1, len: 0.11, w: 0.05, fill: '#e8eef5', alpha: 0.25 },
    brain: { maxSpeed: 1.2, turn: 4.0, zone: [0.5, 1.0], school: 0, grazer: 0, territorial: 0, boldness: 0.75, curiosity: 0.5, activity: 0.8, prey: true, cleaner: true, tailHz: 5.0 },
  },
];

// ---- Derived tables, merged into each definition by completeSpecies() ----

// Fish that visit the cleaning station (Grutter 1995: on the Great Barrier Reef clients of Labroides are
// mostly larger herbivores and invertivores; parasite loads build up over hours).
const CLEANER_CLIENTS: readonly string[] = ['bluetang', 'yellowtang', 'moorishidol', 'emperorangel', 'coralbeauty', 'copperband', 'longnose', 'clowntrigger', 'lionfish'];

// Night colours (fishModel uNight): yellow tangs show a pale lateral patch and blue tangs fade at
// night; chromis, idols, butterflyfish, angels, triggers and the cleaner darken (Hobson 1972; aquarium
// observations). Others keep their day colours.
const NIGHT: Readonly<Record<string, NightColour>> = { yellowtang: 'pale', bluetang: 'pale', chromis: 'dark', moorishidol: 'dark', copperband: 'dark', longnose: 'dark', emperorangel: 'dark', clowntrigger: 'dark', cleanerwrasse: 'dark' };

// Resting roll in shelter (rad, fish.ts): tangs wedge into crevices on their side; the royal gramma
// orients its belly to the nearest surface, so under a ledge it hangs upside down.
const SHELTER_ROLL: Readonly<Record<string, number>> = { bluetang: 1.1, yellowtang: 1.1, royalgramma: Math.PI };

export const FISH_NAMES: readonly string[] = ['Pip', 'Marlow', 'Coral', 'Finn', 'Juno', 'Ripple', 'Sable', 'Wren', 'Tango', 'Opal', 'Basil', 'Kiko',
  'Moss', 'Zuzu', 'Ember', 'Lumen', 'Pearl', 'Drift', 'Nori', 'Skip', 'Mango', 'Indigo', 'Bubbles', 'Quill', 'Saffron',
  'Bramble', 'Echo', 'Fable', 'Gizmo', 'Hollis', 'Kelp', 'Loki', 'Miso', 'Nimbus', 'Olive', 'Pesto'];

// Swimming biomechanics. Sizes above are real aquarium-specimen lengths at 12.5 cm per unit.
//  mode:   'bcf'         body/caudal fin (undulating body + tail)
//          'labriform'   rows with the pectoral fins at cruise; tail recruited above `gait`
//          'balistiform' undulates dorsal + anal fins; tail recruited above `gait`
//  maxBL:  max sustained (prolonged) speed, body lengths/s; burstBL: escape burst speed
//  gait:   speed (BL/s) above which the tail joins in
//  rmin:   minimum turning radius at speed, in body lengths
//  hoverTurn: rad/s yaw rate achievable at zero speed using fins
// Values follow typical published figures for reef fishes (e.g. Fulton 2007; Wainwright et al. 2002).
export const SWIM: Readonly<Record<string, SwimTable>> = {
  clownfish: { mode: 'labriform', maxBL: 3.5, burstBL: 8, gait: 2.0, rmin: 0.25, hoverTurn: 2.2 },
  bluetang: { mode: 'labriform', maxBL: 3.0, burstBL: 7, gait: 2.5, rmin: 0.3, hoverTurn: 1.6 },
  yellowtang: { mode: 'labriform', maxBL: 3.0, burstBL: 7, gait: 2.5, rmin: 0.3, hoverTurn: 1.6 },
  moorishidol: { mode: 'labriform', maxBL: 2.5, burstBL: 6, gait: 2.0, rmin: 0.35, hoverTurn: 1.4 },
  lionfish: { mode: 'balistiform', maxBL: 1.2, burstBL: 4, gait: 0.9, rmin: 0.4, hoverTurn: 0.9 },
  copperband: { mode: 'labriform', maxBL: 2.5, burstBL: 6, gait: 2.0, rmin: 0.25, hoverTurn: 2.0 },
  royalgramma: { mode: 'bcf', maxBL: 4.0, burstBL: 9, gait: 0, rmin: 0.2, hoverTurn: 1.8 },
  clowntrigger: { mode: 'balistiform', maxBL: 2.5, burstBL: 6, gait: 1.5, rmin: 0.3, hoverTurn: 1.5 },
  emperorangel: { mode: 'labriform', maxBL: 2.5, burstBL: 6, gait: 2.0, rmin: 0.35, hoverTurn: 1.3 },
  longnose: { mode: 'labriform', maxBL: 2.5, burstBL: 6, gait: 2.0, rmin: 0.3, hoverTurn: 1.8 },
  chromis: { mode: 'labriform', maxBL: 4.5, burstBL: 10, gait: 2.5, rmin: 0.2, hoverTurn: 2.5 },
  coralbeauty: { mode: 'labriform', maxBL: 3.0, burstBL: 7, gait: 2.0, rmin: 0.25, hoverTurn: 2.0 },
  moray: { mode: 'anguilliform', maxBL: 0.6, burstBL: 2, gait: 0, rmin: 0.2, hoverTurn: 0.6 },   // curls round tightly
  cleanerwrasse: { mode: 'labriform', maxBL: 4.0, burstBL: 9, gait: 2.5, rmin: 0.2, hoverTurn: 2.4 },   // wrasses row with the pectorals
};

// Turning and posture (merged into sp.swim). Turns speed up and slow down gradually; at low speed a
// fish turns almost on the spot by sculling its pectorals (hoverTurn), at speed it is limited by how
// tight a circle it can swim (rmin, widened by `wide` for routine turns) and by the sideways force its
// fins and body produce (omega <= aLat / U). Bending into a turn adds drag, so fish slow in tight turns.
//  aLat / aLatBurst: lateral (centripetal) acceleration, routine / escape turns, in g
//  wide:        routine turning radius as a multiple of rmin (escapes use rmin itself)
//  turnDrag:    extra drag at the tightest turn, as a fraction of straight-line drag
//  pitchCruise: steepest climb or dive while swimming (deg)
//  pitchSlow:   steepest pitch when nearly stopped - grazing, probing, hovering (deg)
//  climb:       fraction of the angle to the goal a fish climbs at (they gain depth gradually)
//  pitchRate:   max pitch rate, routine / escape (deg/s)
//  bank:        max lean into turns (deg); reef fish stay nearly upright
// Deep, compressed bodies (tangs, idol, angels) turn tightly but lean and pitch little; pickers that
// work crevices nose-first (copperband, longnose, trigger, lionfish stalking) pitch steeply when slow.
export const MOTION: Readonly<Record<string, MotionTable>> = {
  clownfish: { aLat: 0.08, aLatBurst: 0.5, wide: 2, turnDrag: 0.6, pitchCruise: 20, pitchSlow: 46, climb: 0.6, pitchRate: [50, 140], bank: 10 },
  bluetang: { aLat: 0.08, aLatBurst: 0.5, wide: 2, turnDrag: 0.5, pitchCruise: 18, pitchSlow: 50, climb: 0.6, pitchRate: [45, 130], bank: 8 },
  yellowtang: { aLat: 0.08, aLatBurst: 0.5, wide: 2, turnDrag: 0.5, pitchCruise: 18, pitchSlow: 50, climb: 0.6, pitchRate: [45, 130], bank: 8 },
  moorishidol: { aLat: 0.06, aLatBurst: 0.4, wide: 2.2, turnDrag: 0.6, pitchCruise: 15, pitchSlow: 40, climb: 0.5, pitchRate: [35, 110], bank: 6 },
  lionfish: { aLat: 0.04, aLatBurst: 0.3, wide: 2.5, turnDrag: 0.8, pitchCruise: 15, pitchSlow: 55, climb: 0.5, pitchRate: [25, 90], bank: 5 },
  copperband: { aLat: 0.07, aLatBurst: 0.45, wide: 2, turnDrag: 0.6, pitchCruise: 18, pitchSlow: 60, climb: 0.6, pitchRate: [45, 120], bank: 6 },
  royalgramma: { aLat: 0.1, aLatBurst: 0.8, wide: 1.8, turnDrag: 0.5, pitchCruise: 25, pitchSlow: 50, climb: 0.7, pitchRate: [60, 170], bank: 12 },
  clowntrigger: { aLat: 0.06, aLatBurst: 0.4, wide: 2.2, turnDrag: 0.7, pitchCruise: 18, pitchSlow: 60, climb: 0.6, pitchRate: [40, 120], bank: 6 },
  emperorangel: { aLat: 0.06, aLatBurst: 0.4, wide: 2.2, turnDrag: 0.6, pitchCruise: 15, pitchSlow: 45, climb: 0.5, pitchRate: [35, 110], bank: 7 },
  longnose: { aLat: 0.07, aLatBurst: 0.45, wide: 2, turnDrag: 0.6, pitchCruise: 18, pitchSlow: 60, climb: 0.6, pitchRate: [45, 120], bank: 7 },
  chromis: { aLat: 0.12, aLatBurst: 0.7, wide: 1.8, turnDrag: 0.4, pitchCruise: 25, pitchSlow: 40, climb: 0.7, pitchRate: [60, 170], bank: 12 },
  coralbeauty: { aLat: 0.09, aLatBurst: 0.6, wide: 1.8, turnDrag: 0.5, pitchCruise: 20, pitchSlow: 50, climb: 0.6, pitchRate: [55, 150], bank: 9 },
  moray: { aLat: 0.05, aLatBurst: 0.3, wide: 1.5, turnDrag: 0.3, pitchCruise: 20, pitchSlow: 35, climb: 0.5, pitchRate: [30, 90], bank: 3 },
  cleanerwrasse: { aLat: 0.1, aLatBurst: 0.7, wide: 1.8, turnDrag: 0.5, pitchCruise: 25, pitchSlow: 45, climb: 0.7, pitchRate: [60, 170], bank: 10 },
};

// Pace: the speed each behaviour asks for, as a fraction of the species' max sustained speed (maxBL).
// Routine swimming in a tank is slow (15-40%); feeding dashes, chases and escapes use the rest.
// Pairs are [far, near] (or [base, +activity] for cruise). Species list only what differs from PACE_BASE.
export const PACE_BASE: Readonly<Pace> = {
  cruise: [0.15, 0.2], school: 0.35, forage: [0.3, 0.15], peck: 0.05, feed: [0.8, 0.4], rest: [0.25, 0.06],
  flee: 1.25, chase: 0.75, patrol: 0.25, inspect: [0.3, 0.03], host: [0.5, 0.15], hover: 0.25, lurk: [0.3, 0.0],
};
export const PACE: Readonly<Record<string, Partial<Pace>>> = {
  clownfish: { cruise: [0.12, 0.15], host: [0.55, 0.18] },          // stays close, wiggles in the tentacles
  bluetang: { cruise: [0.2, 0.2], patrol: 0.3 },                    // restless open-water swimmers
  yellowtang: { cruise: [0.2, 0.2], forage: [0.3, 0.12] },          // constant grazers
  moorishidol: { cruise: [0.18, 0.15] },
  lionfish: { cruise: [0.1, 0.15], forage: [0.2, 0.1], hover: 0.15, feed: [0.9, 0.3] },   // stalks, then lunges
  copperband: { cruise: [0.12, 0.15], forage: [0.2, 0.1], peck: 0.03 },                   // slow, deliberate picker
  royalgramma: { cruise: [0.1, 0.15], rest: [0.3, 0.04], flee: 1.4 },                     // stays by its ledge, darts
  clowntrigger: { cruise: [0.18, 0.2], chase: 0.85 },
  emperorangel: { cruise: [0.15, 0.15] },
  longnose: { forage: [0.25, 0.12], peck: 0.03 },
  chromis: { cruise: [0.2, 0.2], school: 0.4 },                    // active schooling planktivore
  coralbeauty: { cruise: [0.12, 0.2], rest: [0.3, 0.06] },         // darts between rocks
  moray: { cruise: [0.3, 0.2], feed: [0.9, 0.5], flee: 1.0 },       // slow prowl along the bottom at night
  cleanerwrasse: { cruise: [0.15, 0.2] },
};

// Skin anatomy. scales: approximate lateral-line scale count (sets scale size; tangs and the idol have
// minute scales, grammas and chromis large ones). hump: how far the back arches above the midline.
// scaleType: 'ctenoid' (default: a comb of spinules on the free margin, most reef perciforms) or
// 'cycloid' (smooth-edged: wrasses). headScales: size of the cheek scales relative to the body's
// (default 0.55). Elsewhere on a species: speckle (chromatophore density, default 1), irid
// ({ range: [nm, nm], strength } for the guanine film; see fishModel).
export const SKIN: Readonly<Record<string, SkinTable>> = {
  clownfish: { scales: 50, hump: 0.08 },
  bluetang: { scales: 150, hump: 0.06 },
  yellowtang: { scales: 150, hump: 0.04 },
  moorishidol: { scales: 150, hump: 0.04 },
  lionfish: { scales: 90, hump: 0.02 },
  copperband: { scales: 48, hump: 0.04 },
  royalgramma: { scales: 32, hump: 0.04 },
  clowntrigger: { scales: 40, hump: 0.1 },
  emperorangel: { scales: 70, hump: 0.05 },
  longnose: { scales: 72, hump: 0.04 },
  chromis: { scales: 28, hump: 0.07 },
  coralbeauty: { scales: 45, hump: 0.06 },
  moray: { scales: 0, hump: 0.02 },   // scaleless
  cleanerwrasse: { scales: 52, hump: 0.03, scaleType: 'cycloid' },
};

/** Gravity in world units/s^2 (1 unit = 12.5 cm). */
const G_UNITS = 9.81 / 0.125;

function tableEntry<T>(table: Readonly<Record<string, T>>, id: string, name: string): T {
  const entry = table[id];
  if (entry === undefined) throw new Error(`species "${id}" has no ${name} entry`);
  return entry;
}

/** SWIM and MOTION merged, in world units and radians. */
function swimOf(id: string): Swim {
  const m = tableEntry(MOTION, id, 'MOTION');
  return {
    ...tableEntry(SWIM, id, 'SWIM'),
    aLat: m.aLat * G_UNITS, aLatBurst: m.aLatBurst * G_UNITS, wide: m.wide, turnDrag: m.turnDrag,
    pitchCruise: m.pitchCruise * DEG_TO_RAD, pitchSlow: m.pitchSlow * DEG_TO_RAD, climb: m.climb,
    pitchRate: [m.pitchRate[0] * DEG_TO_RAD, m.pitchRate[1] * DEG_TO_RAD], bank: m.bank * DEG_TO_RAD,
  };
}

/** Behaviour flags and night colours that live in side tables, set on the definitions in place. */
function applySideTables(defs: readonly (SpeciesDefinition & { night?: NightColour })[]): void {
  for (const id of CLEANER_CLIENTS) {
    const sp = defs.find((s) => s.id === id);
    if (sp) sp.brain.client = true;
  }
  for (const sp of defs) {
    const night = NIGHT[sp.id];
    if (night) sp.night = night;
  }
  for (const sp of defs) {
    const roll = SHELTER_ROLL[sp.id];
    if (roll) sp.brain.shelterRoll = roll;
  }
}

/** The swim/pace tables merged into a definition; the brain's maxSpeed follows from the swim table. */
function completeSpecies(def: SpeciesDefinition & { night?: NightColour; fitted?: boolean }): Species {
  const sp: Species = Object.assign(def, { swim: swimOf(def.id), pace: { ...PACE_BASE, ...PACE[def.id] } });
  sp.brain.maxSpeed = sp.swim.maxBL * sp.size;   // world units/s, used by the brain as "100% effort"
  return sp;
}

// The pipeline, in the original order: side tables, fitted shape and colour, swim/pace, then the skin
// table (which deliberately overrides a fitted hump).
applySideTables(DEFINITIONS);
applyFitted(DEFINITIONS);
export const SPECIES: readonly Species[] = DEFINITIONS.map(completeSpecies);
for (const sp of SPECIES) Object.assign(sp.body, SKIN[sp.id]);

/** Registry: species looked up by id. */
export class SpeciesRegistry<S extends { readonly id: string }> {
  private readonly byIdMap: ReadonlyMap<string, S>;

  constructor(private readonly items: readonly S[]) {
    this.byIdMap = new Map(items.map((s) => [s.id, s]));
  }

  all(): readonly S[] {
    return this.items;
  }

  has(id: string): boolean {
    return this.byIdMap.has(id);
  }

  /** The species, or undefined for an unknown id. */
  find(id: string): S | undefined {
    return this.byIdMap.get(id);
  }

  /** The species; throws for an unknown id (use after the tank gate has validated ids). */
  byId(id: string): S {
    const sp = this.byIdMap.get(id);
    if (!sp) throw new Error(`unknown species "${id}"`);
    return sp;
  }
}

export const FISH_REGISTRY = new SpeciesRegistry(SPECIES);
