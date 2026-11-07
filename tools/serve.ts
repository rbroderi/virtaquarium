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

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ROOT = path.join(REPO_ROOT, 'web');
const DEFAULT_PORT = 8080;

const SAVE_RETRIES = 20;
const SAVE_RETRY_MS = 250;
const HTTP_OK = 200, HTTP_FOUND = 302, HTTP_NOT_MODIFIED = 304, HTTP_FORBIDDEN = 403, HTTP_NOT_FOUND = 404, HTTP_ERROR = 500;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
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
];

/**
 * The only page a public deploy shows is the tank: the reef, or the moon jelly tank (?scenery=jelly).
 * Any other query (checks, tank documents, debug flags) is dropped by redirecting to the clean URL.
 */
function publicPageQuery(q: URLSearchParams): string {
  return q.get('scenery') === 'jelly' ? '?scenery=jelly' : '';
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

function handleStatic(url: URL, req: http.IncomingMessage, res: http.ServerResponse, publicMode: boolean): void {
  let urlPath: string;
  try { urlPath = decodeURIComponent(url.pathname); } catch { res.writeHead(HTTP_NOT_FOUND).end(); return; }
  const rel = urlPath.replace(/^\/+/, '');
  if (publicMode && (rel === '' || rel === 'index.html')) {
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
    // no-cache still lets the browser keep its copy: it revalidates by date and gets a bodiless 304
    // while the file is unchanged, so a return visit doesn't download the ~100 MB of models again.
    const modified = new Date(Math.floor(st.mtimeMs / 1000) * 1000);
    const since = Date.parse(req.headers['if-modified-since'] ?? '');
    const headers = {
      'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Last-Modified': modified.toUTCString(),
      // js-profiling: lets a page sample itself (main ?profile=1, the JS Self-Profiling API).
      'Document-Policy': 'js-profiling',
    };
    if (!Number.isNaN(since) && modified.getTime() <= since) {
      res.writeHead(HTTP_NOT_MODIFIED, headers).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(HTTP_NOT_FOUND).end('not found');
        return;
      }
      res.writeHead(HTTP_OK, headers);
      res.end(data);
    });
  });
}

export interface ServerOptions {
  /** Read-only, for a public deploy: no POST /__save or /__done, and only PUBLIC_PATHS are served. */
  readonly publicMode?: boolean;
}

export function startServer(port: number = DEFAULT_PORT, onEvent: ServerEventListener = () => {}, opts: ServerOptions = {}): Promise<http.Server> {
  const publicMode = opts.publicMode ?? false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && publicMode) res.writeHead(HTTP_FORBIDDEN).end();
    else if (req.method === 'POST' && url.pathname === '/__save') void handleSave(url, req, res, onEvent);
    else if (req.method === 'POST' && url.pathname === '/__done') void handleDone(req, res, onEvent);
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
