---
name: roku-sdk-app-performance
description: "Use when an RSG SDK TypeScript app janks, drops frames, responds late, or its memory climbs the longer it runs on a real Roku, and the question is how to measure it — recording a Perfetto trace and the order the calls have to happen in, reading which thread and which interval actually blocks, attributing the inside of a slow window to the TypeScript that ran there, and reading how much JS heap the running app holds with cdp_heap_usage, including why the debug build that read needs makes its timings incomparable with a normal run. What retains that heap is cpu-and-heap-profiling. Not for the everyday deploy-and-inspect loop, not for a slow build, not for making a test reliable whether or not it runs on hardware, and not for a component's own API once a trace has named it."
# @roku-sdk/ai managed v=1 hash=640336a3c6b2b01b4ab84d9051f746c56554fc5443dd12d160c3c63f000fd61d skills=1 do-not-edit
---

# App Performance

## Overview

An RSG SDK TypeScript app that stutters, drops frames or grows its memory is diagnosed by
measuring it on the device, and there are two measurements: a Perfetto trace, which says where
the time went, and a CDP heap read, which says how much memory is held. They do not coexist —
the heap read rebuilds the app in debug mode — so decide which question you are asking before
recording anything. This skill covers taking the measurement and classifying what it shows.

## When to Use

- an animation, scroll or transition that janks or drops frames on real hardware
- a key press whose effect arrives late, or a screen that takes too long to appear
- memory that climbs the longer the app is left running
- a recorded trace that has to be read: which thread, which slice, which interval blocks
- confirming that a change actually improved something, rather than assuming it did

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| The everyday deploy, screenshot, drive and log loop | The `mcp-ai-dev-loop` skill | Those tools answer what the app did, not what it cost |
| The tracing tools refuse, or no tools are present | The `mcp-setup` skill | The Perfetto tools need a running server; that is setup |
| A grid's own configuration or API | The `flex-grid` skill | Once a trace names the grid, the fix is that component's subject |
| A slow build, install or CI job | The `cli-dev-loop` skill | Nothing here measures anything but the running app; how the build and install steps are invoked belongs there |
| A test that never touches hardware | The `testing` skill | Timings from an in-process tree describe the host machine |
| A test that passes some runs and fails others, on a device or off it | The `testing` skill for an in-process test; for one that drives real hardware, no skill in this library covers it — take it to the repository's own device-test guidance | Flakiness is a determinism problem; nothing here measures whether a result is repeatable, and a trace of a passing run says nothing about the failing one |

## Quick Reference

| Question | Call | Gives |
|---|---|---|
| Where did the frame time go | `perfetto_enable`, then `perfetto_start` / `perfetto_stop` | A trace file to open in the Perfetto UI |
| The same recording with no agent session | `rk perfetto` | The CLI spelling of those three calls; the analysis afterwards is identical and stays here |
| How much JS memory is held | `cdp_session_create`, then `cdp_heap_usage` | Total and used heap bytes |
| Which JavaScript function is hot, or what retains memory | The `cpu-and-heap-profiling` skill | A CPU profile or heap snapshot file |
| Release the debug session | `cdp_session_end` | One session per device; this frees it |
| Which TypeScript ran inside a slow window | Redeploy with `deploy_app`'s `perfettoPaths` | Named slices for instrumented functions |
| Which callback fired | The `EventCallback` slice under `observer.callback`, in an instrumented build | Function name and source position |

## Instructions

1. **Pick the measurement from the question, not the other way round.** "It janks" is a trace.
   "It grows" is a heap read. Recording the wrong one is expensive in a way that is not obvious
   later, because both produce plausible-looking numbers.

2. **Enable tracing before the app launches.** `perfetto_enable` configures the device; the app
   reads that configuration at startup. Enabling after the app is already running yields a trace
   missing exactly the early work most worth seeing, and it looks like a successful recording.
   The order is `perfetto_enable`, then deploy, then `perfetto_start` — reproduce the problem —
   then `perfetto_stop`.

3. **Read the trace against the render threads first.** `RenderThr:Main` carries `render` and
   `swapBuffers` and is where the frame budget is decided; `AuxRenderThread` carries work that
   can steal from it, and `consumeAllTasks` running on either during an animation is one of the
   three usual causes of jank. TypeScript work arrives under the `rokuos.typescript` category.
   Locate those in the track list before reading a single slice, because every rule below is
   stated relative to where a slice sits.

4. **The frame budget is `render` plus `swapBuffers` inside 16.67 ms.** Past that the frame is
   dropped. The usual causes are one long `render`, meaning a heavy scene or too many nodes, or
   an `observer.callback` over 1 ms delaying the first `render`.

5. **Only two transaction intervals block, and only in one direction.** Going from TypeScript to
   the render thread, `transaction.start` to `transaction.commit` blocks, and so does
   `transaction.update` to `transaction.end`; over roughly 300 ms during an animation is what
   makes a smooth scroll jank. The trace points carrying `toTS` are the other direction, and a
   wide span there does **not** stall the render thread. Reading one as a stall is the most
   common way to spend a day on the wrong slice.

6. **Attribute the inside of a slow window by instrumenting, not by guessing.** Redeploying with
   `deploy_app` and `perfettoPaths: ["packages/solid/src"]` — `--perfetto-paths` is the same
   thing spelled for a terminal — names the reactive work inside the interval, where a
   `createElement` slice means a SceneGraph node was created — during an animation that is
   itself the finding. Widen to `solid-js` only if the narrower path is not enough: each
   tracepoint costs roughly 10–30 microseconds per call, so a broad path distorts what you came
   to measure. The value is matched as a substring of the source file path, so it depends on where
   the SDK sits: `packages/solid/src` inside this workspace, `@roku-sdk/solid/src` in an app that
   installed it. A path that matches nothing instruments nothing and reports no error, which reads
   as an interval with no TypeScript in it. Naming every `createSignal` and `createMemo` makes
   reactive slices attributable, but only in a build with `solidDevMode: true` at the top level
   of `roku-config.ts` built with `rk dev --debug` (or `--solid-dev-mode` on any JS build), which is
   off by default. Plain `rk dev` ignores the config field, and a build that precompiles to Hermes
   bytecode skips it, so reactive work in a production trace stays anonymous no matter how
   the config is set. The switch also adds overhead at component and signal creation, which is
   one more reason the trace it names is not the one to quote timings from.

7. **A heap read changes the build, so never compare its timings with a trace.**
   `cdp_session_create` builds and sideloads unminified JavaScript with the debug preset
   (debugger probe stubs, config overrides); plain `rk dev` also ships JavaScript by default. `cdp_heap_usage` reports total and used bytes from that app. Memory numbers
   are meaningful, timings from that build are not. Only one session may exist per device, so
   end it with `cdp_session_end` before starting another.

8. **One trace is not evidence.** A TypeScript slice that spikes may have had garbage collection
   run inside it, and one that spikes on a render thread may simply have been scheduled away.
   Trust what repeats across frames, and re-record the same interaction after a fix rather than
   declaring the fix worked.

9. **Remove what you instrumented.** Extra tracepoint paths, temporary slices and debug builds
   all outlive the investigation if nothing takes them out. Redeploy normally before handing the
   app back, or the next person measures your instrumentation.

## Example

Recording a scroll that janks, in the order the calls have to happen:

```text
perfetto_enable  {}                       -> device configured; must precede launch
deploy_app       { root }                 -> the app starts with tracing on
perfetto_start   {}                       -> returns sessionId and filePath
                                          -- reproduce the jank now
perfetto_stop    { sessionId }            -> filePath, bytes, durationMs
```

Then, in the trace: find the `keyEvent` that starts the scroll, follow the run of `render` and
`swapBuffers` after it on `RenderThr:Main`, and measure the first frame that exceeds 16.67 ms.
Everything overlapping that timestamp on the other two threads is the candidate set; a
`transaction.start` to `transaction.commit` gap spanning it is the answer, and a `toTS` span
spanning it is not.

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| The trace is missing the startup or first-animation work | Tracing was enabled after the app launched | `perfetto_enable` first, then deploy, then `perfetto_start` |
| A wide transaction span sits over the dropped frame but changing that code does nothing | It was a `toTS` span, which does not block the render thread | Measure `transaction.start` to `transaction.commit` instead |
| Timings look far worse than users report | They were read from a build made for a heap session, which has no Hermes bytecode | Trace a normal build; use the debug build only for memory |
| `cdp_session_create` is refused | A session already exists for that device | `cdp_session_end`, then create the new one |
| Instrumented slices are everywhere and nothing is legible | The instrumentation path was widened before the narrow one was read | Start at `packages/solid/src` and add more only if it falls short |
| Reactive work shows up unnamed | Named slices need solid's development build, which a production build skips outright | Set `solidDevMode: true` and redeploy with `rk dev --debug`, or pass `--solid-dev-mode` |
| A fix looks like an improvement in one recording | A single spike can be garbage collection or a context switch | Re-record and compare what repeats across frames |
| The tracing tools report that they need a server | Perfetto tools are server-mode only | Start one — see the `mcp-setup` skill |
