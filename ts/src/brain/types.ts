// The brain's vocabulary: behaviour modes, personality traits and drives.

/** Each behaviour mode and how the brain panel describes it. */
export const MODES = {
  cruise: 'Exploring open water',
  school: 'Swimming with the shoal',
  forage: 'Picking at the rock',
  feed: 'Chasing food',
  rest: 'Resting near shelter',
  flee: 'Fleeing!',
  patrol: 'Guarding territory',
  inspect: 'Checking out the glass',
  host: 'Snuggling in the anemone',
  hover: 'Hovering, fins fanned',
  lurk: 'Lurking in its crevice, gulping water',
  stalk: 'Stalking, fins spread',
  clean: 'Dancing at its cleaning station',
  pose: 'Queuing at the cleaning station',
} as const;

export type Mode = keyof typeof MODES;

export const isMode = (value: string): value is Mode => value in MODES;

/** Personality: fixed for life, varies between individuals of the same species (0..1). */
export interface Personality {
  boldness: number;
  curiosity: number;
  activity: number;
  sociability: number;
  aggression: number;
  appetite: number;
}

/** Drives: 0..1, change continuously. */
export interface Drives {
  hunger: number;
  energy: number;
  fear: number;
  social: number;
  boredom: number;
  /** Ectoparasites build up over hours; client species visit the cleaner to shed them. */
  parasites: number;
}

/** Utility of each mode at the last decision (the brain panel shows the top few). */
export type ModeScores = Partial<Record<Mode, number>>;
