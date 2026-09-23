import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { googleFlightsOneWay } from '../checks/public.mjs'

// Real read-only page reads captured 2026-09-24 through the harness page reader
// (UI flow: trip type, Zurich, London, date, Search; nothing selected or booked).
const load = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)))
const task = { expect: { iso: '2026-11-20', short: 'Fri, Nov 20', long: 'Friday, November 20' } }
const failed = page => googleFlightsOneWay({ task, pageState: load(page) }).checks.filter(c => !c.passed).map(c => c.id)

test('captured one-way 2026-11-20 results page passes every check', () => {
  assert.deepEqual(failed('flights-oneway-2026-11-20'), [])
})
test('captured round-trip page fails one_way', () => {
  assert.deepEqual(failed('flights-roundtrip-2026-11-20'), ['one_way'])
})
test('captured one-way page for the wrong date fails date, year and results', () => {
  assert.deepEqual(failed('flights-oneway-2026-11-21'), ['date', 'year', 'results'])
})
