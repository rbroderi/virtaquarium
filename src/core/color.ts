// Hex colour helpers for the canvas painters.
import { lerp } from './math.js';

export type Rgb = readonly [number, number, number];

const HEX_RADIX = 16;
const WHITE = '#ffffff';
const BLACK = '#000000';

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const channel = (at: number): number => parseInt(h.slice(at, at + 2), HEX_RADIX);
  return [channel(0), channel(2), channel(4)];
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function mixHex(from: string, to: string, t: number): string {
  const a = hexToRgb(from), b = hexToRgb(to);
  const mixed = a.map((x, i) => Math.round(lerp(x, b[i] ?? x, t)).toString(HEX_RADIX).padStart(2, '0'));
  return '#' + mixed.join('');
}

/** Lighten (amount > 0, towards white) or darken (amount < 0, towards black). */
export const shade = (hex: string, amount: number): string =>
  amount >= 0 ? mixHex(hex, WHITE, amount) : mixHex(hex, BLACK, -amount);
