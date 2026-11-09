// Look check, run on the tank page with ?check=look (headless: tools/check.ts look). Steps the tank as
// the live loop does, at 30 Hz, and at each requested moment renders a frame and saves it to
// out/look-<tag>-<t>s.png, plus close-ups (out/look-<tag>-<t>s-<what>.png) of
//   station   the cleaning station (cleaner and client)
//   <critter> a critter by kind (cuttlefish, octopus, turtle)
//   <species> the first fish of that species
//   fanworm   the most open feather-duster worm
//   <name>    a scenery piece by its object name (rock_a, coral_table, ...)
// URL options: &at=5,30 (seconds), &close=station,cleanerwrasse, &tag=name, &night=1 (lights off),
// &light=0.35 (fixed level), &hour=18 (jump the clock to an hour, for dawn/dusk/night colour).
// Reports { files, stats } to /__done, stats per frame: mean luminance and saturation, so looks can be
// compared over time without opening the pictures.
import * as THREE from 'three';
import type { AquariumHandle } from './app/handle.js';
import { addCaustics } from './water/materials.js';
import { causticUniforms } from './water/caustics.js';
import { waveUniforms } from './water/waves.js';
import { installReefLight } from './reefLight/webgpu.js';
import { reefLightUniforms } from './reefLight/uniforms.js';
import { gpuActive, webgpu } from './webgpu/tsl.js';
import type { Fish } from './fish.js';
import { context2d } from './util.js';
import { paintPendingVariants } from './fishModel.js';
import { fishUniforms } from './reef/fishPush.js';
import { canvasToBlob, postDone, saveFile, CHECK_OUT_DIR } from './checks/report.js';

const DT = 1 / 30;
const CLOSE_UP_PX = 512;
/** Close-up crop as a fraction of the frame height: the worm's is tighter. */
const CLOSE_UP_FRACTION = 0.35, WORM_CLOSE_UP_FRACTION = 0.14;
/** Worms further back than this are hidden by the reef. */
const WORM_MIN_Z = -0.5;
const MEASURE_DOWNSCALE = 8;
const LUMA = [0.2126, 0.7152, 0.0722] as const;
const STATS_DIGITS = 3;
/** How many fish of one species the variant strip shows side by side (one per distinct variant). */
const VARIANTS_COUNT = 6;
/** Cell size (px) of each fish in the variant strip. */
const VARIANT_CELL_PX = 320;
/** Crop fraction of frame height for each variant cell (tight: one fish nearly fills its cell). */
const VARIANT_CROP_FRACTION = 0.09;
/** Seconds the tank runs before the variant strip is captured (fish settle into a natural pose). */
const VARIANT_SETTLE_S = 5;

interface FrameStats { t: number; lum: number; sat: number }

/** True when the renderer is three's WebGPURenderer (its presented canvas cannot be read back). */
function isWebGpu(aq: AquariumHandle): boolean {
  return (aq.renderer as THREE.WebGLRenderer & { isWebGPURenderer?: boolean }).isWebGPURenderer === true;
}

/** The current frame as a 2D-readable canvas. WebGL: the live canvas. WebGPU: a CDP screenshot from the
 *  headless tool (the presented WebGPU canvas is opaque to toBlob/getImageData), drawn at the canvas's
 *  own size so close-ups and stats line up exactly as on the WebGL path. */
async function frameCanvas(aq: AquariumHandle): Promise<HTMLCanvasElement> {
  const canvas = aq.renderer.domElement;
  if (!isWebGpu(aq)) return canvas;
  const res = await fetch('/__shot', { method: 'POST' });
  if (!res.ok) throw new Error(`screenshot failed: ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  // The screenshot is the whole page viewport, not the canvas: a look check pins the canvas to a fixed
  // CSS size (stage.ts CHECK_VIEW) smaller than the window, so crop to the canvas rectangle first.
  const rect = canvas.getBoundingClientRect();
  const scale = bitmap.width / Math.max(1, window.innerWidth);
  context2d(out).drawImage(
    bitmap, rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale,
    0, 0, out.width, out.height);
  bitmap.close();
  return out;
}

export async function main(aq: AquariumHandle): Promise<void> {
  const { world } = aq;
  const q = new URLSearchParams(location.search);
  // The CDP screenshot is of the whole page; the WebGL path reads the canvas only. Hide the overlays so
  // both capture the canvas alone (the glass vignette and the fading hint would otherwise darken/smear
  // the WebGPU frame).
  for (const id of ['glass', 'hint']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  const at = (q.get('at') || '5,30').split(',').map(Number).sort((a, b) => a - b);
  const close = (q.get('close') || 'station').split(',').filter(Boolean);
  const tag = q.get('tag') || 'tank';
  if (q.get('night') === '1') aq.setLight(0);
  if (q.has('light')) aq.setLight(Number(q.get('light')));   // e.g. 0.35: dusk
  if (q.has('hour')) {
    const hour = Number(q.get('hour'));
    if (Number.isFinite(hour)) {
      aq.daylight.jumpTo(hour);   // e.g. 19: golden dusk with the real sun colour
      // Jump the light level too: the loop eases the level towards the clock over ~30 s, so an early
      // frame would still be mid-transition. An explicit --light/--night keeps its override.
      if (!q.has('light') && q.get('night') !== '1') aq.setLight(aq.daylight.level());
    }
  }
  const hide = (q.get('hide') ?? '').split(',').filter(Boolean);
  if (hide.includes('snow')) aq.snow.points.visible = false;
  if (hide.includes('fish')) for (const f of world.fish) f.model.visible = false;
  if (hide.length) aq.scene.traverse((o) => { if (hide.includes(o.name)) o.visible = false; });
  aq.fitCanvas();
  {
    // A look check builds one pinned frame size on both backends (stage.ts CHECK_VIEW); log the geometry
    // so a run can prove two captures came from the same scene, not just the same seed.
    const c = aq.renderer.domElement;
    console.log('look frame', JSON.stringify({
      window: [window.innerWidth, window.innerHeight], css: [c.clientWidth, c.clientHeight],
      px: [c.width, c.height], aspect: aq.camera.aspect,
    }));
  }
  const variantSpeciesId = q.get('variants');
  if (variantSpeciesId) return variants(aq, variantSpeciesId);
  if (q.get('series')) return series(aq, Number(q.get('series')), Number(q.get('dt') || DT));
  if (q.get('frames')) return frameSeries(aq, Number(q.get('frames')), Number(q.get('dt') || DT), Number(q.get('warm') || 0), tag, Number(q.get('every') ?? 1));
  if (q.get('probe') === 'lights') return probeLights(aq, at[0] ?? 5);
  if (q.get('probe') === 'caufield') return probeCausticField(aq, at[0] ?? 5);
  if (q.get('probe') === 'envtex') return probeEnvTex(aq, at[0] ?? 5);
  if (q.get('probe') === 'envconst') return probeEnvConst(aq, at[0] ?? 5);
  if (q.get('probe') === 'sphere') return probeSphere(aq, at[0] ?? 5);
  if (q.get('probe') === 'wrap') return probeWrap(aq, at[0] ?? 5);
  const files: string[] = [], stats: FrameStats[] = [];
  let t = 0;
  for (const target of at) {
    for (; t < target - 1e-6; t += DT) aq.step(DT);
    await aq.present();
    await settle();   // WebGPU presents on the compositor after the render promise resolves
    const shot = await frameCanvas(aq);
    const name = `look-${tag}-${target}s`;
    files.push(await saveFile(`${CHECK_OUT_DIR}${name}.png`, await canvasToBlob(shot)));
    stats.push({ t: target, ...measure(shot) });
    for (const what of close) {
      const crop = closeUp(aq, what, shot);
      if (crop) files.push(await saveFile(`${CHECK_OUT_DIR}${name}-${what}.png`, await canvasToBlob(crop)));
    }
  }
  const station = world.station && { client: world.station.client?.sp.id || null, cleaner: world.station.cleaner?.brain.thought };
  const report = { files, stats, station };
  console.log('look check', JSON.stringify(report));
  await postDone(JSON.stringify(report));
}

/** ?probe=lights: mean luminance with each light term alone (sun / hemi / environment), for comparing
 *  two backends without hunting for a region: a term the backends treat differently shows as a
 *  different contribution to the frame. */
async function probeLights(aq: AquariumHandle, target: number): Promise<void> {
  const tag = new URLSearchParams(location.search).get('tag') || 'probe';
  for (let t = 0; t < target - 1e-6; t += DT) aq.step(DT);
  const { scene } = aq;
  const suns: THREE.DirectionalLight[] = [], hemis: THREE.HemisphereLight[] = [];
  scene.traverse((o) => {
    if ((o as THREE.DirectionalLight).isDirectionalLight) suns.push(o as THREE.DirectionalLight);
    if ((o as THREE.HemisphereLight).isHemisphereLight) hemis.push(o as THREE.HemisphereLight);
  });
  const sunIntensity = suns.map((l) => l.intensity), hemiIntensity = hemis.map((l) => l.intensity);
  const envIntensity = scene.environmentIntensity;
  // The sun's two multipliers on the direct term: the simulated caustic factor (pushing the depth
  // layers past any surface makes causticAt return 1 on both backends) and the shadow map.
  const cauDepth = causticUniforms.uCauDepth.value.clone();
  const setCau = (on: boolean): void => {
    if (on) causticUniforms.uCauDepth.value.copy(cauDepth);
    else causticUniforms.uCauDepth.value.set(1e3, 2e3, 3e3);
  };
  const setShadow = (on: boolean): void => { for (const l of suns) l.shadow.intensity = on ? 1 : 0; };
  // Flat water (every wave amplitude zero) refracts uniformly, so causticAt has to return 1 everywhere:
  // a term that differs from the caustic-off variant with flat water is the lookup, not the simulation.
  const amps = waveUniforms.uWaves.value.map((v) => v.z);
  const setWaves = (on: boolean): void => {
    waveUniforms.uWaves.value.forEach((v, i) => { v.z = on ? amps[i] ?? 0 : 0; });
  };
  const setTerms = (sun: boolean, hemi: boolean, env: number): void => {
    suns.forEach((l, i) => { l.intensity = sun ? sunIntensity[i] ?? 0 : 0; });
    hemis.forEach((l, i) => { l.intensity = hemi ? hemiIntensity[i] ?? 0 : 0; });
    scene.environmentIntensity = envIntensity * env;
  };
  const variants = [
    ['all', true, true, 1], ['sun', true, false, 0], ['hemi', false, true, 0],
    ['env', false, false, 1], ['none', false, false, 0],
    ['envx2', false, false, 2], ['envx5', false, false, 5], ['envx12', false, false, 12],
    // The sun alone, with each of its two multipliers off in turn (see setCau / setShadow).
    ['sun-nocau', true, false, 0], ['sun-noshadow', true, false, 0], ['sun-plain', true, false, 0],
    ['sun-flat', true, false, 0],
  ] as const;
  const stats: ({ terms: string } & FrameStats)[] = [];
  for (const [terms, sun, hemi, env] of variants) {
    setTerms(sun, hemi, env);
    setCau(!terms.includes('nocau') && !terms.endsWith('-plain'));
    setShadow(!terms.includes('noshadow') && !terms.endsWith('-plain'));
    setWaves(!terms.endsWith('-flat'));
    // The caustic texture is only re-simulated inside the loop's step (which also re-applies the light
    // rig and would undo setTerms), so re-simulate it here, after changing the waves.
    aq.caustics?.update();
    await aq.present();
    await settle();
    const shot = await frameCanvas(aq);
    stats.push({ terms, t: target, ...measure(shot) });
    await saveFile(`${CHECK_OUT_DIR}look-${tag}-${terms}-${target}s.png`, await canvasToBlob(shot));
  }
  setTerms(true, true, 1);
  setCau(true);
  setShadow(true);
  setWaves(true);
  console.log('look probe', JSON.stringify({ stats }));
  await postDone(JSON.stringify({ stats }));
}

/** ?probe=caufield: read the simulated caustic field back (depth layer 1) and report its per-channel
 *  mean and a 4x4 box mean. Both backends must simulate the same field: the sun's caustic factor is the
 *  one term the two frames disagreed on, and this field is what feeds it. */
async function probeCausticField(aq: AquariumHandle, target: number): Promise<void> {
  for (let t = 0; t < target - 1e-6; t += DT) aq.step(DT);
  const cau = aq.caustics as unknown as { target?: THREE.WebGLArrayRenderTarget; targets?: THREE.RenderTarget[] };
  let report: Record<string, unknown>;
  if (isWebGpu(aq)) {
    const rt = cau.targets?.[1];
    if (!rt) { await postDone(JSON.stringify({ error: 'no gpu caustic target' })); return; }
    const r = aq.renderer as unknown as {
      readRenderTargetPixelsAsync(rt: THREE.RenderTarget, x: number, y: number, w: number, h: number): Promise<ArrayLike<number>>;
    };
    const decode = rt.texture.type === THREE.HalfFloatType ? halfToFloat : (v: number): number => v / 255;
    report = { tex: texInfo(rt.texture), ...fieldStats(await r.readRenderTargetPixelsAsync(rt, 0, 0, rt.width, rt.height), rt.width, rt.height, decode) };
  } else {
    const rt = cau.target;
    if (!rt) { await postDone(JSON.stringify({ error: 'no gl caustic target' })); return; }
    const r = aq.renderer as THREE.WebGLRenderer, prev = r.getRenderTarget();
    r.setRenderTarget(rt, 1);   // the array framebuffer stays on the layer last rendered to
    const px = new Uint16Array(rt.width * rt.height * 4);   // the caustic field is half-float now
    r.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, px as unknown as Float32Array);
    r.setRenderTarget(prev);
    report = { tex: texInfo(rt.texture), ...fieldStats(px, rt.width, rt.height, halfToFloat) };
  }
  console.log('look caustic field', JSON.stringify(report));
  await postDone(JSON.stringify(report));
}

/** The sampler the lookup actually gets (three may not apply the options the target was built with). */
function texInfo(t: THREE.Texture): Record<string, unknown> {
  const image = t.image as { width: number; height: number };
  return {
    type: t.type, format: t.format, wrap: [t.wrapS, t.wrapT], filter: [t.magFilter, t.minFilter],
    mips: t.generateMipmaps, size: [image.width, image.height],
  };
}

/** Per-channel mean of a readback and the mean of 4x4-pixel block averages (roughly what a blurred mip
 *  level reads). `zero` is the fraction of texels still at the clear colour. */
function fieldStats(px: ArrayLike<number>, w: number, h: number, decode: (v: number) => number): { mean: number[]; box: number[]; zero: number; max: number } {
  const sum = [0, 0, 0], box = [0, 0, 0];
  const add = (a: number[], i: number, v: number): void => { a[i] = (a[i] ?? 0) + v; };
  let zero = 0, max = 0;
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const block = [0, 0, 0];
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          const i = ((y + dy) * w + (x + dx)) * 4;
          const rgb = [decode(px[i] ?? 0), decode(px[i + 1] ?? 0), decode(px[i + 2] ?? 0)];
          rgb.forEach((v, c) => { add(block, c, v); add(sum, c, v); });
          if (rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0) zero++;
          max = Math.max(max, ...rgb.filter(Number.isFinite));
        }
      }
      block.forEach((v, c) => add(box, c, v / 16));
    }
  }
  const n = w * h, blocks = Math.ceil(w / 4) * Math.ceil(h / 4);
  const round = (v: number): number => +v.toFixed(3);
  return { mean: sum.map((v) => round(v / n)), box: box.map((v) => round(v / blocks)), zero: round(zero / n), max: round(max) };
}

/** ?probe=envtex: read the PMREM environment back and report the mean radiance of its first mip levels,
 *  to see whether the node path's environment capture (mip 0) or its blur chain (mips 1+) is dark. */
async function probeEnvTex(aq: AquariumHandle, target: number): Promise<void> {
  for (let t = 0; t < target - 1e-6; t += DT) aq.step(DT);
  const env = aq.scene.environment as (THREE.Texture & { __pmremTarget?: THREE.RenderTarget }) | null;
  const rt = env?.__pmremTarget;
  if (!env || !rt) {
    await postDone(JSON.stringify({ error: 'no environment render target' }));
    return;
  }
  const w = rt.width, h = rt.height;
  let pixels: ArrayLike<number>;
  if (isWebGpu(aq)) {
    const r = aq.renderer as unknown as {
      readRenderTargetPixelsAsync: (t: THREE.RenderTarget, x: number, y: number, w: number, h: number) => Promise<ArrayLike<number>>;
    };
    pixels = await r.readRenderTargetPixelsAsync(rt, 0, 0, w, h);
  } else {
    const buf = new Uint16Array(w * h * 4);
    (aq.renderer as THREE.WebGLRenderer).readRenderTargetPixels(rt as THREE.WebGLRenderTarget, 0, 0, w, h, buf);
    pixels = buf;
  }
  // CubeUV layout check: a coarse grid of per-cell means, in the read buffer's own row order (bottom-up
  // for WebGL readPixels, top-down for the WebGPU readback), plus each half's overall mean.
  const cols = 6, rows = 8;
  const grid: number[][] = [];
  const sums = new Map<string, { s: number[]; n: number }>();
  const half = pixels instanceof Uint16Array;
  for (let gy = 0; gy < rows; gy++) {
    const line: number[] = [];
    for (let gx = 0; gx < cols; gx++) {
      const cell = { s: [0, 0, 0], n: 0 };
      for (let y = Math.floor((gy * h) / rows); y < Math.floor(((gy + 1) * h) / rows); y++) {
        for (let x = Math.floor((gx * w) / cols); x < Math.floor(((gx + 1) * w) / cols); x++) {
          const i = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) cell.s[c]! += half ? halfToFloat(pixels[i + c] ?? 0) : pixels[i + c] ?? 0;
          cell.n++;
        }
      }
      line.push(Number(((cell.s[2] ?? 0) / Math.max(1, cell.n)).toFixed(3)));
      const key = gy < rows / 2 ? 'top' : 'bottom';
      const acc = sums.get(key) ?? { s: [0, 0, 0], n: 0 };
      for (let c = 0; c < 3; c++) acc.s[c]! += cell.s[c]!;
      acc.n += cell.n;
      sums.set(key, acc);
    }
    grid.push(line);
  }
  const halves = [...sums].map(([k, v]) => ({ half: k, rgb: v.s.map((s) => Number((s / v.n).toFixed(4))) }));
  const info = { size: [w, h], type: env.type, colorSpace: env.colorSpace, grid, halves };
  console.log('look envtex', JSON.stringify(info));
  await postDone(JSON.stringify(info));
}

/** ?probe=envconst: fill the PMREM environment's render target with one constant radiance, then render
 *  environment-only frames. With every texel identical, the sampled mip/face no longer matters, so a
 *  backend that still comes out dark has an application/units difference rather than a sampling one. */
async function probeEnvConst(aq: AquariumHandle, target: number): Promise<void> {
  const tag = new URLSearchParams(location.search).get('tag') || 'envconst';
  for (let t = 0; t < target - 1e-6; t += DT) aq.step(DT);
  const { scene } = aq;
  const suns: THREE.DirectionalLight[] = [], hemis: THREE.HemisphereLight[] = [];
  scene.traverse((o) => {
    if ((o as THREE.DirectionalLight).isDirectionalLight) suns.push(o as THREE.DirectionalLight);
    if ((o as THREE.HemisphereLight).isHemisphereLight) hemis.push(o as THREE.HemisphereLight);
  });
  suns.forEach((l) => { l.intensity = 0; });
  hemis.forEach((l) => { l.intensity = 0; });
  const envIntensity = scene.environmentIntensity;
  const rt = (scene.environment as (THREE.Texture & { __pmremTarget?: THREE.RenderTarget }) | null)?.__pmremTarget;
  const stats: ({ terms: string } & FrameStats)[] = [];
  const shoot = async (terms: string): Promise<void> => {
    await aq.present();
    await settle();
    const shot = await frameCanvas(aq);
    stats.push({ terms, t: target, ...measure(shot) });
    await saveFile(`${CHECK_OUT_DIR}look-${tag}-${terms}-${target}s.png`, await canvasToBlob(shot));
  };
  scene.environmentIntensity = 0;
  await shoot('none');
  if (rt) {
    const r = aq.renderer as unknown as {
      getRenderTarget(): THREE.RenderTarget | null;
      setRenderTarget(t: THREE.RenderTarget | null): void;
      getClearColor(c: THREE.Color): THREE.Color;
      setClearColor(c: THREE.Color | number, a?: number): void;
      getClearAlpha(): number;
      clear(color?: boolean, depth?: boolean, stencil?: boolean): void;
    };
    const prevTarget = r.getRenderTarget(), prevColor = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    r.setRenderTarget(rt);
    r.setClearColor(new THREE.Color(0.3, 0.3, 0.3), 1);   // linear working-space radiance, all directions
    r.clear(true, false, false);
    r.setClearColor(prevColor, prevAlpha);
    r.setRenderTarget(prevTarget);
  }
  scene.environmentIntensity = envIntensity;
  await shoot('const');
  scene.environmentIntensity = envIntensity * 5;
  await shoot('constx5');
  console.log('look envconst', JSON.stringify({ hasTarget: !!rt, stats }));
  await postDone(JSON.stringify({ hasTarget: !!rt, stats }));
}

/** ?probe=sphere: three plain white standard spheres in front of the camera — stock, through addCaustics
 *  (the reef-light wrapper, as every reef material is), and one that also receives shadows — measured
 *  under each light term and with the caustic factor switched off (uCauDepth pushed far past any
 *  surface, which makes causticAt return 1 on both backends). Separates "the light is not delivered"
 *  from "the wrapper drops it" from "the caustic multiplies it by zero". The materials are built the
 *  way the tank builds them (reef/materials.ts stdMat): a node material on the WebGPU path. */
async function probeSphere(aq: AquariumHandle, target: number): Promise<void> {
  const tag = new URLSearchParams(location.search).get('tag') || 'sphere';
  for (let t = 0; t < target - 1e-6; t += DT) aq.step(DT);
  const { scene, camera } = aq;
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const centre = camera.position.clone().add(dir.multiplyScalar(6));
  const mat = (wrap: boolean): THREE.Material => {
    const params = { color: 0xffffff, roughness: 0.8, metalness: 0 };
    if (gpuActive()) {
      const wg = webgpu();
      const m = new wg.MeshStandardNodeMaterial(params) as unknown as THREE.Material;
      return wrap ? installReefLight(m) : m;
    }
    const m = new THREE.MeshStandardMaterial(params);
    return wrap ? addCaustics(m) : m;
  };
  const make = (dx: number, wrap: boolean): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.6, 32, 16), mat(wrap));
    m.position.copy(centre).add(new THREE.Vector3(dx, 0, 0));
    scene.add(m);
    return m;
  };
  const plain = make(-1.4, false);
  const wrapped = make(0, true);
  const receiver = make(1.4, true);
  receiver.receiveShadow = true;
  const suns: THREE.DirectionalLight[] = [], hemis: THREE.HemisphereLight[] = [];
  scene.traverse((o) => {
    if ((o as THREE.DirectionalLight).isDirectionalLight) suns.push(o as THREE.DirectionalLight);
    if ((o as THREE.HemisphereLight).isHemisphereLight) hemis.push(o as THREE.HemisphereLight);
  });
  const sunIntensity = suns.map((l) => l.intensity), hemiIntensity = hemis.map((l) => l.intensity);
  const envIntensity = scene.environmentIntensity;
  const cauDepth = causticUniforms.uCauDepth.value.clone();
  const resetCau = (): void => { causticUniforms.uCauDepth.value.copy(cauDepth); };
  const noCau = (): void => { causticUniforms.uCauDepth.value.set(1e3, 2e3, 3e3); };
  const resetShadow = (): void => { for (const l of suns) l.shadow.intensity = 1; };
  const noShadow = (): void => { for (const l of suns) l.shadow.intensity = 0; };
  const setTerms = (sun: boolean, hemi: boolean, env: number): void => {
    suns.forEach((l, i) => { l.intensity = sun ? sunIntensity[i] ?? 0 : 0; });
    hemis.forEach((l, i) => { l.intensity = hemi ? hemiIntensity[i] ?? 0 : 0; });
    scene.environmentIntensity = envIntensity * env;
  };
  const variants: readonly (readonly [string, boolean, boolean, number, () => void])[] = [
    ['sun', true, false, 0, resetCau],
    ['sun-nocau', true, false, 0, noCau],
    ['sun-nocau-noshadow', true, false, 0, () => { noCau(); noShadow(); }],
    ['env', false, false, 1, resetCau],
    ['none', false, false, 0, resetCau],
  ];
  const stats: ({ terms: string } & FrameStats)[] = [];
  for (const [terms, sun, hemi, env, act] of variants) {
    setTerms(sun, hemi, env);
    act();
    await aq.present();
    await settle();
    const shot = await frameCanvas(aq);
    const W = shot.width, H = shot.height;
    const box = (m: THREE.Mesh): number => {
      const v = m.position.clone().project(camera);
      const cx = ((v.x + 1) / 2) * W, cy = ((1 - v.y) / 2) * H, r = H * 0.06;
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      context2d(c).drawImage(shot, cx - r, cy - r, r * 2, r * 2, 0, 0, 64, 64);
      return measure(c).lum;
    };
    stats.push({ terms, t: target, ...measure(shot) });
    console.log('sphere', JSON.stringify({
      terms, plain: box(plain), wrapped: box(wrapped), receiver: box(receiver),
      cau: causticUniforms.uCauDepth.value.toArray().join(','), shadow: suns.map((l) => l.shadow.intensity).join(','),
    }));
    await saveFile(`${CHECK_OUT_DIR}look-${tag}-${terms}-${target}s.png`, await canvasToBlob(shot));
  }
  setTerms(true, true, 1);
  resetCau();
  resetShadow();
  console.log('look sphere', JSON.stringify({ stats }));
  await postDone(JSON.stringify({ stats }));
}

/** ?probe=wrap: why a wrapped (installReefLight) node material renders dimmer on WebGPU than the
 *  unwrapped one. ONE sphere at one spot whose material is swapped, so every probe sees identical
 *  framing and background (spheres at different x are not comparable), under all lights, env only, and
 *  once more with the reef-light gate uniforms forced closed. The no-op wrapper (same overrides
 *  installReefLight installs, body delegated straight to the inner model) separates "the
 *  setupLightingModel override itself" from "the wrapper's shader code"; noopkey tests the
 *  customProgramCacheKey override alone; start/direct/indirect take one wrapper method each. */
async function probeWrap(aq: AquariumHandle, target: number): Promise<void> {
  const tag = new URLSearchParams(location.search).get('tag') || 'wrap';
  for (let t = 0; t < target - 1e-6; t += DT) aq.step(DT);
  if (!gpuActive()) { await postDone(JSON.stringify({ error: 'probe=wrap is WebGPU only' })); return; }
  const { scene, camera } = aq;
  const wg = webgpu();
  const gate = auditGate();
  // Which material classes the scene actually uses: a reef material built while gpuActive() was false
  // would be a classic MeshStandardMaterial (converted internally by WebGPURenderer) and would never
  // carry the reef-light wrapper at all.
  const census = { node: 0, classic: 0, wrapped: 0, sample: [] as { name: string; type: string; wrapped: boolean }[] };
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const m = mesh.material as (THREE.Material & { isMeshStandardNodeMaterial?: boolean; isMeshPhysicalNodeMaterial?: boolean }) | undefined;
    if (!m || mesh.isMesh !== true) return;
    const node = m.isMeshStandardNodeMaterial === true || m.isMeshPhysicalNodeMaterial === true;
    if (node) census.node++; else census.classic++;
    const wrapped = Object.prototype.hasOwnProperty.call(m, 'setupLightingModel');
    if (wrapped) census.wrapped++;
    if (census.sample.length < 12) census.sample.push({ name: mesh.name || '(unnamed)', type: m.type, wrapped });
  });
  console.log('wrap census', JSON.stringify(census));
  // Save the WGSL of the wrapped materials' modules: the wrapper is the only thing between these
  // materials, so its emitted code (the gate, rlSky/rlBounce/rlSun, the indirect assignment) is the
  // evidence, and the harness truncates console lines but not files.
  const gpuProto = (globalThis as unknown as { GPUDevice?: { prototype: { createShaderModule: (d: { code: string }) => unknown } } }).GPUDevice?.prototype;
  let dumped = 0;
  if (gpuProto) {
    const orig = gpuProto.createShaderModule;
    gpuProto.createShaderModule = function (this: unknown, desc: { code: string }): unknown {
      const module = orig.call(this, desc);
      if (desc.code.includes('rlSky') && dumped < 3) {
        const name = `wgsl-${tag}-${dumped++}.wgsl`;
        void saveFile(`${CHECK_OUT_DIR}${name}`, new Blob([desc.code], { type: 'text/plain' }));
        console.log('wgsl saved', name, desc.code.length);
      }
      return module;
    };
  }
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const centre = camera.position.clone().add(dir.multiplyScalar(8));
  type NodeMat = { setupLightingModel?: () => unknown; customProgramCacheKey: () => string };
  const plainMat = (): THREE.Material =>
    new wg.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 }) as unknown as THREE.Material;
  /** Node materials with identical params and the same customProgramCacheKey SHARE one shader program,
   *  so every variant here must carry its own key or it silently renders the first variant's program. */
  const uniq = (m: THREE.Material, k: string): THREE.Material => {
    const nm = m as unknown as NodeMat;
    const prevKey = nm.customProgramCacheKey.bind(m);
    nm.customProgramCacheKey = () => prevKey() + `|${k}`;
    return m;
  };
  type Model = { start: (...a: unknown[]) => void; direct: (...a: unknown[]) => void; indirect: (...a: unknown[]) => void; finish: (...a: unknown[]) => void };
  /** The reef wrapper's own model, but only the named methods come from it; the rest come from a plain
   *  PhysicalLightingModel, so one sphere per part shows which override loses the light. */
  const mixWrap = (m: THREE.Material, keep: { start?: boolean; direct?: boolean; indirect?: boolean }, k: string): THREE.Material => {
    installReefLight(m);
    const nm = m as unknown as NodeMat;
    const prev = nm.setupLightingModel!.bind(m);
    nm.setupLightingModel = () => {
      const w = prev() as Model;
      const plain = new wg.PhysicalLightingModel() as unknown as Model;
      return {
        start: (...a: unknown[]) => (keep.start ? w : plain).start(...a),
        direct: (...a: unknown[]) => (keep.direct ? w : plain).direct(...a),
        indirect: (...a: unknown[]) => (keep.indirect ? w : plain).indirect(...a),
        finish: (...a: unknown[]) => plain.finish(...a),
      };
    };
    return uniq(m, k);
  };
  /** The reef model's own methods, handed back as a plain object instead of a PhysicalLightingModel. */
  const objFromReef = (m: THREE.Material): THREE.Material => {
    installReefLight(m);
    const nm = m as unknown as NodeMat;
    const prev = nm.setupLightingModel!.bind(m);
    nm.setupLightingModel = () => {
      const w = prev() as Model;
      return { start: w.start.bind(w), direct: w.direct.bind(w), indirect: w.indirect.bind(w), finish: w.finish.bind(w) };
    };
    return uniq(m, 'objreef');
  };
  /** A subclass of PhysicalLightingModel that only delegates: separates "extends PhysicalLightingModel"
   *  from the reef wrapper's own method bodies. */
  const delegClass = (m: THREE.Material): THREE.Material => {
    const nm = m as unknown as NodeMat;
    const prev = nm.setupLightingModel?.bind(m);
    nm.setupLightingModel = () => {
      const inner = (prev ? prev() : new wg.PhysicalLightingModel()) as Model;
      class DelegatingModel extends wg.PhysicalLightingModel {
        override start(...a: unknown[]): void { inner.start(...a); }
        override direct(...a: unknown[]): void { inner.direct(...a); }
        override indirect(...a: unknown[]): void { inner.indirect(...a); }
        override finish(...a: unknown[]): void { inner.finish(...a); }
      }
      return new DelegatingModel();
    };
    return uniq(m, 'delegclass');
  };
  const makers: readonly (readonly [string, () => THREE.Material])[] = [
    ['plain', plainMat],
    ['reef', () => uniq(installReefLight(plainMat()), 'vreef')],
    ['start', () => mixWrap(plainMat(), { start: true }, 'vstart')],
    ['direct', () => mixWrap(plainMat(), { direct: true }, 'vdirect')],
    ['indirect', () => mixWrap(plainMat(), { indirect: true }, 'vindirect')],
    ['objreef', () => objFromReef(plainMat())],
    ['delegclass', () => delegClass(plainMat())],
  ];
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 16), makers[0]![1]());
  sphere.position.copy(centre);
  scene.add(sphere);
  const mats = makers.map(([label, make]) => [label, make()] as const);
  const suns: THREE.DirectionalLight[] = [], hemis: THREE.HemisphereLight[] = [];
  scene.traverse((o) => {
    if ((o as THREE.DirectionalLight).isDirectionalLight) suns.push(o as THREE.DirectionalLight);
    if ((o as THREE.HemisphereLight).isHemisphereLight) hemis.push(o as THREE.HemisphereLight);
  });
  const sunI = suns.map((l) => l.intensity), hemiI = hemis.map((l) => l.intensity);
  const envI = scene.environmentIntensity;
  const setTerms = (sun: boolean, hemi: boolean, env: number): void => {
    suns.forEach((l, i) => { l.intensity = sun ? sunI[i] ?? 0 : 0; });
    hemis.forEach((l, i) => { l.intensity = hemi ? hemiI[i] ?? 0 : 0; });
    scene.environmentIntensity = envI * env;
  };
  /** The sphere's on-screen box, 64x64. All probes share one sphere position, so every box has the same
   *  framing and the same background behind it (comparing spheres at different x does not). */
  const sphereBox = (shot: HTMLCanvasElement): HTMLCanvasElement => {
    const W = shot.width, H = shot.height;
    const v = centre.clone().project(camera);
    const cx = ((v.x + 1) / 2) * W, cy = ((1 - v.y) / 2) * H;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const e = centre.clone().add(right.multiplyScalar(0.5)).project(camera);
    const r = Math.max(8, Math.abs(((e.x - v.x) / 2) * W) * 0.8);
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    context2d(c).drawImage(shot, cx - r, cy - r, r * 2, r * 2, 0, 0, 64, 64);
    return c;
  };
  const passes: readonly (readonly [string, () => void])[] = [
    ['all', () => setTerms(true, true, 1)],
    ['env', () => setTerms(false, false, 1)],
    ['gate0', () => { setTerms(true, true, 1); gate.close(); }],
  ];
  const stats: Record<string, unknown>[] = [];
  for (const [name, act] of passes) {
    act();
    const strip = document.createElement('canvas');
    strip.width = 64 * mats.length;
    strip.height = 64;
    const row: Record<string, unknown> = { pass: name };
    for (let i = 0; i < mats.length; i++) {
      const [label, m] = mats[i]!;
      sphere.material = m;
      await aq.present();
      await settle();
      const box = sphereBox(await frameCanvas(aq));
      const s = measure(box);
      row[label] = Number(s.lum.toFixed(3));
      row[`${label}:sat`] = Number(s.sat.toFixed(3));
      // Top vs bottom half: a flipped environment lookup swaps the bright sky for the dark sand, which
      // shows up as the wrapped sphere's bottom getting brighter than its top.
      const top = document.createElement('canvas');
      top.width = 64; top.height = 32;
      const bot = document.createElement('canvas');
      bot.width = 64; bot.height = 32;
      context2d(top).drawImage(box, 0, 0, 64, 32, 0, 0, 64, 32);
      context2d(bot).drawImage(box, 0, 32, 64, 32, 0, 0, 64, 32);
      row[`${label}:t`] = Number(measure(top).lum.toFixed(3));
      row[`${label}:b`] = Number(measure(bot).lum.toFixed(3));
      context2d(strip).drawImage(box, i * 64, 0);
    }
    row.gate = gate.read();
    stats.push(row);
    console.log('wrap', JSON.stringify({ ...row, labels: mats.map(([l]) => l).join(',') }));
    await saveFile(`${CHECK_OUT_DIR}look-${tag}-${name}-${target}s.png`, await canvasToBlob(strip));
  }
  scene.remove(sphere);
  console.log('look wrap', JSON.stringify({ stats }));
  await postDone(JSON.stringify({ stats }));
}

/** The reef-light gate uniforms, read and (for the probe) forced closed. */
function auditGate(): { read: () => string; close: () => void } {
  return {
    read: () => [reefLightUniforms.uRLOn.value, reefLightUniforms.uRLScrOn.value, reefLightUniforms.uRLAOOn.value].join(','),
    close: () => {
      reefLightUniforms.uRLOn.value = 0;
      reefLightUniforms.uRLScrOn.value = 0;
      reefLightUniforms.uRLAOOn.value = 0;
    },
  };
}

/** The point a close-up centres on, or null if `what` isn't in the tank. */
function closeUpTarget(aq: AquariumHandle, what: string): { pos: THREE.Vector3; worm: boolean } | null {
  const { world } = aq;
  if (what === 'station') return world.station ? { pos: world.station.pos, worm: false } : null;
  if (what === 'fanworm') {
    // The most open feather-duster worm in front of the camera.
    const worm = (aq.reef.fanWorms?.worms ?? []).filter((w) => w.mouth.z > WORM_MIN_Z).sort((a, b) => a.retract - b.retract)[0];
    if (worm) return { pos: worm.mouth, worm: true };
  }
  // A critter by kind (cuttlefish, octopus, turtle).
  const critter = aq.critters.find((c) => c.kind === what);
  if (critter) return { pos: critter.pos, worm: false };
  const fish = world.fish.find((f) => f.sp.id === what);
  // (An eel's pos is not on its body, which lies along its path: centre on the middle of the body.)
  const mid = fish?.spine?.nodes[Math.floor(fish.spine.nodes.length / 2)];
  if (fish) return { pos: mid ?? fish.pos, worm: false };
  // A scenery piece by name: the front of its box.
  const piece = aq.scene.getObjectByName(what);   // depth-first, first match (as a traverse would find)
  if (!piece) return null;
  const box = new THREE.Box3().setFromObject(piece);
  return { pos: box.getCenter(new THREE.Vector3()).setZ(box.max.z), worm: false };
}

/** A square crop of the rendered frame centred on a world point, scaled to `size` px. */
function cropSquare(aq: AquariumHandle, pos: THREE.Vector3, canvas: HTMLCanvasElement, size: number, fraction: number): HTMLCanvasElement {
  const v = pos.clone().project(aq.camera), W = canvas.width, H = canvas.height;
  const s = Math.round(H * fraction);
  const x = Math.round(((v.x + 1) / 2) * W - s / 2), y = Math.round(((1 - v.y) / 2) * H - s / 2);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  context2d(c).drawImage(canvas, Math.max(0, Math.min(W - s, x)), Math.max(0, Math.min(H - s, y)), s, s, 0, 0, size, size);
  return c;
}

function closeUp(aq: AquariumHandle, what: string, canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  const target = closeUpTarget(aq, what);
  if (!target) return null;
  return cropSquare(aq, target.pos, canvas, CLOSE_UP_PX, target.worm ? WORM_CLOSE_UP_FRACTION : CLOSE_UP_FRACTION);
}

/** A row of close-ups of one species: each distinct variant first, then further fish up to VARIANTS_COUNT. */
function variantStrip(aq: AquariumHandle, species: string, canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  const seen = new Set<number>(), fish: Fish[] = [];
  for (const f of aq.world.fish) if (f.sp.id === species && !seen.has(f.variant)) { seen.add(f.variant); fish.push(f); }
  for (const f of aq.world.fish) {
    if (fish.length >= VARIANTS_COUNT) break;
    if (f.sp.id === species && !fish.includes(f)) fish.push(f);
  }
  const chosen = fish.slice(0, VARIANTS_COUNT);
  if (!chosen.length) return null;
  const out = document.createElement('canvas');
  out.width = VARIANT_CELL_PX * chosen.length;
  out.height = VARIANT_CELL_PX;
  const g = context2d(out);
  chosen.forEach((f, i) => g.drawImage(cropSquare(aq, f.pos, canvas, VARIANT_CELL_PX, VARIANT_CROP_FRACTION), i * VARIANT_CELL_PX, 0));
  return out;
}

/** ?variants=<species>: one side-by-side strip of that shoaling species' individuals, out/look-variants.png. */
async function variants(aq: AquariumHandle, species: string): Promise<void> {
  const canvas = aq.renderer.domElement;
  for (let t = 0; t < VARIANT_SETTLE_S; t += DT) aq.step(DT);
  const paintStart = performance.now();
  await paintPendingVariants();   // a check steps the tank itself, so paint and swap any variant still pending
  const swapMs = Math.round(performance.now() - paintStart);
  aq.present();
  const strip = variantStrip(aq, species, canvas);
  if (!strip) {
    console.log('look check variants', JSON.stringify({ error: `no fish of species ${species}` }));
    await postDone(JSON.stringify({ error: `no fish of species ${species}` }));
    return;
  }
  const path = `${CHECK_OUT_DIR}look-variants.png`;
  await saveFile(path, await canvasToBlob(strip));
  console.log('look check variants', JSON.stringify({ file: path, fish: strip.width / VARIANT_CELL_PX, swapMs }));
  await postDone(JSON.stringify({ files: [path], stats: [] }));
}

/** Width (px) of each saved sequence frame (the drawing buffer is 1920 px wide headless). */
const FRAME_TILE_PX = 960;
/** Downscale for the grass silhouette read-back (fraction of the drawing buffer). */
const GRASS_MASK_SCALE = 2;
/** A grass pixel is anything the silhouette pass drew brighter than this (0..255 sum of rgb). */
const GRASS_PIXEL_MIN = 12;

interface FrameGrass { i: number; t: number; px: number; x0: number; y0: number; x1: number; y1: number; fish?: number; near?: number; str?: number }

/** The nearest fish to any sea-grass patch (horizontal units) and the strongest parting strength. */
function grassFish(aq: AquariumHandle, patches: THREE.Vector3[]): { fish: number; near: number; str: number } {
  let near = Infinity;
  for (const f of aq.world.fish) for (const p of patches) near = Math.min(near, Math.hypot(f.pos.x - p.x, f.pos.z - p.z));
  return { fish: fishUniforms.uFishCount.value, near: +near.toFixed(2), str: +Math.max(0, ...Array.from(fishUniforms.uFishVel.value).filter((_, k) => k % 4 === 3)).toFixed(2) };
}

/**
 * ?frames=N: a consecutive sequence of frames (with the pan, if ?pan=1), plus a per-frame measure of
 * the seagrass's screen footprint: the number of pixels its silhouette covers and its bounding box
 * (fractions of the frame). A frame where the grass swells or smears shows a spike in px and in the
 * box's size, and can be opened to see what happened.
 *
 * ?every=K writes out/frames-<tag>-<i>.png every K frames (0 writes none: a long sweep can be measured
 * first and the suspect frames captured in a second, short run). Each frame's spike score compares its
 * silhouette with the running median of +-SPIKE_WINDOW frames, so a slow change over a long sweep does
 * not hide a few bad frames.
 */
const SPIKE_WINDOW = 12;
/** Width (px) of the composite comparison image (1/8 of the headless drawing buffer). */
const DIFF_PX = 240;

interface FrameDiff { i: number; t: number; mean: number; blk: number }

/** A DIFF_PX-wide luminance copy of the finished (water + photo) frame, for frame-to-frame comparison. */
function downsample(canvas: HTMLCanvasElement, cv: HTMLCanvasElement): Uint8ClampedArray {
  cv.width = DIFF_PX; cv.height = Math.max(1, Math.round(DIFF_PX * canvas.height / canvas.width));
  const g = context2d(cv, { willReadFrequently: true });
  g.drawImage(canvas, 0, 0, cv.width, cv.height);
  return g.getImageData(0, 0, cv.width, cv.height).data;
}

async function frameSeries(aq: AquariumHandle, count: number, dt: number, warm: number, tag: string, every = 1): Promise<void> {
  const canvas = aq.renderer.domElement, files: string[] = [], series: FrameGrass[] = [], diffs: FrameDiff[] = [];
  const diffCanvas = document.createElement('canvas');
  let prev: Uint8ClampedArray | null = null;
  aq.reef.group.updateMatrixWorld(true);
  const patches: THREE.Vector3[] = [];
  aq.reef.group.traverse((o) => { if (o.name === 'seagrass') patches.push(o.getWorldPosition(new THREE.Vector3())); });
  for (let t = 0; t < warm - 1e-9; t += dt) aq.step(dt);
  for (let i = 0; i < count; i++) {
    aq.step(dt);
    aq.present();
    const cur = downsample(canvas, diffCanvas);
    const dw = diffCanvas.width, dh = diffCanvas.height;
    let mean = 0, blk = 0;
    if (prev) {
      // Mean and worst 8x8-block absolute luminance difference from the previous frame: a smooth pan
      // changes little, but a frame where the grass swells, smears or pops stands out.
      for (let by = 0; by < dh; by += 8) {
        for (let bx = 0; bx < dw; bx += 8) {
          let sum = 0, n = 0;
          for (let y = by; y < Math.min(dh, by + 8); y++) {
            for (let x = bx; x < Math.min(dw, bx + 8); x++) {
              const p = (y * dw + x) * 4;
              const dl = Math.abs((cur[p] ?? 0) * LUMA[0] + (cur[p + 1] ?? 0) * LUMA[1] + (cur[p + 2] ?? 0) * LUMA[2]
                - ((prev[p] ?? 0) * LUMA[0] + (prev[p + 1] ?? 0) * LUMA[1] + (prev[p + 2] ?? 0) * LUMA[2]));
              sum += dl; n++;
            }
          }
          const m = sum / Math.max(1, n);
          mean += m * n;
          if (m > blk) blk = m;
        }
      }
      mean /= dw * dh;
      diffs.push({ i, t: +(warm + i * dt).toFixed(3), mean: +mean.toFixed(3), blk: +blk.toFixed(3) });
    }
    prev = cur;
    if (every > 0 && i % every === 0) {
      const shot = document.createElement('canvas');
      shot.width = FRAME_TILE_PX; shot.height = Math.round(FRAME_TILE_PX * canvas.height / canvas.width);
      context2d(shot).drawImage(canvas, 0, 0, shot.width, shot.height);
      files.push(await saveFile(`${CHECK_OUT_DIR}frames-${tag}-${String(i).padStart(3, '0')}.png`, await canvasToBlob(shot)));
    }
    series.push({ i, t: +(warm + i * dt).toFixed(3), ...grassSilhouette(aq), ...grassFish(aq, patches) });
    if (i % 30 === 0) console.log('frames', i, JSON.stringify(series[series.length - 1]));
  }
  const medianOf = (v: number[]): number => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
  const around = (i: number, f: (s: FrameGrass) => number): number => {
    const lo = Math.max(0, i - SPIKE_WINDOW), hi = Math.min(series.length, i + SPIKE_WINDOW + 1);
    return medianOf(series.slice(lo, hi).map(f)) || 1;
  };
  const scored = series.map((s, i) => ({
    ...s,
    score: +(s.px / around(i, (f) => f.px)).toFixed(3),
    box: +(((s.x1 - s.x0) * (s.y1 - s.y0)) / around(i, (f) => (f.x1 - f.x0) * (f.y1 - f.y0))).toFixed(3),
    wide: +((s.x1 - s.x0) / around(i, (f) => f.x1 - f.x0)).toFixed(3),
    tall: +((s.y1 - s.y0) / around(i, (f) => f.y1 - f.y0)).toFixed(3),
  }));
  const spikes = scored.filter((f) => f.score > 1.35 || f.box > 1.5 || f.wide > 1.3 || f.tall > 1.3);
  const worst = scored.slice().sort((a, b) => Math.max(b.score, b.box) - Math.max(a.score, a.box)).slice(0, 8);
  const diffMedian = (i: number): { mean: number; blk: number } => {
    const lo = Math.max(0, i - SPIKE_WINDOW), hi = Math.min(diffs.length, i + SPIKE_WINDOW + 1);
    const win = diffs.slice(lo, hi);
    return { mean: medianOf(win.map((d) => d.mean)) || 1e-3, blk: medianOf(win.map((d) => d.blk)) || 1e-3 };
  };
  const jumpy = diffs.map((d, i) => {
    const m = diffMedian(i);
    return { ...d, meanRatio: +(d.mean / m.mean).toFixed(2), blkRatio: +(d.blk / m.blk).toFixed(2) };
  });
  const jumps = jumpy.filter((d) => d.meanRatio > 3 || d.blkRatio > 3).sort((a, b) => b.meanRatio - a.meanRatio);
  const worstDiff = diffs.slice().sort((a, b) => b.mean - a.mean).slice(0, 8);
  const report = { frames: count, files: files.length, spikes, worst, jumps, worstDiff, series };
  console.log('look frames', JSON.stringify({ ...report, series: undefined }));
  console.log('look frames series', JSON.stringify(series));
  await postDone(JSON.stringify(report));
}

/**
 * The seagrass's screen footprint: renders only the grass (straight to the canvas, at the current
 * camera) and reads back a downscaled mask. Bypasses the water/photo passes, so it measures the
 * blades' geometry and vertex-shader shape, not their lighting.
 */
function grassSilhouette(aq: AquariumHandle): { px: number; x0: number; y0: number; x1: number; y1: number } {
  const { scene, renderer, camera, reef } = aq;
  const saved: [THREE.Object3D, boolean][] = [];
  scene.traverse((o) => saved.push([o, o.visible]));
  scene.traverse((o) => { o.visible = false; });
  // Show the grass meshes and every ancestor up to the scene.
  reef.group.traverse((o) => {
    if (o.name !== 'seagrass') return;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) p.visible = true;
  });
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
  renderer.setRenderTarget(prevTarget);
  for (const [o, v] of saved) o.visible = v;
  const W = renderer.domElement.width, H = renderer.domElement.height;
  const w = Math.ceil(W / GRASS_MASK_SCALE), h = Math.ceil(H / GRASS_MASK_SCALE);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = context2d(c, { willReadFrequently: true });
  g.drawImage(renderer.domElement, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  let px = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      if ((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0) < GRASS_PIXEL_MIN) continue;
      px++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (px === 0) return { px, x0: 0, y0: 0, x1: 0, y1: 0 };
  return { px, x0: +(x0 / w).toFixed(4), y0: +(y0 / h).toFixed(4), x1: +((x1 + 1) / w).toFixed(4), y1: +((y1 + 1) / h).toFixed(4) };
}

/** Two animation frames: lets the WebGPU compositor present before the canvas is read back. */
const settle = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** Mean luminance and HSV saturation of the frame (0..1), from a 1/8-size copy. */
function measure(src: HTMLCanvasElement): { lum: number; sat: number } {  const c = document.createElement('canvas');
  c.width = Math.ceil(src.width / MEASURE_DOWNSCALE);
  c.height = Math.ceil(src.height / MEASURE_DOWNSCALE);
  const g = context2d(c, { willReadFrequently: true });
  g.drawImage(src, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let lum = 0, sat = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = (d[i] ?? 0) / 255, gg = (d[i + 1] ?? 0) / 255, b = (d[i + 2] ?? 0) / 255, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    lum += LUMA[0] * r + LUMA[1] * gg + LUMA[2] * b;
    sat += mx > 0 ? (mx - mn) / mx : 0;
  }
  const n = d.length / 4;
  return { lum: +(lum / n).toFixed(STATS_DIGITS), sat: +(sat / n).toFixed(STATS_DIGITS) };
}

/** ?series=60: mean luminance of every frame over that many seconds (flicker hunting); reports the outliers. */
async function series(aq: AquariumHandle, seconds: number, dt: number): Promise<void> {
  const canvas = aq.renderer.domElement, lums: number[] = [], hdr: HdrStats[] = [];
  const frames = Math.round(seconds / dt), jitter = new URLSearchParams(location.search).get('jitter') === '1';
  const hide = new URLSearchParams(location.search).get('hide') ?? '';
  if (hide.includes('snow')) aq.snow.points.visible = false;
  if (hide.includes('fish')) for (const f of aq.world.fish) f.model.visible = false;
  for (let i = 0; i < frames; i++) {
    aq.step(jitter ? 0.008 + Math.random() * 0.042 : dt);
    await aq.present();
    lums.push(measure(canvas).lum);
    if (aq.water) hdr.push(hdrStats(aq));
  }
  const sorted = [...lums].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const spikes = lums.map((lum, i) => ({ i, t: +(i * dt).toFixed(2), lum })).filter((f) => f.lum > median * 1.15);
  const report = { frames, median, min: sorted[0], max: sorted[sorted.length - 1], spikes, lums: lums.map((l) => +l.toFixed(3)) };
  const hs = hdr.map((h, i) => ({ i, ...h })).sort((a, b) => b.max - a.max).slice(0, 12);
  const hm = [...hdr].map((h) => h.mean).sort((a, b) => a - b);
  console.log('look hdr', JSON.stringify({ meanMin: hm[0], meanMed: hm[Math.floor(hm.length / 2)], meanMax: hm[hm.length - 1], worst: hs.map((h) => JSON.stringify(h)), over64: hdr.filter((h) => h.over > 0).length, bad: hdr.filter((h) => h.bad > 0).length }));
  console.log('look series', JSON.stringify(report));
  await postDone(JSON.stringify({ frames, median, min: report.min, max: report.max, spikes }));
}

interface HdrStats { mean: number; max: number; over: number; bad: number; at?: string }

function halfToFloat(h: number): number {
  const e = (h >> 10) & 31, m = h & 1023, sgn = h & 0x8000 ? -1 : 1;
  if (e === 0) return sgn * m * 2 ** -24;
  if (e === 31) return m ? NaN : sgn * Infinity;
  return sgn * (1 + m / 1024) * 2 ** (e - 15);
}

/** Linear HDR statistics of the water renderer's scene target (what the shaft, blur and photo passes read). */
function hdrStats(aq: AquariumHandle): HdrStats {
  const t = aq.water.target, w = t.width, h = t.height, buf = new Uint16Array(w * h * 4);
  aq.renderer.readRenderTargetPixels(t, 0, 0, w, h, buf as unknown as Float32Array);
  let sum = 0, max = 0, over = 0, bad = 0, maxI = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const r = halfToFloat(buf[i] ?? 0), g = halfToFloat(buf[i + 1] ?? 0), b = halfToFloat(buf[i + 2] ?? 0);
    if (!Number.isFinite(r + g + b)) { bad++; continue; }
    const l = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
    sum += l;
    if (l > max) { max = l; maxI = i / 4; }
    if (l > 64) over++;
  }
  let at: string | undefined;
  if (max > 200) {
    const ray = new aq.THREE.Raycaster(), ndc = new aq.THREE.Vector2(((maxI % w) + 0.5) / w * 2 - 1, ((Math.floor(maxI / w) + 0.5) / h) * 2 - 1);
    ray.setFromCamera(ndc, aq.camera);
    const hit = ray.intersectObjects(aq.scene.children, true)[0];
    const o = hit?.object;
    at = o ? [o.name, o.parent?.name, (o as THREE.Mesh).material && ((o as THREE.Mesh).material as THREE.Material).type, ((o as THREE.Mesh).material as THREE.Material | undefined)?.name].join('/') : 'none';
  }
  return { mean: +(sum / (w * h)).toFixed(4), max: +max.toFixed(1), over, bad, ...(at ? { at } : {}) };
}
