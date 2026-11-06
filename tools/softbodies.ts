// Mesh the critters' blended (distance-field) bodies offline and write them to web/models/critters/:
//   npm run softbodies
// The shapes are in src/softBodies.ts, the mesher in src/sdfMesh.ts. The output is deterministic
// (no randomness, integer-hash noise), so re-running it rewrites identical files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOFT_BODIES } from '../src/softBodies.js';
import { writeGLB } from '../src/sdfMesh.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web', 'models', 'critters');
const KB = 1024;

fs.mkdirSync(OUT, { recursive: true });
for (const [name, build] of Object.entries(SOFT_BODIES)) {
  const t0 = performance.now(), mesh = build(), ms = performance.now() - t0;
  const file = path.join(OUT, `${name}.glb`), glb = writeGLB(mesh);
  fs.writeFileSync(file, glb);
  const verts = (mesh.attributes['POSITION']?.array.length ?? 0) / 3;
  console.log(`${name}: ${verts} verts, ${mesh.index.length / 3} tris, ${ms.toFixed(0)} ms -> ${path.relative(ROOT, file)} (${(glb.length / KB).toFixed(0)} KB)`);
}
