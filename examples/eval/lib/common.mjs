// Shared server-side run store and grading helpers for local eval sites.
// Oracle state lives only in this process; nothing here is rendered to pages.
import { randomUUID } from 'node:crypto'

export const SEEDS = ['atlas', 'birch']
export const VARIANTS = ['standard', 'alternate']

// Deterministic PRNG so every seed produces the same data on every start.
export function rng(seed) {
  let h = 2166136261
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296 }
}
export const pick = (r, list) => list[Math.floor(r() * list.length)]

export function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s ]+/g, ' ').trim().replace(/[.,;:!?"'`]+$/g, '')
}

// Answer checks: every expected token must occur; forbidden tokens must not.
// Numbers are compared as numbers when the expected value is numeric.
export function gradeAnswer(answer, { anyOf = [], allOf = [], number, forbid = [] }) {
  const a = normalize(answer), checks = []
  if (anyOf.length) checks.push({ id: 'any_of', passed: anyOf.some(x => a.includes(normalize(x))) })
  for (const x of allOf) checks.push({ id: `contains:${x}`, passed: a.includes(normalize(x)) })
  if (number !== undefined) {
    const found = (a.replace(/(\d),(\d{3})/g, '$1$2').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    checks.push({ id: `number:${number}`, passed: found.includes(Number(number)) })
  }
  for (const x of forbid) checks.push({ id: `forbid:${x}`, passed: !a.includes(normalize(x)) })
  return { passed: checks.length > 0 && checks.every(c => c.passed), checks }
}

export class RunStore {
  constructor(site) { this.site = site; this.runs = new Map() }
  create({ seed = 'atlas', variant = 'standard', taskId = null } = {}) {
    if (!SEEDS.includes(seed) || !VARIANTS.includes(variant)) throw Object.assign(new Error('Unknown seed or variant'), { status: 400 })
    const run = { id: randomUUID(), site: this.site, seed, variant, taskId, createdAt: Date.now(), commits: [], events: [], state: {}, answers: [] }
    this.runs.set(run.id, run)
    return run
  }
  get(id) { return this.runs.get(id) }
  // Irreversible actions (order, booking, deletion) are timestamped so the
  // harness can check that a confirmation handoff preceded them.
  commit(run, kind, detail) { const c = { kind, detail, at: Date.now() }; run.commits.push(c); return c }
  event(run, kind, detail) { run.events.push({ kind, detail, at: Date.now() }) }
}

// Resolves the run from ?run= (first visit) or the per-site cookie.
export function runMiddleware(store, cookieName) {
  return (req, res, next) => {
    const fromQuery = typeof req.query.run === 'string' ? req.query.run : null
    const fromCookie = (req.headers.cookie ?? '').split(/;\s*/).map(s => s.split('=')).find(([k]) => k === cookieName)?.[1]
    const run = store.get(fromQuery ?? fromCookie)
    if (fromQuery && run) res.setHeader('Set-Cookie', `${cookieName}=${run.id}; Path=/; SameSite=Lax`)
    req.run = run
    next()
  }
}

// Eval endpoints sit on the site origin, which runners are allowed to visit,
// so they require a per-server token that only the harness holds.
export const EVAL_TOKEN = process.env.EVAL_TOKEN ?? randomUUID()
const guard = (req, res, next) => req.get('x-eval-token') === EVAL_TOKEN ? next() : res.status(403).json({ error: 'Eval token required' })

// Standard eval endpoints shared by all local sites (see docs/eval.zh-CN.md).
export function mountEval(app, store, { tasks, startPath = () => '/' }) {
  app.use('/__eval/reset', guard); app.use('/__eval/oracle', guard); app.use('/__eval/grade', guard)
  app.post('/__eval/reset', (req, res) => {
    const { seed, variant, taskId } = req.body ?? {}
    if (taskId && !tasks[taskId]) return res.status(400).json({ error: 'Unknown task' })
    let run
    try { run = store.create({ seed, variant, taskId }) } catch (e) { return res.status(e.status ?? 500).json({ error: e.message }) }
    const task = taskId ? tasks[taskId] : null
    const params = task?.params?.(run) ?? {}
    run.params = params
    task?.setup?.(run)
    const path = task?.path?.(run) ?? startPath(run)
    res.json({ runId: run.id, url: `${path}${path.includes('?') ? '&' : '?'}run=${run.id}`, params, seed: run.seed, variant: run.variant })
  })
  app.get('/__eval/oracle/:id', (req, res) => {
    const run = store.get(req.params.id)
    if (!run) return res.status(404).json({ error: 'Unknown run' })
    const task = tasks[run.taskId]
    if (!task?.check) return res.status(400).json({ error: 'Task has no state oracle' })
    const checks = task.check(run)
    res.json({ runId: run.id, taskId: run.taskId, checks, passed: checks.every(c => c.passed), commits: run.commits })
  })
  app.post('/__eval/grade/:id', (req, res) => {
    const run = store.get(req.params.id)
    if (!run) return res.status(404).json({ error: 'Unknown run' })
    const task = tasks[run.taskId]
    // Collect tasks grade a structured items[] list instead of an answer string.
    if (task?.items) {
      const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 200) : []
      run.answers.push({ items, at: Date.now() })
      const checks = task.items(run, items)
      return res.json({ runId: run.id, taskId: run.taskId, checks, passed: checks.length > 0 && checks.every(c => c.passed), commits: run.commits })
    }
    if (!task?.answer) return res.status(400).json({ error: 'Task has no answer oracle' })
    const answer = String(req.body?.answer ?? '')
    run.answers.push({ answer, at: Date.now() })
    const graded = gradeAnswer(answer, task.answer(run))
    const extra = task.check ? task.check(run) : []
    const checks = [...graded.checks, ...extra]
    res.json({ runId: run.id, taskId: run.taskId, checks, passed: checks.length > 0 && checks.every(c => c.passed), commits: run.commits })
  })
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export const check = (id, passed, detail) => ({ id, passed: !!passed, ...(detail !== undefined ? { detail } : {}) })
