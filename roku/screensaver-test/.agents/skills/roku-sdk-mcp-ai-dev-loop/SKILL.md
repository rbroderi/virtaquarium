---
name: roku-sdk-mcp-ai-dev-loop
description: "Use when an RSG SDK TypeScript app has to be built, deployed, driven or diagnosed on a real Roku through the SDK's MCP server — sideloading a build and knowing which directory it came from, a device still running older code than the source after a tool built and installed it, capturing what is on screen, reading the rendered node tree, sending remote keys, collecting device logs, turning a crash stack back into TypeScript source, asking from inside a working session whether the server those tools depend on is up, a tool call that answered from the wrong Roku because of the target it was given, or starting and stopping a billed Roku Cloud Emulator device with device_start and device_stop. Not for the Roku developer web interface, not for debugging a web or mobile app, and not for a shell script or CI job with no agent in it, which is the cli-dev-loop skill."
# @roku-sdk/ai managed v=1 hash=f2f26d33a7a76ed39a0bd0a7e300c3383003858b7f042d537f3cf8538ce4673b skills=1 do-not-edit
---

# MCP AI Dev Loop

## Overview

The SDK ships an MCP server, and it is how an agent reaches a Roku: put the current code on
the device, see what it did, drive it, read what it said, and turn a crash back into
TypeScript. Everything below is one of those five steps. The server exposes far more tools
than this skill names — the surface grows — so enumerate what the server offers and match it
to the step you are on, rather than trusting any list, including this one.

## Read the reference first for these tasks

| If the request is | Read now, before answering |
|---|---|
| A crash, an uncaught exception, a stack trace, or console output from the device | `references/crash-and-console.md` |
| Setting a breakpoint, pausing the app, or reading values in a paused frame | `references/live-debugging.md` |

Decoding is the step with the most ways to look finished and be wrong — a stack decoded
against the wrong build reads perfectly and points at the wrong line.

A debug session also breakpoints and steps, which is worth knowing before you reach for a
`console.log` and a redeploy. One rule governs it and costs a rebuild to learn the hard way:
`cdp_eval` evaluates in the running app, but the first debugger tool of any kind — arming a
breakpoint included — disables it for the rest of that connection, and only a new session
brings it back. Read whatever you can with `cdp_eval` first. A session that has spent it is
not stuck, though: `cdp_debugger_eval_frame` reads values in a stopped frame's own scope for
that session's whole life, and the reference is how you reach a frame worth reading.

## When to Use

- deploying an app under development to a device and confirming what landed
- capturing the screen, or reading the rendered node tree, of a running app
- sending remote keys to walk the app somewhere without touching hardware
- collecting device logs, or finding a line in them
- a device the tools cannot see, or a deploy that lands stale code

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| No Roku tools in the session at all, or a client that will not connect | The `mcp-setup` skill | That is transport and editor config; everything here assumes a session that already lists tools |
| A shell script, a CI step, or anything with no agent in it | The `cli-dev-loop` skill | These tools exist inside an agent session; a build runner has to call `rk` itself, and the CLI's directories and flags differ from what the tools expose |
| Registering a Roku with the CLI, or which box a *shell* command reaches | The `device-management` skill | A tool call names its own target, so a tool that answered the wrong box is fixed here; the CLI's stored list is fixed there |
| Installing a signed package through the device's developer web page | Roku's own documentation | That is a browser workflow, and nothing here drives it |
| Debugging a web, mobile or desktop app | That platform's tooling | The tools here speak to a Roku and nothing else |
| Writing the app's code or its project configuration | The `sdk-components` and `project-setup` skills | This skill starts once there is something to run |
| Testing a component without a device | The `testing` skill | That renders into an in-process tree; nothing here is involved |
| An app that janks, drops frames, or grows its memory, and the question is what it costs | The `app-performance` skill | These tools report what the app did, not how long it took to do it |

## Quick Reference

| Step | Call | Notes |
|---|---|---|
| Find the device | `list_devices` | Always first. Nothing else can target sensibly until you know what is registered and which is active |
| Register one | `add_device`, then `activate_device` | Needed once per device; `update_default_auth` sets the password used for sideloading |
| Build and deploy | `deploy_app` | Builds **and** sideloads in one call. This is the normal way to get code onto a device |
| Build only | `build_app` | Produces an artifact without touching the device |
| Sideload an existing artifact | `sideload_app` | Does not build. Reads the directory you point it at |
| See the screen | `capture_screen` | Returns an image, and writes a file |
| Read the node tree | `ecp` with `command: "query/app-ui"` | The rendered tree of the running app, as JSON |
| Read device facts | `ecp` with `command: "query/device-info"` | Model, firmware, resolution; an SDK app needs `software-version` 16.0 or later |
| Press a key | `ecp` with `command: "keypress"` | One key |
| Press several | `ecp` with `command: "keysequence"` | One call for a whole path through the UI. Prefer it over a run of single presses |
| Name a key for either of those | The **wire** name, not the runtime one | `Select` (not `OK`), `Rev` (not `rewind`), `Fwd` (not `fastforward`), `Info` (not `options`). Every element is validated before anything reaches the device, so one wrong name fails the whole call with `ECP_INVALID_KEY` |
| Deep-link | `ecp` with `command: "input"` | Launch parameters, without navigating there by hand |
| Collect logs | `logs` — `start`, then `get` or `search` | A session must exist before there is anything to read |
| Decode a crash | `decode_stack_trace` | `references/crash-and-console.md` |
| Confirm the server is up | `get_server_health` | The fastest way to tell whether `rk server` is running, which decides what the rest of the surface can do |
| Start or stop a cloud device | `device_start`, `device_stop` | Roku Cloud Emulator only, billed while it runs. The server stops what it started; see instruction 11 |

## Instructions

1. **`list_devices` first, every session.** It returns what is registered and which one is
   active, and every other tool's targeting is defined against that. Without a device the
   failure arrives several steps later, worded as though the app were at fault.

2. **Target with `device` or with `host`, never both.** `device` selects a registered device
   by id, IP or name; `host` addresses one directly and skips the store. Passing both is an
   error. Passing neither uses the active device, and if none is active the tool says so.
   The targeting parameters are not uniform, though — `capture_screen` takes `device` and not
   `host`, so a screenshot needs the device to be in the store even when a deploy to the same
   box by `host` has just worked. Read the schema of the tool you are calling rather than
   assuming this one. A Roku Cloud Emulator device is named `rce:<name>` in `device`; it has
   no address, so `host` can never reach it.

3. **Deploy with `deploy_app` and stop there.** It builds and sideloads in one call, into
   `dist-dev`. Since `sideload_app` reads `dist-dev` too, following a deploy with a sideload
   only re-sends what was just sent; reach for `sideload_app` when you have an artifact and no
   reason to rebuild, not as a second half of deploying.

4. **The two directories are the one thing to keep straight.** `deploy_app` writes and reads
   `dist-dev`. `build_app` writes `dist-build`. `sideload_app` reads `dist-dev` unless you
   pass `outDir`. So `build_app` followed by a bare `sideload_app` is the pairing that sends
   stale code, or fails outright when `dist-dev` was never built: pass
   `outDir: "dist-build"` to match them, or use `deploy_app` and think about neither.

   That pairing now reports itself rather than passing silently. A bare `sideload_app` whose
   `dist-dev` is older than `dist-build` returns a warning naming both paths, their build
   times, and the `outDir` to pass — it still sends the artifact you asked for, so read the
   warning rather than assuming the newer one went. When the directory holds nothing at all,
   the error names a command that could have created it and reports where a `pkg-dir` was
   actually found. A project that sets `outDir` in `roku-config.ts` avoids the split entirely:
   the sideload path reads project config, so an `outDir` from config or from the parameter is
   treated as deliberate and draws no warning. Sideloading Hermes bytecode (`index.hbc`) also
   returns a warning, since a device without the `rsg_typescript` token refuses to launch it, and so does
   installing to a device older than Roku OS 16.0, naming the version it runs.

5. **Never reach the device's network endpoints yourself.** No `curl`, no hand-built request
   to a device port. The tools carry the device's password, retry sensibly and report failure
   in a way you can act on; a raw request does none of that and its silence looks like success.

6. **Look before you conclude.** `capture_screen` says what a person would see;
   `ecp` with `query/app-ui` says what the app actually built. They answer different questions
   and disagree in the interesting cases — a node present in the tree but invisible on screen
   is a layout or a colour bug, not a rendering one.

7. **Screenshot pixels are not layout coordinates.** The app lays out in design space, usually
   1920×1080; `capture_screen` returns the device's own resolution, which is 1280×720 on an HD
   box. Multiply by 1.5 going from a measured screenshot pixel to a coordinate in the code, and
   report positions back to a human in design space. Confirm both ends before you rely on the
   ratio: the design space is the app's `ui_resolutions`, and the device's output is the
   `ui-resolution` field of `query/device-info`. On a device already in FHD they match 1:1.
   A frame from the installer rather than ECP (`source: "installer"`, always on a Roku Cloud
   Emulator device and on a secure retail device without an ECP token) is the exception to
   reading the ratio off the device: its size is not fixed, so take the ratio from the
   returned image's own dimensions. That path also captures only while the sideloaded app is
   in the foreground, unless the device's auth token grants the `screenshot` permission.

8. **Prefer one `keysequence` to a run of `keypress` calls.** Each call is a round trip, and a
   sequence keeps the timing consistent. After the last key, capture or query rather than
   assuming the app kept up.

9. **Some tools need the server, and say so.** `logs`, `get_server_health` and the profiling
   and debug-session families only work when `rk server` is running; the rest fall back to
   running the CLI in process. `get_server_health` is the quickest way to tell which side of
   that line a session is on, and a tool that needs a server names one in its failure. Getting
   a server running, and pointing a client at it, is the `mcp-setup` skill's subject.

10. **Clean up what you instrumented.** Log lines added to chase a bug, probe nodes injected
    into the tree, stopwatch wrappers around a function: tag them all with one prefix when you
    add them, and remove them by that prefix before you finish.

11. **A Roku Cloud Emulator device costs money while it runs, so start one only when asked.**
    No tool starts a stopped device implicitly; a call that
    needs it fails with `RCE_DEVICE_NOT_RUNNING`, worded for a shell (`rk device start`). In a
    session the equivalent is `device_start`, which takes a minute or two and makes the server
    the device's owner. The server stops it on `device_stop`, after a stretch with no tool call or
    session touching it, and whenever the server exits — but call `device_stop` yourself when
    the work is done rather than leaning on the idle timer. `device_stop` refuses a device the
    server did not start (`RCE_NOT_SERVER_OWNED`); that one belongs to whoever started it. It also
    refuses one another MCP session started (`RCE_NOT_SESSION_OWNED`): pass `force: true` only when
    the user means to stop it. If a stop fails, the server keeps the device and retries about
    every 30 seconds and on exit, but call `device_stop` again rather than assume it went. Both
    tools need a running `rk server`, and the device must already be registered with
    `rk device add --rce`, which is the `device-management` skill's subject.

## Example

A session that gets code onto a device and confirms it, in the order the tools are called:

```text
list_devices                      -> which device, and is one active
deploy_app       { root }         -> builds dist-dev, sideloads, launches
capture_screen   {}               -> the screen as it is now
ecp              { command: "keysequence", keys: ["right", "right", "Select"] }
ecp              { command: "query/app-ui" }   -> the tree after the presses
logs             { action: "start" }
logs             { action: "search", filter: "MyScreen" }
```

Each step answers one question. If a step returns something you did not expect, stop and find
out why before sending the next key — a crashed app accepts keypresses silently, and every
observation after that point describes a device that is no longer running your app.

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| The device is running older code than the source | `build_app` wrote `dist-build` and a bare `sideload_app` read `dist-dev` | Use `deploy_app`, or pass `outDir: "dist-build"` to `sideload_app`. The sideload now warns when the directory it read is older than the other one |
| A tool reports no device | Nothing registered, or nothing active | `list_devices`, then `activate_device`; `add_device` if the list is empty |
| Sideloading is refused | Developer mode is off, or the device password is wrong | Enable developer mode on the box, then set the password with `update_default_auth` |
| The install succeeds but the app never runs, on a box where other apps do | The device is on a Roku OS older than 16.0, the minimum an SDK app needs | The install's `warnings` name the version; otherwise `ecp` with `command: "query/device-info"` and read `software-version`. The device's software has to be updated, which no tool does |
| `logs` fails before it reads anything | It requires server mode, and there was no session | Start `rk server`, then `logs` with `action: "start"` before `get` or `search` |
| Keys appear to do nothing | The app crashed, or focus is not where you assumed | `capture_screen`, then `ecp` with `query/app-ui`; check the logs for an exception |
| A screenshot looks right but the test of it fails | Measured in device pixels, compared against design coordinates | Convert before comparing |
| A tool fails with `RCE_DEVICE_NOT_RUNNING` and suggests `rk device start` | Nothing starts a billed device implicitly; the message is worded for a shell | `device_start` if the user wants it running, then `device_stop` when done |
| `device_stop` fails with `RCE_NOT_SESSION_OWNED` | Another MCP session (another editor window, another agent) started the device | Leave it, or pass `force: true` if the user asked for it stopped |
| `device_start` fails with `RCE_DEVICE_STOPPING` | A stop of that device is still under way | Wait for it, then call `device_start` again |
| `capture_screen` fails with `SCREENSHOT_NOT_OK` on a cloud or secure retail device | The sideloaded app is not in the foreground | Deploy or relaunch the app, then capture |
| `capture_screen` on a LAN device fails with `SCREEN_CAPTURE_ERROR`, naming an auth token | A secure device, every retail Roku among them, serves no ECP capture without a Roku-issued token, and no developer password was at hand for the installer fallback | `update_default_auth`, or `rk device update <device> --password <password>` from a shell, then capture again |
| Sideloading to a cloud device is refused for its password | Its password is kept with its registration; `update_default_auth` never applies to it | `rk device update rce:<name>` from a shell, as the error names |
