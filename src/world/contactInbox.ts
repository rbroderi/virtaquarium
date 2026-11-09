// The avoidance reflex's messages. When the body separation (world/separation.ts) finds two creatures
// touching, or about to, it posts each a message: who the other is, which way is away from it, and how
// urgent that is (by how close they are, and by the other's share of their masses: a chromis heeds a
// turtle fully, the turtle heeds the chromis less). Posted at the end of one step and read by the
// creature's steering in the next (fish: brain/reflexes.ts; turtle and cuttlefish: Swimmer.steer;
// octopus: its crawl; jellies: the bell's tilt), so the two steer apart rather than the separation
// pushing them apart while their steering drives them straight back in. A creature chasing something
// ignores its quarry's messages, and heeds the rest less (a chase can push past others).
import * as THREE from 'three';

/** How long a message is remembered (s): the creature keeps turning away just after it gets clear. */
const MEMORY = 0.35;
/** Messages fainter than this are dropped. */
const FAINT = 0.02;
/** Chasing, the reflex is heeded this much (the chase can override it). */
export const CHASE_HEED = 0.5;
/** The least a creature heeds a much lighter one (it still makes room for it). */
export const MIN_HEED = 0.35;

/** How much a creature of mass `own` heeds one of mass `other`. */
export const heedOf = (own: number, other: number): number => Math.max(MIN_HEED, Math.min(1, other / (own + other)));

interface Message { readonly away: THREE.Vector3; urgency: number }

export class ContactInbox {
  private readonly from = new Map<object, Message>();

  /** At the start of the separation's step: the old messages fade (the new ones replace them). */
  fade(dt: number): void {
    const keep = Math.exp(-dt / MEMORY);
    for (const [k, m] of this.from) {
      m.urgency *= keep;
      if (m.urgency < FAINT) this.from.delete(k);
    }
  }

  /** A message from `sender`: away (unit) from it, with this urgency (0..1). Several in a step: the strongest. */
  post(sender: object, away: THREE.Vector3, urgency: number): void {
    if (!(urgency > FAINT)) return;
    const m = this.from.get(sender);
    if (!m) this.from.set(sender, { away: away.clone(), urgency: Math.min(1, urgency) });
    else if (urgency >= m.urgency) { m.away.copy(away); m.urgency = Math.min(1, urgency); }
  }

  /** How urgent the message from `sender` is now (0 when there is none); for the checks. */
  urgencyFrom(sender: object): number { return this.from.get(sender)?.urgency ?? 0; }

  /** The message from `sender`: away from it into `out` (zero when there is none), and its urgency. */
  awayFrom(sender: object, out: THREE.Vector3): number {
    const m = this.from.get(sender);
    if (!m) { out.set(0, 0, 0); return 0; }
    out.copy(m.away);
    return m.urgency;
  }

  /**
   * Which way to turn, into `out` (unit, or zero), and how urgently (0..1): every sender but `ignore`
   * (the one it is chasing), scaled by `heed`. Pressed from both sides, the turns cancel.
   */
  read(out: THREE.Vector3, ignore: object | null = null, heed = 1): number {
    out.set(0, 0, 0);
    let peak = 0;
    for (const [k, m] of this.from) {
      if (k === ignore) continue;
      out.addScaledVector(m.away, m.urgency);
      if (m.urgency > peak) peak = m.urgency;
    }
    const len = out.length();
    if (len < 1e-6) { out.set(0, 0, 0); return 0; }
    out.multiplyScalar(1 / len);
    return peak * Math.min(1, len / peak) * heed;
  }
}
