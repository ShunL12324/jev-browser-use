import test from 'node:test'
import assert from 'node:assert/strict'
import { tier, irreversible, bindCandidates, targets } from '../packages/bridge/src/agent/space.mjs'
import { build, invalidAnswers } from '../packages/bridge/src/agent/jev.mjs'
import { runTask, AGENT_PROTOCOL } from '../packages/bridge/src/agent/loop.mjs'

const origin = 'http://127.0.0.1:17441'
let n = 0
const el = (name, extra = {}) => ({ ref: `e${++n}`, role: 'textbox', name, tag: 'input', inputType: 'text', value: '', checked: null, selected: null, expanded: null, hasPopup: null, disabled: false, readonly: false, modalBlocked: false, dialog: null, context: [], href: null, editable: true, password: false, submit: false, formMethod: 'get', payment: false, inView: true, guard: 'g', ...extra })
const button = (name, extra = {}) => el(name, { role: 'button', tag: 'button', inputType: null, editable: false, value: null, ...extra })
const page = (elements, extra = {}) => ({ agentProtocol: AGENT_PROTOCOL, documentId: 'd1', url: origin + '/', title: 'T', text: '', scroll: { y: 0, height: 900, viewport: 900 }, elements, omitted: 0, marker: 'm', ...extra })
const task = (extra = {}) => ({ goal: 'g', startUrl: origin + '/', allowedOrigins: [origin], inputs: {}, irreversible: 'confirm', llm: 'handoff', budgets: { maxSteps: 20, maxJevRequests: 6, timeoutMs: 10000 }, ...extra })
const choice = (q, pick, p = 1) => ({ type: 'choice', choice: pick, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === pick ? p : (1 - p) / Math.max(1, Object.keys(q.criteria).length - 1)])) })

test('deterministic tiers follow observed facts', () => {
  const p = page([button('Continue')])
  assert.equal(tier('SCROLL_DOWN', null, p), 'R0')
  assert.equal(tier('SELECT', el('Country', { tag: 'select' }), p), 'R1')
  assert.equal(tier('CLICK', button('Menu', { expanded: false }), p), 'R0')
  assert.equal(tier('CLICK', el('Remote', { role: 'radio', inputType: 'radio', editable: false }), p), 'R1')
  assert.equal(tier('CLICK', button('Docs', { role: 'link', href: origin + '/#faq' }), p), 'R0')
  assert.equal(tier('CLICK', button('Docs', { role: 'link', href: origin + '/docs' }), p), 'R2')
  assert.equal(tier('CLICK', button('Search', { submit: true }), p), 'R2')
  assert.equal(tier('CLICK', button('Open panel'), p), 'R2')
})
test('irreversible: strong words need a commit signal; purchase words need a final step', () => {
  const next = button('Continue')
  assert.equal(irreversible(button('Confirm address'), page([next])), null)
  assert.equal(irreversible(button('Remove row'), page([])), null)
  assert.equal(irreversible(button('Delete account', { submit: true, formMethod: 'post' }), page([])), 'strong_word_commit')
  assert.equal(irreversible(button('Buy now'), page([])), 'purchase_final_step')
  assert.equal(irreversible(button('Buy now'), page([next])), null)
  assert.equal(irreversible(button('Submit order'), page([])), 'generic_final_step')
  const pay = button('Go', { submit: true })
  assert.equal(irreversible(pay, page([el('Card number', { payment: true }), pay])), 'payment_form')
})
test('binding candidates are type-compatible and never reuse bound or password fields', () => {
  const date = el('Start', { inputType: 'date' }), num = el('Salary', { inputType: 'number' }), text = el('Name'), pw = el('Password', { password: true })
  const radio = el('Hybrid', { role: 'radio', inputType: 'radio', checked: false, editable: false }), sel = el('Country', { tag: 'select', role: 'combobox', editable: false, options: [{ value: 'ca', label: 'Canada' }] })
  const box = el('Consent', { role: 'checkbox', inputType: 'checkbox', checked: false, editable: false }), file = el('CV', { inputType: 'file', editable: false })
  const p = page([date, num, text, pw, radio, sel, box, file])
  assert.deepEqual(Object.keys(bindCandidates(p, { value: '2027-02-15' }, new Set())), [date.ref, text.ref])
  assert.deepEqual(Object.keys(bindCandidates(p, { value: '95000' }, new Set())), [num.ref, text.ref])
  assert.deepEqual(Object.keys(bindCandidates(p, { value: 'hybrid' }, new Set())), [text.ref, radio.ref])
  assert.equal(bindCandidates(p, { value: 'Canada' }, new Set())[sel.ref].value, 'ca')
  assert.equal(bindCandidates(p, { value: 'true' }, new Set())[box.ref].checked, true)
  assert.deepEqual(Object.keys(bindCandidates(p, { fileId: 'cv' }, new Set())), [file.ref])
  assert.ok(!bindCandidates(p, { value: 'x' }, new Set())[pw.ref])
  assert.ok(bindCandidates(p, { value: 'x', secret: true, origins: [origin] }, new Set())[pw.ref])
  assert.ok(!bindCandidates(p, { value: 'x' }, new Set([text.ref]))[text.ref])
  assert.ok(!targets(p, new Set([text.ref])).TYPE_TEXT[text.ref])
})
test('request has one bind head per pending input, masks secrets and summarizes status from records', () => {
  const name = el('Full name'), pw = el('Password', { password: true }), go = button('Continue')
  const p = page([name, pw, go])
  const t = task({ inputs: { name: { value: 'Alex', purpose: 'full name' }, pw: { value: 's3cr3t', purpose: 'password', secret: true, origins: [origin] }, later: { fileId: 'cv', purpose: 'résumé' } } })
  const b = build(p, t, [])
  assert.deepEqual(Object.values(b.binds).map(x => x.valueId), ['name', 'pw'])
  assert.ok(!JSON.stringify(b.payload).includes('s3cr3t'))
  assert.ok(!JSON.stringify(b.payload.state.elements).includes('guard'))
  assert.equal(b.payload.state.inputSummary.pendingWithoutFieldHere, 1)
  assert.ok(!b.payload.questions.operation.criteria.BLOCKED)
  const after = build(p, t, [{ op: 'type', ref: name.ref, valueId: 'name', postcondition: 'met' }])
  assert.equal(after.payload.state.inputs.name.status, 'applied')
  assert.ok(!Object.values(after.binds).some(x => x.valueId === 'name'))
})
test('invalid answers are isolated per question', () => {
  const b = build(page([el('Name'), button('Go')]), task({ inputs: { a: { value: 'x', purpose: 'p' } } }), [])
  const q = b.payload.questions, answers = { operation: choice(q.operation, 'CLICK'), target_CLICK: { type: 'choice', choice: 'zzz', probabilities: {} } }
  const bad = invalidAnswers(q, answers)
  assert.ok(bad.has('target_CLICK') && bad.has('bind_1') && !bad.has('operation'))
})
test('blocked fields explain their modal and base eligibility without offering a bind', () => {
  const address = el('Address', { modalBlocked: true, modalBlockers: [{ ref: 'dialog', name: 'Service alert' }] })
  const aggregate = button('All suggestions', { role: 'generic', popupMember: { status: 'rejected', reason: 'aggregate_popup_container' } })
  const b = build(page([address, aggregate]), task({ inputs: { address: { value: 'Public landmark', purpose: 'address' } } }), [])
  assert.deepEqual(b.binds, {})
  assert.deepEqual(b.targets.CLICK, {})
  assert.deepEqual(b.payload.state.baseTargetExclusions, { modal_blocked: 1, aggregate_popup_container: 1 })
  assert.deepEqual(b.payload.state.elements[0].modalBlockers, address.modalBlockers)
  assert.equal(b.payload.state.elements[0].modalBlocked, true)
})

// Fake page for loop tests: execute mutates element facts; hooks follow.
function fake(elements, { hooks = {}, url = origin + '/' } = {}) {
  const s = { elements: structuredClone(elements), documentId: 'd1', url, executed: [] }
  const call = async (name, args) => {
    if (name === 'tabs') return { tabId: 7 }
    if (name === 'navigate') return {}
    if (args.action === 'agent_observe') return page(structuredClone(s.elements), { documentId: s.documentId, url: s.url, selectionWitnesses: s.selectionWitnesses, marker: JSON.stringify(s.elements.map(e => [e.value, e.checked])) })
    if (args.action === 'agent_settle') return { ok: true, navigating: false }
    const target = s.elements.find(e => e.ref === args.ref)
    if (args.documentId !== s.documentId || target && args.guard !== target.guard) return { ok: true, execution: 'not_sent', code: 'STALE_REF' }
    s.executed.push(args)
    if (args.op === 'type') target.value = args.text
    if (args.op === 'select') target.value = args.value
    if (args.op === 'check') target.checked = args.checked
    hooks[args.ref]?.(s, args)
    return { ok: true, execution: 'returned' }
  }
  return { s, call }
}
const spread = (keys, fixed) => { const rest = keys.filter(k => !(k in fixed)), left = 1 - keys.reduce((t, k) => t + (fixed[k] ?? 0), 0); return Object.fromEntries(keys.map(k => [k, fixed[k] ?? left / rest.length])) }
const jev = (fn) => async payload => ({ usage: { input_tokens: 5 }, answers: fn(payload) })
// Default answerer: first candidate for binds; op/target from `op(state)`.
const answer = ({ bind = () => 0, op = () => ['DONE'], p = 1, text, fields } = {}) => jev(({ state, questions }) => {
  const out = {}
  const [o, target, po = p] = op(state, questions)
  for (const [id, q] of Object.entries(questions)) {
    if (id.startsWith('bind_')) { const keys = Object.keys(q.criteria), i = bind(q); out[id] = choice(q, i === 'not_now' ? 'not_now' : keys[i], typeof i === 'number' ? 0.95 : 1) }
    else if (id === 'operation') out[id] = choice(q, o, po)
    else if (id.startsWith('field_')) out[id] = choice(q, fields?.(q) ?? 'keep')
    else if (id === 'text_value') out[id] = choice(q, text ? Object.keys(q.criteria).find(k => q.criteria[k] === text) : 'caller')
    else out[id] = choice(q, id === `target_${o}` && target ? target : Object.keys(q.criteria)[0])
  }
  return out
})
const run = (t, f, ask, handoff = async () => ({})) => { const events = []; return runTask(t, { call: f.call, ask, handoff, emit: e => events.push(e) }).then(result => ({ result, events })) }

test('one request fills several fields in page order, then consumes the post-batch operation', async () => {
  n = 0
  const a = el('Email'), b = el('Full name'), go = button('Continue')
  const f = fake([a, b, go]), t = task({ inputs: { name: { value: 'Alex', purpose: 'full name' }, email: { value: 'a@x.test', purpose: 'email' } } })
  let asks = 0
  const { result } = await run(t, f, async payload => { asks++; return answer({ bind: q => Object.keys(q.criteria).findIndex(k => q.instructions.includes('full name') ? k === b.ref : k === a.ref), op: s => asks === 1 ? ['CLICK', go.ref, 0.9] : ['DONE'] })(payload) })
  assert.deepEqual(f.s.executed.map(e => [e.op, e.ref]), [['type', a.ref], ['type', b.ref], ['click', go.ref]])
  assert.equal(asks, 2); assert.equal(result.status, 'done')
})
test('conflicting and low-probability bindings are dropped; post-batch op is then not consumed', async () => {
  n = 0
  const a = el('Name'), go = button('Continue')
  const f = fake([a, go]), t = task({ inputs: { x: { value: 'One', purpose: 'first' }, y: { value: 'Two', purpose: 'second' } } })
  let asks = 0
  const kinds = []
  const { events, result } = await run(t, f, async payload => { asks++; return answer({ op: () => asks === 1 ? ['CLICK', go.ref, 0.9] : ['DONE'] })(payload) }, async h => { kinds.push(h.kind); return {} })
  assert.deepEqual(f.s.executed, []); assert.deepEqual(kinds, ['choose']); assert.equal(result.status, 'blocked')
  assert.deepEqual(events.find(e => e.event === 'decision').drops.map(d => d.reason).sort(), ['binding_conflict', 'binding_conflict'])
})
test('below the R2 gate: one scroll fallback, then a choose handoff; llm none blocks without acting', async () => {
  n = 0
  const go = button('Continue')
  const f = fake([go]), shapes = []
  const ask = jev(({ questions }) => ({ operation: { type: 'choice', choice: 'CLICK', probabilities: spread(Object.keys(questions.operation.criteria), { CLICK: 0.45, SCROLL_DOWN: 0.3 }) }, ...Object.fromEntries(Object.entries(questions).filter(([id]) => id.startsWith('target_')).map(([id, q]) => [id, choice(q, Object.keys(q.criteria)[0])])) }))
  const tall = { ...fake([go]) }; tall.call = async (name, args) => { const r = await f.call(name, args); return args.action === 'agent_observe' ? { ...r, scroll: { y: 0, height: 3000, viewport: 900 } } : r }
  const { result } = await run(task(), tall, ask, async h => { shapes.push(h.kind); return {} })
  assert.deepEqual(f.s.executed.map(e => e.op), ['scroll_down'])
  assert.deepEqual(shapes, ['choose']); assert.equal(result.status, 'blocked', JSON.stringify(result))
  const none = fake([go]), r2 = await run(task({ llm: 'none' }), none, ask, async () => { throw Error('no handoff expected') })
  assert.equal(r2.result.status, 'blocked', JSON.stringify(r2.result)); assert.deepEqual(none.s.executed.map(e => e.op), ['wait'])
})
test('irreversible clicks need confirmation; deny mode never executes them', async () => {
  n = 0
  const buy = button('Place order', { submit: true })
  let clicks = 0
  const ask = answer({ op: (s, q) => q.target_CLICK && !clicks++ ? ['CLICK', buy.ref] : ['DONE'] })
  let f = fake([buy]), asked = []
  let r = await run(task(), f, ask, async h => { asked.push(h.kind); return { approve: false } })
  assert.deepEqual(asked, ['confirm']); assert.equal(r.result.status, 'blocked'); assert.deepEqual(f.s.executed, [])
  clicks = 0; f = fake([buy]); r = await run(task({ irreversible: 'deny' }), f, ask, async () => { throw Error('deny mode must not ask') })
  assert.equal(r.result.status, 'needs_confirmation'); assert.deepEqual(f.s.executed, [])
  clicks = 0; f = fake([buy]); r = await run(task(), f, ask, async () => ({ approve: true }))
  assert.deepEqual(f.s.executed.map(e => e.op), ['click'])
})
test('links outside the allowlist need a confirm handoff; denial blocks without clicking', async () => {
  n = 0
  const out = button('Partner', { role: 'link', href: 'https://elsewhere.test/x' })
  const f = fake([out]), kinds = []
  const { result } = await run(task(), f, answer({ op: () => ['CLICK', out.ref] }), async h => { kinds.push(h.reason); return { approve: false } })
  assert.deepEqual(kinds, ['allow_origin']); assert.equal(result.status, 'blocked'); assert.deepEqual(f.s.executed, [])
})
test('stale targets are not replayed; the loop re-observes and decides again', async () => {
  n = 0
  const go = button('Continue'), f = fake([go])
  const call = f.call; let first = true
  f.call = async (name, args) => { if (args.action === 'agent_execute' && first) { first = false; return { ok: true, execution: 'not_sent', code: 'STALE_REF' } } return call(name, args) }
  let asks = 0
  const { result } = await run(task(), f, async p => { asks++; return answer({ op: () => asks < 3 ? ['CLICK', go.ref] : ['DONE'] })(p) })
  assert.equal(f.s.executed.length, 1); assert.equal(result.metrics.stale, 1); assert.equal(result.status, 'done')
})
test('TYPE_TEXT asks the caller once per field and reuses the text', async () => {
  n = 0
  const q = el('Search'), f = fake([q]), texts = []
  let asks = 0
  await run(task(), f, async p => { asks++; return answer({ op: () => asks <= 2 ? ['TYPE_TEXT', q.ref] : ['DONE'] })(p) }, async h => { texts.push(h.kind); return { text: 'Lisbon' } })
  assert.deepEqual(texts, ['text']); assert.deepEqual(f.s.executed.filter(e => e.op === 'type').map(e => e.text), ['Lisbon'])
})
test('typing never silently presses Enter in search, date or ordinary fields', async () => {
  for (const [field, expectEnter] of [[() => el('Search'), false], [() => el('Departure'), false], [() => el('Destination', { form: 'f1', formMethod: 'post' }), false], [() => el('Notes'), false]]) {
    n = 0
    const q = field(), f = fake([q])
    let asks = 0
    await run(task({ goal: 'Find stays in Lisbon' }), f, async p => { asks++; return answer({ op: () => asks === 1 ? ['TYPE_TEXT', q.ref] : ['DONE'], text: 'Lisbon' })(p) }, async () => ({}))
    assert.equal(f.s.executed.some(e => e.op === 'key' && e.key === 'Enter'), expectEnter, q.name)
  }
})
test('an invalid operation answer executes nothing', async () => {
  n = 0
  const f = fake([button('Go')])
  const { result } = await run(task(), f, jev(() => ({ operation: { type: 'choice', choice: 'NOPE', probabilities: {} } })))
  assert.equal(result.status, 'error'); assert.equal(result.code, 'BAD_ANSWER'); assert.deepEqual(f.s.executed, [])
})
test('secrets stay out of every model payload and handoff', async () => {
  n = 0
  const pw = el('Password', { password: true }), f = fake([pw]), seen = []
  await run(task({ inputs: { pw: { value: 'hunter2!', purpose: 'account password', secret: true, origins: [origin] } } }), f, async payload => { seen.push(JSON.stringify(payload)); return answer({ op: () => ['DONE'] })(payload) })
  assert.ok(seen.length && seen.every(s => !s.includes('hunter2!')))
  assert.equal(f.s.executed[0].text, 'hunter2!')
})
test('literal text can come from a goal span chosen by Jev, without a handoff', async () => {
  n = 0
  const q = el('Destination'), f = fake([q])
  let asks = 0
  const { result } = await run(task({ goal: 'Find stays in Lisbon with free cancellation' }), f, async p => { asks++; return answer({ op: () => asks === 1 ? ['TYPE_TEXT', q.ref] : ['DONE'], text: 'Lisbon' })(p) }, async () => { throw Error('no handoff expected') })
  assert.deepEqual(f.s.executed.map(e => e.text), ['Lisbon']); assert.equal(result.metrics.handoffs, 0)
})
test('field heads fill several goal-specified fields in one cycle, then the post-batch operation runs', async () => {
  n = 0
  const dest = el('Destination'), cat = el('Category', { tag: 'select', role: 'combobox', editable: false, value: 'all', options: [{ value: 'all', label: 'All' }, { value: 'design', label: 'Design' }] })
  const free = el('Free cancellation', { role: 'checkbox', inputType: 'checkbox', checked: false, editable: false }), go = button('Find stays')
  const f = fake([dest, cat, free, go])
  let asks = 0
  const pick = q => q.instructions.includes('Destination') ? Object.keys(q.criteria).find(k => q.criteria[k] === 'Lisbon') : q.instructions.includes('Category') ? Object.keys(q.criteria).find(k => q.criteria[k] === 'Design') : 'set'
  const { result } = await run(task({ goal: 'Find Design stays in Lisbon with Free cancellation' }), f, async p => { asks++; return answer({ fields: asks === 1 ? pick : undefined, op: () => asks === 1 ? ['CLICK', go.ref, 0.9] : ['DONE'] })(p) }, async () => { throw Error('no handoff expected') })
  assert.deepEqual(f.s.executed.map(e => [e.op, e.text ?? e.value ?? e.checked ?? null]), [['type', 'Lisbon'], ['select', 'design'], ['check', true], ['click', null]])
  assert.equal(asks, 2); assert.equal(result.status, 'done')
})
test('a link whose navigation starts late is awaited; DONE is not judged on the old document', async () => {
  n = 0
  const link = button('Result article', { role: 'link', href: origin + '/wiki/Target' }), f = fake([link])
  let observes = 0, asks = 0
  const call = f.call
  f.call = async (name, args) => {
    // After the click, the old document is observed twice before the new one appears.
    if (args.action === 'agent_observe' && f.s.executed.length && ++observes === 3) { f.s.documentId = 'd2'; f.s.url = origin + '/wiki/Target'; f.s.elements = [] }
    return call(name, args)
  }
  const docs = []
  const { result } = await run(task(), f, async p => { asks++; docs.push(p.state.page.url); return answer({ op: () => asks === 1 ? ['CLICK', link.ref] : ['DONE'] })(p) })
  assert.equal(result.status, 'done'); assert.equal(result.finalUrl, origin + '/wiki/Target')
  assert.deepEqual(docs, [origin + '/', origin + '/wiki/Target'])
})
test('an expected navigation that never happens blocks one DONE and re-observes', async () => {
  n = 0
  const link = button('Result article', { role: 'link', href: origin + '/wiki/Target' }), f = fake([link])
  let asks = 0
  const { events } = await run(task(), f, async p => { asks++; return answer({ op: () => asks === 1 ? ['CLICK', link.ref] : ['DONE'] })(p) })
  assert.ok(events.some(e => e.event === 'route' && e.why === 'navigation_pending'))
  assert.equal(asks, 3)
})
test('search/submit-like R2 targets need 0.6; other R2 targets 0.5 with margin', async () => {
  n = 0
  const search = button('Search'), other = button('Open panel'), help = button('Help')
  for (const [target, expectHandoff] of [[search, true], [other, false]]) {
    const f = fake([search, other, help]), kinds = []
    let asks = 0
    const ask = jev(({ questions }) => ({ operation: choice(questions.operation, 'CLICK'), target_CLICK: { type: 'choice', choice: target.ref, probabilities: spread(Object.keys(questions.target_CLICK.criteria), { [target.ref]: 0.55 }) }, ...(asks++ ? { operation: choice(questions.operation, 'DONE') } : {}) }))
    await run(task(), f, ask, async h => { kinds.push(h.kind); return {} })
    assert.equal(kinds.includes('choose'), expectHandoff, target.name)
  }
})
test('secrets bind only on documents of their own origins', () => {
  n = 0
  const pw = el('Password', { password: true }), p = page([pw])
  assert.ok(bindCandidates(p, { value: 'x', secret: true, origins: [origin] }, new Set())[pw.ref])
  assert.deepEqual(bindCandidates(p, { value: 'x', secret: true, origins: ['https://idp.test'] }, new Set()), {})
})
test('Enter is judged as the form submit control; a POST delete form is R3', () => {
  n = 0
  const q = el('Reason', { form: 'f1', formMethod: 'post' }), del = button('Delete account', { form: 'f1', submit: true, formMethod: 'post' })
  assert.equal(tier('PRESS_ENTER', q, page([q, del])), 'R3')
  const s = el('Query', { form: 'f2' }), go = button('Search', { form: 'f2', submit: true })
  assert.equal(tier('PRESS_ENTER', s, page([s, go])), 'R2')
})
test('a page confirm() dialog is the confirmation point: denied first, repeated only after approval', async () => {
  n = 0
  const cancel = button('Cancel reservation')
  for (const [mode, approve, expected, executions] of [['confirm', true, 'done', 2], ['confirm', false, 'blocked', 1], ['deny', false, 'needs_confirmation', 1]]) {
    const f = fake([cancel]), call = f.call
    f.call = async (name, args) => { const r = await call(name, args); return args.action === 'agent_execute' && !args.acceptConfirm ? { ...r, confirmDenied: 'Cancel this reservation?' } : r }
    let asks = 0
    const kinds = []
    const { result } = await run(task({ irreversible: mode }), f, async p => { asks++; return answer({ op: () => asks === 1 ? ['CLICK', cancel.ref] : ['DONE'] })(p) }, async h => { kinds.push(h.reason); return { approve } })
    assert.equal(result.status, expected, mode + approve); assert.equal(f.s.executed.length, executions)
    if (executions === 2) assert.equal(f.s.executed[1].acceptConfirm, true)
    if (mode === 'confirm') assert.deepEqual(kinds, ['page_confirm_dialog'])
  }
})
test('options cut at 254 per head are reported in state', () => {
  n = 0
  const many = Array.from({ length: 260 }, (_, i) => button(`Item ${i}`))
  const b = build(page(many), task(), [])
  assert.equal(Object.keys(b.payload.questions.target_CLICK.criteria).length, 254)
  assert.equal(b.payload.state.omittedTargets.CLICK, 6)
})
test('secret postconditions come from the executor; repeated unmet inputs stop being offered', async () => {
  n = 0
  const card = el('Library card'), f = fake([card]), call = f.call
  // Observation shows the secret redacted; the executor reports applied.
  f.call = async (name, args) => { const r = await call(name, args); if (args.action === 'agent_execute') return { ...r, applied: true }; return r }
  let asks = 0
  const t = task({ inputs: { card: { value: '4000-1234', purpose: 'library card', secret: true, origins: [origin] } } })
  const { result } = await run(t, f, async p => { asks++; return answer({ op: () => ['DONE'] })(p) })
  assert.equal(f.s.executed.length, 1); assert.equal(asks, 2); assert.equal(result.status, 'done')
  // A field that never accepts the value: two unmet attempts, then not offered again.
  n = 0
  const stubborn = el('Code'), g = fake([stubborn]), gcall = g.call
  g.call = async (name, args) => { const r = await gcall(name, args); if (args.action === 'agent_execute') { g.s.elements[0].value = ''; return { ...r, applied: false } } return r }
  let binds = []
  await run(task({ inputs: { code: { value: 'X1', purpose: 'code' } }, budgets: { maxSteps: 20, maxJevRequests: 8, timeoutMs: 10000 } }), g, async p => { binds.push(Object.keys(p.questions).filter(k => k.startsWith('bind_')).length); return answer({ op: () => ['WAIT'] })(p) })
  assert.equal(g.s.executed.filter(e => e.op === 'type').length, 2)
  assert.ok(binds.slice(2).every(n => n === 0))
})
test('a covered target is reported to the model instead of retried blindly', async () => {
  n = 0
  const go = button('Search'), f = fake([go]), call = f.call
  let covered = true
  f.call = async (name, args) => args.action === 'agent_execute' && covered ? (covered = false, { ok: true, execution: 'not_sent', code: 'UNREACHABLE', coveredBy: 'listbox "Suggestions"' }) : call(name, args)
  const seen = []
  let asks = 0
  await run(task(), f, async p => { asks++; seen.push(JSON.stringify(p.state.recentActions)); return answer({ op: () => asks === 1 ? ['CLICK', go.ref] : ['DONE'] })(p) })
  assert.ok(seen[1].includes('covered by listbox'))
})
test('dismiss controls are R0 and goal spans keep emails, URLs and phone numbers', async () => {
  const { goalSpans } = await import('../packages/bridge/src/agent/jev.mjs')
  assert.equal(tier('CLICK', button('No thanks'), page([])), 'R0')
  assert.equal(tier('CLICK', button('Next month'), page([])), 'R0')
  assert.equal(tier('CLICK', button('Next'), page([])), 'R2')
  const spans = goalSpans('Set recovery email to sam@example.test, phone +1 617-555-0143, site https://x.test/a')
  for (const s of ['sam@example.test', '+1 617-555-0143', 'https://x.test/a']) assert.ok(spans.includes(s), s)
})
test('refs from an earlier document never protect or exclude elements of a new one', () => {
  n = 0
  const reserve = button('Reserve this title')
  const history = [{ doc: 'old-doc', op: 'type', ref: reserve.ref, valueId: 'card', postcondition: 'met' }]
  const b = build(page([reserve], { documentId: 'new-doc' }), task({ inputs: { card: { value: 'x', purpose: 'card' } } }), history)
  assert.ok(b.payload.questions.target_CLICK.criteria[reserve.ref])
})
test('below the R2 gate a close reversible alternative (e.g. a suggestion option) runs before a handoff', async () => {
  n = 0
  const search = button('Search'), opt = el('Brightwell Field Jacket', { role: 'option', editable: false, tag: 'div', inputType: null })
  const f = fake([search, opt, button('Help')]), kinds = []
  let asks = 0
  const ask = jev(({ questions }) => { asks++; return asks > 1 ? { operation: choice(questions.operation, 'DONE') } : { operation: choice(questions.operation, 'CLICK', 0.9), target_CLICK: { type: 'choice', choice: search.ref, probabilities: spread(Object.keys(questions.target_CLICK.criteria), { [search.ref]: 0.5, [opt.ref]: 0.5 - 0.02 }) } } })
  const { result } = await run(task(), f, ask, async h => { kinds.push(h.kind); return {} })
  assert.deepEqual(f.s.executed.map(e => e.ref), [opt.ref], JSON.stringify(result)); assert.deepEqual(kinds, [])
})
test('read-only GET navigation uses the 0.4 gate; a non-form Search keeps 0.6', async () => {
  for (const [make, expectHandoff] of [[() => button('Search', { submit: true, formMethod: 'get', form: 'f1' }), false], [() => button('Search'), true], [() => button('Article', { role: 'link', href: origin + '/wiki/X' }), false]]) {
    n = 0
    const target = make()
    const f = fake([target, button('Help'), button('About')]), kinds = []
    let asks = 0
    const ask = jev(({ questions }) => asks++ ? { operation: choice(questions.operation, 'DONE') } : { operation: choice(questions.operation, 'CLICK'), target_CLICK: { type: 'choice', choice: target.ref, probabilities: spread(Object.keys(questions.target_CLICK.criteria), { [target.ref]: 0.45 }) } })
    const { result } = await run(task(), f, ask, async h => { kinds.push(h.kind); return {} })
    assert.equal(kinds.includes('choose'), expectHandoff, target.name); assert.equal(f.s.executed.length, expectHandoff ? 0 : 1, JSON.stringify(result))
  }
})
test('a tab opened by a task tab is adopted and followed; SWITCH_TAB returns to the first', async () => {
  n = 0
  const link = button('Open help', { role: 'link', href: origin + '/help' }), f = fake([link]), call = f.call
  const tabs = [{ id: 7, url: origin + '/', title: 'Main' }]
  const switched = []
  f.call = async (name, args) => {
    if (name === 'tabs' && args.action === 'list') return { ok: true, tabs }
    if (name === 'tabs' && args.action === 'switch') { switched.push(args.tabId); return { ok: true } }
    const r = await call(name, args)
    if (args.action === 'agent_execute' && args.op === 'click') tabs.push({ id: 8, url: origin + '/help', title: 'Help', openerTabId: 7 })
    return r
  }
  let asks = 0
  const seenTabs = []
  const { result } = await run(task(), f, async p => { asks++; seenTabs.push(p.state.tabs); return answer({ op: (s, q) => asks === 1 ? ['CLICK', link.ref] : asks === 2 ? ['SWITCH_TAB', 't7'] : ['DONE'] })(p) })
  assert.deepEqual(switched, [8, 7]); assert.equal(result.tabId, 7)
  assert.deepEqual(seenTabs[1].map(t => [t.id, t.current]), [['t7', false], ['t8', true]])
})
test('a value shown on a page of the task can be typed on another page', async () => {
  n = 0
  const code = el('Activation code'), f = fake([code]), call = f.call
  f.call = async (name, args) => { const r = await call(name, args); return args.action === 'agent_observe' ? { ...r, title: 'Help', text: 'Your code is TW-4448-B.' } : r }
  let asks = 0
  await run(task({ goal: 'Enable beta features with the activation code from the help page' }), f, async p => { asks++; return answer({ op: () => asks === 1 ? ['TYPE_TEXT', code.ref] : ['DONE'], text: 'TW-4448-B (shown on page "Help")' })(p) }, async () => { throw Error('no handoff expected') })
  assert.deepEqual(f.s.executed.map(e => e.text), ['TW-4448-B'])
})
test('an extension without the current agent protocol stops the task with EXTENSION_OUTDATED; unexpected errors keep their message', async () => {
  n = 0
  const f = fake([button('Go')]), call = f.call
  f.call = async (name, args) => { const r = await call(name, args); return args.action === 'agent_observe' ? { ok: true, execution: 'not_sent', code: 'PAGE_CHANGED' } : r }
  let r = await run(task(), f, async () => { throw Error('no Jev call expected') })
  assert.equal(r.result.code, 'EXTENSION_OUTDATED'); assert.match(r.result.message, /Reload the extension/)
  const g = fake([button('Go')]), gcall = g.call
  g.call = async (name, args) => { const x = await gcall(name, args); return args.action === 'agent_observe' ? { ...x, text: undefined } : x }
  r = await run(task(), g, async () => ({}))
  assert.match(r.result.message, /TypeError/); assert.ok(r.events.some(e => e.event === 'internal_error' && e.stack))
})
test('text that cannot belong in a field is not typed; the model is told instead', async () => {
  n = 0
  const email = el('Email'), f = fake([email])
  let asks = 0
  const seen = []
  await run(task({ goal: 'Add Jordan Blake to the address book' }), f, async p => { asks++; seen.push(JSON.stringify(p.state.recentActions)); return answer({ op: () => asks === 1 ? ['TYPE_TEXT', email.ref] : ['DONE'], text: 'Jordan Blake' })(p) })
  assert.deepEqual(f.s.executed, []); assert.match(seen[1], /does not fit field/)
})
test('task tabs are closed at the end except the final one, which the next task closes; handoffs are logged with times', async () => {
  const { startTask } = await import('../packages/bridge/dist/agent/task.mjs')
  const { mkdtempSync, rmSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'keep-tabs-'))
  n = 0
  const link = button('Help', { role: 'link', href: origin + '/help' }), buy = button('Place order', { submit: true }), f = fake([link, buy]), call = f.call
  const tabs = [{ id: 7, url: origin + '/' }], closed = []
  let next = 7
  const host = { invoke: async (name, params, tabId) => {
    if (name === 'tabs' && params.action === 'new') return { tabId: tabs.length === 1 && next === 7 ? (next++, 7) : ++next }
    if (name === 'tabs' && params.action === 'list') return { ok: true, tabs }
    if (name === 'tabs' && params.action === 'close') { closed.push(params.tabId); return { ok: true } }
    if (name === 'tabs') return { ok: true }
    const r = await call(name, { ...params, tabId })
    if (params.op === 'click' && params.ref === link.ref) tabs.push({ id: 8, url: origin + '/help', openerTabId: 7 })
    return r
  } }
  let asks = 0
  const ask = async p => { asks++; return answer({ op: () => asks === 1 ? ['CLICK', link.ref] : asks === 2 ? ['SWITCH_TAB', 't7'] : asks === 3 ? ['CLICK', buy.ref] : ['DONE'] })(p) }
  try {
    const r = await startTask({ goal: 'g', startUrl: origin + '/', allowedOrigins: [origin] }, { host, ask, ledgerPath: join(dir, 'ledger.json'), traceDirectory: dir, handoff: async () => ({ approve: true }) })
    assert.equal(r.status, 'done'); assert.equal(r.tabId, 7); assert.deepEqual(closed, [8])
    const confirm = r.handoffs.find(h => h.kind === 'confirm')
    assert.ok(confirm.approve === true && confirm.at >= confirm.askedAt)
    asks = 3
    await startTask({ goal: 'g', startUrl: origin + '/', allowedOrigins: [origin] }, { host, ask, ledgerPath: join(dir, 'ledger.json'), traceDirectory: dir, handoff: async () => ({ approve: true }) })
    assert.equal(closed[1], 7)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('DONE with filled inputs never executes a speculative Search target', async () => {
  n = 0
  const q = el('Where to?'), search = button('Search'), f = fake([q, search])
  let asks = 0
  const { result } = await run(task({ goal: 'Fill destination London and stop before Search' }), f, async p => { asks++; const r = await answer({ op: () => asks === 1 ? ['TYPE_TEXT', q.ref] : ['DONE'], text: 'London' })(p); if (asks === 2) r.answers.target_CLICK = choice(p.questions.target_CLICK, search.ref); return r }, async () => { throw Error('no handoff expected') })
  // A confident speculative CLICK target is not an instruction to click.
  assert.ok(!f.s.executed.some(e => e.op === 'click' && e.ref === search.ref), JSON.stringify(f.s.executed)); assert.equal(result.status, 'done')
})
test('a target refused twice on a document is excluded; the loop hands off instead of re-requesting it', async () => {
  n = 0
  const box = el('Search'), f = fake([box]), call = f.call
  f.call = async (name, args) => args.action === 'agent_execute' ? { ok: true, execution: 'not_sent', code: 'UNREACHABLE', coveredBy: 'textarea ""' } : call(name, args)
  let asks = 0
  const offered = []
  const { result } = await run(task({ goal: 'Search for "JEV"', budgets: { maxSteps: 20, maxJevRequests: 20, timeoutMs: 10000 } }), f, async p => { asks++; offered.push(!!p.questions.target_TYPE_TEXT?.criteria[box.ref]); return answer({ op: () => p.questions.target_TYPE_TEXT ? ['TYPE_TEXT', box.ref] : ['WAIT'], text: 'JEV' })(p) }, async () => ({}))
  assert.deepEqual(offered.slice(0, 3), [true, true, false]); assert.ok(asks < 8, String(asks)); assert.equal(result.status, 'blocked')
})
test('ledger lock contention waits (bounded) instead of failing; a stuck lock still fails closed', async () => {
  const { reserveRequest } = await import('../packages/bridge/src/jev/budget.mjs')
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'ledger-lock-')), path = join(dir, 'l.json')
  try {
    // Another process holds the lock for 300 ms; this reservation waits for it.
    const { spawn } = await import('node:child_process')
    const holder = spawn(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(path + '.lock')}); setTimeout(() => require('fs').rmSync(${JSON.stringify(path + '.lock')}, { recursive: true }), 300)`])
    while (!(await import('node:fs')).existsSync(path + '.lock')) await new Promise(r => setTimeout(r, 10))
    assert.equal(reserveRequest(path, {}, 10000), 1)
    await new Promise(r => holder.on('exit', r))
    mkdirSync(path + '.lock')
    process.env.JEV_LEDGER_LOCK_WAIT_MS = '50'
    assert.throws(() => reserveRequest(path, {}, 10000), { code: 'BUDGET_LOCKED' })
  } finally { delete process.env.JEV_LEDGER_LOCK_WAIT_MS; rmSync(dir, { recursive: true, force: true }) }
})
test('a validation message ("10 digits") picks the fitting goal span when the model is split', async () => {
  n = 0
  const phone = el('Phone', { value: '+1 617-555-0143' }), save = button('Save address'), f = fake([phone, save]), call = f.call
  f.call = async (name, args) => { const r = await call(name, args); return args.action === 'agent_observe' && f.s.executed.length ? { ...r, text: 'Phone must be 10 digits with no spaces or symbols.' } : r }
  let asks = 0
  await run(task({ goal: 'Add this address: phone +1 617-555-0143.' }), f, async p => {
    asks++
    const r = await answer({ op: () => asks === 1 ? ['CLICK', save.ref] : asks === 2 ? ['TYPE_TEXT', phone.ref] : ['DONE'] })(p)
    if (p.questions.text_value) { const c = p.questions.text_value.criteria, k11 = Object.keys(c).find(k => c[k] === '16175550143'), k10 = Object.keys(c).find(k => c[k] === '6175550143'); r.answers.text_value = { type: 'choice', choice: k11, probabilities: Object.fromEntries(Object.keys(c).map(k => [k, k === k11 ? 0.46 : k === k10 ? 0.42 : 0.12 / (Object.keys(c).length - 2)])) } }
    return r
  }, async () => { throw Error('no handoff expected') })
  assert.equal(f.s.executed.find(e => e.op === 'type')?.text, '6175550143')
})
test('an auto-saving select with no associated submitter does not block DONE', async () => {
  n = 0
  const qty = el('Quantity', { tag: 'select', role: 'combobox', editable: false, options: [{ value: '1', label: '1' }, { value: '3', label: '3' }], value: '1' }), checkout = button('Checkout')
  const f = fake([qty, checkout])
  let asks = 0
  const { result } = await run(task({ goal: 'Set quantity to 3' }), f, async p => { asks++; return answer({ op: () => asks === 1 ? ['SELECT', `${qty.ref}:1`] : ['DONE'] })(p) }, async () => { throw Error('no handoff expected') })
  assert.equal(result.status, 'done'); assert.ok(!f.s.executed.some(e => e.op === 'click'))
})
test('auto-Enter is skipped when the field form submit is irreversible', async () => {
  n = 0
  const q = el('Search', { form: 'f1', formMethod: 'get' }), buy = button('Buy now', { form: 'f1', submit: true, formMethod: 'get' })
  const f = fake([q, buy])
  let asks = 0
  await run(task({ goal: 'Search for "lamp"' }), f, async p => { asks++; return answer({ op: () => asks === 1 ? ['TYPE_TEXT', q.ref] : ['WAIT'], text: 'lamp' })(p) }, async () => ({}))
  assert.ok(!f.s.executed.some(e => e.op === 'key'))
})
test('a hanging first observation times out and triggers the read-only startup reload', async () => {
  n = 0
  process.env.JEV_OBSERVE_TIMEOUT_MS = '50'
  const { runTask: run2 } = await import('../packages/bridge/src/agent/loop.mjs?observe-timeout')
  delete process.env.JEV_OBSERVE_TIMEOUT_MS
  const f = fake([button('Go')]), call = f.call
  let hang = true, navigations = 0
  f.call = async (name, args) => {
    if (name === 'navigate' && ++navigations > 1) hang = false
    if (args.action === 'agent_observe' && hang) return new Promise(() => {})
    return call(name, args)
  }
  const events = []
  const result = await run2(task(), { call: f.call, ask: answer({ op: () => ['DONE'] }), handoff: async () => ({}), emit: e => events.push(e) })
  assert.equal(result.status, 'done'); assert.equal(navigations, 2); assert.ok(events.some(e => e.event === 'startup_reload'))
  // Never answering at all ends with a clear error, not a 300 s hang.
  process.env.JEV_OBSERVE_TIMEOUT_MS = '30'
  const { runTask: run3 } = await import('../packages/bridge/src/agent/loop.mjs?observe-timeout-2')
  delete process.env.JEV_OBSERVE_TIMEOUT_MS
  const g = fake([button('Go')]), gcall = g.call
  g.call = async (name, args) => args.action === 'agent_observe' ? new Promise(() => {}) : gcall(name, args)
  const r = await run3(task(), { call: g.call, ask: answer(), handoff: async () => ({}) })
  assert.equal(r.code, 'OBSERVE_TIMEOUT')
})

test('searchable school query cannot auto-Enter, pick another list, or accept DONE', async () => {
  const field = el('Search school', { role: 'combobox', expanded: true, controls: { status: 'known', targets: [{ ref: 'owned', visible: true }] } })
  const wrong = button('Example University', { role: 'option', listbox: { ref: 'other' } })
  const f = fake([field, wrong])
  const t = task({ inputs: { school: { value: 'Example University', purpose: 'school' } }, llm: 'none' })
  const { result } = await run(t, f, answer())
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'selection_unconfirmed')
  assert.deepEqual(f.s.executed.map(e => e.op), ['type'])
})

test('fresh owned suggestion is committed instead of only marking its query applied', async () => {
  const field = el('School', { role: 'combobox', expanded: false, controls: { status: 'known', targets: [{ ref: 'owned', visible: false }] } })
  const opt = button('Example University', { role: 'option', listbox: { ref: 'owned' } })
  const f = fake([field], { hooks: {
    [field.ref]: s => { s.elements[0].expanded = true; s.elements[0].controls.targets[0].visible = true; s.elements.push(structuredClone(opt)) },
    [opt.ref]: s => { s.elements[0].expanded = false; s.elements[0].controls.targets[0].visible = false; s.elements = s.elements.filter(e => e.ref !== opt.ref); s.selectionWitnesses = [{ ref: field.ref, option: opt.name, source: 'labelled_field_display', committed: true }] }
  } })
  const { result, events } = await run(task({ inputs: { school: { value: 'Example University', purpose: 'school' } } }), f, answer())
  assert.equal(result.status, 'done')
  assert.deepEqual(f.s.executed.map(e => e.op), ['type', 'click'])
  assert.ok(events.some(e => e.event === 'selection_committed'))
})

test('ambiguous namesake suggestions do not execute solely on high CLICK probability', async () => {
  const field = el('School', { role: 'combobox', controls: { status: 'known', targets: [{ ref: 'owned', visible: false }] } })
  const opts = ['North campus', 'South campus'].map(item => button('Example University', { role: 'option', listbox: { ref: 'owned' }, item }))
  const f = fake([field], { hooks: { [field.ref]: s => { s.elements[0].expanded = true; s.elements[0].controls.targets[0].visible = true; s.elements.push(...structuredClone(opts)) } } })
  const asks = async payload => {
    const r = await answer({ bind: () => payload.state.pendingSelections?.length ? 'not_now' : 0, op: s => s.pendingSelections?.length ? ['CLICK', opts[0].ref] : ['WAIT'] })(payload)
    if (payload.state.pendingSelections?.length) r.answers.target_CLICK = choice(payload.questions.target_CLICK, opts[0].ref, 0.45)
    return r
  }
  const { result } = await run(task({ inputs: { school: { value: 'Example University', purpose: 'school' } }, llm: 'none' }), f, asks)
  assert.equal(result.status, 'blocked')
  assert.deepEqual(f.s.executed.map(e => e.op), ['type'])
})


test('an explicitly selected Enter remains a separate executable operation', async () => {
  const q = el('Search'), f = fake([q]); let asks = 0
  const { result } = await run(task({ goal: 'Search for Lisbon' }), f, async p => {
    asks++
    return answer({ op: () => asks === 1 ? ['TYPE_TEXT', q.ref] : asks === 2 ? ['PRESS_ENTER', q.ref] : ['DONE'], text: 'Lisbon' })(p)
  })
  assert.deepEqual(f.s.executed.map(e => e.op), ['type', 'key'])
  assert.equal(result.status, 'done')
})


test('cascade reset followed by DONE and not_now bindings remains blocked', async () => {
  const field = el('School', { role: 'combobox', expanded: false, controls: { status: 'known', targets: [{ ref: 'owned', visible: false }] } })
  const opt = button('Example University', { role: 'option', listbox: { ref: 'owned' } }), reset = button('Reset')
  const f = fake([field, reset], { hooks: {
    [field.ref]: s => { s.elements[0].expanded = true; s.elements[0].controls.targets[0].visible = true; s.elements.push(structuredClone(opt)) },
    [opt.ref]: s => { s.elements[0].expanded = false; s.elements[0].controls.targets[0].visible = false; s.elements = s.elements.filter(e => e.ref !== opt.ref); s.selectionWitnesses = [{ ref: field.ref, option: opt.name, source: 'labelled_field_display', committed: true }] },
    [reset.ref]: s => { s.elements[0].value = ''; s.selectionWitnesses[0].committed = false }
  } })
  const ask = answer({ bind: () => f.s.executed.some(e => e.ref === reset.ref) ? 'not_now' : 0, op: () => f.s.executed.some(e => e.ref === reset.ref) ? ['DONE'] : ['CLICK', reset.ref] })
  const { result } = await run(task({ inputs: { school: { value: 'Example University', purpose: 'school' } }, llm: 'none' }), f, ask)
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'selection_unconfirmed')
  assert.ok(f.s.executed.some(e => e.ref === reset.ref))
})

test('noneditable country can reopen and reselect after reset while keeping input identity', async () => {
  const field = button('Country', { role: 'combobox', value: 'Choose country', expanded: false, controls: { status: 'known', targets: [{ ref: 'countries', visible: false }] } })
  const opt = button('Canada', { role: 'option', listbox: { ref: 'countries' } }), reset = button('Reset country')
  const f = fake([field, reset], { hooks: {
    [field.ref]: s => { s.elements[0].expanded = true; s.elements[0].controls.targets[0].visible = true; if (!s.elements.some(e => e.ref === opt.ref)) s.elements.push(structuredClone(opt)) },
    [opt.ref]: s => { s.elements[0].value = 'Canada'; s.elements[0].expanded = false; s.elements[0].controls.targets[0].visible = false; s.elements = s.elements.filter(e => e.ref !== opt.ref) },
    [reset.ref]: s => { s.elements[0].value = 'Choose country' }
  } })
  const ask = async payload => {
    const resetDone = f.s.executed.some(e => e.ref === reset.ref)
    const selected = f.s.executed.filter(e => e.ref === opt.ref).length
    return answer({ bind: () => resetDone ? 'not_now' : 0, op: state => {
      if (selected === 2) return ['DONE']
      if (selected === 1 && !resetDone) return ['CLICK', reset.ref]
      if (state.pendingSelections?.some(s => s.ready)) return ['CLICK', opt.ref]
      return ['CLICK', field.ref]
    } })(payload)
  }
  const { result, events } = await run(task({ inputs: { country: { value: 'Canada', purpose: 'country' } }, llm: 'none', budgets: { maxSteps: 20, maxJevRequests: 12, timeoutMs: 10000 } }), f, ask)
  assert.equal(result.status, 'done', JSON.stringify(result))
  assert.equal(f.s.executed.filter(e => e.ref === opt.ref).length, 2)
  assert.equal(events.filter(e => e.event === 'selection_committed' && e.valueId === 'country').length, 2)
})

test('high confidence cannot execute a rejected generic popup wrapper', async () => {
  const bad = button('350 Fifth Avenue Manhattan', { role: 'generic', tag: 'div', popupMember: { status: 'rejected', reason: 'unqualified_popup_member' } })
  const normal = button('Other action'), f = fake([bad, normal])
  const { result } = await run(task({ llm: 'none' }), f, answer({ op: () => ['CLICK', bad.ref] }))
  assert.notEqual(result.status, 'done')
  assert.equal(f.s.executed.length, 0)
})
