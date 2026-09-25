#!/usr/bin/env python3
"""Rebuild site/assets/data/austin-roads.v1.json from OpenStreetMap.

Downloads drivable roads for the hero's map window from the Overpass API, keeps the tertiary and
larger classes for drawing, and solves the car's loop on the real road graph: a shortest-cost
cycle through a few waypoints (MoPac, Lady Bird Lake, Lake Austin Blvd, Mt. Bonnell Rd), with
already-used segments penalised so the loop does not double back on itself.

All coordinates are pixels of the DEM mosaic (z13 Web Mercator, top-left at tile TX0, TY0), the same
space terrain.js uses. Roads are (c) OpenStreetMap contributors, ODbL.

Usage: python3 tools/build_roads.py [--cache osm.json] [--out path]

The data file is served with a one-year immutable cache, so write a new version (for example
--out site/assets/data/austin-roads.v2.json) and update ROADS.url in site/assets/js/terrain.js.
"""
import argparse, heapq, json, math, os, urllib.parse, urllib.request

Z, TX0, TY0, MPP = 13, 1866.46875, 3369.0, 16.494
TILES = 2 ** Z
OUT = os.path.join(os.path.dirname(__file__), '..', 'site', 'assets', 'data', 'austin-roads.v1.json')
BBOX = (30.26114, -97.83669, 30.36636, -97.73369)            # south, west, north, east
WAYPOINTS = [(1286, 505), (1222, 900), (1150, 842), (1185, 660), (1286, 505)]
DRAW_WINDOW = (380, 250, 1500, 1050)                          # x0, y0, x1, y1 in DEM px
COST = {'motorway': .5, 'motorway_link': .9, 'trunk': .55, 'trunk_link': .9, 'primary': .7, 'primary_link': .9,
        'secondary': .8, 'secondary_link': .9, 'tertiary': 1.0, 'unclassified': 2.4, 'residential': 2.6}


def ll2px(lat, lon):
    tx = (lon + 180) / 360 * TILES
    lr = math.radians(lat)
    ty = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * TILES
    return (tx - TX0) * 256, (ty - TY0) * 256


def fetch_osm():
    s, w, n, e = BBOX
    q = f'[out:json][timeout:60];way["highway"~"^({"|".join(COST)})$"]({s},{w},{n},{e});(._;>;);out body;'
    req = urllib.request.Request('https://overpass-api.de/api/interpreter', data=urllib.parse.urlencode({'data': q}).encode(),
                                 headers={'User-Agent': 'cyrusbehr.com road builder'})
    return json.load(urllib.request.urlopen(req, timeout=120))


def simplify(pts, eps):
    """Douglas-Peucker."""
    if len(pts) < 3:
        return pts
    (ax, ay), (bx, by) = pts[0], pts[-1]
    L = math.hypot(bx - ax, by - ay)
    best, dmax = 0, 0.0
    for k in range(1, len(pts) - 1):
        x, y = pts[k]
        d = math.hypot(x - ax, y - ay) if L < 1e-6 else abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / L
        if d > dmax:
            best, dmax = k, d
    if dmax > eps:
        return simplify(pts[:best + 1], eps)[:-1] + simplify(pts[best:], eps)
    return [pts[0], pts[-1]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', help='read or write the raw Overpass response here')
    ap.add_argument('--out', default=OUT, help='output file (default: the current v1 file)')
    args = ap.parse_args()
    if args.cache and os.path.exists(args.cache):
        data = json.load(open(args.cache))
    else:
        data = fetch_osm()
        if args.cache:
            json.dump(data, open(args.cache, 'w'))

    nodes = {e['id']: ll2px(e['lat'], e['lon']) for e in data['elements'] if e['type'] == 'node'}
    ways = [e for e in data['elements'] if e['type'] == 'way']
    adj = {}
    for w in ways:
        hw = w['tags'].get('highway')
        ns = [n for n in w['nodes'] if n in nodes]
        for a, b in zip(ns, ns[1:]):
            L = math.dist(nodes[a], nodes[b])
            adj.setdefault(a, []).append((b, L, COST.get(hw, 3.0), hw))
            adj.setdefault(b, []).append((a, L, COST.get(hw, 3.0), hw))

    major = set(COST) - {'residential', 'unclassified'}
    def nearest(p):
        return min((n for n, es in adj.items() if any(e[3] in major for e in es)), key=lambda n: math.dist(nodes[n], p))

    used = set()
    def path(a, b):
        dist, prev, pq = {a: 0.0}, {}, [(0.0, a)]
        while pq:
            c, u = heapq.heappop(pq)
            if u == b:
                break
            if c > dist[u]:
                continue
            for v, L, f, _ in adj[u]:
                nc = c + L * f * (8 if (min(u, v), max(u, v)) in used else 1)
                if nc < dist.get(v, float('inf')):
                    dist[v], prev[v] = nc, u
                    heapq.heappush(pq, (nc, v))
        out = [b]
        while out[-1] != a:
            out.append(prev[out[-1]])
        out.reverse()
        used.update((min(u, v), max(u, v)) for u, v in zip(out, out[1:]))
        return out

    ids = [nearest(p) for p in WAYPOINTS]
    loop = []
    for a, b in zip(ids, ids[1:]):
        seg = path(a, b)
        loop += seg if not loop else seg[1:]
    pts = [nodes[n] for n in loop]
    km = sum(math.dist(p, q) for p, q in zip(pts, pts[1:])) * MPP / 1000
    route = simplify(pts, 0.3)

    x0, y0, x1, y1 = DRAW_WINDOW
    roads = []
    for w in ways:
        hw = w['tags'].get('highway', '')
        cls = 3 if hw in ('motorway', 'trunk') else 2 if hw in ('primary', 'secondary') else 1 if hw == 'tertiary' else 0
        if not cls:
            continue
        P = [nodes[n] for n in w['nodes'] if n in nodes]
        if not any(x0 < x < x1 and y0 < y < y1 for x, y in P):
            continue
        roads.append([cls] + [round(c, 1) for p in simplify(P, 0.5) for c in p])

    out = {'source': 'OpenStreetMap contributors (ODbL)', 'route': [round(c, 2) for p in route for c in p], 'routeKm': round(km, 2), 'roads': roads}
    with open(args.out, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'loop {km:.1f} km, {len(route)} route points, {len(roads)} roads -> {os.path.relpath(args.out)}')


if __name__ == '__main__':
    main()
