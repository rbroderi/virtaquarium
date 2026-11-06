// Zero-dependency static server for the TypeScript aquarium build.
//
// Serves the repository root (so /roku/assets/ is reachable, as for the JS build) with the TS pages
// at /ts/web/. Generated data the pages read under /ts/web/models/ and /ts/web/ref/ is layered: a
// file written by this build (ts/web/models/..., git-ignored) wins, otherwise the JS build's shared
// assets in pc/models/ and pc/ref/ are served read-only. POST /__save writes only into the allowed
// output directories; POST /__done reports a headless run's result to the caller (bake / check).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const TS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(TS_ROOT, '..');
const WEB_URL = '/ts/web/';
const DEFAULT_PORT = 8090;

const SAVE_RETRIES = 20;
const SAVE_RETRY_MS = 250;
const HTTP_OK = 200, HTTP_FOUND = 302, HTTP_FORBIDDEN = 403, HTTP_NOT_FOUND = 404, HTTP_ERROR = 500;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
};

/** A URL prefix whose files come from the first directory that has them. */
interface Layer { readonly urlPrefix: string; readonly dirs: readonly string[] }

const LAYERS: readonly Layer[] = [
  { urlPrefix: `${WEB_URL}models/`, dirs: [path.join(TS_ROOT, 'web', 'models'), path.join(REPO_ROOT, 'pc', 'models')] },
  { urlPrefix: `${WEB_URL}ref/`, dirs: [path.join(TS_ROOT, 'web', 'ref'), path.join(REPO_ROOT, 'pc', 'ref')] },
];

/** Directories POST /__save may write into: Roku assets, this build's generated data, check output. */
const WRITABLE = [
  path.join(REPO_ROOT, 'roku'),
  path.join(TS_ROOT, 'web', 'models'),
  path.join(TS_ROOT, 'web', 'ref'),
  path.join(TS_ROOT, 'out'),
];

export type ServerEvent = { readonly type: 'saved'; readonly path: string } | { readonly type: 'done'; readonly body: string };
export type ServerEventListener = (event: ServerEvent) => void;

const isInside = (file: string, dir: string): boolean => file.startsWith(dir + path.sep);
const isSecret = (file: string): boolean => /\.key$/i.test(file) || /[\\/]\./.test(file.slice(REPO_ROOT.length));

function resolveStatic(urlPath: string): string | null {
  for (const layer of LAYERS) {
    if (!urlPath.startsWith(layer.urlPrefix)) continue;
    const rel = urlPath.slice(layer.urlPrefix.length);
    for (const dir of layer.dirs) {
      const file = path.resolve(dir, rel);
      if (isInside(file, dir) && fs.existsSync(file)) return file;
    }
    return null;
  }
  let file = path.resolve(REPO_ROOT, '.' + urlPath);
  if (!file.startsWith(REPO_ROOT) || isSecret(file)) return null;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  return file;
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
  const dest = path.resolve(REPO_ROOT, rel);
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

function handleStatic(url: URL, res: http.ServerResponse): void {
  const urlPath = decodeURIComponent(url.pathname);
  if (urlPath === '/') {
    res.writeHead(HTTP_FOUND, { Location: WEB_URL }).end();
    return;
  }
  const file = resolveStatic(urlPath);
  if (!file) {
    res.writeHead(urlPath.startsWith(WEB_URL) ? HTTP_NOT_FOUND : HTTP_FORBIDDEN).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(HTTP_NOT_FOUND).end('not found');
      return;
    }
    // js-profiling: lets a page sample itself (main ?profile=1, the JS Self-Profiling API).
    res.writeHead(HTTP_OK, {
      'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Document-Policy': 'js-profiling',
    });
    res.end(data);
  });
}

export function startServer(port: number = DEFAULT_PORT, onEvent: ServerEventListener = () => {}): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/__save') void handleSave(url, req, res, onEvent);
    else if (req.method === 'POST' && url.pathname === '/__done') void handleDone(req, res, onEvent);
    else handleStatic(url, res);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

export function serverPort(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

export const pageUrl = (server: http.Server, page: string, query: URLSearchParams): string =>
  `http://localhost:${serverPort(server)}${WEB_URL}${page}?${query.toString()}`;

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env['PORT'] ?? process.argv[2] ?? DEFAULT_PORT);
  void startServer(port).then((s) => console.log(`Virtual aquarium (TypeScript): http://localhost:${serverPort(s)}${WEB_URL}`));
}
