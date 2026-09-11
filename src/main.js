import './styles.css'

import { Clock, MathUtils, PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import { createGlobe } from './globe.js'
import { createPanel } from './panel.js'
import { GLOBE_RADIUS } from './sphere.js'

// How much room the globe leaves around itself. At 1 it would touch the edge
// of whichever viewport dimension is tighter. Narrow viewports get a tighter
// margin, so the globe still has presence on a phone instead of floating in a
// tall empty column.
const FIT_MARGIN_WIDE = 1.45
const FIT_MARGIN_NARROW = 1.2

// Seconds per full rotation, while the globe is still spinning on its own.
const ROTATION_PERIOD = 48

// Earth's axial tilt, applied as camera roll. This has to be set before the
// controls are built, since they capture the up vector to orbit around.
const AXIAL_TILT = MathUtils.degToRad(23.4)

// The closest the camera may get to the centre. The globe's radius is 1, so
// this leaves it just above the surface.
const MIN_DISTANCE = 1.12

// OrbitControls damps rotation and panning, but applies zoom in a single
// step and clears it, so every wheel notch lands as a jump. The drawn
// distance eases toward the distance the controls are holding instead. This
// is the fraction of the remaining gap closed per sixtieth of a second; the
// easing is worked out from elapsed time rather than per frame, so it takes
// the same moment whatever rate the machine is drawing at.
const ZOOM_EASE = 0.16

const MAX_PIXEL_RATIO = 2

// Ceiling on the drawing buffer, in pixels. Past this the cost is all fill
// rate spent on detail nobody can resolve, and it is easy to blow through:
// a 4K display at devicePixelRatio 2, or any display once the page itself is
// zoomed out, asks for a buffer several times this size.
const MAX_DRAWING_BUFFER_PIXELS = 6.5e6

// Frame budget for the adaptive buffer scale. Rendering is only ever as
// heavy as the machine it lands on, and this session could not reproduce the
// slow case, so the globe measures itself and backs off rather than trusting
// any fixed guess about what a GPU can manage.
const SLOW_FRAME_MS = 42
const FAST_FRAME_MS = 20
// Roughly a second of sustained slowness, so a single hitch during a drag
// does not drop the resolution.
const SLOW_FRAMES_BEFORE_BACKING_OFF = 30
const FAST_FRAMES_BEFORE_RECOVERING = 90
const MIN_QUALITY = 0.45
const QUALITY_STEP = 0.72

function main() {
  const canvas = document.getElementById('globe')

  let renderer
  try {
    // Transparent, so the globe composites straight onto the page background
    // and there is only one place that colour is defined.
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true })
  } catch {
    // Without WebGL there is nothing to draw. The page is its background.
    return
  }

  renderer.setClearColor(0x000000, 0)

  // Scaled down when frames run long, back up when they are comfortable.
  let quality = 1

  // devicePixelRatio is not fixed: it changes when the page is zoomed or the
  // window moves to another display. Setting it once at startup leaves the
  // buffer sized for a ratio that no longer applies, which is how a zoom can
  // quietly ask for a buffer several times larger than the screen.
  function applyPixelRatio(width, height) {
    const budget = Math.sqrt(MAX_DRAWING_BUFFER_PIXELS / Math.max(1, width * height))
    const ratio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO, budget) * quality

    const clamped = Math.max(MIN_QUALITY, ratio)
    renderer.setPixelRatio(clamped)
    globe.setPixelRatio(clamped)
  }

  const scene = new Scene()
  const camera = new PerspectiveCamera(35, 1, 0.01, 100)
  camera.up.set(Math.sin(AXIAL_TILT), Math.cos(AXIAL_TILT), 0)
  camera.position.set(0, 0, 3)

  // Declared before the globe, which calls back into it as layers load.
  let needsRender = true

  const globe = createGlobe({
    onChange: () => {
      needsRender = true
    },
  })
  scene.add(globe.object)

  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.075
  controls.rotateSpeed = 0.42
  controls.zoomSpeed = 0.8
  controls.minDistance = MIN_DISTANCE
  // Panning would slide the globe off centre with no way to recover it.
  controls.enablePan = false

  const clock = new Clock()
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  let frame = null
  // The globe turns on its own until someone takes hold of it, then it is
  // theirs. Resuming would drift whatever they were looking at off screen.
  let spinning = !reducedMotion.matches
  let framed = false

  controls.addEventListener('start', () => {
    spinning = false
  })

  // The distance the controls believe in, and the one actually drawn.
  let zoomTarget = camera.position.length()
  let zoomShown = zoomTarget

  // The controls dolly from wherever the camera currently is, including from
  // inside their own wheel handler, which runs between our frames. So the
  // camera is left at the distance they expect and only moved to the eased
  // distance for the moment it takes to draw.
  let easedAt = 0

  function updateControls() {
    const moved = controls.update()
    zoomTarget = camera.position.length()

    const now = performance.now()
    // Capped so a backgrounded tab does not resume with one enormous step.
    const elapsed = easedAt === 0 ? 1 / 60 : Math.min(0.25, (now - easedAt) / 1000)
    easedAt = now

    const previous = zoomShown
    zoomShown += (zoomTarget - zoomShown) * (1 - Math.pow(1 - ZOOM_EASE, elapsed * 60))
    if (Math.abs(zoomTarget - zoomShown) < zoomTarget * 5e-4) zoomShown = zoomTarget

    return moved || zoomShown !== previous
  }

  function fitDistance() {
    // Pull the camera back far enough for the globe to fit whichever frustum
    // dimension is tighter, so portrait viewports work too.
    const halfVertical = MathUtils.degToRad(camera.fov) / 2
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * camera.aspect)
    const halfAngle = Math.min(halfVertical, halfHorizontal)

    const margin = MathUtils.lerp(
      FIT_MARGIN_NARROW,
      FIT_MARGIN_WIDE,
      MathUtils.smoothstep(camera.aspect, 0.6, 1.2),
    )

    return (GLOBE_RADIUS / Math.sin(halfAngle)) * margin
  }

  function resize() {
    const { clientWidth, clientHeight } = canvas
    if (clientWidth === 0 || clientHeight === 0) return

    applyPixelRatio(clientWidth, clientHeight)
    renderer.setSize(clientWidth, clientHeight, false)
    globe.setResolution(clientWidth, clientHeight)
    camera.aspect = clientWidth / clientHeight

    const fit = fitDistance()
    // Framing is the furthest out worth going, so it doubles as the zoom-out
    // limit. Once someone has moved the camera, only the limit is updated;
    // their distance is left alone.
    controls.maxDistance = fit
    if (!framed) {
      camera.position.set(0, 0, fit)
      zoomTarget = fit
      zoomShown = fit
      framed = true
    } else {
      // A narrower viewport can pull the zoom-out limit in past where the
      // camera already is.
      zoomTarget = Math.min(zoomTarget, fit)
    }

    camera.updateProjectionMatrix()
    updateControls()
    needsRender = true
  }

  let slowFrames = 0
  let fastFrames = 0
  let lastFrameAt = 0

  // Only judged on frames that actually drew something, since an idle globe
  // skips rendering and would otherwise look infinitely fast.
  function trackFrameCost(now) {
    const elapsed = now - lastFrameAt
    lastFrameAt = now
    if (elapsed <= 0 || elapsed > 1000) return

    if (elapsed > SLOW_FRAME_MS) {
      fastFrames = 0
      slowFrames += 1
    } else if (elapsed < FAST_FRAME_MS) {
      slowFrames = 0
      fastFrames += 1
    }

    if (slowFrames >= SLOW_FRAMES_BEFORE_BACKING_OFF && quality > MIN_QUALITY) {
      quality = Math.max(MIN_QUALITY, quality * QUALITY_STEP)
      slowFrames = 0
      resize()
    } else if (fastFrames >= FAST_FRAMES_BEFORE_RECOVERING && quality < 1) {
      quality = Math.min(1, quality / QUALITY_STEP)
      fastFrames = 0
      resize()
    }
  }

  // The camera lives at the distance the controls expect and is only moved to
  // the eased distance for the moment it takes to draw, so a wheel notch
  // handled between frames still dollies from the right place.
  function render() {
    camera.position.setLength(zoomShown)
    renderer.render(scene, camera)
    camera.position.setLength(zoomTarget)
  }

  function tick(now) {
    frame = requestAnimationFrame(tick)

    if (spinning) {
      globe.object.rotation.y += (clock.getDelta() / ROTATION_PERIOD) * Math.PI * 2
      needsRender = true
    }

    panel?.tick(now)

    // Reports whether damping, input or the zoom easing actually moved the
    // camera, which is what lets an idle globe stop redrawing.
    if (updateControls()) needsRender = true

    if (!needsRender) {
      lastFrameAt = 0
      return
    }

    needsRender = false
    render()

    if (lastFrameAt === 0) lastFrameAt = now
    else trackFrameCost(now)
  }

  function stop() {
    if (frame === null) return
    cancelAnimationFrame(frame)
    frame = null
  }

  function start() {
    if (frame !== null || document.hidden) return
    // Drop the time spent paused, so the globe resumes instead of jumping.
    clock.getDelta()
    frame = requestAnimationFrame(tick)
  }

  // The event dataset and its controls arrive after the globe is already
  // turning, so a slow load never holds up first paint.
  let panel = null
  createPanel({
    globe,
    camera,
    canvas,
    onChange: () => {
      needsRender = true
    },
  })
    .then((created) => {
      panel = created
      needsRender = true
    })
    .catch((error) => {
      console.error('Could not start the event panel', error)
    })

  new ResizeObserver(resize).observe(canvas)

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop()
    else start()
  })

  reducedMotion.addEventListener('change', () => {
    spinning = spinning && !reducedMotion.matches
  })

  resize()
  start()

  // The globe is the point of the page, so give it a handle for plotting:
  //   asri.points.set([{ lon, lat }])
  //   asri.heatmap.set([{ lon, lat, weight }], { radiusDegrees: 8 })
  window.asri = globe

  // Reports what the renderer is actually doing. Frame cost depends entirely
  // on the machine, so this is how a slow globe can be described precisely
  // rather than guessed at: asri.diagnostics()
  globe.diagnostics = () => {
    const gl = renderer.getContext()
    return {
      devicePixelRatio: window.devicePixelRatio,
      pixelRatio: +renderer.getPixelRatio().toFixed(2),
      drawingBuffer: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
      megapixels: +((gl.drawingBufferWidth * gl.drawingBufferHeight) / 1e6).toFixed(2),
      qualityScale: +quality.toFixed(2),
      cameraDistance: +zoomShown.toFixed(3),
    }
  }
}

main()
