# Virtual Aquarium

A physically based virtual reef aquarium in the browser, where every fish has its own brain.

Fourteen species of reef fish (among them a moray and a cleaner wrasse), a cuttlefish, an octopus, a
green turtle and moon jellies live in
a procedurally built reef. Nothing is scripted. Each animal perceives the tank, weighs its own drives and
swims with real biomechanics, and the shoaling, sheltering, cleaning and territorial behaviour of the
tank comes from those local rules. The water, light and caustics are simulated rather than painted.

Targets: **PC** (three.js / WebGL in any modern browser) and **Roku** (a SceneGraph screensaver that
plays assets pre-rendered from the PC build; in progress).

## Quick start

Needs [Bun](https://bun.sh) and a recent Chrome or Edge.

```bash
bun install
bun start
```

Open <http://localhost:8080/> and press **F11** for full screen. On Windows, `run.bat` does the same and
opens the browser for you.

| Input | Action |
|---|---|
| click | drop food (or select a fish or critter) |
| Tab | inspect the next fish's brain |
| B | show every fish's current thought |
| F | feed |
| N | jump between noon and midnight |
| < / > | slow down / speed up the day-night clock |
| R | back to the real-time clock |
| L | toggle the baked reef light |
| T | switch between the reef and the moon jelly tank (also the buttons bottom right) |
| Space | pause |
| H | help |

### URL options

| Option | Effect |
|---|---|
| `?seed=7` | reef layout and stocking |
| `?clock=0` | turn off the day-night clock (the tank stays bright; it follows your local time by default) |
| `?feed=4` | auto-feeder interval in minutes (`0` = off) |
| `?drift=0` | no camera parallax |
| `?zoom=1` | show the whole tank (default is a 1/1.6 window near the sand) |
| `?pan=0` | hold the camera still (by default it pans slowly across the tank and back, once every 2 minutes; the Roku bake pans only with `?pan=1`) |
| `?scenery=jelly` | the jelly tank: moon jellies in a backlit deep-blue kreisel |
| `?tank=tanks/example.json` | stock the tank from a tank document (see `schema/`) |
| `?rig=led` | light the tank with an aquarium LED bar instead of the sun |
| `?photo=0`, `?fstop=2.8` | turn off or adjust the camera model (depth of field, vignetting, grain) |
| `?glass=1` | reflections in the front glass |
| `?blur=0` | no motion blur |
| `?tone=aces` | ACES tone mapping instead of Khronos PBR Neutral |
| `?reeflight=0` | skip the baked reef light |
| `?lod=0` | always draw fish at full detail |

## How it works

### Brains

Each fish is an agent with:

- **Personality**: boldness, curiosity, activity, sociability, aggression and appetite, drawn per
  individual around species norms, so no two fish of a species act the same.
- **Drives** that change continuously: hunger, energy, fear, social need and boredom.
- **Perception**: all-round vision except a blind cone behind, with a range that grows with the target's
  size, shrinks in the dark and is blocked by rock. A lateral line senses anything within about a body
  length, in any light.
- **Utility-based action selection**: cruise, school, forage, feed, rest, flee, patrol, inspect the glass,
  host in the anemone, hover, stalk, clean or pose for a cleaner. Hysteresis keeps a fish committed to a
  choice.

The chosen behaviour becomes a steering goal that the body then has to achieve physically. From these
local rules:

- **Schools** follow pairwise rules on their nearest shoalmates: repulsion close in, attraction further
  out, speed matching and weak alignment (Herbert-Read et al. 2011; Katz et al. 2011). With no shared
  goal, a shoal splits round a coral head and re-forms.
- **Fear spreads**: a fish that sees a neighbour dash off flees too, so a startle runs through a shoal as
  a wave that weakens with each hop (Rosenthal et al. 2015).
- **Shelter and night**: the reef's ledges and crevices are found automatically, each fish knows one near
  home, and at dusk the reef empties (Hobson 1972). Night colours come on over minutes.
- **Cleaning station**: a cleaner wrasse holds a station and advertises with a dance. Clients queue and
  pose while it works along their flanks, and now and then it cheats and bites (Bshary & Grutter 2002).
- **Territory**: a fish chased off twice by the same holder keeps out afterwards, so truce lines form.
- **Lionfish** stalk at dusk with their fans spread and lunge from about a body length (Albins & Lyons
  2012).
- **The viewer**: moving the pointer at the glass draws bold, curious fish to come and look, and makes shy
  ones back off.

### Physics

World scale: **1 unit = 12.5 cm**. The tank is 2.0 × 1.1 × 0.75 m and the fish are real specimen sizes.

- **Swimming**: mass ∝ L³ and quadratic drag, thrust capped at each species' sustained and burst speeds.
  Turns have rotational inertia and are limited by pectoral sculling at low speed, and by turning radius
  and lateral acceleration at speed. Pitch, banking and depth changes follow published ranges.
- **Gaits**: labriform (tangs, angels, butterflyfish, damsels) row with their pectorals; balistiform
  (triggerfish, lionfish) undulate the dorsal and anal fins; the gramma bursts and coasts; the moray
  undulates its whole body. Tail-beat frequency follows the Strouhal relation `f = St·U/A`.
- **Body wave**: a spine curve that travels head to tail, so the body keeps its length and the caudal
  blade pitches. Damped springs give secondary motion: the tail lags into turns, fins fold at speed,
  pectorals feather on the recovery stroke and spines lock up when a fish is alarmed.
- **The moray**: its body follows the path its head took, so a turn flows down the body through the same
  curve, and it is drawn along that path rather than bent about a straight axis. An anguilliform wave
  (about 0.6 body lengths long, so one or two bends always show) runs head to tail on top, small at the
  head and growing towards the tail, and travels faster than the eel swims. Near the reef the body settles
  onto the rock and lies along its contours, and no part of it enters the rock. By day it rests in its
  cave with the body in line along the crevice behind it, its head and neck out, swaying and gulping
  water; to go home it backs in tail first.
- **Collision**: rock and coral are a 3D signed distance field on a 1 cm grid. Checked against the drawn
  meshes, it never reads rock as open water, and it puts the surface about 0.05 units (6 mm) out on the
  water side. Each fish is its axis with an elliptical section that tapers to the snout and peduncle.
  The snout, middle and peduncle each keep that section off the rock, pushed out no faster than they
  were moving in. After every step, fish bodies that overlap are pushed apart (the lighter fish moves
  more) and lose their closing speed. This comes on top of the brain's personal space. The moray's
  chain is an obstacle the others are pushed off. A cleaner and its client may touch.
- **Water**: a per-channel Beer–Lambert medium with in-scattering and a reef-depth white balance, an
  underwater environment with Snell's window overhead, and a slow divergence-free current from the return
  pump that carries fish, food, bubbles and particles.
- **Surface and caustics**: the surface is stirred by the pumps rather than wind. A fine grid on it
  refracts the light by Snell's law per colour channel, and the irradiance at depth comes from the area
  ratio of each projected triangle, which conserves energy. Light shafts are ray-marched with a
  Henyey–Greenstein phase function. From below, the surface shows total internal reflection beyond the
  critical angle.
- **Bubbles, food and snow**: bubbles rise at speeds from Mendelson's formula and grow with Boyle's law;
  flakes float on the surface film, then flutter down; marine snow sinks at its Stokes velocity.

### Fish bodies

- **Shape** from each species' published body proportions, with silhouettes fitted to traced reference
  photographs (`bun run fit-anatomy`).
- **Skin**: imbricated scales computed at each species' lateral-line scale count drive the normal,
  pigment, cavity, roughness and iridescence maps, so pigment and sheen break up scale by scale. Velvet
  tang scales, smooth wrasse scales and a scaleless moray each read differently. Skins are painted
  procedurally and cached in `web/models/skins/`.
- **Light through tissue**: Beer–Lambert by thickness, so the dorsal ridge, peduncle and fins glow red
  when backlit, plus wrapped diffuse for subsurface softening.
- **Fins**: 3D membranes meshed along their rays, with ray counts from published meristics. Spines are
  stiff with an incised membrane; soft rays are jointed and branch towards the margin.
- **Heads**: a hinged jaw, real gill covers that breathe, nostrils, eyes with a lens catchlight and an
  iridescent ring, and species details such as the tangs' scalpels and the lionfish's tentacles.
- **Not fish**: the cuttlefish, octopus and turtle have their own models and behaviour. The cuttlefish and
  octopus bodies are distance fields meshed into one surface each (`bun run softbodies`), so their parts
  grow out of each other without seams. Click any of them, or a moon jelly, to see what it is doing.

### The reef

The reef is laid out procedurally from the seed: rock piles, caves the moray can use and the viewer can see
into, corals, an anemone, turtle grass, rubble and feather-duster worms that snap shut when a fish passes.
Generated rock, coral and prop models (below) replace their procedural counterparts when present. A 3D
distance field of the solid scenery keeps the fish out of the rock.

At load the static reef is lit by GPU ray casting: soft shadows from a sun of finite size, the share of
ambient light each point can see, and two bounces of coloured light, stored per pixel and in a 3D grid
that lights the fish. The result is cached in `web/models/cache/`, so later starts take a second or two.
Only the fish cast live shadows, and a screen-space AO pass adds contact shading.

## Fish lab

<http://localhost:8080/lab.html?sp=clownfish> shows any species up close (`sp=all` for a lineup, `yaw` or
`swim=0` to pose it). The toolbar switches the light rig and tone mapping and takes screenshots. On
Windows, `run_fishlab.bat clownfish` opens it.

### Comparing against reference photos

Tick **reference** (or add `&ref=1`) to lay a real photo over the render and measure the difference.

1. Drop a side-on photo onto the page, or load one with `&refimg=<url>`. Tick **mirror** if the fish faces
   left.
2. Match the pose with **yaw**, **pitch**, **fov** and the sun direction.
3. Use the **outline** tool to trace the fish and **patch** to mark named colour samples.
4. Click **align**, then **measure**: silhouette IoU, boundary distances and CIEDE2000 colour differences
   per patch, sampled at the same anatomical spot on the render.
5. Click **save** to store the photo and `refs.json` in `web/ref/<species>/`.

## Custom models

Any species can use a GLB model instead of its procedural mesh. The swim shader bends static meshes, so
no rig is needed. Save the model as `web/models/<species-id>.glb` and list it in `web/models/models.json`:

```json
{
  "clownfish": { "file": "clownfish.glb" },
  "bluetang":  { "file": "bluetang.glb", "flip": true }
}
```

The model is centred, scaled to length 1 and its long axis turned onto x. `"flip": true` turns a fish that
swims backwards, `"rotate": [x, y, z]` (degrees) fixes a tilt, and `"finFrac"` (default 0.3) sets where fin
flutter starts. The body must be straight and side-on, because the shader adds the bend.

### Generated scenery

`bun run tripo` generates live rock, coral, plant and prop models with the [Tripo3D](https://www.tripo3d.ai)
API, with baked-in lighting removed so the tank's own lighting is the only light. Models go to
`web/models/scenery/` and are listed in `web/models/scenery.json`.

```bash
bun run tripo --list            # show the jobs and prompts
bun run tripo                   # generate every missing model
bun run tripo rock_b coral_fan  # regenerate just these
```

Put the API key in `tripo3d.ai.key` in the project root or set `TRIPO_API_KEY`; the file is git-ignored and
never served. Each model costs API credits. New models are shrunk for real-time use
(`bun run optimize-scenery`) and get a parallax height map in their normal map's alpha
(`bun run heightmaps`).

## Roku

Roku can't run WebGL, so the scene is rendered offline with the same code: a backdrop, a foreground layer
of the reef pieces near the glass, a looping set of water and caustic frames, and each fish as swim-cycle
sprites at several viewing angles. A reduced brain drives the sprites on the device.

```bash
bun run bake
```

writes the assets to `roku/assets/`. To preview them as the Roku will draw them, open
<http://localhost:8080/roku.html> (`?fps=30`, `?scene=reef-7`, `?seed=1`; **W** toggles the water), or run
`run_baked.bat`, which re-bakes first (`run_baked.bat nobake` skips that). The preview models the
device's texture memory budget (`?budget=40`, in MB) and load time (`?latency=80`, in ms) and shows both in
its HUD.

## Development

The project is strict TypeScript, run with Bun. Tools run straight from their `.ts` sources; the pages are
bundled with esbuild into `web/build/` in well under a second.

| Command | What it does |
|---|---|
| `bun start` | build, then serve on <http://localhost:8080/> |
| `bun run build` / `bun run watch` | bundle the pages into `web/build/` |
| `bun run serve` | the local server (`tools/serve.ts`): serves `web/`, plus `roku/` at `/roku/`, and accepts the cache, bake and check uploads |
| `bun run verify` | typecheck, then run the tests (`bun run typecheck`, `bun run test`) |
| `bun run check <name>` | headless tank checks: `motion`, `look`, `critters`, `startup`, `perf` (output in `out/`) |
| `bun run bake` | headless Roku asset bake |
| `bun run softbodies` | mesh the critters' soft bodies into `web/models/critters/` |
| `bun run fit-anatomy <species>` | fit a species' silhouette to its reference photos (`--dry` to report only) |
| `bun run tripo`, `optimize-scenery`, `heightmaps` | generate and prepare scenery models |

Checks run headless in software GL by default; `--gpu=1` uses the machine's GPU, and `--seeds=7,42` runs
one per seed. For example:

```bash
bun run check motion --seconds=300 --night=1
bun run check look --at=5,30 --close=station,chromis
bun run check startup --gpu=1 --profile=1
bun run check perf --gpu=1
```

`tsconfig.json` enables `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. The code
has no `any` and no `@ts-ignore`. Untrusted input (tank documents, manifests, URL parameters) enters as
`unknown` and is validated at the boundary. The parity tests compare the RNG, species catalogue, organic
noise and reef layouts against recorded outputs in `test/goldens/`, so a seed always builds the same
tank.

### Deploying

`railway.json` deploys the site on [Railway](https://railway.com): it builds with `bun run build` and runs
`bun tools/serve.ts --public` on the port Railway gives it. In public mode the server is read-only. It
serves only what the tank page loads (no lab, bake or Roku pages, reference photos or check output), and
the page URL takes only `?scenery=jelly`. The painted fish skins and the baked reef light are kept in each
visitor's own browser (Cache Storage), so a return visit skips that work. `?store=browser` tries this
locally; with `bun run check`, set `CHECK_PORT` so successive runs share one origin.

### Layout

```
web/                   the site: index.html, lab.html, bake.html, roku.html, tanks/
  models/              scenery, critter and fish models (caches in cache/ and skins/)
  ref/                 reference photos and traced outlines per species
src/
  main.ts              composition root of the tank page
  app/                 tank page: options, stage, lighting, daylight, feeder, stocking, loop
  config/              the tank document gate
  core/                rng, maths, noise, colour, canvas, events, organic variation
  species.ts, species/ species catalogue
  anatomy/             fitted body shapes (generated by fit-anatomy)
  brain.ts, brain/     drives, perception, decisions, one behaviour per mode
  fish.ts, fish/       swimming physics, spine chain
  fishModel.ts, fishModel/  procedural meshes, skins, fins, swim shader, custom models
  world.ts, world/     shared tank state
  reef.ts, reef/       reef layout, scenery, rock field
  water.ts, water/     medium, waves, caustics, surface, bubbles, water renderer
  reefLight.ts, reefLight/  baked reef light and its cache
  critters.ts, critters/, jelly.ts, jelly/   the animals that aren't fish
  lab.ts, labRef/, bake.ts, roku.ts, roku/, *Check.ts   other pages and checks
tools/                 server, build, headless checks and bake, asset tools
test/                  vitest suites and golden fixtures
schema/                JSON schema of the tank documents
roku/                  the Roku channel
```

## Credits

Reference photographs in `web/ref/` are credited in each species' `CREDITS.md`.

## License

[GNU Affero General Public License v3.0](LICENSE).
