// Wires the two live pieces of the page: the hero terrain and the particle-filter exhibit.
// All copy lives in index.html; this file only drives the visuals and their status text.
(function () {
'use strict';
const $ = id => document.getElementById(id);
const debug = new URLSearchParams(location.search).has('debug');

$('year').textContent = String(new Date().getFullYear());

/* Hero terrain, with a cursor probe that reads the real elevation under the pointer */
const readout = $('readout');
const REST = matchMedia('(max-width: 700px)').matches ? 'West Austin, from USGS elevation data' : readout.textContent;
readout.textContent = REST;
const deg = (v, pos, neg) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? pos : neg}`;
const terrain = window.Terrain.init({
  hero: $('top'), canvas: $('terrain'), overlay: $('terrain-ov'),
  labels: [
    { name: 'Mt. Bonnell', lat: 30.3207, lon: -97.7735, peak: true },
    { name: 'Lake Austin', x: 1157, y: 660, rot: -83, water: true },
    { name: 'Lady Bird Lake', x: 1222, y: 912, rot: 47, water: true },
  ],
  onProbe: p => {
    if (!p) { readout.textContent = REST; return; }
    const ft = Math.round(p.m * 3.28084).toLocaleString();
    readout.replaceChildren();
    const b = document.createElement('b'); b.textContent = `${Math.round(p.m)} m`;
    readout.append(b, ` (${ft} ft)${p.water ? ', water' : ''}\u2003${deg(p.lat, 'N', 'S')}, ${deg(p.lon, 'E', 'W')}`);
  },
});

/* Exhibit: particle filter. Status line under the map, plus a polite announcement on state changes. */
const frame = $('pf'), dot = $('pf-dot'), st = $('pf-state'), det = $('pf-detail'), live = $('pf-live');
let lastLabel = '';
const pf = window.Localize.create(frame, {
  onStatus: s => {
    const locked = s.state === 'Locked';
    dot.className = locked ? 'lock' : '';
    const label = locked ? 'Locked' : s.state === 'Lost' ? 'Lost' : s.state === 'Converging' ? 'Converging' : 'Searching';
    if (label !== lastLabel) {
      st.textContent = label; lastLabel = label;
      live.textContent = locked ? `Car located in ${s.lockT.toFixed(1)} seconds.` : label === 'Searching' ? 'Searching for the car.' : '';
    }
    det.textContent = locked
      ? `in ${s.lockT.toFixed(1)} s, error ${s.err < 10 ? s.err.toFixed(1) : Math.round(s.err)} m, ${s.n.toLocaleString()} particles`
      : `${s.n.toLocaleString()} particles, ${s.searchT.toFixed(1)} s`;
  },
});
// Keyboard users move the car with Enter or Space.
frame.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pf.dropRandom(); } });

if (debug) { window.__terrain = terrain; window.__pf = pf; }
})();
