---
name: roku-sdk-dialogs-and-modals
description: "Use when a dialog in an RSG SDK TypeScript app has to be opened, closed and sequenced rather than assembled — an app-level provider that owns which dialog is showing, carrying a close reason back so the caller can branch on how it was dismissed, chaining a multi-step flow such as terms then entry then confirmation, a loading dialog that has to come down when the request it covers resolves, and a determinate progress dialog driven from app state. Not which component draws it, or which StdDlg area and item types go inside one, which is the sdk-components skill; and not holding D-pad focus inside a self-drawn overlay or deciding which keys close it, which is focus-management."
# @roku-sdk/ai managed v=1 hash=0eb026705f65b5b955c94a1f0cf5382ff007db1d963a3e158f2414ff2784e237 skills=1 do-not-edit
---

# Dialog lifecycle and multi-step flows

## Overview

A `StandardDialog` knows how to draw itself and how to take focus. What it does not know is
*when* it should be up, what the caller learns when it goes down, or how one dialog leads to
the next. That is app state, it lives above the component, and it is what this skill covers.

The pattern is a provider at the app root that owns which dialog is showing, plus a registry
so the scene can render the current one without knowing any of them by name. It is an
**app-level pattern, not an SDK export** — there is no dialog provider to import. Copy it into
the app and own it.

## When to Use

| If the request is | Then |
|---|---|
| Deciding when a dialog opens and closes, from somewhere other than the dialog itself | Here |
| Telling apart "the viewer chose something" from "the viewer left" | Here — the close reason |
| A flow of two or more dialogs where backing out returns to the previous step | Here — child dialogs |
| A wait indicator that has to come down when the work it covers finishes | Here |
| Teardown that runs twice when a dialog closes | Keep action completion idempotent; StandardDialog normalizes native close notifications |

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Which component draws the dialog, which areas and item types go inside it, or which pre-assembled variant fits | The `sdk-components` skill, and the dialog reference it declares | That skill owns composition. This one never assembles a dialog; it decides when one is up |
| An overlay drawn out of ordinary nodes that has to hold the D-pad and dismiss on a key | The `focus-management` skill, and the focus-recipes reference it declares | `ModalBoundary` and `useModal` are the other path entirely. A hand-drawn overlay has no native modal to hand focus to, and that skill owns the wiring |
| Focus inside a dialog, or which key dismisses it | The `focus-management` skill | A `StandardDialog` renders a native modal, so focus enters and returns on its own. Nothing here changes that |
| A keyboard or PIN pad the viewer types into | The `sdk-components` skill for the component | Entry is its own subject. This skill only carries the flow the entry sits in |
| Moving between whole screens rather than showing something over one | The `screen-navigation` skill | A dialog leaves the screen underneath mounted and focused-inactive; a screen change does not |

## Quick Reference

The provider's surface. Names are the ones the showcase pattern uses — keep them, because
every dialog in the app reads them.

| Member | Does |
|---|---|
| `setDialog(id, onClose, data?)` | Opens a dialog by id, with the callback that receives its result |
| `closeDialog(params?)` | Closes the current one. Pops to the parent if there is one, otherwise calls `onClose` |
| `openChildDialog(childId, data, parentData)` | Pushes a step. `parentData` is what gets restored underneath |
| `getDialog()` | The current id, or `null` |
| `getDialogData<T>()` | The data the current dialog was opened with |
| `registerDialog(id, factory)` / `deregisterDialog(id)` | Registry, driven from `onMount` / `onCleanup` |
| `getDialogElement()` | The current dialog as an element, for the scene to render |

Two values come back through `closeDialog`:

| Close param | Means |
|---|---|
| `reason: DialogCloseReason.ButtonPressed` | The viewer chose an action. `buttonId` says which |
| `reason: DialogCloseReason.DialogCancelled` | The viewer left, or the dialog dismissed itself |

## Instructions

1. **Mount one provider at the app root** and have the scene render `getDialogElement()`.
   The scene stays ignorant of every individual dialog, so adding one is a registration
   rather than an edit to the scene.

2. **Register from `onMount`, deregister from `onCleanup`.** A factory left registered after
   its dialog is gone can still be built, which produces a dialog nothing owns.

3. **Open with `setDialog(id, onClose, data)`.** The caller's `onClose` is where the result
   lands, so the code that opened the dialog is the code that reacts to it — not the dialog.

4. **Every dialog reports its own close.** Wire the component's `onWasClosed` to
   `closeDialog(params)` and pass a reason. The component reports the native close event;
   the provider decides what that means.

5. **Keep action completion idempotent.** `StandardDialog` and its ready-made variants
   report `onWasClosed` once per presented lifetime. A button handler and the later close
   notification can still both reach app completion; guard that shared action path.
   Raw native nodes and the legacy `Dialog` may report duplicate native close events.

6. **Branch on the reason, not on the button index.** `ButtonPressed` with a `buttonId`
   is a choice; `DialogCancelled` is the viewer leaving. Treating "closed" as "confirmed"
   is how a flow commits something nobody agreed to.

7. **Chain steps with `openChildDialog`, and read the result from `_childCloseParams`.**
   When a child closes, the provider re-opens the parent with the child's close params merged
   into its data, so the parent resumes rather than restarts. `parentData` is how the fields
   the viewer already changed survive the round trip.

8. **Close a progress dialog from the signal that measures it, not from a timer.** An effect
   watching the value reacts the moment it lands, so what is displayed and what triggers the
   close cannot drift apart. A timer sized to "about how long it takes" will sometimes close
   at 95%.

9. **Clear intervals and timeouts in `onCleanup`.** A dialog can go away while its work is
   still running, and a timer that outlives it writes to signals nothing is reading.

## Example

A provider small enough to read, one dialog, and the close reason coming back to the caller.
`DialogProvider` and `useDialogs` here are app code — this is the shape to copy, not an
import to add.

```tsx rsg-skill=complete
import { StandardDialog, StdDlgButton, StdDlgButtonArea, StdDlgTextItem, StdDlgTitleArea } from "@roku-sdk/components";
import { Accessor, Component, createContext, createSignal, JSX, Show, useContext } from "@roku-sdk/solid";

export enum CloseReason {
    ButtonPressed = 0,
    DialogCancelled = 1
}

export interface CloseParams {
    reason: CloseReason;
    buttonId?: string;
}

interface FlowApi {
    current: Accessor<string | null>;
    open: (id: string, onClose: (params: CloseParams) => void) => void;
    close: (params: CloseParams) => void;
}

const FlowContext = createContext<FlowApi>();

export const DialogProvider: Component<{ children: JSX.Element }> = props => {
    const [current, setCurrent] = createSignal<string | null>(null);
    let onClose: ((params: CloseParams) => void) | undefined;

    const open = (id: string, handler: (params: CloseParams) => void) => {
        onClose = handler;
        setCurrent(id);
    };

    const close = (params: CloseParams) => {
        const handler = onClose;
        onClose = undefined;
        setCurrent(null);
        handler?.(params);
    };

    return <FlowContext.Provider value={{ current, open, close }}>{props.children}</FlowContext.Provider>;
};

export function useDialogs(): FlowApi {
    const api = useContext(FlowContext);
    if (!api) {
        throw new Error("useDialogs called outside DialogProvider");
    }
    return api;
}

export function ConfirmDelete() {
    const dialogs = useDialogs();

    // The button and the subsequent close can both complete this app action.
    let reported = false;
    const report = (params: CloseParams) => {
        if (reported) {
            return;
        }
        reported = true;
        dialogs.close(params);
    };

    return (
        <Show when={dialogs.current() === "confirm-delete"}>
            <StandardDialog
                initialFocusId="keep"
                onButtonSelected={index =>
                    report({ reason: CloseReason.ButtonPressed, buttonId: index === 0 ? "keep" : "delete" })
                }
                onWasClosed={() => report({ reason: CloseReason.DialogCancelled })}
            >
                <stdDlgTitleArea primaryTitle="Delete recording?" />
                <stdDlgButtonArea>
                    <stdDlgButton id="keep" text="Keep" />
                    <stdDlgButton text="Delete" />
                </stdDlgButtonArea>
            </StandardDialog>
        </Show>
    );
}
```

The caller decides what a close means:

```tsx
import { CloseReason, useDialogs } from "./dialog-flow";

const dialogs = useDialogs();

dialogs.open("confirm-delete", params => {
    if (params.reason === CloseReason.ButtonPressed && params.buttonId === "delete") {
        void removeRecording();
    }
    // DialogCancelled: the viewer left. Do nothing.
});
```

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| Teardown runs twice and the second run undoes something | Both a button handler and its subsequent close complete the app action | Guard shared completion with a flag, as in the example |
| A flow commits an action the viewer never chose | "The dialog closed" was read as "the viewer confirmed" | Branch on `DialogCloseReason` — only `ButtonPressed` is a choice |
| A child dialog closes and the parent comes back empty | The parent was re-opened without its previous data | Pass `parentData` to `openChildDialog`; read the child's result out of `_childCloseParams` |
| A wait indicator closes slightly before or after the work finishes | A timer was sized to the expected duration | Drive the close from the signal that measures progress |
| A dialog is gone but its timer still fires | The interval outlived the component | `clearInterval` / `clearTimeout` in `onCleanup` |
| The scene shows nothing though the provider says a dialog is current | The dialog's factory was never registered, or was deregistered early | Register in `onMount`, deregister in `onCleanup`, and render `getDialogElement()` |
| A second dialog replaces the first instead of stacking on it | `setDialog` was used where a step was meant | `openChildDialog` pushes; `setDialog` replaces |

Props for the components themselves are typed with TSDoc in `@roku-sdk/components`. Read a
prop there rather than guessing it from here.
