<!-- @roku-sdk/ai managed v=1 hash=438577ec4603755c7ec1fc50e11c35ff1d240a85e09ab699d6c1929051ac1951 skills=1 do-not-edit -->

# Logs and crashes from a shell

What a device printed, and what a crash stack means, reached through `rk` rather than through an
agent's tools. The reasoning about crashes — which route a stack arrives by, why a bytecode frame
cannot be read directly, and when exception tagging is needed — belongs to the `mcp-ai-dev-loop`
skill's `crash-and-console.md` and is not repeated here. This page is the shell surface: which
command, which option, and what only exists here.

## `rk logs` needs a server

`rk logs` is server-mode only. Every other command in this loop runs in process, so a log step is
the one that works on a laptop with an editor open and fails in a CI job that never started a
server. Start one first:

```bash
rk server start --daemon
```

Collection is a session, not a stream you attach to. Nothing is buffered until `start` runs, so a
job that reproduces a fault and *then* asks for lines gets nothing.

| Subcommand | What it is for |
|---|---|
| `start` | Begin buffering. `--buffer-size <lines>` sizes the circular buffer |
| `list` | Sessions that exist. `--verbose` adds metrics |
| `get` | Pull the last N lines. `--lines`, `--output <file>`, `--append`, `--format <txt\|json>` |
| `search` | Query the buffer for terms. `--case-sensitive` |
| `tail` | Follow in real time. `--prefix` stamps each line with the time and the device |
| `stop` | End one session, or every session with `--all` |
| `ports` | The log ports the CLI knows about |

Nothing enforces which subcommand an option belongs to: one allow-list covers `rk logs` as a
whole, so `--lines` passed to `start` parses fine and is then ignored rather than rejected.
`--lines`, `--output`, `--append` and `--format` act on `get`, `--case-sensitive` on `search`,
`--all` on `stop`, `--prefix` on `tail`, `--buffer-size` on `start` and `--verbose` on `list`.
`--port` overrides the device's log port, which defaults to 8085.

One exception needs no server: on a Roku Cloud Emulator device, `rk logs tail --source firmware
--device rce:<name>` streams the device's firmware log in process — system output, not the app's
console, which still comes from a server session. It accepts only `--device` and `--from-start`,
and rejects anything else rather than ignoring it.

Writing to a file is `get --output <file>`, not a shell redirect: `--append` then adds to it
across several calls in the same job instead of truncating.

## `rk decode-stack`, and what the flags are called

The same decode the tool surface performs, with the parameters spelled as CLI options:

| Tool parameter | CLI option |
|---|---|
| `stackTrace` | the input — `--file <path>`, or piped in with `--stream` |
| `buildDir` | `--build-dir`, `-b` |
| `sha` | `--sha` |
| `context` | `--context`, `-c` |
| `dclDirs` | `--dcl-dir` |

The input has two shell spellings the tool parameter does not, both standing in for `stackTrace`:

- `--stream` reads the trace from standard input line by line, so a live log can be piped straight
  in without landing it somewhere first.
- `--file <path>` reads it from a file, which is the pairing for `rk logs get --output`.

Three options have no counterpart in the tool surface at all, and they are what make the command
usable from a script rather than a session:

- `--output <path>`, `-o` writes the decoded result to a file instead of the terminal. It also
  switches the format to `plain` unless `--format` or `--json` was passed too, so a job that wants
  JSON in the file has to ask for it explicitly.
- `--format` and `--json` choose the shape of that result, so a job can parse it.
- `--timeout`, `-t` bounds the wait for a trace on standard input and nothing else — it defaults
  to 30s, and with `--file` or `--stream` it is a no-op that warns on stderr. It is not a cap on
  how long the decode itself may take.

Two options validate their input rather than accepting anything:

- `--sha` must be a hexadecimal string of at least 8 characters. A shorter or non-hex value is
  rejected outright, which is the good case — see the warning below for the bad one.
- `--context` must be a non-negative integer no greater than 50.

`--dcl-dir` is the option to reach for when frames name a Dynamic Component Library instead of
`index`: it points the decoder at that library's own build output, which its separate build left
outside the app's. Its value is not a bare path but `libName=/path/to/dir`, and a value with no
`=` in it is rejected saying so; repeat the option once per library. A library whose frames stay
unresolved after the option is passed is usually a `libName` that does not match the one the frames
name, rather than a wrong path.

## The failure that looks like success

A `--sha` naming a build directory that is not there does not fail. The decoder falls back to
detecting a build automatically and resolves against whichever one is newest on disk, so the
result is confident, complete, and about the wrong code. In a CI job that rebuilds between the
crash and the decode, this is the likely outcome rather than an unlikely one.

Two habits avoid it: decode before rebuilding, and treat a decoded frame that does not match the
code you believe ran as a suspect `--sha` before suspecting the frame.

## The pairing a job actually uses

```bash
rk server start --daemon
rk logs start --device ci-box

# ... run whatever reproduces the fault ...

rk logs get --lines 2000 --output device.log --device ci-box
rk logs stop --all
rk decode-stack --file device.log --build-dir dist-ci/bundle --output decoded.txt
```

`--build-dir` is not optional in a monorepo. `decode-stack` never goes through the server, so both
the automatic build detection and a relative `--build-dir` are anchored at the directory the
command is run from — a job that runs it from the repo root while the app builds into a
subdirectory reports no source map for every frame until it is given.
