// Reference photos: web/ref/<sp>/refs.json (served at ./ref/<sp>/ beside the lab page).
//   { "refs": [ { "file", "source", "license", "mirror", "yaw", "pitch", "fov", "rot",
//     "light": { "az", "el" }, "outline": [[x, y], ...], "patches": [{ "name", "x", "y", "r" }] } ] }
// Outline and patches are in photo pixels. Parsed from `unknown` with defaults for missing fields;
// fields this tool doesn't know are kept and written back on save.
import { isRecord } from '../util.js';

export type PhotoPoint = [x: number, y: number];
export interface Patch { readonly name: string; readonly x: number; readonly y: number; readonly r: number }
export interface LightDir { readonly az: number; readonly el: number }

export interface RefPhoto {
  file: string;
  url: string;
  /** A dropped photo not yet saved. */
  blob: Blob | null;
  mirror: boolean;
  yaw: number;
  pitch: number;
  fov: number;
  /** In-plane photo rotation, degrees (fish in photos are rarely level). */
  rot: number;
  light: LightDir | null;
  outline: PhotoPoint[];
  patches: Patch[];
  readonly author: string | null;
  readonly license: string | null;
  readonly source: string | null;
  /** Fields this tool doesn't edit, kept for saving. */
  readonly extra: Readonly<Record<string, unknown>>;
}

export const DEFAULT_FOV = 30;
export const DEFAULT_LIGHT: LightDir = { az: 23, el: 70 };

const KNOWN = new Set(['file', 'url', 'blob', 'mirror', 'yaw', 'pitch', 'fov', 'rot', 'light', 'outline', 'patches', 'author', 'license', 'source']);

const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function parsePoint(v: unknown): PhotoPoint | null {
  return Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number' ? [v[0], v[1]] : null;
}

function parsePatch(v: unknown): Patch | null {
  if (!isRecord(v) || typeof v['name'] !== 'string') return null;
  const { x, y, r } = v;
  return typeof x === 'number' && typeof y === 'number' && typeof r === 'number' ? { name: v['name'], x, y, r } : null;
}

function parseLight(v: unknown): LightDir | null {
  return isRecord(v) && typeof v['az'] === 'number' && typeof v['el'] === 'number' ? { az: v['az'], el: v['el'] } : null;
}

const notNull = <T>(v: T | null): v is T => v !== null;

/** A reference entry with every field present; `dir` resolves a relative `file`. */
export function normaliseRef(raw: unknown, dir: URL | string): RefPhoto {
  const r = isRecord(raw) ? raw : {};
  const file = typeof r['file'] === 'string' ? r['file'] : '';
  const extra = Object.fromEntries(Object.entries(r).filter(([k]) => !KNOWN.has(k)));
  return {
    file,
    url: typeof r['url'] === 'string' && r['url'] ? r['url'] : new URL(file, dir).href,
    blob: r['blob'] instanceof Blob ? r['blob'] : null,
    mirror: r['mirror'] === true,
    yaw: num(r['yaw'], 0),
    pitch: num(r['pitch'], 0),
    fov: num(r['fov'], DEFAULT_FOV),
    rot: num(r['rot'], 0),
    light: parseLight(r['light']),
    outline: Array.isArray(r['outline']) ? r['outline'].map(parsePoint).filter(notNull) : [],
    patches: Array.isArray(r['patches']) ? r['patches'].map(parsePatch).filter(notNull) : [],
    author: strOrNull(r['author']),
    license: strOrNull(r['license']),
    source: strOrNull(r['source']),
    extra,
  };
}

/** The refs.json list in a parsed sidecar ({ refs: [...] }), or [] if there is none. */
export function parseRefSet(json: unknown, dir: URL): RefPhoto[] {
  const list = isRecord(json) ? json['refs'] : undefined;
  return Array.isArray(list) ? list.map((x) => normaliseRef(x, dir)) : [];
}

/** The entry as written to refs.json (no url or blob; optional fields only when set). */
export function serialiseRef(ref: RefPhoto): Record<string, unknown> {
  const out: Record<string, unknown> = {
    mirror: ref.mirror, yaw: ref.yaw, pitch: ref.pitch, fov: ref.fov, light: ref.light, outline: ref.outline, patches: ref.patches,
    file: ref.file,
  };
  if (ref.rot) out['rot'] = ref.rot;
  if (ref.author !== null) out['author'] = ref.author;
  if (ref.license !== null) out['license'] = ref.license;
  if (ref.source !== null) out['source'] = ref.source;
  return { ...out, ...ref.extra };
}
