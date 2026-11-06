// Look check, run on the tank page with ?check=look (headless: tools/check.mjs look). Steps the tank
// as the live loop does, at 30 Hz, and at each requested moment renders a frame and saves it to
// out/look-<tag>-<t>s.png, plus close-ups (out/look-<tag>-<t>s-<what>.png) of
//   station   the cleaning station (cleaner and client)
//   <species> the first fish of that species
//   fanworm   the most open feather-duster worm
//   <name>    a scenery piece by its object name (rock_a, coral_table, ...)
// URL options: &at=5,30 (seconds), &close=station,cleanerwrasse, &tag=name, &night=1 (lights off).
// Reports { files, stats } to /__done, stats per frame: mean luminance and saturation, so looks can be
// compared over time without opening the pictures.
const DT = 1 / 30;

export async function main(aq) {
  const { world, renderer, camera } = aq;
  const q = new URLSearchParams(location.search);
  const at = (q.get('at') || '5,30').split(',').map(Number).sort((a, b) => a - b);
  const close = (q.get('close') || 'station').split(',').filter(Boolean);
  const tag = q.get('tag') || 'tank';
  if (q.get('night') === '1') aq.setLight(0);
  aq.fitCanvas();
  const canvas = renderer.domElement, files = [], stats = [];
  let t = 0;
  for (const target of at) {
    for (; t < target - 1e-6; t += DT) aq.step(DT);
    aq.present();
    const name = `look-${tag}-${target}s`;
    files.push(await save(`out/${name}.png`, canvas));
    stats.push({ t: target, ...measure(canvas) });
    for (const what of close) {
      // fanworm: the most open feather-duster worm in front of the camera.
      const worm = what === 'fanworm' ? (world.reef.fanWorms?.worms || []).filter((w) => w.mouth.z > -0.5).sort((a, b) => a.retract - b.retract)[0] : null;
      // Otherwise a fish species, or a scenery piece by name (rock_a, coral_table...): the front of its box.
      const piece = () => {
        let o = null;
        aq.scene.traverse((x) => { if (!o && x.name === what) o = x; });
        if (!o) return null;
        const b = new aq.THREE.Box3().setFromObject(o), c = b.getCenter(new aq.THREE.Vector3());
        return c.setZ(b.max.z);
      };
      const p = what === 'station' ? world.station?.pos : worm ? worm.mouth : world.fish.find((f) => f.sp.id === what)?.pos ?? piece();
      if (!p) continue;
      const v = p.clone().project(camera), W = canvas.width, H = canvas.height;
      const s = Math.round(H * (worm ? 0.14 : 0.35)), x = Math.round((v.x + 1) / 2 * W - s / 2), y = Math.round((1 - v.y) / 2 * H - s / 2);
      const c = document.createElement('canvas');
      c.width = c.height = 512;
      c.getContext('2d').drawImage(canvas, Math.max(0, Math.min(W - s, x)), Math.max(0, Math.min(H - s, y)), s, s, 0, 0, 512, 512);
      files.push(await save(`out/${name}-${what}.png`, c));
    }
  }
  const report = { files, stats, station: world.station && { client: world.station.client?.sp.id || null, cleaner: world.station.cleaner?.brain.thought } };
  console.log('look check', JSON.stringify(report));
  await fetch('/__done', { method: 'POST', body: JSON.stringify(report) }).catch(() => {});

  async function save(path, c) {
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    await fetch('/__save?path=' + encodeURIComponent(path), { method: 'POST', body: blob });
    return path;
  }
  // Mean luminance and HSV saturation of the frame (0..1), from a 1/8-size copy.
  function measure(src) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(src.width / 8); c.height = Math.ceil(src.height / 8);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let lum = 0, sat = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      lum += 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      sat += mx > 0 ? (mx - mn) / mx : 0;
    }
    const n = d.length / 4;
    return { lum: +(lum / n).toFixed(3), sat: +(sat / n).toFixed(3) };
  }
}
