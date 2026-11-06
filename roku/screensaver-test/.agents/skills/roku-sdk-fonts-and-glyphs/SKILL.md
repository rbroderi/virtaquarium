---
name: roku-sdk-fonts-and-glyphs
description: "Use when text in an RSG SDK TypeScript app needs a typeface or a symbol and the wrong thing renders — an arrow, chevron, star or check mark taken from the RokuFont01 constants instead of a Unicode character the firmware may not have, text coming out as empty boxes, symbols that disappeared once the app shipped a font of its own, whether fallbackGlyph does anything about that, importing a .ttf or .otf and the build refusing two files that share a name, a typeface that renders unreadably small because its size was left at the default, and a SimpleLabel whose fontSize is ignored because the built-in font name it was given is a fixed-size one."
# @roku-sdk/ai managed v=1 hash=35f7423bc84e66cbb56dc9ad2455c59dfd85cc3ec2635aeb3efeec3e3a607a5c skills=1 do-not-edit
---

# Fonts and Glyphs

## Overview

Two questions decide whether text in an RSG SDK app renders the way you meant: which typeface is
supplying the characters, and whether that typeface actually has them. Get the first wrong and
text comes out at a size nobody can read, or ignores the size you set. Get the second wrong and
you ship empty boxes — and the boxes appear on a device you did not test, because the firmware's
fallback font hides the problem everywhere else.

## When to Use

- text rendering as empty boxes, on any device or only on some, and whether `fallbackGlyph` helps
- symbols that were fine until the app started shipping a typeface of its own
- a symbol needed in a label — arrow, chevron, star, check mark, remote-button icon
- text that renders far too small, or ignores the size you set
- shipping a `.ttf` or `.otf` with the app, and a build that refuses two of them
- deciding whether a shape should be a character at all

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Which node draws the text — `Label`, `SimpleLabel`, `ScrollingLabel`, `MultiStyleLabel` | The `sdk-components` skill | This skill owns the typeface, that one owns the node |
| Brand marks, multi-colour or gradient artwork | The `sdk-components` skill | That is a `Poster` and an image, not a character |
| Where an asset file belongs in the project before anything can import it | The `project-setup` skill | Project layout is that skill's job |

## Read the reference first for this task

| If the request is | Read now, before answering |
|---|---|
| Naming a specific glyph constant, or auditing which ones survive a custom font | `references/glyph-tables.md` |

The body tells you which *group* a symbol falls in and what that means. The 45 constants, their
codepoints and their three groups are only in the reference. Guessing a constant name is the one
mistake here that compiles.

## Quick Reference

| Job | Reach for |
|---|---|
| Any arrow, chevron, star, tick, or remote-button icon | A named constant from `@roku-sdk/components/glyphs` — never a typed or escaped literal |
| A character you can simply type (`·`, `°`, currency, quotes, maths) | Type it. These get no constants on purpose |
| A brand mark or anything multi-colour | Not a character at all — that is `sdk-components` territory |
| Set a typeface on a `Label` | A `Font` node in the `font` prop, with **both** `uri` and `size` |
| `Font.size` | Points. **Defaults to 1**, which is why an otherwise correct font renders as a line of dots |
| Set a typeface on a `SimpleLabel` | `fontUri` plus `fontSize` — no `Font` node |
| Built-in font names | Ten. The eight `font:…SystemFont` names are **fixed size and ignore `fontSize`**; only `font:SystemFontFile` and `font:BoldSystemFontFile` respect it |
| Ship a typeface with the app | `import fontUri from "./fonts/whatever.ttf"` — the import resolves to the packaged path at build time |
| Two font files with the same filename | A build error if their contents differ, reuse if identical. Rename one |
| Wait until a font can be measured | `whenFontReady(ref)` or `createFontReady(fontRef)` from `@roku-sdk/rsg-ts/runtime` — never a fixed timer |
| Text arriving from outside with characters your font lacks | Constrain the text or widen the typeface. **`Font.fallbackGlyph` does not substitute anything on current firmware** — see instruction 8 |
| A `Font` with a `size` and no `uri` | Draws nothing at all. It does not fall back to the system font — omit the `Font` node instead |
| Which symbols survive a custom app font | The 32 private-use glyphs and `●` `★` `☆`. The other ten do not |

## Instructions

1. **Take symbols from the constants, not from your keyboard or an escape.** Import by name from
   `@roku-sdk/components/glyphs` and interpolate. A literal like `"\uE025"` is the same character
   today and an unlabelled magic number the moment the font revision moves; the constant for that
   one is `LEFT_BUTTON_GLYPH`.

2. **Know the one fact that decides whether a symbol renders: which font supplies it.** The
   constants are grouped by that, not by codepoint:
   - **RokuFont01 private-use glyphs** (32 of them) — RokuFont01 is the firmware's system-wide
     fallback font, so these render under a system font *and* under a custom app font.
   - **Unicode characters that RokuFont01 backs** — `●` `★` `☆`. Same fallback, so also safe.
   - **RokuUI-Regular symbols** (10 of them — the arrows, dashes, bullet, ellipsis, tick and
     ballot X). RokuUI-Regular is the default UI font but is **not** in the fallback chain. Under
     a system font they are fine; under a custom app font they get no backstop and go tofu unless
     your font happens to supply them.

   So the counter-intuitive part: if your app ships a typeface, the constants that need care are
   the plain-Unicode-looking ones, not the exotic private-use ones.

3. **Remember that a custom font wins outright where it defines a codepoint.** No fallback occurs.
   A licensed font carrying its own private-use glyphs at `U+E0xx` will render *those* in place of
   the Roku icons, which looks like corruption rather than a font choice.

4. **Give a `Font` node a `size`, always.** `Font.size` is in points and defaults to **1**. A
   `Font` with a correct `uri` and no `size` is the classic "the font loaded but the text is
   unreadable" report. Set both together and treat them as one prop.

5. **On `SimpleLabel`, use `fontUri` and `fontSize` — and know which built-in names ignore the
   size.** Of the ten built-in names, eight are fixed-size (`font:Smallest…`, `font:Small…`,
   `font:Medium…`, `font:Large…`, each plain and `Bold`) and **discard `fontSize` silently**. Only
   `font:SystemFontFile` and `font:BoldSystemFontFile`, and any font file of your own, respect it.
   If a size change does nothing, the name is the reason.

6. **Import font files; do not write packaged paths by hand.** `import fontUri from
   "./fonts/inter.ttf"` gives you a string that is the packaged path, and the build copies the
   file for you. Both `.ttf` and `.otf` are declared. Writing the path as a literal skips the copy
   and ships a reference to a file that is not there.

7. **Expect a build error when two font files share a filename.** The build keys them by filename
   alone, so two files called `Inter.ttf` in different directories collide. Identical contents are
   silently reused; different contents fail the build with a `Font naming conflict` naming both
   sources. Rename one — the directory does not disambiguate them.

8. **Do not plan around `fallbackGlyph`.** `Font.fallbackGlyph` reads like the answer to
   uncontrollable text — a character of your choosing instead of a box — and on current firmware
   it does not deliver one. Measured on a Roku Native running 16.0.4: set as a bare `u25CF` (the
   form the SDK's own documentation shows) and as a literal `●`, against both a symbol only the
   default UI font has and a codepoint no font on the device has, the boxes were unchanged in
   every combination. The property is real and the SDK does forward it; what is missing is any
   visible effect. Treat unsupported characters as something to prevent, not something to
   substitute: constrain the text, or ship a typeface that covers it.

9. **Do not use firmware placeholder syntax for app text.** Translated firmware strings may
   contain tokens like `{BACK_BUTTON_GLYPH}`. Those are runtime text tokens resolved by the
   firmware's own string layer, not TypeScript symbols; putting one in a label renders the braces
   literally. Interpolate the imported constant instead.

10. **Wait for a font with `whenFontReady`, not a timer.** `getFontMeasure()` throws
    `"Font is not yet loaded"` until the GfxFont is published. Current firmware has no Font
    `loadStatus` field; use `whenFontReady(ref)` (promise) or `createFontReady(fontRef)`
    (Solid accessor that cancels on cleanup; pass `() => props.uri` or similar as its second
    argument when the `<font>` node's `uri` or `size` can change) from `@roku-sdk/rsg-ts/runtime`, which keep
    working when one ships. Do not copy the fixed 100ms / 500ms timer stubs from older
    examples — those race on a cold cache. A `<font>` that is not on a drawn label is only
    published if `preUpdate` is set before `uri` and `size`; without it the font never loads
    and the wait never resolves.

## Measuring a font

`whenFontReady` and `createFontReady` ship in SDK 2.19.0. On 2.18.0 and earlier they are
not exported from `@roku-sdk/rsg-ts/runtime`.

Capture the Font node's `TmNodeRef` from `ref={node => … node.r}`, then wait before measuring:

```tsx rsg-skill=complete
import { getFontMeasure, whenFontReady, createFontReady } from "@roku-sdk/rsg-ts/runtime";
import { createEffect, createSignal, type Component } from "@roku-sdk/solid";
import type { TmNodeRef } from "@roku-sdk/interfaces";

export const MeasuredTitle: Component<{ text: string; uri: string }> = props => {
    const [fontRef, setFontRef] = createSignal<TmNodeRef>();
    // The key restarts the wait when `uri` changes on this same <font> node.
    const fontReady = createFontReady(fontRef, () => props.uri);
    const [width, setWidth] = createSignal(0);

    createEffect(() => {
        if (!fontReady()) return;
        const ref = fontRef();
        if (!ref) return;
        setWidth(getFontMeasure().getOneLineWidth(ref, props.text, 1920));
    });

    return (
        <label
            text={props.text}
            width={width() || 600}
            height={48}
            color="0xFFFFFFFF"
            font={<font uri={props.uri} size={32} ref={node => setFontRef(node.r)} />}
        />
    );
};

// Imperative form (same wait, no Solid helper):
async function measureOnce(ref: TmNodeRef, text: string): Promise<number> {
    await whenFontReady(ref);
    return getFontMeasure().getOneLineWidth(ref, text, 1920);
}
```

## Example

A row of chevrons and a rating, using a bundled typeface — imported, sized, and with a fallback
character for anything the typeface lacks.

```tsx rsg-skill=complete
import { BLACK_STAR, LEFT_BUTTON_GLYPH, RIGHT_BUTTON_GLYPH, WHITE_STAR } from "@roku-sdk/components/glyphs";
import { Font, Label, LayoutGroup } from "@roku-sdk/components";

import titleFontUri from "./fonts/title.ttf";

function Rating(props: { filled: number; total: number }) {
    return (
        <label
            text={BLACK_STAR.repeat(props.filled) + WHITE_STAR.repeat(props.total - props.filled)}
            width={200}
            height={48}
            color="0xFFFFFFFF"
        />
    );
}

export function CarouselChrome(props: { title: string; rating: number }) {
    return (
        <layoutGroup layoutDirection="horiz" itemSpacings={[16]}>
            {/* Private-use glyphs: the firmware fallback covers these even under a custom font. */}
            <label text={LEFT_BUTTON_GLYPH} width={48} height={48} color="0xFFFFFFFF" />
            <label
                text={props.title}
                width={600}
                height={48}
                color="0xFFFFFFFF"
                // `size` is not optional in practice -- its default is 1 point,
                // and a `Font` without a `uri` draws nothing at all.
                font={<font uri={titleFontUri} size={32} />}
            />
            <Rating filled={props.rating} total={5} />
            <label text={RIGHT_BUTTON_GLYPH} width={48} height={48} color="0xFFFFFFFF" />
        </layoutGroup>
    );
}
```

## Anti-patterns

Keyed by what you see on screen, because that is what arrives first.

| Symptom | Cause | Fix |
|---|---|---|
| Text shows empty boxes where symbols should be | The character is in neither font — geometric arrows like `◀` `▶` are the usual culprit | Use the named constant; `LEFT_ARROW` and friends are the shapes that exist |
| Arrows, ticks and dashes vanished after the app shipped its own typeface | Those are RokuUI-Regular symbols and get no RokuFont01 backstop under a custom font | Keep them in system-font text, or make the custom typeface supply them |
| Icons turned into unrelated shapes under a custom typeface | The custom font defines the same private-use codepoints and wins outright | Use a font without private-use glyphs, or draw those icons in system-font text |
| Text renders at size 1 — a readable string, unreadably small | `Font.size` was left at its default | Set `size` whenever you set `uri` |
| Changing the size does nothing at all | The `fontUri` names one of the eight fixed-size built-ins | Switch to `font:SystemFontFile` or a font file |
| Characters from a backend show as boxes and `fallbackGlyph` changed nothing | It has no visible effect on current firmware, in either value form | Constrain the text or widen the typeface; do not keep tuning the value |
| A label went completely blank after a `Font` node was added | The `Font` has a `size` but no `uri`, which draws nothing rather than falling back | Give it a `uri`, or drop the `Font` node and let the system font apply |
| The build fails naming two font files | Same filename, different contents, keyed by filename | Rename one of them |
| A private-use escape like `"\uE0nn"` sits in app code | The constant exists and the literal does not say which symbol it is | Import the constant |
| Braces render literally in a label | Firmware placeholder syntax used as app text | Interpolate the constant |
| `getFontMeasure` throws `"Font is not yet loaded"` or returns 0 | Measured before the GfxFont published; a fixed timer was too short | `await whenFontReady(ref)` or `createFontReady(fontRef)` — never a fixed timer |

The glyph groups here are device-verified against firmware 15.3.5 on a Roku Express 4K+ — every
constant rendered in a label under a custom typeface. Re-verify on a device rather than re-wording
if you need to change what they claim. `IFontProps` and `ISimpleLabelProps` carry TSDoc in the
installed package; prefer it over any prose, including this file, when the two disagree.
