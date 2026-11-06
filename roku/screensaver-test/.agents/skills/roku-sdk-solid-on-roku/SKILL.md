---
name: roku-sdk-solid-on-roku
description: "Use when SolidJS code in an RSG SDK TypeScript app has to match what this platform ships rather than what the framework documents — an import of createDeferred, lazy or SuspenseList that @roku-sdk/solid deliberately does not re-export because the Roku runtime cannot support it, why reading the anchor node's inputs whole subscribes an effect to every field and what the untrack there is for, a let or const inside a loop behaving as if it were var, a generator function the build will not transform, a development build whose createSignal is not the one the release build runs, and whether Show needs a fallback. Not for handling something that threw, which is the logging-and-errors skill; not for a stale read in a test assertion, which is testing; and not for which component draws a thing or how focus and keys are wired, which are sdk-components and focus-management."
# @roku-sdk/ai managed v=1 hash=d40c39dd6a097a8e416f3e5c6849c90295ccf9d2aba74ee1262b2bb9ed12bb82 skills=1 do-not-edit
---

# Solid on Roku

## Overview

An RSG SDK TypeScript app is a SolidJS app whose reactivity is unchanged and whose
*surroundings* are not: primitives that need a browser scheduler are not re-exported, the engine
running the code hoists `let` like `var`, a development build swaps three primitives for
instrumented ones, and the anchor node hands the app its input fields as signal getters rather
than as a plain object. This skill is the seam — what the platform does differently from what the
SolidJS documentation describes.

## When to Use

Use this when Solid code is correct by the framework's rules and the platform disagrees:

- an import from `@roku-sdk/solid` that does not resolve, for a primitive `solid-js` documents
- an anchor node input field read once that never changes again, or an effect that re-runs on
  fields it never named
- a `let` or `const` inside a loop behaving as if it were `var`
- a generator function the app cannot use
- a signal that behaves one way under a development build and another under a shipped one
- a conditional element with no fallback, and whether SceneGraph's lack of text nodes makes that
  unsafe

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Handling or recovering from something that threw | The `logging-and-errors` skill | This skill owns which primitives exist, not what to do when one of them throws |
| An assertion reading stale state in a test | The `testing` skill | When effects flush under a test harness is a testing concern, not a platform one |
| Which node draws a thing, or what to pass it | The `sdk-components` skill | Reactivity is the same question everywhere; the component surface is its own |
| Which item is focused, or what a key press does | The `focus-management` skill | Focus is a signal, but which signal and who owns it is that skill's whole subject |
| Which package a Solid import comes from, and declaring it | The `project-setup` skill | Import every primitive from `@roku-sdk/solid`, never `solid-js` — that rule and the `package.json` it needs live there |

## Read the reference first for two of these tasks

| If the request is | Read now, before answering |
|---|---|
| The build rejected a module, or a transform did something to it that has to be explained | `references/hermes-and-exports.md` |
| Whether a specific `solid-js` symbol exists here, beyond the ones named below | `references/hermes-and-exports.md` — the full excluded table, with a reason per row |

The tables below name every fact; the reference carries the shapes and the complete lists. An
answer that needs one exact symbol should not open the file.

## Quick Reference

| Question | Answer |
|---|---|
| Where do primitives come from | `@roku-sdk/solid`, always |
| What is missing, and why | `createDeferred` (needs `MessageChannel`), `lazy` (needs dynamic `import()`), `SuspenseList` and `enableScheduling` (need the concurrent scheduler), `enableHydration` (SSR), `onError` (deprecated upstream), plus thirteen `solid-js` internals |
| Reading an anchor node input | Name the field inside a reactive scope: `createMemo(() => inputs.title)` |
| Why a top-level read of `inputs` never updates | The component function is invoked inside `untrack`, so nothing read while it runs subscribes |
| Why an effect re-runs on fields it never named | Every field is an **enumerable** getter, so spreading, `Object.keys` + read, or stringifying `inputs` subscribes to all of them |
| Why `inputs.title` is `possibly 'undefined'` | The inputs type is `Partial`, though a declared field always holds its descriptor default at runtime — restate the default: `inputs.title ?? "Loading"` |
| `let` in a loop | Hermes hoists it to function scope; the SDK's block-scoping transform restores per-iteration capture |
| Generator functions | Not usable — Hermes does not support them, so no transform covers them |
| What a development build changes | `createSignal`, `createMemo` and `createEffect` are instrumented wrappers, and `__DEV__` is set |
| A conditional with no fallback | Safe. Between siblings the renderer's `createTextNode("")` returns an empty `group` to hold the position; as a sole child there is no node at all |
| Reading a prop | Inside JSX, `createMemo`, `createEffect` or a callback — never destructured, never once at the top |

## Instructions

1. **Import every primitive from `@roku-sdk/solid`.** It re-exports the part of `solid-js` that
   works under the SceneGraph renderer, plus the SDK's own symbols. `project-setup` owns the
   dependency rule; what matters here is that a primitive absent from this package is absent on
   purpose, and the reference gives the reason for each one.

2. **Do not reach for a missing primitive's `solid-js` original.** Installing `solid-js` beside
   the SDK gives you a second reactive graph, not the missing feature — and the feature is missing
   because the runtime cannot carry it. For a deferred value, throttle the *source* signal
   yourself, with the SDK's own timing helpers; for code splitting, there is none to do, since the
   module system is static. Do not substitute a browser scheduling or frame-timing API either —
   this is not a browser, and none of them exist here.

3. **Read anchor node inputs by naming one field, inside a reactive scope.** Each input field is
   an enumerable getter over its own signal, so `inputs.title` inside a `createMemo` subscribes to
   `title` alone. Two consequences follow, and they pull in opposite directions:
   - A read at the top of the component body subscribes to **nothing** — the body is invoked
     inside `untrack` — so the value is whatever it was at construction, forever.
   - A read that touches the object *as a whole* inside a tracking scope subscribes to
     **everything**. Spreading it, iterating its keys, or putting it in a log line does this.

   The inputs type is `Partial`, so every field reads as possibly `undefined` even though a
   declared field always holds its descriptor default. Restate that default at the read —
   `inputs.title ?? "Loading"` — rather than asserting non-null.

4. **Never destructure `props`, and never read `props.x` once at the top of a component.** The
   compiler passes a component's props as an object of memoized getters, so a read is a call and
   destructuring calls each one immediately and keeps the value. Read inside JSX, `createMemo`,
   `createEffect` or a callback. `splitProps` and `mergeProps` are the sanctioned exceptions.

5. **Write loops as you would anywhere, and know why they work.** Hermes hoists `let` and `const`
   to function scope, which would make every closure created in a loop share one variable. The
   SDK's block-scoping transform runs after `babel-preset-solid` and restores per-iteration
   capture, so the ordinary shape is correct. Do not hand-write an immediately invoked wrapper to
   "fix" it.

6. **Do not use generator functions.** Hermes does not support them at all, so this is a language
   limit rather than a transform gap — and it is why the block-scoping transform does not handle
   `yield` inside a loop. Return an array, or expose a `next()` closure over an index.

7. **Assume a development build is not the build you ship.** It sets `__DEV__` and replaces
   `createSignal`, `createMemo` and `createEffect` with instrumented wrappers that record reactive
   activity. Behaviour matches, but timing and anything you measure through them do not — so never
   conclude a performance question from a development build, and never leave code that depends on
   the wrappers being there.

8. **Leave `fallback` off a conditional when there is nothing to show.** SceneGraph has no text
   nodes, so the universal renderer's `createTextNode("")` is answered with an empty `group`
   instead — childless, zero-size, and silent, because the renderer only warns for non-empty
   text. One is created to hold the position when a conditional between siblings renders
   nothing. Supplying a fallback purely to avoid it buys nothing.

## Example

An anchor node whose two input fields are written by the host while the app runs. It reads each
field by name inside a reactive scope, so each subscription is to one field.

```tsx rsg-skill=complete
import { Label, LayoutGroup, Rectangle } from "@roku-sdk/components";
import { type AnchorNodeImplementation, defineAnchorNode, FieldType } from "@roku-sdk/rsg-ts";
import { createEffect, createMemo, Show } from "@roku-sdk/solid";

const ProgressPanelDescription = {
    componentName: "ProgressPanel",
    extends: "Group" as const,
    inputFields: {
        title: FieldType.String("Loading"),
        progress: FieldType.Float(0)
    },
    outputFields: {
        settled: FieldType.Boolean()
    }
};

const ProgressPanel: AnchorNodeImplementation<typeof ProgressPanelDescription> = (inputs, outputs) => {
    // Naming one field subscribes to that field alone. Reading `inputs` as a whole
    // here — spreading it, or putting it in a log line — would subscribe to both.
    // Every field is typed optional, so restate the descriptor's default.
    const heading = createMemo(() => (inputs.title ?? "Loading").toUpperCase());
    const progress = createMemo(() => inputs.progress ?? 0);
    const barWidth = createMemo(() => Math.round(progress() * 600));

    createEffect(() => {
        if (progress() >= 1) {
            outputs.settled(true);
        }
    });

    return (
        <layoutGroup layoutDirection="vert">
            <label text={heading()} width={600} height={48} color="0xFFFFFFFF" />
            {/* No fallback: the renderer holds the position with one empty placeholder. */}
            <Show when={barWidth() > 0}>
                <rectangle width={barWidth()} height={8} color="0x0055FFFF" />
            </Show>
        </layoutGroup>
    );
};

export default defineAnchorNode(ProgressPanelDescription, ProgressPanel);
```

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| An import from `@roku-sdk/solid` does not resolve, though `solid-js` documents the symbol | It is one of the deliberately excluded exports | Read the reference's table for the reason and the alternative; do not install `solid-js` to get it |
| An anchor node input field holds its startup value forever | It was read at the top of the component body, which runs inside `untrack` | Read it inside `createMemo`, `createEffect` or JSX |
| An effect re-runs whenever any input field changes | The effect read `inputs` as a whole — a spread, a key iteration, or a log line — and every field is an enumerable getter | Name the one field the effect depends on |
| A component renders once with the right value and never updates | `props` was destructured, or read once into a local at the top | Read `props.x` inside a reactive scope; use `splitProps` when a subset is genuinely needed |
| `TS18048: 'inputs.x' is possibly 'undefined'` on a field the descriptor gives a default | The inputs type is `Partial`, so it is wider than the runtime | Restate the descriptor's default at the read — `inputs.x ?? <default>` — rather than `!` |
| A measurement taken around signals disappears from the shipped build | Those numbers came from the development build's instrumented `createSignal` / `createMemo` / `createEffect` | Measure the build you ship; treat the wrappers as a development aid only |
| A generator function fails on the device | Hermes has no generator support, and no transform adds it | Return an array, or expose a `next()` closure |
| A hand-written wrapper was added around a loop body to capture the index | The block-scoping transform already does this, after `babel-preset-solid` | Delete the wrapper and write the ordinary loop |
| A fallback was added to every conditional to avoid text nodes | `createTextNode("")` yields an empty `group` here, not a text node | Leave `fallback` off unless there is something to show |
| A node passed by reference, such as `effect={focused() ? <effect …/> : <effect …/>}`, is rebuilt on every change | The prop expression reads the signal itself, so each change builds a new node; a signal read by that node's own fields would update it in place | Hoist each node into a `const` and choose between them — the `effects` skill. This is about node-valued fields, not `fallback` or children, which are inline by design |

The `@roku-sdk/solid` export surface is enumerated in the package's own `EXPORTS.md`, including
the SDK-specific symbols this skill does not cover. Prefer it over any prose, including this file,
when the two disagree.
