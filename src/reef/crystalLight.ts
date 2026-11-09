// The crystal sign's own light on the sand. Glass lets most of the sun through, so instead of the solid
// shadow map shadow it throws a faint blue-tinted shade, and the light it focuses lands beside that as a
// bright, slowly shimmering caustic patch with faint rainbow edges. Both are flat overlays laid on the
// ground under the sign, placed each frame from the sun's direction (away from the light) and faded by
// the light level, so they swing round through the day and vanish at night.
//
// Plain MeshBasicMaterials with custom blending and texture matrices, so the same code runs on both
// renderers: the shade multiplies the ground by (1 - rgb), the caustic adds its rgb.
import * as THREE from 'three';
import { NO_REEF_LIGHT } from '../reefLight/bake.js';

/** How much the shade darkens the ground per channel at its core: faint, and least in blue (the glass
 *  passes blue best). */
const SHADE_DARK = new THREE.Color(0.24, 0.17, 0.08);
/** Caustic brightness at full sun (times the sun's colour). */
const CAUSTIC_GAIN = 1.2;
/** Rainbow split: the red layer of the pattern is drawn this much larger, the blue this much smaller. */
const CAUSTIC_SPLIT = 0.035;
/** Low suns stretch the shade and push the patch out; this caps the stretch (horizontal per vertical). */
const MAX_SLANT = 1.4;
/** Ground overlay grid resolution, and its lift off the ground (world units). */
const GRID = 48;
const LIFT = 0.006;

interface CrystalLightState {
  readonly centre: THREE.Vector3;
  readonly width: number;
  readonly height: number;
  readonly shade: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly caustics: readonly THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[];
}

let state: CrystalLightState | null = null;
const sunDir = new THREE.Vector3(0, 1, 0);
const sunColor = new THREE.Color(1, 1, 1);
let sunLevel = 1;

/** The soft shade blob: dark core fading to nothing well inside the texture's edge (clamped = neutral). */
function shadeTexture(): THREE.Texture {
  const n = 128;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n * 2 - 1, y = (j + 0.5) / n * 2 - 1;
    const r = Math.hypot(x, y);
    const t = Math.min(1, Math.max(0, (0.92 - r) / 0.62));
    const d = t * t * (3 - 2 * t);
    const k = (j * n + i) * 4;
    data[k] = Math.round(255 * d * SHADE_DARK.r);
    data[k + 1] = Math.round(255 * d * SHADE_DARK.g);
    data[k + 2] = Math.round(255 * d * SHADE_DARK.b);
    data[k + 3] = 255;
  }
  return patchTexture(data, n);
}

/** Bright cell borders of a jittered grid (Worley F2 - F1): the network look of real caustics. */
function causticNetwork(cells: number, seed: number): (x: number, y: number) => number {
  const pts: number[] = [];
  let s = seed >>> 0;
  const rnd = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < cells * cells; i++) pts.push(rnd(), rnd());
  return (x, y) => {
    // x, y in 0..1, tiled.
    const gx = x * cells, gy = y * cells;
    const cx = Math.floor(gx), cy = Math.floor(gy);
    let f1 = Infinity, f2 = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const ix = cx + dx, iy = cy + dy;
      const w = ((ix % cells) + cells) % cells, h = ((iy % cells) + cells) % cells;
      const px = ix + (pts[(h * cells + w) * 2] as number), py = iy + (pts[(h * cells + w) * 2 + 1] as number);
      const d = Math.hypot(gx - px, gy - py);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return Math.exp(-(f2 - f1) * 9);
  };
}

/** The caustic patch: the network, its red drawn a little larger and its blue a little smaller (the
 *  rainbow edges), inside a soft oval focus. */
function causticTexture(seed: number): THREE.Texture {
  const n = 256;
  const net = causticNetwork(7, seed);
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n * 2 - 1, y = (j + 0.5) / n * 2 - 1;
    const r = Math.hypot(x, y);
    const t = Math.min(1, Math.max(0, (0.9 - r) / 0.55));
    const mask = t * t * (3 - 2 * t);
    const at = (k: number): number => net(0.5 + x * 0.5 * k, 0.5 + y * 0.5 * k);
    const g = at(1);
    const red = at(1 / (1 + CAUSTIC_SPLIT)), blue = at(1 / (1 - CAUSTIC_SPLIT));
    const k = (j * n + i) * 4;
    data[k] = Math.round(255 * Math.min(1, red * mask));
    data[k + 1] = Math.round(255 * Math.min(1, g * mask));
    data[k + 2] = Math.round(255 * Math.min(1, blue * mask));
    data[k + 3] = 255;
  }
  return patchTexture(data, n);
}

function patchTexture(data: Uint8Array, n: number): THREE.Texture {
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.matrixAutoUpdate = false;   // set each frame: world (x, z) -> patch uv
  tex.needsUpdate = true;
  return tex;
}

/** A ground-hugging grid around (cx, cz), uv = world (x, z), so the texture matrix places the patch. */
function groundGrid(cx: number, cz: number, size: number, groundAt: (x: number, z: number) => number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= GRID; j++) for (let i = 0; i <= GRID; i++) {
    const x = cx + (i / GRID - 0.5) * size, z = cz + (j / GRID - 0.5) * size;
    pos.push(x, groundAt(x, z) + LIFT, z);
    uv.push(x, z);
  }
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const a = j * (GRID + 1) + i, b = a + 1, c = a + GRID + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function overlay(geo: THREE.BufferGeometry, map: THREE.Texture, shade: boolean): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  const mat = new THREE.MeshBasicMaterial({
    map, transparent: true, depthWrite: false, fog: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  // Colour only: the frame's alpha is kept as it was (the water passes read it).
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = mat.blendEquationAlpha = THREE.AddEquation;
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
  // Shade: dst * (1 - src) multiplies the ground down. Caustic: dst + src.
  mat.blendSrc = shade ? THREE.ZeroFactor : THREE.OneFactor;
  mat.blendDst = shade ? THREE.OneMinusSrcColorFactor : THREE.OneFactor;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = shade ? 'crystal-shade' : 'crystal-caustic';
  mesh.raycast = (): void => {};   // never ground or obstacle for anything else
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.renderOrder = shade ? 1 : 2;
  return mesh;
}

/**
 * Lays the shade and caustic overlays on the ground under the sign. box: the sign's world box;
 * groundAt: the rock or sand height at (x, z). Returns the group to add to the scene.
 */
export function makeCrystalLight(box: THREE.Box3, groundAt: (x: number, z: number) => number): THREE.Group {
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const width = Math.max(size.x, size.z);
  const height = size.y;
  const reach = width + MAX_SLANT * height + 0.6;
  const geo = groundGrid(centre.x, centre.z, reach * 2, groundAt);
  const shade = overlay(geo, shadeTexture(), true);
  const caustics = [overlay(geo, causticTexture(11), false), overlay(geo, causticTexture(23), false)];
  const group = new THREE.Group();
  group.name = 'crystal-light';
  group.userData[NO_REEF_LIGHT] = true;   // light on the ground, not an occluder over it
  group.add(shade, ...caustics);
  state = { centre, width, height, shade, caustics };
  updateCrystalLight(0);
  return group;
}

/** The sun's direction (towards the light), colour and level (0 night .. 1 day), from the lighting. */
export function setCrystalSun(dir: THREE.Vector3, color: THREE.Color, level: number): void {
  sunDir.copy(dir).normalize();
  sunColor.copy(color);
  sunLevel = level;
}

const axis = new THREE.Vector2();

/** Points the texture matrix at an oval centred (px, pz), long half-axis `along` on `axis`. */
function placeOval(tex: THREE.Texture, px: number, pz: number, ax: number, az: number, along: number, across: number): void {
  const bx = -az, bz = ax;
  const su = 1 / (2 * along), sv = 1 / (2 * across);
  tex.matrix.set(
    ax * su, az * su, 0.5 - (px * ax + pz * az) * su,
    bx * sv, bz * sv, 0.5 - (px * bx + pz * bz) * sv,
    0, 0, 1,
  );
}

/** Per frame: places the shade and the shimmering caustic from the sun, faded by the light level. */
export function updateCrystalLight(time: number): void {
  if (!state) return;
  const { centre, width, height, shade, caustics } = state;
  const up = Math.max(0.15, sunDir.y);
  axis.set(-sunDir.x, -sunDir.z);
  const flat = axis.length();
  if (flat < 1e-4) axis.set(0, -1); else axis.divideScalar(flat);
  const slant = Math.min(MAX_SLANT, flat / up);
  const ax = axis.x, az = axis.y;
  const k = Math.max(0, Math.min(1, sunLevel));

  // The shade runs from the sign's foot out to where its top's shadow lands.
  const sx = centre.x + ax * slant * height * 0.5, sz = centre.z + az * slant * height * 0.5;
  placeOval(shade.material.map as THREE.Texture, sx, sz, ax, az, (width + slant * height) * 0.55, width * 0.5);
  shade.material.color.setScalar(k);
  shade.visible = k > 0.01;

  // The focused light lands a little beyond the middle of the shade, a smaller oval.
  const reach = slant * height * 0.6 + width * 0.12;
  const cx = centre.x + ax * reach, cz = centre.z + az * reach;
  caustics.forEach((m, i) => {
    // Two layers drifting and turning against each other: where their networks cross they shimmer.
    const w = time * (0.11 + i * 0.07) + i * 2.1;
    const turn = Math.sin(w) * 0.25 * (i ? -1 : 1);
    const c = Math.cos(turn), s = Math.sin(turn);
    const rx = ax * c - az * s, rz = ax * s + az * c;
    const breathe = 1 + Math.sin(w * 1.3 + i) * 0.06;
    const ox = Math.cos(w * 0.7) * width * 0.04, oz = Math.sin(w * 0.9) * width * 0.04;
    placeOval(m.material.map as THREE.Texture, cx + ox, cz + oz, rx, rz,
      (width * 0.42 + slant * height * 0.25) * breathe, width * 0.3 * breathe);
    m.material.color.copy(sunColor).multiplyScalar(k * CAUSTIC_GAIN * 0.5);
    m.visible = k > 0.01;
  });
}
