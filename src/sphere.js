import { MathUtils, Vector3 } from 'three'

export const GLOBE_RADIUS = 1

// Geographic coordinates to a point on the globe. Argument order follows
// GeoJSON, which is [longitude, latitude].
export function pointOnSphere(lonDeg, latDeg, radius = GLOBE_RADIUS, target = new Vector3()) {
  const polar = MathUtils.degToRad(90 - latDeg)
  const azimuth = MathUtils.degToRad(lonDeg)
  const sinPolar = Math.sin(polar)

  return target.set(
    radius * sinPolar * Math.cos(azimuth),
    radius * Math.cos(polar),
    radius * sinPolar * Math.sin(azimuth),
  )
}
