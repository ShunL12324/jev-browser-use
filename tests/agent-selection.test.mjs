import test from 'node:test'
import assert from 'node:assert/strict'
import { Selections, ownedOptions, selectionAllows } from '../packages/bridge/src/agent/selection.mjs'
import { build } from '../packages/bridge/src/agent/jev.mjs'
const owner = (extra = {}) => ({ ref: 'field', name: 'School', tag: 'input', role: 'combobox', editable: true, value: '', expanded: true, inView: true, context: [], controls: { status: 'known', targets: [{ ref: 'list', role: 'listbox', visible: true }] }, ...extra })
const option = (extra = {}) => ({ ref: 'o1', name: 'Example University', role: 'option', listbox: { ref: 'list', visible: true }, inView: true, context: [], ...extra })
const page = (...elements) => ({ documentId: 'd', url: 'http://example.test/', title: '', text: '', scroll: { y: 0, height: 100, viewport: 100 }, elements })
const task = { goal: 'Select the school', inputs: { school: { value: 'Example University', purpose: 'school' } } }
function query({ beforeOptions = [], afterOptions = [option()], busy = false } = {}) {
  const s = new Selections(), history = [], before = page(owner(), ...beforeOptions), after = page(owner({ value: 'Example University', busy }), ...afterOptions)
  s.begin(before, after, before.elements[0], 'Example University', 'school'); s.observe(after, history)
  return { s, history, before, after }
}
test('same-name options outside the owned portal cannot be chosen', () => {
  const { s, after } = query(); after.elements.push(option({ ref: 'other', listbox: { ref: 'elsewhere' } }))
  assert.deepEqual(ownedOptions(after, after.elements[0]).map(e => e.ref), ['o1'])
  assert.equal(selectionAllows(after, after.elements.at(-1)), false)
  assert.equal(s.beforePick(after, after.elements.at(-1)), null)
})
test('query is pending even when visible text exactly matches the requested school', () => {
  const { after } = query(); const b = build(after, task, [{ doc: 'd', ref: 'field', valueId: 'school', op: 'type', postcondition: 'pending_selection' }])
  assert.equal(b.payload.state.inputs.school.status, 'pending_selection')
  assert.equal(b.payload.state.inputSummary.applied, 0)
  assert.ok(!Object.values(b.binds).some(b => b.candidates.field))
})
test('unchanged stale suggestions are not fresh; busy completion permits current results', () => {
  const { s, after, history } = query({ beforeOptions: [option()] })
  assert.equal(after.selections[0].ready, false)
  assert.equal(s.beforePick(after, after.elements[1]), null)
  after.elements[0].busy = true; s.observe(after, history)
  after.elements[0].busy = false; s.observe(after, history)
  assert.equal(after.selections[0].ready, true)
})
test('busy field never exposes selectable options, even if list contents changed', () => {
  const { s, after } = query({ busy: true })
  assert.equal(selectionAllows(after, after.elements[1]), false)
  assert.equal(s.beforePick(after, after.elements[1]), null)
})
test('a highlighted option or a disappearing list alone is not selection evidence', () => {
  const { s, after, history } = query(), pick = s.beforePick(after, after.elements[1])
  after.elements[1].selected = true
  assert.equal(s.finishPick(pick, after, history), false)
  after.elements = []; assert.equal(s.finishPick(pick, after, history), false)
  assert.equal(history.length, 0)
})
test('click + closed popup + owner showing selected value confirms; cascade reset invalidates', () => {
  const { s, after, history } = query(); after.elements[0].value = 'Example'
  const pick = s.beforePick(after, after.elements[1])
  after.elements[0].value = 'Example University'; after.elements[0].expanded = false; after.elements[0].controls.targets[0].visible = false
  assert.equal(s.finishPick(pick, after, history), true); s.observe(after, history)
  assert.equal(build(after, task, history).payload.state.inputs.school.status, 'applied')
  after.elements[0].value = ''; s.observe(after, history)
  assert.equal(history[0].postcondition, 'invalidated')
  assert.equal(build(after, task, history).payload.state.inputs.school.status, 'pending')
})
test('wrong value, validation error, or another document cannot confirm a pick', () => {
  for (const change of [p => p.elements[0].value = 'Wrong campus', p => p.elements[0].invalid = true, p => p.documentId = 'other']) {
    const { s, after, history } = query(), pick = s.beforePick(after, after.elements[1]); after.elements[0].expanded = false
    change(after); assert.equal(s.finishPick(pick, after, history), false)
  }
})
test('ambiguous or unresolved ownership never enables automatic selection', () => {
  const { s, after } = query()
  after.elements.push(owner({ ref: 'second' })); assert.equal(s.beforePick(after, after.elements[1]), null)
  after.elements[0].controls.status = 'unknown'; assert.deepEqual(ownedOptions(after, after.elements[0]), [])
})

test('asynchronous selection acknowledgement is checked on later observations', () => {
  const { s, after, history } = query(); after.elements[0].value = 'Example'
  const pick = s.beforePick(after, after.elements[1])
  assert.equal(s.finishPick(pick, after, history), false); s.observe(after, history)
  assert.equal(after.selections[0].status, 'confirming')
  assert.equal(selectionAllows(after, after.elements[1]), false)
  after.elements[0].value = 'Example University'; after.elements[0].expanded = false; after.elements[0].controls.targets[0].visible = false
  s.observe(after, history)
  assert.equal(after.selections.length, 0)
  assert.equal(history.filter(h => h.postcondition === 'met').length, 1)
  s.observe(after, history); assert.equal(history.length, 1)
})


test('a labelled field display can confirm an owner omitted from the interactive snapshot, then reset invalidates it', () => {
  const { s, after, history } = query(), pick = s.beforePick(after, after.elements[1])
  after.elements = []
  after.selectionWitnesses = [{ ref: 'field', option: 'Example University', source: 'labelled_field_display', committed: true }]
  assert.equal(s.finishPick(pick, after, history), true)
  s.observe(after, history)
  assert.equal(after.selections.length, 0)
  assert.equal(history.at(-1).postcondition, 'met')
  after.selectionWitnesses[0].committed = false
  s.observe(after, history)
  assert.equal(history.at(-1).postcondition, 'invalidated')
})
test('display evidence from another owner, option or unknown source cannot confirm', () => {
  for (const extra of [{ ref: 'other' }, { option: 'Other University' }, { source: 'page_text' }, { committed: false }]) {
    const { s, after, history } = query(), pick = s.beforePick(after, after.elements[1])
    after.elements = []
    after.selectionWitnesses = [{ ref: 'field', option: 'Example University', source: 'labelled_field_display', committed: true, ...extra }]
    assert.equal(s.finishPick(pick, after, history), false)
    assert.equal(history.length, 0)
  }
})


test('closing a list over unchanged exact query is not a committed selection', () => {
  const { s, after, history } = query(), pick = s.beforePick(after, after.elements[1])
  after.elements[0].expanded = false; after.elements[0].controls.targets[0].visible = false
  assert.equal(s.finishPick(pick, after, history), false)
  assert.equal(history.length, 0)
})
test('reset preserves a pending obligation and offers its field for rebinding', () => {
  const { s, after, history } = query(); after.elements[0].value = 'Example'
  const pick = s.beforePick(after, after.elements[1])
  after.elements[0].value = 'Example University'; after.elements[0].expanded = false; after.elements[0].controls.targets[0].visible = false
  assert.equal(s.finishPick(pick, after, history), true)
  after.elements[0].value = ''; s.observe(after, history)
  assert.equal(s.pending(after)[0].status, 'invalidated')
  const b = build(after, task, history)
  assert.equal(b.payload.state.inputs.school.status, 'pending')
  assert.ok(Object.values(b.binds).some(x => x.candidates.field))
})

test('explicitly owned grid wrapper participates in fresh selection and preserves secondary text', () => {
  const s = new Selections(), history = []
  const field = owner({ name: 'Address', hasPopup: 'grid', controls: { status: 'known', targets: [{ ref: 'grid', role: 'grid', visible: true }] } })
  const item = { ...option(), role: 'generic', listbox: null, name: '350 Fifth Avenue Manhattan', candidate: { source: 'explicit_controlled_popup', ownerRef: 'field', popupRef: 'grid', entryRef: 'cell' } }
  const before = page(field), after = page({ ...field, value: '350 Fifth' }, item)
  s.begin(before, after, field, '350 Fifth', 'address'); s.observe(after, history)
  assert.deepEqual(ownedOptions(after, field), [item]); assert.equal(selectionAllows(after, item), true)
  const pick = s.beforePick(after, item); assert.ok(pick)
  after.elements[0].value = '350 Fifth Avenue Manhattan'; after.elements[0].expanded = false; field.controls.targets[0].visible = false
  assert.equal(s.finishPick(pick, after, history), true)
  assert.equal(history[0].selectedOption, '350 Fifth Avenue Manhattan')
})
test('grid candidate cannot cross owner or popup associations or bypass query freshness', () => {
  for (const candidate of [
    { ownerRef: 'other', popupRef: 'list' }, { ownerRef: 'field', popupRef: 'wrong' }
  ]) {
    const { s, after } = query({ afterOptions: [] })
    const item = { ...option(), role: 'generic', candidate: { source: 'explicit_controlled_popup', ...candidate } }
    after.elements.push(item)
    assert.equal(s.beforePick(after, item), null); assert.equal(selectionAllows(after, item), false)
  }
})
test('cross-document pick retains an unconfirmed obligation and a fresh result wait budget', () => {
  const { s, after, history } = query(), pick = s.beforePick(after, after.elements[1])
  pick.r.started -= 10000 // suggestion wait is already spent
  const next = { ...page(), documentId: 'next', url: 'http://example.test/place', text: 'Example University' }
  assert.equal(s.finishPick(pick, next, history), false); s.observe(next, history)
  assert.equal(next.selections.length, 1); assert.equal(next.selections[0].status, 'confirming')
  assert.equal(s.waiting(next), true); assert.equal(history.length, 0)
  pick.r.started -= 4000; assert.equal(s.waiting(next), false)
  assert.equal(next.selections.length, 1) // timeout or URL/name match cannot clear it
})

test('rejected generic popup members cannot bypass selection routing', async () => {
  const { targets, bindCandidates } = await import('../packages/bridge/src/agent/space.mjs')
  for (const reason of ['unqualified_popup_member', 'disabled_entry', 'busy_popup', 'association_lost']) {
    const bad = { ...option(), role: 'generic', candidate: undefined, popupMember: { status: 'rejected', reason } }
    const p = page(owner(), bad)
    assert.equal(selectionAllows(p, bad), false)
    assert.equal(bad.ref in targets(p).CLICK, false)
    assert.equal(bad.ref in bindCandidates(p, { value: bad.name }, new Set()), false)
  }
  const ordinary = { ref: 'normal', name: 'Open information', role: 'generic', inView: true }
  assert.equal(ordinary.ref in targets(page(ordinary)).CLICK, true)
})
test('eligible grid candidate still cannot bypass pending busy or stale query', () => {
  const item = { ...option(), role: 'generic', candidate: { source: 'explicit_controlled_popup', ownerRef: 'field', popupRef: 'list' } }
  for (const options of [{ afterOptions: [item], busy: true }, { beforeOptions: [item], afterOptions: [item] }]) {
    const { s, after } = query(options)
    assert.equal(selectionAllows(after, item), false); assert.equal(s.beforePick(after, item), null)
  }
})
