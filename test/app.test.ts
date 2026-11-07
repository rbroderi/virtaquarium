import { describe, expect, it } from 'vitest';
import { daylightAtHour, wallClockDaylight, alwaysDay, DaylightClock } from '../src/app/daylight.js';
import { Feeder, FIRST_FEED_SECONDS, type TankEvents } from '../src/app/feeder.js';
import { EventBus } from '../src/core/eventBus.js';
import { mulberry32 } from '../src/core/rng.js';
import { StartupTimer } from '../src/app/startupTimer.js';

describe('daylight', () => {
  it('follows the sun through dawn, a noon peak and golden dusk', () => {
    expect(daylightAtHour(5)).toBe(0);
    expect(daylightAtHour(6)).toBe(0);
    expect(daylightAtHour(7)).toBeCloseTo(0.425);
    expect(daylightAtHour(10)).toBeCloseTo(0.925);
    expect(daylightAtHour(12)).toBe(1);
    expect(daylightAtHour(14)).toBeCloseTo(0.925);
    expect(daylightAtHour(18)).toBeCloseTo(0.425);
    expect(daylightAtHour(21.5)).toBe(0);
  });

  it('reads the injected clock', () => {
    const noon = wallClockDaylight(() => new Date(2026, 0, 1, 12, 0));
    const night = wallClockDaylight(() => new Date(2026, 0, 1, 23, 30));
    expect(noon.level()).toBe(1);
    expect(night.level()).toBe(0);
    expect(alwaysDay.level()).toBe(1);
  });

  it('speeds the clock away from real time, jumps it and resets it', () => {
    const clock = new DaylightClock(() => new Date(2026, 0, 1, 12, 0));
    expect(clock.rate()).toBe(1);
    clock.speedUp(); expect(clock.rate()).toBe(2);
    clock.speedUp(); expect(clock.rate()).toBe(5);
    clock.slowDown(); expect(clock.rate()).toBe(2);
    clock.jumpTo(0); expect(clock.hour()).toBeCloseTo(0);
    clock.reset(); expect(clock.rate()).toBe(1);
    expect(clock.hour()).toBeCloseTo(12);
  });
});

describe('Feeder', () => {
  const span = { x0: -8, x1: 8 };

  it('publishes feed events on schedule', () => {
    const bus = new EventBus<TankEvents>();
    const drops: number[] = [];
    bus.on('feed', (e) => drops.push(e.x));
    const feeder = new Feeder(bus, 4, span, mulberry32(1), true);
    feeder.update(FIRST_FEED_SECONDS - 1);
    expect(drops).toHaveLength(0);
    feeder.update(1);
    expect(drops).toHaveLength(1);
    expect(feeder.secondsToNextFeed).toBe(240);
    feeder.update(239);
    expect(drops).toHaveLength(1);
    feeder.update(1);
    expect(drops).toHaveLength(2);
    for (const x of drops) {
      expect(x).toBeGreaterThanOrEqual(span.x0 + 2);
      expect(x).toBeLessThan(span.x1 - 2);
    }
  });

  it('never fires when disabled or the interval is zero', () => {
    const bus = new EventBus<TankEvents>();
    let fired = 0;
    bus.on('feed', () => fired++);
    for (const feeder of [new Feeder(bus, 4, span, mulberry32(1), false), new Feeder(bus, 0, span, mulberry32(1), true)]) {
      feeder.update(1e6);
      expect(feeder.secondsToNextFeed).toBe(Infinity);
    }
    expect(fired).toBe(0);
  });
});

describe('StartupTimer', () => {
  it('records each stage since the previous one', () => {
    let t = 100;
    const timer = new StartupTimer(() => t);
    t = 130; timer.stage('a');
    t = 180; timer.stage('b');
    expect(timer.times()).toEqual({ a: 30, b: 50 });
    expect(timer.totalMs()).toBe(80);
  });
});
