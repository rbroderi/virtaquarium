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
const ETCH = 'rgb(0,255,0)';
const GLOW = 'rgba(150,225,255,0.85)';
const FONT = `system-ui, 'Segoe UI', sans-serif`;
const LABEL_RATIO = 0.45;

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
 * the width of text at a given px size; injected so the fit is unit-testable without a canvas.
 */
export function layoutCrystalText(
  measure: (text: string, sizePx: number) => number,
  text: readonly string[],
  label: string,
  maxW: number,
  maxH: number,
): CrystalTextLayout {
  let size = maxH;
  for (let i = 0; i < 14; i++) {
    const labelSize = size * LABEL_RATIO;
    let wrapped: string[] = [];
    for (const line of text) wrapped = wrapped.concat(wrapLine(measure, line, size, maxW));
    const lineH = size * 1.24;
    const totalH = wrapped.length * lineH + (label ? labelSize * 1.6 : 0);
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

/** Draws the etch mask into the canvas (red clarity, green frost), with soft edges and a faint glow. */
export function renderMask(canvas: HTMLCanvasElement, lines: readonly string[], label: string): void {
  const g = context2d(canvas);
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = CLEAR;
  g.fillRect(0, 0, W, H);
  const margin = 0.08;
  const maxW = W * (1 - 2 * margin), maxH = H * (1 - 2 * margin);
  const measure = (text: string, sizePx: number): number => {
    g.font = `600 ${Math.round(sizePx)}px ${FONT}`;
    return g.measureText(text).width;
  };
  const { size, labelSize, lines: wrapped } = layoutCrystalText(measure, lines, label, maxW, maxH);

  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  const lineH = size * 1.24;
  const blockH = wrapped.length * lineH + (label ? labelSize * 1.7 : 0);
  let y = (H - blockH) / 2 + lineH / 2;

  // A slightly frosted plate behind the text, so the letters read against any background.
  const platePad = size * 0.4;
  const plateW = Math.min(maxW, Math.max(...wrapped.map((l) => measure(l, size))) + platePad * 2);
  const plateH = blockH + platePad * 2;
  const plateX = (W - plateW) / 2, plateY = (H - plateH) / 2;
  g.save();
  g.shadowColor = 'rgba(150,110,0,0.85)';
  g.shadowBlur = size * 0.3;
  g.fillStyle = 'rgb(150,110,0)';
  roundRect(g, plateX, plateY, plateW, plateH, size * 0.18);
  g.fill();
  g.restore();
  g.shadowColor = 'transparent';
  g.shadowBlur = 0;

  const etch = (text: string, cy: number, fontPx: number): void => {
    const font = `600 ${Math.round(fontPx)}px ${FONT}`;
    g.font = font;
    g.shadowColor = GLOW;
    g.shadowBlur = Math.round(fontPx * 0.16);
    g.fillStyle = ETCH;
    g.fillText(text, W / 2, cy);
    g.shadowColor = 'transparent';
    g.shadowBlur = 0;
    g.fillStyle = ETCH;
    g.fillText(text, W / 2, cy);
  };

  for (const line of wrapped) {
    etch(line, y, size);
    y += lineH;
  }
  if (label) etch(label.toUpperCase(), y + labelSize * 0.35, labelSize);
}

/** Rounds a rect path (ctx.roundRect isn't present in every runtime). */
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + radius, y);
  g.lineTo(x + w - radius, y);
  g.arcTo(x + w, y, x + w, y + radius, radius);
  g.lineTo(x + w, y + h - radius);
  g.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  g.lineTo(x + radius, y + h);
  g.arcTo(x, y + h, x, y + h - radius, radius);
  g.lineTo(x, y + radius);
  g.arcTo(x, y, x + radius, y, radius);
  g.closePath();
}
