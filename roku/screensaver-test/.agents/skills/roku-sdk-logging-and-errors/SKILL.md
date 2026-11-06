---
name: roku-sdk-logging-and-errors
description: "Use when an RSG SDK TypeScript app has to report what it is doing, or has to survive something throwing — the logger the SDK exports and the thunk its methods take, a level raised at runtime that recovers nothing because the build already deleted the call sites, log levels set through buildVariables that silently change nothing, console calls present in development and gone from a production build, a screen that comes up blank with no crash and no stack because a root component threw, containing that with ErrorBoundary and recovering with catchError or resetErrorBoundaries, registering an uncaught-exception handler and what it never sees, and calling enableExceptionTagging in main() so the running app marks its own traces."
# @roku-sdk/ai managed v=1 hash=76f02b76ee16796dde06adb63248cf46ce5d45ce9a3548d5a9636799236ba60d skills=1 do-not-edit
---

# Logging and Errors

## Overview

An RSG SDK TypeScript app reports what it is doing through one exported `logger`, and survives a
throw through Solid's `ErrorBoundary`. Both have a platform edge that catches people out: log
levels are enforced in **two** places, one of which deletes your call before the app ever runs,
and the SDK already wraps every screen in a boundary whose fallback draws nothing — so the
default shape of a failure here is a blank screen rather than a crash.

## When to Use

- a log level raised and nothing new appears
- log levels configured somewhere that turns out to have no effect
- `console` calls present while developing and gone from the build handed over
- a screen that comes up blank with no crash and no stack
- containing a throw so one bad screen does not take the app with it, or recovering afterwards
- an uncaught-exception handler that never fires, or fires and then behaves unexpectedly
- a crash stack that cannot be traced back to the TypeScript that produced it

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Getting logs **off** a device from a shell script or a CI job | The `cli-dev-loop` skill | This skill is about a line being emitted; collecting it afterwards is a different surface |
| Getting logs off a device, or decoding a stack, inside an agent session | The `mcp-ai-dev-loop` skill | Same distinction, reached through tool calls rather than a shell |
| What the running app costs in frames, memory or startup time | The `app-performance` skill | Instrumenting for cost is measurement, not reporting |
| Which Solid primitives `@roku-sdk/solid` exports at all | The `solid-on-roku` skill | This skill owns the failure, not the export surface |

## Read the reference first for this task

| If the request is | Read now, before answering |
|---|---|
| Writing or debugging a `setUncaughtExceptionHandler` callback | `references/uncaught-exceptions.md` |

The tables below say that the handler exists, what it never sees, and that registering one cannot
be undone. Its timeout, its inverted `done` flag and the conditions under which it silently does
nothing are only in the reference, and a handler written from the summary alone is wrong in ways
that do not show up until something throws in production.

## Quick Reference

| Question | Answer |
|---|---|
| Get a logger | `import { logger } from "@roku-sdk/rsg-ts"` — the root one; `logger.getLogger("myscreen")` for a child |
| Levels available | `trace`, `debug`, `info`, `warn`, `error`. There is no `fatal`, and `createLogger` is not exported |
| Why a message is a function | `logger.info(() => \`...\`)` — the thunk is only invoked once the level check passes, so a filtered line costs nothing to build |
| The two level knobs | `app.logger.baseLogLevel` **deletes** call sites at build time (default INFO in production builds); `app.logger.currentLogLevel` filters what remains at runtime (default ERROR; also enforced as a runtime backstop at the base level) |
| Which one to raise | Whichever is higher wins. Raising only `currentLogLevel` recovers nothing a lower `baseLogLevel` already deleted |
| Setting levels via `buildVariables` | A silent no-op — the build overwrites `__BASE_LOG_LEVEL__` and `__CURRENT_LOG_LEVEL__` itself |
| Contain a throw | `<ErrorBoundary fallback={…}>` around the subtree, from `@roku-sdk/solid` |
| Recover from one | `catchError` for a scoped throw, `resetErrorBoundaries` to retry every boundary |
| Blank screen, no crash, no stack | The SDK's own boundary caught a root-component throw. One `error` line under source `btstp` is the entire evidence |
| `console` in a shipped build | Dropped by `rk build`, kept by `rk dev`; `dropConsole: false` keeps them, and then `installConsolePolyfill()` restores the helpers |
| Trace a stack back to TypeScript | Call `enableExceptionTagging()` before the code that can throw. Inside `main()`, before the anchor node, covers throws after `main()`; a throw at module top level needs the call in the entry file's first import |
| An uncaught-exception handler | `setUncaughtExceptionHandler` — never sees an `ErrorBoundary` catch, sees nothing thrown before it registers, and registration is permanent |
| Where these live | `logger`, `main`, `enableExceptionTagging` and `setUncaughtExceptionHandler` all come from `@roku-sdk/rsg-ts`; `installConsolePolyfill` only from `@roku-sdk/native` |

## Instructions

1. **Log through the exported `logger`, and give each area a child.** `logger` is the root;
   `logger.getLogger("playback")` tags that area's lines. `createLogger` is deliberately module
   private, so a child logger is the only sanctioned way to get a distinct source.

2. **Pass a thunk, not a string.** Every method takes `() => string`. The level check runs first,
   so an interpolation inside the thunk is never paid for on a filtered line. Building the string
   at the call site throws that away.

3. **Understand which level does what, because only one of them can be undone.**
   - `baseLogLevel` is a **build-time** cut. Any statement calling a method below it is replaced
     with `void 0;` in the source before the bundler sees it, so the call is not in the artifact
     at all. Nothing at runtime can bring it back.
   - `currentLogLevel` is a **runtime** filter over whatever survived, resolved once at module
     load.

   So diagnose in that order: if a line is missing, ask whether it was deleted before asking
   whether it was filtered. The defaults are `INFO` for the base cut and `ERROR` for the runtime
   filter, which is why a `debug` line is absent from a default build twice over.

4. **Know what the build-time cut checks and what it does not.** It matches a whole expression
   statement whose call target is a log method (e.g. `.trace`, `.debug`) on a receiver that is
   recognised as an SDK logger binding in that file. Specifically, the receiver must be:
   - A named import of `logger` (or an aliased import) from one of the SDK logger modules
     (`@roku-sdk/rsg-ts` or `@roku-sdk/common`), or common's own relative `./logger` import.
   - A child logger derived from any of the above via `const X = logger.getLogger("area")`
     (and any further `.getLogger(…)` chains at module level).
   - An inline `logger.getLogger("a").debug(…)` call in statement position.

   Non-SDK receivers (`someLibrary.debug(…)`, `console.debug(…)`, `myEmitter.trace(…)`) are
   never removed. Shadowing is respected: when a local binding reuses the name — any parameter
   (constructor, accessor and destructured ones included), a `catch` binding, a loop variable, or
   a local declaration — calls through it are left untouched.

   One documented limitation: a logger exported from one module and re-imported under a
   *different* import path (not one of the recognised specifiers) is not recognised by the
   per-file pass and is not stripped at build time. The runtime backstop (see below) still
   silences it. The sanctioned pattern is: import `logger` from the SDK and derive children
   with `getLogger` in the same module.

   A second limitation: inside a function, only a child derived directly from a recognised SDK
   logger is stripped. A grandchild built from a function-local child — `const a =
   logger.getLogger("a"); const b = a.getLogger("b"); b.debug(…)`, or inline
   `a.getLogger("b").debug(…)` — is kept at build time. Like the case above, this only ever
   leaves a call in (never removes a non-SDK one), and the runtime backstop still silences it.
   Derive nested children at module level if you want them stripped.

   Child loggers must be declared with `const`. A `let` or `var` child
   (`let l = logger.getLogger("x")`) can be reassigned to some other object, so its calls are
   kept at build time rather than risk deleting app code. The runtime backstop still silences them.

   Only a bare statement is stripped. `const line = logger.debug(…)`, or a call guarded by
   `&&`, survives — so a log statement written in an unusual shape will not be stripped as
   expected.

5. **Set levels in `app.logger`, never in `buildVariables`.** The two keys the logger reads are
   `__BASE_LOG_LEVEL__` and `__CURRENT_LOG_LEVEL__`, and the build writes both itself —
   unconditionally, after copying your `buildVariables` — then restores them only from
   `app.logger`. So a value you put in `buildVariables` under either name is overwritten with an
   empty string, which the reader treats exactly like an unset variable. You get the defaults,
   with no warning that your setting was discarded.

6. **Wrap a subtree that can throw in `ErrorBoundary`, and draw something in the fallback.** The
   SDK already puts one boundary around the whole app, and its fallback returns nothing — so an
   uncontained throw in a root component is a blank screen rather than a crash. That is the SDK
   working as designed, not a missing feature. Your own boundary, closer to the risk, is what
   turns it into a message the user can act on.

7. **Recover with `catchError` or `resetErrorBoundaries`.** `catchError` handles a throw inside
   one computation without unmounting a subtree; `resetErrorBoundaries` re-runs every boundary's
   children, which is the "try again" button's implementation.

8. **Expect `console` to disappear from the build you hand over.** `rk build` drops `console.*`
   and `debugger`; `rk dev` keeps them. Set `dropConsole: false` when a build must keep them
   on purpose — and note the helper methods (`count`, `group`, `assert` and the timing pair) come
   from a polyfill that only auto-installs in a development build, so a production build that
   keeps `console` also needs `installConsolePolyfill()` from `@roku-sdk/native`. Plain
   `console.log`, `warn` and `error` are the runtime's own and are never wrapped. None of this
   replaces `logger`: `console` has no levels, no sources and no build-time cut.

9. **Call `enableExceptionTagging()` before the code that can throw**, when traces from this
   build have to be resolvable later. Inside `main()`, before registering the anchor node, covers
   throws from the `main()` callback onward. A throw while the bundle is still being evaluated
   needs the call in the same module the entry file imports first (step 10). It marks each trace
   with the build's source-map identity. It is idempotent, and calling it costs nothing at runtime
   beyond the tagging itself. Turning a captured stack back into TypeScript afterwards is
   `cli-dev-loop` from a shell and `mcp-ai-dev-loop` from a session — this step is only the app's half.

10. **Reach for `setUncaughtExceptionHandler` only for what a boundary cannot catch**, and read
    the reference before writing one. It replaces the SDK's default permanently, it never sees a
    throw an `ErrorBoundary` already caught, and it is not the mechanism behind the blank screen
    in step 6. It also misses anything thrown before it registers, and every module's top-level
    code runs before `main()` is called. When a module can throw at its top level, register in
    the entry file's first import rather than inside `main()`.

## Render-thread transaction errors

On firmware with `roku.Transaction.setErrorCallback`, SDK `main()` installs a default
error-level logger under source `tx` before declaring app components. It reports each
render-thread transaction error with its reason, message and available operation, node ID
and property name. These asynchronous errors do not throw through `ErrorBoundary` or the
uncaught-exception handler. Apps calling `roku.Transaction.setErrorCallback` themselves
replace this default; accessors are valid only during that callback. Older firmware without
the callback API is unchanged and cannot surface these errors through this SDK handler.

## Example

An app entry point that tags its traces, and a screen that contains its own failures instead of
letting the SDK's blank fallback have them.

```tsx rsg-skill=complete
import { Label, LayoutGroup } from "@roku-sdk/components";
import { type AnchorNodeImplementation, defineAnchorNode, FieldType, logger } from "@roku-sdk/rsg-ts";
import { ErrorBoundary } from "@roku-sdk/solid";

const screenLog = logger.getLogger("playback");

const PlaybackScreenDescription = {
    componentName: "PlaybackScreen",
    extends: "Group" as const,
    inputFields: {
        assetId: FieldType.String("")
    },
    outputFields: {}
};

function NowPlaying(props: { assetId: string }) {
    // The thunk is only invoked once the level check passes.
    screenLog.info(() => `rendering asset ${props.assetId}`);
    return <label text={props.assetId} width={800} height={48} color="0xFFFFFFFF" />;
}

const PlaybackScreen: AnchorNodeImplementation<typeof PlaybackScreenDescription> = inputs => (
    <layoutGroup layoutDirection="vert">
        <ErrorBoundary
            fallback={error => {
                // Without a fallback that draws, this subtree is simply absent.
                screenLog.error(() => `playback failed: ${error.message}`);
                return <label text="Playback unavailable" width={800} height={48} color="0xFF6666FF" />;
            }}
        >
            <NowPlaying assetId={inputs.assetId ?? ""} />
        </ErrorBoundary>
    </layoutGroup>
);

export default defineAnchorNode(PlaybackScreenDescription, PlaybackScreen);
```

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| A level was raised, the app rebuilt, and the lines are still missing | `baseLogLevel` deleted the call sites; raising the runtime filter cannot restore a call that is not in the artifact | Raise `app.logger.baseLogLevel` and rebuild |
| Levels set through `buildVariables` change nothing, and nothing warns | The build overwrites `__BASE_LOG_LEVEL__` and `__CURRENT_LOG_LEVEL__` with an empty string before restoring them from `app.logger` | Set them in `app.logger` |
| A screen is blank, the app is still running, and there is no stack | A root component threw and the SDK's own boundary caught it; its fallback draws nothing | Search the log for source `btstp`; add your own `ErrorBoundary` closer to the risk |
| An `ErrorBoundary` was added and the screen is still blank | The `fallback` returns nothing, or the boundary sits above the component that throws rather than around it | Return a real node from `fallback`; put the boundary around the risky subtree |
| An uncaught-exception handler never fires for a render-time throw | A boundary caught it first, and the handler only sees what nothing caught | Handle it in the boundary; keep the handler for what escapes |
| The app exits from the splash screen, and the handler never fires | A module threw at its top level while the bundle was evaluated, before the handler was registered inside `main()` | Register in a module the entry file imports first, as a bare `import "./…"` |
| A registered handler cannot be swapped back to the SDK default | Registration replaces the default permanently, by design | Register once, at startup, and branch inside your own handler |
| A handler was registered and does nothing at all, silently | `globalThis.Process` was unavailable, so the call warned and returned — and at the default runtime filter that warning is itself invisible | Read the reference; confirm the handler registers where the runtime provides it |
| Diagnostics print in development and are gone from the shipped build | `rk build` drops `console.*` by default | Use `logger`, or set `dropConsole: false` deliberately |
| `console` timing and grouping helpers are missing in a build that kept `console` | The polyfill auto-installs only in a development build | Call `installConsolePolyfill()` from `@roku-sdk/native` |
| A captured stack cannot be matched to a build | The app never tagged its traces, or tagged them inside `main()` after a module had already thrown | Call `enableExceptionTagging()` before that code. Inside `main()` covers throws after it; a module top-level throw needs the call in the entry file's first import |

`Logger`, `setUncaughtExceptionHandler` and `ErrorBoundary` are typed with TSDoc in the installed
packages. Read an option there rather than guessing its name, and prefer it over any prose,
including this file, when the two disagree.
