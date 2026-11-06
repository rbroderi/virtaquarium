// Fish lab reference tooling (docs/photoreal-fish-plan.md, phase 0): put a real photo over the render at
// the same framing and measure how far apart they are.
//
//   lab.html?sp=clownfish&ref=1            load ref/clownfish/refs.json
//   lab.html?sp=clownfish&refimg=<url>     try any image without a sidecar
//   drop a photo onto the page             same; "save" copies it and refs.json into ref/<sp>/
//
// The page's ref/ directory is served from pc/ref/ with this build's saves layered over it
// (tools/serve.ts). See labRef/refs.ts for the refs.json format, labRef/coverage.ts for the masks.
import { context2d, errorMessage, makeCanvas, requireElement } from './util.js';
import { ciede2000, colourKind, linearToHex, linearToLab, meanLinear, type LinearRgb } from './labRef/colour.js';
import { coverageMask, outlineMask } from './labRef/coverage.js';
import type { LabHost } from './labRef/labHost.js';
import { boundary, boundaryDistance, mapAnatomy, silhouette, snapToKind, type Pixel } from './labRef/masks.js';
import { photoToView, rotationOf, viewToPhoto, type ViewTransform } from './labRef/photoView.js';
import { DEFAULT_LIGHT, normaliseRef, parseRefSet, serialiseRef, type Patch, type RefPhoto } from './labRef/refs.js';

export type { LabHost, ReferenceDebug } from './labRef/labHost.js';
export { ciede2000, linearToLab } from './labRef/colour.js';

const FIT_MARGIN = 0.05;
const MIN_MARKER_RADIUS = 2;
const OUTLINE_DOT = 3;
const IOU_TARGET = 0.97;
const DELTA_E_TARGET = 5;
const SNAP_REACH = 0.15;           // fraction of fish length a patch may snap to its feature
const MOVED_REPORT = 0.005;        // fraction of length below which a snapped patch counts as in place
const WHITE_REFERENCE_LEVEL = 0.9;
const MIN_WHITE = 1e-4;
const WHEEL_ZOOM = 0.0015;
const DEFAULT_PATCH_RADIUS = 12;
const POINT_PRECISION = 10;        // outline points kept to 0.1 photo px
const PATCH_NAME_WIDTH = 10;
const REVOKE_DELAY_MS = 1000;
const MIX_PERCENT = 100;

/** The DOM controls of the reference bar (lab.html). */
function controls() {
  const input = (id: string): HTMLInputElement => requireElement(id, HTMLInputElement);
  const button = (id: string): HTMLButtonElement => requireElement(id, HTMLButtonElement);
  return {
    canvas: requireElement('refcv', HTMLCanvasElement),
    out: requireElement('refout', HTMLPreElement),
    bar: requireElement('refbar', HTMLDivElement),
    toggle: input('ref'),
    species: requireElement('sp', HTMLSelectElement),
    yaw: input('yaw'),
    select: requireElement('refsel', HTMLSelectElement),
    view: requireElement('refview', HTMLSelectElement),
    mix: input('refmix'),
    mirror: input('refmirror'),
    rot: input('refrot'),
    pitch: input('refpitch'),
    fov: input('reffov'),
    az: input('refaz'),
    el: input('refel'),
    patchName: input('patchname'),
    patchRadius: input('patchr'),
    fit: button('reffit'),
    align: button('refalign'),
    measure: button('refmeasure'),
    undo: button('refundo'),
    clear: button('refclear'),
    save: button('refsave'),
    shot: button('shot'),
  };
}
type Controls = ReturnType<typeof controls>;

/** A loaded reference photo and its pixels. */
interface LoadedPhoto { readonly img: HTMLImageElement; readonly pixels: ImageData }

/** Where the last measure sampled the render: CSS position, radius and patch name. */
type Spot = readonly [u: number, v: number, r: number, name: string];

interface PatchRow { readonly p: Patch; readonly a: LinearRgb; readonly b: LinearRgb; readonly moved: number | null }

/** The last measure's patches in linear RGB (for calibration from the console). */
interface CalibrationRow {
  readonly name: string;
  readonly photo: LinearRgb;
  readonly render: LinearRgb;
  readonly photoWhite: LinearRgb | undefined;
  readonly renderWhite: LinearRgb | undefined;
}

type ViewMode = 'wipe' | 'blend' | 'photo' | 'render';
type Tool = 'pan' | 'outline' | 'patch';

const isTool = (v: string): v is Tool => v === 'pan' || v === 'outline' || v === 'patch';
const toViewMode = (v: string): ViewMode => (v === 'blend' || v === 'photo' || v === 'render' ? v : 'wipe');

function loadImage(url: string): Promise<HTMLImageElement> {
  const im = new Image();
  // The load event, not decode(): decode() can stay pending while the page is in a background tab.
  const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error(`Could not load ${url}`));
  });
  im.src = url;
  return loaded;
}

function readPixels(img: HTMLImageElement): ImageData {
  const g = context2d(makeCanvas(img.naturalWidth, img.naturalHeight), { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, img.naturalWidth, img.naturalHeight);
}

/** A copy of a canvas's current pixels (the WebGL canvas can't be read with getImageData). */
function snapshot(source: HTMLCanvasElement): ImageData {
  const g = context2d(makeCanvas(source.width, source.height), { willReadFrequently: true });
  g.drawImage(source, 0, 0);
  return g.getImageData(0, 0, source.width, source.height);
}

class ReferenceTool {
  private readonly ctx: CanvasRenderingContext2D;
  private active = false;
  private refs: RefPhoto[] = [];
  private cur: RefPhoto | null = null;
  private photo: LoadedPhoto | null = null;
  private view: ViewTransform = { s: 1, tx: 0, ty: 0 };
  private edge: Pixel[] | null = null;   // the render's silhouette edge from the last measure
  private spots: Spot[] = [];
  private dirty = true;
  private drag: { readonly x: number; readonly y: number; readonly tx: number; readonly ty: number } | null = null;
  private loadedFor: string | null = null;
  private lastRows: CalibrationRow[] = [];
  private selecting = 0;

  constructor(private readonly lab: LabHost, private readonly ui: Controls, private readonly params: URLSearchParams) {
    this.ctx = context2d(ui.canvas);
  }

  private get width(): number { return this.ui.canvas.clientWidth; }
  private get height(): number { return this.ui.canvas.clientHeight; }
  private say(msg: string): void { this.ui.out.textContent = msg; }
  readonly redraw = (): void => { this.dirty = true; };

  private toView(ref: RefPhoto, photo: LoadedPhoto, p: readonly [number, number]): Pixel {
    return photoToView(ref, photo.img, this.view, p);
  }

  // ---------- drawing ----------
  private draw(): void {
    const { ctx } = this, canvas = this.ui.canvas, dpr = devicePixelRatio, w = this.width, h = this.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const { cur, photo } = this;
    if (!this.active || !photo || !cur) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mode = toViewMode(this.ui.view.value), mix = Number(this.ui.mix.value) / MIX_PERCENT;
    if (mode !== 'render') this.drawPhoto(cur, photo, mode, mix, w, h);
    if (mode === 'wipe') { ctx.strokeStyle = '#fff8'; ctx.beginPath(); ctx.moveTo(w * mix, 0); ctx.lineTo(w * mix, h); ctx.stroke(); }
    if (this.edge) { ctx.fillStyle = '#0ff'; for (const [x, y] of this.edge) ctx.fillRect(x, y, 1, 1); }
    this.drawOutline(cur, photo);
    this.drawPatches(cur, photo);
    this.drawSpots();
  }

  private drawPhoto(cur: RefPhoto, { img }: LoadedPhoto, mode: ViewMode, mix: number, w: number, h: number): void {
    const { ctx, view } = this;
    ctx.save();
    if (mode === 'wipe') { ctx.beginPath(); ctx.rect(w * mix, 0, w, h); ctx.clip(); }
    if (mode === 'blend') ctx.globalAlpha = mix;
    else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
    ctx.translate(view.tx, view.ty); ctx.scale(view.s, view.s);
    if (cur.mirror) { ctx.translate(img.naturalWidth, 0); ctx.scale(-1, 1); }
    ctx.translate(img.naturalWidth / 2, img.naturalHeight / 2); ctx.rotate(rotationOf(cur)); ctx.translate(-img.naturalWidth / 2, -img.naturalHeight / 2);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  private drawOutline(cur: RefPhoto, photo: LoadedPhoto): void {
    const { ctx } = this;
    if (!cur.outline.length) return;
    ctx.strokeStyle = '#ff0'; ctx.fillStyle = '#ff0'; ctx.lineWidth = 1;
    ctx.beginPath();
    cur.outline.forEach((p, i) => { const [u, v] = this.toView(cur, photo, p); if (i) ctx.lineTo(u, v); else ctx.moveTo(u, v); });
    if (cur.outline.length > 2) ctx.closePath();
    ctx.stroke();
    for (const p of cur.outline) { const [u, v] = this.toView(cur, photo, p); ctx.fillRect(u - OUTLINE_DOT / 2, v - OUTLINE_DOT / 2, OUTLINE_DOT, OUTLINE_DOT); }
  }

  private drawPatches(cur: RefPhoto, photo: LoadedPhoto): void {
    const { ctx, view } = this;
    ctx.font = '11px system-ui'; ctx.lineWidth = 1.5;
    for (const p of cur.patches) {
      const [u, v] = this.toView(cur, photo, [p.x, p.y]);
      ctx.strokeStyle = '#f0f'; ctx.beginPath(); ctx.arc(u, v, Math.max(MIN_MARKER_RADIUS, p.r * view.s), 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#f0f'; ctx.fillText(p.name, u + p.r * view.s + 3, v + 4);
    }
  }

  /** Where the last measure sampled the render (valid while its silhouette edge is). */
  private drawSpots(): void {
    const { ctx } = this;
    if (!this.edge) return;
    ctx.strokeStyle = '#0ff'; ctx.fillStyle = '#0ff'; ctx.setLineDash([3, 2]);
    for (const [u, v, r, name] of this.spots) {
      ctx.beginPath(); ctx.arc(u, v, Math.max(MIN_MARKER_RADIUS, r), 0, Math.PI * 2); ctx.stroke();
      ctx.fillText(name, u + r + 3, v + 14);
    }
    ctx.setLineDash([]);
  }

  startDrawLoop(): void {
    const loop = (): void => {
      requestAnimationFrame(loop);
      if (this.dirty) { this.dirty = false; this.draw(); }
    };
    loop();
  }

  // ---------- loading ----------
  async loadSet(): Promise<void> {
    const sp = this.lab.species(), dir = new URL(`./ref/${sp}/`, location.href);
    this.refs = [];
    try {
      const r = await fetch(new URL('refs.json', dir), { cache: 'no-cache' });
      if (r.ok) this.refs = parseRefSet(await r.json(), dir);
    } catch { /* no sidecar yet */ }
    const q = this.params.get('refimg');
    if (q) {
      const u = new URL(q, location.href);
      if (!this.refs.some((r) => r.url === u.href)) this.refs.push(normaliseRef({ file: u.pathname }, dir));
    }
    this.loadedFor = sp;
    this.fillSelect();
    await this.select(0);
  }

  private fillSelect(): void {
    const s = this.ui.select;
    s.length = 0;
    this.refs.forEach((r, i) => s.add(new Option(r.file.split('/').pop() ?? r.file, String(i))));
  }

  async select(i: number): Promise<void> {
    const n = ++this.selecting;
    const cur = this.refs[i] ?? null;
    this.cur = cur; this.photo = null; this.edge = null;
    if (!cur) {
      const sp = this.lab.species();
      this.say(`No reference photos for ${sp}. Drop a side-on photo here, or add ref/${sp}/refs.json.`);
      this.redraw();
      return;
    }
    this.ui.select.value = String(i);
    let img: HTMLImageElement;
    try { img = await loadImage(cur.url); } catch { if (n === this.selecting) this.say(`Could not load ${cur.url}`); return; }
    if (n !== this.selecting) return;   // a newer selection won the race
    this.photo = { img, pixels: readPixels(img) };
    this.syncInputs(cur); this.applyPose(); this.fit();
    if (cur.outline.length > 2) this.align();
    const credit = `${cur.author ? `  by ${cur.author}` : ''}${cur.license ? `  (${cur.license})` : ''}${cur.source ? `\n${cur.source}` : ''}`;
    this.say(`${cur.file}  ${img.naturalWidth}x${img.naturalHeight}${credit}\nTrace the outline, add colour patches, then "align" and "measure".`);
    this.redraw();
  }

  private syncInputs(cur: RefPhoto): void {
    const ui = this.ui;
    ui.mirror.checked = cur.mirror; ui.pitch.value = String(cur.pitch); ui.fov.value = String(cur.fov); ui.rot.value = String(cur.rot);
    ui.az.value = String(cur.light?.az ?? DEFAULT_LIGHT.az); ui.el.value = String(cur.light?.el ?? DEFAULT_LIGHT.el);
  }

  applyPose(): void {
    const { lab, cur } = this;
    if (!cur) return;
    lab.setSwim(false); lab.setSpin(false);
    lab.setYaw(cur.yaw); lab.setPitch(cur.pitch); lab.setFov(cur.fov);
    lab.setLightDir(cur.light?.az ?? DEFAULT_LIGHT.az, cur.light?.el ?? DEFAULT_LIGHT.el);
    this.edge = null; this.redraw();
  }

  fit(): void {
    if (!this.photo) return;
    const { img } = this.photo, w = this.width, h = this.height, m = FIT_MARGIN;
    this.view.s = Math.min((w * (1 - 2 * m)) / img.naturalWidth, (h * (1 - 2 * m)) / img.naturalHeight);
    this.view.tx = (w - img.naturalWidth * this.view.s) / 2;
    this.view.ty = (h - img.naturalHeight * this.view.s) / 2;
    this.redraw();
  }

  // ---------- align / measure ----------
  readonly align = (): void => {
    const { cur, photo } = this;
    if (!photo || !cur) return;
    if (cur.outline.length < 3) { this.say('Trace the fish outline first (outline tool), then align.'); return; }
    const { box } = coverageMask(this.lab, this.width, this.height);
    if (!box) { this.say('No fish on screen to align to.'); return; }
    // Outline box after rotation and mirroring (unit scale), then match fish length and centre the boxes.
    this.view = { s: 1, tx: 0, ty: 0 };
    const q = cur.outline.map((p) => this.toView(cur, photo, p)), xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
    const px0 = Math.min(...xs), px1 = Math.max(...xs), py0 = Math.min(...ys), py1 = Math.max(...ys);
    this.view.s = (box.x1 - box.x0 + 1) / (px1 - px0);
    this.view.tx = (box.x0 + box.x1 + 1) / 2 - (this.view.s * (px0 + px1)) / 2;
    this.view.ty = (box.y0 + box.y1 + 1) / 2 - (this.view.s * (py0 + py1)) / 2;
    this.redraw();
  };

  readonly measure = (): void => {
    const { cur, photo } = this;
    if (!photo || !cur) return;
    const { w, h, mask, box } = coverageMask(this.lab, this.width, this.height);
    if (!box) { this.say('No fish on screen.'); return; }
    const len = box.x1 - box.x0 + 1, lines = [`render length ${len} px`];
    const renderEdge = boundary(mask, w, h);
    this.edge = renderEdge;
    const photoMask = cur.outline.length > 2 ? outlineMask(cur.outline.map((p) => this.toView(cur, photo, p)), w, h) : null;
    if (photoMask) lines.push(...silhouetteReport(mask, photoMask, renderEdge, w, h, len));
    else lines.push('(no outline traced: silhouette metrics skipped)');
    let html = lines.join('\n');
    if (cur.patches.length) html += this.patchReport(cur, photo, mask, photoMask, w, h, len);
    this.ui.out.innerHTML = html;
    this.redraw();
  };

  /** Colour of each traced patch, photo against render (CIEDE2000), as HTML lines. */
  private patchReport(cur: RefPhoto, photo: LoadedPhoto, mask: Uint8Array, photoMask: Uint8Array | null, w: number, h: number, len: number): string {
    // Sample the on-screen frame (same tone mapping the viewer sees).
    this.lab.render();
    const gl = this.lab.canvas, shot = snapshot(gl), k = gl.width / this.width;
    // With an outline, each render patch goes to the same anatomical spot: the same fraction of length
    // from the snout, and the same fraction of the local dorsal-to-ventral height (fins included), so a
    // band patch lands on the render's band even when the bands sit elsewhere on screen.
    const anat = photoMask ? { from: silhouette(photoMask, w, h), to: silhouette(mask, w, h) } : null;
    let html = `\n\ncolour patches (CIEDE2000, target <= ${DELTA_E_TARGET}; render sampled by ${anat ? 'anatomical position' : 'screen position'})`;
    this.spots = [];
    const rows: PatchRow[] = [];
    const label = (p: Patch): string => p.name.padEnd(PATCH_NAME_WIDTH);
    for (const p of cur.patches) {
      const a = meanLinear(photo.pixels, p.x, p.y, p.r);
      if (!a) { html += `\n${label(p)} outside the photo`; continue; }
      let [u, v] = this.toView(cur, photo, [p.x, p.y]);
      let r = p.r * this.view.s, moved: number | null = null;
      if (anat) {
        const m = mapAnatomy(anat.from, anat.to, u, v);
        if (!m) { html += `\n${label(p)} not on the photo outline`; continue; }
        [u, v] = m; r *= anat.to.len / anat.from.len;
        // Pattern features (bands, margins) may sit elsewhere on the render; snap to the nearest render
        // area of the same kind, so colour is compared feature to feature and placement is reported apart.
        const s = snapToKind({ shot, mask, w, k, cx: u, cy: v, r, kind: colourKind(linearToLab(a)), reach: SNAP_REACH * len });
        if (s) { moved = Math.hypot(s[0] - u, s[1] - v) / len; [u, v] = s; }
        else moved = Infinity;
      }
      this.spots.push([u, v, r, p.name]);
      const b = meanLinear(shot, u * k, v * k, r * k);
      if (!b) { html += `\n${label(p)} outside the render`; continue; }
      rows.push({ p, a, b, moved });
    }
    // White reference: photo exposure and colour cast are arbitrary, so also compare each image after
    // dividing by its own white band (von Kries), which leaves only relative colour.
    const ref = rows.find((x) => x.p.name.startsWith('band') && colourKind(linearToLab(x.a)) === 'white');
    const scaled = (c: number, white: number): number => (WHITE_REFERENCE_LEVEL * c) / Math.max(MIN_WHITE, white);
    const norm = (c: LinearRgb, white: LinearRgb): LinearRgb => [scaled(c[0], white[0]), scaled(c[1], white[1]), scaled(c[2], white[2])];
    if (ref) html += `\nwhite reference: ${ref.p.name} (wr = after dividing each image by it)`;
    this.lastRows = rows.map(({ p, a, b }) => ({ name: p.name, photo: a, render: b, photoWhite: ref?.a, renderWhite: ref?.b }));
    for (const { p, a, b, moved } of rows) {
      const de = ciede2000(linearToLab(a), linearToLab(b));
      const wr = ref && ref.p !== p ? ciede2000(linearToLab(norm(a, ref.a)), linearToLab(norm(b, ref.b))) : null;
      const where = moved === null ? '' : moved === Infinity ? '  (no matching feature nearby)' : moved > MOVED_REPORT ? `  (feature ${(100 * moved).toFixed(1)}% of length away)` : '';
      html += `\n<span class="sw" style="background:${linearToHex(a)}"></span><span class="sw" style="background:${linearToHex(b)}"></span> ` +
        `${label(p)} photo ${linearToHex(a)}  render ${linearToHex(b)}  dE ${de.toFixed(1)}` +
        (wr === null ? '' : `  wr ${wr.toFixed(1)}${wr <= DELTA_E_TARGET ? ' PASS' : ''}`) + where;
    }
    return html;
  }

  // ---------- saving ----------
  /** Server path of this species' reference directory, from the page's own location. */
  private saveDir(sp: string): string {
    return new URL(`./ref/${sp}/`, location.href).pathname.replace(/^\//, '');
  }

  readonly save = async (): Promise<void> => {
    const sp = this.lab.species(), dir = this.saveDir(sp);
    const post = async (rel: string, body: BodyInit): Promise<void> => {
      const r = await fetch(`/__save?path=${encodeURIComponent(dir + rel)}`, { method: 'POST', body });
      if (!r.ok) throw new Error(`save ${rel}: HTTP ${r.status}`);
    };
    try {
      for (const r of this.refs) {
        if (!r.blob) continue;
        const name = r.file.replace(/[^\w.-]+/g, '_');
        await post(name, r.blob);
        r.file = name; r.url = new URL(`./ref/${sp}/${name}`, location.href).href; r.blob = null;
      }
      const json = { refs: this.refs.map(serialiseRef) };
      await post('refs.json', JSON.stringify(json, null, 2) + '\n');
      this.fillSelect();
      this.ui.select.value = String(this.cur ? this.refs.indexOf(this.cur) : -1);
      this.say(`Saved ${this.refs.length} reference(s) to ${dir}refs.json`);
    } catch (e) { this.say(errorMessage(e)); }
  };

  // ---------- input ----------
  setActive(on: boolean): void {
    this.active = on;
    this.ui.toggle.checked = on; this.ui.bar.hidden = !on;
    this.ui.canvas.classList.toggle('active', on);
    if (on && this.loadedFor !== this.lab.species()) void this.loadSet();
    this.redraw();
  }

  /** A ref is selected: apply an edit to it. */
  private edit(change: (cur: RefPhoto) => void): void {
    if (this.cur) change(this.cur);
  }

  private tool(): Tool {
    const checked = document.querySelector<HTMLInputElement>('input[name=reftool]:checked');
    return checked && isTool(checked.value) ? checked.value : 'pan';
  }

  bindInputs(): void {
    const ui = this.ui;
    ui.toggle.onchange = () => this.setActive(ui.toggle.checked);
    ui.species.addEventListener('change', () => {
      this.refs = []; this.cur = null; this.photo = null; this.loadedFor = null;
      if (this.active) void this.loadSet();
      this.redraw();
    });
    ui.yaw.addEventListener('input', () => { this.edit((c) => { c.yaw = Number(ui.yaw.value); }); this.edge = null; this.redraw(); });
    ui.select.onchange = () => void this.select(Number(ui.select.value));
    ui.view.onchange = this.redraw; ui.mix.oninput = this.redraw;
    ui.mirror.onchange = () => this.edit((c) => { c.mirror = ui.mirror.checked; this.redraw(); });
    ui.rot.onchange = () => this.edit((c) => { c.rot = Number(ui.rot.value); this.edge = null; this.align(); });
    ui.pitch.onchange = () => this.edit((c) => { c.pitch = Number(ui.pitch.value); this.applyPose(); });
    ui.fov.onchange = () => this.edit((c) => { c.fov = Number(ui.fov.value); this.applyPose(); });
    ui.az.onchange = ui.el.onchange = () => this.edit((c) => { c.light = { az: Number(ui.az.value), el: Number(ui.el.value) }; this.applyPose(); });
    ui.fit.onclick = () => this.fit();
    ui.align.onclick = this.align;
    ui.measure.onclick = this.measure;
    ui.undo.onclick = () => this.edit((c) => { c.outline.pop(); this.redraw(); });
    ui.clear.onclick = () => this.edit((c) => { c.outline = []; c.patches = []; this.edge = null; this.redraw(); });
    ui.save.onclick = () => void this.save();
    ui.shot.onclick = () => this.screenshot();
    addEventListener('resize', () => { this.edge = null; this.redraw(); });
    this.bindPointer();
    this.bindKeysAndDrop();
  }

  private bindPointer(): void {
    const cv = this.ui.canvas;
    cv.addEventListener('pointerdown', (e) => {
      const { cur, photo } = this;
      if (!photo || !cur) return;
      const t = this.tool();
      if (t === 'pan') { this.drag = { x: e.clientX, y: e.clientY, tx: this.view.tx, ty: this.view.ty }; cv.setPointerCapture(e.pointerId); return; }
      const round = (v: number): number => Math.round(v * POINT_PRECISION) / POINT_PRECISION;
      const [px, py] = viewToPhoto(cur, photo.img, this.view, [e.clientX, e.clientY]);
      const x = round(px), y = round(py);
      if (t === 'outline') cur.outline.push([x, y]);
      if (t === 'patch') {
        const name = this.ui.patchName.value.trim() || `p${cur.patches.length + 1}`;
        cur.patches = cur.patches.filter((p) => p.name !== name).concat({ name, x, y, r: Number(this.ui.patchRadius.value) || DEFAULT_PATCH_RADIUS });
      }
      this.redraw();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      this.view.tx = this.drag.tx + e.clientX - this.drag.x; this.view.ty = this.drag.ty + e.clientY - this.drag.y;
      this.redraw();
    });
    cv.addEventListener('pointerup', () => { this.drag = null; });
    cv.addEventListener('wheel', (e) => {
      if (!this.photo) return;
      e.preventDefault();
      const k = Math.exp(-e.deltaY * WHEEL_ZOOM), v = this.view;
      v.tx = e.clientX - (e.clientX - v.tx) * k; v.ty = e.clientY - (e.clientY - v.ty) * k; v.s *= k;
      this.redraw();
    }, { passive: false });
  }

  private bindKeysAndDrop(): void {
    addEventListener('keydown', (e) => {
      const target = e.target;
      if (!this.active || !this.cur || (target instanceof Element && target.matches('input, select, textarea'))) return;
      if (e.key === 'Backspace') { this.cur.outline.pop(); this.redraw(); e.preventDefault(); }
    });
    addEventListener('dragover', (e) => e.preventDefault());
    addEventListener('drop', (e) => {
      e.preventDefault();
      const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'));
      if (f) void this.addDropped(f);
    });
  }

  private async addDropped(f: File): Promise<void> {
    // Load the species' existing refs first so "save" adds to refs.json instead of replacing it.
    if (this.loadedFor !== this.lab.species()) await this.loadSet();
    this.refs.push(normaliseRef({ file: f.name, url: URL.createObjectURL(f), blob: f }, location.href));
    if (!this.active) this.setActive(true);
    this.fillSelect();
    void this.select(this.refs.length - 1);
  }

  /** What is on screen (render plus any photo overlay) as a PNG download. */
  private screenshot(): void {
    this.lab.render();
    const gl = this.lab.canvas, c = makeCanvas(gl.width, gl.height), g = context2d(c);
    g.drawImage(gl, 0, 0);
    if (this.active) g.drawImage(this.ui.canvas, 0, 0, c.width, c.height);
    c.toBlob((b) => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `lab-${this.lab.species()}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), REVOKE_DELAY_MS);
    }, 'image/png');
  }

  debugHandle(): NonNullable<LabHost['ref']> {
    return { current: () => this.cur, view: () => this.view, align: this.align, measure: this.measure, redraw: this.redraw, rows: () => this.lastRows };
  }
}

/** Silhouette metrics of the render's coverage mask against the traced photo outline. */
function silhouetteReport(mask: Uint8Array, photoMask: Uint8Array, renderEdge: readonly Pixel[], w: number, h: number, len: number): string[] {
  let inter = 0, uni = 0, renderOnly = 0, photoOnly = 0, photoArea = 0;
  for (let i = 0; i < mask.length; i++) {
    const a = mask[i], b = photoMask[i];
    if (a && b) inter++;
    if (a || b) uni++;
    if (a && !b) renderOnly++;
    if (b && !a) photoOnly++;
    if (b) photoArea++;
  }
  const d = boundaryDistance(renderEdge, boundary(photoMask, w, h));
  const iou = inter / Math.max(1, uni);
  return [
    `silhouette IoU ${iou.toFixed(3)}  ${iou >= IOU_TARGET ? 'PASS' : `target >= ${IOU_TARGET.toFixed(3)}`}`,
    `boundary distance  mean ${d.mean.toFixed(1)} px  max ${d.max.toFixed(1)} px  (max ${((100 * d.max) / len).toFixed(1)}% of length)`,
    `render outside photo ${((100 * renderOnly) / photoArea).toFixed(1)}%   photo not covered ${((100 * photoOnly) / photoArea).toFixed(1)}%`,
  ];
}

export function installReference(lab: LabHost): void {
  const params = new URLSearchParams(location.search);
  const tool = new ReferenceTool(lab, controls(), params);
  tool.startDrawLoop();
  tool.bindInputs();
  if (params.get('ref') === '1' || params.has('refimg')) tool.setActive(true);
  // Console/debug access.
  lab.ref = tool.debugHandle();
}
