import { Vector3 } from 'three'
import { feature } from 'topojson-client'
import land from 'world-atlas/land-50m.json'

import { GLOBE_RADIUS, pointOnSphere } from './sphere.js'

// A straight chord between two distant points would cut through the globe,
// so edges are walked in steps of at most this many degrees.
const MAX_STEP_DEGREES = 1.5

// The 50m data carries detail far finer than the globe is ever drawn at:
// a degree spans roughly seven pixels here, so points packed closer than
// this cost vertices without changing the picture. Dropping them roughly
// halves the geometry, which matters because every segment is drawn as its
// own screen-space quad.
const MIN_SPACING_DEGREES = 0.1

// Below this many points a ring has collapsed to less than a pixel, so it
// would only ever render as a speck.
const MIN_RING_POINTS = 4

function simplify(ring) {
  const kept = [ring[0]]

  for (let i = 1; i < ring.length - 1; i++) {
    const [lastLon, lastLat] = kept[kept.length - 1]
    const [lon, lat] = ring[i]

    // A degree of longitude covers less ground toward the poles, so weight
    // it by latitude rather than thinning polar coastlines too hard.
    const dx = (lon - lastLon) * Math.cos((lat * Math.PI) / 180)
    const dy = lat - lastLat

    if (Math.hypot(dx, dy) >= MIN_SPACING_DEGREES) kept.push(ring[i])
  }

  kept.push(ring[ring.length - 1])
  return kept
}

function* landRings() {
  const collection = feature(land, land.objects.land)
  const features = collection.features ?? [collection]

  for (const { geometry } of features) {
    if (geometry.type === 'Polygon') {
      yield* geometry.coordinates
    } else if (geometry.type === 'MultiPolygon') {
      for (const polygon of geometry.coordinates) yield* polygon
    }
  }
}

// A flat array of segment endpoints: [ax, ay, az, bx, by, bz, ...].
export function coastlinePositions(radius = GLOBE_RADIUS) {
  const positions = []
  const from = new Vector3()
  const to = new Vector3()

  for (const rawRing of landRings()) {
    const ring = simplify(rawRing)
    if (ring.length < MIN_RING_POINTS) continue

    // GeoJSON rings repeat their first point as the last, so stepping to
    // length - 1 already covers every edge including the closing one.
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon, lat] = ring[i]
      const [nextLon, nextLat] = ring[i + 1]

      // Natural Earth splits rings at the antimeridian, which leaves edges
      // that read as a jump most of the way around the world. Take the
      // short way instead of sweeping the globe.
      let endLon = nextLon
      if (endLon - lon > 180) endLon -= 360
      else if (lon - endLon > 180) endLon += 360

      const steps = Math.max(
        1,
        Math.ceil(Math.max(Math.abs(endLon - lon), Math.abs(nextLat - lat)) / MAX_STEP_DEGREES),
      )

      pointOnSphere(lon, lat, radius, from)
      for (let step = 1; step <= steps; step++) {
        const t = step / steps
        pointOnSphere(lon + (endLon - lon) * t, lat + (nextLat - lat) * t, radius, to)
        positions.push(from.x, from.y, from.z, to.x, to.y, to.z)
        from.copy(to)
      }
    }
  }

  return positions
}
