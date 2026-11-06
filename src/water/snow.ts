// Marine snow: fine organic particles sinking at Stokes velocity (~1-3 mm/s) and drifting with the flow.
import * as THREE from 'three';
import { makeCanvas, context2d, range, type Rng } from '../util.js';
import { GLASS_Z, METRES_PER_UNIT, SURFACE_Y } from './medium.js';
import { NO_FLOW, type FlowField } from './flow.js';

const PARTICLE_COUNT = 600;
const DOT_TEXTURE_SIZE = 32;
const BACK_Z = -4;
const GLASS_GAP = 0.1;
const RESPAWN_BELOW_SURFACE = 0.05;
// Stokes: v = 2/9 (dp/mu) g r^2. r = 10-40 um, excess density ~50 kg/m^3.
const RADIUS_MIN_M = 10e-6, RADIUS_MAX_M = 40e-6;
const EXCESS_DENSITY = 50;          // kg/m^3
const WATER_VISCOSITY = 1.0e-3;     // Pa s
const GRAVITY = 9.81;               // m/s^2
const POINT_SIZE = 0.035;
const POINT_OPACITY = 0.5;
const POINT_COLOR = 0xe8f6ff;

function dotTexture(): THREE.CanvasTexture {
  const size = DOT_TEXTURE_SIZE, half = size / 2;
  const canvas = makeCanvas(size, size), g = context2d(canvas);
  const gradient = g.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

const stokesSinkSpeed = (radius: number): number =>
  ((2 / 9) * (EXCESS_DENSITY / WATER_VISCOSITY) * GRAVITY * radius * radius) / METRES_PER_UNIT;

export class MarineSnow {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly positions: Float32Array;
  private readonly positionAttribute: THREE.BufferAttribute;
  private readonly sinkSpeed: Float32Array;
  private readonly p = new THREE.Vector3();
  private readonly f = new THREE.Vector3();

  constructor(scene: THREE.Object3D, private readonly width: number, rng: Rng) {
    const pos = new Float32Array(PARTICLE_COUNT * 3);
    this.sinkSpeed = new Float32Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      pos[i * 3] = range(rng, -width / 2, width / 2);
      pos[i * 3 + 1] = range(rng, 0, SURFACE_Y);
      pos[i * 3 + 2] = range(rng, BACK_Z, GLASS_Z - GLASS_GAP);
      this.sinkSpeed[i] = stokesSinkSpeed(range(rng, RADIUS_MIN_M, RADIUS_MAX_M));
    }
    this.positions = pos;
    this.positionAttribute = new THREE.BufferAttribute(pos, 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.positionAttribute);
    this.points = new THREE.Points(geometry, new THREE.PointsMaterial({
      size: POINT_SIZE, map: dotTexture(), transparent: true, opacity: POINT_OPACITY, depthWrite: false,
      color: POINT_COLOR, blending: THREE.AdditiveBlending,
    }));
    scene.add(this.points);
  }

  update(dt: number, _t: number, flow: FlowField = NO_FLOW): void {
    const a = this.positions, p = this.p, f = this.f, halfWidth = this.width / 2;
    for (let i = 0; i < a.length / 3; i++) {
      const ix = i * 3, iy = ix + 1, iz = ix + 2;
      p.set(a[ix] ?? 0, a[iy] ?? 0, a[iz] ?? 0);
      flow(p, f);
      // (Math.fround: compare the values as the float32 buffer holds them, as the JS build did.)
      let x = Math.fround(p.x + f.x * dt);
      let y = Math.fround(p.y + (f.y - (this.sinkSpeed[i] ?? 0)) * dt);
      const z = p.z + f.z * dt;
      if (y < 0) y = SURFACE_Y - RESPAWN_BELOW_SURFACE;
      if (x > halfWidth) x = Math.fround(x - this.width);
      if (x < -halfWidth) x = Math.fround(x + this.width);
      a[ix] = x; a[iy] = y; a[iz] = z;
    }
    this.positionAttribute.needsUpdate = true;
  }
}
