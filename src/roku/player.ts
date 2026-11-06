// Draws a baked scene the way the Roku channel will: a backdrop strip of tiles, moving-water overlays,
// sprite-sheet fish (two crossfaded angle pages each, mirrored when facing left), the foreground reef
// tiles over fish that are behind it, and the bubble column. Each frame it first plans which bitmaps
// it needs (TextureBudget), then draws only what is loaded.
import { DEG_TO_RAD } from '../util.js';
import type { BubbleColumn } from './bubbles.js';
import type { SceneGeometry } from './geometry.js';
import { wrapAngle } from './geometry.js';
import type { AnglePage, SceneEntry, SpriteSpecies, Tile, WaterLayer, WaterLoop } from './manifest.js';
import type { School, SpriteFish } from './school.js';
import { BYTES_PER_MB, TexturePriority, type TextureBudget } from './textures.js';

const NEAR = 0.35;                 // depth above which a fish swims in front of the foreground reef
const BYTES_PER_PIXEL = 4;
const PAN_LOOKAHEAD_S = 0.5;
const PAN_PRELOAD_PX = 300;
const BUBBLE_HALF_WIDTH_PX = 50, BUBBLE_PRELOAD_PX = 300;
const FISH_PRELOAD_PX = 150;       // just outside counts, so pages are ready
const TURN_LOOKAHEAD_S = 0.4;
const MAX_TILT = 0.35, TILT_EASE = 0.1, TILT_SPEED_PAD = 1;
const BOB_RATE = 1.3, BOB_PX = 2;
const CROSSFADE_MIN = 0.02, CROSSFADE_MAX = 0.98;
const UNLOADED_BACKDROP = '#0b3a55';

const tileBytes = (t: Tile): number => t.rect[2] * t.rect[3] * BYTES_PER_PIXEL;
const pageBytes = (a: AnglePage): number => a.mb * BYTES_PER_MB;

/** A water overlay layer and the last frame it showed (held if the next isn't loaded). */
class WaterTrack {
  readonly bytes: number;
  last: HTMLImageElement | null = null;
  constructor(readonly layer: WaterLayer, scale: number) {
    this.bytes = Math.round(layer.rect[2] / scale) * Math.round(layer.rect[3] / scale) * BYTES_PER_PIXEL;
  }
}

interface FishView { readonly flip: boolean; readonly yaw: number; readonly u: number }

/** Angle pages are evenly spaced from the first to the last yaw over 180 degrees. */
const stepYaw = (sp: SpriteSpecies): number => 180 / (sp.angles.length - 1);

/** Fallback angle, always held: the one cruising fish are mostly seen at. */
function homeAngle(sp: SpriteSpecies): AnglePage | undefined {
  const yaws = sp.angles.map((a) => a.yaw);
  const off = (y: number | undefined): number => Math.abs((y ?? 0) - sp.cruiseYaw);
  const home = yaws.reduce((b, y, i) => (off(y) < off(yaws[b]) ? i : b), 0);
  return sp.angles[home];
}

export class RokuPlayer {
  showWater = true;
  waterT = 0;
  panT = 0;
  private panX: number;
  private readonly water: readonly (WaterTrack | null)[];

  constructor(
    private readonly g: CanvasRenderingContext2D,
    private readonly scene: SceneEntry,
    private readonly geo: SceneGeometry,
    private readonly species: readonly SpriteSpecies[],
    private readonly school: School,
    private readonly tex: TextureBudget,
    private readonly bubbles: BubbleColumn | null,
    private readonly waterLoop: WaterLoop | null,
  ) {
    this.panX = geo.panAt(0);
    this.water = waterLoop ? [waterLoop.back, waterLoop.front].map((L) => (L ? new WaterTrack(L, waterLoop.scale) : null)) : [null, null];
  }

  advance(dt: number): void {
    for (const f of this.school.fish) this.school.step(f, dt);
    this.waterT += dt;
    this.panT += dt;
    this.bubbles?.step(dt);
  }

  /** Is strip span [x0, x1] within `margin` px of the screen window? */
  private inView(x0: number, x1: number, margin = 0): boolean {
    return x1 > this.panX - margin && x0 < this.panX + this.geo.screenW + margin;
  }

  // Viewing angle for a fish's heading: shown a little turned towards the viewer while cruising
  // (cruiseYaw), and folded into -90..90 with a mirror flip for facing left. u indexes the angle pages.
  private view(f: SpriteFish): FishView {
    const { sp } = f, A = sp.angles.length;
    const psi = wrapAngle(f.psi + sp.cruiseYaw * DEG_TO_RAD * Math.cos(f.psi));
    const flip = Math.abs(psi) > Math.PI / 2, yaw = ((flip ? Math.sign(psi) * Math.PI - psi : psi) * 180) / Math.PI;
    const first = sp.angles[0]?.yaw ?? 0;
    const u = Math.min(Math.max((yaw - first) / stepYaw(sp), 0), A - 1);
    return { flip, yaw, u };
  }

  /** Ask for the pages each fish shows now, the ones its turn reaches next, and their neighbours. */
  plan(dt: number): void {
    const { tex, scene } = this;
    this.panX = this.geo.panAt(this.panT);
    // Backdrop and foreground columns: those on screen, and those the pan reaches next.
    const dir = Math.sign(this.geo.panAt(this.panT + PAN_LOOKAHEAD_S) - this.panX);
    for (const t of [...scene.backdrop, ...scene.foreground]) {
      const x0 = t.rect[0], x1 = x0 + t.rect[2];
      if (this.inView(x0, x1)) tex.want(t.file, tileBytes(t), TexturePriority.shown);
      else if (this.inView(x0 - dir * PAN_PRELOAD_PX, x1 - dir * PAN_PRELOAD_PX)) tex.want(t.file, tileBytes(t), TexturePriority.next);
    }
    for (const sp of this.species) {
      const home = homeAngle(sp);
      if (home) tex.want(home.sheet, pageBytes(home), TexturePriority.pinned);
    }
    const b = this.bubbles;
    if (b && this.inView(b.stoneX - BUBBLE_HALF_WIDTH_PX, b.stoneX + BUBBLE_HALF_WIDTH_PX, BUBBLE_PRELOAD_PX)) tex.want(b.sheetUrl, b.bytes, TexturePriority.shown);
    for (const f of this.school.fish) this.planFish(f, dt);
    this.planWater();
    tex.update();
  }

  private planFish(f: SpriteFish, dt: number): void {
    const { sp } = f, A = sp.angles.length, { u } = this.view(f), half = (sp.frameW * f.scale) / 2;
    f.onScreen = this.inView(f.x - half, f.x + half, FISH_PRELOAD_PX);
    if (!f.onScreen) return;   // off screen: its posters' uris are cleared
    f.du = dt > 0 ? (u - f.u) / dt : 0;
    f.u = u;
    const page = (r: number, prio: TexturePriority): void => {
      const a = sp.angles[r];
      if (a) this.tex.want(a.sheet, pageBytes(a), prio);
    };
    const r0 = Math.min(Math.floor(u), A - 2);
    page(r0, TexturePriority.shown); page(r0 + 1, TexturePriority.shown);
    // Where the shown angle will be in 0.4 s, and the pages on the way there.
    const ahead = Math.min(Math.max(u + f.du * TURN_LOOKAHEAD_S, 0), A - 1);
    for (let r = Math.min(r0, Math.floor(ahead)); r <= Math.max(r0 + 1, Math.ceil(ahead)); r++) page(r, TexturePriority.next);
    page(r0 - 1, TexturePriority.nearby); page(r0 + 2, TexturePriority.nearby);
  }

  private waterFrame(track: WaterTrack): { readonly k: number; readonly k1: number; readonly pos: number } {
    const fps = this.waterLoop?.fps ?? 0;
    const n = track.layer.frames.length, pos = (this.waterT * fps) % n, k = Math.floor(pos);
    return { k, k1: (k + 1) % n, pos };
  }

  private planWater(): void {
    for (const track of this.water) {
      if (!track) continue;
      const { layer } = track, { k, k1 } = this.waterFrame(track);
      const want = (url: string | undefined, prio: TexturePriority): void => { if (url !== undefined) this.tex.want(url, track.bytes, prio); };
      want(layer.frames[k], TexturePriority.shown); want(layer.frames[k1], TexturePriority.next);
      if (layer.steps) { want(layer.steps[k], TexturePriority.shown); want(layer.steps[k1], TexturePriority.next); }
    }
  }

  /** The loaded page nearest angle r (a miss if it isn't r itself). */
  private pageFor(sp: SpriteSpecies, r: number): { readonly a: AnglePage; readonly img: HTMLImageElement } | null {
    for (let d = 0; d < sp.angles.length; d++) {
      for (const q of d ? [r - d, r + d] : [r]) {
        const a = sp.angles[q];
        const img = a ? this.tex.get(a.sheet) : null;
        if (a && img) {
          if (d) this.tex.misses++;
          return { a, img };
        }
      }
    }
    return null;
  }

  private drawFish(f: SpriteFish): void {
    const { g } = this, { sp } = f, n = sp.frames, frame = Math.floor(f.phase * n) % n, A = sp.angles.length;
    const { flip, yaw, u } = this.view(f);
    const r0 = Math.min(Math.floor(u), A - 2), t = u - r0;
    // Climbing and diving tilt the side view; a head-on or tail-on view can't show it.
    const tiltW = Math.max(-MAX_TILT, Math.min(MAX_TILT, Math.atan2(f.vy, Math.abs(f.vx) + TILT_SPEED_PAD))) * Math.abs(Math.cos(yaw * DEG_TO_RAD));
    f.tilt += (tiltW - f.tilt) * TILT_EASE;
    const bob = f.mode === 'cruise' ? 0 : Math.sin(f.phase * BOB_RATE) * BOB_PX;
    g.save();
    g.translate(f.x, f.y + bob);
    if (flip) g.scale(-1, 1);
    g.rotate(f.tilt);
    // A cell is the angle page's crop of the full frameW x frameH cell, whose centre is the fish.
    const s = f.scale, drawn = new Set<AnglePage>();
    const cell = (r: number, alpha: number): void => {
      const p = this.pageFor(sp, r);
      if (!p || drawn.has(p.a)) return;   // the fallback for both angles is the same page: draw it once
      drawn.add(p.a);
      const { a, img } = p;
      g.globalAlpha = alpha;
      g.drawImage(img, (frame % a.cols) * a.w, Math.floor(frame / a.cols) * a.h, a.w, a.h,
        (a.x - sp.frameW / 2) * s, (a.y - sp.frameH / 2) * s, a.w * s, a.h * s);
    };
    // Nearer angle drawn solid, the other faded in over it.
    if (t < 0.5) { cell(r0, 1); if (t > CROSSFADE_MIN) cell(r0 + 1, t); }
    else { cell(r0 + 1, 1); if (t < CROSSFADE_MAX) cell(r0, 1 - t); }
    g.globalAlpha = 1;
    g.restore();
  }

  // Two posters per layer: frame k, and its step overlay at opacity t, which the bake encoded against
  // exactly what frame k leaves on screen, so together they are the linear blend towards frame k + 1.
  // If a frame hasn't loaded yet the last one shown holds (the water pauses rather than vanishing).
  private drawWater(track: WaterTrack | null | undefined): void {
    if (!track || !this.showWater) return;
    const { g } = this, { layer } = track, { k, pos } = this.waterFrame(track);
    const [x, y, w, h] = layer.rect;
    const frameUrl = layer.frames[k], stepUrl = layer.steps?.[k];
    const cur = frameUrl !== undefined ? this.tex.get(frameUrl) : null;
    const step = stepUrl !== undefined ? this.tex.get(stepUrl) : null;
    if (cur) track.last = cur; else this.tex.misses++;
    if (!track.last) return;
    g.drawImage(track.last, x, y, w, h);
    if (cur && step) {
      g.globalAlpha = pos - k;
      g.drawImage(step, x, y, w, h);
      g.globalAlpha = 1;
    }
  }

  /** Tiles (backdrop or foreground columns) on screen; a backdrop column not loaded yet is water blue. */
  private drawTiles(tiles: readonly Tile[], fillMissing: boolean): void {
    const { g } = this;
    for (const t of tiles) {
      const [x, y, w, h] = t.rect;
      if (!this.inView(x, x + w)) continue;
      const img = this.tex.get(t.file);
      if (img) g.drawImage(img, x, y);
      else if (fillMissing) { g.fillStyle = UNLOADED_BACKDROP; g.fillRect(x, y, w, h); this.tex.misses++; }
    }
  }

  render(): void {
    const { g, scene, school } = this;
    school.sortByDepth();
    g.save();
    g.translate(-Math.round(this.panX), 0);
    this.drawTiles(scene.backdrop, true);
    this.drawWater(this.water[0]);
    const b = this.bubbles;
    if (b && this.inView(b.stoneX - BUBBLE_HALF_WIDTH_PX, b.stoneX + BUBBLE_HALF_WIDTH_PX)) {   // the airstone is at the back
      const img = this.tex.get(b.sheetUrl);
      if (img) b.draw(g, img);
    }
    for (const f of school.fish) if (f.onScreen && f.depth <= NEAR) this.drawFish(f);
    this.drawTiles(scene.foreground, false);
    this.drawWater(this.water[1]);
    for (const f of school.fish) if (f.onScreen && f.depth > NEAR) this.drawFish(f);
    g.restore();
  }
}
