<!-- @roku-sdk/ai managed v=1 hash=772f84a40edd421a1c57b1d6dbdb1a4e0643b69478207ad25ceffb7b33d625fc skills=1 do-not-edit -->

# Slideshow focus and hand-off

Everything focus-related imports from `@roku-sdk/navigation`, never from `@roku-sdk/components`.

## The three modes build focus three different ways

This is the fact the body cannot compress, and it decides every answer below.

| Mode | What it renders | How left/right move | At the first or last slide |
|---|---|---|---|
| `createSlideshow` (eager) | A `FocusBoundary` with `navigation="horizontal"` | The boundary walks between slide positions | Fires `onEdgeReached`, and **keeps** the key |
| `createVirtualSlideshow` | A `FocusBoundary` with no `navigation` | The factory calls `prev()` / `next()` and moves focus itself | Fires `onEdgeReached`, and **keeps** the key |
| `createPooledSlideshow` | **No boundary** — a single leaf `useFocusable` | Its `onKey` handlers advance the index | Declines the key, so focus leaves on its own |

Two consequences worth stating outright:

- **In eager and virtual modes, `onEdgeReached` does not move focus.** It tells you the viewer
  pushed past the end. Moving focus is your job, with `setFocus` from `useFocusActions()`.
- **In pooled mode you often need no hand-off code at all.** Its edge handler returns `bubble`, so
  the key bubbles and the enclosing boundary's `navigationMap` decides where focus goes.

## `slideFocusId`

`renderSlide` receives `slideFocusId: object` — an opaque identity created once per slide
**position** at factory init, not a node ref and not derived from the item. It stays with the
position when the data changes, and `setSlideCount` grows the list.

Also on the render props: `goTo()`, already bound to that slide's index, so you call it with no
arguments.

## A non-interactive slide

A slide that is only a picture and a caption still has to register, or nothing in the slideshow
is focusable and no key does anything. `FocusableSlide` is the helper for exactly this:

```tsx rsg-skill=complete
import { createSlideshow, FocusableSlide } from "@roku-sdk/slideshow";
import type { Component } from "@roku-sdk/solid";

const Banner: Component = () => {
    const { element } = createSlideshow<undefined>({
        slideCount: 3,
        slideWidth: 1720,
        slideHeight: 940,
        focusId: {},
        renderSlide: ({ index, width, height, slideFocusId, goTo }) => (
            <FocusableSlide slideFocusId={slideFocusId} onFocused={goTo}>
                <rectangle width={width} height={height} color="0x1A1A2EFF" />
                <label text={`Panel ${index + 1}`} translation={[60, 60]} color="0xFFFFFFFF" />
            </FocusableSlide>
        ),
    });
    return <>{element()}</>;
};
```

`onFocused={goTo}` is what keeps the strip in sync when focus lands on a slide. In **eager** mode
wire it. In **virtual** mode you may leave it off — that factory moves focus itself — and `goTo`
is then only for programmatic jumps such as an auto-advance timer.

## A slide with buttons in it

An interactive slide is a nested boundary, and `slideFocusId` is its `focusId`. Wire each
button's `onFocusGained` to `goTo` so the strip follows focus into the slide:

```tsx rsg-skill=complete
import { FocusBoundary, useFocusable } from "@roku-sdk/navigation";
import { createSlideshow } from "@roku-sdk/slideshow";
import type { Component } from "@roku-sdk/solid";

const Button: Component<{ label: string; x: number; focusId: object; onFocused: () => void }> = props => {
    const { isFocused, ref } = useFocusable({
        focusId: props.focusId,
        onFocusGained: () => props.onFocused(),
        onKey: { OK: (press: boolean) => { if (press) console.log(props.label); } },
    });
    return (
        <group ref={ref} translation={[props.x, 0]}>
            <rectangle width={200} height={70} color={isFocused() ? "0x0066FFFF" : "0x333333FF"} />
            <label text={props.label} width={200} height={70} horizAlign="center" vertAlign="center" />
        </group>
    );
};

const Pager: Component = () => {
    const { element } = createSlideshow<undefined>({
        slideCount: 3,
        slideWidth: 1720,
        slideHeight: 940,
        focusId: {},
        renderSlide: ({ width, height, slideFocusId, goTo }) => {
            const btnIds: object[] = [{}, {}];
            return (
                <group>
                    <rectangle width={width} height={height} color="0x0F3460FF" />
                    <FocusBoundary focusId={slideFocusId} initialFocus={btnIds[0]} navigation="horizontal">
                        <Button label="Play" x={0} focusId={btnIds[0]} onFocused={goTo} />
                        <Button label="More" x={220} focusId={btnIds[1]} onFocused={goTo} />
                    </FocusBoundary>
                </group>
            );
        },
    });
    return <>{element()}</>;
};
```

Only **eager** mode supports this. Pooled `templates` receive `PooledSlideRenderProps`, which
carries neither `slideFocusId` nor `goTo` — a pooled template can never be focusable. To make one
particular pooled slide interactive, name its index in `uniqueSlides`; those bypass the pool and
go through `renderSlide` with the full render props.

## Taking focus in

Give the slideshow a `focusId` and name it from the enclosing boundary:

```tsx rsg-skill=complete
import { FocusBoundary } from "@roku-sdk/navigation";
import { createSlideshow } from "@roku-sdk/slideshow";
import type { Component } from "@roku-sdk/solid";

const Screen: Component = () => {
    const slideshowId = {};
    const { element } = createSlideshow<undefined>({
        slideCount: 4,
        slideWidth: 1720,
        slideHeight: 700,
        focusId: slideshowId,
    });
    return (
        <FocusBoundary focusId={{}} initialFocus={slideshowId}>
            {element()}
        </FocusBoundary>
    );
};
```

When `focusId` is set, the handle's `element()` **must** be rendered inside a `FocusBoundary`.

## Handing focus back out

In eager and virtual modes, do it in `onEdgeReached`. The argument is `"first"` or `"last"` —
horizontal ends, not `"left"` / `"right"` and not a vertical edge:

```tsx rsg-skill=complete
import { FocusBoundary, useFocusActions } from "@roku-sdk/navigation";
import { createSlideshow } from "@roku-sdk/slideshow";
import type { Component } from "@roku-sdk/solid";

const Screen: Component = () => {
    const slideshowId = {};
    const menuId = {};

    const Inner: Component = () => {
        const { setFocus } = useFocusActions();
        const { element } = createSlideshow<undefined>({
            slideCount: 4,
            slideWidth: 1720,
            slideHeight: 700,
            focusId: slideshowId,
            onEdgeReached: (edge: "first" | "last") => {
                if (edge === "last") setFocus(menuId);
            },
        });
        return <>{element()}</>;
    };

    return (
        <FocusBoundary focusId={{}} initialFocus={slideshowId}>
            <Inner />
        </FocusBoundary>
    );
};
```

`useFocusActions()` must be called inside the boundary, which is why the slideshow is built in an
inner component here rather than beside the boundary that owns it.

For **pooled** mode this is usually unnecessary: its edge handler returns `bubble`, the key bubbles
to the enclosing boundary, and a `navigationMap` entry there moves focus. Add `onEdgeReached` only
when you need to run something else at the edge as well.

## Things that do not exist

`slideRef` was renamed to `slideFocusId`, and the config field `focusRef` to `focusId`. There is
no `navigationMap` on a slideshow config, no per-slide `nextFocus*` property, and no
`onSlideExit`. Hand-off is `onEdgeReached` plus `setFocus`, or bubbling in pooled mode.
