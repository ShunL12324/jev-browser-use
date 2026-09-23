// Development driver for one T33 local eval task (examples/eval of the eval
// worktree, EVAL_ROOT). Resets the site, gives browser_task only the runner
// view, then reads the site oracle independently. Scripted handoffs: confirm
// approves only when the task says irreversible=confirm; others are declined.
//   EVAL_ROOT=/path/to/examples/eval node scripts/jev/task-eval.mjs forma.travel_filter [--seed=atlas]
import { readFile } from 'node:fs/promises'
import { launchIsolated, runBrowserTask } from './task-browser.mjs'

const root = process.env.EVAL_ROOT, [taskId] = process.argv.slice(2).filter(a => !a.startsWith('--'))
const seed = process.argv.find(a => a.startsWith('--seed='))?.slice(7) ?? 'atlas'
const PORTS = { portal: 17441, shop: 17442, workspace: 17443, partner: 17444, forma: 17445 }
const spec = JSON.parse(await readFile(`${root}/tasks/local.json`, 'utf8')).find(t => t.id === taskId)
const origin = `http://127.0.0.1:${PORTS[spec.site]}`
const token = (await readFile(`${root}/.eval-token`, 'utf8').catch(() => '')).trim(), headers = { 'x-eval-token': token }
const reset = await (await fetch(`${origin}/__eval/reset`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ seed, variant: 'standard', taskId }) })).json()
const fill = s => s.replace(/\{\{([\w.]+)\}\}/g, (_, k) => k.split('.').reduce((o, p) => o?.[p], reset.params) ?? `{{${k}}}`)
const view = { goal: fill(spec.goal), startUrl: origin + reset.url, allowedOrigins: (spec.allowedSites ?? [spec.site]).map(s => `http://127.0.0.1:${PORTS[s]}`), inputs: reset.inputs ?? {}, irreversible: spec.irreversible ?? 'confirm', llm: 'handoff', budgets: { maxJevRequests: 30, timeoutMs: 180000 } }
const browser = await launchIsolated()
try {
  const started = performance.now()
  const run = await runBrowserTask(browser.tool, view, async h => h.kind === 'confirm' ? { approve: spec.irreversible === 'confirm' } : {})
  const oracle = await (await fetch(`${origin}/__eval/oracle/${reset.runId}`, { headers })).json()
  const m = run.result.metrics ?? {}
  console.log(JSON.stringify({ taskId, seed, goal: view.goal, status: run.result.status, reason: run.result.reason ?? run.result.code, oracle, e2eMs: Math.round(performance.now() - started), agentMs: Math.round(m.agentMs), jevRequests: m.jevRequests, jevInputTokens: m.jevInputTokens, steps: m.steps, handoffs: run.handoffs.map(h => h.kind), tracePath: run.result.tracePath }))
} finally { await browser.close() }
