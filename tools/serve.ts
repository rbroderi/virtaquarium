// Zero-dependency static server for the aquarium.
//
// Serves web/ as the site root, with the repository's roku/ at /roku/ (the Roku preview reads the
// baked assets from there). POST /__save writes only into the allowed output directories: a path
// starting roku/ or out/ is relative to the repository, anything else to web/ (the pages save under
// their own URL path, e.g. models/skins/...). POST /__done reports a headless run's result to the
// caller (bake / check). Secrets (*.key) and dotfiles are never served. With --public (a deployed
// site) the server is read-only and serves only what the tank page loads (PUBLIC_PATHS); visitors' generated
// caches are kept in their own browsers instead (src/core/cacheStore.ts).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ROOT = path.join(REPO_ROOT, 'web');
const DEFAULT_PORT = 8080;

const SAVE_RETRIES = 20;
const SAVE_RETRY_MS = 250;
const HTTP_OK = 200, HTTP_PARTIAL = 206, HTTP_RANGE_NOT_SATISFIABLE = 416, HTTP_FOUND = 302, HTTP_NOT_MODIFIED = 304, HTTP_FORBIDDEN = 403, HTTP_NOT_FOUND = 404, HTTP_ERROR = 500;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif','.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8', '.webm': 'audio/webm',
};

/** Top-level directories of the repository served (and saved into) as themselves, not under web/. */
const REPO_DIRS = ['roku', 'out'] as const;

/** Directories POST /__save may write into: Roku assets, check output, generated models and refs. */
const WRITABLE = [
  path.join(REPO_ROOT, 'roku'),
  path.join(REPO_ROOT, 'out'),
  path.join(WEB_ROOT, 'models'),
  path.join(WEB_ROOT, 'ref'),
];

export type ServerEvent = { readonly type: 'saved'; readonly path: string } | { readonly type: 'done'; readonly body: string };
export type ServerEventListener = (event: ServerEvent) => void;

const isInside = (file: string, dir: string): boolean => file.startsWith(dir + path.sep);
const isSecret = (file: string, root: string): boolean => /\.key$/i.test(file) || /[\\/]\./.test(file.slice(root.length));

/** Where a site-relative path (no leading slash) lives on disk. */
function resolvePath(rel: string): { root: string; file: string } {
  const top = rel.split('/')[0];
  const root = REPO_DIRS.some((d) => d === top) ? REPO_ROOT : WEB_ROOT;
  return { root, file: path.resolve(root, rel) };
}

function resolveStatic(urlPath: string): string | null {
  const { root, file } = resolvePath(urlPath.replace(/^\/+/, ''));
  if ((file !== root && !isInside(file, root)) || isSecret(file, root)) return null;
  return fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, 'index.html') : file;
}

// ---- Public deploy allowlist ----
// The repository keeps every original (reference photos, Tripo previews, the lab's comparison fish,
// the lab/bake/Roku pages); a public deploy serves only what the tank page itself loads, so none of
// the rest can be fetched. Retired scenery models (scenery.json "retired") are left out too.
const PUBLIC_PATHS: readonly RegExp[] = [
  /^$/, /^index\.html$/,
  /^build\//,                                   // the bundle, its chunks and source-hash.json
  /^models\/[^/]+\.json$/,                      // models.json, scenery.json, crystal.json
  /^models\/critters\/[^/]+\.glb$/,             // soft-body meshes
  /^models\/(skins|cache)\//,                   // generated caches (absent on a deploy unless baked in)
  /^brand\/logo\.webp$/,                        // the processed loading-screen logo (not the original)
  /^audio\/deep-sea-ambience\.webm$/,           // the ambient sound (M)
  /^brand\/poster\.(avif|jpg)$/, /^about\.html$/, /^robots\.txt$/,   // what crawlers get instead
];

/**
 * Crawlers, scrapers and headless browsers that say what they are. They get about.html (a description
 * and a poster image) in place of the tank page, and no bundle, shaders or models, so they don't pull
 * ~30 MB or run the renderer. A client that hides its User-Agent still meets the page's own check
 * (navigator.webdriver, src/main.ts).
 */
const BOT_UA = /bot\b|crawl|spider|slurp|scrape|headless|phantomjs|puppeteer|playwright|selenium|python-requests|python-urllib|aiohttp|httpx|scrapy|curl\/|wget\/|go-http-client|java\/|okhttp|axios\/|node-fetch|undici|libwww|facebookexternalhit|embedly|whatsapp|discord|slack|telegram|preview|gptbot|ccbot|claude|anthropic|perplexity|bytespider|amazonbot|applebot|diffbot|petalbot|semrush|ahrefs|mj12/i;

function isBot(req: http.IncomingMessage): boolean {
  const ua = String(req.headers['user-agent'] ?? '');
  return ua === '' || BOT_UA.test(ua);
}

/**
 * The only page a public deploy shows is the tank: the reef, the open reef (?scenery=openreef) or the
 * moon jelly tank (?scenery=jelly). Any other query (checks, tank documents, debug flags) is dropped by
 * redirecting to the clean URL.
 */
function publicPageQuery(q: URLSearchParams): string {
  const scenery = q.get('scenery');
  return scenery === 'jelly' || scenery === 'openreef' ? `?scenery=${scenery}` : '';
}

let retiredScenery: ReadonlySet<string> | null = null;
function retired(): ReadonlySet<string> {
  if (retiredScenery) return retiredScenery;
  const out = new Set<string>();
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, 'models', 'scenery.json'), 'utf8'));
    if (manifest && typeof manifest === 'object') {
      for (const cfg of Object.values(manifest as Record<string, unknown>)) {
        const c = cfg as { file?: unknown; retired?: unknown } | null;
        if (c && typeof c.file === 'string' && c.retired) out.add(c.file);
      }
    }
  } catch { /* no manifest: nothing retired */ }
  retiredScenery = out;
  return out;
}

function isPublic(rel: string): boolean {
  if (rel.endsWith('.map')) return false;       // source maps stay local
  if (PUBLIC_PATHS.some((re) => re.test(rel))) return true;
  const m = /^models\/(scenery\/[^/]+\.glb)$/.exec(rel);
  return m !== null && !retired().has(m[1] ?? '');
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * On Windows another process (a virus scan, a browser showing the old sheet) can hold the file a
 * moment: write beside it and swap it in, retrying, rather than take the server down.
 */
async function writeAtomically(dest: string, data: Buffer): Promise<void> {
  const tmp = dest + '.part';
  for (let tries = 0; ; tries++) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, dest);
      return;
    } catch (err) {
      if (tries >= SAVE_RETRIES) throw err;
      await sleep(SAVE_RETRY_MS);
    }
  }
}

async function handleSave(url: URL, req: http.IncomingMessage, res: http.ServerResponse, onEvent: ServerEventListener): Promise<void> {
  const rel = url.searchParams.get('path') ?? '';
  const dest = resolvePath(rel.replace(/^\/+/, '')).file;
  if (!WRITABLE.some((d) => isInside(dest, d))) {
    res.writeHead(HTTP_FORBIDDEN).end();
    return;
  }
  try {
    await writeAtomically(dest, await readBody(req));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`save ${rel}: ${message}`);
    res.writeHead(HTTP_ERROR).end(message);
    return;
  }
  onEvent({ type: 'saved', path: rel });
  res.writeHead(HTTP_OK).end('ok');
}

async function handleDone(req: http.IncomingMessage, res: http.ServerResponse, onEvent: ServerEventListener): Promise<void> {
  const body = (await readBody(req)).toString('utf8');
  res.writeHead(HTTP_OK).end('ok');
  onEvent({ type: 'done', body });
}

/** POST /__shot: the page asks the headless tool for a CDP screenshot of the current frame (the WebGPU
 *  canvas cannot be read back). Responds with the PNG bytes, or an error when no capture backend is
 *  attached (the page opened by hand, a WebGL-only run). */
async function handleShot(res: http.ServerResponse, onShot?: () => Promise<Buffer | null>): Promise<void> {
  if (!onShot) {
    res.writeHead(HTTP_ERROR).end('no screenshot backend');
    return;
  }
  try {
    const png = await onShot();
    if (!png) {
      res.writeHead(HTTP_ERROR).end('screenshot failed');
      return;
    }
    res.writeHead(HTTP_OK, { 'Content-Type': 'image/png', 'Content-Length': png.length });
    res.end(png);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`shot: ${message}`);
    res.writeHead(HTTP_ERROR).end(message);
  }
}

function handleStatic(url: URL, req: http.IncomingMessage, res: http.ServerResponse, publicMode: boolean): void {
  let urlPath: string;
  try { urlPath = decodeURIComponent(url.pathname); } catch { res.writeHead(HTTP_NOT_FOUND).end(); return; }
  let rel = urlPath.replace(/^\/+/, '');
  if (publicMode && isBot(req)) {
    if (rel === '' || rel === 'index.html') { rel = 'about.html'; urlPath = '/about.html'; }
    else if (/^(build|models)\//.test(rel)) { res.writeHead(HTTP_FORBIDDEN).end(); return; }
  } else if (publicMode && (rel === '' || rel === 'index.html')) {
    const clean = publicPageQuery(url.searchParams);
    if (clean !== url.search) {
      res.writeHead(HTTP_FOUND, { Location: '/' + clean }).end();
      return;
    }
  }
  const file = publicMode && !isPublic(rel) ? null : resolveStatic(urlPath);
  if (!file) {
    res.writeHead(HTTP_FORBIDDEN).end();
    return;
  }
  fs.stat(file, (statErr, st) => {
    if (statErr || !st.isFile()) {
      res.writeHead(HTTP_NOT_FOUND).end('not found');
      return;
    }
    const modified = new Date(Math.floor(st.mtimeMs / 1000) * 1000);
    const known = etagCache.get(file);
    const etag = known && known.mtimeMs === st.mtimeMs && known.size === st.size ? known.etag : null;
    const headers: Record<string, string> = {
      'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      // no-cache still lets the browser keep its copy: it revalidates and gets a bodiless 304 while the
      // content is unchanged. Split chunks carry a content hash in their name, so they never change.
      'Cache-Control': HASHED_NAME.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache',
      // The body may be brotli/gzip-encoded by what the client accepts (sendBody).
      // The page at / depends on the User-Agent in public mode (crawlers get about.html).
      'Vary': publicMode && rel.endsWith('.html') ? 'Accept-Encoding, User-Agent' : 'Accept-Encoding',
      'Last-Modified': modified.toUTCString(),
      // js-profiling: lets a page sample itself (main ?profile=1, the JS Self-Profiling API).
      'Document-Policy': 'js-profiling',
    };
    const reply = (tag: string, data: Buffer | null): void => {
      headers['ETag'] = tag;
      if (notModified(req, tag, modified)) {
        res.writeHead(HTTP_NOT_MODIFIED, headers).end();
        return;
      }
      if (data) {
        sendBody(file, st.mtimeMs, data, req, res, headers);
        return;
      }
      fs.readFile(file, (err, body) => {
        if (err) res.writeHead(HTTP_NOT_FOUND).end('not found');
        else sendBody(file, st.mtimeMs, body, req, res, headers);
      });
    };
    if (etag) {
      reply(etag, null);
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(HTTP_NOT_FOUND).end('not found');
        return;
      }
      const tag = contentTag(data);
      etagCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, etag: tag });
      reply(tag, data);
    });
  });
}

/** esbuild's split chunks (name-HASH.js and their maps): the name changes whenever the content does. */
const HASHED_NAME = /^build\/[\w-]+-[A-Z0-9]{8}\.js(\.map)?$/;

/** Content ETags by file, valid while its mtime and size are unchanged. A redeploy touches every file's
 *  mtime, but an unchanged file keeps its tag, so returning visitors get a 304 rather than the models again. */
const etagCache = new Map<string, { readonly mtimeMs: number; readonly size: number; readonly etag: string }>();

/** Weak, because the body may be sent brotli- or gzip-encoded. */
const contentTag = (data: Buffer): string =>
  `W/"${crypto.createHash('sha1').update(data).digest('base64url').slice(0, 22)}"`;

/** If-None-Match wins over If-Modified-Since when both are sent (RFC 9110 13.2.2). */
function notModified(req: http.IncomingMessage, etag: string, modified: Date): boolean {
  const match = req.headers['if-none-match'];
  if (match !== undefined) {
    const strip = (t: string): string => t.trim().replace(/^W\//, '');
    return match.split(',').some((t) => t.trim() === '*' || strip(t) === strip(etag));
  }
  const since = Date.parse(req.headers['if-modified-since'] ?? '');
  return !Number.isNaN(since) && modified.getTime() <= since;
}

/** Already-compressed formats: brotli or gzip would only spend time on them. */
const PRECOMPRESSED = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.webm']);
const MIN_COMPRESS_BYTES = 1024;
/** Brotli 11 takes seconds per megabyte; quality 5 is ~50x faster and within ~10% of it, so only small
 *  files get 11. The first request for a file waits for its compression, later ones hit the cache. */
const BROTLI_MAX = 11, BROTLI_FAST = 5, BROTLI_MAX_BYTES = 64 * 1024;
/** A compressed copy must be at least this much smaller to be worth sending. */
const MIN_SAVING = 0.95;
const COMPRESS_CACHE_MAX_BYTES = 256 * 1024 * 1024;

type Encoding = 'br' | 'gzip';
interface Compressed { readonly mtimeMs: number; readonly body: Buffer | null }
/** Compressed copies by encoding and path, kept while the file's mtime is unchanged (LRU by insertion). */
const compressCache = new Map<string, Compressed>();
let compressCacheBytes = 0;

function pickEncoding(req: http.IncomingMessage): Encoding | null {
  const accept = String(req.headers['accept-encoding'] ?? '');
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

function compress(data: Buffer, enc: Encoding): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, out: Buffer): void => (err ? reject(err) : resolve(out));
    if (enc === 'gzip') zlib.gzip(data, { level: zlib.constants.Z_BEST_COMPRESSION }, done);
    else {
      zlib.brotliCompress(data, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: data.length > BROTLI_MAX_BYTES ? BROTLI_FAST : BROTLI_MAX,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        },
      }, done);
    }
  });
}

async function compressedBody(file: string, mtimeMs: number, data: Buffer, enc: Encoding): Promise<Buffer | null> {
  const key = `${enc}:${file}`;
  const hit = compressCache.get(key);
  if (hit && hit.mtimeMs === mtimeMs) {
    compressCache.delete(key);   // refresh its place in the LRU order
    compressCache.set(key, hit);
    return hit.body;
  }
  const out = await compress(data, enc);
  const body = out.length < data.length * MIN_SAVING ? out : null;
  if (hit) compressCacheBytes -= hit.body?.length ?? 0;
  compressCache.delete(key);
  compressCache.set(key, { mtimeMs, body });
  compressCacheBytes += body?.length ?? 0;
  for (const [k, v] of compressCache) {
    if (compressCacheBytes <= COMPRESS_CACHE_MAX_BYTES) break;
    compressCache.delete(k);
    compressCacheBytes -= v.body?.length ?? 0;
  }
  return body;
}

/** Sends a file, brotli- or gzip-encoded when the client accepts it and it actually shrinks. */
function sendBody(file: string, mtimeMs: number, data: Buffer, req: http.IncomingMessage, res: http.ServerResponse,
  headers: Record<string, string>): void {
  const precompressed = PRECOMPRESSED.has(path.extname(file).toLowerCase());
  // Byte ranges for already-compressed files: <audio> asks for them to seek and to restart the loop.
  const range = precompressed ? /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '')) : null;
  if (range && (range[1] || range[2])) {
    const size = data.length;
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(HTTP_RANGE_NOT_SATISFIABLE, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(HTTP_PARTIAL, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1) });
    res.end(data.subarray(start, end + 1));
    return;
  }
  const enc = data.length >= MIN_COMPRESS_BYTES && !precompressed ? pickEncoding(req) : null;
  const plain = (): void => {
    res.writeHead(HTTP_OK, { ...headers, 'Content-Length': String(data.length), ...(precompressed ? { 'Accept-Ranges': 'bytes' } : {}) });
    res.end(data);
  };
  if (!enc) {
    plain();
    return;
  }
  compressedBody(file, mtimeMs, data, enc).then((body) => {
    if (!body) return plain();
    res.writeHead(HTTP_OK, { ...headers, 'Content-Encoding': enc, 'Content-Length': String(body.length) });
    res.end(body);
  }, () => plain());
}

export interface ServerOptions {
  /** Read-only, for a public deploy: no POST /__save or /__done, and only PUBLIC_PATHS are served. */
  readonly publicMode?: boolean;
  /** POST /__shot: a CDP screenshot backend for the WebGPU look check (tools/headless.ts). */
  readonly onShot?: (() => Promise<Buffer | null>) | undefined;
}

export function startServer(port: number = DEFAULT_PORT, onEvent: ServerEventListener = () => {}, opts: ServerOptions = {}): Promise<http.Server> {
  const publicMode = opts.publicMode ?? false;
  const onShot = opts.onShot;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && publicMode) res.writeHead(HTTP_FORBIDDEN).end();
    else if (req.method === 'POST' && url.pathname === '/__save') void handleSave(url, req, res, onEvent);
    else if (req.method === 'POST' && url.pathname === '/__done') void handleDone(req, res, onEvent);
    else if (req.method === 'POST' && url.pathname === '/__shot') void handleShot(res, onShot);
    else handleStatic(url, req, res, publicMode);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

export function serverPort(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

export const pageUrl = (server: http.Server, page: string, query: URLSearchParams): string =>
  `http://localhost:${serverPort(server)}/${page}?${query.toString()}`;

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // bun tools/serve.ts [port] [--public]; a PORT in the environment (Railway sets one) wins.
  const args = process.argv.slice(2);
  const port = Number(process.env['PORT'] ?? args.find((a) => /^\d+$/.test(a)) ?? DEFAULT_PORT);
  const publicMode = args.includes('--public');
  void startServer(port, () => {}, { publicMode }).then((s) =>
    console.log(`Virtual aquarium${publicMode ? ' (public, read-only)' : ''}: http://localhost:${serverPort(s)}/`));
}
