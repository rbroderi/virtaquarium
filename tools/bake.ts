// Bake Roku assets headlessly: starts the static server, opens web/bake.html in headless Chrome/Edge,
// and exits when the page reports done. Output lands in roku/assets/ (run `npm run build` first; the
// `bake` npm script does).
//   tsx tools/bake.ts [--species=a,b] [--seeds=7,42] [--frames=8] [--yaws=9] [--zoom=1.6] [--pan=0] [--waterFrames=32]
// Set BROWSER=<path to chrome.exe or msedge.exe> if neither is found.
import { parseFlags, runHeadless } from './headless.js';

const BAKE_FLAGS = new Set(['species', 'seeds', 'frames', 'yaws', 'waterFrames', 'waterLoop', 'zoom', 'pan']);
/** 14 fish + a 2x-supersampled scene with the reef light and a 32-frame water loop: ~55 min. */
const TIMEOUT_MS = 100 * 60 * 1000;

const query = new URLSearchParams(parseFlags(process.argv.slice(2), BAKE_FLAGS));
const { ok, body } = await runHeadless({
  page: 'bake.html',
  query,
  timeoutMs: TIMEOUT_MS,
  onSaved: (path) => console.log('  wrote', path),
});
console.log(body);
process.exit(ok ? 0 : 1);
