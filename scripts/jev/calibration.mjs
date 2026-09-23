// Routing calibration report from browser_task traces (and, when present,
// complex-forms run files with test-side bind correctness). Reads local files
// only; no model calls.
//   node scripts/jev/calibration.mjs [--sha=<sourceSha prefix>] [traceDir] [runDir]
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const args = process.argv.slice(2), sha = args.find(a => a.startsWith('--sha='))?.slice(6)
const [traceDir = '/tmp/jev-product/traces', runDir = '/tmp/jev-product/runs'] = args.filter(a => !a.startsWith('--'))
const bucket = p => p >= 0.9 ? '≥0.9' : p >= 0.8 ? '0.8–0.9' : p >= 0.6 ? '0.6–0.8' : p >= 0.4 ? '0.4–0.6' : '<0.4'
const order = ['≥0.9', '0.8–0.9', '0.6–0.8', '0.4–0.6', '<0.4']
const ops = {}, binds = {}, fields = {}, drops = {}, terminals = {}
let tasks = 0
for (const f of (await readdir(traceDir)).filter(f => f.endsWith('.jsonl'))) {
  const events = (await readFile(join(traceDir, f), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
  if (sha && !String(events[0]?.sourceSha).startsWith(sha)) continue
  tasks++
  const terminal = events.find(e => e.event === 'terminal')
  terminals[terminal?.status ?? 'unfinished'] = (terminals[terminal?.status ?? 'unfinished'] ?? 0) + 1
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.event !== 'decision') continue
    for (const a of e.accepted) { const t = String(a.valueId).startsWith('field:') ? fields : binds; t[bucket(a.p)] = (t[bucket(a.p)] ?? 0) + 1 }
    for (const d of e.drops) drops[d.reason] = (drops[d.reason] ?? 0) + 1
    if (e.accepted.length) continue
    // Next routing event after this decision tells what happened to the op.
    const next = events.slice(i + 1).find(x => ['route', 'execute', 'handoff', 'terminal', 'decision'].includes(x.event))
    const level = (next?.event === 'route' ? next.level : null) ?? 'op'
    const key = `${e.operation}|${bucket(Math.min(e.pOp, e.pTarget ?? 1))}`
    const row = ops[key] ??= { executed: 0, fallback: 0, handoff: 0, done: 0, level, inPassingTask: 0 }
    if (terminal?.status === 'done') row.inPassingTask++
    if (e.operation === 'DONE' && next?.event === 'terminal') row.done++
    else if (next?.event === 'route') next.fallback ? row.fallback++ : row.handoff++
    else row.executed++
  }
}
let bindChecks = { total: 0, correct: 0, wrong: [] }
try {
  for (const f of (await readdir(runDir)).filter(f => f.startsWith('complex-') && f.endsWith('.json'))) {
    const r = JSON.parse(await readFile(join(runDir, f), 'utf8')).summary
    if (!r?.live || !r.binds || sha && !String(r.tracePath).length) continue
    bindChecks.total += r.binds.total; bindChecks.correct += r.binds.correct; bindChecks.wrong.push(...r.binds.wrong)
  }
} catch { /* no run files */ }
const lines = [`# browser_task routing calibration`, '', `Traces: ${tasks} tasks${sha ? ` (sourceSha ${sha}*)` : ''}. Terminal: ${JSON.stringify(terminals)}.`, '',
  '## Accepted bindings (supplied inputs, gate 0.6) and goal field fills (gate 0.7)', '', '| p | inputs | goal fields |', '| --- | --- | --- |', ...order.map(b => `| ${b} | ${binds[b] ?? 0} | ${fields[b] ?? 0} |`), '', `Drops: ${JSON.stringify(drops)}.`,
  `Test-side bind correctness (complex-forms live runs): ${bindChecks.correct}/${bindChecks.total}${bindChecks.wrong.length ? `; wrong: ${JSON.stringify(bindChecks.wrong)}` : ''}.`, '',
  '## Operation decisions (cycles without bindings); p = min(operation, target)', '', '| operation | p | executed | R0 fallback | caller handoff | DONE | in tasks ending done |', '| --- | --- | --- | --- | --- | --- | --- |',
  ...Object.entries(ops).sort().map(([k, r]) => { const [op, b] = k.split('|'); return `| ${op} | ${b} | ${r.executed} | ${r.fallback} | ${r.handoff} | ${r.done} | ${r.inPassingTask} |` })]
console.log(lines.join('\n'))
