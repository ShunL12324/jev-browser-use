#!/usr/bin/env node
// Eval harness CLI.
//   list                                  show tasks (id, suite, capabilities)
//   run --runner R [--tasks glob] [--seeds a,b] [--variants s,a] [--repeat n] [--handoff scripted|deny] [--out file]
//   start TASK [--seed s] [--variant v]   tester mode: reset and print the runner view
//   finish PENDING --result FILE [--trace FILE] [--page-state FILE]   tester mode: grade independently
//   report [RESULTS.jsonl]                aggregate by task, capability and weighted coverage
import { parseArgs } from 'node:util'
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { loadTasks, prepare, resolveSecrets, viewHash } from './tasks.mjs'
import { grade } from './grade.mjs'
import { readPageState, trimPageState } from './browser.mjs'
import { report } from './report.mjs'

const RESULTS_DIR = new URL('../results/', import.meta.url).pathname
const BOUNDARIES = {
  e2eMs: 'harness: before runner.run() -> after oracle response (includes reset-free runner time and grading)',
  agentMs: 'runner-reported: first decision -> terminal state, excluding initial navigation (jev-ultrafast-compatible); includes waits and handoffs',
  handoffWaitMs: 'runner-reported: total time waiting for handoff answers'
}
const runners = {
  mechanical: async () => (await import('./adapters/mechanical.mjs')).createRunner({ name: 'mechanical' }),
  'mechanical-noconfirm': async () => (await import('./adapters/mechanical.mjs')).createRunner({ name: 'mechanical-noconfirm' }),
  noop: async () => (await import('./adapters/noop.mjs')).createRunner({ name: 'noop' }),
  wrong: async () => (await import('./adapters/noop.mjs')).createRunner({ name: 'wrong' }),
  'browser-task': async opts => (await import('./adapters/browser-task.mjs')).createRunner(opts),
  'jev-ultrafast': async opts => (await import('./adapters/jev-ultrafast.mjs')).createRunner(opts)
}

// Harness-side handoff answers. Open-ended kinds are never answered here; a
// Claude Code tester answers those in tester mode ("assisted" results).
export function responder(mode, view) {
  return async req => {
    if (mode === 'deny') return { approve: false, answer: null }
    if (req.kind === 'confirm') return { approve: view.irreversible === 'confirm' }
    if (req.kind === 'credentials') return { secretRef: req.secretRef ?? null }
    return { approve: false, answer: null, declined: true }
  }
}
const match = (id, glob) => !glob || glob.split(',').some(g => new RegExp('^' + g.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$').test(id))

export async function runOne(task, runner, { seed, variant, handoff, page }) {
  const { runnerView, run } = await prepare(task, { seed, variant }), secrets = task.suite === 'local' ? resolveSecrets(runnerView, seed) : {}
  const ctx = { secrets, files: run.files ?? {}, handoff: responder(handoff, runnerView), readPage: task.suite === 'public' ? readPageState : null }
  const started = performance.now(), startedAt = Date.now()
  let result
  try { result = await runner.run(runnerView, ctx) } catch (e) { result = { status: 'error', error: e.message, handoffs: [], metrics: {} } }
  const traceText = result.tracePath ? await readFile(result.tracePath, 'utf8').catch(() => '') : ''
  const graded = await grade(task, run, result, { secrets, traceText, pageState: result.pageState ?? page ?? null })
  const e2eMs = performance.now() - started
  return {
    taskId: task.id, suite: task.suite, capabilities: task.capabilities, runner: runner.name, evidence: runner.evidence, seed: run.seed, variant: run.variant, heldOut: run.variant === 'alternate' && task.heldOutStrength !== 'css_only',
    runId: run.runId ?? null, viewHash: viewHash(runnerView), startedAt, passed: graded.passed, status: result.status, error: result.error,
    checks: graded.checks, irreversible: graded.irreversible, leaked: graded.leaked, oracleEvidence: graded.evidence,
    answer: result.answer ?? null, e2eMs, metrics: result.metrics ?? {}, handoffs: result.handoffs ?? [], tracePath: result.tracePath ?? null, ...(task.suite === 'public' && result.pageState ? { pageState: trimPageState(result.pageState) } : {}), boundaries: BOUNDARIES
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { values: o, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    runner: { type: 'string' }, tasks: { type: 'string' }, suite: { type: 'string' }, seeds: { type: 'string', default: 'atlas' }, variants: { type: 'string', default: 'standard' },
    repeat: { type: 'string', default: '1' }, handoff: { type: 'string', default: 'scripted' }, out: { type: 'string' }, seed: { type: 'string', default: 'atlas' }, variant: { type: 'string', default: 'standard' },
    result: { type: 'string' }, trace: { type: 'string' }, 'page-state': { type: 'string' }, bridge: { type: 'string' }, quiet: { type: 'boolean', default: false } } })
  const tasks = loadTasks()
  if (command === 'list') { for (const t of tasks.filter(t => (!o.suite || t.suite === o.suite) && match(t.id, o.tasks))) console.log(`${t.id.padEnd(38)} ${t.suite.padEnd(7)} ${t.irreversible.padEnd(8)} ${t.capabilities.join(' ')}`); return }
  await mkdir(RESULTS_DIR, { recursive: true })
  if (command === 'run') {
    if (!runners[o.runner]) throw new Error(`Unknown runner ${o.runner}; one of ${Object.keys(runners).join(', ')}`)
    const runner = await runners[o.runner]({ bridge: o.bridge }), out = o.out ?? `${RESULTS_DIR}${o.runner}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
    const selected = tasks.filter(t => (!o.suite || t.suite === o.suite) && match(t.id, o.tasks))
    let passed = 0, total = 0
    for (const task of selected) for (const seed of task.suite === 'public' ? [null] : o.seeds.split(',')) for (const variant of task.suite === 'public' ? [null] : o.variants.split(',').filter(v => !task.variants || task.variants.includes(v))) for (let i = 0; i < Number(o.repeat); i++) {
      const row = await runOne(task, runner, { seed: seed ?? undefined, variant: variant ?? undefined, handoff: o.handoff })
      total++; if (row.passed) passed++
      await appendFile(out, JSON.stringify(row) + '\n')
      if (!o.quiet) console.log(`${row.passed ? 'PASS' : 'FAIL'} ${task.id} ${seed ?? ''}/${variant ?? ''} ${row.status}${row.error ? ' ' + row.error : ''} ${row.passed ? '' : row.checks.filter(c => !c.passed).map(c => c.id.replace(/^(contains|number|forbid):.*/, '$1:<hidden>')).join(',')}`)
    }
    await runner.close?.()
    console.log(JSON.stringify({ runner: o.runner, passed, total, out }))
    return
  }
  if (command === 'start') {
    const task = tasks.find(t => t.id === positionals[0]); if (!task) throw new Error('Unknown task')
    const { runnerView, run } = await prepare(task, { seed: o.seed, variant: o.variant })
    const pending = `${RESULTS_DIR}pending-${task.id}-${run.runId ?? Date.now()}.json`
    await writeFile(pending, JSON.stringify({ run, runnerView, startedAt: Date.now() }, null, 2))
    console.log(JSON.stringify({ pending, runnerView }, null, 2))
    return
  }
  if (command === 'finish') {
    const p = JSON.parse(await readFile(positionals[0], 'utf8')), task = tasks.find(t => t.id === p.run.taskId), result = JSON.parse(await readFile(o.result, 'utf8'))
    const secrets = task.suite === 'local' ? resolveSecrets(p.runnerView, p.run.seed) : {}, traceText = o.trace ? await readFile(o.trace, 'utf8') : ''
    const pageState = o['page-state'] ? { ...JSON.parse(await readFile(o['page-state'], 'utf8')), source: 'runner' } : null
    const graded = await grade(task, p.run, result, { secrets, traceText, pageState })
    const row = { taskId: task.id, suite: task.suite, capabilities: task.capabilities, runner: result.runner ?? 'tester', evidence: 'tester', seed: p.run.seed, variant: p.run.variant, heldOut: p.run.variant === 'alternate' && task.heldOutStrength !== 'css_only', runId: p.run.runId ?? null,
      viewHash: viewHash(p.runnerView), startedAt: p.startedAt, passed: graded.passed, status: result.status, checks: graded.checks, irreversible: graded.irreversible, leaked: graded.leaked, oracleEvidence: graded.evidence,
      answer: result.answer ?? null, e2eMs: Date.now() - p.startedAt, metrics: result.metrics ?? {}, handoffs: result.handoffs ?? [], tracePath: o.trace ?? result.tracePath ?? null, boundaries: { ...BOUNDARIES, e2eMs: 'tester mode: harness start -> harness finish (includes tester turns)' } }
    await appendFile(o.out ?? `${RESULTS_DIR}tester.jsonl`, JSON.stringify(row) + '\n')
    // Console output never reveals expected answers (results/ keeps full detail for the validator).
    console.log(JSON.stringify({ passed: row.passed, failedChecks: row.checks.filter(c => !c.passed).map(c => c.id.replace(/^(contains|number|forbid):.*/, '$1:<hidden>')) }, null, 2))
    return
  }
  if (command === 'report') { console.log(await report(positionals[0])); return }
  if (command === 'manifests') {
    // Host-side manifests for a product bridge in tester mode (JEV_SECRETS_MANIFEST,
    // JEV_S1_FILES_MANIFEST). Written 0600; never shown to the tester's model.
    const dir = positionals[0] ?? RESULTS_DIR, seed = o.seed, { loadSecrets } = await import('./tasks.mjs'), { siteOrigin, LOCAL_SITES } = await import('./sites.mjs')
    const secrets = Object.fromEntries(Object.entries(loadSecrets()[seed]).map(([ref, s]) => [ref, { value: s.value, origins: s.sites.map(x => LOCAL_SITES[x] ? siteOrigin(x) : x) }]))
    const { createHash } = await import('node:crypto'), pdf = await readFile(new URL(`../../complex-forms/fixtures/${seed}.pdf`, import.meta.url))
    const files = { [`resume-${seed}`]: { name: `${seed}.pdf`, mimeType: 'application/pdf', data: pdf.toString('base64'), sha256: createHash('sha256').update(pdf).digest('hex') } }
    await mkdir(dir, { recursive: true })
    await writeFile(`${dir}/secrets-${seed}.json`, JSON.stringify(secrets), { mode: 0o600 }); await writeFile(`${dir}/files-${seed}.json`, JSON.stringify(files), { mode: 0o600 })
    console.log(JSON.stringify({ JEV_SECRETS_MANIFEST: `${dir}/secrets-${seed}.json`, JEV_S1_FILES_MANIFEST: `${dir}/files-${seed}.json` }))
    return
  }
  console.log('Commands: list | run | start | finish | report')
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main()
