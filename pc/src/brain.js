// Each fish owns a Brain: a personality (traits), internal drives that rise and fall over time,
// perception of its surroundings, and utility-based action selection. The chosen behaviour
// produces a steering goal that the body (fish.js) turns into actual swimming.
import * as THREE from 'three';
import { clamp, range } from './util.js';

export const MODES = {
  cruise: 'Exploring open water',
  school: 'Swimming with the shoal',
  forage: 'Picking at the rock',
  feed: 'Chasing food',
  rest: 'Resting near shelter',
  flee: 'Fleeing!',
  patrol: 'Guarding territory',
  inspect: 'Checking out the glass',
  host: 'Snuggling in the anemone',
  hover: 'Hovering, fins fanned',
};

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export class Brain {
  constructor(fish, rng) {
    this.fish = fish;
    this.rng = rng;
    const b = fish.sp.brain;
    const j = (v) => clamp(v + (rng() - 0.5) * 0.3, 0, 1);
    // Personality: fixed for life, varies between individuals of the same species.
    this.traits = {
      boldness: j(b.boldness),
      curiosity: j(b.curiosity),
      activity: j(b.activity),
      sociability: j(b.school || 0),
      aggression: j(b.territorial || 0),
      appetite: j(0.5),
    };
    // Drives: 0..1, change continuously.
    this.drives = {
      hunger: range(rng, 0.1, 0.5),
      energy: range(rng, 0.6, 1.0),
      fear: 0,
      social: 0.5,
      boredom: rng() * 0.5,
    };
    this.mode = 'cruise';
    this.modeTime = 0;
    this.thinkClock = rng() * 0.2;
    this.target = new THREE.Vector3();
    this.targetTimer = 0;
    this.pecking = 0;
    this.inspectDone = false;
    this.home = new THREE.Vector3();
    this.threat = null;
    this.focus = null;       // food item or fish being chased
    this.neighbors = [];
    this.intruder = null;
    this.scores = {};
    this.thought = MODES.cruise;
    this.orbit = rng() * Math.PI * 2;
    this.chaseFatigue = 0;   // territorial disputes wear off; rivals settle into a truce
  }

  // Something scary happened nearby (a chase, a predator, a sudden splash).
  startle(source, amount) {
    const f = amount * (1 - 0.6 * this.traits.boldness);
    if (f > this.drives.fear) {
      this.drives.fear = clamp(f, 0, 1);
      this.threat = source;
    }
  }

  update(dt, world) {
    this._updateDrives(dt, world);
    this.modeTime += dt;
    this.thinkClock -= dt;
    if (this.thinkClock <= 0) {
      this.thinkClock = 0.2;
      this._perceive(world);
      this._decide(world);
    }
  }

  _updateDrives(dt, world) {
    const d = this.drives, t = this.traits, sp = this.fish.sp.brain;
    const dark = 1 - world.light;
    const effort = this.fish.speed / sp.maxSpeed;
    d.hunger = clamp(d.hunger + dt * 0.005 * (0.6 + t.appetite), 0, 1);
    if (this.mode === 'rest' || this.mode === 'hover') d.energy += dt * 0.025;
    else d.energy -= dt * (0.0015 + 0.004 * effort);
    // Diurnal fish tire at night; nocturnal ones in daylight.
    d.energy -= dt * 0.004 * (sp.nocturnal ? world.light : dark);
    d.energy = clamp(d.energy, 0, 1);
    d.fear *= Math.exp(-dt * 0.45);
    if (d.fear < 0.05) this.threat = null;
    if (sp.school > 0) {
      const alone = this.neighbors.length === 0;
      d.social = clamp(d.social + dt * (alone ? 0.06 : -0.03), 0, 1);
    }
    d.boredom = clamp(d.boredom + dt * 0.012 * (0.5 + t.curiosity), 0, 1);
    this.chaseFatigue = clamp(this.chaseFatigue + (this.mode === 'patrol' && this.focus ? dt / 12 : -dt / 45), 0, 1);
  }

  _perceive(world) {
    const me = this.fish, sp = me.sp.brain;
    this.neighbors.length = 0;
    this.intruder = null;
    let threatStim = 0, threat = null;
    for (const o of world.fish) {
      if (o === me) continue;
      const dist = o.pos.distanceTo(me.pos);
      if (o.sp === me.sp && dist < 3.0) this.neighbors.push(o);
      // Small prey species are wary of the lionfish and of anything chasing them.
      if (sp.prey && o.sp.brain.predator && dist < 3.5) {
        const s = (1 - dist / 3.5) * 0.9;
        if (s > threatStim) { threatStim = s; threat = o; }
      }
      if (o.brain.mode === 'patrol' && o.brain.focus === me && dist < 2.5) {
        const s = 1 - dist / 2.5;
        if (s > threatStim) { threatStim = s; threat = o; }
      }
      // Territorial fish notice intruders near home, mostly their own kind or similar-sized fish.
      if (this.traits.aggression > 0.3 && !o.sp.brain.predator) {
        const nearHome = o.pos.distanceTo(this.home) < 2.0;
        const rival = o.sp === me.sp || Math.abs(o.sp.size - me.sp.size) < 0.3;
        if (nearHome && rival && (!this.intruder || dist < this.intruder.pos.distanceTo(me.pos))) this.intruder = o;
      }
    }
    if (threat) this.startle(threat, threatStim);

    // Food within sight. Bold, hungry fish notice from further away.
    this.focusFood = null;
    if (world.food.length && this.drives.hunger > 0.08) {
      const sight = 5 + this.traits.boldness * 5;
      let best = sight;
      for (const f of world.food) {
        if (f.eaten) continue;
        const dist = f.pos.distanceTo(me.pos);
        if (dist < best) { best = dist; this.focusFood = f; }
      }
    }
  }

  _decide(world) {
    const d = this.drives, t = this.traits, sp = this.fish.sp.brain;
    const dark = 1 - world.light;
    const noise = () => (this.rng() - 0.5) * 0.08;
    const s = this.scores;
    s.cruise = 0.3 + 0.25 * t.activity + (sp.nocturnal ? dark * 0.5 : 0);
    s.school = sp.school > 0 && this.neighbors.length ? t.sociability * (0.5 + 0.6 * d.social) : 0;
    s.forage = (sp.grazer || 0) * (0.25 + d.hunger * 0.9);
    s.feed = this.focusFood ? 0.5 + d.hunger * 1.2 + t.boldness * 0.3 : 0;
    s.rest = (1 - d.energy) * 1.1 + (sp.nocturnal ? 0 : dark * 0.8) + (sp.shy || 0) * 0.15;
    s.flee = sp.host ? 0 : d.fear * 1.8;
    s.patrol = (this.intruder ? t.aggression * 1.1 : t.aggression * 0.2) * (1 - this.chaseFatigue);
    s.inspect = this.inspectDone || (sp.shy || 0) > 0.6 ? 0 : t.curiosity * d.boredom * 0.9;
    s.host = sp.host ? 0.75 + d.fear * 0.8 - d.boredom * 0.3 : 0;
    s.hover = sp.hover ? 0.7 - (sp.nocturnal ? dark * 0.4 : 0) : 0;

    let best = this.mode, bestScore = -1;
    for (const k in s) {
      let v = s[k] + noise();
      if (k === this.mode) v += 0.15;           // hysteresis: commit to what we're doing
      if (v > bestScore) { bestScore = v; best = k; }
    }
    const urgent = best === 'flee' || best === 'feed';
    if (best !== this.mode && (this.modeTime > 1.5 || urgent)) this._enter(best, world);
    this.thought = this._narrate();
  }

  _enter(mode, world) {
    if (this.mode === 'inspect') this.inspectDone = false;
    this.mode = mode;
    this.modeTime = 0;
    this.targetTimer = 0;
    this.pecking = 0;
    this.focus = null;
    this.drives.boredom *= 0.5;
    if (mode === 'patrol') this.focus = this.intruder;
  }

  _narrate() {
    const d = this.drives;
    let t = MODES[this.mode];
    if (this.mode === 'forage' && this.pecking > 0) t = 'Nibbling algae';
    if (this.mode === 'patrol' && this.focus) t = 'Chasing off ' + this.focus.name;
    if (this.mode === 'rest' && d.energy < 0.3) t = 'Sleepy, settling in';
    if (this.mode === 'feed' && d.hunger > 0.7) t = 'Starving: food!';
    return t;
  }

  _pickZonePoint(world, out) {
    const [a, b] = this.fish.sp.brain.zone;
    const x = range(this.rng, world.bounds.x0 + 1, world.bounds.x1 - 1);
    const z = range(this.rng, world.bounds.z0 + 0.6, world.bounds.z1 - 0.6);
    const floor = world.reefHeight(x, z) + this.fish.size * 0.8;
    const top = world.bounds.y1 - 0.5;
    const f = range(this.rng, a, b);
    out.set(x, Math.max(floor, top + (floor - top) * f), z);
    return out;
  }

  // Returns desired heading (written into `dir`, not normalised) and desired speed fraction of the
  // species' maximum sustained speed. Routine swimming in a tank is slow (~0.5-1.5 body lengths/s,
  // 15-40% of the maximum); feeding dashes, chases and escapes use the rest.
  steer(dt, world, dir) {
    const me = this.fish, sp = me.sp.brain, pos = me.pos;
    let speed = 0.4, clearance = me.size * 0.45;
    dir.set(0, 0, 0);
    this.targetTimer -= dt;

    switch (this.mode) {
      case 'cruise': {
        if (this.targetTimer <= 0 || pos.distanceTo(this.target) < 0.8) {
          this._pickZonePoint(world, this.target);
          this.targetTimer = range(this.rng, 6, 14);
        }
        dir.subVectors(this.target, pos).normalize();
        speed = 0.15 + 0.2 * this.traits.activity;
        break;
      }
      case 'school': {
        const goal = world.schoolGoal(me.sp.id);
        _v.set(0, 0, 0); _w.set(0, 0, 0);
        for (const n of this.neighbors) { _v.add(n.pos); _w.add(n.dir); }
        const k = this.neighbors.length || 1;
        _v.divideScalar(k).sub(pos).multiplyScalar(0.6);   // cohesion
        _w.divideScalar(k).multiplyScalar(1.0);             // alignment
        dir.add(_v).add(_w);
        dir.add(_v.subVectors(goal, pos).normalize().multiplyScalar(0.5));
        speed = 0.35;
        break;
      }
      case 'forage': {
        if (this.targetTimer <= 0) {
          const x = clamp(this.home.x + range(this.rng, -3, 3), world.bounds.x0 + 0.8, world.bounds.x1 - 0.8);
          const z = range(this.rng, world.bounds.z0 + 0.8, world.bounds.z1 - 1.0);
          this.target.set(x, world.reefHeight(x, z) + me.size * 0.3, z);
          this.targetTimer = range(this.rng, 8, 16);
          this.pecking = 0;
        }
        const dist = pos.distanceTo(this.target);
        clearance = me.size * 0.15;
        if (dist < 0.35 || this.pecking > 0) {
          // Peck: hold position nose-down, nibbling.
          this.pecking += dt;
          this.drives.hunger = clamp(this.drives.hunger - dt * 0.012 * sp.grazer, 0, 1);
          dir.subVectors(this.target, pos);
          dir.y -= 0.6;
          dir.x += Math.sin(this.modeTime * 2 + this.orbit) * 0.3;
          speed = 0.05;
          if (this.pecking > range(this.rng, 2.5, 5)) this.targetTimer = 0;
        } else {
          dir.subVectors(this.target, pos).normalize();
          speed = dist > 2 ? 0.3 : 0.15;
        }
        break;
      }
      case 'feed': {
        const f = this.focusFood;
        if (!f || f.eaten) { this.thinkClock = 0; speed = 0.3; dir.copy(me.dir); break; }
        dir.subVectors(f.pos, pos);
        const dist = dir.length();
        dir.normalize();
        clearance = me.size * 0.1;
        speed = dist > 1.2 ? 0.8 : 0.4;
        if (dist < me.size * 0.4) {
          f.eaten = true;
          this.drives.hunger = clamp(this.drives.hunger - 0.15, 0, 1);
          this.drives.energy = clamp(this.drives.energy + 0.04, 0, 1);
          me.gulp = 0.3;
        }
        break;
      }
      case 'rest': {
        dir.subVectors(this.home, pos);
        const dist = dir.length();
        clearance = me.size * 0.2;
        if (dist < 0.5) {
          dir.set(Math.sin(this.modeTime * 0.3 + this.orbit) * 0.4, 0, Math.cos(this.modeTime * 0.2) * 0.3).add(me.dir);
          speed = 0.06;
        } else speed = 0.25;
        break;
      }
      case 'flee': {
        if (this.threat) dir.subVectors(pos, this.threat.pos).normalize().multiplyScalar(1.5);
        dir.add(_v.subVectors(this.home, pos).normalize());
        speed = 1.25;
        clearance = me.size * 0.2;
        break;
      }
      case 'patrol': {
        const foe = this.focus;
        if (foe && foe.pos.distanceTo(this.home) < 4) {
          dir.subVectors(foe.pos, pos);
          const dist = dir.length();
          dir.normalize();
          speed = 0.75;
          if (dist < (me.size + foe.size) * 0.6) foe.brain.startle(me, 0.8);
        } else {
          this.focus = null;
          const a = this.modeTime * 0.35 + this.orbit;
          this.target.set(this.home.x + Math.cos(a) * 1.6, this.home.y + 0.4, this.home.z + Math.sin(a) * 0.8);
          dir.subVectors(this.target, pos).normalize();
          speed = 0.25;
        }
        break;
      }
      case 'inspect': {
        if (this.targetTimer <= 0 && this.target.z < world.bounds.z1 - 1) {
          this.target.set(range(this.rng, world.bounds.x0 * 0.6, world.bounds.x1 * 0.6),
            range(this.rng, world.bounds.y1 * 0.4, world.bounds.y1 * 0.75), world.bounds.z1 - 0.7);
          this.targetTimer = 20;
        }
        dir.subVectors(this.target, pos);
        if (dir.length() < 0.5) {
          // Face the viewer and hang there for a bit.
          dir.set(Math.sin(this.modeTime * 0.7) * 0.25, 0, 1);
          speed = 0.03;
          if (this.modeTime > 9) { this.inspectDone = true; this.drives.boredom = 0; this.thinkClock = 0; }
        } else { dir.normalize(); speed = 0.3; }
        break;
      }
      case 'host': {
        const an = world.anemoneFor(me);
        this.orbit += dt * (0.4 + this.drives.fear);
        const r = an.radius * (0.35 + 0.25 * Math.sin(this.orbit * 0.7));
        this.target.set(an.pos.x + Math.cos(this.orbit) * r, an.pos.y + an.radius * 0.45 + Math.sin(this.orbit * 1.3) * 0.15, an.pos.z + Math.sin(this.orbit) * r * 0.6);
        dir.subVectors(this.target, pos);
        const dist = dir.length();
        dir.normalize();
        speed = dist > 1.5 ? 0.5 : 0.15 + dist * 0.1;
        clearance = 0.05;
        break;
      }
      case 'hover': {
        if (this.targetTimer <= 0) {
          this.target.set(this.home.x + range(this.rng, -1.2, 1.2), this.home.y + range(this.rng, 0.3, 1.2), this.home.z + range(this.rng, -0.6, 0.6));
          this.targetTimer = range(this.rng, 6, 12);
        }
        dir.subVectors(this.target, pos);
        speed = Math.min(0.25, dir.length() * 0.2);
        dir.normalize();
        break;
      }
    }

    // Always-on reflexes: personal space, walls, reef.
    for (const o of world.fish) {
      if (o === me) continue;
      _v.subVectors(pos, o.pos);
      const dist = _v.length(), min = (me.size + o.size) * 0.45;
      if (dist < min && dist > 1e-4) dir.addScaledVector(_v, ((min - dist) / min) * 2.5 / dist);
    }
    const B = world.bounds, m = 0.9;
    if (pos.x < B.x0 + m) dir.x += (B.x0 + m - pos.x) * 2;
    if (pos.x > B.x1 - m) dir.x -= (pos.x - B.x1 + m) * 2;
    if (pos.z < B.z0 + 0.5) dir.z += (B.z0 + 0.5 - pos.z) * 3;
    if (pos.z > B.z1 - 0.4) dir.z -= (pos.z - B.z1 + 0.4) * 3;
    if (pos.y > B.y1 - 0.4) dir.y -= (pos.y - B.y1 + 0.4) * 3;
    // Look ahead for rock.
    const ahead = world.reefHeight(pos.x + me.dir.x * 1.2, pos.z + me.dir.z * 1.2) + clearance;
    const below = world.reefHeight(pos.x, pos.z) + clearance;
    if (pos.y < below) dir.y += (below - pos.y) * 4 + 0.5;
    else if (pos.y < ahead) dir.y += (ahead - pos.y) * 1.5;

    return speed;
  }
}
