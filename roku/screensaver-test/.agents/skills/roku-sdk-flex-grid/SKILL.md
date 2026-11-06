---
name: roku-sdk-flex-grid
description: "Use when the request names a FlexGrid, or asks for the virtualized shelf and poster-grid renderer @roku-sdk/flex-grid provides — creating one with defineFlexGrid or createFlexGrid, the config it requires, filling its rows in as they load, a FlexGrid that renders but receives no key press or whose initialFocus never resolves, a grid nested inside another grid's cell, moving focus from a grid edge to a nav bar or sibling region, and its focus-highlight, zoom and row-title plugins. Everything a grid owns is here, including its focus and its edges. Not for a list, menu or row built by hand out of FocusBoundary and useFocusable — including dimming the items of one that are not focused."
# @roku-sdk/ai managed v=1 hash=fee8692ead2021477db3722e81b12eab5e9fc7cd2a6c1ba345f02e62ba2bd242 skills=1 do-not-edit
---

# FlexGrid

## Overview

`@roku-sdk/flex-grid` renders the shelves and poster grids a Roku app is mostly made of, at a
size a device can hold: cells come from a recycled pool, only the rows near the viewport exist,
and rows may be loaded page by page while the user is already moving. You describe the geometry
and the cell component; the grid owns scrolling, focus movement inside itself, and the focus
highlight.

Every sample here is written against the **3.x line**. 2.x is maintained in parallel and differs in
the plugin surface and in how a cell takes focus, so read the installed package's major before
copying one — `BREAKING_CHANGES.md` in the install carries the 2.x-to-3.x table.

## Read the reference first for these tasks

| If the request is | Read now, before answering |
|---|---|
| A grid inside another grid's cell, or a grid handing focus to a sibling region at its edge | `references/focus-integration.md` |
| The focus highlight, zoom, row titles, or any other plugin | `references/plugins.md` |

The tables below name the callback or the factory and stop there: the arguments, the return
contract that decides whether a key bubbles, and the subpath each plugin is imported from are
only in the references. Answer these two from the reference and quote it — an answer assembled
from a table row here is an invented API, and this package has several names that look right
and do not exist.

## When to Use

- a row of cards, a shelf-of-shelves screen, or a poster grid that scrolls
- rows whose data arrives after the screen is up, page by page
- per-row geometry: different cell widths, heights or column counts per row
- a grid that has to give focus back to a nav bar or menu at its edge
- a second grid inside a cell of the first one
- cells that must not all exist at once, because there are hundreds of them

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| A menu, settings list or short row of buttons | `FocusBoundary` + `useFocusable` from `@roku-sdk/navigation` | Nothing to virtualize, and the grid's geometry config costs more than the screen needs |
| A full-screen image carousel | `@roku-sdk/slideshow` | It owns the transition and the one-item-at-a-time model the grid has no notion of |
| The network call that fills a row — its method, headers, error status or a host this box does not trust | The `fetch-and-data-loading` skill | This skill owns *when* a row is fetched, which is the focus-driven half. What the request itself looks like is not a grid concern |
| A `RowList`, `MarkupGrid` or another list that takes `itemComponentName` | The `sdk-components` skill names them | Those are SceneGraph-native lists exported by `@roku-sdk/components`. They render each item from compiled BrightScript XML, so a TypeScript component cannot be their item — which is the reason this renderer exists rather than wrapping them |

## Quick Reference

| Operation | API |
|---|---|
| Declare the packages (the scaffold ships neither) | `@roku-sdk/flex-grid`, plus `@roku-sdk/navigation` for a top-level grid, in the app's `dependencies` |
| A grid in JSX | `defineFlexGrid<T>()` at module scope, rendered with the config as props |
| A grid built imperatively | `createFlexGrid<T>(config)`, then render `handle.element` |
| Reach the live grid from app code | `gridHandleRef={setGrid}` in JSX, or the `createFlexGrid` return value |
| Required config | `numRows`, `numCols`, `cellSize`, `focus` (both axes), `getCellComponent` |
| Where a row moves on screen | `focus.horizontal` / `focus.vertical`: `fixedFocusStrategy`, `floatingFocusStrategy`, `floatingFocusYStrategy`, `fixedFocusWrapStrategy` |
| Feed rows as they load | `rows` (accessor) in JSX, or `handle.updateRows(startRow, rows)`; `undefined` is a row not loaded yet |
| React to focus moving | `onFocusChanged(row, col, item)` — the prefetch hook |
| Act on OK | `onItemSelected(row, col, item)`, returning `true` to consume it |
| Focus this grid as a region | `focusId` — an identity the enclosing boundary's `initialFocus` or `setFocus` names |
| Hand focus on at an edge | `onEdgeReached(edge)` — `edge` is `"top"`, `"bottom"`, `"left"` or `"right"`, and it returns nothing → `references/focus-integration.md` |
| Send a key into a nested grid | `handle.forwardKeyEvent` → `references/focus-integration.md` |
| Clip to a viewport | `enableClipping: true` with `width` and `height`, which the type then requires |
| Clip one row's cards to a rect | `createRowCardsClipPlugin` from `@roku-sdk/flex-grid/row-clip` — in row coordinates and fixed within the row, so cards scroll through it; row chrome stays outside |
| One backdrop behind several rows | `createRowBackdropPlugin` → `references/plugins.md` |
| Jump somewhere | `jumpTo: [row, col]`, or `handle.jumpTo(row, col, animate)` for an unconditional repeat |
| A row refilled with unrelated items starts at its first item | `handle.resetRowPosition(row)` beside the update — `updateRows` keeps the row's saved column and scroll |

## Instructions

1. **Declare the dependencies first.** `rk create` scaffolds neither `@roku-sdk/flex-grid` nor
   `@roku-sdk/navigation` — which a top-level grid also needs, for the `RootFocusBoundary` it
   registers under — and pnpm does not hoist, so until both are in the app's `dependencies`
   the imports do not resolve and nothing below compiles. Give them whatever range the app's
   other `@roku-sdk/*` packages already carry — the published version for an app installing
   from the registry, `workspace:*` only inside the SDK's own pnpm workspace, where that
   protocol resolves. Then run `rk build` once: until a build has generated this package's XML
   type declarations, bare `tsc` reports errors inside the SDK's own files, so the build is the
   type gate, not `type-check`.

2. **Create the grid inside the root `FocusBoundary`'s owner.** A top-level grid *is* a nested
   boundary: it reads the boundary context when its JSX is created. Built outside — in the
   anchor node's body, or in a module-level factory — it becomes a second root, registers with
   nobody, and every key is dropped while the screen looks correct. A scaffolded app has no
   boundary at all: its anchor node still `extends: "Group"`, so wire that first — skill
   `roku-sdk-focus-management`, Instruction 1 — and render the grid under it.

3. **Give both axes a focus strategy.** `focus` is required and has no default. `fixed` keeps
   the focused cell at one position and scrolls the content past it; `floating` moves the
   highlight until it reaches the offset and scrolls after that.

4. **Write the cell as a component over `CellRenderProps<T>`.** Read `focused()` inside JSX,
   size from `width` / `height`, and treat `item` as possibly `undefined` — that is a row whose
   data has not arrived, not an error.

5. **Return the cell component from `getCellComponent` by identity, not by a fresh closure.**
   Structural props are a remount dependency: a new function on every parent render rebuilds
   the grid, which drops focus and re-warms the pool.

6. **Load rows behind `onFocusChanged`.** Set `numRows` to what the dataset will hold, pass
   `undefined` for rows you have not fetched, and fill them in as focus approaches.

7. **Pass `focusId` only for a top-level grid.** Omitting it is what selects nested mode, where
   the parent cell forwards keys instead — see the reference before writing either.

## Example

A top-level shelf grid: pooled cells, rows filled in as focus moves, a viewport to scroll
inside, and the grid registered as a focus region under the screen's boundary.

```tsx rsg-skill=complete
import { Group, Label, Rectangle } from "@roku-sdk/components";
import type { CellRenderProps } from "@roku-sdk/flex-grid";
import { defineFlexGrid, fixedFocusStrategy, floatingFocusYStrategy } from "@roku-sdk/flex-grid";
import { type Component, createSignal } from "@roku-sdk/solid";

interface Card {
    title: string;
}

const CELL_SIZE: [number, number] = [280, 158];
const TOTAL_ROWS = 40;
const COLUMNS = 6;

// Module scope: the component identity has to be stable, because the grid
// remounts when a structural prop changes identity.
const Shelf = defineFlexGrid<Card>();

const CardCell: Component<CellRenderProps<Card>> = props => (
    <group>
        <rectangle
            width={props.width}
            height={props.height}
            color={props.focused() ? "0x0055FFFF" : "0x1A1A1AFF"}
        />
        <label text={props.item?.title ?? "…"} translation={[16, 120]} />
    </group>
);

function cardCellComponent(): Component<CellRenderProps<Card>> {
    return CardCell;
}

async function fetchRow(row: number): Promise<Card[]> {
    // The app's own paging call.
    return [{ title: `Row ${row}` }];
}

/**
 * Rendered inside the screen's `RootFocusBoundary`, whose `initialFocus` names
 * the same `focusId` this receives.
 */
export const PosterShelves: Component<{ focusId: object }> = props => {
    const [rows, setRows] = createSignal<(Card[] | undefined)[]>(Array.from({ length: TOTAL_ROWS }));

    const loadRow = (row: number): void => {
        if (rows()[row] !== undefined) return;
        void fetchRow(row).then(items =>
            setRows(previous => {
                const next = [...previous];
                next[row] = items;
                return next;
            })
        );
    };

    return (
        <Shelf
            focusId={props.focusId}
            numRows={TOTAL_ROWS}
            numCols={COLUMNS}
            cellSize={CELL_SIZE}
            cellSpacing={[24, 32]}
            translation={[80, 240]}
            // Without a viewport the scrolled rows paint over whatever is above
            // the grid; `enableClipping` is the union arm that requires both sizes.
            enableClipping={true}
            width={1760}
            height={840}
            focus={{
                horizontal: { strategy: fixedFocusStrategy, options: { focusOffset: 80 } },
                vertical: { strategy: floatingFocusYStrategy, options: { focusOffset: 0 } }
            }}
            getCellComponent={cardCellComponent}
            rows={rows}
            onFocusChanged={row => loadRow(row)}
            onItemSelected={(row, col, item) => {
                if (item === undefined) return false;
                openTitle(item);
                return true;
            }}
        />
    );
};

function openTitle(card: Card): void {
    // app logic for the selected card
}
```

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| The grid draws but no key reaches it, and the root boundary's `initialFocus` never resolves | The grid was created outside the root boundary's owner, so it became a second root | Create it in a component rendered inside the boundary |
| `Module '"@roku-sdk/flex-grid"' has no exported member 'Position'` (or `'PositionValue'`) | Both names arrived in 2.15.0; an older install types the edge argument as the bare literal union and exports neither | Compare `edge` against `"top"`, `"bottom"`, `"left"` and `"right"`. The enum's members hold those same strings, so the literal form compiles and matches on every version |
| `Property 'setFocusBoundary' does not exist on type 'CellRenderProps<T>'`, or `declineUnhandledNavigation` rejected in the config | Both are 3.x additions later than 3.0.0, and an install predating them has neither | Give a composite cell its keys through `setKeyDelegate`, which every version has, and expect a nested grid there to claim movement keys rather than decline them → `references/focus-integration.md` |
| Returning `true` from the edge callback changes nothing | `onEdgeReached` returns `void`: it reports, it does not consume | Move focus in the handler and expect no consume semantics |
| `Property 'focusRef' does not exist` | The prop is `focusId`; `focusRef` appears in older prose and never existed | Use `focusId` |
| The highlight config's fields are rejected | Two types share the name `FocusHighlightConfig`, and the main barrel's one is dead | Import it from `@roku-sdk/flex-grid/focus-highlight` |
| Scrolled rows paint over the header, the nav bar, or the screen's edge | The grid has no viewport until one is asked for, so its rows draw outside its box | `enableClipping: true` with `width` and `height`; nothing but a screenshot catches this — the build and the tests both pass |
| `width`/`height` suddenly required | `enableClipping: true` is a discriminated union arm that needs a viewport | Pass both, or drop the clipping |
| A translated grid renders blank: the cells exist and hold their data, but nothing is inside the clip rect | `height` is the size of the grid's box, measured from its own origin, not a bottom edge on the screen. Versions before this fix read it both ways and gave a grid offset further down the screen than it was tall a negative viewport, scrolling every row above its own rect | Size the band itself and let `translation` place it: a 200-tall row at y=220 is `translation: [70, 220], height: 200`. Omitting `height` runs the grid to the bottom of the screen. A custom vertical strategy reading `viewportHeight` as a bottom edge has the same bug — the room below the focus line is `viewportTop + viewportHeight - focusOffset` |
| A card shows where something opaque is drawn over the row — in the gap beside a panel, or past the end of the row | Nothing clips the row there. Hiding the card is the usual stand-in and it is not the same thing: it removes the card mid-slide, so the slot it was heading for fills by appearing instead of gliding in | `createRowCardsClipPlugin({ clip: row => [x, y, w, h] })` from `@roku-sdk/flex-grid/row-clip`, answering `undefined` for every other row. The rect is in the row's own coordinates and does not move with the row's horizontal scroll, so cards are cut at its edges and their motion is untouched — run it well past every edge nothing covers, or a focus ring or zoomed card is cut there too; row chrome stays outside, so a title beyond the rect still draws. Where the rect goes depends on where that row puts its cards in each of its states, which is worth measuring rather than assuming |
| A clipped row renders blank, or loses its first cards | The rect is returned in a state where the opaque thing it hides behind is not drawn — most often the row is no longer focused, which in the same stroke usually undoes whatever spread the cards out. The cut then has nothing over it | Gate `clip` on exactly what draws the covering element, and answer `undefined` in every other state. Clipping a row unconditionally looks right until that row is not the focused one |
| A band meant to sit behind two rows draws over part of one of them, or breaks at the seam between them | It was drawn as one row's `registerRowChrome(…, "back")` reaching past that row. Row chrome belongs to its own row | `createRowBackdropPlugin` from `@roku-sdk/flex-grid/row-backdrop`, one region over the rows → `references/plugins.md` |
| A `layer: "back"` focus highlight disappears behind a row backdrop | `createRowBackdropPlugin` comes after `createFocusHighlightPlugin` in `plugins`, and the back layer draws in that order | List the backdrop plugin first |
| Backdrop art squashes while the bob opens inside the band | A `size.fill` poster takes the region's height, which grows with the gap | `loadDisplayMode="scaleToZoom"` on the poster; place content that must not stretch against `size.height()` |
| Focus resets and the grid flashes on unrelated state changes | A structural prop — `getCellComponent`, `plugins`, an options object — arrives as a new value each render | Hoist it, or keep it in a memo |
| Every cell looks unfocused, or the wrong one is highlighted | `focused` was read at the top of the cell instead of inside JSX, or `props` was destructured | Call `props.focused()` in the JSX that depends on it |
| A key the app wanted never arrives, though the grid handles the arrows | The grid claims seven keys, not five: the four movement keys, `OK`, `fastforward` and `rewind` | Name the extra ones in `handleAdditionalKeyEvents` and handle them where the reference shows. That list is filtered against the seven the grid already claims, so listing `fastforward` or `rewind` there is silently dropped rather than rejected |
| `up` on the first row does nothing, and the boundary's `onUnhandledKey` never fires for it | The grid claimed that key and consumes it even though it moved nothing, so it never reaches the boundary the hand-off was written on | Move the hand-off to the grid's `onEdgeReached`, per `references/focus-integration.md`. `declineUnhandledNavigation: true` makes claimed keys that moved nothing bubble instead, which is how a nested grid escapes its own edges — reach for it there, not to rescue a top-level hand-off |
| `tsc` reports `Property 'floatTween' does not exist on JSX.IntrinsicElements`, inside the SDK's files rather than yours | Those intrinsics come from XML type declarations that only `rk build` / `rk dev` generate, and a fresh install has none | Build once, then re-run. The build's own type check is the authoritative gate; bare `tsc` on a never-built app is not |
| The device log floods with `Could not update the interpolator field ""` | By design: the grid creates its interpolators with an empty `fieldToInterp` and patches the target in from BrightScript | Ignore them, and search the log for the real error rather than reading it in order |

`FlexGridConfig`, `FlexGridHandle` and `CellRenderProps` are typed with TSDoc in the installed
package — read a field there rather than guessing its name, and prefer it over any prose,
including this file, when the two disagree. The package ships raw TypeScript (`main` is
`src/index.ts`), so read `node_modules/@roku-sdk/flex-grid/src/`: the config and the handle are
in `flex-grid-base.tsx`, the cell props in `types.ts`. There are no `dist/*.d.ts` to consult.

## Tween ownership

Import `Tween` and `TweenProps` from `@roku-sdk/components`, not `@roku-sdk/flex-grid`.
The grid export is deprecated and retained for one minor release. The lowercase `<tween>`
intrinsic is declared by `@roku-sdk/components/jsx` and uses the native field contract.
See the Tween value-shape contract in `documentation/core-concepts/tween.md` in the SDK source tree.
