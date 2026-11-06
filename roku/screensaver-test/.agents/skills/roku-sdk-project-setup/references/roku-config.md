<!-- @roku-sdk/ai managed v=1 hash=4042748e7e1db3c08b2c090cc4407cdf862939f184cf8ffe29ba522b64a27084 skills=1 do-not-edit -->

# `roku-config.ts` beyond the manifest

The skill body covers the part of this file every app touches: `app.entryPoint`, and the
`manifestEntries` block that *is* the manifest. This file covers the rest — the blocks that
exist for a specific job, and the rules for which value wins when more than one place sets it.

Every field is typed with TSDoc in `@roku-sdk/sdk-config` (`UserSdkConfig`, `UserSdkAppConfig`,
`RokuManifestEntries`). Read a field's type there; read the behaviour here.

## Code that must not reach production

`app.buildVariables` injects build-time constants, and two names are supplied whether or not
you declare them.

`__DEV__` is `true` under `rk dev` and `false` under `rk build`, except for
`rk build --debug`. It is **reserved**: declaring it in `buildVariables` does not override it.
Guarding with it is what removes code from a production build, because the branch is
tree-shaken away rather than merely skipped.

```ts
if (__DEV__) {
    // dev-only logic, absent from a production bundle
}
```

Naming reactive work is a different switch, and it is not a build variable. `solidDevMode`
sits at the top level beside `app` (or comes from `--solid-dev-mode`) and resolves solid through
its development build, which is what gives `createSignal`, `createMemo` and `createEffect`
their names in traces and Solid devtools — without it reactive work is anonymous, which is
usually discovered halfway through reading a trace. The config field takes effect only on
`rk dev --debug`; `--solid-dev-mode` works on any JavaScript build. Plain `rk dev` and
`rk build` ignore the config field, and bytecode builds skip it, so a production trace stays
anonymous however this is set.

`buildVariables: { __SIGNAL__: true }` is the legacy spelling of the same switch. Reach for
`solidDevMode` instead: values are JSON-stringified on the way through, so the bare `true`
reaches the switch as `true` and matches, while `"true"` reaches it still quoted and turns
nothing on. Both spellings are legal build variables, so the compiler stays silent on the
one that does nothing.

```ts rsg-skill=complete
import { type RokuConfig } from "@roku-sdk/rsg-ts/roku-config";

const configuration: RokuConfig = {
    solidDevMode: true,
    app: {
        entryPoint: "src/index.ts",
        // Not a build variable: the two log-level keys are written by the build
        // itself, so setting them in `buildVariables` is silently discarded.
        logger: { baseLogLevel: "INFO" }
    }
};
```

The log levels are the one pair that does not belong in `buildVariables`. `__BASE_LOG_LEVEL__`
and `__CURRENT_LOG_LEVEL__` are set by the build from `app.logger` and overwrite whatever you put
there, with no warning — see the `logging-and-errors` skill for what each level actually does.

## Seeing inside a function without editing it

`app.perfetto` wraps eligible named functions in trace slices at build time.

| Field | Effect |
|---|---|
| `instrumentPaths` | Folder prefixes to instrument, matched as **substrings** of the source path. Empty or absent disables instrumentation |
| `exclude` | Babel visitor shapes to skip: `"FunctionDeclaration"`, `"VariableDeclarator"`, `"FunctionExpression"`, `"ObjectMethod"` |
| `filter` | Trace-name substrings to keep. Absent instruments every eligible name; an **empty array instruments none** |

The substring match is the trap: `"src"` also matches `resource/data` and `other-src/utils`,
so give a prefix specific enough to mean what you intended.

`--perfetto-paths`, `--perfetto-exclude` and `--perfetto-filter` override the corresponding
field for one run. Each is repeatable and each value may be comma-separated. Passing an empty
value disables that dimension rather than falling back to the config.

## An XML component whose base the SDK does not know

A build that fails asking for a missing base-component mapping is asking for `dtsOptions`.
Declaration generation maps every base an XML component extends; a base outside the merged
mapping — the SDK's defaults plus yours — stops the build rather than emitting a `.d.ts` with a
hole in it.

```ts
import { type RokuConfig } from "@roku-sdk/rsg-ts/roku-config";

const configuration: RokuConfig = {
    app: { entryPoint: "src/index.ts" },
    dtsOptions: {
        includeDefaults: true,
        augmentJSX: true,
        componentMapping: {
            MyCustomBase: {
                interface: "IMyCustomBaseProps",
                module: "./src/components/MyCustomBase.xml"
            }
        }
    }
};
```

Keep `includeDefaults` on unless you intend to replace the SDK's mappings wholesale; the
`componentMapping` object merges with them rather than shadowing the file.

## Signing, and the one value that must not be here

`package.devId` is the developer ID expected after a re-key, and `package.outDir` is where a
signed package lands. The signing password is **not** a config field: pass
`--signing-password`, or set `ROKU_SIGNING_PASSWORD`. A password written into `roku-config.ts`
is a credential in the repository.

## Publishing

`roku-config.ts` accepts a `publishing` block, but `rk` does not currently read it, so editing
it changes nothing a command does. A version reaches a channel by uploading the signed `.pkg` in
the Roku Developer Dashboard; getting that `.pkg` is the `app-packaging` skill's subject.

## Which value wins

Perfetto instrumentation takes the CLI flag first, then the `app.perfetto` field. There is no
environment layer, so a stale environment variable cannot outrank a value you just edited.
