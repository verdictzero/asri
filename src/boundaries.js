import { Vector3 } from 'three'

import { GLOBE_RADIUS, pointOnSphere } from './sphere.js'

import admin1Url from './generated/admin1.bin?url'
import coastlineUrl from './generated/coastline.bin?url'
import countriesUrl from './generated/countries.bin?url'

// Degrees per quantised unit. Must match scripts/build-boundaries.mjs.
const SCALE = 180 / 32767

// A straight chord between two distant points would cut through the globe, so
// edges are walked in steps of at most this many degrees. Country borders
// need this more than coastlines do: a border that runs along a parallel is a
// single step in the data but a long arc on the sphere.
const MAX_STEP_DEGREES = 1.5

export const BOUNDARY_SOURCES = {
  coastline: coastlineUrl,
  countries: countriesUrl,
  admin1: admin1Url,
}

function decodeLines(buffer) {
  const lineCount = new DataView(buffer).getUint32(0, true)
  const pointCounts = new Uint32Array(buffer, 4, lineCount)
  const coords = new Int16Array(buffer, 4 + 4 * lineCount)

  const lines = []
  let i = 0

  for (const pointCount of pointCounts) {
    const line = new Float64Array(pointCount * 2)
    let lon = 0
    let lat = 0

    for (let p = 0; p < pointCount; p++) {
      // The first pair of a line is absolute; every pair after it is a step
      // from the point before.
      lon = p === 0 ? coords[i++] : lon + coords[i++]
      lat = p === 0 ? coords[i++] : lat + coords[i++]

      line[p * 2] = lon * SCALE
      line[p * 2 + 1] = lat * SCALE
    }

    lines.push(line)
  }

  return lines
}

// A flat array of segment endpoints: [ax, ay, az, bx, by, bz, ...].
function toSegments(lines, radius) {
  const positions = []
  const from = new Vector3()
  const to = new Vector3()

  for (const line of lines) {
    for (let p = 0; p < line.length / 2 - 1; p++) {
      const lon = line[p * 2]
      const lat = line[p * 2 + 1]
      const nextLon = line[p * 2 + 2]
      const nextLat = line[p * 2 + 3]

      const steps = Math.max(
        1,
        Math.ceil(Math.max(Math.abs(nextLon - lon), Math.abs(nextLat - lat)) / MAX_STEP_DEGREES),
      )

      pointOnSphere(lon, lat, radius, from)
      for (let step = 1; step <= steps; step++) {
        const t = step / steps
        pointOnSphere(lon + (nextLon - lon) * t, lat + (nextLat - lat) * t, radius, to)
        positions.push(from.x, from.y, from.z, to.x, to.y, to.z)
        from.copy(to)
      }
    }
  }

  return positions
}

export async function loadBoundary(url, radius = GLOBE_RADIUS) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not load boundary data: ${response.status} ${url}`)

  return toSegments(decodeLines(await response.arrayBuffer()), radius)
}
