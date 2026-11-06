---
name: roku-sdk-device-management
description: "Use when the rk CLI's own list of Rokus is wrong, or a shell command has to be pointed at a different one — registering a device, storing its developer password and keeping the file that holds it out of a shared repository, choosing which registered device is active, overriding the target for a single command and why --device and --host cannot be combined, where roku-dev-config.json is looked up and which copy of it wins, rk device ls listing a device that no config file seems to mention, and registering, starting or stopping a Roku Cloud Emulator device named rce:<name>. Not for an agent session whose MCP tools already answer: a tool call that reached the wrong box carries its own target argument, and that is the mcp-ai-dev-loop skill. Not for what gets run against the device once it answers — building, sideloading, driving it or reading its logs is the cli-dev-loop skill — and not for leasing a device out of a shared pool, which needs internal tooling the partner CLI does not ship."
# @roku-sdk/ai managed v=1 hash=5b25aadd881a62b8998d1aa9ac2c35b90ef9c1593a2f51c475fd9083fcddb13e skills=1 do-not-edit
---

# Device Management

## Overview

The `rk` CLI keeps its own list of Rokus, and that list is not part of any project. Every command
that touches a device resolves a target from it — or from a flag that overrides it, or from the
environment when it is empty. Almost everything that goes wrong here is a question of which of
those three won, so the useful first move is to find out rather than to guess.

## When to Use

- registering a Roku, or getting a developer password stored against one
- keeping a stored developer password out of a shared repository
- choosing which registered box commands land on, and changing it
- running a single command against a box that was never registered
- several worktrees or checkouts that disagree about which devices exist
- a device list that is empty, or that holds an entry no file seems to declare
- a device subcommand that runs, prints one line, and tells you nothing
- registering, starting or stopping a Roku Cloud Emulator device, which is listed with the others but registered in a file of its own

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| An agent session whose MCP tools answer, and a tool call that reached the wrong box | The `mcp-ai-dev-loop` skill | A tool call carries its own target argument, so the fix is there and not in the CLI's store — even though the symptom reads identically |
| Building, sideloading, driving a device or reading its logs | The `cli-dev-loop` skill | This skill ends the moment the box answers |
| Signing an app, publishing it, or clearing what is installed | The `app-packaging` skill | Those act on the artifact, not on how the box is reached |
| What `roku-config.ts` declares about the app | The `project-setup` skill | The device store is not project configuration and lives outside the repository |
| What a freshly scaffolded app's `.gitignore` covers, beyond the device store | The `project-setup` skill | The scaffold's own output is its subject; the one entry that protects a stored password is below |
| Leasing a box out of a shared pool | `documentation/advanced/rk/device-lease.md` and `documentation/advanced/rk/device-pool.md` | Leases are a separate mechanism from the device store; `rk` ships the `local` provider, and any other pool kind has to be registered by the caller |
| Turning on developer mode on the television itself | Roku's own documentation | That happens on the box, and no CLI command can do it |

## Quick Reference

| Goal | Do |
|---|---|
| Register a Roku | `rk device add <ip>` |
| Store its password | `rk device update <target> --password <pwd>` |
| One password for every box | `rk device set-default-password` |
| See the list and which one is active | `rk device ls` |
| Switch the active box | `rk device set-active <target>` |
| Stop pinning one | `rk device clear-active` |
| Remove one | `rk device rm <target>` |
| Find out which file is being read | `rk device store-path` |
| Keep a stored password out of a shared repo | add `.roku` to `.gitignore` |
| Send one command elsewhere | `--device <id\|ip\|name>`, or `--host` with `--password` |
| Register a cloud device | `rk device add --rce <name> --snapshot <snapshot>`, then `rk device set-active rce:<name>` |
| See every cloud device in the organisation, registered or not | `rk device ls --org` |
| Start and stop it (billed while running) | `rk device start rce:<name>`, `rk device stop rce:<name>` |

## Instructions

1. **Two files can hold the list, and a local one wins outright.** The nearest
   `.roku/roku-dev-config.json` found by walking upwards is used whenever it carries a `devices`
   array; otherwise `~/roku-dev-config.json` supplies the list. When both exist the local one
   still wins, and the CLI warns that it is doing so. `ROKU_DEV_CONFIG_PATH` replaces the home
   path entirely. `rk device store-path` prints the file actually in effect, which settles the
   question faster than reasoning about it.

2. **The home file is the one worth keeping, because worktrees share it.** A local list belongs
   to one checkout, so five worktrees mean five lists that drift apart. Delete the `devices`
   array from the local config — the file may stay — and every checkout reads the central list.

3. **The active pointer is resolved separately from the list.** A local config's
   `activeDeviceId` outranks the home one even when every device is declared centrally. One
   shared list with a different active box per worktree is therefore a supported arrangement
   rather than a conflict, and it is worth knowing before "fixing" it.

4. **`rk device add` cannot take a password.** For a box on your network it accepts `--name`,
   `--id`, `--tag` and `--json`, and nothing else. Set the password afterwards with `rk device update <target> --password`, or set
   one for every box at once with `rk device set-default-password`.

5. **`--device` and `--host` are alternatives, not partners.** `--device` looks the box up in the
   store, so it needs nothing else. `--host` bypasses the store entirely, so it needs
   `--password` beside it. Passing both fails with a message saying exactly that, and the reason
   is that they answer the same question two incompatible ways.

6. **An empty store does not mean there is no device.** With `ROKU_DEV_TARGET` set to a valid
   address, a synthetic entry is used, taking its password from `ROKU_DEV_PASSWORD` and showing
   up tagged as having come from the environment. A CI image with no config file that still
   reaches a box is almost always doing this.

7. **Two advertised subcommands do nothing yet.** `ping` and `info` appear in the CLI's own
   help and each prints a single line saying it is not yet implemented. Nothing is wrong with
   the box; use `rk device ls` for what is registered. `rk device status` does work, but only
   for a Roku Cloud Emulator device: with a box on your network active it says so and exits 0,
   and naming one fails with `DEVICE_KIND_UNSUPPORTED`.

8. **A local store puts a developer password inside the repository.** The password is written in
   clear text into whichever `roku-dev-config.json` is in effect, so a local one lands at
   `.roku/roku-dev-config.json` — a committable path. An app scaffolded by `rk create` ignores the
   whole `.roku/` directory and is covered; any other project needs that entry added by hand,
   before the first commit. `rk device add` warns while the directory is unignored and accepts any
   of `.roku`, `/.roku`, `.roku/` or `/.roku/`, so the spelling its own warning suggests does
   clear it — but it compares against those four forms and nothing else, so a pattern such as
   `**/.roku` ignores the directory while leaving the warning in place. If the file was committed
   already, `git rm --cached` it and treat the password as disclosed.

9. **A Roku Cloud Emulator device is a second kind in the same listing, kept in its own file.**
   `rk device ls` shows both kinds, but a registration lives in `~/roku-rce-devices.json`, beside
   the RCE token in `~/roku-rce-config.json`; `ROKU_RCE_CONFIG_PATH` moves both, and
   `~/roku-dev-config.json` holds LAN devices only. Neither is ever read from a project's
   `.roku/`. `RK_RCE_TOKEN` outranks the saved token, and `rk device set-rce-token` saves one
   without taking it as an argument. Name the device `rce:<name>` wherever a command takes one:
   a bare name also resolves, but when a box on your network shares it the LAN box wins, with a
   warning on stderr naming the `rce:` spelling. It has no address, so `--host` can never reach
   it — use `--device`. Its developer password, like the token, is read from standard input,
   never from an argument, so `rk device update <target> --password` is refused for it; from a
   pipe only the first line is read. `rk device update rce:<name>` prints only what it changed,
   and `--json` prints `{ device }`. It is billed while it runs and nothing starts it behind your
   back: a command that needs it says `rk dev --start` or `rk device start`, and whoever starts it
   should stop it. `documentation/advanced/rk/rce.md` covers creating one, snapshots, and what works on it.

## Example

Moving a checkout off its own private list and onto the shared one, then confirming what the CLI
now reads.

```bash
# What is actually in effect right now.
rk device store-path
rk device ls

# Register centrally and give the box its password in two steps, not one.
rk device add 10.0.0.42 --name desk-ultra
rk device update desk-ultra --password <pwd>
rk device set-active desk-ultra
```

If `store-path` reported a `.roku/roku-dev-config.json` inside the checkout, remove the `devices`
array from it first — otherwise the commands above write to a list only this worktree can see.

A one-off box that should never be registered skips all of it:

```bash
rk ecp query/device-info --host 10.0.0.99 --password <pwd>
```

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| `rk device add` rejects a password option | `add` takes only `--name`, `--id`, `--tag` and `--json` | `rk device update <target> --password` |
| `rk device remove` is not recognised | The subcommand is `rm` | `rk device rm <target>` |
| A tag-clearing option is rejected | No such option exists, though older documentation names one | Re-tag with `rk device update --tag` |
| Two worktrees see different devices | Each has its own local `devices` array | Drop the local array; keep `~/roku-dev-config.json` |
| A warning about a legacy local device list | Both files exist and the local one is winning | Migrate the list to the home file |
| `--device` together with `--host` fails | They resolve the target two incompatible ways | `--device` for a stored box, `--host` with `--password` for an ad-hoc one |
| `--host` alone is refused for want of a password | Bypassing the store also bypasses the stored password | Add `--password`, or register the box and use `--device` |
| A device health subcommand prints one line and stops | `ping` and `info` are not implemented | `rk device ls` |
| `rk device status` only prints that it reports on cloud devices, or refuses a box on your network | It reports on Roku Cloud Emulator devices only | `rk device ls` for a network box |
| A command warns that a name "names a LAN device and a Roku Cloud Emulator device" | A box on your network shares the cloud device's name, and wins | `rce:<name>` for the cloud device |
| `--host rce:<name>` is refused | A cloud device has no address of its own | `--device rce:<name>` |
| A command says the cloud device is not running | Nothing starts one implicitly, since it is billed | `rk device start rce:<name>`, or `rk dev --start`; stop it afterwards |
| `rk device ls` shows a cloud device as `unknown` | No RCE token is configured, or the service did not answer | `rk device set-rce-token`, or set `RK_RCE_TOKEN` |
| The list is empty but commands still reach a box | `ROKU_DEV_TARGET` is set in the environment | `rk device store-path`, then check the environment |
| `git status` offers to commit a file holding the developer password | A local store writes it to `.roku/roku-dev-config.json`, and the project was not scaffolded by `rk create`, so nothing ignores it | Ignore `.roku/`, then `git rm --cached` it if it was already committed |
| The unignored-directory warning survives a `.gitignore` entry | The check recognises `.roku`, `/.roku`, `.roku/` and `/.roku/`, and no other pattern | Use one of those four forms rather than a glob |
