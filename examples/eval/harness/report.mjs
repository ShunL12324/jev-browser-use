// Aggregates result rows: per task, per capability, and weighted checklist
// coverage as defined in docs/eval.zh-CN.md (held-out runs, >=4/5 success).
import { readFile, readdir } from 'node:fs/promises'
import { loadTasks } from './tasks.mjs'

const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null }
const ms = v => v == null ? '-' : `${(v / 1000).toFixed(2)}s`

export async function loadRows(path) {
  const dir = new URL('../results/', import.meta.url).pathname
  const files = path ? [path] : (await readdir(dir)).filter(f => f.endsWith('.jsonl')).map(f => dir + f)
  return (await Promise.all(files.map(f => readFile(f, 'utf8')))).flatMap(t => t.split('\n').filter(Boolean).map(l => JSON.parse(l)))
}

export function coverage(rows, checklist, { minRuns = 5, minRate = 0.8 } = {}) {
  const tasks = loadTasks(), items = checklist.items.map(item => {
    // ROB-3 (held-out variant) is measured by every held-out run.
    const variantItem = item.id === 'ROB-3'
    const mapped = tasks.filter(t => variantItem ? t.suite === 'local' : t.capabilities.includes(item.id)).map(t => t.id)
    const held = rows.filter(r => variantItem ? r.heldOut : r.capabilities?.includes(item.id) && (r.heldOut || r.suite === 'public'))
    const passes = held.filter(r => r.passed).length, rate = held.length ? passes / held.length : null
    const status = item.knownLimit ? 'known_limit' : !mapped.length ? 'no_task' : held.length < minRuns ? 'insufficient_runs' : rate >= minRate ? 'covered' : 'not_covered'
    return { ...item, tasks: mapped, heldOutRuns: held.length, heldOutPasses: passes, status }
  })
  const total = items.reduce((s, i) => s + i.weight, 0), covered = items.filter(i => i.status === 'covered').reduce((s, i) => s + i.weight, 0)
  return { items, weightedCoverage: covered / total, knownLimitWeight: items.filter(i => i.knownLimit).reduce((s, i) => s + i.weight, 0) / total }
}

export async function report(path) {
  const rows = await loadRows(path), checklist = JSON.parse(await readFile(new URL('../checklist.json', import.meta.url), 'utf8'))
  const byRunner = Object.groupBy(rows, r => r.runner), out = []
  for (const [runner, rs] of Object.entries(byRunner)) {
    out.push(`## Runner ${runner} (${rs[0].evidence})`, '', '| task | runs | pass | held-out pass | median e2e | median agentMs | median Jev req | handoffs |', '|---|---|---|---|---|---|---|---|')
    for (const [task, ts] of Object.entries(Object.groupBy(rs, r => r.taskId))) {
      const held = ts.filter(r => r.heldOut)
      out.push(`| ${task} | ${ts.length} | ${ts.filter(r => r.passed).length} | ${held.length ? `${held.filter(r => r.passed).length}/${held.length}` : '-'} | ${ms(median(ts.map(r => r.e2eMs)))} | ${ms(median(ts.map(r => r.metrics?.agentMs)))} | ${median(ts.map(r => r.metrics?.jevRequests)) ?? '-'} | ${ts.reduce((s, r) => s + (r.handoffs?.length ?? 0), 0)} |`)
    }
    const cov = coverage(rs, checklist)
    out.push('', `Weighted checklist coverage (held-out, >=5 runs, >=80%): **${(cov.weightedCoverage * 100).toFixed(1)}%**; known-limit weight ${(cov.knownLimitWeight * 100).toFixed(1)}%.`, '')
    out.push('| item | weight | status | held-out | tasks |', '|---|---|---|---|---|', ...cov.items.map(i => `| ${i.id} ${i.title} | ${i.weight} | ${i.status} | ${i.heldOutPasses}/${i.heldOutRuns} | ${i.tasks.length} |`), '')
  }
  return out.join('\n')
}
