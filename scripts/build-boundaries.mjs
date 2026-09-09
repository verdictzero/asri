// Generates the compact boundary geometry the globe loads at runtime.
//
// The source datasets are Natural Earth, which ship as TopoJSON/GeoJSON far
// larger than the globe can ever draw: the 50m coastline alone is 157kB gzipped
// and carries detail finer than a pixel. This script thins each layer and
// writes it as quantised int16, which is both much smaller and far cheaper to
// turn into geometry at startup. It also keeps topojson-client and world-atlas
// out of the shipped bundle entirely, since only this script needs them.
//
// Run with `npm run build:boundaries`. The output is committed, so the app
// build stays hermetic and needs no network.

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { mesh } from 'topojson-client'
import countries50m from 'world-atlas/countries-50m.json' with { type: 'json' }

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'generated')

// Natural Earth admin-1 boundary *lines*, rather than the state polygons: the
// polygons would retrace every coastline the land layer already draws.
const ADMIN_1_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces_lines.geojson'

// Points closer together than this are dropped. A degree spans roughly seven
// pixels at the size the globe draws, so this keeps detail down to well under
// a pixel while discarding a lot of vertices.
const MIN_SPACING_DEGREES = 0.1

// Coordinates are quantised to int16. Latitude shares longitude's scale even
// though it only spans half the range, so that a delta between any two points
// still fits in an int16. The result resolves to about 0.006 degrees, which is
// a few hundred metres.
const SCALE = 32767 / 180
const HALF_TURN = Math.round(180 * SCALE)
const FULL_TURN = 2 * HALF_TURN

function simplify(line) {
  const kept = [line[0]]

  for (let i = 1; i < line.length - 1; i++) {
    const [lastLon, lastLat] = kept[kept.length - 1]
    const [lon, lat] = line[i]

    // A degree of longitude covers less ground toward the poles, so weight it
    // by latitude rather than thinning polar boundaries too hard.
    const dx = (lon - lastLon) * Math.cos((lat * Math.PI) / 180)
    const dy = lat - lastLat

    if (Math.hypot(dx, dy) >= MIN_SPACING_DEGREES) kept.push(line[i])
  }

  kept.push(line[line.length - 1])
  return kept
}

// Layout: uint32 lineCount, uint32[lineCount] points per line, then int16
// lon/lat pairs. The header is always a multiple of four bytes, so the int16
// block lands aligned and can be read as a typed array without copying.
//
// Each line stores its first point outright and the rest as steps from the
// previous one. Boundary points are close together, so the steps are small
// numbers that compress far better than absolute coordinates: it takes the
// three layers from 204kB gzipped to 132kB.
function encode(lines) {
  const pointTotal = lines.reduce((sum, line) => sum + line.length, 0)
  const headerBytes = 4 + 4 * lines.length
  const buffer = new ArrayBuffer(headerBytes + pointTotal * 2 * 2)

  new DataView(buffer).setUint32(0, lines.length, true)
  new Uint32Array(buffer, 4, lines.length).set(lines.map((line) => line.length))

  const coords = new Int16Array(buffer, headerBytes)
  let i = 0

  for (const line of lines) {
    let previousLon = 0
    let previousLat = 0

    line.forEach(([lon, lat], index) => {
      const quantisedLon = Math.round(lon * SCALE)
      const quantisedLat = Math.round(lat * SCALE)

      if (index === 0) {
        coords[i++] = quantisedLon
        coords[i++] = quantisedLat
      } else {
        // Natural Earth splits lines at the antimeridian, which leaves steps
        // reading as most of the way around the world. Storing the short way
        // round keeps every step inside an int16, and since the decoded
        // longitude is only ever fed to sin and cos, coming out a whole turn
        // away from the original lands on exactly the same point.
        let stepLon = quantisedLon - previousLon
        if (stepLon > HALF_TURN) stepLon -= FULL_TURN
        else if (stepLon < -HALF_TURN) stepLon += FULL_TURN

        coords[i++] = stepLon
        coords[i++] = quantisedLat - previousLat
      }

      previousLon = quantisedLon
      previousLat = quantisedLat
    })
  }

  return { buffer, pointTotal }
}

function write(name, rawLines) {
  const lines = rawLines.map(simplify).filter((line) => line.length >= 2)
  const { buffer, pointTotal } = encode(lines)
  const rawPoints = rawLines.reduce((sum, line) => sum + line.length, 0)

  writeFileSync(join(OUT_DIR, `${name}.bin`), Buffer.from(buffer))
  console.log(
    `${name.padEnd(10)} ${String(lines.length).padStart(5)} lines  ` +
      `${String(rawPoints).padStart(6)} -> ${String(pointTotal).padStart(6)} points  ` +
      `${(buffer.byteLength / 1024).toFixed(0)}kB`,
  )
}

function geoJsonLines(collection) {
  const lines = []
  for (const { geometry } of collection.features) {
    if (!geometry) continue
    if (geometry.type === 'LineString') lines.push(geometry.coordinates)
    else if (geometry.type === 'MultiLineString') lines.push(...geometry.coordinates)
  }
  return lines
}

const { countries, land } = countries50m.objects

// The land object's outer boundary is the coastline. Filtering the country
// mesh to arcs shared by two different countries leaves only the borders
// between them, so the coastline is not drawn a second time.
write('coastline', mesh(countries50m, land).coordinates)
write('countries', mesh(countries50m, countries, (a, b) => a !== b).coordinates)

const response = await fetch(ADMIN_1_URL)
if (!response.ok) throw new Error(`admin-1 fetch failed: ${response.status}`)
write('admin1', geoJsonLines(await response.json()))
