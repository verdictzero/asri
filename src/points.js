import { BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial } from 'three'

import { GLOBE_RADIUS, pointOnSphere } from './sphere.js'

// Markers sit on the globe's surface. Rather than depth-testing them against
// the body, which cannot be biased for points the way polygons can, the shader
// drops anything on the far side outright: the globe is a sphere centred on
// the origin, so whether a point faces the camera is exact, not approximate.
const vertexShader = /* glsl */ `
  attribute float size;
  attribute vec3 tint;

  uniform float uPixelRatio;
  uniform float uScale;

  varying float vFacing;
  varying vec3 vTint;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

    vec3 normalView = normalize(normalMatrix * normalize(position));
    vFacing = dot(normalView, normalize(-mvPosition.xyz));
    vTint = tint;

    // gl_PointSize is in device pixels, so undo the pixel ratio to keep marker
    // size in CSS pixels. Perspective scaling keeps markers proportional as
    // the camera zooms in.
    gl_PointSize = size * uPixelRatio * (uScale / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`

const fragmentShader = /* glsl */ `
  varying float vFacing;
  varying vec3 vTint;

  void main() {
    if (vFacing < 0.0) discard;

    // gl_PointCoord runs 0..1 across the square the point is drawn into, so
    // this trims it to a circle with a soft edge instead of a hard square.
    float distance = length(gl_PointCoord - 0.5) * 2.0;
    float alpha = 1.0 - smoothstep(0.82, 1.0, distance);
    if (alpha <= 0.0) discard;

    gl_FragColor = vec4(vTint, alpha);

    #include <colorspace_fragment>
  }
`

export function createPoints({
  // Near-white rather than the heatmap's blue: markers and density are two
  // different readings, and they should not be told apart only by size.
  color = '#f0f0f0',
  size = 5,
  // Chosen so a marker's size reads as roughly its size in CSS pixels at the
  // default framing, growing as the camera moves closer.
  scale = 3.4,
  maxPoints = 20000,
  // Nothing redraws on its own, so changing the data has to ask for a frame.
  onChange = () => {},
} = {}) {
  const positions = new Float32Array(maxPoints * 3)
  const sizes = new Float32Array(maxPoints)
  const tints = new Float32Array(maxPoints * 3)

  // BufferAttribute rather than Float32BufferAttribute: the latter copies the
  // array it is handed, which would leave these buffers writing to nothing.
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('size', new BufferAttribute(sizes, 1))
  geometry.setAttribute('tint', new BufferAttribute(tints, 3))
  geometry.setDrawRange(0, 0)

  const material = new ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: 1 },
      uScale: { value: scale },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    // A marker is a flat screen-facing square drawn at a single depth, so
    // depth-testing it against a curved surface shears it off wherever the
    // globe bulges nearer than its centre. The shader's facing test already
    // hides anything on the far side, exactly, so no depth test is wanted:
    // markers simply sit on top of the map, which is where markers belong.
    depthTest: false,
  })

  const object = new Points(geometry, material)
  // The draw range starts empty, so three's own bounds would cull it away.
  object.frustumCulled = false

  const defaultColor = new Color(color)
  const scratch = new Color()

  return {
    object,

    setPixelRatio(value) {
      material.uniforms.uPixelRatio.value = value
    },

    // Each marker is { lon, lat } and may carry its own size and color.
    set(markers) {
      const count = Math.min(markers.length, maxPoints)

      for (let i = 0; i < count; i++) {
        const marker = markers[i]
        const point = pointOnSphere(marker.lon, marker.lat, marker.radius ?? GLOBE_RADIUS)

        positions[i * 3] = point.x
        positions[i * 3 + 1] = point.y
        positions[i * 3 + 2] = point.z

        sizes[i] = marker.size ?? size

        const tint = marker.color ? scratch.set(marker.color) : defaultColor
        tints[i * 3] = tint.r
        tints[i * 3 + 1] = tint.g
        tints[i * 3 + 2] = tint.b
      }

      geometry.attributes.position.needsUpdate = true
      geometry.attributes.size.needsUpdate = true
      geometry.attributes.tint.needsUpdate = true
      geometry.setDrawRange(0, count)
      onChange()

      return count
    },

    clear() {
      geometry.setDrawRange(0, 0)
      onChange()
    },
  }
}
