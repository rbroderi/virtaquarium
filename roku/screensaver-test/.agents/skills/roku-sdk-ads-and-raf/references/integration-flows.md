<!-- @roku-sdk/ai managed v=1 hash=2ab13834a98d65e89a0d71a02fb85f5c3fc6758b16c6fa02e76eb10cdd7afa4f skills=1 do-not-edit -->

# Ads integration flows: CSAI, SSAI and CSAS

One complete wired module per mode. All three obey the same protocol — wait for `"ready"`, set the
data fields then `command`, read the matching callback — and differ only in which commands they
issue and which nodes they need.

## What differs between the three

| | CSAI | SSAI | CSAS |
|---|---|---|---|
| Command sequence | `getAds` → `showAds`, per break | `getAds` → `stitchedAdsInit` | `getAds` → `constructStitchedStream` → `renderStitchedStream` |
| `adView` | required | not used | required |
| `contentView` | required | required | not used |
| `contentMetadata` | not used | not used | required |
| Who owns the `Video` | the app | the app | RAF — the app renders no `Video` at all |
| Result callbacks | `onGetAdsResult`, `onShowAdsResult` | `onGetAdsResult`, `onStitchedAdResult` | `onGetAdsResult`, `onConstructStitchedStreamResult`, `onRenderStitchedStreamResult` |

The `Video`-ownership row is the one that surprises people. CSAS hands RAF a single stream that
already has the ads spliced in, and RAF plays it; there is no content `Video` in the tree and no
`contentView` to give, so nothing in a CSAS module reacts to playback position.

## CSAI: pause the content, play the break, resume

The break's resume point has to be captured **before** the content is stopped, because stopping it
is what discards the position. `position` is milliseconds and `ContentNode`'s `playStart` is
seconds. `-1` is the "not started" sentinel: 0 ms is a real cue point, so 0 cannot be it.

Mid-roll arrives as another `onGetAdsResult`, from a `getAds` the task fired itself. That is why
the same handler serves pre-roll and every mid-roll, and why the empty-pods branch is guarded on
`position() === -1` — an empty mid-roll result means "no fill for this break", and restarting
content on it would fight the playback already running.

```tsx rsg-skill=complete
import type { AdsCommand, AdsState, EventHandler, EventHandlerAdPods, ShowAdsResult } from "@roku-sdk/ads";
import { Ads } from "@roku-sdk/ads";
import { Component, ContentNode, Group, MediaControl, Rectangle, Video } from "@roku-sdk/components";
import { DomNode } from "@roku-sdk/interfaces";
import { createSignal } from "@roku-sdk/solid";

const AD_TAG = "https://example.com/tag.vmap";
const CONTENT_URL = "https://example.com/content.m3u8";

export const CsaiPlayer: Component = () => {
    const [command, setCommand] = createSignal<AdsCommand>("none");
    const [adUrl, setAdUrl] = createSignal("");
    const [adView, setAdView] = createSignal<DomNode | undefined>();
    const [contentView, setContentView] = createSignal<DomNode | undefined>();
    const [control, setControl] = createSignal<MediaControl>("none");
    const [position, setPosition] = createSignal(-1);
    const [playStart, setPlayStart] = createSignal(0);

    const handleAdsState = (state: AdsState) => {
        if (state !== "ready") return;
        setAdUrl(AD_TAG);
        setCommand("getAds");
    };

    const handleGetAdsResult: EventHandlerAdPods = pods => {
        if (pods.length > 0) {
            setPlayStart(position() === -1 ? 0 : position() / 1000);
            setControl("stop");
            setCommand("showAds");
        } else if (position() === -1) {
            setControl("play");
        }
    };

    const handleShowAdsResult: EventHandler<ShowAdsResult> = result => {
        if (result === "none") return;
        if (result === "completed") {
            setControl("play");
            setCommand("none");
        } else {
            setControl("stop");
            setCommand("stop");
        }
    };

    return (
        <group>
            <Video
                width={1920}
                height={1080}
                content={<contentNode url={CONTENT_URL} playStart={playStart()} />}
                control={control()}
                notificationInterval={1.0}
                onPosition={value => setPosition(value)}
                ref={element => setContentView(element)}
                gainFocus={control() === "play"}
            />
            <rectangle
                width={1920}
                height={1080}
                color="0x000000FF"
                visible={control() !== "play"}
                ref={element => setAdView(element)}
            />
            <Ads
                adUrl={adUrl()}
                adView={adView()}
                contentView={contentView()}
                command={command()}
                onAdsState={handleAdsState}
                onGetAdsResult={handleGetAdsResult}
                onShowAdsResult={handleShowAdsResult}
            />
        </group>
    );
};
```

`gainFocus={control() === "play"}` is doing more than it looks. An ad break takes focus and does
not give it back, so without a re-assertion on resume the app plays content that answers no remote
keys. Tying it to the resume condition is the cheapest correct place for it.

## SSAI: the stream already contains the ads

The app plays one stream and asks RAF what is on screen. `getAds` here exists only to give
`stitchedAdsInit` its pods — nothing is rendered from the result.

There is a **race worth respecting**: `stitchedAdsInit` has to reach the task before position
events start arriving, because the task is still in CSAI mode until it lands, and a position event
that arrives first is treated as a CSAI cue point. Start playback from
`onStitchedAdsInitResult` rather than from `onGetAdsResult`, and the race is answered by the
protocol instead of by a timing margin. Only `"completed"` may start playback: an `"error"` means
the mode never changed, so playing anyway puts position events back on the CSAI cue-point path
against a stream that was never initialised.

`onStitchedAdResult` receives RAF's own associative array, so its keys are lowercase:
`evthandled`, not `evtHandled`. That is the general rule for anything RAF returns.

The module below needs **2.15.0 or newer**: that is the release `onStitchedAdsInitResult` and its
`StitchedAdsInitResult` type arrived in. The `stitchedAdsInit` command itself is older, but nothing
acknowledged it before then, so on 2.14.0 the only place to start playback from is
`onGetAdsResult` — which is the race above, answerable there by a timing margin and nothing better.

```tsx rsg-skill=complete
import type {
    AdsCommand,
    AdsState,
    EventHandler,
    EventHandlerAdPods,
    StitchedAdsInitResult
} from "@roku-sdk/ads";
import { Ads } from "@roku-sdk/ads";
import { Component, ContentNode, Group, MediaControl, Video } from "@roku-sdk/components";
import { DomNode } from "@roku-sdk/interfaces";
import { createSignal } from "@roku-sdk/solid";

const AD_TAG = "https://example.com/tag.vmap";
const STITCHED_URL = "https://example.com/stitched.m3u8";

export const SsaiPlayer: Component = () => {
    const [command, setCommand] = createSignal<AdsCommand>("none");
    const [adUrl, setAdUrl] = createSignal("");
    const [contentView, setContentView] = createSignal<DomNode | undefined>();
    const [control, setControl] = createSignal<MediaControl>("none");
    const [adPlaying, setAdPlaying] = createSignal(false);

    const handleAdsState = (state: AdsState) => {
        if (state !== "ready") return;
        setAdUrl(AD_TAG);
        setCommand("getAds");
    };

    const handleGetAdsResult: EventHandlerAdPods = pods => {
        if (pods.length === 0) {
            setControl("play");
            return;
        }
        setCommand("stitchedAdsInit");
    };

    // Playback starts here, once the task confirms it is in SSAI mode.
    const handleStitchedAdsInitResult: EventHandler<StitchedAdsInitResult> = result => {
        if (result === "none") return;
        if (result === "error") {
            // Still in CSAI: position events would drive mid-roll against a stream never
            // set up for it, so this is terminal rather than a warning to play past.
            setCommand("stop");
            return;
        }
        setControl("play");
    };

    const handleStitchedAdResult: EventHandler<Record<string, unknown>> = result => {
        setAdPlaying(result?.evthandled === true);
    };

    return (
        <group>
            <Video
                width={1920}
                height={1080}
                content={<contentNode url={STITCHED_URL} />}
                control={control()}
                notificationInterval={1.0}
                ref={element => setContentView(element)}
                gainFocus={control() === "play" && !adPlaying()}
            />
            <Ads
                adUrl={adUrl()}
                contentView={contentView()}
                command={command()}
                onAdsState={handleAdsState}
                onGetAdsResult={handleGetAdsResult}
                onStitchedAdsInitResult={handleStitchedAdsInitResult}
                onStitchedAdResult={handleStitchedAdResult}
            />
        </group>
    );
};
```

`stitchedAdsInit` on empty pods changes no mode and answers `"error"`. The `pods.length === 0`
branch above is what keeps that case from arising at all; the result is the backstop, and reading
it as anything other than terminal leaves the app playing a stitched stream through a task still
in CSAI.

## CSAS: build one stream, then render it

Two commands in sequence, each gated on the previous one's result. `contentMetadata` describes the
content to be stitched: a `ContentNode` prop bag, so `url` and `length` in seconds.

The task writes `"none"` to both result fields before it writes the real value, so guard on it
before branching. The shape to avoid is `if (result === "completed") { … } else { fail }`: it puts
the sentinel down the failure path, which here means abandoning the session before RAF has
answered.

A failed `constructStitchedStream` puts the task back in CSAI mode. Its `"error"` result is the
only notice of that, so treat it as terminal for the session rather than retrying
`renderStitchedStream`.

```tsx rsg-skill=complete
import type {
    AdsCommand,
    AdsState,
    ConstructStitchedStreamResult,
    EventHandler,
    EventHandlerAdPods,
    RenderStitchedStreamResult
} from "@roku-sdk/ads";
import { Ads } from "@roku-sdk/ads";
import { Component, Group, IContentNodeProps, Rectangle } from "@roku-sdk/components";
import { DomNode } from "@roku-sdk/interfaces";
import { createSignal } from "@roku-sdk/solid";

const AD_TAG = "https://example.com/tag.vmap";

export const CsasPlayer: Component<{ onFinished: () => void }> = props => {
    const [command, setCommand] = createSignal<AdsCommand>("none");
    const [adUrl, setAdUrl] = createSignal("");
    const [adView, setAdView] = createSignal<DomNode | undefined>();
    const [contentMetadata, setContentMetadata] = createSignal<IContentNodeProps>();
    const [playing, setPlaying] = createSignal(false);

    const handleAdsState = (state: AdsState) => {
        if (state !== "ready") return;
        setContentMetadata({ url: "https://example.com/content.m3u8", length: 600 });
        // Measurement fields must be in place before the pods are fetched.
        setAdUrl(AD_TAG);
        setPlaying(true);
        setCommand("getAds");
    };

    const handleGetAdsResult: EventHandlerAdPods = () => {
        setCommand("constructStitchedStream");
    };

    const handleConstructResult: EventHandler<ConstructStitchedStreamResult> = result => {
        if (result === "none") return;
        if (result === "completed") {
            setCommand("renderStitchedStream");
        } else {
            setPlaying(false);
            props.onFinished();
        }
    };

    const handleRenderResult: EventHandler<RenderStitchedStreamResult> = result => {
        if (result === "none") return;
        // "user_exited" is a viewer back-out, not a failure.
        setPlaying(false);
        setCommand("none");
        props.onFinished();
    };

    return (
        <group>
            <rectangle
                width={1920}
                height={1080}
                color="0x000000FF"
                visible={playing()}
                gainFocus={playing()}
                ref={element => setAdView(element)}
            />
            <Ads
                adUrl={adUrl()}
                adView={adView()}
                contentMetadata={contentMetadata()}
                command={command()}
                enableAdMeasurements={true}
                contentGenre="Entertainment"
                contentId="csas-sample"
                onAdsState={handleAdsState}
                onGetAdsResult={handleGetAdsResult}
                onConstructStitchedStreamResult={handleConstructResult}
                onRenderStitchedStreamResult={handleRenderResult}
            />
        </group>
    );
};
```

`onGetAdsResult` ignores its pods here on purpose: `constructStitchedStream` reads the ads the task
already holds, so there is nothing for the app to pass along and no reason to inspect them.

## Debug output

`debugOutput={true}` turns on RAF's own logging, which is the only view into what the library did
with a tag it rejected. It is verbose and belongs in development only — set it from the same
`"ready"` branch that sets `adUrl`, and leave it off in anything you ship.

## Stopping

`command = "stop"` ends the task's loop and reports `"stopped"` on `onAdsState`. Issue it while the
component is still mounted — from a Back key handler, or wherever the app decides to leave the
player. Doing it from `onCleanup` alone is best-effort: SolidJS may already have disposed the
effect that writes the field, and `onAdsState` is gone either way, so nothing confirms it. The task
does self-terminate when SceneGraph destroys the node, so the cleanup is a reasonable belt-and-
braces addition — just not the primary path.
