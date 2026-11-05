# Organic modelling plan: soft bodies, joins and tentacles

Research note (2026-11-05). Nothing in `pc/src` was changed for it. The aim is soft parts that read as
tissue rather than primitives glued together: octopus, cuttlefish, moon jelly, the bubble-tip anemone,
and possibly a new chambered nautilus.

## 1. What reads as "geometric" today

| Part | Where | What gives it away |
|---|---|---|
| Octopus arms | `ArmTube` (critters.js) | Each ring is a perfect circle, 10 sides, with straight-line taper `lerp(r0, r1, s)` and a pinched last ring (`* 0.3`). Normals are the ring directions, so the taper is ignored and the flank looks flat-lit. Suckers are just vertex colours (two pale stripes at 22 rings), with no relief. The oral (sucker) side should be flatter and broader than the aboral side. |
| Octopus body | `Octopus` constructor | Six separate spheres (sac, head, disc, 2 turrets) plus an open cylinder for the siphon, all intersecting. Only the sac gets noise (±9%). You can see the seams where sac meets head, turret meets head and disc meets the arm roots. The web is a 3-column sheet, so it shows creases. |
| Cuttlefish | `Cuttlefish` | A lathe mantle with an ellipsoid head pushed into its rim. The eyes are spheres stuck on. The 8 arms are perfect-circle tubes (10 sides, 18 rings) with linear taper. The fin skirt is a `PlaneGeometry` 2 cells wide with no thickness and no root: it hangs beside the mantle instead of growing out of it. |
| Moon jelly | jelly.js | The bell is one zero-thickness lathe surface. It has no lens thickening at the apex, no 8 marginal notches (rhopalia) and no scalloped margin. Marginal tentacles are 1 px `LineSegments`. The oral arms are flat ribbons that are only waved. The additive Fresnel shading is good and already hides most of this. |
| Anemone | `anemone()` in reef.js | The column is a 24-sided cylinder. Tentacles are capsules, so they have no bulb, no constriction band and no tip. A real *Entacmaea* tentacle swells to a bulb with a pale ring and a darker nipple. The oral disc and mouth are missing, and the pedal disc doesn't grip the rock. |
| Shared material | `skin()` | `MeshStandardMaterial` with no translucency. Thin tissue (arm tips, fins, web) is lit like rubber. |

## 2. Techniques evaluated

### 2.1 Metaballs / implicit surfaces with three's `MarchingCubes`
`three/addons/objects/MarchingCubes.js` was written for blobs remeshed every frame. Its field is a fixed
-1..1 cube that you fill with `addBall` or by writing `field[]` directly. It outputs an **unindexed
triangle soup** into a preallocated buffer, with field-gradient normals and no usable UVs.

Measured in node 20 (prototype: `proto_sdf.mjs` in my scratchpad), on the octopus body SDF described in 2.2:

| Mesher | Grid | Build ms | Verts | Tris |
|---|---|---|---|---|
| three MarchingCubes | 48^3 | 182-195 | 21 360 | 7 120 |
| three MarchingCubes | 64^3 | 416-481 | 38 448 | 12 816 |
| three MarchingCubes | 96^3 | 1 585 | 87 228 | 29 076 |

**Verdict:** per-frame metaballs are out. A 64^3 field takes about 0.4 s on the CPU, and the time goes into
evaluating the field, not into the marching. The addon is also a poor fit even for a one-off build: it uses
3x the vertices (unindexed), the cube is fixed, and the buffer is capped. We don't use it.

### 2.2 SDF with smooth-min, meshed once (recommended for joins)
Write each body as a signed distance function: ellipsoids, round cones and capsules, joined with the
polynomial smooth-min `smin(a,b,k)`. `k` is the fillet radius, so the sac blends into the head and the arm
roots into the oral disc with real fillets. Low-amplitude noise is added for wrinkles. The result is
meshed **once at load** by a small surface-nets mesher (indexed, quad-dominant, smoother than MC), with
normals taken from the SDF gradient.

Measured on the same body: sac, head, oral disc, 2 turrets and 8 two-segment arm roots (17 primitives plus
value-noise wrinkles). The narrow band samples a 4x coarser grid first and evaluates finely only near the
surface.

| Cell (M units) | Grid | Full ms | Narrow-band ms | Verts | Tris |
|---|---|---|---|---|---|
| 0.04 | 49x26x39 | 136 | 119 | 3 864 | 7 728 |
| 0.03 | 65x35x51 | 283 | 208 | 6 925 | 13 848 |
| 0.02 | 96x51x76 | 684 | 409 | 15 745 | 31 488 |

For comparison, today's octopus body (6 spheres) is about 5k triangles. A cell of 0.035 M gives about 10k.
The geometry is built for M = 1, cached by key and scaled by the mesh, so it's built once per species
rather than per animal. Further savings, if needed:
- prune primitives per coarse brick (this is a 17-primitive SDF, so it's cheap to do);
- run the build in a Worker;
- precompute it in a tools script and ship a small `.bin`.

At about 0.15–0.3 s once at load it's acceptable as is.

Consequences to plan for:
- **No UVs.** Use triplanar mapping of the existing canvas skins in the `skin()` hook (3 texture taps),
  or bake colour into vertex colours from the same noise. Triplanar is what makes wrinkles line up across
  the join.
- **Breathing / squeeze.** You can't scale the sac on its own once it's merged. At build time, store a
  per-vertex weight attribute (`aSac`, the sac primitive's share of the smooth-min) and scale it in the
  vertex shader with a `uBreath` uniform. The same works for the cuttlefish jet squeeze (`aMantle`).
- **Code that names parts.** `_untangle` reads `this.sac` and the `turret*`/`eye*` children as sphere
  obstacles (`geometry.parameters.radius`). Keep invisible `Object3D` proxies with those names, scales
  and a `userData.radius` so the collision code stays unchanged. `joins` in critterCheck.js shrinks to
  `body`, `eye*`, `arm*` and `web`.

### 2.3 Raymarching SDFs in a shader
This gives perfect blends with no mesh, but it costs fill rate for every pixel covered. It can't use
`MeshStandardMaterial` lighting, caustics or shadow maps without re-implementing them, and it needs a
custom depth write. **Rejected.** Mesh the SDF instead, which gets the same shapes at mesh cost.

### 2.4 Better tubes (recommended for anything that moves)
Arms that are rebuilt every frame should stay parametric tubes along the existing point chains. That
keeps all of the existing towing, draping, `_untangle` and web code. The improvements are per-ring and
almost free (8 arms x 40 rings x 16 sides = 5k verts/frame, against 1.8k today):
- **Cross-section profile.** Replace the circle with a superellipse (`|cos|^p`) and flatten the oral side
  (sucker side broad and flat, aboral side domed). Today's frame (`Nn` toward the ground, `Bn` across)
  is already oriented, so this is a per-vertex radius function `r(s, theta)`.
- **Curvature-aware taper.** Use a radius curve rather than a lerp: quick thinning near the root, long
  and slender to a rounded tip (`r = r1 + (r0 - r1) * (1 - s)^1.6`, tip closed by a hemispherical cap
  ring instead of the `*0.3` pinch). Thicken on the inside of a bend and thin on the outside
  (`r *= 1 - 0.15 * kappa * dot(o, curvatureDir)`) so coils look muscular.
- **Analytic normals.** Compute normals from the profile and taper (or call `computeVertexNormals` on
  the tube, which costs about 0.1 ms) so the taper shades.
- **Suckers.** Use one `InstancedMesh` of a small cupped lathe (rim plus dimple, about 40 tris), with
  2 staggered rows per arm, shrinking to the tip: 8 x ~36 = ~290 instances. Each sucker's matrix comes
  from the ring frame of its arm (`pts`, `Nn`, `Bn`) when `build()` runs, which costs about 0.05 ms per
  frame. The cheaper alternative is a sucker normal-map tile in the arm UV strip, but it reads flat in
  silhouette, and the instanced cups are what sell it at close range.
- **Skin detail.** Use papillae and wrinkle normal maps generated on canvas (like `octoBump`). The cuttlefish
  and octopus already take a bump map, so this is texture work, not geometry.
- **Skinning along a spine** is an alternative for arms whose shape is fixed (the cuttlefish bundle, nautilus
  tentacles): build the tube once and bend it in the vertex shader from a few uniforms (curl, phase), as
  the fish swim shader does. No CPU rebuild.

### 2.5 Subdivision (Catmull-Clark / Loop)
three 0.170 ships no subdivision modifier (`modifiers/` has only Tessellate, Simplify, EdgeSplit and Curve);
Loop subdivision would mean the `three-subdivide` npm package. Our surfaces are parametric (lathe, tube)
or SDF, so we raise their resolution directly. Subdivision would only smooth the existing primitive
seams, and the SDF join fixes those properly. **Not needed.**

### 2.6 Vertex displacement + procedural normals
This is the right tool for fine detail on top of any of the above: wrinkles, papillae that rise when the
octopus is cryptic (a `uPapillae` uniform for the den mode), and fin-edge ruffles. Displace along the normal
in `onBeforeCompile` (`begin_vertex`) and perturb `normal` with an analytic derivative or a canvas normal
map. The cost is a few ALU per vertex. It bakes, because it is driven by uniforms.

### 2.7 Translucency ("subsurface look")
Add a cheap term in the `skin()` hook: wrap diffuse (`(NdotL + w)/(1 + w)`), plus a back-light
transmission lobe `pow(saturate(dot(V, -L)), 4) * thickness * tint`. `thickness` comes from a vertex
attribute (1 on the body, falling to 0.2 at arm tips, fin edges and web). Skip `MeshPhysicalMaterial`
transmission: it adds an extra scene render pass. This is one shared change that improves every soft
part.

### 2.8 Generated assets (Tripo) versus procedural
Tripo is good for rigid shapes (rock, coral, possibly a nautilus *shell*), but each credit costs money and
needs the user's approval. Its meshes come unrigged, with baked lighting in the textures and messy topology,
so they are useless for anything that bends every frame. A logarithmic-spiral shell is about 60 lines
procedurally and exact, so **procedural is recommended everywhere**. Tripo stays an optional upgrade for a
nautilus shell close-up, on approval.

## 3. Roku bake compatibility (applies to all items)

- `bake.js` bakes only `SPECIES` (fish) plus the reef backdrop/foreground. Critters and jellies are **not
  baked yet** (docs/roku_bake.md, "Cuttlefish, octopus and turtle" and "Jelly tank"). Nothing here breaks
  the current bake.
- The **anemone is in the reef backdrop**, so a better anemone just needs a rebake of the scenery.
- For the future critter sprite sets, keep every animation driven by **uniforms or explicit pose state**
  (uTime, uBreath, curl and phase), with no hidden per-frame randomness. The offscreen renderer can then
  step frames deterministically. Meshed SDFs, instanced suckers and tubes are ordinary meshes, and they
  render offscreen like any other.
- Avoid techniques that need screen-space history (temporal dithering for translucency) or extra render
  passes (physical transmission). The bake renders single frames at 2x supersampling.

## 4. Plan by part (ranked by visible gain per effort)

Shared new modules, written once:
- `pc/src/sdf.js`: smin, ellipsoid, round cone, capsule, narrow-band surface nets, gradient normals,
  per-primitive weight attributes, cache by key. About 200 lines.
- An addition to `skin()`: the triplanar option and the wrap/transmission term with a `thickness` attribute.

| Rank | Part | Technique | Build | Triangles | Per frame | Animation / bake | Effort |
|---|---|---|---|---|---|---|---|
| 1 | **Octopus arms** | Upgraded `ArmTube`: flattened oral-side superellipse, curve taper with a rounded tip cap, bend bulge, analytic normals; instanced cupped suckers (2 staggered rows); papillae bump. | none | 8x40x16x2 = 10k (now 3.4k) + suckers ~12k | +~0.3 ms CPU (rings + sucker matrices) | Same point chains, `_untangle` and web, so behaviour is unchanged. Bake: ordinary meshes. | S-M (1 day) |
| 2 | **Anemone tentacles + column** | Replace the capsule with a lathe tentacle profile: stem, constriction ring, bulb, darker nipple tip, vertex-colour bands (pale ring at the constriction). Per-instance length, bulb size and lean, keeping `addSway`. Column becomes a lathe with a flared, wrinkled oral disc, a mouth slit and a pedal-disc lip, noise-displaced once. | <5 ms | 320 x ~200 = 64k (now 320 x 272 = 87k: the capsule is over-tessellated round its caps, while a lathe puts the rings where the profile curves) | 0 (shader sway as now) | Static plus shader sway. Rebake the scenery backdrop. | S (half a day) |
| 3 | **Octopus body + arm-root join** | SDF body: sac, head, disc, turrets, siphon root and the first 2 arm segments as round cones, smooth-min k 0.06-0.12, wrinkle noise. Surface nets at cell 0.035 M, triplanar skin, an `aSac` weight for breathing. Arms (rank 1) start inside the buried roots, so the joins are filleted. | ~150-250 ms once per species (cache) | ~10k | 0 | Proxies keep `_untangle` obstacles. Squash stays `model.scale`. Bake: one mesh. | M (2 days) |
| 4 | **Shared translucency** | Wrap plus back-light transmission in `skin()`, with a `thickness` attribute on tubes, fins and web. | none | 0 | a few ALU/pixel | Uniform-free, so it bakes. | S |
| 5 | **Cuttlefish fins + mantle + arms** | Fin skirt as a thick strip (6-8 rows across, a lens-shaped section tapering to a thin translucent edge) whose root row lies *inside* the mantle surface, with the wave still on the CPU (or moved to the vertex shader: phase(t) is already analytic). Mantle, head, eye bulges and arm crown as one SDF mesh (`aMantle` weight for the jet squeeze). Arms built once as profiled tubes bent in the vertex shader (curl and strike uniforms) instead of rebuilt by `_arm`. | ~150 ms once | ~9k body, 8x1.4k arms, 2x1k fins | lower than now (no CPU arm rebuild) | Uniform-driven poses suit the planned Roku sprite set (swim loop, strike frame). | M (2 days) |
| 6 | **Moon jelly bell + oral arms** | Shader only. A second inner (subumbrella) lathe offset inward, thick at the apex and thin at the margin, so the Fresnel rim doubles like a real lens. 8 rhopalial notches and 16 scallops on the margin (a radius modulation by `uv.x`). Oral arms with the edge rolled into a tube (curl the ribbon's outer 30% about its long axis) and frilled at a higher frequency. Marginal tentacles as thin camera-facing ribbons (or keep lines). | none | +2k | 0 (vertex shader) | Uniform-driven pulse: a few baked frames are fine. | S-M |
| 7 | **Nautilus (new critter)** | See section 5. | <20 ms | ~30k | ~0.1 ms | Rigid shell plus shader tentacles: the easiest critter to bake for Roku. | M-L (3 days incl. behaviour) |

Do first: **1 (octopus arms), 2 (anemone), 3 (octopus SDF body)**. Item 4 is cheap and can ride along
with 1.

## 5. Nautilus (optional new critter)

*Nautilus pompilius*: a 15–20 cm shell. It lives on deep reef slopes (100–500 m) and rises towards shallower
water at night. Public aquariums show it in dim tanks, hovering and jetting slowly backwards, with the
tentacles fanned forward.

- **Shell.** A logarithmic spiral, `r(theta) = a * e^(b*theta)` with whorl expansion W of about 3 per turn
  (`b = ln(3)/(2*pi)`). The cross-section is a slightly compressed ellipse swept along it, each section
  scaled by `r(theta)`. The inner whorls are hidden by the outer, which is what makes the involute
  nautilus look. Build it as one sweep (about 240 sections x 32 = 15k tris). Tiger stripes come from the
  fragment shader in (theta, across) coordinates: wavy, orange-brown, fading toward the aperture, with a
  white belly and nacre at the aperture lip (low roughness plus env map). An optional Tripo shell needs
  approval.
- **Hood and head.** A small SDF mesh (hood, eye stalks with the pinhole eye, and the funnel), meshed
  once (~3k tris, <20 ms at this size).
- **Tentacles (~90).** One `InstancedMesh` of a single tapered, ringed tube (8 sides x 12 rings plus a
  rounded tip, ~200 tris, so 90 instances are ~18k tris, one draw call). Per-instance attributes are
  `aBase` (position and direction on the cephalic ring, set by the instance matrix), `aLen`, `aPhase` and
  `aCurl`. The vertex shader bends each tube with uniforms: `uFan` (spread forward to curled in), `uTime`
  for a slow wave, and `uTrail` for drag in a jet (as jelly.js does). The ridged rings come from a cheap
  `sin(s*60)` radius modulation. CPU cost is zero beyond uniforms.
- **Behaviour.** Neutral buoyancy, hovering. It jets slowly backwards (shell first) with a gentle pitch
  rock on each funnel pulse, rises at night (`world.light` low) and sinks to the back wall by day. Its
  tentacles reach toward food on the sand.
- **Roku.** A rigid shell with uniform-driven tentacles. A few headings x 6-8 frames of the tentacle and
  pitch loop make a simple sprite set, simpler than the octopus.

**Recommendation:** add it, but after items 1-3. It is cheap to render and easy to bake. Most of the
technique it needs (instanced shader-bent tubes, a small SDF hood) is the same infrastructure, so it
works as a showcase for the organic modelling. It's ecologically a stretch for a shallow reef tank, but
many public aquariums do show it.

## 6. Prototype

`proto_sdf.mjs` and `proto_sdf_band.mjs`, in the research agent's scratchpad, are not in the repo. They
build the octopus body SDF (17 primitives plus noise) and mesh it with surface nets and with three's
MarchingCubes. The timings above come from node 20 on this machine, first run (including JIT warm-up), so
expect similar or better in Chrome.
