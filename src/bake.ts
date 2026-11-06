// Roku asset baker. Renders what the Roku channel can't (it has no WebGL) into plain images:
//   roku/assets/fish/<id>-a<n>.png    one page per viewing angle n: the swim cycle, facing right, cropped
//   roku/assets/scenery/<key>-<n>.jpg backdrop columns: water + reef, no fish
//   roku/assets/scenery/<key>-fg-<n>.png  reef pieces near the glass, drawn over fish behind them
//   roku/assets/manifest.json         frame sizes, anchors, per-species behaviour, reef floor line
// Open /bake.html (optionally ?species=a,b&seeds=7,42&frames=8&yaws=9), or run `npm run bake`.
// The stages live in bake/: config, io, fishSprites, bubbles, scenery, waterLoop (overlay maths), manifest.
import * as THREE from 'three';
import { SPECIES } from './species.js';
import { loadCustomModels, loadSkinCache } from './fishModel.js';
import { SCENERY } from './tank.js';
import { PAN_PERIOD } from './view.js';
import { errorMessage } from './util.js';
import { parseBakeConfig, SCREEN, type BakeConfig } from './bake/config.js';
import { pageLog, saveAsset, type Log } from './bake/io.js';
import { bakeFish, makeFishScene } from './bake/fishSprites.js';
import { bakeBubbles } from './bake/bubbles.js';
import { bakeScenery } from './bake/scenery.js';
import type { BakeManifest } from './bake/manifest.js';

const MS_PER_SECOND = 1000;

function makeRenderer(config: BakeConfig): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.toneMapping = config.tone.mapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

async function run(config: BakeConfig, log: Log): Promise<void> {
  const t0 = performance.now();
  const renderer = makeRenderer(config);
  const species = SPECIES.filter((sp) => !config.speciesFilter || config.speciesFilter.includes(sp.id));
  const manifest: BakeManifest = {
    version: 1, generated: new Date().toISOString(), screen: SCREEN,
    view: { zoom: config.view.zoom, pan: config.view.pan, period: PAN_PERIOD, strip: config.strip },
    pxPerUnit: config.pxPerUnit, species: {}, scenery: {},
  };
  const [custom] = await Promise.all([loadCustomModels(species), loadSkinCache(species)]);
  if (custom.length) log(`custom models: ${custom.join(', ')}`);

  const fishScene = makeFishScene(renderer, config);
  for (const sp of species) {
    const entry = await bakeFish(renderer, config, sp, fishScene);
    manifest.species[sp.id] = entry;
    log(`fish ${sp.id}: ${entry.frameW}x${entry.frameH} x ${config.yaws} angles x ${config.frames}, ${entry.textureMB} MB`);
  }
  manifest.bubbles = await bakeBubbles(renderer, config, fishScene.scene);
  for (const scenery of SCENERY) {
    for (const seed of config.seeds) {
      const { key, entry } = await bakeScenery(renderer, config, log, scenery, seed);
      manifest.scenery[key] = entry;
      log(`scenery ${key}`);
    }
  }
  await saveAsset('manifest.json', JSON.stringify(manifest, null, 2));
  const summary = `baked ${species.length} fish, ${Object.keys(manifest.scenery).length} scenery in ${((performance.now() - t0) / MS_PER_SECOND).toFixed(1)}s`;
  log(summary);
  await fetch('/__done', { method: 'POST', body: summary });
}

const log = pageLog();
run(parseBakeConfig(new URLSearchParams(location.search)), log).catch(async (err: unknown) => {
  log('FAILED: ' + (err instanceof Error && err.stack ? err.stack : String(err)));
  await fetch('/__done', { method: 'POST', body: 'FAILED: ' + errorMessage(err) });
});
