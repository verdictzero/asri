import { Color, Group, MathUtils, Vector3 } from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'

export const GLOBE_RADIUS = 1

// Graticule spacing, in degrees.
const PARALLEL_STEP = 15
const MERIDIAN_STEP = 15

// Points used to draw one full 360deg circle. Parallels use all of them;
// meridians span 180deg and so use half.
const CIRCLE_SEGMENTS = 160

function pointOnSphere(latDeg, lonDeg, target) {
  const polar = MathUtils.degToRad(90 - latDeg)
  const azimuth = MathUtils.degToRad(lonDeg)
  const sinPolar = Math.sin(polar)

  return target.set(
    GLOBE_RADIUS * sinPolar * Math.cos(azimuth),
    GLOBE_RADIUS * Math.cos(polar),
    GLOBE_RADIUS * sinPolar * Math.sin(azimuth),
  )
}

// A flat array of segment endpoints: [ax, ay, az, bx, by, bz, ...].
function graticulePositions() {
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
      pointOnSphere(lat, (i / CIRCLE_SEGMENTS) * 360, from)
      pointOnSphere(lat, ((i + 1) / CIRCLE_SEGMENTS) * 360, to)
      pushSegment()
    }
  }

  // Meridians: half circles running pole to pole.
  const meridianSegments = CIRCLE_SEGMENTS / 2
  for (let lon = 0; lon < 360; lon += MERIDIAN_STEP) {
    for (let i = 0; i < meridianSegments; i++) {
      pointOnSphere(-90 + (i / meridianSegments) * 180, lon, from)
      pointOnSphere(-90 + ((i + 1) / meridianSegments) * 180, lon, to)
      pushSegment()
    }
  }

  return positions
}

// LineMaterial draws each segment as a screen-space quad, which is what
// keeps the line width even across pixel ratios. It has no notion of which
// side of the sphere a segment is on, so patch a facing term into its
// shader: lines on the far side fade back, and the wireframe reads as a
// volume instead of a flat tangle.
function applyDepthFade(material, { nearOpacity, farOpacity }) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNearOpacity = { value: nearOpacity }
    shader.uniforms.uFarOpacity = { value: farOpacity }

    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        `varying float vFacing;

        void main() {`,
      )
      .replace(
        'vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );',
        `vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );

        // The graticule sits on a sphere centred on the origin, so the
        // surface normal at a point is just its normalised position. One
        // value per segment is plenty at this segment count.
        vec3 midLocal = ( instanceStart + instanceEnd ) * 0.5;
        vec3 normalView = normalize( normalMatrix * normalize( midLocal ) );
        vec3 towardCamera = normalize( -( start.xyz + end.xyz ) * 0.5 );
        vFacing = dot( normalView, towardCamera );`,
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `uniform float uNearOpacity;
        uniform float uFarOpacity;
        varying float vFacing;

        void main() {`,
      )
      .replace(
        'gl_FragColor = vec4( diffuseColor.rgb, alpha );',
        `float facing = smoothstep( -0.35, 0.7, vFacing );
        gl_FragColor = vec4( diffuseColor.rgb, alpha * mix( uFarOpacity, uNearOpacity, facing ) );`,
      )
  }
}

export function createGlobe({
  color = '#e8e8e8',
  linewidth = 1.1,
  nearOpacity = 0.75,
  farOpacity = 0.08,
} = {}) {
  const geometry = new LineSegmentsGeometry()
  geometry.setPositions(graticulePositions())

  const material = new LineMaterial({
    color: new Color(color),
    // In CSS pixels, as long as resolution is kept in CSS pixels too.
    linewidth,
    transparent: true,
    // Segments are ordered by construction, not by depth. Writing depth
    // would let whichever drew first punch holes in the ones behind it.
    depthWrite: false,
  })

  applyDepthFade(material, { nearOpacity, farOpacity })

  // A group rather than the line object directly, so later layers can be
  // added to the globe without changing how it is spun.
  const object = new Group()
  object.add(new LineSegments2(geometry, material))

  return {
    object,

    // LineMaterial sizes its quads against this, so it has to track the
    // canvas. Pass CSS pixels to keep linewidth in CSS pixels.
    setResolution(width, height) {
      material.resolution.set(width, height)
    },
  }
}
