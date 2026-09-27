import test from 'node:test'
import assert from 'node:assert/strict'
import { InputFeedback } from '../packages/bridge/src/agent/input-feedback.mjs'
import { build } from '../packages/bridge/src/agent/jev.mjs'
const desc = (extra = {}) => ({ source: 'aria-describedby', id: 'hint', targetRef: 'hint1', status: 'visible', text: 'Feedback', complete: true, ...extra })
const facts = (extra = {}) => ({ ownerRef: 'f', rootId: 'root1', connected: true, constraints: { attributes: {} }, native: { willValidate: true, validity: { valid: true }, validationMessage: '' }, ariaInvalid: { raw: null, invalid: false }, descriptions: [], ...extra })
function start(before = facts(), after = facts(), extra = {}) {
  const manager = new InputFeedback(), receipt = { documentId: 'd', ref: 'f', valueBefore: '', requestedValue: 'Full address', actualValue: 'Full address', before, after, ...extra }
  manager.begin(receipt, 'address')
  const p = { documentId: 'd', url: 'https://example.test', title: '', text: '', elements: [{ ref: receipt.ref, name: 'Address', role: 'combobox', editable: true, fieldFeedback: after }], scroll: { y: 0, height: 900, viewport: 500 }, tabs: [{ id: 1 }, { id: 2 }] }
  const history = [{ doc: 'd', ref: receipt.ref, valueId: 'address', postcondition: 'met' }]
  manager.observe(p, history)
  return { manager, p, receipt, history }
}
for (const [name, before, after, expected] of [
  ['native invalid', facts(), facts({ native: { willValidate: true, validity: { valid: false, patternMismatch: true }, validationMessage: '' } }), 'input_rejected'],
  ['nonparticipating native invalid', facts(), facts({ native: { willValidate: false, validity: { valid: false }, validationMessage: '' } }), null],
  ['ARIA invalid without message', facts(), facts({ ariaInvalid: { raw: 'true', invalid: true } }), 'input_rejected'],
  ['custom description with native valid', facts(), facts({ descriptions: [desc()] }), 'input_feedback_unresolved'],
  ['errormessage without invalid', facts(), facts({ descriptions: [desc({ source: 'aria-errormessage' })] }), 'input_feedback_unresolved'],
  ['old help unchanged', facts({ descriptions: [desc()] }), facts({ descriptions: [desc()] }), null],
  ['ordinary new help', facts(), facts({ descriptions: [desc({ text: '3 characters entered' })] }), 'input_feedback_unresolved'],
  ['same text revealed', facts({ descriptions: [desc({ status: 'hidden' })] }), facts({ descriptions: [desc()] }), 'input_feedback_unresolved'],
  ['replacement target', facts({ descriptions: [desc()] }), facts({ descriptions: [desc({ targetRef: 'replacement' })] }), 'input_feedback_unresolved'],
  ['hidden', facts(), facts({ descriptions: [desc({ status: 'hidden' })] }), null],
  ['ambiguous', facts(), facts({ descriptions: [desc({ status: 'ambiguous' })] }), null],
  ['incomplete', facts(), facts({ descriptions: [desc({ complete: false })] }), null],
  ['root changed', facts(), facts({ rootId: 'other' }), 'input_feedback_unresolved'],
  ['disconnected', facts(), facts({ connected: false }), 'input_feedback_unresolved'],
]) test(`input feedback: ${name}`, () => {
  const { p, history } = start(before, after)
  assert.equal(p.inputFeedback[0]?.status ?? null, expected)
  assert.equal(history[0].postcondition, expected ? 'unmet' : 'met')
})
test('existing invalid is still invalid, not a new error caused by input', () => {
  const f = facts({ ariaInvalid: { raw: 'true', invalid: true } })
  assert.equal(start(f, f).p.inputFeedback[0].cause, 'still_invalid_after_input')
  assert.equal(start(f, facts()).p.inputFeedback.length, 0)
})
test('a synchronous stale error cleared before settled observation does not reject', () => {
  const { manager, receipt } = start()
  manager.begin({ ...receipt, after: facts({ ariaInvalid: { raw: 'true', invalid: true } }) }, 'address')
  const p = { documentId: 'd', elements: [{ ref: 'f', fieldFeedback: facts() }] }
  manager.observe(p, []); assert.deepEqual(p.inputFeedback, [])
})
test('feedback freezes all heads; disappearance keeps historical evidence without current attribution', () => {
  const { manager, p, history } = start(facts(), facts({ descriptions: [desc()] }))
  const b = build(p, { goal: 'Fill address', inputs: { address: { value: 'Full address', purpose: 'address' } } }, history)
  assert.deepEqual(Object.keys(b.ops), ['WAIT']); assert.deepEqual(b.binds, {}); assert.deepEqual(b.fields, {})
  assert.ok(Object.values(b.targets).every(t => !Object.keys(t).length))
  p.elements[0].fieldFeedback = facts(); manager.observe(p, history)
  assert.equal(p.inputFeedback[0].status, 'input_feedback_unresolved'); assert.equal(p.inputFeedback[0].evidenceCurrent, false)
  assert.equal(p.inputFeedback[0].requestedValue, 'Full address')
  p.documentId = 'other'; manager.observe(p, history); assert.equal(p.inputFeedback.length, 1)
})
test('pick-phase descriptions do not become typing errors; explicit invalid still rejects', () => {
  const { manager, p, history } = start()
  manager.picked('d', 'f'); p.elements[0].fieldFeedback = facts({ descriptions: [desc()] }); manager.observe(p, history)
  assert.deepEqual(p.inputFeedback, [])
  p.elements[0].fieldFeedback.ariaInvalid = { raw: 'true', invalid: true }; manager.observe(p, history)
  assert.equal(p.inputFeedback[0].status, 'input_rejected')
})
test('actual redirected owner is retained but requires rebind; not_sent creates no transaction', () => {
  const { p } = start(facts({ ownerRef: 'actual' }), facts({ ownerRef: 'actual' }), { ref: 'actual', redirected: true })
  assert.equal(p.inputFeedback[0].ref, 'actual'); assert.equal(p.inputFeedback[0].cause, 'redirected_input_requires_rebind')
  const m = new InputFeedback(); m.begin(undefined, 'x'); const empty = { documentId: 'd', elements: [] }; m.observe(empty, []); assert.deepEqual(empty.inputFeedback, [])
})
test('a fresh explicit input revision replaces the feedback baseline', () => {
  const { manager, p, receipt, history } = start(facts(), facts({ descriptions: [desc()] }))
  manager.begin({ ...receipt, before: facts({ descriptions: [desc()] }), after: facts({ descriptions: [desc()] }) }, 'address')
  manager.observe(p, history); assert.deepEqual(p.inputFeedback, [])
})

test('navigation before input validation retains the transaction; after pick leaves confirmation to selection', () => {
  const { manager, p, history, receipt } = start(); manager.begin(receipt, 'address'); p.documentId = 'next'; manager.observe(p, history)
  assert.equal(p.inputFeedback[0].cause, 'document_changed_before_validation'); assert.equal(p.inputFeedback[0].evidenceCurrent, false)
  const next = start(); next.manager.picked('d','f'); next.p.documentId='next'; next.manager.observe(next.p, next.history)
  assert.deepEqual(next.p.inputFeedback, [])
})

for (const change of ['navigation', 'omission']) test(`validated plain input tolerates ${change} and still watches present delayed errors`, () => {
 const {manager,p,history}=start(); p.elements[0].role='textbox';
 if(change==='navigation')p.documentId='next';else p.elements=[];
 manager.observe(p,history);assert.deepEqual(p.inputFeedback,[]);assert.equal(history[0].postcondition,'met');
 p.documentId='d';p.elements=[{ref:'f',fieldFeedback:facts({ariaInvalid:{raw:'true',invalid:true}})}];
 manager.observe(p,history);assert.equal(p.inputFeedback[0].status,'input_rejected');
});
test('owner missing before first settled input observation remains unresolved',()=>{
 const {manager,p,receipt}=start();manager.begin(receipt,'address');p.elements=[];manager.observe(p,[]);
 assert.equal(p.inputFeedback[0].cause,'owner_not_observed');
});
