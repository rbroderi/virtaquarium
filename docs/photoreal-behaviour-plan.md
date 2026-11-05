# Photoreal look and emergent behaviour: plan

Written 2026-11-05 on branch `photoreal-fish`. Paths are under `pc/src/` unless noted; line numbers are from that tree. The look assessment is grounded in the code and the baked Roku tiles and sprites, which come from the same renderer as the live tank.

## 1. Gaps today

**Look**, in order of impact:

1. **Scenery materials and detail, more than the fish.** The open water is a flat teal void (`makeWaterBackdrop`, `water.js:351-372`); real tanks show a dark back glass or a fading gradient. The Tripo rocks are clones of 4 models stretched up to 1.45x (`reef.js:516-522`), so the pore pattern repeats at the wrong scale; coralline algae is a flat purple decal. Dome corals (`domeCluster`, `reef.js:591-604`) are uniform spheres with no polyps or translucency, and only the anemone moves (`reef.js:313-320`). Sand is one grain texture bump-mapped on an fbm plane (`reef.js:492-502`): no ripples, detritus, banking or rubble at rock feet.
2. **Everything is equally sharp and still.** No motion blur (`photo.js` has DoF, CA and grain only); marine snow is 600 additive points with no bokeh (`water.js:512-531`). Real tank video has motion blur on every tail beat.
3. **Fish look matte.** The in-water Fresnel (`IN_WATER_IOR = 1.04`, `fishModel.js:1578`) is right, but photos show lamp glints streaking along scale rows. The body material has a flat iridescence and no anisotropy (`fishModel.js:1608-1612`). ACES tone mapping (`main.js:35`) desaturates the oranges and yellows the fish were calibrated to; `docs/photoreal-fish-plan.md` recommended Neutral or AgX.
4. **Animation is good in the body, thin at the extremities.** Eyes never move (README); pectorals are rigid planes (`posePectoral`, `fishModel.js:1584-1589`); no caudal cupping; no night colouring.

**Behaviour.** `brain.js` is a sound utility architecture, but perception sees everything and the social rules are too weak for emergence:

- `_perceive` (`brain.js:105-151`) uses distance only: no field of view, no occlusion, no size or contrast. Predators are feared through solid rock (`:115`) and food is seen through rock up to 10 units away (`:142-150`).
- Schooling (`:234-245`) is cohesion plus alignment towards one shared target per species (`world.js:70-82`), with every conspecific within 3 units weighted equally. A school can't split round a coral head and rejoin.
- Fear is first-hand only: a chromis that sees a neighbour bolt doesn't bolt (`startle`, `:66-72`).
- A territory is a point and a chase, with no dominance memory or size asymmetry.
- Shelter doesn't exist: the reef lookahead (`:406-413`) and the rock limit (`fish.js:234-238`) keep every fish above the height field, so nothing tucks under a ledge; "rest" is hovering near home.
- The lionfish and moray never hunt. Feeding is a nearest-flake race with no pecking order. Flakes appear at y 9.38 (`world.js:89`), above the fish's ceiling (`main.js:121`), so the feeding frenzy is out of view.

## 2. Photorealism

The mid-laptop budget is about 3 ms more before integrated GPUs drop under 60 fps at 1080p.

- **R1. Tone mapping and grade (0.5 day).** Switch `main.js`, `bake.js` and `lab.js` to `NeutralToneMapping` or AgX, and refit `albedoGain` with the lab tool, since it was fitted under ACES. Add a slight black lift and a mild S-curve in the shaft pass (`water.js:447`). No GPU cost. Carries to the Roku on rebake.
- **R2. Motion blur (1 day).** Render the fish only into a half-res velocity buffer, using each fish's previous model matrix and swim phase. Blur along it with 8 taps in the final pass (180° shutter at 60 Hz). This is the biggest "video, not render" cue. About 1.5 ms. Doesn't carry to the Roku's sprites.
- **R3. Scale specular (1 day).** Use the material's anisotropy, aligned with the scale rows from `paintSkin`, plus per-species iridescence and a dorsal specular boost. The glint travels along the flank as a fish turns. No GPU cost. Carries to the Roku on rebake.
- **R4. Scenery pass (3-5 days, the biggest payoff).**
  - *Back wall:* a near-black back glass at z -6, with darker inscatter on backward rays.
  - *Rocks:* a free triplanar overlay in `normaliseScenery` (coralline patches from 3D noise, algae turf on upward faces, detritus on flats), at most 1.15x stretch, and per-copy hue jitter. Optionally 4 more Tripo rocks for about 120 credits.
  - *Corals:* lofted polyp stalks instead of spheres, a time-based sway, and cheap subsurface scattering, porting the fish's tissue shader.
  - *Sand:* ripples, about 200 rubble and shell pieces at rock feet, and contact darkening.
  - *Inverts and plants:* feather-duster worms that retract on startle, and swaying macroalgae. **Done (2026-11-05):** `fanWorms.js`; rock and coral pores also get parallax occlusion (`parallax.js`).
  - About +0.5 ms. Everything carries to the Roku through the baked layers and the water loop, for about 10% more bake time.
- **R5. Particulates and depth of field (0.5 day).** Draw marine snow as quads that blur with distance from focus, add near-glass motes, and make `?photo=1` the default at f/5.6 with gentler grain. About 1.5 ms. The backdrop bake can use it too.
- **R6. Animation (2 days).**
  - Eyes on their own pivots, counter-rotating against pitch and roll, with saccades towards what the brain is looking at.
  - Pectoral fins that bend along their rays. **Done (2026-11-05):** `uPBend`.
  - Caudal cupping on the power stroke.
  - Night colouring: pale clownfish and tangs, darker chromis.
  - No GPU cost. Not carried to the Roku: night sprites would break the memory budget.
- **R7. Glass (optional).** A faint double-contour refraction. **Done (2026-11-05)** as the pane's two reflecting faces (`photo.js`): the side panes, where a real tank shows a doubled image by total internal reflection, are never in this framing (the tank's width follows the screen's aspect).
- **R8. Lighting from above (user request, 2026-11-05).** The renders still look flat. Make the sun (or the tank's lamp) clearly the dominant light from overhead and cut the fake ambient fill: hemisphere light, environment intensity and the ambient water light in `main.js` `applyLight` and `bake.js`. Shadows, undersides and form should then read. Check with look-check renders, and keep the bake on the same values.

## 3. Brains

Rule: `steer()` stays the one place that sets direction and speed, and the reflexes and `fish.js` physics stay untouched, so the motion-check numbers stay comparable.

- **B0. Blended steering (1 day).** Today each fish runs one exclusive mode. Make the mode supply the main vector and add always-on social forces (separation, alignment, cohesion, fear, shelter pull) with weights the mode can scale. Expose the result as `brain.state` for the checks.
- **B1. Perception (1 day).** Build one percept per 0.2 s tick:
  - About 330° vision with a rear blind cone.
  - Range that depends on size, contrast and light. At night it drops to about 1 body length.
  - Lateral-line sensing of about 1-1.5 BL in every direction, which works in the dark (Partridge & Pitcher 1980).
  - Line of sight tested in 4 samples against the height field and cave roofs, so predators appear suddenly round rocks.
  - The nearest 4 visible conspecifics as neighbours (Katz et al. 2011; Herbert-Read et al. 2011).
- **B2. Schools that split and merge (1 day).**
  - Pairwise rules on the 4 nearest neighbours: repulsion inside 0.6 BL, attraction beyond 1.5 BL, speed matching, and weak alignment.
  - A preferred height band.
  - Chromis centred on their staghorn, which they hover over and dive into when threatened (Fishelson et al. 1974).
- **B3. Fear contagion (0.5 day).** A visible neighbour fleeing or bursting raises fear, scaled by distance and boldness. Startles then spread as waves with a short delay, limited by line of sight (Rosenthal et al. 2015).
- **B4. Shelter and the night (1.5 days).**
  - Shelter points come from caves, overhangs, gaps between rocks, the staghorn and the anemone.
  - Each fish learns 2-3 of them and forgets one where it was chased.
  - At night fish go into shelter, bypassing the height-field limit there.
  - Blue tangs wedge in sideways, the royal gramma hangs upside down under its ledge, and the trigger locks into a crevice.
  - At dusk the reef goes quiet while the lionfish and moray come out (Hobson 1972).
- **B5. Dominance and territory (1 day).**
  - Each fish keeps a win/loss memory against each other fish. Outcomes go by size with noise; clownfish groups form a strict size hierarchy (Buston 2003).
  - Subordinates yield and head-shake.
  - Territories become regions, and chases stop at their edge.
  - Yellow and blue tangs treat each other as rivals.
- **B6. Predators that hunt (1 day).** The lionfish stalks at dusk with its fins fanned, then strikes. It always misses, but each strike startles the shoal. The moray prowls the bottom at night.
- **B7. Feeding (1 day).**
  - Drop flakes inside the visible window.
  - Subordinates don't contest a flake near a dominant fish.
  - An algae map regrows slowly, so tangs graze a patch bare and move on.
  - Hungry fish drift to the usual drop spot about 60 s before feeding time.
- **B8. Viewer awareness (0.5 day).** Pointer movement on the canvas becomes a "viewer". Bold species come to the glass and hold; shy ones retreat to shelter. Habituation replaces the current one-shot inspect.
- **B9. Cleaner station (optional, 2 days).** A cleaner wrasse at one rock. Clients pose head-up with fins spread while it works along their flanks.

**Stability and cost.** Blended forces are clamped to the same sizes as the reflexes, and the physics limits still bound everything. Perception runs on the 0.2 s tick, so per-frame cost barely changes. Tune with seed sweeps.

**Roku 2D version.** Use `roku.js` as the model; there is no BrightScript player yet. It would include:
- nearest-3 pairwise schooling;
- one fear value per species, spreading with a 0.3 s delay;
- a shelter list exported by `bake.js` in screen space, next to `floor` and `anemone`, where fish hide behind the foreground layer at night or when startled;
- gathering at feeding time, and the day/night clock;
- thinking at 5 Hz, with fish bucketed into 200 px columns.

## 4. Verification

**Behaviour.** Add `?check=behaviour` to `motionCheck.js`: 10 simulated minutes at 30 Hz, with these targets.

| Measure | Target |
|---|---|
| Nearest-neighbour distance in schools | median 1-2 BL by day, 3-5 BL at night |
| Chromis shoal polarisation | 0.3-0.5 at rest, above 0.8 for 2-4 s after a startle |
| Number of subgroups (within 2.5 BL) | varies between 1 and 3 |
| Time spent against the glass | under 8% |

It also records, without set targets:
- each species' share of time in each mode;
- chase rate and length;
- how many fish a single strike starts fleeing;
- bite order against rank after a feeding;
- shelter occupancy at night.

The existing climb, jitter and roof numbers stay as regression gates. A `tools/check.mjs` runs it headless over several seeds, reusing `startServer` and the bake's Chrome launch.

**Look.** Add `?check=look` to render fixed frames (seed 7 at 5 s, at 30 s, and at night) and save them with image statistics: luminance histogram, saturation, edge density and colour cast. Compare them with a folder of reference tank photos to be collected in `pc/ref/tank/`. The lab's IoU and colour-difference tooling (`labRef.js`) stays the check for individual fish.

## 5. Roadmap

| Phase | Content | Size | Risk |
|---|---|---|---|
| P1 | R1 tone/grade, R3 scale specular, R6 eyes and night colour, B1 perception, B3 fear contagion | 3 days | `albedoGain` refit; rebake all sprites |
| P2 | B0 blended steering, B2 schooling, B4 shelter and dusk, behaviour check | 4 days | shelter bypass must not regress climb/jitter |
| P3 | R8 lighting from above, R4 scenery pass | 5 days | bake time +10% |
| P4 | R2 motion blur, R5 particulates and DoF by default | 2 days | integrated-GPU budget; keep `?photo=0` |
| P5 | B5 dominance, B6 hunting, B7 feeding, B8 viewer | 4 days | tuning time |
| P6 | Roku 2D brain port and shelter export | 3 days | BrightScript CPU |
| P7 (optional) | B9 cleaner wrasse, 4 Tripo rocks (~120 credits) | 3 days | money; +2.5 MB sprites |

P1 is cheap and visible on both platforms. P2 fixes what makes the tank feel like a screensaver: fish that don't react to each other or to the reef. P3 is the biggest visual gain but is content work. P4 is polish that depends on frame-rate headroom.
