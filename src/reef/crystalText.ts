// The etched text on the crystal sign, and the message source that drives it. The face's transmission
// and roughness maps are one canvas: red = clarity (1 clear, 0 etched), green = frost (roughness).
// Messages rotate with a gentle fade; a message that carries a URL is clickable (see ui.ts).
import * as THREE from 'three';
import { isRecord } from '../util.js';
import { crystalFaceMaterial } from './crystal.js';
import { DEFAULT_CRYSTAL_TEXT, DEFAULT_LABEL, renderMask } from './crystalMask.js';

/** One message a source can show on the crystal. */
export interface CrystalMessage {
  readonly text: string | string[];
  readonly url?: string;
  readonly impressionUrl?: string;
  /** Kept for source compatibility; defaults to empty (nothing is etched under the product). */
  readonly label?: string;
  /** The click card's small-print disclosure line (set by the source; Amazon sets its own). */
  readonly disclosure?: string;
}

/** A provider seam: a JSON file now, later an affiliate list or a native-ad feed. */
export interface CrystalAdSource {
  messages(): Promise<readonly CrystalMessage[]>;
}

/** The default placeholder, shown when no source provides messages. */
export const DEFAULT_CRYSTAL_MESSAGE: CrystalMessage = { text: [...DEFAULT_CRYSTAL_TEXT], label: DEFAULT_LABEL };

const DEFAULT_INTERVAL_S = 20;
const DEFAULT_FADE_S = 0.9;

/** Validates an unknown parsed JSON document into CrystalMessage[] (anti-corruption, unit-tested). */
export function parseCrystalMessages(raw: unknown): CrystalMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: CrystalMessage[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const text: unknown = entry['text'];
    let lines: string[] | null = null;
    if (typeof text === 'string') lines = [text.trim()].filter((t) => t.length > 0);
    else if (Array.isArray(text)) lines = text.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter((t) => t.length > 0);
    if (!lines || lines.length === 0) continue;
    const url = typeof entry['url'] === 'string' && entry['url'].length > 0 ? entry['url'] : undefined;
    const impressionUrl = typeof entry['impressionUrl'] === 'string' && entry['impressionUrl'].length > 0 ? entry['impressionUrl'] : undefined;
    const label = typeof entry['label'] === 'string' && entry['label'].length > 0 ? entry['label'] : DEFAULT_LABEL;
    const disclosure = typeof entry['disclosure'] === 'string' && entry['disclosure'].length > 0 ? entry['disclosure'] : undefined;
    out.push({ text: lines, ...(url !== undefined ? { url } : {}), ...(impressionUrl !== undefined ? { impressionUrl } : {}), label, ...(disclosure !== undefined ? { disclosure } : {}) });
  }
  return out;
}

/** Reads the message list from a JSON file (web/models/crystal.json). */
export class JsonCrystalAdSource implements CrystalAdSource {
  constructor(private readonly url: string) {}
  async messages(): Promise<readonly CrystalMessage[]> {
    try {
      const res = await fetch(this.url, { cache: 'no-cache' });
      return res.ok ? parseCrystalMessages(await res.json()) : [];
    } catch {
      return [];
    }
  }
}

/** A tiny beacon, fired once per showing when a message has an impression URL. */
function ping(url: string): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(url);
      return;
    }
  } catch { /* fall through to the image ping */ }
  try {
    const img = new Image();
    img.src = url;
  } catch { /* ignore */ }
}

/** What a click on the tank does, in priority order: a creature, the crystal card, or feeding. */
export type CrystalClickAction = 'select' | 'card' | 'feed';

/** The click priority: creatures first, then a clickable crystal, then feeding (unit-tested). */
export function crystalClickAction(pickedCreature: boolean, crystalHit: boolean, crystalHasUrl: boolean): CrystalClickAction {
  if (pickedCreature) return 'select';
  if (crystalHit && crystalHasUrl) return 'card';
  return 'feed';
}

/** The crystal's etched text: rotation, fade, impressions, hover glow, and the low-level setCrystalText API. */
export class CrystalSign {
  private messages: readonly CrystalMessage[] = [DEFAULT_CRYSTAL_MESSAGE];
  private index = 0;
  private time = 0;
  private fade = 1;
  private phase: 'in' | 'hold' | 'out' = 'hold';
  private pendingImpression = true;
  private readonly interval: number;
  private readonly fadeSeconds: number;
  private readonly mask: THREE.CanvasTexture;
  private readonly fadeUniform: { value: number };
  private hover = false;

  constructor(private readonly material: THREE.MeshPhysicalMaterial, private readonly source: CrystalAdSource, options: { intervalSeconds?: number; fadeSeconds?: number } = {}) {
    this.interval = options.intervalSeconds ?? DEFAULT_INTERVAL_S;
    this.fadeSeconds = options.fadeSeconds ?? DEFAULT_FADE_S;
    this.mask = material.userData['crystalMask'] as THREE.CanvasTexture;
    this.fadeUniform = material.userData['crystalFade'] as { value: number };
    this.show(0, false);
  }

  /** Loads the source's messages and shows the first (keeps the default until they arrive). */
  async start(): Promise<void> {
    const loaded = await this.source.messages();
    if (loaded.length) {
      this.messages = loaded;
      this.index = 0;
      this.time = 0;
      this.phase = 'hold';
      this.pendingImpression = true;
      this.show(0, false);
    }
  }

  /** What a click on the tank does, in priority order: a creature, the crystal card, or feeding. */
  // (crystalClickAction lives outside the class, below.)

  /** The message currently shown (or about to be shown during a fade). */
  current(): CrystalMessage | null {
    return this.messages[this.index] ?? null;
  }

  hasUrl(): boolean {
    return this.current()?.url !== undefined;
  }

  /** Low-level text API: shows these lines (no label), stopping rotation. */
  setText(lines: readonly string[]): void {
    this.messages = lines.length ? [{ text: lines.slice(), label: '' }] : [DEFAULT_CRYSTAL_MESSAGE];
    this.index = 0;
    this.time = 0;
    this.phase = 'hold';
    this.fade = 1;
    this.pendingImpression = false;
    this.show(0, true);
  }

  /** Advances the rotation and fade; wired into the tank loop's afterStep. */
  update(dt: number): void {
    if (!this.messages.length) return;
    if (this.pendingImpression) {
      this.pendingImpression = false;
      this.fireImpression();
    }
    if (this.phase === 'in') {
      this.fade = Math.min(1, this.fade + dt / this.fadeSeconds);
      if (this.fade >= 1) { this.phase = 'hold'; this.time = 0; this.fireImpression(); }
    } else if (this.phase === 'hold') {
      this.time += dt;
      if (this.time >= this.interval && this.messages.length > 1) this.phase = 'out';
    } else {
      this.fade = Math.max(0, this.fade - dt / this.fadeSeconds);
      if (this.fade <= 0) { this.show(this.index + 1, false); this.phase = 'in'; }
    }
    this.fadeUniform.value = this.fade;
  }

  /** Soft glow on the etched face while the pointer hovers over it. */
  setHover(hover: boolean): void {
    if (this.hover === hover) return;
    this.hover = hover;
    if (hover) {
      this.material.emissive.setRGB(0.035, 0.09, 0.13);
      this.material.emissiveIntensity = 1;
    } else {
      this.material.emissive.setRGB(0, 0, 0);
      this.material.emissiveIntensity = 1;
    }
  }

  private show(i: number, force: boolean): void {
    this.index = ((i % this.messages.length) + this.messages.length) % this.messages.length;
    const msg = this.messages[this.index];
    if (!msg) return;
    renderMask(this.mask.image as HTMLCanvasElement, Array.isArray(msg.text) ? msg.text : [msg.text], msg.label ?? DEFAULT_LABEL);
    this.mask.needsUpdate = true;
    this.fade = force ? 1 : this.fade;
  }

  private fireImpression(): void {
    const url = this.current()?.impressionUrl;
    if (url) ping(url);
  }
}

// A module-level binding so any text source (house ads, sponsor messages) can drive the sign.
let boundSign: CrystalSign | null = null;

/** Binds the single sign (called by main after the reef is built). */
export function bindCrystalSign(sign: CrystalSign): void {
  boundSign = sign;
}

/** Shows arbitrary lines on the crystal face. */
export function setCrystalText(lines: string[]): void {
  boundSign?.setText(lines);
}

/** Builds the sign for the loaded face material, or null when the crystal isn't present. */
export function crystalSign(source: CrystalAdSource, options?: { intervalSeconds?: number; fadeSeconds?: number }): CrystalSign | null {
  const material = crystalFaceMaterial();
  return material ? new CrystalSign(material, source, options) : null;
}
