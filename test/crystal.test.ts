// The crystal sign's message parsing, text fit and click priority (the DOM/canvas parts are covered by
// the look check and the live page).
import { describe, expect, it } from 'vitest';
import { crystalClickAction, parseCrystalMessages } from '../src/reef/crystalText.js';
import { layoutCrystalText } from '../src/reef/crystalMask.js';

describe('parseCrystalMessages', () => {
  it('parses string and array text, url, impressionUrl, disclosure and an empty default label', () => {
    const msgs = parseCrystalMessages([
      { text: 'Red Sea Coral Pro salt', url: 'https://www.amazon.com/', impressionUrl: 'https://www.amazon.com/i', disclosure: 'Affiliate link: as an Amazon Associate I earn from qualifying purchases.' },
      { text: ['two', 'lines'], url: 'https://b.example/', label: 'Sponsored' },
      { text: 'no url' },
    ]);
    expect(msgs).toEqual([
      { text: ['Red Sea Coral Pro salt'], url: 'https://www.amazon.com/', impressionUrl: 'https://www.amazon.com/i', label: '', disclosure: 'Affiliate link: as an Amazon Associate I earn from qualifying purchases.' },
      { text: ['two', 'lines'], url: 'https://b.example/', label: 'Sponsored' },
      { text: ['no url'], label: '' },
    ]);
  });

  it('drops malformed entries and empty text', () => {
    expect(parseCrystalMessages([{ url: 'https://x.example/' }, 42, { text: '' }, { text: ['', '  '] }])).toEqual([]);
  });

  it('rejects non-arrays', () => {
    expect(parseCrystalMessages({ text: 'x' })).toEqual([]);
  });
});

describe('layoutCrystalText', () => {
  const measure = (t: string, s: number): number => t.length * s * 0.6;

  it('wraps long lines so every line fits within the face width', () => {
    const maxW = 800, maxH = 600;
    const layout = layoutCrystalText(measure, ['Support this reef visit our sponsor'], '', maxW, maxH);
    expect(layout.lines.length).toBeGreaterThan(1);
    for (const line of layout.lines) expect(measure(line, layout.size)).toBeLessThanOrEqual(maxW);
  });

  it('shrinks a single long word to fit', () => {
    const maxW = 400, maxH = 600;
    const layout = layoutCrystalText(measure, ['Supercalifragilisticexpialidocious'], '', maxW, maxH);
    for (const line of layout.lines) expect(measure(line, layout.size)).toBeLessThanOrEqual(maxW);
  });

  it('fits within the height too', () => {
    const maxW = 800, maxH = 600;
    const layout = layoutCrystalText(measure, ['one', 'two', 'three', 'four', 'five'], '', maxW, maxH);
    const totalH = layout.lines.length * layout.size * 1.24;
    expect(totalH).toBeLessThanOrEqual(maxH + 0.001);
  });

  it('keeps the longest crystal.json entry inside the face with a realistic line height', () => {
    // The plaque's drawn area: 84% of a 1024 x (1024 / 3) face (a wide cleavage plane).
    const maxW = 860, maxH = 286;
    const lineHeight = (s: number): number => s * 1.34;   // Segoe UI's line box is taller than 1.24 em
    const layout = layoutCrystalText(measure, ['Seachem Prime water conditioner'], '', maxW, maxH, lineHeight);
    expect(layout.lines.length).toBeGreaterThanOrEqual(2);
    for (const line of layout.lines) expect(measure(line, layout.size)).toBeLessThanOrEqual(maxW);
    expect(layout.lines.length * lineHeight(layout.size)).toBeLessThanOrEqual(maxH + 0.001);
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
