import { Group, Mesh, SphereGeometry } from 'three'

import { BOUNDARY_SOURCES, loadBoundary } from './boundaries.js'
import { graticulePositions } from './graticule.js'
import { createHeatmapSurface } from './heatmap.js'
import { DEPTH_BIAS, createLines } from './lines.js'
import { createPoints } from './points.js'
import { GLOBE_RADIUS } from './sphere.js'

// Segments per axis on the body mesh, high enough that its silhouette reads
// as a circle rather than a polygon.
const BODY_WIDTH_SEGMENTS = 128
const BODY_HEIGHT_SEGMENTS = 96

// Political boundaries are drawn dimmer than the coastline so the shape of
// the land still reads first.
const LAYER_STYLE = {
  coastline: { color: '#e8e8e8', linewidth: 1.3 },
  countries: { color: '#7d7d7d', linewidth: 0.9 },
  admin1: { color: '#4a4a4a', linewidth: 0.7 },
}

export function createGlobe({
  bodyColor = '#191919',
  graticuleColor = '#3a3a3a',
  graticuleWidth = 1,
  // The globe only redraws when something asks it to, so every layer that can
  // change reports through here.
  onChange = () => {},
} = {}) {
  const object = new Group()

  const heatmap = createHeatmapSurface({ bodyColor, onChange })

  // A solid body is what makes the globe opaque: it occludes everything on
  // the far side, so the lines need no depth trickery of their own.
  object.add(
    new Mesh(
      new SphereGeometry(GLOBE_RADIUS, BODY_WIDTH_SEGMENTS, BODY_HEIGHT_SEGMENTS),
      heatmap.material,
    ),
  )

  const graticule = createLines(graticulePositions(), {
    color: graticuleColor,
    linewidth: graticuleWidth,
    depthBias: DEPTH_BIAS.graticule,
  })
  object.add(graticule)

  const points = createPoints({ onChange })
  object.add(points.object)

  // Resolution has to track the canvas for the line layers to size their
  // quads, and boundary layers arrive later, so it is kept and replayed.
  const lineLayers = [graticule]
  let width = 1
  let height = 1

  // Boundaries load as separate files rather than riding in the bundle, so
  // the globe is on screen while they arrive.
  const ready = Promise.all(
    Object.entries(BOUNDARY_SOURCES).map(async ([name, url]) => {
      const layer = createLines(await loadBoundary(url), {
        ...LAYER_STYLE[name],
        depthBias: DEPTH_BIAS[name],
      })

      layer.material.resolution.set(width, height)
      lineLayers.push(layer)
      object.add(layer)
      onChange()

      return name
    }),
  )

  return {
    object,
    ready,

    // Plot markers: [{ lon, lat, size?, color? }]
    points,

    // Plot density: heatmap.set([{ lon, lat, weight? }], { radiusDegrees? })
    heatmap,

    setResolution(nextWidth, nextHeight) {
      width = nextWidth
      height = nextHeight
      for (const layer of lineLayers) layer.material.resolution.set(width, height)
    },

    setPixelRatio(value) {
      points.setPixelRatio(value)
    },
  }
}
