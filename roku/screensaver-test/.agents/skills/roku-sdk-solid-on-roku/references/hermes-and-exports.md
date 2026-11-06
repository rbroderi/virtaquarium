<!-- @roku-sdk/ai managed v=1 hash=c402705d32c0808138f67190a183da88625223698e3478e2cc43b473128c63af skills=1 do-not-edit -->

# Hermes and the Export Surface

Two things the SDK does to ordinary Solid code before it runs: it withholds primitives the
runtime cannot carry, and it rewrites loops the engine would otherwise get wrong. The body names
every fact here; this file is the complete lists and the shapes.

## The compile pipeline, in order

```
TypeScript → Babel (babel-preset-solid) → block-scoping transform → Hermes bytecode
```

Order is the part worth holding on to. The block-scoping transform runs **after** Babel has
already turned components into reactive calls, so it operates on the emitted code rather than on
what was written. A closure Babel generated is treated exactly like one authored by hand.

## Why the loop transform exists

Hermes does not implement block scoping. `let` and `const` are hoisted to function scope and
behave as `var`, so every closure created in a loop would capture the same binding and observe
the final value.

```ts
// Authored — correct everywhere block scoping is real
for (let i = 0; i < 5; i += 1) {
    schedule(() => report(i));
}
// Without the transform, on Hermes: five closures, all reporting 5.
```

The transform restores per-iteration capture, so the ordinary shape is the correct one. Two
things follow:

- **Do not hand-write a wrapper** — an immediately invoked function around the loop body, or a
  `.forEach` used purely to get a fresh binding. It is redundant, and it hides the intent.
- **The fix is compile-time.** Code that never goes through the SDK's build — a snippet evaluated
  some other way — does not get it.

This is a workaround with an expiry: Hermes is gaining native block scoping, and the transform is
documented as removable once that lands. Treat the shape as permanent and the mechanism as not.

## Generator functions

Hermes does not support `function*` at all. This is not a gap in the transform — there is nothing
for it to transform into, which is why the transform explicitly does not handle `yield` inside a
loop.

```ts
// Not usable on the device
function* pages(): Generator<number> {
    for (let i = 0; i < 5; i += 1) {
        yield i;
    }
}
```

Replace with whichever fits:

- return the whole array when it is small enough to build eagerly;
- expose a closure over an index — `const next = () => items[cursor++]` — when it is not;
- use a signal for the cursor when the consumer is reactive.

## Excluded exports, with the reason for each

These exist in `solid-js` or `solid-js/store` and are **not** re-exported by `@roku-sdk/solid`.
Reaching past the package for one does not work: the reason is the runtime, not the packaging.

### Withheld because the platform cannot carry them

| Export | Reason | What to do instead |
|---|---|---|
| `createDeferred` | Solid's scheduler needs `MessageChannel`, which the Roku Hermes runtime does not have — the import fails with `ReferenceError: Property 'MessageChannel' doesn't exist` | Throttle the source signal, or derive from a signal you update on your own cadence |
| `lazy` | Dynamic `import()` against a static module system | Import statically; there is no split bundle to defer |
| `SuspenseList` | Coordinates several `<Suspense>` boundaries through the concurrent scheduler | Order the loading states yourself with ordinary signals |
| `enableScheduling` | Platform-specific scheduler wiring that has no Roku implementation | Nothing to enable |
| `enableHydration` | Server-side rendering, which does not apply here | Nothing to hydrate |
| `enableExternalSource` | A hook for bridging external reactive libraries; no current demand | Adapt the external source into a signal by hand |
| `onError` | Deprecated upstream | `catchError` — and for containing a throw at all, the `logging-and-errors` skill |

### Withheld as internals

Not part of the public API in `solid-js` either. If one of these looks necessary, the design
usually wants revisiting rather than the symbol.

| Export | Source |
|---|---|
| `equalFn` | `solid-js` |
| `getListener` | `solid-js` |
| `requestCallback` | `solid-js` |
| `cancelCallback` | `solid-js` |
| `sharedConfig` | `solid-js` |
| `createComponent` | `solid-js` |
| `$PROXY`, `$TRACK`, `$DEVCOMP` | `solid-js` |
| `isWrappable` | `solid-js/store` |
| `setProperty` | `solid-js/store` |
| `updatePath` | `solid-js/store` |
| `$RAW` | `solid-js/store` |

## What a development build substitutes

A development build sets `__DEV__`, and re-exports `createSignal`, `createMemo` and
`createEffect` from an instrumented module rather than from the reactive core. The wrappers record
reactive activity for tooling; semantics match, timing does not.

The consequences worth acting on:

- **Never measure performance on it.** Every signal read and write carries bookkeeping the
  shipped build does not.
- **Never depend on the instrumentation existing.** Code that reads what the wrappers record
  compiles fine and does nothing in the build you ship.
- **A behavioural difference between the two builds is worth reporting**, since the wrappers are
  meant to be transparent.

## The placeholder node behind a fallback-less conditional

SceneGraph has no text nodes, but the universal renderer asks for one to hold a position. The
SDK's renderer answers that by creating an empty `group`: childless, zero-size, no layout effect.
The warning path is only for *non-empty* text, so a positional placeholder is silent.

It appears in one situation: a conditional with no `fallback`, rendering falsy, as a direct child
of a real element **with siblings** — the compiler needs a marker to know where the content goes
when it comes back. Inside a fragment there is no marker and no placeholder, because a fragment
compiles to an array.

Each placeholder is its own node, and that is deliberate — the renderer tracks children by object
identity and a node has one parent, so a shared placeholder would corrupt positional tracking for
every conditional after the first. The cost is one node creation and one append, against the
hundreds a screen makes for real content.

So: leave `fallback` off when there is nothing to show. Add one when there is.
