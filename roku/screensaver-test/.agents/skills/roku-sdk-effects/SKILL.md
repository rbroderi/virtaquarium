---
name: roku-sdk-effects
description: "Use when a Rectangle or Poster in an RSG SDK TypeScript app needs rounded corners, a border or a gradient fill through the Effect node — where to create the Effect and when one is rebuilt instead of updated, one Effect shared by several consumers, animating its fields with an interpolator that otherwise does nothing, shaderCompatible on a Poster whose corners stay square for some images, a gradient that never draws, corners that do not appear on some devices and how to detect that at runtime, and a child that still paints over the rounded corners. Not clipping or fading a group of children through an image mask, which is MaskGroup in sdk-components; and not createEffect or any other reactive primitive, which is solid-on-roku."
# @roku-sdk/ai managed v=1 hash=35f511f361faf49cfc1c01e421fb9997398bc0c9e90de106695a43ca0a97f762 skills=1 do-not-edit
---

# Effects

## Overview

`Effect` from `@roku-sdk/components` restyles a `Rectangle` or a `Poster` on the GPU: rounded
corners, a border, a linear or radial gradient. It draws nothing itself. You attach it through the
consumer's `effect` prop, which holds a **reference** to the node rather than a child, so one
effect can serve any number of consumers, and it restyles only its consumer — it clips nothing.
Effects need Roku OS 16.0 or later and the OpenGL backend; anywhere else the prop is ignored
without an error.

## When to Use

- rounded corners, a border or a gradient on a panel, a card, a button surface or a poster
- the same look on several nodes, or a look that changes with focus
- a border or a gradient that animates
- corners that come out on one device and not another, or on some images and not others
- a gradient or a padding value that is set and changes nothing

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Clipping or fading a group of children through an image | `MaskGroup` and its `maskUri`, in the `sdk-components` skill | An Effect restyles its consumer only; it never touches the subtree |
| `createEffect`, or any other reactive primitive | The `solid-on-roku` skill | Same word, unrelated API |
| A click or a chime | `SoundEffect` from `@roku-sdk/components`; no skill covers audio playback | It plays audio and draws nothing |
| The focus ring on a FlexGrid's focused cell | `createFocusHighlightPlugin`, in the `flex-grid` skill | The grid draws its own focus chrome; an Effect can style what that plugin's `render` returns |
| Rounded corners on Roku OS 15 or earlier, or in BrightScript | A 9-patch image on a `Poster` | The Effect node does not exist below OS 16 |

## Quick Reference

| Job | Write |
|---|---|
| Rounded corners | `const fx = <effect borderRadius={24} />;` then `effect={fx}` |
| One radius per corner | `borderRadius={[topLeft, topRight, bottomRight, bottomLeft]}` |
| A border | `borderWidth` and `borderColor`; it is drawn **outside** the consumer's rect |
| A linear gradient | `gradientStyle="linear"`, `gradientColors` (two to eight), `gradientAngle` in **degrees** |
| A radial gradient | `gradientStyle="radial"`, `gradientCentre` and `gradientRadius`, both normalised |
| The same look on several nodes | Pass the one `const` to each consumer's `effect` |
| A look that follows focus | One hoisted effect whose fields read the signal, or two hoisted effects and `effect={focused() ? on : off}` |
| An animated field | An `id` on the effect, `{fx}` rendered in the tree, `fieldToInterp="<id>.<field>"` |
| A Poster | Add `shaderCompatible` |
| Whether this device draws effects | `getDeviceInfo()` from `@roku-sdk/rsg-ts/runtime` — step 5 |

Colours are RGBA hex strings such as `"0xFF0000FF"`. The samples use the lowercase `<effect>`
intrinsic, as the `sdk-components` skill recommends for new code; the capitalised `Effect`
component is a pass-through for it, and every rule here holds for both spellings unchanged.

## Instructions

1. **Hoist every effect into a `const` and pass the identifier.** A signal read by an effect's own
   fields updates that node in place, hoisted or inline. What rebuilds the node is a signal read by
   the `effect={…}` expression itself — a ternary or a function call there builds a new effect node
   on every change and discards the old one, and nothing looks wrong on screen. Hoist each look and
   choose between the constants, and the expression can only ever pick an existing node. Prefer the
   `const` to `createMemo`, which reaches the same result with more machinery.

```tsx rsg-skill=no-check
// Rebuilt on every focus change: the expression builds the node.
<rectangle effect={focused() ? <effect borderWidth={6} /> : <effect borderWidth={0} />} />
```

2. **Share by passing the same `const`.** The consumer never parents a node it references, so one
   effect on a `Rectangle` and a `Poster` at once is well defined. No helper and no imperative
   setter is involved.

3. **To animate a field, give the effect an `id` and also render it into the tree.**
   `fieldToInterp` resolves its target through `findNode()`, which walks the scene tree, and a node
   held only by reference has no parent — the animation starts and silently moves nothing.
   Rendering `{fx}` as a sibling costs nothing, since an Effect is not drawn. Keep it in the same
   scope as the `Animation`. A tuple `borderRadius` cannot be interpolated; animate a single number.

```tsx
import { Animation, FloatFieldInterpolator } from "@roku-sdk/components";

const pulse = <effect id="tile-pulse" borderRadius={24} borderWidth={2} borderColor="0x9B59B6FF" />;

<group>
    {pulse}
    <rectangle width={300} height={300} color="0x1A1A2EFF" effect={pulse} />
    <Animation ref={animRef} duration={2} repeat={true} easeFunction="linear">
        <FloatFieldInterpolator fieldToInterp="tile-pulse.borderWidth" key={[0, 0.5, 1]} keyValue={[2, 14, 2]} />
    </Animation>
</group>;
```

4. **Set `shaderCompatible` on every `Poster` that takes an effect.** It asks for the bitmap to be
   decoded into a format shaders can use. Without it the effect may still apply, depending on how
   each source image decodes — which is how corners stay square on a few images and not the rest.
   A `Rectangle` needs nothing.

5. **Gate on the platform when the unstyled look is not acceptable.** Below Roku OS 16, or on a
   backend other than OpenGL, the prop is ignored with no error and the node type does not even
   exist. Check with `getDeviceInfo()` from `@roku-sdk/rsg-ts/runtime`: it can return `null`, and
   the test is `Number(info.osVersion.major) >= 16 && info.graphicsPlatform === "opengl"`. Answer it
   once per app and keep the result, as the example does: each call builds a new object, and a grid
   of tiles would otherwise ask once per tile. Asking again never changes the answer — the SDK keeps
   whatever the first call returned, `null` included. The firmware's own `supported`
   field on the Effect node cannot be read from TypeScript — it is set once when the node is
   created, before any handler can observe it — so do not reach for it. Nor can this check see
   effects switched off in the device's configuration.

6. **An Effect clips nothing.** A child of a rounded `Rectangle` can paint into and past the
   corners. Lay children out inside the rounded area; to clip them to a shape, use `MaskGroup`.

7. **Know the fields that fail silently on device.** A gradient draws nothing while
   `gradientStyle` is `"none"`, its default, or with fewer than two or more than eight
   `gradientColors`. `gradientStops` needs one entry per colour in `[0, 1]`. In `__DEV__` builds
   the SDK warns once per distinct problem (and stays quiet while `gradientStyle` is `"none"`,
   including empty colors/stops). `borderPadding` is the gap between the border and the content,
   so with `borderWidth` at `0` it changes nothing — inset a child with layout instead.
   `gradientFillContent` defaults to `true` and
   `gradientFillBorder` to `false`.

8. **`setPropMethod("effect")` is not how you share.** It builds a property descriptor for
   `registerImperativeMethods`, which gives every node of a tag an imperative method that sets
   `effect` — the same call the prop makes. Reach for it only when *which* node a consumer points at
   changes outside render and a reactive expression would be worse, such as moving one focus effect
   between the cells of a large grid from a key handler. Register once per tag, before the first
   node of that tag is created.

## Example

A tile whose frame follows focus, shared by its background and its artwork, with a plain outline
on devices that do not draw effects:

```tsx rsg-skill=complete
import { getDeviceInfo } from "@roku-sdk/rsg-ts/runtime";
import { Show } from "@roku-sdk/solid";

let drawsEffects: boolean | undefined;

function deviceDrawsEffects(): boolean {
    if (drawsEffects === undefined) {
        const info = getDeviceInfo();
        drawsEffects = info !== null && Number(info.osVersion.major) >= 16 && info.graphicsPlatform === "opengl";
    }
    return drawsEffects;
}

export function Tile(props: { posterUri: string; focused: boolean }) {
    const effectsOn = deviceDrawsEffects();

    const idle = <effect borderRadius={24} />;
    const ring = <effect borderRadius={24} borderWidth={6} borderColor="0xFFFFFFFF" />;

    return (
        <>
            <Show when={!effectsOn && props.focused}>
                <rectangle width={312} height={182} translation={[-6, -6]} color="0xFFFFFFFF" />
            </Show>
            <rectangle width={300} height={170} color="0x1A1A2EFF" effect={props.focused ? ring : idle} />
            <poster
                width={300}
                height={170}
                loadDisplayMode="scaleToZoom"
                shaderCompatible
                effect={props.focused ? ring : idle}
                uri={props.posterUri}
            />
        </>
    );
}
```

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| Moving focus or changing selection feels heavier, and nothing looks wrong | The `effect={…}` expression reads a signal and builds a new node on every change | Hoist each effect into a `const` and choose between the constants |
| An `Animation` targeting an effect field starts and moves nothing | `findNode()` cannot see a node held only by reference | Give the effect an `id` and render `{fx}` next to the `Animation` |
| Some Posters show the effect and a few stay square | Whether the bitmap decodes into a shader-usable format varies by image | Set `shaderCompatible` on every Poster that takes an effect |
| Corners, borders and gradients show on one device and not on another, with no error | That device runs Roku OS 15 or earlier, or not OpenGL | Gate on `getDeviceInfo()` and give those devices a fallback look |
| `gradientColors` is set and no gradient draws | `gradientStyle` is still `"none"`, or there are fewer than two colours | Set `gradientStyle` to `"linear"` or `"radial"` |
| A child paints over the rounded corners | An Effect restyles its consumer and never clips | Keep the child inside the rounded area, or clip it with `MaskGroup` |
| `borderPadding` has no visible effect | It only spaces a border from the content, and `borderWidth` is `0` | Inset the child with layout |
| A tuple `borderRadius` will not animate | Per-corner radii are one Vector4 field, not a float | Animate a single-number `borderRadius` |

## Source of truth

Prefer the typed source over any prose, including this file: read
`node_modules/@roku-sdk/components/src/sg-nodes/effect.props.ts` for every field, its type and its
default. The same wiring runs in the **Effect** entry of the SDK's showcase example.
