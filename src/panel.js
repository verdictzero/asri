import { Color } from 'three'

import { dateToDay, dayToDate, histogram, loadEvents, selectEvents } from './events.js'

// The first three slots of the categorical palette, which are the most that
// stay distinguishable when every pair can appear together, as they do on a
// map. Six hues were measured and two pairs failed: magenta against aqua is
// indistinguishable to a deuteranope, and yellow against orange is hard to
// separate with full colour vision. So the two categories that carry real
// weight get their own hue and the rare ones share the third. Every category
// still filters on its own, and the chips are labelled, so nothing depends on
// telling colours apart.
const CATEGORY_COLORS = ['#3987e5', '#d95926', '#199e70']

const HISTOGRAM_BUCKETS = 260

// How long a full play-through of the selected span takes.
const PLAY_SECONDS = 24

const MARKER_SIZE = 3.4

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})
const yearOf = (day) => dayToDate(day).getUTCFullYear()

function label(day) {
  return dayFormat.format(dayToDate(day))
}

export async function createPanel({ globe, onChange = () => {} }) {
  const events = await loadEvents()

  const element = {
    panel: document.getElementById('panel'),
    categories: document.getElementById('categories'),
    selectAll: document.getElementById('select-all'),
    selectNone: document.getElementById('select-none'),
    heatmap: document.getElementById('heatmap'),
    range: document.getElementById('range'),
    histogram: document.getElementById('histogram'),
    selection: document.getElementById('selection'),
    playhead: document.getElementById('playhead'),
    handleFrom: document.getElementById('handle-from'),
    handleTo: document.getElementById('handle-to'),
    play: document.getElementById('play'),
    readout: document.getElementById('readout'),
    count: document.getElementById('count'),
    apply: document.getElementById('apply'),
  }

  // Ordered by how many events each holds, so the largest take the hues that
  // are easiest to tell apart.
  const order = events.categories
    .map((name, index) => ({ name, index, total: events.counts[name] ?? 0 }))
    .sort((a, b) => b.total - a.total)

  const palette = new Array(events.categories.length)
  const swatch = new Array(events.categories.length)
  order.forEach(({ index }, rank) => {
    const hex = CATEGORY_COLORS[Math.min(rank, CATEGORY_COLORS.length - 1)]
    palette[index] = new Color(hex)
    swatch[index] = hex
  })

  const enabled = new Uint8Array(events.categories.length).fill(1)
  const selection = new Uint32Array(events.count)

  const span = { first: events.firstDay, last: events.lastDay }
  let pendingFrom = span.first
  let pendingTo = span.last
  let activeFrom = span.first
  let activeTo = span.last
  let playhead = span.last
  let playing = false
  let playingSince = 0
  let heatmapOn = false
  let lastHeatmapAt = 0

  const dayToFraction = (day) => (day - span.first) / Math.max(1, span.last - span.first)
  const fractionToDay = (t) =>
    Math.round(span.first + Math.min(1, Math.max(0, t)) * (span.last - span.first))

  // --- drawing ----------------------------------------------------------

  const bins = histogram(events, HISTOGRAM_BUCKETS)
  // Square root, because a couple of peak years hold more events than whole
  // decades elsewhere and would otherwise flatten everything else to nothing.
  const binPeak = Math.sqrt(Math.max(...bins))

  function drawHistogram() {
    const canvas = element.histogram
    const ratio = Math.min(window.devicePixelRatio, 2)
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (!width || !height) return

    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)

    const context = canvas.getContext('2d')
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)

    const barWidth = width / HISTOGRAM_BUCKETS
    for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
      const value = binPeak > 0 ? Math.sqrt(bins[i]) / binPeak : 0
      const barHeight = Math.max(value > 0 ? 1 : 0, value * (height - 2))
      const day = fractionToDay((i + 0.5) / HISTOGRAM_BUCKETS)
      const inside = day >= pendingFrom && day <= pendingTo

      context.fillStyle = inside ? '#6a6a6a' : '#2f2f2f'
      context.fillRect(i * barWidth, height - barHeight, Math.max(1, barWidth - 0.5), barHeight)
    }

    drawYearTicks(context, width, height)
  }

  // Without these the track is an unlabelled bar: the span runs to centuries
  // and the readout only names the two ends.
  function drawYearTicks(context, width, height) {
    const firstYear = yearOf(span.first)
    const lastYear = yearOf(span.last)
    const step = [10, 25, 50, 100].find((n) => (lastYear - firstYear) / n <= 8) ?? 200

    context.font = '10px ui-sans-serif, system-ui, sans-serif'
    context.textBaseline = 'top'

    for (let year = Math.ceil(firstYear / step) * step; year <= lastYear; year += step) {
      const x = dayToFraction(dateToDay(new Date(Date.UTC(year, 0, 1)))) * width
      if (x < 12 || x > width - 12) continue

      context.fillStyle = '#242424'
      context.fillRect(x, 0, 1, height)

      context.fillStyle = '#5a5a5a'
      context.textAlign = 'center'
      context.fillText(String(year), x, 2)
    }
  }

  function drawRange() {
    const from = dayToFraction(pendingFrom) * 100
    const to = dayToFraction(pendingTo) * 100

    element.selection.style.left = `${from}%`
    element.selection.style.width = `${Math.max(0, to - from)}%`
    element.handleFrom.style.left = `${from}%`
    element.handleTo.style.left = `${to}%`

    for (const [node, day] of [
      [element.handleFrom, pendingFrom],
      [element.handleTo, pendingTo],
    ]) {
      node.setAttribute('aria-valuemin', String(yearOf(span.first)))
      node.setAttribute('aria-valuemax', String(yearOf(span.last)))
      node.setAttribute('aria-valuenow', String(yearOf(day)))
      node.setAttribute('aria-valuetext', label(day))
    }

    element.playhead.hidden = !playing && playhead >= activeTo
    element.playhead.style.left = `${dayToFraction(playhead) * 100}%`

    const dirty = pendingFrom !== activeFrom || pendingTo !== activeTo
    element.apply.dataset.dirty = String(dirty)
    element.readout.textContent = `${label(pendingFrom)} — ${label(pendingTo)}`

    drawHistogram()
  }

  // --- plotting ---------------------------------------------------------

  function refresh({ rebuildHeat = true } = {}) {
    const upTo = playing || playhead < activeTo ? playhead : activeTo
    const total = selectEvents(events, { fromDay: activeFrom, toDay: upTo, enabled }, selection)

    globe.points.plot({
      indices: selection,
      count: total,
      lon: events.lon,
      lat: events.lat,
      group: events.category,
      palette,
      size: MARKER_SIZE,
    })

    if (heatmapOn && rebuildHeat) {
      globe.heatmap.build(
        { indices: selection, count: total, lon: events.lon, lat: events.lat },
        { radiusDegrees: 2.5 },
      )
    }

    element.count.textContent = `${total.toLocaleString()} of ${events.count.toLocaleString()} events`
    onChange()
  }

  // --- interaction ------------------------------------------------------

  function dayAtPointer(event) {
    const box = element.range.getBoundingClientRect()
    return fractionToDay((event.clientX - box.left) / Math.max(1, box.width))
  }

  function dragHandle(node, read, write) {
    node.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      node.setPointerCapture(event.pointerId)

      const move = (moveEvent) => {
        write(dayAtPointer(moveEvent))
        drawRange()
      }
      const up = () => {
        node.removeEventListener('pointermove', move)
        node.removeEventListener('pointerup', up)
      }

      node.addEventListener('pointermove', move)
      node.addEventListener('pointerup', up)
    })

    node.addEventListener('keydown', (event) => {
      // A year at a time, ten with shift, since the span runs to centuries.
      const step = event.shiftKey ? 3652 : 365
      if (event.key === 'ArrowLeft') write(read() - step)
      else if (event.key === 'ArrowRight') write(read() + step)
      else return

      event.preventDefault()
      drawRange()
    })
  }

  dragHandle(
    element.handleFrom,
    () => pendingFrom,
    (day) => {
      pendingFrom = Math.min(Math.max(span.first, day), pendingTo)
    },
  )
  dragHandle(
    element.handleTo,
    () => pendingTo,
    (day) => {
      pendingTo = Math.max(Math.min(span.last, day), pendingFrom)
    },
  )

  // Dragging on the track itself scrubs the playhead, which is the natural
  // thing to reach for once a span has been applied.
  element.range.addEventListener('pointerdown', (event) => {
    if (event.target !== element.range && event.target !== element.histogram) return
    element.range.setPointerCapture(event.pointerId)
    playing = false
    element.play.textContent = 'Play'

    const scrub = (moveEvent) => {
      playhead = Math.min(activeTo, Math.max(activeFrom, dayAtPointer(moveEvent)))
      drawRange()
      refresh({ rebuildHeat: false })
    }
    const up = () => {
      element.range.removeEventListener('pointermove', scrub)
      element.range.removeEventListener('pointerup', up)
      refresh()
    }

    scrub(event)
    element.range.addEventListener('pointermove', scrub)
    element.range.addEventListener('pointerup', up)
  })

  element.apply.addEventListener('click', () => {
    activeFrom = pendingFrom
    activeTo = pendingTo
    playhead = activeTo
    playing = false
    element.play.disabled = activeTo <= activeFrom
    element.play.textContent = 'Play'
    drawRange()
    refresh()
  })

  element.play.addEventListener('click', () => {
    if (playing) {
      playing = false
      element.play.textContent = 'Play'
    } else {
      // Starting from the end would have nothing left to show.
      if (playhead >= activeTo) playhead = activeFrom
      playing = true
      // Wound back by however far along the playhead already is, so pausing
      // and resuming carries on from there rather than restarting.
      const spanDays = Math.max(1, activeTo - activeFrom)
      const progress = (playhead - activeFrom) / spanDays
      playingSince = performance.now() - progress * PLAY_SECONDS * 1000
      element.play.textContent = 'Pause'
    }
    drawRange()
  })

  function buildChips() {
    for (const { name, index, total } of order) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'chip'
      chip.setAttribute('aria-pressed', 'true')
      chip.style.color = swatch[index]
      chip.innerHTML =
        `<span class="chip__swatch"></span>${name.replace(/_/g, ' ')}` +
        `<span class="chip__count">${total.toLocaleString()}</span>`

      chip.addEventListener('click', () => {
        enabled[index] = enabled[index] ? 0 : 1
        chip.setAttribute('aria-pressed', String(Boolean(enabled[index])))
        refresh()
      })

      element.categories.append(chip)
    }
  }

  function setAll(value) {
    enabled.fill(value)
    for (const chip of element.categories.children) {
      chip.setAttribute('aria-pressed', String(Boolean(value)))
    }
    refresh()
  }

  element.selectAll.addEventListener('click', () => setAll(1))
  element.selectNone.addEventListener('click', () => setAll(0))

  element.heatmap.addEventListener('click', () => {
    heatmapOn = !heatmapOn
    element.heatmap.setAttribute('aria-pressed', String(heatmapOn))
    if (!heatmapOn) globe.heatmap.clear()
    refresh()
  })

  buildChips()
  element.panel.hidden = false
  drawRange()
  refresh()

  new ResizeObserver(drawHistogram).observe(element.histogram)

  return {
    // Advances playback. Driven from the render loop so it shares one clock.
    tick(now) {
      if (!playing) return false

      const spanDays = activeTo - activeFrom
      if (spanDays <= 0) return false

      if (playingSince === 0) playingSince = now
      const elapsed = (now - playingSince) / 1000
      const next = activeFrom + Math.round((elapsed / PLAY_SECONDS) * spanDays)

      if (next >= activeTo) {
        playhead = activeTo
        playing = false
        playingSince = 0
        element.play.textContent = 'Play'
      } else {
        playhead = next
      }

      // The heatmap costs a blur over the whole grid, which is far more than
      // a frame's worth of work at playback rates, so it lags a little rather
      // than pacing the animation.
      const rebuildHeat = heatmapOn && now - lastHeatmapAt > 120
      if (rebuildHeat) lastHeatmapAt = now

      drawRange()
      refresh({ rebuildHeat })
      return true
    },
  }
}
