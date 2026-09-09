# asri

A static site built with [Vite](https://vite.dev) and [three.js](https://threejs.org).

## Develop

```sh
npm install
npm run dev
```

## Build

```sh
npm run build    # writes dist/
npm run preview  # serves the built output
```

## Deploy

`.github/workflows/deploy.yml` builds the site and publishes `dist/` to
GitHub Pages on every push to `main`.

This requires the Pages source to be set to GitHub Actions:
**Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Boundary data

The globe's coastlines, country borders and state/province borders come from
[Natural Earth](https://www.naturalearthdata.com/), by way of `world-atlas`
and the Natural Earth admin-1 line data.

Those sources ship far more detail than the globe can draw, so they are not
loaded directly. `npm run build:boundaries` thins each layer and writes it to
`src/generated/*.bin` as quantised, delta-encoded int16 — about 131kB gzipped
for all three layers, against 157kB for the coastline alone in its original
form. The generated files are committed, so a normal build needs no network
and `topojson-client`/`world-atlas` stay out of the shipped bundle.

Re-run it only when changing the source data or the thinning parameters.

## Event data

`data/paranormal_events.csv` holds the source records. `npm run build:events`
reduces it to `src/generated/events.bin`: the CSV is 23MB, almost all of it
prose the map never draws, against 309kB gzipped for the four things that are
plotted — when, where, and which category.

Events are written in date order, which does two things. Dates become steps
from the one before, so they compress from 164kB to 11kB, and the runtime can
find a date range by binary search rather than scanning 84,000 records.

Two rows of the 84,187 are dropped: one has no date at all, and one is dated
2053, which is a transcription error rather than a record. Partial dates
(`1995`, `1934-04`) are kept, placed at the start of the period they name.

Coordinates are stored inline. Grouping them into a table of the 23,283
distinct locations was measured and saves only 27kB, because an index into
that table costs nearly as much as the coordinates do — the entropy floor for
one is 12.9 bits per event.

Like the boundaries, the generated file is committed and only needs rebuilding
when the source data or the reduction changes.

## Plotting

The globe is exposed on `window.asri` for plotting:

```js
// Markers. size is in CSS pixels; both size and color are per-point optional.
asri.points.set([
  { lon: -0.13, lat: 51.51 },
  { lon: 139.69, lat: 35.69, size: 8, color: '#e8e8e8' },
])
asri.points.clear()

// Density. radiusDegrees is how far each sample spreads across the surface;
// weights are normalised against the largest unless a max is given.
asri.heatmap.set(
  [
    { lon: -0.13, lat: 51.51, weight: 4 },
    { lon: 139.69, lat: 35.69, weight: 1 },
  ],
  { radiusDegrees: 8 },
)
asri.heatmap.clear()
```

`asri.ready` resolves once the boundary layers have loaded.

## Rendering cost

Frame cost depends entirely on the machine, so the globe measures itself. The
drawing buffer is capped at 6.5 megapixels, and if frames keep running long it
scales the buffer down and back up again as they recover.

`asri.diagnostics()` reports what the renderer is actually doing:

```js
asri.diagnostics()
// { devicePixelRatio: 2, pixelRatio: 2, drawingBuffer: '2400x1600',
//   megapixels: 3.84, qualityScale: 1, cameraDistance: 4.82 }
```

A `qualityScale` below 1 means the globe has backed off to keep up.
