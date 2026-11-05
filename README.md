# Virtual Aquarium

A physically based virtual reef aquarium where every fish has its own digital brain.
Targets: **PC** (three.js / WebGL, runs in any modern browser) and **Roku** (SceneGraph screensaver, in progress).

## Run on PC

```bash
npm install
npm start
```

Open <http://localhost:8080/pc/> and press **F11** for full screen.

| Input | Action |
|---|---|
| click | drop food (or select a fish) |
| Tab | inspect the next fish's brain |
| B | show every fish's current thought |
| F | feed |
| N | toggle lights (day / night) |
| L | toggle the baked reef light (A/B) |
| Space | pause |
| H | help |

**View**: the camera is pushed in towards the glass like Aquatic Life's: the screen shows a 1/1.6 window of the tank, near the bottom so the sand and reef stay in frame (`pc/src/view.js`). Fish stay below the top of the window. `?zoom=1` shows the whole tank. `?pan=1` pans the window slowly across the tank every 2 minutes; it is off by default because on the Roku it measured 53–66 MB of texture memory against a 50 MB target. The Roku bake uses the same framing.

URL options: `?clock=1` (lights follow your local time), `?feed=4` (auto-feeder interval in minutes, `0` = off), `?drift=0` (no camera parallax), `?seed=7` (reef layout). `?scenery=jelly` opens the jelly tank: moon jellies only, in a backlit deep-blue kreisel with no reef, sand or surface (`jelly.js`; a tank file's `"scenery": "jelly"` does the same, and jellies are dropped from reef tanks). `?reeflight=0` skips the baked reef light: at load the static reef is ray cast on the GPU (`reefLight.js`, about a second) for soft sun shadows from a light of finite size, the share of the water's ambient light each point can see, and coloured light bounced off the reef (two bounces), per pixel from the camera's rest view and in a 3D grid that the fish use. Live, a screen-space AO pass adds contact shading for the fish, and only the fish cast real-time shadows (Roku bake notes: `docs/roku_bake.md`). `?rig=led` lights the tank with an aquarium LED bar (a softer key plus fills; the lab offers the same rig). By default the tank renders through a camera model (`photo.js`, f/5.6, `&fstop=2.8` for shallower, `?photo=0` to turn it off): thin-lens depth of field with autofocus on the fish nearest the centre, lateral chromatic aberration, cos⁴ vignetting and shot-noise grain, all in linear light before tone mapping. Fish get motion blur for a 1/100 s shutter (`water.js`, from a velocity buffer of the fish; `?blur=0` to turn it off). Tone mapping is Khronos PBR Neutral, which keeps the fish's hues where ACES greys saturated oranges and yellows (`?tone=aces` to compare; `rig.js`). Lighting (`rig.js` `LIGHTS`, shared with the bake) is one strong overhead sun with low ambient fill, so undersides and overhangs read. The lab takes `?photo=1` too.

## How it works

### Brains (`pc/src/brain.js`)
Each fish is an agent with:
- **Personality traits**: boldness, curiosity, activity, sociability, aggression and appetite. Drawn per individual around species norms, so no two fish of a species act the same.
- **Drives** that change continuously: hunger, energy, fear, social need and boredom.
- **Perception**: all-round vision except a blind cone behind. Its range grows with the target's size, shrinks in the dark (to a quarter at night) and is blocked by rock (sightlines tested against the reef). The lateral line senses anything within about a body length, in any light and through rock. A fish attends to its nearest 4 shoalmates, predators, rivals near its territory, and food it can see.
- **Utility-based action selection**: cruise, school, forage, feed, rest, flee, patrol, inspect the glass, host in the anemone, hover, stalk (lionfish), clean (cleaner wrasse) or pose (a client at the cleaning station). Hysteresis keeps it committed to a choice, and chase fatigue lets rivals settle into a truce.

The behaviour turns into a steering goal; the body then has to physically achieve it. The local rules below are what the tank's group behaviour comes from; nothing is scripted:
- **Schools** follow pairwise rules on their nearest shoalmates: repulsion inside ~0.6 body lengths, attraction beyond ~1.5, matching the speed of fish ahead, weak alignment (Herbert-Read et al. 2011, Katz et al. 2011). There is no shared goal, so a shoal splits round a coral head and re-forms. Chromis hover over their staghorn and dive into it when scared.
- **Fear spreads**: a fish that sees a neighbour dash off flees too, away from what scared it, so a startle runs through a shoal as a wave (Rosenthal et al. 2015). It weakens with each hop and dies out after three, and a fish ignores further waves for a few seconds. Prey keep a wary distance from a predator that is just there, and flee from one closing in.
- **Shelter and night**: `reef.js` finds gaps under rock ledges and crevices with an open front; each fish knows one near home, and chromis use their coral. At dusk the reef empties as fish go in (Hobson 1972). Tangs rest wedged on their side and the royal gramma hangs upside down under its ledge. Night colours come on over minutes: yellow and blue tangs pale, chromis, idols, butterflyfish, angels and triggers darken.
- **Cleaning station**: a bluestreak cleaner wrasse holds a station on a prominent rock and advertises with an up-and-down dance. Tangs, angels, butterflyfish, the idol, the trigger and the lionfish build up parasites over a few minutes. They queue, then hold still head-up with fins spread, colours shifted, while it works along their flanks. Now and then it cheats and bites mucus, and the client jolts away (Bshary & Grutter 2002).
- **Territory**: a fish chased off twice by the same territory holder keeps out of its home area afterwards, so stable truce lines form.
- **Lionfish** stalk at dusk with their fans spread, then lunge from about a body length (Albins & Lyons 2012). The prey always gets away here, but the lunge sets off a fear wave.
- **Feeding**: flakes sink into view from just above the window. A small fish leaves a flake that a much bigger one is already taking. Hungry fish gather where food comes in during the last minute before a scheduled feed.
- **The viewer**: pointer movement at the glass draws bold, curious fish to come and look, and makes shy ones back off; both get used to it.
- **Eyes** make saccades to whatever the fish attends to, and counter-roll against pitch.

### Physics
World scale: **1 unit = 12.5 cm**. The tank is 2.0 × 1.1 × 0.75 m and the fish are real aquarium-specimen sizes.

- **Swimming** (`fish.js`): mass ∝ L³ and quadratic drag. Thrust comes from a speed controller, capped at the species' sustained speed and its burst speed (body lengths/s).
  - **Turning** has rotational inertia, so angular acceleration is limited by fin torque. Yaw rate is limited by pectoral sculling at low speed. At speed it is limited by the turning radius (`r ≥ r_min · L` for escapes, about twice that for routine turns) and by lateral acceleration (`ω ≤ a_lat / U`, about 0.04–0.12 g routine and 0.3–0.8 g in escapes). A U-turn picks a direction once and commits to it.
  - **Posture**: pitch stays within 15–25° while swimming and gets steeper (40–60°) only when nearly stopped (grazing, probing, hovering). Fish change depth gradually and bank 5–12°. Bending into a turn adds drag. Strong lateral drag acts like a keel.
  - **Speed**: routine swimming asks for 10–40% of the species' sustained speed (about 0.5–1.5 body lengths/s). Feeding dashes, chases and escapes use the rest of the range.
  - **Per species** (`species.js`): `SWIM` holds speeds, gait and turning radius; `MOTION` holds lateral acceleration, routine-turn widening, turn drag, pitch limits and rates, climb angle and bank; `PACE` holds the speed each behaviour asks for (defaults in `PACE_BASE`). Deep-bodied tangs, angels and the idol lean and pitch little; crevice pickers (copperband, longnose, trigger) and stalking lionfish pitch steeply when slow; chromis and the gramma turn hardest.
  - Tail-beat frequency follows the Strouhal relation `f = St·U/A` (St ≈ 0.3, A = 0.2 L), using the speed the current thrust would sustain.
  - Each species uses its real swimming mode:
    - Labriform (tangs, angels, butterflyfish, damsels) row with their pectoral fins and recruit the tail above a gait-transition speed.
    - Balistiform (triggerfish, lionfish) undulate the dorsal and anal fins.
    - Body-caudal-fin swimmers (gramma) use burst-and-coast.
    - Anguilliform (the snowflake moray) undulates the whole body: wavelength about 0.6 body lengths (1.5–2 waves on the body), amplitude rising from about 0.03 BL at the head to 0.1 BL at the tail, with no separate caudal blade (`uAnguil`).
  - The body wave travels head to tail with slip ratio ≈ 0.6, and the spine curves with path curvature in turns.
    - The wave is a spine curve: each cross-section is carried along the midline and turned to its tangent, so the body keeps its length and the caudal blade pitches.
    - Wavelength is about 0.95 body lengths. Amplitude runs from about 0.02 BL of head recoil to about 0.1 BL at the tail tip, and the caudal fin lags the peduncle by about 45°.
  - **Pectoral stroke**: on the recovery stroke the fin feathers edge-on and its rays partly collapse (`posePectoral`). Hovering fish hold the body still and scull with the pectorals.
  - **Secondary motion** (damped springs, `fish.js`): the turn bend overshoots a little as a turn ends, and the rear half follows it on a softer spring (`uBendTail`), so the tail lags into a turn and swings past straight coming out. The caudal blade flexes further while the fish accelerates (`uCup`); dorsal and anal fins fold down and back at speed and stand up in slow turns (`uFold`); pectorals follow their stroke on a soft spring and tuck back at speed. The moray's body is a chain of point masses (`SpineChain`) that the head tows: the body traces the head's path, swings wide out of tight turns and drapes over ledges (`uSpine`). The cuttlefish's arm bundle swings after turns and its mantle squeezes as it jets; the octopus's arms are towed through the water and trail a jet; the moon jelly's tentacles and oral arms trail its motion and keep hanging down as the bell tips.
  - **Breathing**: the gill covers flare at 1–1.5 Hz, faster after exertion. Morays have no gill covers: they pump water by opening and closing a hinged lower jaw (~0.6–0.9 Hz) and gape wide to strike. By day a moray holds its crevice with the front of its body raised (`lurk` mode, `uLift`).
- **Water** (`water.js`): three.js fog is replaced by a per-channel Beer–Lambert medium.
  - Beam attenuation and downwelling attenuation Kd use clear reef-water coefficients.
  - Inscattered light fills long paths, and only the path inside the glass counts.
  - A custom white balance at reef depth is applied, as an underwater camera would.
  - The ambient environment is the underwater radiance field: Snell's window overhead, blue-green inscatter around it, sand upwelling below.
- **Surface waves**: an aquarium has no wind waves. Its surface roughness is stirred up by the pumps and carried by slow surface currents while it slowly re-forms (frozen turbulence). The model sums four wave trains, each drifting its own way at 2–3 cm/s instead of as free waves at 30–90 cm/s: fine roughness along the return pump's outflow, long swells in the gyre returning the other way, a powerhead's cross-flow, and short reflections off the glass that shimmer in place. Each train focuses about the same share of the light, so the caustic networks cross and mix instead of sliding one way. The 28 components are 5–50 cm long and evolve over seconds. They tile every 50 cm. The caustics, the light shafts and the surface all use this one wave field.
- **Caustics** are simulated, not painted:
  - A fine grid on the moving surface refracts the light by Snell's law, with seawater IOR per colour channel so bright lines fringe slightly.
  - The grid is projected to three depths. Irradiance there is the area ratio of each surface triangle to its projection, which conserves energy, times the Fresnel transmittance.
  - Every lit surface, fish included, looks the pattern up along the refracted light ray. It multiplies only the direct light, so shadows and shading stay correct.
  - The light source's angular size (0.35°) blurs the pattern in proportion to depth.
- **Light shafts**: a post pass ray-marches each view ray through the water and adds single scattering: Henyey–Greenstein phase (g = 0.75), Beer–Lambert along the light path and the view path, and the caustic fluctuation as the source. Shafts brighten where the surface focuses light and dim between.
- **Surface from below**: exact water-to-air Fresnel. Beyond the 48.6° critical angle it is a mirror of the tank (total internal reflection); waves open Snell's window onto the fixture in flickers.
- **Water flow**: a divergence-free overturning cell from the return pump, about 1.5 cm/s and pulsing. Fish, food, bubbles and particles are all carried by it.
- **Bubbles**: rise speed from Mendelson's wave-analogy formula, Boyle's-law growth, an oblate shape, and zig-zag above 2 mm. Shading uses Fresnel reflection with total internal reflection past the 48.8° critical angle, which gives the bright rim.
- **Food**: flakes float on the surface film, then settle at 1–2.5 cm/s with falling-leaf flutter.
- **Marine snow**: sinks at its Stokes velocity.

### Fish bodies and tissue (`fishModel.js`)
- **Shape**: an arched back with a flatter belly line, a convex head ending in a blunt mouth, and a gill-cover bulge with an eye socket. The cross-section is lens-shaped for compressed species and fuller for round ones.
- **Skin**:
  - Imbricated scales are computed analytically at each species' lateral-line scale count. They drive a normal map, the dark pigment pockets along each scale's edge, and the guanine platelets' iridescence.
  - The scale lattice is laid out by arc length round the body, and scales shrink with body depth towards the peduncle and nape. Each scale is slightly jittered in place and size, and small scales cover the cheek (`body.headScales`).
  - Each scale is tilted on its own, and has its own reflector strength and film thickness (iridescence map R and G). So the sheen breaks into a scale-by-scale mosaic: near neutral on most fish, a narrow blue-green band for structural colour (`iridescent`, or `irid: { range, strength }`).
  - Pigment follows the scales: band edges step along scale rows, each scale is a shade lighter or darker, and fine chromatophore speckle is densest on the back (`speckle`).
  - Countershading and mottling are layered over the pattern. The gill cover, lateral line and mouth are painted on, with no painted highlights: the light picks out relief through the normal maps.
  - A cavity map shades the groove under each scale's free margin and the nostril pits. A roughness map makes the exposed field smooth and the margins rough: more so on comb-edged (ctenoid) scales than on a wrasse's smooth-edged (cycloid) ones (`body.scaleType`). Minute tang scales read as velvet, with a low sheen. These maps share textures with the sheen map (strength and film thickness in one, cavity in the roughness map's red channel) to save texture units: WebGL on Windows allows 16 per shader. Caustics (3 cascades) live in one texture array and the reef light's five grids in two, so the body shader uses 11 units and the fins 9; fin thickness rides in the fin roughness map's red channel.
  - The lateral line is a row of pored scales over a paler canal.
  - Close up, a tiling detail normal map adds what the body map can't hold: velvet minute scales on tangs and the Moorish idol, growth rings (and spinules on ctenoid scales) within each scale on the others, and mucus creases on the moray. It fades out once it is finer than the screen shows.
  - Eyes have a lens catchlight (a thin clearcoat) and an iridescent iridophore ring round the pupil.
  - Skin and fin-relief maps take ~1 s per species to paint. They are cached as PNGs in `pc/models/skins/` (git-ignored), keyed by the species' look and the painters' source, so any change repaints. Pages served locally save them on first load.
- **Light transport**:
  - Light that passes through tissue follows Beer–Lambert by thickness in mm. Red survives longest, so the dorsal ridge, peduncle and fins glow when backlit, with a forward-scattering lobe.
  - Subsurface diffusion softens the terminator (wrapped Lambert, wider for red).
  - Ambient light from behind passes through thin parts.
- **Fins**: each fin is a 3D membrane meshed along its rays and fan-folded, with rays on alternate ridges and valleys. That gives real relief and broken-up highlights. A relief map raises each jointed ray above the membrane (normal map). Rays are also glossier and about 4x thicker for the tissue light term, so backlit fins show dark rays on a glowing film.
  - Ray counts come from the species' published meristics (`anatomy` in `species.js`, e.g. clownfish D XI,15; caudal fins default to the 17 principal rays of spiny-rayed fishes).
  - Spines are stiff and unjointed, and the membrane is incised between their tips. Soft rays are jointed and branch towards the margin.
  - The membrane is a thin pigmented film that thins from base to margin. Pigmented margins (`edgeW`, in body lengths) follow only the free edge and can have a translucent fringe outside them.
  - Pelvic fins (`sp.pelvic`) are paired and splay out from the belly. Pectorals are pleated and slightly cupped; `kind: 'round'` gives the damselfish paddle.
  - Free spines (`kind: 'spines'`: the lionfish dorsal, the triggerfish's trigger) are banded 3D tubes joined only by a low, incised web, each with a membrane flag along its rear edge. Fan pectorals (`kind: 'fan'`) have tube rays standing free past a deeply notched membrane.
- **Eels** (`moray`): no pectoral or pelvic fins (`pectoral: null`); a solid, skin-covered fin fold (`solid: true`); scaleless, glossier skin (`scales: 0`); a hinged jaw (`sp.mouth`: the lower jaw turns about the corner of the gape, over a dark lining painted along the lip line); the snowflake pattern (`op: 'blotches'`: rows of dendritic dark blotches with yellow centres over fine speckle).
- **Head detail**: `sp.ridges` raises ridges or cuts grooves along segments placed on the side view (the lionfish's suborbital stay and brow, the triggerfish's groove before the eye and its lips). `sp.appendages` adds paired tentacles and lappets (the lionfish's leaf-shaped supraorbital tentacles) as tapered, banded tubes.
- **Eyes**: iris stroma and a lens pupil under a nearly flush cornea, with no dark limbal ring. Pupil and iris size and the melanophore flecks around the pupil can be set per species (`sp.eye`). The eyes are baked into fish space so they move with the swimming head.

- **Not fish** (`critters.js`): a common cuttlefish (zebra-barred mantle, W pupils, a fin skirt whose waves run either way so it hovers, cruises and backs up; dark clouds pass over its back while it hunts, it mottles at rest and blanches as it jets off), a day octopus (wrinkled mantle sac, eye turrets, eight arms rebuilt each frame as tubes that drape over the rock, with pale suckers underneath; it keeps a den in a cave the moray doesn't hold, forages over the reef, pounces on food that settles near it and jets away from big animals) and a juvenile green turtle (sunburst scutes, scaled head and flippers; it flies on its front flippers, rests on sand, grazes on rock and comes up to breathe every few minutes). Fish give them room, and small fish treat the cuttlefish and octopus as predators. They are listed in tank files like fish (`cuttlefish`, `octopus`, `turtle`).
  - **Soft bodies** (docs/organic-modelling-plan.md): the octopus's body (sac, head, turrets, siphon, oral disc and arm roots) and the cuttlefish's mantle, head and arm crown are each one mesh from a distance field joined by smooth minimums, so parts grow out of each other with fillets instead of seams. They are meshed offline by surface nets (`pc/src/softBodies.js`, `sdfMesh.js`) into `pc/models/critters/*.glb` with `node tools/softbodies.mjs` (deterministic; the page meshes a missing file itself, slowly, with a warning). The octopus skin is mapped triplanar and the sac breathes in the vertex shader (a per-vertex sac weight); the cuttlefish mantle squeezes the same way. Octopus arms have a flat, broad sucker side, a curved taper with a rounded tip, and two staggered rows of raised suckers (one instanced mesh). The cuttlefish arms are built once and bent in the vertex shader; its fin skirt is a thick strip rooted inside the mantle. The moon jelly's bell is a lens (an inner surface drawn inside it) with a notched, scalloped margin, and its oral arms have rolled, frilled edges. All of them, and the anemone, get a cheap light-through-the-skin term (`softSkin.js`: wrapped diffuse plus a back-light lobe, stronger in thin parts).

Inspect any species up close at <http://localhost:8080/pc/lab.html?sp=clownfish>. Use `sp=all` for a lineup, and `yaw` or `swim=0` to pose it. The toolbar also switches the light rig (`rig=sun|led`) and tone mapping (`tone=aces|neutral|agx|none`), and **screenshot** saves what is on screen as a PNG.

### Comparing against reference photos

Tick **reference** (or use `&ref=1`) to lay a real photo over the render and measure the difference. This is phase 0 of [docs/photoreal-fish-plan.md](docs/photoreal-fish-plan.md).

1. Drop a side-on photo onto the lab page, or try any image with `&refimg=<url>`. Tick **mirror** if the fish faces left.
2. Match the pose: **yaw** in the main bar, plus **pitch**, **fov** and the sun direction (**az**/**el**, relative to the view).
3. Pick the **outline** tool and click around the fish (Backspace removes a point). Pick **patch** to mark named colour samples, such as body, band or fin margin.
4. Click **align** to scale and move the photo so its outline matches the render's silhouette, then **measure**:
   - **silhouette IoU** (target ≥ 0.97), mean and max boundary distance, and how much of the render lies outside the photo and vice versa. The render's edge is drawn in cyan, the traced outline in yellow.
   - **CIEDE2000** for each colour patch, photo vs render, both in the colours on screen (target ≤ 5). The render is sampled at the same anatomical spot: the same fraction of length from the snout and of the local top-to-bottom height. The sample then snaps to the nearest area of the same kind (white band, black margin or colour), so a misplaced band is compared as a band. How far it had to move is reported separately, as a percentage of length. Dashed cyan circles show where the render was sampled.
5. Click **save** to copy the photo and `refs.json` into `pc/ref/<species>/`. Next time, `&ref=1` reloads them and aligns automatically.

The render's silhouette is a coverage mask: the scene is drawn over black and over white, so translucent fins count only where they hide at least half the background. **wipe**, **blend**, **photo** and **render** choose how the photo is shown. Drag to pan the photo and use the mouse wheel to zoom.

## Using Tripo3D models (studio.tripo3d.ai)

Any species can use a generated model instead of its procedural mesh. The swim shader bends static meshes, so **no rig is needed**.

1. Generate the fish in Tripo. Image-to-3D from a clean side-on photo gives the most accurate markings.
2. Export as **GLB** with PBR textures. A face limit of about 10–30k is plenty.
3. Save it as `pc/models/<species-id>.glb` and add it to `pc/models/models.json`:

   ```json
   {
     "clownfish": { "file": "clownfish.glb" },
     "bluetang":  { "file": "bluetang.glb", "flip": true }
   }
   ```

   The model is auto-centred, scaled to length 1 and its long axis turned onto x. Set `"flip": true` if the fish swims backwards, `"rotate": [x, y, z]` (degrees) if it is tilted or upside down, and `"finFrac"` (default 0.3) to tune where fin flutter starts.

Prompt tips for every species: *"photorealistic, adult, straight neutral side-on pose, body NOT bent, fins naturally extended, mouth closed, no base or stand, isolated"*. A straight body matters most, because the shader adds the bend.

| species id | Prompt subject |
|---|---|
| `clownfish` | Ocellaris clownfish (*Amphiprion ocellaris*), bright orange, three white bands with thin black edges, black-edged rounded fins |
| `bluetang` | Pacific blue tang (*Paracanthurus hepatus*), royal blue body, black "palette" marking, yellow tail |
| `yellowtang` | Yellow tang (*Zebrasoma flavescens*), bright yellow tall disc-shaped body, tall dorsal and anal fins, white tail spine |
| `moorishidol` | Moorish idol (*Zanclus cornutus*), white and yellow, two broad black bands, long trailing white dorsal filament, orange snout saddle |
| `lionfish` | Red lionfish (*Pterois volitans*), red-brown and white vertical stripes, long separate venomous dorsal spines, large fan-like pectoral fins |
| `copperband` | Copperband butterflyfish (*Chelmon rostratus*), white with orange vertical bands, long tweezer snout, black eyespot on dorsal fin |
| `royalgramma` | Royal gramma (*Gramma loreto*), front half magenta-purple, rear half yellow, black spot on dorsal fin |
| `clowntrigger` | Clown triggerfish (*Balistoides conspicillum*), black with large white belly spots, yellow reticulated saddle, orange-yellow lips |
| `emperorangel` | Adult emperor angelfish (*Pomacanthus imperator*), blue with yellow horizontal stripes, black eye mask, yellow tail |
| `longnose` | Yellow longnose butterflyfish (*Forcipiger flavissimus*), yellow body, very long thin snout, black upper head, eyespot on anal fin |
| `chromis` | Blue-green chromis (*Chromis viridis*), small iridescent pale blue-green damselfish, forked tail |
| `coralbeauty` | Coral beauty angelfish (*Centropyge bispinosa*), orange centre fading to deep blue-purple edges, thin vertical blue bars |

### Generated scenery (rocks and corals)

`tools/tripo.mjs` generates live rock and coral models with the Tripo3D API. It uses PBR textures with baked lighting removed (`delight`), so the underwater lighting is the only light.

```bash
node tools/tripo.mjs --list
node tools/tripo.mjs
node tools/tripo.mjs rock_b coral_fan
```

The first command shows the jobs and prompts. The second generates every missing model. The third regenerates only the named models.

- **Key**: put the API key in `tripo3d.ai.key` in the project root, or set `TRIPO_API_KEY`. The file is git-ignored and the server refuses to serve it.
- **Credits**: API credits are separate from a Studio subscription. Each model costs roughly 10–40 credits (1 credit = $0.01).
- **Output**: models go to `pc/models/scenery/` and are listed in `pc/models/scenery.json`.
- **Placement**: rocks are stretched onto the procedural rock-pile layout, each slot taking one of the two rocks whose own proportions fit it best (8 rocks: boulders, a pillar, a shelf, an arch, a ledge with an overhang, a rubble mound, a pitted boulder and a branching dead-coral piece). Each coral replaces its procedural counterpart (staghorn, finger, cauliflower, brain, leather, fan), fitted to the same size and spot. The reef heightfield the fish steer by follows the new shapes, and a 3D distance field of the real rock and coral surfaces (8 cm voxels, built in under a second at load) keeps fish out of the rock: they slide along a face instead of being lifted to its top, and steer round a boulder's flank as readily as over it. Anything missing stays procedural.
- **Props** (`kind: "prop"`): a starfish and a conch, from your own GLBs (`starfish.glb`, `conch.glb`, textures shrunk with `node tools/optimize-scenery.mjs starfish conch`), lie on the open sand at the front at life size (17 and 16 cm). `rotate: [x, y, z]` in degrees turns a model before it is fitted; the starfish was modelled upright, so it gets `[-90, 0, 0]` to lie flat.
- **Plants** (`kind: "plant"`, `stiff` 0..1): Halimeda (calcified, stiff) and Caulerpa clumps on clear sand. Three beds of turtle grass are built in code: strap blades in shoots, olive with browned tips. Plants, the sea fan, the leather coral (`sway`) and the anemone sway with the water in the vertex shader (`reef.js` `addSway`). The anemone's sway had never run before this: its shader read an unbound `uTime`.
- **Rubble**: angular coral and shell fragments collect at the rock feet.

### Checks (`node tools/check.mjs`)

Headless, in software GL; the page's console is printed. `--seeds=7,42` runs one per seed.

```bash
node tools/check.mjs motion --seconds=300
node tools/check.mjs motion --night=1
node tools/check.mjs look --at=5,30 --close=station,chromis
```

- **`look`** (`lookCheck.js`) renders the tank at the given simulated seconds. It saves `out/look-<tag>-<t>s.png` (git-ignored), close-ups of the cleaning station or a species, and the frame's mean luminance and saturation. Add `--light=0.35` for dusk or `--tone=aces` for a tone A/B. The reef-light bake (`--reeflight=1`) followed by a live render overloads software GL, so judge the reef light from the Roku bake's backdrop instead.
- **`motion`** reports, besides what is listed below:
  - shoal structure: median nearest-neighbour distance in body lengths, polarisation, and how many subgroups;
  - the share of fish in shelter;
  - fear passed on versus seen first-hand, per minute;
  - cleaning sessions and clients;
  - lionfish lunges, and truces between territorial fish.

  `--night=1` runs it at night, `--light=0.35` at dusk. Seed 7: by day the chromis keep 1.9 body lengths apart at polarisation 0.38, splitting and re-forming; at night they pack into their coral (0.8 BL) and a third of all fish are in shelter. In 5 minutes there are about 5 cleaning sessions; at dusk the lionfish lunges about 8 times.

`?check=motion` steps the tank for two simulated minutes without drawing (`&seconds=N` to change that; add `&reeflight=0` to skip the slow light bake) and reports in the console and `window.motionCheck`:
- each fish's fastest climb, in body lengths per second (a snap up a coral head shows as a spike);
- quick up-down reversals per minute (bobbing over branching coral);
- for each eel, the frames in which its body is inside a cave roof.

Measured on seed 7, before and after the fish started looking about a second ahead for the reef top and the rock stopped snapping them upwards: the fastest climb fell from 67 to 11.5 body lengths per second, reversals from 0.39 to 0.15 per fish per minute, and the eel's frames inside its roof from 3598 of 3600 to 0.

## Roku (in progress)

Roku can't run WebGL, so the plan is to render the scene offline with the same three.js code:
- a backdrop, and each fish as sprite frames at several viewing angles and tail phases;
- a BrightScript port of the brain and swimming physics, driving SceneGraph posters;
- packaged as a channel with `RunScreenSaver()` and `Main()` entry points.

To see the baked assets as the Roku will draw them (a 2D backdrop, sprite fish and foreground reef, no WebGL), open <http://localhost:8080/pc/roku.html> or run `run_baked.bat`, which re-bakes first so the preview matches the current code (`run_baked.bat nobake` skips that). URL options: `?fps=30`, `?scene=reef-7`, `?seed=1`. Press **W** to toggle the moving water.

The bake takes as much as it can from the live tank:
- **Reef light**: the PC tank's ray-cast reef light (`reefLight.js`: soft sun shadows, ambient occlusion, coloured bounce), with the same inputs as `main.js` and the ambient water light lowered against it as `main.js` does (`?reeflight=0` to compare).
- **Fish**: lit by the live rig at full daylight (sun 2.65, ambient 0.75, exposure 1.25) and rendered through the live water (absorption, inscatter and the reef-depth white balance), placed mid-way up the window and seen from the live camera's distance, so sprites match the reef they swim over.
- **Marine snow**: the live particles, carried by the pump current, are in the water loop. Two copies of the simulation run forward to the two moments each loop frame blends.
- **Bubbles**: the airstone's column uses sprites baked with the live bubble shader, sent up by the player at the live rise speed, about 25 cm/s, which is too fast for a 4 fps loop.
- **Brains**: the bake exports the shelters in screen space, and the predator and nocturnal flags. The player (`roku.js`, the model for the BrightScript port) runs a reduced brain:
  - schooling by pairwise rules on the nearest three shoalmates;
  - prey fear of a predator heading their way;
  - fear passed between shoalmates after a 0.25 s reaction delay, weaker by a hop;
  - a dash to the fish's shelter, where it may drop behind the foreground reef.
- **Not carried over**: motion blur, night colours, cleaning and stalking (yet), caustics moving over the fish (a frozen pattern would slide with the sprite), fish shadows on the reef, and the screen-space AO between fish and rock.

With the zoomed view (`?zoom=1.6`, the default; bake with `--zoom=1` for the whole tank), the backdrop is baked as the strip the screen shows: one screen wide, or with `--pan=1` 1.6 screens wide for the pan, cut into 512 px columns (`scenery/<key>-<n>.jpg`, and `-fg-<n>.png` for the foreground, each cropped to its reef). The player draws everything shifted by the pan and loads only the columns on screen plus the next one the pan reaches. Fish off screen hold no textures. Fish sprites are baked at 120 × zoom px per unit to stay sharp at the larger size. Everything (fish, backdrop, foreground and water loop) is rendered at 2× and filtered down, because the headless GPU's MSAA alone left about a quarter of the reef's outline pixels hard-stepped. This cut hard steps in the foreground by about 90%, with a scenery bake of about 29 min.

The moving water (caustics, light shafts, surface ripples, swaying soft corals) is baked as a looping set of half-resolution overlay frames, `scenery/<key>-water-NN.png` plus `-water-fg-NN.png` for the foreground reef. Each frame is drawn over the static backdrop with plain alpha blending. Between frames, a step overlay `-water-step-NN.png` (encoded against exactly what frame NN leaves on screen) is drawn over it at opacity t, which gives the true linear blend towards the next frame. Fading one partly transparent frame over another instead shows both caustic networks at once, brightening through each step and snapping back: a pulse 4 times a second. Each frame's caustic contrast is also matched to the average, so the loop's own crossfade doesn't dim it mid-loop. Tune it with `pc/bake.html?waterFrames=32&waterLoop=8` (frame count, loop length in seconds).

**Fish turning.** Roku's own Aquatic Life screensaver renders 3D fish live through the native NDK and OpenGL, which Roku doesn't open to ordinary channels. Instead, each fish is baked as its swim cycle (`?frames=8`) at evenly spaced viewing angles from tail-on through side-on to head-on (`?yaws=9`, 22.5° steps). Fish are symmetric, so a fish facing left is the mirror image.
- **Player**: each fish has a heading in the plane of x and depth. It turns at its species' rate (`turnRate`, from pectoral sculling), easing in and out, and commits to one side for a U-turn: towards the viewer from the back of the tank, away from it near the glass. It swims along that heading, so it grows as it comes nearer. Cruising fish are shown turned `cruiseYaw` towards the viewer. The two nearest angles are crossfaded (two posters on the Roku), and climbs tilt the side view.
- **Pages**: each angle is its own page `fish/<id>-a<n>.png` (within 2048 × 2048, Roku's recommended largest bitmap), cropped to what that angle covers: a head-on fish is a third the width of a side-on one. The manifest records each page's decoded size (`mb`) and its crop within the full cell. All 9 angles × 8 frames for every species is about 32 MB.

**Texture memory.** Roku bitmaps cost 4 bytes a pixel in texture memory whatever the file size, and the ~100 MB is shared with Roku OS, whose own textures can take more than half of it ([jellyrock#74](https://github.com/jellyrock/jellyrock/issues/74) measured 58 MB OS, 32 MB app). A bitmap stays resident while any Poster's `uri` points at it, even a hidden one, so the channel clears the `uri` of every poster it isn't showing. The preview models this (`Textures` in `pc/src/roku.js`) and shows the total in the HUD:
- **Budget**: `?budget=40` (MB). Each frame the player asks for what it needs by priority: the backdrop, foreground and one fallback angle per species are pinned; then the angles and water frames being drawn; then what a turn or the water loop reaches within 0.4 s; then neighbouring angles if there is room. Wants are granted in that order while they fit, and everything else is freed.
- **Load time**: `?latency=80` (ms) simulates the device's load and decode time. Loading ahead covers it; a shown angle that isn't ready yet is drawn with the nearest one that is (counted as a miss in the HUD).
- **Water**: the loop is streamed, holding only the frame and step on screen and the next pair (about 10 MB instead of 160 MB for all of them). That is 16 PNG loads a second at the default 4 frames a second, which needs checking on the device; `waterFrames` and `waterLoop` set the rate. The foreground reef is cropped to its content (2 MB instead of 8 MB).
- **Measured** in the preview (`?timer=1` runs it without animation frames, for a hidden window): about 33–35 MB needed and 37 MB held under a 40 MB budget, ~22 loads a second, a few misses a second at 80 ms load time.
- **More angles**: with pages loaded on demand, `?yaws=17` (11.25° steps) costs about twice the fish memory with everything loaded but much less in use, since most fish are near side-on most of the time. The 50S525's texture memory isn't published, so the right budget needs checking on the device.

## Layout

```
pc/index.html        page + UI styles
pc/src/main.js       renderer, lights, scene assembly, day/night, loop
pc/src/brain.js      per-fish brain
pc/src/fish.js       swimming physics
pc/src/fishModel.js  procedural fish meshes/textures, swim shader, GLB loader
pc/src/reef.js       rocks, corals, anemone, sand, reef heightfield
pc/src/rockField.js  signed distance field of the solid scenery, for collision
pc/src/water.js      underwater light transport, waves, caustics, light shafts, surface, bubbles, particles
pc/src/world.js      shared tank state: bounds, flow field, food, shoal goals
pc/src/species.js    species anatomy, temperament and swimming biomechanics
pc/models/           optional GLB models + models.json
tools/serve.mjs      local server (also used by the Roku exporter)
tools/softbodies.mjs meshes the critters' blended bodies into pc/models/critters/*.glb
```
