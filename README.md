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
