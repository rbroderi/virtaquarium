// The airstone's bubble column: sprites baked with the live bubble shader, sent up at the live rise
// speed (water.ts, Mendelson's wave analogy: U = sqrt(2.14 sigma / (rho d) + 0.505 g d)), zig-zagging
// once over 2 mm. A bubble a frame is released at the live rate (~90 in the column at once).
import type { Rng } from '../util.js';
import type { BubbleSheet, Bubbler } from './manifest.js';

const COLUMN_SIZE = 90;
const WOBBLE_CYCLE = 6.283;   // radians per wobble (2 pi, as the original rounds it)
const SPREAD_UNITS = 0.08;
const WOBBLE_HZ_MIN = 4, WOBBLE_HZ_RANGE = 4;
const ZIGZAG_FROM_MM = 2;
const ZIGZAG_M_PER_MM = 0.004;
const METRES_PER_UNIT = 0.125;
const SURFACE_TENSION = 0.072;   // N/m, water
const WATER_DENSITY = 1000;      // kg/m^3
const GRAVITY = 9.81;            // m/s^2
const MENDELSON_TENSION = 2.14, MENDELSON_GRAVITY = 0.505;
const MM_PER_M = 1000;

/** Rise speed of a bubble of this diameter, world units/s. */
export function riseSpeed(mm: number): number {
  const d = mm / MM_PER_M;
  return Math.sqrt((MENDELSON_TENSION * SURFACE_TENSION) / (WATER_DENSITY * d) + MENDELSON_GRAVITY * GRAVITY * d) / METRES_PER_UNIT;
}

interface Bubble { k: number; x: number; y: number; ph: number; f: number }

export class BubbleColumn {
  private readonly list: Bubble[] = [];
  private t = 0;
  /** Decoded bytes of the bubble sheet. */
  readonly bytes: number;

  constructor(private readonly sheet: BubbleSheet, private readonly stone: Bubbler, private readonly rng: Rng) {
    this.bytes = sheet.cell * sheet.mm.length * sheet.cell * 4;
    for (let i = 0; i < COLUMN_SIZE; i++) {
      this.list.push(this.respawn({ k: 0, x: 0, y: 0, ph: 0, f: 0 }, stone.pos[1] + this.rng() * (stone.top - stone.pos[1])));
    }
  }

  get stoneX(): number {
    return this.stone.pos[0];
  }

  get sheetUrl(): string {
    return this.sheet.sheet;
  }

  private respawn(b: Bubble, y: number): Bubble {
    b.k = Math.floor(this.rng() * this.sheet.mm.length);
    b.y = y;
    b.x = (this.rng() - 0.5) * SPREAD_UNITS * this.stone.pxPerUnit;
    b.ph = this.rng() * WOBBLE_CYCLE;
    b.f = WOBBLE_HZ_MIN + WOBBLE_HZ_RANGE * this.rng();
    return b;
  }

  private mm(b: Bubble): number {
    return this.sheet.mm[b.k] ?? 0;
  }

  step(dt: number): void {
    this.t += dt;
    for (const b of this.list) {
      b.y -= riseSpeed(this.mm(b)) * this.stone.pxPerUnit * dt;
      if (b.y < Math.max(this.stone.top, -this.sheet.cell)) this.respawn(b, this.stone.pos[1]);
    }
  }

  draw(g: CanvasRenderingContext2D, img: HTMLImageElement): void {
    const { stone, sheet } = this, s = stone.pxPerUnit / sheet.pxPerUnit;
    for (const b of this.list) {
      const mm = this.mm(b);
      const zz = mm > ZIGZAG_FROM_MM ? (((mm - ZIGZAG_FROM_MM) * ZIGZAG_M_PER_MM) / METRES_PER_UNIT) * stone.pxPerUnit : 0;
      const x = stone.pos[0] + b.x + Math.sin(this.t * b.f * WOBBLE_CYCLE + b.ph) * zz, c = sheet.cell * s;
      g.drawImage(img, b.k * sheet.cell, 0, sheet.cell, sheet.cell, x - c / 2, b.y - c / 2, c, c);
    }
  }
}
