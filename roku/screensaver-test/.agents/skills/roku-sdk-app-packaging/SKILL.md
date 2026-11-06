---
name: roku-sdk-app-packaging
description: "Use when a built RSG SDK TypeScript app has to be signed, published, or cleared off a device — producing a signed .pkg and the password tiers a CI job with no terminal is left with, rekeying a box to a different signing key, getting a new version onto a channel for review or live (publishing to a channel is done in the Roku Developer Dashboard; the SDK has no command for it), listing or removing the dev channel and the Dynamic Component Libraries a device holds, and where setting a library up and referencing a node from it is documented once a partner ships that library separately and the app loads it from a URL at runtime. Not for installing @roku-sdk packages from npmjs.com, which is the sdk-installation skill's subject; not for producing the build that then gets signed, which is the cli-dev-loop skill; and not for what roku-config.ts declares about the app, which project-setup owns."
# @roku-sdk/ai managed v=1 hash=4a59467d066c8e4a7e236686e19574ad3ab2f20ac6cdfc5c991e786143cbce4a skills=1 do-not-edit
---

# App Packaging

## Overview

`rk device package` and `rk dcl` talk to a Roku over its developer interface: they sign using the key
already on that box and manage what it holds, so they need a device. Signing is where the SDK
stops. Getting a version onto a channel, staged for review or live, is done by uploading the
signed `.pkg` in the Roku Developer Dashboard; the SDK has no command for it.

## When to Use

- producing a signed `.pkg` from an app that is already installed on a device
- a signing step in CI, where nothing can be typed at a prompt
- pointing a box at a different signing key, or checking which developer ID it now reports
- getting a version onto a channel, staged for review or published outright, and which part of
  that the SDK does
- listing or clearing the dev channel and the Dynamic Component Libraries a device holds
- a partner shipping a library separately for the app to load from a URL at runtime, and where
  setting that library up and referencing a node from it is written down

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Installing `@roku-sdk` packages from npmjs.com | The `sdk-installation` skill | That is what arrives; this is what leaves |
| Cutting a release of the SDK's own packages | The repository's release process | This ships an app to a channel, not a library to a registry |
| Producing the build that then gets signed | The `cli-dev-loop` skill | Signing starts from an app that already exists on the box |
| Writing the code that builds a Dynamic Component Library, or loads one and pulls a node out of it | `documentation/core-concepts/dcl.md` | No other skill covers it, so the two Quick Reference rows below are the whole routing answer: `rk dcl` manages the ones a device already holds, and building one is an app whose `roku-config.ts` sets `app.type: "dcl"`, side-loaded like any other |
| What `roku-config.ts` declares about the app | The `project-setup` skill | Its `package` block is read here, but the file belongs there |
| Reaching the device at all, or which one a command lands on | The `device-management` skill | Everything here takes `--device` or `--host`; what those resolve to is decided there |

## Quick Reference

| Goal | Do |
|---|---|
| Sign what is installed on the device | `rk device package sign` |
| Sign with nothing to type at | `ROKU_SIGNING_PASSWORD` in the environment |
| Point a box at another signing key | `rk device package rekey <pkg-path>` |
| See what is installed | `rk device package ls` |
| Remove the dev channel | `rk device package delete` |
| Re-image the installed dev channel as squashfs | `rk device package squashfs` |
| Get a version onto a channel, staged or live | Upload the signed `.pkg` in the Roku Developer Dashboard; no `rk` command does this |
| DCLs on a device | `rk dcl ls`, `rk dcl delete <filename>`, `rk dcl delete-all` |
| A partner's library the app loads at runtime | Build it as its own app with `app.type: "dcl"` in `roku-config.ts`; the host resolves it from the channel store by library name |
| Referencing a node out of that library | `getComponentLibraryFactory()` from `@roku-sdk/runtime/component-library`, then `factory.createLibrary(<name>)`, `library.load()` and `getDCLComponent(library, <node>)` from `@roku-sdk/rsg-ts` — full walkthrough in `documentation/core-concepts/dcl.md` |

## Instructions

1. **The signing password resolves from three places, in one order.** `--signing-password`
   first, then the `ROKU_SIGNING_PASSWORD` environment variable, then a masked prompt. The
   prompt needs a TTY on both stdin and stdout; without one the command fails immediately and
   names the first two. A CI job therefore has exactly one tier it can use — the environment
   variable. The flag is the wrong answer there, because the value lands in the process list and
   in any log that echoes the command it was given.

2. **`rk device package sign` signs the app on the device, not a file on disk.** It requires a box with
   a dev channel already installed and keyed; a box without one fails saying so, and the fix is
   to sideload first. The signed file lands in `--out`, falling back to `package.outDir` from
   `roku-config.ts`, and then to the working directory. Name `--out` in a job, so the step that
   collects the artifact does not depend on where the command ran.

3. **`rekey` finds its package from the project when it is not given one.** The positional wins;
   otherwise `package.signingKeyPackage` is used, and with neither the command explains both.
   `--dev-id` falls back to `package.devId` the same way, and it is an assertion rather than an
   input: the developer ID the box reports afterwards is checked against it.

4. **Putting a version on a channel happens in the Developer Dashboard.** The SDK signs; it does
   not upload, stage, wait on review or promote. Whether a version goes live or stays with QA is
   chosen there, against the signed `.pkg` this skill produced. Do not offer an `rk` command or
   flag for any of those steps, and do not read a `publishing` block in `roku-config.ts` as
   evidence of one: the block is accepted, and `rk` does not read it.

5. **Only a signed `.pkg` goes onto a channel.** What `rk build` writes to `dist-build` is
   unsigned: side-load it, then sign it on the device with `rk device package sign`. That signed `.pkg`
   is the file to upload.

6. **`device package` and `dcl` name a box.** Both take `--device` for a box in the store, or `--host`
   with `--password` for one by address, and both work the same whether the command went through
   a running server or `--local`. The two ways of naming a box are exclusive: `--host` together
   with `--device` is an error, and `--host` alone still needs a password, because an address is
   not in the store to carry one.

## Example

A CI job that signs without a prompt, keeping the password out of the command line and putting
the artifact in a fixed directory for the job to collect.

```bash
# ROKU_SIGNING_PASSWORD comes from the job's secret store, never from an argument.
# --out fixes where the .pkg lands, whatever directory the job runs in.
rk device package sign --device ci-box --out dist-build/package --json
```

The `.pkg` in `dist-build/package` is then uploaded in the Roku Developer Dashboard, where the
version is kept for review or published.

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| Signing fails in CI asking for a password, and works on a laptop | The prompt is the only tier left, and it needs a TTY | Set `ROKU_SIGNING_PASSWORD` in the job environment |
| The signed file is not where the next step looks | `--out` was omitted, so it fell back to `package.outDir` or the working directory | Pass `--out`, or set `package.outDir` to the directory that step reads |
| An unsigned build is offered for upload | The output of `rk build` was taken as the release artifact | Sideload it, then `rk device package sign`; only the signed `.pkg` uploads |
| An agent proposes an `rk` command to upload, stage or promote a version | The SDK has none | Sign with `rk device package sign`, then upload in the Roku Developer Dashboard |
| `rekey` reports the wrong developer ID | `--dev-id` or `package.devId` asserts the expected one and it did not match | Confirm which key the box should hold before rekeying it |
| Signing fails saying no dev channel is installed | Nothing is on the box to sign | Sideload the app first, then sign |
| `--host` is rejected, or reaches a box you did not mean | It cannot be combined with `--device`, and on its own it still needs `--password` | Give `--host` with `--password`, and drop `--device` — the store is not consulted for an address |
