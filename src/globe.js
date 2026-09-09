import { Color, Group, Mesh, MeshBasicMaterial, SphereGeometry } from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'

import { coastlinePositions } from './coastlines.js'
import { graticulePositions } from './graticule.js'
import { GLOBE_RADIUS } from './sphere.js'

// Segments per axis on the body mesh, high enough that its silhouette reads
// as a circle rather than a polygon.
const BODY_WIDTH_SEGMENTS = 128
const BODY_HEIGHT_SEGMENTS = 96

// Every layer sits on the same unit sphere, so their silhouettes coincide
// exactly and nothing overhangs the globe's edge. They are separated in
// depth instead of radius: higher values are pushed further back, so the
// body loses to the graticule, which loses to the coastlines.
const BODY_DEPTH_BIAS = 2
const GRATICULE_DEPTH_BIAS = 1
const COASTLINE_DEPTH_BIAS = 0

function createLines(positions, { color, linewidth, depthBias }) {
  const geometry = new LineSegmentsGeometry()
  geometry.setPositions(positions)

  const material = new LineMaterial({
    color: new Color(color),
    // In CSS pixels, as long as resolution is kept in CSS pixels too.
    linewidth,
    // Antialiases the line edges against the multisampled buffer, which
    // keeps them smooth while staying opaque and depth-tested.
    alphaToCoverage: true,
    polygonOffset: true,
    polygonOffsetFactor: depthBias,
    polygonOffsetUnits: depthBias,
  })

  return new LineSegments2(geometry, material)
}

export function createGlobe({
  bodyColor = '#191919',
  graticuleColor = '#3a3a3a',
  coastlineColor = '#e8e8e8',
  graticuleWidth = 1,
  coastlineWidth = 1.3,
} = {}) {
  // A solid body is what makes the globe opaque: it occludes everything on
  // the far side, so the lines need no depth trickery of their own.
  const body = new Mesh(
    new SphereGeometry(GLOBE_RADIUS, BODY_WIDTH_SEGMENTS, BODY_HEIGHT_SEGMENTS),
    new MeshBasicMaterial({
      color: new Color(bodyColor),
      // The lines lie on this exact surface. Nudging the body back in depth
      // stops it z-fighting with the lines drawn across its facets.
      polygonOffset: true,
      polygonOffsetFactor: BODY_DEPTH_BIAS,
      polygonOffsetUnits: BODY_DEPTH_BIAS,
    }),
  )

  const graticule = createLines(graticulePositions(), {
    color: graticuleColor,
    linewidth: graticuleWidth,
    depthBias: GRATICULE_DEPTH_BIAS,
  })

  const coastlines = createLines(coastlinePositions(), {
    color: coastlineColor,
    linewidth: coastlineWidth,
    depthBias: COASTLINE_DEPTH_BIAS,
  })

  // A group, so the whole globe spins as one and later layers can join it.
  const object = new Group()
  object.add(body, graticule, coastlines)

  return {
    object,

    // LineMaterial sizes its quads against this, so it has to track the
    // canvas. Pass CSS pixels to keep linewidth in CSS pixels.
    setResolution(width, height) {
      graticule.material.resolution.set(width, height)
      coastlines.material.resolution.set(width, height)
    },
  }
}
