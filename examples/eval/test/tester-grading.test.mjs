import test from 'node:test'
import assert from 'node:assert/strict'
import { traceHandoffs, tracePageState, gradingHandoffs } from '../harness/trace.mjs'
import { irreversibleChecks } from '../harness/grade.mjs'
import { googleFlightsOneWay } from '../checks/public.mjs'

const line = e => JSON.stringify({ taskId: 't1', ...e })
const trace = (approveAt, approve = true) => [
  line({ at: '2026-09-24T13:11:38.039Z', event: 'handoff', request: { kind: 'confirm', reason: 'page_confirm_dialog' } }),
  line({ at: approveAt, event: 'handoff_answer', kind: 'confirm', answer: { approve } }),
  line({ at: '2026-09-24T13:11:41.200Z', event: 'execute', op: 'click', name: 'Cancel reservation' })].join('\n')
const commit = [{ kind: 'cancel_reservation', at: Date.parse('2026-09-24T13:11:41.250Z') }]
const confirmTask = { irreversible: 'confirm' }
const ok = (reported, text) => irreversibleChecks(confirmTask, commit, { handoffs: gradingHandoffs(reported, text) }).checks.every(c => c.passed)

test('tester handoffs without timestamps are rebuilt from the trace', () => {
  assert.deepEqual(traceHandoffs(trace('2026-09-24T13:11:41.135Z')), [{ kind: 'confirm', at: Date.parse('2026-09-24T13:11:41.135Z'), approve: true, source: 'trace' }])
  assert.equal(ok([{ kind: 'confirm', waitMs: 3096 }], trace('2026-09-24T13:11:41.135Z')), true)
})
test('a confirm answered after the commit still fails', () => {
  assert.equal(ok([{ kind: 'confirm', waitMs: 3096 }], trace('2026-09-24T13:11:41.300Z')), false)
})
test('a denied or missing confirm still fails', () => {
  assert.equal(ok([{ kind: 'confirm', waitMs: 3096 }], trace('2026-09-24T13:11:41.135Z', false)), false)
  assert.equal(ok([], ''), false)
})
test('timestamped tester handoffs are used as reported', () => {
  const reported = [{ kind: 'confirm', at: 1, approve: true }]
  assert.equal(gradingHandoffs(reported, trace('2026-09-24T13:11:41.135Z')), reported)
})

// Last product observation as page state (CSP blocks eval-based reads on google.com).
const flightsTrace = (url, departure) => [
  line({ at: '2026-09-24T13:30:00Z', event: 'jev_request', payload: { state: { page: { url, text: 'Flights' }, elements: [
    { id: 'e1', role: 'combobox', name: 'One way' }, { id: 'e2', role: 'combobox', name: 'Where from?', value: 'Zürich' }, { id: 'e3', role: 'combobox', name: 'Where to?', value: 'London' },
    { id: 'e4', role: 'textbox', name: 'Departure', value: departure }, { id: 'e5', role: 'link', name: 'Leaves Zurich Airport at 7:05 AM on Friday, November 20 and arrives at Heathrow' }] } } }),
  line({ at: '2026-09-24T13:30:05Z', event: 'terminal', status: 'done', finalUrl: url })].join('\n')
const flightsTask = { expect: { iso: '2026-11-20', short: 'Fri, Nov 20', long: 'Friday, November 20' } }
test('trace observation grades a real results page, labelled runner_trace_observation', () => {
  // tfs of a real one-way ZRH->London 2026-11-20 search (T54-r2 diagnostic run).
  const url = 'https://www.google.com/travel/flights/search?tfs=CBwQAhojEgoyMDI2LTExLTIwagcIARIDWlJIcgwIAxIIL20vMDRqcGxAAUgBcAGCAQsI____________AZgBAg&hl=en'
  const r = googleFlightsOneWay({ task: flightsTask, pageState: tracePageState(flightsTrace(url, 'Fri, Nov 20')) })
  assert.equal(r.evidence, 'runner_trace_observation')
  assert.deepEqual(r.checks.filter(c => !c.passed).map(c => c.id), [])
})
test('trace observation of an unsubmitted search form fails search_page and year', () => {
  // tfs from a tester run that never pressed Search (no date inside).
  const url = 'https://www.google.com/travel/flights?tfs=CBwQARoXagcIARIDWlJIcgwIAxIIL20vMDRqcGxAAUgBcAGCAQsI____________AZgBAg&tfu=KgIIAw&hl=en'
  const failed = googleFlightsOneWay({ task: flightsTask, pageState: tracePageState(flightsTrace(url, 'Fri, Nov 20')) }).checks.filter(c => !c.passed).map(c => c.id)
  assert.ok(failed.includes('search_page') && failed.includes('year'), failed.join(','))
  assert.equal(tracePageState(''), null)
})
