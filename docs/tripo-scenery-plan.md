# Tripo scenery plan

**Status (2026-11-05): batches 1 and 2 generated and placed**, 15 jobs at 30 credits each (450 credits).
Results: `rock_i` came out saturated magenta (toned with a `grade`), `rock_j` grey with small raised
blobs (used); the first Montipora grew finger branches (kept as `coral_digitata`) and its retry gave
plates; `sponge_ear` grew tubes (kept as `sponge_tube_orange`); the brain coral now has meandering
ridges (the old one is `coral_brain_v1`, retired); the urchin has thin spines rather than slate pencils.
`rock_b`, `rock_c` and `rock_e` are retired from the rock pool. Section 5 layout fixes done the same day:
the 1.15x stretch cap (`STRETCH` in reef.js), a continuous back wall in two staggered rows (1.8-3.2
units tall), and the foreground pulled back half a unit (small props only at the front). Roku: the
backdrop needs a rebake.

Originally a plan only. Cost basis: the
README and `tools/tripo.mjs` say a model costs 10-40 credits (1 credit = $0.01). The jobs here use
`texture_quality: 'detailed'` and PBR, and `photoreal-behaviour-plan.md` budgets 4 rocks at about 120
credits, so this plan assumes **about 30 credits per job** (40 at worst).

## 1. Audit of the current scene

Sources: the live tank (`pc/index.html?reeflight=0`), every `pc/models/scenery/*.preview.webp`, and
`pc/src/reef.js`.

### What reads as fake or repetitive

1. **The rocks share one look.** All 8 Tripo rocks are bleached cream "dry rock" with a honeycomb pore
   texture. The prompt words "coralline algae crust" came out as **raised pink and purple flower or
   blob growths stuck on top** (rock_a, rock_b, rock_c, rock_d, rock_e), not a flat crust. In the tank
   they read as candy sprinkles. Real live rock that has been in a tank for a year is mostly dark: it
   is mottled purple, maroon and pink as a *flat paint-like crust*, with olive and brown turf and film
   algae, and small orange and red encrusting sponges. Rock fills about half the frame, so this is the
   biggest single fakeness cue.
2. **The rocks are stretched.** `normaliseScenery` scales rocks to a unit box per axis. `addRock` then
   stretches each one to its slot by 1.45 sideways and 1.3 upward, on top of the slot's own aspect.
   The pores turn into oval holes several cm across, about the size of a chromis. That breaks the scale
   cue: real live-rock pores are 0.5-2 cm. It also makes every rock read as the same sponge. (The
   behaviour plan already proposes at most 1.15x stretch, a triplanar overlay and hue jitter. Do those
   first. They are free.)
3. **Every silhouette is a mound.** Rock piles, cauliflower, finger dome, brain, leather and lettuce
   coral are all rounded humps of about the same height. Nothing is **horizontal**, like table or plate
   Acropora or Montipora plating. Above the staghorn nothing is **vertical**, like barrel and tube
   sponges, sea rods or whips. Real reefscapes are read from that mix of plates, columns and mounds.
4. **There are gaps in the back wall.** The back wall rocks (z -4.2 to -5.2, 1.2-2.6 units tall)
   leave gaps. Through them the bright sand runs to a hard horizon line against open blue (see the left
   of the frame behind the second pile). The upper half of the frame is empty blue. A reef tank's back
   is either dark (black backing) or rockwork with sponges and gorgonians that fades into murk.
5. **Two procedural domes look like plastic.** The blue finger dome (front centre, `d3`) and the
   yellow-green finger dome (`d4`) are instanced capsules with no Tripo swap. They read as bead toys
   and sit in the most visible place.
6. **The brain coral is the wrong shape.** The `coral_brain` preview is a spiky, pagoda-like boulder,
   not meandering ridges, so it reads more like a hedgehog. It sits big at the front.
7. **The staghorn sits on a rubble base.** `coral_staghorn` has a puck of multicoloured gravel at its
   base, like aquarium-shop decor. It is mostly hidden by placement (base sunk 0.15). The branches are
   fewer and fatter than real *A. cervicornis*, but it is acceptable.
8. **The colours are uniformly saturated.** Orange, violet, cobalt and lime sit at similar
   brightness, all at the same depth. Real reefs have many browns, olives, tans and greys, with a few
   saturated accents. New items should mostly be **earthy** (brown and olive SPS, ochre sponges, grey
   rubble), with one or two saturated accents (a Tridacna mantle, a yellow tube sponge).
9. **The foreground.** The front edge is crowded with large rounded items cut by the frame: brain,
   blue dome, starfish, lettuce coral, anemone. Real tank fronts are open sand with small low things
   (shells, a sea cucumber, rubble, a sand-sifting goby), which gives scale and depth.

### Reef elements we lack, and whether Tripo can make them

| Element | Have it? | Tripo-friendly? | Notes |
|---|---|---|---|
| Table/plate Acropora | no | **yes**: chunky flat plate on a stalk | strong horizontal; shelter underneath |
| Montipora plating/scrolls | no | **yes**: thick curled plates | covers bare rock faces |
| Barrel sponge (*Xestospongia*) | no | **yes**: very chunky | Caribbean signature, vertical |
| Tube sponges (*Aplysina*, *Callyspongia*) | no | **yes**: chunky cylinders | vertical accent |
| Encrusting / elephant-ear sponge | no | mostly | flat ear shapes |
| Tridacna giant clam | no | **yes**: shell and mantle | colour accent |
| Bubble coral (*Plerogyra*) | no | **yes**: grape bubbles | |
| Zoanthid/Palythoa mat | procedural cylinders | as "rock with polyp mat" | instanced is fine at distance |
| Mushroom / Ricordea | no | ok: flat discs | small, low value per credit |
| Goniopora | no | **no**: fine polyp fuzz | skip |
| Gorgonian sea fan | procedural alpha plane | **no**: net mesh | keep the plane |
| Sea rod / whip (thick) | no | ok if branches are few and thick | risky, needs sway |
| Feather dusters, Christmas tree worms | no | **no**: fine radioles, 2 cm | procedural instanced |
| Long-spine urchin (*Diadema*) | no | **no**: thin spines | use pencil urchin instead |
| Pencil urchin (*Eucidaris*) | no | **yes**: thick blunt spines | prop |
| Sea cucumber | no | **yes**: trivial blob | prop, scale cue |
| Shells, sand dollar | starfish, conch | **yes** | cheap scale cues |
| Dead coral rubble | procedural | n/a | procedural is fine |
| Coralline crust | as raised blobs (bad) | **no** as geometry | do in texture or shader |
| Kelp | none | n/a | correctly absent: kelp is temperate, not reef |

### What the fish would use

- **Clownfish** need a host. The only one is the procedural bubble-tip anemone (*Entacmaea*), with 320
  instanced capsule tentacles. That is fine, and better than Tripo would do. *A. ocellaris* also hosts
  in *Heteractis magnifica* and *Stichodactyla gigantea*. A second host is a nice-to-have, not a need.
  Keep the procedural one.
- **Royal gramma** hangs upside down under ledges, and **lionfish** sit under overhangs. A table
  Acropora gives a real overhang. It needs the plate kept out of the height field (see the code notes).
- **Emperor angel, moorish idol, coral beauty and turtle** graze sponges and algae. Barrel, tube and
  encrusting sponges give them a plausible target.
- **Copperband and longnose butterflies** pick worms from crevices. Feather dusters and Christmas tree
  worms on rock are their food (procedural).
- **Clown trigger** eats urchins and clams. A pencil urchin and a Tridacna are on-theme.
- **Cleaner wrasse** runs a station on a prominent rock or coral head. The brain coral or the barrel
  sponge rim is a good spot.
- **Moray and octopus** use the caves (already there).
- **Chromis** use the staghorn (already there). A table coral is a second plausible home.

## 2. Tripo: strengths and limits, from our previews

What it does well:

- **Chunky organic solids.** The porous rock bodies (rock_f rubble mound, rock_g bored boulder),
  `coral_finger` (Porites dome), `coral_cauliflower` (Pocillopora) and `coral_leather` (toadstool)
  are all convincing.
- **Plates with thickness.** `coral_fan` (Pectinia lettuce) came out well: thick ruffled plates.
- Albedo is believable when the prompt names concrete colours. `delight: true` works, so there is no
  baked sun.

What it does badly:

- **"Crust" and "encrusted with" become raised geometry.** Every rock that mentions coralline algae
  got 3D flowers or blobs. Treat coralline as a texture job: say "flat, paint-like, smooth crust
  flush with the surface, no raised growths", or leave it out and add it in our shader.
- **It adds a base.** The staghorn got a rubble puck despite `NEG` saying "base plate". Add "no rubble,
  no gravel, colony base broken off cleanly" for colonies.
- **It ignores texture-pattern words.** "Meandering grooves" (brain) became spikes. Name the species,
  describe it like a photograph ("smooth rounded ridges like a human brain"), and add a negative for
  the wrong reading ("spikes").
- **Thin, many-branch structures.** Fine tentacles, fan nets, long spines and feather radioles fail or
  turn into blobs. Branching is fine when branches are few and thick (staghorn, rock_h).
- **One watertight object.** It cannot make an "object attached to rock" as two materials cleanly. A
  plating coral will come out with or without a rock nub. Ask for "attached at its narrow edge to a
  small nub of rock" so it can be pushed into a rock face.
- **The shared STYLE** ("single isolated object resting on flat ground") is right for colonies and
  props. For wall-attached plates, the plate may lie flat. Our loader can rotate (`rotate` in
  scenery.json), so that is recoverable.
- Texture resolution suits 0.5-4 units on screen. Items smaller than about 0.5 units (2-6 cm) waste
  credits: they are mostly a few pixels and better instanced.

Prompt style to keep (from `JOBS`): one sentence, starting with common name, growth form and Latin
genus, then shape detail, then colours, base to tip. `STYLE` and `NEG` are appended automatically.
Extra negatives per job need a small `neg` field in `tripo.mjs` (a code change, see section 5). Until
then, fold "no X" into the prompt.

## 3. Prioritised items (visual gain per credit)

Sizes are in tank units (1 unit = 12.5 cm; the tank is about 16 units wide). "Solid" means in the
height field and RockField, so fish collide with it. "Sway" refers to the `sway`/`stiff` flags in
scenery.json.

### 1. `rock_i`: dark mature live rock (new rock texture)
- **Prompt:** `Large reef aquarium live rock boulder after years in a reef tank, dense irregular shape with a few deep holes and ledges, surface almost entirely covered in smooth flat paint-like coralline algae crust in mottled deep purple, maroon and dusky pink, flush with the rock with no raised growths, olive-brown turf algae in the hollows, a few small flat orange encrusting sponges`
- Kind: rock. Faces 30000. Used everywhere through `fitRock` (piles and back wall).
- Size: slot-fitted, 1.0-2.6 units.
- Sway: no. Solid: yes.
- Risk: it may still sprout blobs, or come out saturated violet everywhere.
- Fallback: the shader triplanar coralline overlay from the behaviour plan on existing rocks (free).

### 2. `rock_j`: algae-filmed weathered rock (second texture family)
- **Prompt:** `Reef live rock ledge, tall irregular slab with an undercut base, weathered dark grey and brown limestone with small pores, short olive-green and brown turf algae on the upper faces, scattered flat maroon coralline patches flush with the surface, a few white calcareous worm tubes, no raised growths`
- Kind: rock. Size: 1.2-2.6 units, back wall and pile tops.
- Sway: no. Solid: yes.
- Risk: it may read as a plain dry stone. Accept that: some plain rock is realistic.
- Fallback: per-copy hue and darkness jitter on existing rocks.

### 3. `coral_table`: table Acropora
- **Prompt:** `Table coral colony (Acropora hyacinthus), one broad flat horizontal plate of tightly fused fine branchlets on a short thick central stalk, plate thick at the edge, upper surface covered in tiny upright branchlet tips, soft brown and olive tissue with pale cream growing rim, colony base broken off cleanly, no rubble`
- Kind: coral. Faces 40000.
- Size: 4-5 units across, 1.5 units tall. Put it high on the central pile (x about 2.6, z -2.6) or on
  the left pile, so its plate overhangs.
- Sway: no.
- Solid: the plate yes, but **not in the height field**. Otherwise the ground under it becomes a
  column and no fish can get under it. It needs a "RockField-only" flag (section 5) and a shelter entry
  under it.
- Risk: the plate may come out as a dome, or the stalk too thin. A plate seen edge-on from the camera
  looks like a line, so tilt it 10-15 degrees toward the view.
- Fallback: a procedural lofted disc with instanced tips. A table is easy procedurally.

### 4. `sponge_barrel`: giant barrel sponge
- **Prompt:** `Giant barrel sponge (Xestospongia muta), tall thick-walled vase shape wider at the top with a deep central opening, outer wall covered in rough knobbly vertical ridges and furrows, dull brownish red to terracotta, paler inside the rim`
- Kind: coral, or a new `sponge` kind treated like coral. Faces 30000.
- Size: 2.5-3 units tall, 2 units wide. Put it back left (x about -6, z -3.5) to fill the back-wall gap
  and break the skyline, or one smaller (1.5 units) on the right pile.
- Sway: no. Solid: yes. A fish may enter the opening, so collision is by mesh voxels.
- Risk: it may close the opening. That is acceptable, because the opening is seen from above only.
- Fallback: a lathe-turned procedural vase with a ridged normal map.

### 5. `coral_montipora`: plating Montipora
- **Prompt:** `Plating Montipora coral (Montipora capricornis), several thick overlapping horizontal scrolling plates radiating like a whorl, attached at the narrow edge to a small nub of rock, plate surfaces finely pitted with tiny polyp pores, rich orange-red tissue with paler cream edges`
- Kind: coral. Faces 30000.
- Size: 1.5-2.5 units across. Push 2-3 copies into rock faces (front of the central and right piles,
  0.8-1.5 units up) at different yaw.
- Sway: no. Solid: yes, on rock, so no shelter is needed.
- Risk: it may lie flat on the ground as a dish (fix it with `rotate`), or fuse into one blob.
- Fallback: a green variant prompt, or a procedural curled disc.

### 6. `clam_tridacna`: giant clam
- **Prompt:** `Maxima giant clam (Tridacna maxima), oval fluted grey-white shell with wavy scalloped ridges, opened with the thick fleshy mantle spread over the shell lips, mantle electric blue and teal with dark green mottled spots and a pale siphon opening in the middle`
- Kind: prop. Faces 20000.
- Size: 1.4-1.8 units long. Put it on a low front rock or on the sand front right, mantle up toward the
  light and the camera.
- Sway: no. Solid: yes (small).
- Risk: the mantle colour may be flat, or the shell closed. It is cheap to retry.
- Fallback: none needed. Skip it if it fails.

### 7. `coral_brain`: regenerate
- **Prompt:** `Grooved brain coral (Diploria labyrinthiformis) round boulder, smooth rounded meandering ridges and valleys winding over the whole dome exactly like a human brain, no spikes, no points, ridges olive-tan, valleys pale cream-green`
- Kind: coral, the existing slot. Size: as now (about 1.6 units).
- Sway: no. Solid: yes.
- Risk: the spikes come back. Fallback: the procedural `brainCoral()` already gets the grooves right.
  Consider simply disabling the swap.

### 8. `sponge_tube`: tube sponge cluster
- **Prompt:** `Cluster of five yellow tube sponges (Aplysina fistularis), thick upright hollow tubes of different heights joined at the base, each open at the top, rough porous outer surface, bright sulphur yellow`
- Kind: coral or sponge. Size: 1.5-2.2 units tall, on the right pile top or the back wall.
- Sway: no. Solid: yes.
- Risk: the tubes fuse, or the openings close. Fallback: a purple variant (*Callyspongia*) or
  procedural cylinders.

### 9. `coral_bubble`: bubble coral
- **Prompt:** `Bubble coral (Plerogyra sinuosa) colony, rounded mound densely covered in plump grape-like translucent bubble vesicles, creamy white with a faint green tint, short ridged skeleton walls showing at the base`
- Kind: coral. Size: 1.2 units. It replaces the procedural yellow-green finger dome `d4`.
- Sway: optional (sway 0.4). Solid: yes.
- Risk: it may come out as a cauliflower. Fallback: keep `d4` with better colours.

### 10. `zoanthid_rock`: polyp-covered rubble
- **Prompt:** `Small reef rubble rock carpeted on top with a dense mat of zoanthid polyps (Zoanthus), hundreds of short fleshy tubes with flat open discs, discs bright orange centres with green rims, rock underside grey and porous`
- Kind: coral (a named slot). Size: 1.0-1.4 units. It replaces the procedural blue dome `d3` front
  centre.
- Sway: no. Solid: yes.
- Risk: the polyps may come out as dots. Fallback: keep the instanced zoanthids and move them onto rock.

### 11. `sea_rod`: Caribbean sea rod (gorgonian)
- **Prompt:** `Knobby sea rod gorgonian (Eunicea), a few thick upright candelabra branches forking from a short trunk, each branch finger-thick and covered in raised polyp calyces, dull purple-brown with tan tips`
- Kind: coral with `sway: 1.5` (it flexes in the surge). Size: 3-4 units tall. Put it in the back
  corners and behind piles, to fill the empty upper frame.
- Solid: no. Fish swim through.
- Risk: there may be too many branches, or they may be thin and broken. Fallback: procedural tapered
  tubes (the staghorn generator with fewer forks and sway).

### 12. `urchin_pencil`: slate pencil urchin
- **Prompt:** `Slate pencil sea urchin (Heterocentrotus mamillatus), round test with about twenty thick blunt cylindrical spines radiating, spines banded red-brown and cream`
- Kind: prop. Size: 0.8-1 unit. Put it in a crevice in a front rock.
- Sway: no. Solid: no (too small).
- Risk: low. Fallback: skip.

### 13. `sea_cucumber`: sea cucumber
- **Prompt:** `Sea cucumber (Holothuria), soft elongated sausage-shaped body lying on sand, wrinkled leathery skin with small rounded papillae, dark brown with mottled tan`
- Kind: prop. Size: 1.6-2.2 units long, on open sand at the front. It is a scale cue that gives the
  foreground a "real floor" read.
- Sway: no. Solid: no.
- Risk: very low. Fallback: none needed.

### 14. `sponge_ear`: elephant-ear sponge
- **Prompt:** `Orange elephant ear sponge (Agelas clathrodes), a few thick wavy upright ear-shaped plates growing from a common base, rough porous surface, bright orange`
- Kind: coral or sponge. Size: 1.5 units, on rock faces as a colour accent.
- Sway: no. Solid: yes.
- Risk: it may look like the lettuce coral. Fallback: skip.

### Not worth Tripo credits

These are better done procedurally: Goniopora, gorgonian fan nets (keep the alpha plane), feather
dusters, Christmas tree worms, Diadema, a second host anemone (tentacles), coralline crust, and rubble.

## 4. Batches

**Batch 1 (5 jobs, about 150 credits, 200 at worst)**, for the biggest change to the frame:

1. `rock_i`: the rock texture family rock is about 50% of the frame and currently candy-sprinkled.
2. `rock_j`: a second family, so the piles stop being one sponge.
3. `coral_table`: the first horizontal silhouette, and a real overhang for the gramma and lionfish.
4. `sponge_barrel`: fills the back-wall gap and the empty upper frame, with a Caribbean signature.
5. `coral_montipora`: covers bare rock faces with plates, a second horizontal element.

**Batch 2 (about 9 jobs, about 270 credits)**, in order: `clam_tridacna`, `coral_brain` (regenerate),
`sponge_tube`, `coral_bubble`, `zoanthid_rock`, `sea_rod`, `sea_cucumber`, `urchin_pencil`,
`sponge_ear`.

Retries: budget about 20% (one retry per batch) for the items most likely to fail: table, Montipora
and sea rod.

### Regenerate or retire

- **Retire** `rock_c`, `rock_e` and `rock_b` from the rock pool once `rock_i` and `rock_j` exist. They
  have the worst raised pink and purple blobs. Remove them from scenery.json, not from disk, so the
  seeded layouts stay reproducible if they are restored. Keep rock_f, rock_g and rock_h. rock_a and
  rock_d are borderline: rock_d's arch is useful for caves.
- **Regenerate** `coral_brain` (wrong morphology), or just drop the swap and use the procedural one.
- **Retire** the procedural blue finger dome `d3` and yellow-green dome `d4`. Replace them with
  `zoanthid_rock` and `coral_bubble`, or with Montipora.
- **Keep** staghorn, finger, cauliflower, leather, lettuce (`coral_fan`), Halimeda, Caulerpa, starfish
  and conch. All read well.

### Rock variety or new corals?

Rock variety first, but only after the free shader fixes: 1.15x stretch cap, a triplanar coralline and
turf overlay, and hue jitter. Those fix most of the sameness at zero credits. After that, two new rock
families are worth more than any single coral, because rock is the most screen area. Beyond two, new
corals and sponges (shape variety: plates and columns) win.

## 5. Non-Tripo fixes and code notes (for whoever wires these in)

- **Biggest layout fix: close the back.** Make the back wall continuous and taller (slots every
  1.2-1.6 units, 1.8-3.2 tall, two staggered rows). Or add the dark back glass at z -6 from R4. Then
  the bright sand horizon and the empty blue upper half stop showing through the gaps.
- **Rock stretch.** Cap the `fitRock` kx and ky (1.45 and 1.3) and the per-axis normalise to at most
  about 1.15x off the model's natural aspect. Fill extra footprint with more rocks.
- **Foreground.** Pull the brain and blue dome back by about 0.5 units, leave 1-1.5 units of open sand
  at the front, and put small props there (cucumber, shells, rubble).
- New ids need **layout code**. `loadScenery` treats any non-rock, non-prop, non-plant entry as a
  coral keyed by name, but nothing places it unless reef.js has a slot (`swapCoral` onto a procedural
  stand-in, or a `place()` call for props). A `sponge` kind can reuse the coral path.
- **Table coral collision.** Today an item is either in both the height field and RockField, or in
  neither (`noHeight`). The table needs a third state: in RockField, so the plate is solid, but not
  splatted into the height field, plus a `shelters` entry under the plate (kind `'ledge'`).
- **Wall-mounted Montipora.** Place it by raycasting from the front into a rock face and orient it to
  the hit normal, not with `top()`.
- **Per-job negatives.** Add an optional `neg` to JOBS, appended to `NEG` in `generate()`, for "spikes"
  (brain) and "rubble, gravel" (colonies).
- **Roku.** Every addition changes the baked backdrop. Rebake after each batch.
