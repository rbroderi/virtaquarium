// Zero-dependency static server for the aquarium.
//
// Serves web/ as the site root, with the repository's roku/ at /roku/ (the Roku preview reads the
// baked assets from there). POST /__save writes only into the allowed output directories: a path
// starting roku/ or out/ is relative to the repository, anything else to web/ (the pages save under
// their own URL path, e.g. models/skins/...). POST /__done reports a headless run's result to the
// caller (bake / check). Secrets (*.key) and dotfiles are never served.
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
const HTTP_OK = 200, HTTP_FORBIDDEN = 403, HTTP_NOT_FOUND = 404, HTTP_ERROR = 500;

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

function handleStatic(url: URL, res: http.ServerResponse): void {
  const file = resolveStatic(decodeURIComponent(url.pathname));
  if (!file) {
    res.writeHead(HTTP_FORBIDDEN).end();
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

export function startServer(
  port: number = DEFAULT_PORT,
  onEvent: ServerEventListener = () => {},
  onShot?: () => Promise<Buffer | null>,
): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/__save') void handleSave(url, req, res, onEvent);
    else if (req.method === 'POST' && url.pathname === '/__done') void handleDone(req, res, onEvent);
    else if (req.method === 'POST' && url.pathname === '/__shot') void handleShot(res, onShot);
    else handleStatic(url, res);
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
  const port = Number(process.env['PORT'] ?? process.argv[2] ?? DEFAULT_PORT);
  void startServer(port).then((s) => console.log(`Virtual aquarium: http://localhost:${serverPort(s)}/`));
}
