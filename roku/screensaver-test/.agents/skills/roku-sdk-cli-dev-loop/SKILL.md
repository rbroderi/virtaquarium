---
name: roku-sdk-cli-dev-loop
description: "Use when an RSG SDK TypeScript app has to be built, installed, driven and observed from a shell script or a CI job, with no agent session in it — rk build and rk dev writing to different directories while rk dev --no-build reads only one of them, rk start-dev and top-level rk sideload surviving as deprecated aliases, there being no rk deploy, a dev build with no Roku on hand, which commands refuse to run without rk server, a flag one build command accepts and the other rejects, flags rejected as the wrong half of --no-build or --no-sideload, sending remote keys or capturing the screen from a script, and collecting device logs or decoding a crash stack once the run is over. Not for an agent session whose MCP tools already answer — that is the mcp-ai-dev-loop skill, which reaches the same operations through tool calls; not for what the running app costs in frames, memory or startup time, which is app-performance; and not for registering a Roku or choosing which one commands reach, which is device-management."
# @roku-sdk/ai managed v=1 hash=c04cd38dfc3faf6bb856fce9d0c1fb1100441f792792aec40161655689ba3910 skills=1 do-not-edit
---

# CLI Dev Loop

## Overview

This is the build-install-drive-observe loop run from a shell rather than from an agent session:
the same operations the MCP tools expose, reached through `rk` directly, which is what a script
or a CI job needs.

**The normal way to get a channel onto a device is `rk dev`.** With no flags it builds and
sideloads a debug build in one step; everything else in this loop is a variation on it. Reach for
`rk dev` first; do not hand-assemble a package or improvise an install path.

Two things about the loop surprise people. The two build commands write to different
directories and the install command reads only one of them, so the obvious pairing installs the
wrong thing. And most commands run in process while a few refuse without a server, which turns a
working local command into a failing CI step.

## When to Use

- a shell script or CI job that has to build an RSG SDK TypeScript app and get it onto a Roku
- an install that keeps landing an older build than the one just produced
- sending remote keys, capturing the screen or reading the node tree with no agent involved
- collecting what the app printed on the device, from a job nobody is watching
- turning a crash stack back into TypeScript after the run is over
- a flag one of the two build commands accepts and the other rejects

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| An agent session whose Roku tools already answer | The `mcp-ai-dev-loop` skill | Same loop, different surface: those tools carry their own arguments and their own failure modes |
| A session with no Roku tools in it at all | The `mcp-setup` skill | Nothing here is the reason an editor lists no tools |
| What the running app *costs* — dropped frames, slow start, memory | The `app-performance` skill | These commands report what the app did, not what it spent doing it |
| Registering a Roku, its password, or which one is targeted | The `device-management` skill | Everything here assumes a target already resolves |
| Signing an app, publishing it, or clearing what is installed | The `app-packaging` skill | Those act on an artifact once this loop has produced one |
| Writing the app's code, or the project's own configuration | The `sdk-components` and `project-setup` skills | This loop starts once there is something to run |

## Read the reference first for these tasks

| If the request is | Read now, before answering |
|---|---|
| Collecting device logs from a script, or decoding a crash stack outside an agent session | `references/logs-and-crashes.md` |

Both are commands whose shell spelling has options the tool surface does not, and `rk logs` is
one of the few things here that will not run without a server.

## BrightScript-only channels

A traditional BrightScript/XML app can set `app.brsOnly: true` in
`roku-config.cjs`. Run `rk build --local` or `rk dev --local`: no tsconfig,
JavaScript bundle or Hermes bytecode is needed, and stale `ts_path` entries
are removed. `--no-write-ts-path` alone does not skip bundling. Keep `--local`
for build/dev until server project discovery supports non-TS configs. Sideload
and package defaults discover `.ts`, `.cjs`, `.js` and `.mjs`. `entryPoint` is
optional with `brsOnly`, and `--compile-ts` warns that it is ignored. Pipeline
plugins anchored to TS build slots are unsupported. Root assets are limited to the native
channel directories; use `app.staticAssetsDir` for a separate curated channel
tree. The output/install pairing below is unchanged.

## Quick Reference

| Goal | Do |
|---|---|
| **Put a channel on a device (the normal sideload path)** | **`rk dev` — builds and sideloads in one step** |
| Production build (artifact only) | `rk build` — writes `dist-build` |
| Dev build and install together | `rk dev` — writes `dist-dev` |
| Install something already built | `rk dev --no-build` — reads `<out-dir>/pkg-dir`, defaulting to `dist-dev` |
| Dev build with no device on the network | `rk dev --no-sideload` — writes `dist-dev`, installs nothing |
| Press one key | `rk ecp keypress <Key>` |
| Press a whole path | `rk keysequence Down Down Select` |
| Capture the screen | `rk ecp capture-screen -o shot.png` |
| Read the live node tree | `rk ecp query/app-ui --json` |
| Hand the app launch parameters | `rk ecp input --json '<json>'` |
| Device logs | `rk logs start`, then `get`, `search` or `tail` — needs a server |
| A crash stack back to TypeScript | `rk decode-stack` |
| Fresh-checkout `type-check` / XML JSX types without a build | `rk gen-types` — writes gitignored `.xml.d.ts`; app scripts usually run it before `tsc` |
| Frames from a Dynamic Component Library left unresolved | add `--dcl-dir <libName>=<dir>` — one per library |
| Start a stopped cloud device and build while it boots | `rk dev --start --device rce:<name>` — then `rk device stop rce:<name>` |

## Instructions

1. **The two build commands write to different directories, and a no-build install reads only
   one.** `rk build` writes `dist-build`; `rk dev` writes `dist-dev`; `rk dev --no-build` reads
   `<out-dir>/pkg-dir`, which defaults to `dist-dev`. So `rk build` followed by a bare
   `rk dev --no-build` still installs out of `dist-dev`. It no longer does so silently: when a
   newer `pkg-dir` sits in the other directory, the command says which artifact it is installing,
   which one is newer, and the flag that switches — and when the directory is empty it names a
   command that can actually create it. Pass `--out-dir` matching the build, or let `rk dev` do
   both steps.

   A project that sets `outDir` in `roku-config.ts` sidesteps this entirely: the install path now
   loads project config the way `rk build` and `rk dev` do, so both halves agree by construction.
   An `outDir` that came from config or a flag is treated as deliberate and draws no warning.

2. **One command puts an app on a box: `rk dev`.** With no flags it builds and installs; with
   `--no-build` it installs what already exists. There is no `rk deploy`, no `rk install` and no
   `rk push` — the CLI rejects an unknown command rather than guessing, so a script written
   against a remembered name fails on its first line.

   Two older spellings still work and print the replacement on stderr: `rk start-dev` is now
   `rk dev`, and the top-level `rk sideload` is now `rk dev --no-build`. Both are deprecated and
   will be removed; `rk sideload`'s own options are unchanged in the meantime.

   `--no-build` rejects every option that only shapes a build — `--watch`, `--debug`,
   `--inspect`, `--inspect-persist`, `--drop-console`, `--drop-debugger`, `--solid-dev-mode`,
   `--no-write-ts-path`, `--no-typecheck`, `--build-type` and the `--perfetto-*` set —
   rather than accepting and ignoring them. Device targeting (`--device`, `--host`, `--password`,
   `--dap-debug`) and launch options (`--launch-params`, `--no-launch`, `--console`) still apply.

   `--no-sideload` is the inverse: it builds and stops before the sideload, so it rejects the
   device-facing set instead (`--device`, `--host`, `--password`, `--dap-debug`,
   `--launch-params`, `--no-launch`, `--console`, `--auto-console-close`) and keeps every build
   option, `--watch` included. The two are opposites and cannot be combined.

3. **A dev build that needs no Roku at all is `rk dev --no-sideload`.** This is the one worth
   knowing for CI: plain `rk dev` resolves a device *before* it builds and exits non-zero when
   none is active and no password is stored, so a job that only wants to prove the dev bundle
   compiles fails on infrastructure it does not need. `--no-sideload` never reaches that step.
   Output still lands in `dist-dev` unless `--out-dir` moves it, and the artifact is what a
   normal `rk dev` would have installed. For a *production* package it is still `rk build`.
   The other way round, a build that compiles but never reaches the box fails the step: without
   `--watch`, `rk dev` exits 1 with `SIDELOAD_FAILED` when the install failed, and with
   `LAUNCH_FAILED` when the app installed but did not launch — the box then holds the new build,
   and `rk dev --no-build` retries without rebuilding.

4. **A few commands need a server; most do not.** `build`, `dev`, `device`, `package`,
   `dcl` and `perfetto` try a running server first and fall back to an in-process
   path, so they work either way; `--local` skips the discovery and is accepted by exactly those
   six. `rk logs` and `rk cdp` have no in-process path and refuse when no server is running,
   which is why a log step that works on a laptop with an editor open fails in CI. Start
   `rk server` in the job first. The one exception is a cloud device's firmware log,
   `rk logs tail --source firmware`, which runs in process.

5. **Flags do not carry between the two build commands.** `--metafile` belongs to `rk build`
   alone. `--watch` is not compatible with `--archive`, and `--output`, `--bump-minor` and
   `--bump-build` mean nothing without it. Both `rk build` and `rk dev` accept `--drop-console` and `--drop-debugger`.

6. **`--inspect-persist` outlives the run that set it.** Every later launch waits for a debugger
   until the app is reinstalled *without* the flag, so a box left in that state looks hung. It
   also needs firmware 16.0 or later; on anything earlier the field is ignored during sideload
   and nothing persists.

7. **`--auto-console-close` is turned off unless `--console` is set.** Nothing warns about it —
   the flag is simply cleared, so on its own it has no effect at all.

8. **`ecp input --json` takes a JSON string, not a boolean.** Almost everywhere else in the CLI
   `--json` is a switch that changes the output format; on this one subcommand it carries the
   payload.

9. **Key arguments take the wire name, not the runtime one.** `Select` (not `OK`), `Rev` (not
   `rewind`), `Fwd` (not `fastforward`), `Info` (not `options`). The two vocabularies are
   inverted for exactly these four: the name a script passes to `rk ecp` is the enum member,
   while the string the firmware delivers to `onKey` is the other one. A key is validated
   before anything is sent, so a wrong name fails the command outright rather than pressing
   nothing.

11. **A Roku Cloud Emulator device is billed while it runs, and a job has to stop what it
   starts.** Nothing in the loop starts a stopped one on its
   own: every command that needs it fails with `RCE_DEVICE_NOT_RUNNING` until `rk device start` or
   `rk dev --start` does. Plain `rk dev --start` leaves the device running when it exits — only
   with `--watch`, or `--console` without `--auto-console-close`, does it stop the device on the
   way out — so end the job with
   `rk device stop`, from a `trap` so a failed step still reaches it. A run this machine did not
   start asks for confirmation before stopping, and refuses without `--yes` when there is no
   terminal to ask on. The run is also capped by its maximum runtime — `--max-runtime` on
   `rk dev --start` or `rk device start`, else the registration's, else an hour — but billing can
   outlast the cap by minutes. In CI give the
   job its token through `RK_RCE_TOKEN`. Interrupted while still holding a device they started,
   `rk dev` and `rk device start` stop it and exit 130 (143 on `SIGTERM`), so a step the runner
   cancelled does not read as an ordinary failure.
   The device and its registration are the `device-management` skill's subject.

## Example

A CI step that builds, installs the artifact it just built, drives the app to a known screen and
captures evidence — with the server started because the log step needs one.

```bash
rk server start --daemon

rk build --out-dir dist-ci
rk dev --no-build --out-dir dist-ci --device ci-box

rk logs start --device ci-box
rk keysequence Down Down Select --device ci-box
rk ecp capture-screen -o evidence.png --device ci-box
rk logs get --lines 500 --output run.log --device ci-box
```

Both `--out-dir` values have to agree. Dropping it from just the install line is the failure in
instruction 1: it would install from `dist-dev`, which this job never wrote. That case now fails
with an error naming `dist-ci` as the directory that does hold a `pkg-dir`, rather than
succeeding against a stale one.

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| The device runs an older build after a green build step | The install read `dist-dev` while `build` wrote `dist-build` | Give both the same `--out-dir`, or use `rk dev`. The install now warns when a newer build sits elsewhere |
| A script fails on its very first command | It was written against a `deploy` subcommand that does not exist | `rk dev` to build and install, `rk dev --no-build` to install |
| `[deprecated]` on stderr from a working command | `rk start-dev` and top-level `rk sideload` are aliases now | `rk dev` and `rk dev --no-build` |
| The log command works locally and refuses in CI | `rk logs` is server-mode only | `rk server start --daemon` earlier in the job |
| `--metafile` rejected | It belongs to `rk build` | Move the analysis to the production build |
| `--watch` and `--package` together do nothing sensible | They are not compatible | Watch while developing, package when releasing |
| A build flag rejected next to `--no-build` | There is no build for it to shape | Drop the flag, or drop `--no-build` to build too |
| A CI job that only compiles fails on "no active device" | Plain `rk dev` resolves a device before it builds | `rk dev --no-sideload` — it contacts nothing |
| `--host` or `--console` rejected next to `--no-sideload` | No device is contacted, so they would be ignored | Drop the flag, or drop `--no-sideload` to install too |
| Every launch hangs waiting for a debugger | `--inspect-persist` is still set on the box | Reinstall without the flag |
| `--inspect-persist` appears to do nothing | Firmware is older than 16.0 | Nothing persists there; use `--inspect` per run |
| `--auto-console-close` has no effect | It is cleared unless `--console` is set | Pass `--console` as well |
| `ecp input --json` rejects a bare `true` | Here the option carries a JSON string | Pass the payload, quoted |
| The app's own frames decode but a Dynamic Component Library's do not | A DCL is built separately, so its maps are not under the app's build directory | `--dcl-dir <libName>=<dir>`, naming the library — a bare path is rejected |
| `rk dev` fails with `LAUNCH_FAILED` after a green build | The app installed, but launching it failed; the reason is printed above the error | Fix what the reason names, then `rk dev --no-build` to install and launch the same build without rebuilding |
| A finished CI job left a cloud device running, and billing | `rk dev --start` stops it only while `--watch`, or `--console` without `--auto-console-close`, keeps it running | `trap 'rk device stop rce:<name> --yes' EXIT` before the start |
| `rk ecp capture-screen` fails with `SCREENSHOT_NOT_OK` on a cloud or secure retail device | It captures through the installer, which works only while the sideloaded app is in front | Install or relaunch the app, then capture; `Home` breaks it as well |
| `rk ecp capture-screen` on a LAN device fails with `ECP_ENDPOINT_NOT_FOUND`, naming an auth token | A secure device, every retail Roku among them, serves no ECP capture without a Roku-issued token, and no developer password was at hand for the installer fallback | `rk device update <device> --password <password>` once, then capture again |
| Every capture after some point in a key sequence shows the wrong thing, or the same thing | `Home` was sent expecting the app's own home screen — the remote's `Home` exits to the Roku home screen, and every capture after it is of that | Move within the app with `Back`; install again to relaunch one that was exited |
