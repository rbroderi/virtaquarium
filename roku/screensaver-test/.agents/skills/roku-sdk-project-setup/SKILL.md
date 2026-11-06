---
name: roku-sdk-project-setup
description: "Use when an RSG SDK TypeScript app has to be created or its project-level configuration is wrong — scaffolding a new app, what roku-config.ts owns (title, version, splash, manifest entries, and dtsOptions such as includeDefaults when declaration generation does not recognise an XML base), the app's tsconfig.json, which @roku-sdk packages the app must list because its own code imports them, what the scaffold's .gitignore covers after rk create, which Roku OS version a device needs before an app runs on it (16.0 or later), or where a file such as an image has to live before it can be imported in code. Not for resolving SDK packages from npmjs.com, which version line installs, or a peer an SDK package requires the app to declare, which is the sdk-installation skill's subject."
# @roku-sdk/ai managed v=1 hash=626488fba7a3407bf13c9851984bd15bb490c3f0e18c418ddaadf101ff3bbc0e skills=1 do-not-edit
---

# Project Setup

## Overview

`npx rk create <app-name>` scaffolds an RSG SDK TypeScript app that already builds and
runs. Five things then own the project: `roku-config.ts` (app config and manifest entries),
`tsconfig.json` (one `extends` line), `package.json` (the `@roku-sdk/*` dependencies),
`src/` (TypeScript and imported images) and `pkg/` (static assets copied verbatim).

An SDK app runs on **Roku OS 16.0 or later**. Below 16.0 a device runs one only with a
Roku-issued authorization token, so update the device's software rather than working around
it. A feature with a higher floor of its own says so where it is documented.

## Read the reference first for these tasks

| If the request is | Read now, before answering |
|---|---|
| Any `roku-config.ts` field this body does not itself show | `references/roku-config.md` |

This body shows `app.entryPoint` and `manifestEntries`, plus the `images` and `logger` blocks in
the Example. For any other field, open the reference and name the field from it. If it is not
there either, the authority is `RokuConfig` — the type already annotating the app's own
`roku-config.ts` — because the schema gains fields faster than either page. This table routes;
there is nothing in it to answer from.

## When to Use

- creating a new app, or adding one to an existing repo
- the app title, version, splash screen or supported resolutions have to change
- a new image, font or static asset has to be added and referenced from code
- an `@roku-sdk/*` package the app imports is missing from its `package.json`
- the app's TypeScript setup is wrong: JSX or SDK types not resolving
- declaration generation stops on an XML component base the SDK does not map, or whether built-in mappings still apply alongside yours in `dtsOptions`
- `rk` cannot find the config, or a first run on a device is not working yet
- which Roku OS version a device needs before an app will run on it

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Building, deploying, sideloading, or reading logs from an app that already runs, inside an agent session | The `mcp-ai-dev-loop` skill | Those are build and deploy operations, not project configuration |
| The same operations from a shell script or a CI job | The `cli-dev-loop` skill | Same reason, different surface — and the CLI's directories and flags are not the ones the tools expose |
| An `@roku-sdk` package that will not resolve at all, moving the versions of ones that do, a peer one of them requires the app to declare, or a `workspace:*` range that will not resolve | The `sdk-installation` skill | Reaching the registry, and which version line arrives from it, comes before any of this |
| Registering a Roku, storing its password, or choosing which one a command reaches | The `device-management` skill | That store lives outside the repository and is not project configuration |
| A legacy BrightScript channel with XML components | Roku's BrightScript documentation | This SDK's project shape does not apply there |
| How the app behaves at runtime — focus, layout, data | The skill for that area | Setup ends where the app's own code begins |
| A convention that holds only in one repo | That repo's `AGENTS.md` | Repo-specific facts do not belong in a portable skill |

## Quick Reference

| Task | Do this |
|---|---|
| Create an app | `npx rk create my-app` — name lowercase, letters, digits, hyphens |
| Check a device can run the app | `npx rk ecp query/device-info --json` — `software-version` must be 16.0 or later |
| Change title, version, splash, resolutions | `manifestEntries` in `roku-config.ts` |
| An XML base declaration generation does not recognise | `dtsOptions.componentMapping` in `roku-config.ts`; keep sibling `includeDefaults` on so the SDK's own mappings still merge |
| Configure anything else in `roku-config.ts` | `references/roku-config.md` — the field names are only there |
| Register a Roku, store its password, or pick which one commands reach | The `device-management` skill |
| Keep the device developer password out of git | it lands in `.roku/roku-dev-config.json`, which the scaffold already covers by ignoring `.roku/` — that entry is also the only one it writes, not even build output |
| Build the app, install it, drive it or read its logs from a shell | The `cli-dev-loop` skill |
| Find any flag | `npx rk <command> --help` — the help text is the contract |

## Instructions

1. **Scaffold with `npx rk create my-app`**, then `cd my-app && npx rk dev`. It
   installs dependencies, generates the app icons and drops the SDK's agent skills into the
   new repo. Needs Node >= 24 and pnpm. Do **not** assemble a project by hand, and do
   **not** reach for `brighterscript`, `roku-deploy` or `ropm` — a different toolchain that
   does not apply to this SDK.

   A standalone app also gets a `pnpm-workspace.yaml` whose `allowBuilds` block allows
   `@roku-sdk/tooling`'s install script and denies `esbuild`, `unrs-resolver` and
   `@parcel/watcher`. pnpm 11 fails every install and every `pnpm run` without a decision
   for each, so keep the file. Created inside an existing pnpm workspace, the app gets no
   file and the root's `allowBuilds` has to cover those four.

   The `.gitignore` it writes holds a single entry, `.roku/`. That is the entry that matters —
   the device developer password lands in `.roku/roku-dev-config.json` in clear text, so without
   it `git add -A` would commit a credential — but it is also the only one, so build output and
   `node_modules` still want adding before the first commit.

2. **Configure the app in `roku-config.ts`** at the app root — see the Example. Only
   `app.entryPoint` is required. Let `manifestEntries` write the manifest, and never hand-write
   one alongside it. The build does read a `manifest` file when the app ships one, keeping its
   comments, its line order and any key `manifestEntries` leaves alone — but every key set in
   both is overwritten from `roku-config.ts`, with a warning. Two sources for one file that
   only ever resolves one way is a file that drifts. `rk` finds `roku-config.ts` by walking up
   from the current directory, so run commands from inside the app or pass `--config <path>`.

3. **Know the chain that starts the app**, because nothing under `src/` runs until all of it is
   in place. BrightScript's `Main()` creates the SceneGraph screen and instantiates a Scene
   **by name**; that Scene is the root node, and the app's anchor node is a child of it, not
   the root itself. The app's entry point then calls `main()` and registers the anchor node
   with `registerAnchorNode` **inside** that callback. The Scene's generated XML has to be
   imported for its side effect — `import "./compiled-components/<Scene>.xml";` — or the name
   `Main()` asks for does not exist at runtime and the app comes up as an empty screen with no
   build error.

4. **Keep `tsconfig.json` to one `extends` line**, by package alias:

```json
{
    "extends": "@roku-sdk/rsg-ts/tsconfig.json",
    "compilerOptions": { "rootDir": "src", "baseUrl": "." },
    "include": ["src/**/*"]
}
```

   Never extend by a relative path — it breaks as soon as the app moves. `jsx`,
   `jsxImportSource: "@roku-sdk/solid"` and the SDK's `types` all arrive from that config,
   so do not re-declare them. If you must add to `types`, re-list
   `@roku-sdk/interfaces/global` and `@roku-sdk/components/jsx` beside your addition,
   because the array **replaces** the inherited one.

5. **Declare every package the app imports** in its own `package.json`, including one you
   only take a type from — pnpm does not hoist. Use `"workspace:*"` inside the SDK's pnpm
   workspace and one shared caret version for a standalone app, since `@roku-sdk/*`
   packages are released together; which line that is, and any peer a package requires on top,
   belong to the `sdk-installation` skill. Into a standalone app, `rk create` writes
   `@roku-sdk/common`, `@roku-sdk/components`, `@roku-sdk/interfaces`, `@roku-sdk/native`,
   `@roku-sdk/rsg-ts`, `@roku-sdk/sdk-config`, `@roku-sdk/solid`, `@roku-sdk/testing-library`,
   `@roku-sdk/tooling` and `@roku-sdk/ts-core`, plus `@roku-sdk/dev-tools` as a dev
   dependency. The `rk` launcher loads `tsx` from tooling itself; do not add `tsx`
   merely to run `npx rk`. Run inside the SDK's own workspace it scaffolds from a different app and the
   set differs, so read the `package.json` it generated before concluding anything is missing.
   What is not there is on you to add: `@roku-sdk/navigation` the moment the screen needs
   focus, `@roku-sdk/flex-grid` for a shelf or poster grid. `solid-js` is deliberately
   not in that set and must not be added: SolidJS reaches the app through `@roku-sdk/solid`,
   which re-exports the part of it that works under the SceneGraph renderer. Import every
   SolidJS primitive from there, never from `solid-js`. Declaring a package is not the same as
   being able to install it — if one of these will not resolve at all, that is the
   `sdk-installation` skill.

6. **Put app images in `src/` and import them by relative path.** The import gives you
   `uri`, plus `dimensions` when the intrinsic size is needed:

```tsx
import { Poster } from "@roku-sdk/components";

import { dimensions, uri } from "../images/logo-fhd.png";

<poster uri={uri} width={dimensions.fhd.width} height={dimensions.fhd.height} />;
```

   Alias them — `import { uri as logoUri }` — in a module that imports more than one image.
   Never hardcode a `pkg:/` URI for an app image: that opts out of the path rewrite, the
   webp conversion and the copy into the package. Importable extensions are `.png`, `.jpg`,
   `.jpeg` and `.webp`.

7. **For one image per resolution, put the placeholder in the specifier** —
   `import { uri } from "../images/logo-*.png"`. The `*` is **not** a glob: it is the
   `uri_resolution_autosub` placeholder and is substituted literally, so the files must be
   named exactly `logo-fhd.png` and `logo-hd.png`. A 9-patch (`logo-*.9.png`) fails the
   build outright without a hand-authored `logo-hd.9.png`.

8. **Put the icons and splash named in `manifestEntries` under `pkg/images/`** and reference
   them as `pkg:/images/...`. Everything under `pkg/` is copied into the package verbatim,
   which is what makes it the one place a `pkg:/` URI is written by hand.

## Example

```ts rsg-skill=complete
import { getBuildType, type RokuConfig } from "@roku-sdk/rsg-ts/roku-config";

const buildType = getBuildType();

const configuration: RokuConfig = {
    app: {
        entryPoint: "src/index.ts",
        images: { convertToWebp: true, generateHd: true },
        logger: { baseLogLevel: "INFO", currentLogLevel: "ERROR" },
        manifestEntries: {
            title: buildType === "production" ? "My App" : `My App (${buildType})`,
            major_version: 1,
            minor_version: 0,
            build_version: 0,
            ui_resolutions: "fhd",
            uri_resolution_autosub: "*,sd,hd,fhd",
            mm_icon_focus_hd: "pkg:/images/app-icon-hd.png",
            mm_icon_focus_fhd: "pkg:/images/app-icon-fhd.png",
            splash_screen_hd: "pkg:/images/splash_hd.jpg",
            splash_color: "0x000000FF",
            splash_min_time: 1,
            rsg_version: "2.0"
        }
    }
};

export default configuration;
```

`ui_resolutions` also fixes the space the app is **authored** in. With `"fhd"`, every
coordinate, width and height in the code is in a 1920×1080 design space whatever the device
turns out to be, and an HD box scales the whole tree down as it renders. So write one set of
numbers and never branch on the device's resolution. Reading a measurement back *off* a device
runs the other way — a 720p screenshot's pixels are two-thirds of the number the code used —
and that direction belongs to the `mcp-ai-dev-loop` skill.

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| An image import resolves to the wrong file, or to nothing | `*` was read as a glob | Name the files `-fhd` and `-hd` exactly |
| `HD image not found for 9-patch image` | A `.9.png` has no HD variant | Author `-hd.9.png` by hand; it is not generated |
| SDK types vanished after editing `types` in `tsconfig.json` | The array replaced the inherited one | Re-list `@roku-sdk/interfaces/global` and `@roku-sdk/components/jsx` |
| Builds fine, but no icon on the device | `mm_icon_focus_hd` / `mm_icon_focus_fhd` name files that are not there | Put them under `pkg/images/` |
| `git status` offers to commit `.roku/roku-dev-config.json`, which holds the password | The project was not scaffolded by `rk create`, so nothing ignores `.roku/` | Ignore `.roku/`, and `git rm --cached` it if it was already committed |
| `.roku/` is git-ignored but `rk` still warns that it is not | The check recognises `.roku`, `/.roku`, `.roku/` and `/.roku/`, and no other pattern | Use one of those four forms rather than a glob such as `**/.roku` |
| The build stops on an XML component whose base the declaration generation does not recognise, and no SDK version ever mapped it | The base is the app's own, so only the app can declare it | Add it under `dtsOptions.componentMapping` in `roku-config.ts`, and leave the sibling `includeDefaults` on so the SDK's own mappings still merge in |
| `rk` cannot find the config | It walks up from the current directory | Run from inside the app, or pass `--config` |
| The app builds, but the device will not run it | The device is on a Roku OS older than 16.0 | Read `software-version` from `npx rk ecp query/device-info`; update the device's software, then install again |
| The build fails on something the installed version handles — a base component the SDK maps itself, a define it sets itself — or otherwise behaves like an older SDK | `rk` prefers a running `rk server`, which executes the build with the tooling it loaded at startup, from whatever project it was started in. Reinstalling the app's packages cannot change code already resident in that process | `rk server status` to see it, `rk server stop` then start it again from this app, or pass `--local` to skip server discovery for one command |
| A package you import is missing at build time | pnpm does not hoist it in | Declare it in the app's own `package.json` |
| An import of `solid-js` does not resolve, or its API does nothing on the device | `solid-js` belongs to `@roku-sdk/solid`, not to the app, and only the re-exported part drives the SceneGraph renderer | Import from `@roku-sdk/solid` |

Every config field is typed with TSDoc in `@roku-sdk/sdk-config` — `UserSdkConfig`,
`UserSdkAppConfig`, `RokuManifestEntries`. Read a field there rather than guessing its name.
