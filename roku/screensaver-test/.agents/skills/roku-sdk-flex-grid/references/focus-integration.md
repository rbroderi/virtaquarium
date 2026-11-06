<!-- @roku-sdk/ai managed v=1 hash=7f123f1ef2785b52e69482c613f8e7c1104181bdb8764de7d0949152a5af0bf9 skills=1 do-not-edit -->

# Focus Integration

A grid is in one of two modes, and the mode decides everything about how keys reach it. One
config field selects it.

| `focusId` | Mode | How keys arrive |
|---|---|---|
| passed | **top-level** | The grid renders its own nested `FocusBoundary` and claims seven keys from the enclosing boundary — the four movement keys, `OK`, `fastforward` and `rewind` |
| omitted | **bare** (nested in another grid's cell) | No boundary exists. The parent cell's `KeyDelegate` calls `handle.forwardKeyEvent(key, press)` |

Nothing else distinguishes them: same config, same handle, same plugins.

## Top-level: hand focus to a sibling region at an edge

The grid claims `left`, `right`, `up`, `down`, `OK`, `fastforward` and `rewind`, and nothing
else — a key outside that set bubbles to the enclosing boundary untouched, which is how a
screen's `back` still works. By default a claimed key is consumed whether or not it moved
anything, so the enclosing `onUnhandledKey` never sees one; `declineUnhandledNavigation: true`
changes that, and is covered under nested grids below, where it matters most. Those are the runtime strings the firmware delivers, which is what
`handleAdditionalKeyEvents` is compared against; the enum members for the last two are spelled
`RemoteKey.Fwd` and `RemoteKey.Rev`. Add to the set with `handleAdditionalKeyEvents`, and catch
what the grid then does not use with `onUnhandledAdditionalKey`; both are top-level concerns and
neither exists in bare mode. The list is filtered against the seven above, so naming one of them
there is dropped rather than rejected — a caller cannot re-route a navigation key and break the
grid.

`onEdgeReached` is the region hand-off cue. Its return is the half that reads the other way round
from most APIs:

| | |
|---|---|
| Signature | `onEdgeReached?: (edge: PositionValue) => void` |
| The argument | One of `"top"`, `"bottom"`, `"left"`, `"right"`. `PositionValue` aliases the `Position` string enum, whose members hold exactly those strings, so `edge === "top"` and `edge === Position.Top` both compile and both match. Both names are exported from 2.15.0 on, and an install older than that types the argument as the bare literal union — so comparing against the literals is the form that holds on every version |
| The return | `void`. There is no consume signal — returning `true` is meaningless, and the key is already spent |
| When it fires | The user was **already** at that boundary and pressed further. Never on a wrap, and never on a press that moved focus |

So moving focus is your call to make, and the only thing the grid promises is the report.

```tsx rsg-skill=complete
import { Group, Label, Rectangle } from "@roku-sdk/components";
import type { CellRenderProps } from "@roku-sdk/flex-grid";
import { defineFlexGrid, fixedFocusStrategy, floatingFocusYStrategy } from "@roku-sdk/flex-grid";
import { FocusBoundary, useFocusable, useFocusActions } from "@roku-sdk/navigation";
import { type Component, onCleanup } from "@roku-sdk/solid";

interface Card {
    title: string;
}

const screenId: object = {};
const navId: object = {};
const gridId: object = {};
const firstTabId: object = {};

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

function NavTab(props: { label: string; focusId?: object; x: number }) {
    const { ref, isFocused } = useFocusable({ focusId: props.focusId });

    return (
        <group ref={ref} translation={[props.x, 0]}>
            <rectangle width={200} height={56} color={isFocused() ? "0x0055FFFF" : "0x1A1A1AFF"} />
            <label text={props.label} translation={[16, 16]} />
        </group>
    );
}

/** Rendered inside the screen's boundary, which is what makes both regions reachable. */
export const ShelfScreen: Component = () => {
    // Written by the capture component, read by the edge callback.
    let focusRegion: ((id: object) => void) | undefined;

    const CaptureRegionFocus: Component = () => {
        const { setFocus } = useFocusActions();
        focusRegion = setFocus;
        onCleanup(() => {
            focusRegion = undefined;
        });
        return null;
    };

    // Annotated with the literals rather than `PositionValue`: the values are those
    // strings, and a handler typed this way stays assignable on an SDK too old to
    // export the alias.
    const onEdgeReached = (edge: "top" | "bottom" | "left" | "right"): void => {
        if (edge === "top") focusRegion?.(navId);
    };

    // The grid is built by this component's JSX, inside the boundary below — not
    // above it. A grid created outside the boundary's owner becomes a second root
    // and never receives a key.
    return (
        <FocusBoundary focusId={screenId} initialFocus={gridId} navigation="vertical">
            <CaptureRegionFocus />

            <FocusBoundary focusId={navId} initialFocus={firstTabId} navigation="horizontal">
                <NavTab label="Home" focusId={firstTabId} x={0} />
                <NavTab label="Movies" x={220} />
            </FocusBoundary>

            <Shelf
                focusId={gridId}
                numRows={30}
                numCols={6}
                cellSize={[280, 158]}
                cellSpacing={[24, 32]}
                translation={[80, 240]}
                focus={{
                    horizontal: { strategy: fixedFocusStrategy, options: { focusOffset: 80 } },
                    vertical: { strategy: floatingFocusYStrategy, options: { focusOffset: 0 } }
                }}
                getCellComponent={cardCellComponent}
                onEdgeReached={onEdgeReached}
            />
        </FocusBoundary>
    );
};
```

## Focusable cells (`setFocusBoundary`)

A composite cell — several buttons, a nested grid, real internal navigation — can hand the grid
its own `FocusBoundary` identity instead of intercepting keys with a `KeyDelegate`. While that
cell is focused, the grid parks its boundary's virtual focus there, so keys arrive through the
focus chain and grid navigation runs only when the cell **declines**.

`setFocusBoundary` is a 3.x addition later than 3.0.0, so an install predating it types
`CellRenderProps` without the prop and the sample below does not compile there. Where
`props.setFocusBoundary` is missing, `setKeyDelegate` is the composite-cell mechanism every version
has, with the key order inverted: the delegate runs *before* grid navigation and hands a key back by
returning `false`, and `isFocused()` does not work inside the cell because no boundary of its own is
focused.

```tsx rsg-skill=complete
import { Group, Label, Rectangle } from "@roku-sdk/components";
import type { CellRenderProps } from "@roku-sdk/flex-grid";
import { FocusBoundary } from "@roku-sdk/navigation";
import type { Component } from "@roku-sdk/solid";

interface ShelfItem {
    title: string;
}

export const CompositeCell: Component<CellRenderProps<ShelfItem>> = props => {
    const cellRef: object = {};
    props.setFocusBoundary(cellRef);

    return (
        <FocusBoundary focusId={cellRef} initialFocus={cellRef} rememberLastFocus={false}>
            <group>
                <rectangle
                    width={props.width}
                    height={props.height}
                    color={props.focused() ? "0x0055FFFF" : "0x1A1A1AFF"}
                />
                <label text={props.item?.title ?? "…"} translation={[16, 120]} />
            </group>
        </FocusBoundary>
    );
};
```

Requires the outer grid to be in boundary mode (`focusId` set). The registration is **not**
cleared on pool recycle — drive per-item state from `props.item` and prefer
`rememberLastFocus={false}`. `rememberLastFocus` remembers per pool node, not per item, so a
recycled node reopens on whatever the previous item last focused; to remember per item, store
the last sub-focus on the item and derive `initialFocus` from it. Shared pools support this pattern: when a grid focuses a node,
a focus relay moves the cell's registration to that grid. All grids sharing the pool
must be under the same root `FocusBoundary`.

## Nested grids — boundary mode (preferred)

Give the inner grid a `focusId` too, register that identity in the parent cell's
`FocusBoundary` (`navigationMap` moves sub-focus into it), and set
`declineUnhandledNavigation: true` so keys the inner grid could not act on keep bubbling.
Without it the inner boundary claims every movement key and the user is trapped at its edges.

`declineUnhandledNavigation` is the same vintage as `setFocusBoundary` — a 3.x addition later than
3.0.0 — so an install predating it rejects the config key, and a nested grid there cannot decline a
movement key it could not act on.

```tsx rsg-skill=complete
import { Group } from "@roku-sdk/components";
import type { CellRenderProps } from "@roku-sdk/flex-grid";
import { createFlexGrid, fixedFocusStrategy, floatingFocusYStrategy } from "@roku-sdk/flex-grid";
import { FocusBoundary } from "@roku-sdk/navigation";
import type { Component } from "@roku-sdk/solid";

interface Episode {
    title: string;
}

interface Series {
    episodes: Episode[];
}

const nestedGridId: object = {};
const detailZoneId: object = {};

export const SeriesCell: Component<CellRenderProps<Series>> = props => {
    const cellRef: object = {};
    props.setFocusBoundary(cellRef);

    const inner = createFlexGrid<Episode>({
        focusId: nestedGridId,
        declineUnhandledNavigation: true,
        numRows: 1,
        numCols: 12,
        cellSize: [220, 124],
        focus: {
            horizontal: { strategy: fixedFocusStrategy, options: { focusOffset: 40 } },
            vertical: { strategy: floatingFocusYStrategy, options: { focusOffset: 0 } }
        },
        getCellComponent: () => EpisodeCell,
        onItemSelected: (_row, _col, item) => item !== undefined
    });

    const navigationMap = new Map<object, Partial<Record<"up" | "down" | "left" | "right", object>>>([
        [detailZoneId, { right: nestedGridId }],
        [nestedGridId, { left: detailZoneId }]
    ]);

    return (
        <FocusBoundary
            focusId={cellRef}
            initialFocus={detailZoneId}
            rememberLastFocus={false}
            navigationMap={navigationMap}
        >
            <group>{inner.element}</group>
        </FocusBoundary>
    );
};

const EpisodeCell: Component<CellRenderProps<Episode>> = () => <group />;
```

Escapes are declarative: a `navigationMap` entry on the cell catches a direction (e.g. `left`
back to a Detail zone), and a direction the cell has no entry for is declined so the outer grid
changes row.

## Bare: a grid inside another grid's cell

The inner grid gets no `focusId`. The outer cell registers a `KeyDelegate` while it is focused
and forwards keys into the inner grid, using the return value to decide whether the outer grid
should act instead.

Forward **both** press and release. A release is what clears a hold timer and settles a smooth
scroll, so swallowing it leaves the inner grid gliding after the user let go.

```tsx rsg-skill=complete
import { Group, Label, Rectangle } from "@roku-sdk/components";
import type { CellRenderProps, KeyDelegate } from "@roku-sdk/flex-grid";
import { createFlexGrid, fixedFocusStrategy, floatingFocusYStrategy } from "@roku-sdk/flex-grid";
import { type Component, createEffect, onCleanup } from "@roku-sdk/solid";

interface Episode {
    title: string;
}

interface Series {
    episodes: Episode[];
}

const EpisodeCell: Component<CellRenderProps<Episode>> = props => (
    <group>
        <rectangle
            width={props.width}
            height={props.height}
            color={props.focused() ? "0x0055FFFF" : "0x1A1A1AFF"}
        />
        <label text={props.item?.title ?? "…"} translation={[12, 96]} />
    </group>
);

function episodeCellComponent(): Component<CellRenderProps<Episode>> {
    return EpisodeCell;
}

/** A cell of the outer grid that expands into an inner grid of episodes. */
export const SeriesCell: Component<CellRenderProps<Series>> = props => {
    // No focusId: this grid has no boundary and is driven entirely by the
    // delegate below.
    const inner = createFlexGrid<Episode>({
        numRows: 1,
        numCols: 12,
        cellSize: [220, 124],
        cellSpacing: [12, 0],
        focus: {
            horizontal: { strategy: fixedFocusStrategy, options: { focusOffset: 40 } },
            vertical: { strategy: floatingFocusYStrategy, options: { focusOffset: 0 } }
        },
        getCellComponent: episodeCellComponent,
        onItemSelected: (row, col, item) => item !== undefined
    });

    createEffect(() => {
        if (!props.focused()) {
            props.setKeyDelegate(null);
            return;
        }

        const delegate: KeyDelegate = {
            handleKey(key, press) {
                // false means the inner grid did nothing with it, so the outer
                // grid gets its turn — that is how an edge escapes the inner row.
                return inner.forwardKeyEvent(key, press);
            }
        };

        props.setKeyDelegate(delegate);
        onCleanup(() => props.setKeyDelegate(null));
    });

    return <group>{inner.element}</group>;
};
```

### What `forwardKeyEvent` returns

The boolean is the whole contract: `true` means the inner grid consumed the key and the parent
must not act on it.

| Returns `true` | Returns `false` |
|---|---|
| The focused inner cell's own `KeyDelegate` consumed it | A directional press at a non-wrapping edge that moved nothing |
| A directional press moved focus, or wrapped under a wrap strategy | An idle horizontal release with no hold timer or smooth scroll to settle |
| A directional press or re-press that a live smooth-scroll session consumed | `OK` when `onItemSelected` is absent or returned `false` — deliberate, so selection bubbles |
| A directional release that did real work: cleared a hold timer, settled a scroll | A key the grid does not act on at all, such as a `play` release |
| `OK` accepted by an `onItemSelected` that returned `true` | A key listed in `handleAdditionalKeyEvents` that the focused cell declined |

Two asymmetries worth knowing, because both are silent:

- **Bare mode has no claimed-key filter.** In top-level mode only the boundary's keys reach a
  cell's delegate; here *every* key you forward is offered to the focused inner cell first,
  including keys with no navigation meaning. Forwarding a key the inner grid cannot use is
  harmless, and forwarding only the arrows is what makes an inner cell's `play` handler dead.
- **`onEdgeReached` fires in both modes**, so an inner grid can report its own edges. Use it
  when the reaction belongs to the grid; use the `false` return when the reaction belongs to the
  parent cell, which is the usual case.
