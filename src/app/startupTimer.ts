// Startup timing: each stage's wall time since the last, reported once the first frame is on screen.
// Listeners (the loading screen) hear each stage as it completes.

export type StageTimes = Readonly<Record<string, number>>;
export type StageListener = (name: string) => void;

export class StartupTimer {
  private readonly stages: [string, number][] = [];
  private readonly listeners: StageListener[] = [];
  private readonly start: number;
  private last: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.start = now();
    this.last = this.start;
  }

  /** Calls `listener` with each stage's name as it completes. */
  onStage(listener: StageListener): void {
    this.listeners.push(listener);
  }

  stage(name: string): void {
    const t = this.now();
    this.stages.push([name, Math.round(t - this.last)]);
    this.last = t;
    for (const l of this.listeners) l(name);
  }

  times(): StageTimes {
    return Object.fromEntries(this.stages);
  }

  totalMs(): number {
    return Math.round(this.now() - this.start);
  }
}
