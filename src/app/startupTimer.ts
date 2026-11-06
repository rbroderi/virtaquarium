// Startup timing: each stage's wall time since the last, reported once the first frame is on screen.

export type StageTimes = Readonly<Record<string, number>>;

export class StartupTimer {
  private readonly stages: [string, number][] = [];
  private readonly start: number;
  private last: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.start = now();
    this.last = this.start;
  }

  stage(name: string): void {
    const t = this.now();
    this.stages.push([name, Math.round(t - this.last)]);
    this.last = t;
  }

  times(): StageTimes {
    return Object.fromEntries(this.stages);
  }

  totalMs(): number {
    return Math.round(this.now() - this.start);
  }
}
