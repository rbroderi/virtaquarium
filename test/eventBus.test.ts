import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/eventBus.js';

interface Events {
  feed: { x: number };
  tick: number;
}

describe('EventBus', () => {
  it('delivers payloads to every listener of an event', () => {
    const bus = new EventBus<Events>();
    const seen: number[] = [];
    bus.on('feed', (p) => seen.push(p.x));
    bus.on('feed', (p) => seen.push(p.x * 10));
    bus.on('tick', (n) => seen.push(-n));
    bus.emit('feed', { x: 2 });
    expect(seen).toEqual([2, 20]);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus<Events>();
    let count = 0;
    const off = bus.on('tick', () => count++);
    bus.emit('tick', 1);
    off();
    bus.emit('tick', 2);
    expect(count).toBe(1);
  });

  it('tolerates listeners removing themselves while emitting', () => {
    const bus = new EventBus<Events>();
    const seen: string[] = [];
    const off = bus.on('tick', () => { seen.push('a'); off(); });
    bus.on('tick', () => seen.push('b'));
    bus.emit('tick', 0);
    bus.emit('tick', 0);
    expect(seen).toEqual(['a', 'b', 'b']);
  });
});
