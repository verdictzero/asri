import { CanvasTexture, Color, LinearFilter, ShaderMaterial } from 'three'

// The heatmap is painted into an equirectangular canvas and used as the
// globe body's own texture, so it is part of the one opaque surface rather
// than a shell floating above it. Nothing to z-fight, and it is occluded on
// the far side for free.
const TEXTURE_WIDTH = 2048
const TEXTURE_HEIGHT = 1024

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
    float heat = texture2D(uHeat, vUv).r;

    // The ramp's low end is already much lighter than the body, so easing the
    // blend across the bottom of the range is what gives a sample a soft edge
    // instead of landing as a flat disc.
    vec3 color = mix(uBodyColor, rampColor(heat), smoothstep(0.0, 0.42, heat));

    gl_FragColor = vec4(color, 1.0);

    #include <colorspace_fragment>
  }
`

// Longitude/latitude to a pixel in the equirectangular canvas. This has to
// agree with how three lays UVs onto SphereGeometry, where u runs the other
// way round from longitude.
function toCanvas(lon, lat) {
  return {
    x: (0.5 - lon / 360) * TEXTURE_WIDTH,
    y: ((90 - lat) / 180) * TEXTURE_HEIGHT,
  }
}

export function createHeatmapSurface({
  bodyColor = '#191919',
  // Nothing redraws on its own, so changing the data has to ask for a frame.
  onChange = () => {},
} = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = TEXTURE_WIDTH
  canvas.height = TEXTURE_HEIGHT

  const context = canvas.getContext('2d', { willReadFrequently: false })
  context.fillStyle = '#000000'
  context.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT)

  // Mipmaps left on deliberately: at the default framing this 2048x1024
  // texture is minified hard onto a small globe, and sampling it without them
  // scatters every fragment's reads across the whole image.
  const texture = new CanvasTexture(canvas)
  texture.magFilter = LinearFilter

  const ramp = RAMP.map((hex) => new Color(hex))

  const material = new ShaderMaterial({
    uniforms: {
      uHeat: { value: texture },
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

  function clear() {
    context.fillStyle = '#000000'
    context.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT)
    texture.needsUpdate = true
    onChange()
  }

  return {
    material,
    clear,

    // Each sample is { lon, lat } and may carry a weight. radiusDegrees is
    // how far a sample's influence spreads across the surface.
    set(samples, { radiusDegrees = 6, max } = {}) {
      context.fillStyle = '#000000'
      context.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT)

      const ceiling = max ?? Math.max(1e-6, ...samples.map((s) => s.weight ?? 1))

      // Overlapping samples should sum rather than paint over each other.
      context.globalCompositeOperation = 'lighter'

      const radiusY = (radiusDegrees / 180) * TEXTURE_HEIGHT

      for (const sample of samples) {
        const { x, y } = toCanvas(sample.lon, sample.lat)
        const intensity = Math.min(1, (sample.weight ?? 1) / ceiling)

        // Longitude compresses toward the poles, so a patch that is round on
        // the globe has to be drawn wider than it is tall near them.
        const cosLat = Math.max(0.08, Math.cos((sample.lat * Math.PI) / 180))
        const radiusX = ((radiusDegrees / 360) * TEXTURE_WIDTH) / cosLat

        // Drawn three times so a sample near the seam bleeds across it
        // instead of being cut in half.
        for (const offset of [-TEXTURE_WIDTH, 0, TEXTURE_WIDTH]) {
          const centreX = x + offset
          if (centreX + radiusX < 0 || centreX - radiusX > TEXTURE_WIDTH) continue

          const gradient = context.createRadialGradient(centreX, y, 0, centreX, y, radiusY)
          gradient.addColorStop(0, `rgba(255, 255, 255, ${intensity})`)
          gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')

          context.save()
          context.translate(centreX, y)
          context.scale(radiusX / radiusY, 1)
          context.translate(-centreX, -y)
          context.fillStyle = gradient
          context.fillRect(centreX - radiusY, y - radiusY, radiusY * 2, radiusY * 2)
          context.restore()
        }
      }

      context.globalCompositeOperation = 'source-over'
      texture.needsUpdate = true
      onChange()

      return samples.length
    },
  }
}
