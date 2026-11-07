// Where the tank's generated caches (painted fish skins, the baked reef light) are kept between visits.
// On the local dev server they are written into the repository through POST /__save (tools/serve.ts),
// so every check and every later run shares them. On a public deploy the server is read-only, so each
// visitor's caches are kept in their own browser instead (Cache Storage), and their next visit loads
// them from there. ?store=browser forces the browser store locally, to try it.

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const STORE_NAME = 'virtaquarium-cache-v1';
/** Reef-light bakes kept per visitor (one per window shape it was baked for; ~50 MB each). */
const KEEP_REEF_LIGHTS = 2;

const forceBrowser = (): boolean => new URLSearchParams(globalThis.location?.search).get('store') === 'browser';

/** Served by the local dev server, which accepts saves into the repository. */
export const isDevServer = (): boolean => LOCAL_HOSTS.includes(globalThis.location?.hostname ?? '') && !forceBrowser();

/** The browser store, or null where there is none (Cache Storage needs a secure context: https or localhost). */
async function browserStore(): Promise<Cache | null> {
  if (isDevServer() || typeof caches === 'undefined') return null;
  try { return await caches.open(STORE_NAME); } catch { return null; }
}

/** The absolute URL a site path (no leading slash) or a page-relative URL stands for. */
const absolute = (url: string): string => new URL(url, globalThis.location.href).href;

/** fetch(), but the visitor's own saved copy first when the caches live in their browser. */
export async function fetchCached(url: string, init?: RequestInit): Promise<Response> {
  const store = await browserStore();
  if (store) {
    try {
      // The query strings on cached files are only cache busters: their keys are checked inside.
      const hit = await store.match(absolute(url), { ignoreSearch: true });
      if (hit) return hit;
    } catch { /* fall through to the network */ }
  }
  return fetch(url, init);
}

/** Whether saveCached can keep anything here (the dev server, or a browser with Cache Storage). */
export const canSaveCache = (): boolean => isDevServer() || typeof caches !== 'undefined';

/**
 * Saves body under a site path (no leading slash, e.g. models/skins/x.png): into the repository on the
 * dev server, into the visitor's browser otherwise. Reef-light bakes are pruned to the newest few.
 */
export async function saveCached(path: string, body: Blob | string): Promise<void> {
  if (isDevServer()) {
    await fetch(`/__save?path=${path}`, { method: 'POST', body });
    return;
  }
  const store = await browserStore();
  if (!store) return;
  const url = absolute('/' + path);
  if (/\/reeflight-[^/]*\.bin$/.test(url)) await pruneReefLights(store, url);
  await store.put(url, new Response(body));
}

async function pruneReefLights(store: Cache, keep: string): Promise<void> {
  const old = (await store.keys()).filter((r) => /\/reeflight-[^/]*\.bin$/.test(r.url) && r.url !== keep);
  // keys() lists entries in the order they were added, so the oldest go first.
  for (const r of old.slice(0, Math.max(0, old.length - (KEEP_REEF_LIGHTS - 1)))) await store.delete(r);
}
