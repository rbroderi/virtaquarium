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
  // The rock's projected silhouette, drawn at the face mask's 1024 px width: ~0.9 of a square, so the
  // inset (12% each side) leaves a ~778 x 691 px text area. (See src/reef/crystal.ts.)
  const SILHOUETTE_W = 1024, SILHOUETTE_H = 910;
  const INSET = 0.12;
  const maxW = SILHOUETTE_W * (1 - 2 * INSET);
  const maxH = SILHOUETTE_H * (1 - 2 * INSET);
  const lineHeight = (s: number): number => s * 1.34;   // Segoe UI's line box is taller than 1.24 em

  it('wraps long lines so every line fits within the silhouette width', () => {
    const layout = layoutCrystalText(measure, ['Support this reef visit our sponsor'], '', 800, 600);
    expect(layout.lines.length).toBeGreaterThan(1);
    for (const line of layout.lines) expect(measure(line, layout.size)).toBeLessThanOrEqual(800);
  });

  it('shrinks a single long word to fit', () => {
    const layout = layoutCrystalText(measure, ['Supercalifragilisticexpialidocious'], '', 400, 600);
    for (const line of layout.lines) expect(measure(line, layout.size)).toBeLessThanOrEqual(400);
  });

  it('fits within the height too', () => {
    const layout = layoutCrystalText(measure, ['one', 'two', 'three', 'four', 'five'], '', 800, 600);
    const totalH = layout.lines.length * layout.size * 1.24;
    expect(totalH).toBeLessThanOrEqual(600 + 0.001);
  });

  it('sizes the short entry to two large lines across most of the rock width', () => {
    const layout = layoutCrystalText(measure, ['Red Sea Coral Pro salt'], '', maxW, maxH, lineHeight);
    expect(layout.lines.length).toBe(2);
    for (const line of layout.lines) expect(measure(line, layout.size)).toBeLessThanOrEqual(maxW + 0.001);
    // The widest line stays large: it spans most of the available width, not a small plaque.
    const widest = Math.max(...layout.lines.map((l) => measure(l, layout.size)));
    expect(widest).toBeGreaterThan(maxW * 0.55);
  });

  it('keeps the long entry inside the silhouette and readable', () => {
    const layout = layoutCrystalText(measure, ['Seachem Prime water conditioner'], '', maxW, maxH, lineHeight);
    expect(layout.lines.length).toBeGreaterThanOrEqual(2);
    for (const line of layout.lines) expect(measure(line, layout.size)).toBeLessThanOrEqual(maxW + 0.001);
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
