import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  LinearFilter,
  RedFormat,
  RepeatWrapping,
  ShaderMaterial,
  UnsignedByteType,
} from 'three'

// The heatmap is built as an equirectangular grid and used as the globe
// body's own texture, so it is part of the one opaque surface rather than a
// shell above it. Nothing to z-fight, and it is occluded on the far side for
// free.
//
// Density is counted into the grid and then blurred, rather than each sample
// being drawn as its own soft blob. With tens of thousands of samples the
// blob approach costs one canvas gradient per sample; counting costs one
// array increment, and the blur that follows does not care how many samples
// went in.
const GRID_WIDTH = 512
const GRID_HEIGHT = 256

// Three box passes approximate a Gaussian closely enough, and each one is a
// running sum, so the cost does not grow with the radius.
const BLUR_PASSES = 3

// Sequential encoding wants a single hue running light to dark. On a dark
// surface that runs the other way: near-zero recedes into the body and
// magnitude climbs toward the light end. Lightness is monotonic across these
// six steps, which is the check that matters for a ramp.
const RAMP = ['#104281', '#1c5cab', '#2a78d6', '#5598e7', '#9ec5f4', '#cde2fb']

const vertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform sampler2D uHeat;
  uniform float uOpacity;
  uniform vec3 uBodyColor;
  uniform vec3 uRamp0;
  uniform vec3 uRamp1;
  uniform vec3 uRamp2;
  uniform vec3 uRamp3;
  uniform vec3 uRamp4;
  uniform vec3 uRamp5;

  varying vec2 vUv;

  // Piecewise interpolation across the six ramp stops. Written as a chain of
  // clamped mixes rather than an indexed array, since dynamic indexing into a
  // uniform array is the kind of thing drivers disagree about.
  vec3 rampColor(float t) {
    float x = clamp(t, 0.0, 1.0) * 5.0;
    vec3 c = mix(uRamp0, uRamp1, clamp(x, 0.0, 1.0));
    c = mix(c, uRamp2, clamp(x - 1.0, 0.0, 1.0));
    c = mix(c, uRamp3, clamp(x - 2.0, 0.0, 1.0));
    c = mix(c, uRamp4, clamp(x - 3.0, 0.0, 1.0));
    c = mix(c, uRamp5, clamp(x - 4.0, 0.0, 1.0));
    return c;
  }

  void main() {
    float heat = texture2D(uHeat, vUv).r * uOpacity;

    // The ramp's low end is already much lighter than the body, so easing the
    // blend across the bottom of the range is what gives a patch a soft edge
    // instead of landing as a flat disc.
    vec3 color = mix(uBodyColor, rampColor(heat), smoothstep(0.0, 0.42, heat));

    gl_FragColor = vec4(color, 1.0);

    #include <colorspace_fragment>
  }
`

// Blurs a row at a time with a running sum, wrapping around the seam so a
// patch at the date line is not cut in half. The radius widens toward the
// poles because a degree of longitude covers less ground there, which is what
// keeps a patch round on the globe instead of squashed.
function blurHorizontal(source, target, baseRadius) {
  for (let y = 0; y < GRID_HEIGHT; y++) {
    const latitude = 90 - ((y + 0.5) / GRID_HEIGHT) * 180
    const cosLat = Math.max(0.08, Math.cos((latitude * Math.PI) / 180))
    const radius = Math.min(GRID_WIDTH >> 1, Math.max(1, Math.round(baseRadius / cosLat)))
    const span = radius * 2 + 1
    const row = y * GRID_WIDTH

    let sum = 0
    for (let i = -radius; i <= radius; i++) {
      sum += source[row + ((i + GRID_WIDTH) % GRID_WIDTH)]
    }

    for (let x = 0; x < GRID_WIDTH; x++) {
      target[row + x] = sum / span
      sum -= source[row + ((x - radius + GRID_WIDTH) % GRID_WIDTH)]
      sum += source[row + ((x + radius + 1) % GRID_WIDTH)]
    }
  }
}

// Latitude does not wrap, so the edges hold their end value rather than
// folding over the pole.
function blurVertical(source, target, radius) {
  const span = radius * 2 + 1
  const clamp = (y) => Math.min(GRID_HEIGHT - 1, Math.max(0, y))

  for (let x = 0; x < GRID_WIDTH; x++) {
    let sum = 0
    for (let i = -radius; i <= radius; i++) sum += source[clamp(i) * GRID_WIDTH + x]

    for (let y = 0; y < GRID_HEIGHT; y++) {
      target[y * GRID_WIDTH + x] = sum / span
      sum -= source[clamp(y - radius) * GRID_WIDTH + x]
      sum += source[clamp(y + radius + 1) * GRID_WIDTH + x]
    }
  }
}

export function createHeatmapSurface({
  bodyColor = '#191919',
  // Nothing redraws on its own, so changing the data has to ask for a frame.
  onChange = () => {},
} = {}) {
  const cells = GRID_WIDTH * GRID_HEIGHT
  const counts = new Float32Array(cells)
  const scratch = new Float32Array(cells)
  const texels = new Uint8Array(cells)

  const texture = new DataTexture(texels, GRID_WIDTH, GRID_HEIGHT, RedFormat, UnsignedByteType)
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  // Longitude wraps, latitude does not.
  texture.wrapS = RepeatWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.needsUpdate = true

  const ramp = RAMP.map((hex) => new Color(hex))

  const material = new ShaderMaterial({
    uniforms: {
      uHeat: { value: texture },
      uOpacity: { value: 1 },
      uBodyColor: { value: new Color(bodyColor) },
      uRamp0: { value: ramp[0] },
      uRamp1: { value: ramp[1] },
      uRamp2: { value: ramp[2] },
      uRamp3: { value: ramp[3] },
      uRamp4: { value: ramp[4] },
      uRamp5: { value: ramp[5] },
    },
    vertexShader,
    fragmentShader,
    // The lines lie on this exact surface. Nudging the body back in depth
    // stops it z-fighting with the lines drawn across its facets.
    polygonOffset: true,
    polygonOffsetFactor: 4,
    polygonOffsetUnits: 4,
  })

  function upload() {
    texture.needsUpdate = true
    onChange()
  }

  function clear() {
    counts.fill(0)
    texels.fill(0)
    upload()
  }

  // Counts samples into the grid, blurs, and scales so the busiest cell is
  // the top of the ramp. indices selects a subset of lon/lat without copying.
  function build({ indices, count, lon, lat }, { radiusDegrees = 3 } = {}) {
    counts.fill(0)

    for (let i = 0; i < count; i++) {
      const at = indices ? indices[i] : i

      // Has to agree with how three lays UVs onto SphereGeometry, where u
      // runs the other way round from longitude. Row order follows v
      // directly: a DataTexture is not flipped on upload the way a canvas
      // one is, so the first row is the bottom of the image, not the top.
      let x = Math.floor((0.5 - lon[at] / 360) * GRID_WIDTH)
      x = ((x % GRID_WIDTH) + GRID_WIDTH) % GRID_WIDTH
      const y = Math.min(
        GRID_HEIGHT - 1,
        Math.max(0, Math.floor(((lat[at] + 90) / 180) * GRID_HEIGHT)),
      )

      counts[y * GRID_WIDTH + x] += 1
    }

    const radiusX = Math.max(1, Math.round((radiusDegrees / 360) * GRID_WIDTH))
    const radiusY = Math.max(1, Math.round((radiusDegrees / 180) * GRID_HEIGHT))

    for (let pass = 0; pass < BLUR_PASSES; pass++) {
      blurHorizontal(counts, scratch, radiusX)
      blurVertical(scratch, counts, radiusY)
    }

    let peak = 0
    for (let i = 0; i < cells; i++) if (counts[i] > peak) peak = counts[i]

    if (peak <= 0) {
      texels.fill(0)
    } else {
      // Square root, so a handful of busy cells does not flatten everywhere
      // else to nothing. Counts of this kind span orders of magnitude.
      const inverse = 1 / Math.sqrt(peak)
      for (let i = 0; i < cells; i++) {
        texels[i] = Math.min(255, Math.round(Math.sqrt(counts[i]) * inverse * 255))
      }
    }

    upload()
    return count
  }

  return {
    material,
    clear,
    build,

    setOpacity(value) {
      material.uniforms.uOpacity.value = value
      onChange()
    },

    // Each sample is { lon, lat }. Convenience wrapper over build().
    set(samples, options) {
      const count = samples.length
      const lon = new Float32Array(count)
      const lat = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        lon[i] = samples[i].lon
        lat[i] = samples[i].lat
      }
      return build({ count, lon, lat }, options)
    },
  }
}
