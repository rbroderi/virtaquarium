<!-- @roku-sdk/ai managed v=1 hash=ced1a392bb6317ae5791345390f1ccc1acaa93ecdd4b9727968052f8bc5e84b9 skills=1 do-not-edit -->

# Async and timing in a component test

The symptom is always the same: an assertion reads a prop, gets the value from before the
thing that was supposed to change it, and the app is demonstrably correct when run. The
cause is that renders are committed in a batch. A prop write does not land on the node the
moment the signal changes; it is queued, and the queue is flushed on a commit. Between
those two points the tree still holds the old value, and a query run there reads it.

`render` and `fireEvent` both await that flush for you, which is why most tests never meet
this. It surfaces where the change is triggered by something else.

## The two fixes, in order of preference

**1. Await the call that caused the change.** Both entry points are already async and
already flush:

```tsx
import { render, TestAnchorNode } from "@roku-sdk/testing-library";

import App from "./app";

const TestApp = TestAnchorNode(App);

const view = await render(() => <TestApp />);
await view.fireEvent(view.getByTag("key-handler"), "onKeyEvent", { key: "right", press: true });
// The tree is committed here. Assert directly.
view.getByProp("text", "Focused: 1");
```

An un-awaited `fireEvent` is the single most common source of a stale read, and it is
silent: the call still fires, the assertion still runs, and it simply runs early.

**2. Flush explicitly with `transaction()`** when the change came from somewhere the test
did not await — a signal the test set directly, a callback the component invoked, a promise
the component under test kicked off:

```tsx
// Same `view` as above.
setItems(["a", "b"]);
await view.transaction();
view.getByProp("text", "2 items");
```

`transaction()` resolves when the queued commit has been applied. That is all it does. It
does not wait for a network call, a timer, or any promise the component is holding, so it
is the fix for a batching problem and never for a slow one.

## There is no `waitFor` and no `findBy*`

This library ships neither, deliberately: both exist to paper over an unknown settling time,
and in a tree with an explicit commit there is not one to guess at. If an assertion needs a
retry loop, something in the component is genuinely asynchronous, and the test should await
that thing rather than poll the tree. Expose it — resolve a promise the test holds, or call
a callback the test passed in — and await that, then `transaction()`.

Where a component's own promise cannot be reached, yielding to the microtask queue before
flushing is the honest last resort, and it belongs in the one test that needs it rather
than in shared setup:

```tsx
await Promise.resolve();
await view.transaction();
```

## Fake timers do not flush a commit

The commit is scheduled as a microtask, not on a timer, so `jest.advanceTimersByTime` does
not make a queued prop write land. A test with fake timers on still awaits the flush the
same way every other test does:

```tsx
import { render, TestAnchorNode } from "@roku-sdk/testing-library";

import App from "./app";

const TestApp = TestAnchorNode(App);

jest.useFakeTimers();

const view = await render(() => <TestApp />);
jest.advanceTimersByTime(5000);
// The timer's callback ran; its effect on the tree has not landed yet.
await view.transaction();
view.getByProp("text", "Timed out");
```

The shared Jest setup in `@roku-sdk/dev-tools` leaves real timers in place and restores them
after each test that turns them on, so a test opts in and does not have to clean up by hand.
Opt in only when the component reads the clock. For a value that is merely late, fake timers
are the wrong tool: the commit is not waiting on a timer, so advancing one changes nothing.

## Disposal is part of timing

`dispose()` tears the tree down. It is Solid's disposer and returns nothing, so there is
nothing to await. Skipping it leaves a live tree behind, and the reactive work it is still
doing lands during whichever test runs next — which is why "passes alone, fails in the
suite" is nearly always a missing `dispose`, and why the failure names the wrong test.
