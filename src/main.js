import './styles.css'

import {
  Clock,
  MathUtils,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three'

import { GLOBE_RADIUS, createGlobe } from './globe.js'

// How much room the globe leaves around itself. At 1 it would touch the
// edge of whichever viewport dimension is tighter. Narrow viewports get a
// tighter margin, so the globe still has presence on a phone instead of
// floating in a tall empty column.
const FIT_MARGIN_WIDE = 1.45
const FIT_MARGIN_NARROW = 1.2

// Seconds per full rotation.
const ROTATION_PERIOD = 48

// Earth's axial tilt, applied as camera roll. The graticule is symmetric
// about its polar axis, so rolling the camera and spinning the globe about
// its own axis look the same, and this keeps the spin a plain world-Y turn.
const AXIAL_TILT = MathUtils.degToRad(23.4)

const MAX_PIXEL_RATIO = 2

function main() {
  const canvas = document.getElementById('globe')

  let renderer
  try {
    // Transparent, so the globe composites straight onto the page
    // background and there is only one place that colour is defined.
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true })
  } catch {
    // Without WebGL there is nothing to draw. The page is its background.
    return
  }

  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO))

  const scene = new Scene()
  const camera = new PerspectiveCamera(35, 1, 0.1, 100)
  camera.up.set(Math.sin(AXIAL_TILT), Math.cos(AXIAL_TILT), 0)

  const globe = createGlobe()
  scene.add(globe.object)

  const clock = new Clock()
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  let frame = null

  function render() {
    renderer.render(scene, camera)
  }

  function resize() {
    const { clientWidth, clientHeight } = canvas
    if (clientWidth === 0 || clientHeight === 0) return

    renderer.setSize(clientWidth, clientHeight, false)
    globe.setResolution(clientWidth, clientHeight)
    camera.aspect = clientWidth / clientHeight

    // Pull the camera back far enough for the globe to fit whichever
    // frustum dimension is tighter, so portrait viewports work too.
    const halfVertical = MathUtils.degToRad(camera.fov) / 2
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * camera.aspect)
    const halfAngle = Math.min(halfVertical, halfHorizontal)

    const margin = MathUtils.lerp(
      FIT_MARGIN_NARROW,
      FIT_MARGIN_WIDE,
      MathUtils.smoothstep(camera.aspect, 0.6, 1.2),
    )

    camera.position.set(0, 0, (GLOBE_RADIUS / Math.sin(halfAngle)) * margin)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()

    render()
  }

  function tick() {
    globe.object.rotation.y += (clock.getDelta() / ROTATION_PERIOD) * Math.PI * 2
    render()
    frame = requestAnimationFrame(tick)
  }

  function stop() {
    if (frame === null) return
    cancelAnimationFrame(frame)
    frame = null
  }

  function start() {
    if (frame !== null || document.hidden || reducedMotion.matches) return
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
    if (reducedMotion.matches) stop()
    else start()
  })

  resize()
  start()
}

main()
