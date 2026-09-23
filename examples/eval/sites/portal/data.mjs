// Seeded synthetic library data. Deterministic per seed; never sent to runners
// except through the rendered pages themselves.
import { rng, pick } from '../../lib/common.mjs'

const ADJ = ['Silent', 'Amber', 'Hidden', 'Northern', 'Paper', 'Glass', 'Quiet', 'Copper', 'Winter', 'Distant', 'Lantern', 'Salt', 'Iron', 'Velvet', 'Hollow', 'Crimson']
const NOUN = ['Harbor', 'Orchard', 'Atlas', 'Meridian', 'Garden', 'Signal', 'Archive', 'Tide', 'Compass', 'Bridge', 'Canyon', 'Lighthouse', 'Market', 'Observatory', 'River', 'Station']
const FIRST = ['Ada', 'Bram', 'Cleo', 'Dario', 'Elin', 'Farah', 'Goran', 'Hana', 'Ivo', 'Juno', 'Kai', 'Lena', 'Milo', 'Nia', 'Oren', 'Pia']
const LAST = ['Arden', 'Brooks', 'Castell', 'Drummond', 'Ellery', 'Fontaine', 'Greaves', 'Hollis', 'Iverson', 'Jarrow', 'Keene', 'Lindqvist']
export const GENRES = ['Mystery', 'Science', 'History', 'Poetry', 'Travel', 'Cooking']
export const BRANCHES = ['Central', 'Riverside', 'Hillcrest', 'Old Town']
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

const cache = new Map()
export function libraryData(seed) {
  if (cache.has(seed)) return cache.get(seed)
  const r = rng('portal:' + seed), titles = new Set(), books = []
  while (books.length < 48) {
    const title = `The ${pick(r, ADJ)} ${pick(r, NOUN)}`
    if (titles.has(title)) continue
    titles.add(title)
    const id = books.length + 1
    books.push({
      id, title, author: `${pick(r, FIRST)} ${pick(r, LAST)}`, genre: GENRES[id % GENRES.length],
      year: 1950 + Math.floor(r() * 75), pages: 120 + Math.floor(r() * 500),
      isbn: `978-${1 + Math.floor(r() * 9)}-${String(Math.floor(r() * 100000)).padStart(5, '0')}-${String(Math.floor(r() * 1000)).padStart(3, '0')}-${Math.floor(r() * 10)}`,
      shelf: `${'ABCDEFGH'[Math.floor(r() * 8)]}-${1 + Math.floor(r() * 40)}`, available: r() > 0.3, copies: 1 + Math.floor(r() * 4)
    })
  }
  const dates = ['2026-10-03', '2026-10-04', '2026-10-10', '2026-10-11', '2026-10-17']
  const events = []
  for (const [i, date] of dates.entries()) for (let k = 0; k < 4; k++) {
    // Seats are distinct within a date so "most seats left" has one answer.
    events.push({ id: events.length + 1, date, title: `${pick(r, ['Workshop', 'Talk', 'Reading', 'Club', 'Clinic'])}: ${pick(r, ADJ)} ${pick(r, NOUN)}`, branch: pick(r, BRANCHES), time: `${10 + k * 2}:00`, seats: 3 + k * 7 + Math.floor(r() * 6) + i })
  }
  const branches = BRANCHES.map(name => ({
    name, members: 1200 + Math.floor(r() * 9000), visits: { 2024: 40000 + Math.floor(r() * 90000), 2025: 40000 + Math.floor(r() * 90000) },
    hours: Object.fromEntries(DAYS.map(d => [d, d === 'Sunday' && r() > 0.5 ? 'Closed' : `${8 + Math.floor(r() * 3)}:00-${16 + Math.floor(r() * 5)}:00`]))
  }))
  const data = { books, events, branches, dates }
  cache.set(seed, data)
  return data
}
