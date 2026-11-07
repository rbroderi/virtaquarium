// The tank page's URL switches, parsed once into a typed, read-only record. The tank document itself
// (?tank= ?seed= ?clock= ?feed= ?drift= ?scenery=) goes through the config gate (config/tankConfig.ts);
// these are rendering and debugging options around it.
import { viewOptions, type ViewOptions } from '../view.js';
import { toneFor, type ToneCurve } from '../rig.js';

export type CheckName = 'motion' | 'look' | 'critters' | 'startup' | 'perf';
const CHECKS: readonly CheckName[] = ['motion', 'look', 'critters', 'startup', 'perf'];
const isCheckName = (v: string | null): v is CheckName => v !== null && (CHECKS as readonly string[]).includes(v);

/** f/5.6 keeps most of the reef sharp with the far rock and near-glass motes softened. */
const DEFAULT_F_NUMBER = 5.6;

export interface AppOptions {
  /** Camera model (depth of field, lens fall-off, grain); ?photo=0 turns it off. */
  readonly photo: boolean;
  readonly fNumber: number;
  /** The room's reflection in the front glass: off unless ?glass=1. */
  readonly glass: boolean;
  /** Baked reef light; ?reeflight=0 to compare. */
  readonly reefLight: boolean;
  /** Compile shaders in parallel during startup; ?precompile=0 to measure without. */
  readonly precompile: boolean;
  /** Per-object motion blur; ?blur=0 turns it off. */
  readonly motionBlur: boolean;
  /** ?tripo=0: procedural rocks and corals only. */
  readonly generatedScenery: boolean;
  readonly rig: string;
  readonly tone: ToneCurve;
  readonly view: ViewOptions;
  /** ?capture keeps the drawing buffer so a frame can be read back. */
  readonly capture: boolean;
  readonly profile: boolean;
  readonly check: CheckName | null;
  /** A check other than critters/startup steps the tank itself, so the page runs no animation loop. */
  readonly checkDrivesLoop: boolean;
}

export function parseAppOptions(params: URLSearchParams): AppOptions {
  const check = params.get('check');
  return {
    photo: params.get('photo') !== '0',
    fNumber: Number(params.get('fstop')) || DEFAULT_F_NUMBER,
    glass: params.get('glass') === '1',
    reefLight: params.get('reeflight') !== '0',
    precompile: params.get('precompile') !== '0',
    motionBlur: params.get('blur') !== '0',
    generatedScenery: params.get('tripo') !== '0',
    rig: params.get('rig') ?? 'sun',
    tone: toneFor(params),
    // The live view pans by default; checks hold still so their frames stay comparable.
    view: viewOptions(params, check === null),
    capture: params.has('capture'),
    profile: params.get('profile') === '1',
    check: isCheckName(check) ? check : null,
    checkDrivesLoop: check !== null && check !== 'critters' && check !== 'startup',
  };
}
