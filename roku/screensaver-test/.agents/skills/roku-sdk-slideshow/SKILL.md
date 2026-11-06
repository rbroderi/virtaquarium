---
name: roku-sdk-slideshow
description: "Use when an RSG SDK TypeScript app shows one thing at a time and transitions between them — a hero banner, a full-screen image carousel, an onboarding or promo pager — built with @roku-sdk/slideshow: choosing among createSlideshow, createVirtualSlideshow and createPooledSlideshow, the JSX defineSlideshow wrapper that only wraps the eager one, slideFocusId and making a slide focusable, a pooled slideshow whose recycled templates can never take focus and how one entry in it is made reachable with the remote anyway, handing focus back to a sibling region at the first or last slide, and the DefaultChevrons and DefaultDotIndicator chrome. Not a row, shelf, poster grid or any screen that scrolls through many items at once, which is flex-grid; not which node draws the picture or the text inside a slide, which is sdk-components; and never video playback or the handoff from one video to the next, which this package has no part in."
# @roku-sdk/ai managed v=1 hash=ec0e3a6c995660f3d9a85ad37ef111d2eed38ef244c6db164b8dff72f21df1dd skills=1 do-not-edit
---

# Slideshow

## Overview

`@roku-sdk/slideshow` shows **one thing at a time** and animates between them — a hero banner, a
full-screen image carousel, an onboarding or promo pager. You give it a slide count, a slide size
and a `renderSlide` callback; it owns the tween, which slide is current, and the arrows and dots
drawn around the strip. Three factories render the same handle in three different ways, and they
differ most in how focus works, not in what they draw.

## Read the reference first for these tasks

| If the request is | Read now, before answering |
|---|---|
| Making a slide focusable, or a slide with buttons inside it | `references/focus-and-handoff.md` |
| Moving focus out of the slideshow at the first or last slide, or into it from a sibling region | `references/focus-and-handoff.md` |

The tables below name the callback and stop there. The three modes build focus in three different
ways, and the wiring each one needs — including which of them moves focus for you and which only
tells you it is time — is only in the reference. Answer a focus question from the reference and
quote it; an answer assembled from a table row here will describe the wrong mode.

## When to Use

- one item on screen at a time, with a transition between items
- a hero banner or promo pager the viewer steps through with left and right
- a full-screen image carousel
- an onboarding flow of panels
- any of the above where the panels themselves contain buttons

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| A row, shelf, poster grid, or any screen showing many items at once | The `flex-grid` skill | It owns rows, columns and cell recycling. This package has no notion of a row — it advances one whole slide at a time |
| Which node draws the picture, the text or the button inside a slide | The `sdk-components` skill | A slide's contents are ordinary components. This skill owns the strip around them, not what you put in one |
| Moving between whole screens rather than between panels of one screen | The `screen-navigation` skill | A slideshow is one screen's content; pushing and popping screens is a different mechanism |
| A row of buttons or a menu you laid out yourself | `FocusBoundary` + `useFocusable` from `@roku-sdk/navigation` | Nothing transitions, so the tween and slide bookkeeping cost more than the screen needs |

## Quick Reference

### Choosing a factory

| Your situation | Use | Import from |
|---|---|---|
| A handful of slides, and/or slides containing focusable buttons | `createSlideshow` | `@roku-sdk/slideshow` |
| Many slides, each cheap to build, and you do not want them all mounted | `createVirtualSlideshow` | `@roku-sdk/slideshow/virtual` |
| Many slides of a few repeated shapes, where building SceneGraph nodes is the cost | `createPooledSlideshow` | `@roku-sdk/slideshow/pooled` |
| You would rather write it as JSX than call a factory | `defineSlideshow<T>()` or `Slideshow` | `@roku-sdk/slideshow` |

`defineSlideshow` wraps **eager mode only**. There is no `defineVirtualSlideshow` and no
`definePooledSlideshow` — for those two, call the factory.

Eager is the only mode whose individual slides can take focus in the ordinary way. Pooled is the
opposite extreme: its recycled template slides cannot be focused at all.

### Config

| Field | Notes |
|---|---|
| `slideCount`, `slideWidth`, `slideHeight` | The three required fields |
| `items` | `(T \| undefined)[]`; `undefined` is a slide whose data has not arrived |
| `margin` | Gap **between** slides, default `0`. It is not padding around the strip |
| `translation` | `[x, y]` of the whole slideshow on screen |
| `renderSlide` | Optional; receives `index`, `item`, `focused`, `width`, `height`, `slideFocusId`, `goTo` |
| `initialIndex` | Default `0` |
| `animation` | `{ durationSec }` default `0.333`, `{ easeFunction }` default `"outCubic"` |
| `onSlideChange`, `onSelect` | `(index, item)` |
| `onEdgeReached` | `(edge)` where `edge` is `"first"` or `"last"` → `references/focus-and-handoff.md` |
| `focusId` | Identity the enclosing boundary's `initialFocus` or `setFocus` names |
| `chevrons`, `dots` | A component, or `false` to disable |
| `windowSize` | Virtual only; slides kept alive each side of current, default `1` |
| `templates`, `getTemplateId`, `poolSize`, `uniqueSlides` | Pooled only; `poolSize` defaults to `3` per template |

`onKeyEvent` also exists, but treat it as legacy: prefer letting keys reach the slideshow through
the focus chain, and use `onEdgeReached` for hand-off.

### The handle

All three factories return the same shape: `element`, `currentIndex`, `currentItem`,
`goTo(index, animated?)`, `next()`, `prev()`, `getCurrentIndex()`,
`updateSlides(startIndex, items)`, `setSlideCount(n)`.

Render it as `{element()}` — always call it.

### Chrome

| Component | Import from | Props |
|---|---|---|
| `DefaultChevrons` | `@roku-sdk/slideshow/chrome/chevrons` | `showLeft`, `showRight`, `onLeft?`, `onRight?`, `width`, `height` |
| `DefaultDotIndicator` | `@roku-sdk/slideshow/chrome/dots` | `slideCount`, `currentIndex`, `width`, `height` |

Pass the component itself — `chevrons: DefaultChevrons` — not an element. The factory binds the
props. Both are also re-exported from the package root for convenience.

## Example

A five-slide hero banner with chrome, taking focus from the root boundary:

```tsx rsg-skill=complete
import { FocusBoundary, useFocusable } from "@roku-sdk/navigation";
import { createSlideshow, DefaultChevrons, DefaultDotIndicator, FocusableSlide } from "@roku-sdk/slideshow";
import type { Component } from "@roku-sdk/solid";

const COLORS = ["0x1A1A2EFF", "0x0F3460FF", "0x533483FF", "0x2D6A4FFF", "0xE94560FF"];

const HeroBanner: Component = () => {
    const slideshowId = {};

    const { element } = createSlideshow<undefined>({
        slideCount: 5,
        slideWidth: 1720,
        slideHeight: 940,
        translation: [100, 40],
        margin: 200,
        focusId: slideshowId,
        chevrons: DefaultChevrons,
        dots: DefaultDotIndicator,
        onEdgeReached: (edge: "first" | "last") => console.log(`at the ${edge} slide`),
        renderSlide: ({ index, focused, width, height, slideFocusId, goTo }) => (
            <FocusableSlide slideFocusId={slideFocusId} onFocused={goTo}>
                <rectangle width={width} height={height} color={COLORS[index]} />
                <label text={`Slide ${index + 1}`} translation={[60, 60]} color="0xFFFFFFFF" />
                <label text={focused() ? "[ FOCUSED ]" : ""} translation={[60, 130]} color="0x88FF88FF" />
            </FocusableSlide>
        ),
    });

    return (
        <FocusBoundary focusId={{}} initialFocus={slideshowId}>
            {element()}
        </FocusBoundary>
    );
};

// `useFocusable` is what FocusableSlide uses internally for a non-interactive slide.
void useFocusable;
```

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| Slides render, but left and right do nothing and no slide is ever focused | `renderSlide` returns bare nodes, so nothing registers with the boundary | Wrap a non-interactive slide in `FocusableSlide` and hand it `slideFocusId` → `references/focus-and-handoff.md` |
| Nothing renders at all, or the strip appears only after a key press | `element` was rendered without calling it | It is a thunk: write `{element()}` |
| At the last slide, `onEdgeReached` fires but focus stays put | In eager and virtual modes the callback only *notifies* — it does not move focus | Call `setFocus` yourself in the callback → `references/focus-and-handoff.md` |
| A chevron is missing or half off the screen | Chevrons are drawn outside the slide box, roughly 80px beyond each edge | Give the slideshow enough `translation` room on both sides; `margin` will not help, it is the gap between slides |
| Chevrons or dots never appear | An element was passed instead of a component | Pass `chevrons: DefaultChevrons`, not `chevrons: <DefaultChevrons … />` |
| A pooled slide's buttons cannot be reached with the remote | Pooled templates render outside the focus context and can never be focused | List that index in `uniqueSlides`, which routes it through `renderSlide` instead of the pool |
| A virtual slideshow scrolls but focus lags a slide behind | `goTo` was wired into `onFocusGained` as eager mode requires | Virtual mode drives navigation itself — leave `goTo` for programmatic jumps such as an auto-advance timer |
| `slideRef` is not defined on the render props | It was renamed | It is `slideFocusId` |

## Source of truth

Prefer the typed source over any prose, including this file: read
`node_modules/@roku-sdk/slideshow/src/types.ts` for the config, the render props and the handle,
and the factory's own destructure for a default this file does not list.
