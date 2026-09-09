import './styles.css'

import { Clock, MathUtils, PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import { createGlobe } from './globe.js'
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

const MAX_PIXEL_RATIO = 2

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
  const pixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO)
  renderer.setPixelRatio(pixelRatio)

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
  globe.setPixelRatio(pixelRatio)
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
      framed = true
    }

    camera.updateProjectionMatrix()
    controls.update()
    needsRender = true
  }

  function tick() {
    frame = requestAnimationFrame(tick)

    if (spinning) {
      globe.object.rotation.y += (clock.getDelta() / ROTATION_PERIOD) * Math.PI * 2
      needsRender = true
    }

    // Reports whether damping or input actually moved the camera, which is
    // what lets an idle globe stop redrawing.
    if (controls.update()) needsRender = true

    if (!needsRender) return
    needsRender = false
    renderer.render(scene, camera)
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
}

main()
