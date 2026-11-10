// The loading screen: a progress bar over the tank while it starts up. It follows the startup timer's
// stages (each weighted by its usual share of the wait), and the reef-light bake reports its own
// progress within its stage, since a first run for a layout bakes for up to a minute.
import { errorMessage } from '../core/dom.js';
import type { StartupTimer } from './startupTimer.js';

interface StagePlan {
  /** StartupTimer stage name (marks the stage's end). */
  readonly name: string;
  /** What the viewer is told while the stage runs. */
  readonly label: string;
  /** Usual share of the wait (relative). */
  readonly weight: number;
}

/** The tank page's stages in order (main.ts). The jelly tank skips some; the bar just moves on. */
const PLAN: readonly StagePlan[] = [
  { name: 'renderer, environment, caustics', label: 'Filling the tank', weight: 4 },
  { name: 'fish models + skin cache', label: 'Painting the fish', weight: 8 },
  { name: 'load scenery', label: 'Loading rocks and corals', weight: 10 },
  { name: 'build reef', label: 'Building the reef', weight: 12 },
  { name: 'reef light bake', label: 'Lighting the reef', weight: 40 },
  { name: 'wait for skin painters', label: 'Painting the fish', weight: 1 },   // skins the cache lacked, painted in workers since the skin-cache stage
  { name: 'fish and critters', label: 'Releasing the fish', weight: 12 },
  { name: 'compile shaders', label: 'Preparing shaders', weight: 6 },
  { name: 'first frame (shader compile)', label: 'Almost there', weight: 8 },
];
const TOTAL = PLAN.reduce((a, s) => a + s.weight, 0);
/** How long the screen fades out (ms, matches the CSS transition). */
const FADE_MS = 900;
/** A wait that lets the browser paint even in a background tab (where frames don't come). */
const PAINT_TIMEOUT_MS = 50;

export class LoadingScreen {
  private current = 0;
  private sub = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly bar: HTMLElement,
    private readonly label: HTMLElement,
  ) {
    this.render(PLAN[0]?.label ?? '');
  }

  /** Builds one from the page's #loading markup, or null when the page has none. */
  static fromPage(): LoadingScreen | null {
    const root = document.getElementById('loading'), bar = root?.querySelector<HTMLElement>('.bar i'), label = root?.querySelector<HTMLElement>('.label');
    return root && bar && label ? new LoadingScreen(root, bar, label) : null;
  }

  /** Follows the timer: each completed stage moves the bar on to the next. */
  follow(timer: StartupTimer): void {
    timer.onStage((name) => {
      const i = PLAN.findIndex((s) => s.name === name);
      if (i < 0) return;
      this.current = Math.max(this.current, i + 1);
      this.sub = 0;
      this.render(PLAN[this.current]?.label ?? '');
    });
  }

  /** Progress within the current stage (0..1), with an optional more specific label. */
  progress(done: number, label?: string): void {
    this.sub = Math.min(1, Math.max(0, done));
    this.render(label ?? PLAN[this.current]?.label ?? '');
  }

  /** Lets the browser paint the bar before a long synchronous step. */
  paint(): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => resolve();
      setTimeout(done, PAINT_TIMEOUT_MS);
      requestAnimationFrame(() => setTimeout(done, 0));
    });
  }

  /** Fades the screen out once the tank is on screen. */
  finish(): void {
    this.current = PLAN.length;
    this.render('');
    this.root.classList.add('done');
    setTimeout(() => this.root.remove(), FADE_MS);
  }

  /** Startup failed: keep the screen up with the error. */
  fail(e: unknown): void {
    this.root.classList.add('failed');
    this.label.textContent = `Could not start: ${errorMessage(e)}`;
  }

  private render(text: string): void {
    const before = PLAN.slice(0, this.current).reduce((a, s) => a + s.weight, 0);
    const share = (before + (PLAN[this.current]?.weight ?? 0) * this.sub) / TOTAL;
    this.bar.style.width = `${(Math.min(1, share) * 100).toFixed(1)}%`;
    this.label.textContent = text;
  }
}
