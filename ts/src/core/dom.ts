// Small narrowing helpers for untyped boundaries (DOM lookups, caught errors, parsed JSON).

/** The element with this id, checked to be of the expected class. */
export function requireElement<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} missing or not a ${type.name}`);
  return el;
}

/** A caught value's message (catch variables are `unknown`). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True for a non-null, non-array object, i.e. something parsed JSON can index by key. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
