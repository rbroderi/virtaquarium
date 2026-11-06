---
name: roku-sdk-sdk-installation
description: "Use when @roku-sdk packages must be installed from npmjs.com or their versions have to move — public pnpm installs that need no token, an install that succeeds locally but fails in CI, a package publishing major lines under separate dist-tags, a peer dependency an SDK package requires the app to declare, and checking registry configuration and the lockfile to prove where packages resolve. Not for a package the app lists because its own code imports it, or how a scaffolded app is configured, which is the project-setup skill's subject."
# @roku-sdk/ai managed v=1 hash=0b90501c1652947cfd87e5f47e123f2f35b9fa962f6ba0ce01045f8fb0c4ff39 skills=1 do-not-edit
---

# SDK Installation

## Overview

Stable `@roku-sdk/*` packages install from registry.npmjs.org with ordinary pnpm
commands. No registry override or token is needed. Check the effective registry,
requested version and lockfile when an install fails; adding authentication is
not the fix for a public package.

## When to Use

- a first install into a project that has none of the SDK yet
- pnpm cannot find an `@roku-sdk` package, or returns 401 or 404 for that scope
- an install succeeds locally but fails on another machine or in a pipeline
- moving SDK versions or staying on a package's older major line
- satisfying a peer dependency or avoiding duplicate reactive runtimes
- confirming where installed packages resolved

### When not to use

| Situation                                                                      | Use instead                                                                   | Because                                                                 |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A package the app lists because its code imports it, or configuring a scaffold | The `project-setup` skill                                                     | That starts once packages resolve; a package's required peers stay here |
| A resolved package's API does not behave as expected                           | The skill for that area                                                       | Installation is finished                                                |
| A different company's private registry                                         | That registry's documentation                                                 | This skill covers public SDK consumption                                |
| Signing or publishing an app                                                   | The `app-packaging` skill                                                     | That ships an app outwards; this brings dependencies in                 |
| Releasing the SDK itself or obtaining a prerelease                             | The release process or preview access instructions supplied by the maintainer | npmjs.com carries stable releases; this is the stable consuming side    |

## Quick Reference

| Goal                               | Do                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| Install stable packages            | `pnpm add @roku-sdk/components` — registry.npmjs.org, no token                   |
| Check the effective package source | `pnpm config get registry` and `pnpm config get @roku-sdk:registry`              |
| Check a published version or tag   | `pnpm view @roku-sdk/flex-grid dist-tags`                                        |
| Stay on an older major             | Use `^2.0.0`; older patches may use `latest-2.16`, but confirm it exists |
| Verify installed versions          | Inspect `pnpm-lock.yaml` and run `pnpm list`                                     |
| Satisfy FlexGrid's peers           | Declare all six in the app's `package.json`, including `@roku-sdk/runtime`       |
| Install in CI                      | `pnpm install --frozen-lockfile`; public installs need no auth token             |

## Instructions

1. **Install from the public registry.** Use Node 24 or later and pnpm 11.
   If the SDK packages are already listed in `package.json`, run `pnpm install`;
   otherwise use `pnpm add` to declare them. No project registry file or token
   setup is required for stable SDK packages.

2. **Check effective configuration before fixing a 401 or 404.** The default
   registry should be `https://registry.npmjs.org/`. An unset `@roku-sdk:registry`
   uses that default; an obsolete scope override still wins over it. Remove
   stale overrides or authentication settings from the configuration that owns
   them. Verify the requested package, version and dist-tag with `pnpm view`.
   A public install does not need a new read token.

3. **Check local and CI environments separately.** A runner can inherit
   different user or environment registry configuration even with identical
   repository files. Match Node/pnpm versions, confirm access to
   registry.npmjs.org, and use the committed lockfile with `--frozen-lockfile`.
   Do not add a CI authentication step for public packages.

4. **Transitive packages install automatically; required peers are different.**
   Which dependencies the app lists because it imports them is `project-setup`.
   A package's peer contract is this skill's subject: inspect it with
   `pnpm view @roku-sdk/flex-grid peerDependencies`.

5. **Move packages released together together.** Keep a shared version range
   across the coordinated SDK packages. A package on an independent major line,
   such as FlexGrid, has its own version, but its peer ranges still require
   compatible SDK versions.

6. **Prefer a semver range over a moving dist-tag for a major line.** `^2.0.0`
   receives compatible 2.x fixes and cannot select 3.x. A stable line can have
   a tag such as `latest-2.16` for older patches; newest-line releases carry only
   `latest`. Check the published tags before installing by one.
   FlexGrid 3.x owns `latest`, while its 2.x maintenance tag is `maintenance-2x`.
   Read the package's `BREAKING_CHANGES.md` before changing majors. Prerelease
   channels are not available on npmjs.com.

7. **Declare all of FlexGrid's peers in the app.** They are `@roku-sdk/common`,
   `@roku-sdk/components`, `@roku-sdk/interfaces`, `@roku-sdk/navigation`,
   `@roku-sdk/runtime` and `@roku-sdk/solid`. They let the app own one shared
   reactive runtime. Satisfy the floors declared by the selected grid release
   rather than upgrading the grid alone.

8. **Verify the lockfile, not just the install's exit code.** Check the
   `@roku-sdk/*` versions and integrity entries in `pnpm-lock.yaml` against the
   installed tree. Packages should resolve from registry.npmjs.org. Modern
   pnpm lockfiles usually omit download URLs and derive the registry from
   configuration: no host string is not evidence of failure. If an older entry
   explicitly points elsewhere, remove its obsolete registry override and run
   `pnpm install --registry https://registry.npmjs.org`, then review the lockfile
   diff. Do not hand-edit integrity hashes or introduce tarball URLs.

## Example

In a consumer app with no SDK dependencies yet:

```bash
pnpm add @roku-sdk/rsg-ts @roku-sdk/components @roku-sdk/solid @roku-sdk/tooling
pnpm config get registry
# Expected: https://registry.npmjs.org/
pnpm config get @roku-sdk:registry
# Unset is normal: the scope uses the default registry.
pnpm view @roku-sdk/rsg-ts version --registry https://registry.npmjs.org
pnpm list @roku-sdk/rsg-ts @roku-sdk/components
```

Review the `@roku-sdk/*` entries in `pnpm-lock.yaml`, then commit it with
`package.json`. A CI runner installs the same tree with:

```bash
pnpm install --frozen-lockfile
```

For the exact exports and peer contract of an installed package, inspect its
`package.json` and typed source under `node_modules/@roku-sdk/`.

## Common Mistakes

| Symptom                      | Cause                                                       | Fix                                                                                            |
| ---------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 401 for public SDK packages  | Unexpected registry or stale authentication configuration   | Check default and scoped configuration on that machine; use registry.npmjs.org without a token |
| 404 or no matching version   | Misspelled package or unpublished version/tag               | Inspect `pnpm view`; use a published stable version                                            |
| Works locally, fails in CI   | Different configuration, network access or toolchain        | Check the runner's effective registry and Node/pnpm versions; no public read token is needed   |
| Frozen lockfile mismatch     | Dependency declarations changed without the lockfile        | Update locally and commit both files                                                           |
| Lockfile has no registry URL | Current pnpm stores integrity and versions rather than URLs | Check effective registry configuration and installed versions, not a grep's empty output       |
| Unrequested major upgrade    | A moving dist-tag was used instead of a range               | Pin the intended major with a range; confirm tags before deliberate one-off installs           |
| Duplicate reactive runtime   | Required peers were omitted or incompatible                 | Declare all six FlexGrid peers and satisfy their ranges                                        |
| `workspace:*` cannot resolve | The app is outside the SDK workspace                        | Replace workspace ranges with published versions                                               |
