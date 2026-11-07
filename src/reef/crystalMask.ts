// The crystal face's etched mask, shared by crystal.ts (the default placeholder) and crystalText.ts
// (rotating messages). One canvas drives the face's transmission and roughness maps:
//   red   = clarity (255 clear, 0 etched/opaque)
//   green = frost (255 rough/frosted, ~16 smooth)
import { context2d } from '../util.js';

export const DEFAULT_CRYSTAL_TEXT = ['Your message here'] as const;
export const DEFAULT_LABEL = 'Sponsored';

const CLEAR = 'rgb(255,16,0)';
const ETCH = 'rgb(0,255,0)';
const GLOW = 'rgba(150,225,255,0.85)';

interface FontLayout { readonly size: number; readonly labelSize: number }

/** Finds a font size (and label size) that fits lines + label within the given box. */
function fitFont(g: CanvasRenderingContext2D, lines: readonly string[], label: string, maxW: number, maxH: number): FontLayout {
  const labelRatio = 0.45;
  let size = maxH;
  for (let i = 0; i < 40; i++) {
    const lineH = size * 1.24;
    const labelSize = size * labelRatio;
    const totalH = lines.length * lineH + (label ? labelSize * 1.6 : 0);
    g.font = `600 ${Math.round(size)}px system-ui, 'Segoe UI', sans-serif`;
    let widest = 0;
    for (const line of lines) widest = Math.max(widest, g.measureText(line).width);
    g.font = `600 ${Math.round(labelSize)}px system-ui, 'Segoe UI', sans-serif`;
    const labelW = label ? g.measureText(label).width : 0;
    if (totalH <= maxH && widest <= maxW && labelW <= maxW) break;
    size *= 0.94;
  }
  return { size, labelSize: size * labelRatio };
}

/** Draws the etch mask into the canvas (red clarity, green frost), with soft edges and a faint glow. */
export function renderMask(canvas: HTMLCanvasElement, lines: readonly string[], label: string): void {
  const g = context2d(canvas);
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = CLEAR;
  g.fillRect(0, 0, W, H);
  const margin = 0.09;
  const maxW = W * (1 - 2 * margin), maxH = H * (1 - 2 * margin);
  const { size, labelSize } = fitFont(g, lines, label, maxW, maxH);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  const lineH = size * 1.24;
  const blockH = lines.length * lineH + (label ? labelSize * 1.7 : 0);
  let y = (H - blockH) / 2 + lineH / 2;

  const etch = (text: string, cy: number, font: string, blur: number): void => {
    g.font = font;
    g.shadowColor = GLOW;
    g.shadowBlur = blur;
    g.fillStyle = ETCH;
    g.fillText(text, W / 2, cy);
    g.shadowColor = 'transparent';
    g.shadowBlur = 0;
    g.fillStyle = ETCH;
    g.fillText(text, W / 2, cy);
  };

  for (const line of lines) {
    etch(line, y, `600 ${Math.round(size)}px system-ui, 'Segoe UI', sans-serif`, Math.round(size * 0.16));
    y += lineH;
  }
  if (label) {
    const ly = y + labelSize * 0.35;
    etch(label.toUpperCase(), ly, `600 ${Math.round(labelSize)}px system-ui, 'Segoe UI', sans-serif`, Math.round(labelSize * 0.2));
  }
}
