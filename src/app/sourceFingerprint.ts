// The build's fingerprint of the sources the baked reef light depends on (tools/build.ts writes
// build/source-hash.json next to the bundle). It keys the reef-light cache; without it the cache key
// still works, it just never matches a stale file by accident.
import { isRecord } from '../core/dom.js';

const MANIFEST = './build/source-hash.json';
const UNKNOWN_FINGERPRINT = 'unbuilt';

export async function loadReefLightFingerprint(fetcher: (url: string) => Promise<Response> = (u) => fetch(u, { cache: 'no-cache' })): Promise<string> {
  try {
    const res = await fetcher(MANIFEST);
    if (!res.ok) return UNKNOWN_FINGERPRINT;
    const json: unknown = await res.json();
    return isRecord(json) && typeof json['reefLight'] === 'string' ? json['reefLight'] : UNKNOWN_FINGERPRINT;
  } catch {
    return UNKNOWN_FINGERPRINT;
  }
}
