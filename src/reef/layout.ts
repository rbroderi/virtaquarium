// Layout tunables for the procedural reef. Positions are in "design" units for a 16-unit-wide tank and
// are multiplied by the tank's width / 16 (ReefBuilder's sx) where they are x positions.

/** The tank width the x positions below were laid out for. */
export const DESIGN_WIDTH = 16;

/** Offsets added to the tank seed for each independent random stream. Pieces added after the original
 * layout draw from their own stream so the seeded layout before them (and the Roku bake) is unchanged. */
export const STREAM = {
  noise: 1,
  shellProps: 11,
  plants: 13,
  generatedCorals: 21,
  backWallSecondRow: 31,
  caves: 101,
  crystal: 41,
} as const;

/** The height field grid: margin beyond the tank's width, z extent, cell size. */
export const HEIGHT_FIELD = { xMargin: 2, z0: -6, z1: 6, step: 0.2 } as const;

/** How far a generated rock may be stretched off its own proportions, per axis. */
export const ROCK_STRETCH = 1.15;

/** Generated rocks fill less of their box than the procedural blobs: enlarge them by this (sideways, up). */
export const GENERATED_ROCK_GROWTH = { x: 1.45, y: 1.3 } as const;
/** Cave stones: generated rocks fitted closer to the slot. */
export const CAVE_STONE_GROWTH = { x: 1.1, y: 1.05 } as const;

export interface RockPile {
  readonly x: number;
  readonly z: number;
  /** [base width, height] per level, bottom up. */
  readonly levels: readonly (readonly [number, number])[];
}

/** Main piles: x (design units), z, levels. */
export const ROCK_PILES: readonly RockPile[] = [
  { x: -5.6, z: -1.0, levels: [[2.2, 1.3], [1.6, 1.1], [1.1, 0.9]] },
  { x: -0.6, z: -1.6, levels: [[2.4, 1.4], [1.9, 1.3], [1.4, 1.1], [0.9, 0.8]] },
  { x: 5.0, z: -1.2, levels: [[2.1, 1.2], [1.6, 1.0], [1.1, 0.8]] },
  { x: -2.9, z: -2.4, levels: [[1.6, 1.2], [1.2, 1.0]] },
  { x: 2.6, z: -2.6, levels: [[1.8, 1.3], [1.2, 1.0]] },
];

/** A pile level wider than this gets two rocks side by side. */
export const PILE_DOUBLE_WIDTH = 1.8;

/** Foreground rubble rocks (design x). */
export const FOREGROUND_ROCK_X: readonly number[] = [-6.8, -3.6, 2.0, 3.3, 6.6];

/** Staghorn colonies: [design x, z, scale]; the first is the chromis shoal's home coral. */
export const STAGHORNS: readonly (readonly [number, number, number])[] = [[-0.6, -1.4, 1.25], [4.6, -1.3, 0.7], [-6.0, -2.6, 0.6]];

/** The host anemone's low front rock (design x, z). */
export const ANEMONE_SPOT = { x: 2.9, z: 1.3 } as const;

/**
 * The crystal sign: its preferred spot on the open sand left of centre (world x, z), the area searched
 * for the nearest spot clear of rock and coral, the clearance kept around it, and the keep-out margin
 * and front strip later plantings stay out of (world units).
 */
export const CRYSTAL_SIGN = {
  x: -1.6, z: 1.5,
  searchX: [-2.8, -0.6], searchZ: [1.2, 2.8], searchStep: 0.1,
  clearance: 0.06, plantMargin: 0.45, frontStrip: 2.2,
} as const;

/** The bubbler's air stone (design x, y, z). */
export const BUBBLER = { x: 6.3, y: 0.6, z: -3.4 } as const;

/** Height-field level that still counts as open sand. */
export const OPEN_SAND_LEVEL = 0.12;

export const HOMES = { count: 40, xFraction: 0.42, z0: -2.2, z1: 2.0, above: 0.35 } as const;

export const SHELTER_LIMITS = { ledges: 14, withCrevices: 16, spacing: 1.0 } as const;

export const MORAY_CAVES = 2;

/** cm per world unit. */
export const CM_PER_UNIT = 12.5;

/** Probe rays for ground height start this high. */
export const PROBE_HEIGHT = 30;
