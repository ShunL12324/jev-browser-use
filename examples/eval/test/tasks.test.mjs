import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadTasks } from '../harness/tasks.mjs'
import { portalTasks } from '../sites/portal/app.mjs'
import { shopTasks } from '../sites/shop/app.mjs'
import { workspaceTasks } from '../sites/workspace/app.mjs'
import { formaTasks } from '../sites/forma/app.mjs'
import { solvers } from '../mechanical/solvers.mjs'

const checklist = JSON.parse(readFileSync(new URL('../checklist.json', import.meta.url)))
const ids = new Set(checklist.items.map(i => i.id))
const server = { ...portalTasks(), ...shopTasks(), ...workspaceTasks(), ...formaTasks() }

test('every task uses known checklist ids and a known oracle', () => {
  for (const t of loadTasks()) {
    for (const c of t.capabilities) assert.ok(ids.has(c), `${t.id}: unknown capability ${c}`)
    assert.ok(['none', 'confirm', 'deny'].includes(t.irreversible), t.id)
    if (t.suite === 'local' && t.site !== 'complex-forms') {
      const s = server[t.id]; assert.ok(s, `${t.id}: no server-side definition`)
      assert.ok(t.oracle.kind === 'answer' ? s.answer : s.check, `${t.id}: oracle kind ${t.oracle.kind} not implemented`)
      assert.ok(solvers[t.id], `${t.id}: no mechanical solver`)
    }
    if (t.suite === 'public') assert.ok(t.check && t.allowedOrigins?.length && t.startUrl.startsWith('https://'), t.id)
  }
})

test('goals contain no field targets or oracle words, and deny/confirm pairs share goals', () => {
  for (const t of loadTasks()) {
    assert.doesNotMatch(t.goal, /oracle|__eval|selector|#[a-z-]+\b|\bref=|e\d+\]/i, t.id)
    assert.ok(!('expected' in (t.inputs ?? {})), t.id)
  }
  const byId = Object.fromEntries(loadTasks().map(t => [t.id, t]))
  assert.equal(byId['shop.checkout_confirm'].goal, byId['shop.checkout_denied'].goal)
  assert.equal(byId['workspace.cross_origin_booking'].goal, byId['workspace.booking_denied'].goal)
})

test('every non-limit checklist item has at least one task; weights are sane', () => {
  const used = new Set(loadTasks().flatMap(t => t.capabilities))
  for (const item of checklist.items) {
    assert.ok(item.weight >= 1 && item.weight <= 5, item.id)
    for (const s of item.sources) assert.ok(checklist.sources[s], `${item.id}: missing source ${s}`)
    if (!item.knownLimit && item.id !== 'ROB-3') assert.ok(used.has(item.id), `${item.id} has no task`)
  }
  const total = checklist.items.reduce((s, i) => s + i.weight, 0), limits = checklist.items.filter(i => i.knownLimit).reduce((s, i) => s + i.weight, 0)
  assert.ok(limits / total <= 0.05, 'known-limit weight must stay within the 5% allowance')
})
