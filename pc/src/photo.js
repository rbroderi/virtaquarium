// Camera model for ?photo=1: what an aquarium photo adds on top of the scene, all derived from a lens
// and sensor rather than tuned by eye. Runs in linear light on the HDR frame, then tone-maps.
//   depth of field   thin lens: circle of confusion c = (f / N) * |d - s| / d * f / (s - f), for focal
//                    length f (from the field of view on a 36 mm full-frame sensor), f-number N and
//                    focus distance s; gathered over a 24-tap disc, each tap counted only where its
//                    own blur circle reaches the pixel. Fins write depth in this mode (see
//                    fishRender.finDepth) so they focus with the body.
//   lateral CA       red and blue magnified slightly differently, growing with r^2 from the centre.
//   vignetting       natural cos^4 falloff of the angle off-axis.
//   grain            photon shot noise: std dev proportional to sqrt(signal), plus a little read noise.
import * as THREE from 'three';
import { METRES_PER_UNIT } from './water.js';

const TAPS = 24;
const DISC = Array.from({ length: TAPS }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / TAPS), a = i * 2.39996323;   // golden-angle spiral, uniform over the disc
  return new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
});

export class PhotoCamera {
  // depth: give the target its own depth texture (for scenes drawn straight into begin(), as in the lab).
  constructor(renderer, { fNumber = 2.8, sensorMM = 36, ca = 0.0012, iso = 1, depth = false } = {}) {
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: depth ? 4 : 0 });
    if (depth) this.target.depthTexture = new THREE.DepthTexture(1, 1);
    this.fNumber = fNumber; this.sensorMM = sensorMM;
    this.focus = 10;   // focus distance, world units
    this.uniforms = {
      tColor: { value: this.target.texture }, tDepth: { value: null },
      uNear: { value: 0.1 }, uFar: { value: 100 },
      uCocK: { value: 0 }, uFocus: { value: 10 }, uRes: { value: new THREE.Vector2(1, 1) },
      uTanHalf: { value: new THREE.Vector2(1, 1) }, uCA: { value: ca }, uIso: { value: iso }, uSeed: { value: 0 },
      uDisc: { value: DISC },
    };
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: this.uniforms, depthTest: false, depthWrite: false,
      defines: { TAPS },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: PHOTO_FRAG,
    }));
    quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(quad);
    this.camera = new THREE.Camera();
    this._size = new THREE.Vector2();
  }

  // Where the scene should be drawn before finish() (HDR, linear).
  begin() {
    const r = this.renderer;
    r.getDrawingBufferSize(this._size);
    if (this.target.width !== this._size.x || this.target.height !== this._size.y) this.target.setSize(this._size.x, this._size.y);
    return this.target;
  }

  // depthTexture: the scene's depth (perspective), camera: the scene camera.
  finish(depthTexture, camera, t = 0) {
    const u = this.uniforms, cam = camera;
    // Focal length from the vertical field of view on a 3:2 sensor (24 mm tall for 36 mm wide).
    const fMM = (this.sensorMM / 1.5 / 2) / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const s = Math.max(this.focus, 0.05) * METRES_PER_UNIT * 1000;   // focus distance, mm
    // c(d) [mm on sensor] = (f^2 / (N (s - f))) * |1 - s / d|; in pixels: / sensor width * image width.
    u.uCocK.value = ((fMM * fMM) / (this.fNumber * Math.max(s - fMM, 1))) / this.sensorMM * this._size.x;
    u.uFocus.value = this.focus;
    u.tDepth.value = depthTexture;
    u.uNear.value = cam.near; u.uFar.value = cam.far;
    u.uRes.value.copy(this._size);
    const ty = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    u.uTanHalf.value.set(ty * cam.aspect, ty);
    u.uSeed.value = t % 100;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }
}

const PHOTO_FRAG = /* glsl */`
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform float uNear, uFar, uCocK, uFocus, uCA, uIso, uSeed;
uniform vec2 uRes, uTanHalf;
uniform vec2 uDisc[TAPS];
varying vec2 vUv;

float viewDist(vec2 uv) {
  float z = texture2D(tDepth, uv).x;
  return -perspectiveDepthToViewZ(z, uNear, uFar);
}
// Circle-of-confusion radius in pixels at view distance d (capped: the gather has 24 taps).
float coc(float d) { return min(0.5 * uCocK * abs(1.0 - uFocus / max(d, 1e-3)), 14.0); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed * 7.13) * 43758.5453); }

// Lateral chromatic aberration: the three channels are magnified slightly differently.
vec3 sampleCA(vec2 uv) {
  vec2 c = uv - 0.5;
  float k = uCA * dot(c, c) * 4.0;
  return vec3(texture2D(tColor, 0.5 + c * (1.0 + k)).r, texture2D(tColor, uv).g, texture2D(tColor, 0.5 + c * (1.0 - k)).b);
}

void main() {
  float d0 = viewDist(vUv), r0 = coc(d0);
  vec3 col = sampleCA(vUv);
  if (r0 > 0.5) {
    vec3 acc = col; float wsum = 1.0;
    for (int i = 0; i < TAPS; i++) {
      vec2 o = uDisc[i] * r0;
      vec2 uv = vUv + o / uRes;
      float di = viewDist(uv), ri = coc(di), dist = length(o);
      // Scatter as gather: a sample contributes only where its own blur circle reaches this pixel, so a
      // sharp fish does not haze the blurred water around it.
      float w = clamp(ri - dist + 1.0, 0.0, 1.0);
      acc += sampleCA(uv) * w; wsum += w;
    }
    col = acc / wsum;
  }
  // Natural vignetting: cos^4 of the angle off the optical axis.
  vec2 ndc = vUv * 2.0 - 1.0;
  float tan2 = dot(ndc * uTanHalf, ndc * uTanHalf);
  col *= 1.0 / ((1.0 + tan2) * (1.0 + tan2));
  // Sensor noise: shot noise ~ sqrt(signal) per channel plus read noise; Box-Muller from two hashes.
  vec2 px = floor(vUv * uRes);
  for (int c = 0; c < 3; c++) {
    float u1 = max(hash(px + float(c) * 17.0), 1e-4), u2 = hash(px + float(c) * 31.0 + 5.0);
    float n = sqrt(-2.0 * log(u1)) * cos(6.2831853 * u2);
    col[c] = max(col[c] + n * uIso * (0.012 * sqrt(max(col[c], 0.0)) + 0.002), 0.0);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
