// Where the tank's light level (0 night .. 1 day) comes from, and the sun's colour and angle. The
// day follows the sun: a smooth curve from dawn through a noon peak to golden dusk, and the clock
// can run at real time, slower or faster, or be jumped to noon/midnight.
import { clamp, smooth } from '../core/math.js';

/** The colour/angle half of the sun's state, passed to lighting separately from the light level. */
export interface SunState {
  /** 0 warm horizon sun .. 1 white-blue noon sun. */
  readonly warmth: number;
  /** 0 dawn .. 1 dusk across the lit day (0.5 = noon), for the sun's arc. */
  readonly phase: number;
}

/** What a fixed (no-clock) source returns: overhead white-blue noon. */
export const NOON_SUN: SunState = { warmth: 1, phase: 0.5 };

export interface DaylightSource {
  /** Target light level now, 0 (night, moonlight) .. 1 (full day). */
  level(): number;
  readonly followsClock: boolean;
  /** Advance the source's own clock by dt simulated seconds (fixed sources ignore it). */
  advance(dt: number): void;
  /** Simulated hour of day (0..24), or null for a fixed source. */
  hour(): number | null;
  /** Time rate vs real time (1 = real time). */
  rate(): number;
  /** Sun colour/angle state for lighting.ts. */
  sun(): SunState;
  /** Clock controls; no-ops for a fixed source. */
  speedUp(): void;
  slowDown(): void;
  reset(): void;
  jumpTo(hour: number): void;
}

/** The tank's light day: dawn begins, the noon peak, and when the lights are fully off (hours). */
const DAY_START = 6.0;
const DAWN_END = 8.0;
const NOON = 12.0;
const DUSK_START = 16.0;
const DAY_END = 20.0;
/** Light level on the morning/afternoon plateau; the noon peak reaches 1. */
const PLATEAU = 0.85;
/** The sun's arc is symmetric around noon: it clears the horizon at 6:00 and sets at 18:00, leaving a
 *  twilight glow until the lights are fully off at DAY_END. */
const SOLAR_RISE = NOON - 6.0;
const SOLAR_SET = NOON + 6.0;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const SECONDS_PER_HOUR = 3600;

/** How far a smooth ramp (0..1) is through [a, b]. */
const ramp = (hour: number, a: number, b: number): number => clamp((hour - a) / (b - a), 0, 1);

/** The sun's light level: a smooth dawn, a noon peak and a golden dusk. */
export function daylightAtHour(hour: number): number {
  if (hour < DAY_START || hour >= DAY_END) return 0;
  if (hour < DAWN_END) return smooth(ramp(hour, DAY_START, DAWN_END)) * PLATEAU;
  if (hour < NOON) return PLATEAU + (1 - PLATEAU) * smooth(ramp(hour, DAWN_END, NOON));
  if (hour < DUSK_START) return 1 - (1 - PLATEAU) * smooth(ramp(hour, NOON, DUSK_START));
  return PLATEAU * (1 - smooth(ramp(hour, DUSK_START, DAY_END)));
}

/** 0 dawn .. 1 dusk across the sun's arc (0.5 = noon). */
export function sunPhaseAtHour(hour: number): number {
  return clamp((hour - SOLAR_RISE) / (SOLAR_SET - SOLAR_RISE), 0, 1);
}

/** 0 at the horizon (warm) .. 1 overhead at noon (white-blue). */
export function sunWarmthAtHour(hour: number): number {
  return Math.sin(Math.PI * sunPhaseAtHour(hour));
}

/** Clock rates away from real time, from slowest to fastest; 1 = real time. */
const RATES = [0.25, 0.5, 1, 2, 5, 10, 30, 60, 300, 1200] as const;
const REALTIME_INDEX = RATES.indexOf(1);

/** A day/night clock: real time by default, with rate and jump controls. */
export class DaylightClock implements DaylightSource {
  readonly followsClock = true;
  private rateIndex = REALTIME_INDEX;
  private offsetHours = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  level(): number {
    return daylightAtHour(this.hour());
  }

  hour(): number {
    const h = this.realHour() + this.offsetHours;
    return ((h % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY;
  }

  rate(): number {
    return RATES[this.rateIndex] ?? 1;
  }

  advance(dt: number): void {
    this.offsetHours += ((this.rate() - 1) * dt) / SECONDS_PER_HOUR;
  }

  sun(): SunState {
    const hour = this.hour();
    return { warmth: sunWarmthAtHour(hour), phase: sunPhaseAtHour(hour) };
  }

  speedUp(): void {
    if (this.rateIndex < RATES.length - 1) this.rateIndex++;
  }

  slowDown(): void {
    if (this.rateIndex > 0) this.rateIndex--;
  }

  reset(): void {
    this.rateIndex = REALTIME_INDEX;
    this.offsetHours = 0;
  }

  /** Jump the simulated time to `hour` o'clock (the clock keeps running from there). */
  jumpTo(hour: number): void {
    this.offsetHours = hour - this.realHour();
  }

  private realHour(): number {
    const d = this.now();
    return d.getHours() + d.getMinutes() / MINUTES_PER_HOUR;
  }
}

export const alwaysDay: DaylightSource = {
  followsClock: false,
  level: () => 1,
  advance: () => {},
  hour: () => null,
  rate: () => 1,
  sun: () => NOON_SUN,
  speedUp: () => {},
  slowDown: () => {},
  reset: () => {},
  jumpTo: () => {},
};

export function wallClockDaylight(now: () => Date = () => new Date()): DaylightSource {
  return new DaylightClock(now);
}

export const daylightFor = (followClock: boolean): DaylightSource => (followClock ? wallClockDaylight() : alwaysDay);
