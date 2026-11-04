# cyrusbehr.com

Personal site of Cyrus Behroozi, Director of Engineering at Tern. A single static page with no framework and no build step.

- **Hero:** real west Austin terrain drawn live on the GPU as a contoured 3D relief, with OpenStreetMap roads draped over it and a car looping on real streets. On load the flat map tilts up into 3D while the relief rises; then it drifts slowly and follows the pointer. The line under it reads out the car's position and elevation, or the point under the cursor.
- **Exhibit:** a live particle filter that works out where a car is using only its motion and the road map. Once it locks on, the camera glides in and follows the car. Click the map to move the car and watch it search again.

## Layout

```
site/                     everything that ships (Netlify publishes this folder)
  index.html              all copy lives here
  404.html
  assets/css/site.css
  assets/js/terrain.js    hero: WebGL2 3D terrain (mesh, per-pixel contours, draped roads), framing solver, CPU fallback
  assets/js/localize.js   exhibit: particle filter, procedural city, vehicle model, follow camera
  assets/js/main.js       wires everything: hero readout, exhibit (loaded after the hero draws), nav, reveals
  assets/data/            elevation (Terrarium-encoded lossless WebP), its inlined quarter-resolution preview, roads
  assets/fonts/           self-hosted Schibsted Grotesk and IBM Plex Mono (latin subsets)
  assets/img/             portrait
tools/build_roads.py      rebuilds the roads file and the car's loop from OpenStreetMap
tools/build_dem_preview.py  rebuilds the quarter-resolution elevation preview from the full file
netlify.toml              publish settings, security headers (CSP), caching
```

## Preview locally

Any static server works. Opened straight from disk (`file://`) the page still works, but the hero stays on its quarter-resolution preview because browsers block `fetch` there, and the web fonts do not load.

```sh
python3 -m http.server 8000 --directory site
```

Then open http://localhost:8000. Add `?debug` to expose `window.__terrain` and `window.__pf` in the console, and `?seed=<n>` to reproduce a particular particle-filter run.

The hero's first frame comes from the inlined preview (`assets/data/austin-dem-q4.v1.js`, about 120 KB); the full elevation file and the roads download only after that frame, and the exhibit's script after that, so on a slow connection none of them delays the hero.

## Editing

- **Copy:** edit `site/index.html` directly.
- **Cached assets:** files under `assets/data`, `assets/fonts`, `assets/img`, and `og.v1.jpg` are served with a one-year immutable cache. When you change one, bump the `.v1` in its file name and in every reference to it.
- **Roads or the car's loop:** `python3 tools/build_roads.py --out site/assets/data/austin-roads.v2.js`, then point `ROADS.url` in `terrain.js` at the new file (needs network access to the Overpass API). Writing over the `.v1` file would leave visitors on the cached copy for a year. The roads ship as a script (it sets `window.TerrainRoads`) so they load from `file://` too. If the loop itself changes, also regenerate `LOOP_PTS` in `terrain.js` (every fourth route point), which the hero uses to frame itself before the roads arrive.
- **Elevation:** if the elevation file changes, rebuild the preview with `python3 tools/build_dem_preview.py site/assets/data/austin-dem.v2.webp site/assets/data/austin-dem-q4.v2.js` and update both references.
- **Hero camera:** the viewing angles are set per layout in `layout()` in `terrain.js`; the target shift and distance are solved per screen in `solveFraming()` so the drive loop stays clear of the copy. With `?debug`, `__terrain.pose` can be edited live and `__terrain.stats` shows the framing, mesh size, and timings.

## Deploy

Netlify builds from `master`. `netlify.toml` sets the publish folder to `site/`, replaces the old Gatsby build command with a no-op, and skips the Gatsby runtime plugin, so a push to `master` deploys. Pull requests get a Deploy Preview.

`site/sw.js` is not a feature: it retires the service worker the old Gatsby site installed, so returning visitors are not stuck on cached pages. Keep it.

## Data and credits

- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (USGS 3DEP and SRTM), z13, cropped and stored in Terrarium encoding. The lowest bit of blue marks water, derived from the flat lake surfaces in the elevation data itself.
- Roads: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
- Fonts: Schibsted Grotesk and IBM Plex Mono, both SIL Open Font License 1.1 (license texts in `site/assets/fonts/`).
