// Bake Roku assets headlessly: starts the static server, opens pc/bake.html in headless Chrome/Edge,
// and exits when the page reports done. Output lands in roku/assets/.
//   node tools/bake.mjs [--species=a,b] [--seeds=7,42] [--frames=12]
// Set BROWSER=<path to chrome.exe or msedge.exe> if neither is found.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from './serve.mjs';

const CANDIDATES = [
  process.env.BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const browser = CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) { console.error('No Chrome/Edge found; set BROWSER=<path>'); process.exit(1); }

const query = new URLSearchParams();
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--(species|seeds|frames)=(.+)$/);
  if (m) query.set(m[1], m[2]);
}

const TIMEOUT_MS = 10 * 60 * 1000;
let child;
const server = await startServer(0, (ev) => {
  if (ev.type === 'saved') console.log('  wrote', ev.path);
  if (ev.type === 'done') finish(ev.body.startsWith('FAILED') ? 1 : 0, ev.body);
});
const url = `http://localhost:${server.address().port}/pc/bake.html?${query}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'virtaquarium-bake-'));

function finish(code, msg) {
  console.log(msg);
  server.close();
  const cleanup = () => {
    // Chrome can hold profile files briefly after exit; a leftover temp dir is not worth failing over.
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    process.exit(code);
  };
  // Chrome forks helper processes; on Windows only a tree kill takes them all down.
  if (child && process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('exit', cleanup);
  else { child?.kill(); setTimeout(cleanup, 500); }
}

console.log(`Baking with ${path.basename(browser)}: ${url}`);
child = spawn(browser, [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1920,1080', url,
], { stdio: 'ignore' });
child.on('exit', (code) => { if (code) finish(1, `browser exited with code ${code}`); });
setTimeout(() => finish(1, 'timed out'), TIMEOUT_MS).unref();
