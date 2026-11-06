---
name: roku-sdk-data-entry-keyboards
description: "Use when a viewer has to type something into an RSG SDK TypeScript app — wiring CustomKeyboard, DynamicKeyboard, DynamicKeyGrid, DynamicMiniKeyboard or DynamicPinPad, reading what was entered as it changes, authoring a .keyboard.json definition with several modes for another language or a caps state, masking a PIN as it is typed, and a search field that filters while the viewer types. Not which pre-assembled dialog wraps one, or how a StandardDialog is composed from areas and items, which is sdk-components; and not remote key routing or where focus sits, which is focus-management."
# @roku-sdk/ai managed v=1 hash=77ae83db1dcc86edd4fc3bc7651be4afa1f12a7d474af48bb3ec27e793306bbb skills=1 do-not-edit
---

# On-screen keyboards and PIN entry

## Overview

Five components collect typing from a remote: `DynamicKeyboard` and `DynamicMiniKeyboard` for
prose, `DynamicPinPad` for a code, `CustomKeyboard` for an arrangement you define, and
`DynamicKeyGrid` when the keys are choices rather than characters.

Two things decide how one is wired. The `Dynamic*` family reports the **whole string so far**
through `onText`, so app state follows the field rather than accumulating keys. And a
`CustomKeyboard` reports **which key** was pressed, which is what makes shift and
language keys the app's job rather than the component's.

## When to Use

| If the request is | Then |
|---|---|
| Reading what a viewer has typed, as they type it | Here — `onText` |
| Hiding the characters of a code while still showing its length | Here — `secureMode` |
| An arrangement of keys the defaults do not cover | Here — a key definition file |
| Whether the SDK already ships the layout you were about to author | Here — the packaged KDFs |
| Shift or language keys that appear to do nothing | Here — the app drives the mode |
| Suiting the arrangement to an email address or a URL | Here — the domain |

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Which pre-assembled dialog wraps a field, or which item type goes in a composed one | The `sdk-components` skill, and the dialog reference it declares | That skill owns which component and how a dialog is composed. This one owns the entry itself, wherever it sits |
| Opening and closing the dialog the field sits in, or chaining a step after it | The `dialogs-and-modals` skill | Lifecycle is above the field. This skill has nothing to say about when the dialog is up |
| Moving focus between the keyboard and the rest of the screen | The `focus-management` skill | Handing focus between regions is its subject. A keyboard is just one region |
| How to spell these exports in JSX, or why they keep their backing asset | The `sdk-components` skill | It owns the spelling table and the tree-shaking rule for them |

## Quick Reference

| Component | Collects | Reports through |
|---|---|---|
| `DynamicKeyboard` | Prose, full-width | `onText` |
| `DynamicMiniKeyboard` | Prose, compact | `onText` |
| `DynamicPinPad` | Digits | `onText` |
| `CustomKeyboard` | Whatever the layout defines | `onKeySelectedValue` |
| `DynamicKeyGrid` | A choice among keys | `onKeySelected` |

Props worth knowing before reaching for the source:

| Prop | On | Does |
|---|---|---|
| `onText` | the `Dynamic*` family | The full string so far, on every change |
| `secureMode` | `DynamicKeyboard`, `DynamicPinPad` | Masks the characters; length stays visible |
| `hintText` | all | Guidance shown while the field is empty |
| `maxTextLength` | all | Caps the entry |
| `showUnderscores`, `centerUnderscores` | `DynamicPinPad` | How the unfilled positions are drawn |
| `domain` | `DynamicKeyboard`, `DynamicMiniKeyboard`, `CustomKeyboard` | Suits the arrangement to a kind of value; typed by `KeyboardDomain` |
| `keyDefinitionUri` | `CustomKeyboard`, `DynamicKeyGrid` | The layout to use |
| `mode` | `CustomKeyboard`, `DynamicKeyGrid` | Which arrangement inside that layout is showing |
| `jumpToKey` | `CustomKeyboard` | Moves the highlight to a key by position |
| `horizWrap`, `vertWrap` | `DynamicKeyGrid` | Whether movement wraps at an edge |

## Instructions

1. **Take the value from `onText`, not by accumulating presses.** It hands over the whole
   string each time it changes, so the signal behind the field is a mirror of the field rather
   than a log of keys. Appending on every call is how a field ends up with doubled characters.

2. **Mask with `secureMode`.** It hides the characters and leaves the length visible, which is
   what a viewer needs to see that a press registered. Do not build masking yourself by
   holding the real value beside a row of asterisks.

3. **Before authoring a layout, check whether one ships.** `@roku-sdk/components/kdfs` exports
   packaged key definitions — an address layout, a MOP PIN pad, a phone pad and a Wi-Fi
   layout — as URIs ready for `keyDefinitionUri`. **Import only the ones you use**: an unused
   export is what keeps the rest of the files out of the build.

4. **Author your own as a `.keyboard.json` and import it.** The build rewrites that import to
   the packaged URI, so what you pass to `keyDefinitionUri` is the imported value rather than a
   path you construct. Declaring several arrangements in one file is what makes shift and
   alphabet switching possible at all.

5. **Drive `mode` yourself in response to `onKeySelectedValue`.** This is the step that is
   easy to miss: a shift or language key is **suppressed by the component** so it is not typed
   into the field, and nothing switches the arrangement on your behalf. Watch for those keys in
   the handler and set the `mode` signal — the component renders whichever arrangement `mode`
   names.

6. **Set `domain` when the value has a shape.** It suits the arrangement to what is being
   collected rather than making the viewer hunt for `@` on a prose layout. The choices are
   typed by `KeyboardDomain`.

7. **Let `focus-management` put focus on the keyboard.** These components take key presses once
   focused; getting focus to them, and back out afterwards, is not their concern.

## Example

A PIN pad that masks its entry, and a custom keyboard whose shift key the app has to honour.

```tsx rsg-skill=complete
import { CustomKeyboard, DynamicPinPad, IKeyHandlerData } from "@roku-sdk/components";
import { Component, createSignal } from "@roku-sdk/solid";

export const ParentalCode: Component<{ onComplete: (code: string) => void }> = props => {
    const [code, setCode] = createSignal("");

    return (
        <DynamicPinPad
            secureMode
            maxTextLength={4}
            hintText="Enter your 4-digit code"
            text={code()}
            onText={value => {
                // The whole string so far — assign it, never append to it.
                setCode(value);
                if (value.length === 4) {
                    props.onComplete(value);
                }
            }}
        />
    );
};

const LOWER = "lower";
const UPPER = "upper";

export const NameField: Component<{ layoutUri: string }> = props => {
    const [mode, setMode] = createSignal(LOWER);
    const [text, setText] = createSignal("");

    return (
        <CustomKeyboard
            keyDefinitionUri={props.layoutUri}
            mode={mode()}
            text={text()}
            onText={value => {
                setText(value);
            }}
            // A shift key is suppressed rather than typed, so the arrangement
            // only changes if this handler changes it.
            onKeySelectedValue={(data: IKeyHandlerData) => {
                if (String(data.key).toLowerCase().startsWith("caps")) {
                    setMode(current => (current === LOWER ? UPPER : LOWER));
                }
            }}
        />
    );
};
```

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| Characters appear doubled or the field grows too fast | `onText` was treated as one key and appended to state | It is the whole string; assign it |
| A code is readable over the viewer's shoulder | Masking was not turned on | `secureMode` |
| A viewer cannot tell whether a press registered on a masked field | Masking hid the length too, because it was hand-built | `secureMode` keeps the length visible |
| A shift or language key does nothing, and is not typed either | The component suppresses it; nothing switched the arrangement | Watch for it in `onKeySelectedValue` and set `mode` |
| A hand-written layout URI does not resolve | A path was constructed rather than using the value the import produced | Import the `.keyboard.json` and pass what it yields |
| The build carries layouts the app never shows | Every packaged KDF was imported, or a barrel pulled them in | Import only the ones used from `@roku-sdk/components/kdfs` |
| An email field puts the viewer on a prose arrangement | `domain` was left unset | Set it from `KeyboardDomain` |

Props are documented with TSDoc in `@roku-sdk/components`; read a field's exact shape and the
full `KeyboardDomain` list there rather than inferring either from here.
