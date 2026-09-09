import { Vector3 } from 'three'

import { GLOBE_RADIUS, pointOnSphere } from './sphere.js'

// Graticule spacing, in degrees.
const PARALLEL_STEP = 15
const MERIDIAN_STEP = 15

// Points used to draw one full 360deg circle. Parallels use all of them;
// meridians span 180deg and so use half.
const CIRCLE_SEGMENTS = 160

// A flat array of segment endpoints: [ax, ay, az, bx, by, bz, ...].
export function graticulePositions(radius = GLOBE_RADIUS) {
  const positions = []
  const from = new Vector3()
  const to = new Vector3()

  const pushSegment = () => {
    positions.push(from.x, from.y, from.z, to.x, to.y, to.z)
  }

  // Parallels: rings of constant latitude. The poles are skipped, since a
  // ring there collapses to a point.
  for (let lat = -90 + PARALLEL_STEP; lat < 90; lat += PARALLEL_STEP) {
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      pointOnSphere((i / CIRCLE_SEGMENTS) * 360, lat, radius, from)
      pointOnSphere(((i + 1) / CIRCLE_SEGMENTS) * 360, lat, radius, to)
      pushSegment()
    }
  }

  // Meridians: half circles running pole to pole.
  const meridianSegments = CIRCLE_SEGMENTS / 2
  for (let lon = 0; lon < 360; lon += MERIDIAN_STEP) {
    for (let i = 0; i < meridianSegments; i++) {
      pointOnSphere(lon, -90 + (i / meridianSegments) * 180, radius, from)
      pointOnSphere(lon, -90 + ((i + 1) / meridianSegments) * 180, radius, to)
      pushSegment()
    }
  }

  return positions
}
