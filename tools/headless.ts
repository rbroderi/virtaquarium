// Shared plumbing for the headless tools (bake, check): find a Chromium browser, run a page in it
// against the static server, and wait for the page to POST /__done.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { startServer, pageUrl, type ServerEvent } from './serve.js';

const BROWSER_CANDIDATES = [
  process.env['BROWSER'],
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter((p): p is string => typeof p === 'string' && p.length > 0);

const WINDOW_SIZE = '--window-size=1920,1080';
const SOFTWARE_GL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const HARDWARE_GL = ['--use-angle=d3d11', '--ignore-gpu-blocklist'];
/** WebGPU in headless Chrome: enable the (unsafe) API; --use-angle=vulkan or --enable-features=Vulkan
 *  leaves requestAdapter empty on Windows, so keep the default Dawn backend past the blocklist. */
const WEBGPU_GL = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
const KILL_GRACE_MS = 500;
const PROFILE_RM_RETRIES = 5, PROFILE_RM_DELAY_MS = 200;
const CONSOLE_LINE_LIMIT = 400;

export function findBrowser(): string {
  const browser = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  if (!browser) {
    console.error('No Chrome/Edge found; set BROWSER=<path>');
    process.exit(1);
  }
  return browser;
}

/** Parses `--name=value` arguments into a record (later ones win). */
export function parseFlags(args: readonly string[], allowed?: ReadonlySet<string>): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of args) {
    const m = /^--([a-zA-Z]+)=(.*)$/.exec(arg);
    if (m?.[1] !== undefined && m[2] !== undefined && (!allowed || allowed.has(m[1]))) flags[m[1]] = m[2];
  }
  return flags;
}

export interface HeadlessRun {
  readonly page: string;
  readonly query: URLSearchParams;
  readonly timeoutMs: number;
  readonly gpu?: boolean;
  /** Keep this profile directory between runs (warm shader cache) instead of a temp one. */
  readonly keepProfile?: string;
  /** Echo the page's console lines (Chrome's --enable-logging) to stdout. */
  readonly echoConsole?: boolean;
  readonly onSaved?: (path: string) => void;
  /** Serve POST /__shot with a CDP screenshot (the WebGPU canvas cannot be read back). */
  readonly shots?: boolean;
}

export interface HeadlessResult {
  readonly ok: boolean;
  readonly body: string;
}

function killTree(child: ChildProcess | undefined, then: () => void): void {
  if (child?.pid !== undefined && process.platform === 'win32') {
    // Chrome forks helper processes; on Windows only a tree kill takes them all down.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('exit', then);
  } else {
    child?.kill();
    setTimeout(then, KILL_GRACE_MS);
  }
}

function removeProfile(dir: string): void {
  // Chrome can hold profile files briefly after exit; a leftover temp dir is not worth failing over.
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: PROFILE_RM_RETRIES, retryDelay: PROFILE_RM_DELAY_MS });
  } catch {
    /* ignored */
  }
}

/** Forwards the page's console lines from Chrome's stderr log, without Chrome's own logging. */
function echoPageConsole(child: ChildProcess): void {
  let buffer = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const m = /:CONSOLE:\d+\] "(.*)", source: /.exec(line);
      const text = m?.[1];
      if (text !== undefined && !text.startsWith('[object Object]')) console.log(`  page: ${text.slice(0, CONSOLE_LINE_LIMIT)}`);
    }
  });
}

// --- CDP screenshot (WebGPU capture: the presented canvas is not readable from the page) ---

interface CdpPage {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Waits for Chrome's chosen debugging port (written into the profile with --remote-debugging-port=0). */
async function cdpPort(profile: string): Promise<number> {
  const file = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    try {
      const port = Number((await fs.promises.readFile(file, 'utf8')).split('\n')[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      /* Chrome has not written it yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Chrome debugging port did not appear');
}

/** Waits for the page target's WebSocket debugger URL. */
async function cdpPageWs(port: number): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = (await res.json()) as readonly { type?: string; webSocketDebuggerUrl?: string }[];
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Chrome page target did not appear');
}

/** Connects to the page over CDP and returns a command sender (attached lazily on the first /__shot). */
async function cdpConnect(profile: string): Promise<CdpPage> {
  const ws = new WebSocket(await cdpPageWs(await cdpPort(profile)));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('CDP websocket failed')));
  });
  let nextId = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.addEventListener('message', (ev: MessageEvent) => {
    const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
    const msg = JSON.parse(text) as { id?: number; result?: unknown; error?: { message?: string } };
    if (msg.id === undefined) return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message ?? 'CDP error'));
    else entry.resolve(msg.result);
  });
  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Page.enable');
  return { send };
}

/** Captures the current page as a PNG (the compositor's view of the presented WebGPU frame). */
async function cdpScreenshot(page: CdpPage): Promise<Buffer | null> {
  const result = (await page.send('Page.captureScreenshot', { format: 'png' })) as { data?: string };
  return result.data ? Buffer.from(result.data, 'base64') : null;
}

/** Runs one page headlessly; resolves when it reports done, the browser dies, or the timeout hits. */
export async function runHeadless(run: HeadlessRun): Promise<HeadlessResult> {
  const browser = findBrowser();
  const profile = run.keepProfile ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vaq-ts-'));
  let child: ChildProcess | undefined;
  let settle: (result: HeadlessResult) => void = () => {};
  const finished = new Promise<HeadlessResult>((resolve) => { settle = resolve; });

  let done = false;
  let cdp: Promise<CdpPage> | null = null;
  const onShot = run.shots
    ? async (): Promise<Buffer | null> => {
        cdp ??= cdpConnect(profile);
        return cdpScreenshot(await cdp);
      }
    : undefined;
  // CHECK_PORT pins the port (the browser's own stores, e.g. ?store=browser, are per origin); else any free one.
  const server = await startServer(Number(process.env['CHECK_PORT'] ?? 0), (event: ServerEvent) => {
    if (event.type === 'saved') run.onSaved?.(event.path);
    else finish(!event.body.startsWith('FAILED'), event.body);
  }, { onShot });

  function finish(ok: boolean, body: string): void {
    if (done) return;
    done = true;
    server.close();
    killTree(child, () => {
      if (!run.keepProfile) removeProfile(profile);
      settle({ ok, body });
    });
  }

  const url = pageUrl(server, run.page, run.query);
  // The page defaults to auto (WebGPU when available, else WebGL); only an explicit ?renderer=webgl
  // should withhold the WebGPU browser flags.
  const webgpu = run.query.get('renderer') !== 'webgl';
  console.log(`${path.basename(browser)}: ${url}`);
  child = spawn(browser, [
    '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    ...(webgpu ? WEBGPU_GL : run.gpu ? HARDWARE_GL : SOFTWARE_GL), WINDOW_SIZE,
    ...(run.shots ? ['--remote-debugging-port=0'] : []),
    ...(run.echoConsole ? ['--enable-logging=stderr', '--v=0'] : []), url,
  ], { stdio: ['ignore', 'ignore', run.echoConsole ? 'pipe' : 'ignore'] });
  if (run.echoConsole) echoPageConsole(child);
  child.on('exit', (code) => { if (code) finish(false, `browser exited with code ${code}`); });
  setTimeout(() => finish(false, 'timed out'), run.timeoutMs).unref();
  return finished;
}
