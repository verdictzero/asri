import { Color } from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'

// Every layer sits on the same unit sphere, so their silhouettes coincide and
// nothing overhangs the globe's edge. They are separated in depth instead of
// radius: higher values are pushed further back, so the body loses to the
// graticule, which loses to the borders, which lose to the coastline.
export const DEPTH_BIAS = {
  body: 4,
  graticule: 3,
  admin1: 2,
  countries: 1,
  coastline: 0,
}

// Draws segments as screen-space quads, so line width stays even across device
// pixel ratios instead of thinning out on high-DPI displays.
export function createLines(positions, { color, linewidth, depthBias }) {
  const geometry = new LineSegmentsGeometry()
  geometry.setPositions(positions)

  const material = new LineMaterial({
    color: new Color(color),
    // In CSS pixels, as long as resolution is kept in CSS pixels too.
    linewidth,
    // Antialiases the line edges against the multisampled buffer, which keeps
    // them smooth while staying opaque and depth-tested.
    alphaToCoverage: true,
    polygonOffset: true,
    polygonOffsetFactor: depthBias,
    polygonOffsetUnits: depthBias,
  })

  return new LineSegments2(geometry, material)
}
