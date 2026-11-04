// Wires the two live pieces of the page: the hero terrain and the particle-filter exhibit.
// All copy lives in index.html; this file only drives the visuals, the confidence meter and the screen-reader status.
(function () {
'use strict';
const $ = id => document.getElementById(id);
const debug = new URLSearchParams(location.search).has('debug');

$('year').textContent = String(new Date().getFullYear());

/* Floating nav: shown once the hero's own nav has scrolled away; marks the section in view. */
{
  const pill = $('pill'), links = [...pill.querySelectorAll('a[href^="#"]:not(.pill-brand)')];
  new IntersectionObserver(([e]) => { const on = !e.isIntersecting; pill.classList.toggle('show', on); pill.inert = !on; }, { rootMargin: '-30% 0px 0px 0px' }).observe($('top'));
  const seen = new Map();
  const io = new IntersectionObserver(es => {
    for (const e of es) seen.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
    let best = '', r = 0; for (const [id, v] of seen) if (v > r) { r = v; best = id; }
    for (const a of links) a.setAttribute('aria-current', String(a.getAttribute('href') === `#${best}`));
  }, { threshold: [0, .15, .3, .5, .75, 1], rootMargin: '-40% 0px -40% 0px' });
  for (const a of links) { const t = document.querySelector(a.getAttribute('href')); if (t) io.observe(t); }
}

/* Reveal on scroll: below-the-fold blocks rise in once as they arrive. Anything already on screen is left alone. */
if (!matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
  const groups = ['.marks li', '.intro-text', '.stats > div', '.portrait', '.work h2', '.work-lede', '.exhibit', '.stack > div', '.record h2', '.rows-h', '.row', '.contact-h', '.contact-links'];
  const els = groups.flatMap(q => [...document.querySelectorAll(q)]);
  const io = new IntersectionObserver(es => {
    for (const e of es) {
      const el = e.target;
      if (!el.dataset.rv) {   // first report: hide only what is still below the fold
        el.dataset.rv = '1';
        if (e.boundingClientRect.top >= innerHeight) { el.classList.add('rv'); continue; }
        io.unobserve(el); continue;
      }
      if (e.isIntersecting) { el.classList.add('in'); io.unobserve(el); }
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  // Siblings in a row arrive one after another.
  for (const q of ['.marks li', '.stats > div', '.stack > div', '.row']) document.querySelectorAll(q).forEach((el, i, all) => { const sib = [...el.parentNode.children].indexOf(el); el.style.setProperty('--d', `${Math.min(sib, 5) * 70}ms`); });
  els.forEach(el => io.observe(el));
  // Keyboard focus can land on a block that has not been revealed yet (the browser scrolls it only to the very edge).
  document.addEventListener('focusin', e => { const el = e.target.closest('.rv'); if (el) { el.classList.add('in'); io.unobserve(el); } });
}

/* Press marks: hovering or focusing one names what it is, in a quiet line under the row. */
{
  const note = document.querySelector('.marks-note');
  let hideT = 0;
  for (const a of document.querySelectorAll('.marks a')) {
    const show = () => { clearTimeout(hideT); note.textContent = a.dataset.note; note.classList.add('on'); };
    const hide = () => { clearTimeout(hideT); hideT = setTimeout(() => note.classList.remove('on'), 140); };
    a.addEventListener('mouseenter', show); a.addEventListener('focus', show);
    a.addEventListener('mouseleave', hide); a.addEventListener('blur', hide);
  }
}

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
  if (terrain.stats.ready || terrain.stats.error || performance.now() - t0 > 3000) { loadExhibit(); return; }
  setTimeout(() => waitHero(t0), 50);
})(performance.now());
addEventListener('scroll', loadExhibit, { once: true, passive: true });   // a reader heading down gets it sooner
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
  return 'Searching for the car.';
};
const pf = window.Localize.create(frame, {
  onStatus: s => {
    const locked = s.state === 'Locked', p = Math.round((locked ? 1 : s.frac) * 100);
    if (p !== lastPct) { lastPct = p; bar.style.width = `${p}%`; pct.textContent = `${p}%`; }
    if (s.eventN !== lastEventN) { lastEventN = s.eventN; announce(spoken(s.event)); }
  },
});
// Keyboard users move the car with Enter or Space (held keys do not repeat). Screen readers activate the
// frame with a synthesized click on the frame itself; real pointer clicks land on the canvas inside it.
frame.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); pf.dropRandom(); } });
frame.addEventListener('click', e => { if (e.target === frame) pf.dropRandom(); });

if (debug) window.__pf = pf;
}
})();
