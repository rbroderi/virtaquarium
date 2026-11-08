// The underside of the water surface on the WebGPU path, in TSL (the WebGL path is src/water/surface.ts,
// a ShaderMaterial WebGPURenderer never runs). Exact Fresnel at the water-air boundary: total internal
// reflection beyond the critical angle, the bright fixture overhead inside Snell's window, and the
// same waves as the caustics. The renderer applies tone mapping and sRGB, so this outputs linear radiance.
import * as THREE from 'three';
import { tsl, webgpu, type NodeObject } from '../webgpu/tsl.js';
import { waveGradNode } from './webgpuCaustics.js';
import { GLASS_Z, INSCATTER_DAY, SURFACE_Y } from './medium.js';
import type { SurfaceUniforms } from './surface.js';

const WIDTH_MARGIN = 1.8;          // the plane is this many tank widths across
const DEPTH_BEHIND_GLASS = 10;     // how far the plane reaches back from the glass (units)
const WATER_IOR = 1.34;

/** Per-unit beam / downwelling attenuation (medium.ts, metres x METRES_PER_UNIT). */
const BEAM_PER_UNIT = [0.60 * 0.125, 0.17 * 0.125, 0.12 * 0.125] as const;
const KD_PER_UNIT = [0.45 * 0.125, 0.07 * 0.125, 0.05 * 0.125] as const;
/** Camera white balance, exp(UW_KD * 7), as in medium.ts. */
const WHITE_BALANCE = [Math.exp(KD_PER_UNIT[0] * 7), Math.exp(KD_PER_UNIT[1] * 7), Math.exp(KD_PER_UNIT[2] * 7)] as const;

export type GpuWaterSurface = THREE.Mesh<THREE.PlaneGeometry, import('three/webgpu').NodeMaterial> & { readonly surfaceUniforms: SurfaceUniforms };

/** Its typed uniforms are on `surfaceUniforms` (the same objects lighting.ts writes, as the WebGL path). */
export function makeGpuSurface(width: number): GpuWaterSurface {
  const t = tsl();
  const wg = webgpu();
  const uniforms: SurfaceUniforms = {
    uLight: { value: 1 }, uBase: { value: INSCATTER_DAY.clone() },
    uSky: { value: new THREE.Color(2.4, 2.5, 2.6) }, uFloor: { value: new THREE.Color(0.30, 0.27, 0.21) },
  };
  // uLight is replaced wholesale by lighting.ts, so bridge it to the uniform node; uBase is mutated in
  // place (copy) and read back by reference each frame.
  const uLight = t.uniform(uniforms.uLight.value);
  Object.defineProperty(uniforms.uLight, 'value', {
    get: (): number => uLight.value,
    set: (v: number): void => { uLight.value = v; },
    configurable: true, enumerable: true,
  });
  const uBase = t.uniform(uniforms.uBase.value);

  const C = t.vec3(BEAM_PER_UNIT[0], BEAM_PER_UNIT[1], BEAM_PER_UNIT[2]);
  const KD = t.vec3(KD_PER_UNIT[0], KD_PER_UNIT[1], KD_PER_UNIT[2]);
  const WB = t.vec3(WHITE_BALANCE[0], WHITE_BALANCE[1], WHITE_BALANCE[2]);
  const surfaceY = t.float(SURFACE_Y);
  const glassZ = t.float(GLASS_Z);
  const sky = t.vec3(2.4, 2.5, 2.6);
  const floorCol = t.vec3(0.30, 0.27, 0.21);
  const waveGrad = waveGradNode(t);

  // medium.ts uwInscatter: the radiance scattered towards the eye from an infinite water path.
  const uwInscatter = t.Fn(([base, dir, y]: [NodeObject, NodeObject, NodeObject]) => {
    const up = t.smoothstep(t.float(-0.7), t.float(0.95), dir.y);
    return base.mul(t.float(0.45).add(t.float(1.1).mul(up).mul(up)))
      .mul(t.exp(KD.mul(t.max(t.float(0), surfaceY.sub(y))).mul(t.float(1.5)).negate()));
  });
  // medium.ts uwPath: the length of the eye ray inside the water (camera is outside the glass).
  const uwPath = t.Fn(([p, cam]: [NodeObject, NodeObject]) => {
    const d = t.length(p.sub(cam));
    const outside = cam.z.greaterThan(glassZ);
    return t.select(outside,
      d.mul(t.clamp(glassZ.sub(p.z).div(t.max(t.float(1e-3), cam.z.sub(p.z))), t.float(0), t.float(1))),
      d);
  });

  const material = new wg.NodeMaterial();
  material.fragmentNode = t.Fn(() => {
    const vW = t.positionWorld as unknown as NodeObject;
    const cam = t.cameraPosition as unknown as NodeObject;
    const g = waveGrad(vW.xz) as unknown as NodeObject;
    const n = t.vec3(g.x.negate(), t.float(1), g.y.negate()).normalize() as unknown as NodeObject;
    const v = vW.sub(cam).normalize() as unknown as NodeObject;
    const ci = t.max(v.dot(n), t.float(1e-3));
    const eta = t.float(WATER_IOR);
    const st2 = eta.mul(eta).mul(t.float(1).sub(ci.mul(ci)));
    // Fresnel reflectance (water to air), 1 beyond the critical angle (total internal reflection).
    const ct = t.sqrt(t.float(1).sub(st2));
    const rs = eta.mul(ci).sub(ct).div(eta.mul(ci).add(ct));
    const rp = eta.mul(ct).sub(ci).div(eta.mul(ct).add(ci));
    const R = t.select(st2.lessThan(t.float(1)), t.float(0.5).mul(rs.mul(rs).add(rp.mul(rp))), t.float(1));
    const refl = t.reflect(v, n) as unknown as NodeObject;
    // Mirror image of the tank below the surface, plus the sunlit floor when reflected steeply down.
    const below = uwInscatter(uBase, refl, surfaceY)
      .add(floorCol.mul(uLight)
        .mul(t.exp(KD.mul(surfaceY.sub(t.float(1))).negate()))
        .mul(t.smoothstep(t.float(-0.25), t.float(-0.9), refl.y))
        .mul(t.float(0.5)));
    const col = t.mix(sky.mul(uLight), below, R);
    const transmittance = t.exp(C.mul(uwPath(vW, cam)).negate());
    return col.mul(transmittance)
      .add(uwInscatter(uBase, v, surfaceY).mul(t.vec3(1).sub(transmittance)))
      .mul(WB);
  })();
  material.fog = false;
  material.side = THREE.DoubleSide;

  const depth = GLASS_Z + DEPTH_BEHIND_GLASS;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width * WIDTH_MARGIN, depth), material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(0, SURFACE_Y, GLASS_Z - depth / 2);
  return Object.assign(mesh, { surfaceUniforms: uniforms });
}
