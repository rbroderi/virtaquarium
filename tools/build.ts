// Bundles the browser entry points (src/main.ts, lab.ts, bake.ts, roku.ts) with esbuild into
// web/build/, and writes web/build/source-hash.json: a fingerprint of the sources the baked reef light
// depends on, so its cache (models/cache/reeflight-<key>.bin) is invalidated when they change.
//   tsx tools/build.ts            one build
//   tsx tools/build.ts --watch    rebuild on change
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT_DIR = path.join(ROOT, 'web', 'build');
const ENTRY_POINTS = [
  ...['main', 'lab', 'bake', 'roku'].map((name) => path.join(SRC, `${name}.ts`)),
  path.join(SRC, 'fishModel/variantPainter.worker.ts'),
];

/** Source paths (relative to src/, files or directories) whose code shapes the baked reef light. */
const REEF_LIGHT_SOURCES = [
  'reefLight.ts', 'reefLight', 'reef.ts', 'reef', 'water.ts', 'water', 'rockField.ts', 'sdfMesh.ts',
  'fanWorms.ts', 'parallax.ts', 'util.ts', 'core',
];

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function listFiles(rel: string): string[] {
  const full = path.join(SRC, rel);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [full];
  return fs.readdirSync(full).flatMap((name) => listFiles(path.join(rel, name)));
}

function fnv1a(text: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), FNV_PRIME) >>> 0;
  return h;
}

export function reefLightFingerprint(): string {
  const files = [...new Set(REEF_LIGHT_SOURCES.flatMap(listFiles))].sort();
  let h = FNV_OFFSET;
  for (const file of files) h = fnv1a(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), h);
  return h.toString(16).padStart(8, '0');
}

function writeFingerprint(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'source-hash.json'), JSON.stringify({ reefLight: reefLightFingerprint() }) + '\n');
}

const fingerprintPlugin: esbuild.Plugin = {
  name: 'reef-light-fingerprint',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) writeFingerprint();
    });
  },
};

const options: esbuild.BuildOptions = {
  entryPoints: ENTRY_POINTS,
  outdir: OUT_DIR,
  bundle: true,
  splitting: true,          // the checks are loaded on demand with import()
  format: 'esm',
  target: 'es2022',         // top-level await in the entry modules
  sourcemap: true,
  logLevel: 'info',
  plugins: [fingerprintPlugin],
};

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching src/ ...');
} else {
  await esbuild.build(options);
}
