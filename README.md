# cyrusbehr.com

Personal site of Cyrus Behroozi, Director of Engineering at Tern. A single static page with no framework and no build step.

- **Hero:** real west Austin terrain, contoured live on the GPU from USGS elevation data, with a car looping on real OpenStreetMap roads. The cursor reads the true elevation under it.
- **Exhibit:** a live particle filter that works out where a car is using only its motion and the road map. Click the map to move the car and watch it search again.

## Layout

```
site/                     everything that ships (Netlify publishes this folder)
  index.html              all copy lives here
  404.html
  assets/css/site.css
  assets/js/terrain.js    hero: WebGL2 contour shader, CPU fallback, roads, looping car
  assets/js/localize.js   exhibit: particle filter, procedural city, vehicle model
  assets/js/main.js       wires the two together and drives the status text
  assets/data/            elevation (Terrarium-encoded lossless WebP) and roads (JSON)
  assets/fonts/           self-hosted Schibsted Grotesk and IBM Plex Mono (latin subsets)
  assets/img/             portrait
tools/build_roads.py      rebuilds the roads file and the car's loop from OpenStreetMap
netlify.toml              publish settings, security headers (CSP), caching
```

## Preview locally

Any static server works. The page fetches its data files, so opening `index.html` from disk will not load the terrain.

```sh
python3 -m http.server 8000 --directory site
```

Then open http://localhost:8000. Add `?debug` to expose `window.__terrain` and `window.__pf` in the console, and `?seed=<n>` to reproduce a particular particle-filter run.

## Editing

- **Copy:** edit `site/index.html` directly.
- **Cached assets:** files under `assets/data`, `assets/fonts`, `assets/img`, and `og.v1.jpg` are served with a one-year immutable cache. When you change one, bump the `.v1` in its file name and in every reference to it.
- **Roads or the car's loop:** `python3 tools/build_roads.py` (needs network access to the Overpass API).

## Deploy

Netlify builds from `master`. `netlify.toml` sets the publish folder to `site/` and replaces the old Gatsby build command with a no-op, so a push to `master` deploys.

## Data and credits

- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (USGS 3DEP and SRTM), z13, cropped and stored in Terrarium encoding. The lowest bit of blue marks water.
- Roads: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
- Fonts: Schibsted Grotesk and IBM Plex Mono, both SIL Open Font License.
