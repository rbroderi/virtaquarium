<!-- @roku-sdk/ai managed v=1 hash=a33dd40d14c313341a93a11cea12c7dd59b364df20b467f1368d54fa434b21fd skills=1 do-not-edit -->

# Plugins

Everything optional about a grid is a plugin, and every plugin lives on its own subpath. That is
deliberate: the main barrel does not re-export them, so a grid without a row title never carries
the row-title code. Import the factory from the subpath, call it, and pass the result in
`plugins`.

| Subpath | Factory | What it owns |
|---|---|---|
| `@roku-sdk/flex-grid/focus-highlight` | `createFocusHighlightPlugin` | The highlight node around the focused cell, its tweens, layer and visibility |
| `@roku-sdk/flex-grid/zoom-focus` | `withZoomFocus`, `ScaleTween` | Scale-on-focus on cell templates (not a `plugins[]` entry) |
| `@roku-sdk/flex-grid/row-titles` | `createRowTitlePlugin` | A title drawn per row, scrolling with it |
| `@roku-sdk/flex-grid/bob-in-the-middle` | `createBobPlugin` | An interstitial band between two rows |
| `@roku-sdk/flex-grid/empty-placeholder` | `createEmptyPlaceholderPlugin` | What a cell shows while its row has not loaded |
| `@roku-sdk/flex-grid/row-clip` | `createRowCardsClipPlugin` | A rect one row's cards scroll through and are cut at |
| `@roku-sdk/flex-grid/row-backdrop` | `createRowBackdropPlugin` | One backdrop behind a run of rows, under every card |
| `@roku-sdk/flex-grid/perf` | `createPerfPlugin` | Frame and transaction counters, for a measurement session |

`@roku-sdk/flex-grid/compose-h-strategy` is on the same principle but is not a plugin: it
composes a horizontal focus *strategy* out of extensions, and its result goes in
`focus.horizontal.strategy`.

**One import trap.** Two different types are called `FocusHighlightConfig`. The main barrel
exports a legacy one that nothing reads; the plugin's own is on its subpath. Import the config
type from `@roku-sdk/flex-grid/focus-highlight` alongside the factory, or the fields you pass
will be rejected against a shape that has nothing to do with the plugin.

## The focus highlight

| Field | Meaning |
|---|---|
| `render` | Your content instead of the default rectangle. Receives `width`, `height` and `focusedRow` as **accessors** |
| `layer` | `"front"` (default) draws above the cards, `"back"` below them |
| `visible` | An accessor. Returning false hides the node **and** clears every cell's `focused` signal, which is what dims in-cell outlines while a tab bar or a dialog owns focus |
| `hideOnSmoothScroll` | Fade the highlight out while a held scroll glides, and back in when it settles |
| `color` | The default rectangle's colour. Ignored once `render` is set |

`render` runs **once**, untracked, with no Solid parent context — it is a factory, not a
component body. So read its accessors inside the JSX it returns, and never destructure the
context object: doing either captures the first focused cell's size and keeps it forever.

```tsx rsg-skill=complete
import { Poster } from "@roku-sdk/components";
import type { GridPlugin } from "@roku-sdk/flex-grid";
import { createFocusHighlightPlugin } from "@roku-sdk/flex-grid/focus-highlight";
import type { Accessor } from "@roku-sdk/solid";

interface Card {
    title: string;
}

const BORDER = 12;

/**
 * `width` and `height` stay accessors all the way into the JSX props, so the
 * frame resizes when focus moves to a row with a different cell size.
 */
export function cardFocusFrame(uri: string): GridPlugin<Card> {
    return createFocusHighlightPlugin<Card>({
        layer: "back",
        hideOnSmoothScroll: true,
        render: (ctx: { width: Accessor<number>; height: Accessor<number>; focusedRow: Accessor<number> }) => (
            <poster
                uri={uri}
                width={ctx.width() + BORDER * 2}
                height={ctx.height() + BORDER * 2}
                translation={[-BORDER, -BORDER]}
            />
        )
    });
}
```

## Scale-on-focus with `withZoomFocus`

Scale-on-focus is a **template** concern, not a plugin. Wrap cell templates at module scope
with `withZoomFocus` from `@roku-sdk/flex-grid/zoom-focus` so only templates that need zoom
pull in `ScaleTween`.

`withZoomFocus` arrived in **3.0.0**, which removed the `createZoomFocusPlugin` entry along
with the `getItemScale` and `requiredNodeSignals` hooks a scale plugin needed. On a 2.x
install (`@roku-sdk/flex-grid@maintenance-2x`) neither the wrapper nor its subpath export
exists, so zoom is still a `plugins[]` entry there; see that install's
`BREAKING_CHANGES.md` for the plugin-to-wrapper migration table.

When templates own the focus visual (zoom scale, in-cell outline), still add
`createFocusHighlightPlugin` to `plugins` with `renderNode: false` — also **3.0.0**, and the
half of the zoom migration that is easy to miss. It gates per-cell `focused` — returning
`false` from `visible` clears every cell's focus styling while a tab bar or dialog owns focus.
Dropping the highlight plugin because zoom draws the visual is how `visible` stops working.

```tsx rsg-skill=complete
import type { Component } from "@roku-sdk/solid";
import type { CellRenderProps, GridPlugin } from "@roku-sdk/flex-grid";
import { createFocusHighlightPlugin } from "@roku-sdk/flex-grid/focus-highlight";
import { withZoomFocus } from "@roku-sdk/flex-grid/zoom-focus";
import type { Accessor } from "@roku-sdk/solid";

interface Card {
    title: string;
}

const PortraitCell: Component<CellRenderProps<Card>> = (props) => (
    <label text={props.item?.title ?? ""} width={props.width} />
);

const ZoomedPortraitCell = withZoomFocus(PortraitCell, {
    focusedScale: 1,
    unfocusedScale: 0.88,
    durationSec: 0.2
});

/**
 * @param gridHasFocus false while a tab bar or dialog owns focus, which drops
 *   every cell's focused styling via the highlight plugin's `visible`.
 */
export function zoomedShelfPlugins(gridHasFocus: Accessor<boolean>): GridPlugin<Card>[] {
    return [
        createFocusHighlightPlugin<Card>({ visible: gridHasFocus, renderNode: false })
    ];
}

export { ZoomedPortraitCell };
```

## A backdrop behind several rows

An image or colour behind a run of rows — a brand band under a pill row and a shelf — is
`createRowBackdropPlugin`, not row chrome. Chrome belongs to one row; this draws each region as
one node behind every row of the grid, which scrolls with the rows and glides with them when a
gap such as the bob opens above or inside it. Cards scroll over it horizontally.

| Field | Meaning |
|---|---|
| `regions` | An accessor returning `{ rows: [first, last], left?, width?, …your fields }[]`. `rows` is inclusive and is the region's **identity**: keep the tuple and the node stays; your other fields reach `render` as updates |
| `render` | `(region, size)` — runs **once per mount**, y = 0 at the region top. Read `region()` inside the JSX for anything that changes |
| `size.fill` | Pass as `ref` to each node spanning the whole region. The plugin owns its `id`, `width` and `height` and glides the height with the rows. The node must live as long as the region, so never put one under `<Show>` |
| `size.width`, `size.height` | Accessors. `height` is where the rows are heading, not tweened — place content that must not stretch against it |
| `above` / `below` | Px past the first row's cards and the last row's. `above` defaults to the grid's title reserve, so the band covers the first row's title; `below` to 0 |
| `left` / `width` | Default to the grid's viewport. In the coordinates the grid's `translation` uses, so `left: 0` with the screen width is full bleed on an inset grid |

A gap opening **inside** the region stretches it, so a `Poster` fill needs
`loadDisplayMode="scaleToZoom"` or the art distorts. A region more than about two viewports from
focus is unmounted and re-rendered on return, which reloads its images: bound them with
`loadWidth` / `loadHeight`, and set `uri` last so cached art does not draw before those apply.
`createPerfPlugin` reports each mount's nodes as "createElement called after warmup"; that is this
lifetime, not a leak.

`createRowBackdropPlugin` is a 3.x addition later than 3.0.0, so an install predating it has no
`@roku-sdk/flex-grid/row-backdrop` entry and the sample below does not compile there.

```tsx rsg-skill=complete
import type { GridPlugin } from "@roku-sdk/flex-grid";
import { createFocusHighlightPlugin } from "@roku-sdk/flex-grid/focus-highlight";
import { createRowBackdropPlugin } from "@roku-sdk/flex-grid/row-backdrop";
import type { Accessor } from "@roku-sdk/solid";

interface Card {
    title: string;
}

interface Brand {
    name: string;
    artUri: string;
}

const SCREEN_WIDTH = 1920;
const BAND_HEIGHT = 725;

/**
 * The selected brand's art across the whole screen behind rows 7 and 8. A new
 * brand updates the poster and label in place; the `rows` tuple never changes.
 */
export function brandBandPlugins(brand: Accessor<Brand>): GridPlugin<Card>[] {
    return [
        // First: a back-layer highlight listed before it would draw under the band.
        createRowBackdropPlugin({
            regions: () => [{ rows: [7, 8] as const, left: 0, width: SCREEN_WIDTH, brand: brand() }],
            render: (region, size) => (
                <group>
                    <poster
                        ref={size.fill}
                        loadWidth={SCREEN_WIDTH}
                        loadHeight={BAND_HEIGHT}
                        loadDisplayMode="scaleToZoom"
                        uri={region().brand.artUri}
                    />
                    <label text={region().brand.name} translation={[108, 284]} />
                </group>
            )
        }),
        createFocusHighlightPlugin<Card>({ layer: "back" })
    ];
}
```

## Cost of a plugin array

`plugins` is a structural prop, so a fresh array on every parent render remounts the grid and
drops focus. Build it once — a module-level constant, a `createMemo`, or a function called once
like the two above — and never inline the factory calls into JSX.
