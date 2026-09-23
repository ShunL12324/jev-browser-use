#!/usr/bin/env node
// Full mechanical verification: every local site starts, every task is
// solvable through the UI with its oracle accepting (2 seeds x variants), and
// negative controls (no-op, wrong answer, commit without confirmation,
// missing eval token) are rejected. Host-scripted evidence only.
import { writeFile, mkdir } from 'node:fs/promises'
import { startAll } from '../server.mjs'
import { loadTasks } from '../harness/tasks.mjs'
import { runOne } from '../harness/run.mjs'
import { siteOrigin, LOCAL_SITES } from '../harness/sites.mjs'

const out = new URL('../results/', import.meta.url).pathname, started = Date.now()
await mkdir(out, { recursive: true })
let servers
try { servers = await startAll({ quiet: true }) } catch (e) { if (e.code !== 'EADDRINUSE') throw e; console.log('Using already running eval servers') }
const cf = await fetch(siteOrigin('complex-forms') + '/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.ok).catch(() => false)
const tasks = loadTasks().filter(t => t.suite === 'local' && (cf || t.site !== 'complex-forms'))
const rows = [], runner = n => import('../harness/adapters/' + (n.startsWith('mechanical') ? 'mechanical' : 'noop') + '.mjs').then(m => m.createRunner({ name: n }))
const plan = [['mechanical', tasks, ['atlas', 'birch'], ['standard', 'alternate'], true], ['noop', tasks, ['atlas'], ['standard'], false], ['wrong', tasks, ['atlas'], ['standard'], false],
  ['mechanical-noconfirm', tasks.filter(t => t.irreversible !== 'none' && t.site !== 'complex-forms'), ['atlas'], ['standard'], false]]
for (const [name, list, seeds, variants, expectPass] of plan) {
  const r = await runner(name)
  for (const task of list) for (const seed of seeds) for (const variant of variants.filter(v => !task.variants || task.variants.includes(v))) {
    const row = await runOne(task, r, { seed, variant, handoff: 'scripted' })
    rows.push({ ...row, expectPass, asExpected: row.passed === expectPass })
    if (row.passed !== expectPass) console.log(`UNEXPECTED ${name} ${task.id} ${seed}/${variant} passed=${row.passed} ${row.error ?? ''}`)
  }
}
// Eval endpoints must refuse callers without the harness token.
const guard = []
for (const site of Object.keys(LOCAL_SITES).filter(s => !['partner', 'complex-forms'].includes(s))) {
  const r = await fetch(siteOrigin(site) + '/__eval/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  guard.push({ site, status: r.status, asExpected: r.status === 403 })
}
const summary = { at: new Date().toISOString(), durationMs: Date.now() - started, complexFormsReachable: cf,
  positive: { runs: rows.filter(r => r.expectPass).length, passed: rows.filter(r => r.expectPass && r.passed).length },
  negative: Object.fromEntries(['noop', 'wrong', 'mechanical-noconfirm'].map(n => [n, { runs: rows.filter(r => r.runner === n).length, rejected: rows.filter(r => r.runner === n && !r.passed).length }])),
  tokenGuard: guard, allAsExpected: rows.every(r => r.asExpected) && guard.every(g => g.asExpected) }
await writeFile(out + 'mechanical-all.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n')
await writeFile(out + 'mechanical-summary.json', JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
await servers?.close()
process.exit(summary.allAsExpected ? 0 : 1)
