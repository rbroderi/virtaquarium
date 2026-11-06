---
name: roku-sdk-sdk-components
description: "Use when the question is which @roku-sdk/components component draws a thing on screen in an RSG SDK TypeScript app, or how one is composed — a block of text, an image, a row of buttons, a busy indicator, a confirmation or alert dialog built from a StandardDialog and the named StdDlg area nodes that go inside it, layout with Group, LayoutGroup or MaskGroup, and which props a component needs before it renders anything at all. Not for a virtualized shelf or poster grid, not for focus, movement or the state that dims an unfocused item, and not for a Dynamic Component Library loaded at runtime, which the app-packaging skill routes."
# @roku-sdk/ai managed v=1 hash=353ccd12b9aeb68bbb82dc296e655c07a358d714a86800427cfdc7439d0b301c skills=1 do-not-edit
---

# SDK Components

## Overview

`@roku-sdk/components` is the package an RSG SDK TypeScript app draws with: mostly thin typed
wrappers over SceneGraph nodes, plus a few helpers that wrap no node at all. Everything here is
imported in source at compile time. A partner shipping a player as a separate component library
from a URL at runtime is a Dynamic Component Library — the `app-packaging` skill routes those, and
the API is `@roku-sdk/runtime/component-library`, not a `Poster`, `Label` or any other export from
this package. This skill answers "which one renders this", not "what are its props" — the props
ship as TSDoc in the consumer's own `node_modules`, and the last section says where.

## Read the reference first for these tasks

| If the request is | Read now, before answering |
|---|---|
| A dialog of any kind — a confirmation, a message, a prompt, anything modal | `references/dialogs.md` |

A dialog is composed from areas, each a separately named component, and the tables below do
not name them. Answer from the reference and quote it: a dialog assembled out of a `Group` and
some labels is the wrong answer even when it renders.

## When to Use

- choosing the component for a job: a block of text, an image, a row of buttons, a spinner
- laying a screen out with `Group`, `LayoutGroup` or `MaskGroup`
- a component that compiles and renders nothing, or renders in the wrong place
- deciding whether a component is the encouraged one for new work

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Focus, D-pad movement, or the state that dims an unfocused item | The `focus-management` skill | `Focusable`, `FocusableGroup`, `KeyHandler`, `ModalBoundary` and `useModal` are exports of this package that that skill owns outright. It also owns `FocusBoundary` and `useFocusable`, which live in `@roku-sdk/navigation` and are where new focus work goes |
| A virtualized shelf or poster grid in TypeScript | The `flex-grid` skill | That renderer owns its cells, its keys and its edges |
| Loading a component library from a URL at runtime, or referencing a node a partner shipped separately | The `app-packaging` skill, which routes to `documentation/core-concepts/dcl.md` and `@roku-sdk/runtime/component-library` | The words "component library" name a delivery mechanism. None of the exports below are fetched from a URL at runtime |
| Deciding *when* a dialog is up, what the caller learns when it closes, or a flow of several dialogs in sequence | The `dialogs-and-modals` skill | This skill owns what a dialog is made of. Which one is showing, and what its close means to the code that opened it, is app state above the component |
| Scaffolding, dependencies, `roku-config.ts`, where an image file lives | The `project-setup` skill | This skill starts once the app renders |
| Rounded corners, a border or a gradient on a `Rectangle` or `Poster` | The `effects` skill | An `Effect` is wired through a prop rather than rendered, and where it is created, how it is shared and animated, and which devices draw it are all there |

## Quick Reference

| Job | Reach for | Give it |
|---|---|---|
| Position or group children | `Group` | Nothing — it draws nothing itself |
| Stack children in a row or column | `LayoutGroup` | `layoutDirection`, `itemSpacings` |
| A solid block of colour | `Rectangle` | `width`, `height` (`color` defaults to white) |
| Clip or fade children against a shape | `MaskGroup` | `maskUri` |
| Rounded corners, a border, or a gradient on a surface | `Effect`, whose wiring this row deliberately does not repeat | The `effects` skill — an effect is passed through a prop, and the rules for it live there |
| One line of text | `Label` | `text` |
| Text positioned by its own centre or edge | `SimpleLabel` | `text`, `horizOrigin`, `vertOrigin` |
| Text too long for its box that should march past | `ScrollingLabel` | `text` |
| A synopsis in a fixed box the user scrolls | `ScrollableText` | `text`, `width`, `height` |
| Text with inline styled runs | `MultiStyleLabel` | `text`, `drawingStyles` |
| A typeface | `Font`, whose props this row deliberately does not repeat | The `fonts-and-glyphs` skill — a typeface is wrong without its size and its fallback, and shipping one needs the import contract that lives there too |
| An image | `Poster` | `uri`, plus `loadDisplayMode` when it has to fit a fixed box |
| One button | `Button` | `text`, and `showFocusFootprint` when it is not inside a `ButtonGroup` |
| A row or column of buttons | `ButtonGroup` | `buttons` (strings), `onButtonSelected` (the index) |
| A loading indicator | `BusySpinner` | `uri`, e.g. `"theme:ActionHudSpinner"` |
| A dialog | The components named in `references/dialogs.md`, which this row deliberately does not repeat | `references/dialogs.md` — a dialog is wrong without its areas, and their props are only there |
| Animate a field to a target | `Tween` from `@roku-sdk/components` | `targetNode`, `field`, and `targetValue` or `targetVector` |
| Video or audio playback | `Video`, `Audio` | A `VideoContentNode` as `content` |
| Data for a SceneGraph-native list | `ContentNode` | The fields that list reads |

For the declarative `<tween>` primitive and the components `Tween` wrapper, read the Tween value-shape contract in `documentation/core-concepts/tween.md` in the SDK source tree.

## Instructions

1. **Assume nothing is required, because almost nothing is.** Every prop inherited from
   `INodeProps` is optional, so a component with no props at all compiles. It just does not
   render. The type system will not tell you that `Label` needs `text`, that `Rectangle` needs
   `width` and `height`, that `Poster` needs `uri`, or that `MaskGroup` needs `maskUri`. Treat the
   Quick Reference's third column as the real signature.

2. **The handful of genuinely required props are worth knowing** because they are the only
   compile errors this package gives you: `ButtonRow` needs `buttons`, `Dialog` needs `close`,
   `RsgPalette` needs `colors`, `MarkupList` and `MarkupGrid` need `itemComponentName`, and
   `KeyHandler` needs `onKeyEvent` plus exactly one of `keys` or `handleAllKeys`.

3. **Write the lowercase intrinsic, not the capitalized wrapper, in new code.** Most of these
   components are pure pass-throughs — `Rectangle` is exactly `props => <rectangle {...props} />`
   — and the lowercase tag is already typed against the same props interface. So `<rectangle>`,
   `<group>`, `<label>` and friends need no import and render identically. The wrappers are
   supported and not deprecated, so existing code is fine as it stands and an app author may
   use either; but samples, demos and generated code should be consistent about the intrinsic.
   The exceptions are the components in step 4, which are not pass-throughs and must keep their
   capitalized form. Full reasoning: `references/scenegraph-node-spelling.md`.

4. **These are not pass-throughs — always write them capitalized.** `Audio` (renders `content`
   as a child), `VideoContentNode`, the five keyboard components `CustomKeyboard`,
   `DynamicKeyboard`, `DynamicKeyGrid`, `DynamicMiniKeyboard` and `DynamicPinPad` (they call
   `retainAsset()` so the backing XML survives tree-shaking), the six dialogs `Dialog`,
   `StandardDialog`, `StandardKeyboardDialog`, `StandardMessageDialog`, `StandardPinPadDialog`
   and `StandardProgressDialog` (they wrap in `<Modal>`), `ListPanel` (forwards to a different
   node), and the logic-bearing `Focusable`, `FocusableGroup`, `KeyHandler`, `Modal`,
   `Container`, `ButtonRow`, `BlendedBusySpinner`, `BoundingTracker` and `ChannelStore`. A
   lowercase tag here either fails to compile or silently drops the behaviour.

5. **`<group>` now needs an import like everything else.** It used to be registered as a
   capitalized JSX intrinsic, uniquely in the package, so a forgotten or misspelled import of
   `Group` did not fail the build and a layout could misbehave with nothing to point at. That
   alias has been removed: write `<group>` for the node, or import `Group` from
   `@roku-sdk/components` if you want the wrapper.

6. **If it is fed by a `content` ContentNode, it is a SceneGraph-native list.** Eleven are:
   `RowList`, `ZoomRowList`, `MarkupList`, `MarkupGrid`, `PosterGrid`, `LabelList`, `CheckList`,
   `RadioButtonList`, `TimeGrid`, `TargetGroup` and `TargetList`. Six of them also take an
   `itemComponentName` — required on `MarkupList` and `MarkupGrid` — which names a compiled
   BrightScript component by string, and that is what renders each item. A TypeScript component
   therefore cannot be an item of one. Name them when a reader asks about them; for a scrolling
   shelf or poster grid written in TypeScript, the answer is `@roku-sdk/flex-grid`. (`Video` and
   `Audio` take a `content` node too, but they are players, not lists.)

7. **Prefer these over the four that are still exported but not the current answer.**
   `StandardDialog` over `Dialog` — Roku OS 10 introduced the newer node with palette support,
   and `Dialog` remains only for backward compatibility. `RsgPalette` over `RSGPalette`, which
   is the same value under a deprecated alias. `ButtonGroup` over `ButtonRow`, which is a
   convenience wrapper built on the legacy `Focusable` / `FocusableGroup` focus model rather
   than on `FocusBoundary`. And `Container` only for deliberate node pooling — it renders
   nothing itself, and detaching a node through it on firmware 15.2.x destroys that node
   (fixed in 15.3).

8. **On an intrinsic, attribute order is behaviour: handlers first, `uri` last.** A capitalized
   wrapper spreads its props, and the spread path hoists event handlers ahead of regular props
   before any are applied. An intrinsic written with inline attributes does not go through that
   path — the compiler emits one `setProp` per attribute in source order and nothing reorders
   them. Two consequences. A property that can synchronously fire an event will fire it before a
   handler written after it, and the event is lost: `<poster uri={u} onLoadStatus={h} />` drops
   the event when the image is already cached, `<poster onLoadStatus={h} uri={u} />` does not.
   (The spread path reorders handlers first; inline intrinsic attributes are not reordered.) And the `Poster` load starts when
   `uri` lands, so a `loadDisplayMode` or a size written after it applies to a load already in
   flight. Full reasoning: `references/scenegraph-node-spelling.md`.

9. **Read the TSDoc for anything this skill does not answer.** Every export ships as raw
   TypeScript with its documentation attached, at
   `node_modules/@roku-sdk/components/src/sg-nodes/<node>.tsx` — `poster.tsx`, `label.tsx`,
   `standard-dialog.tsx` and so on. The few components not backed by a single SceneGraph node
   sit one level up in `src/`: `container.tsx`, `button-row.tsx`, `key-handler.tsx`.
   `ModalBoundary` is re-exported from `@roku-sdk/navigation`. There is no bundled `.d.ts` and no
   package README to consult instead.

## Example

Intrinsics for the plain nodes — `poster` and `label` need no import, because each is a
pass-through with a lowercase tag.

The composite nodes are written here as the capitalized `LayoutGroup`, `ButtonGroup` and
`BusySpinner` components, which is the spelling that compiles on every version. Their intrinsic
tags are spelled `layoutGroup`, `buttonGroup` and `busySpinner` from SDK v2.15.0 onward, and were
`layoutgroup`, `buttongroup` and `busyspinner` on v2.14.0 and earlier; the components wrap
whichever the installed version provides, so prefer them in code meant to survive the rename.

```tsx rsg-skill=complete
import { BusySpinner, ButtonGroup, LayoutGroup } from "@roku-sdk/components";
import { Show } from "@roku-sdk/solid";

interface DetailPanelProps {
    title: string;
    posterUri: string;
    loading: boolean;
    onAction: (index: number) => void;
}

export function DetailPanel(props: DetailPanelProps) {
    return (
        <layoutGroup layoutDirection="horiz" itemSpacings={[40]}>
            {/* `uri` last: the load starts when it lands. */}
            <poster width={300} height={400} loadDisplayMode="scaleToFit" uri={props.posterUri} />
            <layoutGroup layoutDirection="vert" itemSpacings={[24]}>
                <label text={props.title} width={900} />
                <Show
                    when={props.loading}
                    fallback={
                        <buttonGroup
                            buttons={["Play", "More Info"]}
                            onButtonSelected={(index: number) => props.onAction(index)}
                        />
                    }
                >
                    <busySpinner uri="theme:ActionHudSpinner" />
                </Show>
            </layoutGroup>
        </layoutGroup>
    );
}
```

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| A component compiles but nothing appears | The prop that gives it content or size is optional and was left off | `Label` needs `text`; `Rectangle` and `ScrollableText` need `width` and `height`; `Poster` needs `uri`; `MaskGroup` needs `maskUri` |
| A `LayoutGroup` centres its children somewhere unexpected | Alignment is relative to the group's own `translation`, not to the screen | Position the group, then let it align within itself |
| A lone `Button` has no background until it is focused | `showFocusFootprint` defaults off outside a `ButtonGroup` | Set `showFocusFootprint={true}` |
| Text is set but renders at an unreadable size, or a symbol comes out as an empty box | The typeface, not the node | The `fonts-and-glyphs` skill |
| A `MaskGroup` masks nothing on some hardware | Masking is OpenGL-only; elsewhere children draw unmasked | Do not rely on it for correctness, only for polish |
| A TypeScript component cannot be used as a list item | That list renders items from BrightScript XML named by `itemComponentName` | Use `@roku-sdk/flex-grid` for a shelf or grid written in TypeScript |
| Rounded corners, a border or a gradient is missing, stutters, or will not animate | An `Effect` problem, not a component choice | The `effects` skill |
| The question names a component library, a URL at runtime, or a partner binary shipped separately | Those words describe a Dynamic Component Library, not a choice between `Poster` and `Label` | The `app-packaging` skill: it owns the routing, and names `@roku-sdk/runtime/component-library` for loading and referencing |

## Tween

`Tween` is a logic-bearing wrapper and must remain capitalized. Use `targetNode` with a node
or a getter returning one. The old `targetRef` name is a deprecated alias for one minor release;
`targetNode` wins when both are supplied. The wrapper uses the native field types in `ITweenProps`,
except that its `onAnimationState` callback receives `(state, value)` rather than the intrinsic's
single `[state, value]` tuple. It binds the target before triggers and releases it on cleanup.
It defaults to `outCubic`; the native intrinsic defaults to `linear`.

The native node is selected when firmware supports the `tween` feature. Import `@roku-sdk/compat`
for `RsgTweenShim` on older firmware. Without compat, unsupported firmware throws a missing-feature
error rather than silently rendering an inert node. Axis and settle value shapes are described in
the linked value-shape contract.
