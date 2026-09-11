import eventsUrl from './generated/events.bin?url'

// Every detail chunk, as a hashed URL. Listing them eagerly costs a string
// each and nothing more: the files themselves are only fetched when a marker
// is actually clicked.
const detailUrls = Object.entries(
  import.meta.glob('./generated/details/*.json', { query: '?url', import: 'default', eager: true }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => url)

// Degrees per quantised unit. Must match scripts/build-events.mjs.
const SCALE = 180 / 32767

const MS_PER_DAY = 86400000

export function dayToDate(day) {
  return new Date(day * MS_PER_DAY)
}

export function dateToDay(date) {
  return Math.floor(date.getTime() / MS_PER_DAY)
}

export async function loadEvents() {
  const response = await fetch(eventsUrl)
  if (!response.ok) throw new Error(`Could not load events: ${response.status}`)

  const buffer = await response.arrayBuffer()
  const view = new DataView(buffer)

  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4))
  if (magic !== 'ASRE') throw new Error('Events file is not in the expected format')

  const count = view.getUint32(8, true)
  const metaLength = view.getUint32(12, true)
  const meta = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 16, metaLength)).replace(/\0+$/, ''),
  )

  let offset = 16 + metaLength
  const steps = new Uint16Array(buffer, offset, count)
  offset += count * 2
  const rawLon = new Int16Array(buffer, offset, count)
  offset += count * 2
  const rawLat = new Int16Array(buffer, offset, count)
  offset += count * 2
  const country = new Uint16Array(buffer, offset, count)
  offset += count * 2
  const category = new Uint8Array(buffer, offset, count)
  offset += count
  const creature = new Uint8Array(buffer, offset, count)

  // Dates are stored as steps from the one before, which is what makes them
  // compress. Running them back up gives absolute days, still in order.
  const day = new Int32Array(count)
  let running = meta.baseDay
  for (let i = 0; i < count; i++) {
    running += steps[i]
    day[i] = running
  }

  const lon = new Float32Array(count)
  const lat = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    lon[i] = rawLon[i] * SCALE
    lat[i] = rawLat[i] * SCALE
  }

  const chunkCache = new Map()

  return {
    count,
    day,
    lon,
    lat,
    category,
    creature,
    country,
    categories: meta.categories,
    creatures: meta.creatures,
    countries: meta.countries,
    counts: meta.counts,
    creatureCounts: meta.creatureCounts,
    countryCounts: meta.countryCounts,
    firstDay: day[0],
    lastDay: day[count - 1],

    // The write-ups are split into numbered chunks, so reading one event's
    // text means fetching only the block it sits in. Chunks are kept once
    // fetched, since clicking around tends to stay in the same period.
    async detail(index) {
      const chunk = Math.floor(index / meta.detailsPerChunk)
      const url = detailUrls[chunk]
      if (!url) return null

      if (!chunkCache.has(chunk)) {
        chunkCache.set(
          chunk,
          fetch(url)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            .catch((error) => {
              chunkCache.delete(chunk)
              throw error
            }),
        )
      }

      const rows = await chunkCache.get(chunk)
      const row = rows[index - chunk * meta.detailsPerChunk]
      if (!row) return null

      const [name, location, description] = row
      return { name, location, description }
    },
  }
}

// Events are stored in date order, so the first index on or after a day is a
// binary search rather than a scan of eighty thousand records.
export function lowerBound(day, target) {
  let low = 0
  let high = day.length

  while (low < high) {
    const middle = (low + high) >> 1
    if (day[middle] < target) low = middle + 1
    else high = middle
  }

  return low
}

// Fills `into` with the indices of events inside [fromDay, toDay] that pass
// the filters, and returns how many there were. Reusing the same array avoids
// allocating a new one on every scrub frame.
//
// `creature` narrows the cryptid category alone, since that is the only one
// with a creature to name; the other categories pass through untouched.
// `country` and `creature` are -1 when not narrowing.
export function selectEvents(
  events,
  { fromDay, toDay, enabled, creature = -1, country = -1, cryptidCategory = -1 },
  into,
) {
  const start = lowerBound(events.day, fromDay)
  const end = lowerBound(events.day, toDay + 1)

  let written = 0
  for (let i = start; i < end; i++) {
    if (!enabled[events.category[i]]) continue
    if (country >= 0 && events.country[i] !== country) continue
    if (creature >= 0 && events.category[i] === cryptidCategory && events.creature[i] !== creature) {
      continue
    }
    into[written++] = i
  }

  return written
}

// Event counts per bucket across the whole span, for the timeline's
// histogram. Without it the slider gives no clue where the data actually is,
// and this data is bunched into a few decades of a much longer range.
export function histogram(events, buckets) {
  const bins = new Float64Array(buckets)
  const span = Math.max(1, events.lastDay - events.firstDay)

  for (let i = 0; i < events.count; i++) {
    const at = Math.min(buckets - 1, Math.floor(((events.day[i] - events.firstDay) / span) * buckets))
    bins[at] += 1
  }

  return bins
}
