// Open water around the tank: the backdrop sphere and the image-based ambient light.
import * as THREE from 'three';
import { INSCATTER_DAY, UW_GLSL } from './medium.js';

const BACKDROP_RADIUS = 90;
const BACKDROP_SEGMENTS: readonly [number, number] = [48, 24];
const ENVIRONMENT_RADIUS = 10;
const ENVIRONMENT_SEGMENTS: readonly [number, number] = [64, 32];
const ENVIRONMENT_BLUR_SIGMA = 0.02;
const DRAW_FIRST = -1;

/** uFlat 1 drops the darker-below grade (the open reef: a fully fogged object is then the backdrop colour). */
export interface BackdropUniforms { uBase: THREE.IUniform<THREE.Color>; uFlat: THREE.IUniform<number> }
export type WaterBackdrop = THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> & { readonly backdropUniforms: BackdropUniforms };

/**
 * Background: the same inscatter function evaluated for an infinitely long path, so distant objects
 * fade seamlessly into the "open water" behind them. Its typed uniforms are on `backdropUniforms`
 * (the same objects as material.uniforms).
 */
export function makeWaterBackdrop(): WaterBackdrop {
  const uniforms: BackdropUniforms = { uBase: { value: INSCATTER_DAY.clone() }, uFlat: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { ...uniforms },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; gl_Position.z = gl_Position.w; }',
    fragmentShader: UW_GLSL + `
      uniform vec3 uBase; uniform float uFlat; varying vec3 vW;
      void main(){
        vec3 dir = normalize(vW - cameraPosition);
        // Start the infinite path at the glass, at the height the ray crosses it.
        float t = (UW_GLASS - cameraPosition.z) / min(-1e-3, dir.z);
        float y = cameraPosition.y + dir.y * max(t, 0.0);
        // Underwater radiance falls steeply away from the light: looking up towards the lamp is several
        // times brighter than looking level, and downward light is dimmer still (the radiance
        // distribution of the water column). Across the window this reads as open water fading darker
        // towards the bottom of the frame instead of a flat teal.
        float grade = mix(mix(0.55, 1.3, smoothstep(-0.3, 0.35, dir.y)), 1.0, uFlat);
        gl_FragColor = vec4(uwInscatter(uBase, dir, y) * UW_WB * grade, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(BACKDROP_RADIUS, ...BACKDROP_SEGMENTS), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = DRAW_FIRST;
  return Object.assign(mesh, { backdropUniforms: uniforms });
}

/**
 * Image-based ambient light for the underwater radiance field: Snell's window overhead (the whole
 * sky squeezed into a ~97 degree cone), blue-green inscatter around it, and dim sand-coloured
 * upwelling from below.
 */
export function makeEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(ENVIRONMENT_RADIUS, ...ENVIRONMENT_SEGMENTS);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uBase: { value: INSCATTER_DAY.clone() } },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: UW_GLSL + `uniform vec3 uBase; varying vec3 vP; void main(){
      vec3 dir = normalize(vP);
      vec3 water = uwInscatter(uBase, dir, 5.0);
      float win = smoothstep(cos(radians(50.0)), cos(radians(46.0)), dir.y);
      vec3 sky = vec3(0.95, 1.0, 1.05) * 2.2 * exp(-UW_KD * (UW_SURFACE - 5.0));
      vec3 sand = vec3(0.32, 0.29, 0.24) * 0.35;
      vec3 c = mix(water, sky, win);
      c = mix(c, sand, smoothstep(-0.1, -0.6, dir.y));
      gl_FragColor = vec4(c, 1.0);
    }`,
  });
  scene.add(new THREE.Mesh(geo, mat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, ENVIRONMENT_BLUR_SIGMA);
  pmrem.dispose();
  // Diagnostic hook for the look check's envtex probe (see lookCheck.ts).
  (target.texture as THREE.Texture & { __pmremTarget?: THREE.RenderTarget }).__pmremTarget = target;
  return target.texture;
}
