// Copyright (c) 2026 Roku, Inc.
// SPDX-License-Identifier: MIT

import { getBuildType, RokuConfig } from "@roku-sdk/rsg-ts/roku-config";

const buildType = getBuildType();

const configuration: RokuConfig = {
    app: {
        entryPoint: "src/index.ts",
        images: {
            convertToWebp: true,
            generateHd: true
        },
        logger: {
            baseLogLevel: "INFO",
            currentLogLevel: "ERROR"
        },
        manifestEntries: {
            title: buildType === "production" ? "Virtual Aquarium Test" : `Virtual Aquarium Test (${buildType})`,
            major_version: 1,
            minor_version: 0,
            build_version: 0,
            ui_resolutions: "fhd",
            uri_resolution_autosub: "*,sd,hd,fhd",
            mm_icon_focus_hd: "pkg:/images/app-icon-hd.png",
            mm_icon_focus_fhd: "pkg:/images/app-icon-fhd.png",
            splash_screen_hd: "pkg:/images/splash_hd.jpg",
            splash_color: "0x000000FF",
            splash_min_time: 1,
            // Declare RSG 2.0. Firmware defaults to 1.2 when this key is absent.
            // Until the Channel Store static-analysis change lands (CHAN-111466),
            // publishing with 2.0 raises a P2 cert warning — a warning, not a
            // rejection, since static analysis still expects the older 1.3.
            rsg_version: "2.0"
        }
    }
};

export default configuration;
