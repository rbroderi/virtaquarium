<!-- @roku-sdk/ai managed v=1 hash=288740c2ede1f29e14dd391102dcd78d9edce59e402dd683d4c0bc9020239885 skills=1 do-not-edit -->

# Focus Recipes

Two procedures that need more than a row in a table, and that the body of the skill
therefore does not carry. Each is a whole screen's worth of decisions.

## Hand focus between regions of a screen

### First: check whether you need any code at all

A boundary hands its keys upward when the focused child declines them **and** its own
directional navigation finds no eligible neighbour. So for a regular layout — a menu on the
left, content on the right — the hand-off is already implemented: wrap both regions in one
boundary with `navigation="horizontal"`, and `right` at the menu's edge moves focus into the
content region with no callback anywhere. Reach for the recipe below only when the hand-off is
**conditional** (the target region has no data yet) or **non-directional** (`OK` on a menu row
jumps into the content it describes).

One region this recipe does not cover: a `FlexGrid`. It claims seven keys from the boundary — the
four movement keys, `OK`, `fastforward` and `rewind` — so neither the parent's navigation nor its
`onUnhandledKey` ever sees them, and the edge it reports arrives through the grid's own
`onEdgeReached`. Everything below still applies to the *receiving* side — `setFocus` is how focus
arrives at either kind of region.

### Then: capture `setFocus` inside the boundary that owns both regions

`useFocusActions()` resolves against the *nearest* boundary, and `setFocus` only reaches
identities registered with that one. Both region boundaries register with their common parent,
so the hook has to be called from a component rendered **inside** that parent — which is why
this pattern exists as a component that renders nothing.

```tsx rsg-skill=complete
import { Group, Label, Rectangle } from "@roku-sdk/components";
import { FocusBoundary, onPress, useFocusable, useFocusActions } from "@roku-sdk/navigation";
import { type Component, For, onCleanup } from "@roku-sdk/solid";

const menuId: object = {};
const contentId: object = {};
const firstMenuItemId: object = {};
const firstCardId: object = {};

const MENU = ["Home", "Movies", "Search"];
const CARDS = ["A", "B", "C", "D"];

function MenuRow(props: { label: string; focusId?: object; y: number; onEnter: () => void }) {
    const { ref, isFocused } = useFocusable({
        focusId: props.focusId,
        onKey: { OK: onPress(() => props.onEnter()) }
    });

    return (
        <group ref={ref} translation={[0, props.y]}>
            <rectangle width={320} height={64} color={isFocused() ? "0x0055FFFF" : "0x1A1A1AFF"} />
            <label text={props.label} translation={[24, 18]} />
        </group>
    );
}

function Card(props: { label: string; focusId?: object; x: number }) {
    const { ref, isFocused } = useFocusable({ focusId: props.focusId });

    return (
        <group ref={ref} translation={[props.x, 0]}>
            <rectangle width={240} height={135} color={isFocused() ? "0x0055FFFF" : "0x1A1A1AFF"} />
            <label text={props.label} translation={[16, 100]} />
        </group>
    );
}

export const TwoRegionScreen: Component<{ focusId?: object; hasContent: () => boolean }> = props => {
    // Written by the capture component below, read by the key handlers. Not a
    // signal: nothing renders from it, and a signal write here would be a
    // render-time update.
    let focusRegion: ((id: object) => void) | undefined;

    const CaptureRegionFocus: Component = () => {
        const { setFocus } = useFocusActions();
        focusRegion = setFocus;
        onCleanup(() => {
            focusRegion = undefined;
        });
        return null;
    };

    return (
        <FocusBoundary focusId={props.focusId} initialFocus={menuId} navigation="horizontal">
            <CaptureRegionFocus />

            <FocusBoundary
                focusId={menuId}
                initialFocus={firstMenuItemId}
                navigation="vertical"
                onUnhandledKey={{
                    // Non-directional hand-off: `right` is already handled by the
                    // parent's horizontal navigation, but OK is not.
                    OK: onPress(() => {
                        if (props.hasContent()) focusRegion?.(contentId);
                    })
                }}
            >
                <For each={MENU}>
                    {(label, index) => (
                        <MenuRow
                            label={label}
                            focusId={index() === 0 ? firstMenuItemId : undefined}
                            y={index() * 72}
                            onEnter={() => focusRegion?.(contentId)}
                        />
                    )}
                </For>
            </FocusBoundary>

            <group translation={[400, 0]}>
                <FocusBoundary
                    focusId={contentId}
                    initialFocus={firstCardId}
                    navigation="horizontal"
                    onUnhandledKey={{ back: onPress(() => focusRegion?.(menuId)) }}
                >
                    <For each={CARDS}>
                        {(label, index) => (
                            <Card
                                label={label}
                                focusId={index() === 0 ? firstCardId : undefined}
                                x={index() * 264}
                            />
                        )}
                    </For>
                </FocusBoundary>
            </group>
        </FocusBoundary>
    );
};
```

### Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| `setFocus` on a region does nothing | It was called from a hook whose nearest boundary is one of the regions, not their parent | Capture `setFocus` in a component rendered as a direct child of the parent boundary |
| The hand-off fires but focus lands on the wrong item | The region remembers where it was; that is `rememberLastFocus`, default `true` | Pass `rememberLastFocus={false}` on the region that should reopen at its first item |
| `back` inside a region exits the screen instead of returning to the menu | The region did not claim `back`, so it bubbled past the parent to the root | Declare `back` in that region's `onUnhandledKey`; a handler that returns nothing consumes the key and stops it there |
| The whole screen stops navigating after a region is added | The parent boundary has no `navigation` and no `navigationMap`, so it performs no movement at all — there is no default | Set the axis the regions are laid out on |

## Hold focus inside a dialog, and give it back

`ModalBoundary` and `useModal` from `@roku-sdk/components` implement this: enter on open,
dismiss on a key you name, restore on close. Do not hand-wire a boundary, a scrim and a
`Show` — the parts that are easy to get wrong are the ones this already does.

Placement is the whole trick. `useModal().open()` calls `setFocus` on the modal's identity, so
it must be called where the nearest boundary is the **common parent** of the content branch and
the `ModalBoundary` — the same rule as region hand-off above, for the same reason.

```tsx rsg-skill=complete
import { Group, Label, ModalBoundary, Rectangle, useModal } from "@roku-sdk/components";
import { FocusBoundary, onPress, useFocusable } from "@roku-sdk/navigation";
import { type Component, createSignal, For } from "@roku-sdk/solid";

const listId: object = {};
const firstRowId: object = {};
const confirmId: object = {};

const ROWS = ["Play", "Add to list", "Delete"];

function Button(props: { label: string; focusId?: object; x: number; onSelect: () => void }) {
    const { ref, isFocused } = useFocusable({
        focusId: props.focusId,
        onKey: { OK: onPress(() => props.onSelect()) }
    });

    return (
        <group ref={ref} translation={[props.x, 0]}>
            <rectangle width={240} height={64} color={isFocused() ? "0x0055FFFF" : "0x2B2B2BFF"} />
            <label text={props.label} translation={[24, 18]} />
        </group>
    );
}

/**
 * Rendered inside the boundary that owns both branches, which is what lets
 * `open()` reach the dialog.
 */
const ListWithConfirm: Component = () => {
    const confirm = useModal();
    const [result, setResult] = createSignal("");

    const finish = (answer: string): void => {
        setResult(answer);
        confirm.close();
    };

    return (
        <>
            <FocusBoundary focusId={listId} initialFocus={firstRowId} navigation="vertical">
                <For each={ROWS}>
                    {(label, index) => (
                        <Row
                            label={label}
                            focusId={index() === 0 ? firstRowId : undefined}
                            y={index() * 72}
                            onSelect={confirm.open}
                        />
                    )}
                </For>
                <label text={result()} translation={[0, 260]} />
            </FocusBoundary>

            <ModalBoundary
                show={confirm.isOpen()}
                focusId={confirm.focusId}
                initialFocus={confirmId}
                navigation="horizontal"
                onDismiss={confirm.close}
                dismissKeys={["back"]}
                dim="0x000000AA"
            >
                <group translation={[520, 360]}>
                    <rectangle width={880} height={240} color="0x14142AFF" />
                    <label text="Delete this item?" translation={[48, 36]} />
                    <group translation={[48, 140]}>
                        <Button label="Delete" focusId={confirmId} x={0} onSelect={() => finish("deleted")} />
                        <Button label="Cancel" x={280} onSelect={() => finish("kept")} />
                    </group>
                </group>
            </ModalBoundary>
        </>
    );
};

function Row(props: { label: string; focusId?: object; y: number; onSelect: () => void }) {
    const { ref, isFocused, hasFootprint } = useFocusable({
        focusId: props.focusId,
        onKey: { OK: onPress(() => props.onSelect()) }
    });

    // While the dialog is open every `isFocused()` in this branch is false, so the
    // row the dialog will return to is drawn from `hasFootprint()` instead.
    const color = (): string => {
        if (isFocused()) return "0x0055FFFF";
        return hasFootprint() ? "0x003399FF" : "0x1A1A1AFF";
    };

    return (
        <group ref={ref} translation={[0, props.y]}>
            <rectangle width={480} height={64} color={color()} />
            <label text={props.label} translation={[24, 18]} />
        </group>
    );
}

export const ScreenWithDialog: Component<{ focusId?: object }> = props => (
    <FocusBoundary focusId={props.focusId} initialFocus={listId}>
        <ListWithConfirm />
    </FocusBoundary>
);
```

### How the restore works, and why you do not write it

`close()` only clears `show`. Unmounting the dialog unregisters its boundary from the parent,
and the parent moves focus to the neighbour it sat next to in registration order — the content
branch. That branch then restores its own last focused child, because `rememberLastFocus`
defaults to `true`. Nothing in your code names the item focus returns to, which is why nothing
in your code can name the wrong one.

### The footprint is not dialog-specific

`hasFootprint()` is `!isActive() && focusedId() === focusId`, so it is true of any branch that is
not the active one and still remembers an item. A dialog above it is one cause; focus moving to a
sibling region is another. A row styled from it therefore keeps its subdued marker while the user
is over in the menu — usually what you want, but decide it rather than discover it. To mark only
the dialog case, pass the dialog's `isOpen()` down and gate the marker on it.

It is also evaluated against its own boundary alone, so a nested region focus will not pass back
through keeps marking its last child, and so does a region with `rememberLastFocus={false}` that
will reopen at `initialFocus`. When only items focus will actually land on should be marked,
use `hasReturnFootprint()` from `useFocusable` instead; `useFocusActions().hasReturnFootprint()`
answers the same question for the whole region. Each dormant sibling region under the nearest
active ancestor still marks its own item — the one focus reaches when the user moves there — so
the tree shows a single footprint only while the root itself is inactive.

### Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| The dialog appears but keys still drive the list behind it | `show` is true while focus never moved — `open()` was not used, or `focusId` differs between `useModal` and `ModalBoundary` | Drive both from one `useModal()`: `show={m.isOpen()}` and `focusId={m.focusId}` |
| `useModal` throws on mount | It was called outside any boundary | Call it from a component rendered inside the parent boundary |
| The dialog cannot be dismissed | No `dismissKeys` key was pressed, and no child claimed one | `dismissKeys` defaults to `back`; name every key that should close it, and wire `onDismiss` |
| The dialog opens with nothing focused | `initialFocus` names an identity that no child of the dialog registered | Point it at a button inside the dialog, or omit it entirely and let a hidden focusable be injected |
| Everything behind the dialog looks unfocused, including the row focus will return to | Correct, and by design: `isFocused()` is false throughout an inactive branch | Draw that indicator from `hasFootprint()` |
