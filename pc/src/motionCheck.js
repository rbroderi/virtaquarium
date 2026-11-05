// Motion checks, run on the tank page with ?check=motion (report in the console, in window.motionCheck,
// and POSTed to /__done for a headless run). The tank is stepped at 30 Hz for two simulated minutes
// without drawing, and for every fish it measures
//   - jumps: the fastest climb, in body lengths per second (a snap up a coral head shows as a spike);
//   - jitter: up-down reversals of over 2% of a body length that come within half a second of each
//     other (bobbing over branching coral);
// and for each eel, frames where a node of its body (with the head lift the shader adds) is inside a
// cave roof.
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
  for (let n = 0; n < FRAMES; n++) {
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
      if (f.spine) {
        const lift = f.model.userData.uniforms.uLift.value, N = f.spine.p.length;
        s.roof += f.spine.p.some((p, i) => {
          const r = world.roofAt(p.x, p.z), x = 0.5 - i / (N - 1);
          const y = p.y + lift * Math.max(0, x - 0.1) ** 2 * 2.5 * L;
          return r && y > r.y - 0.02 * L && y < r.top;
        }) ? 1 : 0;
      }
    }
  }
  const rows = stats.map((s) => ({ fish: s.f.name || s.f.sp.id, species: s.f.sp.id, riseBLs: +s.rise.toFixed(2), jitterPerMin: +(s.jitter / (FRAMES * DT / 60)).toFixed(1), ...(s.f.spine ? { roofFrames: s.roof } : {}) }));
  const sum = {
    fish: rows.length,
    maxRiseBLs: Math.max(...rows.map((r) => r.riseBLs)),
    meanJitterPerMin: +(rows.reduce((a, r) => a + r.jitterPerMin, 0) / rows.length).toFixed(2),
    eelRoofFrames: rows.filter((r) => 'roofFrames' in r).map((r) => r.roofFrames),
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
