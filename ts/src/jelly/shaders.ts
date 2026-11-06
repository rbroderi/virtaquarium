// GLSL for the moon jellies: additive, translucent, dimmed and tinted by the water with distance.
import { METRES_PER_UNIT } from '../water.js';

/** Beam attenuation per metre, red/green/blue (as water.ts), for the water between jelly and eye. */
const WATER_C_PER_M = [0.6, 0.17, 0.12] as const;
/** The jelly fade uses a little more than the water's own path (bluer, as the exhibits look). */
const WATER_PATH_GAIN = 1.6;

// Water between the jelly and the eye: blue survives longest (per unit, as water.ts).
const WATER_C = `vec3(${WATER_C_PER_M.map((c) => (c * METRES_PER_UNIT * WATER_PATH_GAIN).toFixed(4)).join(', ')})`;

const COMMON = /* glsl */`
uniform float uPulse;     // 0 relaxed .. 1 fully contracted
uniform float uR;         // bell radius
uniform float uTime, uSeed, uLight;
uniform vec3 uTrail;     // bell-space sweep of the trailing parts: they drag behind the bell's motion and hang towards the world's down
varying vec3 vView;
varying float vDist;
// Bell margin under contraction: s = 0 at the apex .. 1 at the margin.
vec2 bellShape(float r, float y, float s) {
  float c = uPulse * s * s;
  return vec2(r * (1.0 - 0.22 * c), y + uR * (0.1 * c - 0.03 * uPulse));
}
// The margin (a = 0..1 round the bell): 8 notches, where the rhopalia (the balance and light organs)
// sit, and two scalloped lappets between each pair. Returns the radius factor; the notches also lift
// the rim a little (it tucks in there).
float marginCut(float a, float s) {
  float m = smoothstep(0.82, 1.0, s), q = fract(a * 8.0);
  float notch = exp(-pow((min(q, 1.0 - q)) / 0.035, 2.0));
  float lappet = abs(sin(q * 6.2831853));          // two lobes per eighth
  return 1.0 - m * (0.07 * notch - 0.018 * lappet + 0.012);
}
// Light through the jelly: the light panel is behind and above the tank, so a bell seen against it
// glows, the thick lens most (it scatters more on the way through).
const vec3 PANEL_DIR = vec3(0.0, 0.32, -0.95);
float throughLight(vec3 V) { return pow(clamp(dot(-V, normalize(PANEL_DIR)), 0.0, 1.0), 4.0); }
vec3 waterFade(vec3 col) { return col * exp(-${WATER_C} * vDist); }
`;

// The bell is drawn twice from one lathe: the outer (exumbrella) surface, and the inner
// (subumbrella) one offset inwards by the mesoglea's thickness, thick at the apex and thin at the
// margin, a lens; seen through, the two outlines double the rim the way a real bell's do.
export const BELL_VERT = COMMON + /* glsl */`
uniform float uInner;
varying vec2 vUv;
varying vec3 vN;
void main() {
  vUv = uv;
  float s = uv.y;   // lathe profile: 0 apex .. 1 margin
  float r = length(position.xz);
  vec2 rs = bellShape(r, position.y, s);
  vec2 dxz = r > 1e-5 ? position.xz / r : vec2(0.0);
  float a = uv.x * 6.2831853;
  rs.x *= marginCut(uv.x, s);
  rs.y += uR * 0.035 * smoothstep(0.85, 1.0, s) * (1.0 - marginCut(uv.x, s)) * 10.0;
  vec3 p = vec3(dxz.x * rs.x, rs.y, dxz.y * rs.x);
  // The lens: up to 0.2 bell radii thick at the apex, thinning to the margin (thinner as it contracts).
  float th = uR * 0.2 * pow(1.0 - s, 1.6) * (1.0 - 0.25 * uPulse);
  p -= normal * th * uInner;
  // A little irregularity so the bells aren't perfect domes.
  p.xz *= 1.0 + 0.025 * sin(a * 3.0 + uSeed) * s;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vView = cameraPosition - w.xyz;
  vDist = length(vView);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const BELL_FRAG = COMMON + /* glsl */`
uniform float uInner;
varying vec2 vUv;
varying vec3 vN;
uniform vec3 uTint, uGonad;
float line(float x, float w) { return 1.0 - smoothstep(0.0, w, abs(fract(x) - 0.5) * 2.0); }
void main() {
  vec3 V = normalize(vView), N = normalize(vN);
  float f = pow(1.0 - abs(dot(N, V)), 2.2);   // folds seen edge-on catch the most light
  float s = vUv.y, a = vUv.x;
  if (uInner > 0.5) {
    // The subumbrella: only its outline and the light through the lens (the canals and gonads are
    // drawn once, on the outer surface).
    gl_FragColor = vec4(waterFade(uTint * (0.35 * f + 0.12 * throughLight(V) * (1.0 - s))) * uLight, 1.0);
    return;
  }
  // Rhopalia: a bright point in each notch, just inside the margin.
  float qn = fract(a * 8.0), rho = exp(-pow(min(qn, 1.0 - qn) / 0.012, 2.0)) * exp(-pow((s - 0.965) / 0.012, 2.0));
  // Radial canals: 16 from the centre, branching towards the margin; the ring canal at the margin.
  float canal = line(a * 16.0, 0.06) * smoothstep(0.15, 0.3, s) + line(a * 32.0 + 0.5, 0.05) * smoothstep(0.55, 0.8, s) * 0.8;
  float ring = smoothstep(0.93, 0.985, s) * (1.0 - smoothstep(0.985, 1.0, s));
  // Four horseshoe gonads around the centre, open towards the margin.
  vec2 q = s * vec2(cos(a * 6.2831853), sin(a * 6.2831853));
  float g = 0.0;
  for (int k = 0; k < 4; k++) {
    float ang = (float(k) + 0.5) * 1.5707963 + 0.15 * sin(uSeed + float(k));
    vec2 dir = vec2(cos(ang), sin(ang)), c = dir * 0.27, d = q - c;
    float rr = length(d), open = dot(normalize(d + 1e-5), dir);
    // A thick, soft band (not a thin outline), fading towards its open ends.
    g += (1.0 - smoothstep(0.015, 0.06, abs(rr - 0.11))) * (1.0 - smoothstep(0.2, 0.8, open)) * 0.75;
  }
  // Light from above and behind: the top of the bell is a little brighter.
  float top = 0.75 + 0.25 * N.y;
  vec3 col = uTint * (0.1 + 0.8 * f + 0.14 * canal + 0.6 * ring + 0.9 * rho) * top + uGonad * g * (0.45 + 0.4 * f)
           + (uTint * 0.5 + uGonad * g * 0.6) * throughLight(V) * (0.15 + 0.35 * (1.0 - s));
  gl_FragColor = vec4(waterFade(col) * uLight, 1.0);
}`;

// Marginal tentacles: short fine threads from the margin, swept by the pulse.
export const TENT_VERT = COMMON + /* glsl */`
attribute float aAng, aS, aLen;
varying float vS;
void main() {
  vS = aS;
  vec2 rim = bellShape(uR * 1.0, -uR * 0.05, 1.0);
  float a = aAng * 6.2831853;
  vec3 dir = vec3(cos(a), 0.0, sin(a));
  float L = aLen * uR;
  // Hang down and a little outwards, flicked out by each contraction, swaying slowly.
  float sweep = 0.35 + 0.5 * uPulse;
  vec3 p = dir * rim.x + vec3(0.0, rim.y, 0.0)
         + (dir * sweep * aS - vec3(0.0, aS, 0.0)) * L
         + vec3(sin(uTime * 0.7 + a * 5.0 + uSeed), 0.0, cos(uTime * 0.6 + a * 4.0)) * 0.08 * L * aS * aS
         + uTrail * L * aS * aS;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vView = cameraPosition - w.xyz;
  vDist = length(vView);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
export const TENT_FRAG = COMMON + /* glsl */`
uniform vec3 uTint;
varying float vS;
void main() { gl_FragColor = vec4(waterFade(uTint * 0.22 * (1.0 - 0.7 * vS)) * uLight, 1.0); }`;

// Oral arms: four frilly ribbons trailing from the centre of the bell.
export const ARM_VERT = COMMON + /* glsl */`
attribute float aArm;
varying float vEdge, vS;
void main() {
  float s = uv.y, x = uv.x * 2.0 - 1.0;   // along the arm (0 at the bell) and across it
  vS = s; vEdge = abs(x);
  float a = (aArm + 0.5) * 1.5707963 + 0.7854;
  vec3 out_ = vec3(cos(a), 0.0, sin(a)), side = vec3(-out_.z, 0.0, out_.x);
  // Long, broad ribbons (about 1.3 bell radii; viatour.jpg), folded lengthwise into a V, with the
  // edges gently waved rather than zig-zagged.
  float L = uR * 1.3, w = uR * 0.24 * (1.0 - 0.55 * s) * (0.75 + 0.25 * smoothstep(0.0, 0.15, s));
  float ruffle = sin(s * 11.0 + x * 1.5 + aArm * 1.7) * vEdge * vEdge;
  // The outer third of each side is rolled into a tube about the arm's length (an arc of the same
  // width, so it curls rather than stretches), and that rolled lip is frilled finely along it.
  float e = clamp((vEdge - 0.65) / 0.35, 0.0, 1.0), phi = e * 3.4, Rr = 0.35 * w / 3.4;
  float lat = min(vEdge, 0.65) * w + Rr * sin(phi), lift = Rr * (1.0 - cos(phi));
  float frill = sin(s * 58.0 + aArm * 3.1 + sign(x) * 1.3) * e * e * 0.16 * w;
  vec3 p = vec3(0.0, -uR * 0.02, 0.0) + out_ * (uR * 0.06 + s * L * 0.15) + side * sign(x) * (lat + frill * 0.4)
         + vec3(0.0, -s * L, 0.0) + out_ * (ruffle * 0.45 * w + min(vEdge, 0.65) * 0.6 * w + lift + frill)
         + vec3(sin(uTime * 0.5 + aArm * 2.1 + uSeed), 0.0, cos(uTime * 0.43 + aArm)) * 0.12 * L * s * s;
  p.y += uPulse * 0.06 * uR * (1.0 - s);
  p += uTrail * L * s * s;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vView = cameraPosition - wp.xyz;
  vDist = length(vView);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
export const ARM_FRAG = COMMON + /* glsl */`
uniform vec3 uTint;
varying float vEdge, vS;
void main() {
  // The crinkled edge catches the light; a fine flicker along it reads as the frill.
  float frill = smoothstep(0.7, 1.0, vEdge) * (0.7 + 0.3 * sin(vS * 140.0));
  gl_FragColor = vec4(waterFade(uTint * (0.05 + 0.26 * frill + 0.08 * throughLight(normalize(vView))) * (1.0 - 0.6 * vS)) * uLight, 1.0);
}`;

/** The jelly tank's backdrop: a light panel behind and above, falling off to navy at the edges. */
export const BACKDROP_VERT = 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; gl_Position.z = gl_Position.w; }';
export const BACKDROP_FRAG = /* glsl */`
      uniform float uLight; varying vec3 vW;
      void main() {
        vec3 d = normalize(vW - cameraPosition);
        // Light panel behind and above the tank: a broad glow, brightest a little above the centre.
        float glow = exp(-pow(length(vec2(d.x * 1.1, d.y - 0.12)) / 0.42, 2.0));
        float halo = exp(-pow(length(vec2(d.x * 0.8, d.y - 0.05)) / 0.9, 2.0));
        // Azure at the panel (exhibit photos read ~#1a70ff), navy towards the edges.
        vec3 col = vec3(0.006, 0.13, 0.75) * glow + vec3(0.0, 0.025, 0.16) * halo + vec3(0.0, 0.003, 0.016);
        gl_FragColor = vec4(col * uLight, 1.0);
      }`;
