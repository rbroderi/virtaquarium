// Builds a 3D fish from a species description:
//  - body: lofted elliptical cross-sections following the species' side profile
//  - skin: pattern painted in (u, v) body space onto a canvas texture
//  - fins: one transparent "fin sheet" through the midline (dorsal, anal, caudal) + pectorals
//  - swimming: vertex shader bends everything in a travelling wave (tail beats harder than head)
//
// This file is the public face of the fishModel/ modules:
//   profile.ts       side profile and landmarks (gill, nostrils, mouth)
//   skin.ts          the body skin painter and its scale / normal / sheen maps
//   fins.ts          fin outlines and the painted fin sheet
//   pectoral.ts      pectoral fins (painted, tubes, cupped surface)
//   eye.ts           eyes;  detail.ts  tiling skin detail
//   section.ts       the body's cross-section;  meshes.ts  fin membranes and tubes
//   bodyGeometry.ts  the body mesh (jaw, gill margin, relief)
//   swimShader.ts    the swim / tissue shader composed into three.js materials
//   skinCache.ts     saved skin maps;  customModels.ts  GLB models;  assets.ts  per-species assets
//   builder.ts       buildFishModel: the assembled FishModel
export { makeProfile, gillU, gillOf, naresOf, mouthOf, type Profile, type Gill, type Naris, type P2, type P3 } from './fishModel/profile.js';
export { spineLayout, finOutline, caudalOutline, pelvicOutline, type FinSheet, type TubeSpec, type Rays } from './fishModel/fins.js';
export { pectoralOutline } from './fishModel/pectoral.js';
export { makeSwimMaterial, swimUniforms, IN_WATER_IOR, type SwimUniforms, type Tissue } from './fishModel/swimShader.js';
export { loadSkinCache } from './fishModel/skinCache.js';
export { loadCustomModels, loadFishModel, parseModelConfig, type ModelConfig, type NormalisedModel } from './fishModel/customModels.js';
export { buildFishModel, posePectoral, setPectLag, fishRender, speciesCanvases, type BuildFishOptions } from './fishModel/builder.js';
export { FishModel, PectoralPivot } from './fishModel/model.js';
export type { SpeciesCanvases } from './fishModel/assets.js';
