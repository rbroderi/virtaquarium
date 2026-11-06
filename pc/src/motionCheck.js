// Motion checks, run on the tank page with ?check=motion (report in the console, in window.motionCheck,
// and POSTed to /__done for a headless run). The tank is stepped at 30 Hz for two simulated minutes
// without drawing, and for every fish it measures
//   - jumps: the fastest climb, in body lengths per second (a snap up a coral head shows as a spike);
//   - jitter: up-down reversals of over 2% of a body length that come within half a second of each
//     other (bobbing over branching coral);
// and for each eel, frames where a node of its body (with the head lift the shader adds) is inside a
// cave roof, and where a node of the body as drawn is inside the rock field (eelBodyInRock).
// &probe=10,60: at those seconds, log the eel's chain nodes with the rock distance and the meshes there.
// The eel's burrow (as fish.js inBurrow, repeated here so the measure doesn't depend on the code it checks).
const inBurrow = (f, p) => {
  const b = f.brain, L = f.size;
  if (!b.lurkDir) return false;
  const dx = p.x - b.home.x, dy = p.y - b.home.y, dz = p.z - b.home.z, D = b.lurkDir;
  const s = Math.min(0, Math.max(-0.55 * L, dx * D.x + dy * D.y + dz * D.z)), r = 0.3 + 0.4 * Math.abs(s) / L;
  return (dx - D.x * s) ** 2 + (dy - D.y * s) ** 2 + (dz - D.z * s) ** 2 < r * r;
};
const DT = 1 / 30, FRAMES = 30 * Number(new URLSearchParams(location.search).get('seconds') ?? 120);

export async function main(aq) {
  const { world } = aq;
  const stats = world.fish.map((f) => ({ f, y: f.pos.y, vy: 0, ext: null, rise: 0, jitter: 0, roof: 0 }));
  // Cleaning station: sessions (a client starts posing with the cleaner working on it), seconds of
  // cleaning, which clients came, and how many jolted away (the cleaner cheated or something scared them).
  const st = world.station, cleaning = st && { sessions: 0, seconds: 0, clients: new Set(), jolts: 0 };
  let was = null;
  // Shoal structure, sampled once a second for each shoaling species with 4+ fish: median nearest-
  // neighbour distance (body lengths), polarisation (|mean heading|, 1 = all aligned), and the number of
  // subgroups (fish within 2.5 body lengths of each other count as one group). And the share of fish
  // that are in their shelter.
  const shoals = [...new Set(world.fish.filter((f) => f.sp.brain.school >= 0.8).map((f) => f.sp))]
    .map((sp) => ({ sp, fish: world.fish.filter((f) => f.sp === sp), nnd: [], pol: [], groups: [] }))
    .filter((s) => s.fish.length >= 4);
  let shelteredSum = 0, samples = 0;
  const qs = new URLSearchParams(location.search);
  if (qs.get('night') === '1') aq.setLight(0);
  if (qs.has('light')) aq.setLight(Number(qs.get('light')));   // e.g. 0.35: dusk, when lionfish hunt
  const probeAt = (qs.get('probe') || '').split(',').filter(Boolean).map((s) => Math.round(Number(s) * 30));
  const probe = () => {
    const T = aq.THREE, eel = world.fish.find((f) => f.spine);
    console.log('PROBE lift', eel.model.userData.uniforms.uLift.value.toFixed(2), 'pitch', eel.pitch.toFixed(2), 'hf at pos', world.reefHeight(eel.pos.x, eel.pos.z).toFixed(2));
    console.log('PROBE caves', JSON.stringify(world.reef.caves.map((c) => ({ x: c.x, z: c.z, yaw: c.yaw, ground: c.ground, mouth: c.mouth }))));
    console.log('PROBE eel', JSON.stringify({ pos: eel.pos, dir: eel.dir, home: eel.brain.home, mode: eel.brain.mode }));
    const us = eel.model.userData.uniforms.uSpine.value, lift = eel.model.userData.uniforms.uLift.value, Q = new T.Vector3();
    eel.model.updateMatrixWorld();
    console.log('PROBE drawn', eel.spine.p.map((p, i) => {
      const x = 0.5 - i / 11;
      eel.model.localToWorld(Q.set(x, us[2 * i + 1] + lift * Math.max(0, x - 0.1) ** 2 * 2.5, us[2 * i]));
      return `${i}:${world.rockDist(Q).toFixed(2)}${inBurrow(eel, Q) ? 'B' : ''}`;
    }).join(' '));
    eel.spine.p.forEach((p, i) => {
      const hits = [];
      world.reef.group.traverse((o) => {
        if (!o.isMesh) return;
        const b = new T.Box3().setFromObject(o);
        if (b.containsPoint(p)) { let path = []; for (let q = o; q && q !== world.reef.group; q = q.parent) path.push(q.name || q.type); hits.push(path.join('<') + (o.userData.noHeight ? ' [noH]' : '') + (o.userData.solid ? ' [solid]' : '')); }
      });
      console.log('PROBE node', i, p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2), 'd', world.rockDist(p).toFixed(2), 'hf', world.reefHeight(p.x, p.z).toFixed(2), 'roof', JSON.stringify(world.roofAt(p.x, p.z)), hits.join(' | ').slice(0, 200));
    });
  };
  for (let n = 0; n < FRAMES; n++) {
    if (probeAt.includes(n)) { console.log('PROBE t', n / 30); probe(); }
    if (n % 30 === 0) {
      samples++;
      shelteredSum += world.fish.filter((f) => f.brain.sheltered).length / world.fish.length;
      for (const s of shoals) {
        const F = s.fish, L = F.reduce((a, f) => a + f.size, 0) / F.length;
        const nn = F.map((f) => Math.min(...F.filter((o) => o !== f).map((o) => o.pos.distanceTo(f.pos)))).sort((a, b) => a - b);
        s.nnd.push(nn[Math.floor(nn.length / 2)] / L);
        const h = F.reduce((v, f) => v.add(f.dir), new aq.THREE.Vector3());
        s.pol.push(h.length() / F.length);
        const group = new Array(F.length).fill(-1);
        let g = 0;
        for (let i = 0; i < F.length; i++) {
          if (group[i] >= 0) continue;
          const stack = [i]; group[i] = g;
          while (stack.length) { const k = stack.pop(); F.forEach((o, j) => { if (group[j] < 0 && o.pos.distanceTo(F[k].pos) < 2.5 * L) { group[j] = g; stack.push(j); } }); }
          g++;
        }
        s.groups.push(g);
      }
    }
    world.update(DT);
    for (const c of world.critters) c.update(DT, world);
    if (st) {
      const c = st.client, on = c && c.brain.posing && st.cleaner.brain.focus === c ? c : null;
      if (on && on !== was) { cleaning.sessions++; cleaning.clients.add(on.sp.id); }
      if (was && !on && was.brain.mode === 'flee') cleaning.jolts++;
      if (on) cleaning.seconds += DT;
      was = on;
    }
    for (const s of stats) {
      const { f } = s, L = f.size, vy = (f.pos.y - s.y) / DT;
      s.rise = Math.max(s.rise, vy / L);
      // A reversal: the climb changes sign. Count it when the swing since the last one is big and quick.
      if (Math.sign(vy) !== Math.sign(s.vy) && Math.abs(vy) > 1e-4) {
        if (s.ext && Math.abs(f.pos.y - s.ext.y) > 0.02 * L && n - s.ext.n < 15) s.jitter++;
        s.ext = { y: f.pos.y, n };
      }
      s.y = f.pos.y; s.vy = vy;
      // Inside rock: the fish's centre deeper than a tenth of a body length under the real surface.
      if (!f.spine && world.rockDist(f.pos) < -0.1 * L) s.inRock = (s.inRock || 0) + 1;
      if (f.spine) {
        const lift = f.model.userData.uniforms.uLift.value, N = f.spine.p.length;
        s.roof += f.spine.p.some((p, i) => {
          const r = world.roofAt(p.x, p.z), x = 0.5 - i / (N - 1);
          const y = p.y + lift * Math.max(0, x - 0.1) ** 2 * 2.5 * L;
          return r && y > r.y - 0.02 * L && y < r.top;
        }) ? 1 : 0;
        // The whole body in the rock field, where the shader draws it: each of the 12 midline nodes (the
        // chain's offsets as clamped into uSpine, plus the head lift) in the model's frame. A node more
        // than a voxel (0.08) inside solid scenery is clipping, unless it is in the eel's burrow (fish.js
        // inBurrow: the crevice behind its cave, where the body is meant to be out of sight in the rock).
        // Frames with any node clipping, node-samples clipping, the deepest, by brain mode and by node
        // (0 = head); and burrow nodes in rock, with how many of those are shallow (within 0.08 of the
        // surface, so they could show through it).
        const sp = f.model.userData.uniforms.uSpine.value, P = new aq.THREE.Vector3();
        f.model.updateMatrixWorld();
        let any = false;
        for (let i = 0; i < N; i++) {
          const x = 0.5 - i / (N - 1);
          f.model.localToWorld(P.set(x, sp[2 * i + 1] + lift * Math.max(0, x - 0.1) ** 2 * 2.5, sp[2 * i]));
          const d = world.rockDist(P);
          if (inBurrow(f, P)) { if (d < 0) { s.burrowIn = (s.burrowIn || 0) + 1; if (d > -0.08) s.burrowShallow = (s.burrowShallow || 0) + 1; } continue; }
          if (d < -0.08 && probeAt.length && n > 300 && n - (s.clipAt ?? -99) > 45 && (s.clipLog = (s.clipLog || 0) + 1) <= 16) {
            s.clipAt = n;
            const c = f.spine.p[i], D = f.brain.lurkDir, h = f.brain.home;
            const sAx = D ? (P.x - h.x) * D.x + (P.z - h.z) * D.z : 0;
            console.log('PROBE clip', n, i, f.brain.mode, 'drawn', P.x.toFixed(2), P.y.toFixed(2), P.z.toFixed(2), 'd', d.toFixed(2), 'chain', c.x.toFixed(2), c.y.toFixed(2), c.z.toFixed(2), 'd', world.rockDist(c).toFixed(2), 'chainB', inBurrow(f, c), 's/L', (sAx / L).toFixed(2), 'off', sp[2 * i].toFixed(3), sp[2 * i + 1].toFixed(3));
          }
          if (d < -0.08) { any = true; s.bodyIn = (s.bodyIn || 0) + 1; s.bodyDeep = Math.max(s.bodyDeep || 0, -d); (s.bodyIdx ||= new Array(N).fill(0))[i]++; }
        }
        if (any) { s.bodyFrames = (s.bodyFrames || 0) + 1; (s.bodyBy10s ||= {})[Math.floor(n / 300) * 10] = (s.bodyBy10s[Math.floor(n / 300) * 10] || 0) + 1; (s.bodyModes ||= {})[f.brain.mode] = (s.bodyModes[f.brain.mode] || 0) + 1; }
      }
    }
  }
  const rows = stats.map((s) => ({ fish: s.f.name || s.f.sp.id, species: s.f.sp.id, riseBLs: +s.rise.toFixed(2), jitterPerMin: +(s.jitter / (FRAMES * DT / 60)).toFixed(1), inRockFrames: s.inRock || 0, ...(s.f.spine ? { roofFrames: s.roof, bodyInRockFrames: s.bodyFrames || 0, bodyInRockNodes: s.bodyIn || 0, bodyDeepest: +(s.bodyDeep || 0).toFixed(2), bodyInRockModes: s.bodyModes || {}, bodyInRockByNode: s.bodyIdx || [], burrowNodesInRock: s.burrowIn || 0, burrowNodesShallow: s.burrowShallow || 0, bodyInRockBy10s: s.bodyBy10s || {} } : {}) }));
  const sum = {
    fish: rows.length,
    maxRiseBLs: Math.max(...rows.map((r) => r.riseBLs)),
    meanJitterPerMin: +(rows.reduce((a, r) => a + r.jitterPerMin, 0) / rows.length).toFixed(2),
    inRockFrames: rows.reduce((a, r) => a + r.inRockFrames, 0),
    eelRoofFrames: rows.filter((r) => 'roofFrames' in r).map((r) => r.roofFrames),
    // Eel body nodes inside the rock field (any node > 0.08 deep), of FRAMES frames.
    eelBodyInRock: rows.filter((r) => 'roofFrames' in r).map((r) => ({ frames: r.bodyInRockFrames, nodes: r.bodyInRockNodes, deepest: r.bodyDeepest, modes: r.bodyInRockModes, byNode: r.bodyInRockByNode.join(' '), burrowIn: r.burrowNodesInRock, burrowShallow: r.burrowNodesShallow, by10s: r.bodyInRockBy10s })),
    // Fear passed on by a neighbour's flight (brain.js _perceive), per simulated minute.
    contagionPerMin: +(world.fish.reduce((a, f) => a + (f.brain.contagions || 0), 0) / (FRAMES * DT / 60)).toFixed(1),
    firstHandPerMin: +(world.fish.reduce((a, f) => a + (f.brain.firstHand || 0), 0) / (FRAMES * DT / 60)).toFixed(1),
    shoals: shoals.map((s) => {
      const med = (a) => +a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2);
      return { species: s.sp.id, nndBL: med(s.nnd), polarisation: med(s.pol), groupsMin: Math.min(...s.groups), groupsMax: Math.max(...s.groups) };
    }),
    shelteredShare: +(shelteredSum / Math.max(1, samples)).toFixed(2),
    lionfishStrikes: world.fish.reduce((a, f) => a + (f.brain.strikes || 0), 0),
    truces: world.fish.reduce((a, f) => a + [...(f.brain.lostTo?.values() || [])].filter((n) => n >= 2).length, 0),
    ...(cleaning && { cleaning: { ...cleaning, seconds: +cleaning.seconds.toFixed(0), clients: [...cleaning.clients] } }),
  };
  window.motionCheck = { sum, rows };
  console.table(rows);
  console.log('motion check', sum);
  await fetch('/__done', { method: 'POST', body: JSON.stringify({ sum, rows }) }).catch(() => {});
}
