// Hero terrain: real west Austin elevation (USGS via AWS Terrain Tiles), drawn live on the GPU as a contoured 3D
// relief, with OpenStreetMap roads draped over it and a car looping along real streets.
// The first frame comes from a quarter-resolution preview inlined in the page (assets/data/austin-dem-q4.v1.js), so
// the hero is never empty while the full 1 MB elevation file downloads; full detail morphs in when it arrives. On
// arrival the flat map tilts up into 3D and the relief rises. Without WebGL2 it falls back to a flat CPU-traced
// contour map, and it survives a lost GPU context.
(function () {
'use strict';

// DEM: z13 Web Mercator mosaic in Terrarium encoding (lossless WebP), top-left at tile (tx0, ty0).
const DEM = { url: 'assets/data/austin-dem.v1.webp', z: 13, tx0: 1866.46875, ty0: 3369.0, mpp: 16.494 };
const ROADS = { url: 'assets/data/austin-roads.v2.js' };   // a script that sets window.TerrainRoads (works from file://)
const TILES = 2 ** DEM.z;
const MINOR = 20, MAJOR = 100;   // contour interval and index interval, m
const PK = 4;                    // preview resolution divisor
const GS = 2;                    // mesh vertex spacing, DEM px (33 m)
const EXAG = 6;                  // vertical exaggeration of the relief (Austin's hills are only ~240 m tall)
const H0 = 124;                  // reference elevation (the lowest point in the data), m
const REVEAL = 3400;             // ms for the flat map to tilt into 3D while the relief rises
const SWEEP = [0, 2900];         // ms: the contours fill in from the valleys up while the view rotates in
const CAR_IN = .65;              // the car arrives this far into the reveal
const DEG = Math.PI / 180;
// The drive loop's outline (every 4th point of the route in the roads file), DEM px. The hero frames itself around
// it before the roads file arrives, so the camera never re-frames mid-reveal. Regenerate if the route changes.
const LOOP_PTS = [1290,505,1274,721,1268,792,1236,852,1211,903,1206,901,1185,888,1128,774,1174,778,1192,740,1198,730,1208,717,1219,691,1215,650,1195,654,1192,608,1194,590,1212,588,1221,579,1229,559,1240,549,1251,532,1274,508,1290,502];
const LOOP = { x0: 1128, x1: 1291, y0: 495, y1: 924 };
const ll2px = (lat, lon) => {
  const tx = (lon + 180) / 360 * TILES, lr = lat * Math.PI / 180;
  const ty = (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * TILES;
  return [(tx - DEM.tx0) * 256, (ty - DEM.ty0) * 256];
};
const px2ll = (x, y) => {
  const tx = DEM.tx0 + x / 256, ty = DEM.ty0 + y / 256;
  return [Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / TILES))) * 180 / Math.PI, tx / TILES * 360 - 180];
};
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smoother = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10);

/* ---------- Shaders ---------- */
// World space: x east and y north in DEM px (DEM rows run south, so y = -row), z up in DEM px.
const TERRAIN_VS = `#version 300 es
precision highp float;
in vec2 aH;               // elevation (m) at this grid vertex: preview, full
uniform mat4 uVP;
uniform float uZk, uMix;  // world z per metre (includes the current exaggeration); preview-to-full blend
uniform int uGW;
out vec2 vP; out vec3 vW;
void main() {
  int i = gl_VertexID % uGW, j = gl_VertexID / uGW;
  vec2 p = vec2(float(i), float(j)) * ${GS}. + ${GS / 2}.;
  vec3 w = vec3(p.x, -p.y, (mix(aH.x, aH.y, uMix) - ${H0}.) * uZk);
  vP = p; vW = w;
  gl_Position = uVP * vec4(w, 1.);
}`;

const TERRAIN_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uDemA;  // preview: RG32F elevation (m) and water (0 or 1), one texel per ${PK} x ${PK} block
uniform sampler2D uDemB;  // full resolution, same layout
uniform float uMix;       // 0: preview only, 1: full only
uniform vec2 uSize;       // full-resolution size, DEM px
uniform vec2 uRes;        // drawing buffer size, device px
uniform vec4 uLens;       // cursor x, y (device px, GL origin), radius (device px), strength
uniform float uDpr, uFade, uShade;
uniform vec3 uEye;
uniform vec3 uLight;      // toward the sun
uniform vec2 uFog;        // fog start and end, distance from the eye
uniform float uHaze;      // how much the distance lifts toward a faint haze, so far ridges stand out against it
uniform vec2 uMinorFar;   // minor contours fade out between these distances
uniform vec4 uSweep;      // the draw-in: level (m), fade-in depth (m), shimmer strength, on (0 or 1)
in vec2 vP; in vec3 vW;
out vec4 o;

// Cubic B-spline reconstruction (16 taps) with an analytic gradient, so isolines stay smooth
// and evenly weighted on steep bluffs.
struct D { vec2 v; vec2 dx; vec2 dy; };
D dem(sampler2D t, vec2 p) {
  ivec2 hi = textureSize(t, 0) - 1;
  p -= .5;
  vec2 i = floor(p), f = p - i, f2 = f * f, f3 = f2 * f, g = 1. - f;
  vec4 wx = vec4(g.x * g.x * g.x, 4. - 6. * f2.x + 3. * f3.x, 1. + 3. * f.x + 3. * f2.x - 3. * f3.x, f3.x) / 6.;
  vec4 wy = vec4(g.y * g.y * g.y, 4. - 6. * f2.y + 3. * f3.y, 1. + 3. * f.y + 3. * f2.y - 3. * f3.y, f3.y) / 6.;
  vec4 dx = vec4(-.5 * g.x * g.x, -2. * f.x + 1.5 * f2.x, .5 + f.x - 1.5 * f2.x, .5 * f2.x);
  vec4 dy = vec4(-.5 * g.y * g.y, -2. * f.y + 1.5 * f2.y, .5 + f.y - 1.5 * f2.y, .5 * f2.y);
  ivec2 b = ivec2(i) - 1;
  D r; r.v = vec2(0.); r.dx = vec2(0.); r.dy = vec2(0.);
  for (int j = 0; j < 4; j++) {
    int yy = clamp(b.y + j, 0, hi.y);
    vec2 t0 = texelFetch(t, ivec2(clamp(b.x, 0, hi.x), yy), 0).rg;
    vec2 t1 = texelFetch(t, ivec2(clamp(b.x + 1, 0, hi.x), yy), 0).rg;
    vec2 t2 = texelFetch(t, ivec2(clamp(b.x + 2, 0, hi.x), yy), 0).rg;
    vec2 t3 = texelFetch(t, ivec2(clamp(b.x + 3, 0, hi.x), yy), 0).rg;
    vec2 rv = wx.x * t0 + wx.y * t1 + wx.z * t2 + wx.w * t3;
    vec2 rd = dx.x * t0 + dx.y * t1 + dx.z * t2 + dx.w * t3;
    r.v += wy[j] * rv; r.dx += wy[j] * rd; r.dy += dy[j] * rv;
  }
  return r;
}
// The preview and full data, blended while the full file morphs in.
D demAt(vec2 p) {
  D b; b.v = vec2(0.); b.dx = vec2(0.); b.dy = vec2(0.);
  if (uMix > 0.) b = dem(uDemB, p);
  if (uMix >= 1.) return b;
  D a = dem(uDemA, p / ${PK}.); a.dx /= ${PK}.; a.dy /= ${PK}.;
  if (uMix <= 0.) return a;
  a.v = mix(a.v, b.v, uMix); a.dx = mix(a.dx, b.dx, uMix); a.dy = mix(a.dy, b.dy, uMix);
  return a;
}
// Anti-aliased isoline coverage from a gradient in value per device px.
float iso(float v, float gpx, float step, float w0, float w1, out float spacing) {
  float gn = max(gpx / step, 1e-5);
  spacing = 1. / gn;
  float d = abs(fract(v / step + .5) - .5) / gn;
  return 1. - smoothstep(w0, w1, d);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 fc = gl_FragCoord.xy;
  D d = demAt(vP);
  float h = d.v.x, w = clamp(d.v.y, 0., 1.);
  vec2 gh = vec2(d.dx.x, d.dy.x), gw = vec2(d.dx.y, d.dy.y);
  // Gradients per screen pixel, through the perspective: how much the value changes from one pixel to the next.
  vec2 ex = dFdx(vP), ey = dFdy(vP);
  float ghPx = length(vec2(dot(gh, ex), dot(gh, ey)));
  float gwPx = length(vec2(dot(gw, ex), dot(gw, ey)));

  // Low sun from behind the viewer's left. 's' is 1 on flat ground, higher on slopes turned to the sun.
  vec3 n = normalize(vec3(-gh.x * uShade, gh.y * uShade, 1.));
  float s = clamp(dot(n, uLight) / uLight.z, 0., 2.6);
  vec3 col = vec3(.054, .057, .057) * (.30 + .74 * s);
  float dist = length(vW - uEye);

  // Soft spotlight around the cursor lifts the contours nearby.
  float lens = uLens.w * (1. - smoothstep(0., uLens.z, length(fc - uLens.xy)));

  // Contours: minor and index. Lines fade where they would crowd closer than a few pixels, and the minor ones
  // give way to the index lines with distance. Lines on sunlit slopes glow; on shaded slopes they recede.
  float spA, spB;
  float minor = iso(h, ghPx, ${MINOR}., .30 * uDpr, .95 * uDpr, spA) * smoothstep(3. * uDpr, 8. * uDpr, spA) * (1. - smoothstep(uMinorFar.x, uMinorFar.y, dist));
  float major = iso(h, ghPx, ${MAJOR}., .45 * uDpr, 1.25 * uDpr, spB) * smoothstep(3. * uDpr, 7. * uDpr, spB);
  float lit = clamp(.25 + .75 * s, .2, 1.9);
  float land = 1. - smoothstep(.3, .7, w);
  vec3 ink = vec3(.925, .918, .898), warm = vec3(1., .55, .32);
  // The draw-in: the index lines are there from the start, and the minor lines fill in from the valleys up as a
  // level rises through them, each fading in with a slight shimmer that settles.
  float sw = 1., glow = 0.;
  if (uSweep.w > 0.) {
    float below = uSweep.x - h;
    sw = smoothstep(0., uSweep.y, below);
    glow = sw * exp(-max(below - uSweep.y, 0.) / uSweep.y) * uSweep.z;
  }
  col = mix(col, mix(ink, warm, lens * .35), clamp(minor * sw * (.17 * lit * (1. + .7 * glow) + .22 * lens) * land, 0., 1.));
  col = mix(col, mix(ink, warm, lens * .45), clamp(major * (.36 * lit + .25 * lens) * land, 0., 1.));

  // Water: a flat, slightly cooler surface with a fine shoreline.
  float wm = smoothstep(.3, .7, w);
  col = mix(col, vec3(.032, .042, .048), wm);
  float shore = 1. - smoothstep(.4 * uDpr, 1.2 * uDpr, abs(w - .5) / max(gwPx, 1e-4));
  col = mix(col, vec3(.58, .65, .68), shore * .30);

  // Distance fog, fade at the data edge, vignette, dither against banding.
  vec3 bg = vec3(.043, .047, .047);
  vec2 edge = min(vP, uSize - vP);
  float far = smoothstep(uFog.x, uFog.y, dist);
  col = mix(col, bg * (1. + uHaze), far);
  col = mix(bg, col, smoothstep(0., 80., min(edge.x, edge.y)));
  vec2 q = fc / uRes - .5;
  col *= 1. - .26 * dot(q, q);
  col += (hash(fc) - .5) * (1.5 / 255.);
  o = vec4(mix(bg, col, uFade), 1.);
}`;

// Roads: each piece is a quad widened in screen space, so lines stay crisp at any distance, depth-tested against
// the terrain so ridges hide the streets behind them.
const ROAD_VS = `#version 300 es
precision highp float;
in vec4 aA;               // piece start: x, y (DEM px), elevation preview, full (m)
in vec4 aB;               // piece end
in vec4 aS;               // side (-1 or 1), end (0 or 1), width (CSS px), opacity
uniform mat4 uVP;
uniform float uZk, uMix, uDpr;
uniform vec2 uRes;
uniform vec4 uBox;        // extent of the road data, DEM px: roads fade out before they end
out float vD; out float vHW; out float vA;
vec4 clip(vec4 a) { return uVP * vec4(a.x, -a.y, (mix(a.z, a.w, uMix) - ${H0}.) * uZk, 1.); }
void main() {
  vec4 ca = clip(aA), cb = clip(aB);
  if (ca.w <= 0. || cb.w <= 0.) { gl_Position = vec4(2., 2., 2., 1.); return; }
  vec2 sa = ca.xy / ca.w * uRes * .5, sb = cb.xy / cb.w * uRes * .5, dir = sb - sa;
  float L = length(dir);
  dir = L > 1e-4 ? dir / L : vec2(1., 0.);
  float hw = .5 * aS.z * uDpr, ext = hw + uDpr;
  vec4 c = aS.y > .5 ? cb : ca;
  c.xy += vec2(-dir.y, dir.x) * aS.x * ext / (uRes * .5) * c.w;
  c.z -= 4e-4 * c.w;      // a hair toward the eye, so the road wins against the surface it lies on
  gl_Position = c;
  vec2 m = mix(aA.xy, aB.xy, aS.y);
  float e = min(min(m.x - uBox.x, uBox.z - m.x), min(m.y - uBox.y, uBox.w - m.y));
  vD = aS.x * ext; vHW = hw; vA = aS.w * smoothstep(0., 70., e);
}`;
const ROAD_FS = `#version 300 es
precision highp float;
uniform float uFade, uDpr;
in float vD; in float vHW; in float vA;
out vec4 o;
void main() {
  // Coverage of a line of half-width vHW, box-filtered over one device pixel; thin lines keep their total ink.
  float c = clamp(vHW + .5 * uDpr - abs(vD), 0., uDpr) / uDpr * min(1., 2. * vHW / uDpr + .25);
  o = vec4(.925, .918, .898, vA * c * uFade);
}`;

// The car: a small low-poly model in metres (x forward, y left, z up), placed on the surface through uM, lit by the
// same sun as the terrain. Materials: 0 paint, 1 glass, 2 lamp (unlit), 3 tyre.
const CAR_VS = `#version 300 es
precision highp float;
in vec3 aP; in vec3 aN; in vec4 aC;
uniform mat4 uVP, uM;
out vec3 vN; out vec3 vW; out vec4 vC;
void main() {
  vec4 w = uM * vec4(aP, 1.);
  vN = mat3(uM) * aN; vW = w.xyz; vC = aC;
  gl_Position = uVP * w;
}`;
const CAR_FS = `#version 300 es
precision highp float;
uniform vec3 uLight, uEye;
in vec3 vN; in vec3 vW; in vec4 vC;
out vec4 o;
void main() {
  vec3 N = normalize(vN), V = normalize(uEye - vW);
  // Key light from the sun, a soft fill from the viewer's side (so the paint reads at every heading), sky ambient.
  float dif = max(dot(N, uLight), 0.), sky = .55 + .45 * N.z, fill = max(dot(N, V), 0.);
  vec3 c;
  if (vC.a < .5) c = vC.rgb * (.26 * sky + .62 * dif + .42 * fill) + .08 * pow(1. - fill, 3.);
  else if (vC.a < 1.5) c = vC.rgb * (.6 + .4 * sky) + .30 * pow(max(dot(reflect(-V, N), uLight), 0.), 16.) + .05 * sky;
  else if (vC.a < 2.5) c = vC.rgb;
  else c = vC.rgb * (.5 + .5 * dif);
  o = vec4(c, 1.);
}`;
// Composite: the car is drawn into a small 4x multisampled target around it (so its edges are smooth without
// multisampling the whole screen), resolved to a texture with premultiplied coverage, and laid over the frame.
const COMP_VS = `#version 300 es
in vec2 aQ;
uniform vec4 uRect;       // centre and half-size, NDC
out vec2 vUV;
void main() { vUV = aQ * .5 + .5; gl_Position = vec4(uRect.xy + aQ * uRect.zw, 0., 1.); }`;
const COMP_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uAlpha;
in vec2 vUV;
out vec4 o;
void main() { o = texture(uTex, vUV) * uAlpha; }`;
// Light and shade the car casts on the ground: a contact shadow, a warm glow, and the headlight beam. One quad in the
// car's ground frame; uKind picks the shape.
const DECAL_VS = `#version 300 es
precision highp float;
in vec2 aQ;
uniform mat4 uVP, uM;
out vec2 vQ;
void main() { vQ = aQ; gl_Position = uVP * uM * vec4(aQ, 0., 1.); }`;
const DECAL_FS = `#version 300 es
precision highp float;
uniform int uKind;
uniform float uAlpha;
in vec2 vQ;
out vec4 o;
void main() {
  float r = length(vQ);
  if (uKind == 0) { o = vec4(0., 0., 0., .62 * uAlpha * (1. - smoothstep(.35, 1., r))); return; }
  if (uKind == 1) { float g = 1. - smoothstep(0., 1., r); o = vec4(vec3(1., .55, .35) * .20 * g * g * uAlpha, 1.); return; }
  // Beam: vQ.x runs 0 (bumper) to 1 (far end) along the quad from -1 to 1; it spreads with distance.
  float u = vQ.x * .5 + .5, w = .16 + .5 * u, b = (1. - smoothstep(w * .55, w, abs(vQ.y))) * pow(1. - u, 1.6) * smoothstep(0., .08, u);
  o = vec4(vec3(1., .93, .84) * .26 * b * uAlpha, 1.);
}`;
// Car mesh: a few extruded profiles and boxes with flat normals.
function buildCarMesh() {
  const v = [];
  const PAINT = [.94, .93, .91, 0], GLASS = [.10, .11, .12, 1], HEAD = [1, .95, .86, 2], TAIL = [1, .40, .18, 2], TYRE = [.05, .05, .055, 3];
  const tri = (a, b, c, m, ctr) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const L = Math.hypot(...n) || 1; n = n.map(x => x / L);
    // Face outward, away from the part's centre.
    const mid = [(a[0] + b[0] + c[0]) / 3 - ctr[0], (a[1] + b[1] + c[1]) / 3 - ctr[1], (a[2] + b[2] + c[2]) / 3 - ctr[2]];
    if (n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2] < 0) n = n.map(x => -x);
    for (const p of [a, b, c]) v.push(...p, ...n, ...m);
  };
  const quad = (a, b, c, d, m, ctr) => { tri(a, b, c, m, ctr); tri(a, c, d, m, ctr); };
  // A profile in the x-z plane, extruded across y; each profile point may have its own half-width (a third value),
  // which gives the cabin its tumblehome. mats(i) colours the strip after profile point i.
  const prism = (pr, hw, mats, sideMat) => {
    const ctr = [pr.reduce((s, p) => s + p[0], 0) / pr.length, 0, pr.reduce((s, p) => s + p[1], 0) / pr.length], W = p => p[2] ?? hw;
    for (const sg of [-1, 1]) for (let i = 1; i + 1 < pr.length; i++) tri([pr[0][0], sg * W(pr[0]), pr[0][1]], [pr[i][0], sg * W(pr[i]), pr[i][1]], [pr[i + 1][0], sg * W(pr[i + 1]), pr[i + 1][1]], sideMat, ctr);
    for (let i = 0; i < pr.length; i++) {
      const a = pr[i], b = pr[(i + 1) % pr.length];
      quad([a[0], -W(a), a[1]], [b[0], -W(b), b[1]], [b[0], W(b), b[1]], [a[0], W(a), a[1]], mats(i), ctr);
    }
  };
  const box = (cx, cy, cz, hx, hy, hz, m) => prism([[cx - hx, cz - hz], [cx + hx, cz - hz], [cx + hx, cz + hz], [cx - hx, cz + hz]].map(([x, z]) => [x, z]), hy, () => m, m) || v;
  // Tyres first (offset in y by shifting the box), then the body over them.
  for (const x of [-1.42, 1.42]) for (const y of [-.78, .78]) {
    const n0 = v.length; box(x, 0, .33, .34, .13, .33, TYRE);
    for (let i = n0; i < v.length; i += 10) v[i + 1] += y;
  }
  // Body: a low sedan, the hood falling to the nose and a short deck at the back.
  prism([[-2.3, .3], [2.3, .3], [2.34, .56], [2.14, .78], [1.15, .97], [-1.95, .97], [-2.3, .86]], .93, () => PAINT, PAINT);
  // Cabin: raked windshield, narrower at the roof; dark glass all round, painted roof.
  prism([[-1.72, .97, .82], [1.12, .97, .82], [.1, 1.41, .66], [-1.12, 1.41, .66]], .8, i => i === 2 ? PAINT : GLASS, GLASS);
  // Lamps, a hair proud of the body.
  const lamp = (x, y0, y1, z0, z1, m) => quad([x, y0, z0], [x, y1, z0], [x, y1, z1], [x, y0, z1], m, [0, 0, .6]);
  lamp(2.345, .46, .82, .42, .53, HEAD); lamp(2.345, -.82, -.46, .42, .53, HEAD);
  lamp(-2.31, .52, .88, .66, .79, TAIL); lamp(-2.31, -.88, -.52, .66, .79, TAIL);
  return new Float32Array(v);
}
const CAR_LEN = 4.6;   // model metres, nose to tail

const yieldTask = () => new Promise(r => setTimeout(r, 0));
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
// Loads a data script (allowed from file://, unlike fetch) and resolves with the global it sets.
const loadScript = (url, global) => new Promise((res, rej) => {
  if (window[global]) { res(window[global]); return; }
  const s = document.createElement('script'); s.src = url; s.async = true;
  s.onload = () => window[global] ? res(window[global]) : rej(new Error(`${url} did not define ${global}`));
  s.onerror = () => rej(new Error(`Failed to load ${url}`));
  document.head.appendChild(s);
});
async function fetchOk(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r;
}
// Terrarium-encoded image to elevation (m) and water (0 or 1).
async function decodeDem(blob) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const w = bmp.width, h = bmp.height, c = document.createElement('canvas'); c.width = w; c.height = h;
  const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(bmp, 0, 0);
  const px = cx.getImageData(0, 0, w, h).data; bmp.close();
  const elev = new Float32Array(w * h), water = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    // Terrarium encoding: h = R*256 + G + B/256 - 32768. The lowest blue bit carries the water mask.
    const b = px[j + 2]; elev[i] = px[j] * 256 + px[j + 1] + (b & 254) / 256 - 32768; water[i] = b & 1;
  }
  return { w, h, elev, water };
}

function init({ hero, canvas, overlay, onReadout, labels, avoid = [] }) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stats = { gl: false, frames: 0, ready: false, full: false, error: null, firstFrameMs: 0 };
  let cv = canvas;
  const ov = overlay, octx = ov.getContext('2d');

  /* ---------- Data ---------- */
  // Grid: mesh vertices every GS DEM px, at (i, j) * GS + GS / 2. Their heights are lightly smoothed so ridges render
  // as rounded crests instead of facets; contours and shading still come from the exact data, per pixel.
  let GW = 0, GH = 0, gA = null, gB = null, mixV = 0;            // grid elevations: preview, full; blend
  let EW = 0, EH = 0, elev = null, water = null;                  // full-resolution CPU copy
  const gridH = k => gA[k] + (gB[k] - gA[k]) * mixV;
  // Elevation (m) of the rendered mesh at (x, y) DEM px: the same triangles the GPU draws.
  // Triangle strips split each cell along its (i, j + 1) to (i + 1, j) diagonal.
  function meshH(x, y) {
    const cx = clamp((x - GS / 2) / GS, 0, GW - 1.0001), cy = clamp((y - GS / 2) / GS, 0, GH - 1.0001);
    const i = cx | 0, j = cy | 0, fx = cx - i, fy = cy - j, k = j * GW + i;
    const h00 = gridH(k), h10 = gridH(k + 1), h01 = gridH(k + GW), h11 = gridH(k + GW + 1);
    return fx + fy <= 1 ? h00 + fx * (h10 - h00) + fy * (h01 - h00) : h11 + (1 - fx) * (h01 - h11) + (1 - fy) * (h10 - h11);
  }
  // True elevation for readouts: full data once loaded, the preview mesh before that.
  const sampleElev = (x, y) => {
    if (!elev) return meshH(x, y);
    x = clamp(x - .5, 0, EW - 1.001); y = clamp(y - .5, 0, EH - 1.001);
    const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, i = iy * EW + ix;
    return (elev[i] * (1 - fx) + elev[i + 1] * fx) * (1 - fy) + (elev[i + EW] * (1 - fx) + elev[i + EW + 1] * fx) * fy;
  };
  const isWater = (x, y) => water ? water[clamp(y | 0, 0, EH - 1) * EW + clamp(x | 0, 0, EW - 1)] > 0 : false;

  /* ---------- Camera ---------- */
  let vw = 0, vh = 0, dpr = 1, dprOv = 1, dprCap = 1.5, portrait = false;
  let t0 = -1, ex = 0, zk = 0;                                   // reveal start; current exaggeration; world z per m
  const cam = { eye: [0, 0, 0], r: [1, 0, 0], u: [0, 1, 0], d: [0, 0, -1], VP: new Float32Array(16), P00: 1, P11: 1, sx: 0, sy: 0, D: 1, near: 1, far: 2 };
  const pose = { tx: 0, ty: 0, psi: 0, theta: 0, D: 1, fov: 30 * DEG, sx: 0, sy: 0, ex: EXAG, shade: 6, sun: -70, sunEl: 24, fog0: 1.2, fog1: 2.6, mf0: 1.0, mf1: 1.7, haze: .35 };   // resting pose for this layout
  const mouse = { x: -1, y: -1, in: false }, par = { x: 0, y: 0 };
  // Framing: the angles are fixed per layout; the target shift and distance are solved for this screen, so the whole
  // drive loop sits in the free space beside (or above) the copy, with a margin for the drift and pointer parallax.
  function layout() {
    portrait = vw < 700 || vh > vw * 1.05;
    Object.assign(pose, portrait
      ? { tx: 1210, ty: 700, psi: 22 * DEG, theta: 60 * DEG, fov: 34 * DEG, sx: 0, sy: .3, D: 900 }
      : { tx: 1210, ty: 710, psi: 40 * DEG, theta: 66 * DEG, fov: 28 * DEG, sx: .3, sy: .3, D: 720 });
    if (gA) solveFraming();
    if (ib) buildIndices();
  }
  let rects = [];
  const hit = (x, y) => { for (const r of rects) if (x > r[0] && x < r[2] && y > r[1] && y < r[3]) return true; return false; };
  function solveFraming() {
    const hr = hero.getBoundingClientRect(), rng = document.createRange(), pad = 36;
    rects = avoid.map(el => { rng.selectNodeContents(el); return rng.getBoundingClientRect(); }).filter(b => b.width > 0 && b.height > 0)
      .map(b => [b.left - hr.left - pad, b.top - hr.top - pad, b.right - hr.left + pad, b.bottom - hr.top + pad]);
    const zk0 = zk, base = { ...pose }, out = [0, 0, 0], camSave = { ...cam, VP: cam.VP.slice() };
    zk = pose.ex / DEM.mpp;
    const tz = (meshH(pose.tx, pose.ty) - H0) * zk, wobble = [[0, 0], [-7, 1.5], [7, -1.5], [0, 6]];
    let best = null;
    const sxs = portrait ? [-.12, -.06, 0, .06, .12] : [.08, .14, .2, .26, .32, .38, .44, .5, .56, .62];
    const sys = portrait ? [.18, .24, .3, .36, .42, .48] : [.12, .18, .24, .3, .36];
    for (const sx of sxs) for (const sy of sys) for (let D = 460; D <= 1500; D += 40) {
      let bad = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const [dp, dt] of wobble) {
        setCamera(pose.tx, pose.ty, tz, base.psi + dp * DEG, base.theta + dt * DEG, D, base.fov, sx, sy);
        for (let k = 0; k < LOOP_PTS.length; k += 2) {
          project(LOOP_PTS[k], LOOP_PTS[k + 1], meshH(LOOP_PTS[k], LOOP_PTS[k + 1]), out);
          if (out[2] <= 0 || out[0] < 20 || out[0] > vw - 20 || out[1] < 76 || out[1] > vh - 20 || hit(out[0], out[1])) { bad++; break; }
          if (!dp && !dt) { x0 = Math.min(x0, out[0]); x1 = Math.max(x1, out[0]); y0 = Math.min(y0, out[1]); y1 = Math.max(y1, out[1]); }
        }
        if (bad) break;
      }
      // Largest loop that clears the copy; among near-ties, the one nearest the middle of the free space.
      const score = bad ? -1 : (x1 - x0) * (y1 - y0) - 400 * Math.abs(sx - sxs[(sxs.length / 2) | 0]) * vw;
      if (!bad && (!best || score > best.score)) best = { score, sx, sy, D };
    }
    zk = zk0; cam.VP.set(camSave.VP); Object.assign(cam, { ...camSave, VP: cam.VP });   // the solver leaves no trace on the live camera
    if (best) Object.assign(pose, { sx: best.sx, sy: best.sy, D: best.D });
    stats.framing = best ? { sx: best.sx, sy: best.sy, D: best.D } : null;
  }
  function setCamera(tx, ty, tz, psi, theta, D, fov, sx, sy) {
    const sp = Math.sin(psi), cp = Math.cos(psi), st = Math.sin(theta), ct = Math.cos(theta);
    const d = [-sp * st, cp * st, -ct], r = [cp, sp, 0], b = [-d[0], -d[1], -d[2]];
    const u = [b[1] * r[2] - b[2] * r[1], b[2] * r[0] - b[0] * r[2], b[0] * r[1] - b[1] * r[0]];
    const eye = [tx - d[0] * D, -ty - d[1] * D, tz - d[2] * D];
    const dot = (a, c) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
    const V = [r[0], u[0], b[0], 0, r[1], u[1], b[1], 0, r[2], u[2], b[2], 0, -dot(r, eye), -dot(u, eye), -dot(b, eye), 1];
    const f = 1 / Math.tan(fov / 2), asp = vw / vh, n = D * .25, fa = D * 4;
    const P = [f / asp, 0, 0, 0, 0, f, 0, 0, -sx, -sy, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0];
    const m = cam.VP;
    for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) m[c * 4 + k] = P[k] * V[c * 4] + P[4 + k] * V[c * 4 + 1] + P[8 + k] * V[c * 4 + 2] + P[12 + k] * V[c * 4 + 3];
    Object.assign(cam, { eye, r, u, d, P00: f / asp, P11: f, sx, sy, D, near: n, far: fa });
  }
  // World point (DEM x, y, elevation m) to CSS px; out[2] > 0 when it is in front of the camera.
  function project(x, y, h, out) {
    if (!gl) { out[0] = (x - fv.x) * fv.s + vw / 2; out[1] = (y - fv.y) * fv.s + vh / 2; out[2] = 1; return out; }   // flat fallback
    const m = cam.VP, X = x, Y = -y, Z = (h - H0) * zk, w = m[3] * X + m[7] * Y + m[11] * Z + m[15];
    out[0] = ((m[0] * X + m[4] * Y + m[8] * Z + m[12]) / w * .5 + .5) * vw;
    out[1] = (.5 - (m[1] * X + m[5] * Y + m[9] * Z + m[13]) / w * .5) * vh;
    out[2] = w; return out;
  }
  // Is the straight line from the eye to this point clear of the terrain?
  function visible(x, y, h) {
    const e = cam.eye, Z = (h - H0) * zk;
    for (let k = 1; k < 28; k++) {
      const s = k / 28, qx = e[0] + (x - e[0]) * s, qy = -(e[1] + (-y - e[1]) * s), qz = e[2] + (Z - e[2]) * s;
      if ((meshH(qx, qy) - H0) * zk > qz + .4) return false;
    }
    return true;
  }
  // The point on the terrain under a screen position (CSS px), or null.
  function pick(mx, my) {
    const nx = mx / vw * 2 - 1, ny = 1 - my / vh * 2, ax = (nx - cam.sx) / cam.P00, ay = (ny - cam.sy) / cam.P11;
    const { r, u, d, eye } = cam, dir = [ax * r[0] + ay * u[0] + d[0], ax * r[1] + ay * u[1] + d[1], ax * r[2] + ay * u[2] + d[2]];
    if (dir[2] >= -1e-4) return null;
    const top = (370 - H0) * zk, below = (x, y, z) => (meshH(x, -y) - H0) * zk >= z;
    let t = Math.max(0, (eye[2] - top) / -dir[2]), prev = t;
    const step = 1.5 / Math.hypot(dir[0], dir[1]) * Math.max(.2, Math.hypot(dir[0], dir[1]));
    for (let k = 0; k < 4000; k++) {
      const x = eye[0] + dir[0] * t, y = eye[1] + dir[1] * t, z = eye[2] + dir[2] * t;
      if (x < 0 || -y < 0 || x > EW || -y > EH) { if (z < 0) return null; }
      if (below(x, y, z)) {
        let lo = prev, hi = t;
        for (let b = 0; b < 12; b++) { const m = (lo + hi) / 2; if (below(eye[0] + dir[0] * m, eye[1] + dir[1] * m, eye[2] + dir[2] * m)) hi = m; else lo = m; }
        const px = eye[0] + dir[0] * hi, py = -(eye[1] + dir[1] * hi);
        return px < 0 || py < 0 || px >= EW || py >= EH ? null : [px, py];
      }
      prev = t; t += step;
    }
    return null;
  }
  let scrollP = 0, lastCamT = 0;
  function updateCamera(t) {
    const dt = lastCamT ? clamp((t - lastCamT) / 1000, .001, .1) : 1 / 60; lastCamT = t;
    const age = t0 < 0 ? 0 : t - t0;
    // The reveal: a single eased move from a flatter, higher view, with the relief rising a beat behind the tilt.
    const u = reduce ? 1 : smoother(age / REVEAL), ur = reduce ? 1 : smoother((age - 250) / (REVEAL - 250));
    ex = pose.ex * ur; zk = ex / DEM.mpp;
    let theta = lerp(pose.theta * .3, pose.theta, u), D = pose.D * lerp(1.16, 1, u), psi = pose.psi - lerp(12 * DEG, 0, u);
    // Then a slow drift, faded in from zero so it never starts with a jolt.
    if (!reduce) {
      const da = smoother((age - REVEAL * .6) / 3000);
      psi += da * 4.5 * DEG * Math.sin(t * 2 * Math.PI / 110000);
      theta += da * 1.6 * DEG * Math.sin(t * 2 * Math.PI / 71000 + 1);
      // Pointer parallax, smoothed exponentially (no overshoot).
      const k = 1 - Math.exp(-dt / .7);
      par.x += ((mouse.in && !touch ? mouse.x / vw - .5 : 0) - par.x) * k;
      par.y += ((mouse.in && !touch ? mouse.y / vh - .5 : 0) - par.y) * k;
      psi += par.x * 6 * DEG; theta -= par.y * 2.5 * DEG;
      theta += scrollP * 6 * DEG; D *= 1 - .08 * scrollP;
    }
    const tz = (meshH(pose.tx, pose.ty) - H0) * zk;
    setCamera(pose.tx, pose.ty, tz, psi, theta, D, pose.fov, pose.sx, pose.sy);
  }

  /* ---------- GL ---------- */
  let gl = null, glLost = false, progT = null, progR = null, vaoT = null, vaoR = null, hBuf = null, nIdx = 0, nRIdx = 0, rIdxType = 0;
  let texA = null, texB = null, roadsOn = false;
  const UT = {}, UR = {}, UC = {}, UD = {};
  let progC = null, progD = null, progQ = null, vaoC = null, vaoD = null, nCar = 0, carRT = null;
  const UQ = {};
  function compile(vsSrc, fsSrc) {
    const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
    const p = gl.createProgram(), vs = mk(gl.VERTEX_SHADER, vsSrc), fs = mk(gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p); p.shaders = [vs, fs];
    return p;
  }
  function linked(p) {
    if (gl.getProgramParameter(p, gl.LINK_STATUS)) return true;
    for (const sh of p.shaders) if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(sh));
    console.error(gl.getProgramInfoLog(p)); return false;
  }
  function createGL() {
    // No multisampling: lines and roads anti-alias themselves, and MSAA over a million triangles halves the frame
    // rate on integrated GPUs.
    gl = cv.getContext('webgl2', { antialias: false, alpha: false, depth: true, powerPreference: 'default' });
    stats.gl = !!gl;
    if (!gl) { const c2 = cv.cloneNode(false); cv.replaceWith(c2); cv = c2; fctx = cv.getContext('2d'); return; }
    gl.getExtension('KHR_parallel_shader_compile');
    progT = compile(TERRAIN_VS, TERRAIN_FS); progR = compile(ROAD_VS, ROAD_FS); progC = compile(CAR_VS, CAR_FS); progD = compile(DECAL_VS, DECAL_FS); progQ = compile(COMP_VS, COMP_FS);
    // A GPU reset or driver switch loses the context: keep drawing the overlay, and rebuild when it returns.
    cv.addEventListener('webglcontextlost', e => { e.preventDefault(); glLost = true; });
    cv.addEventListener('webglcontextrestored', () => {
      progT = compile(TERRAIN_VS, TERRAIN_FS); progR = compile(ROAD_VS, ROAD_FS); progC = compile(CAR_VS, CAR_FS); progD = compile(DECAL_VS, DECAL_FS); progQ = compile(COMP_VS, COMP_FS);
      vaoR = null; roadsOn = false; ib = null; carRT = null;
      // Lost before the first data was in: load() sets up the new context when the data arrives.
      if (!pre) { glLost = false; return; }
      setupGL(); if (elev) { texB = makeTex(EW, EH, elev, water); uploadGridH(); } if (roads.length) buildRoads();
      glLost = false; if (ready) draw(performance.now(), true);
    });
  }
  function makeTex(w, h, e, wa) {
    const data = new Float32Array(w * h * 2);
    for (let i = 0; i < w * h; i++) { data[i * 2] = e[i]; data[i * 2 + 1] = wa[i]; }
    const tx = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, w, h, 0, gl.RG, gl.FLOAT, data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return tx;
  }
  let pre = null;   // preview data, kept for a context restore
  function setupGL() {
    linked(progT); linked(progR); linked(progC); linked(progD); linked(progQ);
    for (const n of ['uVP', 'uM', 'uLight', 'uEye']) UC[n] = gl.getUniformLocation(progC, n);
    for (const n of ['uRect', 'uTex', 'uAlpha']) UQ[n] = gl.getUniformLocation(progQ, n);
    for (const n of ['uVP', 'uM', 'uKind', 'uAlpha']) UD[n] = gl.getUniformLocation(progD, n);
    {
      const mesh = buildCarMesh(); nCar = mesh.length / 10;
      vaoC = gl.createVertexArray(); gl.bindVertexArray(vaoC);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
      [['aP', 3, 0], ['aN', 3, 12], ['aC', 4, 24]].forEach(([n, k, off]) => { const l = gl.getAttribLocation(progC, n); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, k, gl.FLOAT, false, 40, off); });
      vaoD = gl.createVertexArray(); gl.bindVertexArray(vaoD);
      const q = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, q); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
      const l = gl.getAttribLocation(progD, 'aQ'); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
      // progQ reads the same quad; its aQ is bound to the same location.
      gl.bindAttribLocation(progQ, l, 'aQ'); gl.linkProgram(progQ);
      for (const n of ['uRect', 'uTex', 'uAlpha']) UQ[n] = gl.getUniformLocation(progQ, n);
      gl.bindVertexArray(null);
    }
    for (const n of ['uVP', 'uZk', 'uMix', 'uGW', 'uDemA', 'uDemB', 'uSize', 'uRes', 'uLens', 'uDpr', 'uFade', 'uShade', 'uEye', 'uFog', 'uLight', 'uMinorFar', 'uHaze', 'uSweep']) UT[n] = gl.getUniformLocation(progT, n);
    for (const n of ['uVP', 'uZk', 'uMix', 'uDpr', 'uRes', 'uBox', 'uFade']) UR[n] = gl.getUniformLocation(progR, n);
    texA = makeTex(pre.w, pre.h, pre.elev, pre.water);
    texB = texA;
    // Mesh: elevations per vertex (preview, full), and triangles split along the same diagonal as meshH().
    vaoT = gl.createVertexArray(); gl.bindVertexArray(vaoT);
    hBuf = gl.createBuffer(); uploadGridH();
    const aH = gl.getAttribLocation(progT, 'aH'); gl.enableVertexAttribArray(aH); gl.vertexAttribPointer(aH, 2, gl.FLOAT, false, 0, 0);
    ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    buildIndices();
    gl.bindVertexArray(null);
  }
  // Only the part of the mesh the camera can see (at rest, through the reveal, and across the drift) is drawn: one
  // triangle strip per row with primitive restart, rows emitted south to north, nearest first for the views used
  // here, so the depth test rejects most hidden fragments before they are shaded.
  let ib = null, meshBox = null;
  // The draw-in's elevation schedule: levels at evenly spaced fractions of what the resting view shows (by screen area,
  // fading with the fog), so the front spends its time where there are lines to draw rather than on hidden peaks.
  const sweep = { q: null };
  function sweepTable() {
    const save = { ...cam, VP: cam.VP.slice() }, zk0 = zk, P = [0, 0, 0], hist = new Float64Array(1024);
    zk = pose.ex / DEM.mpp;
    setCamera(pose.tx, pose.ty, (meshH(pose.tx, pose.ty) - H0) * zk, pose.psi, pose.theta, pose.D, pose.fov, pose.sx, pose.sy);
    const [i0, j0, i1, j1] = meshBox, F0 = pose.D * pose.fog0, F1 = pose.D * pose.fog1;
    let tot = 0, top = 0;
    for (let j = j0; j <= j1; j += 2) for (let i = i0; i <= i1; i += 2) {
      const x = i * GS + GS / 2, y = j * GS + GS / 2, h = gA[j * GW + i], b = clamp(Math.round(h), 0, 1023);
      top = Math.max(top, b);
      if (pre.water[clamp(y / PK | 0, 0, pre.h - 1) * pre.w + clamp(x / PK | 0, 0, pre.w - 1)]) continue;
      project(x, y, h, P);
      if (P[2] <= 0 || P[0] < 0 || P[0] > vw || P[1] < 0 || P[1] > vh) continue;
      const dist = Math.hypot(x - cam.eye[0], -y - cam.eye[1], (h - H0) * zk - cam.eye[2]);
      const wgt = (1 - clamp((dist - F0) / (F1 - F0), 0, 1)) / (P[2] * P[2]);
      hist[b] += wgt; tot += wgt;
    }
    zk = zk0; cam.VP.set(save.VP); Object.assign(cam, { ...save, VP: cam.VP });
    if (!tot) return null;
    // 25 levels from the lowest visible ground to the 99.5th percentile, then on past the highest peak in the data.
    const q = []; let c = 0, v = 0;
    for (let k = 0; k <= 24; k++) { const want = tot * (.002 + k / 24 * .993); while (v < 1023 && c + hist[v] < want) c += hist[v++]; q.push(v); }
    q.push(Math.max(q[24], top) + 31);
    stats.sweep = q.slice();
    return q;
  }
  function visibleBox() {
    const save = { ...cam, VP: cam.VP.slice() }, zk0 = zk, F = pose.D * pose.fog1;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    zk = pose.ex / DEM.mpp;
    const tz = (meshH(pose.tx, pose.ty) - H0) * zk, zTop = (370 - H0) * zk;
    for (const [th, dd, dp, dt] of [[.3, 1.16, -10, 0], [.65, 1.08, -5, 0], [1, 1, 0, 0], [1, 1, -12, 3], [1, 1, 12, -3], [1, 1, 0, 8]]) {
      setCamera(pose.tx, pose.ty, tz * (th > .5 ? 1 : 0), pose.psi + dp * DEG, pose.theta * th + dt * DEG, pose.D * dd, pose.fov, pose.sx, pose.sy);
      for (let k = 0; k <= 16; k++) for (const [nx, ny] of [[k / 8 - 1, -1], [k / 8 - 1, 1], [-1, k / 8 - 1], [1, k / 8 - 1]]) {
        const ax = (nx - cam.sx) / cam.P00, ay = (ny - cam.sy) / cam.P11, { r, u, d, eye } = cam;
        const dir = [ax * r[0] + ay * u[0] + d[0], ax * r[1] + ay * u[1] + d[1], ax * r[2] + ay * u[2] + d[2]], L = Math.hypot(...dir);
        for (const zp of [0, zTop]) {
          let t = dir[2] < -1e-6 ? (eye[2] - zp) / -dir[2] : F * 4 / L;
          t = Math.min(t, F * 1.05 / L);
          const x = eye[0] + dir[0] * t, y = -(eye[1] + dir[1] * t);
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
      }
    }
    zk = zk0; cam.VP.set(save.VP); Object.assign(cam, { ...save, VP: cam.VP });
    const m = 60;
    return [clamp(Math.floor((x0 - m) / GS), 0, GW - 1), clamp(Math.floor((y0 - m) / GS), 0, GH - 1), clamp(Math.ceil((x1 + m) / GS), 0, GW - 1), clamp(Math.ceil((y1 + m) / GS), 0, GH - 1)];
  }
  function buildIndices() {
    if (!gl || !ib) return;
    const [i0, j0, i1, j1] = meshBox = visibleBox(), cols = i1 - i0 + 1;
    const idx = new Uint32Array(Math.max(0, j1 - j0) * (cols * 2 + 1)); let n = 0;
    for (let j = j1 - 1; j >= j0; j--) { for (let i = i0; i <= i1; i++) { idx[n++] = j * GW + i; idx[n++] = (j + 1) * GW + i; } idx[n++] = 0xFFFFFFFF; }
    nIdx = n;
    // The draw-in climbs through the elevations the view actually shows (fixed once, so a resize mid-reveal does not jump it).
    if (!sweep.q) sweep.q = sweepTable();
    gl.bindVertexArray(vaoT); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW); gl.bindVertexArray(null);
    stats.mesh = { box: meshBox, tris: n };
  }
  function uploadGridH() {
    const a = new Float32Array(GW * GH * 2);
    for (let k = 0; k < GW * GH; k++) { a[k * 2] = gA[k]; a[k * 2 + 1] = gB[k]; }
    gl.bindBuffer(gl.ARRAY_BUFFER, hBuf); gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
  }

  /* ---------- Roads (OpenStreetMap) and the loop the car drives, in DEM px ---------- */
  const route = { x: null, y: null, cum: null, n: 0, len: 0 };
  let roads = [], roadBox = [0, 0, 1, 1], roadsT = -1;
  const ROAD_STYLE = [null, [1.0, .085], [1.15, .13], [1.45, .18]], ROUTE_STYLE = [1.5, .24];
  function setRoads(data) {
    roads = data.roads.map(r => ({ cls: r[0], pts: Float32Array.from(r.slice(1)) }));
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const r of roads) for (let i = 0; i < r.pts.length; i += 2) { x0 = Math.min(x0, r.pts[i]); x1 = Math.max(x1, r.pts[i]); y0 = Math.min(y0, r.pts[i + 1]); y1 = Math.max(y1, r.pts[i + 1]); }
    roadBox = [x0, y0, x1, y1];
    const R = data.route, n = R.length / 2;
    route.n = n; route.x = new Float32Array(n); route.y = new Float32Array(n); route.cum = new Float32Array(n);
    let len = 0;
    for (let i = 0; i < n; i++) { route.x[i] = R[i * 2]; route.y[i] = R[i * 2 + 1]; if (i) len += Math.hypot(route.x[i] - route.x[i - 1], route.y[i] - route.y[i - 1]); route.cum[i] = len; }
    route.len = len;
    buildPath(); warmTilt();
  }
  // Each polyline is cut into pieces of at most 3 DEM px, so the straight pieces follow the folds of the mesh.
  function buildRoads() {
    if (!gl || glLost) return;
    const pieces = [];
    const add = (pts, w, a) => {
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 3));
        for (let k = 0; k < n; k++) pieces.push(ax + (bx - ax) * k / n, ay + (by - ay) * k / n, ax + (bx - ax) * (k + 1) / n, ay + (by - ay) * (k + 1) / n, w, a);
      }
    };
    for (let c = 1; c <= 3; c++) for (const r of roads) if (r.cls === c) add(r.pts, ROAD_STYLE[c][0], ROAD_STYLE[c][1]);
    const rp = []; for (let i = 0; i < route.n; i++) rp.push(route.x[i], route.y[i]); add(rp, ROUTE_STYLE[0], ROUTE_STYLE[1]);
    const P = pieces.length / 6, v = new Float32Array(P * 4 * 12), idx = (P * 4 > 65535 ? new Uint32Array(P * 6) : new Uint16Array(P * 6));
    const hp = (x, y) => { const m = mixV; mixV = 0; const a = meshH(x, y); mixV = 1; const b = meshH(x, y); mixV = m; return [a, b]; };
    for (let p = 0; p < P; p++) {
      const o = p * 6, ax = pieces[o], ay = pieces[o + 1], bx = pieces[o + 2], by = pieces[o + 3], [ha0, ha1] = hp(ax, ay), [hb0, hb1] = hp(bx, by);
      for (let q = 0; q < 4; q++) {
        const b = (p * 4 + q) * 12;
        v[b] = ax; v[b + 1] = ay; v[b + 2] = ha0; v[b + 3] = ha1;
        v[b + 4] = bx; v[b + 5] = by; v[b + 6] = hb0; v[b + 7] = hb1;
        v[b + 8] = q & 1 ? 1 : -1; v[b + 9] = q >> 1; v[b + 10] = pieces[o + 4]; v[b + 11] = pieces[o + 5];
      }
      const i0 = p * 4, k = p * 6; idx[k] = i0; idx[k + 1] = i0 + 1; idx[k + 2] = i0 + 3; idx[k + 3] = i0; idx[k + 4] = i0 + 3; idx[k + 5] = i0 + 2;
    }
    if (!vaoR) {
      vaoR = gl.createVertexArray(); gl.bindVertexArray(vaoR);
      vaoR.vb = gl.createBuffer(); vaoR.ib = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vaoR.vb);
      [['aA', 0], ['aB', 16], ['aS', 32]].forEach(([n, off]) => { const l = gl.getAttribLocation(progR, n); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 4, gl.FLOAT, false, 48, off); });
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, vaoR.ib);
    } else { gl.bindVertexArray(vaoR); gl.bindBuffer(gl.ARRAY_BUFFER, vaoR.vb); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, vaoR.ib); }
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    nRIdx = P * 6; rIdxType = idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT; roadsOn = true;
  }
  // The car drives the loop rounded at its corners, as a real car would: the route resampled every half pixel and
  // smoothed along the loop. Its trail follows the same path, and its heading is the path's own direction, so every
  // turn is continuous (no snapping at a corner).
  const path = { x: null, y: null, cum: null, n: 0, len: 0 };
  function buildPath() {
    const step = .5, n = Math.max(8, Math.floor(route.len / step)), xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) { routeAt(i * route.len / n, A); xs[i] = A[0]; ys[i] = A[1]; }
    const sig = 2.5 / step, R = Math.ceil(sig * 3), w = new Float64Array(2 * R + 1); let ws = 0;
    for (let k = -R; k <= R; k++) { w[k + R] = Math.exp(-.5 * (k / sig) ** 2); ws += w[k + R]; }
    path.x = new Float32Array(n + 1); path.y = new Float32Array(n + 1); path.cum = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) {
      let ax = 0, ay = 0;
      for (let k = -R; k <= R; k++) { const j = (i + k + n) % n; ax += xs[j] * w[k + R]; ay += ys[j] * w[k + R]; }
      path.x[i] = ax / ws; path.y[i] = ay / ws;
    }
    path.x[n] = path.x[0]; path.y[n] = path.y[0];
    let len = 0; for (let i = 1; i <= n; i++) { len += Math.hypot(path.x[i] - path.x[i - 1], path.y[i] - path.y[i - 1]); path.cum[i] = len; }
    path.n = n + 1; path.len = len;
  }
  const pathAt = (d, out) => {
    d = ((d % path.len) + path.len) % path.len;
    let lo = 0, hi = path.n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (path.cum[m] < d) lo = m + 1; else hi = m; }
    const i = Math.max(1, lo), a = path.cum[i - 1], b = path.cum[i], f = b > a ? (d - a) / (b - a) : 0;
    out[0] = path.x[i - 1] + (path.x[i] - path.x[i - 1]) * f; out[1] = path.y[i - 1] + (path.y[i] - path.y[i - 1]) * f;
  };
  // Fractional sample index on the path at distance d.
  const pathIdx = d => {
    d = ((d % path.len) + path.len) % path.len;
    let lo = 0, hi = path.n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (path.cum[m] < d) lo = m + 1; else hi = m; }
    const i = Math.max(1, lo), a = path.cum[i - 1], b = path.cum[i];
    return i - 1 + (b > a ? (d - a) / (b - a) : 0);
  };
  // The car's pitch and roll come from the ground along its path, smoothed over about a hundred metres of road: it
  // climbs a real hill nose up, but does not rock over every fold of the mesh. Grade (along the road) and cross slope
  // (across it) are in metres per DEM px, one pair per path sample, for the preview mesh and the full one (blended
  // like the terrain), and rebuilt whenever either mesh or the path changes.
  const TILT_SIG = 10, ROLL_SIG = 10, ROLL_W = 3;   // DEM px: smoothing along the road for pitch and roll; half-width across it
  const tilt = { gA: null, gB: null, nA: 0, nB: 0, a: null, b: null };
  function tiltFor(m) {
    const n = path.n - 1, h = new Float64Array(n), c = new Float64Array(n), m0 = mixV;
    mixV = m;
    for (let i = 0; i < n; i++) {
      const p = (i + 1) % n, q = (i - 1 + n) % n;
      let tx = path.x[p] - path.x[q], ty = path.y[p] - path.y[q]; const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
      const x = path.x[i], y = path.y[i];
      h[i] = meshH(x, y);
      // Left of travel in DEM px is (ty, -tx), matching carFrame.
      c[i] = (meshH(x + ty * ROLL_W, y - tx * ROLL_W) - meshH(x - ty * ROLL_W, y + tx * ROLL_W)) / (2 * ROLL_W);
    }
    mixV = m0;
    const ds = path.len / n, blur = (v, sig) => {
      const s = sig / ds, R = Math.ceil(s * 3), w = []; let ws = 0;
      for (let k = -R; k <= R; k++) { w.push(Math.exp(-.5 * (k / s) ** 2)); ws += w[k + R]; }
      const o = new Float64Array(n);
      for (let i = 0; i < n; i++) { let a = 0; for (let k = -R; k <= R; k++) a += v[(i + k + n * 4) % n] * w[k + R]; o[i] = a / ws; }
      return o;
    };
    const hs = blur(h, TILT_SIG), cs = blur(c, ROLL_SIG), out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const p = (i + 1) % n, q = (i - 1 + n) % n;
      out[i * 2] = (hs[p] - hs[q]) / (2 * ds); out[i * 2 + 1] = cs[i];
    }
    return out;
  }
  // Build the tables when the main thread is idle, so the car never arrives on a long frame.
  const warmTilt = () => (window.requestIdleCallback || (f => setTimeout(f, 60)))(() => { if (path.n && gA) slopesAt(0, SL); }, { timeout: 600 });
  function slopesAt(d, out) {
    if (tilt.gA !== gA || tilt.nA !== path.n) { tilt.a = tiltFor(0); tilt.gA = gA; tilt.nA = path.n; }
    if (tilt.gB !== gB || tilt.nB !== path.n) { tilt.b = gB === gA ? tilt.a : tiltFor(1); tilt.gB = gB; tilt.nB = path.n; }
    const n = path.n - 1, fi = pathIdx(d), i = Math.floor(fi) % n, j = (i + 1) % n, f = fi - Math.floor(fi);
    for (let k = 0; k < 2; k++) {
      const a = tilt.a[i * 2 + k] + (tilt.a[j * 2 + k] - tilt.a[i * 2 + k]) * f, b = tilt.b[i * 2 + k] + (tilt.b[j * 2 + k] - tilt.b[i * 2 + k]) * f;
      out[k] = a + (b - a) * mixV;
    }
  }
  const routeAt = (d, out) => {
    d = ((d % route.len) + route.len) % route.len;
    let lo = 0, hi = route.n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (route.cum[m] < d) lo = m + 1; else hi = m; }
    const i = Math.max(1, lo), a = route.cum[i - 1], b = route.cum[i], f = b > a ? (d - a) / (b - a) : 0;
    out[0] = route.x[i - 1] + (route.x[i] - route.x[i - 1]) * f; out[1] = route.y[i - 1] + (route.y[i] - route.y[i - 1]) * f;
  };

  /* ---------- Overlay: labels, the car and its trail, the cursor ring ---------- */
  const SPEED = 10.5;                      // DEM px per second, about 170 m/s: one lap takes about 100 s
  const carS = [0, 0, 0];
  const TRAIL = 150, CAR = new Float32Array(2), A = new Float32Array(2), B = new Float32Array(2), S = [0, 0, 0], S2 = [0, 0, 0], S3 = [0, 0, 0];
  const beam = document.createElement('canvas'); beam.width = 96; beam.height = 48;
  { const g = beam.getContext('2d'), rg = g.createRadialGradient(0, 24, 0, 0, 24, 96); rg.addColorStop(0, 'rgba(255,236,214,.34)'); rg.addColorStop(1, 'rgba(255,236,214,0)'); g.fillStyle = rg; g.beginPath(); g.moveTo(0, 18); g.lineTo(96, 0); g.lineTo(96, 48); g.lineTo(0, 30); g.closePath(); g.fill(); }
  const glow = document.createElement('canvas'); glow.width = glow.height = 64;
  { const g = glow.getContext('2d'), rg = g.createRadialGradient(32, 32, 0, 32, 32, 32); rg.addColorStop(0, 'rgba(255,140,90,.32)'); rg.addColorStop(1, 'rgba(255,140,90,0)'); g.fillStyle = rg; g.fillRect(0, 0, 64, 64); }
  const rrect = (c, x, y, w, h, r) => {
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  };
  // The car lies on the ground: its sprite is mapped through the local perspective (forward and right axes on
  // screen), at a constant on-screen size.
  function drawCar(x, y, fx, fy, rx, ry, a) {
    octx.globalAlpha = a;
    octx.drawImage(glow, x - 22, y - 22, 44, 44);
    octx.save(); octx.transform(fx, fy, rx, ry, x, y);
    octx.drawImage(beam, 7, -12, 46, 24);
    octx.fillStyle = 'rgba(0,0,0,.55)'; octx.beginPath(); rrect(octx, -7.6, -4, 16.2, 9, 3); octx.fill();
    octx.fillStyle = '#efede8'; octx.beginPath(); rrect(octx, -7.5, -3.9, 15, 7.8, 2.8); octx.fill();
    octx.fillStyle = '#26292a';
    octx.beginPath(); rrect(octx, 1.4, -3, 2.9, 6, 1); octx.fill();       // windshield
    octx.beginPath(); rrect(octx, -5.6, -2.8, 1.8, 5.6, .8); octx.fill();  // rear window
    octx.restore();
  }
  const places = (labels || []).map(l => { const p = l.lat == null ? { ...l } : { ...l, ...(([x, y]) => ({ x, y }))(ll2px(l.lat, l.lon)) }; p.a = 0; return p; });
  let fontsOk = !document.fonts, labelsA = 0, carA = 0, carVis = 1, heading = 0, headingInit = false, lensA = 0;
  if (document.fonts) document.fonts.ready.then(() => { fontsOk = true; if (reduce && ready) draw(performance.now(), true); });
  // The car arrives where it used to be 20 s into its drive, which puts it front and centre in the framing.
  const D0 = SPEED * (20 - REVEAL * CAR_IN / 1000);
  let dSeek = 0;                           // debug: jump along the loop
  const carDist = t => dSeek + (reduce ? SPEED * 20 : D0 + (t0 < 0 ? 0 : t - t0) / 1000 * SPEED);

  // The car's pose on the surface, shared by the GL pass (the 3D car and the light it casts) and the overlay (its trail).
  const CAR_PX = 26;                       // car length on screen, CSS px
  const PITCH_K = .9, PITCH_MAX = 26 * DEG, ROLL_K = .12, ROLL_MAX = 2.5 * DEG, SL = [0, 0];
  // Pitch for a drawn slope angle: half strength on gentle rolls (so they barely register), full strength on real
  // climbs, easing toward PITCH_MAX on the steepest.
  const pitchOf = a => PITCH_MAX * Math.tanh(a * PITCH_K * (.45 + .55 * clamp((Math.abs(a) - 4 * DEG) / (14 * DEG), 0, 1)) / PITCH_MAX);
  const car = { ok: false, x: 0, y: 0, h: 0, d: 0, a: 0, Lw: 1, M: new Float32Array(16), up: [0, 0, 1], f: [1, 0, 0], l: [0, 1, 0], o: [0, 0, 0] };
  function updateCar(t, dt) {
    car.ok = false;
    if (route.n < 2) return;
    const age = t0 < 0 ? 0 : t - t0, k = reduce ? 1 : 1 - Math.exp(-dt / .25);
    // The car arrives once the land has settled (and its roads are in), never during the tilt.
    carA += ((roadsT >= 0 && (reduce || age > REVEAL * CAR_IN) ? 1 : 0) - carA) * (reduce ? 1 : 1 - Math.exp(-dt / .45));
    const d = carDist(t);
    pathAt(d, CAR);
    const ch = gl ? meshH(CAR[0], CAR[1]) : 0;
    carVis += ((!gl || visible(CAR[0], CAR[1], ch + 1.5) ? 1 : 0) - carVis) * k;
    pathAt(d + .75, A); pathAt(d - .75, B);
    const target = Math.atan2(A[1] - B[1], A[0] - B[0]);
    if (!headingInit) { heading = target; headingInit = true; }
    let dh = target - heading; dh -= 6.2832 * Math.round(dh / 6.2832); heading += dh * (reduce ? 1 : 1 - Math.exp(-dt / .05));
    car.ok = true; car.x = CAR[0]; car.y = CAR[1]; car.h = ch; car.d = d; car.a = carA * carVis;
    if (gl && carA > .001) carFrame(k);   // nothing to place before it starts to arrive
  }
  // Model matrix: the car sits on the surface, pitched and rolled with the slope under it (smoothed), at a constant
  // size on screen like a map marker.
  function carFrame(k) {
    const e = cam.eye, X = car.x, Y = -car.y, zAt = (x, y) => (meshH(x, y) - H0) * zk, Z = zAt(car.x, car.y);
    const Lw = CAR_PX * 2 * Math.hypot(X - e[0], Y - e[1], Z - e[2]) * Math.tan(pose.fov / 2) / vh;
    const hx = Math.cos(heading), hy = Math.sin(heading), fl = Lw * .5, wl = Lw * .21;
    // Ground under the nose, tail, and both sides. World forward is (hx, -hy); world left is (hy, hx).
    const pf = [X + hx * fl, Y - hy * fl, zAt(car.x + hx * fl, car.y + hy * fl)], pb = [X - hx * fl, Y + hy * fl, zAt(car.x - hx * fl, car.y - hy * fl)];
    const pl = [X + hy * wl, Y + hx * wl, zAt(car.x + hy * wl, car.y - hx * wl)], pr = [X - hy * wl, Y - hx * wl, zAt(car.x - hy * wl, car.y + hx * wl)];
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], nrm = a => { const L = Math.hypot(...a) || 1; return [a[0] / L, a[1] / L, a[2] / L]; };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    // The relief is drawn six times taller than life, so the car follows part of it: a clear nose-up on a real climb,
    // easing toward a limit on the steepest drawn slopes, and just a hint of side-to-side roll.
    slopesAt(car.d, SL);
    const sF = Math.tan(pitchOf(Math.atan(SL[0] * zk))), sL = Math.tan(ROLL_MAX * Math.tanh(Math.atan(SL[1] * zk) * ROLL_K / ROLL_MAX));
    const up = nrm(cross(nrm([hx, -hy, sF]), nrm([hy, hx, sL])));
    car.up = nrm([car.up[0] + (up[0] - car.up[0]) * k, car.up[1] + (up[1] - car.up[1]) * k, car.up[2] + (up[2] - car.up[2]) * k]);
    const u = car.up, f0 = [hx, -hy, sF], fd = f0[0] * u[0] + f0[1] * u[1] + f0[2] * u[2];
    const f = nrm([f0[0] - u[0] * fd, f0[1] - u[1] * fd, f0[2] - u[2] * fd]), l = cross(u, f);
    // Rest on the highest of the five ground points, so no corner sinks into the hillside.
    const zc = Math.max(Z, (pf[2] + pb[2] + pl[2] + pr[2]) / 4) + Lw * .02;
    const sc = Lw / CAR_LEN, M = car.M;
    M.set([f[0] * sc, f[1] * sc, f[2] * sc, 0, l[0] * sc, l[1] * sc, l[2] * sc, 0, u[0] * sc, u[1] * sc, u[2] * sc, 0, X, Y, zc, 1]);
    car.f = f; car.l = l; car.o = [X, Y, zc]; car.Lw = Lw;
  }
  // The car's own 4x multisampled render target (colour and depth) and the texture it resolves into.
  function carTarget(size) {
    if (carRT && carRT.size === size) return carRT;
    if (carRT) { gl.deleteFramebuffer(carRT.ms); gl.deleteFramebuffer(carRT.rs); gl.deleteRenderbuffer(carRT.c); gl.deleteRenderbuffer(carRT.z); gl.deleteTexture(carRT.tex); }
    const n = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0);
    const rb = fmt => { const r = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, r); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, n, fmt, size, size); return r; };
    const c = rb(gl.RGBA8), z = rb(gl.DEPTH_COMPONENT24), ms = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, ms); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, c); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, z);
    const tex = gl.createTexture(); gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const rs = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, rs); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return (carRT = { size, ms, rs, c, z, tex });
  }
  const carVP = new Float32Array(16);
  // A quad in the car's ground frame: centre c ahead of the car, half-length a, half-width b (world units).
  const decalM = new Float32Array(16);
  function decal(c, a, b) {
    const { f, l, up, o } = car;
    decalM.set([f[0] * a, f[1] * a, f[2] * a, 0, l[0] * b, l[1] * b, l[2] * b, 0, up[0], up[1], up[2], 0, o[0] + f[0] * c, o[1] + f[1] * c, o[2] + f[2] * c, 1]);
    return decalM;
  }
  function drawOverlay(t, dt) {
    octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, ov.width, ov.height);
    octx.setTransform(dprOv, 0, 0, dprOv, 0, 0);
    octx.lineCap = 'round'; octx.lineJoin = 'round';
    const age = t0 < 0 ? 0 : t - t0, k = reduce ? 1 : 1 - Math.exp(-dt / .25);
    // Labels arrive once the land has settled (and the web font is in, so they never swap typeface).
    labelsA += ((fontsOk && (reduce || age > REVEAL * .8) ? 1 : 0) - labelsA) * (reduce ? 1 : 1 - Math.exp(-dt / .5));
    if (car.ok) project(car.x, car.y, car.h, carS);
    if (labelsA > .01) for (const l of places) {
      project(l.x, l.y, gl ? meshH(l.x, l.y) : 0, S);
      if (S[2] <= 0 || S[0] < -150 || S[1] < -40 || S[0] > vw + 150 || S[1] > vh + 40) continue;
      // Labels give way to the copy, and to ridges in front of them.
      octx.font = `${l.water ? 'italic ' : ''}400 12px "Schibsted Grotesk", sans-serif`;
      const tw = octx.measureText(l.label || l.name).width, onCopy = hit(S[0] - tw / 2 - 10, S[1]) || hit(S[0] + tw / 2 + 10, S[1]) || hit(S[0] + tw + 10, S[1]);
      // ...and to the car as it drives past (labels sit above the 3D layer).
      const x0 = l.water ? S[0] - tw / 2 : S[0], nearCar = car.ok && car.a > .1 && carS[0] > x0 - 40 && carS[0] < x0 + tw + 40 && Math.abs(carS[1] - S[1]) < 34;
      l.a += ((onCopy || nearCar || (gl && !visible(l.x, l.y, meshH(l.x, l.y) + 4)) ? 0 : 1) - l.a) * k;
      const a = labelsA * l.a; if (a < .01) continue;
      octx.globalAlpha = a;
      if (l.water) {
        // Water labels follow the river's direction on screen, kept upright.
        const ra = (l.rot || 0) * DEG; project(l.x + Math.cos(ra) * 20, l.y + Math.sin(ra) * 20, gl ? meshH(l.x, l.y) : 0, S2);
        let ang = Math.atan2(S2[1] - S[1], S2[0] - S[0]); if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
        octx.save(); octx.translate(S[0], S[1]); octx.rotate(ang);
        octx.font = 'italic 400 12px "Schibsted Grotesk", sans-serif'; octx.textAlign = 'center'; octx.textBaseline = 'middle';
        octx.fillStyle = 'rgba(170,184,190,.6)'; octx.fillText(l.name, 0, 0);
        octx.restore();
      } else {
        octx.fillStyle = 'rgba(236,234,229,.6)';
        octx.beginPath(); octx.arc(S[0], S[1], 2, 0, 6.2832); octx.fill();
        octx.font = '400 12px "Schibsted Grotesk", sans-serif'; octx.textAlign = 'left'; octx.textBaseline = 'middle';
        octx.fillStyle = 'rgba(236,234,229,.55)';
        const txt = l.label || l.name, tw = octx.measureText(txt).width;
        if (S[0] + 9 + tw > vw - 12) { octx.textAlign = 'right'; octx.fillText(txt, S[0] - 9, S[1]); } else octx.fillText(txt, S[0] + 9, S[1]);
      }
    }
    octx.globalAlpha = 1;
    // The drive's trail (the 3D car itself is drawn in the GL pass; the flat fallback draws a sprite here).
    if (car.ok && car.a > .01) {
      const a = car.a, d = car.d, end = d - (gl ? car.Lw * .46 : 0);
      // Opacity follows a continuous curve along the trail. Pieces are grouped only while the 8-bit alpha is
      // unchanged, and use flat caps so neighbouring pieces never overlap into a seam.
      octx.lineWidth = 1.8; octx.lineCap = 'butt';
      let lvl = -1, lx = 0, ly = 0, first = true;
      for (let q = d - TRAIL; ; q += 1) {
        const last = q >= end; if (last) q = end;
        pathAt(q, A); project(A[0], A[1], gl ? meshH(A[0], A[1]) + .5 : 0, S);
        if (first) { lx = S[0]; ly = S[1]; first = false; if (!last) continue; }
        const al = Math.round(217 * a * Math.pow(1 - (d - q) / TRAIL, 1.6));   // 217/255 = 0.85 at the car
        if (al !== lvl) { if (lvl > 0) octx.stroke(); lvl = al; octx.beginPath(); octx.moveTo(lx, ly); octx.strokeStyle = `rgba(255,122,69,${(al / 255).toFixed(4)})`; }
        octx.lineTo(S[0], S[1]); lx = S[0]; ly = S[1];
        if (last) break;
      }
      if (lvl > 0) octx.stroke();
      octx.lineCap = 'round';
      if (!gl) {
        const hx = Math.cos(heading), hy = Math.sin(heading);
        project(car.x, car.y, 0, S); project(car.x + hx, car.y + hy, 0, S2); project(car.x - hy, car.y + hx, 0, S3);
        let fx = S2[0] - S[0], fy = S2[1] - S[1], rx = S3[0] - S[0], ry = S3[1] - S[1];
        const sc = 1 / Math.max(1e-6, Math.max(Math.hypot(fx, fy), Math.hypot(rx, ry)));
        drawCar(S[0], S[1], fx * sc, fy * sc, rx * sc, ry * sc, a);
      }
      octx.globalAlpha = 1;
    }
    // Cursor ring
    if (mouse.in && lensA > .05) {
      octx.globalAlpha = .6 * lensA;
      octx.beginPath(); octx.arc(mouse.x, mouse.y, 5, 0, 6.2832); octx.strokeStyle = 'rgba(255,122,69,1)'; octx.lineWidth = 1; octx.stroke();
      octx.globalAlpha = 1;
    }
  }

  /* ---------- CPU fallback (no WebGL2): a flat contour map, traced once and panned per frame ---------- */
  let fctx = null, fbMap = null, rcv = null;
  const FBK = 1.5, fv = { x: 1060, y: 700, s: 1 };
  function buildFallback() {
    const n = EW * EH, tmp = new Float32Array(n), sm = new Float32Array(n);
    for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++) { const i = y * EW + x; tmp[i] = ((x > 0 ? elev[i - 1] : elev[i]) + 2 * elev[i] + (x < EW - 1 ? elev[i + 1] : elev[i])) * .25; }
    for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++) { const i = y * EW + x; sm[i] = ((y > 0 ? tmp[i - EW] : tmp[i]) + 2 * tmp[i] + (y < EH - 1 ? tmp[i + EW] : tmp[i])) * .25; }
    const img = new ImageData(EW, EH), d = img.data, lx = -.6, ly = -.7, lz = .8, ll = Math.hypot(lx, ly, lz);
    for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++) {
      const i = y * EW + x, q = i * 4;
      if (water[i]) { d[q] = 8; d[q + 1] = 11; d[q + 2] = 12; d[q + 3] = 255; continue; }
      const gx = (sm[x < EW - 1 ? i + 1 : i] - sm[x > 0 ? i - 1 : i]) / (2 * DEM.mpp) * 2.4, gy = (sm[y < EH - 1 ? i + EW : i] - sm[y > 0 ? i - EW : i]) / (2 * DEM.mpp) * 2.4;
      const sh = (-gx * lx - gy * ly + lz) / (Math.hypot(gx, gy, 1) * ll) - lz / ll, v = 1 + 1.05 * sh;
      d[q] = 12 * v; d[q + 1] = 12.8 * v; d[q + 2] = 12.8 * v; d[q + 3] = 255;
    }
    const baseC = document.createElement('canvas'); baseC.width = EW; baseC.height = EH; baseC.getContext('2d').putImageData(img, 0, 0);
    const off = document.createElement('canvas'); off.width = Math.round(EW * FBK); off.height = Math.round(EH * FBK);
    const o = off.getContext('2d'); o.imageSmoothingEnabled = true; o.drawImage(baseC, 0, 0, off.width, off.height);
    const minor = new Path2D(), major = new Path2D();
    const seg = (P, x0, y0, x1, y1) => { P.moveTo(x0, y0); P.lineTo(x1, y1); };
    for (let y = 0; y < EH - 1; y++) for (let x = 0; x < EW - 1; x++) {
      const i = y * EW + x, a = sm[i], b = sm[i + 1], c = sm[i + EW + 1], e = sm[i + EW];
      if (water[i]) continue;
      const mn = Math.min(a, b, c, e), mx = Math.max(a, b, c, e);
      for (let L = Math.floor(mn / MINOR) * MINOR + MINOR; L < mx; L += MINOR) {
        const A = a > L, B = b > L, C = c > L, E = e > L;
        const tX = x + (L - a) / (b - a), rY = y + (L - b) / (c - b), bX = x + (L - e) / (c - e), lY = y + (L - a) / (e - a);
        const top = A !== B, right = B !== C, bottom = E !== C, left = A !== E, P = L % MAJOR === 0 ? major : minor;
        if (top && right && bottom && left) {
          if (A === ((a + b + c + e) / 4 > L)) { seg(P, tX, y, x + 1, rY); seg(P, bX, y + 1, x, lY); }
          else { seg(P, tX, y, x, lY); seg(P, x + 1, rY, bX, y + 1); }
        } else {
          let x0 = 0, y0 = 0, k = 0;
          const add = (px, py) => { if (k++ === 0) { x0 = px; y0 = py; } else seg(P, x0, y0, px, py); };
          if (top) add(tX, y); if (right) add(x + 1, rY); if (bottom) add(bX, y + 1); if (left) add(x, lY);
        }
      }
    }
    o.setTransform(FBK, 0, 0, FBK, FBK * .5, FBK * .5); o.lineCap = 'round';
    o.strokeStyle = 'rgba(236,234,229,0.14)'; o.lineWidth = .5; o.stroke(minor);
    o.strokeStyle = 'rgba(236,234,229,0.32)'; o.lineWidth = .8; o.stroke(major);
    return off;
  }
  function frameFallback() {
    const cx = (LOOP.x0 + LOOP.x1) / 2, cy = (LOOP.y0 + LOOP.y1) / 2, lw = LOOP.x1 - LOOP.x0 + 40, lh = LOOP.y1 - LOOP.y0 + 40;
    let s = portrait ? Math.max(vw / 560, Math.min(vh * .5 / lh, vw * .88 / lw)) : Math.min(Math.max(vw / 880, vh / 560), (vh - 190) / lh);
    s = Math.max(s, .05, vw / (EW - 8), vh / (EH - 8));
    fv.s = s; fv.x = portrait ? cx : cx - .27 * vw / s; fv.y = portrait ? cy + .21 * vh / s : cy + 6 / s;
    fv.x = clamp(fv.x, vw / (2 * s), EW - vw / (2 * s)); fv.y = clamp(fv.y, vh / (2 * s), EH - vh / (2 * s) + (portrait ? .5 * vh / s : 0));
  }
  function drawFallback() {
    const k = fv.s * dpr / FBK;
    fctx.setTransform(1, 0, 0, 1, 0, 0); fctx.fillStyle = '#0b0c0c'; fctx.fillRect(0, 0, cv.width, cv.height);
    fctx.globalAlpha = fadeV; fctx.imageSmoothingEnabled = true;
    fctx.setTransform(k, 0, 0, k, (vw / 2 - fv.x * fv.s) * dpr, (vh / 2 - fv.y * fv.s) * dpr);
    fctx.drawImage(fbMap, 0, 0); fctx.globalAlpha = 1;
    const r = rcv.getContext('2d'), sx = x => (x - fv.x) * fv.s + vw / 2, sy = y => (y - fv.y) * fv.s + vh / 2;
    r.setTransform(1, 0, 0, 1, 0, 0); r.clearRect(0, 0, rcv.width, rcv.height); r.setTransform(dprOv, 0, 0, dprOv, 0, 0);
    r.globalAlpha = fadeV; r.lineCap = 'round'; r.lineJoin = 'round';
    for (let c = 1; c <= 3; c++) {
      r.beginPath();
      for (const rd of roads) { if (rd.cls !== c) continue; const p = rd.pts; r.moveTo(sx(p[0]), sy(p[1])); for (let i = 2; i < p.length; i += 2) r.lineTo(sx(p[i]), sy(p[i + 1])); }
      r.strokeStyle = `rgba(236,234,229,${ROAD_STYLE[c][1] * .85})`; r.lineWidth = ROAD_STYLE[c][0] * .9; r.stroke();
    }
    if (route.n > 1) { r.beginPath(); r.moveTo(sx(route.x[0]), sy(route.y[0])); for (let i = 1; i < route.n; i++) r.lineTo(sx(route.x[i]), sy(route.y[i])); r.strokeStyle = 'rgba(236,234,229,.2)'; r.lineWidth = 1.4; r.stroke(); }
  }

  /* ---------- Frame ---------- */
  let raf = 0, visibleHero = true, lastRead = 0, slow = 0, lastDt = 0, fadeV = 0, ready = false;
  let touch = false, readShown = '';
  let sized = '';
  function resize() {
    const r = hero.getBoundingClientRect();
    // Phones fire resize as the URL bar slides during a scroll; the hero (100svh) does not change, so skip the work.
    const key = `${r.width}x${r.height}@${devicePixelRatio}/${dprCap}`;
    if (key === sized) return;
    sized = key; vw = r.width; vh = r.height;
    dpr = Math.min(devicePixelRatio || 1, dprCap); dprOv = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr);
    ov.width = Math.round(vw * dprOv); ov.height = Math.round(vh * dprOv);
    if (rcv) { rcv.width = ov.width; rcv.height = ov.height; }
    layout();
    if (fbMap) frameFallback();
    if (ready) draw(performance.now(), true);
  }
  function drawGL(t) {
    const age = t0 < 0 ? 0 : t - t0;
    fadeV = reduce ? 1 : smoother(age / 700);
    gl.viewport(0, 0, cv.width, cv.height);
    gl.depthMask(true);   // before the clear, which skips depth while writes are off (the previous frame ends with them off)
    gl.clearColor(.043, .047, .047, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.BLEND);
    gl.useProgram(progT); gl.bindVertexArray(vaoT);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texA); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texB);
    gl.uniform1i(UT.uDemA, 0); gl.uniform1i(UT.uDemB, 1); gl.uniform1i(UT.uGW, GW);
    gl.uniformMatrix4fv(UT.uVP, false, cam.VP); gl.uniform1f(UT.uZk, zk); gl.uniform1f(UT.uMix, mixV);
    gl.uniform2f(UT.uSize, GW * GS, GH * GS); gl.uniform2f(UT.uRes, cv.width, cv.height);
    gl.uniform4f(UT.uLens, mouse.x * dpr, (vh - mouse.y) * dpr, 170 * dpr, lensA);
    gl.uniform1f(UT.uDpr, dpr); gl.uniform1f(UT.uFade, fadeV); gl.uniform1f(UT.uShade, pose.shade / DEM.mpp);
    // The draw-in level: starting with the valleys already drawn and easing out as the view settles.
    const sp = reduce ? 2 : (age - SWEEP[0]) / (SWEEP[1] - SWEEP[0]), se = clamp(sp, 0, 1);
    if (sp < 1 && sweep.q) {
      const q = sweep.q, e = (.2 + .8 * (1 - (1 - se) * (1 - se))) * (q.length - 1), i = Math.min(q.length - 2, e | 0);
      gl.uniform4f(UT.uSweep, lerp(q[i], q[i + 1], e - i), 30, 1 - smoother((sp - .75) / .25), 1);
    } else gl.uniform4f(UT.uSweep, 0, 1, 0, 0);
    gl.uniform3f(UT.uEye, cam.eye[0], cam.eye[1], cam.eye[2]); gl.uniform2f(UT.uFog, cam.D * pose.fog0, cam.D * pose.fog1); gl.uniform2f(UT.uMinorFar, cam.D * pose.mf0, cam.D * pose.mf1); gl.uniform1f(UT.uHaze, pose.haze);
    // The sun sits behind the viewer's left at the resting view, so the slopes the camera sees are side-lit.
    { const a = pose.psi + pose.sun * DEG, el = pose.sunEl * DEG; gl.uniform3f(UT.uLight, Math.sin(a) * Math.cos(el), -Math.cos(a) * Math.cos(el), Math.sin(el)); }
    gl.drawElements(gl.TRIANGLE_STRIP, nIdx, gl.UNSIGNED_INT, 0);
    if (roadsOn) {
      const ra = reduce ? 1 : smoother((t - roadsT) / 900) * smoother((age - 300) / 900);
      gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(progR); gl.bindVertexArray(vaoR);
      gl.uniformMatrix4fv(UR.uVP, false, cam.VP); gl.uniform1f(UR.uZk, zk); gl.uniform1f(UR.uMix, mixV);
      gl.uniform1f(UR.uDpr, dpr); gl.uniform2f(UR.uRes, cv.width, cv.height); gl.uniform1f(UR.uFade, fadeV * ra);
      gl.uniform4f(UR.uBox, roadBox[0], roadBox[1], roadBox[2], roadBox[3]);
      gl.drawElements(gl.TRIANGLES, nRIdx, rIdxType, 0);
    }
    if (car.ok && car.a * fadeV > .005 && vaoC) {
      const ca = car.a * fadeV, Lw = car.Lw;
      // Light and shade on the ground first (no depth test: they lie on the surface under the car).
      gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.enable(gl.BLEND);
      gl.useProgram(progD); gl.bindVertexArray(vaoD);
      gl.uniformMatrix4fv(UD.uVP, false, cam.VP); gl.uniform1f(UD.uAlpha, ca);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1i(UD.uKind, 1); gl.uniformMatrix4fv(UD.uM, false, decal(0, Lw * 1.5, Lw * 1.5)); gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.uniform1i(UD.uKind, 2); gl.uniformMatrix4fv(UD.uM, false, decal(Lw * 1.6, Lw * 1.1, Lw * .9)); gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1i(UD.uKind, 0); gl.uniformMatrix4fv(UD.uM, false, decal(0, Lw * .62, Lw * .34)); gl.drawArrays(gl.TRIANGLES, 0, 6);
      // The car, depth-tested only against itself (so it never clips into the hillside it sits on), drawn into a
      // small multisampled square around it, then laid over the frame with its fade.
      const [px, py, w] = project(car.x, car.y, car.h, S);
      if (w > 0) {
        const size = Math.ceil(CAR_PX * 2.6 * dpr / 8) * 8, W = cv.width, H = cv.height;
        const cx = Math.round(px * dpr), cy = Math.round(H - py * dpr);     // centre, GL device px
        const rt = carTarget(size);
        // Map that square of the screen onto the whole target: clip' = T * clip.
        const sx = W / size, sy = H / size, tx = (W - 2 * cx) / size, ty = (H - 2 * cy) / size, m = cam.VP;
        for (let c = 0; c < 4; c++) { carVP[c * 4] = m[c * 4] * sx + m[c * 4 + 3] * tx; carVP[c * 4 + 1] = m[c * 4 + 1] * sy + m[c * 4 + 3] * ty; carVP[c * 4 + 2] = m[c * 4 + 2]; carVP[c * 4 + 3] = m[c * 4 + 3]; }
        gl.bindFramebuffer(gl.FRAMEBUFFER, rt.ms); gl.viewport(0, 0, size, size);
        // Depth writes must be on before the clear: gl.clear leaves depth untouched while depthMask is false (as the
        // decal pass leaves it), and the car would then be tested against its own previous frame.
        gl.depthMask(true); gl.colorMask(true, true, true, true);
        gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.disable(gl.BLEND);
        gl.useProgram(progC); gl.bindVertexArray(vaoC);
        gl.uniformMatrix4fv(UC.uVP, false, carVP); gl.uniformMatrix4fv(UC.uM, false, car.M);
        { const a = pose.psi + pose.sun * DEG, el = pose.sunEl * DEG; gl.uniform3f(UC.uLight, Math.sin(a) * Math.cos(el), -Math.cos(a) * Math.cos(el), Math.sin(el)); }
        gl.uniform3f(UC.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);
        gl.drawArrays(gl.TRIANGLES, 0, nCar);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rt.ms); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, rt.rs);
        gl.blitFramebuffer(0, 0, size, size, 0, 0, size, size, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.clearColor(.043, .047, .047, 1);
        gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(progQ); gl.bindVertexArray(vaoD);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, rt.tex); gl.uniform1i(UQ.uTex, 2);
        gl.uniform4f(UQ.uRect, cx / W * 2 - 1, cy / H * 2 - 1, size / W, size / H); gl.uniform1f(UQ.uAlpha, ca);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }
    gl.bindVertexArray(null);
  }
  let mixT = -1;
  function draw(t, once) {
    const dt = lastDt || 1 / 60;
    if (!reduce && t0 >= 0 && mixT >= 0) mixV = smoother((t - mixT) / 900);
    lensA += ((mouse.in ? 1 : 0) - lensA) * (reduce ? 1 : 1 - Math.exp(-dt / .23));
    if (gl) {
      updateCamera(t);
      updateCar(t, dt);
      if (!glLost) drawGL(t);
      stats.frames++;
    } else if (fbMap) {
      fadeV = reduce ? 1 : Math.min(1, fadeV + dt / .7);
      updateCar(t, dt);
      drawFallback(); stats.frames++;
    }
    drawOverlay(t, dt);
    if (onReadout && (once || t - lastRead > 200)) { lastRead = t; readout(t); }
  }
  // One line of live data under the hero: the car's position and elevation, or the point under the cursor.
  function readout(t) {
    let r = null;
    if (mouse.in && lensA > .3) {
      const p = gl ? pick(mouse.x, mouse.y) : [fv.x + (mouse.x - vw / 2) / fv.s, fv.y + (mouse.y - vh / 2) / fv.s];
      if (p && p[0] >= 0 && p[1] >= 0 && p[0] < EW && p[1] < EH) { const [lat, lon] = px2ll(p[0], p[1]); r = { kind: 'cursor', lat, lon, m: sampleElev(p[0], p[1]), water: isWater(p[0], p[1]) }; }
    }
    if (!r && route.n > 1 && carA > .5) { pathAt(carDist(t), A); const [lat, lon] = px2ll(A[0], A[1]); r = { kind: 'car', lat, lon, m: sampleElev(A[0], A[1]) }; }
    const key = r ? `${r.kind}${r.lat.toFixed(4)}${r.lon.toFixed(4)}${Math.round(r.m)}` : '';
    if (key !== readShown) { readShown = key; onReadout(r); }
  }
  // Frame pacing. Terrain, roads, car and overlay are always drawn together, on the same frame. On a high-refresh
  // screen (120 to 300 Hz) the hero draws on every n-th refresh, about 60 to 90 fps and evenly spaced, instead of
  // asking the GPU for every refresh and getting uneven frames. The screen's refresh period is the shortest steady
  // interval between animation frames, measured once at start. A device that still cannot keep up drops to 1x
  // resolution, then to half rate.
  let tick = 0, every = 1, slowEvery = 1, lastDraw = 0, refreshMs = 1000 / 60;
  (function probe() {
    const ds = []; let last = 0;
    const f = t => {
      if (last) ds.push(t - last);
      last = t;
      if (ds.length < 30) { requestAnimationFrame(f); return; }
      ds.sort((a, b) => a - b);
      refreshMs = Math.max(2, ds[Math.floor(ds.length * .2)]);
      every = Math.max(1, Math.floor(1000 / refreshMs / 60 + .08));
      stats.refreshHz = Math.round(1000 / refreshMs); stats.every = every;
    };
    requestAnimationFrame(f);
  })();
  function loop(t) {
    raf = (!reduce && visibleHero && !document.hidden) ? requestAnimationFrame(loop) : 0;
    if (t0 < 0) t0 = t;
    if (tick++ % (every * slowEvery)) return;
    lastDt = lastDraw ? clamp((t - lastDraw) / 1000, .001, .1) : 1 / 60;
    if (lastDraw) {
      const late = t - lastDraw > Math.max(26, 1.7 * every * slowEvery * refreshMs);
      slow = late ? slow + 1 : Math.max(0, slow - 1);
      if (slow > 90) { slow = 0; if (dprCap > 1) { dprCap = 1; resize(); } else if (slowEvery === 1) slowEvery = 2; }
    }
    lastDraw = t;
    draw(t, false);
  }
  function start() { if (ready && !raf && !reduce && visibleHero && !document.hidden) { lastDraw = 0; raf = requestAnimationFrame(loop); } }
  addEventListener('scroll', () => { scrollP = clamp(scrollY / Math.max(1, vh), 0, 1); }, { passive: true });
  new IntersectionObserver(([e]) => { visibleHero = e.isIntersecting; start(); }).observe(hero);
  document.addEventListener('visibilitychange', start);
  let tapTimer = 0;
  const setPointer = e => { clearTimeout(tapTimer); touch = e.pointerType !== 'mouse'; const r = hero.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.in = true; if (reduce && ready) draw(performance.now(), true); };
  hero.addEventListener('pointermove', setPointer);
  hero.addEventListener('pointerdown', setPointer);
  const clearPointer = () => { mouse.in = false; if (reduce && ready) draw(performance.now(), true); };
  hero.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') clearPointer(); });
  hero.addEventListener('pointercancel', clearPointer);
  hero.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') { clearTimeout(tapTimer); tapTimer = setTimeout(clearPointer, 2500); } });
  addEventListener('resize', resize);

  /* ---------- Load ---------- */
  // 3 x 3 binomial blur over the vertex grid (about 1.4 DEM px of smoothing).
  function smoothGrid(h) {
    const t = new Float32Array(GW * GH), o = new Float32Array(GW * GH);
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) { const k = j * GW + i; t[k] = (h[i > 0 ? k - 1 : k] + 2 * h[k] + h[i < GW - 1 ? k + 1 : k]) / 4; }
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) { const k = j * GW + i; o[k] = (t[j > 0 ? k - GW : k] + 2 * t[k] + t[j < GH - 1 ? k + GW : k]) / 4; }
    return o;
  }
  function setGridFromPreview(p) {
    GW = p.w * PK / GS; GH = p.h * PK / GS;
    // Readouts and the probe need the full size even before the full file arrives.
    EW = p.w * PK; EH = p.h * PK;
    const a = new Float32Array(GW * GH);
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      // Bilinear from the preview, whose texel centres sit at (u + 0.5) * PK.
      const u = clamp((i * GS + GS / 2) / PK - .5, 0, p.w - 1.001), v = clamp((j * GS + GS / 2) / PK - .5, 0, p.h - 1.001);
      const iu = u | 0, iv = v | 0, fu = u - iu, fv2 = v - iv, k = iv * p.w + iu;
      a[j * GW + i] = (p.elev[k] * (1 - fu) + p.elev[k + 1] * fu) * (1 - fv2) + (p.elev[k + p.w] * (1 - fu) + p.elev[k + p.w + 1] * fu) * fv2;
    }
    gA = smoothGrid(a); gB = gA;
  }
  function setGridFromFull(f) {
    const b = new Float32Array(GW * GH);
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      // Bilinear value at the vertex: the mean of the 2 x 2 texels around it.
      const x = Math.min(f.w - 2, i * GS + GS / 2 - 1), y = Math.min(f.h - 2, j * GS + GS / 2 - 1), k = y * f.w + x;
      b[j * GW + i] = (f.elev[k] + f.elev[k + 1] + f.elev[k + f.w] + f.elev[k + f.w + 1]) / 4;
    }
    gB = smoothGrid(b);
  }
  async function load() {
    // The preview (a small script loaded with the page) draws the first frame. The full elevation file and the roads
    // only start downloading after that, so on a slow connection they never compete with it.
    await nextFrame();          // let the text paint before any GPU setup
    resize();
    createGL();
    if (gl && window.TerrainPreview) {
      const bin = atob(window.TerrainPreview.webp), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      pre = await decodeDem(new Blob([u8], { type: 'image/webp' }));
      setGridFromPreview(pre);
      snapPeaks();
      layout();
      setupGL();
      ready = true; cv.classList.add('on'); stats.ready = true;
      stats.firstFrameMs = Math.round(performance.now());
      if (reduce) draw(performance.now(), true); else start();
      await nextFrame();
    }
    const roadsP = loadScript(ROADS.url, 'TerrainRoads').catch(err => { console.error('Roads failed to load', err); return null; });
    const fullP = (location.protocol === 'file:' ? Promise.reject(new Error('file://: full elevation needs a server')) : fetchOk(DEM.url)).then(r => r.blob()).then(decodeDem);
    fullP.catch(() => {});
    roadsP.then(data => {
      if (!data) return;
      setRoads(data);
      if (gl && gA) buildRoads();   // without the preview, the grid (and so the road heights) comes with the full file
      roadsT = performance.now();
      if (reduce && ready) draw(performance.now(), true);
    });
    let full;
    try { full = await fullP; } catch (err) {
      // From file:// (or offline) the full file cannot load: the preview stays, which is still the whole scene.
      if (gl && ready) { console.warn('Full elevation unavailable; staying on the preview.', err); return; }
      throw err;
    }
    EW = full.w; EH = full.h; elev = full.elev; water = full.water;
    await yieldTask();
    if (gl) {
      if (!pre) {
        // No preview script: build the grid from the full data and start now.
        const w = Math.floor(EW / PK), h = Math.floor(EH / PK), e = new Float32Array(w * h), wa = new Uint8Array(w * h);
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const k = (j * PK + PK / 2) * EW + i * PK + PK / 2; e[j * w + i] = elev[k]; wa[j * w + i] = water[k]; }
        pre = { w, h, elev: e, water: wa }; setGridFromPreview(pre); EW = full.w; EH = full.h; snapPeaks(); layout(); setupGL();
        ready = true; cv.classList.add('on'); stats.ready = true; if (reduce) draw(performance.now(), true); else start();
      }
      setGridFromFull(full); warmTilt();
      if (!glLost) { texB = makeTex(EW, EH, elev, water); gl.bindVertexArray(null); uploadGridH(); }
      if (roads.length) buildRoads();
      mixT = performance.now(); if (reduce) { mixV = 1; draw(performance.now(), true); }
    } else {
      // CPU fallback: a flat map, traced once.
      rcv = document.createElement('canvas'); rcv.setAttribute('aria-hidden', 'true'); rcv.className = 'roads';
      ov.parentNode.insertBefore(rcv, ov); rcv.width = ov.width; rcv.height = ov.height;
      fbMap = buildFallback(); frameFallback();
      ready = true; cv.classList.add('on'); stats.ready = true;
      if (reduce) draw(performance.now(), true); else start();
    }
    stats.full = true;
    snapPeaks();
    if (reduce && ready) draw(performance.now(), true);
  }
  // Snap peak labels to the highest point near where they were placed, and show its elevation (from the preview
  // until the full data arrives).
  function snapPeaks() {
    for (const l of places) if (l.peak) {
      if (l.x0 === undefined) { l.x0 = l.x; l.y0 = l.y; }
      let bx = l.x0, by = l.y0, be = -1e9;
      for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) { const e = sampleElev(l.x0 + dx, l.y0 + dy); if (e > be) { be = e; bx = l.x0 + dx; by = l.y0 + dy; } }
      l.x = bx; l.y = by; l.label = `${l.name}  ${Math.round(be)} m`;
    }
  }
  load().catch(err => {
    // Without elevation data the hero stays a quiet dark field; the rest of the page is unaffected.
    console.error('Terrain failed to load', err);
    stats.error = String(err && err.message || err);
  });
  return { stats, cam, pose, route, sampleElev: (x, y) => sampleElev(x, y), ll2px, px2ll, pick, meshH, project: (x, y) => project(x, y, meshH(x, y), [0, 0, 0]),
    // Debug: put the camera at the resting pose (no drift, pointer or scroll), for checking the composition.
    carState: () => ({ a: car.a, d: car.d, h: heading, up: car.up.slice(), f: car.f.slice(), l: car.l.slice() }),
    // Debug: the car's pitch and roll (degrees) every DEM px around the loop, at the current relief.
    tiltProfile: () => { const o = []; for (let d = 0; d < path.len; d++) { slopesAt(d, SL); o.push([d, pitchOf(Math.atan(SL[0] * zk)) / DEG, ROLL_MAX * Math.tanh(Math.atan(SL[1] * zk) * ROLL_K / ROLL_MAX) / DEG]); } return o; },
    seekCar: d => { dSeek += d - car.d; },
    carScreen: () => car.ok ? project(car.x, car.y, car.h, [0, 0, 0]).slice(0, 2).map(Math.round) : null,
    rest: () => { zk = pose.ex / DEM.mpp; setCamera(pose.tx, pose.ty, (meshH(pose.tx, pose.ty) - H0) * zk, pose.psi, pose.theta, pose.D, pose.fov, pose.sx, pose.sy); } };
}

window.Terrain = { init };
})();
