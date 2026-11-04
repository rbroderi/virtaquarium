// Fish lab reference tooling (docs/photoreal-fish-plan.md, phase 0): put a real photo over the render at
// the same framing and measure how far apart they are.
//
//   lab.html?sp=clownfish&ref=1            load pc/ref/clownfish/refs.json
//   lab.html?sp=clownfish&refimg=<url>     try any image without a sidecar
//   drop a photo onto the page             same; "save" copies it and refs.json into pc/ref/<sp>/
//
// pc/ref/<sp>/refs.json: { "refs": [ { "file", "source", "license", "mirror", "yaw", "pitch", "fov",
//   "light": { "az", "el" }, "outline": [[x, y], ...], "patches": [{ "name", "x", "y", "r" }] } ] }
// Outline and patches are in photo pixels. The render is measured as a coverage mask: the scene is drawn
// over black and over white, so translucent fins count by how much they actually hide.
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);

export function installReference(lab) {
  const params = new URLSearchParams(location.search);
  const cv = $('refcv'), ctx = cv.getContext('2d'), out = $('refout');
  let active = false, refs = [], cur = null, img = null, pix = null;   // pix: the photo's ImageData
  let view = { s: 1, tx: 0, ty: 0 };   // photo px -> CSS px
  let edge = null, spots = [], dirty = true, drag = null, loadedFor = null;   // spots: where the render was sampled
  const W = () => cv.clientWidth, H = () => cv.clientHeight;
  const say = (msg) => { out.textContent = msg; };
  const redraw = () => { dirty = true; };

  const toView = ([x, y]) => [view.tx + view.s * (cur.mirror ? img.naturalWidth - x : x), view.ty + view.s * y];
  const toPhoto = ([u, v]) => { const x = (u - view.tx) / view.s; return [cur.mirror ? img.naturalWidth - x : x, (v - view.ty) / view.s]; };

  // ---------- drawing ----------
  function draw() {
    const dpr = devicePixelRatio, w = W(), h = H();
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!active || !img) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mode = $('refview').value, mix = $('refmix').value / 100;
    if (mode !== 'render') {
      ctx.save();
      if (mode === 'wipe') { ctx.beginPath(); ctx.rect(w * mix, 0, w, h); ctx.clip(); }
      if (mode === 'blend') ctx.globalAlpha = mix;
      else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
      ctx.translate(view.tx, view.ty); ctx.scale(view.s, view.s);
      if (cur.mirror) { ctx.translate(img.naturalWidth, 0); ctx.scale(-1, 1); }
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    }
    if (mode === 'wipe') { ctx.strokeStyle = '#fff8'; ctx.beginPath(); ctx.moveTo(w * mix, 0); ctx.lineTo(w * mix, h); ctx.stroke(); }
    if (edge) { ctx.fillStyle = '#0ff'; for (const [x, y] of edge) ctx.fillRect(x, y, 1, 1); }
    if (cur.outline.length) {
      ctx.strokeStyle = '#ff0'; ctx.fillStyle = '#ff0'; ctx.lineWidth = 1;
      ctx.beginPath();
      cur.outline.forEach((p, i) => { const [u, v] = toView(p); i ? ctx.lineTo(u, v) : ctx.moveTo(u, v); });
      if (cur.outline.length > 2) ctx.closePath();
      ctx.stroke();
      for (const p of cur.outline) { const [u, v] = toView(p); ctx.fillRect(u - 1.5, v - 1.5, 3, 3); }
    }
    ctx.font = '11px system-ui'; ctx.lineWidth = 1.5;
    for (const p of cur.patches) {
      const [u, v] = toView([p.x, p.y]);
      ctx.strokeStyle = '#f0f'; ctx.beginPath(); ctx.arc(u, v, Math.max(2, p.r * view.s), 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#f0f'; ctx.fillText(p.name, u + p.r * view.s + 3, v + 4);
    }
    // Where the last measure sampled the render (valid while its silhouette edge is).
    if (edge) {
      ctx.strokeStyle = '#0ff'; ctx.fillStyle = '#0ff'; ctx.setLineDash([3, 2]);
      for (const [u, v, r, name] of spots) {
        ctx.beginPath(); ctx.arc(u, v, Math.max(2, r), 0, Math.PI * 2); ctx.stroke();
        ctx.fillText(name, u + r + 3, v + 14);
      }
      ctx.setLineDash([]);
    }
  }
  (function loop() { requestAnimationFrame(loop); if (dirty) { dirty = false; draw(); } })();
  addEventListener('resize', () => { edge = null; redraw(); });

  // ---------- loading ----------
  const normalise = (r, dir) => ({ mirror: false, yaw: 0, pitch: 0, fov: 30, light: null, outline: [], patches: [], ...r, url: r.url || new URL(r.file, dir).href });

  async function loadSet() {
    const sp = lab.species(), dir = new URL(`./ref/${sp}/`, location.href);
    refs = [];
    try {
      const r = await fetch(new URL('refs.json', dir), { cache: 'no-cache' });
      if (r.ok) refs = ((await r.json()).refs || []).map((x) => normalise(x, dir));
    } catch { /* no sidecar yet */ }
    const q = params.get('refimg');
    if (q) {
      const u = new URL(q, location.href);
      if (!refs.some((r) => r.url === u.href)) refs.push(normalise({ file: u.pathname }, dir));
    }
    loadedFor = sp;
    fillSelect();
    await select(0);
  }

  function fillSelect() {
    const s = $('refsel');
    s.length = 0;
    refs.forEach((r, i) => s.add(new Option(r.file.split('/').pop(), i)));
  }

  let selecting = 0;
  async function select(i) {
    const n = ++selecting;
    cur = refs[i] || null; img = null; pix = null; edge = null;
    if (!cur) { say(`No reference photos for ${lab.species()}. Drop a side-on photo here, or add pc/ref/${lab.species()}/refs.json.`); redraw(); return; }
    $('refsel').value = i;
    const im = new Image();
    // The load event, not decode(): decode() can stay pending while the page is in a background tab.
    const loaded = new Promise((res, rej) => { im.onload = res; im.onerror = rej; });
    im.src = cur.url;
    try { await loaded; } catch { if (n === selecting) say(`Could not load ${cur.url}`); return; }
    if (n !== selecting) return;   // a newer selection won the race
    img = im;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    pix = g.getImageData(0, 0, c.width, c.height);
    syncInputs(); applyPose(); fit();
    if (cur.outline.length > 2) align();
    say(`${cur.file}  ${img.naturalWidth}x${img.naturalHeight}${cur.author ? `  by ${cur.author}` : ''}${cur.license ? `  (${cur.license})` : ''}${cur.source ? `\n${cur.source}` : ''}\n` +
      'Trace the outline, add colour patches, then "align" and "measure".');
    redraw();
  }

  function syncInputs() {
    $('refmirror').checked = cur.mirror; $('refpitch').value = cur.pitch; $('reffov').value = cur.fov;
    $('refaz').value = cur.light?.az ?? 23; $('refel').value = cur.light?.el ?? 70;
  }

  function applyPose() {
    lab.setSwim(false); lab.setSpin(false);
    lab.setYaw(cur.yaw); lab.setPitch(cur.pitch); lab.setFov(cur.fov);
    lab.setLightDir(cur.light?.az ?? 23, cur.light?.el ?? 70);
    edge = null; redraw();
  }

  function fit() {
    const w = W(), h = H(), m = 0.05;
    view.s = Math.min(w * (1 - 2 * m) / img.naturalWidth, h * (1 - 2 * m) / img.naturalHeight);
    view.tx = (w - img.naturalWidth * view.s) / 2; view.ty = (h - img.naturalHeight * view.s) / 2;
    redraw();
  }

  // ---------- render masks ----------
  function coverageMask() {
    const w = W(), h = H(), { renderer, scene, backdrop, camera } = lab;
    // The lab's frame loop may not have run yet (e.g. right after load), so match the aspect here.
    camera.aspect = w / h; camera.updateProjectionMatrix();
    const rt = new THREE.WebGLRenderTarget(w, h);
    const bg = scene.background, vis = backdrop.visible, bufs = [];
    backdrop.visible = false;
    for (const c of [0x000000, 0xffffff]) {
      scene.background = new THREE.Color(c);
      renderer.setRenderTarget(rt);
      lab.render();
      const b = new Uint8Array(w * h * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, b);
      bufs.push(b);
    }
    renderer.setRenderTarget(null);
    scene.background = bg; backdrop.visible = vis;
    rt.dispose();
    const [k, wh] = bufs, mask = new Uint8Array(w * h);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w;   // GL rows are bottom-up
      for (let x = 0; x < w; x++) {
        const i = (src + x) * 4;
        const cover = 1 - (wh[i] - k[i] + wh[i + 1] - k[i + 1] + wh[i + 2] - k[i + 2]) / 765;
        if (cover >= 0.5) { mask[y * w + x] = 1; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    return { w, h, mask, box: x1 < 0 ? null : { x0, y0, x1, y1 } };
  }

  function outlineMask(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.beginPath();
    cur.outline.forEach((p, i) => { const [u, v] = toView(p); i ? g.lineTo(u, v) : g.moveTo(u, v); });
    g.closePath(); g.fillStyle = '#fff'; g.fill();
    const d = g.getImageData(0, 0, w, h).data, mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4 + 3] > 127 ? 1 : 0;
    return mask;
  }

  // ---------- align / measure ----------
  function align() {
    if (!img) return;
    if (cur.outline.length < 3) { say('Trace the fish outline first (outline tool), then align.'); return; }
    const { box } = coverageMask();
    if (!box) { say('No fish on screen to align to.'); return; }
    const xs = cur.outline.map((p) => p[0]), ys = cur.outline.map((p) => p[1]);
    const px0 = Math.min(...xs), px1 = Math.max(...xs), py0 = Math.min(...ys), py1 = Math.max(...ys);
    // Match fish length (horizontal extent), then centre the boxes.
    view.s = (box.x1 - box.x0 + 1) / (px1 - px0); view.tx = 0; view.ty = 0;
    const [cx, cy] = toView([(px0 + px1) / 2, (py0 + py1) / 2]);
    view.tx = (box.x0 + box.x1 + 1) / 2 - cx; view.ty = (box.y0 + box.y1 + 1) / 2 - cy;
    redraw();
  }

  function measure() {
    if (!img) return;
    const { w, h, mask, box } = coverageMask();
    if (!box) { say('No fish on screen.'); return; }
    const len = box.x1 - box.x0 + 1, lines = [`render length ${len} px`];
    const rEdge = boundary(mask, w, h);
    edge = rEdge;
    const pm = cur.outline.length > 2 ? outlineMask(w, h) : null;
    if (pm) {
      let inter = 0, uni = 0, rOnly = 0, pOnly = 0, pArea = 0;
      for (let i = 0; i < mask.length; i++) {
        const a = mask[i], b = pm[i];
        if (a && b) inter++; if (a || b) uni++; if (a && !b) rOnly++; if (b && !a) pOnly++; if (b) pArea++;
      }
      const d = boundaryDistance(rEdge, boundary(pm, w, h));
      const iou = inter / Math.max(1, uni);
      lines.push(
        `silhouette IoU ${iou.toFixed(3)}  ${iou >= 0.97 ? 'PASS' : 'target >= 0.970'}`,
        `boundary distance  mean ${d.mean.toFixed(1)} px  max ${d.max.toFixed(1)} px  (max ${(100 * d.max / len).toFixed(1)}% of length)`,
        `render outside photo ${(100 * rOnly / pArea).toFixed(1)}%   photo not covered ${(100 * pOnly / pArea).toFixed(1)}%`,
      );
    } else lines.push('(no outline traced: silhouette metrics skipped)');

    let html = lines.join('\n');
    if (cur.patches.length) {
      // Sample the on-screen frame (same tone mapping the viewer sees).
      lab.render();
      const gl = lab.canvas, c = document.createElement('canvas');
      c.width = gl.width; c.height = gl.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(gl, 0, 0);
      const shot = g.getImageData(0, 0, c.width, c.height), k = gl.width / W();
      // With an outline, each render patch goes to the same anatomical spot: the same fraction of length
      // from the snout, and the same fraction of the local dorsal-to-ventral height (fins included), so a
      // band patch lands on the render's band even when the bands sit elsewhere on screen.
      const anat = pm ? { from: silhouette(pm, w, h), to: silhouette(mask, w, h) } : null;
      html += `\n\ncolour patches (CIEDE2000, target <= 5; render sampled by ${anat ? 'anatomical position' : 'screen position'})`;
      spots = [];
      const rows = [];
      for (const p of cur.patches) {
        const a = meanLinear(pix, p.x, p.y, p.r);
        if (!a) { html += `\n${p.name.padEnd(10)} outside the photo`; continue; }
        let [u, v] = toView([p.x, p.y]), r = p.r * view.s, moved = null;
        if (anat) {
          const m = mapAnatomy(anat.from, anat.to, u, v);
          if (!m) { html += `\n${p.name.padEnd(10)} not on the photo outline`; continue; }
          [u, v] = m; r *= anat.to.len / anat.from.len;
          // Pattern features (bands, margins) may sit elsewhere on the render; snap to the nearest render
          // area of the same kind, so colour is compared feature to feature and placement is reported apart.
          const s = snapToKind(shot, mask, w, k, u, v, r, colourKind(linearToLab(a)), 0.15 * len);
          if (s) { moved = Math.hypot(s[0] - u, s[1] - v) / len; [u, v] = s; }
          else moved = Infinity;
        }
        spots.push([u, v, r, p.name]);
        const b = meanLinear(shot, u * k, v * k, r * k);
        if (!b) { html += `\n${p.name.padEnd(10)} outside the render`; continue; }
        rows.push({ p, a, b, moved });
      }
      // White reference: photo exposure and colour cast are arbitrary, so also compare each image after
      // dividing by its own white band (von Kries), which leaves only relative colour.
      const ref = rows.find((x) => x.p.name.startsWith('band') && colourKind(linearToLab(x.a)) === 'white');
      const norm = (c, w) => c.map((x, i) => (0.9 * x) / Math.max(1e-4, w[i]));
      if (ref) html += `\nwhite reference: ${ref.p.name} (wr = after dividing each image by it)`;
      for (const { p, a, b, moved } of rows) {
        const de = ciede2000(linearToLab(a), linearToLab(b));
        const wr = ref && ref.p !== p ? ciede2000(linearToLab(norm(a, ref.a)), linearToLab(norm(b, ref.b))) : null;
        const where = moved == null ? '' : moved === Infinity ? '  (no matching feature nearby)' : moved > 0.005 ? `  (feature ${(100 * moved).toFixed(1)}% of length away)` : '';
        html += `\n<span class="sw" style="background:${hex(a)}"></span><span class="sw" style="background:${hex(b)}"></span> ` +
          `${p.name.padEnd(10)} photo ${hex(a)}  render ${hex(b)}  dE ${de.toFixed(1)}` +
          (wr == null ? '' : `  wr ${wr.toFixed(1)}${wr <= 5 ? ' PASS' : ''}`) + where;
      }
    }
    out.innerHTML = html;
    redraw();
  }

  // ---------- saving ----------
  async function save() {
    const sp = lab.species();
    const post = async (rel, body) => {
      const r = await fetch(`/__save?path=${encodeURIComponent(`pc/ref/${sp}/${rel}`)}`, { method: 'POST', body });
      if (!r.ok) throw new Error(`save ${rel}: HTTP ${r.status}`);
    };
    try {
      for (const r of refs.filter((x) => x.blob)) {
        const name = r.file.replace(/[^\w.-]+/g, '_');
        await post(name, r.blob);
        r.file = name; r.url = new URL(`./ref/${sp}/${name}`, location.href).href; delete r.blob;
      }
      const json = { refs: refs.map(({ url, blob, ...r }) => r) };
      await post('refs.json', JSON.stringify(json, null, 2) + '\n');
      fillSelect(); $('refsel').value = refs.indexOf(cur);
      say(`Saved ${refs.length} reference(s) to pc/ref/${sp}/refs.json`);
    } catch (e) { say(e.message); }
  }

  // ---------- input ----------
  function setActive(on) {
    active = on;
    $('ref').checked = on; $('refbar').hidden = !on;
    cv.classList.toggle('active', on);
    if (on && loadedFor !== lab.species()) loadSet();
    redraw();
  }
  $('ref').onchange = (e) => setActive(e.target.checked);
  $('sp').addEventListener('change', () => { refs = []; cur = null; img = null; loadedFor = null; if (active) loadSet(); redraw(); });
  $('yaw').addEventListener('input', (e) => { if (cur) cur.yaw = Number(e.target.value); edge = null; redraw(); });
  $('refsel').onchange = (e) => select(Number(e.target.value));
  $('refview').onchange = redraw; $('refmix').oninput = redraw;
  $('refmirror').onchange = (e) => { if (cur) { cur.mirror = e.target.checked; redraw(); } };
  $('refpitch').onchange = (e) => { if (cur) { cur.pitch = Number(e.target.value); applyPose(); } };
  $('reffov').onchange = (e) => { if (cur) { cur.fov = Number(e.target.value); applyPose(); } };
  $('refaz').onchange = $('refel').onchange = () => { if (cur) { cur.light = { az: Number($('refaz').value), el: Number($('refel').value) }; applyPose(); } };
  $('reffit').onclick = () => img && fit();
  $('refalign').onclick = align;
  $('refmeasure').onclick = measure;
  $('refundo').onclick = () => { if (cur) { cur.outline.pop(); redraw(); } };
  $('refclear').onclick = () => { if (cur) { cur.outline = []; cur.patches = []; edge = null; redraw(); } };
  $('refsave').onclick = save;
  const tool = () => document.querySelector('input[name=reftool]:checked').value;

  cv.addEventListener('pointerdown', (e) => {
    if (!img) return;
    const t = tool();
    if (t === 'pan') { drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }; cv.setPointerCapture(e.pointerId); return; }
    const [x, y] = toPhoto([e.clientX, e.clientY]).map((v) => Math.round(v * 10) / 10);
    if (t === 'outline') cur.outline.push([x, y]);
    if (t === 'patch') {
      const name = $('patchname').value.trim() || `p${cur.patches.length + 1}`;
      cur.patches = cur.patches.filter((p) => p.name !== name).concat({ name, x, y, r: Number($('patchr').value) || 12 });
    }
    redraw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    view.tx = drag.tx + e.clientX - drag.x; view.ty = drag.ty + e.clientY - drag.y;
    redraw();
  });
  cv.addEventListener('pointerup', () => { drag = null; });
  cv.addEventListener('wheel', (e) => {
    if (!img) return;
    e.preventDefault();
    const k = Math.exp(-e.deltaY * 0.0015);
    view.tx = e.clientX - (e.clientX - view.tx) * k; view.ty = e.clientY - (e.clientY - view.ty) * k; view.s *= k;
    redraw();
  }, { passive: false });
  addEventListener('keydown', (e) => {
    if (!active || !cur || e.target.matches('input, select, textarea')) return;
    if (e.key === 'Backspace') { cur.outline.pop(); redraw(); e.preventDefault(); }
  });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
    if (!f) return;
    // Load the species' existing refs first so "save" adds to refs.json instead of replacing it.
    if (loadedFor !== lab.species()) await loadSet();
    refs.push(normalise({ file: f.name, url: URL.createObjectURL(f), blob: f }, location.href));
    if (!active) setActive(true);
    fillSelect();
    select(refs.length - 1);
  });

  // Screenshot: what is on screen (render plus any photo overlay) as a PNG.
  $('shot').onclick = () => {
    lab.render();
    const gl = lab.canvas, c = document.createElement('canvas');
    c.width = gl.width; c.height = gl.height;
    const g = c.getContext('2d');
    g.drawImage(gl, 0, 0);
    if (active) g.drawImage(cv, 0, 0, c.width, c.height);
    c.toBlob((b) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `lab-${lab.species()}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  };

  if (params.get('ref') === '1' || params.has('refimg')) setActive(true);
  // Console/debug access.
  lab.ref = { current: () => cur, view: () => view, align, measure, redraw };
}

// ---------- pixel helpers ----------
const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const toSrgb = (c) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)));
const hex = ([r, g, b]) => '#' + [r, g, b].map((c) => toSrgb(c).toString(16).padStart(2, '0')).join('');

// Mean linear RGB of a disc (centre and radius in the image's pixels); null if it misses the image.
function meanLinear({ data, width, height }, cx, cy, r) {
  let n = 0, R = 0, G = 0, B = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(height - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(width - 1, Math.ceil(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const i = (y * width + x) * 4;
      R += toLin(data[i]); G += toLin(data[i + 1]); B += toLin(data[i + 2]); n++;
    }
  }
  return n ? [R / n, G / n, B / n] : null;
}

// Per-column dorsal/ventral extent of a silhouette mask. The fish faces +x on screen (mirror the photo
// to match), so the snout is at x1.
function silhouette(mask, w, h) {
  const top = new Int32Array(w).fill(-1), bot = new Int32Array(w).fill(-1);
  let x0 = w, x1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    if (top[x] < 0) top[x] = y;
    bot[x] = y;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
  }
  return { top, bot, x0, x1, len: x1 - x0 + 1 };
}

// Coarse colour class of a patch: pattern whites (bright and unsaturated, even if under-exposed), black
// margins, saturated colour, or in between.
function colourKind([L, a, b]) {
  const C = Math.hypot(a, b);
  if (L < 30) return 'dark';
  if (C < 18 && L > 50) return 'white';
  if (C > 30) return 'colour';
  return 'other';
}

// Nearest point (CSS px) to (cx, cy), within `reach`, where a disc of radius r/2 on the render frame is
// all `kind` and on the fish (or, failing that, at least 80%). shot is the frame at k buffer px per CSS px.
function snapToKind(shot, mask, w, k, cx, cy, r, kind, reach) {
  return snapAt(shot, mask, w, k, cx, cy, r, kind, reach, 1) || snapAt(shot, mask, w, k, cx, cy, r, kind, reach, 0.8);
}

function snapAt(shot, mask, w, k, cx, cy, r, kind, reach, need) {
  const { data, width } = shot;
  const kindAt = (x, y) => {
    const i = (Math.round(y * k) * width + Math.round(x * k)) * 4;
    return colourKind(linearToLab([toLin(data[i]), toLin(data[i + 1]), toLin(data[i + 2])])) === kind;
  };
  const rr = Math.max(1, r / 2), step = Math.max(1, Math.round(rr / 2));
  let best = null, bestD = Infinity;
  for (let y = Math.round(cy - reach); y <= cy + reach; y += step) {
    for (let x = Math.round(cx - reach); x <= cx + reach; x += step) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d >= bestD || d > reach * reach || x < 0 || y < 0 || x >= w || !mask[y * w + x] || !kindAt(x, y)) continue;
      let n = 0, hit = 0;
      for (let dy = -rr; dy <= rr; dy += Math.max(1, rr / 3)) for (let dx = -rr; dx <= rr; dx += Math.max(1, rr / 3)) {
        if (dx * dx + dy * dy > rr * rr) continue;
        n++; if (mask[Math.round(y + dy) * w + Math.round(x + dx)] && kindAt(x + dx, y + dy)) hit++;
      }
      if (hit >= need * n) { best = [x, y]; bestD = d; }
    }
  }
  return best;
}

// Screen point on silhouette A -> the same anatomical spot on silhouette B, or null if it is off A.
function mapAnatomy(A, B, x, y) {
  const xa = Math.min(A.x1, Math.max(A.x0, Math.round(x)));   // patches may sit right on the outline
  if (A.top[xa] < 0) return null;
  const u = (A.x1 - x) / A.len, v = (y - A.top[xa]) / Math.max(1, A.bot[xa] - A.top[xa]);
  let xb = Math.round(B.x1 - u * B.len);
  // Columns can be empty between separated fins; step towards the body until one is filled.
  for (let d = 0; d < B.len && B.top[xb] < 0; d++) xb += xb > (B.x0 + B.x1) / 2 ? -1 : 1;
  if (B.top[xb] < 0) return null;
  return [xb, B.top[xb] + v * (B.bot[xb] - B.top[xb])];
}

function boundary(mask, w, h) {
  const pts = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mask[i] && (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w])) pts.push([x, y]);
  }
  return pts;
}

// Symmetric boundary distance (mean and Hausdorff max), on up to 1500 points per side.
function boundaryDistance(A, B) {
  const sub = (P) => { const s = Math.max(1, Math.ceil(P.length / 1500)); return P.filter((_, i) => i % s === 0); };
  const a = sub(A), b = sub(B);
  const one = (P, Q) => {
    let sum = 0, max = 0;
    for (const [x, y] of P) {
      let m = Infinity;
      for (const [u, v] of Q) { const d = (x - u) ** 2 + (y - v) ** 2; if (d < m) m = d; }
      m = Math.sqrt(m); sum += m; if (m > max) max = m;
    }
    return { mean: sum / Math.max(1, P.length), max };
  };
  if (!a.length || !b.length) return { mean: NaN, max: NaN };
  const ab = one(a, b), ba = one(b, a);
  return { mean: (ab.mean + ba.mean) / 2, max: Math.max(ab.max, ba.max) };
}

// Linear sRGB (D65) -> CIE L*a*b*.
export function linearToLab([r, g, b]) {
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const Z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// CIEDE2000 colour difference (Sharma, Wu & Dalal 2005).
export function ciede2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180, p7 = (c) => c ** 7 / (c ** 7 + 25 ** 7);
  const G = 0.5 * (1 - Math.sqrt(p7((Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1 = Math.hypot(a1p, b1), C2 = Math.hypot(a2p, b2);
  const hue = (b, a) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1 = hue(b1, a1p), h2 = hue(b2, a2p);
  let dh = 0;
  if (C1 * C2 !== 0) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dL = L2 - L1, dC = C2 - C1, dH = 2 * Math.sqrt(C1 * C2) * Math.sin(dh * rad / 2);
  const Lm = (L1 + L2) / 2, Cm = (C1 + C2) / 2;
  let hm = h1 + h2;
  if (C1 * C2 !== 0) hm = Math.abs(h1 - h2) <= 180 ? hm / 2 : hm < 360 ? (hm + 360) / 2 : (hm - 360) / 2;
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const Rt = -2 * Math.sqrt(p7(Cm)) * Math.sin(2 * 30 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad);
  const SL = 1 + 0.015 * (Lm - 50) ** 2 / Math.sqrt(20 + (Lm - 50) ** 2), SC = 1 + 0.045 * Cm, SH = 1 + 0.015 * Cm * T;
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + Rt * (dC / SC) * (dH / SH));
}
