<!-- @roku-sdk/ai managed v=1 hash=e74fcc33c0eeb586664b89a7d046f9efba75b93efe85eca07e00a419abf0d961 skills=1 do-not-edit -->

# Crashes and console output

A thrown error reaches you by one of two routes, and which one you have decides how much work
is left.

## Route 1: a live debug session, where the stacks arrive decoded

`cdp_session_create` builds the app in debug mode, deploys it, loads the source map and
connects. With a session up:

- `cdp_errors_read` returns the exceptions the app has thrown, **with their stacks already
  mapped back to TypeScript**. Nothing else to do.
- `cdp_console_read` returns console output, so a `console.log` added to narrow something down
  is readable without starting a log session at all.
- `cdp_console_clear_errors` and `cdp_console_clear_console` empty those buffers. Clear before
  reproducing, and what you read afterwards is only what this attempt produced.

One session per device. Redeploying through `cdp_session_update` clears both buffers as part
of the update, so read what you need *before* you redeploy, not after.

This route is strictly better than searching a log buffer when you can have it: the stack
comes back resolved, and console output is separated from every other line the device emits.

## Route 2: the log stream, where the stack arrives raw

Without a session, an uncaught exception is written to the device log along with a
`source_map_sha=` line naming the build it came from. That is what `logs` gives you, and the
stack in it contains bundle positions rather than TypeScript positions: `index.js` for plain
`rk dev`, or `index.hbc` for a build using `--compile-ts`.

Hand the whole thing to `decode_stack_trace`. Do not try to read it, and do not open a source
map yourself: JS frames need the ESBuild map; bytecode frames need a composed map or the
Hermes and ESBuild maps.

## Getting the decode right

`stackTrace` is the only required parameter. Paste the raw text — surrounding log noise is
fine, since only `index.hbc` and `index.js` frames are read — and the tool finds the build's
SHA in the `source_map_sha=` or `[SourceMap: ...]` marker the runtime emitted.

The other four parameters are the difference between a decode you can trust and one that
merely succeeds:

| Parameter | When you need it |
|---|---|
| `buildDir` | When the app is not at the root the server is running from. Resolution is anchored at that root, so in a monorepo an app in a subdirectory reports `No HBC source map found` for every frame until you pass this — point it at the build's `bundle` directory |
| `sha` | When the trace has no marker, or you are deliberately decoding against an older build |
| `context` | Lines of source shown around each frame; defaults to 2 |
| `dclDirs` | When frames name a Dynamic Component Library rather than `index` — map each library name to its own build directory |

**The failure to watch for**: a `sha` that names a directory which does not exist does not
error. It falls back to auto-detection and decodes against whatever build is newest locally,
which produces a confident answer pointing at the wrong line. If a decoded frame does not
match the code you think ran, suspect this before suspecting the frame.

Source maps never leave your machine — only the JavaScript bundle (or bytecode with `--compile-ts`) is on the device — so a decode
is only as good as the build directory still sitting in your working tree. Decode before you
rebuild.

## Tagging exceptions

`enableExceptionTagging()` appends a `[SourceMap: <sha>]` marker to every `Error.stack`, which
is what makes an error caught and logged by the app's own code decodable later. It is opt-in
and idempotent.

Uncaught exceptions do not need it: the runtime logs the SHA line for those on its own. Turn it
on when the app catches errors and reports them itself — that is the case where the stack
reaches your log without the runtime's marker attached.
