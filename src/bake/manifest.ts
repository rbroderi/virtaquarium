// The shape of roku/assets/manifest.json as the bake writes it (roku/manifest.ts parses it back).
import type { PixelSize } from '../view.js';
import type { Rect } from './io.js';

/** [x, y] screen pixels. */
export type ScreenPoint = [number, number];

export interface AngleSheet {
  yaw: number;
  sheet: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cols: number;
  mb: number;
}

export interface SpriteBrain {
  maxSpeed: number;
  zone: [number, number];
  school: number;
  grazer: number;
  territorial: number;
  boldness: number;
  curiosity: number;
  activity: number;
  host: boolean;
  prey: boolean;
  shy: number;
  predator: boolean;
  nocturnal: boolean;
}

export interface FishEntry {
  name: string;
  sci: string;
  fact: string;
  count: number;
  frameW: number;
  frameH: number;
  frames: number;
  angles: AngleSheet[];
  textureMB: number;
  cruiseYaw: number;
  turnRate: number;
  lengthPx: number;
  tailHz?: number;
  brain: SpriteBrain;
}

export interface Tile { file: string; rect: Rect }

export interface WaterLayer { rect: number[]; frames: string[]; steps: string[] }

export interface WaterEntry {
  fps: number;
  scale: number;
  back: WaterLayer | null;
  front: WaterLayer | null;
}

export interface BubblerEntry { pos: ScreenPoint; top: number; pxPerUnit: number }

export interface SceneryEntry {
  scenery: string;
  seed: number;
  backdrop: Tile[];
  foreground: Tile[];
  water: WaterEntry;
  floor: number[];
  anemone: ScreenPoint | null;
  swimBox: [number, number, number, number];
  bubbler: BubblerEntry | null;
  shelters: { pos: ScreenPoint; kind: string }[];
}

export interface BubblesEntry { sheet: string; cell: number; mm: readonly number[]; pxPerUnit: number }

export interface BakeManifest {
  version: 1;
  generated: string;
  screen: PixelSize;
  view: { zoom: number; pan: boolean; period: number; strip: PixelSize };
  pxPerUnit: number;
  species: Record<string, FishEntry>;
  scenery: Record<string, SceneryEntry>;
  bubbles?: BubblesEntry;
}
