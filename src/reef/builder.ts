// ReefBuilder (Builder pattern): assembles the procedural reef in named steps, sand first, then rock,
// corals, the anemone, shells, generated corals, plants, the moray caves, and finally the derived data
// the animals use (homes, shelters, the collision field, fan worms).
//
// Everything is seeded so the PC scene and the exported Roku backdrop match. The steps run in a fixed
// order and each draws from the random streams exactly as the original single function did, so a seed
// builds the same reef: do not reorder steps or the draws inside them.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Noise, clamp, mulberry32, range, type Rng } from '../util.js';
import { addParallax } from '../parallax.js';
import { RockField } from '../rockField.js';
import { FanWorms } from '../fanWorms.js';
import { HeightField } from './heightField.js';
import { addSway, stdMat } from './materials.js';
import { brainCoral, color, domeCluster, leatherPlate, rockGeometry, ruffledFan, scratch, staghorn, type DomeShape } from './geometry.js';
import { grainTexture, poreTexture, rockDetailTexture, seaFanTexture } from './textures.js';
import { anemone } from './anemone.js';
import { swapCoral } from './scenery.js';
import { inNoHeightSubtree, isMesh, isSolid, markNoHeight, markSolid, naturalSize } from './flags.js';
import {
  ANEMONE_SPOT, BUBBLER, CAVE_STONE_GROWTH, CM_PER_UNIT, DESIGN_WIDTH, FOREGROUND_ROCK_X, GENERATED_ROCK_GROWTH,
  HEIGHT_FIELD, HOMES, MORAY_CAVES, OPEN_SAND_LEVEL, PILE_DOUBLE_WIDTH, PROBE_HEIGHT, ROCK_PILES, ROCK_STRETCH,
  SHELTER_LIMITS, STAGHORNS, STREAM,
} from './layout.js';
import type { Anemone, Cave, PlantedCounts, Reef, Scenery, Shelter, ShoalCoral } from './types.js';

const DOWN = new THREE.Vector3(0, -1, 0);
const EIGHT_DIRECTIONS = 8;

export interface ReefBuildParams {
  readonly scene: THREE.Object3D;
  /** Tank width (world units); the layout scales with it. */
  readonly width: number;
  readonly seed: number;
  readonly scenery: Scenery;
  /** The camera's rest position, which the moray caves must face. */
  readonly view: THREE.Vector3;
}

interface PutOptions {
  readonly sink?: number;
  /** Fish swim through it: not solid. */
  readonly soft?: boolean;
  /** Solid in the rock field but not in the height field, so fish can get under it. */
  readonly overhang?: boolean;
  readonly yaw?: number;
  readonly tilt?: number;
  /** Stand on the sand even where rock is under the footprint's edge. */
  readonly onSand?: boolean;
}

interface Blade { x: number; y: number; z: number; yaw: number; lean: number; w: number; L: number }
interface SandSpot { x: number; z: number; r: number }

export class ReefBuilder {
  private readonly width: number;
  private readonly seed: number;
  private readonly scenery: Scenery;
  private readonly view: THREE.Vector3;
  private readonly rng: Rng;
  private readonly noise: Noise;
  /** Layout x scale: the tank's width over the design width. */
  private readonly sx: number;
  private readonly group = new THREE.Group();
  private readonly rocks = new THREE.Group();
  private readonly corals = new THREE.Group();
  private readonly hf: HeightField;
  private readonly groundRay = new THREE.Raycaster();
  private sand: THREE.Mesh | null = null;
  private pores: THREE.Texture | null = null;
  private rockMat: THREE.MeshStandardMaterial | null = null;
  private stagMain: THREE.Object3D | null = null;
  private tableShelter: Shelter | null = null;
  private readonly anemoneSpot: THREE.Vector3;
  private readonly caves: Cave[] = [];
  private readonly planted: PlantedCounts = { grass: 0, clumps: 0, rubble: 0 };

  constructor(params: ReefBuildParams) {
    this.width = params.width;
    this.seed = params.seed;
    this.scenery = params.scenery;
    this.view = params.view;
    this.rng = mulberry32(params.seed);
    this.noise = new Noise(mulberry32(params.seed + STREAM.noise));
    this.sx = params.width / DESIGN_WIDTH;
    params.scene.add(this.group);
    this.hf = new HeightField(-params.width / 2 - HEIGHT_FIELD.xMargin, params.width / 2 + HEIGHT_FIELD.xMargin, HEIGHT_FIELD.z0, HEIGHT_FIELD.z1, HEIGHT_FIELD.step);
    this.anemoneSpot = new THREE.Vector3(ANEMONE_SPOT.x * this.sx, 0, ANEMONE_SPOT.z);
  }

  build(): Reef {
    this.addSand();
    this.makeRockMaterial();
    this.group.add(this.rocks);
    this.addBackWall();
    this.addRockPiles();
    this.addForegroundRocks();
    this.group.add(this.corals);
    this.group.updateMatrixWorld(true);
    this.addStaghorns();
    this.addDomes();
    this.addBrainCoral();
    this.addLeatherToadstool();
    this.addRuffledShells();
    this.addSeaFan();
    this.addZoanthids();
    this.addAnemone();
    this.addShellProps();
    this.addGeneratedCorals();
    this.hf.splatObject(this.corals);
    this.addPlants();
    this.addCaves();
    this.hf.finish();
    this.carveCaveFloors();
    const homes = this.findHomes();
    const shelters = this.findShelters();
    const rockField = this.buildRockField();
    const fanWorms = this.addFanWorms(rockField);
    const shoalCoral = this.shoalCoral(shelters);
    const hf = this.hf;
    const anemones: Anemone[] = [{ pos: new THREE.Vector3(this.anemoneSpot.x, this.anemoneSpot.y + 0.35, this.anemoneSpot.z), radius: 0.75 }];
    return {
      group: this.group,
      heightAt: (x, z) => hf.sample(x, z),
      heightField: hf,
      rockField,
      anemones,
      bubbler: new THREE.Vector3(BUBBLER.x * this.sx, BUBBLER.y, BUBBLER.z),
      homes,
      caves: this.caves,
      planted: this.planted,   // { grass: patches, clumps: algae clumps, rubble: pieces } that found clear sand
      shelters,
      shoalCoral,              // the chromis' home staghorn
      fanWorms,                // feather dusters: update(dt, world) retracts them when startled
    };
  }

  // ---------- helpers ----------

  private requireRockMaterial(): THREE.MeshStandardMaterial {
    if (!this.rockMat) throw new Error('ReefBuilder: rock material not made yet');
    return this.rockMat;
  }

  private requirePores(): THREE.Texture {
    if (!this.pores) throw new Error('ReefBuilder: pore texture not made yet');
    return this.pores;
  }

  private requireSand(): THREE.Mesh {
    if (!this.sand) throw new Error('ReefBuilder: sand not laid yet');
    return this.sand;
  }

  /**
   * Corals stand on the actual rock or sand surface straight below them. (The heightfield is a
   * 0.2-unit grid: next to a steep rock face it reports the cliff top, which left stalks floating.)
   */
  private groundAt(x: number, z: number): number {
    this.groundRay.set(new THREE.Vector3(x, PROBE_HEIGHT, z), DOWN);
    const hit = this.groundRay.intersectObjects([this.rocks, this.requireSand()], true)[0];
    return hit ? hit.point.y : this.hf.sample(x, z);
  }

  /**
   * r: footprint radius. A colony settles to the lowest point under its base, so where it overhangs
   * a rock edge its base reaches down into the rock instead of hanging over the drop.
   */
  private restingHeight(x: number, z: number, r = 0): number {
    let y = this.groundAt(x, z);
    for (let i = 0; r > 0 && i < EIGHT_DIRECTIONS; i++) y = Math.min(y, this.groundAt(x + Math.cos(i * Math.PI / 4) * r, z + Math.sin(i * Math.PI / 4) * r));
    return y;
  }

  /**
   * A generated rock for a w x h x d slot, stretched by kx (sideways) and ky (up). Rocks stay near their
   * own proportions: each slot takes one of the two whose shape fits it best, turned a quarter if that
   * fits better (a branching piece stretched into a low slab reads as melted).
   */
  private fitRock(r: Rng, w: number, h: number, d: number, kx: number, ky: number, yaw: number): THREE.Object3D {
    const err = (n: THREE.Vector3, a: number, b: number): number => Math.log((a / h) / (n.x / n.y)) ** 2 + Math.log((b / h) / (n.z / n.y)) ** 2;
    const ranked = this.scenery.rocks.map((m) => {
      const n = naturalSize(m), e = err(n, w, d), e2 = err(n, d, w);
      return { m, e: Math.min(e, e2), swap: e2 < e };
    }).sort((p, q) => p.e - q.e);
    const pick = ranked[Math.min(ranked.length - 1, Math.floor(r() * 2))];
    if (!pick) throw new Error('fitRock: no generated rocks');
    const m = pick.m.clone();
    // Keep the rock near its own shape: scale it uniformly to the slot's size (geometric mean), then let
    // each axis stretch at most ROCK_STRETCH towards the slot. (Stretched further, the pores became oval
    // holes several cm across and every rock read as the same sponge.) The pile fills any gap with more rocks.
    const n = naturalSize(pick.m);
    const tx = (pick.swap ? d : w) * kx, ty = h * ky, tz = (pick.swap ? w : d) * kx;
    const s = Math.cbrt((tx / n.x) * (ty / n.y) * (tz / n.z));
    const fit = (t: number, nn: number): number => s * nn * clamp(t / (s * nn), 1 / ROCK_STRETCH, ROCK_STRETCH);
    m.scale.set(fit(tx, n.x), fit(ty, n.y), fit(tz, n.z));
    m.rotation.y = pick.swap ? yaw + Math.PI / 2 : yaw;
    return m;
  }

  /** r: the random stream (pieces added after the original layout use their own, so it doesn't shift). */
  private addRock(x: number, z: number, w: number, h: number, d: number, sink = 0, r: Rng = this.rng): THREE.Object3D {
    const ground = Math.max(this.hf.sample(x, z), 0);
    let m: THREE.Object3D;
    if (this.scenery.rocks.length) {
      // Generated rock fitted to the footprint, base slightly buried in the sand (any yaw: the
      // footprint's two sides are interchangeable).
      m = this.fitRock(r, w, h, d, GENERATED_ROCK_GROWTH.x, GENERATED_ROCK_GROWTH.y, r() * Math.PI * 2);
      m.position.set(x, ground - sink - m.scale.y * (0.15 / 1.3), z);   // sunk 15% of the slot's height
    } else {
      m = new THREE.Mesh(rockGeometry(r, this.noise, w, h, d), this.requireRockMaterial());
      m.position.set(x, ground + h * 0.55 - sink, z);
      m.rotation.y = r() * Math.PI * 2;
    }
    m.castShadow = m.receiveShadow = true;
    this.rocks.add(m);
    this.hf.splatObject(m);
    return m;
  }

  // ---------- sand and rock ----------

  private addSand(): void {
    const { rng, noise } = this;
    const sandTex = grainTexture(rng, 512, [188, 178, 158], 80, 10);
    const geo = new THREE.PlaneGeometry(this.width * 2.4, 22, 220, 110);
    geo.rotateX(-Math.PI / 2);
    const p = geo.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const y = (noise.fbm(x * 0.15, z * 0.2, 3) - 0.5) * 0.5 + Math.sin(x * 2.2 + noise.noise2(x * 0.3, z * 0.3) * 6) * 0.025 - Math.max(0, z - 3) * 0.08;
      p.setY(i, y);
    }
    geo.computeVertexNormals();
    const sand = new THREE.Mesh(geo, stdMat({ map: sandTex, bumpMap: sandTex, bumpScale: 1.5, roughness: 1 }));
    sand.receiveShadow = true;
    markNoHeight(sand);
    sand.name = 'sand';
    this.group.add(sand);
    this.sand = sand;
  }

  private makeRockMaterial(): void {
    this.pores = poreTexture(this.rng);
    this.rockMat = addParallax(stdMat({ vertexColors: true, map: rockDetailTexture(this.rng), roughness: 0.95, bumpMap: this.pores, bumpScale: 3.0 }), 0.05);
  }

  /**
   * Distant back wall of rock: gives depth and fills the frame edges. A continuous wall in two staggered
   * rows (a reef tank's back is rockwork fading into murk). The first row keeps its original draws,
   * remapped taller (1.8-3.2), so the seeded layout after it is unchanged; the second row, in front of
   * the gaps, has its own stream.
   */
  private addBackWall(): void {
    const { rng, width } = this;
    const wallX: number[] = [];
    for (let x = -width * 0.75; x <= width * 0.75; x += range(rng, 1.6, 2.4)) {
      const z = range(rng, -5.2, -4.2), w = range(rng, 1.3, 2.1), h = 1.8 + (range(rng, 1.2, 2.6) - 1.2) * 1.0, d = range(rng, 1.0, 1.6);
      this.addRock(x, z, w, h, d);
      wallX.push(x);
    }
    const wrng = mulberry32(this.seed + STREAM.backWallSecondRow);
    for (let i = 0; i + 1 < wallX.length; i++) {
      const x = ((wallX[i] ?? 0) + (wallX[i + 1] ?? 0)) / 2 + range(wrng, -0.2, 0.2);
      this.addRock(x, range(wrng, -4.0, -3.6), range(wrng, 1.2, 1.7), range(wrng, 1.3, 2.2), range(wrng, 0.9, 1.3), 0, wrng);
    }
  }

  private addRockPiles(): void {
    const { rng } = this;
    for (const pile of ROCK_PILES) {
      const px = pile.x * this.sx;
      for (const [w, h] of pile.levels) {
        const n = w > PILE_DOUBLE_WIDTH ? 2 : 1;
        for (let i = 0; i < n; i++) {
          this.addRock(px + range(rng, -w * 0.5, w * 0.5), pile.z + range(rng, -0.6, 0.6), w * range(rng, 0.8, 1.1), h, w * range(rng, 0.6, 0.85), h * 0.35);
        }
      }
    }
  }

  /**
   * Foreground rubble and small rocks, set back from the front (z 0.9-1.5; the original draws remapped)
   * so the front of the sand stays open for small, low things: the scale cues of a real tank floor.
   */
  private addForegroundRocks(): void {
    const { rng, sx } = this;
    for (const x of FOREGROUND_ROCK_X) this.addRock(x * sx + range(rng, -0.5, 0.5), 0.9 + (range(rng, 1.4, 2.4) - 1.4) * 0.6, range(rng, 0.6, 1.0), range(rng, 0.4, 0.8), range(rng, 0.5, 0.8), 0.15);
  }

  // ---------- corals ----------

  /** Staghorn on the central pile (the first is the chromis shoal's home coral). */
  private addStaghorns(): void {
    const { rng, sx, corals } = this;
    const mat = addParallax(stdMat({ vertexColors: true, roughness: 0.7, bumpMap: this.requirePores(), bumpScale: 1.0 }), 0.03);
    for (const [x, z, s] of STAGHORNS) {
      const m = new THREE.Mesh(staghorn(rng, s), mat);
      m.position.set(x * sx, this.restingHeight(x * sx, z, 0.3 * s) - 0.15, z);
      m.rotation.y = rng() * 6;
      m.castShadow = m.receiveShadow = true;
      corals.add(m);
      const g = swapCoral(corals, m, this.scenery.coral['staghorn']);
      if (!this.stagMain) this.stagMain = g;
    }
  }

  private addDome(radius: number, count: number, baseHex: string, varyHex: string, shape: DomeShape): THREE.InstancedMesh {
    return domeCluster(this.rng, radius, count, baseHex, varyHex, shape);
  }

  /** White finger dome (left), lavender cauliflower, and two small front domes. */
  private addDomes(): void {
    const { sx, corals } = this, coral = this.scenery.coral;
    const d1 = this.addDome(1.0, 520, '#eee8dc', '#c9c2b0', 'finger');
    d1.position.set(-5.5 * sx, this.restingHeight(-5.5 * sx, -0.9, 0.6) - 0.1, -0.9);
    corals.add(d1);
    swapCoral(corals, d1, coral['finger']);
    const d2 = this.addDome(0.75, 650, '#c9a4dc', '#9e78b8', 'ball');
    d2.position.set(-2.4 * sx, this.restingHeight(-2.4 * sx, -0.3, 0.45) - 0.05, -0.3);
    corals.add(d2);
    swapCoral(corals, d2, coral['cauliflower']);
    // Two small domes, front centre: a zoanthid-covered rubble rock and a bubble coral when generated
    // (the procedural bead domes read as toys).
    const d3 = this.addDome(0.55, 300, '#3b52d1', '#6070e8', 'finger');
    d3.position.set(1.4 * sx, Math.max(0, this.restingHeight(1.4 * sx, 1.1, 0.3)) - 0.05, 1.1);
    corals.add(d3);
    swapCoral(corals, d3, coral['zoanthid_rock']);
    const d4 = this.addDome(0.45, 240, '#a8c45c', '#d8e070', 'finger');
    d4.position.set(-1.0 * sx, this.restingHeight(-1.0 * sx, 0.4, 0.25) - 0.05, 0.4);
    corals.add(d4);
    swapCoral(corals, d4, coral['bubble']);
  }

  /** Brain coral on the sand, front-left of centre, set back clear of the bubble coral. */
  private addBrainCoral(): void {
    const { sx, corals } = this;
    const m = new THREE.Mesh(brainCoral(this.noise), stdMat({ vertexColors: true, roughness: 0.8 }));
    m.scale.setScalar(0.8);
    m.position.set(-1.9 * sx, Math.max(0, this.restingHeight(-1.9 * sx, 0.7, 0.4)) - 0.05, 0.7);
    m.castShadow = m.receiveShadow = true;
    corals.add(m);
    swapCoral(corals, m, this.scenery.coral['brain']);
  }

  /** Green leather toadstool: a stalk and a ruffled cap. */
  private addLeatherToadstool(): void {
    const { sx, corals } = this;
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 0.6, 16), stdMat({ color: 0xc8bf86, roughness: 0.8 }));
    const cap = new THREE.Mesh(leatherPlate(this.rng), stdMat({ vertexColors: true, roughness: 0.65, side: THREE.DoubleSide }));
    const g = new THREE.Group();
    stalk.position.y = 0.3; cap.position.y = 0.55; cap.scale.setScalar(1.15);
    cap.rotation.z = 0.15;
    stalk.castShadow = cap.castShadow = true; cap.receiveShadow = true;
    g.add(stalk, cap);
    g.position.set(-4.0 * sx, this.restingHeight(-4.0 * sx, 1.0, 0.3) - 0.1, 1.0);
    corals.add(g);
    swapCoral(corals, g, this.scenery.coral['leather']);
  }

  /** Ruffled shells on the right. */
  private addRuffledShells(): void {
    const { rng, sx, corals } = this;
    const mat = stdMat({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide });
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(ruffledFan(), mat);
      const x = (5.4 + range(rng, -1.0, 1.2)) * sx, z = range(rng, -0.6, 0.6);
      m.position.set(x, this.restingHeight(x, z, 0.2) - 0.15, z);
      m.rotation.set(range(rng, -0.4, -0.1), range(rng, -0.6, 0.6), 0);
      m.scale.setScalar(range(rng, 0.6, 0.9));
      m.castShadow = true;
      corals.add(m);
      swapCoral(corals, m, this.scenery.coral['fan']);
    }
  }

  /**
   * Sea fan, back left. A gorgonian flexes with the surge across its face (plane local z), its base
   * fixed (the plane runs y 0..2.8, so only the upper part moves, growing towards the rim).
   */
  private addSeaFan(): void {
    const { sx } = this;
    const fanGeo = new THREE.PlaneGeometry(2.8, 2.8);
    fanGeo.translate(0, 1.4, 0);
    const mat = addSway(stdMat({ map: seaFanTexture(this.rng), transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.8 }), 'seafan', { ax: 0.04, az: 0.2, hz: 0.5, hTop: 2.8 });
    const m = new THREE.Mesh(fanGeo, mat);
    m.position.set(-6.8 * sx, this.restingHeight(-6.8 * sx, -3.0) - 0.2, -3.0);   // base at the geometry's y = 0
    m.rotation.y = 0.35;
    markNoHeight(m);
    this.corals.add(m);
  }

  /** Zoanthid polyp patches: 7 patches of 60, on the height-field grid (cheaper than ray casting). */
  private addZoanthids(): void {
    const { rng, sx, hf } = this;
    const PATCHES = 7, PER_PATCH = 60;
    const geo = new THREE.CylinderGeometry(0.03, 0.022, 0.025, 10);
    const mesh = new THREE.InstancedMesh(geo, stdMat({ color: 0xffffff, roughness: 0.5, emissive: 0x112222 }), PATCHES * PER_PATCH);
    const cols = ['#33d1b5', '#ff8a3a', '#9ae35b', '#e05bb0'].map(color);
    const { m, q, s, p } = scratch;
    let n = 0;
    for (let patch = 0; patch < PATCHES; patch++) {
      const cx = range(rng, -6, 6) * sx, cz = range(rng, -1, 1.8), col = cols[patch % cols.length] ?? new THREE.Color();
      for (let i = 0; i < PER_PATCH; i++, n++) {
        const x = cx + range(rng, -0.25, 0.25), z = cz + range(rng, -0.2, 0.2);
        m.compose(p.set(x, hf.sample(x, z) - 0.12, z), q.identity(), s.setScalar(range(rng, 0.8, 1.3)));
        mesh.setMatrixAt(n, m);
        mesh.setColorAt(n, col);
      }
    }
    markNoHeight(mesh);
    this.corals.add(mesh);
  }

  /** Host anemone on a low front rock. */
  private addAnemone(): void {
    const spot = this.anemoneSpot;
    this.addRock(spot.x, spot.z, 1.1, 0.7, 0.9, 0.1);
    spot.y = this.restingHeight(spot.x, spot.z, 0.15) - 0.12;
    const an = anemone(this.rng);
    an.position.copy(spot);
    an.traverse((o) => markNoHeight(o));
    this.corals.add(an);
  }

  /**
   * Shells on the open sand at the front: a starfish lying flat and a conch on its side, and scale cues
   * (a sea cucumber, a giant clam, a pencil urchin). Their own random stream keeps the rest of the seeded
   * layout as it was; no procedural stand-ins. facing: turn the model's +z to the viewer.
   */
  private addShellProps(): void {
    const { sx, view } = this;
    const prng = mulberry32(this.seed + STREAM.shellProps);
    const place = (model: THREE.Object3D | undefined, cm: number, x: number, z: number, facing = false): void => {
      if (!model) return;
      const m = model.clone(), k = cm / CM_PER_UNIT;   // largest side, cm -> units
      m.scale.setScalar(k);
      const spin = prng() * Math.PI * 2;
      m.rotation.y = facing ? Math.atan2(view.x - x, view.z - z) + (spin / Math.PI - 1) * 0.2 : spin;
      m.position.set(x, this.restingHeight(x, z, 0.4 * k) - 0.01 * k, z);
      m.traverse((o) => { if (isMesh(o)) o.castShadow = o.receiveShadow = true; });
      this.corals.add(m);
    };
    const props = this.scenery.props;
    // Far enough back to sit whole above the bottom of the zoomed window (view.ts), which cuts the sand at z ~2.
    place(props['starfish'], 17, (0.2 + range(prng, -0.3, 0.3)) * sx, range(prng, 1.4, 1.7));
    place(props['conch'], 16, (4.4 + range(prng, -0.3, 0.3)) * sx, range(prng, 1.1, 1.4), true);
    place(props['sea_cucumber'], 22, (-2.8 + range(prng, -0.2, 0.2)) * sx, range(prng, 1.6, 1.8));
    place(props['clam_tridacna'], 19, (-5.3 + range(prng, -0.2, 0.2)) * sx, range(prng, 1.6, 1.8), true);
    place(props['urchin_pencil'], 11, (-6.6 + range(prng, -0.2, 0.2)) * sx, range(prng, 1.7, 1.9));
  }

  /**
   * Generated corals and sponges with no procedural stand-in, from their
   * own random stream. Each: model, largest side (units), design x, z, and how it sits (PutOptions).
   */
  private addGeneratedCorals(): void {
    const crng = mulberry32(this.seed + STREAM.generatedCorals), coral = this.scenery.coral;
    const put = (model: THREE.Object3D | undefined, size: number, designX: number, z: number, options: PutOptions = {}): THREE.Object3D | null => {
      // (The yaw is drawn before the model check, as the original's default parameter was.)
      const yaw = options.yaw ?? crng() * Math.PI * 2;
      if (!model) return null;
      const sink = options.sink ?? 0.08, soft = options.soft ?? false, overhang = options.overhang ?? false;
      const m = model.clone();
      m.scale.setScalar(size);
      const x = designX * this.sx;
      m.rotation.set(options.tilt ?? 0, yaw, 0);
      let y = this.restingHeight(x, z, 0.15 * size);
      if (options.onSand) {
        this.groundRay.set(new THREE.Vector3(x, PROBE_HEIGHT, z), DOWN);
        const hit = this.groundRay.intersectObject(this.requireSand(), false)[0];
        if (hit) y = hit.point.y;
      }
      m.position.set(x, y - sink * size, z);   // settles to the lowest point under its foot
      m.traverse((o) => {
        if (!isMesh(o)) return;
        o.castShadow = o.receiveShadow = true;
        if (soft || overhang) markNoHeight(o);
        if (overhang) markSolid(o);
      });
      this.corals.add(m);
      return m;
    };
    // Table Acropora high on the back-right pile, tilted a little to the camera so the plate reads as a
    // plate: the first horizontal in the reef, and an overhang for the gramma and lionfish.
    const table = put(coral['table'], 3.0, 2.6, -2.5, { overhang: true, tilt: 0.12, yaw: 0.3, sink: 0.05 });
    if (table) {
      const b = new THREE.Box3().setFromObject(table), c = b.getCenter(new THREE.Vector3());
      this.tableShelter = { pos: new THREE.Vector3(c.x, b.min.y + (b.max.y - b.min.y) * 0.35, c.z), floor: this.restingHeight(c.x, c.z), top: b.max.y - 0.15, r: 0.6, kind: 'ledge' };
    }
    // Barrel sponge back left, filling the back-wall gap and breaking the skyline.
    put(coral['sponge_barrel'], 2.2, -4.4, -2.9, { sink: 0.04, onSand: true });
    // Tube sponges standing up from pile tops: yellow on the back-left pile, orange on the right pile.
    put(coral['sponge_tube'], 1.8, -2.9, -2.5, { sink: 0.05 });
    put(coral['sponge_tube_orange'], 1.5, 5.2, -1.4, { sink: 0.05 });
    // Sea rods in the back corners, filling the empty upper frame; they flex, and fish swim through.
    put(coral['sea_rod'], 3.4, -7.0, -3.7, { soft: true, sink: 0.03 });
    put(coral['sea_rod'], 2.8, 7.1, -3.9, { soft: true, sink: 0.03 });
    // Plating Montipora on the right pile's front; the branching finger Montipora on the left pile.
    put(coral['montipora'], 1.6, 4.9, -0.9, { sink: 0.03 });
    put(coral['digitata'], 1.1, -6.3, -0.2);
  }

  // ---------- plants and rubble ----------

  /**
   * Sea grass, macroalgae and rubble, placed after the corals are in the height field so they find
   * clear sand. Their own random stream leaves the rest of the seeded layout as it was. Fish swim
   * through them (not in the height field), as they do through real grass beds.
   */
  private addPlants(): void {
    const grng = mulberry32(this.seed + STREAM.plants);
    const spots: SandSpot[] = [];
    this.addSeaGrass(grng, spots);
    this.addAlgaeClumps(grng, spots);
    this.addRubble(grng);
    this.planted.grass = this.corals.children.filter((o) => o.name === 'seagrass').length;
    this.planted.clumps = spots.length - this.planted.grass;
  }

  /** True when the sand within r of (x, z) is clear of rock. */
  private clearSand(x: number, z: number, r: number): boolean {
    const hf = this.hf;
    if (hf.sample(x, z) > OPEN_SAND_LEVEL) return false;
    for (let i = 0; i < EIGHT_DIRECTIONS; i++) if (hf.sample(x + Math.cos(i * Math.PI / 4) * r, z + Math.sin(i * Math.PI / 4) * r) > OPEN_SAND_LEVEL) return false;
    return true;
  }

  /** A clear sand spot of radius r between z0 and z1, apart from the earlier ones; recorded in spots. */
  private findSpot(grng: Rng, spots: SandSpot[], r: number, z0: number, z1: number, apart: number): [number, number] | null {
    for (let i = 0; i < 80; i++) {
      const x = range(grng, -6.6, 6.6) * this.sx, z = range(grng, z0, z1);
      if (this.clearSand(x, z, r) && spots.every((s) => Math.hypot(s.x - x, s.z - z) > apart + s.r)) { spots.push({ x, z, r }); return [x, z]; }
    }
    return null;
  }

  /**
   * Turtle grass (Thalassia testudinum): strap blades 4-12 mm wide and 10-30 cm long, in shoots of 2-5
   * from a buried rhizome; green, browning and speckled with epiphytes towards the tips.
   */
  private addSeaGrass(grng: Rng, spots: SandSpot[]): void {
    const blade = new THREE.PlaneGeometry(1, 1, 1, 10);
    blade.translate(0, 0.5, 0);
    {
      const p = blade.getAttribute('position'), col = new Float32Array(p.count * 3), c = new THREE.Color();
      const base = color('#3b5a2a'), mid = color('#5a7a36'), tip = color('#8a8248');   // olive, as in field photos
      for (let i = 0; i < p.count; i++) {
        const h = p.getY(i);
        c.copy(base).lerp(mid, clamp(h * 2, 0, 1)).lerp(tip, clamp((h - 0.7) / 0.3, 0, 1) * 0.8);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      blade.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const grassMat = addSway(stdMat({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide }), 'seagrass', { ax: 0, az: 0.16, hz: 0.7 });
    const { m, q, s, p } = scratch;
    for (let patch = 0; patch < 3; patch++) {
      const at = this.findSpot(grng, spots, 0.3, -0.4, 1.8, 1.2);
      if (!at) break;
      const [cx, cz] = at, shoots = Math.floor(range(grng, 45, 65)), blades: Blade[] = [];
      for (let sh = 0; sh < shoots; sh++) {
        const a = grng() * Math.PI * 2, r = Math.sqrt(grng()) * 0.6;
        const x = Math.cos(a) * r * 1.4, z = Math.sin(a) * r * 0.8, yaw = grng() * Math.PI * 2;
        if (this.hf.sample(cx + x, cz + z) > OPEN_SAND_LEVEL) { grng(); grng(); continue; }   // grass grows in sand, not on rock
        const n = 2 + Math.floor(grng() * 4), L = range(grng, 0.8, 1.8) * (1 - r * 0.5);   // shorter at the edge
        const y = this.groundAt(cx + x, cz + z) - 0.04;   // the sand undulates and isn't in the height field
        for (let b = 0; b < n; b++) blades.push({ x, y, z, yaw: yaw + range(grng, -0.35, 0.35), lean: range(grng, 0.08, 0.4), w: range(grng, 0.04, 0.085), L: L * range(grng, 0.7, 1.05) });
      }
      const mesh = new THREE.InstancedMesh(blade, grassMat, blades.length);
      const e = new THREE.Euler(), tint = new THREE.Color();
      blades.forEach((b, i) => {
        q.setFromEuler(e.set(b.lean, b.yaw, 0, 'YXZ'));
        m.compose(p.set(b.x, b.y, b.z), q, s.set(b.w, b.L, b.L));
        mesh.setMatrixAt(i, m);
        // Per-blade tint around white (instance colour multiplies the vertex colour): a little hue and
        // brightness variation, some blades older and browner.
        mesh.setColorAt(i, tint.setHSL(0.2 + range(grng, -0.04, 0.05), 0.18, range(grng, 0.36, 0.5)).multiplyScalar(1.9));
      });
      mesh.position.set(cx, 0, cz);
      mesh.castShadow = mesh.receiveShadow = true;
      markNoHeight(mesh);
      mesh.name = 'seagrass';
      this.corals.add(mesh);
    }
  }

  /** Macroalgae clumps from scenery.json: Halimeda on sand and rubble, Caulerpa on sand and low rock. */
  private addAlgaeClumps(grng: Rng, spots: SandSpot[]): void {
    const clump = (model: THREE.Object3D | undefined, cm: number, n: number, z0: number, z1: number): void => {
      if (!model) return;
      for (let i = 0; i < n; i++) {
        const k = cm * range(grng, 0.75, 1.15) / CM_PER_UNIT;
        const at = this.findSpot(grng, spots, 0.15 * k + 0.05, z0, z1, 0.5);
        if (!at) return;
        const m = model.clone();
        m.scale.setScalar(k);
        m.rotation.y = grng() * Math.PI * 2;
        m.position.set(at[0], this.restingHeight(at[0], at[1], 0.3 * k) - 0.02 * k, at[1]);
        m.traverse((o) => { if (isMesh(o)) { o.castShadow = o.receiveShadow = true; markNoHeight(o); } });
        markNoHeight(m);
        this.corals.add(m);
      }
    };
    const plants = this.scenery.plants;
    clump(plants['halimeda'], 15, 3, -0.6, 1.4);
    clump(plants['caulerpa'], 11, 4, -0.4, 1.5);
  }

  /** Broken pieces are angular: a coarse, strongly jittered polyhedron, flat shaded so the facets read. */
  private rubbleGeometry(): THREE.BufferGeometry {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 1);
    g.deleteAttribute('uv');
    g = mergeVertices(g);
    const p = g.attributes['position'], v = new THREE.Vector3(), stretch = new THREE.Vector3(1.2, 0.5, 0.7);
    if (p) {
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        v.multiplyScalar(0.55 + 0.9 * this.noise.fbm3(v.x * 2.1 + 5, v.y * 2.1, v.z * 2.1, 2)).multiply(stretch);
        p.setXYZ(i, v.x, v.y, v.z);
      }
    }
    g = g.toNonIndexed();
    g.computeVertexNormals();
    return g;
  }

  /**
   * Rubble: broken coral and shell fragments (2-5 cm) collect at the feet of the rock, where it meets
   * the sand; it softens the hard line between them. One instanced mesh of lumpy low-poly pieces.
   */
  private addRubble(grng: Rng): void {
    const { sx, hf } = this;
    const MAX_PIECES = 260, TRIES = 3000, NEAR_ROCK = 0.5;
    const mesh = new THREE.InstancedMesh(this.rubbleGeometry(), stdMat({ color: 0xffffff, roughness: 1, flatShading: true, bumpMap: this.requirePores(), bumpScale: 2.5 }), MAX_PIECES);
    // Bleached skeleton and shell, dulled by a film of algae and detritus; a little old coralline.
    const tints = ['#b8ad96', '#a89c84', '#c4b9a2', '#9a9080', '#8e8a7a', '#a8968e'].map(color);
    const e = new THREE.Euler();
    const { m, q, s: scale, p } = scratch;
    let n = 0;
    for (let i = 0; i < TRIES && n < MAX_PIECES; i++) {
      const x = range(grng, -7.2, 7.2) * sx, z = range(grng, -3.0, 1.9);
      if (hf.sample(x, z) > OPEN_SAND_LEVEL) continue;
      let near = 0;
      for (let k = 0; k < 6; k++) near = Math.max(near, hf.sample(x + Math.cos(k * 1.05) * 0.45, z + Math.sin(k * 1.05) * 0.45));
      if (near < NEAR_ROCK) continue;
      const s = range(grng, 0.05, 0.18);
      q.setFromEuler(e.set(range(grng, -0.5, 0.5), grng() * 6.3, range(grng, -0.5, 0.5)));
      m.compose(p.set(x, this.groundAt(x, z) + s * 0.15, z), q, scale.set(s, s, s));
      mesh.setMatrixAt(n, m);
      mesh.setColorAt(n, tints[Math.floor(grng() * tints.length)] ?? new THREE.Color());
      n++;
    }
    mesh.count = n;
    mesh.castShadow = mesh.receiveShadow = true;
    markNoHeight(mesh);
    mesh.name = 'rubble';
    this.corals.add(mesh);
    this.planted.rubble = n;
  }

  // ---------- moray caves ----------

  /** Cave-local (lx, y, lz) to world, for a cave at (cx, cz) turned by yaw. */
  private static caveToWorld(cx: number, cz: number, yaw: number, lx: number, y: number, lz: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(cx + lx * Math.cos(yaw) + lz * Math.sin(yaw), y, cz - lx * Math.sin(yaw) + lz * Math.cos(yaw));
  }

  /** Fraction of camera sight lines that reach a cave at (cx, cz, yaw), or -1 where the site is unusable. */
  private caveVisibility(cx: number, cz: number, yaw: number): number {
    const { hf, view } = this;
    const sight = new THREE.Raycaster(), t = new THREE.Vector3(), d = new THREE.Vector3();
    const anem = new THREE.Vector3(ANEMONE_SPOT.x * this.sx, 0, ANEMONE_SPOT.z);
    const ground = Math.max(0, hf.sample(cx, cz));
    if (ground > 0.3) return -1;   // on the sand, not perched on a rock pile
    for (const [lx, lz] of [[0, 0], [-0.3, 0.5], [0.3, 0.5], [0, 0.9], [0, -0.4]] as const) {
      if (hf.sample(ReefBuilder.caveToWorld(cx, cz, yaw, lx, 0, lz, t).x, t.z) > ground + 0.3) return -1;   // rock where the eel lies
    }
    if (Math.hypot(cx - anem.x, cz - anem.z) < 2 || this.caves.some((c) => Math.hypot(cx - c.x, cz - c.z) < 3.5)) return -1;
    this.rocks.updateMatrixWorld(true); this.corals.updateMatrixWorld(true);
    let hit = 0, n = 0;
    for (const [lx, y, lz] of [[0, 0.3, 0.1], [-0.3, 0.2, 0.55], [0, 0.2, 0.55], [0.3, 0.2, 0.55], [-0.3, 0.45, 0.55], [0, 0.45, 0.55], [0.3, 0.45, 0.55]] as const) {
      ReefBuilder.caveToWorld(cx, cz, yaw, lx, ground + y, lz, t);
      d.subVectors(t, view);
      sight.set(view, d.clone().normalize());
      sight.far = d.length() - 0.05;
      n++;
      if (!sight.intersectObjects([this.rocks, this.corals], true).length) hit++;
    }
    return hit / n;
  }

  /** Candidate sites across the tank, back rows first (a cave tucked into the reef), shuffled within a row. */
  private caveCandidates(crng: Rng): [number, number][][] {
    const width = this.width;
    return [-1.4, -0.8, -0.2, 0.4, 1.0].map((z) => {
      const row: [number, number][] = [];
      for (let x = -width * 0.4; x <= width * 0.4; x += 0.8) row.push([x + range(crng, -0.2, 0.2), z + range(crng, -0.15, 0.15)]);
      for (let i = row.length - 1; i > 0; i--) {
        const j = Math.floor(crng() * (i + 1));
        const a = row[i], b = row[j];
        if (a && b) { row[i] = b; row[j] = a; }
      }
      return row;
    });
  }

  /** The best-seen site, mouth turned towards the viewer; stops at the first fully visible one. */
  private bestCaveSite(crng: Rng, rows: readonly (readonly [number, number])[][]): { site: [number, number, number]; seen: number } | null {
    const view = this.view;
    let best: [number, number, number] | null = null, bestV = -1;
    for (const row of rows) {
      for (const [x, z] of row) {
        const yaw = clamp(Math.atan2(view.x - x, view.z - z) + range(crng, -0.15, 0.15), -0.6, 0.6);
        const v = this.caveVisibility(x, z, yaw);
        if (v > bestV) { bestV = v; best = [x, z, yaw]; }
        if (v === 1) break;
      }
      if (bestV === 1) break;
    }
    return best ? { site: best, seen: bestV } : null;
  }

  /** The arch: two side stones and a back stone under a roof that stays out of the height field. */
  private caveStones(crng: Rng, cave: THREE.Group): void {
    const stone = (x: number, y: number, z: number, w: number, h: number, d: number, solid: boolean): void => {
      let m: THREE.Object3D;
      if (this.scenery.rocks.length) {
        m = this.fitRock(crng, w, h, d, CAVE_STONE_GROWTH.x, CAVE_STONE_GROWTH.y, range(crng, -0.3, 0.3));
        m.position.set(x, y - h * 0.1, z);
      } else {
        m = new THREE.Mesh(rockGeometry(crng, this.noise, w, h, d), this.requireRockMaterial());
        m.position.set(x, y + h * 0.5, z);
        m.rotation.y = range(crng, -0.3, 0.3);
      }
      m.castShadow = m.receiveShadow = true;
      if (!solid) markNoHeight(m);
      cave.add(m);
    };
    stone(-0.75, -0.15, 0, 0.6, 1.0, 1.4, true);    // side stones
    stone(0.75, -0.15, 0, 0.6, 1.0, 1.4, true);
    stone(0, -0.15, -0.8, 1.7, 1.0, 0.5, true);     // back
    stone(0, 0.75, -0.1, 2.3, 0.45, 1.7, false);    // roof
  }

  /**
   * Moray caves: an arch of rock with its mouth to the front, so every tank has a crevice for an eel.
   * They draw from their own random stream, so the rest of the seeded layout (and the Roku backdrop
   * baked from it) is unchanged. Each goes where the viewer can see into it: rays from the camera to its
   * mouth and interior must reach them past the rocks and corals already placed (and earlier caves).
   */
  private addCaves(): void {
    const crng = mulberry32(this.seed + STREAM.caves);
    const rows = this.caveCandidates(crng);
    for (let k = 0; k < MORAY_CAVES; k++) {
      const found = this.bestCaveSite(crng, rows);
      if (!found) break;
      const [cx, cz, yaw] = found.site;
      const ground = Math.max(0, this.hf.sample(cx, cz));
      const cave = new THREE.Group();
      cave.position.set(cx, ground, cz);
      cave.rotation.y = yaw;
      this.caveStones(crng, cave);
      this.rocks.add(cave);
      this.hf.splatObject(cave);
      const out = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      this.caves.push({
        mouth: new THREE.Vector3(cx, ground + 0.3, cz).addScaledVector(out, 0.55),
        dir: out,
        yaw, ground, x: cx, z: cz, seen: found.seen,
        roof: { y: ground + 0.68, top: ground + 1.2, hx: 1.1, z0: -0.9, z1: 0.72 },
      });
    }
  }

  /** Floor between the side stones, from the back stone out past the mouth, back down to the sand. */
  private carveCaveFloors(): void {
    for (const c of this.caves) {
      const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
      this.hf.carve((x, z) => {
        const dx = x - c.x, dz = z - c.z, lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
        return Math.abs(lx) < 0.4 && lz > -0.55 && lz < 1.0;
      }, c.ground + 0.05);
    }
  }

  // ---------- what the animals use ----------

  /** Resting spots: points just above the reef surface spread across the tank. */
  private findHomes(): THREE.Vector3[] {
    const { rng, width, hf } = this;
    const homes: THREE.Vector3[] = [];
    for (let i = 0; i < HOMES.count; i++) {
      const x = range(rng, -width * HOMES.xFraction, width * HOMES.xFraction), z = range(rng, HOMES.z0, HOMES.z1);
      homes.push(new THREE.Vector3(x, hf.sample(x, z) + HOMES.above, z));
    }
    return homes;
  }

  /**
   * Shelters: where a fish can tuck in for the night or dive when scared. Gaps under rock (the table
   * coral's plate first), crevices between rocks; the shoal coral's is added with it. The height field
   * holds the rock's top, so a fish inside one is let below it (fish.ts).
   */
  private findShelters(): Shelter[] {
    const shelters: Shelter[] = this.tableShelter ? [this.tableShelter] : [];
    this.group.updateMatrixWorld(true);
    this.findLedges(shelters);
    this.findCrevices(shelters);
    return shelters;
  }

  /**
   * From the open water in front of each rock face, look back into it at two heights: where the low
   * sightline goes clearly deeper than the high one, the face is undercut. The shelter is just inside
   * the lip, and a ray up from there finds the roof. (Rays start in open water: three.js ignores back
   * faces, so a ray from inside the rock would see nothing.)
   */
  private findLedges(shelters: Shelter[]): void {
    const { sx, hf } = this;
    const ray = new THREE.Raycaster(), UPV = new THREE.Vector3(0, 1, 0), BACK = new THREE.Vector3(0, 0, -1);
    const hit = (o: THREE.Vector3, d: THREE.Vector3, far: number): THREE.Intersection | null => {
      ray.set(o, d); ray.far = far;
      return ray.intersectObject(this.rocks, true)[0] ?? null;
    };
    for (let x = -7 * sx; x <= 7 * sx && shelters.length < SHELTER_LIMITS.ledges; x += 0.3) {
      let zr = 1.8;
      while (zr > -2.8 && hf.sample(x, zr) < 0.5) zr -= 0.2;
      if (zr <= -2.8) continue;
      const zf = zr + 0.7, floor = Math.max(0, this.groundAt(x, zf)) + 0.05;
      const lo = hit(new THREE.Vector3(x, floor + 0.2, zf), BACK, 3), hi = hit(new THREE.Vector3(x, floor + 0.8, zf), BACK, 3);
      if (!lo || !hi || lo.distance - hi.distance < 0.3) continue;
      const p = new THREE.Vector3(x, floor + 0.2, zf - hi.distance - 0.15);
      const up = hit(p, UPV, 2);
      if (!up || up.distance < 0.2) continue;
      if (shelters.some((s) => s.pos.distanceTo(p) < SHELTER_LIMITS.spacing)) continue;
      const topY = p.y + up.distance;
      shelters.push({ pos: new THREE.Vector3(p.x, (floor + topY) / 2, p.z), floor, top: topY, r: 0.45, kind: 'ledge' });
    }
  }

  /** Crevices: low spots walled left, right and behind, open to the front; the fish stays below the lower rim. */
  private findCrevices(shelters: Shelter[]): void {
    const { sx, hf } = this;
    for (let x = -7 * sx; x <= 7 * sx && shelters.length < SHELTER_LIMITS.withCrevices; x += 0.25) {
      for (let z = -2.6; z <= 1.2; z += 0.25) {
        const h = hf.sample(x, z), wl = hf.sample(x - 0.6, z), wr = hf.sample(x + 0.6, z);
        if (wl < h + 0.5 || wr < h + 0.5 || hf.sample(x, z - 0.6) < h + 0.4 || hf.sample(x, z + 0.6) > h + 0.2) continue;
        const p = new THREE.Vector3(x, h + 0.3, z);
        if (shelters.some((s) => s.pos.distanceTo(p) < SHELTER_LIMITS.spacing)) continue;
        shelters.push({ pos: p, floor: h + 0.05, top: Math.min(wl, wr), r: 0.35, kind: 'ledge' });
      }
    }
  }

  /**
   * The solid scenery in 3D, for collision: every rock including the cave roofs, and the corals that
   * are in the height field (not grass, algae, rubble or the anemone, which fish brush through), plus
   * overhanging pieces (userData.solid), solid here though kept out of the height field.
   */
  private buildRockField(): RockField {
    const t0 = performance.now();
    const top = new THREE.Box3().setFromObject(this.rocks).union(new THREE.Box3().setFromObject(this.corals)).max.y;
    const field = new RockField({ x0: -this.width / 2, x1: this.width / 2, y0: -0.3, y1: Math.min(top, 7) + 0.4, z0: -3.8, z1: 3.2 }, 0.08);
    field.add(this.rocks);
    field.add(this.corals, (o) => !isSolid(o) && inNoHeightSubtree(o));
    const info = field.finish();
    console.log('Rock field', JSON.stringify({ ...info, ms: Math.round(performance.now() - t0) }));
    return field;
  }

  /** Feather-duster worms on the rock faces, in a few clusters; not on the anemone's rock. */
  private addFanWorms(field: RockField): FanWorms {
    const hf = this.hf;
    const fanWorms = new FanWorms(this.rng, field, (x, z) => hf.sample(x, z), {
      width: this.width, count: 16, avoid: [{ x: this.anemoneSpot.x, z: this.anemoneSpot.z, r: 1.2 }],
    });
    this.group.add(fanWorms.group);
    console.log('Fan worms:', fanWorms.worms.length);
    return fanWorms;
  }

  /** The chromis' home staghorn, and their shelter in among its branches (down to halfway up the colony). */
  private shoalCoral(shelters: Shelter[]): ShoalCoral | null {
    if (!this.stagMain) return null;
    const b = new THREE.Box3().setFromObject(this.stagMain), c = b.getCenter(new THREE.Vector3());
    const shoal: ShoalCoral = { pos: new THREE.Vector3(c.x, b.min.y + (b.max.y - b.min.y) * 0.75, c.z), top: b.max.y, r: Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.4 };
    shelters.push({ pos: new THREE.Vector3(c.x, b.min.y + (b.max.y - b.min.y) * 0.55, c.z), floor: b.min.y + (b.max.y - b.min.y) * 0.4, top: b.max.y + 0.2, r: shoal.r, kind: 'coral' });
    return shoal;
  }
}
