// The tank's ambience: a deep-sea underwater soundscape, looped without a seam. On by default; M, the
// speaker button or the touch menu turn it off, and the choice is remembered. Browsers only allow sound
// after a gesture, so "on" starts at the first click or key. Paused while the page is hidden.
//
// Seamless loop: an <audio loop> wraps with a small gap in some browsers, so two players take turns.
// Near the end of one, the other starts from the top and they cross over with equal-power fades
// (the sound is noise-like, so the overlap neither dips nor swells).
//
// Sound effect by DRAGON-STUDIO from Pixabay (credited in the help panel and web/audio/CREDITS.md).

const SRC = './audio/deep-sea-ambience.webm';
/** Overlap of the two players at the loop point (s). */
const CROSSFADE = 4;
/** Fade when switching the sound on or off (s). */
const TOGGLE_FADE = 1.2;
const VOLUME = 0.6;
const STORE_KEY = 'virtaquarium.sound';
const CURVE_STEPS = 64;

interface Player {
  readonly el: HTMLAudioElement;
  readonly gain: GainNode;
}

function readStored(): boolean {
  try { return localStorage.getItem(STORE_KEY) !== 'off'; } catch { return true; }
}

function store(on: boolean): void {
  try { localStorage.setItem(STORE_KEY, on ? 'on' : 'off'); } catch { /* private mode: not remembered */ }
}

/** Equal-power fade curve: cos (out) or sin (in) over a quarter turn. */
function fadeCurve(fadeIn: boolean): Float32Array {
  const c = new Float32Array(CURVE_STEPS);
  for (let i = 0; i < CURVE_STEPS; i++) {
    const a = (i / (CURVE_STEPS - 1)) * Math.PI / 2;
    c[i] = fadeIn ? Math.sin(a) : Math.cos(a);
  }
  return c;
}

export class Ambience {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private players: Player[] = [];
  private current = 0;
  private crossing = false;
  private wanted = readStored();
  private stopTimer = 0;

  constructor() {
    if (this.wanted) {
      // "On": start at the first gesture, but not one that is itself a sound toggle (M, the speaker).
      const start = (e: Event): void => {
        if (e instanceof KeyboardEvent && (e.key === 'm' || e.key === 'M')) return;
        if (e.target instanceof Element && e.target.closest('[data-sound-toggle]')) return;
        window.removeEventListener('pointerdown', start, true);
        window.removeEventListener('keydown', start, true);
        if (this.wanted) this.start();
      };
      window.addEventListener('pointerdown', start, true);
      window.addEventListener('keydown', start, true);
    }
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.pauseAll();
      else if (this.wanted) this.start();
    });
  }

  get isOn(): boolean {
    return this.wanted;
  }

  toggle(): void {
    this.wanted = !this.wanted;
    store(this.wanted);
    if (this.wanted) this.start(); else this.stop();
  }

  private setup(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    this.players = [0, 1].map(() => {
      const el = new Audio(SRC);
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      ctx.createMediaElementSource(el).connect(gain).connect(master);
      el.addEventListener('timeupdate', () => this.watch(el));
      el.addEventListener('ended', () => this.ended(el));
      return { el, gain };
    });
    this.ctx = ctx;
    this.master = master;
    return ctx;
  }

  private start(): void {
    const ctx = this.setup();
    window.clearTimeout(this.stopTimer);
    void ctx.resume();
    const p = this.players[this.current] as Player;
    if (p.el.paused) {
      // Resuming after a stop: if it was stopped mid-crossfade, drop the outgoing player.
      const other = this.players[1 - this.current] as Player;
      other.el.pause();
      other.gain.gain.cancelScheduledValues(ctx.currentTime);
      other.gain.gain.setValueAtTime(0, ctx.currentTime);
      this.crossing = false;
      p.gain.gain.cancelScheduledValues(ctx.currentTime);
      p.gain.gain.setValueAtTime(1, ctx.currentTime);
      void p.el.play().catch(() => { /* blocked until a gesture; the next toggle retries */ });
    }
    this.ramp(VOLUME);
  }

  private stop(): void {
    if (!this.ctx) return;
    this.ramp(0);
    window.clearTimeout(this.stopTimer);
    this.stopTimer = window.setTimeout(() => this.pauseAll(), TOGGLE_FADE * 1000 + 100);
  }

  private pauseAll(): void {
    window.clearTimeout(this.stopTimer);
    for (const p of this.players) p.el.pause();
    if (this.ctx && this.master) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setValueAtTime(0, this.ctx.currentTime);
    }
  }

  private ramp(to: number): void {
    const ctx = this.ctx, master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(to, t + TOGGLE_FADE);
  }

  /** Near the end of the playing one, start the other from the top and cross over. */
  private watch(el: HTMLAudioElement): void {
    const ctx = this.ctx;
    const cur = this.players[this.current];
    if (!ctx || !cur || cur.el !== el || this.crossing || !this.wanted) return;
    if (!Number.isFinite(el.duration) || el.duration - el.currentTime > CROSSFADE) return;
    const next = this.players[1 - this.current] as Player;
    const left = Math.max(0.05, el.duration - el.currentTime);
    const t = ctx.currentTime;
    this.crossing = true;
    next.el.currentTime = 0;
    void next.el.play().catch(() => { this.crossing = false; });
    for (const [p, fadeIn] of [[cur, false], [next, true]] as const) {
      p.gain.gain.cancelScheduledValues(t);
      p.gain.gain.setValueCurveAtTime(fadeCurve(fadeIn), t, left);
    }
    this.current = 1 - this.current;
  }

  private ended(el: HTMLAudioElement): void {
    if (this.players[this.current]?.el !== el) this.crossing = false;   // the outgoing one finished
  }
}
