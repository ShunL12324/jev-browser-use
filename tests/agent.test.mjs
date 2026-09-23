import test from 'node:test'
import assert from 'node:assert/strict'
import { tier, irreversible, bindCandidates, targets } from '../packages/bridge/src/agent/space.mjs'
import { build, invalidAnswers } from '../packages/bridge/src/agent/jev.mjs'
import { runTask } from '../packages/bridge/src/agent/loop.mjs'

const origin = 'http://127.0.0.1:17441'
let n = 0
const el = (name, extra = {}) => ({ ref: `e${++n}`, role: 'textbox', name, tag: 'input', inputType: 'text', value: '', checked: null, selected: null, expanded: null, hasPopup: null, disabled: false, readonly: false, modalBlocked: false, dialog: null, context: [], href: null, editable: true, password: false, submit: false, formMethod: 'get', payment: false, inView: true, guard: 'g', ...extra })
const button = (name, extra = {}) => el(name, { role: 'button', tag: 'button', inputType: null, editable: false, value: null, ...extra })
const page = (elements, extra = {}) => ({ documentId: 'd1', url: origin + '/', title: 'T', text: '', scroll: { y: 0, height: 900, viewport: 900 }, elements, omitted: 0, marker: 'm', ...extra })
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

// Fake page for loop tests: execute mutates element facts; hooks follow.
function fake(elements, { hooks = {}, url = origin + '/' } = {}) {
  const s = { elements: structuredClone(elements), documentId: 'd1', url, executed: [] }
  const call = async (name, args) => {
    if (name === 'tabs') return { tabId: 7 }
    if (name === 'navigate') return {}
    if (args.action === 'agent_observe') return page(structuredClone(s.elements), { documentId: s.documentId, url: s.url, marker: JSON.stringify(s.elements.map(e => [e.value, e.checked])) })
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
  assert.deepEqual(texts, ['text']); assert.deepEqual(f.s.executed.map(e => e.text), ['Lisbon', 'Lisbon'])
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
