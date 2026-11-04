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
| Baked reef light | `bakeReefLight(renderer, reef, {...})` right after `buildReef` (options below) | **missing**: add it |
| Hemisphere light | `0.75 × k` with the reef light on (`1.0` without) | `1.0`: change to `0.75` |
| Environment intensity | `0.35 × 0.75 × k` with the reef light on | `0.35`: change to `0.2625` |
| Sun | `DirectionalLight(0xfff2dc, 2.65)` at `(3, 22, 7)` | same ✓ |
| Sun shadows | reef shadows baked; live map (VSM, radius 6) has the fish only | PCF soft with the reef: fine until the bake call is added (the call turns reef `castShadow` off) |

`k = 1` at full daylight.

## Baked reef light (`pc/src/reefLight.js`, updated 2026-11-04)

The reef used to look cut out, like a bad blue screen. Rocks and corals were lit almost evenly from every
side, so nothing darkened in crevices, under overhangs or where things meet the sand.

The reef doesn't move, so it's lit once at load by ray casting on the GPU, and the live renderer only adds
what the fish change. For each ray direction the reef is drawn into depth maps looking back along it, which
tests every point's ray at once. Three terms are baked:

- **Sun:** soft shadows from a light of finite size. 64 directions over a 0.1 rad cone around the sun are
  averaged, so shadows are sharp where a rock meets the sand and soften with distance.
- **Sky:** the share of the water's diffuse light (hemisphere and environment) each point can see, weighted
  by the angle it arrives at for that point's normal (256 directions).
- **Bounce:** light the reef reflects onto each point, in colour, two bounces deep (192 directions per
  bounce). For every ray that hits rock, the baker finds the face looking back along the ray (a back-face
  depth map), its albedo (an albedo render), and how brightly that face is lit (its own sky and sun terms,
  plus the previous bounce).

Each term is stored twice:

- **Per pixel from the camera's rest view** (2048 wide, field of view 15% wider than the camera's). Reef
  fragments find their pixel by projecting into the rest view. Where the camera's drift reveals something the
  bake didn't see, a depth check fails and the grid is used instead.
- **In a 3D grid** every 0.1 units around the reef (L1 spherical harmonics, so any normal can look it up).
  Fish use the grid: they darken, and pick up reef colour, under ledges and in caves.

Live, every material that goes through `addCaustics` applies:
- sun visibility on the key light only (the LED rig's fills stay unshadowed);
- sky visibility on the ambient light;
- the bounce on top;
- specular occlusion (80% of the sky term on reflections).

A half-resolution screen-space AO pass, built from the previous frame's depth with a depth-aware blur, adds
fine contact shading between fish and rock and between fish, on ambient light only.

- **Cost:** the bake takes about a second.
- **Toggles:** `?reeflight=0` turns it off. `L` toggles it live for A/B comparison (off brings back the live
  reef shadows).
- **Debug views:** set `reefLightUniforms.uRLDebug` to 1, 2 or 3 to show the sun, sky or bounce term on its
  own.

### To get it in the Roku backdrop

The per-pixel bake is made from the camera you pass in. Pass the bake's camera, and the backdrop gets
per-pixel soft shadows, ambient occlusion and bounce light: as close to path traced as this approach gets.

```js
import { bakeReefLight } from './reefLight.js';
// ...
const reef = buildReef(scene, TANK_W, seed, await loadScenery());
bakeReefLight(renderer, reef, {
  sun: { dir: sun.position.clone(), irr: sun.color.clone().multiplyScalar(sun.intensity), cone: 0.1 },
  sky: new THREE.Color(0.86, 0.92, 1.0).multiplyScalar(0.75),
  ground: new THREE.Color(0x8a7458).multiplyScalar(0.75),
  camera,   // the backdrop camera: (0, 4.6, 15) looking at (0, 3.9, 0)
});
```

Then set the hemisphere light to `0.75` and the environment to `0.35 * 0.75`, as in the table above.

- `reefLightUniforms` is module-global, so the last call wins. Call it once per scenery, before that
  scenery's renders. The foreground pass reuses the same bake, which is fine because hiding meshes doesn't
  change what was baked.
- The fish sprite bake has no reef. With `uRLOn` at 0 every lookup returns "unoccluded", so sprites are
  unaffected.
- The baker sets the reef's `castShadow` to false afterwards, because its shadows are now baked. The water
  frames (`bakeWater`) still get the fish-free scene, so nothing else changes.
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

## Jelly tank (added 2026-11-04)

`tank.scenery` can now be `"jelly"`: moon jellies (`pc/src/jelly.js`) in a backlit deep-blue void with no
reef, sand or surface, holding only jellies.

`SCENERY` in `tank.js` is still `['reef']`, the layouts `bake.js` loops over, so the bake is unchanged. The
new list of every tank kind is `TANK_SCENERY`.

A Roku jelly tank would need:
- **Backdrop:** the gradient from `buildJellyTank`, rendered alone.
- **Jelly sprites:** additive (they add light and block almost none), with a short pulse cycle. A few frames
  from bell relaxed to contracted, played at about 0.5–1 Hz, plus tilted variants.
- **Motion:** a port of `Jelly.update`, which covers the pulse thrust, slight sinking, a preferred depth and
  home column, the righting tendency, soft bumping between bells, and the tank's current.

## Cuttlefish, octopus and turtle (added 2026-11-04)

`pc/src/critters.js` adds three reef animals that are not fish: they have their own models and
behaviour and live in `World.critters`, not `World.fish`, so `bake.js` (which bakes `SPECIES`) skips them.

For Roku each needs its own sprite set:
- **Cuttlefish:** a side-on swim loop of the fin-skirt wave (forward and reversed), plus colour states:
  zebra, passing clouds (a short loop), mottled at rest and pale. The arms are a rigid bundle, so one pose
  will do, plus a frame of the tentacle strike.
- **Octopus:** the arms are rebuilt every frame against the reef heights, so baking them is the hard
  part. A den pose (arms tucked, drawn in place in front of its cave) and a few crawl frames would probably
  read well enough. A jet pose has the arms trailing.
- **Turtle:** a 12-frame flipper stroke at several headings, a glide frame, and a resting pose for the sand.

## Secondary motion (added 2026-11-04)

The swim shader has new uniforms, all defaulting to the old look, so `bake.js` renders exactly as
before without changes: `uBendTail` (the rear half's bend), `uFold` (median fins folded), `uCup` (extra
caudal lag), `uSpineOn`/`uSpine` (the moray's chain offsets).

The springs are dynamic, so most of this is PC only. What a bake could take:
- **Turn row (row 1):** set `uBend` to the turn's bend and `uBendTail` a step behind it (ramping in over
  the frames), so the turn sprites bend in with the tail lagging instead of rotating a rigid fish.
- **Fast swim:** a variant of the swim loop with `uFold` about 0.5 and `uCup` about 0.4 for bursts.
- **Moray:** a few curved-body poses (an S and a C from `uSpine`) would read better than the straight
  loop when it turns.

## Log

- 2026-11-04: secondary-motion uniforms (`uBendTail`, `uFold`, `uCup`, `uSpine`); their defaults keep the bake unchanged.

- 2026-11-04: cuttlefish, octopus and turtle (`critters.js`), PC only; not in `SPECIES`, so the bake skips them.

- 2026-11-04: jelly tank (`scenery: "jelly"`), PC only; not in `SCENERY`, so the bake skips it.

- 2026-11-04: baked reef light v2: soft area-light sun shadows, coloured two-bounce light and a per-pixel
  rest-view bake; the bake call now takes options (see above).
- 2026-11-04: baked reef light added (PC). Bake needs `bakeReefLight` plus the light changes above. Rock
  order fixed, so rebake. Moray caves added to the layout, then moved to sites the camera can see into.
