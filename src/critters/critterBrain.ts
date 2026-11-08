// A small utility brain for the critters, in the spirit of the fish brain (brain.ts): a few drives that
// rise and fall with what the animal is doing, each behaviour scored from them, and the best one taken
// with some stickiness so it doesn't dither. Each critter owns its drive dynamics and scoring; this
// keeps the choosing and the click panel (laid out exactly as the fish panel) in one place.
import { brainRows, clamp01, type InspectPanel, type InspectRow } from '../inspect.js';
import type { CritterSpecies } from './types.js';

export interface DriveInfo {
  readonly label: string;
  /** Bar colour class in the panel (as the fish drives: hunger, energy, fear, social, boredom). */
  readonly cls: string;
}

/** A behaviour has to beat the current one's score by this much to take over. */
const SWITCH_MARGIN = 0.12;

export class CritterBrain<D extends string, M extends string, T extends string = string> {
  readonly drives: Record<D, number>;
  /** The latest scores, for the panel. */
  scores: Partial<Record<M, number>> = {};

  /**
   * `traits` are its personality, 0..1, each with its panel label; a critter turns them into weights
   * on its options (see weight()).
   */
  constructor(
    private readonly info: Readonly<Record<D, DriveInfo>>,
    start: Record<D, number>,
    readonly traits: Readonly<Record<T, number>>,
    private readonly traitLabels: Readonly<Record<T, string>>,
  ) {
    this.drives = { ...start };
  }

  /** A trait as a score weight: 0.8 for the least inclined, 1.2 for the most. */
  weight(t: T): number {
    return 0.8 + 0.4 * this.traits[t];
  }

  /** Nudge a drive by `delta`, kept within 0..1. */
  add(d: D, delta: number): void {
    this.drives[d] = clamp01(this.drives[d] + delta);
  }

  /**
   * The behaviour to do next: the best score, unless `current` is within the switching margin of it
   * (`current` null: no incumbent, take the best).
   */
  choose(current: M | null, scores: Partial<Record<M, number>>): M {
    this.scores = scores;
    let best: M | null = null, bestS = -Infinity;
    for (const [m, s] of Object.entries(scores) as [M, number][]) if (s > bestS) { bestS = s; best = m; }
    if (best === null) throw new Error('CritterBrain.choose: no options');
    const cur = current !== null ? scores[current] : undefined;
    return cur !== undefined && cur + SWITCH_MARGIN >= bestS ? (current as M) : best;
  }

  /** The click panel, as the fish panel: name, thought, drives, options considered, personality, fact. */
  panel(sp: CritterSpecies, mode: string, thought: string): InspectPanel {
    return { title: sp.name, sci: sp.sci, note: thought, rows: this.rows(mode), fact: sp.fact };
  }

  private rows(mode: string): InspectRow[] {
    return brainRows({
      drives: (Object.entries(this.drives) as [D, number][]).map(([d, v]) => [this.info[d].label, v, this.info[d].cls]),
      scores: Object.entries(this.scores) as [M, number][],
      mode,
      traits: (Object.entries(this.traits) as [T, number][]).map(([t, v]) => [this.traitLabels[t], v]),
    });
  }
}
