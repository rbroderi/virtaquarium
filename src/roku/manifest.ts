// roku/assets/manifest.json, as bake.ts writes it, parsed from `unknown` into checked types.
import {
  ManifestError, asArray, asNumber, asNumbers, asObject, asString, asStrings, asTuple2, asTuple4, numberOr, truthy,
  type JsonObject,
} from './json.js';

export type Rect = readonly [x: number, y: number, w: number, h: number];
export type Point = readonly [x: number, y: number];
export interface Size { readonly w: number; readonly h: number }

export interface Tile { readonly file: string; readonly rect: Rect }

export interface WaterLayer {
  readonly rect: Rect;
  readonly frames: readonly string[];
  /** Step overlays towards the next frame, or null for an older bake without them. */
  readonly steps: readonly string[] | null;
}

export interface WaterLoop {
  readonly fps: number;
  readonly scale: number;
  readonly back: WaterLayer | null;
  readonly front: WaterLayer | null;
}

export interface Bubbler { readonly pos: Point; readonly top: number; readonly pxPerUnit: number }
export interface ShelterSpot { readonly pos: Point; readonly kind: string }

export interface SceneEntry {
  readonly backdrop: readonly Tile[];
  readonly foreground: readonly Tile[];
  readonly water: WaterLoop | null;
  readonly floor: readonly number[];
  readonly anemone: Point;
  readonly swimBox: Rect;
  readonly bubbler: Bubbler | null;
  readonly shelters: readonly ShelterSpot[];
}

export interface AnglePage {
  readonly yaw: number;
  readonly sheet: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly cols: number;
  readonly mb: number;
}

export interface SpriteBrain {
  readonly maxSpeed: number;
  readonly zone: readonly [number, number];
  readonly school: number;
  readonly grazer: number;
  readonly activity: number;
  readonly host: boolean;
  readonly prey: boolean;
  readonly shy: number;
  readonly predator: boolean;
}

export interface SpriteSpecies {
  readonly id: string;
  readonly count: number;
  readonly frameW: number;
  readonly frameH: number;
  readonly frames: number;
  readonly angles: readonly AnglePage[];
  /** Degrees cruising fish are shown turned towards the viewer. */
  readonly cruiseYaw: number;
  /** Degrees per second, the pectoral-sculling turn at low speed. */
  readonly turnRate: number;
  readonly lengthPx: number;
  /** Tail beats per second, or null for the player's default rate. */
  readonly tailHz: number | null;
  readonly brain: SpriteBrain;
}

export interface BubbleSheet {
  readonly sheet: string;
  readonly cell: number;
  readonly mm: readonly number[];
  readonly pxPerUnit: number;
}

export interface ViewFraming {
  readonly zoom: number;
  readonly pan: boolean;
  readonly period: number;
  readonly strip: Size;
}

export interface Manifest {
  readonly screen: Size;
  readonly view: ViewFraming;
  readonly pxPerUnit: number;
  readonly species: readonly SpriteSpecies[];
  /** Scenes by key, parsed on demand (parseScene) so only the one shown has to be current. */
  readonly scenery: Readonly<Record<string, unknown>>;
  readonly bubbles: BubbleSheet | null;
}

const DEFAULT_TURN_RATE = 90;   // deg/s
const DEFAULT_PAN_PERIOD = 120; // s

const parseSize = (v: unknown, path: string): Size => {
  const o = asObject(v, path);
  return { w: asNumber(o['w'], `${path}.w`), h: asNumber(o['h'], `${path}.h`) };
};

const parseTile = (v: unknown, path: string): Tile => {
  const o = asObject(v, path);
  return { file: asString(o['file'], `${path}.file`), rect: asTuple4(o['rect'], `${path}.rect`) };
};

function parseWaterLayer(v: unknown, path: string): WaterLayer | null {
  if (!v) return null;
  const o = asObject(v, path);
  return {
    rect: asTuple4(o['rect'], `${path}.rect`),
    frames: asStrings(o['frames'], `${path}.frames`),
    steps: o['steps'] ? asStrings(o['steps'], `${path}.steps`) : null,
  };
}

function parseWater(v: unknown, path: string): WaterLoop | null {
  if (!v) return null;
  const o = asObject(v, path);
  return {
    fps: asNumber(o['fps'], `${path}.fps`),
    scale: asNumber(o['scale'], `${path}.scale`),
    back: parseWaterLayer(o['back'], `${path}.back`),
    front: parseWaterLayer(o['front'], `${path}.front`),
  };
}

function parseBubbler(v: unknown, path: string): Bubbler | null {
  if (!v) return null;
  const o = asObject(v, path);
  return { pos: asTuple2(o['pos'], `${path}.pos`), top: asNumber(o['top'], `${path}.top`), pxPerUnit: asNumber(o['pxPerUnit'], `${path}.pxPerUnit`) };
}

const parseShelter = (v: unknown, path: string): ShelterSpot => {
  const o = asObject(v, path);
  return { pos: asTuple2(o['pos'], `${path}.pos`), kind: asString(o['kind'], `${path}.kind`) };
};

export function parseScene(raw: unknown, key: string): SceneEntry {
  const path = `scenery.${key}`;
  const o = asObject(raw, path);
  if (!Array.isArray(o['backdrop'])) throw new ManifestError('backdrop is not tiled; re-bake');
  return {
    backdrop: asArray(o['backdrop'], `${path}.backdrop`).map((t, i) => parseTile(t, `${path}.backdrop[${i}]`)),
    foreground: asArray(o['foreground'], `${path}.foreground`).map((t, i) => parseTile(t, `${path}.foreground[${i}]`)),
    water: parseWater(o['water'], `${path}.water`),
    floor: asNumbers(o['floor'], `${path}.floor`),
    anemone: asTuple2(o['anemone'], `${path}.anemone`),
    swimBox: asTuple4(o['swimBox'], `${path}.swimBox`),
    bubbler: parseBubbler(o['bubbler'], `${path}.bubbler`),
    shelters: o['shelters'] ? asArray(o['shelters'], `${path}.shelters`).map((s, i) => parseShelter(s, `${path}.shelters[${i}]`)) : [],
  };
}

function parseAngle(v: unknown, path: string): AnglePage {
  const o = asObject(v, path);
  const n = (k: string): number => asNumber(o[k], `${path}.${k}`);
  return { yaw: n('yaw'), sheet: asString(o['sheet'], `${path}.sheet`), x: n('x'), y: n('y'), w: n('w'), h: n('h'), cols: n('cols'), mb: n('mb') };
}

function parseBrain(v: unknown, path: string): SpriteBrain {
  const o = asObject(v, path);
  const n = (k: string): number => asNumber(o[k], `${path}.${k}`);
  return {
    maxSpeed: n('maxSpeed'), zone: asTuple2(o['zone'], `${path}.zone`), school: n('school'), grazer: n('grazer'),
    activity: n('activity'), host: truthy(o['host']), prey: truthy(o['prey']), shy: numberOr(o['shy'], 0), predator: truthy(o['predator']),
  };
}

function parseSpecies(id: string, v: unknown): SpriteSpecies {
  const path = `species.${id}`;
  const o: JsonObject = asObject(v, path);
  if (!o['angles']) throw new ManifestError(`${id}: sprite sheet has no per-angle pages; re-bake`);
  const n = (k: string): number => asNumber(o[k], `${path}.${k}`);
  const tailHz = numberOr(o['tailHz'], 0);
  return {
    id,
    count: numberOr(o['count'], 1),
    frameW: n('frameW'),
    frameH: n('frameH'),
    frames: n('frames'),
    angles: asArray(o['angles'], `${path}.angles`).map((a, i) => parseAngle(a, `${path}.angles[${i}]`)),
    cruiseYaw: numberOr(o['cruiseYaw'], 0),
    turnRate: numberOr(o['turnRate'], DEFAULT_TURN_RATE),
    lengthPx: n('lengthPx'),
    tailHz: tailHz || null,
    brain: parseBrain(o['brain'], `${path}.brain`),
  };
}

function parseBubbles(v: unknown): BubbleSheet | null {
  if (!v) return null;
  const o = asObject(v, 'bubbles');
  return {
    sheet: asString(o['sheet'], 'bubbles.sheet'),
    cell: asNumber(o['cell'], 'bubbles.cell'),
    mm: asNumbers(o['mm'], 'bubbles.mm'),
    pxPerUnit: asNumber(o['pxPerUnit'], 'bubbles.pxPerUnit'),
  };
}

function parseView(v: unknown, screen: Size): ViewFraming {
  if (!v) return { zoom: 1, pan: false, period: DEFAULT_PAN_PERIOD, strip: screen };
  const o = asObject(v, 'view');
  return { zoom: asNumber(o['zoom'], 'view.zoom'), pan: truthy(o['pan']), period: asNumber(o['period'], 'view.period'), strip: parseSize(o['strip'], 'view.strip') };
}

export function parseManifest(raw: unknown): Manifest {
  const o = asObject(raw, 'manifest');
  const screen = parseSize(o['screen'], 'screen');
  return {
    screen,
    view: parseView(o['view'], screen),
    pxPerUnit: asNumber(o['pxPerUnit'], 'pxPerUnit'),
    species: Object.entries(asObject(o['species'], 'species')).map(([id, sp]) => parseSpecies(id, sp)),
    scenery: asObject(o['scenery'], 'scenery'),
    bubbles: parseBubbles(o['bubbles']),
  };
}
