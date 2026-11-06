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
//   front glass      the room reflected in the pane, twice: off its outer face (air/glass, Fresnel F0
//                    0.04) and, fainter, off its inner face (glass/water, F0 0.0044), shifted by the
//                    pane's thickness (2 t tan of the angle inside the glass), so a bright edge in the
//                    room shows a double contour. A dim room with one window; 12 mm glass, the room
//                    ~2.5 m behind the camera. glass: false turns it off (?glass=0).
import * as THREE from 'three';
import { METRES_PER_UNIT } from './water.js';

const TAPS = 24;
const DISC = Array.from({ length: TAPS }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / TAPS), a = i * 2.39996323;   // golden-angle spiral, uniform over the disc
  return new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
});

export class PhotoCamera {
  // depth: give the target its own depth texture (for scenes drawn straight into begin(), as in the lab).
  constructor(renderer, { fNumber = 2.8, sensorMM = 36, ca = 0.0012, iso = 1, depth = false, glass = true } = {}) {
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
      // x on, y pane thickness, z room distance (units); uCamRot: camera to world rotation
      uGlass: { value: new THREE.Vector3(glass ? 1 : 0, 0.012 / METRES_PER_UNIT, 2.5 / METRES_PER_UNIT) }, uCamRot: { value: new THREE.Matrix3() },
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
    u.uCamRot.value.setFromMatrix4(cam.matrixWorld);
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
uniform vec3 uGlass;
uniform mat3 uCamRot;
varying vec2 vUv;

// The room behind the camera, as radiance seen along world direction r (r.z > 0: away from the tank).
// Dim walls, a slightly lighter ceiling, and one window up to the left with a mullion across it.
vec3 roomAt(vec3 r) {
  vec3 L = vec3(0.025, 0.024, 0.022) * (1.0 + 0.6 * max(r.y, 0.0));
  vec2 w = vec2(r.x / max(r.z, 0.05) + 0.55, r.y / max(r.z, 0.05) - 0.3);   // on a plane in front of r
  vec2 e = smoothstep(vec2(0.33, 0.21), vec2(0.3, 0.18), abs(w));
  float mull = smoothstep(0.006, 0.012, abs(w.y));
  // (a dim, overcast window: a bright one read as a pasted rectangle over the open water)
  return L + vec3(0.9, 0.95, 1.0) * 0.22 * e.x * e.y * mull;
}
float schlick(float f0, float c) { return f0 + (1.0 - f0) * pow(1.0 - c, 5.0); }
vec3 glassReflection(vec2 ndc) {
  vec3 d = normalize(uCamRot * vec3(ndc * uTanHalf, -1.0));
  if (d.z >= -0.05) return vec3(0.0);
  vec3 r = vec3(d.x, d.y, -d.z);                          // mirrored by the pane (normal +z)
  float c = r.z, s = sqrt(max(0.0, 1.0 - c * c));
  float f1 = schlick(0.04, c), f2 = schlick(0.0044, sqrt(max(0.0, 1.0 - s * s / (1.52 * 1.52))));
  // The inner face's image: the ray crosses the pane twice, shifted sideways by 2 t tan(theta_glass),
  // seen from the room's distance as an angular offset along the plane of incidence.
  float tg = (s / 1.52) / sqrt(max(1e-4, 1.0 - s * s / (1.52 * 1.52)));
  vec2 side = length(r.xy) > 1e-4 ? normalize(r.xy) : vec2(0.0);
  vec3 r2 = normalize(vec3(r.xy + side * (2.0 * uGlass.y * tg * c / uGlass.z), r.z));
  return f1 * roomAt(r) + (1.0 - f1) * (1.0 - f1) * f2 * roomAt(r2);
}

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
  vec2 ndc = vUv * 2.0 - 1.0;
  // The room's reflection in the pane (the ~4.5% the two faces take from the tank's light is left to
  // the exposure, which was matched to the photos through glass).
  if (uGlass.x > 0.5) col += glassReflection(ndc);
  // Natural vignetting: cos^4 of the angle off the optical axis.
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
