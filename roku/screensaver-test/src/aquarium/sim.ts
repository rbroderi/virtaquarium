// Copyright (c) 2026 Roku, Inc.
// SPDX-License-Identifier: MIT
//
// The aquarium player from pc/src/roku.js, ported to TypeScript for the RSG 2.0 SDK. Same brain,
// fear, steering, turning, angle pages, water loop, bubbles and texture budget; the only change is
// the output: instead of canvas drawImage calls, each tick produces a Frame describing what every
// Poster should show, which the SceneGraph component applies.
/* eslint-disable @typescript-eslint/no-explicit-any */

export const FPS = 30;
const NEAR = 0.35;          // depth above which a fish swims in front of the foreground reef
const BUDGET_MB = 40;       // app texture budget (Roku texture memory is ~100 MB shared with the OS)

function mulberry32(a: number) {
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** One sprite cell: a clipping group at (x, y) of size w x h, holding a poster offset by (px, py). */
export interface Cell { uri: string; x: number; y: number; w: number; h: number; px: number; py: number; opacity: number }
export interface FishView { x: number; y: number; sx: number; sy: number; rotation: number; cells: Cell[] }
export interface WaterView { x: number; y: number; w: number; h: number; uri: string; stepUri: string; stepOpacity: number }
export interface BubbleView { x: number; y: number; size: number; px: number }
export interface Frame {
    panX: number;
    backdrop: string[];        // uri per backdrop tile ("" = not shown, texture freed)
    foreground: string[];
    water: (WaterView | null)[];
    bubbles: BubbleView[] | null;
    bubbleUri: string;
    back: (FishView | null)[]; // slots behind the foreground reef, in drawing order
    front: (FishView | null)[];
}

/**
 * Texture memory as the Roku keeps it (see pc/src/roku.js Textures). A bitmap is resident while any
 * Poster's uri points at it; the component keeps one hidden "loader" poster per granted url, and a
 * display poster only switches to a url once its loader reports ready (a texture-cache hit).
 */
export class Textures {
    budget: number;
    map = new Map<string, { bytes: number; ready: boolean }>();
    wants = new Map<string, { bytes: number; prio: number }>();
    used = 0; need = 0; peak = 0; loads = 0; misses = 0;
    constructor(budgetMB: number) { this.budget = budgetMB * 1e6; }
    want(url: string, bytes: number, prio: number) {
        const w = this.wants.get(url);
        if (!w) this.wants.set(url, { bytes, prio });
        else if (prio < w.prio) w.prio = prio;
    }
    ready(url: string) { const e = this.map.get(url); return !!e && e.ready; }
    markReady(url: string) { const e = this.map.get(url); if (e) e.ready = true; }
    /** Grant this tick's wants in priority order within the budget; returns true if the held set changed. */
    update(): boolean {
        const rank = ([url, w]: [string, { prio: number }]) => (w.prio === 3 && this.map.has(url) ? 2.5 : w.prio);
        const order = [...this.wants].sort((a, b) => rank(a) - rank(b));
        const keep = new Set<string>();
        let total = 0, spec = 0, changed = false;
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
            this.map.delete(url);
            this.used -= e.bytes;
            changed = true;
        }
        for (const url of keep) {
            if (this.map.has(url)) continue;
            this.map.set(url, { bytes: this.wants.get(url)!.bytes, ready: false });
            this.used += this.wants.get(url)!.bytes;
            this.loads++;
            changed = true;
        }
        this.peak = Math.max(this.peak, this.used);
        this.wants.clear();
        return changed;
    }
}

export function createSim(manifest: any, root: string, seed = 1) {
    const rand = mulberry32(seed);
    const range = (a: number, b: number) => a + (b - a) * rand();
    const keys = Object.keys(manifest.scenery);
    const scene = manifest.scenery[keys[0]];
    const tex = new Textures(BUDGET_MB);
    const SW = manifest.screen.w;
    const framing = manifest.view || { zoom: 1, pan: false, period: 120, strip: manifest.screen };
    const STRIP_W = framing.strip.w;
    const panAt = (t: number) => (STRIP_W - SW) * (framing.pan ? 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / framing.period) : 0.5);
    if (!Array.isArray(scene.backdrop)) throw new Error("backdrop is not tiled; re-bake");
    const tileBytes = (t: any) => t.rect[2] * t.rect[3] * 4;
    const water = scene.water;
    const waterLayers = water ? [water.back, water.front].map((L: any) => L && {
        ...L, bytes: Math.round(L.rect[2] / water.scale) * Math.round(L.rect[3] / water.scale) * 4, last: ""
    }) : [null, null];

    const B = manifest.bubbles, stone = scene.bubbler;
    const bubbles = B && stone ? { list: [] as any[], bytes: B.cell * B.mm.length * B.cell * 4, t: 0 } : null;
    const riseU = (mm: number) => { const d = mm / 1000; return Math.sqrt((2.14 * 0.072) / (1000 * d) + 0.505 * 9.81 * d) / 0.125; };
    const spawnBubble = (b: any, y: number) => {
        b.k = Math.floor(rand() * B.mm.length);
        b.y = y; b.x = (rand() - 0.5) * 0.08 * stone.pxPerUnit;
        b.ph = rand() * 6.283; b.f = 4 + 4 * rand();
        return b;
    };
    if (bubbles) for (let i = 0; i < 90; i++) bubbles.list.push(spawnBubble({}, stone.pos[1] + rand() * (stone.top - stone.pos[1])));

    const species = Object.entries(manifest.species).map(([id, sp]: [string, any]) => {
        if (!sp.angles) throw new Error(`${id}: sprite sheet has no per-angle pages; re-bake`);
        const yaws = sp.angles.map((a: any) => a.yaw);
        const home = yaws.reduce((b: number, y: number, i: number) =>
            (Math.abs(y - (sp.cruiseYaw || 0)) < Math.abs(yaws[b] - (sp.cruiseYaw || 0)) ? i : b), 0);
        return { id, ...sp, fw: sp.frameW, fh: sp.frameH, home, stepYaw: 180 / (yaws.length - 1) };
    });

    const aspect = manifest.screen.w / manifest.screen.h;
    const tankW = Math.min(30, Math.max(16, 8.6 * aspect + 1.5));
    const [bx0, by0, bx1, by1] = scene.swimBox;
    const pxPerUnit = (bx1 - bx0) / (tankW - 1.8);
    const baseScale = pxPerUnit / manifest.pxPerUnit;
    const DEPTH_PX = 2.85 * pxPerUnit;
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    const floorAt = (x: number) => {
        const f = scene.floor, t = Math.min(Math.max(x / STRIP_W, 0), 1) * (f.length - 1);
        const i = Math.min(Math.floor(t), f.length - 2);
        return f[i] + (f[i + 1] - f[i]) * (t - i);
    };

    const fish: any[] = [];
    for (const sp of species) {
        for (let n = 0; n < (sp.count || 1); n++) {
            const depth = range(-1, 1);
            fish.push({
                sp, depth, tdepth: depth, scale: baseScale * (1 + 0.18 * depth),
                x: range(bx0 + 100, bx1 - 100), y: range(by0 + 150, by1 - 150), vx: 0, vy: 0, vz: 0, speed: 0,
                psi: rand() < 0.5 ? 0 : Math.PI, omega: 0, turnSign: 0, tilt: 0,
                u: 0, du: 0, phase: rand(), tx: 0, ty: 0, timer: 0, mode: "cruise",
                fear: 0, fearAge: 9, caughtT: 0, pendingFear: 0, threatX: 0, threatY: 0, shelter: null, onScreen: true
            });
        }
    }
    for (const f of fish) {
        const b = f.sp.brain, list = scene.shelters || [];
        if (b.host || !list.length) continue;
        const coral = list.find((s: any) => s.kind === "coral");
        if (b.school >= 0.8 && coral) { f.shelter = coral; continue; }
        let best = null, bd = Infinity;
        for (const s of list) if (s.kind === "ledge") { const d = Math.abs(s.pos[0] - f.x); if (d < bd) { bd = d; best = s; } }
        f.shelter = best;
    }

    const limits = (f: any, x: number) => {
        const h = f.sp.fh * f.scale;
        const hiding = f.shelter && (f.mode === "flee" || f.mode === "rest") && Math.abs(f.x - f.shelter.pos[0]) < 90;
        return [by0 + h * 0.5, hiding ? Math.min(by1, f.shelter.pos[1] + h * 0.3) : Math.min(by1, floorAt(x)) - h * 0.35];
    };

    function pickTarget(f: any) {
        const b = f.sp.brain;
        f.mode = "cruise";
        let x = range(bx0 + 60, bx1 - 60), zoneF = range(b.zone[0], b.zone[1]);
        if (b.host && rand() < 0.6) {
            x = scene.anemone[0] + range(-90, 90);
            zoneF = 0.92;
            f.mode = "host";
        } else if (b.school >= 0.5) {
            const mates = fish.filter(o => o.sp === f.sp && o !== f);
            if (mates.length) {
                const cx = mates.reduce((s, o) => s + o.x, 0) / mates.length;
                x = Math.min(Math.max(cx + range(-260, 260), bx0 + 60), bx1 - 60);
            }
        } else if (rand() < b.grazer * 0.4 || rand() < (b.shy || 0) * 0.5) {
            zoneF = 1;
            f.mode = "graze";
        }
        const [top, bottom] = limits(f, x);
        f.tx = x;
        f.ty = top + (bottom - top) * zoneF;
        if (f.mode === "host") f.tdepth = 0;
        else if (rand() < 0.5) f.tdepth = range(-1, 1);
        f.timer = range(3, 10) / (0.4 + b.activity) * (f.mode === "cruise" ? 1 : 1.8);
    }

    function feel(f: any, dt: number) {
        const b = f.sp.brain, L = f.sp.lengthPx * f.scale;
        f.fear *= Math.exp(-dt * 0.45);
        f.fearAge += dt;
        const raise = (s: number, x: number, y: number) => {
            if (s > f.fear + 0.1) f.fearAge = 0;
            if (s > f.fear) { f.fear = s; f.threatX = x; f.threatY = y; }
        };
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

    function step(f: any, dt: number) {
        const b = f.sp.brain;
        f.timer -= dt;
        feel(f, dt);
        let boost = 1;
        if (f.fear > 0.4) {
            f.mode = "flee"; boost = 2.5; f.timer = Math.max(f.timer, 0.5);
            if (f.shelter) { f.tx = f.shelter.pos[0]; f.ty = f.shelter.pos[1]; f.tdepth = -0.5; }
            else { f.tx = Math.min(Math.max(f.x + (f.x - f.threatX) * 2, bx0 + 60), bx1 - 60); f.ty = f.y + (f.y - f.threatY); }
        } else if (f.mode === "flee") f.timer = 0;
        const dx = f.tx - f.x, dy = f.ty - f.y, dist = Math.hypot(dx, dy);
        if (f.timer <= 0 || (dist < 20 && f.mode === "cruise")) pickTarget(f);

        const cruise = b.maxSpeed * pxPerUnit * (0.2 + 0.3 * b.activity) * boost;
        const arrive = Math.min(1, dist / 160);
        let wx = dist > 1 ? (dx / dist) * cruise * arrive : 0;
        let wy = dist > 1 ? (dy / dist) * cruise * arrive : 0;
        const mates: [number, any, number, number][] = [];
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
        wy = Math.max(-cruise * 0.45, Math.min(cruise * 0.45, wy));
        const wz = Math.max(-cruise * 0.5, Math.min(cruise * 0.5, (f.tdepth - f.depth) * DEPTH_PX * 0.4));

        const rate = (f.sp.turnRate || 90) * Math.PI / 180, want = Math.hypot(wx, wz);
        let err = want > cruise * 0.1 ? wrap(Math.atan2(wz, wx) - f.psi) : 0;
        if (Math.abs(err) > 2.6) {
            if (!f.turnSign) f.turnSign = (Math.cos(f.psi) >= 0 ? 1 : -1) * (f.depth < 0.4 ? 1 : -1);
            err = Math.abs(err) * f.turnSign;
        } else if (Math.abs(err) < 2.0) f.turnSign = 0;
        const wOmega = Math.max(-rate, Math.min(rate, err * 2.5));
        f.omega += Math.max(-rate * 4 * dt, Math.min(rate * 4 * dt, wOmega - f.omega));
        f.psi = wrap(f.psi + f.omega * dt);

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
        const effort = Math.min(1.5, Math.hypot(f.vx, f.vy) / cruise);
        f.phase += dt * (f.sp.tailHz ? f.sp.tailHz * (0.35 + 0.65 * effort) : 0.7 + 2.2 * effort);
    }

    function view(f: any) {
        const { sp } = f, A = sp.angles.length;
        const psi = wrap(f.psi + (sp.cruiseYaw || 0) * Math.PI / 180 * Math.cos(f.psi));
        const flip = Math.abs(psi) > Math.PI / 2, yaw = (flip ? Math.sign(psi) * Math.PI - psi : psi) * 180 / Math.PI;
        const u = Math.min(Math.max((yaw - sp.angles[0].yaw) / sp.stepYaw, 0), A - 1);
        return { flip, yaw, u };
    }

    let waterT = 0, panT = 0, panX = panAt(0);
    const inView = (x0: number, x1: number, margin = 0) => x1 > panX - margin && x0 < panX + SW + margin;

    function plan(dt: number) {
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
            f.onScreen = inView(f.x - half, f.x + half, 150);
            if (!f.onScreen) continue;
            f.du = dt > 0 ? (u - f.u) / dt : 0;
            f.u = u;
            const page = (r: number, prio: number) => { if (r >= 0 && r < A) tex.want(sp.angles[r].sheet, sp.angles[r].mb * 1e6, prio); };
            const r0 = Math.min(Math.floor(u), A - 2);
            page(r0, 1); page(r0 + 1, 1);
            const ahead = Math.min(Math.max(u + f.du * 0.4, 0), A - 1);
            for (let r = Math.min(r0, Math.floor(ahead)); r <= Math.max(r0 + 1, Math.ceil(ahead)); r++) page(r, 2);
            page(r0 - 1, 3); page(r0 + 2, 3);
        }
        for (const L of waterLayers) {
            if (!L) continue;
            const n = L.frames.length, k = Math.floor((waterT * water.fps) % n), k1 = (k + 1) % n;
            tex.want(L.frames[k], L.bytes, 1); tex.want(L.frames[k1], L.bytes, 2);
            if (L.steps) { tex.want(L.steps[k], L.bytes, 1); tex.want(L.steps[k1], L.bytes, 2); }
        }
        return tex.update();
    }

    const uri = (url: string) => (url ? root + url : "");

    function pageFor(sp: any, r: number) {
        for (let d = 0; d < sp.angles.length; d++) {
            for (const q of d ? [r - d, r + d] : [r]) {
                if (q >= 0 && q < sp.angles.length && tex.ready(sp.angles[q].sheet)) {
                    if (d) tex.misses++;
                    return sp.angles[q];
                }
            }
        }
        return null;
    }

    function fishView(f: any): FishView {
        const { sp } = f, n = sp.frames, frame = Math.floor(f.phase * n) % n, A = sp.angles.length;
        const { flip, yaw, u } = view(f);
        const r0 = Math.min(Math.floor(u), A - 2), t = u - r0;
        const tiltW = Math.max(-0.35, Math.min(0.35, Math.atan2(f.vy, Math.abs(f.vx) + 1))) * Math.abs(Math.cos(yaw * Math.PI / 180));
        f.tilt += (tiltW - f.tilt) * 0.1;
        const bob = f.mode === "cruise" ? 0 : Math.sin(f.phase * 1.3) * 2;
        const cells: Cell[] = [], drawn = new Set<any>();
        const cell = (r: number, opacity: number) => {
            const a = pageFor(sp, r);
            if (!a || drawn.has(a)) return;
            drawn.add(a);
            cells.push({
                uri: uri(a.sheet), x: a.x - sp.fw / 2, y: a.y - sp.fh / 2, w: a.w, h: a.h,
                px: -(frame % a.cols) * a.w, py: -Math.floor(frame / a.cols) * a.h, opacity
            });
        };
        if (t < 0.5) { cell(r0, 1); if (t > 0.02) cell(r0 + 1, t); }
        else { cell(r0 + 1, 1); if (t < 0.98) cell(r0, 1 - t); }
        // Canvas: translate, mirror, rotate(tilt), scale. SceneGraph applies scale then rotation, and
        // a mirror turns the rotation round; SceneGraph's positive rotation is counter-clockwise.
        return { x: f.x, y: f.y + bob, sx: flip ? -f.scale : f.scale, sy: f.scale, rotation: flip ? f.tilt : -f.tilt, cells };
    }

    function waterView(L: any): WaterView | null {
        if (!L) return null;
        const n = L.frames.length, pos = (waterT * water.fps) % n, k = Math.floor(pos);
        const ready = tex.ready(L.frames[k]), stepReady = L.steps && tex.ready(L.steps[k]);
        if (ready) L.last = L.frames[k]; else tex.misses++;
        if (!L.last) return null;
        const [x, y, w, h] = L.rect;
        return { x, y, w, h, uri: uri(L.last), stepUri: ready && stepReady ? uri(L.steps[k]) : "", stepOpacity: pos - k };
    }

    const fishCount = fish.length;
    return {
        fishCount,
        backdropTiles: scene.backdrop as any[],
        foregroundTiles: scene.foreground as any[],
        bubbleCount: bubbles ? bubbles.list.length : 0,
        bubbleCell: B ? B.cell : 16,
        tex,
        root,
        /** Advance by dt seconds; returns the frame and whether the set of held textures changed. */
        tick(dt: number): { frame: Frame; texturesChanged: boolean } {
            for (const f of fish) step(f, dt);
            waterT += dt;
            panT += dt;
            if (bubbles) {
                bubbles.t += dt;
                for (const b of bubbles.list) {
                    b.y -= riseU(B.mm[b.k]) * stone.pxPerUnit * dt;
                    if (b.y < Math.max(stone.top, -B.cell)) spawnBubble(b, stone.pos[1]);
                }
            }
            panX = panAt(panT);
            const texturesChanged = plan(dt);

            fish.sort((a, b) => a.depth - b.depth);
            const back: (FishView | null)[] = new Array(fishCount).fill(null);
            const front: (FishView | null)[] = new Array(fishCount).fill(null);
            let nb = 0, nf = 0;
            for (const f of fish) {
                if (!f.onScreen) continue;
                if (f.depth <= NEAR) back[nb++] = fishView(f); else front[nf++] = fishView(f);
            }
            const tileUri = (t: any) => (inView(t.rect[0], t.rect[0] + t.rect[2]) && tex.ready(t.file) ? uri(t.file) : "");
            let bubbleViews: BubbleView[] | null = null;
            if (bubbles && inView(stone.pos[0] - 50, stone.pos[0] + 50) && tex.ready(B.sheet)) {
                const s = stone.pxPerUnit / B.pxPerUnit;
                bubbleViews = bubbles.list.map(b => {
                    const mm = B.mm[b.k], zz = mm > 2 ? ((mm - 2) * 0.004 / 0.125) * stone.pxPerUnit : 0;
                    const size = B.cell * s;
                    const x = stone.pos[0] + b.x + Math.sin(bubbles.t * b.f * 6.283 + b.ph) * zz;
                    return { x: x - size / 2, y: b.y - size / 2, size, px: -b.k * B.cell };
                });
            }
            return {
                texturesChanged,
                frame: {
                    panX,
                    backdrop: scene.backdrop.map(tileUri),
                    foreground: scene.foreground.map(tileUri),
                    water: waterLayers.map(waterView),
                    bubbles: bubbleViews,
                    bubbleUri: B ? uri(B.sheet) : "",
                    back, front
                }
            };
        }
    };
}
