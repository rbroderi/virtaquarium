# Roku bake notes

Shared notes for anyone baking the Roku assets (`pc/src/bake.js` → `roku/assets/`). Add to the log at the
bottom when something changes that a rebake has to know about.

The Roku app can't render 3D. It shows pre-rendered pictures instead:
- a backdrop with no fish;
- a foreground layer of the reef pieces near the glass, drawn over the fish;
- looping water/caustic frames;
- fish sprite sheets.

The PC renderer is the reference. `bakeScenery` mirrors `main.js` at full daylight with the camera at rest,
so anything that changes the PC lighting or layout has to be mirrored in `bake.js` too.

## What the bake must mirror from `main.js`

| Item | `main.js` | `bake.js` today |
|---|---|---|
| Reef layout | `buildReef(scene, TANK_W, SEED, scenery)` | same call ✓ |
| Baked reef light | `bakeReefLight(renderer, reef)` right after `buildReef` | **missing**: add it (see below) |
| Hemisphere light | `0.75 × k` with the reef light on (`1.0` without) | `1.0`: change to `0.75` |
| Environment intensity | `0.35 × 0.75 × k` with the reef light on | `0.35`: change to `0.2625` |
| Sun | `DirectionalLight(0xfff2dc, 2.65)` at `(3, 22, 7)`, 2048² PCF soft shadows | same ✓ |

`k = 1` at full daylight.

## Baked reef light (`pc/src/reefLight.js`, added 2026-11-04)

The reef used to look cut out, like a bad blue screen. Rocks and corals were lit almost evenly from every
side, so nothing darkened in crevices, under overhangs or where things meet the sand. The sun shadows were
there, but the flat ambient light washed them out.

`bakeReefLight(renderer, reef)` fixes this by ray casting the static reef's view of the open water.
- **Grid:** a 3D grid of points every 0.1 units covers the reef.
- **Rays:** each point casts rays in 256 directions (a Fibonacci sphere). For each direction the reef is
  drawn once into a depth map, which tests every point's ray at once.
- **Stored data:** each point keeps the fraction of rays that reach open water and the mean open direction
  (L1 spherical harmonics). That gives the visibility for any surface normal, weighted by the angle the light
  arrives at.
- **Who uses it:** every lit material that goes through `addCaustics` (`water.js`) multiplies its ambient
  light (hemisphere and environment) by that visibility. That covers the reef, the sand and the fish, so fish
  also darken under overhangs.
- **Bounce:** rock that blocks a ray still returns 18% (`uRLBounce`).
- **Sun:** keeps its real-time shadow map.
- **Cost:** about 150 ms on the GPU, with no read-back. The result is a half-float atlas of z slices in
  `reefLightUniforms`.
- **Toggles:** `?reeflight=0` turns it off, and `L` toggles it live for A/B comparison.

### To get it in the Roku backdrop

In `bakeScenery`, straight after `buildReef(...)`:

```js
import { bakeReefLight } from './reefLight.js';
// ...
const reef = buildReef(scene, TANK_W, seed, await loadScenery());
bakeReefLight(renderer, reef);
```

Then set the hemisphere light to `0.75` and the environment to `0.35 * 0.75`, as in the table above.

- `reefLightUniforms` is module-global, so the last call wins. Call it once per scenery, before that
  scenery's renders. The foreground pass reuses the same grid, which is fine because hiding meshes doesn't
  change what was baked.
- The fish sprite bake has no reef, so it needs no grid. With `uRLOn` at 0 the lookup returns 1, so sprites
  are unaffected.
- Check that `renderer.capabilities.maxTextureSize` is at least 2048 in the bake browser. The baker makes the
  grid coarser if the atlas wouldn't fit.

### Going further: a true path-traced backdrop

Performance isn't a concern for the Roku backdrop, because it's baked once. A full path tracer such as
[three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) would add:
- multi-bounce light between rocks;
- soft sun shadows;
- coloured bounce from the sand;
- correct light in the caves.

The PC grid above is the real-time stand-in for the same effect.

Open points before that's worth doing:
- **Water:** the path tracer would need the underwater medium (per-channel absorption and in-scatter in
  `water.js`) as a volume, or a path-traced reef pass composited under the existing water pass. The second
  is simpler: path trace the reef's lighting only, then let the existing fog and in-scatter run on top.
- **Caustics:** these are a projected texture today. Keep them as a multiply on the direct sun term so the
  water frames still line up with the backdrop.
- **Matching PC:** the PC would no longer match the backdrop exactly. That's acceptable if the grid's look
  is tuned towards the path-traced reference.

## Layout determinism (fixed 2026-11-04)

The scanned rocks were sorted by their GLB scene name, but every GLB's scene has the same name, so their
order came from whichever download finished first. The same seed could therefore put different rocks in
different places from one load to the next. That means a baked backdrop may not match the PC layout or the
foreground layer from another run.

`loadScenery` now names each rock by its `scenery.json` id before sorting. **Roku assets baked before this
fix should be rebaked.** The PC layout for a given seed is now the same on every load.

## Moray caves (added 2026-11-04)

`buildReef` now adds two rock arches per tank for the moray. They're built from their own random stream
(`seed + 101`), so nothing else in the layout moves.

Each cave is placed where the viewer can see into it:
- Candidate sites on the sand are tried back row first.
- The mouth is turned towards the camera.
- A site is taken only if 7 sight lines, from the camera's rest position to the mouth and the interior,
  clear the rocks, the corals and the earlier cave.
- Sites on a rock pile, near the clownfish anemone or within 3.5 units of another cave are rejected.

The camera position is `buildReef`'s last argument. It defaults to `(0, 4.6, 15)`, the camera both
`main.js` and `bake.js` use, so the bake needs no change unless its camera moves. They show up in the backdrop, and in the foreground
layer when they're near the glass. They change the height field, which the Roku fish brains use if those
are exported. If the Roku side has its own copy of the height field, regenerate it.

## Log

- 2026-11-04: baked reef light added (PC). Bake needs `bakeReefLight` plus the light changes above. Rock
  order fixed, so rebake. Moray caves added to the layout, then moved to sites the camera can see into.
