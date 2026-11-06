---
name: roku-sdk-cpu-and-heap-profiling
description: "Use when an RSG SDK TypeScript app's CPU time or heap has to be attributed — which JavaScript function is hot, or which objects and call sites hold the heap — recording a CPU profile, heap snapshot or allocation sample through the server's CDP session, making frames readable rather than minified, driving the app between start and stop, reading the .cpuprofile, .heapprofile or .heapsnapshot that lands on disk, and profiling while also evaluating expressions in the same session, which a debugger tool having run on that session makes impossible. Not the heap's size alone, which app-performance reads with cdp_heap_usage; not frame drops, jank or a render-thread question, which is app-performance; not a crash stack, which is mcp-ai-dev-loop; and not missing MCP tools, which is mcp-setup."
# @roku-sdk/ai managed v=1 hash=d51bd70e4f477533c163325a1ae482f3001124d9abf18ebf1adcee6cb710a1e3 skills=1 do-not-edit
---

# CPU and Heap Profiling

## Overview

The server's CDP profiler answers "which JavaScript function is burning the time" and "what is
holding memory" against the running app, and writes the result to a file you then read. It rides
on a debug session, so the loop is fixed: create the session, drive the app to the state worth
measuring, start a capture, drive the interaction, stop it, read the file. A CPU capture only
names functions on an unminified build, which is the precondition to settle before recording.

## When to Use

- a screen, key press or list that is slow and the question is which TypeScript function is hot
- JS memory that grows and the question is what is retaining it
- comparing a `.cpuprofile`, `.heapprofile` or `.heapsnapshot` before and after a change
- profiling while also evaluating expressions in the same app (`cdp_eval`)

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Frames dropped, a transition janks, the render thread is the suspect | The `app-performance` skill | A Perfetto trace shows the render and transaction threads; a CPU profile only sees JavaScript |
| Only total and used heap bytes are wanted, or whether they climb the longer the app runs | `cdp_heap_usage` in `app-performance` | A capture is heavier than the question; read the size first, and capture only once the question becomes what holds it |
| The app crashed and there is a stack | The `mcp-ai-dev-loop` skill | Crashes are decoded, not profiled |
| No profiling tools in the session | The `mcp-setup` skill | These tools exist only against a running `rk server` |
| No agent session, a shell script or CI job | Nothing here drives it from a shell | The tools are MCP and REST; the loop below is what a script would have to reproduce |

## Quick Reference

| Question | Call | Gives |
|---|---|---|
| Open the session | `cdp_session_create { root }` | Builds and sideloads a debug build, connects |
| Which functions are hot | `cdp_profile_start`, then `cdp_profile_stop` | A `.cpuprofile` file |
| Profile the next N ms in one call | `cdp_profile_start { durationMs }` | The server stops and writes it; no stop call |
| What retains memory right now | `cdp_heap_snapshot` | A `.heapsnapshot`, blocks until written |
| Which call sites hold allocations | `cdp_heap_sampling_start`, then `cdp_heap_sampling_stop` | A `.heapprofile` |
| Release the device | `cdp_session_end` | One session per device |

Every response is metadata (`filePath`, byte and node counts, a `captureId`), never the profile.
Read the file at `filePath`. Steps 4 and 5 below, and the shape of each file, are in
`references/reading-profiles.md`: read it before summarising a profile, because the two
mistakes that make one wrong — reading self time as total time, and reading a minified
build — both look like a finished answer.

## Instructions

1. **Profile a debug build.** `cdp_session_create` builds in debug mode, which is unminified
   JavaScript, so frames keep their function names; no config change is needed. From a terminal
   the same build is `rk dev --debug`. If every frame is a short renamed symbol, the profile came
   from a minified build (`rk dev --release`, or `--minify`): rebuild with `--debug`. Profile
   timings from a debug build have no Hermes bytecode: use them to rank functions against each
   other, not to quote milliseconds.
2. **Create the session.** `cdp_session_create { root }` with the absolute app root. It needs a
   running `rk server`. A second session for the same device is refused until `cdp_session_end`.
3. **Drive the app to the starting state before recording.** Use `ecp`, `capture_screen`, or
   `cdp_eval` to reach the screen, so the capture holds the interaction and not the navigation to it.
4. **Start, drive, stop.** `cdp_profile_start`, perform the interaction, `cdp_profile_stop`.
   Keep the window to the interaction; a long capture buries it. For "the next N ms", pass
   `durationMs` and skip the stop call: the file appears at the `filePath` the start returned,
   and a later `cdp_profile_stop` answers `CAPTURE_NOT_ACTIVE`.
5. **Read the file, then answer.** Open `filePath`, rank functions by self time, and map the
   top ones back to source with `cdp_source_grep` or `cdp_source_get`.
6. **Change one thing, capture again.** One profile is not evidence: the sampler is a few
   hundred hertz at best, so a function that shows once may be noise. Repeat the same
   interaction and compare what repeats.
7. **End the session and redeploy.** `cdp_session_end`, then redeploy normally so the next
   person does not measure your debug build.

### Profiling and evaluating in one session

`cdp_eval`, `cdp_profile_*` and `cdp_heap_*` interleave freely on one session: eval, profile,
eval again needs no reconnect. The exception is any `cdp_debugger_*` tool, including arming a
breakpoint: after the first one, `cdp_eval` is disabled for that connection for good, while the
profiler tools keep working. So a session that already ran a debugger tool cannot combine
profiling with evaluation. `cdp_session_end`, then `cdp_session_create` a fresh one, and do
the eval and profile work in it without touching a debugger tool.

## Example

Profiling a slow screen transition, then checking the heap:

```text
# cdp_session_create builds a debug (unminified) build; no config change needed
cdp_session_create   { root }                        -> sessionId
ecp                  { keypress: Select }             -- reach the screen
cdp_profile_start    { samplingHz: 200 }              -> captureId, filePath
ecp                  { keypress: Right }              -- the slow transition
cdp_profile_stop     {}                               -> filePath, nodeCount, sampleCount, durationMs
cdp_heap_snapshot    {}                               -> filePath, bytes, nodeCount, edgeCount
cdp_session_end      {}
```

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| Frames are single letters or `(anonymous)` | The build was minified (`--release` or `--minify`) | Rebuild with `--debug` (or a fresh `cdp_session_create`), capture again |
| `NO_CDP_SESSION` | Session missing, or created with `rk cdp` rather than `cdp_session_create` | `cdp_session_create`; the aliased tools cannot see a REST-created one |
| `CAPTURE_ALREADY_ACTIVE` / `SAMPLING_ALREADY_ACTIVE` | A capture is open on this session | Stop it, or pass its `captureId` to the stop call |
| `CAPTURE_NOT_ACTIVE` on stop | `durationMs` already stopped it | Read the file the start returned |
| `cdp_eval` refused after profiling worked | A `cdp_debugger_*` tool ran on this session | Fresh session, above |
| `samplingHz` made no difference | Older firmware may ignore it and sample at its own rate | Compare captures at the same rate; do not tune it |
| Heap sampling profile is nearly empty | It shows only allocations still live at stop; the collector ran | Stop earlier, or use `cdp_heap_snapshot` for retained memory |
| `SNAPSHOT_TIMEOUT` | A large heap took over two minutes | Retry once idle; an immediate retry can come back incomplete |
| Timings look worse than users report | Debug build, no bytecode | Rank, don't quote; confirm with a normal build's trace |

The tool descriptions from the server's `tools/list` carry each parameter and response field;
enumerate them rather than trusting this table.
