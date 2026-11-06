---
name: roku-sdk-ads-and-raf
description: "Use when an RSG SDK TypeScript app has to play ads through the Roku Advertising Framework with @roku-sdk/ads — waiting for the Ads task to report ready before issuing anything, setting the data fields first and command last, and reading each result off its own callback; choosing between CSAI, SSAI and CSAS and the command sequence each needs; the roku_ads_lib manifest entry without which RAF never initialises; a command re-issued with the same value writing nothing because the field never changed; a result handler firing with a none sentinel before the real value; why almost every ad-pod field is optional and lowercase; and the audience-measurement fields that must precede getAds. Not which node plays the content video or anything else on screen, which is sdk-components; not making the network request yourself, which is fetch-and-data-loading, since RAF fetches the ads; and not ChannelStore's set-data-then-set-command sequence for sign-in and purchases, which is user-accounts-and-purchases."
# @roku-sdk/ai managed v=1 hash=f576d4ee6386a98917f1406d666ed2f874667eedd48c27a08079c47c574a396b skills=1 do-not-edit
---

# Ads and the Roku Advertising Framework

## Overview

`@roku-sdk/ads` exports one component, `<Ads>`, a headless SceneGraph Task that wraps the Roku
Advertising Framework. You do not call RAF; you write fields on the task and read results off its
callbacks, in a fixed order. Every trap in the package comes from that being a protocol rather
than an API.

The package's interface may still change between releases: pin the version and re-read the types
after an upgrade.

## Read the reference first for these tasks

Wiring a CSAI, SSAI or CSAS module end to end: read
[`references/integration-flows.md`](references/integration-flows.md) first — it carries one
complete wired module per mode. The tables below name the commands and say what each mode needs,
but no row here is a complete answer to "how do I wire this mode".

## When to Use

- Playing ads at all through `@roku-sdk/ads`: pre-roll, mid-roll or post-roll.
- A command that appears to do nothing, or a result callback firing with an unexpected value.
- Choosing between CSAI, SSAI and CSAS, or finding a mode is not the one you asked for.
- RAF never reporting ready in a new app.
- Audience measurement fields required for certification.

### When not to use

| Situation | Use instead | Because |
|---|---|---|
| Which node plays the content video, or draws anything on screen | `sdk-components` | `<Ads>` renders nothing; it only needs refs to nodes something else drew |
| Loading your own catalog or metadata over the network | `fetch-and-data-loading` | RAF makes the ad request itself — the app never fetches the tag |
| `ChannelStore` sign-in or purchases | `user-accounts-and-purchases` | Same set-data-then-set-command shape, different subsystem and different fields |
| Where D-pad focus lives generally | `focus-management` | Only the focus an ad break takes is here |
| Calling RAF directly from BrightScript | — | This skill is the TypeScript wrapper; the task already owns the RAF calls |

## Quick Reference

### The protocol, in order

1. **Wait for `"ready"`.** `onAdsState` reports it once, before the task's command loop starts.
   A command written earlier is never seen — no error, no result.
2. **Set the data fields first, `command` last.** The task reacts to the `command` write and reads
   the other fields as they stand at that moment.
3. **Read the result off the matching callback**, not off the next thing that happens.

Two consequences are invisible in the types and are the most common cause of "it worked once":

- **A repeated `command` value writes nothing.** The field is signal-driven and compares by value,
  so setting `"showAds"` twice in a row is one command. Reset through `"none"` between two
  identical commands.
- **A string result field is cleared to `"none"` before the real value is written**, so
  `onShowAdsResult`, `onStitchedAdsInitResult`, `onConstructStitchedStreamResult` and
  `onRenderStitchedStreamResult` all fire with `"none"` before anything you can act on. Guard it
  and return. The catch is that the *first* command hides it — the field already holds `"none"`,
  so that write changes nothing and notifies nobody. An unguarded handler therefore works
  perfectly until the second command, which is where it starts treating the sentinel as a result.
  `onGetAdsResult` is the exception and needs no guard: it carries an array, and RAF returns a
  fresh one each call.

### Commands

| `command` | Needs | Reports on |
|---|---|---|
| `getAds` | `adUrl` | `onGetAdsResult` — always an array; an empty or unset `adUrl` yields `[]` without a network call |
| `showAds` | `adView` | `onShowAdsResult` — `"error"` immediately if `adView` is missing; a viewer leaving the break is `"user_exited"` (2.15.0 and newer), not a failure |
| `stitchedAdsInit` | non-empty pods | `onStitchedAdsInitResult` — `"error"` on empty pods, which is also the only case that leaves the mode alone |
| `constructStitchedStream` | `contentMetadata` | `onConstructStitchedStreamResult` |
| `renderStitchedStream` | a built stream and `adView` | `onRenderStitchedStreamResult` — a viewer back-out is `"user_exited"`, a distinct result from `"error"` |
| `stop` | — | `onAdsState` reports `"stopped"`; the task's loop exits |

### Choosing a mode

| Your situation | Mode | Needs |
|---|---|---|
| Pause the content, play ads over it, resume where you left off | CSAI | `adView` and `contentView` |
| The ads are stitched into the content stream server-side and you react to ad events as it plays | SSAI | `contentView` |
| Build one stitched stream up front and render it yourself | CSAS | `adView` and `contentMetadata` |

Command sequences, after `"ready"`: CSAI is `getAds` → `showAds`, repeated per break. SSAI is
`getAds` → `stitchedAdsInit`, then content playback drives the ad events. CSAS is
`getAds` → `constructStitchedStream` → `renderStitchedStream`.

## Instructions

1. **Add `bs_libs_required: "roku_ads_lib"`** to `manifestEntries` in `roku-config.ts`. Without it
   RAF is not linked, `onAdsState` never reports `"ready"`, and the failure names a library path
   rather than the manifest.
2. **Give `<Ads>` an `adView`** for any mode that renders ads — a ref to any renderable node whose
   lifetime covers the whole break. A full-screen `Rectangle` behind the ad is enough.
3. **Give it `contentView`** for CSAI and SSAI: a ref to the content `Video`. The task watches
   playback position on it, and that is what drives mid-roll — so set the `Video`'s
   `notificationInterval` fine enough that a cue point is reported.
4. **Set measurement before the first `getAds`.** `enableAdMeasurements`, `contentGenre` and
   `contentId` are applied as they change, and RAF needs them in place when the pods are fetched.
   Empty strings are skipped. RAF fires the beacons itself — do not intercept or suppress them.
5. **Do not write a cue-point loop.** The task calls RAF's `getAds` itself at each cue point it
   sees on `contentView` and hands back only the pods due now, so mid-roll arrives as another
   `onGetAdsResult`. There is nothing to schedule and no pod field to filter on.
6. **Re-assert focus when content resumes.** An ad break does not hand focus back; it is left on
   the screen root, and an app that does not take it returns to receiving no keys.
7. **Stop with `command = "stop"` while still mounted.** Doing it only from a cleanup is
   best-effort: the callback that would confirm it is torn down by the same unmount.

Two more facts a reader cannot derive from the surface. `contentView` binds **once** — the task
observes position on the first non-invalid value and then stops watching its own field, so
swapping the `Video` node means unmounting and remounting `<Ads>`. And mid-roll reuses the last
`adUrl`; there is no per-break tag.

### The mode transitions that do not happen

Both leave the task in CSAI while the app believes otherwise, so position events then offer
mid-roll pods for a stream that was never set up for them. Each reports, but only as an `"error"`
that is easy to log and walk past:

- `stitchedAdsInit` on empty pods changes no mode and reports `"error"`. Check `pods.length > 0`
  before issuing it rather than reacting afterwards.
- A failed `constructStitchedStream` reverts to CSAI, signalled only by its `"error"` result.

Treat either as "this is not the mode I asked for" and stop, rather than starting playback.

## Example

Minimal CSAI pre-roll. It demonstrates both consequences above: `onShowAdsResult` guards the
`"none"` sentinel, and it resets `command` to `"none"` so the next break's `showAds` is a change.

It resumes content on the two results that mean the break is over — `"completed"`, and `"error"`
for a break that never played — and stops on anything else, which is a viewer who walked out.
That way round on purpose: `"user_exited"` joined `ShowAdsResult` in 2.15.0, so comparing against
that literal does not compile on 2.14.0, while an allow-list of the results that permit resuming
reads the same on both and keeps its meaning as the union grows.

```tsx rsg-skill=complete
import type { AdsCommand, AdsState, EventHandler, EventHandlerAdPods, ShowAdsResult } from "@roku-sdk/ads";
import { Ads } from "@roku-sdk/ads";
import { Component, ContentNode, Group, MediaControl, Rectangle, Video } from "@roku-sdk/components";
import { DomNode } from "@roku-sdk/interfaces";
import { createSignal } from "@roku-sdk/solid";

export const PreRoll: Component = () => {
    const [command, setCommand] = createSignal<AdsCommand>("none");
    const [adUrl, setAdUrl] = createSignal("");
    const [adView, setAdView] = createSignal<DomNode | undefined>();
    const [contentView, setContentView] = createSignal<DomNode | undefined>();
    const [control, setControl] = createSignal<MediaControl>("none");

    const handleAdsState = (state: AdsState) => {
        if (state !== "ready") return;
        setAdUrl("https://example.com/tag.vmap");
        setCommand("getAds");
    };

    const handleGetAdsResult: EventHandlerAdPods = pods => {
        if (pods.length === 0) {
            setControl("play");
            return;
        }
        setControl("stop");
        setCommand("showAds");
    };

    const handleShowAdsResult: EventHandler<ShowAdsResult> = result => {
        if (result === "none") return;
        if (result === "completed" || result === "error") {
            // The break played out, or never played at all: resume content either way.
            setControl("play");
            setCommand("none");
            return;
        }
        // Anything else is the viewer leaving the break, so do not resume.
        setCommand("stop");
    };

    return (
        <group>
            <Video
                width={1920} height={1080} control={control()} notificationInterval={1.0}
                content={<contentNode url="https://example.com/content.m3u8" />}
                gainFocus={control() === "play"}
                ref={element => setContentView(element)}
            />
            <rectangle
                width={1920} height={1080} color="0x000000FF"
                visible={control() !== "play"}
                ref={element => setAdView(element)}
            />
            <Ads
                adUrl={adUrl()} adView={adView()} contentView={contentView()} command={command()}
                onAdsState={handleAdsState}
                onGetAdsResult={handleGetAdsResult}
                onShowAdsResult={handleShowAdsResult}
            />
        </group>
    );
};
```

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| `onAdsState` never reports `"ready"`; log shows a `roku_ads` library path | RAF was not linked into the app | `bs_libs_required: "roku_ads_lib"` in `manifestEntries` |
| First command does nothing, no error | It was written before `"ready"` | Issue the first command from `onAdsState` |
| Second ad break never plays; the first did | `command` was already that value, so nothing was written | Reset to `"none"` between two identical commands |
| A handler that worked in testing mishandles the *second* command | It received the `"none"` sentinel, which the first command hides because the field already held it | `if (result === "none") return;` in every string result handler |
| `showAds` reports `"error"` at once | No `adView` | Pass a ref to a renderable node that outlives the break |
| Content restarts when the viewer backs out of an ad | `"user_exited"` was handled as if it were `"completed"` | Resume only on the results that mean the break is over; leaving one early usually means leaving the content. `showAds` reports it from 2.15.0, `renderStitchedStream` from earlier |
| Mid-roll never fires | No `contentView`, so nothing watches playback position | Pass a ref to the content `Video` |
| The app stops responding to the remote after an ad | The break took focus and did not return it | Re-assert focus when content resumes |
| A pod field read fine in testing and is `undefined` in production | Pod fields are optional: which ones arrive depends on the VAST tag that answered | Treat pods as opaque; `pods.length > 0` is the whole decision |

### Ad pods carry ad-server data, so almost every field is optional

The names are RAF's own and lowercase — `rendersequence`, `mimetype`, `adtitle` — not camelCase.
Only `AdPod.ads` is required; everything else is optional, because RAF passes the ad server's
response through and a different tag carries different fields. There is no ad count — it is
`ads.length` — and the break is described by two fields rather than one: `rendersequence`, a string
(`"preroll"`), and `rendertime`, the offset in seconds RAF has already scheduled it at.
`tracking` is a flat array of event objects, not a record of URLs, so finding one means searching
on `event`.

None of which a correct integration needs: the task fetches cue-point pods itself, so check
`pods.length` and read nothing else.

## Source of truth

`@roku-sdk/ads` ships its `src/`, so the typed surface is in `node_modules/@roku-sdk/ads`: one
component and 16 types in `src/index.ts`, with TSDoc on every prop of `IAdsProps`. The command loop
those props drive is `src/xml-components/ads/ads.brs`, and where the two disagree the BrightScript
is what runs.
