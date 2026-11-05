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
  lurk: 'Lurking in its crevice, gulping water',
  stalk: 'Stalking, fins spread',
  clean: 'Dancing at its cleaning station',
  pose: 'Queuing at the cleaning station',
};

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _a = new THREE.Vector3();
const _n = new THREE.Vector3();

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
      // Ectoparasites (gnathiid isopods) build up over hours; client species visit the cleaner to shed them.
      parasites: b.client ? range(rng, 0, 0.6) : 0,
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
    if (sp.client) d.parasites = clamp(d.parasites + dt * 0.003, 0, 1);   // ~5 min from clean to itching
    this.chaseFatigue = clamp(this.chaseFatigue + (this.mode === 'patrol' && this.focus ? dt / 12 : -dt / 45), 0, 1);
    if (this.strikeCool > 0) this.strikeCool -= dt;
    // Habituation to the viewer: builds while watching it, fades over a few minutes.
    this.habit = clamp((this.habit || 0) + (this.mode === 'inspect' && world.viewer?.activity > 0.2 ? dt / 40 : -dt / 200), 0, 1);
  }

  // Perception. Vision covers all round but a blind cone behind (reef fish see ~330 degrees), reaches
  // further for bigger targets and shrinks in the dark, and is blocked by rock. The lateral line senses
  // anything moving within about a body length whatever the light or the rock (Partridge & Pitcher 1980:
  // blinded saithe still school by it), so shoals loosen but hold together at night.
  _senses(o, dist, world) {
    const me = this.fish;
    if (dist < 1.2 * me.size + 0.5 * o.size) return true;   // lateral line
    const range = (2.5 + 4 * me.size) * (0.25 + 0.75 * world.light) * clamp(o.size / 0.6, 0.6, 1.8);
    if (dist > range) return false;
    _v.subVectors(o.pos, me.pos);
    if (_v.dot(me.dir) < -0.85 * dist) return false;   // directly behind
    return world.lineOfSight(me.pos, o.pos);
  }

  _perceive(world) {
    const me = this.fish, sp = me.sp.brain;
    this.neighbors.length = 0;
    this.intruder = null;
    let threatStim = 0, threat = null;
    const near = this._near || (this._near = []);
    near.length = 0;
    let social = 0;   // > 0: the threat is a neighbour's flight (its hop count), not something seen first-hand
    for (const o of world.fish) {
      if (o === me) continue;
      const dist = o.pos.distanceTo(me.pos);
      if (dist > 8 || !this._senses(o, dist, world)) continue;
      // Shoalmates: the nearest few that can be sensed (topological, not every fish in a radius: Katz et
      // al. 2011, Herbert-Read et al. 2011).
      if (o.sp === me.sp && dist < 3.0) near.push([dist, o]);
      // Fear is contagious: a fish that sees a neighbour bolt bolts too, away from what scared it, so a
      // startle runs through a shoal as a wave (Rosenthal et al. 2015), limited by who can see whom. Only
      // the first second of a flight passes it on, and a fish caught by one ignores others for a few
      // seconds, so it doesn't ping-pong.
      // A flight only passes on as a dash beyond the fish's sustainable speed, weakens with each fish it
      // passes through (hop), and dies out after three.
      const ob = o.brain;
      if (ob.mode === 'flee' && ob.modeTime < 1 && (ob.hop ?? 0) < 3 && o.speed > 1.1 * o.sp.swim.maxBL * o.size && world.time - (this.caught ?? -99) > 8) {
        const reach = 3 * me.size + 1, kin = o.sp === me.sp ? 1 : 0.55;
        if (dist < reach) {
          const s = 0.6 * (1 - dist / reach) * kin * (sp.prey ? 1 : 0.6) * 0.6 ** (ob.hop ?? 0);
          if (s > threatStim) {
            threatStim = s;
            threat = ob.threat?.pos ? ob.threat : { pos: o.pos.clone().addScaledVector(o.dir, -2) };
            social = (ob.hop ?? 0) + 1;
          }
        }
      }
      // Small prey species are wary of the lionfish and of anything chasing them.
      // A predator that is just there is watched and kept at a distance; one closing in is fled from.
      if (sp.prey && o.sp.brain.predator && dist < 3.5) {
        _w.subVectors(me.pos, o.pos);
        const closing = clamp(o.vel.dot(_w) / Math.max(dist, 1e-3) / (0.5 * me.size), 0, 1);
        const s = (1 - dist / 3.5) * 0.9 * (0.3 + 0.7 * closing);
        if (s > threatStim) { threatStim = s; threat = o; social = 0; }
      }
      if (o.brain.mode === 'patrol' && o.brain.focus === me && dist < 2.5) {
        const s = 1 - dist / 2.5;
        if (s > threatStim) { threatStim = s; threat = o; social = 0; }
      }
      // Territorial fish notice intruders near home, mostly their own kind or similar-sized fish.
      if (this.traits.aggression > 0.3 && !o.sp.brain.predator) {
        const nearHome = o.pos.distanceTo(this.home) < 2.0;
        const rival = o.sp === me.sp || Math.abs(o.sp.size - me.sp.size) < 0.3;
        if (nearHome && rival && (!this.intruder || dist < this.intruder.pos.distanceTo(me.pos))) this.intruder = o;
      }
    }
    // The cuttlefish and octopus eat small fish.
    if (sp.prey) for (const o of world.critters) {
      const dist = o.pos.distanceTo(me.pos);
      if (o.sp.predator && dist < 3 && (dist < 1.2 * me.size + o.radius || world.lineOfSight(me.pos, o.pos))) {
        const s = (1 - dist / 3) * 0.8;
        if (s > threatStim) { threatStim = s; threat = o; social = 0; }
      }
    }
    // Shy fish back off from movement at the glass.
    const vw = world.viewer;
    if (vw && vw.activity > 0.3 && (sp.shy || 0) > 0.5) {
      const dist = vw.pos.distanceTo(me.pos);
      if (dist < 3) {
        const s = 0.4 * vw.activity * sp.shy * (1 - dist / 3);
        if (s > threatStim) { threatStim = s; threat = vw; social = 0; }
      }
    }
    if (threat) {
      const before = this.drives.fear;
      this.startle(threat, threatStim);
      if (this.drives.fear > before + 0.15) {   // a new scare, not fear topped up by the same one
        this.hop = social || 0;   // 0: saw the danger itself
        if (social) { this.caught = world.time; this.contagions = (this.contagions || 0) + 1; }
        else this.firstHand = (this.firstHand || 0) + 1;
      }
    }
    near.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < Math.min(4, near.length); i++) this.neighbors.push(near[i][1]);

    // Food within sight: bold, hungry fish notice from further away; less far in dim light, not
    // through rock (flakes on the sand behind a rock are found by searching, not seen).
    this.focusFood = null;
    if (world.food.length && this.drives.hunger > 0.08) {
      const sight = (5 + this.traits.boldness * 5) * (0.3 + 0.7 * world.light);
      let best = sight;
      for (const f of world.food) {
        if (f.eaten) continue;
        const dist = f.pos.distanceTo(me.pos);
        if (dist >= best || (dist >= me.size * 1.5 && !world.lineOfSight(me.pos, f.pos))) continue;
        // Pecking order: a flake a much bigger fish is already closing on is left to it.
        if (world.fish.some((o) => o !== me && o.brain.focusFood === f && o.size > me.size * 1.3 && o.pos.distanceTo(f.pos) < dist)) continue;
        best = dist; this.focusFood = f;
      }
    }
  }

  _decide(world) {
    const d = this.drives, t = this.traits, sp = this.fish.sp.brain;
    const dark = 1 - world.light;
    const noise = () => (this.rng() - 0.5) * 0.08;
    const s = this.scores;
    // Eels keep to the crevice by day and roam at night.
    s.cruise = sp.lurker ? 0.2 + dark * 0.9 : 0.3 + 0.25 * t.activity + (sp.nocturnal ? dark * 0.5 : 0);
    s.school = sp.school > 0 && this.neighbors.length ? t.sociability * (0.5 + 0.6 * d.social) : 0;
    s.forage = (sp.grazer || 0) * (0.25 + d.hunger * 0.9);
    s.feed = this.focusFood ? 0.5 + d.hunger * 1.2 + t.boldness * 0.3 : 0;
    s.rest = sp.lurker ? 0 : (1 - d.energy) * 1.1 + (sp.nocturnal ? 0 : dark * 0.8) + (sp.shy || 0) * 0.15;
    s.lurk = sp.lurker ? 0.85 + (1 - d.energy) * 0.4 - d.hunger * 0.35 - dark * 0.45 : 0;
    s.flee = sp.host ? 0 : d.fear * 1.8;
    s.patrol = (this.intruder ? t.aggression * 1.1 : t.aggression * 0.2) * (1 - this.chaseFatigue);
    s.inspect = this.inspectDone || (sp.shy || 0) > 0.6 ? 0 : t.curiosity * d.boredom * (sp.lurker ? 0.4 : 0.9);
    s.host = sp.host ? 0.75 + d.fear * 0.8 - d.boredom * 0.3 : 0;
    s.hover = sp.hover ? 0.7 - (sp.nocturnal ? dark * 0.4 : 0) : 0;
    // Lionfish hunt mostly at dusk and dawn (crepuscular), and by day only when hungry.
    const dusk = clamp(1 - Math.abs(world.light - 0.35) / 0.3, 0, 1);
    s.stalk = sp.predator && !sp.lurker && !(this.strikeCool > 0) ? dusk * 0.9 + d.hunger * 0.55 : 0;
    // A pointer at the glass: bold, curious fish come to look; shy ones keep away (main.js world.viewer).
    // They get used to it (habituation), so it isn't a lure that works for ever.
    const vw = world.viewer;
    if (vw && vw.activity > 0.2 && !sp.lurker) s.inspect = Math.max(s.inspect, t.curiosity * t.boldness * 1.2 * vw.activity * (1 - (this.habit || 0)));
    // Cleaning runs by day: the cleaner holds its station, clients come when their parasites itch.
    const st = world.station;
    s.clean = sp.cleaner && st ? 0.55 + 0.35 * world.light - (1 - d.energy) * 0.3 : 0;
    s.pose = sp.client && st && st.cleaner && st.cleaner.brain.mode === 'clean' ? (d.parasites - 0.3) * 2.5 * world.light - d.fear : 0;

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
    const st = world.station;
    if (st && st.client === this.fish && mode !== 'pose') st.client = null;   // leaving frees the station
    this.mode = mode;
    this.posing = false;
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
    if (this.mode === 'clean' && this.focus) t = 'Cleaning ' + this.focus.name;
    if (this.mode === 'stalk' && this.focus) t = (this.striking > 0 ? 'Lunging at ' : 'Stalking ') + this.focus.name;
    if (this.mode === 'inspect' && this.fish.brain && this.habit > 0 && this.habit < 1) t = 'Watching you';
    if (this.mode === 'pose' && this.posing) t = 'Posing, being cleaned';
    return t;
  }

  // Where to swim to reach shelter sh: a ledge is entered from its open front (+z, towards the glass),
  // level with the gap; the coral from above.
  _shelterGoal(sh, pos) {
    const g = this._sg || (this._sg = new THREE.Vector3());
    const inside = Math.hypot(pos.x - sh.pos.x, pos.z - sh.pos.z) < sh.r;
    if (sh.kind === 'coral') return inside || pos.y < sh.top ? g.copy(sh.pos) : g.copy(sh.pos).setY(sh.top + 0.3);
    if (inside || (pos.z > sh.pos.z && Math.abs(pos.y - sh.pos.y) < 0.25 && Math.abs(pos.x - sh.pos.x) < 0.5)) return g.copy(sh.pos);
    return g.set(sh.pos.x, sh.pos.y, sh.pos.z + 0.9);
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
  // species' maximum sustained speed, from the species' pace table (species.js PACE).
  steer(dt, world, dir) {
    const me = this.fish, sp = me.sp.brain, pace = me.sp.pace, pos = me.pos;
    let speed = 0.4, clearance = me.size * 0.45;
    dir.set(0, 0, 0);
    this.targetTimer -= dt;
    const backing = this.backing;
    this.backing = 0;   // reverse swimming speed (m/s), set while an eel backs into its cave

    switch (this.mode) {
      case 'cruise': {
        if (this.targetTimer <= 0 || pos.distanceTo(this.target) < 0.8) {
          this._pickZonePoint(world, this.target);
          // Feeding anticipation: fish fed on a schedule gather where the food comes in during the last
          // minute before it (feeding-anticipatory activity), hungry ones most.
          if (world.feedIn < 60 && world.lastFeedX !== undefined && this.drives.hunger > 0.4 && !sp.lurker && world.light > 0.3) {
            this.target.set(clamp(world.lastFeedX + range(this.rng, -1.5, 1.5), world.bounds.x0 + 1, world.bounds.x1 - 1),
              world.bounds.y1 - range(this.rng, 0.6, 1.8), range(this.rng, -0.8, 1.5));
          }
          this.targetTimer = range(this.rng, 6, 14);
        }
        dir.subVectors(this.target, pos).normalize();
        speed = pace.cruise[0] + pace.cruise[1] * this.traits.activity;
        break;
      }
      case 'school': {
        // Each fish follows local rules on its nearest few shoalmates (Herbert-Read et al. 2011, Katz et
        // al. 2011): repulsion inside ~0.6 body lengths, attraction beyond ~1.5, matching the speed of
        // those ahead, and only weak alignment. There is no shared goal: the shoal splits round a coral
        // head and re-forms behind it on its own. It is held loosely to its home coral, over which chromis
        // hover in a loose column (Fishelson et al. 1974), drifting about it.
        const L = me.size;
        let ahead = 0, aheadSpeed = 0;
        _v.set(0, 0, 0); _w.set(0, 0, 0);
        for (const n of this.neighbors) {
          _a.subVectors(n.pos, pos);
          const d = _a.length() || 1e-3, dBL = d / L;
          if (dBL < 0.6) _v.addScaledVector(_a, -(0.6 - dBL) * 3 / d);
          else if (dBL > 1.5) _v.addScaledVector(_a, Math.min(1, (dBL - 1.5) * 0.4) / d);
          _w.add(n.dir);
          if (_a.dot(me.dir) > 0) { ahead++; aheadSpeed += Math.max(0, n.speed); }
        }
        dir.copy(me.dir).multiplyScalar(0.8).add(_v).addScaledVector(_w, 0.3 / Math.max(1, this.neighbors.length));
        // Home: drift round it; pulled back harder the further the shoal strays.
        if (this.targetTimer <= 0) {
          const c = world.reef.shoalCoral && sp.school >= 0.8 ? world.reef.shoalCoral.pos : this.home;
          this.target.set(c.x + range(this.rng, -2.2, 2.2), c.y + range(this.rng, 0.3, 2.0), c.z + range(this.rng, -0.8, 1.2));
          this.target.y = Math.min(this.target.y, world.bounds.y1 - 0.6);
          this.targetTimer = range(this.rng, 4, 9);
        }
        _a.subVectors(this.target, pos);
        dir.addScaledVector(_a, clamp(_a.length() / 4, 0.1, 0.8) / (_a.length() || 1));
        const want = pace.school * sp.maxSpeed;
        speed = pace.school * (ahead ? clamp(aheadSpeed / ahead / want, 0.6, 1.4) : 0.9);
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
          speed = pace.peck;
          if (this.pecking > range(this.rng, 2.5, 5)) this.targetTimer = 0;
        } else {
          dir.subVectors(this.target, pos).normalize();
          speed = pace.forage[dist > 2 ? 0 : 1];
        }
        break;
      }
      case 'feed': {
        const f = this.focusFood;
        if (!f || f.eaten) { this.thinkClock = 0; speed = pace.forage[0]; dir.copy(me.dir); break; }
        dir.subVectors(f.pos, pos);
        const dist = dir.length();
        dir.normalize();
        clearance = me.size * 0.1;
        speed = pace.feed[dist > 1.2 ? 0 : 1];
        if (dist < me.size * 0.4) {
          f.eaten = true;
          this.drives.hunger = clamp(this.drives.hunger - 0.15, 0, 1);
          this.drives.energy = clamp(this.drives.energy + 0.04, 0, 1);
          me.gulp = 0.3;
        }
        break;
      }
      case 'rest': {
        // Into its shelter (through the open front of a ledge, or down into the coral) when it knows one,
        // else hover by home. In the dark everyone goes in: the reef empties at dusk (Hobson 1972).
        const sh = this.shelter, goal = sh ? this._shelterGoal(sh, pos) : this.home;
        dir.subVectors(goal, pos);
        const dist = dir.length();
        clearance = me.size * 0.2;
        if (dist < (sh ? 0.25 : 0.5)) {
          dir.set(Math.sin(this.modeTime * 0.3 + this.orbit) * 0.4, 0, Math.cos(this.modeTime * 0.2) * 0.3).add(me.dir);
          speed = pace.rest[1];
        } else speed = dist > 1 ? pace.rest[0] : pace.rest[0] * Math.max(0.3, dist);
        break;
      }
      case 'flee': {
        if (this.threat) dir.subVectors(pos, this.threat.pos).normalize().multiplyScalar(1.5);
        // Dash for cover: a known shelter close by, else home.
        const sh = this.shelter && this.shelter.pos.distanceTo(pos) < 5 ? this.shelter : null;
        dir.add(_v.subVectors(sh ? this._shelterGoal(sh, pos) : this.home, pos).normalize().multiplyScalar(sh ? 1.4 : 1));
        speed = pace.flee;
        clearance = me.size * 0.2;
        break;
      }
      case 'patrol': {
        const foe = this.focus;
        if (foe && foe.pos.distanceTo(this.home) < 4) {
          dir.subVectors(foe.pos, pos);
          const dist = dir.length();
          dir.normalize();
          speed = pace.chase;
          if (dist < (me.size + foe.size) * 0.6 && foe.brain.mode !== 'flee') {
            foe.brain.startle(me, 0.8);
            // The loser remembers: after two defeats it keeps out of this fish's territory (a truce line).
            const lost = foe.brain.lostTo || (foe.brain.lostTo = new Map());
            lost.set(me, (lost.get(me) || 0) + 1);
          }
        } else {
          this.focus = null;
          const a = this.modeTime * 0.35 + this.orbit;
          this.target.set(this.home.x + Math.cos(a) * 1.6, this.home.y + 0.4, this.home.z + Math.sin(a) * 0.8);
          dir.subVectors(this.target, pos).normalize();
          speed = pace.patrol;
        }
        break;
      }
      case 'inspect': {
        const vw = world.viewer;
        if (vw && vw.activity > 0.2) {
          // Come up to the pointer and hold just behind the glass, facing it.
          this.target.copy(vw.pos).setZ(world.bounds.z1 - 0.5 - me.size * 0.5);
          this.targetTimer = 5;
        } else if (this.targetTimer <= 0 && this.target.z < world.bounds.z1 - 1) {
          this.target.set(range(this.rng, world.bounds.x0 * 0.6, world.bounds.x1 * 0.6),
            range(this.rng, world.bounds.y1 * 0.4, world.bounds.y1 * 0.75), world.bounds.z1 - 0.7);
          this.targetTimer = 20;
        }
        dir.subVectors(this.target, pos);
        if (dir.length() < 0.5) {
          // Face the viewer and hang there for a bit.
          dir.set(Math.sin(this.modeTime * 0.7) * 0.25, 0, 1);
          speed = pace.inspect[1];
          if (this.modeTime > 9) { this.inspectDone = true; this.drives.boredom = 0; this.thinkClock = 0; }
        } else { dir.normalize(); speed = pace.inspect[0]; }
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
        speed = dist > 1.5 ? pace.host[0] : pace.host[1] + dist * 0.1;
        clearance = 0.05;
        break;
      }
      case 'lurk': {
        // Settle in the cave at home (main.js), facing out of its mouth, head up, swaying slowly.
        dir.subVectors(this.home, pos);
        const dist = dir.length();
        clearance = me.size * 0.04;
        _v.copy(this.home).addScaledVector(this.lurkDir || me.dir, 1.2);   // just outside the mouth
        if (dist < 0.3 || (this.lurkDir && pos.distanceTo(_v) < 0.5) || (this.lurkDir && dist < 1.3 && backing)) {
          // Face out with a slow sway. Morays reverse their body wave to swim backwards, so an eel
          // that is outside the mouth backs in tail first (fish.js); at home it braces against the rock.
          dir.copy(this.lurkDir || me.dir).multiplyScalar(2);
          dir.x += Math.sin(this.modeTime * 0.25 + this.orbit) * 0.3; dir.z += Math.cos(this.modeTime * 0.17) * 0.2;
          speed = pace.lurk[1];
          this.backing = this.lurkDir && dist > 0.05 ? Math.min(0.3, 0.1 + dist * 0.4) : 0;
        } else {
          // Coming home: head for the water just outside the mouth (the roof is not in the height field).
          if (this.lurkDir) dir.subVectors(_v, pos);
          const d = dir.length();
          dir.normalize(); speed = Math.max(0.12, d < 1 ? pace.lurk[0] * d : pace.lurk[0]);
        }
        break;
      }
      case 'stalk': {
        // Lionfish (Albins & Lyons 2012): a slow approach with the pectoral fans spread, herding prey
        // against the rock, then a lunge from about a body length. The prey always gets away here (the
        // tank keeps its fish), but the lunge scares it and the shoal around it.
        let prey = this.focus;
        if (!prey || prey.pos.distanceTo(pos) > 5 || this.modeTime > 45) {
          prey = null;
          let bd = 4;
          for (const o of world.fish) {
            if (!o.sp.brain.prey || o.sp === me.sp || o.brain.sheltered) continue;
            const d = o.pos.distanceTo(pos);
            if (d < bd && this._senses(o, d, world)) { bd = d; prey = o; }
          }
          this.focus = prey;
          if (this.modeTime > 45) { this.strikeCool = 30; this.thinkClock = 0; }
        }
        if (!prey) { dir.copy(me.dir); dir.y = 0; speed = pace.hover; break; }
        dir.subVectors(prey.pos, pos);
        const d = dir.length();
        dir.normalize();
        clearance = me.size * 0.2;
        if (this.striking > 0) {
          this.striking -= dt;
          speed = 1.6;
          if (this.striking <= 0) { this.strikeCool = 25; this.focus = null; this.thinkClock = 0; }
        } else if (d < me.size * 0.9) {
          this.striking = 0.35;
          me.gulp = 0.35;
          prey.brain.startle(me, 0.95);
          this.strikes = (this.strikes || 0) + 1;
        } else speed = 0.22 * clamp(d, 0.3, 1);
        break;
      }
      case 'clean': {
        // Cleaner wrasse (Labroides): with a client posing, work along its flank head to tail and back,
        // swapping sides every other pass, nose to the skin, picking. Without one, advertise with the
        // up-and-down rocking "dance" over the station (Potts 1973) that brings clients in.
        const st = world.station, c = st.client;
        clearance = me.size * 0.1;
        if (c && c.brain.posing) {
          this.focus = c;
          this.orbit += dt * 0.45;
          const along = Math.sin(this.orbit) * 0.42, side = Math.sin(this.orbit * 0.5) > 0 ? 1 : -1;
          _w.set(-c.dir.z, 0, c.dir.x).normalize();   // the client's side
          const off = 0.1 * c.size + 0.18 * me.size;
          this.target.copy(c.pos).addScaledVector(c.dir, along * c.size).addScaledVector(_w, side * off);
          dir.subVectors(this.target, pos);
          const dist = dir.length();
          if (dist < 0.15) {
            // At the skin: face it and pick, with the odd snap of the jaws.
            dir.copy(_w).multiplyScalar(-side).addScaledVector(c.dir, -Math.cos(this.orbit) * 0.6);
            speed = 0.04;
            c.brain.drives.parasites = clamp(c.brain.drives.parasites - dt * 0.03, 0, 1);
            this.peckT = (this.peckT ?? 0) - dt;
            if (this.peckT <= 0) {
              me.gulp = 0.12;
              this.peckT = range(this.rng, 0.4, 1.2);
              // Cleaners sometimes cheat and bite the client's mucus instead (Bshary & Grutter 2002): the
              // client jolts and leaves.
              if (this.rng() < 0.03) c.brain.startle(me, 0.7);
            }
          } else speed = dist > 0.6 ? 0.45 : 0.08 + dist * 0.5;
        } else {
          this.focus = null;
          this.orbit += dt;
          this.target.set(st.pos.x + Math.sin(this.orbit * 0.6) * 0.35, st.pos.y + 0.3 + Math.sin(this.orbit * 2.2) * 0.18, st.pos.z + Math.cos(this.orbit * 0.6) * 0.2);
          dir.subVectors(this.target, pos);
          speed = Math.min(0.3, dir.length() * 0.6);
        }
        break;
      }
      case 'pose': {
        // Client: swim to the station and hold still head-up with fins spread while the cleaner works.
        // Only one at a time; the next waits its turn a little way off.
        const st = world.station, free = !st.client || st.client === me;
        clearance = me.size * 0.25;
        _v.set(st.pos.x, st.pos.y + 0.35 + me.size * 0.3, st.pos.z + 0.4);
        if (!free) _v.x += (pos.x > st.pos.x ? 1 : -1) * (1.2 + me.size);
        dir.subVectors(_v, pos);
        const dist = dir.length();
        // Once in place, stay posing while within a looser radius (the cleaner nudges, the current drifts).
        this.posing = free && dist < (this.posing ? 1.0 : 0.5);
        if (this.posing) {
          st.client = me;
          // Hold still head-up, drifting back to the spot if pushed off it.
          dir.set(me.dir.x * 0.3, 1, me.dir.z * 0.3).addScaledVector(_w.subVectors(_v, pos), 0.8);
          speed = 0.02 + dist * 0.1;
        } else {
          dir.normalize();
          speed = dist > 1 ? pace.cruise[0] + 0.1 : 0.06 + dist * 0.15;
        }
        break;
      }
      case 'hover': {
        if (this.targetTimer <= 0) {
          this.target.set(this.home.x + range(this.rng, -1.2, 1.2), this.home.y + range(this.rng, 0.3, 1.2), this.home.z + range(this.rng, -0.6, 0.6));
          this.targetTimer = range(this.rng, 6, 12);
        }
        dir.subVectors(this.target, pos);
        speed = Math.min(pace.hover, dir.length() * 0.2);
        dir.normalize();
        break;
      }
    }

    // Always-on reflexes: personal space, walls, reef. A lurking eel holds its crevice: other fish
    // keep clear of it, and the reef ahead of the mouth is open water it does not need to climb over.
    const anchored = this.mode === 'lurk';
    // Keep out of the territory of a fish that has beaten this one twice (it yields at the boundary).
    if (this.lostTo && this.mode !== 'feed' && this.mode !== 'pose') {
      for (const [o, n] of this.lostTo) {
        if (n < 2) continue;
        _a.subVectors(pos, o.brain.home);
        const d = _a.length(), R = 2.6;
        if (d < R && d > 1e-3) dir.addScaledVector(_a, ((R - d) / R) * 1.2 / d);
      }
    }
    if (!anchored) for (const o of world.fish) {
      if (o === me) continue;
      // A cleaner and its client touch on purpose.
      if ((this.mode === 'clean' && o === this.focus) || (this.posing && o.sp.brain.cleaner)) continue;
      _v.subVectors(pos, o.pos);
      const dist = _v.length(), min = (me.size + o.size) * 0.45;
      if (dist < min && dist > 1e-4) dir.addScaledVector(_v, ((min - dist) / min) * 2.5 / dist);
    }
    // The cuttlefish, octopus and turtle (critters.js) are given a wide berth.
    if (!anchored) for (const o of world.critters) {
      _v.subVectors(pos, o.pos);
      const dist = _v.length(), min = o.radius + me.size * 0.5;
      if (dist < min && dist > 1e-4) dir.addScaledVector(_v, ((min - dist) / min) * 3 / dist);
    }
    const B = world.bounds, m = 0.9;
    if (pos.x < B.x0 + m) dir.x += (B.x0 + m - pos.x) * 2;
    if (pos.x > B.x1 - m) dir.x -= (pos.x - B.x1 + m) * 2;
    if (pos.z < B.z0 + 0.5) dir.z += (B.z0 + 0.5 - pos.z) * 3;
    if (pos.z > B.z1 - 0.4) dir.z -= (pos.z - B.z1 + 0.4) * 3;
    if (pos.y > B.y1 - 0.4) dir.y -= (pos.y - B.y1 + 0.4) * 3;
    // Look ahead for rock: the highest reef along the next second or so of travel, so a fish starts its
    // climb before a coral head rather than at its foot. Over branching coral the height field is bumpy
    // cell to cell, so the remembered top sinks back slowly and the fish glides level across instead of
    // bobbing into every gap.
    // In (or at the mouth of) its shelter, resting or hiding, the fish may be under the rock's top: it
    // keeps between the gap's floor and roof instead (fish.js lets it below the height field too).
    const sh = this.shelter;
    // (Hysteresis: once in, the fish counts as in until clearly out, or it flips between this and the
    // reef reflex at the edge and bobs.)
    const was = this.sheltered === sh, extra = was ? 0.8 : 0.4;
    this.sheltered = sh && (this.mode === 'rest' || this.mode === 'flee') && pos.y < sh.top + (was ? 0.25 : 0)
      && Math.hypot(pos.x - sh.pos.x, (pos.z - sh.pos.z) * (sh.kind === 'ledge' ? 0.6 : 1)) < sh.r + extra ? sh : null;
    if (this.sheltered) {
      // Ease to the middle of the gap (hard limits either side made it bob between them).
      const mid = clamp(sh.pos.y, sh.floor + me.size * 0.15, sh.top - me.size * 0.25);
      dir.y = dir.y * 0.3 + (mid - pos.y) * 1.5;
      this.reefSeen = undefined;
      return speed;
    }
    const reach = 0.3 + Math.max(0, me.speed) * 1.2, hd = Math.hypot(me.dir.x, me.dir.z) || 1;
    let top = world.reefHeight(pos.x, pos.z);
    for (const k of [0.33, 0.67, 1]) top = Math.max(top, world.reefHeight(pos.x + (me.dir.x / hd) * reach * k, pos.z + (me.dir.z / hd) * reach * k));
    this.reefSeen = top >= (this.reefSeen ?? -Infinity) ? top : Math.max(top, this.reefSeen - 0.6 * dt);
    const ahead = this.reefSeen + clearance;
    const below = world.reefHeight(pos.x, pos.z) + clearance;
    if (pos.y < below) dir.y += (below - pos.y) * 4 + 0.5;
    else if (pos.y < ahead && !anchored) dir.y += (ahead - pos.y) * 1.5;
    // And in 3D (rockField.js): rock on the path a moment ahead turns the fish off it along the surface
    // normal there, so it goes round a boulder's flank as readily as over it.
    if (!anchored && !me.spine) {
      const want = me.size * 0.6 + clearance;
      for (const k of [0.5, 1]) {
        _v.copy(pos).addScaledVector(me.dir, reach * k);
        const d = world.rockDist(_v);
        if (d < want) dir.addScaledVector(world.rockNormal(_v, _n), ((want - d) / want) * 2 / k);
      }
    }

    return speed;
  }
}
