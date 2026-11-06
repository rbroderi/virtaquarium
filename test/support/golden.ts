// Golden fixtures: outputs of the original JavaScript build (recorded before it was removed), which the
// TypeScript code must still reproduce exactly. Stored as JSON in test/goldens/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GOLDEN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'goldens');

export function readGolden(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, `${name}.json`), 'utf8')) as unknown;
}

export function writeGolden(name: string, value: unknown): void {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  fs.writeFileSync(path.join(GOLDEN_DIR, `${name}.json`), JSON.stringify(value) + '\n');
}

/** Plain-data copy, as JSON would store it (drops undefined members). */
export const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v)) as unknown;

/** The sample points the organic-noise goldens were recorded at. */
export const ORGANIC_SAMPLES: readonly (readonly [number, number])[] =
  Array.from({ length: 40 }, (_, i) => [((i * 37) % 101) / 100, ((i * 53) % 97) / 96] as const);

/** Seeds the RNG golden covers, and how many draws per seed. */
export const RNG_SEEDS: readonly number[] = [0, 1, 7, 42, 708, 2 ** 31 - 1];
export const RNG_DRAWS = 200;

/** Seeds the reef layout golden covers. */
export const REEF_SEEDS: readonly number[] = [7, 42];
