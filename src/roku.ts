// Roku preview: plays the baked assets in roku/assets/ the way the Roku channel will, with no WebGL.
// Only what SceneGraph can do: a 1920x1080 backdrop poster, sprite-sheet fish and the foreground reef
// poster over fish that are behind it, driven by a simple brain (roku/school.ts). Each viewing angle
// (tail-on, side-on, head-on) is its own page holding the swim cycle; a fish facing left is the mirror
// image, and the player crossfades the two nearest angles (two posters on the Roku).
// Texture memory is budgeted as on the Roku (roku/textures.ts): pages are loaded ahead of need and
// freed when no poster shows them, so the total stays under ?budget= MB however many angles were baked.
// The view is zoomed in and pans slowly (view.ts): everything lives on a strip wider than the screen,
// drawn shifted by the pan; backdrop and foreground columns, and fish, out of view hold no textures.
//   /roku.html?scene=reef-7&fps=30&seed=1&budget=40&latency=80
// Keys: H hud, W moving water on/off, Space pause.
import { context2d, errorMessage, mulberry32, requireElement } from './util.js';
import { BubbleColumn } from './roku/bubbles.js';
import { SceneGeometry } from './roku/geometry.js';
import { parseManifest, parseScene, type Manifest } from './roku/manifest.js';
import { RokuPlayer } from './roku/player.js';
import { School } from './roku/school.js';
import { BYTES_PER_MB, TextureBudget } from './roku/textures.js';

const ASSETS = '/roku/assets/';
const MS_PER_S = 1000;
const VSYNC_TOLERANCE_MS = 2;   // so 60 Hz vsync lands on every 2nd frame at 30 fps
const MAX_STEP_S = 0.1;
const STATS_PERIOD_MS = 1000;

interface PlayerOptions {
  readonly fps: number;
  readonly seed: number;
  /** Roku texture memory is ~100 MB shared with the OS, whose own textures can take more than half of
   *  it (jellyrock/jellyrock#74 measured 58 MB OS, 32 MB app), so the app keeps to its own budget. */
  readonly budgetMB: number;
  /** ms to load and decode a bitmap, as on the device */
  readonly latencyMs: number;
  /** drive the loop from a timer instead of animation frames (headless or hidden-window checks) */
  readonly timer: boolean;
  readonly scene: string | null;
}

function readOptions(params: URLSearchParams): PlayerOptions {
  return {
    fps: Number(params.get('fps') || 30),
    seed: Number(params.get('seed') || 1),
    budgetMB: Number(params.get('budget') || 40),
    latencyMs: Number(params.get('latency') ?? 80),
    timer: params.has('timer'),
    scene: params.get('scene'),
  };
}

function showError(message: string): void {
  const el = requireElement('error', HTMLDivElement);
  el.style.display = 'grid';
  el.textContent = message;
}

async function loadManifest(): Promise<Manifest> {
  const res = await fetch(ASSETS + 'manifest.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('No baked assets found. Run `npm run bake` (or run_baked.bat bake) first.');
  return parseManifest(await res.json());
}

/** Frame-rate counters shown in the HUD, refreshed once a second. */
class Stats {
  private frames = 0;
  private since = 0;
  private loads0 = 0;
  private misses0 = 0;
  fps = 0;
  loads = 0;
  misses = 0;

  tick(now: number, tex: TextureBudget): void {
    this.frames++;
    if (now - this.since <= STATS_PERIOD_MS) return;
    this.fps = this.frames; this.frames = 0; this.since = now;
    this.loads = tex.loads - this.loads0; this.loads0 = tex.loads;
    this.misses = tex.misses - this.misses0; this.misses0 = tex.misses;
  }
}

async function main(opts: PlayerOptions): Promise<void> {
  const canvas = requireElement('screen', HTMLCanvasElement);
  const hud = requireElement('hud', HTMLDivElement);
  const g = context2d(canvas);
  const rand = mulberry32(opts.seed);

  const manifest = await loadManifest();
  const keys = Object.keys(manifest.scenery);
  const sceneKey = opts.scene !== null && manifest.scenery[opts.scene] ? opts.scene : keys[0];
  if (sceneKey === undefined) throw new Error('manifest has no scenery; re-bake');
  const scene = parseScene(manifest.scenery[sceneKey], sceneKey);
  canvas.width = manifest.screen.w;
  canvas.height = manifest.screen.h;

  const tex = new TextureBudget(opts.budgetMB, opts.latencyMs, ASSETS, (url) => showError(`missing ${url}`));
  const geo = new SceneGeometry(manifest, scene);
  // Bubbles draw from the shared rng before the fish, as the original did.
  const bubbles = manifest.bubbles && scene.bubbler ? new BubbleColumn(manifest.bubbles, scene.bubbler, rand) : null;
  const school = new School(manifest.species, scene, geo, rand);
  const player = new RokuPlayer(g, scene, geo, manifest.species, school, tex, bubbles, scene.water);

  let paused = false, showHud = true, last = performance.now(), acc = 0;
  const stats = new Stats();
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { paused = !paused; e.preventDefault(); }
    if (e.code === 'KeyH') showHud = !showHud;
    if (e.code === 'KeyW') player.showWater = !player.showWater;
  });

  const nextFrame = (f: (now: number) => void): void => {
    if (opts.timer) setTimeout(() => f(performance.now()), MS_PER_S / opts.fps);
    else requestAnimationFrame(f);
  };
  const mb = (b: number): string => (b / BYTES_PER_MB).toFixed(1);

  function loop(now: number): void {
    nextFrame(loop);
    acc += now - last;
    last = now;
    // Run at the Roku's frame rate, not the monitor's.
    if (acc < MS_PER_S / opts.fps - VSYNC_TOLERANCE_MS) return;
    const dt = Math.min(acc / MS_PER_S, MAX_STEP_S);
    acc = 0;
    if (!paused) player.advance(dt);
    player.plan(paused ? 0 : dt);
    player.render();
    stats.tick(now, tex);
    hud.textContent = showHud
      ? `Roku preview  ${sceneKey}  ${school.fish.length} fish  ${stats.fps}/${opts.fps} fps${paused ? '  paused' : ''}${scene.water ? '' : '  (no water loop: re-bake)'}\n`
        + `textures ${mb(tex.used)}/${opts.budgetMB} MB (peak ${mb(tex.peak)}, needed ${mb(tex.need)})  ${tex.bitmapCount} bitmaps  ${stats.loads} loads/s  ${stats.misses} misses/s\n`
        + 'H hud  W water  Space pause'
      : '';
  }
  nextFrame(loop);
}

main(readOptions(new URLSearchParams(location.search))).catch((e: unknown) => showError(errorMessage(e)));
