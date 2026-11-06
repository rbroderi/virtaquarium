<!-- @roku-sdk/ai managed v=1 hash=bf84f07580a3cbccceab21a47af5f6723a3098c5da347ea1440c90c5b52113fe skills=1 do-not-edit -->

# Uncaught exceptions

`setUncaughtExceptionHandler` is the only hook for a throw that nothing in the app caught. It is a
narrow API with four behaviours that are not guessable from its signature, each of which produces
a handler that looks correct and is not.

## What it does and does not see

It is registered against the runtime's uncaught-exception capture callback. That means:

- **Nothing thrown before the call reaches it.** Until `setUncaughtExceptionHandler` runs, only
  the SDK's default handles a throw: it logs the error and `source_map_sha`, then the app exits.
  The whole bundle is evaluated before `main()` is called. Each module's top-level code runs in
  import order, and a module's imports run before its own body. So a handler registered inside
  `main()` is too late for a module whose top level throws, such as a constant initialized from
  a configuration read that fails. To cover that, register in a module of its own, and make it
  the entry file's first import: `import "./install-exception-reporting";`. Keep it a bare
  side-effect import. Import sorting keeps side-effect imports first and in the order written,
  but sorts named imports alphabetically, which can move the handler below the module that
  throws.
- **An `ErrorBoundary` catch never reaches it.** A boundary handles the throw, so as far as the
  runtime is concerned nothing escaped. Since the SDK wraps the whole app in a boundary already,
  a render-time throw is caught before this handler is a possibility. If you want a monitoring
  service to hear about render failures, report them from the boundary's `fallback`.
- **Unhandled promise rejections never reach it.** They go to a separate runtime callback, which
  the SDK sets to log the rejection at `error` and stop there. `setUncaughtExceptionHandler` does
  not forward rejections. To act on one, register your own callback with
  `globalThis.Process.setUnhandledRejectionCallback`, which replaces the SDK's logging.

So the handler's actual scope is small. It covers a throw that happens after registration and
outside any boundary and the reactive render path: module-level work in modules evaluated after
it, the `main()` callback, a timer, a callback the SDK invoked directly, a listener.

## The handler's contract

```ts
setUncaughtExceptionHandler(
    async error => {
        // error: Error. The only argument; the returned Promise is awaited.
    },
    { timeout: 5000, resume: false }
);
```

| Element | Behaviour |
|---|---|
| `error` | The only argument. Never null: if the runtime hands over a falsy error, the SDK synthesizes one with the message `Uncaught exception (no error object provided)`, so reading `.message` or `.stack` is always safe. With `enableExceptionTagging()` active, `error.stack` ends in `[SourceMap: <sha>]`, the build's source-map identity. Send the stack as is, or it cannot be resolved later |
| Return value | A Promise. The SDK awaits it for up to `timeout`, then tells the runtime to exit or resume |
| `timeout` | Milliseconds the returned Promise is awaited for. Default **5000**, floor **100** — a smaller value is raised to the floor rather than rejected |
| `resume` | Chooses what happens after. Default `false` |

There is no `sha` argument and no `done` argument. A handler written as `(error, sha, done)` does
not typecheck. The SDK logs the error message and `source_map_sha` itself, before your handler
runs, and registering a handler does not suppress that line. The SDK also calls the runtime's
`done` callback for you.

## The `done` flag is inverted relative to `resume`

This is the single easiest thing to get backwards, because the two names read as synonyms and
mean opposites:

| You pass | The SDK calls | The app |
|---|---|---|
| nothing, or `resume: false` | `done(true)` | exits |
| `resume: true` | `done(false)` | resumes its event loop |

`done(true)` means "yes, we are finished — exit", not "yes, the handler succeeded". Passing
`resume: true` to keep an app alive through a background failure is legitimate, but understand
that the app then continues from a state something already failed in.

Both outcomes are unconditional: whether your handler resolves, rejects, or runs out its timeout,
`done` is invoked with the flag chosen by `resume`. There is no path in which a failing handler
changes the exit decision.

## Registration is permanent

Calling `setUncaughtExceptionHandler` replaces the currently registered handler, including the
SDK's default. Only the last registration is active, and **there is no way to restore the SDK
default afterwards** — no unregister, no argument that means "back to normal".

The consequence for structure: register once, before anything can throw, and branch inside your own handler
rather than swapping handlers per screen. A test that registers one has no clean way to undo it,
which is why the module keeps an internal reset that is explicitly test-only and not exported for
application use.

## It can silently do nothing

If `globalThis.Process` is unavailable when you call it, the function logs at `warn` and returns
without registering anything. Two things make that hard to notice:

- Nothing throws and nothing returns a failure — the call looks like it worked.
- The default runtime log filter is `ERROR`, so the `warn` line explaining what happened is
  itself filtered out.

If a handler appears to be registered and never fires, distinguish this case from the
`ErrorBoundary` case by lowering `currentLogLevel` to `WARN` and looking for that line before
concluding the handler is wired up wrong.

## Shape to copy

A module of its own, `src/install-exception-reporting.ts`, that registers as it is evaluated:

```ts rsg-skill=complete
import { enableExceptionTagging, setUncaughtExceptionHandler } from "@roku-sdk/rsg-ts";

enableExceptionTagging();

setUncaughtExceptionHandler(
    async error => {
        await fetch("https://monitoring.example.com/exceptions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: error.name, message: error.message, stack: error.stack })
        });
    },
    { timeout: 2000 }
);
```

The entry file imports it before anything else:

```ts
import "./install-exception-reporting";

import { main, registerAnchorNode } from "@roku-sdk/rsg-ts";

import MyApp from "./my-app";

main(() => registerAnchorNode(MyApp));
```

`enableExceptionTagging()` comes first, so a trace captured by the handler is already tagged.
The handler has nothing to call when it is done: the SDK finishes once the Promise settles or
2000 ms elapse, whichever comes first. Omitting `resume` means the app exits afterwards, which
is what you want unless you have a specific reason to keep running. It is also the only sensible
choice for a throw during boot, because there is nothing to resume into: the throwing module
never finished, and `main()` never registered the app.
