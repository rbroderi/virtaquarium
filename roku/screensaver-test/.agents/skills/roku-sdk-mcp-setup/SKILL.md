---
name: roku-sdk-mcp-setup
description: "Use when the SDK's MCP tools are missing from an agent session, will not connect, or have to be configured for the first time — choosing between the editor spawning the server and running it persistently, the config entry that does either, starting a server and finding the port it chose, and reading the failure when no tools appear at all. Not for a session whose tools already answer: one call failing over targeting, a device or the app, asking from inside that session whether the backing server is up, and everything after that — deploying, capturing the screen, driving the app, reading logs — belongs to the mcp-ai-dev-loop skill."
# @roku-sdk/ai managed v=1 hash=3420c1be964c420148775ffcfa903904f8f784af05fe344b3a7df56471133453 skills=1 do-not-edit
---

# MCP Setup

## Overview

The SDK reaches an agent through an MCP server, and there are two ways to run it: the editor
spawns it, or it runs as a persistent background process. They are not alternatives to choose
between once. The spawned entry looks for a running server on every request and forwards to it,
so the config decides how the client reaches the tools, and whether a server is running decides
which tools answer. Write the spawned entry, then start a server if the task needs one.

## When to Use

- an agent session with no Roku tools in it, or an editor that has never been configured
- a client that will not connect, or connects and lists nothing
- deciding between the spawned entry and a persistent server, and how to move between them
- finding the port a running server chose, or fixing it so it can be written down
- a call refused with a message about requiring server mode

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Tools answer, and one call fails over targeting, a device, or the app | The `mcp-ai-dev-loop` skill | Setup finished when the client listed tools. A refusal that names server mode is the exception and stays here, because the fix is to start a server |
| Which call reports whether the server is up, from inside a working session | The `mcp-ai-dev-loop` skill | Reading the session's own state is that skill's loop; starting what is missing is this one |
| Deploying, screenshotting, driving the app or reading its logs | The `mcp-ai-dev-loop` skill | This skill ends at the connection |
| Configuring an MCP server that is not the SDK's | That server's own documentation | Nothing here generalises past `rk` |
| A shell script, a CI step, or anything with no agent in it | The `cli-dev-loop` skill | MCP exists to give an agent the tools; a runner calls `rk` itself, and needs none of this |
| `rk` itself does not resolve yet | The `sdk-installation` skill | There is nothing to configure until the package is installed |

## Quick Reference

| Goal | Do |
|---|---|
| Let the editor run the server | A config entry invoking `rk mcp` through the project's own runner |
| Run one persistently | `rk server start --daemon` |
| Find the port, and confirm it is up | `rk server status` |
| Fix the port so it can be written down | `--port <n>` on `rk server start` |
| Stop it | `rk server stop` |
| Test the install without the editor | Run `rk mcp` in a terminal; it should sit waiting on stdin |

## Instructions

1. **Write the spawned entry first.** It is the whole of setup for most work, and it is the
   half that survives every later change. What matters is that the entry reaches the *installed*
   binary in `node_modules/.bin`: `npx rk mcp` and `pnpm exec rk mcp` both do that in a project
   that depends on `@roku-sdk/tooling`, so use whichever runner the project already uses. What
   fails is an entry that can miss it — a bare `rk` that is not on `PATH`, or a runner invoked
   outside the project directory, which sends it to the registry for a package it could have
   read from disk.

2. **The key and the fields differ by editor, and a wrong key fails silently.** VS Code reads
   `.vscode/mcp.json` under a `servers` key and wants a `type`. Cursor reads `.cursor/mcp.json`
   under `mcpServers` and does not. A client handed the other shape finds no entry, so it
   reports no error and lists no tools — which looks exactly like a broken install.

3. **Start a server only when the task needs one.** Most tools run in process. `logs`,
   `get_server_health`, `stop_dev_session`, the three Perfetto tools (`perfetto_enable`,
   `perfetto_start`, `perfetto_stop`) and the CDP and DAP debugger families require a server
   and say so when there is none, naming `rk server` in the failure.

4. **Never hardcode the port.** It is derived from a hash of the workspace root path, so it
   differs per checkout and even between two clones of the same repo, landing somewhere in
   3737–4236 (Fetch-blocked ports such as 4045 and 4190 are skipped). `rk server status`
   prints the one in use. If a port has to be written into a config file, make it true by
   starting the server with `--port` rather than by guessing.

5. **Moving from spawned to persistent is starting a server, not rewriting the config.**
   Because `rk mcp` forwards to a live server when it finds one, a stdio entry plus a running
   server already has the full tool surface. Point the client at an HTTP URL only when
   something other than that editor needs the same backend.

6. **`--daemon` is what makes it outlive the terminal.** Without it the server stops with the
   shell that started it. It also exits after 240 idle minutes, which `--timeout` changes; a
   morning's server being gone after lunch is that, not a crash.

7. **When no tools appear, test the install before touching the config again.** Run `rk mcp`
   from the workspace root, through the same runner the config entry uses: it should start and
   sit waiting on stdin. That separates the two failures — if it runs, the config is wrong; if it
   reports that `rk` was not found, the tooling is not installed and no config would have helped.
   Read the message rather than the exit status: a runner reports a missing binary with its own
   code, and only a bare shell returns the 127 people expect.

8. **In spawned mode nothing may write to stdout.** That stream carries JSON-RPC and nothing
   else. A wrapper script that echoes a line, or a shell profile that prints a banner, corrupts
   the first message and the client drops the connection — usually reported as the server
   exiting immediately. Invoke the binary directly rather than through a wrapper.

## Example

A Cursor setup that starts spawned and gains the server-only tools without the config changing.

`.cursor/mcp.json` — written once:

```json
{
    "mcpServers": {
        "roku-sdk-tools": {
            "command": "pnpm",
            "args": ["exec", "rk", "mcp"]
        }
    }
}
```

`"command": "npx"` with `["rk", "mcp"]` is the same entry for a project on npm; the runner has
to match the project, not this page.

Later, when the task needs log collection or a trace:

```bash
npx rk server start --daemon
npx rk server status
# rk server running at http://localhost:3941/api (pid 12345, rkRoot: /Users/you/workspace)
```

The config above is unchanged and now reaches that server. The printed port matters only if
another client has to be pointed at the same backend; for this editor, nothing needs it.

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| No tools at all, and no error anywhere | The config uses the other editor's key | `servers` for VS Code, `mcpServers` for Cursor |
| Tools appear, but every connection is slow | The runner is reaching the registry because it cannot see the project's `node_modules` | Give the entry the project directory, so `rk` resolves from disk |
| The server exits the moment the client starts it | Something wrote to stdout ahead of the protocol | Drop the wrapper script; invoke the binary |
| Connection refused on the URL that worked yesterday | The port was hardcoded and is derived per workspace | `rk server status`, or pin it with `--port` |
| Every request answers `403` with `HOST_NOT_ALLOWED` or `ORIGIN_NOT_ALLOWED` | The URL names the server by something other than a loopback name (`host.docker.internal`, the machine's LAN address), or a browser-based client sends an `Origin` from another port | Use `localhost` or `127.0.0.1`, through a port forward if the client runs elsewhere (`ssh -L`, an editor's port forwarding, `docker -p` all work, since only the `Host` name is checked); a browser client has to be served from the server's own port |
| An HTTP client gets `404` with `MCP_SESSION_UNKNOWN` | Its `Mcp-Session-Id` was not issued on this machine: made up or altered, from another machine, or signed with a session key file (`roku-rce-mcp-session-secret`, beside the RCE token) that was since deleted or replaced. A restart alone does not cause it | Reconnect the client so it sends `initialize` again; `rk mcp` does this on its own |
| A call refuses, naming server mode, while others work | No server is running | `rk server start --daemon`; the config needs no change |
| The server is gone after a few hours | The idle timeout, or it was started without `--daemon` | Restart with `--daemon`, and raise `--timeout` if the gap is expected |
| Running it by hand reports that `rk` was not found | The tooling is not installed in this workspace | Install dependencies, and confirm `node_modules/.bin/rk` exists |
