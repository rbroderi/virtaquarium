// Run a tank check headlessly and print its report: starts the static server, opens
// pc/index.html?check=<name>&... in headless Chrome/Edge, and exits when the page reports done.
//   node tools/check.mjs motion [--seconds=300] [--seed=7]        climb, bobbing, eel roof, cleaning
//   node tools/check.mjs look [--at=5,30] [--close=station] [--night=1] [--tag=x]   pictures in out/
//   node tools/check.mjs critters
//   node tools/check.mjs startup --gpu=1     time each startup stage (main.js stage()) on the real GPU
// --reeflight=1 runs the slow reef-light bake first (off by default: minutes in software GL).
// Several seeds: --seeds=7,42 runs the check once per seed.
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

const [name = 'motion', ...args] = process.argv.slice(2);
const opts = { reeflight: '0' };
for (const a of args) { const m = a.match(/^--([a-zA-Z]+)=(.*)$/); if (m) opts[m[1]] = m[2]; }
const seeds = (opts.seeds || opts.seed || '7').split(',');
delete opts.seeds; delete opts.seed;
const gpu = opts.gpu === '1';
delete opts.gpu;
if (name === 'startup') delete opts.reeflight;   // time the real startup, light bake included
const TIMEOUT_MS = 20 * 60 * 1000;

function runOnce(seed) {
  return new Promise((resolve) => {
    let child, done = false;
    // --keep=1: one browser profile kept between runs (out/.check-profile), so its GPU shader cache is
    // warm, as for someone who has opened the tank before.
    const keep = opts.keep === '1';
    const profile = keep ? path.resolve('out/.check-profile') : fs.mkdtempSync(path.join(os.tmpdir(), 'vaq-check-'));
    const finish = (ok, body) => {
      if (done) return;
      done = true;
      server.close();
      const cleanup = () => { try { if (!keep) fs.rmSync(profile,{ recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} resolve({ ok, body }); };
      if (child && process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('exit', cleanup);
      else { child?.kill(); setTimeout(cleanup, 500); }
    };
    const server = startServer(0, (ev) => {
      if (ev.type === 'saved') console.log('  wrote', ev.path);
      if (ev.type === 'done') finish(true, ev.body);
    });
    server.then((s) => {
      const q = new URLSearchParams({ check: name, seed, ...opts });
      const url = `http://localhost:${s.address().port}/pc/index.html?${q}`;
      console.log(`check ${name}, seed ${seed}: ${url}`);
      // --gpu=1: the machine's own GPU (for timings) instead of software GL.
      const gl = gpu ? ['--use-angle=d3d11', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
      child = spawn(browser, [
        '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
        ...gl, '--window-size=1920,1080', '--enable-logging=stderr', '--v=0', url,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      // The page's console (errors and info lines), without Chrome's own logging.
      let buf = '';
      child.stderr.on('data', (d) => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) {
          const m = l.match(/:CONSOLE:\d+\] "(.*)", source: .*\/([^/]+:\d+|[^/]+ \(\d+\))/);
          if (m && !m[1].startsWith('[object Object]')) console.log(`  page: ${m[1].slice(0, 400)}`);
        }
      });
      child.on('exit', (code) => { if (code) finish(false, `browser exited with code ${code}`); });
      setTimeout(() => finish(false, 'timed out'), TIMEOUT_MS).unref();
    });
    server.close = () => server.then((s) => s.close());
  });
}

let failed = false;
for (const seed of seeds) {
  const { ok, body } = await runOnce(seed);
  console.log(body);
  failed ||= !ok;
}
process.exit(failed ? 1 : 0);
