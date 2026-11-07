// Fish build flags set once, before any fish model is built. Kept in their own module so both the
// procedural builder and the GLB-model path can read them without a circular import.
export const fishRender = {
  /** Fins write depth (photo camera focus); set before building fish. */
  finDepth: false,
  /** Build TSL node materials (swimNodes.ts) instead of the WebGL onBeforeCompile swim shader. */
  gpu: false,
};
