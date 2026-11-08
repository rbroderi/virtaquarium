// The crystal's transmission background: a small sub-frustum render of the reef behind the sign,
// sampled by the crystal's shader instead of three's full-screen transmission pass (which re-draws the
// whole 9.5M-triangle scene every frame). Only the wedge of the reef the crystal looks through is
// drawn, so the extra cost stays a couple of milliseconds.
import * as THREE from 'three';

/** Target size (px, square is fine: the wedge is small and the shader maps it with a projection). */
const BG_SIZE = 256;
/** Margin around the crystal's bounding box, as a fraction of its radius. */
const MARGIN = 0.55;

export const crystalBgUniforms = {
  uCrystalBg: { value: null as THREE.Texture | null },
  uCrystalBgSize: { value: new THREE.Vector2(BG_SIZE, BG_SIZE) },
  uCrystalBgProj: { value: new THREE.Matrix4() },
};

let target: THREE.WebGLRenderTarget | THREE.RenderTarget | null = null;
const sub = new THREE.PerspectiveCamera(40, 1, 0.1, 120);
const tmp = { up: new THREE.Vector3(), right: new THREE.Vector3(), forward: new THREE.Vector3(), d: new THREE.Vector3(), c: new THREE.Vector3() };

/** Frames the box in a camera at `from`, and returns its projection * inverse-view. */
function frameBox(from: THREE.Vector3, box: THREE.Box3): THREE.Matrix4 {
  const centre = box.getCenter(tmp.c);
  const dist = from.distanceTo(centre);
  tmp.forward.copy(centre).sub(from).normalize();
  tmp.right.crossVectors(tmp.forward, new THREE.Vector3(0, 1, 0)).normalize();
  tmp.up.crossVectors(tmp.right, tmp.forward).normalize();
  let halfW = 0, halfH = 0;
  for (let i = 0; i < 8; i++) {
    tmp.d.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(from);
    halfW = Math.max(halfW, Math.abs(tmp.d.dot(tmp.right)));
    halfH = Math.max(halfH, Math.abs(tmp.d.dot(tmp.up)));
  }
  const fov = (2 * Math.atan2(halfH * (1 + MARGIN), dist) * 180) / Math.PI;
  sub.fov = fov;
  sub.aspect = Math.max(0.1, halfW / Math.max(1e-6, halfH));
  // Clip the foreground (anything nearer than the crystal's own box) so grass and front rubble in
  // front of the sign don't appear "behind" it in the transmitted view.
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const toCentre = from.distanceTo(sphere.center);
  sub.near = Math.max(0.05, toCentre - sphere.radius * (1 + MARGIN));
  sub.far = toCentre + sphere.radius * (1 + MARGIN) + 20;
  sub.position.copy(from);
  sub.up.set(0, 1, 0);
  sub.lookAt(centre);
  sub.updateMatrixWorld(true);
  sub.updateProjectionMatrix();
  return new THREE.Matrix4().multiplyMatrices(sub.projectionMatrix, sub.matrixWorldInverse);
}

/** Either renderer: the crystal background is a plain setRenderTarget + render on both backends. */
export type CrystalBgRenderer = THREE.WebGLRenderer & { isWebGPURenderer?: boolean };

/** Renders the crystal's background for the crystal(s) in this scene (found by the builder's name). */
export function renderCrystalBgScene(renderer: CrystalBgRenderer, scene: THREE.Scene, camera: THREE.Camera, hide: readonly THREE.Object3D[]): void {
  const crystal = scene.getObjectByName('crystal');
  renderCrystalBg(renderer, scene, camera, hide, crystal ? [crystal] : []);
}

/** Renders the crystal's background and refreshes the shader uniforms; a no-op when no crystal. */
export function renderCrystalBg(renderer: CrystalBgRenderer, scene: THREE.Scene, camera: THREE.Camera, hide: readonly THREE.Object3D[], pieces: readonly THREE.Object3D[]): void {
  if (!pieces.length) return;
  if (!target) {
    // The WebGPU path uses a plain RenderTarget; the WebGL path its WebGLRenderTarget.
    target = renderer.isWebGPURenderer === true
      ? new THREE.RenderTarget(BG_SIZE, BG_SIZE, { type: THREE.HalfFloatType, depthBuffer: true })
      : new THREE.WebGLRenderTarget(BG_SIZE, BG_SIZE, { type: THREE.HalfFloatType, depthBuffer: true });
  }
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const p of pieces) box.expandByObject(p);
  if (box.isEmpty()) return;
  crystalBgUniforms.uCrystalBgProj.value.copy(frameBox(camera.position, box));

  const saved: [THREE.Object3D, boolean][] = [];
  for (const o of [...pieces, ...hide]) { saved.push([o, o.visible]); o.visible = false; }
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target as THREE.WebGLRenderTarget);
  renderer.render(scene, sub);
  renderer.setRenderTarget(prev);
  for (const [o, v] of saved) o.visible = v;
  crystalBgUniforms.uCrystalBg.value = target.texture;
  crystalBgUniforms.uCrystalBgSize.value.set(target.width, target.height);
}
