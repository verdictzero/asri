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

// Half of every layer sits on the far side of the globe, hidden by the body.
// The depth test alone will not save the work: LineMaterial's fragment shader
// discards, which stops the GPU rejecting fragments before shading them, so
// those hidden segments get shaded in full and then thrown away. Since each
// segment is drawn as a screen-space quad, that waste grows with zoom - the
// closer the camera, the longer each quad and the more fragments it costs.
//
// Collapsing back-facing segments in the vertex shader removes them before
// they are ever rasterised. The margin keeps segments that straddle the
// horizon, which the body occludes anyway, so nothing pops at the edge.
const BACK_FACE_MARGIN = -0.12

function cullFarSide(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      'vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );',
      `vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );

      {
        // Every line layer lies on a sphere centred on the origin, so a
        // point's surface normal is just its normalised position.
        float startFacing = dot(
          normalize( normalMatrix * normalize( instanceStart ) ),
          normalize( -start.xyz )
        );
        float endFacing = dot(
          normalize( normalMatrix * normalize( instanceEnd ) ),
          normalize( -end.xyz )
        );

        if ( max( startFacing, endFacing ) < ${BACK_FACE_MARGIN} ) {
          // Outside the clip volume, so the quad is thrown away whole.
          gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
          return;
        }
      }`,
    )
  }
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
    // Deliberately no alphaToCoverage. It costs per-sample work on every
    // fragment, and the renderer's multisampling already smooths the quad
    // edges, which is what a thin line is almost entirely made of. Compared
    // side by side the two are indistinguishable, and dropping it measured
    // about a quarter faster.
    polygonOffset: true,
    polygonOffsetFactor: depthBias,
    polygonOffsetUnits: depthBias,
  })

  cullFarSide(material)

  return new LineSegments2(geometry, material)
}
