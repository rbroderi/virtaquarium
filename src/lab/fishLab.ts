// The fish lab's scene: one species (or a grid of all of them) mid-water under the tank's lights and
// water, posed swimming or still, through an optional camera model. Implements the LabHost port that
// the reference-photo tool (labRef) drives.
import * as THREE from 'three';
import { SPECIES, type Species } from '../species.js';
import { buildFishModel, loadFishModel, mountPectoral, posePectoral, posePectoralFan, FAN_POSE, type FanPose, type FishModel } from '../fishModel.js';
import type { NormalisedModel } from '../fishModel/customModels.js';
import { PhotoCamera } from '../photo.js';
import { LightRig } from '../rig.js';
import { installUnderwaterMedium, INSCATTER_DAY, makeWaterBackdrop, makeEnvironment, waterUniforms, type WaterBackdrop } from '../water.js';
import { TAU } from '../util.js';
import type { LabHost, ReferenceDebug } from '../labRef/labHost.js';

/** Just behind the front glass, mid-water. */
export const CENTRE = new THREE.Vector3(0, 5, 2.2);
const SUN_COLOR = 0xfff2dc, SUN_INTENSITY = 2.6;
const SUN_DISTANCE = 23;
const SHADOW_MAP_SIZE = 2048, SHADOW_BOX = 2, SHADOW_NEAR = 1, SHADOW_FAR = 60;
const SHADOW_BIAS = -0.0004, SHADOW_NORMAL_BIAS = 0.01, SHADOW_RADIUS = 3;
const SKY_COLOR = 0xdcecff, GROUND_COLOR = 0x8a7458;
const ENVIRONMENT_INTENSITY = 0.35;
const CAMERA_FOV = 30, CAMERA_NEAR = 0.01, CAMERA_FAR = 120;
const MAX_PIXEL_RATIO = 2;
const MAX_DT = 0.05;
const DEFAULT_LIGHT_AZ = 23, DEFAULT_LIGHT_EL = 70;
// Light level (0 night .. 1 day) -> hemisphere, fog and exposure, as the tank does.
const HEMI_NIGHT = 0.12, FOG_NIGHT = 0.06, EXPOSURE = 1.25, EXPOSURE_NIGHT = 0.45;
// Grid layout for "all species".
const GRID_ASPECT = 1.4, GRID_DX = 1.25, GRID_DY = 0.9, GRID_SPAN = 1.3, SINGLE_SPAN = 1.5, FRAMING = 0.9;
// Swim and breathing animation.
const SPIN_DEG_PER_S = 20;
const BODY_HZ = 2.2, FIN_HZ = 3, SWIM_AMP = 0.6, SWIM_FLUTTER = 0.6;
const BREATH_HZ = 1.2, VENT_AMP = 0.035, GAPE_AMP = 0.07;
const ERECT_SLOW_HZ = 0.7, ERECT_SWING = 0.6;
const PECT_RATE = 9;
const FAN_SPREAD = 0.9;
/** The lab's fan pose (opened about the vertical only) and the fans' beat rate and effort while swimming. */
const LAB_FAN_POSE: FanPose = { roll: 0, yaw: FAN_SPREAD, flap: 0 };
const FAN_RATE_SHARE = 0.25, FAN_LAB_BEAT = 0.4;

export interface LabOptions {
  readonly yaw: number;
  readonly pitch: number;
  readonly spin: boolean;
  readonly swim: boolean;
  readonly compare: boolean;
  readonly rig: string;
  readonly photo: boolean;
  readonly fNumber: number;
  /** Still fans in the tank's rest pose (the species' or FAN_POSE) rather than the lab's flat spread. */
  readonly tankFan?: boolean;
}

/** lab.hold({ vent, gape, erect, pect }): pin parts of the pose (null: animate). */
export interface PoseHold {
  vent: number | null;
  gape: number | null;
  erect?: number | null;
  pect?: number | null;
}

export const TONE_MAPPINGS: Readonly<Record<string, THREE.ToneMapping>> = {
  aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping, agx: THREE.AgXToneMapping, none: THREE.NoToneMapping,
};

export class FishLab implements LabHost {
  readonly THREE = THREE;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, CAMERA_NEAR, CAMERA_FAR);
  readonly backdrop: WaterBackdrop;
  readonly rig: LightRig;
  ref?: ReferenceDebug;

  private readonly sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  private readonly hemi = new THREE.HemisphereLight(SKY_COLOR, GROUND_COLOR, 1.0);
  private readonly fog = new THREE.FogExp2(INSCATTER_DAY.clone(), 1.0);
  private readonly photo: PhotoCamera | null;
  private readonly generated = new Map<string, NormalisedModel | null>();
  private readonly holdState: PoseHold = { vent: null, gape: null };
  private models: FishModel[] = [];
  private yaw: number;
  private pitch: number;
  private spinning: boolean;
  private swimming: boolean;
  private readonly tankFan: boolean;
  private comparing: boolean;
  private level = 1;
  private span = 1;
  private showing = 0;
  private t = 0;
  private readonly timer = new THREE.Timer();
  private readonly listeners: { yaw?: (deg: number) => void; swim?: (on: boolean) => void; spin?: (on: boolean) => void } = {};

  constructor(readonly canvas: HTMLCanvasElement, options: LabOptions, readonly species: () => string) {
    this.yaw = options.yaw;
    this.pitch = options.pitch;
    this.spinning = options.spin;
    this.swimming = options.swim;
    this.tankFan = !!options.tankFan;
    this.comparing = options.compare;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;

    installUnderwaterMedium();
    this.backdrop = makeWaterBackdrop();
    this.scene.add(this.backdrop);
    this.scene.fog = this.fog;
    this.scene.environment = makeEnvironment(this.renderer);
    this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
    this.setUpSun();
    this.scene.add(this.hemi);
    // Light presets: 'sun' is the tank's single key light; 'led' previews an aquarium LED bar.
    this.rig = new LightRig(this.scene, this.sun, options.rig);
    this.setLightDir();
    // ?photo=1: through the camera model (photo.ts), focused on the fish.
    this.photo = options.photo ? new PhotoCamera(this.renderer, { depth: true, fNumber: options.fNumber, glass: false }) : null;
  }

  /** Shadows as in the tank, on a tight box around the fish so fins shade the flank crisply. */
  private setUpSun(): void {
    const sun = this.sun;
    sun.position.set(3, 22, 7);
    sun.target.position.copy(CENTRE);
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    Object.assign(sun.shadow.camera, { left: -SHADOW_BOX, right: SHADOW_BOX, top: SHADOW_BOX, bottom: -SHADOW_BOX, near: SHADOW_NEAR, far: SHADOW_FAR });
    sun.shadow.bias = SHADOW_BIAS; sun.shadow.normalBias = SHADOW_NORMAL_BIAS; sun.shadow.radius = SHADOW_RADIUS;
    this.scene.add(sun, sun.target);
  }

  onChange(listeners: FishLab['listeners']): void {
    Object.assign(this.listeners, listeners);
  }

  fish(): readonly FishModel[] { return this.models; }
  get swim(): boolean { return this.swimming; }
  get spin(): boolean { return this.spinning; }
  get compare(): boolean { return this.comparing; }
  get yawDeg(): number { return this.yaw; }

  // ---- LabHost ----
  setYaw(deg: number): void { this.yaw = deg; this.listeners.yaw?.(deg); }
  setPitch(deg: number): void { this.pitch = deg; }
  setSwim(on: boolean): void { this.swimming = on; this.listeners.swim?.(on); }
  setSpin(on: boolean): void { this.spinning = on; this.listeners.spin?.(on); }
  setFov(deg: number): void { this.camera.fov = deg; this.frameCamera(); }

  /** Sun direction in degrees relative to the view: az 0 = from the camera side, el 90 = straight down. */
  setLightDir(az = DEFAULT_LIGHT_AZ, el = DEFAULT_LIGHT_EL): void {
    const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
    this.sun.position.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).multiplyScalar(SUN_DISTANCE).add(CENTRE);
  }

  /** Render one frame now (e.g. right before reading pixels), with the pose applied. */
  render(): void {
    for (const m of this.models) {
      this.orient(m);
      const u = m.uniforms;
      if (this.holdState.vent != null) u.uVent.value = this.holdState.vent;
      if (this.holdState.gape != null && u.uGape) u.uGape.value = this.holdState.gape;
    }
    this.renderer.render(this.scene, this.camera);
  }

  // ---- lab controls ----
  setCompare(on: boolean): void { this.comparing = on; }

  hold(h: Partial<PoseHold>): PoseHold { return Object.assign(this.holdState, h); }

  /** l: light level (0 night .. 1 day); omitted keeps the current level (after a rig change). */
  setLight(l: number = this.level): void {
    this.level = l;
    this.rig.apply(l);
    this.hemi.intensity = HEMI_NIGHT + (1 - HEMI_NIGHT) * l;
    waterUniforms.uCaustic.value = l;
    this.fog.color.copy(INSCATTER_DAY).multiplyScalar(FOG_NIGHT + (1 - FOG_NIGHT) * l);
    this.backdrop.backdropUniforms.uBase.value.copy(this.fog.color);
    this.renderer.toneMappingExposure = EXPOSURE * (EXPOSURE_NIGHT + (1 - EXPOSURE_NIGHT) * l);
  }

  setTone(name: string): void {
    this.renderer.toneMapping = TONE_MAPPINGS[name] ?? THREE.ACESFilmicToneMapping;
    for (const m of this.models) {
      m.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const materials: unknown = o.material;
        for (const mat of Array.isArray(materials) ? materials : [materials]) if (mat instanceof THREE.Material) mat.needsUpdate = true;
      });
    }
  }

  /** compare=1: procedural fish (left) next to its generated model in models/fish/<id>.glb (right). */
  private async generatedModel(id: string): Promise<NormalisedModel | null> {
    if (!this.generated.has(id)) this.generated.set(id, await loadFishModel(`./models/fish/${id}.glb`).catch(() => null));
    return this.generated.get(id) ?? null;
  }

  async show(id: string): Promise<void> {
    const n = ++this.showing;
    const single = SPECIES.find((s) => s.id === id);
    const model = this.comparing && single ? await this.generatedModel(id) : null;
    if (n !== this.showing) return;   // a newer selection won the race
    if (this.comparing && single && !model) console.warn(`No models/fish/${id}.glb to compare against`);
    for (const f of this.models) this.scene.remove(f);
    const list: readonly Species[] = id === 'all' ? SPECIES : single ? (model ? [single, single] : [single]) : [];
    const cols = Math.ceil(Math.sqrt(list.length * GRID_ASPECT));
    this.models = list.map((sp, i) => this.placeModel(sp, i, list.length, cols, model));
    const first = list[0];
    this.span = list.length === 1 && first ? first.size * SINGLE_SPAN : cols * GRID_SPAN;
    this.frameCamera();
  }

  private placeModel(sp: Species, i: number, count: number, cols: number, model: NormalisedModel | null): FishModel {
    const m = model ? buildFishModel(sp, i ? { model } : { procedural: true }) : buildFishModel(sp);
    // Single fish: true size. Grid: every species at the same length so they can be compared.
    const len = count === 1 ? sp.size : 1;
    m.scale.setScalar(len);
    const r = Math.floor(i / cols), c = i % cols, rows = Math.ceil(count / cols);
    m.position.copy(CENTRE).add(count === 1 ? new THREE.Vector3() : new THREE.Vector3((c - (cols - 1) / 2) * GRID_DX, ((rows - 1) / 2 - r) * GRID_DY, 0));
    m.userData['len'] = len;
    m.userData['fanPose'] = sp.pectoral?.pose ?? FAN_POSE;
    m.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = true; });   // as in the tank (fish.ts)
    this.scene.add(m);
    return m;
  }

  private frameCamera(): void {
    const camera = this.camera;
    camera.updateProjectionMatrix();
    camera.position.copy(CENTRE).add(new THREE.Vector3(0, 0, (this.span / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))) * FRAMING));
    camera.lookAt(CENTRE);
  }

  private orient(m: FishModel): void {
    m.rotation.set(THREE.MathUtils.degToRad(this.pitch), THREE.MathUtils.degToRad(this.yaw), 0);
  }

  start(): void {
    const loop = (): void => {
      requestAnimationFrame(loop);
      this.frame();
    };
    loop();
  }

  private fitCanvas(): void {
    const { canvas, renderer, camera } = this;
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = renderer.getPixelRatio();
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  private frame(): void {
    this.fitCanvas();
    const dt = Math.min(this.timer.update().getDelta(), MAX_DT);
    this.t += dt;
    const t = this.t;
    waterUniforms.uTime.value = t;
    if (this.spinning) this.yaw = ((this.yaw + dt * SPIN_DEG_PER_S + 180) % 360) - 180;
    for (const m of this.models) this.animate(m, t);
    this.present();
  }

  private animate(m: FishModel, t: number): void {
    const swim = this.swimming, hold = this.holdState;
    this.orient(m);
    const u = m.uniforms;
    u.uPhase.value = swim ? t * TAU * BODY_HZ : 0;
    u.uFinPhase.value = swim ? t * TAU * FIN_HZ : 0;
    u.uAmp.value = swim ? SWIM_AMP : 0;
    u.uFlutter.value = swim ? SWIM_FLUTTER : 0;
    // Breathing, even when still: the gill covers flare as the mouth closes (fish.ts). hold: fixed
    // values to inspect the mouth and gill opening.
    const br = Math.sin(t * TAU * BREATH_HZ);
    u.uVent.value = hold.vent ?? VENT_AMP * (0.5 + 0.5 * br);
    if (u.uGape) u.uGape.value = hold.gape ?? GAPE_AMP * (0.5 - 0.5 * br);
    // hold.erect: erectile spines (0 lowered, 1 as drawn, 2 raised); else they rise and fall slowly.
    if (u.uErect) u.uErect.value = hold.erect ?? (swim ? 1 + ERECT_SWING * Math.sin(t * ERECT_SLOW_HZ) : 1);
    for (const p of m.pects) {
      // Fans: the lab's own spread (pectoralOutline assumes it), beating and rippling while swimming.
      if (m.fan && swim) posePectoralFan(p, t * PECT_RATE * FAN_RATE_SHARE, FAN_LAB_BEAT, LAB_FAN_POSE);
      else if (m.fan && this.tankFan) {
        const pose = m.userData['fanPose'] as FanPose;
        p.rotation.set(p.side * pose.roll, p.side * pose.yaw, pose.flap);
        p.uPBend?.value.setX(0);
        p.uPWave?.value.set(0, 0);
      } else if (m.fan) {
        p.rotation.set(0, p.side * FAN_SPREAD, 0);
        p.uPBend?.value.setX(0);
        p.uPWave?.value.set(0, 0);
      }
      // hold.pect: a fixed stroke phase, to look at the rays' bend
      else if (hold.pect != null) posePectoral(p, hold.pect, 0.5 + 0.3 * Math.sin(hold.pect), 0.2 + 0.25 * Math.cos(hold.pect));
      else if (swim) posePectoral(p, t * PECT_RATE, 0.5 + 0.3 * Math.sin(t * PECT_RATE), 0.2 + 0.25 * Math.cos(t * PECT_RATE));
      else posePectoral(p, -Math.PI / 2, 0.5, 0);   // glide pose: half open, flat
      if (!m.custom) mountPectoral(p, u);   // ride on the body wave
    }
  }

  private present(): void {
    const { photo, renderer, scene, camera } = this;
    if (!photo) {
      renderer.render(scene, camera);
      return;
    }
    photo.focus = camera.position.distanceTo(CENTRE);
    renderer.setRenderTarget(photo.begin());
    renderer.render(scene, camera);
    photo.finish(photo.target.depthTexture, camera, this.t);
  }
}
