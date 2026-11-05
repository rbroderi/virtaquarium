// Roku preview: plays the baked assets in roku/assets/ the way the Roku channel will, with no WebGL.
// Only what SceneGraph can do: a 1920x1080 backdrop poster, sprite-sheet fish and the foreground reef
// poster over fish that are behind it, driven by a simple brain. Each fish has a heading in the plane of
// x and depth, turned at a limited rate, so it swings towards or away from the viewer as it turns and
// its size changes as it swims nearer. Each viewing angle (tail-on, side-on, head-on) is its own page
// holding the swim cycle; a fish facing left is the mirror image, and the player crossfades the two
// nearest angles (two posters on the Roku).
// Texture memory is budgeted as on the Roku (see Textures): pages are loaded ahead of need and freed
// when no poster shows them, so the total stays under ?budget= MB however many angles were baked.
// The view is zoomed in and pans slowly (view.js): everything lives on a strip wider than the screen,
// drawn shifted by the pan; backdrop and foreground columns, and fish, out of view hold no textures.
//   /pc/roku.html?scene=reef-7&fps=30&seed=1&budget=40&latency=80
// Keys: H hud, W moving water on/off, Space pause.
const params = new URLSearchParams(location.search);
const ASSETS = '/roku/assets/';
const FPS = Number(params.get('fps') || 30);
// ?timer=1 drives the loop from a timer instead of animation frames (headless or hidden-window checks).
const nextFrame = params.has('timer') ? (f) => setTimeout(() => f(performance.now()), 1000 / FPS) : requestAnimationFrame;
const NEAR = 0.35;                 // depth above which a fish swims in front of the foreground reef
// Roku texture memory is ~100 MB shared with the OS, whose own textures can take more than half of it
// (jellyrock/jellyrock#74 measured 58 MB OS, 32 MB app), so the app keeps to its own budget.
const BUDGET_MB = Number(params.get('budget') || 40);
const LATENCY = Number(params.get('latency') ?? 80);   // ms to load and decode a bitmap, as on the device

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

function fail(msg) {
  const el = document.getElementById('error');
  el.style.display = 'grid';
  el.textContent = msg;
}

// Texture memory as the Roku keeps it. A bitmap is resident while any Poster's uri points at it,
// visible or not, and freed when the last one is cleared, so the channel must clear the uri of every
// poster it isn't showing (Roku's advice) rather than just hiding it. Bitmaps cost 4 bytes a pixel
// whatever the file size. Each frame the player says what it wants, by priority:
//   0 pinned    backdrop, foreground, one fallback angle per species
//   1 shown     the angles and water frames being drawn now
//   2 next      what a turn or the water loop reaches within a fraction of a second
//   3 nearby    neighbouring angles, if there is room
// Wants are granted in priority order while they fit the budget; anything not granted is freed (its
// poster's uri cleared). A load takes LATENCY ms, so 'next' covers the gap; a shown page that isn't
// ready is drawn with the nearest page that is (a miss). Every load is a PNG decode on the device, so
// 'nearby' pages don't churn: one already held outranks a new one, and a new one starts only with 10%
// of the budget spare, one per frame.
class Textures {
  constructor(budgetMB, latency) {
    this.budget = budgetMB * 1e6;
    this.latency = latency;
    this.map = new Map();   // url -> { bytes, img, ready }
    this.wants = new Map(); // url -> { bytes, prio } for this frame
    this.used = 0;
    this.need = 0;   // of `used`, what is shown or about to be (priorities 0-2)
    this.peak = 0;
    this.loads = 0;
    this.misses = 0;
  }
  want(url, bytes, prio) {
    const w = this.wants.get(url);
    if (!w) this.wants.set(url, { bytes, prio });
    else if (prio < w.prio) w.prio = prio;
  }
  get(url) {
    const e = this.map.get(url);
    return e && e.ready ? e.img : null;
  }
  // Grant this frame's wants, free the rest, start loads.
  update() {
    // Held 'nearby' pages rank just above new ones.
    const rank = ([url, w]) => (w.prio === 3 && this.map.has(url) ? 2.5 : w.prio);
    const order = [...this.wants].sort((a, b) => rank(a) - rank(b));
    const keep = new Set();
    let total = 0, spec = 0;
    for (const [url, w] of order) {
      if (w.prio > 0 && total + w.bytes > this.budget) continue;
      if (w.prio === 3 && !this.map.has(url) && (spec >= 1 || total + w.bytes > this.budget * 0.9)) continue;
      if (w.prio === 3 && !this.map.has(url)) spec++;
      keep.add(url);
      total += w.bytes;
    }
    this.need = order.reduce((s, [url, w]) => s + (w.prio <= 2 && keep.has(url) ? w.bytes : 0), 0);
    for (const [url, e] of this.map) {
      if (keep.has(url)) continue;
      e.img.onload = e.img.onerror = null;   // clearing src fires onerror in the browser
      e.img.src = '';   // the Roku: poster.uri = ""
      this.map.delete(url);
      this.used -= e.bytes;
    }
    for (const url of keep) {
      if (this.map.has(url)) continue;
      const e = { bytes: this.wants.get(url).bytes, img: new Image(), ready: false };
      e.img.onload = () => setTimeout(() => { e.ready = true; }, this.latency);
      e.img.onerror = () => fail(`missing ${url}`);
      e.img.src = ASSETS + url;
      this.map.set(url, e);
      this.used += e.bytes;
      this.loads++;
    }
    this.peak = Math.max(this.peak, this.used);
    this.wants.clear();
  }
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

  const tex = new Textures(BUDGET_MB, LATENCY);
  const { w: SW, h: SH } = manifest.screen;
  // The strip the screen pans along (as wide as the screen when not zoomed).
  const framing = manifest.view || { zoom: 1, pan: false, period: 120, strip: manifest.screen };
  const STRIP_W = framing.strip.w;
  const panAt = (t) => (STRIP_W - SW) * (framing.pan ? 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / framing.period) : 0.5);
  if (!Array.isArray(scene.backdrop)) throw new Error('backdrop is not tiled; re-bake');
  const tileBytes = (t) => t.rect[2] * t.rect[3] * 4;
  // Moving water: a loop of overlay frames for the backdrop and for the foreground reef, streamed:
  // only the frames being shown and the next one are held.
  const water = scene.water;
  const waterLayers = water ? [water.back, water.front].map((L) => L && {
    ...L, bytes: Math.round(L.rect[2] / water.scale) * Math.round(L.rect[3] / water.scale) * 4, last: null,
  }) : [null, null];
  // The airstone's bubble column: sprites baked with the live bubble shader, sent up at the live rise
  // speed (water.js, Mendelson's wave analogy: U = sqrt(2.14 sigma / (rho d) + 0.505 g d)), zig-zagging
  // once over 2 mm. A bubble a frame is released at the live rate (~90 in the column at once).
  const B = manifest.bubbles, stone = scene.bubbler;
  const bubbles = B && stone ? { list: [], bytes: B.cell * B.mm.length * B.cell * 4, t: 0 } : null;
  const riseU = (mm) => { const d = mm / 1000; return Math.sqrt((2.14 * 0.072) / (1000 * d) + 0.505 * 9.81 * d) / 0.125; };   // units/s
  const spawnBubble = (b, y) => {
    b.k = Math.floor(rand() * B.mm.length);
    b.y = y; b.x = (rand() - 0.5) * 0.08 * stone.pxPerUnit;
    b.ph = rand() * 6.283; b.f = 4 + 4 * rand();
    return b;
  };
  if (bubbles) {
    for (let i = 0; i < 90; i++) bubbles.list.push(spawnBubble({}, stone.pos[1] + rand() * (stone.top - stone.pos[1])));
  }
  function stepBubbles(dt) {
    bubbles.t += dt;
    for (const b of bubbles.list) {
      b.y -= riseU(B.mm[b.k]) * stone.pxPerUnit * dt;
      if (b.y < Math.max(stone.top, -B.cell)) spawnBubble(b, stone.pos[1]);
    }
  }
  function drawBubbles() {
    const img = tex.get(B.sheet), s = stone.pxPerUnit / B.pxPerUnit;
    if (!img) return;
    for (const b of bubbles.list) {
      const mm = B.mm[b.k], zz = mm > 2 ? ((mm - 2) * 0.004 / 0.125) * stone.pxPerUnit : 0;
      const x = stone.pos[0] + b.x + Math.sin(bubbles.t * b.f * 6.283 + b.ph) * zz, c = B.cell * s;
      g.drawImage(img, b.k * B.cell, 0, B.cell, B.cell, x - c / 2, b.y - c / 2, c, c);
    }
  }

  const species = Object.entries(manifest.species).map(([id, sp]) => {
    if (!sp.angles) throw new Error(`${id}: sprite sheet has no per-angle pages; re-bake`);
    const yaws = sp.angles.map((a) => a.yaw);
    // Fallback angle, always held: the one cruising fish are mostly seen at.
    const home = yaws.reduce((b, y, i) => (Math.abs(y - (sp.cruiseYaw || 0)) < Math.abs(yaws[b] - (sp.cruiseYaw || 0)) ? i : b), 0);
    return { id, ...sp, fw: sp.frameW, fh: sp.frameH, home, stepYaw: 180 / (yaws.length - 1) };
  });

  // Screen pixels per world unit on the mid-depth plane, from the same tank width the bake used.
  const aspect = manifest.screen.w / manifest.screen.h;
  const tankW = Math.min(30, Math.max(16, 8.6 * aspect + 1.5));
  const [bx0, by0, bx1, by1] = scene.swimBox;
  const pxPerUnit = (bx1 - bx0) / (tankW - 1.8);
  const baseScale = pxPerUnit / manifest.pxPerUnit;
  const DEPTH_PX = 2.85 * pxPerUnit;   // depth runs -1..1 over the tank's 5.7 units front to back
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  const floorAt = (x) => {
    const f = scene.floor, t = Math.min(Math.max(x / STRIP_W, 0), 1) * (f.length - 1);
    const i = Math.min(Math.floor(t), f.length - 2);
    return f[i] + (f[i + 1] - f[i]) * (t - i);
  };

  const fish = [];
  for (const sp of species) {
    for (let n = 0; n < (sp.count || 1); n++) {
      const depth = range(-1, 1);
      fish.push({
        sp, depth, tdepth: depth, scale: baseScale * (1 + 0.18 * depth),
        x: range(bx0 + 100, bx1 - 100), y: range(by0 + 150, by1 - 150), vx: 0, vy: 0, vz: 0, speed: 0,
        psi: rand() < 0.5 ? 0 : Math.PI, omega: 0, turnSign: 0, tilt: 0,   // heading: 0 right, +pi/2 at the viewer
        u: 0, du: 0,   // shown angle (index into the angle pages) and its rate, for loading ahead
        phase: rand(), tx: 0, ty: 0, timer: 0, mode: 'cruise',
        fear: 0, fearAge: 9, caughtT: 0, pendingFear: 0, threatX: 0, threatY: 0, shelter: null,
      });
    }
  }
  fish.sort((a, b) => a.depth - b.depth);
  // Each fish knows a shelter (bake.js: reef.js shelters in screen space): shoalers their coral, the
  // rest the nearest ledge to where they start. Hosts keep to the anemone.
  for (const f of fish) {
    const b = f.sp.brain, list = scene.shelters || [];
    if (b.host || !list.length) continue;
    const coral = list.find((s) => s.kind === 'coral');
    if (b.school >= 0.8 && coral) { f.shelter = coral; continue; }
    let best = null, bd = Infinity;
    for (const s of list) if (s.kind === 'ledge') { const d = Math.abs(s.pos[0] - f.x); if (d < bd) { bd = d; best = s; } }
    f.shelter = best;
  }

  // Vertical limits for a fish at x: under the surface, above the reef line.
  const limits = (f, x) => {
    const h = f.sp.fh * f.scale;
    // A fish at its shelter may go down among the rock (behind the foreground layer).
    const hiding = f.shelter && (f.mode === 'flee' || f.mode === 'rest') && Math.abs(f.x - f.shelter.pos[0]) < 90;
    return [by0 + h * 0.5, hiding ? Math.min(by1, f.shelter.pos[1] + h * 0.3) : Math.min(by1, floorAt(x)) - h * 0.35];
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
    // Sometimes also move nearer the glass or further back; host fish stay at the anemone's depth.
    if (f.mode === 'host') f.tdepth = 0;
    else if (rand() < 0.5) f.tdepth = range(-1, 1);
    f.timer = range(3, 10) / (0.4 + b.activity) * (f.mode === 'cruise' ? 1 : 1.8);
  }

  // Fear, reduced from brain.js for the Roku's CPU: prey fear a predator heading their way; a shoalmate
  // that has just bolted passes it on after a reaction delay, weaker by a hop; a scared fish dashes for
  // its shelter (or away from the threat).
  function feel(f, dt) {
    const b = f.sp.brain, L = f.sp.lengthPx * f.scale;
    f.fear *= Math.exp(-dt * 0.45);
    f.fearAge += dt;
    const raise = (s, x, y) => { if (s > f.fear + 0.1) f.fearAge = 0; if (s > f.fear) { f.fear = s; f.threatX = x; f.threatY = y; } };
    if (b.prey) for (const o of fish) {
      if (!o.sp.brain.predator) continue;
      const ox = f.x - o.x, oy = f.y - o.y, d = Math.hypot(ox, oy), R = 2.5 * o.sp.lengthPx * o.scale;
      if (d < R && Math.abs(o.depth - f.depth) < 0.6 && o.vx * ox + o.vy * oy > 0) raise(0.8 * (1 - d / R), o.x, o.y);
    }
    if (f.caughtT > 0) { f.caughtT -= dt; if (f.caughtT <= 0) raise(f.pendingFear, f.threatX, f.threatY); }
    else if (b.school > 0 && f.fear < 0.3) {
      for (const o of fish) {
        if (o === f || o.sp !== f.sp || o.fear < 0.45 || o.fearAge > 1 || Math.hypot(f.x - o.x, f.y - o.y) > 4 * L) continue;
        f.caughtT = 0.25; f.pendingFear = o.fear * 0.6; f.threatX = o.threatX; f.threatY = o.threatY;
        break;
      }
    }
  }

  function step(f, dt) {
    const b = f.sp.brain;
    f.timer -= dt;
    feel(f, dt);
    let boost = 1;
    if (f.fear > 0.4) {
      f.mode = 'flee'; boost = 2.5; f.timer = Math.max(f.timer, 0.5);
      if (f.shelter) { f.tx = f.shelter.pos[0]; f.ty = f.shelter.pos[1]; f.tdepth = -0.5; }
      else { f.tx = Math.min(Math.max(f.x + (f.x - f.threatX) * 2, bx0 + 60), bx1 - 60); f.ty = f.y + (f.y - f.threatY); }
    } else if (f.mode === 'flee') f.timer = 0;
    const dx = f.tx - f.x, dy = f.ty - f.y, dist = Math.hypot(dx, dy);
    if (f.timer <= 0 || (dist < 20 && f.mode === 'cruise')) pickTarget(f);

    const cruise = b.maxSpeed * pxPerUnit * (0.2 + 0.3 * b.activity) * boost;
    const arrive = Math.min(1, dist / 160);
    let wx = dist > 1 ? (dx / dist) * cruise * arrive : 0;
    let wy = dist > 1 ? (dy / dist) * cruise * arrive : 0;
    // Everyone keeps a little room from fish at a similar depth. Schoolers follow pairwise rules on their
    // nearest three mates (as brain.js): apart inside ~0.6 body lengths, together beyond ~1.5, and a
    // little of their heading.
    const mates = [];
    for (const o of fish) {
      if (o === f) continue;
      const ox = f.x - o.x, oy = f.y - o.y, d = Math.hypot(ox, oy);
      if (o.sp === f.sp && b.school > 0 && d < 400) mates.push([d, o, ox, oy]);
      const room = (f.sp.lengthPx * f.scale + o.sp.lengthPx * o.scale) * 0.55;
      if (d < room && d > 0.01 && Math.abs(f.depth - o.depth) < 0.4) { wx += (ox / d) * cruise * 0.8; wy += (oy / d) * cruise * 0.5; }
    }
    if (mates.length) {
      const L = f.sp.lengthPx * f.scale;
      mates.sort((p, q) => p[0] - q[0]);
      for (const [d, o, ox, oy] of mates.slice(0, 3)) {
        if (d < 0.6 * L && d > 0.01) { wx += (ox / d) * cruise * 0.6; wy += (oy / d) * cruise * 0.4; }
        else if (d > 1.5 * L) { const k = Math.min(1, (d - 1.5 * L) / (3 * L)) * cruise * 0.5 * b.school; wx -= (ox / d) * k; wy -= (oy / d) * k; }
        wx += o.vx * b.school * 0.1; wy += o.vy * b.school * 0.1;
      }
    }
    wy = Math.max(-cruise * 0.45, Math.min(cruise * 0.45, wy));   // fish climb and dive gently

    const wz = Math.max(-cruise * 0.5, Math.min(cruise * 0.5, (f.tdepth - f.depth) * DEPTH_PX * 0.4));

    // Heading turns at a limited rate (the species' pectoral-sculling rate), easing in and out. A U-turn
    // picks a side once: towards the viewer from the back half of the tank, away from it near the glass.
    const rate = (f.sp.turnRate || 90) * Math.PI / 180, want = Math.hypot(wx, wz);
    let err = want > cruise * 0.1 ? wrap(Math.atan2(wz, wx) - f.psi) : 0;
    if (Math.abs(err) > 2.6) {
      if (!f.turnSign) f.turnSign = (Math.cos(f.psi) >= 0 ? 1 : -1) * (f.depth < 0.4 ? 1 : -1);
      err = Math.abs(err) * f.turnSign;
    } else if (Math.abs(err) < 2.0) f.turnSign = 0;
    const wOmega = Math.max(-rate, Math.min(rate, err * 2.5));
    f.omega += Math.max(-rate * 4 * dt, Math.min(rate * 4 * dt, wOmega - f.omega));
    f.psi = wrap(f.psi + f.omega * dt);

    // The fish swims along its heading, slowing in tight turns.
    const k = Math.min(1, dt * 1.4);
    f.speed += (want * Math.max(0, Math.cos(err)) * (1 - 0.5 * Math.min(1, Math.abs(f.omega) / rate)) - f.speed) * k;
    f.vx = f.speed * Math.cos(f.psi);
    f.vz = f.speed * Math.sin(f.psi);
    f.vy += (wy - f.vy) * k;

    f.x = Math.min(Math.max(f.x + f.vx * dt, bx0), bx1);
    f.depth = Math.min(Math.max(f.depth + (f.vz / DEPTH_PX) * dt, -1), 1);
    f.scale = baseScale * (1 + 0.18 * f.depth);
    const [top, bottom] = limits(f, f.x);
    f.y = Math.min(Math.max(f.y + f.vy * dt, top), bottom);
    // Tail beat speeds up with swimming speed; idle fish still fin gently.
    const effort = Math.min(1.5, Math.hypot(f.vx, f.vy) / cruise);
    f.phase += dt * (f.sp.tailHz ? f.sp.tailHz * (0.35 + 0.65 * effort) : 0.7 + 2.2 * effort);
  }

  // Viewing angle for a fish's heading: shown a little turned towards the viewer while cruising
  // (cruiseYaw), and folded into -90..90 with a mirror flip for facing left. u indexes the angle pages.
  function view(f) {
    const { sp } = f, A = sp.angles.length;
    const psi = wrap(f.psi + (sp.cruiseYaw || 0) * Math.PI / 180 * Math.cos(f.psi));
    const flip = Math.abs(psi) > Math.PI / 2, yaw = (flip ? Math.sign(psi) * Math.PI - psi : psi) * 180 / Math.PI;
    const u = Math.min(Math.max((yaw - sp.angles[0].yaw) / sp.stepYaw, 0), A - 1);
    return { flip, yaw, u };
  }

  // Ask for the pages each fish shows now, the ones its turn reaches next, and their neighbours.
  // Is strip span [x0, x1] within `margin` px of the screen window?
  const inView = (x0, x1, margin = 0) => x1 > panX - margin && x0 < panX + SW + margin;

  function plan(dt) {
    // Backdrop and foreground columns: those on screen, and those the pan reaches next.
    const dir = Math.sign(panAt(panT + 0.5) - panX);
    for (const t of [...scene.backdrop, ...scene.foreground]) {
      const x0 = t.rect[0], x1 = x0 + t.rect[2];
      if (inView(x0, x1)) tex.want(t.file, tileBytes(t), 1);
      else if (inView(x0 - dir * 300, x1 - dir * 300)) tex.want(t.file, tileBytes(t), 2);
    }
    for (const sp of species) tex.want(sp.angles[sp.home].sheet, sp.angles[sp.home].mb * 1e6, 0);
    if (bubbles && inView(stone.pos[0] - 50, stone.pos[0] + 50, 300)) tex.want(B.sheet, bubbles.bytes, 1);
    for (const f of fish) {
      const { sp } = f, A = sp.angles.length, { u } = view(f), half = (sp.fw * f.scale) / 2;
      f.onScreen = inView(f.x - half, f.x + half, 150);   // just outside counts, so pages are ready
      if (!f.onScreen) continue;                         // off screen: its posters' uris are cleared
      f.du = dt > 0 ? (u - f.u) / dt : 0;
      f.u = u;
      const page = (r, prio) => { if (r >= 0 && r < A) tex.want(sp.angles[r].sheet, sp.angles[r].mb * 1e6, prio); };
      const r0 = Math.min(Math.floor(u), A - 2);
      page(r0, 1); page(r0 + 1, 1);
      // Where the shown angle will be in 0.4 s, and the pages on the way there.
      const ahead = Math.min(Math.max(u + f.du * 0.4, 0), A - 1);
      for (let r = Math.min(r0, Math.floor(ahead)); r <= Math.max(r0 + 1, Math.ceil(ahead)); r++) page(r, 2);
      page(r0 - 1, 3); page(r0 + 2, 3);
    }
    for (const L of waterLayers) {
      if (!L) continue;
      const n = L.frames.length, k = Math.floor((waterT * water.fps) % n);
      const k1 = (k + 1) % n;
      tex.want(L.frames[k], L.bytes, 1); tex.want(L.frames[k1], L.bytes, 2);
      if (L.steps) { tex.want(L.steps[k], L.bytes, 1); tex.want(L.steps[k1], L.bytes, 2); }
    }
    tex.update();
  }

  // The loaded page nearest angle r (a miss if it isn't r itself).
  function pageFor(sp, r) {
    for (let d = 0; d < sp.angles.length; d++) {
      for (const q of d ? [r - d, r + d] : [r]) {
        const img = q >= 0 && q < sp.angles.length && tex.get(sp.angles[q].sheet);
        if (img) { if (d) tex.misses++; return { a: sp.angles[q], img }; }
      }
    }
    return null;
  }

  function draw(f) {
    const { sp } = f, n = sp.frames, frame = Math.floor(f.phase * n) % n, A = sp.angles.length;
    const { flip, yaw, u } = view(f);
    const r0 = Math.min(Math.floor(u), A - 2), t = u - r0;
    // Climbing and diving tilt the side view; a head-on or tail-on view can't show it.
    const tiltW = Math.max(-0.35, Math.min(0.35, Math.atan2(f.vy, Math.abs(f.vx) + 1))) * Math.abs(Math.cos(yaw * Math.PI / 180));
    f.tilt += (tiltW - f.tilt) * 0.1;
    const bob = f.mode === 'cruise' ? 0 : Math.sin(f.phase * 1.3) * 2;
    g.save();
    g.translate(f.x, f.y + bob);
    if (flip) g.scale(-1, 1);
    g.rotate(f.tilt);
    // A cell is the angle page's crop of the full frameW x frameH cell, whose centre is the fish.
    const s = f.scale, drawn = new Set();
    const cell = (r, alpha) => {
      const p = pageFor(sp, r);
      if (!p || drawn.has(p.a)) return;   // the fallback for both angles is the same page: draw it once
      drawn.add(p.a);
      const { a, img } = p;
      g.globalAlpha = alpha;
      g.drawImage(img, (frame % a.cols) * a.w, Math.floor(frame / a.cols) * a.h, a.w, a.h,
        (a.x - sp.fw / 2) * s, (a.y - sp.fh / 2) * s, a.w * s, a.h * s);
    };
    // Nearer angle drawn solid, the other faded in over it.
    if (t < 0.5) { cell(r0, 1); if (t > 0.02) cell(r0 + 1, t); }
    else { cell(r0 + 1, 1); if (t < 0.98) cell(r0, 1 - t); }
    g.globalAlpha = 1;
    g.restore();
  }

  let paused = false, showHud = true, showWater = true, last = performance.now(), acc = 0, frames = 0, fpsShown = 0, fpsT = 0;
  let waterT = 0, panT = 0, panX = panAt(0), loadsShown = 0, loads0 = 0, missesShown = 0, misses0 = 0;
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { paused = !paused; e.preventDefault(); }
    if (e.code === 'KeyH') showHud = !showHud;
    if (e.code === 'KeyW') showWater = !showWater;
  });

  // Two posters per layer: frame k, and its step overlay at opacity t, which the bake encoded against
  // exactly what frame k leaves on screen, so together they are the linear blend towards frame k + 1.
  // If a frame hasn't loaded yet the last one shown holds (the water pauses rather than vanishing).
  function drawWater(L) {
    if (!L || !showWater) return;
    const n = L.frames.length, pos = (waterT * water.fps) % n, k = Math.floor(pos);
    const [x, y, w, h] = L.rect, cur = tex.get(L.frames[k]), step = L.steps && tex.get(L.steps[k]);
    if (cur) L.last = cur; else tex.misses++;
    if (!L.last) return;
    g.drawImage(L.last, x, y, w, h);
    if (cur && step) {
      g.globalAlpha = pos - k;
      g.drawImage(step, x, y, w, h);
      g.globalAlpha = 1;
    }
  }

  // Tiles (backdrop or foreground columns) on screen; a backdrop column not loaded yet is water blue.
  function drawTiles(tiles, fill) {
    for (const t of tiles) {
      const [x, y, w, h] = t.rect;
      if (!inView(x, x + w)) continue;
      const img = tex.get(t.file);
      if (img) g.drawImage(img, x, y);
      else if (fill) { g.fillStyle = '#0b3a55'; g.fillRect(x, y, w, h); tex.misses++; }
    }
  }

  function render() {
    fish.sort((a, b) => a.depth - b.depth);   // depth changes as fish swim nearer or further
    g.save();
    g.translate(-Math.round(panX), 0);
    drawTiles(scene.backdrop, true);
    drawWater(waterLayers[0]);
    if (bubbles && inView(stone.pos[0] - 50, stone.pos[0] + 50)) drawBubbles();   // the airstone is at the back
    for (const f of fish) if (f.onScreen && f.depth <= NEAR) draw(f);
    drawTiles(scene.foreground, false);
    drawWater(waterLayers[1]);
    for (const f of fish) if (f.onScreen && f.depth > NEAR) draw(f);
    g.restore();
  }

  function loop(now) {
    nextFrame(loop);
    acc += now - last;
    last = now;
    // Run at the Roku's frame rate, not the monitor's.
    if (acc < 1000 / FPS - 2) return;     // tolerance so 60 Hz vsync lands on every 2nd frame
    const dt = Math.min(acc / 1000, 0.1);
    acc = 0;
    if (!paused) {
      for (const f of fish) step(f, dt);
      waterT += dt;
      panT += dt;
      if (bubbles) stepBubbles(dt);
    }
    panX = panAt(panT);
    plan(paused ? 0 : dt);
    render();
    frames++;
    if (now - fpsT > 1000) {
      fpsShown = frames; frames = 0; fpsT = now;
      loadsShown = tex.loads - loads0; loads0 = tex.loads;
      missesShown = tex.misses - misses0; misses0 = tex.misses;
    }
    const mb = (b) => (b / 1e6).toFixed(1);
    hud.textContent = showHud
      ? `Roku preview  ${sceneKey}  ${fish.length} fish  ${fpsShown}/${FPS} fps${paused ? '  paused' : ''}${water ? '' : '  (no water loop: re-bake)'}\n`
        + `textures ${mb(tex.used)}/${BUDGET_MB} MB (peak ${mb(tex.peak)}, needed ${mb(tex.need)})  ${tex.map.size} bitmaps  ${loadsShown} loads/s  ${missesShown} misses/s\n`
        + 'H hud  W water  Space pause'
      : '';
  }
  nextFrame(loop);
}

main().catch((e) => fail(e.message));
