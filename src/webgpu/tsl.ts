// Holds the lazily imported `three/webgpu` namespace so the WebGL default path (and the Node test
// runner, where `self.GPUShaderStage` is undefined) never loads the WebGPU bundle. Only the renderer
// choice loads it (see app/stage.ts), and the TSL material factories read it back synchronously.
export type Tsl = typeof import('three/webgpu');

/** The loaded namespace, or null until loadTsl() has run on the WebGPU path. */
export const tslRef: { tsl: Tsl | null } = { tsl: null };

/** Dynamic import: pulls in three's WebGPU + TSL build exactly once. */
export async function loadTsl(): Promise<Tsl> {
  if (tslRef.tsl) return tslRef.tsl;
  tslRef.tsl = await import('three/webgpu');
  return tslRef.tsl;
}

/** The loaded TSL namespace (throws if the WebGPU bundle was never requested). */
export function tsl(): Tsl {
  if (!tslRef.tsl) throw new Error('three/webgpu has not been loaded (WebGPU path not initialised)');
  return tslRef.tsl;
}
