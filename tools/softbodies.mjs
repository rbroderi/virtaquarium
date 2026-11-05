// Mesh the critters' blended (distance-field) bodies offline and write them to pc/models/critters/:
//   node tools/softbodies.mjs
// The shapes are in pc/src/softBodies.js, the mesher in pc/src/sdfMesh.js. The output is deterministic
// (no randomness, integer-hash noise), so re-running it rewrites identical files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOFT_BODIES } from '../pc/src/softBodies.js';
import { writeGLB } from '../pc/src/sdfMesh.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'pc/models/critters');
fs.mkdirSync(out, { recursive: true });
for (const [name, build] of Object.entries(SOFT_BODIES)) {
  const t0 = performance.now(), mesh = build(), ms = performance.now() - t0;
  const file = path.join(out, `${name}.glb`), glb = writeGLB(mesh);
  fs.writeFileSync(file, glb);
  console.log(`${name}: ${mesh.attributes.POSITION.array.length / 3} verts, ${mesh.index.length / 3} tris, ${ms.toFixed(0)} ms -> ${path.relative(root, file)} (${(glb.length / 1024).toFixed(0)} KB)`);
}
