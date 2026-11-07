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
/** WebGPU in headless Chrome: enable the (unsafe) API and force the Vulkan backend past the blocklist. */
const WEBGPU_GL = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist'];
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

/** Runs one page headlessly; resolves when it reports done, the browser dies, or the timeout hits. */
export async function runHeadless(run: HeadlessRun): Promise<HeadlessResult> {
  const browser = findBrowser();
  const profile = run.keepProfile ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vaq-ts-'));
  let child: ChildProcess | undefined;
  let settle: (result: HeadlessResult) => void = () => {};
  const finished = new Promise<HeadlessResult>((resolve) => { settle = resolve; });

  let done = false;
  const server = await startServer(0, (event: ServerEvent) => {
    if (event.type === 'saved') run.onSaved?.(event.path);
    else finish(!event.body.startsWith('FAILED'), event.body);
  });

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
  const webgpu = run.query.get('renderer') === 'webgpu';
  console.log(`${path.basename(browser)}: ${url}`);
  child = spawn(browser, [
    '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    ...(webgpu ? WEBGPU_GL : run.gpu ? HARDWARE_GL : SOFTWARE_GL), WINDOW_SIZE,
    ...(run.echoConsole ? ['--enable-logging=stderr', '--v=0'] : []), url,
  ], { stdio: ['ignore', 'ignore', run.echoConsole ? 'pipe' : 'ignore'] });
  if (run.echoConsole) echoPageConsole(child);
  child.on('exit', (code) => { if (code) finish(false, `browser exited with code ${code}`); });
  setTimeout(() => finish(false, 'timed out'), run.timeoutMs).unref();
  return finished;
}
