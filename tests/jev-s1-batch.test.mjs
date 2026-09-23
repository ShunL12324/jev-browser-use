import test from 'node:test'
import assert from 'node:assert/strict'
import { validateS1Task, adaptObservation, enumerate, compile, compileBatch, decideBatch, rebind, batchSet, runS1 } from '../packages/bridge/src/jev/s1.mjs'
const origin = 'http://127.0.0.1:17431'
const field = (ref, name, extra = {}) => ({ ref, facts: { name, role: 'textbox', tag: 'input', visible: true, disabled: false, readonly: false, modalBlocked: false, inert: false, nativeText: true, nativeActivate: false, value: '', shadowContext: false, nameTruncated: false, context: [], ...extra } })
const button = (ref, name) => field(ref, name, { role: 'button', tag: 'button', nativeText: false, nativeActivate: true, value: null })
const raw = (objects, documentId = 'd1') => ({ documentId, url: origin + '/', capturedAt: '', view: { documentId, content: '', truncated: false }, snapshot: { documentId, coverage: { matched: objects.length, returned: objects.length, truncated: false } }, objects: structuredClone(objects), assertions: [], scroll: { x: 0, y: 0 } })
const value = (text, name, context) => ({ text, purpose: name, target: { role: 'textbox', name, ...(context ? { context } : {}) } })
const task = (extra = {}) => validateS1Task({ profile: 'complex_forms', decision: 'form_batch', goal: 'Fill the form', startUrl: origin + '/', allowedOrigins: [origin], values: { name: value('Alex', 'Name'), email: value('a@x.test', 'Email') }, maxSteps: 20, maxRequests: 6, ...extra })
const choiceAnswer = (criteria, pick, p = 1) => ({ type: 'choice', choice: pick, probabilities: Object.fromEntries(Object.keys(criteria).map(k => [k, k === pick ? p : (1 - p) / (Object.keys(criteria).length - 1)])) })
// Deterministic answerer: bind every question to its first target unless
// overridden; next picks `next` by target name; Nouls default low.
const answerer = ({ bind = () => [undefined, 1], next = () => ['none', 1], fit = () => 0, goal = 0 } = {}) => async ({ questions }) => ({ usage: { input_tokens: 10 }, answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => {
  if (q.type === 'noul') return [id, { type: 'noul', noul: id === 'goal_met' ? goal : fit(q) }]
  if (id === 'next') { const [name, p, op] = next(q); const pick = Object.entries(q.criteria).find(([, c]) => (c.target?.name === name && (!op || c.operation === op)) || c.operation === name)?.[0] ?? 'none'; return [id, choiceAnswer(q.criteria, pick, p)] }
  const [pick, p] = bind(q); return [id, choiceAnswer(q.criteria, pick ?? Object.keys(q.criteria)[0], p)]
})) })
// Stateful fake page: execute applies text/checked; hooks mutate after actions.
function page(objects, hooks = {}) {
  const state = { objects: structuredClone(objects), documentId: 'd1', executed: [] }
  const call = async (name, args) => {
    if (name === 'tabs') return { tabId: 1 }
    if (name === 'navigate') return {}
    if (args.action === 'observe') return raw(state.objects, state.documentId)
    const target = state.objects.find(o => o.ref === args.ref)
    if (args.documentId !== state.documentId || (target && JSON.stringify(target.facts) !== JSON.stringify(args.expected))) return { execution: 'not_sent', code: 'STALE_REF' }
    state.executed.push(args)
    if (args.text !== undefined) target.facts.value = args.text
    if (args.operation === 'scroll_into_view') target.facts.centerReachable = true
    hooks[args.ref]?.(state, args)
    return { execution: 'returned' }
  }
  return { state, call }
}
const run = async (t, p, ask) => { const events = []; let asks = 0; const result = await runS1(t, { call: p.call, emit: e => events.push(e), ask: async payload => { asks++; return ask(payload) } }); return { result, events, asks: () => asks } }

test('form_batch is opt-in and only valid with complex_forms; default stays single', () => {
  assert.equal(validateS1Task({ goal: 'g', startUrl: origin, allowedOrigins: [origin] }).decision, 'single')
  assert.throws(() => validateS1Task({ goal: 'g', startUrl: origin, allowedOrigins: [origin], decision: 'form_batch' }), { code: 'TASK' })
  assert.equal(task().minSuitability, 0.8)
})
test('batch compiles one binding question per pending value and keeps inputs out of next/fits', () => {
  const t = task(), o = adaptObservation(raw([field('e1', 'Name'), field('e2', 'Email'), button('e3', 'Continue')]), 1), set = enumerate(o, t)
  const c = compileBatch(o, t, set)
  assert.deepEqual(Object.values(c.binds).map(b => b.valueId), ['name', 'email'])
  assert.deepEqual(Object.values(c.binds).map(b => b.targets), [1, 1])
  for (const id of Object.keys(c.binds)) assert.deepEqual(Object.keys(c.payload.questions[id].criteria).length, 2)
  assert.ok(Object.values(c.payload.questions.next.criteria).every(x => typeof x === 'string' || !['replace_text', 'select_option', 'set_checked', 'upload_file'].includes(x.operation)))
  assert.equal(Object.keys(c.fits).length, Object.keys(c.payload.questions.next.criteria).length - 1)
  assert.equal(c.payload.state.selectionPolicy, 'form_batch_v1')
  assert.ok(c.bytes < 48000)
  assert.throws(() => compileBatch(o, { ...t, decision: 'single' }, set), { code: 'STALE_INTENT' })
  // Legacy single payload for the same observation is unaffected by the new mode.
  assert.deepEqual(compile(o, { ...t, decision: 'single' }, set).questions.operation.criteria, compile(o, t, set).questions.operation.criteria)
})
test('value not on page gets no question; attached file is not re-offered', () => {
  const t = task({ values: { name: value('Alex', 'Name'), missing: value('x', 'Not here') }, files: { cv: { fileId: 'cv', purpose: 'CV', target: { role: 'file', name: 'CV' } } } })
  const file = field('e2', 'CV', { role: 'file', nativeText: false, nativeFile: true, files: [] })
  let o = adaptObservation(raw([field('e1', 'Name'), file]), 1)
  assert.deepEqual(Object.values(compileBatch(o, t, enumerate(o, t)).binds).map(b => b.valueId), ['name', 'cv'])
  file.facts.files = [{ name: 'cv.pdf', size: 3, type: 'application/pdf' }]
  o = adaptObservation(raw([field('e1', 'Name'), file]), 1)
  assert.deepEqual(Object.values(compileBatch(o, t, enumerate(o, t)).binds).map(b => b.valueId), ['name'])
})
test('decision drops not_now, low probability and conflicting bindings; orders by observation', () => {
  const t = task({ values: { name: value('Alex', 'Name'), email: value('a@x.test', 'Email'), alt: value('b@x.test', 'Email'), zip: value('1', 'Zip') } })
  const o = adaptObservation(raw([field('e1', 'Zip'), field('e2', 'Email'), field('e3', 'Name'), field('e4', 'Other')]), 1), set = enumerate(o, t)
  const c = compileBatch(o, t, set), q = c.payload.questions, answers = { goal_met: { type: 'noul', noul: 0 } }
  for (const [id, { valueId }] of Object.entries(c.binds)) {
    const first = Object.keys(q[id].criteria)[0]
    answers[id] = valueId === 'name' ? choiceAnswer(q[id].criteria, first, 0.55) : choiceAnswer(q[id].criteria, first, 0.9)
  }
  answers.next = choiceAnswer(q.next.criteria, 'none')
  for (const f of Object.keys(c.fits)) answers[f] = { type: 'noul', noul: 0 }
  const d = decideBatch(o, t, set, c, answers)
  assert.deepEqual(d.bindings.map(b => b.valueId), ['zip'])
  assert.deepEqual(d.drops.map(x => [x.valueId, x.reason]).sort(), [['alt', 'binding_conflict'], ['email', 'binding_conflict'], ['name', 'low_probability']])
  const zipId = Object.entries(c.binds).find(([, b]) => b.valueId === 'zip')[0]
  answers[zipId] = choiceAnswer(q[zipId].criteria, 'not_now')
  assert.ok(decideBatch(o, t, set, c, answers).drops.some(x => x.valueId === 'zip' && x.reason === 'not_now'))
})
test('next policy: choice gate, suitability gate only for argmax fit, else uncertain', () => {
  const t = task({ values: {} }), o = adaptObservation(raw([button('e1', 'Open'), button('e2', 'Continue')]), 1), set = enumerate(o, t), c = compileBatch(o, t, set)
  const q = c.payload.questions, open = set.candidates.find(x => x.targetId === 'e1').id, cont = set.candidates.find(x => x.targetId === 'e2').id
  const fitsFor = values => Object.fromEntries(Object.entries(c.fits).map(([f, cid]) => [f, { type: 'noul', noul: values[cid] ?? 0 }]))
  const decide = (pick, p, fits) => decideBatch(o, t, set, c, { next: choiceAnswer(q.next.criteria, pick, p), goal_met: { type: 'noul', noul: 0 }, ...fitsFor(fits) }).next
  assert.equal(decide(open, 0.7, {}).basis, 'choice')
  assert.equal(decide(open, 0.45, { [open]: 0.9, [cont]: 0.3 }).basis, 'suitability')
  assert.equal(decide(open, 0.45, { [open]: 0.85, [cont]: 0.9 }).basis, 'uncertain')
  assert.equal(decide(open, 0.45, { [open]: 0.7 }).basis, 'uncertain')
  assert.equal(decide('none', 0.9, {}).basis, 'none')
})
test('one request applies several simultaneously valid fields, then navigation is decided next round', async () => {
  const p = page([field('e1', 'Name'), field('e2', 'Email'), button('e3', 'Continue')])
  const { result, events, asks } = await run(task({ maxSteps: 3 }), p, answerer({ next: () => ['Continue', 0.9] }))
  assert.deepEqual(p.state.executed.map(e => [e.ref, e.text]), [['e1', 'Alex'], ['e2', 'a@x.test'], ['e3', undefined]])
  assert.equal(asks(), 2); assert.equal(result.status, 'step_limit')
  const d = events.find(e => e.event === 'batch_decision')
  assert.deepEqual(d.questions, { bind: 2, fits: 7, next: 1, goal_met: 1 }); assert.deepEqual(d.bindTargetCounts, [1, 1])
  assert.ok(d.payloadBytes > 0 && d.inputTokens === 10)
  assert.ok(events.filter(e => e.event === 'batch_round').every(e => e.modelMs >= 0 && e.observationMs >= 0 && e.executionMs >= 0))
  assert.ok(events.filter(e => e.event === 'parameter_binding').every(e => e.method === 'batch'))
})
test('identity change mid-batch stops remaining bindings without executing them', async () => {
  const p = page([field('e1', 'Name'), field('e2', 'Email')], { e1: s => { s.objects[1].facts.name = 'Email address' } })
  const { events } = await run(task({ maxRequests: 2 }), p, answerer())
  assert.deepEqual(p.state.executed.map(e => e.ref), ['e1'])
  const stop = events.find(e => e.event === 'batch_stopped')
  assert.equal(stop.reason, 'identity_changed'); assert.equal(stop.valueId, 'email')
})
test('document change and new rows stop the batch; new row values are only asked on the next observation', async () => {
  const p = page([field('e1', 'Name'), field('e2', 'Email')], { e1: s => { s.documentId = 'd2' } })
  let r = await run(task({ maxRequests: 1 }), p, answerer())
  assert.deepEqual(p.state.executed.map(e => e.ref), ['e1']); assert.equal(r.events.find(e => e.event === 'batch_stopped').reason, 'identity_changed')
  const t = task({ values: { a: value('One', 'Company', 'Row 1'), b: value('Two', 'Company', 'Row 2') }, maxRequests: 3, maxSteps: 3 })
  const rows = page([field('e1', 'Company', { context: ['Row 1'] }), button('e2', 'Add row')], { e2: s => { s.objects.push(field('e3', 'Company', { context: ['Row 2'] })) } })
  r = await run(t, rows, answerer({ next: () => ['Add row', 0.9] }))
  const decisions = r.events.filter(e => e.event === 'batch_decision')
  assert.deepEqual(decisions.map(d => d.accepted.map(a => a.valueId)), [['a'], [], ['b']])
  assert.deepEqual(rows.state.executed.map(e => [e.ref, e.text]), [['e1', 'One'], ['e2', undefined], ['e3', 'Two']])
})
test('stale refs at dispatch stop the batch and use bounded recovery', async () => {
  const p = page([field('e1', 'Name'), field('e2', 'Email')])
  const call = p.call; let first = true
  p.call = async (name, args) => { if (args.action === 'execute' && first) { first = false; return { execution: 'not_sent', code: 'STALE_REF' } } return call(name, args) }
  const { events } = await run(task({ maxRequests: 2, maxSteps: 2 }), p, answerer())
  assert.equal(events.find(e => e.event === 'batch_stopped').reason, 'not_sent')
  assert.deepEqual(p.state.executed.map(e => e.ref), ['e1', 'e2'])
})
test('option removed before its turn is dropped as not_in_domain', () => {
  const t = task({ values: { city: { text: 'Toronto', purpose: 'City', target: { role: 'combobox', name: 'City' } } } })
  const select = field('e1', 'City', { role: 'combobox', tag: 'select', nativeText: false, nativeSelect: true, options: [{ value: 'Toronto', disabled: false }] })
  const judged = adaptObservation(raw([select]), 1), set = enumerate(judged, t)
  const binding = { valueId: 'city', candidate: set.candidates.find(c => c.operationId === 'select_option') }
  select.facts.options = []
  const current = adaptObservation(raw([select]), 1)
  assert.equal(rebind(judged, current, t, binding).reason, 'not_in_domain')
  select.facts.options = [{ value: 'Toronto', disabled: false }]; select.facts.disabled = true
  assert.equal(rebind(judged, adaptObservation(raw([select]), 1), t, binding).reason, 'not_eligible')
})
test('uncertain navigation and high goal_met never complete or dispatch', async () => {
  const p = page([button('e1', 'Continue')])
  let r = await run(task({ values: {} }), p, answerer({ next: () => ['Continue', 0.5], fit: () => 0.5 }))
  assert.equal(r.result.code, 'UNCERTAIN'); assert.equal(p.state.executed.length, 0)
  const receipt = { id: 'receipt', scope: { frame: 'top', root: { kind: 'selector', css: 'main' } }, subject: 'scope', read: 'text', predicate: 'contains', expected: 'Received', freshness: 'current' }
  const q = page([field('e1', 'Name')])
  r = await run(task({ values: { name: value('Alex', 'Name') }, assertions: [receipt], maxRequests: 2 }), q, answerer({ goal: 1 }))
  assert.notEqual(r.result.status, 'verified'); assert.notEqual(r.result.status, 'reported_done')
  assert.equal(r.result.code, 'NO_CANDIDATE')
})
test('offscreen targets are offered with reveal; host scrolls, re-checks and then acts without another request', async () => {
  const t = task({ values: { name: value('Alex', 'Name') }, maxSteps: 4, maxRequests: 2 })
  const hidden = field('e1', 'Name', { centerReachable: false }), next = { ...button('e2', 'Continue') }; next.facts.centerReachable = false
  const o = adaptObservation(raw([hidden, next]), 1), set = enumerate(o, t)
  assert.ok(!set.candidates.some(c => c.operationId === 'replace_text'))
  const batch = batchSet(o, t, set), c = compileBatch(o, t, batch)
  const bind = c.payload.questions[Object.keys(c.binds)[0]]
  assert.ok(Object.values(bind.criteria).some(x => x.operation === 'replace_text' && x.reveal))
  assert.ok(Object.values(c.payload.questions.next.criteria).some(x => x.operation === 'activate' && x.reveal))
  const p = page([hidden, next])
  const { asks } = await run(t, p, answerer({ next: () => ['Continue', 0.9, 'activate'] }))
  assert.deepEqual(p.state.executed.map(e => [e.operation, e.ref]), [['scroll_into_view', 'e1'], ['replace_text', 'e1'], ['scroll_into_view', 'e2'], ['activate', 'e2']])
  assert.equal(asks(), 2)
})
test('reveal that changes page identity stops without acting', async () => {
  const hidden = field('e1', 'Name', { centerReachable: false })
  const p = page([hidden], { e1: (s, args) => { if (args.operation === 'scroll_into_view') s.objects.push(button('e9', 'Injected')) } })
  const { events } = await run(task({ values: { name: value('Alex', 'Name') }, maxRequests: 1 }), p, answerer())
  assert.deepEqual(p.state.executed.map(e => e.operation), ['scroll_into_view'])
  assert.equal(events.find(e => e.event === 'batch_stopped').reason, 'identity_changed')
})
