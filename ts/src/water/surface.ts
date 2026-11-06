// The underside of the water surface, seen through the water. Exact Fresnel at the water-air
// boundary: beyond the 48.6 degree critical angle it is a perfect mirror of the tank (total internal
// reflection); inside Snell's window it shows the bright fixture above. At the shallow angles a
// viewer looks up through the front glass, the waves' slopes open the window only in flickers,
// which is the silvery, glinting ceiling of a real aquarium. Same waves as the caustics.
import * as THREE from 'three';
import { GLASS_Z, INSCATTER_DAY, SURFACE_Y, UW_GLSL } from './medium.js';
import { WAVE_GLSL, waveUniforms } from './waves.js';

const WIDTH_MARGIN = 1.8;          // the plane is this many tank widths across
const DEPTH_BEHIND_GLASS = 10;     // how far the plane reaches back from the glass (units)

export interface SurfaceUniforms {
  uLight: THREE.IUniform<number>;
  uBase: THREE.IUniform<THREE.Color>;
  uSky: THREE.IUniform<THREE.Color>;
  uFloor: THREE.IUniform<THREE.Color>;
}

export type WaterSurface = THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> & { readonly surfaceUniforms: SurfaceUniforms };

/** Its typed uniforms are on `surfaceUniforms` (the same objects as material.uniforms). */
export function makeSurface(width: number): WaterSurface {
  const uniforms: SurfaceUniforms = {
    uLight: { value: 1 }, uBase: { value: INSCATTER_DAY.clone() },
    uSky: { value: new THREE.Color(2.4, 2.5, 2.6) }, uFloor: { value: new THREE.Color(0.30, 0.27, 0.21) },
  };
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, fog: false,
    uniforms: { ...waveUniforms, ...uniforms },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: UW_GLSL + WAVE_GLSL + /* glsl */`
      uniform float uLight; uniform vec3 uBase; uniform vec3 uSky; uniform vec3 uFloor; varying vec3 vW;
      void main(){
        vec2 g = waveGrad(vW.xz);
        vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
        vec3 v = normalize(vW - cameraPosition);
        float ci = max(dot(v, n), 1e-3), eta = 1.34, st2 = eta * eta * (1.0 - ci * ci);
        float R = 1.0;
        if (st2 < 1.0) {
          float ct = sqrt(1.0 - st2);
          float rs = (eta * ci - ct) / (eta * ci + ct), rp = (eta * ct - ci) / (eta * ct + ci);
          R = 0.5 * (rs * rs + rp * rp);
        }
        vec3 refl = reflect(v, n);
        // Mirror image of the tank: water radiance, plus the sunlit floor when reflected steeply down.
        vec3 below = uwInscatter(uBase, refl, UW_SURFACE)
          + uFloor * uLight * exp(-UW_KD * (UW_SURFACE - 1.0)) * smoothstep(-0.25, -0.9, refl.y) * 0.5;
        vec3 col = mix(uSky * uLight, below, R);
        vec3 T = exp(-UW_C * uwPath(vW, cameraPosition));
        gl_FragColor = vec4((col * T + uwInscatter(uBase, v, UW_SURFACE) * (1.0 - T)) * UW_WB, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const depth = GLASS_Z + DEPTH_BEHIND_GLASS;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width * WIDTH_MARGIN, depth), mat);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(0, SURFACE_Y, GLASS_Z - depth / 2);
  return Object.assign(mesh, { surfaceUniforms: uniforms });
}
