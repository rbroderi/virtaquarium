<!-- @roku-sdk/ai managed v=1 hash=59e9a4d12450c43d27b21795ca9e42f2a66831317cfbe1f94fe875c4177b1d75 skills=1 do-not-edit -->

# Live debugging: breakpoints and paused frames

A debug session can do more than report what already went wrong. It can stop the app on a line
you choose and let you read the values that reached it — which is the difference between
inferring why a handler misbehaved and watching it happen.

Creating a session, and reading errors or console output from one, is
`references/crash-and-console.md`. This file starts once a session is up.

## `cdp_eval` keeps working alongside the debugger

`cdp_eval` evaluates an expression inside the running app without stopping it, and it keeps
working for the whole life of the connection — including after a `cdp_debugger_*` tool has
enabled the Debugger domain, arming a breakpoint, or being genuinely paused.

While paused, `cdp_debugger_eval_frame` is still the better tool for inspecting the paused
code itself: it evaluates in the frame's own scope, so a handler's arguments and locals are in
scope by name, which `cdp_eval` (global scope only) can't see. It requires a `callFrameId`,
which `cdp_debugger_state` returns for each frame of the current pause. Reach for it because of
that extra visibility, not because `cdp_eval` has stopped working.

A breakpoint, not a blind pause, is still the reliable way into a stopped app: `cdp_debugger_pause`
against an idle app (nothing running, no timers/animation/input) simply times out after about
five seconds — there's no JavaScript execution to interrupt. A breakpoint on a line you know
executes, followed by driving the app to it, always lands where you intended.

## The flow

Six steps, and the order matters more than any single call:

1. **`cdp_source_grep`** — find the line by searching the *deployed* bundle, matched by
   TypeScript path. This is also how you get a path in the form the next step demands.
2. **`cdp_breakpoint_set`** — arm it. The response reports the compiled line it mapped to.
3. **Drive the app to that line** — `ecp` with `command: "keypress"`, or whatever reaches the
   code. Once it stops the app itself is frozen: its UI stops responding, and anything that waits
   on the app to do something will wait forever. The debugger tools are what still answer.
4. **`cdp_debugger_state`** — read the pause. It returns a `callFrameId` per frame, each already
   mapped back to a TypeScript file and line, with the SDK's own frames below yours.
5. **`cdp_debugger_eval_frame`** — read values in that frame's scope, by name. A handler's
   arguments and locals are simply in scope; nothing has to be logged to be visible.
6. **`cdp_debugger_resume`** — let it go.

`cdp_debugger_pause` is deliberately absent from that list. It interrupts at the next statement
the app happens to execute, which means it either times out on an idle app or lands somewhere
you did not choose on a busy one. It answers exactly one question — whether the app is executing
JavaScript at all — and is not a way to reach a line.

## When a breakpoint does not stop where you expect

Keyed on the symptom, because that is the order you meet them in:

| What you see | What it means | What to do |
|---|---|---|
| `Could not map src/file.tsx:120 to a compiled location: the file exists on disk but is not part of the bundle`, HTTP 400 | The path resolved, but the file is not in the bundle that is on the device: tree-shaken out, or not reachable from the entry | Confirm with `cdp_source_list` or `cdp_source_grep`. Nothing is wrong with the path or the line |
| `Could not map …` ending `(project root: …)`, or `: no compiled code at or after this line` | The first: the path matches no source in the map. A path is accepted as absolute, as relative to the session's project root, or as the raw source-map path. The second: the file is in the bundle but nothing is compiled at or after that line, as at the end of a file | First: take the path from `cdp_source_list` or `cdp_source_resolve`. Second: use an earlier line, and confirm the extent with `cdp_source_get` |
| `Breakpoint creation failed` | The location exists but the engine refused it — an import or declaration that produced no reachable instruction | Move to a statement that executes at run time |
| The call **succeeds**, reports `active: true`, and nothing ever stops | Two different causes, below. This is the expensive one, because nothing surfaces it | Do not trust `active: true`. It means the line was *mapped*, not that it can be reached |

**Read that first message carefully, because its wording is the trap.** `Could not map … to a
compiled location` sounds like *this line is not executable*, and the natural reaction is to go
looking for a different line. It is almost always the path. A relative path fails this way even
when the line is perfect:

- Fails: `src/components/player.tsx`
- Works: `/Users/you/project/src/components/player.tsx`

For the accepted-but-silent case, there are two causes and they need different fixes:

| Cause | How to confirm |
|---|---|
| The line number matches your working tree, not the build on the device | `cdp_source_get` reads the deployed bundle. If what it shows at that line is not what your editor shows, the breakpoint is on whatever used to be there. Rebuild with `cdp_session_update` rather than by hand: it redeploys into the same session and re-maps every breakpoint against the new build, **reporting the ones it can no longer place** — which turns this silent case into a named failure |
| The line carries no executable statement — a comment, a blank line, a type-only declaration | The mapping snaps to a nearby compiled offset and reports success for a location that can never be reached. Move to a statement that runs |

One more message worth recognising rather than fearing: `the app's compiled script has not been
observed yet`. It is close to unreachable in practice, because enabling the domain makes the
engine replay its already-loaded scripts before acknowledging. If it does appear, the session
attached earlier than the app's own bundle loaded.

## Two habits

**Resume before concluding.** A component that renders more than once per interaction stops once
per render, and the first stop need not be the interesting one — a single key press stops twice on
a handler that runs on both the press and the release edge, and the values differ between them.
Read the first frame, resume, and see whether another stop follows before deciding what happened.

**Step only once you are in the right frame.** `cdp_debugger_step_over`, `_step_into` and
`_step_out` are cheap once a pause is where you want it and nearly useless as a way of getting
there. Prefer a second breakpoint over stepping toward a distant line.

## Before a long session: the request limiter

The server rate-limits itself, and a debugging sweep is the one workflow that reaches the ceiling:
**100 requests per rolling 15 minutes**, counted across every route but the health check, so tool
calls and CDP traffic share the budget. Exceeding it returns HTTP 429 with `RATE_LIMIT_EXCEEDED`.

That is worth knowing in advance because of how it presents. Calls start failing partway through a
session that was working, which reads like the app having crashed or the device having dropped off
— and the instinct is to redeploy, which spends more requests.

Raise it before you start, not after: `--no-rate-limit` when launching the server, or
`RK_DISABLE_RATE_LIMIT=1` in its environment. Both are read once at startup, so a server that is
already running has to be restarted for either to matter.

## Reading the deployed source

`cdp_source_list`, `cdp_source_get`, `cdp_source_grep` and `cdp_source_resolve` all read the
bundle **that is on the device**, addressed by TypeScript path. That is the point of them: they are
not a convenience over opening the file locally, they are the only way to see what the device
actually has. Every stale-line problem above is diagnosed with them, and `cdp_source_list` is where
an exact path comes from when a project-relative one does not match.

Two things to expect from `cdp_source_list`. It returns the SDK's and dependencies' sources
alongside the app's own, so the app's files are a small minority of a long list — filter rather
than read it. And the session summary's file count is not the length of that list; treat it as
"a source map loaded" and nothing more.

## Not to be confused: the `dap_*` family

`dap_*` speaks Roku's own socket-based BrightScript debug protocol on TCP 8081. It is **not** the
Microsoft Debug Adapter Protocol, and the resemblance of the name is the whole problem — every one
of those tool descriptions says so in capitals. Nothing on this page uses that family: TypeScript
running under the JavaScript engine is debugged through the `cdp_*` tools.

## What belongs elsewhere

| If the question is | Go to |
|---|---|
| An exception that has already been thrown, or console output | `references/crash-and-console.md` — a session reports those with stacks already mapped, and no breakpoint is involved |
| What something costs — memory, frame time, why the app janks | The `app-performance` skill. It owns the measurement tools, and this page is about correctness, not cost |
