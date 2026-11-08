// The species catalogue's shape: anatomy (mesh and texture generation) and temperament (the brain).
//
// Anatomy is in normalised units where total length = 1, nose at x=+0.5, tail tip at x=-0.5. The body
// runs from u=0 (nose) to u=1 (caudal peduncle). Pattern coordinates are (u, v) where v=-1 is the
// dorsal (top) outline and v=+1 the ventral (bottom) outline at that u. Temperament values are 0..1.

/** [lo, hi] */
export type Range2 = [number, number];
/** A colour stop: [position, '#rrggbb']. */
export type ColourStop = [number, string];
/** A 2D point [u, v] or [t, h], optionally with a third "sweep back" component. */
export type Point2 = [number, number] | [number, number, number];
export type Vec3Tuple = [number, number, number];

/** Meristic counts of one fin (published spine and ray counts). */
export interface FinCount { spines: number; rays: number }

export interface Anatomy {
  bodyDepthSL?: Range2;
  dorsal?: FinCount;
  dorsalSoft?: FinCount;
  anal?: FinCount;
  pectoralRays?: number;
  /** Principal caudal rays (17 in nearly all spiny-rayed fishes when unset). */
  caudalRays?: number;
  pelvic?: FinCount;
}

/** Boxed-head cross-section (triggerfish plates). */
export interface BodySection { u0: number; u1: number; ease: number; lo: number; hi: number; round: number; sharp: number }

/** A moray-like head: deeper than the body behind, laterally flattened, bulging up over the jaw muscles. */
export interface HeadShape {
  /** Body u where the bulge rises off the snout. */
  u0: number;
  /** Body u where the bulge peaks (over the eye and jaw muscles). */
  u1: number;
  /** Body u where the head has blended back into the body. */
  u2: number;
  /** Peak extra half-depth as a share of H (the head is this much deeper than the body). */
  depth: number;
  /** Share of the extra depth carried dorsally (1: all of it rises above the midline). */
  top: number;
  /** The head's half-width at the peak, as a share of the usual section width. */
  width: number;
}

export type ScaleType = 'ctenoid' | 'cycloid';

export interface Body {
  len: number;
  depth: number;
  width: number;
  m: number;
  headP: number;
  tailP: number;
  ped: number;
  /** Merged in from the SKIN table (species.ts). */
  hump?: number;
  scales?: number;
  scaleType?: ScaleType;
  headScales?: number;
  flank?: number;
  snout?: number;
  snoutH?: number;
  snoutW?: number;
  snoutTip?: number;
  snoutBlend?: number;
  headW?: number;
  mouth?: number;
  section?: BodySection;
  /** A moray-like head bulge (only the moray sets this). */
  head?: HeadShape;
  /** Free-form corrections to the side outline, for bodies the formula cannot bend into shape. */
  outline?: BodyOutline;
  /** Control points [u, k] scaling the section's half-width by 1 + k (smooth through the points, held at
   *  the end values): a broad trunk, a tapered snout. */
  widthCurve?: readonly (readonly [number, number])[];
  /** Control points [u, e] making the section egg-shaped: e > 0 widens the lower half and narrows the
   *  upper (a head broadest across the cheeks), e < 0 the reverse (a trunk broadest over the back). */
  egg?: readonly (readonly [number, number])[];
  /** How far the gill cover stands proud of the flank at its free margin, as a share of the half-width
   *  (0.05 when unset). Smaller: a cover that lies flush, its margin a soft edge rather than a step. */
  cover?: number;
}

/** Control points [u, dy] that move the dorsal (top) and ventral (bot) outlines up or down by dy (in
 *  half-depths H; + is up), joined by a smooth curve through the points and held at the end values
 *  beyond them. Moving both lowers or raises the centreline there (a head hung below the body axis);
 *  moving one bends that outline alone (a brow, a nape dip, a deep belly). */
export interface BodyOutline {
  top?: readonly (readonly [number, number])[];
  bot?: readonly (readonly [number, number])[];
}

export interface Eye {
  u: number;
  v: number;
  r: number;
  iris: string;
  irisR?: number;
  pupil?: number;
  fleck?: string;
  fleckR?: number;
}

export interface Mouth { u: number; v: number; v0: number; lining?: number }

/** The surgeonfish caudal spine. */
export interface Scalpel { u: number; v: number; len: number; color: string }

export interface BandOp { op: 'band'; u: number; w: number; curve: number; color: string; edge?: string; ew?: number }
export interface GradientOp { op: 'vgrad' | 'hgrad'; stops: ColourStop[] }
export interface PolyOp { op: 'poly'; color: string; pts: Point2[] }
export interface BlobOp { op: 'blob'; u: number; v: number; ru: number; rv: number; color: string; soft: number }
// Rings round a point (the lionfish's head stripes, bent round its eye): n bands at radii r0 + i * dr
// (TL) between angles a0 and a1 (degrees; 0 points to the tail, 90 to the belly), w wide (TL), clipped
// to u <= uMax; spokes: bars out from the centre at these angles, from spokeR0 to spokeR1, spokeW wide
// (or [angle, width] for a bar of its own width).
export interface RingsOp {
  op: 'rings'; u: number; v: number; n: number; r0: number; dr: number; w: number; a0: number; a1: number; color: string;
  uMax?: number; spokes?: (number | readonly [number, number])[]; spokeR0?: number; spokeR1?: number; spokeW?: number;
}
// Vertical bars from u0 to u1: n bars, ratio of the pitch dark. lean: degrees off vertical, tops towards
// the tail; dense: bars closer together and narrower towards u1 (0 even, 0.5 about half the pitch at the
// end); split: bars (by index) parted down the middle by a thin pale line; fork: bars that part into a Y
// over the back, above forkV (v as for the eye: -1 dorsal, default -0.2).
export interface StripesVOp {
  op: 'stripesV'; u0: number; u1: number; n: number; color: string; ratio: number; alpha?: number;
  lean?: number; dense?: number; split?: number[]; fork?: number[]; forkV?: number;
}
export interface StripesHOp { op: 'stripesH'; n: number; color: string; w: number; tilt: number; u0: number; u1: number }
export interface SpotsOp { op: 'spots'; n: number; r: number; color: string; u0: number; u1: number; v0: number; v1: number; seed: number }
export interface BlotchRow { v: number; du?: number }
export interface BlotchesOp {
  op: 'blotches'; u0: number; u1: number; n: number; rows: BlotchRow[]; r: number; color: string;
  inner?: string; innerN?: number; speck?: string; speckN?: number; speckR?: number; seed: number;
}
/** One layer of the body skin painter (fishModel skin), discriminated on `op`. */
export type PatternOp = BandOp | GradientOp | PolyOp | BlobOp | StripesVOp | StripesHOp | SpotsOp | BlotchesOp | RingsOp;

export type FinPosition = 'top' | 'bottom';
export type Meristic = 'dorsal' | 'dorsalSoft' | 'anal';
/** A flat colour, or colour stops along the fin. */
export type FinFill = string | ColourStop[];

export interface FinPaint { t0: number; t1: number; color: string }
export interface FinSpot { t: number; h: number; r: number; color: string; ring?: string }

/** Spots sprinkled over a fin membrane. */
export interface FinSpots { spots?: string; spotR?: number; spotN?: number }

/** Shared fin look. */
export interface FinLook extends FinSpots {
  fill: FinFill;
  alpha?: number;
  edge?: string;
  edgeW?: number;
  fringe?: string;
  fringeW?: number;
  rays?: string;
  thin?: number;
  solid?: boolean;
}

/** A membrane fin (dorsal or anal) given as an outline of heights along it. */
export interface MembraneFin extends FinLook {
  kind?: undefined;
  pos: FinPosition;
  meristic?: Meristic;
  u0: number;
  u1: number;
  pts: Point2[];
  sweep?: number;
  paint?: FinPaint[];
  spot?: FinSpot;
}

/** A row of free, erectile spines (lionfish dorsal, trigger). */
export interface SpineFin {
  kind: 'spines';
  pos: FinPosition;
  u0: number;
  u1: number;
  n: number;
  h: number;
  hs: number[];
  lean: Range2;
  r: number;
  flag?: number;
  flagLen?: number;
  web: number;
  fill: string;
  alpha?: number;
  color: string;
  stripes?: string;
  bend?: number;
  raise: number;
  foldTo: number;
}

export type Fin = MembraneFin | SpineFin;

export type CaudalType = 'round' | 'lunate' | 'truncate' | 'forked';

export interface CaudalBand { t: number; w: number; color: string }

export interface Caudal extends FinSpots {
  type: CaudalType;
  spread: number;
  tip?: number;
  fill: string;
  alpha?: number;
  edge?: string;
  edgeW?: number;
  fringe?: string;
  fringeW?: number;
  rays?: string;
  thin?: number;
  solid?: boolean;
  band?: CaudalBand;
}

export interface Pelvic extends FinSpots {
  u: number;
  len: number;
  angle: number;
  base?: number;
  splay?: number;
  fill: string;
  alpha?: number;
  edge?: string;
  edgeW?: number;
}

export type PectoralKind = 'round' | 'fan';

export interface Pectoral extends FinSpots {
  kind?: PectoralKind;
  u: number;
  v: number;
  len: number;
  w: number;
  fill: string;
  alpha?: number;
  edge?: string;
  edgeW?: number;
  stripes?: string;
  rayColor?: string;
  rayR?: number;
  flag?: number;
  /** Fans: membrane depth between rays, as a share of the shorter ray (the rest stands free). */
  web?: number;
  /** Fans: ray lengths as a share of len, [t, share] with t from the top ray (0) to the bottom one (1). */
  rayLen?: readonly (readonly [number, number])[];
  /** Fans: rest pose in the tank (rad; defaults to FAN_POSE): roll about the body axis, opening, droop. */
  pose?: { readonly roll: number; readonly yaw: number; readonly flap: number };
}

/** A raised or grooved line on the head (bony stays, grooves, lips). */
export interface Ridge { u0: number; v0: number; u1: number; v1: number; w: number; h: number }

/** A small fleshy or bony projection: tentacles, lappets, spines, nostrils. */
export interface Appendage {
  u: number;
  v: number;
  len: number;
  dir: Vec3Tuple;
  r: number;
  flat?: number;
  shape?: 'leaf' | 'frond';
  color: string;
  stripes?: string;
  nb?: number;
  bend?: number;
}

/** Erectile spine angles at rest and alarmed (multipliers of the fin's raise). */
export interface Erect { rest: number; alarm: number }

/** A per-colour linear gain (lab calibration of two-hue fish). */
export interface ColourGain { hex: string[]; gain: Vec3Tuple }

export type NightColour = 'pale' | 'dark';

/** Thin-film iridescence of the guanine layer. */
export interface Iridescence { range?: Range2; strength?: number }

/** Temperament and locomotion limits read by the brain (brain.ts) and the swimmer (fish.ts). */
export interface BrainTraits {
  /** World units/s at "100% effort" (recomputed from SWIM.maxBL x size). */
  maxSpeed: number;
  turn: number;
  /** Preferred depth band, 0 surface .. 1 floor. */
  zone: Range2;
  school: number;
  grazer: number;
  territorial: number;
  boldness: number;
  curiosity: number;
  activity: number;
  tailHz: number;
  shy?: number;
  host?: boolean;
  prey?: boolean;
  hover?: boolean;
  predator?: boolean;
  nocturnal?: boolean;
  lurker?: boolean;
  cleaner?: boolean;
  client?: boolean;
  shelterRoll?: number;
  /** Perches on the rock to sleep (settles still once against it in its shelter). */
  perch?: boolean;
}

export type SwimMode = 'bcf' | 'labriform' | 'balistiform' | 'anguilliform';

/** Swimming biomechanics (SWIM table) as written, body lengths and degrees. */
export interface SwimTable { mode: SwimMode; maxBL: number; burstBL: number; gait: number; rmin: number; hoverTurn: number }

/** Turning and posture (MOTION table) as written, in g and degrees. */
export interface MotionTable {
  aLat: number; aLatBurst: number; wide: number; turnDrag: number;
  pitchCruise: number; pitchSlow: number; climb: number; pitchRate: Range2; bank: number;
}

/** SWIM and MOTION merged, converted to world units/s^2 and radians. */
export interface Swim extends SwimTable {
  aLat: number; aLatBurst: number; wide: number; turnDrag: number;
  pitchCruise: number; pitchSlow: number; climb: number; pitchRate: Range2; bank: number;
}

/** A pace: a fraction of maxBL, or [far, near] / [base, +activity]. */
export type PaceValue = number | Range2;

export interface Pace {
  cruise: Range2; school: number; forage: Range2; peck: number; feed: Range2; rest: Range2;
  flee: number; chase: number; patrol: number; inspect: Range2; host: Range2; hover: number; lurk: Range2;
}

export interface SkinTable { scales: number; hump: number; scaleType?: ScaleType }

/** A species as written in the catalogue, before the derived tables are merged in. */
/** How strongly a species' paint is warped and mottled (core/organic.ts); 0 turns one off. */
export interface Organic { warp?: number; mottle?: number }

export interface SpeciesDefinition {
  id: string;
  name: string;
  sci: string;
  fact: string;
  /** Specimen length in world units (1 unit = 12.5 cm). */
  size: number;
  /** Default count in a stocked tank. */
  count: number;
  anatomy?: Anatomy;
  albedoGain?: Vec3Tuple;
  colourGain?: ColourGain[];
  body: Body;
  eye: Eye;
  gill?: boolean;
  /** false: no nostrils painted. */
  nares?: boolean;
  mouth?: Mouth;
  scalpel?: Scalpel;
  pattern: PatternOp[];
  ridges?: Ridge[];
  appendages?: Appendage[];
  erect?: Erect;
  fins: Fin[];
  caudal: Caudal;
  pelvic?: Pelvic;
  pectoral: Pectoral | null;
  iridescent?: boolean;
  irid?: Iridescence;
  speckle?: number;
  /** Organic imperfection scales (fishModel organicSkin and fin paint), default 1 each. */
  organic?: Organic;
  /** Look variant 0..VARIANT_COUNT-1 set on a variant clone; the catalogue leaves it unset (variant 0). */
  variant?: number;
  brain: BrainTraits;
}

/** A complete species: the definition plus swim/pace tables, night colours and fit flag. */
export interface Species extends SpeciesDefinition {
  swim: Swim;
  pace: Pace;
  night?: NightColour;
  fitted?: boolean;
}

// ---- Fitted anatomy (tools/fit-anatomy.ts output, anatomy/<id>.ts) ----

export interface FittedBand { index: number; u: number; w: number }

/** A fitted fin outline, merged over sp.fins[i] by index. */
export interface FittedFin { u0?: number; u1?: number; sweep?: number; pts?: Point2[]; h?: number }

export interface FittedAnatomy {
  bands?: FittedBand[];
  body: Partial<Body>;
  fins: FittedFin[];
  caudal: Partial<Pick<Caudal, 'spread' | 'tip'>>;
  pelvic?: Partial<Pick<Pelvic, 'u' | 'len' | 'angle'>>;
  pectoral?: Partial<Pick<Pectoral, 'u' | 'v' | 'len' | 'w'>>;
}
