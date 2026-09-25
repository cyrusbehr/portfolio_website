// Hero terrain: real west Austin elevation (USGS via AWS Terrain Tiles), contoured live on the GPU,
// with OpenStreetMap roads and a car looping along real streets. Falls back to a CPU-traced contour
// image when WebGL is unavailable, and survives a lost GPU context.
(function () {
'use strict';

// DEM: z13 Web Mercator mosaic in Terrarium encoding (lossless WebP), top-left at tile (tx0, ty0).
const DEM = { url: 'assets/data/austin-dem.v1.webp', z: 13, tx0: 1866.46875, ty0: 3369.0, mpp: 16.494 };
const ROADS = { url: 'assets/data/austin-roads.v1.json' };
const TILES = 2 ** DEM.z;
const MINOR = 20, MAJOR = 100;               // contour interval and index interval, meters
const ll2px = (lat, lon) => {
  const tx = (lon + 180) / 360 * TILES, lr = lat * Math.PI / 180;
  const ty = (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * TILES;
  return [(tx - DEM.tx0) * 256, (ty - DEM.ty0) * 256];
};
const px2ll = (x, y) => {
  const tx = DEM.tx0 + x / 256, ty = DEM.ty0 + y / 256;
  return [Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / TILES))) * 180 / Math.PI, tx / TILES * 360 - 180];
};

const VS = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0., 1.); }`;
const FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uDem;   // RG32F: elevation (m), water (0 or 1)
uniform vec2 uRes;        // drawing buffer size, device px
uniform vec3 uView;       // map center x, y (DEM px), scale (device px per DEM px)
uniform vec4 uLens;       // cursor x, y (device px, GL origin), radius (device px), strength
uniform float uDpr, uMpp, uFade;
out vec4 o;

// Cubic B-spline reconstruction (16 taps) with an analytic gradient, so isolines stay smooth
// and evenly weighted on steep bluffs.
struct D { vec2 v; vec2 dx; vec2 dy; };
D dem(vec2 p) {
  ivec2 hi = textureSize(uDem, 0) - 1;
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
    vec2 t0 = texelFetch(uDem, ivec2(clamp(b.x, 0, hi.x), yy), 0).rg;
    vec2 t1 = texelFetch(uDem, ivec2(clamp(b.x + 1, 0, hi.x), yy), 0).rg;
    vec2 t2 = texelFetch(uDem, ivec2(clamp(b.x + 2, 0, hi.x), yy), 0).rg;
    vec2 t3 = texelFetch(uDem, ivec2(clamp(b.x + 3, 0, hi.x), yy), 0).rg;
    vec2 rv = wx.x * t0 + wx.y * t1 + wx.z * t2 + wx.w * t3;
    vec2 rd = dx.x * t0 + dx.y * t1 + dx.z * t2 + dx.w * t3;
    r.v += wy[j] * rv; r.dx += wy[j] * rd; r.dy += dy[j] * rv;
  }
  return r;
}
// Anti-aliased isoline coverage from an analytic gradient ('gpx' = value change per device px).
float iso(float v, float gpx, float step, float w0, float w1, out float spacing) {
  float gn = max(gpx / step, 1e-5);
  spacing = 1. / gn;
  float d = abs(fract(v / step + .5) - .5) / gn;
  return 1. - smoothstep(w0, w1, d);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = vec2(uView.x + (fc.x - .5 * uRes.x) / uView.z, uView.y - (fc.y - .5 * uRes.y) / uView.z);
  vec2 sz = vec2(textureSize(uDem, 0));
  D d = dem(p);
  float h = d.v.x, w = clamp(d.v.y, 0., 1.);
  vec2 gh = vec2(d.dx.x, d.dy.x);
  float ghPx = length(gh) / uView.z;
  float gwPx = length(vec2(d.dx.y, d.dy.y)) / uView.z;

  // Quiet hillshade, light from the northwest.
  vec3 n = normalize(vec3(-gh / uMpp * 2.4, 1.));
  vec3 Ld = normalize(vec3(-.6, -.7, .8));
  float shade = dot(n, Ld) - Ld.z;
  vec3 col = vec3(.047, .050, .050) * (1. + 1.05 * shade);

  // Soft spotlight around the cursor lifts the contours nearby.
  float lensD = length(fc - uLens.xy);
  float lens = uLens.w * (1. - smoothstep(0., uLens.z, lensD));

  // Contours: minor and index. Lines fade out where they would crowd closer than a few pixels.
  float spA, spB;
  float minor = iso(h, ghPx, ${MINOR}., .30 * uDpr, .95 * uDpr, spA) * smoothstep(3. * uDpr, 7. * uDpr, spA);
  float major = iso(h, ghPx, ${MAJOR}., .45 * uDpr, 1.25 * uDpr, spB) * smoothstep(3. * uDpr, 7. * uDpr, spB);
  float land = 1. - smoothstep(.3, .7, w);
  vec3 ink = vec3(.925, .918, .898), warm = vec3(1., .55, .32);
  col = mix(col, mix(ink, warm, lens * .35), minor * (.13 + .22 * lens) * land);
  col = mix(col, mix(ink, warm, lens * .45), major * (.30 + .25 * lens) * land);

  // Water: a flat, slightly cooler surface with a fine shoreline.
  float wm = smoothstep(.3, .7, w);
  col = mix(col, vec3(.032, .042, .048), wm);
  float shore = 1. - smoothstep(.4 * uDpr, 1.2 * uDpr, abs(w - .5) / max(gwPx, 1e-4));
  col = mix(col, vec3(.58, .65, .68), shore * .30);

  // Vignette, fade at the data edge, dither against banding.
  vec2 q = fc / uRes - .5;
  col *= 1. - .30 * dot(q, q);
  vec2 edge = min(p, sz - p);
  vec3 bg = vec3(.043, .047, .047);
  col = mix(bg, col, smoothstep(0., 24., min(edge.x, edge.y)));
  col += (hash(fc) - .5) * (1.5 / 255.);
  o = vec4(mix(bg, col, uFade), 1.);
}`;

const yieldTask = () => new Promise(r => setTimeout(r, 0));
// Resolves once the browser reports its first contentful paint (with a timeout for browsers without paint timing).
const firstPaint = () => new Promise(res => {
  let done = false;
  const go = () => { if (!done) { done = true; res(); } };
  try {
    const po = new PerformanceObserver(list => { if (list.getEntries().some(e => e.name === 'first-contentful-paint')) { po.disconnect(); setTimeout(go, 50); } });
    po.observe({ type: 'paint', buffered: true });
  } catch (e) { /* no paint timing: fall through to the timeout */ }
  setTimeout(go, 2000);
});
async function fetchOk(url) {
  const r = await fetch(url, { priority: 'low' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r;
}

function init({ hero, canvas, overlay, onProbe, labels }) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stats = { gl: false, frames: 0, ready: false, error: null };
  let cv = canvas;
  const ov = overlay, octx = ov.getContext('2d');
  // The GL context and shader are created in load(), after the elevation download starts, so that one-time
  // GPU setup never blocks the first paint. Without WebGL2 the canvas is swapped for a 2D one (CPU fallback).
  let gl = null, glLost = false, prog = null;
  let fctx = null, fbMap = null;
  const FBK = 1.5;

  const U = {};
  // Compile and link without querying status: with KHR_parallel_shader_compile the driver finishes in the
  // background, and finishGL() only asks for the result once the elevation data is decoded.
  function compileGL() {
    const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
    prog = gl.createProgram();
    const vs = mk(gl.VERTEX_SHADER, VS), fs = mk(gl.FRAGMENT_SHADER, FS);
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    prog.shaders = [vs, fs];
  }
  function finishGL() {
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      for (const sh of prog.shaders) if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(sh));
      console.error(gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);
    const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aP = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['uRes', 'uView', 'uLens', 'uDpr', 'uMpp', 'uFade', 'uDem']) U[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(U.uDem, 0); gl.uniform1f(U.uMpp, DEM.mpp);
    gl.viewport(0, 0, cv.width, cv.height);
  }
  // Upload elevation and water as an RG32F texture, built from the CPU copies when no prepared buffer is given.
  function uploadDem(tex) {
    if (!tex) { tex = new Float32Array(EW * EH * 2); for (let i = 0; i < EW * EH; i++) { tex[i * 2] = elev[i]; tex[i * 2 + 1] = water[i]; } }
    const tx = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, EW, EH, 0, gl.RG, gl.FLOAT, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  function createGL() {
    gl = cv.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power' });
    stats.gl = !!gl;
    if (!gl) { const c2 = cv.cloneNode(false); cv.replaceWith(c2); cv = c2; fctx = cv.getContext('2d'); return; }
    gl.getExtension('KHR_parallel_shader_compile');
    compileGL();
    // A GPU reset or driver switch loses the context: keep drawing the overlay, and rebuild when it returns.
    cv.addEventListener('webglcontextlost', e => { e.preventDefault(); glLost = true; });
    cv.addEventListener('webglcontextrestored', () => { compileGL(); finishGL(); if (elev) uploadDem(); glLost = false; if (ready) draw(performance.now(), true); });
  }

  // CPU copy of the elevation for the probe, the route solver, and the fallback renderer.
  let EW = 0, EH = 0, elev = null, water = null;
  const sampleElev = (x, y) => {
    x = Math.min(EW - 1.001, Math.max(0, x - .5)); y = Math.min(EH - 1.001, Math.max(0, y - .5));
    const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, i = iy * EW + ix;
    return (elev[i] * (1 - fx) + elev[i + 1] * fx) * (1 - fy) + (elev[i + EW] * (1 - fx) + elev[i + EW + 1] * fx) * fy;
  };
  const isWater = (x, y) => water[Math.min(EH - 1, Math.max(0, y | 0)) * EW + Math.min(EW - 1, Math.max(0, x | 0))] > 0;

  /* View */
  let vw = 0, vh = 0, dpr = 1, dprOv = 1, base = 1, fx0 = 1060, fy0 = 700, ready = false, fade = 0, lensA = 0, dprCap = 1.5, portrait = false;
  const view = { x: 1060, y: 700, s: 1 };          // target view, updated every frame
  const rv = { x: 1060, y: 700, s: 1 };            // view the map was last drawn with
  const mouse = { x: -1, y: -1, in: false }, par = { x: 0, y: 0 };
  function resize() {
    const r = hero.getBoundingClientRect(); vw = r.width; vh = r.height;
    dpr = Math.min(devicePixelRatio || 1, dprCap); dprOv = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr);
    ov.width = Math.round(vw * dprOv); ov.height = Math.round(vh * dprOv);
    rcv.width = ov.width; rcv.height = ov.height;
    if (gl) gl.viewport(0, 0, cv.width, cv.height);
    portrait = vw < 700 || vh > vw * 1.05;
    // Frame the drive loop: right of the copy on wide screens, above the copy on tall ones.
    const B = loopBox, lw = B.x1 - B.x0 + 40, lh = B.y1 - B.y0 + 40, cx = (B.x0 + B.x1) / 2, cy = (B.y0 + B.y1) / 2;
    if (portrait) {
      base = Math.max(vw / 560, Math.min(vh * 0.5 / lh, vw * 0.88 / lw));
    } else {
      base = Math.min(Math.max(vw / 880, vh / 560), (vh - 190) / lh);
    }
    // Never zoom out past the data (a very short or very wide window), and never let the scale reach zero.
    base = Math.max(base, 0.05);
    if (EW) base = Math.max(base, vw / (EW - 8), vh / (EH - 8));
    if (portrait) { fx0 = cx; fy0 = cy + (0.5 - 0.29) * vh / base; } else { fx0 = cx - 0.27 * vw / base; fy0 = cy + 6 / base; }
    if (ready) draw(performance.now(), true);
  }
  function updateView(t) {
    const scrollP = Math.min(1, Math.max(0, scrollY / Math.max(1, vh)));
    const s = base * (1 + .12 * scrollP);
    const drift = reduce ? 0 : 1;
    if (!reduce) {
      par.x += ((mouse.in ? mouse.x / vw - .5 : 0) - par.x) * .04;
      par.y += ((mouse.in ? mouse.y / vh - .5 : 0) - par.y) * .04;
    }
    const x = fx0 + drift * (Math.sin(t * 6e-5) * 16 + Math.sin(t * 1.9e-5) * 10) - par.x * 12 + scrollP * 60;
    const y = fy0 + drift * Math.cos(t * 5e-5) * 10 - par.y * 9 + scrollP * 50;
    const hw = vw / (2 * s), hh = vh / (2 * s);
    // On tall screens the lower part sits under the copy, so the view may run past the south edge of the data there.
    const slack = portrait ? 0.5 * vh / s : 0;
    view.x = Math.min(EW - hw, Math.max(hw, x)); view.y = Math.min(EH - hh + slack, Math.max(hh, y)); view.s = s;
  }
  const sx = x => (x - rv.x) * rv.s + vw / 2, sy = y => (y - rv.y) * rv.s + vh / 2;

  /* Real roads (OpenStreetMap) and a closed loop along them, both in DEM pixel coordinates */
  const route = { x: null, y: null, cum: null, n: 0, len: 0 };
  let roads = [], loopBox = { x0: 1110, x1: 1292, y0: 503, y1: 903 };
  function setRoads(data) {
    roads = data.roads.map(r => {
      const pts = Float32Array.from(r.slice(1));
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); }
      return { cls: r[0], pts, x0, y0, x1, y1 };
    });
    const R = data.route, n = R.length / 2;
    route.n = n; route.x = new Float32Array(n); route.y = new Float32Array(n); route.cum = new Float32Array(n);
    let len = 0;
    for (let i = 0; i < n; i++) { route.x[i] = R[i * 2]; route.y[i] = R[i * 2 + 1]; if (i) len += Math.hypot(route.x[i] - route.x[i - 1], route.y[i] - route.y[i - 1]); route.cum[i] = len; }
    route.len = len;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < n; i++) { x0 = Math.min(x0, route.x[i]); x1 = Math.max(x1, route.x[i]); y0 = Math.min(y0, route.y[i]); y1 = Math.max(y1, route.y[i]); }
    loopBox = { x0, x1, y0, y1 };
  }
  const routeAt = (d, out) => {
    d = ((d % route.len) + route.len) % route.len;
    let lo = 0, hi = route.n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (route.cum[m] < d) lo = m + 1; else hi = m; }
    const i = Math.max(1, lo), a = route.cum[i - 1], b = route.cum[i], f = b > a ? (d - a) / (b - a) : 0;
    out[0] = route.x[i - 1] + (route.x[i] - route.x[i - 1]) * f; out[1] = route.y[i - 1] + (route.y[i] - route.y[i - 1]) * f;
  };

  // Roads get their own layer, redrawn with the terrain pass so they stay locked to it.
  const rcv = document.createElement('canvas'); rcv.setAttribute('aria-hidden', 'true'); rcv.className = 'roads';
  ov.parentNode.insertBefore(rcv, ov);
  const rctx = rcv.getContext('2d');
  const ROAD_STYLE = [null, ['rgba(236,234,229,0.07)', 0.9], ['rgba(236,234,229,0.11)', 1.1], ['rgba(236,234,229,0.15)', 1.4]];
  function drawRoads() {
    rctx.setTransform(1, 0, 0, 1, 0, 0); rctx.clearRect(0, 0, rcv.width, rcv.height);
    if (!roads.length) return;
    rctx.setTransform(dprOv, 0, 0, dprOv, 0, 0); rctx.globalAlpha = fade; rctx.lineCap = 'round'; rctx.lineJoin = 'round';
    const hw = vw / (2 * rv.s), hh = vh / (2 * rv.s), X0 = rv.x - hw, X1 = rv.x + hw, Y0 = rv.y - hh, Y1 = rv.y + hh;
    for (let c = 1; c <= 3; c++) {
      rctx.beginPath();
      for (const r of roads) {
        if (r.cls !== c || r.x1 < X0 || r.x0 > X1 || r.y1 < Y0 || r.y0 > Y1) continue;
        const p = r.pts;
        rctx.moveTo(sx(p[0]), sy(p[1]));
        for (let i = 2; i < p.length; i += 2) rctx.lineTo(sx(p[i]), sy(p[i + 1]));
      }
      rctx.strokeStyle = ROAD_STYLE[c][0]; rctx.lineWidth = ROAD_STYLE[c][1]; rctx.stroke();
    }
    // The loop itself reads as a slightly brighter road.
    if (route.n > 1) {
      rctx.beginPath(); rctx.moveTo(sx(route.x[0]), sy(route.y[0]));
      for (let i = 1; i < route.n; i++) rctx.lineTo(sx(route.x[i]), sy(route.y[i]));
      rctx.strokeStyle = 'rgba(236,234,229,0.2)'; rctx.lineWidth = 1.4; rctx.stroke();
    }
    rctx.globalAlpha = 1;
  }

  /* Overlay: a small car drives the loop slowly, forever, trailing a fading line */
  const SPEED = 10.5;                      // DEM px per second, about 170 m/s: one lap takes about 100 s
  const TRAIL = 150, CAR = new Float32Array(2), A = new Float32Array(2), B = new Float32Array(2);
  const beam = document.createElement('canvas'); beam.width = 96; beam.height = 48;
  { const g = beam.getContext('2d'), rg = g.createRadialGradient(0, 24, 0, 0, 24, 96); rg.addColorStop(0, 'rgba(255,236,214,.34)'); rg.addColorStop(1, 'rgba(255,236,214,0)'); g.fillStyle = rg; g.beginPath(); g.moveTo(0, 18); g.lineTo(96, 0); g.lineTo(96, 48); g.lineTo(0, 30); g.closePath(); g.fill(); }
  const glow = document.createElement('canvas'); glow.width = glow.height = 64;
  { const g = glow.getContext('2d'), rg = g.createRadialGradient(32, 32, 0, 32, 32, 32); rg.addColorStop(0, 'rgba(255,140,90,.32)'); rg.addColorStop(1, 'rgba(255,140,90,0)'); g.fillStyle = rg; g.fillRect(0, 0, 64, 64); }
  let heading = 0, headingInit = false;
  const rrect = (c, x, y, w, h, r) => {
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  };
  function drawCar(x, y, ang) {
    octx.drawImage(glow, x - 22, y - 22, 44, 44);
    octx.save(); octx.translate(x, y); octx.rotate(ang);
    octx.drawImage(beam, 7, -12, 46, 24);
    octx.fillStyle = 'rgba(0,0,0,.55)'; octx.beginPath(); rrect(octx, -7.6, -4, 16.2, 9, 3); octx.fill();
    octx.fillStyle = '#efede8'; octx.beginPath(); rrect(octx, -7.5, -3.9, 15, 7.8, 2.8); octx.fill();
    octx.fillStyle = '#26292a';
    octx.beginPath(); rrect(octx, 1.4, -3, 2.9, 6, 1); octx.fill();       // windshield
    octx.beginPath(); rrect(octx, -5.6, -2.8, 1.8, 5.6, .8); octx.fill();  // rear window
    octx.restore();
  }
  const places = (labels || []).map(l => { if (l.lat == null) return { ...l }; const [x, y] = ll2px(l.lat, l.lon); return { ...l, x, y }; });
  function drawOverlay(t) {
    octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, ov.width, ov.height);
    octx.setTransform(dprOv, 0, 0, dprOv, 0, 0);
    octx.globalAlpha = fade;
    octx.lineCap = 'round'; octx.lineJoin = 'round';
    // Labels
    for (const l of places) {
      const x = sx(l.x), y = sy(l.y);
      if (x < -150 || y < -40 || x > vw + 150 || y > vh + 40) continue;
      if (l.water) {
        octx.save(); octx.translate(x, y); octx.rotate((l.rot || 0) * Math.PI / 180);
        octx.font = 'italic 400 12px "Schibsted Grotesk", sans-serif'; octx.textAlign = 'center'; octx.textBaseline = 'middle';
        octx.fillStyle = 'rgba(170,184,190,.55)'; octx.fillText(l.name, 0, 0);
        octx.restore();
      } else {
        octx.fillStyle = 'rgba(236,234,229,.55)';
        octx.beginPath(); octx.arc(x, y, 2, 0, 6.2832); octx.fill();
        octx.font = '400 12px "Schibsted Grotesk", sans-serif'; octx.textAlign = 'left'; octx.textBaseline = 'middle';
        octx.fillStyle = 'rgba(236,234,229,.5)';
        const txt = l.label || l.name, tw = octx.measureText(txt).width;
        if (x + 9 + tw > vw - 12) { octx.textAlign = 'right'; octx.fillText(txt, x - 9, y); } else octx.fillText(txt, x + 9, y);
      }
    }
    // The drive: trail, then the car.
    if (route.n > 1) {
      const d = reduce ? route.len * 0.3 : (t / 1000) * SPEED;
      // Trail: opacity follows a continuous curve along its length. Pieces are grouped only while the
      // 8-bit alpha is unchanged, and use flat caps so neighbouring pieces never overlap into a seam.
      const step = 1.2 / rv.s;                   // about 1.2 screen px per piece
      octx.lineWidth = 1.8; octx.lineCap = 'butt';
      let lvl = -1;
      if (step > 0 && step < TRAIL) {
      routeAt(d - TRAIL, A);
      let lx = sx(A[0]), ly = sy(A[1]);
      for (let q = d - TRAIL + step; ; q += step) {
        const last = q >= d; if (last) q = d;
        routeAt(q, A);
        const x = sx(A[0]), y = sy(A[1]), a = Math.round(217 * Math.pow(1 - (d - q) / TRAIL, 1.6));   // 217/255 = 0.85 at the car
        if (a !== lvl) { if (lvl > 0) octx.stroke(); lvl = a; octx.beginPath(); octx.moveTo(lx, ly); octx.strokeStyle = `rgba(255,122,69,${(a / 255).toFixed(4)})`; }
        octx.lineTo(x, y); lx = x; ly = y;
        if (last) break;
      }
      if (lvl > 0) octx.stroke();
      }
      octx.lineCap = 'round';
      routeAt(d, CAR); routeAt(d + 3, A); routeAt(d - 3, B);
      const target = Math.atan2(A[1] - B[1], A[0] - B[0]);
      if (!headingInit) { heading = target; headingInit = true; }
      let dh = target - heading; dh -= 6.2832 * Math.round(dh / 6.2832); heading += dh * (reduce ? 1 : 0.25);
      drawCar(sx(CAR[0]), sy(CAR[1]), heading);
    }
    // Cursor ring
    if (mouse.in && lensA > .05) {
      octx.globalAlpha = .6 * lensA;
      octx.beginPath(); octx.arc(mouse.x, mouse.y, 5, 0, 6.2832); octx.strokeStyle = 'rgba(255,122,69,1)'; octx.lineWidth = 1; octx.stroke();
    }
    octx.globalAlpha = 1;
  }

  /* CPU fallback: smooth, shade, and trace contours once; pan and scale the cached image per frame */
  function buildFallback() {
    const n = EW * EH, tmp = new Float32Array(n), sm = new Float32Array(n);
    for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++) { const i = y * EW + x; tmp[i] = ((x > 0 ? elev[i - 1] : elev[i]) + 2 * elev[i] + (x < EW - 1 ? elev[i + 1] : elev[i])) * .25; }
    for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++) { const i = y * EW + x; sm[i] = ((y > 0 ? tmp[i - EW] : tmp[i]) + 2 * tmp[i] + (y < EH - 1 ? tmp[i + EW] : tmp[i])) * .25; }
    const img = new ImageData(EW, EH), d = img.data, lx = -.6, ly = -.7, lz = .8, ll = Math.hypot(lx, ly, lz);
    for (let y = 0; y < EH; y++) for (let x = 0; x < EW; x++) {
      const i = y * EW + x, q = i * 4;
      if (water[i]) { d[q] = 8; d[q + 1] = 11; d[q + 2] = 12; d[q + 3] = 255; continue; }
      const gx = (sm[x < EW - 1 ? i + 1 : i] - sm[x > 0 ? i - 1 : i]) / (2 * DEM.mpp) * 2.4, gy = (sm[y < EH - 1 ? i + EW : i] - sm[y > 0 ? i - EW : i]) / (2 * DEM.mpp) * 2.4;
      const sh = (-gx * lx - gy * ly + lz) / (Math.hypot(gx, gy, 1) * ll) - lz / ll;
      const v = 1 + 1.05 * sh;
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

  /* Probe */
  function probe() {
    if (!mouse.in || !elev) return null;
    const x = rv.x + (mouse.x - vw / 2) / rv.s, y = rv.y + (mouse.y - vh / 2) / rv.s;
    if (x < 0 || y < 0 || x >= EW || y >= EH) return null;
    const [lat, lon] = px2ll(x, y);
    return { m: sampleElev(x, y), lat, lon, water: isWater(x, y) };
  }

  /* Frame */
  let raf = 0, visible = true, lastGl = -1e9, lastOv = -1e9, lastProbe = 0, slow = 0, lastT = 0, probeShown = false;
  const drawn = { mx: -1, my: -1, lens: -1, fade: -1 };
  function draw(t, once) {
    updateView(t);
    lensA += ((mouse.in ? 1 : 0) - lensA) * (reduce ? 1 : .07);
    fade = reduce ? 1 : Math.min(1, fade + .02);
    // The terrain drifts slowly, so it is only redrawn (at up to 30 fps) once the view has moved half a device
    // pixel or the cursor lens has changed. An idle hero costs a few redraws a second, not a full-screen pass per frame.
    const moved = Math.max(Math.abs(view.x - rv.x), Math.abs(view.y - rv.y)) * view.s * dpr > 0.5 || Math.abs(view.s - rv.s) > rv.s * 1e-3;
    const lensChanged = Math.abs(lensA - drawn.lens) > 0.004 || (lensA > 0.004 && (Math.abs(mouse.x - drawn.mx) > 0.5 || Math.abs(mouse.y - drawn.my) > 0.5));
    if (once || ((moved || lensChanged || fade !== drawn.fade) && t - lastGl > 30)) {
      lastGl = t;
      rv.x = view.x; rv.y = view.y; rv.s = view.s;
      drawn.mx = mouse.x; drawn.my = mouse.y; drawn.lens = lensA; drawn.fade = fade;
      if (gl && !glLost) {
        gl.uniform2f(U.uRes, cv.width, cv.height); gl.uniform3f(U.uView, rv.x, rv.y, rv.s * dpr);
        gl.uniform4f(U.uLens, mouse.x * dpr, (vh - mouse.y) * dpr, 170 * dpr, lensA);
        gl.uniform1f(U.uDpr, dpr); gl.uniform1f(U.uFade, fade);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } else if (fbMap) {
        const k = rv.s * dpr / FBK;
        fctx.setTransform(1, 0, 0, 1, 0, 0); fctx.fillStyle = '#0b0c0c'; fctx.fillRect(0, 0, cv.width, cv.height);
        fctx.globalAlpha = fade; fctx.imageSmoothingEnabled = true;
        fctx.setTransform(k, 0, 0, k, (vw / 2 - rv.x * rv.s) * dpr, (vh / 2 - rv.y * rv.s) * dpr);
        fctx.drawImage(fbMap, 0, 0); fctx.globalAlpha = 1;
      }
      drawRoads();
      stats.frames++;
    }
    // Full rate up to 90 Hz (about 60 fps above that); the CPU-only fallback paints the overlay at 30 fps.
    if (once || t - lastOv > (gl ? 11 : 30)) { lastOv = t; drawOverlay(t); }
    if (onProbe && t - lastProbe > 80) {
      lastProbe = t;
      const p = probe();
      if (p || probeShown) { probeShown = !!p; onProbe(p); }            // no DOM writes while nothing changes
    }
  }
  function loop(t) {
    if (lastT && dprCap > 1) { slow = t - lastT > 30 ? slow + 1 : Math.max(0, slow - 1); if (slow > 90) { dprCap = 1; resize(); } }
    lastT = t;
    draw(t, false);
    raf = (!reduce && visible && !document.hidden) ? requestAnimationFrame(loop) : 0;
  }
  function start() { if (ready && !raf && !reduce && visible && !document.hidden) { lastT = 0; raf = requestAnimationFrame(loop); } }
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; start(); }).observe(hero);
  document.addEventListener('visibilitychange', start);
  const setPointer = e => { clearTimeout(tapTimer); const r = hero.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.in = true; if (reduce && ready) draw(performance.now(), true); };
  hero.addEventListener('pointermove', setPointer);
  hero.addEventListener('pointerdown', setPointer);
  const clearPointer = () => { mouse.in = false; if (reduce && ready) draw(performance.now(), true); };
  let tapTimer = 0;
  hero.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') clearPointer(); });
  hero.addEventListener('pointercancel', clearPointer);
  hero.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') { clearTimeout(tapTimer); tapTimer = setTimeout(clearPointer, 2500); } });
  addEventListener('resize', resize);

  async function load() {
    // The text paints first, in its web font; only then do the terrain downloads and GPU setup start, at
    // low priority, so a 1 MB elevation file never competes with the first render on a slow connection.
    await Promise.all([firstPaint(), document.fonts ? Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 1500))]) : null]);
    // Roads are decoration: if they fail, the terrain still renders without them.
    const roadsP = fetchOk(ROADS.url).then(r => r.json()).then(setRoads).catch(err => console.error('Roads failed to load', err));
    const blobP = fetchOk(DEM.url).then(r => r.blob());
    createGL();
    const blob = await blobP;
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    EW = bmp.width; EH = bmp.height;
    const c = document.createElement('canvas'); c.width = EW; c.height = EH;
    const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(bmp, 0, 0);
    const px = cx.getImageData(0, 0, EW, EH).data;
    bmp.close();
    await yieldTask();
    elev = new Float32Array(EW * EH); water = new Uint8Array(EW * EH);
    const tex = gl ? new Float32Array(EW * EH * 2) : null;
    for (let i = 0, j = 0; i < EW * EH; i++, j += 4) {
      // Terrarium encoding: h = R*256 + G + B/256 - 32768. The lowest blue bit carries the water mask.
      const b = px[j + 2], e = px[j] * 256 + px[j + 1] + (b & 254) / 256 - 32768;
      elev[i] = e; water[i] = b & 1;
      if (tex) { tex[i * 2] = e; tex[i * 2 + 1] = b & 1; }
    }
    await yieldTask();
    if (gl) { if (!glLost) { finishGL(); uploadDem(tex); } } else fbMap = buildFallback();
    await yieldTask();
    // Snap peak labels to the true local maximum in the data, and show its elevation.
    for (const l of places) if (l.peak) {
      let bx = l.x, by = l.y, be = -1e9;
      for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) { const e = sampleElev(l.x + dx, l.y + dy); if (e > be) { be = e; bx = l.x + dx; by = l.y + dy; } }
      l.x = bx; l.y = by; l.label = `${l.name}  ${Math.round(be)} m`;
    }
    await roadsP;
    ready = true; resize(); cv.classList.add('on');
    stats.ready = true;
    if (reduce) draw(performance.now(), true); else start();
  }
  load().catch(err => {
    // Without elevation data the hero stays a quiet dark field; the rest of the page is unaffected.
    console.error('Terrain failed to load', err);
    stats.error = String(err && err.message || err);
  });
  return { stats, view, route, sampleElev: (x, y) => elev && sampleElev(x, y), ll2px, px2ll };
}

window.Terrain = { init };
})();
