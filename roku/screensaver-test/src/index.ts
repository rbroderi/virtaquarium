// Copyright (c) 2026 Roku, Inc.
// SPDX-License-Identifier: MIT

import "./compiled-components/BaseAppScene.xml";

import { enableExceptionTagging, main, registerAnchorNode } from "@roku-sdk/rsg-ts";

import AquariumScene from "./components/aquarium-scene";

main(() => {
    enableExceptionTagging();
    console.log("Registering AquariumScene");
    registerAnchorNode(AquariumScene);
});
