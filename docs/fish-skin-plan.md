# Fish Skin Plan

Goal: fish skin that reads as living tissue rather than a rendered surface, at tank framing (fish 100-300 px long) and in the lab close-up. Line references are to `pc/src/fishModel.js` as of 2026-11-05 unless stated otherwise. three.js is 0.170.

## 1. What the skin is today

Everything is generated per species at load, on 2D canvases, in `paintSkin` (`:110-398`) and cached in `speciesAssets` (`:1464-1494`).

| Map | How it is made | Size | Colour space | Bound to |
|---|---|---|---|---|
| Albedo | Pattern ops (`vgrad`, `band`, `spots`, ...) painted in (u, v) body space (`:123-226`). A separate melanin multiply layer holds the countershading, 70 soft mottling blobs and the scale-margin pockets (`:234-255`, `:376-378`). Gill margin, nostrils, mouth, scalpel and orbit are painted strokes (`:257-324`). | 2048x1024 (scale pockets computed at 1024x512, then upscaled) | sRGB (correct) | `map` |
| Normal | Height field of imbricated scales on one staggered lattice (`:326-364`) plus nostril pits (`:365-375`), central differences into a tangent-space normal map (`:381-396`). | 1024x512 | linear (correct) | `normalMap`, `normalScale` (1, 1) |
| Iridescence mask | Per-pixel strength of the guanine layer: stronger on the belly and towards each scale's free margin (`:360-362`). Greyscale in RGBA. | 1024x512 | linear (correct) | `iridescenceMap` (reads R) |
| Fin sheet | Fill, paint, spots, membrane alpha thinning to the margin, rays as dashed strokes with a white "lit edge" stroke beside each (`:491-600`). | 2048 x ~1300 | sRGB | `map` (alpha) |
| Pectoral, eye | Canvas paintings. | 512x512 each | sRGB | `map` |

Material (`:1623-1630`): `MeshPhysicalMaterial`, `roughness 0.36` (0.3 scaleless), `metalness 0`, `ior 1.04` (in-water Fresnel), `anisotropy 0.45`, `iridescence 0.35` (1.0 when `sp.iridescent`), `iridescenceIOR 1.8`, `iridescenceThicknessRange [180, 420]`. No clearcoat or sheen (deliberately removed, see `docs/photoreal-fish-plan.md` item 3). Light transport through tissue (Beer-Lambert, wrap) is custom (`TISSUE_GLSL`, `:1130-1161`). Caustics reach the fish (`addCaustics`, `:1259`). Fins: `roughness 0.45`, map only. Eye: `roughness 0.1`, `ior 1.04`, map only.

No geometry `tangent` attribute: three builds the tangent frame from screen-space derivatives (`getTangentFrame` in `normal_fragment_begin`), so the tangent follows texture u (nose to tail) and the mirrored far flank is handled. That part is fine.

### 1.1 Findings (bugs and surprises)

1. **The iridescence thickness range is dead config.** Without `iridescenceThicknessMap`, three r170 uses `iridescenceThicknessMaximum` everywhere (`lights_physical_fragment.glsl.js:101`). Every fish wears one 420 nm film of n 1.8. Its optical path (1512 nm) peaks near 504 nm and 756 nm, which is the uniform pastel pink-green sheen seen on the chromis in the lab. Real guanine stacks vary in spacing from scale to scale and within a scale, which averages to silver, or sits in a narrow band for structural blues and greens.
2. **With `ior 1.04` the skin has almost no surface specular** (F0 ~ 0.0004). That is physically right for a submerged fish, but it means `roughness`, `anisotropy` and the normal map only shape two things: the diffuse shading (weakly) and the iridescence lobe. The normal map's scales therefore read as a faint, perfectly regular dot texture (a knitted or chain-mail look) instead of scales. On real fish the scales show mostly through (a) a mosaic of reflector glints, each scale flashing at its own angle, (b) pigment that follows the scale margins and (c) the dark cavity under each free margin. All three are missing or uniform.
3. **Minute-scaled species have no skin texture at all.** The scale field fades to zero where a scale is under ~1.5 texels (`fade`, `:333-338`). With `scales: 150` (yellow tang, blue tang, Moorish idol) the scale is ~5 texels long but under 1 texel tall on a deep body, so the fade is 0 and the body is a smooth plastic shell (confirmed in the lab). Real tangs look velvety, from minute ctenoid scales.
4. **The lattice is perfectly regular and uniform in size.** One scale size `s` for the whole body, a fixed row height in physical units (`Y = v * halfCol`, `:342`), no jitter, no scales ahead of the gill (`mask`, `:343`). Real fish keep a roughly constant number of scale rows from back to belly, so scales get smaller where the body is shallow (peduncle, nape, belly) and on the cheek and gill cover; rows curve with the body.
5. **Lighting is painted into albedo.** The gill cover's "lit lip" (`:270`), the nostrils' lit lower rim (`:297-298`) and every fin ray's white "lit edge" stroke (`:577`, `:586`) are highlights baked into colour. They stay lit when the fish turns away from the light or swims under a ledge, which is a classic "rendered" tell. These belong in normal maps.
6. **Texture v follows `-cos(theta)`, not arc length** (`bodyGeometry`, `:1337`, `:1346`). Near the dorsal and ventral midlines one texel row spans much more surface, so scales computed in v space stretch across the back and belly. Minor at tank framing; visible in top-down views.
7. **Albedo band edges are vector-crisp.** Pattern ops are filled paths; on real fish (see `pc/ref/clownfish/krisp_side.jpg`) the white bands' borders step along scale rows and the black margins are slightly ragged.
8. **The eye cannot show a catchlight.** `ior 1.04` and no clearcoat: correct for the cornea, but the spherical lens (n ~1.67 at the core) bulges through the pupil and reflects ~1.2% against water, about 30 times the skin. Every reference photo has that catchlight; the model has none.
9. **Texture anisotropic filtering is fixed at 4** (`tex`, `:1474`). The flank is often seen at grazing angles; 16 is free on desktop GPUs.
10. **Memory is already high.** Per species: albedo 8.4 MB + normal 2.1 + iridescence 2.1 (greyscale stored as RGBA) + fin sheet ~10.6 + pectoral 1 + eye 1, about 25 MB, ~34 MB with mipmaps. For 15 species that is ~500 MB of VRAM. Any new map must be packed.

## 2. What sells real fish skin under water (and what does not)

- **Reflector glints, per scale.** Iridophores (guanine platelet stacks) under each scale act as small tilted mirrors. Each scale's platelets sit at a slightly different angle, so a swimming fish sparkles in a scale-by-scale mosaic that changes as the body bends. Silvery and white regions use chirped stacks (broadband, near neutral); blues and greens (chromis, blue tang) use regular stacks (narrow band, blue-shifting with angle).
- **Pigment follows scales.** Melanophores concentrate along scale margins (dark crescents, already partly modelled as pockets) and chromatophore cells appear as fine speckle at close range; pattern boundaries are quantised to scales.
- **Cavity and occlusion.** The free margin overlaps the next scale and casts a thin shadow line; environment reflection is occluded there.
- **Scale size and shape vary.** Cycloid (smooth round: chromis-like look, wrasses) vs ctenoid (spiny rear margin: rougher, "velvet" at small sizes: tangs, angels, butterflies). Size scales with local body depth; head scales are small; snout, lips and fin rays are scaleless.
- **Mucus is nearly invisible under water.** It is index-matched to water (n ~1.37 vs 1.33). A clearcoat "wet" layer is an in-air look and makes the fish milky; do not add one. The previous plan removed it for that reason, correctly.
- **Fins are pleated.** Membrane bows between rays; rays are raised, jointed and thicker than the membrane, so they block more backlight (darker ray lines when backlit, brighter ray edges when lit from the front).
- **Eye.** Dark, deep pupil with a sharp catchlight from the lens; the iris has fine radial structure and often a reflective (iridophore) ring.
- **Lighting under water.** Caustics crawl over the body (already done), a bright overhead key with Snell's window in the environment (already in `makeEnvironment`, `water.js:382`), rim/backlight through thin tissue (already done). The remaining skin work is in the maps.

## 3. Prioritised plan

Ranked by realism gained per effort. Effort assumes the person knows this codebase.

### P1. Per-scale reflector mosaic (highest impact, ~1 day)

Rewrite the scale loop (`:326-364`) so each texel knows which scale it is on (`ri`, `rj` of the winning cell), then hash that id for per-scale variation.

1. Per-scale **tilt**: add a planar slope `tx * ddx + ty * ddy` to the height of the exposed field, with `tx, ty` ~ N(0, 0.10) (about +-6 degrees). This is what breaks the glint into a mosaic.
2. Per-scale **reflector strength** (`0.5-1.2x`) into the iridescence mask, and a new **iridescence thickness** channel: per-scale random thickness plus a small within-scale gradient. Species set the range:
   - silvery / white areas: wide range (e.g. 250-650 nm), so neighbouring scales differ in hue and the average is neutral;
   - structural colour (`sp.iridescent`: chromis, blue tang): narrow range around the species' hue (chromis ~ 320-360 nm at n 1.8 for green-blue);
   - others: wide range at low strength.
3. Bind it: `iridescenceThicknessMap` (reads **G**), keep `iridescenceThicknessRange` per species (`sp.irid = { range, strength }` in `species.js`, defaulting to the current numbers).
4. Pack it with the existing mask into one RGBA texture: R = iridescence strength (`iridescenceMap` reads R), G = thickness (`iridescenceThicknessMap` reads G). Assign the same `Texture` to both properties: one upload, one sampler.

Expected result: the fish flashes scale by scale as it turns and swims, and the uniform pastel sheen disappears. Biggest single change for chromis, clownfish, wrasse, gramma, angels.

### P2. Natural scale lattice (high impact, ~0.5-1 day, same loop as P1)

1. **Constant row count** instead of constant scale size: rows in v (`NR` rows back to belly, from `sp.body.rows`, ~ 2x the scales above the lateral line, default 24), and along the body a cumulative coordinate `X(u) = integral of du / s(u)` with `s(u) proportional to half(u)^0.6`, tabulated per column. Scales shrink towards the peduncle and nape as on the real fish, and the moire fade (`fade`) works per column on the real size.
2. **Jitter** each cell centre by +-12% and radius by +-10% (hash of `ri, rj`).
3. **Head scales**: allow scales ahead of the gill for species that have them (`sp.body.headScales: 0..1` size factor; cheek and opercle only, masked off the snout, lips, orbit and jaw), at ~50% size.
4. **Arc-length v**: compute the lattice in arc length rather than texture v by tabulating, per column, arc length against `-cos(theta)` from `prof.half` and `prof.width` (fixes finding 6 without touching the UVs, which other code uses).
5. **Ctenoid vs cycloid**: `sp.body.scaleType: 'ctenoid' | 'cycloid'`. Ctenoid adds a fine comb of spinules on the exposed margin (high-frequency height noise in the last 20% of the radius) and raises roughness there.

### P3. Fine detail for small scales and close-ups (high for 4 species, ~0.5 day)

The unique 1024x512 map cannot carry minute scales or close-up micro-relief. Add a **tiling detail normal map**, generated once at load (shared, 256x256 RGBA, three variants: cycloid micro, ctenoid velvet, smooth mucus with fine wrinkles), sampled at `vNormalMapUv * uDetailRep` and blended with the main normal (UDN or reoriented normal blend) in an `onBeforeCompile` replacement of `#include <normal_fragment_maps>` (the material already patches its shaders, `makeSwimMaterial`, `:1165`). `uDetailRep` comes from the species' scale count, so for tangs one detail tile cell is one real scale. Fade the detail with `fwidth(vNormalMapUv)` so it does not alias at tank distance.

- Tangs and the idol: ctenoid velvet tile at full strength, `roughness ~0.5`, plus optional `sheen 0.15`, `sheenRoughness 0.6`, `sheenColor` = 0.6 x body colour (the velvet retro-reflection of spinules; keep it low, sheen made fish milky before).
- Moray: mucus wrinkle tile, roughness 0.3.
- Everyone: the detail fades in only in close-ups, so it costs nothing at tank framing.

Memory: 3 x 256 KB. Shader cost: one extra texture fetch.

### P4. Scale-aligned pigment and no painted lighting (high impact, ~1 day)

1. **Colour per scale**: read the painted pattern (`g.getImageData` once after the pattern ops, before the shade multiply) and, inside the scale loop, mix each texel's colour towards the colour at its scale's centre by `0.5 * mask` on the exposed field. Band edges then step along the scale outlines (finding 7). Write the result back into the albedo at full 2048 resolution (sample the lattice at 2x, or upscale the cell-id map with nearest filtering).
2. **Per-scale brightness**: +-4% value and +-2% hue jitter per scale (hash), stronger in dark areas.
3. **Chromatophore speckle**: fine dark dots (1-2 texels at 2048, density per species) in the melanin layer; strongest on the back.
4. **Remove painted highlights**: gill lip (`:270`), nostril rims (`:297-298`), fin-ray lit strokes (`:577`, `:586`). Put the gill margin step and the nostril rims into the height field (the nostril pits already are) and the rays into a fin normal map (P5). Keep the dark lines (shadow and pigment), drop the white ones.
5. **Lateral line** (`:273-277`): replace the dark rectangles with pored scales: a small pit per scale in the height field along the line and a slightly paler tube on that row.

### P5. Fin relief, thickness and roughness (high impact on silhouettes, ~1-1.5 days)

Fins are a large share of the visible fish and currently flat albedo.

1. In `paintFins`, alongside the colour canvas, draw a **height canvas** from the same `rays()` field: each ray a raised half-cylinder (width as the stroke today), soft-ray joints as tiny notches every 0.035 TL, branches included; the membrane bows between rays (a cosine across the gap, ~30% of ray height, more towards the margin). Convert to a normal map at half the colour sheet's resolution (1024 x ~650).
2. **Thickness for transmission**: rays ~4x the membrane. Pack into the fin normal map's alpha? Not readable by three's built-ins, so put it in a small packed RGBA (R = thickness scale, G = roughness), and read R in `TISSUE_GLSL` for fins (`tissueThickMM` becomes `uThickMM * mix(1.0, 4.0, finData.r)`). Backlit fins then show dark rays on glowing membrane, as in photos.
3. **Roughness**: rays 0.35, membrane 0.5 (`roughnessMap` reads **G**: the same packed texture).
4. **Margin fringe** stays alpha-only (already done).

Do not use three's `transmission` for fins: it adds a full scene render per frame for transmissive objects, sorts badly with the existing alpha fins and does nothing the custom Beer-Lambert term does not already do.

### P6. Eye catchlight (medium-high, ~1 hour)

On `eyeMat` (`:1667-1669`): `clearcoat: 0.3`, `clearcoatRoughness: 0.04`. three's clearcoat F0 is fixed at 0.04, so 0.3 gives ~1.2%, the lens-to-water reflectance. Keep `ior 1.04` for the base. The highlight shows mostly over the dark pupil, where it should. Optional refinements: a `clearcoatMap` (reads R) masking the lens area, and an iris iridophore ring via `iridescence 0.3` with an `iridescenceMap` ring (shift with `uGaze` like `map`, `:1680-1683`, or leave static; it is tiny).

### P7. Cavity and roughness maps for the body (medium, ~0.5 day, after P1-P2)

From the same scale loop, a packed RGBA 1024x512:
- R = **cavity / AO**: 1 on the exposed field, down to ~0.6 in a thin line under each free margin and in the gill groove and nostril pits. Bind as `aoMap` (reads R, `aoMapIntensity 1`). In r170 `aoMap` also applies specular occlusion to the environment reflection when an env map is present, which matters for the iridescent lobe.
- G = **roughness**: exposed field 0.30, margin 0.45 (ctenoid 0.55), head and scaleless skin 0.28. Bind as `roughnessMap` (reads **G**) with `roughness: 1`.
- B, A spare (B could hold a `metalnessMap` reflector for a future silvery species: metalness reads B).

Assign the one texture to both `aoMap` and `roughnessMap`. `aoMap` uses `texture.channel` 0 (the body uv) by default since r151, so no second uv set is needed.

Because surface F0 is tiny, roughness mainly reshapes the reflector glints; the cavity line gives the visible scale outline under diffuse light, which the normal map alone cannot.

### P8. Small fixes (low effort, do with P1)

- `t.anisotropy = renderer.capabilities.getMaxAnisotropy()` (pass the value into `speciesAssets` or set it after build in `fish.js`/`lab.js`/`bake.js`).
- Raise `normalScale` per species only after P1/P7 land; tune in the lab, not now.
- `anisotropyRotation` stays 0 (tangent = body axis). An `anisotropyMap` (RG direction, B strength) along scale rows is possible but not worth it while specular is iridescence-only.

### Not recommended

- **Clearcoat on the body** ("wet mucus"): in-air look, desaturates; the prior plan removed it with good reason.
- **`transmission` / `thickness` / `attenuationColor`** on body or fins: expensive transmission pass, and the custom tissue term already covers backlight.
- **Photo-sourced skin textures**: carry baked lighting and noise; the procedural route is the chosen strategy (`docs/photoreal-fish-plan.md` section 2). Photos remain the colour target.
- **Per-fragment analytic scales in the main shader**: infinite resolution, but a 15-cell lattice search per fragment for 32 fish, extra cost in the Roku bake's supersampled renders and harder to debug. P3's tiling detail gives the close-up benefit at one fetch.

## 4. Generation: CPU canvas now, GPU pass if load time grows

The scale loop today is ~7.8 M lattice tests per species on the main thread. P1/P2/P4 roughly double the work per texel and P4 wants the albedo at 2048 width.

1. Start on the CPU in `paintSkin`, keeping the scale fields at 1024x512 (normal, packed data) and only the albedo mix at 2048. Measure load time in the lab (`performance.now()` around `speciesAssets`).
2. If 15 species take more than ~2 s, move the lattice into a UV-space GLSL pass rendered once per species at load (`WebGLRenderTarget` with `count: 3` for normal / irid / cavity-roughness, `generateMipmaps: true`, `minFilter: LinearMipmapLinearFilter`). That needs a renderer in `fishModel.js`: add `setSkinRenderer(renderer)` called by `main.js`, `lab.js` and `bake.js`, with the CPU path as fallback. The same GLSL then also generates the P3 detail tiles. Headless checks run in software GL; a few 1024x512 passes per species are cheap even there.
3. Keep everything deterministic (`mulberry32` seeded by species id, integer hashes of `ri, rj`), so the Roku bake is reproducible.

## 5. Memory budget (15 species, ~32 fish; textures are per species, shared by individuals)

| Texture | Today | After | Notes |
|---|---|---|---|
| Body albedo 2048x1024 | 8.4 MB | 8.4 MB | unchanged |
| Body normal 1024x512 | 2.1 MB | 2.1 MB | richer content, same size |
| Body irid (R) + thickness (G) | 2.1 MB | 2.1 MB | replaces today's greyscale irid |
| Body cavity (R) + roughness (G) | - | 2.1 MB | P7 |
| Fin colour 2048 x ~1300 | 10.6 MB | 10.6 MB | unchanged |
| Fin normal 1024 x ~650 | - | 2.7 MB | P5 |
| Fin thickness + roughness 512 x ~325 | - | 0.7 MB | P5 (low frequency) |
| Pectoral, eye | 2 MB | 2.3 MB | pectoral normal 256x256 optional |
| **Per species** | ~25 MB | ~31 MB | x1.33 with mipmaps |
| **All 15** | ~500 MB | ~620 MB | |
| Shared detail tiles | - | 0.8 MB | P3 |

If the extra ~120 MB is a problem: the fin colour sheet is the obvious saving (its height is mostly empty above and below the fins; a tight atlas of the dorsal, anal and caudal halves would cut it by ~40%), or drop albedo to 2048x512 for species with `scales >= 100` (their pattern is smooth).

## 6. Roku bake (`pc/src/bake.js`)

- Sprites are rendered from the same `buildFishModel` (`bake.js:134`) with an orthographic camera at `PX_PER_UNIT = 120 * zoom` and 2x supersampling (`SS`, `bake.js:29`), so every material change carries over with no bake code change.
- A clownfish is ~75-150 px long in a cell; its scales are 2-3 px. The supersample averages the normal detail; what survives is the glint mosaic and the stepped pigment, which is the part that matters. Detail tiles (P3) fade out by `fwidth`, so they cost nothing there.
- The glint mosaic changes between swim frames (the body bends), which is right: real fish shimmer as they swim. Check the 8-frame loop for flicker of single bright pixels; if it shows, clamp the per-scale tilt for the bake (`fishRender.bake = true` read in `speciesAssets`) rather than blurring.
- PNG sheets will compress a little worse with more high-frequency detail; check the sizes under `roku/assets/fish/` against the previous bake (decoded memory is unchanged).

## 7. Verification

1. **Lab close-ups, fixed views** (`http://localhost:8080/pc/lab.html?sp=<id>&swim=0&yaw=0.3` and `&pitch=15`; `lab.setLightDir` for a grazing key). Screenshot before and after for clownfish, chromis, yellow tang, blue tang, emperor angel and moray, with the lab's `reference` toggle beside the photos in `pc/ref/<id>/`. Look for: glints broken into scales (not a sheet), stepped band edges, tangs no longer plastic, no white strokes on the shadow side, a catchlight in each eye.
2. **Tank framing**: `node tools/check.mjs look --close=station,cleanerwrasse` (out/look-*.png). The close-ups are crops of the 1080p frame, so this is the realistic viewing size; compare the `stats` (mean luminance and saturation) before and after: P1 should not move mean saturation by more than a few percent (if it drops, the reflector strength is too high and is greying the colour).
3. **Simple objective check** (optional script in the lab): in a body mask, the standard deviation of a band-pass (scale-sized) luminance filter, compared with the same measure on the reference photo of that species at matched scale. Today it is low and spatially uniform; target is within ~2x of the photo.
4. **Performance**: tank frame time with all fish before and after (P3 adds one fetch, P7 two built-in samplers); load time of `speciesAssets` per species (section 4).
5. **Bake**: one species, `bake.html`, compare sprite cells for flicker and sheet size.

## 8. Order of work

1. P6 eye catchlight and P8 anisotropic filtering (hours; immediate visible gain).
2. P1 + P2 together (same loop; rewrite the scale lattice with cell ids, jitter, constant rows, tilt, thickness channel).
3. P4 scale-aligned pigment, painted highlights removed.
4. P7 cavity and roughness (falls out of the new loop).
5. P5 fins.
6. P3 detail tiles (tangs, moray, close-ups).
7. GPU generation only if load time requires it.
