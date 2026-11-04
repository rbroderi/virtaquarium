// Overlay: click to feed or inspect a fish's brain, optional name tags, help, idle cursor hiding.
import * as THREE from 'three';
import { MODES } from './brain.js';

const DRIVE_LABELS = { hunger: 'Hunger', energy: 'Energy', fear: 'Fear', social: 'Social need', boredom: 'Boredom' };
const TRAIT_LABELS = { boldness: 'Boldness', curiosity: 'Curiosity', activity: 'Activity', sociability: 'Sociability', aggression: 'Aggression', appetite: 'Appetite' };

export class UI {
  constructor({ world, camera, renderer, onFeed }) {
    this.world = world;
    this.camera = camera;
    this.renderer = renderer;
    this.onFeed = onFeed;
    this.selected = null;
    this.showTags = false;
    this.ray = new THREE.Raycaster();
    this.v = new THREE.Vector3();

    this.panel = document.getElementById('brain');
    this.tags = document.getElementById('tags');
    this.help = document.getElementById('help');
    this.hint = document.getElementById('hint');
    setTimeout(() => this.hint.classList.add('fade'), 6000);

    for (const f of world.fish) {
      const el = document.createElement('div');
      el.className = 'tag';
      this.tags.appendChild(el);
      f.tagEl = el;
    }

    renderer.domElement.addEventListener('pointerdown', (e) => this._click(e));
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (k === 'b') { this.showTags = !this.showTags; this.tags.style.display = this.showTags ? 'block' : 'none'; }
      if (k === 'h' || k === '?') this.help.classList.toggle('show');
      if (k === 'f') this.onFeed((Math.random() - 0.5) * 8);
      if (k === 'escape') this.select(null);
      if (k === 'tab') { e.preventDefault(); this._cycle(); }
    });
    let idle;
    window.addEventListener('pointermove', () => {
      document.body.classList.remove('idle');
      clearTimeout(idle);
      idle = setTimeout(() => document.body.classList.add('idle'), 3000);
    });
    document.body.classList.add('idle');
  }

  _ndc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  _click(e) {
    const ndc = this._ndc(e);
    this.ray.setFromCamera(ndc, this.camera);
    // Pick the fish closest to the click ray (generous, fish are small and moving).
    let best = null, bestD = Infinity;
    for (const f of this.world.fish) {
      const d = this.ray.ray.distanceToPoint(f.pos);
      if (d < f.size * 0.6 && d < bestD) { bestD = d; best = f; }
    }
    if (best) { this.select(best); return; }
    // Otherwise sprinkle food where the click ray meets the middle of the tank.
    const t = (0 - this.ray.ray.origin.z) / this.ray.ray.direction.z;
    const x = this.ray.ray.origin.x + this.ray.ray.direction.x * t;
    this.onFeed(x);
  }

  _cycle() {
    const fish = this.world.fish;
    const i = this.selected ? fish.indexOf(this.selected) : -1;
    this.select(fish[(i + 1) % fish.length]);
  }

  select(f) {
    this.selected = f;
    this.panel.classList.toggle('show', !!f);
  }

  _bar(label, v, cls = '') {
    return `<div class="row"><span>${label}</span><div class="bar ${cls}"><i style="width:${Math.round(v * 100)}%"></i></div></div>`;
  }

  update() {
    const f = this.selected;
    if (f) {
      const b = f.brain;
      const scores = Object.entries(b.scores).filter(([, v]) => v > 0.01).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const max = Math.max(1.5, ...scores.map((s) => s[1]));
      this.panel.innerHTML = `
        <h2>${f.name}</h2>
        <div class="sp">${f.sp.name} <em>${f.sp.sci}</em></div>
        <div class="thought">“${b.thought}”</div>
        <h3>Drives</h3>
        ${Object.entries(b.drives).map(([k, v]) => this._bar(DRIVE_LABELS[k], v, k)).join('')}
        <h3>Options considered</h3>
        ${scores.map(([k, v]) => this._bar(k + (k === b.mode ? ' ✓' : ''), v / max, k === b.mode ? 'on' : 'opt')).join('')}
        <h3>Personality</h3>
        ${Object.entries(b.traits).map(([k, v]) => this._bar(TRAIT_LABELS[k], v, 'trait')).join('')}
        <p class="fact">${f.sp.fact}</p>`;
    }
    if (this.showTags) {
      const w = window.innerWidth, h = window.innerHeight;
      for (const fish of this.world.fish) {
        this.v.copy(fish.pos).project(this.camera);
        const el = fish.tagEl;
        el.style.transform = `translate(${(this.v.x * 0.5 + 0.5) * w}px, ${(-this.v.y * 0.5 + 0.5) * h - 28}px) translate(-50%, -100%)`;
        el.textContent = `${fish.name} · ${MODES[fish.brain.mode] ? fish.brain.thought : fish.brain.mode}`;
        el.classList.toggle('sel', fish === f);
      }
    }
  }
}
