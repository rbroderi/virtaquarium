// Run a tank check headlessly and print its report: starts the static server, opens
// web/index.html?check=<name>&... in headless Chrome/Edge, and exits when the page reports done.
//   tsx tools/check.ts motion [--seconds=300] [--seed=7]        climb, bobbing, eel roof, cleaning
//   tsx tools/check.ts look [--at=5,30] [--close=station] [--night=1] [--tag=x]   pictures in out/
//   tsx tools/check.ts critters
//   tsx tools/check.ts startup --gpu=1     time each startup stage on the real GPU
// --reeflight=1 runs the slow reef-light bake first (off by default: minutes in software GL).
// Several seeds: --seeds=7,42 runs the check once per seed. --keep=1 keeps one browser profile
// (out/.check-profile) so its GPU shader cache is warm. The page's renderer is auto (WebGPU when the
// browser offers it, else WebGL); --renderer=webgl or --renderer=webgpu pins a backend.
import path from 'node:path';
import { parseFlags, runHeadless } from './headless.js';

const TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_SEED = '7';

const [name = 'motion', ...args] = process.argv.slice(2);
const { seeds, seed, gpu, keep, ...pageFlags } = parseFlags(args);
const flags: Record<string, string> = { reeflight: '0', ...pageFlags };
if (name === 'startup') delete flags['reeflight'];   // time the real startup, light bake included

let failed = false;
for (const runSeed of (seeds ?? seed ?? DEFAULT_SEED).split(',')) {
  const query = new URLSearchParams({ check: name, seed: runSeed, ...flags });
  console.log(`check ${name}, seed ${runSeed}`);
  const { ok, body } = await runHeadless({
    page: 'index.html',
    query,
    timeoutMs: TIMEOUT_MS,
    gpu: gpu === '1',
    // The look check captures frames; under WebGPU the canvas cannot be read back in-page, so the
    // CDP screenshot backend is always attached (the page only uses it when it picked WebGPU).
    shots: name === 'look',
    ...(keep === '1' ? { keepProfile: path.resolve('out/.check-profile') } : {}),
    echoConsole: true,
    onSaved: (p) => console.log('  wrote', p),
  });
  console.log(body);
  failed ||= !ok;
}
process.exit(failed ? 1 : 0);
