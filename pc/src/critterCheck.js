// Shape checks for the critters, run on the tank page with ?check=critters (report in the console, on
// screen and in window.critterCheck). Each critter is voxelised as it stands, over a run of frames
// of its own behaviour and in its extreme poses (a jet, a strike), and must be
//   - one piece: its parts, taken together, form a single connected solid (nothing floats loose);
//   - water tight: filled as a container, the water fills the whole animal. A part's inside must be
//     closed off from the outside by the parts round it, so the inside of a part sits sealed under
//     its skin (a gap where two parts were meant to meet lets the outside in);
//   - free of clipping: no part runs into another, except at the joints the critter lists as
//     attachments (critter.joins, [partA, partB] by mesh name, 'arm*' matching any 'arm...').
// Parts are the critter's meshes; a double-sided mesh is a sheet (a fin skirt, a web): it has no
// inside of its own, but must still join the body and not cut through another part.
import * as THREE from 'three';

const RES = 180;   // voxels along the critter's longest side

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _p = new THREE.Vector3(), _n = new THREE.Vector3();

function partsOf(model) {
  const parts = [];
  model.updateMatrixWorld(true);
  model.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry.attributes.position) return;
    o.geometry.computeBoundingBox();   // arms and skirts are rebuilt each frame: a cached box is stale
    parts.push({ mesh: o, name: o.name || 'unnamed', sheet: o.material.side === THREE.DoubleSide || !!o.userData.sheet });
  });
  return parts;
}

// Voxelise every part's surface (dense samples over each triangle, so the shell has no holes a
// 6-connected flood could slip through).
function surfaces(parts, grid) {
  const { o, h, nx, ny } = grid;
  for (const P of parts) {
    const g = P.mesh.geometry, pos = g.attributes.position, ix = g.index, M = P.mesh.matrixWorld;
    const nt = (ix ? ix.count : pos.count) / 3, cells = new Set();
    const vi = (k) => (ix ? ix.getX(k) : k);
    for (let t = 0; t < nt; t++) {
      _a.fromBufferAttribute(pos, vi(3 * t)).applyMatrix4(M);
      _b.fromBufferAttribute(pos, vi(3 * t + 1)).applyMatrix4(M);
      _c.fromBufferAttribute(pos, vi(3 * t + 2)).applyMatrix4(M);
      const e = Math.max(_a.distanceTo(_b), _b.distanceTo(_c), _c.distanceTo(_a));
      const n = Math.max(1, Math.ceil(e / (h / 3)));
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n;
        const x = _a.x + (_b.x - _a.x) * u + (_c.x - _a.x) * v, y = _a.y + (_b.y - _a.y) * u + (_c.y - _a.y) * v, z = _a.z + (_b.z - _a.z) * u + (_c.z - _a.z) * v;
        cells.add(Math.floor((x - o.x) / h) + nx * (Math.floor((y - o.y) / h) + ny * Math.floor((z - o.z) / h)));
      }
    }
    P.surf = Uint32Array.from(cells);
  }
}

// Flood the water in from the grid's edge (6-connected) round the walls marked in wall; returns the
// flooded cells (1) within the box [lo, hi) of cell coordinates.
function flood(grid, wall, lo, hi) {
  const { nx, ny } = grid, out = new Uint8Array(wall.length), q = new Int32Array(wall.length);
  let qn = 0;
  const at = (x, y, z) => x + nx * (y + ny * z);
  const push = (x, y, z) => { const k = at(x, y, z); if (!wall[k] && !out[k]) { out[k] = 1; q[qn++] = k; } };
  for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++)
    if (x === lo[0] || y === lo[1] || z === lo[2] || x === hi[0] - 1 || y === hi[1] - 1 || z === hi[2] - 1) push(x, y, z);
  for (let qi = 0; qi < qn; qi++) {
    const k = q[qi], x = k % nx, y = Math.floor(k / nx) % ny, z = Math.floor(k / (nx * ny));
    if (x > lo[0]) push(x - 1, y, z); if (x < hi[0] - 1) push(x + 1, y, z);
    if (y > lo[1]) push(x, y - 1, z); if (y < hi[1] - 1) push(x, y + 1, z);
    if (z > lo[2]) push(x, y, z - 1); if (z < hi[2] - 1) push(x, y, z + 1);
  }
  return out;
}

const matches = (pat, name) => (pat.endsWith('*') ? name.startsWith(pat.slice(0, -1)) : name === pat);
const joined = (joins, a, b) => joins.some(([p, q]) => (matches(p, a) && matches(q, b)) || (matches(p, b) && matches(q, a)));

// One check of a critter as it stands now.
export function checkShape(critter) {
  const parts = partsOf(critter.model), joins = critter.joins || [];
  const box = new THREE.Box3();
  for (const P of parts) box.expandByObject(P.mesh);
  const size = box.getSize(new THREE.Vector3()), h = Math.max(size.x, size.y, size.z) / RES;
  const o = box.min.clone().subScalar(2 * h);
  const nx = Math.ceil(size.x / h) + 5, ny = Math.ceil(size.y / h) + 5, nz = Math.ceil(size.z / h) + 5, N = nx * ny * nz;
  const grid = { o, h, nx, ny, nz };
  surfaces(parts, grid);
  const cell = (k) => [k % nx, Math.floor(k / nx) % ny, Math.floor(k / (nx * ny))];

  // The whole animal: the water flooded in round every part; what it can't reach is the animal.
  const wall = new Uint8Array(N);
  for (const P of parts) for (const k of P.surf) wall[k] = 1;
  const water = flood(grid, wall, [0, 0, 0], [nx, ny, nz]);

  // One piece: 26-connected pieces of the solid, and the parts in each.
  const comp = new Int32Array(N).fill(-1), sizes = [];
  const q = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (water[s] || comp[s] >= 0) continue;
    const id = sizes.length; let qn = 0; comp[s] = id; q[qn++] = s;
    for (let qi = 0; qi < qn; qi++) {
      const [x, y, z] = cell(q[qi]);
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
        const k = X + nx * (Y + ny * Z);
        if (!water[k] && comp[k] < 0) { comp[k] = id; q[qn++] = k; }
      }
    }
    sizes.push(qn);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  // Every part with skin in a piece other than the main one (a gap cuts it off, or it floats).
  const loose = parts.filter((P) => { for (const k of P.surf) if (comp[k] !== main && sizes[comp[k]] > 2) return true; return false; }).map((P) => P.name);

  // Water tight: points just under each part's skin are sealed from the water (where the part is
  // thick enough for the grid to hold a point under its skin: thinner is solid at this scale).
  const leaks = [], ray = new THREE.Raycaster(), both = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  for (const P of parts) {
    if (P.sheet) continue;
    const g = P.mesh.geometry, pos = g.attributes.position, nor = g.attributes.normal;
    if (!nor) continue;
    const nm = new THREE.Matrix3().getNormalMatrix(P.mesh.matrixWorld), step = Math.max(1, Math.floor(pos.count / 600));
    const mat = P.mesh.material;
    P.mesh.material = both;
    let n = 0, wet = 0;
    for (let i = 0; i < pos.count; i += step) {
      _p.fromBufferAttribute(pos, i).applyMatrix4(P.mesh.matrixWorld);
      _n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      ray.set(_a.copy(_p).addScaledVector(_n, -1e-4), _b.copy(_n).negate());
      ray.far = 3 * h;
      if (ray.intersectObject(P.mesh, false).length) continue;
      _p.addScaledVector(_n, -1.2 * h);
      const k = Math.floor((_p.x - o.x) / h) + nx * (Math.floor((_p.y - o.y) / h) + ny * Math.floor((_p.z - o.z) / h));
      n++; if (water[k]) wet++;
    }
    P.mesh.material = mat;
    // (a gap floods a part's whole inside, so a real leak wets most of its skin; a few wet points are
    // the grid's aliasing at thin edges)
    if (n && wet / n > 0.15) leaks.push({ part: P.name, wet: +(wet / n).toFixed(3) });
  }

  // Clipping: each part's own inside (flooded round its own surface alone, within its own box).
  for (const P of parts) {
    if (P.sheet) { P.inside = new Uint32Array(0); continue; }
    const lo = [Infinity, Infinity, Infinity], hi = [0, 0, 0];
    for (const k of P.surf) { const c = cell(k); for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], c[d] - 1); hi[d] = Math.max(hi[d], c[d] + 2); } }
    const own = new Uint8Array(N);
    for (const k of P.surf) own[k] = 1;
    const wet = flood(grid, own, lo, hi), ins = [];
    for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) {
      const k = x + nx * (y + ny * z);
      if (!wet[k] && !own[k]) ins.push(k);
    }
    P.inside = Uint32Array.from(ins);
  }
  // Two parts clip where the skin of one runs inside the other, unless that is hidden inside a third
  // (arms crossing inside the head they grow from).
  // Only A's inside deeper than a cell under its skin counts: nearer, the grid can't tell a clip
  // from two skins just apart.
  const mark = new Int32Array(N).fill(-1), skin = new Int32Array(N).fill(-1), within = new Uint8Array(N), clip = new Map();
  for (const P of parts) for (const k of P.inside) within[k]++;
  const D = [1, -1, nx, -nx, nx * ny, -nx * ny];
  parts.forEach((A, i) => {
    for (const k of A.surf) skin[k] = i;
    for (const k of A.inside) if (D.every((d) => skin[k + d] !== i)) mark[k] = i;
    parts.forEach((B, j) => {
      if (j === i || joined(joins, A.name, B.name)) return;
      let n = 0;
      for (const k of B.surf) if (mark[k] === i && within[k] === 1) n++;
      const key = i < j ? `${A.name}/${B.name}` : `${B.name}/${A.name}`;
      if (n > 2) clip.set(key, Math.max(n, clip.get(key) || 0));
    });
  });
  const clips = [...clip].map(([pair, voxels]) => ({ pair, voxels }));

  checkShape.last = { parts, grid };   // for poking at a failure in the console
  return { pieces: sizes.filter((s) => s > 2).length, loose, leaks, clips, voxel: +h.toFixed(4) };
}

const ok = (r) => r.pieces === 1 && !r.loose.length && !r.leaks.length && !r.clips.length;

// Each critter's behaviours, held a while each in turn (where it goes: an offset from where it is,
// or null to stay put), on top of whatever it was doing.
const MODES = {
  Cuttlefish: [['cruise', [3, 0, 0]], ['hover', [0.3, 0, 0]], ['rest', null]],
  Octopus: [['forage', [1.5, 0, 0.5]], ['den', null]],
  Turtle: [['cruise', [4, 0, 1]], ['graze', null], ['rest', null]],
};

// Run every critter in the tank through its behaviours and its extreme poses, checking as it goes.
export async function runCritterChecks(aq, { seconds = 12, every = 1.5 } = {}) {
  const { world } = aq, dt = 1 / 30, report = [];
  for (const c of world.critters) {
    const name = c.constructor.name, fails = [];
    let checks = 0;
    const check = (label) => { checks++; const r = checkShape(c); if (!ok(r)) fails.push({ at: label, ...r }); };
    const run = async (label, secs) => {
      for (let t = 0, next = every; t < secs; t += dt) {
        c.update(dt, world);
        if (t >= next) { check(`${label} ${t.toFixed(1)}s`); next += every; await new Promise((r) => setTimeout(r)); }
      }
    };
    await run('as is', seconds);
    for (const [mode, go] of MODES[name] || []) {
      c.mode = mode; c.modeT = 1e3;
      c.target = go ? c.pos.clone().add(new THREE.Vector3(...go)) : c.pos.clone();
      await run(mode, 6);
    }
    c.modeT = 0;
    // Extreme poses: a jet, and the tentacles shot out through a strike.
    if ('jet' in c) {
      if (c._jet) c._jet(world, c.pos.clone().add(new THREE.Vector3(1, 0, 0.5)));   // its own start (a jet out of a den goes out of its mouth)
      else { c.mode = 'jet'; c.modeT = 1.4; c.jet = 1; }
      for (let i = 1; i <= 36; i++) { c.update(dt, world); if (i % 6 === 0) check(`jet +${i}`); }
    }
    if ('strike' in c) for (const s of [0.3, 0.2, 0.1]) { c.strike = s + dt; c.update(dt, world); check(`strike ${s}`); }
    report.push({ critter: name, checks, fails });
    console.log(`critter check: ${name} done, ${fails.length} failed`);
  }
  return report;
}

// The ?check=critters entry point: run, then print the report.
export async function main(aq) {
  const report = await runCritterChecks(aq);
  window.critterCheck = report;
  const lines = report.map((r) => `${r.fails.length ? 'FAIL' : 'ok  '} ${r.critter}: ${r.fails.length} of ${r.checks} checks failed` +
    r.fails.slice(0, 6).map((f) => `\n     ${f.at}: pieces ${f.pieces}` + (f.loose.length ? `, loose ${f.loose.join(' ')}` : '') +
      (f.leaks.length ? `, leaks ${f.leaks.map((l) => `${l.part} ${l.wet}`).join(' ')}` : '') +
      (f.clips.length ? `, clips ${f.clips.map((x) => `${x.pair} ${x.voxels}`).join(' ')}` : '')).join(''));
  console.log('critter shape check\n' + lines.join('\n'));
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;left:8px;top:8px;z-index:20;margin:0;padding:8px;background:#000c;color:#fff;font:12px monospace;max-width:96vw;white-space:pre-wrap';
  pre.textContent = lines.join('\n');
  document.body.appendChild(pre);
  return report;
}
