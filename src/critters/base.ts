// The base every critter species specialises, on the creature step template (creature.ts). CritterBase
// owns what all critters share: the species record, the random stream, the model group, the animation
// and mode clocks, deciding when the mode's time is up, the brain-driven click panel and the soft-body
// mesh. Cephalopod adds what the octopus and cuttlefish share: the startle check and the escape jet.
//
// A species subclass supplies its body plan in its constructor (calling super first, then drawing from
// rng in its own order, its CritterBrain included) and fills in the hooks:
//   sense(dt, world)     react to the world and move its drives (threats, food, tiredness)
//   wantsToDecide(world) (optional) think again before the mode's time is up (new food in sight)
//   decide(world)        score the options with its brain and start the best
//   think(dt, world)     (optional) replace the when-to-decide rule outright (the turtle's breath)
//   act(dt, world)       move, pose and colour the model for this step
//   thought()            the panel's one-line note
//   checkVisits, displayName   its shape check (critterCheck.ts)
// and adds its static create() to factory.ts. Its parts (textures, geometry) live in <species>Parts.ts.
import * as THREE from 'three';
import type { Rng } from '../util.js';
import type { SoftBodyName } from '../softBodies.js';
import type { InspectPanel } from '../inspect.js';
import { softBodyGeometry } from './softBodyMeshes.js';
import { threatNear } from './shared.js';
import type { CritterBrain } from './critterBrain.js';
import { CreatureBase } from '../creature.js';
import type { CheckVisit, Critter, CritterKind, CritterSpecies, CritterWorld, JoinRule } from './types.js';

export abstract class CritterBase<Mode extends string, Drive extends string = string, Trait extends string = string>
  extends CreatureBase<CritterWorld> implements Critter {
  abstract override readonly kind: CritterKind;
  readonly stepPhase = 'free';
  /** The name the shape check reports it under. */
  abstract readonly displayName: string;
  /** The behaviours the shape check holds it in, in turn. */
  abstract readonly checkVisits: readonly CheckVisit[];
  readonly sp: CritterSpecies;
  readonly radius: number;
  readonly model = new THREE.Group();
  // Where parts are attached (and may run into each other): critterCheck.ts.
  abstract readonly joins: readonly JoinRule[];
  abstract readonly buildMs: number;
  abstract mode: Mode;
  abstract modeT: number;
  abstract target: THREE.Vector3;
  /** Its drives, personality and choosing (critterBrain.ts); made in the subclass, at its own point in the rng stream. */
  abstract readonly brain: CritterBrain<Drive, Mode, Trait>;
  protected readonly rng: Rng;
  /** Seconds since it was made: the clock its idle motion runs on. */
  protected t = 0;

  constructor(sp: CritterSpecies, rng: Rng) {
    super();
    this.sp = sp; this.rng = rng; this.radius = sp.radius;
  }

  /** The idle-motion clock runs on; the mode's time runs out. */
  protected override tick(dt: number): void {
    this.t += dt; this.modeT -= dt;
  }

  protected abstract override sense(dt: number, world: CritterWorld): void;
  protected abstract decide(world: CritterWorld): void;
  /** The panel's note: what it is doing, in a line. */
  protected abstract thought(): string;

  /** Decide when the mode's time is up, or sooner if wantsToDecide() says so. */
  protected override think(_dt: number, world: CritterWorld): void {
    if (this.modeT <= 0 || this.wantsToDecide(world)) this.decide(world);
  }

  /** Something new (food in sight) calls for a decision before the mode's time is up. */
  protected wantsToDecide(_world: CritterWorld): boolean { return false; }

  /** The click panel, laid out as the fish panel (critterBrain.ts). */
  override inspect(): InspectPanel {
    return this.brain.panel(this.sp, this.mode, this.thought());
  }

  /** A blended soft body (softBodyMeshes.ts, built at scale 1), scaled, casting shadow, on the model. */
  protected addSoftBody(name: SoftBodyName, material: THREE.Material, scale: number, partName: string): THREE.Mesh {
    const body = new THREE.Mesh(softBodyGeometry(name), material);
    body.scale.setScalar(scale);
    body.castShadow = true;
    body.name = partName;
    this.model.add(body);
    return body;
  }
}

/** The octopus and cuttlefish: a big, fast animal close by startles them into an escape jet. */
export abstract class Cephalopod<Mode extends string, Drive extends string = string, Trait extends string = string>
  extends CritterBase<Mode, Drive, Trait> {
  /** Jet strength left, 1 at the start of a jet. */
  jet = 0;
  /** Seconds before it can startle again. */
  protected calm = 0;
  /** How close a threat startles it. */
  protected abstract readonly threatRange: number;

  /** Escape from a threat at `from` (it sets calm and adds fear). */
  protected abstract jetFrom(world: CritterWorld, from: THREE.Vector3): void;

  /** Count down the calm; when it is over and it isn't already jetting, a threat near sets off a jet. */
  protected reactToThreat(dt: number, world: CritterWorld): void {
    this.calm -= dt;
    const threat = this.calm <= 0 && this.mode !== 'jet' ? threatNear(this, world, this.threatRange) : null;
    if (threat) this.jetFrom(world, threat.pos);
  }
}
