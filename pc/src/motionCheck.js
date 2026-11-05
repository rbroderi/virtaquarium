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
  for (let n = 0; n < FRAMES; n++) {
    world.update(DT);
    for (const c of world.critters) c.update(DT, world);
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
  const rows = stats.map((s) => ({ fish: s.f.name || s.f.sp.id, species: s.f.sp.id, riseBLs: +s.rise.toFixed(2), jitterPerMin: +(s.jitter / 2).toFixed(1), ...(s.f.spine ? { roofFrames: s.roof } : {}) }));
  const sum = {
    fish: rows.length,
    maxRiseBLs: Math.max(...rows.map((r) => r.riseBLs)),
    meanJitterPerMin: +(rows.reduce((a, r) => a + r.jitterPerMin, 0) / rows.length).toFixed(2),
    eelRoofFrames: rows.filter((r) => 'roofFrames' in r).map((r) => r.roofFrames),
  };
  window.motionCheck = { sum, rows };
  console.table(rows);
  console.log('motion check', sum);
  await fetch('/__done', { method: 'POST', body: JSON.stringify({ sum, rows }) }).catch(() => {});
}
