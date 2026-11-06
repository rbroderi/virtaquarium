// The moving water. The Roku can't simulate the surface, so the moving water (caustics on sand and
// reef, light shafts, surface ripples, swaying soft corals) is baked as a short loop. Each frame is an
// overlay that, drawn over the static backdrop with plain alpha blending, turns it into that moment of
// the water. Only pixels that change carry alpha, so the frames crop and compress well. The waves never
// repeat, so the loop is a crossfade: frame s shows (s/T) F(s) + (1 - s/T) F(s + T), which starts and
// ends on F(T) (blended about the loop's mean, so the contrast holds through the fade).
// A second overlay set covers the foreground reef layer and is drawn over it.
import * as THREE from 'three';
import { waterUniforms, updateWaves, type Caustics, type WaterRenderer, type ShaftLight } from '../water.js';
import { context2d } from '../util.js';
import { CAUSTIC_T, SUPERSAMPLE, WATER_SCALE, type BakeConfig } from './config.js';
import { blankCanvas, readbackContext, saveAsset, toBlob, type Log } from './io.js';
import { composite, contrastMix, emptyBox, encodeOverlay, meanOf, rmsOffset, type DirtyBox, type Rgba } from './overlay.js';
import type { WaterEntry, WaterLayer } from './manifest.js';

/** The marine snow simulation the backdrop frames show (scenery.ts). */
export interface SnowLoop {
  /** Show copy k simulated forward to time t. */
  at(k: 0 | 1, t: number): void;
  off(): void;
}

export interface WaterStage {
  readonly renderer: THREE.WebGLRenderer;
  readonly config: BakeConfig;
  readonly log: Log;
  readonly key: string;
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  readonly sun: ShaftLight;
  readonly waterRenderer: WaterRenderer;
  readonly caustics: Caustics;
  readonly showForegroundOnly: (on: boolean) => void;
  readonly snow: SnowLoop;
}

interface Shot { b0: Rgba; f0: Rgba; b1: Rgba; f1: Rgba }

const FRAME_INDEX_DIGITS = 2;

/** Renders and reads back the backdrop and foreground layers at loop resolution. */
function makeGrabber(stage: WaterStage, w: number, h: number): { back(): Rgba; front(): Rgba; setTime(t: number, waves?: number): void } {
  const { renderer, scene, camera, sun, waterRenderer, caustics, showForegroundOnly } = stage;
  const g = readbackContext(blankCanvas(w, h));
  const read = (): Rgba => {
    g.clearRect(0, 0, w, h);
    g.drawImage(renderer.domElement, 0, 0, w, h);
    return g.getImageData(0, 0, w, h).data;
  };
  return {
    setTime(t, waves = t) {
      waterUniforms.uTime.value = t;
      updateWaves(waves);
      caustics.update();
    },
    back() {
      renderer.setClearColor(0x000000, 1);
      waterRenderer.render(scene, camera, sun);
      return read();
    },
    front() {
      showForegroundOnly(true);
      renderer.setClearColor(0x000000, 0);
      renderer.render(scene, camera);
      const d = read();
      showForegroundOnly(false);
      return d;
    },
  };
}

/** Each layer's final frame targets: the contrast-preserving crossfade of the t and t + loop shots. */
function crossfadeTargets(shots: readonly Shot[], frames: number): [Rgba, Rgba][] {
  const backs = shots.flatMap((s) => [s.b0, s.b1]), fronts = shots.flatMap((s) => [s.f0, s.f1]);
  const MB = meanOf(backs), MF = meanOf(fronts);
  const avg = (list: readonly Rgba[], M: Float32Array): number => list.reduce((s, d) => s + rmsOffset(d, M), 0) / list.length;
  const rmsB = avg(backs, MB), rmsF = avg(fronts, MF);
  return shots.map(({ b0, f0, b1, f1 }, i) => {
    const w = i / frames;
    return [contrastMix(b0, b1, w, MB, rmsB), contrastMix(f0, f1, w, MF, rmsF)];
  });
}

interface LayerOut { suffix: string; b: DirtyBox; c: HTMLCanvasElement; files: string[]; steps: string[]; rect: number[] }

async function saveLayerFrame(stage: WaterStage, L: LayerOut, data: Rgba, w: number, h: number, kind: string, index: number, list: string[]): Promise<void> {
  const cg = context2d(L.c);
  cg.clearRect(0, 0, L.c.width, L.c.height);
  cg.putImageData(new ImageData(data, w, h), -L.b.x0, -L.b.y0, L.b.x0, L.b.y0, L.c.width, L.c.height);
  const file = `scenery/${stage.key}-water${L.suffix}-${kind}${String(index).padStart(FRAME_INDEX_DIGITS, '0')}.png`;
  await saveAsset(file, await toBlob(L.c, 'image/png'));
  list.push(file);
}

export async function bakeWater(stage: WaterStage): Promise<WaterEntry> {
  const { renderer, config, log, key, snow } = stage;
  const W = config.strip.w / WATER_SCALE, H = config.strip.h / WATER_SCALE, N = config.waterFrames;
  renderer.setSize(W * SUPERSAMPLE, H * SUPERSAMPLE, false);   // supersampled as the static layers
  const grab = makeGrabber(stage, W, H);

  // Bases: the backdrop and foreground exactly as baked, at loop resolution (no snow: the static layers have none).
  grab.setTime(0, CAUSTIC_T);
  snow.off();
  const B = grab.back(), G = grab.front();
  const fgAlpha = new Uint8ClampedArray(W * H), backMask = new Uint8ClampedArray(W * H);
  for (let p = 0; p < W * H; p++) {
    fgAlpha[p] = G[p * 4 + 3] ?? 0;
    backMask[p] = 255 - (fgAlpha[p] ?? 0);
  }

  const shots: Shot[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = CAUSTIC_T + (i / N) * config.waterLoopSeconds, t1 = t0 + config.waterLoopSeconds;
    // Snow shows in the backdrop layer's frames (the foreground layer covers only the near reef).
    grab.setTime(t0); snow.at(0, t0); const b0 = grab.back(); snow.off(); const f0 = grab.front();
    grab.setTime(t1); snow.at(1, t1); const b1 = grab.back(); snow.off(); const f1 = grab.front();
    shots.push({ b0, f0, b1, f1 });
    log(`water ${key}: frame ${i + 1}/${N}`);
  }
  const targets = crossfadeTargets(shots, N);
  shots.length = 0;   // ~8 MB a frame; the overlays below need as much again

  // Each step has two overlays: the frame itself (over the static base), and a step overlay that takes
  // what is then on screen to the next frame. The Roku draws the frame, then the step at opacity t;
  // because the step was encoded against exactly that screen, the result is the linear blend.
  const boxes = [emptyBox(W, H), emptyBox(W, H)] as const;
  const bases = [[B, backMask], [G, fgAlpha]] as const;
  const frames: [Rgba, Rgba][][] = [];
  for (let i = 0; i < N; i++) {
    frames.push(([0, 1] as const).map((l): [Rgba, Rgba] => {
      const [base, mask] = bases[l], box = boxes[l];
      const target = targets[i]?.[l], next = targets[(i + 1) % N]?.[l];
      if (!target || !next) throw new Error('water loop: missing frame');
      const O = encodeOverlay(target, base, mask, box, W);
      return [O, encodeOverlay(next, composite(base, O), mask, box, W)];
    }));
  }
  grab.setTime(0, CAUSTIC_T);

  // Crop every frame of a layer to the area that ever changes, and save.
  const layers = (['', '-fg'] as const).map((suffix, l): LayerOut | null => {
    const b = boxes[l === 0 ? 0 : 1];
    if (b.x1 <= b.x0) return null;
    const cw = b.x1 - b.x0, ch = b.y1 - b.y0;
    return { suffix, b, c: blankCanvas(cw, ch), files: [], steps: [], rect: [b.x0, b.y0, cw, ch].map((v) => v * WATER_SCALE) };
  });
  for (const [i, frame] of frames.entries()) {
    for (const [l, L] of layers.entries()) {
      const pair = frame[l];
      if (!L || !pair) continue;
      await saveLayerFrame(stage, L, pair[0], W, H, '', i, L.files);
      await saveLayerFrame(stage, L, pair[1], W, H, 'step-', i, L.steps);
    }
  }
  renderer.setSize(config.strip.w * SUPERSAMPLE, config.strip.h * SUPERSAMPLE, false);
  const layer = (L: LayerOut | null | undefined): WaterLayer | null => (L ? { rect: L.rect, frames: L.files, steps: L.steps } : null);
  return { fps: N / config.waterLoopSeconds, scale: WATER_SCALE, back: layer(layers[0]), front: layer(layers[1]) };
}
