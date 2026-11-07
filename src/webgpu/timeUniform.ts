// One shared TSL uniform node for waterUniforms.uTime. The tank loop advances
// waterUniforms.uTime.value; every WebGPU material that needs the water clock reads this node, so it
// must be bridged exactly once (two bridges would each defineProperty over the other and leave one
// node stale). The WebGL path never installs the bridge.
import { waterUniforms } from '../water.js';
import { tsl } from './tsl.js';
import type { ShaderNodeObject, UniformNode } from 'three/webgpu';

let node: ShaderNodeObject<UniformNode<number>> | null = null;

/** The shared uTime uniform node (created on first use, which is always on the WebGPU path). */
export function waterTimeNode(): ShaderNodeObject<UniformNode<number>> {
  if (node) return node;
  const t = tsl();
  const n = t.uniform(waterUniforms.uTime.value);
  Object.defineProperty(waterUniforms.uTime, 'value', {
    get: (): number => n.value,
    set: (v: number): void => { n.value = v; },
    configurable: true,
    enumerable: true,
  });
  node = n;
  return node;
}
