// The auto-feeder: counts down to the next feeding and publishes a `feed` event on the tank's event
// bus (Observer) when it fires; the world drops the food. Fish read `secondsToNextFeed` to anticipate
// the schedule.
import type { EventBus } from '../core/eventBus.js';
import type { Rng } from '../core/rng.js';
import { range } from '../core/rng.js';

/** Events the running tank publishes. */
export interface TankEvents {
  /** Food dropped at x (world units). */
  feed: { readonly x: number; readonly automatic: boolean };
  /** The target light level changed (0 night .. 1 day). */
  lightsTarget: { readonly level: number };
}

/** The first automatic feeding comes this many seconds after startup. */
export const FIRST_FEED_SECONDS = 45;
const SECONDS_PER_MINUTE = 60;
/** Food lands at least this far in from the side walls. */
const WALL_MARGIN = 2;

export interface FeedSpan { readonly x0: number; readonly x1: number }

export class Feeder {
  private countdown: number;

  constructor(
    private readonly bus: EventBus<TankEvents>,
    private readonly intervalMinutes: number,
    private readonly span: FeedSpan,
    private readonly rng: Rng,
    enabled: boolean,
  ) {
    this.countdown = enabled && intervalMinutes > 0 ? FIRST_FEED_SECONDS : Infinity;
  }

  get secondsToNextFeed(): number {
    return this.countdown;
  }

  /** Advances the countdown; returns the seconds left this step (<= 0 on the step that feeds). */
  update(dt: number): number {
    this.countdown -= dt;
    const left = this.countdown;
    if (left > 0) return left;
    this.bus.emit('feed', { x: range(this.rng, this.span.x0 + WALL_MARGIN, this.span.x1 - WALL_MARGIN), automatic: true });
    this.countdown = this.intervalMinutes * SECONDS_PER_MINUTE;
    return left;
  }
}
