// Wires the two live pieces of the page: the hero terrain and the particle-filter exhibit.
// All copy lives in index.html; this file only drives the visuals, the confidence meter and the screen-reader status.
(function () {
'use strict';
const $ = id => document.getElementById(id);
const debug = new URLSearchParams(location.search).has('debug');

$('year').textContent = String(new Date().getFullYear());

/* Hero terrain, with one line of live data under it: where the car is, or the point under the cursor */
const readout = $('readout');
const REST = readout.textContent;
let lastKind = '';
const deg = (v, pos, neg) => `${Math.abs(v).toFixed(4)}\u00b0\u202f${v >= 0 ? pos : neg}`;
const terrain = window.Terrain.init({
  hero: $('top'), canvas: $('terrain'), overlay: $('terrain-ov'),
  // The drive loop is framed to stay clear of these.
  avoid: ['.eyebrow', '.hero h1', '.lede', '.nav', '.hero-foot'].map(q => document.querySelector(q)),
  labels: [
    { name: 'Mt. Bonnell', lat: 30.3207, lon: -97.7735, peak: true },
    { name: 'Lake Austin', x: 1157, y: 660, rot: -83, water: true },
    { name: 'Lady Bird Lake', x: 1222, y: 912, rot: 47, water: true },
  ],
  onReadout: r => {
    if (!r) { lastKind = ''; readout.className = 'readout'; readout.textContent = REST; return; }
    // The marker matches what is on the map: a dot for the car, a ring for the cursor.
    if (r.kind !== lastKind) { lastKind = r.kind; readout.className = `readout live ${r.kind}`; }
    const b = document.createElement('b'); b.textContent = `${Math.round(r.m)} m`;
    const tail = r.kind === 'cursor' ? ` (${Math.round(r.m * 3.28084).toLocaleString()} ft)${r.water ? ', water' : ''}` : '';
    readout.replaceChildren(`${deg(r.lat, 'N', 'S')}, ${deg(r.lon, 'E', 'W')}\u2003`, b, tail);
  },
});

if (debug) window.__terrain = terrain;

/* Exhibit: particle filter. A confidence meter under the map, plus a polite announcement on state changes.
   Its script loads once the hero has drawn (or after a few seconds at most), so it never competes with the hero. */
const loadExhibit = () => {
  if (loadExhibit.done) return; loadExhibit.done = true;
  const s = document.createElement('script'); s.src = 'assets/js/localize.js'; s.onload = initExhibit; document.head.appendChild(s);
};
(function waitHero(t0) {
  if (terrain.stats.ready || terrain.stats.error || performance.now() - t0 > 3000) { setTimeout(loadExhibit, 200); return; }
  setTimeout(() => waitHero(t0), 100);
})(performance.now());
function initExhibit() {
const frame = $('pf'), bar = $('pf-bar'), pct = $('pf-pct'), live = $('pf-live');
if (matchMedia('(pointer: coarse)').matches) $('pf-hint').textContent = 'Tap the map to move the car.';
let lastPct = -1, lastEventN = -1;
// Announce each event (search started, car moved, car located). Clearing first makes a repeated message speak again.
const announce = msg => { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 60); };
const spoken = e => {
  const lock = /^Locked in ([\d.]+) s/.exec(e);
  if (lock) return `Car located in ${lock[1]} seconds.`;
  if (/moved the car/i.test(e)) return 'Car moved. Searching again.';
  if (/lock lost/i.test(e)) return 'Lock lost. Searching again.';
  if (/GPS jammed/.test(e)) return 'GPS jammed, then spoofed away from the car. The estimate stays on the car.';
  if (/GPS restored/.test(e)) return 'GPS restored.';
  return 'Searching for the car.';
};
// Jam GPS: the button follows the demo's GPS state, and pulses once to invite a press when the car is first found.
const jam = $('pf-jam'), jamT = jam.querySelector('.jam-t');
let jammed = false, invited = false;
const setJamUi = on => { if (on === jammed) return; jammed = on; jam.setAttribute('aria-pressed', String(on)); jamT.textContent = on ? 'Restore GPS' : 'Jam GPS'; };
const pf = window.Localize.create(frame, {
  onStatus: s => {
    const locked = s.state === 'Locked', p = Math.round((locked ? 1 : s.frac) * 100);
    if (p !== lastPct) { lastPct = p; bar.style.width = `${p}%`; pct.textContent = `${p}%`; }
    if (s.eventN !== lastEventN) { lastEventN = s.eventN; announce(spoken(s.event)); }
    setJamUi(s.gps.mode === 1 || s.gps.mode === 2);
    if (!invited && s.lockT != null && !jammed) { invited = true; jam.classList.add('invite'); }
  },
});
jam.addEventListener('click', () => pf.jam(!jammed));
jam.addEventListener('animationend', () => jam.classList.remove('invite'));
jam.disabled = false;
// Keyboard users move the car with Enter or Space (held keys do not repeat). Screen readers activate the
// frame with a synthesized click on the frame itself; real pointer clicks land on the canvas inside it.
frame.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); pf.dropRandom(); } });
frame.addEventListener('click', e => { if (e.target === frame) pf.dropRandom(); });

if (debug) window.__pf = pf;
}
})();
