// Where the tank's light level (0 night .. 1 day) comes from. Strategy: a fixed day, or the local
// wall clock with a dawn and dusk ramp (?clock=1).

export interface DaylightSource {
  /** Target light level now, 0 (night, moonlight) .. 1 (full day). */
  level(): number;
  readonly followsClock: boolean;
}

const LIGHTS_ON_HOUR = 7;
const DAWN_RAMP_HOURS = 1.5;
const LIGHTS_OFF_HOUR = 20;
const DUSK_RAMP_HOURS = 1.5;
const MINUTES_PER_HOUR = 60;

/** Lights ramp 7:00-8:30 and 20:00-21:30; moonlight at night. */
export function daylightAtHour(hour: number): number {
  if (hour < LIGHTS_ON_HOUR || hour >= LIGHTS_OFF_HOUR + DUSK_RAMP_HOURS) return 0;
  if (hour < LIGHTS_ON_HOUR + DAWN_RAMP_HOURS) return (hour - LIGHTS_ON_HOUR) / DAWN_RAMP_HOURS;
  if (hour >= LIGHTS_OFF_HOUR) return 1 - (hour - LIGHTS_OFF_HOUR) / DUSK_RAMP_HOURS;
  return 1;
}

export const alwaysDay: DaylightSource = { level: () => 1, followsClock: false };

export function wallClockDaylight(now: () => Date = () => new Date()): DaylightSource {
  return {
    followsClock: true,
    level: () => {
      const d = now();
      return daylightAtHour(d.getHours() + d.getMinutes() / MINUTES_PER_HOUR);
    },
  };
}

export const daylightFor = (followClock: boolean): DaylightSource => (followClock ? wallClockDaylight() : alwaysDay);
