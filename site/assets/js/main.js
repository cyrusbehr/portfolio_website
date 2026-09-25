// Wires the two live pieces of the page: the hero terrain and the particle-filter exhibit.
// All copy lives in index.html; this file only drives the visuals, the confidence meter and the screen-reader status.
(function () {
'use strict';
const $ = id => document.getElementById(id);
const debug = new URLSearchParams(location.search).has('debug');

$('year').textContent = String(new Date().getFullYear());

/* Hero terrain, with a cursor probe that reads the real elevation under the pointer */
const readout = $('readout');
const REST = matchMedia('(max-width: 700px)').matches ? 'West Austin, from USGS elevation data' : readout.textContent;
readout.textContent = REST;
let lastReadout = REST;
const deg = (v, pos, neg) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? pos : neg}`;
const terrain = window.Terrain.init({
  hero: $('top'), canvas: $('terrain'), overlay: $('terrain-ov'),
  labels: [
    { name: 'Mt. Bonnell', lat: 30.3207, lon: -97.7735, peak: true },
    { name: 'Lake Austin', x: 1157, y: 660, rot: -83, water: true },
    { name: 'Lady Bird Lake', x: 1222, y: 912, rot: 47, water: true },
  ],
  onProbe: p => {
    const m = p ? `${Math.round(p.m)} m` : '', rest = p ? ` (${Math.round(p.m * 3.28084).toLocaleString()} ft)${p.water ? ', water' : ''}\u2003${deg(p.lat, 'N', 'S')}, ${deg(p.lon, 'E', 'W')}` : REST;
    if (m + rest === lastReadout) return;            // only touch the DOM when the reading changes
    lastReadout = m + rest;
    if (!p) { readout.textContent = REST; return; }
    const b = document.createElement('b'); b.textContent = m;
    readout.replaceChildren(b, rest);
  },
});

/* Exhibit: particle filter. A confidence meter under the map, plus a polite announcement on state changes. */
const frame = $('pf'), meter = $('pf-meter'), bar = $('pf-bar'), pct = $('pf-pct'), live = $('pf-live');
if (matchMedia('(pointer: coarse)').matches) $('pf-hint').textContent = 'Tap the map to move the car.';
let lastPct = -1, lastLocked = null, lastEventN = -1;
// Announce each event (search started, car moved, car located). Clearing first makes a repeated message speak again.
const announce = msg => { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 60); };
const spoken = e => {
  const lock = /^Locked in ([\d.]+) s/.exec(e);
  if (lock) return `Car located in ${lock[1]} seconds.`;
  if (/moved the car/i.test(e)) return 'Car moved. Searching again.';
  if (/lock lost/i.test(e)) return 'Lock lost. Searching again.';
  return 'Searching for the car.';
};
const pf = window.Localize.create(frame, {
  onStatus: s => {
    const locked = s.state === 'Locked', p = Math.round((locked ? 1 : s.frac) * 100);
    if (p !== lastPct) { lastPct = p; bar.style.width = `${p}%`; pct.textContent = `${p}%`; }
    if (locked !== lastLocked) { lastLocked = locked; meter.classList.toggle('done', locked); }
    if (s.eventN !== lastEventN) { lastEventN = s.eventN; announce(spoken(s.event)); }
  },
});
// Keyboard users move the car with Enter or Space (held keys do not repeat). Screen readers activate the
// frame with a synthesized click on the frame itself; real pointer clicks land on the canvas inside it.
frame.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); pf.dropRandom(); } });
frame.addEventListener('click', e => { if (e.target === frame) pf.dropRandom(); });

if (debug) { window.__terrain = terrain; window.__pf = pf; }
})();
