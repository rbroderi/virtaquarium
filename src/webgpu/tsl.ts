// Holds the lazily imported `three/tsl` and `three/webgpu` namespaces so the WebGL default path (and the
// Node test runner, where `self.GPUShaderStage` is undefined) never loads the WebGPU bundles. Only the
// renderer choice loads them (see app/stage.ts), and the TSL material factories read them back
// synchronously. three r187 split the language and node types into `three/tsl` while the renderer, node
// materials and light nodes stayed in `three/webgpu`; both builds share three's core module
// (`three.core.js`), so the scene graph's lights, materials and classes are the same objects either way.
export type Tsl = typeof import('three/tsl');
export type Webgpu = typeof import('three/webgpu');

// The node/material types. These live in three's WebGPU build (nodes/Nodes.js) in r187; three/tsl only
// re-exports the *functions* (its default class exports are not re-exported by the type definitions).
export type {
  Node, NodeBuilder, LightingModel, LightingModelDirectInput, LightingModelDirectRectAreaInput,
  LightingModelReflectedLight, WebGPURenderer, StackNode, TextureNode, UniformArrayNode, UniformNode, PassNode,
} from 'three/webgpu';
import type { UniformArrayNode, UniformNode } from 'three/webgpu';

/** r187 removed three r170's `ShaderNodeObject<T>` wrapper. The ported code tracks most nodes loosely
 *  (swizzles on any expression), so both of these collapse to `any` rather than the new `Node<T>` type,
 *  whose per-node-type discriminant rejects the loose cross-type arithmetic the shaders rely on. */
export type NodeObject = any;
/** A node plus free swizzle access, the r170 `ShaderNodeObject<T>` shape. */
export type ShaderNodeObject<T> = any;

export type FloatUniformNode = UniformNode<'float'>;
export type Vec2UniformNode = UniformNode<'vec2'>;
export type Vec3UniformNode = UniformNode<'vec3'>;
export type ColorUniformNode = UniformNode<'color'>;
export type Mat3UniformNode = UniformNode<'mat3'>;
export type Mat4UniformNode = UniformNode<'mat4'>;
/** A uniform array of vec3s (the fish path / fish-push arrays). */
export type PathArrayNode = UniformArrayNode<'vec3'>;
/** A texture node we re-sample at an explicit uv / layer (the `.uv()`/`.depth()` keep the link). */
export type TextureNodeObject = ShaderNodeObject<import('three/webgpu').TextureNode>;

/** The loaded TSL namespace, or null until loadTsl() has run on the WebGPU path. */
export const tslRef: { tsl: Tsl | null } = { tsl: null };
/** The loaded WebGPU namespace, or null until loadWebgpu() has run on the WebGPU path. */
export const wgRef: { wg: Webgpu | null } = { wg: null };

/** Dynamic import: pulls in three's TSL build exactly once. */
export async function loadTsl(): Promise<Tsl> {
  if (tslRef.tsl) return tslRef.tsl;
  tslRef.tsl = await import('three/tsl');
  return tslRef.tsl;
}

/** Dynamic import: pulls in three's WebGPU build (and the TSL build it depends on) exactly once. */
export async function loadWebgpu(): Promise<Webgpu> {
  if (wgRef.wg) return wgRef.wg;
  await loadTsl();
  wgRef.wg = await import('three/webgpu');
  return wgRef.wg;
}

/** The loaded TSL namespace (throws if the WebGPU bundle was never requested). */
export function tsl(): Tsl {
  if (!tslRef.tsl) throw new Error('three/tsl has not been loaded (WebGPU path not initialised)');
  return tslRef.tsl;
}

/** The loaded WebGPU namespace (throws if the WebGPU bundle was never requested). */
export function webgpu(): Webgpu {
  if (!wgRef.wg) throw new Error('three/webgpu has not been loaded (WebGPU path not initialised)');
  return wgRef.wg;
}

/** True once the WebGPU bundle has been loaded (the WebGPU renderer path is active). */
export function gpuActive(): boolean {
  return tslRef.tsl !== null;
}
