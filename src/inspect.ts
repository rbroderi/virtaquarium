// A small common inspection interface for the overlay (ui.ts): a clicked fish shows its brain, and
// every other animated creature (critters, jellies) supplies a panel built from its own live state.
// Positions and radii here are click proxies: the real bodies deform, blend or are instanced, so the
// overlay tests a sphere rather than raycasting the drawn geometry.
import type * as THREE from 'three';

/** A line in an inspection panel: a section heading, a labelled text value, or a 0..1 bar. */
export interface InspectRow {
  /** A section heading (drawn like the fish panel's h3). */
  readonly heading?: string;
  readonly label?: string;
  readonly value?: string;
  /** A 0..1 drive, drawn as a bar like the fish panel's drives. */
  readonly bar?: number;
  /** The bar's colour class (e.g. 'fear', 'energy', 'on', 'opt'). */
  readonly cls?: string;
}

export interface InspectPanel {
  readonly title: string;
  /** Common name under the title (when the title is the animal's own name). */
  readonly species?: string;
  readonly sci?: string;
  /** One user-facing line on what it is doing now. */
  readonly note?: string;
  readonly rows: readonly InspectRow[];
  readonly fact?: string;
}

/** Something a click can select and inspect. */
export interface Inspectable {
  /** Click-proxy centre (the body may deform far from this). */
  readonly pos: THREE.Vector3;
  /** Click-proxy radius (world units). */
  readonly pickRadius: number;
  inspect(): InspectPanel;
}

/** World scale: 1 unit = 12.5 cm (README). */
export const CM_PER_UNIT = 12.5;
const METRES_PER_UNIT = 0.125;

/** A speed in units/s as cm/s (or mm/s when very slow). */
export function fmtSpeed(unitsPerS: number): string {
  const cm = Math.abs(unitsPerS) * CM_PER_UNIT;
  return cm < 1 ? `${(cm * 10).toFixed(0)} mm/s` : `${cm < 10 ? cm.toFixed(1) : Math.round(cm)} cm/s`;
}

/** Seconds left as whole seconds (never negative). */
export function fmtSeconds(s: number): string {
  return Number.isFinite(s) ? `${Math.max(0, Math.ceil(s))} s` : '—';
}

/** A height or distance in units as metres. */
export function fmtMetres(units: number): string {
  return `${(units * METRES_PER_UNIT).toFixed(2)} m`;
}

/** 'hover' -> 'Hover' (the state machines use lower-case mode names). */
export function modeLabel(mode: string): string {
  return mode.length ? mode.charAt(0).toUpperCase() + mode.slice(1) : mode;
}

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** A brain as the panel shows it: drives (label, 0..1, bar class), option scores, mode, traits. */
export interface BrainView {
  readonly drives: readonly (readonly [string, number, string])[];
  readonly scores: readonly (readonly [string, number])[];
  readonly mode: string;
  readonly traits: readonly (readonly [string, number])[];
}

/** Options shown, the smallest score worth showing, and the least the bars are scaled to. */
const TOP_OPTIONS = 5, MIN_SCORE = 0.01, MIN_SCORE_SCALE = 1.5;

/** The shared brain sections of every panel (fish and critters): Drives, Options considered, Personality. */
export function brainRows(b: BrainView): InspectRow[] {
  const rows: InspectRow[] = [{ heading: 'Drives' }];
  for (const [label, v, cls] of b.drives) rows.push({ label, bar: v, cls });
  const opts = b.scores.filter(([, s]) => s > MIN_SCORE).sort((x, y) => y[1] - x[1]).slice(0, TOP_OPTIONS);
  if (opts.length) {
    const max = Math.max(MIN_SCORE_SCALE, ...opts.map(([, s]) => s));
    rows.push({ heading: 'Options considered' });
    for (const [m, s] of opts) rows.push({ label: m + (m === b.mode ? ' ✓' : ''), bar: s / max, cls: m === b.mode ? 'on' : 'opt' });
  }
  if (b.traits.length) {
    rows.push({ heading: 'Personality' });
    for (const [label, v] of b.traits) rows.push({ label, bar: v, cls: 'trait' });
  }
  return rows;
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);

/** Panel markup in the same style as the fish brain panel (#brain). */
export function inspectHtml(p: InspectPanel): string {
  let html = `<h2>${esc(p.title)}</h2>`;
  if (p.species || p.sci) html += `<div class="sp">${p.species ? esc(p.species) + ' ' : ''}${p.sci ? `<em>${esc(p.sci)}</em>` : ''}</div>`;
  if (p.note) html += `<div class="thought">“${esc(p.note)}”</div>`;
  for (const row of p.rows) {
    if (row.heading !== undefined) html += `<h3>${esc(row.heading)}</h3>`;
    else if (row.bar !== undefined) html += `<div class="row"><span>${esc(row.label ?? '')}</span><div class="bar ${row.cls ?? ''}"><i style="width:${Math.round(clamp01(row.bar) * 100)}%"></i></div></div>`;
    else if (row.value !== undefined) html += `<div class="row"><span>${esc(row.label ?? '')}</span><span class="val">${esc(row.value)}</span></div>`;
  }
  if (p.fact) html += `<p class="fact">${esc(p.fact)}</p>`;
  return html;
}
