---
name: roku-sdk-screen-navigation
description: "Use when an RSG SDK TypeScript app has to move between whole screens — mounting ScreenControllerProvider with the fallback it requires, pushing and popping a stack whose lower entries stay mounted, replacing the current screen instead of stacking it, releasing work when a screen is covered and restoring it when it is uncovered, passing data into a screen, and a pushed screen that shows the one underneath through it because the controller paints no background of its own. Not focus or D-pad movement once a screen is up, which is focus-management; and not the app's layout or which packages it declares, which is project-setup."
# @roku-sdk/ai managed v=1 hash=7966c02b6bee0da2f512a2853d5234a89b7761b5552224e4c89f1737e484f37e skills=1 do-not-edit
---

# Moving between screens

## Overview

`@roku-sdk/navigation`'s screen controller owns which whole view is on screen. It offers two
styles that mix freely: a **stack**, where a pushed view layers over the previous one and the
one below stays mounted, and a **replace**, where the outgoing view is torn down.

Two things about it are not guessable from the API and cause most of the surprises. It renders
**no background of its own**, so a pushed view does not hide what is under it. And it exposes
**no hook** — a screen reads the context directly.

## When to Use

| If the request is | Then |
|---|---|
| Opening a whole view over another, and getting back to the first with its state intact | Here — the stack |
| Swapping the current view for a sibling, with the old one torn down | Here — replace |
| Dropping everything a viewer had open and returning to the app's starting view | Here — reset |
| Releasing work while a view is covered and resuming when it is on top again | Here — the cover callbacks |
| A pushed view through which the previous one is still visible | Here — the controller draws no background |
| Handing a value to the view being opened | Here — props on the factory's element |

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Focus or D-pad movement inside a view, or handing focus between regions of one | The `focus-management` skill | Screen routing is not a focus concern. Focus work starts once the view is up |
| A view that comes up blank with no crash and no stack | The `logging-and-errors` skill | That is a component that threw, not a navigation problem. The controller will happily mount a screen that renders nothing |
| A dialog or overlay over the current view | The `dialogs-and-modals` skill for its lifecycle, `sdk-components` for what it is made of | A dialog leaves the view underneath mounted *and* claims focus through a native modal. Pushing a screen does neither |
| The app's directory layout, or which packages it declares | The `project-setup` skill | The scaffold already lists `@roku-sdk/navigation`, so there is nothing to add before using this |
| Moving along a shelf or grid, or off its edge onto something else | The `flex-grid` skill | A grid owns its own movement keys and its own edges |

## Quick Reference

Read the context to get these. Every one is a member of the controller.

| Member | Does |
|---|---|
| `pushScreen(factory)` | Layers a view on top. The one below stays mounted, so its state survives |
| `popScreen()` | Drops the top one; the one below reappears untouched |
| `setScreen(factory)` | Replaces the top entry. **The outgoing instance is destroyed and its local state is gone** |
| `resetScreen(factory?)` | Clears the whole history. With no argument, lands on the provider's fallback |
| `getScreen()` | The element for the current stack, which the root scene renders |
| `onScreenCovered(callback)` | Fires when something is pushed over this view |
| `onScreenUncovered(callback)` | Fires when the thing above it is popped and it is top again |

`ScreenControllerProvider` takes `children` and a required `fallback` — the factory used when
the stack is empty, when an entry's factory is `null`, and when `resetScreen()` is called bare.

## Instructions

1. **Mount `ScreenControllerProvider` once, near the root, and give it a `fallback`.** The
   fallback is not an error path — it is the app's starting view, and three different calls
   land on it.

2. **Reach the controller with `useContext(ScreenControllerContext)`.** That is the whole
   access pattern. Its default value throws if it is read outside the provider, so a missing
   provider fails loudly rather than silently doing nothing.

3. **Choose the style by what should survive.** `pushScreen` / `popScreen` for drilling in and
   coming back, because the view underneath stays mounted and Solid keeps its state for free.
   `setScreen` for siblings — tabs, wizard steps — because only one should be alive.
   `resetScreen` to clear history.

4. **A pushed view does not hide the one below it.** The controller paints nothing, so unless
   the new view covers the screen with something opaque, the old one shows through. Either give
   the pushed view an opaque background, or set the lower one invisible from its
   `onScreenCovered`.

5. **Pass data as props on the element the factory returns.** The factory closes over whatever
   is in scope, so no parameter mechanism is needed. But those props are a **snapshot taken at
   navigation time** — mutating the source afterwards does not reach the mounted view. Pass an
   accessor when the view has to track a value that keeps changing.

6. **Register the cover callbacks from `onMount`.** They unregister themselves when the calling
   owner is disposed, so there is no matching teardown to write. What belongs in them is work
   that costs something while nobody is looking: polling, timers, heavy textures.

7. **Return to the start with `setScreen(null)` or a bare `resetScreen()`.** Both render the
   provider's fallback; `resetScreen()` also empties the history so there is nothing left to
   pop back to.

## Example

A provider, a list that drills in, and a details view that releases work while it is covered.

```tsx rsg-skill=complete
import { ScreenControllerContext, ScreenControllerProvider } from "@roku-sdk/navigation";
import { Component, createSignal, JSX, onMount, useContext } from "@roku-sdk/solid";

interface DetailsProps {
    itemId: string;
}

const DetailsScreen: Component<DetailsProps> = props => {
    const screens = useContext(ScreenControllerContext);
    const [live, setLive] = createSignal(true);

    onMount(() => {
        // Both callbacks unregister with this owner — nothing to undo by hand.
        screens.onScreenCovered(() => setLive(false));
        screens.onScreenUncovered(() => setLive(true));
    });

    return (
        <group>
            {/* Opaque, because the controller paints no background of its own. */}
            <rectangle width={1920} height={1080} color="0x101018FF" />
            <label text={`Details for ${props.itemId}`} translation={[96, 96]} />
            <label text={live() ? "streaming" : "paused"} translation={[96, 160]} />
        </group>
    );
};

const HomeScreen: Component = () => <label text="Home" translation={[96, 96]} />;

/** Renders whichever entries are on the stack. One of these, under the provider. */
const ScreenHost: Component = () => {
    const screens = useContext(ScreenControllerContext);
    return <group>{screens.getScreen()}</group>;
};

export const RootScene: Component = (): JSX.Element => (
    <ScreenControllerProvider fallback={() => <HomeScreen />}>
        <ScreenHost />
    </ScreenControllerProvider>
);

export { DetailsScreen };
```

Drilling in and coming back, from anywhere under the provider:

```tsx
import { ScreenControllerContext } from "@roku-sdk/navigation";
import { useContext } from "@roku-sdk/solid";

import { DetailsScreen } from "./details-screen";

const screens = useContext(ScreenControllerContext);

// `itemId` is captured here; changing it afterwards does not reach the mounted view.
const openItem = (itemId: string) => screens.pushScreen(() => <DetailsScreen itemId={itemId} />);

const goBack = () => screens.popScreen();
```

Going back is `popScreen()`, and the list returns with its position and focus intact because
it was never unmounted.

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| The previous view is readable through the one just opened | The controller renders no background, and the new view does not cover the screen | Give the pushed view an opaque background, or hide the lower one from its `onScreenCovered` |
| Coming back from a details view resets the list | `setScreen` was used where a drill-down was meant, so the list was destroyed | `pushScreen` to go in, `popScreen` to come back |
| A view shows a stale value that has since changed | Props on the factory's element are a snapshot at navigation time | Pass an accessor rather than the value |
| Memory and network keep growing as a viewer drills deeper | Every pushed view stays mounted and keeps working | Release what is expensive from `onScreenCovered` and restore it from `onScreenUncovered` |
| Reading the controller throws on mount | The component is outside the provider | Mount `ScreenControllerProvider` above it. The throw is deliberate — a silent no-op would be worse |
| Back leaves the app instead of returning | Nothing was on the stack to pop, so the key reached the platform | Push before expecting to pop, and treat the fallback as the floor |
| Sibling tabs slow down as the viewer cycles them | Each tab was pushed, so they accumulate | `setScreen` for siblings — only one should be alive |

Provider and context types are exported from `@roku-sdk/navigation` and documented with TSDoc
there — `IScreenControllerContext` and `IScreenControllerProviderProps`. Read a member's exact
signature there rather than inferring it from here.
