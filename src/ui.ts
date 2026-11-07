// Overlay: click to feed or inspect a fish's brain, optional name tags, help, idle cursor hiding, and the
// tank switcher (reef / moon jellies; T or the buttons bottom right reload the page as the other tank).
// Feeding is injected (onFeed), so the page decides what a feed request does (main publishes it on the
// tank's event bus).
import * as THREE from 'three';
import { MODES, type Drives, type Personality, type Mode } from './brain.js';
import { requireElement } from './util.js';
import { inspectHtml, type Inspectable } from './inspect.js';
import type { Fish } from './fish.js';

const DRIVE_LABELS: Readonly<Record<keyof Drives, string>> = {
  hunger: 'Hunger', energy: 'Energy', fear: 'Fear', social: 'Social need', boredom: 'Boredom', parasites: 'Parasites',
};
const TRAIT_LABELS: Readonly<Record<keyof Personality, string>> = {
  boldness: 'Boldness', curiosity: 'Curiosity', activity: 'Activity', sociability: 'Sociability', aggression: 'Aggression', appetite: 'Appetite',
};

const HINT_FADE_MS = 6000;
const IDLE_CURSOR_MS = 3000;
/** The day/night clock readout stays up this long after a clock key. */
const CLOCK_FADE_MS = 2500;
/** A click within this fraction of a fish's length of it selects the fish (fish are small and moving). */
const PICK_RADIUS = 0.6;
/** The F key drops food within +-half this of the tank's centre. */
const KEY_FEED_SPREAD = 8;
/** Options shown in the brain panel, and the smallest score worth showing. */
const TOP_OPTIONS = 5, MIN_SCORE = 0.01, MIN_SCORE_SCALE = 1.5;
const TAG_LIFT_PX = 28;

/** What the overlay reads from the running tank. */
export interface UIWorld {
  readonly fish: readonly Fish[];
}

/** The renderer surface the UI needs (both WebGL and WebGPU renderers expose `domElement`). */
interface RendererSurface { readonly domElement: HTMLCanvasElement }

export interface UIOptions {
  readonly world: UIWorld;
  /** Other animated creatures (critters, jellies) that can be clicked and inspected. */
  readonly inspectables: readonly Inspectable[];
  readonly camera: THREE.Camera;
  readonly renderer: RendererSurface;
  /** Food requested at x (world units). */
  readonly onFeed: (x: number) => void;
  /** The tank on show, and whether to offer switching to the other one (not during checks). */
  readonly scenery: TankKind;
  readonly switcher: boolean;
}

/** The tanks the switcher offers. */
export type TankKind = 'reef' | 'jelly';

/** Reloads the page as the given tank, keeping the rest of the URL. */
function switchTank(to: TankKind): void {
  const url = new URL(location.href);
  if (to === 'reef') url.searchParams.delete('scenery'); else url.searchParams.set('scenery', to);
  location.assign(url.href);
}

const typedEntries = <K extends string, V>(o: Readonly<Record<K, V>>): [K, V][] => Object.entries(o) as [K, V][];

function bar(label: string, v: number, cls = ''): string {
  return `<div class="row"><span>${label}</span><div class="bar ${cls}"><i style="width:${Math.round(v * 100)}%"></i></div></div>`;
}

export class UI {
  private selected: Fish | Inspectable | null = null;
  private showTags = false;
  private clockTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly ray = new THREE.Raycaster();
  private readonly projected = new THREE.Vector3();
  private readonly panel = requireElement('brain', HTMLDivElement);
  private readonly tags = requireElement('tags', HTMLDivElement);
  private readonly help = requireElement('help', HTMLDivElement);
  private readonly hint = requireElement('hint', HTMLDivElement);
  private readonly clock = requireElement('clock', HTMLDivElement);
  private readonly tagOf = new Map<Fish, HTMLDivElement>();
  private readonly world: UIWorld;
  private readonly inspectables: readonly Inspectable[];
  private readonly camera: THREE.Camera;
  private readonly renderer: RendererSurface;
  private readonly onFeed: (x: number) => void;
  private readonly scenery: TankKind;
  private readonly switcher: boolean;

  constructor({ world, inspectables, camera, renderer, onFeed, scenery, switcher }: UIOptions) {
    this.scenery = scenery;
    this.switcher = switcher;
    this.world = world;
    this.inspectables = inspectables;
    this.camera = camera;
    this.renderer = renderer;
    this.onFeed = onFeed;
    setTimeout(() => this.hint.classList.add('fade'), HINT_FADE_MS);
    for (const f of world.fish) {
      const el = document.createElement('div');
      el.className = 'tag';
      this.tags.appendChild(el);
      this.tagOf.set(f, el);
    }
    renderer.domElement.addEventListener('pointerdown', (e) => this.click(e));
    window.addEventListener('keydown', (e) => this.key(e));
    this.hideIdleCursor();
    if (switcher) this.showSwitcher();
  }

  private showSwitcher(): void {
    const box = requireElement('tanks', HTMLDivElement);
    for (const b of box.querySelectorAll<HTMLButtonElement>('button[data-scenery]')) {
      const to = b.dataset['scenery'] === 'jelly' ? 'jelly' : 'reef';
      b.setAttribute('aria-pressed', String(to === this.scenery));
      b.addEventListener('click', () => { if (to !== this.scenery) switchTank(to); });
    }
    box.classList.add('show');
    // Shown while the hint is, before the idle cursor hides it, so a visitor sees it's there.
    document.body.classList.add('fresh');
    setTimeout(() => document.body.classList.remove('fresh'), HINT_FADE_MS);
  }

  private key(e: KeyboardEvent): void {
    const k = e.key.toLowerCase();
    if (k === 'b') {
      this.showTags = !this.showTags;
      this.tags.style.display = this.showTags ? 'block' : 'none';
    }
    if (k === 'h' || k === '?') this.help.classList.toggle('show');
    if (k === 'f') this.onFeed((Math.random() - 0.5) * KEY_FEED_SPREAD);
    if (k === 'escape') this.select(null);
    if (k === 't' && this.switcher) switchTank(this.scenery === 'jelly' ? 'reef' : 'jelly');
    if (k === 'tab') {
      e.preventDefault();
      this.cycle();
    }
  }

  /** Show the day/night clock briefly (time, and the rate when it isn't 1x). */
  showClock(clock: { hour(): number | null; rate(): number }): void {
    const hour = clock.hour();
    if (hour === null) return;
    const h = Math.floor(hour) % 24;
    const m = Math.floor((hour - Math.floor(hour)) * 60);
    const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const rate = clock.rate();
    this.clock.textContent = rate === 1 ? time : `${time} · ${rate}×`;
    this.clock.classList.add('show');
    clearTimeout(this.clockTimer);
    this.clockTimer = setTimeout(() => this.clock.classList.remove('show'), CLOCK_FADE_MS);
  }

  private hideIdleCursor(): void {
    let idle: ReturnType<typeof setTimeout> | undefined;
    window.addEventListener('pointermove', () => {
      document.body.classList.remove('idle');
      clearTimeout(idle);
      idle = setTimeout(() => document.body.classList.add('idle'), IDLE_CURSOR_MS);
    });
    document.body.classList.add('idle');
  }

  private ndc(e: PointerEvent): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private click(e: PointerEvent): void {
    this.ray.setFromCamera(this.ndc(e), this.camera);
    // Pick the creature closest to the click ray, relative to its own pick radius, so a small fish
    // directly under the pointer beats a big critter's sphere beside it.
    let best: Fish | Inspectable | null = null, bestD = 1;
    for (const f of this.world.fish) {
      const d = this.ray.ray.distanceToPoint(f.pos) / (f.size * PICK_RADIUS);
      if (d < bestD) { bestD = d; best = f; }
    }
    for (const c of this.inspectables) {
      const d = this.ray.ray.distanceToPoint(c.pos) / c.pickRadius;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) {
      this.select(best);
      return;
    }
    // Otherwise sprinkle food where the click ray meets the middle of the tank.
    const { origin, direction } = this.ray.ray;
    const t = (0 - origin.z) / direction.z;
    this.onFeed(origin.x + direction.x * t);
  }

  private cycle(): void {
    const fish = this.world.fish;
    const i = this.selected && 'brain' in this.selected ? fish.indexOf(this.selected) : -1;
    this.select(fish[(i + 1) % fish.length] ?? null);
  }

  select(f: Fish | Inspectable | null): void {
    this.selected = f;
    this.panel.classList.toggle('show', !!f);
  }

  private panelHtml(f: Fish): string {
    const b = f.brain;
    const scores = (Object.entries(b.scores) as [Mode, number | undefined][])
      .filter((e): e is [Mode, number] => (e[1] ?? 0) > MIN_SCORE)
      .sort((x, y) => y[1] - x[1])
      .slice(0, TOP_OPTIONS);
    const max = Math.max(MIN_SCORE_SCALE, ...scores.map((s) => s[1]));
    return `
        <h2>${f.name}</h2>
        <div class="sp">${f.sp.name} <em>${f.sp.sci}</em></div>
        <div class="thought">“${b.thought}”</div>
        <h3>Drives</h3>
        ${typedEntries(b.drives).map(([k, v]) => bar(DRIVE_LABELS[k], v, k)).join('')}
        <h3>Options considered</h3>
        ${scores.map(([k, v]) => bar(k + (k === b.mode ? ' ✓' : ''), v / max, k === b.mode ? 'on' : 'opt')).join('')}
        <h3>Personality</h3>
        ${typedEntries(b.traits).map(([k, v]) => bar(TRAIT_LABELS[k], v, 'trait')).join('')}
        <p class="fact">${f.sp.fact}</p>`;
  }

  private updateTags(): void {
    const w = window.innerWidth, h = window.innerHeight;
    for (const fish of this.world.fish) {
      const el = this.tagOf.get(fish);
      if (!el) continue;
      this.projected.copy(fish.pos).project(this.camera);
      const x = (this.projected.x * 0.5 + 0.5) * w, y = (-this.projected.y * 0.5 + 0.5) * h - TAG_LIFT_PX;
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      el.textContent = `${fish.name} · ${fish.brain.mode in MODES ? fish.brain.thought : fish.brain.mode}`;
      el.classList.toggle('sel', fish === this.selected);
    }
  }

  update(): void {
    const selected = this.selected;
    if (selected) this.panel.innerHTML = 'brain' in selected ? this.panelHtml(selected) : inspectHtml(selected.inspect());
    if (this.showTags) this.updateTags();
  }
}
