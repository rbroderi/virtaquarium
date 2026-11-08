// The crystal's etched mask, shared by crystal.ts (the default placeholder) and crystalText.ts
// (rotating messages). One canvas drives the etch and frost:
//   red   = clarity (255 clear, 0 etched/opaque)
//   green = frost (255 rough/frosted, ~16 smooth)
//   blue  = the shadowed upper wall just inside each glyph
// The text is sized against the whole rock's projected silhouette (its 2D extent on the etched
// plane), inset ~12% so glyphs never reach the rock's outline, and drawn centred. layoutCrystalText
// is unit-tested.
import { context2d } from '../util.js';

export const DEFAULT_CRYSTAL_TEXT = ['Red Sea Coral Pro salt'] as const;
export const DEFAULT_LABEL = '';

const CLEAR = 'rgb(255,16,0)';
const FROST = 'rgb(0,255,0)';
/** The shadowed upper wall inside each glyph, added into the B channel alone (R/G untouched). */
const EDGE_BLUE = 'rgb(0,0,255)';
const FONT = `system-ui, 'Segoe UI', sans-serif`;
const LABEL_RATIO = 0.45;
/** Fallback line-height ratio (of the font size) when the canvas reports no glyph bounds. */
const FALLBACK_LINE_RATIO = 1.34;
/** The etched-text area is the strong-facing region inset by this much on each side (fraction of the canvas). */
const TEXT_INSET = 0.12;
/** Below this fraction of the text area's width a line is too small to read: allow another line instead.
 *  Calibrated so the short entry ("Red Sea Coral Pro salt") stays two large lines, not one squeezed line,
 *  independent of the mask resolution. */
const MIN_FONT_FRACTION = 0.116;
const MAX_LINES = 6;

/** The settled text layout: a font size (px), the label size, and the wrapped lines. */
export interface CrystalTextLayout {
  readonly size: number;
  readonly labelSize: number;
  readonly lines: readonly string[];
}

/** Wraps one line into sub-lines that fit maxW at the given size. */
function wrapLine(measure: (text: string, sizePx: number) => number, line: string, sizePx: number, maxW: number): string[] {
  const words = line.split(/\s+/).filter((w) => w.length > 0);
  if (!words.length) return [];
  const out: string[] = [];
  let cur = words[0] ?? '';
  for (let i = 1; i < words.length; i++) {
    const next = `${cur} ${words[i]}`;
    if (measure(next, sizePx) <= maxW) cur = next;
    else { out.push(cur); cur = words[i] ?? ''; }
  }
  out.push(cur);
  return out;
}

/**
 * Wraps and sizes text (and an optional label) so every line fits within maxW x maxH — the rock's
 * silhouette inset. `measure` returns the width of text at a given px size and `lineHeight` the height
 * of one line at that size; both are injected so the fit is unit-testable without a canvas. The font
 * size and line breaks are searched together, preferring few wide lines: a short message stays two
 * large lines and only a longer one wraps further, so nothing shrinks to an unreadable size.
 */
export function layoutCrystalText(
  measure: (text: string, sizePx: number) => number,
  text: readonly string[],
  label: string,
  maxW: number,
  maxH: number,
  lineHeight: (sizePx: number) => number = (s): number => s * 1.24,
): CrystalTextLayout {
  /** Wraps and measures the block at a given size against the fixed width. */
  const atSize = (sizePx: number): { lines: readonly string[]; height: number; widest: number } => {
    const labelSize = sizePx * LABEL_RATIO;
    const lineH = lineHeight(sizePx);
    const labelH = label ? labelSize * 1.7 : 0;
    const wrapped: string[] = [];
    for (const line of text) wrapped.push(...wrapLine(measure, line, sizePx, maxW));
    const height = wrapped.length * lineH + labelH;
    let widest = 0;
    for (const w of wrapped) widest = Math.max(widest, measure(w, sizePx));
    if (label) widest = Math.max(widest, measure(label.toUpperCase(), labelSize));
    return { lines: wrapped, height, widest };
  };

  const fits = (sizePx: number, maxLines: number): boolean => {
    const r = atSize(sizePx);
    return r.lines.length <= maxLines && r.height <= maxH && r.widest <= maxW;
  };

  const largestFor = (maxLines: number): number => {
    let lo = 0, hi = maxH;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid, maxLines)) lo = mid; else hi = mid;
    }
    return lo;
  };

  // Prefer few, wide lines at a readable size: start with one line and only allow another line when
  // the single-line font falls below the readable floor, so a short message stays two large lines.
  const minFont = maxW * MIN_FONT_FRACTION;
  let lines = 1;
  let size = largestFor(1);
  while (size < minFont && lines < MAX_LINES) { lines++; size = largestFor(lines); }
  const final = atSize(size);
  return { size, labelSize: size * LABEL_RATIO, lines: final.lines };
}

/** The canvas's line height for the etched font: the glyphs' real ascent+descent plus a little leading,
 *  so multi-line blocks never spill past the rock (Segoe UI's line box is taller than 1.24 em). */
function measureLineHeight(g: CanvasRenderingContext2D, sizePx: number): number {
  g.font = `600 ${Math.round(sizePx)}px ${FONT}`;
  const m = g.measureText('AgjQy');
  const asc = m.actualBoundingBoxAscent;
  const desc = m.actualBoundingBoxDescent;
  return typeof asc === 'number' && typeof desc === 'number' && asc + desc > 0
    ? (asc + desc) * 1.15
    : sizePx * FALLBACK_LINE_RATIO;
}

/** Draws the etch mask into the canvas (red clarity, green frost, blue inner edge), soft and beveled. */
export function renderMask(canvas: HTMLCanvasElement, lines: readonly string[], label: string): void {
  const g = context2d(canvas);
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = CLEAR;
  g.fillRect(0, 0, W, H);
  // The text fills the silhouette inset 12% on each side (the canvas maps the whole silhouette).
  const maxW = W * (1 - 2 * TEXT_INSET), maxH = H * (1 - 2 * TEXT_INSET);
  const measure = (text: string, sizePx: number): number => {
    g.font = `600 ${Math.round(sizePx)}px ${FONT}`;
    return g.measureText(text).width;
  };
  const lineH = (sizePx: number): number => measureLineHeight(g, sizePx);
  const { size, labelSize, lines: wrapped } = layoutCrystalText(measure, lines, label, maxW, maxH, lineH);

  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  const cx = W / 2, cyTop = H / 2;
  const lineHpx = lineH(size);
  const blockH = wrapped.length * lineHpx + (label ? labelSize * 1.7 : 0);
  let y = cyTop - blockH / 2 + lineHpx / 2;

  // Scratch canvas for the shadowed wall, built per glyph run and added into the blue channel only.
  const wall = document.createElement('canvas');
  wall.width = W;
  wall.height = H;
  const w = context2d(wall);
  w.textAlign = 'center';
  w.textBaseline = 'middle';

  const etch = (text: string, cy: number, fontPx: number): void => {
    const font = `600 ${Math.round(fontPx)}px ${FONT}`;
    const bevel = Math.max(1, Math.round(fontPx * 0.05));
    const frostSoft = Math.max(1, Math.round(fontPx * 0.015));
    g.font = font;
    // The frosted glyph (the R/G channels), with a slightly soft edge.
    g.shadowColor = FROST;
    g.shadowBlur = frostSoft;
    g.fillStyle = FROST;
    g.fillText(text, cx, cy);
    g.shadowBlur = 0;
    g.fillText(text, cx, cy);
    // The recess's upper wall, in the B channel only: light from above leaves a band just inside each
    // glyph's top edges in shadow, so the letters read as cut into the glass. It is the glyph minus
    // the glyph dropped by the bevel, so it never reaches outside the letter or prints a second copy.
    w.clearRect(0, 0, W, H);
    w.font = font;
    w.globalCompositeOperation = 'source-over';
    w.fillStyle = EDGE_BLUE;
    w.fillText(text, cx, cy);
    w.globalCompositeOperation = 'destination-out';
    w.fillText(text, cx, cy + bevel);
    g.globalCompositeOperation = 'lighter';
    g.filter = `blur(${frostSoft}px)`;
    g.drawImage(wall, 0, 0);
    g.filter = 'none';
    g.globalCompositeOperation = 'source-over';
  };

  for (const line of wrapped) {
    etch(line, y, size);
    y += lineHpx;
  }
  if (label) etch(label.toUpperCase(), y + labelSize * 0.35, labelSize);
}
