<!-- @roku-sdk/ai managed v=1 hash=a8fdd35739e69d28ba030f937edd7295572be15b8ec0acad7dd4a931704726c6 skills=1 do-not-edit -->

# Composing a StandardDialog

A `StandardDialog` is assembled from areas, and each area holds items. Nothing about it is
positioned by hand: the dialog sizes and stacks its own areas, and `width` / `height` default
to the system size (1038 FHD, 692 HD) when left at 0.

## The areas

| Area | Where it goes | Required |
|---|---|---|
| `StdDlgTitleArea` | Top, at most one | — |
| `StdDlgContentArea` | Between title and buttons, at most one | — |
| `StdDlgButtonArea` | Always the bottom, at most one | — |
| `StdDlgSideCardArea` | Left or right of the rest, at most one | `width` |
| `RsgPalette` | A child, or the `palette` prop | `colors` |

Ordering in the JSX does not decide layout — the dialog places each area by its type — but
writing them top-to-bottom keeps the source readable.

## The items that go in the content area

`StdDlgTextItem` (`text`) and `StdDlgMultiStyleTextItem` (`drawingStyles`, `audioGuideText`)
for prose, `StdDlgBulletTextItem` for a list, `StdDlgGraphicItem` for an image,
`StdDlgProgressItem` (`text`) and `StdDlgDeterminateProgressItem` for progress,
`StdDlgKeyboardItem` for entry, and `StdDlgCustomItem` when nothing else fits.

Wrap a set of choices in a `StdDlgItemGroup`: it tightens the spacing and enforces
one-of-N selection across the `StdDlgActionCardItem`s inside it. An action card is focusable
and holds its own `StdDlgTextItem` as its label.

Buttons are `StdDlgButton` (`text`), and they belong directly inside `StdDlgButtonArea` —
nowhere else. The side card never takes key focus, so nothing interactive belongs in it.

## A confirmation dialog

```tsx rsg-skill=complete
import {
    StandardDialog,
    StdDlgButton,
    StdDlgButtonArea,
    StdDlgContentArea,
    StdDlgTextItem,
    StdDlgTitleArea
} from "@roku-sdk/components";

interface ConfirmDeleteProps {
    onChoice: (index: number) => void;
    onClosed: () => void;
}

export function ConfirmDelete(props: ConfirmDeleteProps) {
    return (
        <StandardDialog
            initialFocusId="confirm-cancel"
            onButtonSelected={index => props.onChoice(index)}
            onWasClosed={() => props.onClosed()}
        >
            <stdDlgTitleArea primaryTitle="Delete recording?" />
            <stdDlgContentArea>
                <stdDlgTextItem text="This removes it from every device on your account." />
            </stdDlgContentArea>
            <stdDlgButtonArea>
                <stdDlgButton id="confirm-cancel" text="Cancel" />
                <stdDlgButton text="Delete" />
            </stdDlgButtonArea>
        </StandardDialog>
    );
}
```

`onButtonSelected` reports the index of the button in the order they are declared, so the
handler switches on 0 and 1 rather than on a label.

This reference stops at the dialog itself. Who decides it should be up, what the caller learns
when it goes down, and how one dialog leads to the next are app state — the
`dialogs-and-modals` skill owns that. `StandardDialog` normalizes native close notifications
to at most one `onWasClosed` per presented lifetime while mounted; button/action completion
remains app state. Unmount releases ownership and retires callbacks, so do not wait for a
close notification from a component you have already disposed.

## Preparing before presentation

The lifecycle props in this section require SDK 2.17.0 (not available in 2.16.0).

Use `ready={false}` to prepare the dialog without presenting its content. An optional
`fallback` is a **raw native dialog element**, not a nested `StandardProgressDialog`
component (which would create a second modal owner):

```tsx rsg-skill=complete
import { StandardDialog } from "@roku-sdk/components";

const DeferredDialog = (props: { open: boolean; ready: boolean; onClose: () => void }) => (
    <StandardDialog
        open={props.open}
        ready={props.ready}
        replaceExisting={false}
        fallback={
            <standardDialog optionsDialog>
                <stdDlgContentArea><stdDlgProgressItem text="Loading" /></stdDlgContentArea>
            </standardDialog>
        }
        onWasClosed={props.onClose}
        onBlocked={props.onClose}
        title="Preferences"
        optionsDialog
    >
        {/* StdDlg areas and items */}
    </StandardDialog>
);
```

`open` defaults to true. Setting it false requests native closure; `onWasClosed` follows
the native event. Unmount requests closure of only the owned modal and retires its observers.
Native dismissal does not reopen on a late readiness update; toggle `open` after native
closure to start another lifetime. `replaceExisting` defaults to true for existing consumers;
false reports `onBlocked` rather than replacing an unrelated native dialog. The fallback
and ready content share that ownership, so their handoff does not report a terminal close.
`onOpened` confirms the main dialog's native attachment and initial focus, not bitmap
readiness or drawn pixels. `title` and `optionsDialog` are native dialog properties.

`close` also stays on the native dialog, without a Modal proxy. Native `close` is
always-notify: an actual field assignment closes regardless of the Boolean value.
Solid does not rewrite an unchanged prop. Clearing `scene.dialog` is not the native
close operation. Non-preemption is opt-in with `replaceExisting={false}`.

## Focus is not yours to wire

`StandardDialog` renders a native SceneGraph modal, so SceneGraph moves focus into it when it
appears and back out when it closes. Point `initialFocusId` at the button that should be
focused first and stop there. An enclosing `FocusBoundary` goes inactive on its own while the
dialog is up; setting `focusActive` by hand fights the platform.

`ModalBoundary` and `useModal` are the other path, not an addition to this one. They exist for
an overlay you draw yourself out of ordinary nodes, which has no native modal to hand focus
to. Choose one: a `StandardDialog`, or a hand-drawn overlay inside a `ModalBoundary`. The
`focus-management` skill owns the second.

## Ready-made variants

When the composition above is more than the job needs, four dialogs arrive pre-assembled and
take the same props as `StandardDialog`: `StandardMessageDialog` for a message and buttons,
`StandardKeyboardDialog` for text entry, `StandardPinPadDialog` for a PIN, and
`StandardProgressDialog` for a wait. They exist as separate modules so an app that uses one
does not pay for the XML of the others.

`Dialog` is the pre-OS-10 node. It is still exported and still works — note its required
`close` prop, which dismisses the dialog whenever it is *set*, whatever the value, so it is
normally passed as `close={false}` — but new work should use `StandardDialog`.
