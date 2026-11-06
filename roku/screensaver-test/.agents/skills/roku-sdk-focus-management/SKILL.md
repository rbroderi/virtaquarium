---
name: roku-sdk-focus-management
description: "Use when D-pad focus in an RSG SDK TypeScript app has to be wired or is not behaving — reaching for FocusBoundary or useFocusable, deciding where an OK press on the focused item is handled, showing focus state on a row or list and dimming the items that are not focused, handing focus between regions built out of FocusBoundary, holding focus inside a dialog, or focus that lands on the wrong node. Not for a region a FlexGrid owns: that grid claims the movement keys itself, so its edges and its focus belong to the flex-grid skill."
# @roku-sdk/ai managed v=1 hash=6b43301459155a0766b793fa55b152140fd4a53631ff5b5c06b523051fb24065 skills=1 do-not-edit
---

# Focus Management

## Overview

D-pad focus in an RSG SDK TypeScript app is virtual: one SceneGraph node holds real focus
for the whole screen, and which item is focused inside it is a SolidJS signal, so moving
focus is a signal write rather than a SceneGraph call. `FocusBoundary` owns that state and
`useFocusable` registers the items that can hold it, both from `@roku-sdk/navigation`.

## Read the recipe first for two of these tasks

| If the request is | Read now, before answering |
|---|---|
| A dialog or overlay that holds focus while open and gives it back on close | `references/focus-recipes.md` → *Hold focus inside a dialog, and give it back* |
| Focus moving between regions on a key the layout does not already carry | `references/focus-recipes.md` → *Hand focus between regions of a screen* |

The tables below name the API for both, and stop there: the props you pass it, and where the
call has to sit for it to work at all, are only in the recipe. An answer assembled from a table
row is an invented one — so read the recipe and quote it, and never hand the pointer to the
user in place of an answer.

## When to Use

Use this whenever the question is which item is focused, or what a key press does to it:

- a menu, row, list or grid that has to respond to the D-pad
- highlighting the focused item and dimming the rest
- an OK press that must act on the focused item
- handing focus between regions of a screen
- focus that starts on the wrong item, will not move, or is lost when the data changes
- an item that must be skipped while it is disabled

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| An overlay you draw yourself out of ordinary nodes | `ModalBoundary` + `useModal` from `@roku-sdk/components`, wired from `references/focus-recipes.md` | It already implements enter on open, dismiss on `back`, and restore on close |
| A `StandardDialog` | The `sdk-components` skill for what it is made of; nothing here for its focus | It renders a native SceneGraph modal, so focus enters and returns on its own. Point `initialFocusId` at the first button and leave `focusActive` alone — an enclosing `FocusBoundary` deactivates itself while it is up |
| A region a `FlexGrid` owns — its edges, its cells, its keys | `@roku-sdk/flex-grid`'s own `onEdgeReached` | The grid claims seven keys from the boundary — up, down, left, right, `OK`, `fastforward` and `rewind` — and by default consumes them whether or not they moved anything, so `onUnhandledKey` never sees one and a hand-off written there is dead code. `declineUnhandledNavigation: true` on the grid is the exception: claimed keys that moved nothing then do bubble |
| BrightScript component interop: `nextFocusUp`, `onFocusedChild`, focus driven on the render thread | `FocusableGroup` / `Focusable` | Those need real SceneGraph focus. It is a legacy path — do not start new work there |
| Imperative key routing the user asked for by name, or that is already in the file | `KeyHandler` | Every key costs a BrightScript round trip and movement logic ends up per component |
| Opening and closing a dialog from elsewhere in the app, telling a viewer's choice from a dismissal, or chaining several dialogs | The `dialogs-and-modals` skill | Holding focus while an overlay is up is this skill's job; deciding which overlay is up and what its close means is not |
| Moving between whole screens | The `screen-navigation` skill | Screen routing is not a focus concern; focus work starts once the screen is up |

## Quick Reference

| Operation | API |
|---|---|
| Wire a screen for focus | `RootFocusBoundary` with `keyEvent`, `focusActive` and `setHandledKeys`, on an anchor node extending `FocusBoundaryBase` |
| Make an item focusable | `useFocusable()`, then attach the returned `ref` and read `isFocused()` |
| Act on OK on the focused item | `onKey: { OK: onPress(() => …) }` in `useFocusable` |
| Name a key without memorising its runtime string | `RemoteKey` from `@roku-sdk/interfaces` — `onKey: { [RemoteKey.Select]: … }`. Four members read differently from the string they carry: `Select` is `"OK"`, `Fwd` is `"fastforward"`, `Rev` is `"rewind"`, `Info` is `"options"`. Bare strings stay valid |
| Move on up/down, left/right, or all four | `navigation="vertical"`, `"horizontal"`, `"grid"` on the boundary |
| Route movement in an irregular layout | `navigationMap`: a `Map` from each identity to its neighbour per direction |
| Add a second region to a screen | A nested `FocusBoundary` with a `focusId` that the parent's `initialFocus` names |
| Skip an item while it is disabled | `canReceiveFocus: () => !disabled()` |
| Move focus from app logic | `useFocusActions()` → `setFocus(id)`; `focusedId()` to read it |
| Act on a key nobody handled, such as `back` | `onUnhandledKey` on the boundary |
| Reopen a region at its first item | `rememberLastFocus={false}` — the default `true` restores the last item |
| Mark the item an inactive region will return to — dialog open, or focus in another region | `hasFootprint()` from `useFocusable`; `hasReturnFootprint()` when nested regions or `rememberLastFocus={false}` must mark only where focus will land, and `useFocusActions().hasReturnFootprint()` for the region itself |

## Instructions

`@roku-sdk/navigation` is not in the set `rk create` installs. Add it to the app's own
`package.json` first — `workspace:*` inside the SDK's pnpm workspace, otherwise the version the
app's other `@roku-sdk/*` packages are on — or every import below fails to resolve.

1. **Wire the screen once.** Give the screen's anchor node `extends: "FocusBoundaryBase"`,
   `keyEvent` and `focusActive` as input fields and `handledKeys` as an output field, then
   pass all three to `RootFocusBoundary`. Without this no key reaches TypeScript and nothing
   moves. One per anchor node — never give a nested boundary its own `keyEvent`.

   For TypeScript descriptors, keep `FocusBoundaryBase`: registration selects the native
   component when firmware reports `hasFeature("focusBoundaryBase")`, otherwise
   `FocusBoundaryBaseShim`. XML/BrightScript does not go through that remap: extend or
   create `FocusBoundaryBaseShim` by name to keep working on existing firmware.

2. **Wrap each region in a `FocusBoundary`** and set `navigation` to the axis the region
   moves on. Nest a region by giving it a `focusId` that its parent's `initialFocus` or
   `navigationMap` names.

3. **Point `initialFocus` at something registered in that same boundary** — a child's
   `useFocusable({ focusId })` identity, or a nested boundary's `focusId`. An identity
   registered one level further down never matches, and focus starts nowhere.

4. **Call `useFocusable()` in every item that can hold focus**, attach the returned `ref` to
   the item's root node, and put the item's own keys in `onKey`. Use `onPress` / `onRelease`
   to fire on one edge instead of guarding `press` by hand.

5. **Leave directional keys to the boundary.** A leaf handles OK and its own keys; up, down,
   left and right are the boundary's job, so do not add them to a leaf's `onKey`.

6. **Read `isFocused()` inside JSX** or another reactive scope, and never destructure
   `props`. Reading either once at the top of a component captures a value that never
   updates again.

7. **Iterate with `<For>`**, never `items.map()`. `map` recreates every child when the array
   changes, which unregisters the focused item and drops focus.

8. **Create a `focusId` only when something names it** — `initialFocus`, a `navigationMap`
   entry, `setFocus`, a `focusedId()` comparison, or a `FlexGrid` `focusId`. Every other
   item gets one automatically, and linear navigation follows registration order.

## Example

A screen wired end to end: the anchor node, one vertical region, three rows, per-row OK
handling, and focus styling driven by `isFocused()`.

```tsx rsg-skill=complete
import { Group, Label, Rectangle } from "@roku-sdk/components";
import { FocusBoundary, onPress, RootFocusBoundary, useFocusable } from "@roku-sdk/navigation";
import { type AnchorNodeImplementation, defineAnchorNode, FieldType } from "@roku-sdk/rsg-ts";
import { For } from "@roku-sdk/solid";

const MainSceneDescription = {
    componentName: "MainScene",
    extends: "FocusBoundaryBase" as const,
    inputFields: {
        keyEvent: FieldType.Object(),
        focusActive: FieldType.Boolean(true)
    },
    outputFields: {
        handledKeys: FieldType.Object(),
        exitApp: FieldType.Boolean()
    }
};

// Two identities this screen names: the region the root boundary starts in,
// and the row that region starts on.
const menuId: object = {};
const homeRowId: object = {};

interface Item {
    label: string;
    disabled?: boolean;
    focusId?: object;
}

const ITEMS: Item[] = [
    { label: "Home", focusId: homeRowId },
    { label: "Search" },
    { label: "Settings", disabled: true }
];

function MenuRow(props: { item: Item; y: number; onSelect: (label: string) => void }) {
    const { ref, isFocused } = useFocusable({
        focusId: props.item.focusId,
        onKey: { OK: onPress(() => props.onSelect(props.item.label)) },
        canReceiveFocus: () => !props.item.disabled
    });

    return (
        <group ref={ref} translation={[0, props.y]}>
            <rectangle width={480} height={72} color={isFocused() ? "0x0055FFFF" : "0x1A1A1AFF"} />
            <label
                text={props.item.label}
                translation={[24, 20]}
                color={isFocused() ? "0xFFFFFFFF" : "0x8A8A8AFF"}
            />
        </group>
    );
}

const MainScene: AnchorNodeImplementation<typeof MainSceneDescription> = (inputs, outputs) => (
    <RootFocusBoundary
        keyEvent={inputs.keyEvent as Parameters<typeof RootFocusBoundary>[0]["keyEvent"]}
        focusActive={inputs.focusActive as boolean}
        setHandledKeys={outputs.handledKeys}
        initialFocus={menuId}
        onUnhandledKey={{ back: onPress(() => outputs.exitApp(true)) }}
    >
        <FocusBoundary focusId={menuId} initialFocus={homeRowId} navigation="vertical">
            <For each={ITEMS}>
                {(item, index) => (
                    <MenuRow item={item} y={index() * 88} onSelect={label => openScreen(label)} />
                )}
            </For>
        </FocusBoundary>
    </RootFocusBoundary>
);

function openScreen(label: string): void {
    // app logic for the selected row
}

export default defineAnchorNode(MainSceneDescription, MainScene);
```

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| Nothing moves and no handler fires | The anchor node is not wired, or the items have no boundary above them | `extends: "FocusBoundaryBase"`, `keyEvent` in, `handledKeys` out |
| The focus fields were added, but `inputs.keyEvent` and `outputs.handledKeys` come out untyped | The scaffold annotates the descriptor `: AnchorNodeDescriptor`, which widens the field maps, and `AnchorNodeImplementation<typeof …>` derives its types from what `typeof` still knows | Drop the annotation and keep `as const` on `extends`, as the example does — the descriptor should be inferred, not declared |
| The screen compiles but the app's `.test.tsx` stops compiling the moment the anchor node is wired: `Type '{}' is not assignable`, missing `keyEvent` and `focusActive` | `TestAnchorNode` derives the test component's props from the descriptor's field maps, so the three focus fields are now required props of it — the scaffolded `<TestApp />` passes none | Pass all three: `<TestApp keyEvent={{}} focusActive={true} handledKeys={() => undefined} />` — render `keyEvent` from a signal when the test has to press a key |
| `'Row' cannot be used as a JSX component. Its return type 'Component' is not a valid JSX element` | A focusable leaf was annotated `function Row(props): Component`. `Component` is the type of the function, not of what it returns | Annotate the value — `const Row: Component<Props> = props => …` — or leave the return type inferred, as the example does |
| OK works but the arrows do nothing | Wrong axis on `navigation`, or a `navigationMap` with that direction unmapped | Set the axis the region moves on; unmapped directions are deliberately not claimed |
| Focus drops whenever the list updates | `items.map()` in the JSX | Use `<For>` |
| The highlight never changes | `isFocused` read outside a reactive scope, or `props` destructured | Read it inside JSX, `createMemo`, `createEffect` or a callback |
| Focus starts nowhere, and even `onUnhandledKey` is dead | `initialFocus` names an id registered deeper than this boundary, or one nothing registered | Point it at a direct child: a leaf's `focusId`, or a nested boundary's `focusId` |
| Focus jumps back, or fights the keys | `gainFocus` on a SceneGraph node while the boundary is also moving focus | Inside a boundary, move focus with `setFocus` only |
| One item is never reachable | Its `canReceiveFocus` returns false | Check the condition — a disabled item is skipped by design |
| A whole branch looks unfocused — behind an open dialog, or once another region has focus | By design: `isFocused()` is `isActive() && focusedId() === focusId`, so it is false throughout an inactive branch, and false everywhere when `focusActive` is false | Draw the "focus returns here" marker from `hasFootprint()` |
| Two regions react to one key, or a nested region steals keys | A nested boundary was given `keyEvent` | Only the root boundary gets it |
| Focus is lost when app state changes | Focus state is held in app state and the subtree is rebuilt from it | Let the boundary own focus; read `isFocused()` |
| A handler armed something on key-down and the key-up never arrived, so a hold never ends | A release is routed by focus *at key-up time*, and focus moved while the key was held — something now in the path claimed the release, or the key left `handledKeys` and BrightScript filtered it out | Set `captureKeyPress` on the boundary that owns the handler: a consumed press is bound to it and the release is delivered there directly. `FlexGrid` exposes the same flag |

Props and options are typed with TSDoc in `@roku-sdk/navigation` — `IRootFocusBoundaryProps`,
`IFocusBoundaryProps`, `UseFocusableOptions`, `FocusActions`. Read a prop there rather than
guessing its name.
