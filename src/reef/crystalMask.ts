// The crystal face's etched mask, shared by crystal.ts (the default placeholder) and crystalText.ts
// (rotating messages). One canvas drives the face's etch and frost:
//   red   = clarity (255 clear, 0 etched/opaque)
//   green = frost (255 rough/frosted, ~16 smooth)
// Text wraps and auto-sizes so every line stays inside the face with a margin (layoutCrystalText,
// unit-tested).
import { context2d } from '../util.js';

export const DEFAULT_CRYSTAL_TEXT = ['Red Sea Coral Pro salt'] as const;
export const DEFAULT_LABEL = '';

const CLEAR = 'rgb(255,16,0)';
const FROST = 'rgb(0,255,0)';
/** The faint darker inner edge on each glyph (B channel; R/G stay frosted, not a clear halo). */
const EDGE = 'rgb(0,255,255)';
const FONT = `system-ui, 'Segoe UI', sans-serif`;
const LABEL_RATIO = 0.45;
/** Fallback line-height ratio (of the font size) when the canvas reports no glyph bounds. */
const FALLBACK_LINE_RATIO = 1.34;

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
 * Wraps and sizes text (and an optional label) so every line fits within maxW x maxH. `measure` returns
 * the width of text at a given px size and `lineHeight` the height of one line at that size; both are
 * injected so the fit is unit-testable without a canvas.
 */
export function layoutCrystalText(
  measure: (text: string, sizePx: number) => number,
  text: readonly string[],
  label: string,
  maxW: number,
  maxH: number,
  lineHeight: (sizePx: number) => number = (s): number => s * 1.24,
): CrystalTextLayout {
  let size = maxH;
  for (let i = 0; i < 14; i++) {
    const labelSize = size * LABEL_RATIO;
    let wrapped: string[] = [];
    for (const line of text) wrapped = wrapped.concat(wrapLine(measure, line, size, maxW));
    const lineH = lineHeight(size);
    const totalH = wrapped.length * lineH + (label ? labelSize * 1.7 : 0);
    let widest = 0;
    for (const w of wrapped) widest = Math.max(widest, measure(w, size));
    const labelW = label ? measure(label.toUpperCase(), labelSize) : 0;
    const hScale = Math.min(1, maxH / Math.max(1e-6, totalH));
    const wScale = Math.min(1, maxW / Math.max(1e-6, widest), label ? maxW / Math.max(1e-6, labelW) : 1);
    const scale = Math.min(hScale, wScale);
    size *= scale;
    if (scale >= 0.995) break;
  }
  const wrapped: string[] = [];
  for (const line of text) wrapped.push(...wrapLine(measure, line, size, maxW));
  return { size, labelSize: size * LABEL_RATIO, lines: wrapped };
}

/** The canvas's line height for the etched font: the glyphs' real ascent+descent plus a little leading,
 *  so multi-line blocks never spill past the face (Segoe UI's line box is taller than 1.24 em). */
function measureLineHeight(g: CanvasRenderingContext2D, sizePx: number): number {
  g.font = `600 ${Math.round(sizePx)}px ${FONT}`;
  const m = g.measureText('AgjQy');
  const asc = m.actualBoundingBoxAscent;
  const desc = m.actualBoundingBoxDescent;
  return typeof asc === 'number' && typeof desc === 'number' && asc + desc > 0
    ? (asc + desc) * 1.15
    : sizePx * FALLBACK_LINE_RATIO;
}

/** The face's etched-text area as canvas fractions [x0, y0, x1, y1] (from the face's inscribed rect). */
export type CrystalTextRegion = readonly [number, number, number, number];

/** Draws the etch mask into the canvas (red clarity, green frost, blue inner edge), soft and beveled. */
export function renderMask(canvas: HTMLCanvasElement, lines: readonly string[], label: string, region?: CrystalTextRegion): void {
  const g = context2d(canvas);
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = CLEAR;
  g.fillRect(0, 0, W, H);
  const [rx0, ry0, rx1, ry1] = region ?? [0.08, 0.08, 0.92, 0.92];
  const pad = 0.03;   // a little breathing room inside the face's text area
  const fit = 0.8;    // the widest line keeps ~10% margin on each side, so glyphs never reach the face edge
  const x0 = rx0 + pad, x1 = rx1 - pad, y0 = ry0 + pad, y1 = ry1 - pad;
  const maxW = (x1 - x0) * W * fit, maxH = (y1 - y0) * H * fit;
  const cx = ((x0 + x1) / 2) * W, cyTop = ((y0 + y1) / 2) * H;
  const measure = (text: string, sizePx: number): number => {
    g.font = `600 ${Math.round(sizePx)}px ${FONT}`;
    return g.measureText(text).width;
  };
  const lineH = (sizePx: number): number => measureLineHeight(g, sizePx);
  const { size, labelSize, lines: wrapped } = layoutCrystalText(measure, lines, label, maxW, maxH, lineH);

  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  const lineHpx = lineH(size);
  const blockH = wrapped.length * lineHpx + (label ? labelSize * 1.7 : 0);
  let y = cyTop - blockH / 2 + lineHpx / 2;

  const etch = (text: string, cy: number, fontPx: number): void => {
    const font = `600 ${Math.round(fontPx)}px ${FONT}`;
    const bevel = Math.max(1, Math.round(fontPx * 0.08));
    const edgeSoft = Math.max(1, Math.round(fontPx * 0.06));
    const frostSoft = Math.max(1, Math.round(fontPx * 0.03));
    g.font = font;
    // Faint darker inner edge first (the B channel), dropped a hair below the glyph: light from above
    // leaves the recess's lower lip in shadow, so the letters read as etched into the glass, not
    // printed on it. Soft, not a heavy halo.
    g.shadowColor = EDGE;
    g.shadowBlur = edgeSoft;
    g.fillStyle = EDGE;
    g.fillText(text, cx, cy + bevel);
    g.shadowColor = 'transparent';
    g.shadowBlur = 0;
    g.fillStyle = EDGE;
    g.fillText(text, cx, cy + bevel);
    // The frosted white/ice glyph on top (the R/G channels), with a soft edge.
    g.shadowColor = FROST;
    g.shadowBlur = frostSoft;
    g.fillStyle = FROST;
    g.fillText(text, cx, cy);
    g.shadowBlur = 0;
    g.fillStyle = FROST;
    g.fillText(text, cx, cy);
  };

  for (const line of wrapped) {
    etch(line, y, size);
    y += lineHpx;
  }
  if (label) etch(label.toUpperCase(), y + labelSize * 0.35, labelSize);
}
