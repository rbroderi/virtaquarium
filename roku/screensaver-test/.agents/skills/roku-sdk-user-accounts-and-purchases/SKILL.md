---
name: roku-sdk-user-accounts-and-purchases
description: "Use when an RSG SDK TypeScript app has to sign a viewer in, remember them across devices, or sell them something through ChannelStore — setting a data field, registering the result handler and only then setting command, reading the viewer's Roku account details, storing and retrieving channel credentials so a second device signs in without typing, fetching the product catalog, placing an order, listing what the viewer already owns, and requesting a device attestation token. Not signing a build, publishing it, or the beta channel, which is app-packaging; not SDK package installation, which is sdk-installation; and not a Roku's developer password, which is device-management."
# @roku-sdk/ai managed v=1 hash=2b3a4c9bd2ed7a59e9a781e6546ea0bac16b7efafe675974ee4d80c8ebf46113 skills=1 do-not-edit
---

# Viewer accounts and in-channel purchases

## Overview

`ChannelStore` from `@roku-sdk/components` is the one component that reaches Roku's account
and commerce services. It covers three jobs: reading who the viewer is, remembering them
across their devices, and selling them something.

It is **not called like a function**. You render one, put the input on a data prop, register
the handler the answer will arrive on, and then set `command`. The result comes back
asynchronously on that handler, never as a return value. Everything below follows from that.

## When to Use

| If the request is | Then |
|---|---|
| Reading the viewer's Roku account details to pre-fill a form | Here |
| Remembering a signed-in viewer so their next device does not ask again | Here |
| Proving to your own backend that a request came from a real Roku | Here |
| Listing, selling or confirming something inside the channel | Here |
| An auth gate in front of content, driven by whether a stored credential came back | Here |

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Signing a build, uploading a version, or the beta channel | The `app-packaging` skill | Those are about shipping the app. This is about the viewer using it. The word "channel" appears on both sides and means different things |
| Installing SDK packages with `pnpm` | The `sdk-installation` skill | That brings dependencies into the app; it does not authenticate a viewer |
| A Roku's developer password, or which box a command reaches | The `device-management` skill | Also a developer credential. Nothing here reads or writes it |
| Calling your own partner API over the network | The `fetch-and-data-loading` skill | Use that for your backend, and this only for what Roku itself holds. The attestation token below is the bridge between them |
| How to spell the component, or why it keeps its backing asset | The `sdk-components` skill | That skill owns the spelling table and the tree-shaking rule |

**Viewer credentials and developer credentials are different things** and three skills own the
second kind. Nothing in this skill touches a signing password, a registry token or a box's
developer password.

## Quick Reference

Eleven commands, plus `"none"`. Each result arrives on its own handler prop.

| Job | Command | Result arrives on |
|---|---|---|
| Who is this viewer | `getUserData` | `onUserDataObject` |
| Where are they | `getUserRegionData` | `onUserRegionDataObject` |
| Remember them | `storeChannelCredData` | `onStoreChannelCredDataStatusObject` |
| Are they already known | `getChannelCred` | `onChannelCredObject` |
| What can I sell | `getCatalog` | `onCatalogObject` |
| Sell it | `doOrder` | `onOrderStatusObject` |
| What do they own | `getPurchases` / `getAllPurchases` | `onPurchasesObject` — **and the status separately on `onPurchasesStatusObject`** |
| Partner-billed order | `requestPartnerOrder` / `confirmPartnerOrder` | `onRequestPartnerOrderStatusObject` / `onConfirmPartnerOrderStatusObject` |
| Prove the box is genuine | `getDeviceAttestationToken` | `onDeviceAttestationTokenObject` |
| Idle | `"none"` | — |

Input props that pair with them: `requestedUserData` (`"all"`, or a comma-separated list such
as `"email,firstname,lastname"`), `channelCredData`, `orderObject`, `deltaOrder`,
`requestPartnerOrderObject`, `confirmPartnerOrderObject`.

## Instructions

1. **Render one `ChannelStore` and drive `command` from a signal.** Start it at `"none"`. One
   instance serves every command; there is no need for one per operation.

2. **Set the data prop before you set the command.** The component reads its inputs when the
   command changes, so a command set in the same breath as its data may act on the previous
   value. Set the data signal, then the command signal.

3. **Return `command` to `"none"` once a result has arrived.** It is the idle value, and it is
   how the next request of the same kind is distinguishable from the last one. Left on the
   previous command, a re-request can look like nothing happened.

4. **Read the answer only on the matching handler.** Every result is
   `(event: T) => void` — a plain callback, not a promise — so the code that reacts to a
   command lives beside the render rather than after the call.

5. **Ask for the narrowest `requestedUserData` you need.** `"all"` returns the whole profile.
   A comma-separated list returns only those fields, which is both less to handle and less
   to justify.

6. **Adjust a basket with `deltaOrder`, not by rebuilding `orderObject`.** It applies one
   change on its own, and a **negative quantity removes** rather than adding a negative line.

7. **Read the result's `status`, and expect the credential as a string.** Every result
   carries `status`, where **0 means success** — an arrived handler is not the same as a
   successful command. Purchases are the one command that splits the two apart: the data
   arrives on `onPurchasesObject` and the status on `onPurchasesStatusObject`, so a failed
   request shows up as a status rather than as an empty list. And `getChannelCred` returns the credential as a **JSON string** in
   `json`, not as structured fields, so it has to be parsed.

8. **Treat `getChannelCred` as the auth gate.** On launch, ask; if a credential comes back,
   the viewer is known and no sign-in screen is needed. If nothing does, show one, and store
   the result with `storeChannelCredData` so the next device skips it.

9. **Send the attestation token to your backend, not to your own logic.** It is a signed JWT
   whose point is that a server can verify it. Checking it inside the app proves nothing,
   because anything that can fake the request can fake the check.

## Example

The auth gate: ask on launch, and store what a sign-in produced.

```tsx rsg-skill=complete
import { ChannelStore, ChannelStoreCommand, IChannelCred, IStoreChannelCredDataStatus } from "@roku-sdk/components";
import { Component, createSignal, onMount } from "@roku-sdk/solid";

export const AuthGate: Component = () => {
    const [command, setCommand] = createSignal<ChannelStoreCommand>("none");
    const [credData, setCredData] = createSignal("");
    const [known, setKnown] = createSignal<boolean | undefined>(undefined);

    onMount(() => setCommand("getChannelCred"));

    const onCred = (event: IChannelCred) => {
        // `status` 0 is success. The credential itself is a JSON *string* in `json`.
        setKnown(event.status === 0);
        setCommand("none");
    };

    const onStored = (event: IStoreChannelCredDataStatus) => {
        setKnown(event.status === 0);
        setCommand("none");
    };

    return (
        <group>
            <ChannelStore
                command={command()}
                channelCredData={credData()}
                onChannelCredObject={onCred}
                onStoreChannelCredDataStatusObject={onStored}
            />
            <label
                text={known() === undefined ? "checking" : known() ? "welcome back" : "please sign in"}
                translation={[96, 96]}
            />
            <label text={credData() === "" ? "" : "credential pending"} translation={[96, 160]} />
        </group>
    );
};

/** Wire this to whatever your sign-in screen produces. */
export function rememberViewer(setCredData: (v: string) => void, setCommand: (c: ChannelStoreCommand) => void) {
    return (token: string) => {
        setCredData(token); // data first
        setCommand("storeChannelCredData"); // then the command
    };
}
```

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| A command acts on the previous value | Data and command were set together, and the component read its inputs on the change | Set the data prop first, then the command |
| Re-issuing the same command appears to do nothing | `command` never returned to `"none"`, so there was no change to react to | Reset it to `"none"` in the handler |
| The handler never fires | The result was expected as a return value, or the wrong handler prop was wired | Each command has exactly one handler prop — match them from the table above |
| A basket ends up with a negative line | A removal was expressed by adding a negative entry to `orderObject` | A negative quantity on `deltaOrder` is the removal |
| The whole profile arrives when two fields were wanted | `requestedUserData` was left at `"all"` | Pass the comma-separated list instead |
| An attestation check passes for a forged request | The token was verified inside the app | Verify it on a server. In-app verification is not a check |
| A viewer is asked to sign in on every device | The credential was kept in app state rather than stored | `storeChannelCredData` puts it where the viewer's other boxes can read it |

`ChannelStore` is backed by a BrightScript XML extension rather than a native SceneGraph node,
which is why it behaves like a service rather than a view — it draws nothing. Every prop and
result type is documented with TSDoc in `@roku-sdk/components`; read a field's exact shape
there rather than inferring it from here.
