// Narrowing readers for parsed JSON: each checks a field's type and throws a ManifestError naming the
// path, so a malformed manifest fails with a clear message instead of a TypeError mid-frame.
import { isRecord } from '../util.js';

export class ManifestError extends Error {}

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown, path: string): JsonObject {
  if (!isRecord(value)) throw new ManifestError(`${path}: expected an object`);
  return value;
}

export function asNumber(value: unknown, path: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Older bakes wrote some numbers (the seed) as strings.
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  throw new ManifestError(`${path}: expected a number`);
}

export function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ManifestError(`${path}: expected a string`);
  return value;
}

export function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new ManifestError(`${path}: expected an array`);
  return value;
}

export const asNumbers = (value: unknown, path: string): readonly number[] =>
  asArray(value, path).map((v, i) => asNumber(v, `${path}[${i}]`));

export const asStrings = (value: unknown, path: string): readonly string[] =>
  asArray(value, path).map((v, i) => asString(v, `${path}[${i}]`));

export function asTuple2(value: unknown, path: string): readonly [number, number] {
  const [a, b] = asNumbers(value, path);
  if (a === undefined || b === undefined) throw new ManifestError(`${path}: expected 2 numbers`);
  return [a, b];
}

export function asTuple4(value: unknown, path: string): readonly [number, number, number, number] {
  const [a, b, c, d] = asNumbers(value, path);
  if (a === undefined || b === undefined || c === undefined || d === undefined) throw new ManifestError(`${path}: expected 4 numbers`);
  return [a, b, c, d];
}

/** A number, or the fallback when the field is missing, zero or not a number (the JS `x || fallback`). */
export function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value !== 0 && Number.isFinite(value) ? value : fallback;
}

export const truthy = (value: unknown): boolean => Boolean(value);
