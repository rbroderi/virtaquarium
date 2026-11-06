// Copyright (c) 2026 Roku, Inc.
// SPDX-License-Identifier: MIT
//
// The aquarium screensaver scene. The simulation (src/aquarium/sim.ts) runs on a 30 Hz timer and
// hands back a Frame; every poster reads its fields from that one signal. Draw order, back to front:
// water-blue fill, backdrop tiles, back water loop, bubbles, fish behind the reef, foreground tiles,
// front water loop, fish in front of the reef.

import type { AnchorNodeDescriptor, AnchorNodeImplementation } from "@roku-sdk/rsg-ts";
import { defineAnchorNode } from "@roku-sdk/rsg-ts";
import { batch, createSignal, For, onCleanup, onMount } from "@roku-sdk/solid";

import { ASSET_ROOT, manifest } from "../aquarium/manifest.generated";
import type { BubbleView, FishView, Frame, WaterView } from "../aquarium/sim";
import { createSim, FPS } from "../aquarium/sim";

const AquariumSceneDescriptor: AnchorNodeDescriptor = {
    componentName: "AquariumScene",
    extends: "Group" as const,
    inputFields: {},
    outputFields: {}
};

const ZERO: [number, number] = [0, 0];

// One fish: up to two angle pages crossfaded, each a clipping group around its sprite-sheet poster.
const FishSlot = (props: { view: () => FishView | null }) => {
    const v = () => props.view();
    return (
        <group
            visible={v() !== null}
            translation={v() ? [v()!.x, v()!.y] : ZERO}
            scale={v() ? [v()!.sx, v()!.sy] : [1, 1]}
            rotation={v()?.rotation ?? 0}
        >
            {[0, 1].map(i => {
                const c = () => v()?.cells[i];
                return (
                    <group
                        visible={!!c()}
                        opacity={c()?.opacity ?? 0}
                        translation={c() ? [c()!.x, c()!.y] : ZERO}
                        clippingRect={c() ? [0, 0, c()!.w, c()!.h] : [0, 0, 0, 0]}
                    >
                        <poster uri={c()?.uri ?? ""} translation={c() ? [c()!.px, c()!.py] : ZERO} />
                    </group>
                );
            })}
        </group>
    );
};

// A water loop layer: frame k, and its step overlay at the fraction towards frame k + 1.
const WaterLayer = (props: { view: () => WaterView | null }) => {
    const v = () => props.view();
    return (
        <group visible={v() !== null} translation={v() ? [v()!.x, v()!.y] : ZERO}>
            <poster uri={v()?.uri ?? ""} width={v()?.w ?? 0} height={v()?.h ?? 0} />
            <poster uri={v()?.stepUri ?? ""} width={v()?.w ?? 0} height={v()?.h ?? 0} opacity={v()?.stepOpacity ?? 0} />
        </group>
    );
};

const Bubble = (props: { view: () => BubbleView | undefined; uri: () => string; cell: number }) => {
    const v = () => props.view();
    return (
        <group
            visible={!!v()}
            translation={v() ? [v()!.x, v()!.y] : ZERO}
            scale={v() ? [v()!.size / props.cell, v()!.size / props.cell] : [1, 1]}
            clippingRect={[0, 0, props.cell, props.cell]}
        >
            <poster uri={v() ? props.uri() : ""} translation={v() ? [v()!.px, 0] : ZERO} />
        </group>
    );
};

const AquariumScene: AnchorNodeImplementation<typeof AquariumSceneDescriptor> = () => {
    const sim = createSim(manifest, ASSET_ROOT);
    const [frame, setFrame] = createSignal<Frame | null>(null, { equals: false });
    // The bitmaps the texture budget holds; one hidden loader poster each keeps it resident.
    const [held, setHeld] = createSignal<string[]>([]);

    const slots = Array.from({ length: sim.fishCount }, (_, i) => i);
    const bubbleSlots = Array.from({ length: sim.bubbleCount }, (_, i) => i);
    const f = () => frame();

    let timer: number | undefined;
    let last = Date.now(), ticks = 0, statsT = last, worst = 0;
    const tick = () => {
        const now = Date.now(), dt = Math.min((now - last) / 1000, 0.1);
        worst = Math.max(worst, now - last);
        last = now;
        const { frame: next, texturesChanged } = sim.tick(dt);
        batch(() => {
            if (texturesChanged) setHeld([...sim.tex.map.keys()]);
            setFrame(next);
        });
        ticks++;
        if (now - statsT >= 5000) {
            const t = sim.tex, mb = (b: number) => (b / 1e6).toFixed(1);
            console.log(`aquarium: ${(ticks * 1000 / (now - statsT)).toFixed(1)}/${FPS} ticks/s, worst gap ${worst} ms, ` +
                `textures ${mb(t.used)} MB (peak ${mb(t.peak)}, needed ${mb(t.need)}), ${t.map.size} bitmaps, ` +
                `${t.loads} loads, ${t.misses} misses`);
            ticks = 0; worst = 0; statsT = now;
        }
        // Schedule from the tick's start so the rate holds at 30 Hz when the tick itself takes time.
        timer = setTimeout(tick, Math.max(1, 1000 / FPS - (Date.now() - now))) as unknown as number;
    };
    onMount(() => { tick(); });
    onCleanup(() => { if (timer !== undefined) clearTimeout(timer); });

    const tileUri = (list: () => string[] | undefined, i: number) => list()?.[i] ?? "";

    return (
        <group>
            <rectangle width={1920} height={1080} color="0x0B3A55FF" />
            <group translation={[-(f()?.panX ?? 0), 0]}>
                {sim.backdropTiles.map((t, i) => (
                    <poster translation={[t.rect[0], t.rect[1]]} uri={tileUri(() => f()?.backdrop, i)} />
                ))}
                <WaterLayer view={() => f()?.water[0] ?? null} />
                {bubbleSlots.map(i => (
                    <Bubble view={() => f()?.bubbles?.[i]} uri={() => f()?.bubbleUri ?? ""} cell={sim.bubbleCell} />
                ))}
                {slots.map(i => <FishSlot view={() => f()?.back[i] ?? null} />)}
                {sim.foregroundTiles.map((t, i) => (
                    <poster translation={[t.rect[0], t.rect[1]]} uri={tileUri(() => f()?.foreground, i)} />
                ))}
                <WaterLayer view={() => f()?.water[1] ?? null} />
                {slots.map(i => <FishSlot view={() => f()?.front[i] ?? null} />)}
            </group>
            <group visible={false}>
                <For each={held()}>
                    {url => (
                        <poster
                            onLoadStatus={status => {
                                if (status === "ready") sim.tex.markReady(url);
                                else if (status === "failed") console.log(`aquarium: failed to load ${url}`);
                            }}
                            uri={sim.root + url}
                        />
                    )}
                </For>
            </group>
        </group>
    );
};

export default defineAnchorNode(AquariumSceneDescriptor, AquariumScene);
