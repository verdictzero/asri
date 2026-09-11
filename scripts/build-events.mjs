// Turns the paranormal events CSV into the compact binary the globe loads.
//
// The CSV is 23MB, nearly all of it prose the map never draws. Only four
// things are plotted: when, where, and which category. Sorting by date first
// means the runtime can find a date range by binary search instead of
// scanning, and makes the dates delta-encode down to almost nothing.
//
// Run with `npm run build:events`. The output is committed, so the app build
// stays hermetic.

import { feature } from 'topojson-client'
import countries50m from 'world-atlas/countries-50m.json' with { type: 'json' }

import { createReadStream, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = process.argv[2] ?? join(HERE, '..', 'data', 'paranormal_events.csv')
const OUT = join(HERE, '..', 'src', 'generated', 'events.bin')
const DETAIL_DIR = join(HERE, '..', 'src', 'generated', 'details')

// Clicking a marker should show what the record says, but the write-ups come
// to 11MB across the whole file. They are split into numbered chunks instead,
// so a click fetches only the block holding that event.
const DETAILS_PER_CHUNK = 1000

// Reports that describe being taken, rather than only seeing something. The
// word is specific enough to be worth trusting: the matches read "i was
// abducted" and "abduction out of bed", not passing mentions.
const ABDUCTION = /abduct/i

// Cryptid reports name their creature in the case title. Everything from the
// BFRO is a bigfoot report by definition of the source, which covers all but
// a handful.
const CREATURES = [
  [/bigfoot|sasquatch/i, 'bigfoot'],
  [/mothman/i, 'mothman'],
  [/flatwoods/i, 'flatwoods monster'],
  [/dover demon/i, 'dover demon'],
  [/loch ness/i, 'loch ness'],
  [/lizard man/i, 'lizard man'],
  [/hopkinsville/i, 'hopkinsville goblins'],
  [/jersey devil/i, 'jersey devil'],
  [/chupacabra/i, 'chupacabra'],
  [/skinwalker/i, 'skinwalker'],
  [/loveland frogman/i, 'loveland frogman'],
  [/gevaudan/i, 'beast of gevaudan'],
  [/nightcrawler/i, 'nightcrawlers'],
]

// Matches scripts/build-boundaries.mjs so both use the same quantisation.
const SCALE = 32767 / 180

const MS_PER_DAY = 86400000

// Anything dated after this is a transcription error rather than a record.
const FUTURE_CUTOFF = new Date().getUTCFullYear() + 1

// A minimal CSV reader: the file has quoted fields containing commas,
// newlines and doubled quotes, which a split on commas would tear apart.
function* parseRows(text) {
  let field = ''
  let row = []
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (quoted) {
      if (char !== '"') field += char
      else if (text[i + 1] === '"') { field += '"'; i++ }
      else quoted = false
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field); field = ''
    } else if (char === '\n') {
      row.push(field); yield row; row = []; field = ''
    } else if (char !== '\r') {
      field += char
    }
  }

  if (field !== '' || row.length) { row.push(field); yield row }
}

// Dates come in three shapes: a full date, a month, or a bare year. The
// partial ones are real records and worth keeping, placed at the start of
// whatever period they name.
function parseDate(value) {
  const text = (value ?? '').trim()

  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match) return Date.UTC(+match[1], +match[2] - 1, +match[3])

  match = /^(\d{4})-(\d{2})$/.exec(text)
  if (match) return Date.UTC(+match[1], +match[2] - 1, 1)

  match = /^(\d{4})$/.exec(text)
  if (match) return Date.UTC(+match[1], 0, 1)

  return null
}

// Which country a point falls in, so the map can be narrowed to one place.
// The location column cannot be trusted for this: a third of the rows end in
// a state code rather than a country, and 2,394 distinct endings appear.
// Testing the coordinates against the country outlines is unambiguous.
function buildCountryLookup() {
  const shapes = []

  for (const { id, properties, geometry } of feature(countries50m, countries50m.objects.countries)
    .features) {
    if (!geometry) continue

    const polygons =
      geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates

    let west = 180
    let east = -180
    let south = 90
    let north = -90

    for (const rings of polygons) {
      for (const [lon, lat] of rings[0]) {
        if (lon < west) west = lon
        if (lon > east) east = lon
        if (lat < south) south = lat
        if (lat > north) north = lat
      }
    }

    shapes.push({ id, name: properties.name, polygons, west, east, south, north })
  }

  return shapes
}

// Ray casting: counts how many times a ray east from the point crosses the
// ring. An odd count means inside.
function inRing(ring, lon, lat) {
  let inside = false

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]

    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }

  return inside
}

function countryAt(shapes, lon, lat) {
  for (const shape of shapes) {
    // The bounding box rejects almost every country outright, which is what
    // keeps this affordable across eighty thousand points.
    if (lon < shape.west || lon > shape.east || lat < shape.south || lat > shape.north) continue

    for (const rings of shape.polygons) {
      if (!inRing(rings[0], lon, lat)) continue
      // A hit inside a hole is not inside the country.
      let inHole = false
      for (let h = 1; h < rings.length; h++) {
        if (inRing(rings[h], lon, lat)) { inHole = true; break }
      }
      if (!inHole) return shape.name
    }
  }

  return null
}

const text = await new Promise((resolve, reject) => {
  const chunks = []
  createReadStream(SOURCE, 'utf8')
    .on('data', (c) => chunks.push(c))
    .on('end', () => resolve(chunks.join('')))
    .on('error', reject)
})

const rows = parseRows(text)
const header = rows.next().value
const column = Object.fromEntries(header.map((name, i) => [name, i]))

const shapes = buildCountryLookup()

const events = []
const categoryIndex = new Map()
const creatureIndex = new Map([['', 0]])
const countryIndex = new Map([['', 0]])
const skipped = { undated: 0, future: 0, unplaced: 0 }
const reclassified = { abduction: 0 }

for (const row of rows) {
  if (row.length < header.length) continue

  const day = parseDate(row[column.date])
  if (day === null) { skipped.undated += 1; continue }
  if (new Date(day).getUTCFullYear() > FUTURE_CUTOFF) { skipped.future += 1; continue }

  const lat = Number(row[column.latitude])
  const lon = Number(row[column.longitude])
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    skipped.unplaced += 1
    continue
  }

  const caseName = row[column.case_name] ?? ''
  const description = row[column.description] ?? ''

  let name = row[column.category] || 'unknown'

  // Being taken is a different kind of report from seeing a light, and the
  // source data files both under the same heading.
  if ((name === 'ufo_uap' || name === 'alien_encounter') && ABDUCTION.test(caseName + description)) {
    name = 'alien_abduction'
    reclassified.abduction += 1
  }

  let creature = ''
  if (name === 'cryptid') {
    if (row[column.source_type] === 'bulk_bfro') creature = 'bigfoot'
    else creature = CREATURES.find(([pattern]) => pattern.test(caseName))?.[1] ?? 'other'
  }

  const country = countryAt(shapes, lon, lat) ?? ''

  if (!categoryIndex.has(name)) categoryIndex.set(name, categoryIndex.size)
  if (!creatureIndex.has(creature)) creatureIndex.set(creature, creatureIndex.size)
  if (!countryIndex.has(country)) countryIndex.set(country, countryIndex.size)

  events.push({
    day: day / MS_PER_DAY,
    lon,
    lat,
    category: categoryIndex.get(name),
    creature: creatureIndex.get(creature),
    country: countryIndex.get(country),
    caseName,
    description,
    location: row[column.location] ?? '',
  })
}

events.sort((a, b) => a.day - b.day)

const baseDay = events[0].day
const count = events.length

// Deltas between neighbouring dates, which is what makes this compress: most
// are zero or one, and the whole run is monotonic.
const days = new Uint16Array(count)
let previous = baseDay
let widestGap = 0
for (let i = 0; i < count; i++) {
  const gap = events[i].day - previous
  if (gap > widestGap) widestGap = gap
  if (gap > 65535) throw new Error(`gap of ${gap} days exceeds what a uint16 step can hold`)
  days[i] = gap
  previous = events[i].day
}

const lons = new Int16Array(count)
const lats = new Int16Array(count)
const categories = new Uint8Array(count)
const creatures = new Uint8Array(count)
const countries = new Uint16Array(count)
for (let i = 0; i < count; i++) {
  lons[i] = Math.round(events[i].lon * SCALE)
  lats[i] = Math.round(events[i].lat * SCALE)
  categories[i] = events[i].category
  creatures[i] = events[i].creature
  countries[i] = events[i].country
}

// Written in the same order as the events, so the chunk holding an event is
// simply its index divided by the chunk size.
rmSync(DETAIL_DIR, { recursive: true, force: true })
mkdirSync(DETAIL_DIR, { recursive: true })

let detailBytes = 0
for (let start = 0; start < count; start += DETAILS_PER_CHUNK) {
  const slice = events
    .slice(start, start + DETAILS_PER_CHUNK)
    .map((event) => [event.caseName, event.location, event.description])

  const json = JSON.stringify(slice)
  detailBytes += json.length
  writeFileSync(join(DETAIL_DIR, `${String(start / DETAILS_PER_CHUNK).padStart(4, '0')}.json`), json)
}

const tally = (values, lookup) => {
  const totals = {}
  for (const [name, index] of lookup) totals[name] = 0
  for (const value of values) totals[[...lookup.keys()][value]] += 1
  return totals
}

const perCategory = tally(categories, categoryIndex)
const perCreature = tally(creatures, creatureIndex)
const perCountry = tally(countries, countryIndex)

const meta = JSON.stringify({
  baseDay,
  detailsPerChunk: DETAILS_PER_CHUNK,
  categories: [...categoryIndex.keys()],
  creatures: [...creatureIndex.keys()],
  countries: [...countryIndex.keys()],
  counts: perCategory,
  creatureCounts: perCreature,
  countryCounts: perCountry,
})
const metaBytes = new TextEncoder().encode(meta)
// Padded so the typed arrays that follow start on a four-byte boundary.
const metaLength = Math.ceil(metaBytes.length / 4) * 4

const headerBytes = 16 + metaLength
const buffer = new ArrayBuffer(headerBytes + count * 2 * 4 + count * 2)
const view = new DataView(buffer)

new TextEncoder().encodeInto('ASRE', new Uint8Array(buffer, 0, 4))
view.setUint32(4, 1, true)
view.setUint32(8, count, true)
view.setUint32(12, metaLength, true)
new Uint8Array(buffer, 16, metaBytes.length).set(metaBytes)

let offset = headerBytes
new Uint16Array(buffer, offset, count).set(days); offset += count * 2
new Int16Array(buffer, offset, count).set(lons); offset += count * 2
new Int16Array(buffer, offset, count).set(lats); offset += count * 2
new Uint16Array(buffer, offset, count).set(countries); offset += count * 2
new Uint8Array(buffer, offset, count).set(categories); offset += count
new Uint8Array(buffer, offset, count).set(creatures)

writeFileSync(OUT, Buffer.from(buffer))

const iso = (day) => new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
console.log(`events    ${count} plotted, ${iso(baseDay)} -> ${iso(previous)}`)
console.log(`skipped   ${skipped.undated} undated, ${skipped.future} future-dated, ${skipped.unplaced} unplaced`)
console.log(`widest gap between consecutive events: ${widestGap} days`)
console.log(`reclassed ${reclassified.abduction} reports as alien_abduction`)
console.log(`categories ${JSON.stringify(perCategory)}`)
console.log(`creatures  ${JSON.stringify(perCreature)}`)
const placed = count - perCountry['']
console.log(`countries  ${countryIndex.size - 1} distinct, ${placed} of ${count} events placed`)
console.log(`${(buffer.byteLength / 1024).toFixed(0)}kB binary + ${(detailBytes / 1024 / 1024).toFixed(1)}MB of detail across ${Math.ceil(count / DETAILS_PER_CHUNK)} chunks`)
