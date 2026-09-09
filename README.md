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
