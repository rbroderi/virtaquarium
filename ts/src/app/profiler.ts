// ?profile=1: sample the startup with the JS Self-Profiling API (tools/serve.ts sends the
// Document-Policy it needs) and report the functions that took the most time, self and inclusive.
// The API is not in lib.dom, so it is described here and reached through a narrowing lookup.
import { errorMessage } from '../core/dom.js';

interface ProfilerFrame { readonly name?: string; readonly resourceId?: number; readonly line?: number }
interface ProfilerStack { readonly frameId: number; readonly parentId?: number }
interface ProfilerSample { readonly timestamp: number; readonly stackId?: number }
interface ProfilerTrace {
  readonly frames: readonly ProfilerFrame[];
  readonly resources: readonly string[];
  readonly stacks: readonly ProfilerStack[];
  readonly samples: readonly ProfilerSample[];
}
interface Profiler { stop(): Promise<ProfilerTrace> }
type ProfilerConstructor = new (init: { sampleInterval: number; maxBufferSize: number }) => Profiler;

export interface ProfileReport {
  readonly self: Readonly<Record<string, number>>;
  readonly total: Readonly<Record<string, number>>;
}

const SAMPLE_INTERVAL_MS = 2;
const MAX_BUFFER = 1e6;
const TOP_SELF = 40;
const TOP_TOTAL = 60;

function profilerConstructor(): ProfilerConstructor | null {
  const ctor: unknown = Reflect.get(globalThis, 'Profiler');
  return typeof ctor === 'function' ? (ctor as ProfilerConstructor) : null;
}

export function startProfiler(): Profiler | null {
  const Ctor = profilerConstructor();
  if (!Ctor) return null;
  try {
    return new Ctor({ sampleInterval: SAMPLE_INTERVAL_MS, maxBufferSize: MAX_BUFFER });
  } catch (err) {
    console.warn('Profiler:', errorMessage(err));
    return null;
  }
}

function frameLabel(trace: ProfilerTrace, frameId: number): string {
  const f = trace.frames[frameId];
  const resource = f?.resourceId !== undefined ? trace.resources[f.resourceId] ?? '' : '';
  return `${f?.name || '(anon)'} ${resource.split('/').pop() ?? ''}:${f?.line ?? ''}`;
}

const topEntries = (m: Map<string, number>, k: number): Record<string, number> =>
  Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([n, v]) => [n, Math.round(v)]));

export async function profileReport(profiler: Profiler): Promise<ProfileReport> {
  const trace = await profiler.stop();
  const self = new Map<string, number>(), total = new Map<string, number>();
  // Each sample counts for the time to the next one (Windows samples every ~16 ms whatever was asked).
  trace.samples.forEach((sample, i) => {
    const dt = (trace.samples[i + 1]?.timestamp ?? sample.timestamp) - sample.timestamp;
    const seen = new Set<string>();
    let top = true;
    for (let id = sample.stackId; id !== undefined; id = trace.stacks[id]?.parentId, top = false) {
      const stack = trace.stacks[id];
      if (!stack) break;
      const label = frameLabel(trace, stack.frameId);
      if (top) self.set(label, (self.get(label) ?? 0) + dt);
      if (!seen.has(label)) {
        seen.add(label);
        total.set(label, (total.get(label) ?? 0) + dt);
      }
    }
  });
  return { self: topEntries(self, TOP_SELF), total: topEntries(total, TOP_TOTAL) };
}
