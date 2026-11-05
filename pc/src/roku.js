// Roku preview: plays the baked assets in roku/assets/ the way the Roku channel will, with no WebGL.
// Only what SceneGraph can do: a 1920x1080 backdrop poster, sprite-sheet fish (flipped for facing left),
// and the foreground reef poster over fish that are behind it, driven by a simple 2D brain.
//   /pc/roku.html?scene=reef-7&fps=30&seed=1
// Keys: H hud, W moving water on/off, Space pause.
const params = new URLSearchParams(location.search);
const ASSETS = '/roku/assets/';
const FPS = Number(params.get('fps') || 30);
const TURN_TIME = 0.45;            // seconds to play the turn row
const NEAR = 0.35;                 // depth above which a fish swims in front of the foreground reef

const canvas = document.getElementById('screen');
const g = canvas.getContext('2d');
const hud = document.getElementById('hud');

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(Number(params.get('seed') || 1));
const range = (a, b) => a + (b - a) * rand();

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error(`missing ${src}`));
  img.src = src;
});

function fail(msg) {
  const el = document.getElementById('error');
  el.style.display = 'grid';
  el.textContent = msg;
}

async function main() {
  const res = await fetch(ASSETS + 'manifest.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('No baked assets found. Run `npm run bake` (or run_baked.bat bake) first.');
  const manifest = await res.json();
  const keys = Object.keys(manifest.scenery);
  const sceneKey = manifest.scenery[params.get('scene')] ? params.get('scene') : keys[0];
  const scene = manifest.scenery[sceneKey];
  canvas.width = manifest.screen.w;
  canvas.height = manifest.screen.h;

  const [back, front] = await Promise.all([loadImage(ASSETS + scene.backdrop), loadImage(ASSETS + scene.foreground)]);
  // Moving water: a loop of overlay frames for the backdrop and for the foreground reef.
  const water = scene.water;
  const loadLayer = async (L) => L && { rect: L.rect, frames: await Promise.all(L.frames.map((f) => loadImage(ASSETS + f))) };
  // The loop is large, so the tank starts without it and the water starts moving once it has loaded.
  let waterLayers = [null, null];
  if (water) Promise.all([loadLayer(water.back), loadLayer(water.front)]).then((l) => { waterLayers = l; }, (e) => fail(e.message));
  const species = await Promise.all(Object.entries(manifest.species).map(async ([id, sp]) => {
    const img = await loadImage(ASSETS + sp.sheet);
    // Cell size from the sheet itself, so a sheet re-baked on its own still lines up.
    return { id, ...sp, img, fw: img.width / sp.frames, fh: img.height / 2 };
  }));

  // Screen pixels per world unit on the mid-depth plane, from the same tank width the bake used.
  const aspect = manifest.screen.w / manifest.screen.h;
  const tankW = Math.min(30, Math.max(16, 8.6 * aspect + 1.5));
  const [bx0, by0, bx1, by1] = scene.swimBox;
  const pxPerUnit = (bx1 - bx0) / (tankW - 1.8);
  const baseScale = pxPerUnit / manifest.pxPerUnit;

  const floorAt = (x) => {
    const f = scene.floor, t = Math.min(Math.max(x / manifest.screen.w, 0), 1) * (f.length - 1);
    const i = Math.min(Math.floor(t), f.length - 2);
    return f[i] + (f[i + 1] - f[i]) * (t - i);
  };

  const fish = [];
  for (const sp of species) {
    for (let n = 0; n < (sp.count || 1); n++) {
      const depth = range(-1, 1);
      fish.push({
        sp, depth, scale: baseScale * (1 + 0.18 * depth),
        x: range(bx0 + 100, bx1 - 100), y: range(by0 + 150, by1 - 150), vx: 0, vy: 0,
        facing: rand() < 0.5 ? 1 : -1, turn: null, phase: rand(), tx: 0, ty: 0, timer: 0, mode: 'cruise',
      });
    }
  }
  fish.sort((a, b) => a.depth - b.depth);

  // Vertical limits for a fish at x: under the surface, above the reef line.
  const limits = (f, x) => {
    const h = f.sp.fh * f.scale;
    return [by0 + h * 0.5, Math.min(by1, floorAt(x)) - h * 0.35];
  };

  function pickTarget(f) {
    const b = f.sp.brain;
    f.mode = 'cruise';
    let x = range(bx0 + 60, bx1 - 60), zoneF = range(b.zone[0], b.zone[1]);
    if (b.host && rand() < 0.6) {
      x = scene.anemone[0] + range(-90, 90);
      zoneF = 0.92;
      f.mode = 'host';
    } else if (b.school >= 0.5) {
      const mates = fish.filter((o) => o.sp === f.sp && o !== f);
      if (mates.length) {
        const cx = mates.reduce((s, o) => s + o.x, 0) / mates.length;
        x = Math.min(Math.max(cx + range(-260, 260), bx0 + 60), bx1 - 60);
      }
    } else if (rand() < b.grazer * 0.4 || rand() < (b.shy || 0) * 0.5) {
      zoneF = 1;
      f.mode = 'graze';
    }
    const [top, bottom] = limits(f, x);
    f.tx = x;
    f.ty = top + (bottom - top) * zoneF;
    f.timer = range(3, 10) / (0.4 + b.activity) * (f.mode === 'cruise' ? 1 : 1.8);
  }

  function step(f, dt) {
    const b = f.sp.brain;
    f.timer -= dt;
    const dx = f.tx - f.x, dy = f.ty - f.y, dist = Math.hypot(dx, dy);
    if (f.timer <= 0 || (dist < 20 && f.mode === 'cruise')) pickTarget(f);

    const cruise = b.maxSpeed * pxPerUnit * (0.2 + 0.3 * b.activity);
    const arrive = Math.min(1, dist / 160);
    let wx = dist > 1 ? (dx / dist) * cruise * arrive : 0;
    let wy = dist > 1 ? (dy / dist) * cruise * arrive : 0;
    // Schoolers match their mates' heading; everyone keeps a little room from fish at a similar depth.
    for (const o of fish) {
      if (o === f) continue;
      const ox = f.x - o.x, oy = f.y - o.y, d = Math.hypot(ox, oy);
      if (o.sp === f.sp && b.school > 0 && d < 300) { wx += o.vx * b.school * 0.08; wy += o.vy * b.school * 0.08; }
      const room = (f.sp.lengthPx * f.scale + o.sp.lengthPx * o.scale) * 0.55;
      if (d < room && d > 0.01 && Math.abs(f.depth - o.depth) < 0.4) { wx += (ox / d) * cruise * 0.8; wy += (oy / d) * cruise * 0.5; }
    }
    wy = Math.max(-cruise * 0.45, Math.min(cruise * 0.45, wy));   // fish climb and dive gently

    const k = Math.min(1, dt * (f.turn ? 4 : 1.4));
    f.vx += (wx - f.vx) * k;
    f.vy += (wy - f.vy) * k;
    if (f.turn) f.vx *= 1 - Math.min(1, dt * 3);      // brake through the turn

    // Start a turn when the wanted heading crosses over; the sheet's turn row carries the facing across.
    if (!f.turn && Math.sign(wx) === -f.facing && Math.abs(wx) > cruise * 0.15) f.turn = { t: 0, to: -f.facing };
    if (f.turn) {
      f.turn.t += dt / TURN_TIME;
      if (f.turn.t >= 1) { f.facing = f.turn.to; f.turn = null; }
    }

    f.x = Math.min(Math.max(f.x + f.vx * dt, bx0), bx1);
    const [top, bottom] = limits(f, f.x);
    f.y = Math.min(Math.max(f.y + f.vy * dt, top), bottom);
    // Tail beat speeds up with swimming speed; idle fish still fin gently.
    f.phase += dt * (0.7 + 2.2 * Math.min(1.5, Math.hypot(f.vx, f.vy) / cruise));
  }

  function draw(f) {
    const { sp } = f, n = sp.frames, w = sp.fw * f.scale, h = sp.fh * f.scale;
    let row = sp.rows.swim, frame = Math.floor(f.phase * n) % n, flip = f.facing < 0;
    if (f.turn) {
      // The turn row goes right -> left; played backwards it goes left -> right.
      const i = Math.min(n - 1, Math.floor(f.turn.t * n));
      row = sp.rows.turn;
      frame = f.turn.to < 0 ? i : n - 1 - i;
      flip = false;
    }
    const bob = f.mode === 'cruise' ? 0 : Math.sin(f.phase * 1.3) * 2;
    g.save();
    g.translate(f.x, f.y + bob);
    if (flip) g.scale(-1, 1);
    g.drawImage(sp.img, frame * sp.fw, row * sp.fh, sp.fw, sp.fh, -w / 2, -h / 2, w, h);
    g.restore();
  }

  let paused = false, showHud = true, showWater = true, last = performance.now(), acc = 0, frames = 0, fpsShown = 0, fpsT = 0;
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { paused = !paused; e.preventDefault(); }
    if (e.code === 'KeyH') showHud = !showHud;
    if (e.code === 'KeyW') showWater = !showWater;
  });

  // Two posters per layer: the current frame, and the next one fading in over it.
  let waterT = 0;
  function drawWater(L) {
    if (!L || !showWater) return;
    const n = L.frames.length, pos = (waterT * water.fps) % n, k = Math.floor(pos);
    const [x, y, w, h] = L.rect;
    g.drawImage(L.frames[k], x, y, w, h);
    g.globalAlpha = pos - k;
    g.drawImage(L.frames[(k + 1) % n], x, y, w, h);
    g.globalAlpha = 1;
  }

  function render() {
    g.drawImage(back, 0, 0);
    drawWater(waterLayers[0]);
    for (const f of fish) if (f.depth <= NEAR) draw(f);
    g.drawImage(front, 0, 0);
    drawWater(waterLayers[1]);
    for (const f of fish) if (f.depth > NEAR) draw(f);
  }

  function loop(now) {
    requestAnimationFrame(loop);
    acc += now - last;
    last = now;
    // Run at the Roku's frame rate, not the monitor's.
    if (acc < 1000 / FPS - 2) return;     // tolerance so 60 Hz vsync lands on every 2nd frame
    const dt = Math.min(acc / 1000, 0.1);
    acc = 0;
    if (!paused) {
      for (const f of fish) step(f, dt);
      waterT += dt;
    }
    render();
    frames++;
    if (now - fpsT > 1000) { fpsShown = frames; frames = 0; fpsT = now; }
    hud.textContent = showHud
      ? `Roku preview  ${sceneKey}  ${fish.length} fish  ${fpsShown}/${FPS} fps${paused ? '  paused' : ''}${water ? '' : '  (no water loop: re-bake)'}\nH hud  W water  Space pause`
      : '';
  }
  requestAnimationFrame(loop);
}

main().catch((e) => fail(e.message));
