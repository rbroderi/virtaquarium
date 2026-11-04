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
| Space | pause |
| H | help |

URL options: `?clock=1` (lights follow your local time), `?feed=4` (auto-feeder interval in minutes, `0` = off), `?drift=0` (no camera parallax), `?seed=7` (reef layout).

## How it works

### Brains (`pc/src/brain.js`)
Each fish is an agent with:
- **Personality traits**: boldness, curiosity, activity, sociability, aggression and appetite. Drawn per individual around species norms, so no two fish of a species act the same.
- **Drives** that change continuously: hunger, energy, fear, social need and boredom.
- **Perception**: same-species neighbours, predators, rivals near its territory, and food within sight. Bold, hungry fish notice food from further away.
- **Utility-based action selection**: cruise, school, forage, feed, rest, flee, patrol, inspect the glass, host in the anemone, or hover. Hysteresis keeps it committed to a choice, and chase fatigue lets rivals settle into a truce.

The behaviour turns into a steering goal; the body then has to physically achieve it.

### Physics
World scale: **1 unit = 12.5 cm**. The tank is 2.0 × 1.1 × 0.75 m and the fish are real aquarium-specimen sizes.

- **Swimming** (`fish.js`): mass ∝ L³ and quadratic drag. Thrust comes from a speed controller, capped at the species' sustained speed and its burst speed (body lengths/s).
  - Yaw rate is limited by `hoverTurn + U / (r_min · L)`. Strong lateral drag acts like a keel.
  - Tail-beat frequency follows the Strouhal relation `f = St·U/A` (St ≈ 0.3, A = 0.2 L), using the speed the current thrust would sustain.
  - Each species uses its real swimming mode:
    - Labriform (tangs, angels, butterflyfish, damsels) row with their pectoral fins and recruit the tail above a gait-transition speed.
    - Balistiform (triggerfish, lionfish) undulate the dorsal and anal fins.
    - Body-caudal-fin swimmers (gramma) use burst-and-coast.
  - The body wave travels head to tail with slip ratio ≈ 0.6, and the spine curves with path curvature in turns.
- **Water** (`water.js`): three.js fog is replaced by a per-channel Beer–Lambert medium.
  - Beam attenuation and downwelling attenuation Kd use clear reef-water coefficients.
  - Inscattered light fills long paths, and only the path inside the glass counts.
  - A custom white balance at reef depth is applied, as an underwater camera would.
  - The ambient environment is the underwater radiance field: Snell's window overhead, blue-green inscatter around it, sand upwelling below.
- **Surface waves**: 24 capillary-gravity waves, 5–50 cm long, each travelling at its physical phase speed (ω² = gk + σk³/ρ). They tile every 50 cm. The caustics, the light shafts and the surface all use this one wave field.
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
  - Imbricated scales are computed analytically at each species' lateral-line scale count. They drive a normal map, the dark pigment pockets along each scale's edge, and an iridescence mask for the guanine platelets.
  - Countershading and mottling are layered over the pattern. The gill cover, lateral line and mouth are painted on.
- **Light transport**:
  - Light that passes through tissue follows Beer–Lambert by thickness in mm. Red survives longest, so the dorsal ridge, peduncle and fins glow when backlit, with a forward-scattering lobe.
  - Subsurface diffusion softens the terminator (wrapped Lambert, wider for red).
  - Ambient light from behind passes through thin parts.
- **Fins**: each fin is a 3D membrane meshed along its rays and fan-folded, with rays on alternate ridges and valleys. That gives real relief and broken-up highlights. The membrane is a thin pigmented film, and its jointed rays are more opaque than the membrane. Pectorals are pleated and slightly cupped.
- **Eyes**: iris stroma, limbal ring and lens pupil under a clear cornea. They are baked into fish space so they move with the swimming head.

Inspect any species up close at <http://localhost:8080/pc/lab.html?sp=clownfish>. Use `sp=all` for a lineup, and `yaw` or `swim=0` to pose it.

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
- **Placement**: rocks are stretched onto the procedural rock-pile layout. Each coral replaces its procedural counterpart (staghorn, finger, cauliflower, brain, leather, fan), fitted to the same size and spot. The reef heightfield the fish use follows the new shapes. Anything missing stays procedural.

## Roku (in progress)

Roku can't run WebGL, so the plan is to render the scene offline with the same three.js code:
- a backdrop, and each fish as sprite frames at several yaw angles and tail phases;
- a BrightScript port of the brain and swimming physics, driving SceneGraph posters;
- packaged as a channel with `RunScreenSaver()` and `Main()` entry points.

## Layout

```
pc/index.html        page + UI styles
pc/src/main.js       renderer, lights, scene assembly, day/night, loop
pc/src/brain.js      per-fish brain
pc/src/fish.js       swimming physics
pc/src/fishModel.js  procedural fish meshes/textures, swim shader, GLB loader
pc/src/reef.js       rocks, corals, anemone, sand, reef heightfield
pc/src/water.js      underwater light transport, waves, caustics, light shafts, surface, bubbles, particles
pc/src/world.js      shared tank state: bounds, flow field, food, shoal goals
pc/src/species.js    species anatomy, temperament and swimming biomechanics
pc/models/           optional GLB models + models.json
tools/serve.mjs      local server (also used by the Roku exporter)
```
