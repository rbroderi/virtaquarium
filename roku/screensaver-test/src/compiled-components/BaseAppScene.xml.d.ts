// Auto-generated TypeScript declarations for XML component import.
// DO NOT EDIT — this file is regenerated during build.
//
// Source component: BaseAppScene
// Extends: Scene

import type { ISceneProps } from "@roku-sdk/components";
import type { TypedXmlComponent } from "@roku-sdk/interfaces";

export interface IBaseAppSceneProps extends ISceneProps {}

declare const _default: TypedXmlComponent<"BaseAppScene", Record<string, never>>;
export default _default;

declare module "@roku-sdk/solid" {
    namespace JSX {
        interface IntrinsicElements {
            baseAppScene: IBaseAppSceneProps;
        }
    }
}

declare module "@roku-sdk/solid/jsx-runtime" {
    namespace JSX {
        interface IntrinsicElements {
            baseAppScene: IBaseAppSceneProps;
        }
    }
}

declare module "solid-js" {
    namespace JSX {
        interface IntrinsicElements {
            baseAppScene: IBaseAppSceneProps;
        }
    }
}
