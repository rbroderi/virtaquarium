<!-- @roku-sdk/ai managed v=1 hash=afac20b556f0e5c2c7aaccad90fb33129625a61df31c6eacc351c2208710b50e skills=1 do-not-edit -->

# SceneGraph Node Spelling: Intrinsics vs. Component Wrappers

Most SceneGraph nodes can be written two ways in an RSG SDK TypeScript app:

```tsx
import { Rectangle } from "@roku-sdk/components";

<Rectangle width={200} height={100} color="0x333355FF" />;
```

```tsx
<rectangle width={200} height={100} color="0x333355FF" />;
```

Both compile. Both type-check against the same `IRectangleProps`. Both produce the same node
at runtime. The capitalised form is a component whose entire body is
`props => <rectangle {...props} />`.

**Recommended for new work: the lowercase intrinsic.** The wrappers are supported and are not
deprecated — an existing app has no reason to churn, and either spelling is a legitimate
choice. This page explains the recommendation so the reasoning travels with it.

## Why the intrinsic is recommended

The lowercase tag is the node. The capitalised export adds a component to the tree that exists
only to spread its props straight through, so the intrinsic is one less indirection between
what you write and what renders.

It also needs no import, which removes a class of mistake rather than merely discouraging one.
Capitalised names collide with names an app plausibly wants for its own components — `Button`,
`Panel`, `Video` and `ProgressBar` are all reasonable names for something in your own codebase,
and importing ours shadows yours.

The remaining reason is consistency. Two spellings with no stated preference means every author
and every code-generating agent picks arbitrarily, and a codebase ends up with both. Picking one
for new work is worth more than which one gets picked.

## The `<Group>` alias, which used to be a trap

`Group` was once registered as a capitalised JSX intrinsic under `@roku-sdk/solid` — uniquely in
the package, nothing else was. A file could write `<Group>` with no import at all and still
compile, so a forgotten or misspelled `Group` import did not fail the build and a layout could
misbehave with nothing to point at.

That alias has been removed. `Group` is now an ordinary export like every other wrapper: import
it if you want it, or write `<group>` for the node. Both spell the same node, and the
recommendation above still applies — prefer `<group>`.

## Put event handlers first in the attribute list

This one matters for correctness, not style, and it applies specifically to intrinsics.

A capitalised wrapper spreads its props (`props => <rectangle {...props} />`), and the spread
path reorders event handlers ahead of regular props before any of them are applied. An intrinsic
written with inline attributes does not go through that path: the compiler emits one
`setProp` call per attribute, in source order, and nothing reorders them.

So for an intrinsic, the order you write the attributes in is the order they are applied. If a
property assignment can synchronously fire an event, and its handler is written after that
property, the event fires before the handler exists and is lost:

```tsx rsg-skill=no-check
// Wrong: if the image is already in the cache, the load completes during the
// uri assignment — before onLoadStatus is registered — and the event is dropped.
<poster uri={posterUri} onLoadStatus={handleLoad} />

// Right: the handler is registered before the property that can fire it.
<poster onLoadStatus={handleLoad} uri={posterUri} />
```

This is the same defect that was fixed for the spread path only. Inline intrinsic attributes
are applied in source order, so write handlers first. It is a good habit regardless, since it
makes the ordering explicit rather than incidental.

## Where the recommendation is binding

Samples, demos, documentation examples and the packaged AI skills should use intrinsics
consistently. This is the part that does the work — code-generating agents imitate surrounding
code far more reliably than they follow prose guidance, so example code that uses the
capitalised form teaches the capitalised form regardless of what any doc says.

Application code is the developer's call. Nothing here is enforced by lint, and no wrapper is
scheduled for removal.

## Nodes with no intrinsic equivalent

Some exports are not pass-throughs. They add behaviour, and the capitalised component is the
only correct way to use them:

| Component | What it adds |
|---|---|
| `Audio` | Renders `content` as a child rather than spreading props alone |
| `VideoContentNode` | A distinct typed view over `<contentNode>` |
| `CustomKeyboard`, `DynamicKeyboard`, `DynamicKeyGrid`, `DynamicMiniKeyboard`, `DynamicPinPad` | Call `retainAsset()` so the backing XML survives tree-shaking |
| `Dialog`, `StandardDialog`, `StandardKeyboardDialog`, `StandardMessageDialog`, `StandardPinPadDialog`, `StandardProgressDialog` | Wrap their node in `<Modal>` |
| `ListPanel` | Forwards to `<managedListPanel>`, a different node |
| `Focusable`, `FocusableGroup`, `KeyHandler`, `Modal`, `Container`, `ButtonRow`, `BlendedBusySpinner`, `BoundingTracker`, `ChannelStore` | Real logic, no single backing node |

Writing a lowercase tag in place of one of these either fails to compile or silently drops the
behaviour the wrapper existed to provide.

## Migrating (optional)

Props, types and rendered output are unchanged, so the edit is mechanical and the import can
usually be dropped:

```tsx
// before
import { Group, Rectangle, Label } from "@roku-sdk/components";

<Group>
    <Rectangle width={w} height={h} color="0x333355FF" />
    <Label text="Hello" horizAlign="center" />
</Group>;

// after
<group>
    <rectangle width={w} height={h} color="0x333355FF" />
    <label text="Hello" horizAlign="center" />
</group>;
```

Check the table above first — a `Dialog` or a `CustomKeyboard` must keep its wrapper.
