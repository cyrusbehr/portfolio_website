// Exhibit: a map-matching particle filter localizing a car with GPS denied.
// It knows only the road map and noisy odometry (distance and heading change). Nothing is scripted.
// Global search with an adaptive particle count, random injection until lock, and a sustained-lock rule.
(function () {
'use strict';

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const TAU = 6.283185307179586;
const wrapPi = a => a - TAU * Math.round(a / TAU);
const ease3 = t => 1 - Math.pow(1 - t, 3);

// Simulation constants
const STEP = 1 / 60, TS = 3.0, DT = STEP * TS, UPD = 6;
const VMAX = 14, VTURN = 5.5, ACC = 2.6, DEC = 4.5;
const SIG_D = 5.5, SIG_A = 0.26, EPS = 1e-4, INV_SD2 = 1 / (SIG_D * SIG_D), INV_SA2 = 1 / (SIG_A * SIG_A);
const ODO_SCALE = 0.02, GYRO_BIAS = 0.003;
const M = 140, CS = 3, HB = 40;

const PS_VS = `#version 300 es
layout(location = 0) in vec3 a;
uniform vec2 uRes; uniform float uSize;
out float vL;
void main() {
  vec2 c = a.xy / uRes * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  gl_PointSize = uSize * (0.7 + 0.8 * a.z);
  vL = a.z;
}`;
const PS_FS = `#version 300 es
precision mediump float;
in float vL; uniform float uGain; out vec4 o;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float g = exp(-r2 * 3.4);
  vec3 col = mix(vec3(1.0, 0.42, 0.18), vec3(1.0, 0.86, 0.74), vL * vL);
  float a = g * uGain * (0.2 + 0.8 * vL);
  o = vec4(col * a, a);
}`;

function create(container, opts = {}) {
  const onStatus = opts.onStatus || (() => {});
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mk = cls => { const c = document.createElement('canvas'); c.className = cls; c.setAttribute('aria-hidden', 'true'); container.appendChild(c); return c; };
  const cvMap = mk('pf-map'), cvPf = mk('pf-glow'), cvFx = mk('pf-fx');
  const fx = cvFx.getContext('2d');

  let rs = 88172645;
  const rnd = () => { let x = rs; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; rs = x >>> 0; return rs / 4294967296; };
  const NT = new Float32Array(8192);
  { const r = mulberry32(7); for (let i = 0; i < 8192; i += 2) { const u = Math.max(1e-9, r()), v = r(), m = Math.sqrt(-2 * Math.log(u)); NT[i] = m * Math.cos(TAU * v); NT[i + 1] = m * Math.sin(TAU * v); } }
  const gauss = () => NT[(rnd() * 8192) | 0];

  /* ---------- State ---------- */
  let N = 0, NMAX = 0, NMIN = 0;
  let px, py, pt, pl, qx, qy, qt, ql, pw, fromX, fromY, delay, vbuf;
  let W, H, ppm, DPR, vw, vh, focus;
  let nX, nY, edges, adjDrive, driveIdx, driveCum, totalLen;
  let FW, FH, fDist, fAng, fJun, HW, HH, hist, box, sup;
  let river, blocks, bld;
  // Loop guard: when each street was last driven, so the car does not circle the same block.
  let lastVisit = new Int32Array(1), visits = 0;
  const seq = new Int32Array(4096); let seqN = 0;
  const cw = new Float32Array(16);
  function alloc(n) {
    if (n === NMAX) return;
    NMAX = n; N = n;
    px = new Float32Array(N); py = new Float32Array(N); pt = new Float32Array(N); pl = new Float32Array(N);
    qx = new Float32Array(N); qy = new Float32Array(N); qt = new Float32Array(N); ql = new Float32Array(N);
    pw = new Float64Array(N); fromX = new Float32Array(N); fromY = new Float32Array(N); delay = new Float32Array(N);
    vbuf = new Float32Array(N * 3);
  }
  const inFocus = k => nX[k] > focus.x0 && nX[k] < focus.x1 && nY[k] > focus.y0 && nY[k] < focus.y1;

  /* ---------- World ---------- */
  const yieldTask = () => new Promise(r => setTimeout(r, 0));
  let built = false, bootGen = 0;
  // Builds the city in a few short tasks. Returns false if a newer boot (a resize) superseded this one.
  async function buildWorld(gen) {
    const r0 = container.getBoundingClientRect();
    vw = Math.max(1, Math.round(r0.width)); vh = Math.max(1, Math.round(r0.height));
    DPR = Math.min(1.5, window.devicePixelRatio || 1);
    ppm = clamp(vw / 1000, 0.8, 1.2);
    W = vw / ppm; H = vh / ppm;
    for (const c of [cvMap, cvPf, cvFx]) { c.width = Math.round(vw * DPR); c.height = Math.round(vh * DPR); c.style.width = vw + 'px'; c.style.height = vh + 'px'; }
    alloc(vw >= 700 ? 16000 : 9000); NMIN = vw >= 700 ? 2500 : 1400;
    const mr = mulberry32(20260924);
    focus = { x0: 30, y0: 30, x1: W - 30, y1: H - 30 };

    river = [];
    const ry0 = H * 0.9;
    for (let x = -M; x <= W + M; x += 14) river.push(x, ry0 + Math.sin(x / 270) * 48 + Math.sin(x / 101 + 1.3) * 16);
    const riverDist = (x, y) => {
      let best = 1e9;
      for (let i = 0; i < river.length - 2; i += 2) {
        const ax = river[i], ay = river[i + 1], bx = river[i + 2], by = river[i + 3];
        const dx = bx - ax, dy = by - ay, t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1);
        const ex = ax + t * dx - x, ey = ay + t * dy - y, d = ex * ex + ey * ey;
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    };
    const crossesRiver = (ax, ay, bx, by) => {
      const L = Math.hypot(bx - ax, by - ay), n = Math.ceil(L / 8);
      for (let k = 0; k <= n; k++) { const t = k / n; if (riverDist(ax + (bx - ax) * t, ay + (by - ay) * t) < 26) return true; }
      return false;
    };
    // Irregular streets: a perfect grid aliases because parallel streets give identical turn timings.
    const rot = -0.17, cr = Math.cos(rot), sr = Math.sin(rot);
    const R = Math.hypot(W, H) / 2 + M + 60;
    const inExp = (x, y) => x > -M && y > -M && x < W + M && y < H + M;
    const vs = []; for (let v = -R; v <= R; v += 72 + mr() * 78) vs.push(v);
    const aves = []; for (let u = -R + mr() * 200; u <= R; u += 320 + mr() * 220) aves.push(u);
    const aveRows = new Set(); for (let j = 1; j < vs.length; j += 3 + (mr() * 2 | 0)) aveRows.add(j);
    const bands = [];
    for (let j = 0; j + 1 < vs.length; j++) {
      const list = aves.map(u => ({ u, ave: true }));
      for (let u = -R + mr() * 80; u <= R; u += 68 + mr() * 96) if (aves.every(a => Math.abs(a - u) > 38)) list.push({ u, ave: false });
      list.sort((a, b) => a.u - b.u); bands.push(list);
    }
    const xs = [], ys = [], rows = [];
    for (let j = 0; j < vs.length; j++) {
      const set = new Set();
      if (j > 0) for (const c of bands[j - 1]) set.add(c.u);
      if (j < bands.length) for (const c of bands[j]) set.add(c.u);
      const uu = [...set].sort((a, b) => a - b), row = new Map();
      const order = [];
      for (const u of uu) {
        const v = vs[j] + (mr() - 0.5) * 14;
        const x = u * cr - v * sr + W / 2, y = u * sr + v * cr + H / 2;
        let id = -1;
        if (inExp(x, y) && riverDist(x, y) > 34) { id = xs.length; xs.push(x); ys.push(y); }
        row.set(u, id); order.push(id);
      }
      rows.push({ row, order });
    }
    nX = Float64Array.from(xs); nY = Float64Array.from(ys);
    edges = [];
    const addEdge = (a, b, type, bridge) => {
      const dx = nX[b] - nX[a], dy = nY[b] - nY[a], len = Math.hypot(dx, dy);
      edges.push({ a, b, len, ux: dx / len, uy: dy / len, ang: Math.atan2(dy, dx), type, bridge: !!bridge });
    };
    const keepCross = (a, b, major) => (!crossesRiver(nX[a], nY[a], nX[b], nY[b])) ? 1 : (major && mr() < 0.6 ? 2 : 0);
    rows.forEach(({ order }, j) => {
      const major = aveRows.has(j);
      for (let k = 0; k + 1 < order.length; k++) {
        const a = order[k], b = order[k + 1];
        if (a < 0 || b < 0) continue;
        if (!major && mr() < 0.07) continue;
        const kc = keepCross(a, b, major);
        if (kc) addEdge(a, b, major ? 2 : 1, kc === 2);
      }
    });
    blocks = [];
    bands.forEach((list, j) => {
      const top = rows[j].row, bot = rows[j + 1].row;
      for (let k = 0; k < list.length; k++) {
        const c = list[k], a = top.get(c.u), b = bot.get(c.u);
        if (a >= 0 && b >= 0 && (c.ave || mr() > 0.1)) { const kc = keepCross(a, b, c.ave); if (kc) addEdge(a, b, c.ave ? 2 : 1, kc === 2); }
        if (k + 1 < list.length) {
          const n = list[k + 1], a2 = top.get(n.u), b2 = bot.get(n.u);
          if (a >= 0 && b2 >= 0 && mr() < 0.05 && !crossesRiver(nX[a], nY[a], nX[b2], nY[b2])) addEdge(a, b2, 0);
          const q = [a, a2, b2, b];
          if (q.every(v => v >= 0)) {
            const cx = (nX[a] + nX[a2] + nX[b2] + nX[b]) / 4, cy = (nY[a] + nY[a2] + nY[b2] + nY[b]) / 4;
            if (riverDist(cx, cy) > 70) blocks.push({ q, cx, cy, park: mr() < 0.07 });
          }
        }
      }
    });
    await yieldTask(); if (gen !== bootGen) return false;
    // Drivable network: inside the frame, largest component, then its 2-core (no dead ends, no U-turns).
    const nn = nX.length, ne = edges.length;
    const inDrive = k => nX[k] > focus.x0 - 20 && nY[k] > focus.y0 - 20 && nX[k] < focus.x1 + 20 && nY[k] < focus.y1 + 20;
    const alive = new Uint8Array(ne);
    edges.forEach((e, k) => { if (inDrive(e.a) && inDrive(e.b)) alive[k] = 1; });
    const inc = Array.from({ length: nn }, () => []);
    edges.forEach((e, k) => { inc[e.a].push(k); inc[e.b].push(k); });
    const comp = new Int32Array(nn).fill(-1);
    let bestC = -1, bestSize = 0, cc = 0;
    for (let s = 0; s < nn; s++) {
      if (comp[s] >= 0) continue;
      const st = [s]; comp[s] = cc; let size = 0;
      while (st.length) { const u = st.pop(); size++; for (const k of inc[u]) { if (!alive[k]) continue; const e = edges[k], v = e.a === u ? e.b : e.a; if (comp[v] < 0) { comp[v] = cc; st.push(v); } } }
      if (size > bestSize) { bestSize = size; bestC = cc; }
      cc++;
    }
    edges.forEach((e, k) => { if (comp[e.a] !== bestC) alive[k] = 0; });
    const deg = new Int32Array(nn);
    edges.forEach((e, k) => { if (alive[k]) { deg[e.a]++; deg[e.b]++; } });
    const qd = []; for (let k = 0; k < nn; k++) if (deg[k] === 1) qd.push(k);
    while (qd.length) { const u = qd.pop(); for (const k of inc[u]) if (alive[k]) { alive[k] = 0; const e = edges[k], v = e.a === u ? e.b : e.a; deg[u]--; if (--deg[v] === 1) qd.push(v); } }
    adjDrive = inc.map(list => list.filter(k => alive[k]));
    const di = []; edges.forEach((e, k) => { if (alive[k]) di.push(k); });
    driveIdx = Int32Array.from(di); driveCum = new Float64Array(di.length); totalLen = 0;
    di.forEach((k, j) => { totalLen += edges[k].len; driveCum[j] = totalLen; });
    await yieldTask(); if (gen !== bootGen) return false;
    // Distance and direction field to the nearest road, plus a junction mask.
    FW = Math.ceil((W + 2 * M) / CS); FH = Math.ceil((H + 2 * M) / CS);
    fDist = new Float32Array(FW * FH).fill(40); fAng = new Float32Array(FW * FH); fJun = new Uint8Array(FW * FH);
    for (const e of edges) {
      const ax = nX[e.a], ay = nY[e.a], bx = nX[e.b], by = nY[e.b], RAD = 40;
      const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - RAD + M) / CS)), x1 = Math.min(FW - 1, Math.ceil((Math.max(ax, bx) + RAD + M) / CS));
      const y0 = Math.max(0, Math.floor((Math.min(ay, by) - RAD + M) / CS)), y1 = Math.min(FH - 1, Math.ceil((Math.max(ay, by) + RAD + M) / CS));
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      for (let gy = y0; gy <= y1; gy++) {
        const y = gy * CS - M + CS / 2;
        for (let gx = x0; gx <= x1; gx++) {
          const x = gx * CS - M + CS / 2, t = clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1);
          const d = Math.hypot(ax + t * dx - x, ay + t * dy - y), k = gy * FW + gx;
          if (d < fDist[k]) { fDist[k] = d; fAng[k] = e.ang; }
        }
      }
    }
    const degAll = new Int32Array(nn); for (const e of edges) { degAll[e.a]++; degAll[e.b]++; }
    const JR = Math.ceil(16 / CS);
    for (let k = 0; k < nn; k++) {
      if (!degAll[k]) continue;
      const cx = Math.round((nX[k] + M) / CS), cy = Math.round((nY[k] + M) / CS);
      for (let gy = Math.max(0, cy - JR); gy <= Math.min(FH - 1, cy + JR); gy++)
        for (let gx = Math.max(0, cx - JR); gx <= Math.min(FW - 1, cx + JR); gx++)
          if ((gx - cx) ** 2 + (gy - cy) ** 2 <= JR * JR) fJun[gy * FW + gx] = 1;
    }
    HW = Math.ceil((W + 2 * M) / HB); HH = Math.ceil((H + 2 * M) / HB);
    hist = new Float32Array(HW * HH); box = new Float32Array(HW * HH); sup = new Uint8Array(HW * HH);
    await yieldTask(); if (gen !== bootGen) return false;
    // Building footprints: subdivide each block into lots.
    const b = [];
    for (const bk of blocks) {
      if (bk.park) continue;
      const c = bk.q.map(n => [bk.cx + (nX[n] - bk.cx) * 0.8, bk.cy + (nY[n] - bk.cy) * 0.8]);
      const wdt = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]), hgt = Math.hypot(c[3][0] - c[0][0], c[3][1] - c[0][1]);
      const nu = clamp(Math.round(wdt / 34), 1, 5), nv = clamp(Math.round(hgt / 30), 1, 4);
      const P = (s, t) => [(1 - s) * (1 - t) * c[0][0] + s * (1 - t) * c[1][0] + s * t * c[2][0] + (1 - s) * t * c[3][0], (1 - s) * (1 - t) * c[0][1] + s * (1 - t) * c[1][1] + s * t * c[2][1] + (1 - s) * t * c[3][1]];
      for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        if (mr() < 0.16) continue;
        const g = 0.06 + mr() * 0.06, s0 = i / nu + g, s1 = (i + 1) / nu - g * (0.6 + mr()), t0 = j / nv + g, t1 = (j + 1) / nv - g * (0.6 + mr());
        const p = [P(s0, t0), P(s1, t0), P(s1, t1), P(s0, t1)];
        b.push(p[0][0], p[0][1], p[1][0], p[1][1], p[2][0], p[2][1], p[3][0], p[3][1], mr());
      }
    }
    bld = Float32Array.from(b);
    lastVisit = new Int32Array(edges.length).fill(-1e6); visits = 0;
    await yieldTask(); if (gen !== bootGen) return false;
    drawStatic();
    initGL();
    return true;
  }

  function drawStatic() {
    const g = cvMap.getContext('2d', { alpha: false }), k = ppm * DPR;
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#0e0f0f'; g.fillRect(0, 0, cvMap.width, cvMap.height);
    g.setTransform(k, 0, 0, k, 0, 0); g.lineCap = 'round'; g.lineJoin = 'round';
    for (const bk of blocks) {
      g.beginPath();
      bk.q.forEach((n, i) => { const x = bk.cx + (nX[n] - bk.cx) * 0.86, y = bk.cy + (nY[n] - bk.cy) * 0.86; i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.closePath(); g.fillStyle = bk.park ? 'rgba(150,170,150,0.045)' : 'rgba(236,234,229,0.014)'; g.fill();
    }
    const tones = ['rgba(236,234,229,0.030)', 'rgba(236,234,229,0.045)', 'rgba(236,234,229,0.065)'];
    for (let t = 0; t < 3; t++) {
      g.beginPath();
      for (let i = 0; i < bld.length; i += 9) {
        const tone = bld[i + 8] < 0.55 ? 0 : bld[i + 8] < 0.9 ? 1 : 2;
        if (tone !== t) continue;
        g.moveTo(bld[i], bld[i + 1]); g.lineTo(bld[i + 2], bld[i + 3]); g.lineTo(bld[i + 4], bld[i + 5]); g.lineTo(bld[i + 6], bld[i + 7]); g.closePath();
      }
      g.fillStyle = tones[t]; g.fill();
    }
    const rp = () => { g.beginPath(); g.moveTo(river[0], river[1]); for (let i = 2; i < river.length; i += 2) g.lineTo(river[i], river[i + 1]); };
    rp(); g.strokeStyle = 'rgba(160,180,190,0.07)'; g.lineWidth = 54; g.stroke();
    rp(); g.strokeStyle = '#0c1012'; g.lineWidth = 48; g.stroke();
    const roads = (pred, col, w) => { g.beginPath(); for (const e of edges) if (pred(e)) { g.moveTo(nX[e.a], nY[e.a]); g.lineTo(nX[e.b], nY[e.b]); } g.strokeStyle = col; g.lineWidth = w / ppm; g.stroke(); };
    roads(e => e.type === 0, 'rgba(236,234,229,0.10)', 1.0);
    roads(e => e.type === 1, 'rgba(236,234,229,0.16)', 1.2);
    roads(e => e.type === 2, 'rgba(14,15,15,1)', 6);
    roads(e => e.type === 2 && e.bridge, 'rgba(236,234,229,0.12)', 7.5);
    roads(e => e.type === 2 && e.bridge, 'rgba(14,15,15,1)', 5.5);
    roads(e => e.type === 2, 'rgba(236,234,229,0.30)', 2.0);
  }

  /* ---------- Particles on the GPU ---------- */
  let gl = null, glBuf = null, glVao = null, glLost = false, uRes, uSize, uGain;
  function setupGL() {
    const sh = (t, src) => { const x = gl.createShader(t); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(x)); return x; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, PS_VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, PS_FS)); gl.linkProgram(pr); gl.useProgram(pr);
    uRes = gl.getUniformLocation(pr, 'uRes'); uSize = gl.getUniformLocation(pr, 'uSize'); uGain = gl.getUniformLocation(pr, 'uGain');
    glVao = gl.createVertexArray(); gl.bindVertexArray(glVao);
    glBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.bufferData(gl.ARRAY_BUFFER, NMAX * 12, gl.DYNAMIC_DRAW);
  }
  function initGL() {
    if (!gl) {
      gl = cvPf.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
      if (!gl) return;
      // Particles fall back to CPU dots while the context is lost, and the program is rebuilt when it returns.
      cvPf.addEventListener('webglcontextlost', e => { e.preventDefault(); glLost = true; });
      cvPf.addEventListener('webglcontextrestored', () => { setupGL(); glLost = false; });
      setupGL();
      return;
    }
    if (glLost) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
    gl.bufferData(gl.ARRAY_BUFFER, NMAX * 12, gl.DYNAMIC_DRAW);
  }

  /* ---------- Vehicle: ground truth with smooth cornering ---------- */
  const veh = { e: 0, dir: 1, s: 0, ne: 0, ndir: 1, rIn: 0, rOut: 0, pux: 1, puy: 0, turn: 0, v: 8, x: 0, y: 0, th: 0 };
  function chooseNext(node, fromE, ux, uy) {
    const opts = adjDrive[node], n = Math.min(opts.length, 16);
    let tot = 0, oldest = -1, oldestAge = -1;
    for (let j = 0; j < n; j++) {
      const k = opts[j];
      if (k === fromE) { cw[j] = 0; continue; }
      const e = edges[k], dir = e.a === node ? 1 : -1, turn = Math.acos(clamp(ux * dir * e.ux + uy * dir * e.uy, -1, 1));
      let w = 1;
      if (turn > 0.5 && turn < 2.5) w *= 1.8;
      if (turn >= 2.5) w *= 0.05;
      // Loop guard: streets driven in the last 24 legs are ruled out, so no circuit repeats; streets
      // from the last 60 are discouraged so the car keeps exploring. If every option is recent, the
      // car takes the one it drove longest ago.
      {
        const age = visits - lastVisit[k];
        if (age > oldestAge) { oldestAge = age; oldest = k; }
        if (age < 24) w = 0; else if (age < 60) w *= 0.35;
      }
      cw[j] = w; tot += w;
    }
    if (tot <= 0) { if (oldest >= 0) return oldest; for (let j = 0; j < n; j++) if (opts[j] !== fromE) return opts[j]; return fromE; }
    let r = rnd() * tot;
    for (let j = 0; j < n; j++) { r -= cw[j]; if (r <= 0 && cw[j] > 0) return opts[j]; }
    for (let j = n - 1; j >= 0; j--) if (cw[j] > 0) return opts[j];
    return opts[0];
  }
  function setNext() {
    const e = edges[veh.e], node = veh.dir > 0 ? e.b : e.a, ux = veh.dir * e.ux, uy = veh.dir * e.uy;
    const nk = chooseNext(node, veh.e, ux, uy), n = edges[nk];
    veh.ne = nk; veh.ndir = n.a === node ? 1 : -1;
    veh.rOut = Math.min(13, 0.42 * e.len, 0.42 * n.len);
    veh.turn = Math.acos(clamp(ux * veh.ndir * n.ux + uy * veh.ndir * n.uy, -1, 1));
  }
  function bez(x0, y0, x1, y1, x2, y2, t) {
    const m = 1 - t;
    veh.x = m * m * x0 + 2 * m * t * x1 + t * t * x2; veh.y = m * m * y0 + 2 * m * t * y1 + t * t * y2;
    veh.th = Math.atan2(2 * m * (y1 - y0) + 2 * t * (y2 - y1), 2 * m * (x1 - x0) + 2 * t * (x2 - x1));
  }
  function computePose() {
    const e = edges[veh.e], L = e.len, s = veh.s, ux = veh.dir * e.ux, uy = veh.dir * e.uy;
    const ax = veh.dir > 0 ? nX[e.a] : nX[e.b], ay = veh.dir > 0 ? nY[e.a] : nY[e.b];
    if (veh.rIn > 0 && s < veh.rIn) { const r = veh.rIn; bez(ax - veh.pux * r, ay - veh.puy * r, ax, ay, ax + ux * r, ay + uy * r, 0.5 + 0.5 * s / r); }
    else if (s > L - veh.rOut) {
      const n = edges[veh.ne], nux = veh.ndir * n.ux, nuy = veh.ndir * n.uy, bx = ax + ux * L, by = ay + uy * L, r = veh.rOut;
      bez(bx - ux * r, by - uy * r, bx, by, bx + nux * r, by + nuy * r, 0.5 * (s - (L - r)) / r);
    } else { veh.x = ax + ux * s; veh.y = ay + uy * s; veh.th = Math.atan2(uy, ux); }
  }
  function stepVehicle(dt) {
    const e = edges[veh.e], toCorner = e.len - veh.rOut - veh.s;
    const slow = VMAX - (VMAX - VTURN) * Math.min(1, veh.turn / 1.3);
    const vt = toCorner < 26 ? slow + (VMAX - slow) * Math.max(0, toCorner) / 26 : VMAX;
    veh.v += clamp(vt - veh.v, -DEC * dt, ACC * dt);
    veh.s += veh.v * dt;
    let guard = 0;
    while (veh.s >= edges[veh.e].len && guard++ < 6) {
      const c = edges[veh.e];
      veh.s -= c.len; veh.pux = veh.dir * c.ux; veh.puy = veh.dir * c.uy; veh.rIn = veh.rOut;
      veh.e = veh.ne; veh.dir = veh.ndir;
      lastVisit[veh.e] = ++visits; seq[seqN++ & 4095] = veh.e;
      setNext();
    }
    computePose();
  }
  function placeVehicle(eIdx, dir, frac) {
    const e = edges[eIdx];
    veh.e = eIdx; veh.dir = dir; veh.s = e.len * frac; veh.rIn = 0;
    veh.pux = dir * e.ux; veh.puy = dir * e.uy; veh.v = 6;
    lastVisit.fill(-1e6); visits = 0; lastVisit[eIdx] = 0; seqN = 0;
    setNext(); computePose();
  }

  /* ---------- Filter ---------- */
  function samplePrior(bx, by, bt, i) {
    const r = rnd() * totalLen;
    let lo = 0, hi = driveIdx.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (driveCum[mid] < r) lo = mid + 1; else hi = mid; }
    const e = edges[driveIdx[lo]], s = rnd() * e.len, lat = gauss() * 2;
    bx[i] = nX[e.a] + e.ux * s - e.uy * lat; by[i] = nY[e.a] + e.uy * s + e.ux * lat;
    bt[i] = e.ang + (rnd() < 0.5 ? 0 : Math.PI) + gauss() * 0.05;
  }
  let wSlow = 0, wFast = 0, lhRatio = 1, lowCount = 0, neff = 0, stepCount = 0, simT = 0, seedT = 0, tween0 = -1;
  let state = 'Searching', lockedOnce = false, lockT = 0, lockReal = 0, lockRun = 0, lastErr = NaN, lockFx = -1;
  const hyp = { n: 0, x: new Float32Array(3), y: new Float32Array(3), m: new Float32Array(3) };
  const est = { ok: false, x: 0, y: 0, th: 0, frac: 0, sxx: 0, syy: 0, sxy: 0, sig: 1e9 };
  function seedFilter(animate) {
    if (animate) { for (let i = 0; i < NMAX; i++) { const j = i % N; fromX[i] = px[j]; fromY[i] = py[j]; delay[i] = rnd() * 0.35; } tween0 = performance.now(); }
    N = NMAX;
    for (let i = 0; i < N; i++) { samplePrior(px, py, pt, i); pw[i] = 1 / N; pl[i] = 0.5; }
    wSlow = wFast = 0; lhRatio = 1; lowCount = 0; seedT = simT; neff = N;
    lockedOnce = false; lockT = 0; lockRun = 0; state = 'Searching'; hyp.n = 0; est.ok = false;
  }
  function predict(md, mdth) {
    const sa = 0.002 + 0.06 * Math.abs(mdth);
    for (let i = 0; i < N; i++) { const t = pt[i] + mdth + gauss() * sa, d = md * (1 + gauss() * 0.03); pt[i] = t; px[i] += d * Math.cos(t); py[i] += d * Math.sin(t); }
  }
  function likelihood(x, y, t) {
    const gx = ((x + M) / CS) | 0, gy = ((y + M) / CS) | 0;
    if (gx < 0 || gy < 0 || gx >= FW || gy >= FH) return EPS;
    const k = gy * FW + gx, d = fDist[k];
    let L = Math.exp(-0.5 * d * d * INV_SD2);
    if (!fJun[k]) { let da = t - fAng[k]; da -= Math.PI * Math.round(da / Math.PI); L *= Math.exp(-0.5 * da * da * INV_SA2); }
    return L + EPS;
  }
  function measurementUpdate() {
    let sum = 0;
    for (let i = 0; i < N; i++) { const L = likelihood(px[i], py[i], pt[i]); pl[i] = L; const w = pw[i] * L; pw[i] = w; sum += w; }
    if (wSlow === 0) wSlow = wFast = sum;
    wSlow += 0.01 * (sum - wSlow); wFast += 0.2 * (sum - wFast); lhRatio = wFast / wSlow;
    const inv = 1 / sum; let s2 = 0;
    for (let i = 0; i < N; i++) { pw[i] *= inv; s2 += pw[i] * pw[i]; }
    neff = 1 / s2;
    lowCount = lhRatio < 0.25 ? lowCount + 1 : 0;
    if (lockedOnce && lowCount >= 3 && simT - seedT > 6) { event('Lock lost, searching again'); seedFilter(true); return; }
    if (neff < N * 0.5) resample();
    // A trickle of fresh road hypotheses while searching, so an early loss of the true cluster can recover.
    if ((state === 'Searching' || state === 'Lost') && simT - seedT > 1) {
      const nInj = Math.round(N * 0.008), w0 = 1 / N;
      for (let j = 0; j < nInj; j++) { const i = (rnd() * N) | 0; samplePrior(px, py, pt, i); pw[i] = w0; pl[i] = 0.3; }
      let t = 0; for (let i = 0; i < N; i++) t += pw[i];
      const iv = 1 / t; for (let i = 0; i < N; i++) pw[i] *= iv;
    }
  }
  function resample() {
    // Adaptive sample size: about 70 particles per occupied 40 m cell, like KLD sampling.
    sup.fill(0); let occ = 0;
    for (let i = 0; i < N; i++) {
      if (pw[i] * N < 0.05) continue;
      const hx = ((px[i] + M) / HB) | 0, hy = ((py[i] + M) / HB) | 0;
      if (hx >= 0 && hy >= 0 && hx < HW && hy < HH) { const q = hy * HW + hx; if (!sup[q]) { sup[q] = 1; occ++; } }
    }
    const Nn = clamp(occ * 70, NMIN, NMAX), step = 1 / Nn;
    let u = rnd() * step, c = pw[0], i = 0;
    for (let m = 0; m < Nn; m++) {
      const U = u + m * step;
      while (U > c && i < N - 1) { i++; c += pw[i]; }
      qx[m] = px[i] + gauss() * 0.6; qy[m] = py[i] + gauss() * 0.6; qt[m] = pt[i] + gauss() * 0.008; ql[m] = pl[i];
    }
    let t;
    t = px; px = qx; qx = t; t = py; py = qy; qy = t; t = pt; pt = qt; qt = t; t = pl; pl = ql; ql = t;
    N = Nn; for (let m = 0; m < N; m++) pw[m] = 1 / N;
  }
  function estimate() {
    hist.fill(0); sup.fill(0);
    for (let i = 0; i < N; i++) { const hx = ((px[i] + M) / HB) | 0, hy = ((py[i] + M) / HB) | 0; if (hx >= 0 && hy >= 0 && hx < HW && hy < HH) hist[hy * HW + hx] += pw[i]; }
    for (let hy = 0; hy < HH; hy++) for (let hx = 0; hx < HW; hx++) {
      let v = 0;
      for (let oy = -1; oy <= 1; oy++) { const yy = hy + oy; if (yy < 0 || yy >= HH) continue; for (let ox = -1; ox <= 1; ox++) { const xx = hx + ox; if (xx >= 0 && xx < HW) v += hist[yy * HW + xx]; } }
      box[hy * HW + hx] = v;
    }
    hyp.n = 0;
    const R2 = 75 * 75;
    for (let r = 0; r < 3; r++) {
      let bi = -1, bv = 0.015;
      for (let k = 0; k < box.length; k++) if (!sup[k] && box[k] > bv) { bv = box[k]; bi = k; }
      if (bi < 0) break;
      const bx = bi % HW, by = (bi / HW) | 0;
      for (let oy = -4; oy <= 4; oy++) for (let ox = -4; ox <= 4; ox++) { const xx = bx + ox, yy = by + oy; if (xx >= 0 && yy >= 0 && xx < HW && yy < HH) sup[yy * HW + xx] = 1; }
      const cx = (bx + 0.5) * HB - M, cy = (by + 0.5) * HB - M;
      let sw = 0, mx = 0, my = 0;
      for (let i = 0; i < N; i++) { const dx = px[i] - cx, dy = py[i] - cy; if (dx * dx + dy * dy < R2) { sw += pw[i]; mx += pw[i] * px[i]; my += pw[i] * py[i]; } }
      if (sw <= 0) continue;
      hyp.x[hyp.n] = mx / sw; hyp.y[hyp.n] = my / sw; hyp.m[hyp.n] = sw; hyp.n++;
    }
    if (!hyp.n) { est.ok = false; return; }
    const cx = hyp.x[0], cy = hyp.y[0];
    let sw = 0, mx = 0, my = 0, cs = 0, sn = 0;
    for (let i = 0; i < N; i++) { const dx = px[i] - cx, dy = py[i] - cy; if (dx * dx + dy * dy < R2) { const w = pw[i]; sw += w; mx += w * px[i]; my += w * py[i]; cs += w * Math.cos(pt[i]); sn += w * Math.sin(pt[i]); } }
    mx /= sw; my /= sw;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < N; i++) { const dx = px[i] - mx, dy = py[i] - my; if ((px[i] - cx) ** 2 + (py[i] - cy) ** 2 < R2) { const w = pw[i] / sw; sxx += w * dx * dx; syy += w * dy * dy; sxy += w * dx * dy; } }
    est.ok = true; est.x = mx; est.y = my; est.th = Math.atan2(sn, cs); est.frac = sw; est.sxx = sxx; est.syy = syy; est.sxy = sxy;
    const tr = sxx + syy, det = sxx * syy - sxy * sxy;
    est.sig = Math.sqrt(Math.max(0, tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det))));
    const prev = state;
    if (lockedOnce && lhRatio < 0.45) state = 'Lost';
    else if (est.frac > 0.85 && est.sig < 14 && ++lockRun >= 12) state = 'Locked';
    else if (est.frac > 0.85 && est.sig < 14) state = 'Converging';
    else if (est.frac > 0.4) { state = 'Converging'; lockRun = 0; }
    else { state = 'Searching'; lockRun = 0; }
    if (state === 'Locked' && prev !== 'Locked') {
      lockReal = performance.now();
      if (!lockedOnce) { lockedOnce = true; lockT = (simT - seedT) / TS; lockFx = performance.now(); event(`Locked in ${lockT.toFixed(1)} s`); }
    }
  }

  /* ---------- Traces ---------- */
  const TR = 900, trT = new Float32Array(TR * 2).fill(NaN), trE = new Float32Array(TR * 2).fill(NaN);
  let trHead = 0;
  const disp = { x: 0, y: 0, a: 0, b: 0, ang: 0, th: 0, alpha: 0 };
  function pushTrace(gap) {
    trT[trHead * 2] = gap ? NaN : veh.x; trT[trHead * 2 + 1] = veh.y;
    trE[trHead * 2] = !gap && disp.alpha > 0.6 && state === 'Locked' ? disp.x : NaN; trE[trHead * 2 + 1] = disp.y;
    trHead = (trHead + 1) % TR;
  }
  function simStep() {
    const x0 = veh.x, y0 = veh.y, t0 = veh.th;
    stepVehicle(DT);
    const d = Math.hypot(veh.x - x0, veh.y - y0), dth = wrapPi(veh.th - t0);
    predict(d * (1 + ODO_SCALE) + gauss() * 0.02 * d, dth + GYRO_BIAS * DT + gauss() * 0.0012);
    stepCount++; simT += DT;
    if (stepCount % 3 === 0) pushTrace(false);
    if (stepCount % UPD === 0) { measurementUpdate(); estimate(); lastErr = est.ok ? Math.hypot(est.x - veh.x, est.y - veh.y) : NaN; }
  }

  /* ---------- Interaction ---------- */
  let dropFx = null, lastEvent = '';
  let eventN = 0;
  function event(msg) { lastEvent = msg; eventN++; }
  function nearestRoad(x, y) {
    let best = -1, bd = 1e18, bt = 0;
    for (let j = 0; j < driveIdx.length; j++) {
      const k = driveIdx[j], e = edges[k], ax = nX[e.a], ay = nY[e.a];
      const t = clamp((x - ax) * e.ux + (y - ay) * e.uy, 0, e.len), d = (ax + e.ux * t - x) ** 2 + (ay + e.uy * t - y) ** 2;
      if (d < bd) { bd = d; best = k; bt = t; }
    }
    return best < 0 ? null : { k: best, t: bt, d: Math.sqrt(bd) };
  }
  // Reduced motion shows a settled frame instead of animation; the steps run in chunks so the page never freezes.
  // Time-sliced (about 8 ms per slice), and a newer drop or boot cancels a run that is still going.
  let preTok = 0;
  async function prerun(n, gen) {
    const tok = ++preTok;
    let slice = performance.now();
    for (let i = 0; i < n; i++) {
      simStep(); if (stepCount % UPD === 0) smoothDisplay(true);
      if (performance.now() - slice > 8) { await yieldTask(); if (gen !== bootGen || tok !== preTok) return false; slice = performance.now(); }
    }
    lockFx = -1; dropFx = null; return true;
  }
  function dropAt(wx, wy, auto) {
    if (!built) return;
    const r = nearestRoad(wx, wy);
    if (!r) return;
    const e = edges[r.k], dir = rnd() < 0.5 ? 1 : -1, f = clamp(r.t / e.len, 0.2, 0.75);
    placeVehicle(r.k, dir, dir > 0 ? f : 1 - f);
    pushTrace(true); trE.fill(NaN);
    seedFilter(true); disp.alpha = 0;
    event(auto ? 'Moved the car. Searching again' : 'You moved the car. Searching again');
    dropFx = { x: veh.x, y: veh.y, t: performance.now() };
    if (reduceMotion) { tween0 = -1; prerun(1200, bootGen).then(ok => { if (ok) { render(performance.now()); report(); } }); }
  }

  /* ---------- Rendering ---------- */
  function smoothDisplay(snap) {
    const show = est.ok && (state === 'Locked' || state === 'Converging' || state === 'Lost');
    disp.alpha += ((show ? 1 : 0) - disp.alpha) * (snap ? 1 : 0.08);
    if (!est.ok) return;
    const tr = est.sxx + est.syy, dsc = Math.sqrt(Math.max(0, tr * tr / 4 - (est.sxx * est.syy - est.sxy * est.sxy)));
    const a = Math.max(6 / ppm, 2 * Math.sqrt(tr / 2 + dsc)), b = Math.max(6 / ppm, 2 * Math.sqrt(Math.max(0, tr / 2 - dsc)));
    const ang = 0.5 * Math.atan2(2 * est.sxy, est.sxx - est.syy);
    if (snap || Math.hypot(est.x - disp.x, est.y - disp.y) > 60 || disp.alpha < 0.05) { Object.assign(disp, { x: est.x, y: est.y, a, b, ang, th: est.th }); return; }
    const k = 0.16;
    disp.x += (est.x - disp.x) * k; disp.y += (est.y - disp.y) * k; disp.a += (a - disp.a) * k; disp.b += (b - disp.b) * k;
    let da = ang - disp.ang; da -= Math.PI * Math.round(da / Math.PI); disp.ang += da * k;
    disp.th += wrapPi(est.th - disp.th) * k;
  }
  // The same car as the hero: warm glow, headlight beam, body with windshield and rear window.
  const glowS = document.createElement('canvas'), beamS = document.createElement('canvas');
  {
    glowS.width = glowS.height = 64;
    let g = glowS.getContext('2d'), rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, 'rgba(255,140,90,.32)'); rg.addColorStop(1, 'rgba(255,140,90,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
    beamS.width = 96; beamS.height = 48; g = beamS.getContext('2d');
    rg = g.createRadialGradient(0, 24, 0, 0, 24, 96);
    rg.addColorStop(0, 'rgba(255,236,214,.34)'); rg.addColorStop(1, 'rgba(255,236,214,0)');
    g.fillStyle = rg; g.beginPath(); g.moveTo(0, 18); g.lineTo(96, 0); g.lineTo(96, 48); g.lineTo(0, 30); g.closePath(); g.fill();
  }
  const rrect = (c, x, y, w, h, r) => {
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }   // Safari before 16, Firefox before 112
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  };
  function drawCar(x, y, ang) {
    const u = 1 / ppm;   // sizes below are screen px, same as the hero
    fx.drawImage(glowS, x - 22 * u, y - 22 * u, 44 * u, 44 * u);
    fx.save(); fx.translate(x, y); fx.rotate(ang); fx.scale(u, u);
    fx.drawImage(beamS, 7, -12, 46, 24);
    fx.fillStyle = 'rgba(0,0,0,.55)'; fx.beginPath(); rrect(fx, -7.6, -4, 16.2, 9, 3); fx.fill();
    fx.fillStyle = '#efede8'; fx.beginPath(); rrect(fx, -7.5, -3.9, 15, 7.8, 2.8); fx.fill();
    fx.fillStyle = '#26292a';
    fx.beginPath(); rrect(fx, 1.4, -3, 2.9, 6, 1); fx.fill();
    fx.beginPath(); rrect(fx, -5.6, -2.8, 1.8, 5.6, .8); fx.fill();
    fx.restore();
  }
  function strokeTrail(buf, rgb, maxA, w) {
    // Opacity follows a continuous curve; a new piece starts only when the 8-bit alpha changes.
    // Flat caps keep neighbouring pieces from overlapping into visible seams.
    fx.lineWidth = w / ppm; fx.lineCap = 'butt';
    const top = maxA * 255;
    let lvl = -1, pen = false, lx = 0, ly = 0;
    for (let j = 0; j < TR; j++) {
      const q = ((trHead + j) % TR) * 2, x = buf[q], y = buf[q + 1];
      if (x !== x) { if (pen && lvl > 0) fx.stroke(); pen = false; lvl = -1; continue; }
      if (!pen) { lx = x; ly = y; pen = true; continue; }
      const a = Math.round(top * Math.pow((j + 1) / TR, 1.8));
      if (a !== lvl) { if (lvl > 0) fx.stroke(); lvl = a; fx.beginPath(); fx.moveTo(lx, ly); fx.strokeStyle = `rgba(${rgb},${(a / 255).toFixed(4)})`; }
      fx.lineTo(x, y); lx = x; ly = y;
    }
    if (pen && lvl > 0) fx.stroke();
    fx.lineCap = 'round';
  }
  let hover = null, hoverDirty = false, hx = 0, hy = 0;
  function render(now) {
    const k = ppm * DPR, tw = tween0 >= 0 ? (now - tween0) / 1000 : 9;
    if (tw > 1.3) tween0 = -1;
    const spread = clamp(est.ok ? est.frac : 0, 0, 1);
    const useGL = gl && !glLost;
    if (useGL) {
      for (let i = 0; i < N; i++) {
        let x = px[i], y = py[i];
        if (tween0 >= 0) { const u = ease3(clamp((tw - delay[i]) / 0.9, 0, 1)); x = fromX[i] + (x - fromX[i]) * u; y = fromY[i] + (y - fromY[i]) * u; }
        vbuf[i * 3] = x * k; vbuf[i * 3 + 1] = y * k; vbuf[i * 3 + 2] = pl[i] > 1 ? 1 : pl[i];
      }
      gl.viewport(0, 0, cvPf.width, cvPf.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindVertexArray(glVao); gl.bindBuffer(gl.ARRAY_BUFFER, glBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, vbuf, 0, N * 3);
      gl.uniform2f(uRes, cvPf.width, cvPf.height); gl.uniform1f(uSize, 3.2 * DPR); gl.uniform1f(uGain, 0.55 - 0.44 * spread * spread);
      gl.drawArrays(gl.POINTS, 0, N);
    }
    fx.setTransform(1, 0, 0, 1, 0, 0); fx.clearRect(0, 0, cvFx.width, cvFx.height);
    fx.setTransform(k, 0, 0, k, 0, 0); fx.lineCap = 'round'; fx.lineJoin = 'round';
    if (!useGL) { fx.fillStyle = 'rgba(255,122,69,0.45)'; for (let i = 0; i < N; i += 2) fx.fillRect(px[i], py[i], 1.6 / ppm, 1.6 / ppm); }
    // Competing hypotheses while searching: a quiet ring and share of probability.
    if (state !== 'Locked' && hyp.n && tween0 < 0) {
      fx.font = `400 ${11 / ppm}px "IBM Plex Mono", monospace`; fx.textBaseline = 'middle';
      for (let r = 0; r < hyp.n; r++) {
        const m = hyp.m[r]; if (m < 0.04) continue;
        const a = clamp(0.3 + m * 0.8, 0, 0.9), rad = (16 + 22 * Math.sqrt(m)) / ppm;
        fx.beginPath(); fx.arc(hyp.x[r], hyp.y[r], rad, 0, TAU);
        fx.strokeStyle = `rgba(255,160,120,${(a * 0.7).toFixed(2)})`; fx.lineWidth = 1 / ppm; fx.stroke();
        fx.fillStyle = `rgba(255,210,190,${a.toFixed(2)})`;
        // Keep the label inside the frame: flip it to the left of the ring near the right edge.
        const lbl = `${Math.round(m * 100)}%`, lw = fx.measureText(lbl).width;
        if (hyp.x[r] + rad + 6 / ppm + lw > W - 4 / ppm) { fx.textAlign = 'right'; fx.fillText(lbl, hyp.x[r] - rad - 6 / ppm, hyp.y[r]); fx.textAlign = 'left'; }
        else fx.fillText(lbl, hyp.x[r] + rad + 6 / ppm, hyp.y[r]);
      }
    }
    strokeTrail(trT, '236,234,229', 0.42, 1.4);
    strokeTrail(trE, '255,122,69', 0.95, 1.9);
    if (disp.alpha > 0.02) {
      fx.globalAlpha = disp.alpha;
      fx.beginPath(); fx.ellipse(disp.x, disp.y, disp.a, disp.b, disp.ang, 0, TAU);
      fx.fillStyle = 'rgba(255,122,69,0.08)'; fx.fill();
      fx.strokeStyle = 'rgba(255,122,69,0.85)'; fx.lineWidth = 1 / ppm; fx.stroke();
      fx.globalAlpha = 1;
    }
    drawCar(veh.x, veh.y, veh.th);
    if (lockFx > 0) {
      const a = (now - lockFx) / 1000;
      if (a > 1.6) lockFx = -1;
      else for (let r = 0; r < 2; r++) { const aa = a - r * 0.2; if (aa <= 0) continue; const u = Math.min(1, aa / 1.2); fx.beginPath(); fx.arc(veh.x, veh.y, (10 + ease3(u) * 40) / ppm, 0, TAU); fx.strokeStyle = `rgba(255,122,69,${(0.8 * (1 - u)).toFixed(3)})`; fx.lineWidth = 1.4 / ppm; fx.stroke(); }
    }
    if (dropFx) {
      const a = (now - dropFx.t) / 1000;
      if (a > 1.4) dropFx = null;
      else { const u = Math.min(1, a / 1.2); fx.beginPath(); fx.arc(dropFx.x, dropFx.y, (8 + ease3(u) * 80) / ppm, 0, TAU); fx.strokeStyle = `rgba(236,234,229,${(0.6 * (1 - u)).toFixed(3)})`; fx.lineWidth = 1.2 / ppm; fx.stroke(); }
    }
    // Hover preview of where a click puts the car.
    fx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (hoverDirty) { hoverDirty = false; const r = nearestRoad(hx / ppm, hy / ppm); hover = r && r.d * ppm < 60 ? { x: nX[edges[r.k].a] + edges[r.k].ux * r.t, y: nY[edges[r.k].a] + edges[r.k].uy * r.t } : null; }
    if (hover) {
      const x = hover.x * ppm, y = hover.y * ppm;
      fx.strokeStyle = 'rgba(236,234,229,0.7)'; fx.lineWidth = 1;
      fx.beginPath(); fx.arc(x, y, 7, 0, TAU); fx.stroke();
      fx.beginPath(); fx.arc(x, y, 1.5, 0, TAU); fx.fillStyle = 'rgba(236,234,229,0.9)'; fx.fill();
    }
  }
  let reportT = 0;
  function report() {
    onStatus({ state, err: lastErr, n: N, lockT: lockedOnce ? lockT : null, searchT: (simT - seedT) / TS, event: lastEvent, eventN, hyp: hyp.n });
  }

  /* ---------- Loop ---------- */
  let running = false, raf = 0, last = 0, acc = 0, visible = false, lastDraw = -1e9;
  function frame(t) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(0.1, (t - last) / 1000) : STEP; last = t;
    acc += dt; let n = 0;
    while (acc >= STEP && n < 3) { simStep(); acc -= STEP; n++; }
    if (n === 3) acc = 0;
    smoothDisplay(false);
    if (t - lastDraw > 11) { lastDraw = t; render(t); }   // full rate up to 90 Hz, about 60 fps above that
    if (t - reportT > 150) { reportT = t; report(); }
  }
  function setRunning() {
    const should = built && !reduceMotion && !document.hidden && visible;
    if (should && !running) { running = true; last = 0; raf = requestAnimationFrame(frame); }
    else if (!should && running) { running = false; cancelAnimationFrame(raf); }
  }
  document.addEventListener('visibilitychange', setRunning);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; setRunning(); }, { rootMargin: '120px' }).observe(container);
  const local = ev => { const r = cvFx.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  cvFx.addEventListener('click', ev => { const [x, y] = local(ev); dropAt(x / ppm, y / ppm, false); });
  if (matchMedia('(pointer: fine)').matches) {
    cvFx.addEventListener('pointermove', ev => { if (!built) return; [hx, hy] = local(ev); hoverDirty = true; if (!running) render(performance.now()); });
    cvFx.addEventListener('pointerleave', () => { hover = null; hoverDirty = false; if (built && !running) render(performance.now()); });
  }

  async function boot() {
    const gen = ++bootGen;
    built = false; setRunning();
    rs = (+(new URLSearchParams(location.search).get('seed')) || 88172645) >>> 0;
    if (!(await buildWorld(gen))) return;
    let startE = driveIdx[0];
    for (let j = 0; j < driveIdx.length; j++) { const k = driveIdx[j], e = edges[k]; if (inFocus(e.a) && inFocus(e.b)) { startE = k; if (rnd() < 0.15) break; } }
    placeVehicle(startE, 1, 0.3);
    simT = 0; stepCount = 0; trT.fill(NaN); trE.fill(NaN);
    seedFilter(false); event('GPS denied. Searching');
    if (reduceMotion && !(await prerun(1500, gen))) return;
    built = true;
    render(performance.now()); report(); setRunning();
  }
  // The city is only built when the exhibit comes within about a screen of the viewport, so it costs nothing at page load.
  let lastW = 0, rz = 0, started = false;
  new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => { const w = Math.round(container.getBoundingClientRect().width); if (started && w !== lastW) { lastW = w; boot(); } }, 150); }).observe(container);
  const near = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting || started) return;
    started = true; near.disconnect();
    lastW = Math.round(container.getBoundingClientRect().width); boot();
  }, { rootMargin: '100% 0px' });
  near.observe(container);

  const api = {
    state: () => ({ state, err: lastErr, frac: est.frac, hyp: hyp.n, simT, neff, n: N, locked: lockedOnce, ttl: lockT }),
    near: r => { let c = 0; for (let i = 0; i < N; i++) if ((px[i] - veh.x) ** 2 + (py[i] - veh.y) ** 2 < r * r) c++; return c; },
    run: n => { const out = []; for (let i = 0; i < n; i++) { simStep(); if (stepCount % UPD === 0) out.push([+(simT / TS).toFixed(1), 0, 0, 0, 0, api.near(30), state, +lastErr.toFixed(1), +lhRatio.toFixed(2)]); } return out; },
    seq: () => Array.from(seq.subarray(0, Math.min(seqN, 4096))),
    ready: () => built,
    dropRandom: () => { if (!built) return; const c = driveIdx[(rnd() * driveIdx.length) | 0], e = edges[c]; dropAt((nX[e.a] + nX[e.b]) / 2, (nY[e.a] + nY[e.b]) / 2, true); },
    bench: () => { let t0 = performance.now(); for (let i = 0; i < 60; i++) simStep(); const ts = performance.now() - t0; t0 = performance.now(); for (let i = 0; i < 30; i++) render(performance.now()); return { simMsPerStep: ts / 60, renderMs: (performance.now() - t0) / 30 }; },
  };
  return api;
}

window.Localize = { create };
})();
