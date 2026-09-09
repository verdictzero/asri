// Turns the paranormal events CSV into the compact binary the globe loads.
//
// The CSV is 23MB, nearly all of it prose the map never draws. Only four
// things are plotted: when, where, and which category. Sorting by date first
// means the runtime can find a date range by binary search instead of
// scanning, and makes the dates delta-encode down to almost nothing.
//
// Run with `npm run build:events`. The output is committed, so the app build
// stays hermetic.

import { createReadStream, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = process.argv[2] ?? join(HERE, '..', 'data', 'paranormal_events.csv')
const OUT = join(HERE, '..', 'src', 'generated', 'events.bin')

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

const events = []
const categoryIndex = new Map()
const skipped = { undated: 0, future: 0, unplaced: 0 }

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

  const name = row[column.category] || 'unknown'
  if (!categoryIndex.has(name)) categoryIndex.set(name, categoryIndex.size)

  events.push({ day: day / MS_PER_DAY, lon, lat, category: categoryIndex.get(name) })
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
for (let i = 0; i < count; i++) {
  lons[i] = Math.round(events[i].lon * SCALE)
  lats[i] = Math.round(events[i].lat * SCALE)
  categories[i] = events[i].category
}

const perCategory = {}
for (const [name, index] of categoryIndex) {
  perCategory[name] = categories.reduce((sum, c) => sum + (c === index ? 1 : 0), 0)
}

const meta = JSON.stringify({
  baseDay,
  categories: [...categoryIndex.keys()],
  counts: perCategory,
})
const metaBytes = new TextEncoder().encode(meta)
// Padded so the typed arrays that follow start on a four-byte boundary.
const metaLength = Math.ceil(metaBytes.length / 4) * 4

const headerBytes = 16 + metaLength
const buffer = new ArrayBuffer(headerBytes + count * 2 + count * 2 + count * 2 + count)
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
new Uint8Array(buffer, offset, count).set(categories)

writeFileSync(OUT, Buffer.from(buffer))

const iso = (day) => new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
console.log(`events    ${count} plotted, ${iso(baseDay)} -> ${iso(previous)}`)
console.log(`skipped   ${skipped.undated} undated, ${skipped.future} future-dated, ${skipped.unplaced} unplaced`)
console.log(`widest gap between consecutive events: ${widestGap} days`)
console.log(`categories ${JSON.stringify(perCategory)}`)
console.log(`${(buffer.byteLength / 1024).toFixed(0)}kB`)
