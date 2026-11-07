// The crystal sign's message parsing and click priority (the DOM/canvas parts are covered by the
// look check and the live page).
import { describe, expect, it } from 'vitest';
import { crystalClickAction, parseCrystalMessages } from '../src/reef/crystalText.js';

describe('parseCrystalMessages', () => {
  it('parses string and array text, with url, impressionUrl and a default label', () => {
    const msgs = parseCrystalMessages([
      { text: 'one line', url: 'https://a.example/', impressionUrl: 'https://a.example/i', label: 'Sponsored' },
      { text: ['two', 'lines'], url: 'https://b.example/' },
      { text: 'no url' },
    ]);
    expect(msgs).toEqual([
      { text: ['one line'], url: 'https://a.example/', impressionUrl: 'https://a.example/i', label: 'Sponsored' },
      { text: ['two', 'lines'], url: 'https://b.example/', label: 'Sponsored' },
      { text: ['no url'], label: 'Sponsored' },
    ]);
  });

  it('drops malformed entries and empty text', () => {
    expect(parseCrystalMessages([{ url: 'https://x.example/' }, 42, { text: '' }, { text: ['', '  '] }])).toEqual([]);
  });

  it('rejects non-arrays', () => {
    expect(parseCrystalMessages({ text: 'x' })).toEqual([]);
  });
});

describe('crystalClickAction', () => {
  it('picks a creature first', () => {
    expect(crystalClickAction(true, true, true)).toBe('select');
  });

  it('opens the crystal card only when hit and clickable', () => {
    expect(crystalClickAction(false, true, true)).toBe('card');
    expect(crystalClickAction(false, true, false)).toBe('feed');
    expect(crystalClickAction(false, false, true)).toBe('feed');
  });

  it('feeds otherwise', () => {
    expect(crystalClickAction(false, false, false)).toBe('feed');
  });
});
