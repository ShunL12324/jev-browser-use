// browser_task sessions: schema, product ledger, trace, secrets and the
// pause/resume plumbing that turns loop handoffs into MCP round trips.
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { askJev, RunError } from '../jev/core.mjs'
import { requireBudget, reserveRequest } from '../jev/budget.mjs'
import { authorizeFile, loadAuthorizedFiles } from '../jev/s1-service.mjs'
import { runTask } from './loop.mjs'
import { lenient } from './jev.mjs'

export const PRODUCT_LEDGER = '/tmp/jev-product/live-budget.json'
export const PRODUCT_LIMIT = 10000
const input = z.union([z.object({ value: z.string().max(4000), purpose: z.string().min(1).max(300) }).strict(), z.object({ secretRef: z.string().min(1).max(100), purpose: z.string().min(1).max(300) }).strict()])
export const startSchema = z.object({
  goal: z.string().min(1).max(4000), startUrl: z.string().url(), allowedOrigins: z.array(z.string().url()).min(1).max(20),
  inputs: z.record(input).default({}), files: z.record(z.object({ fileId: z.string().min(1).max(100), purpose: z.string().min(1).max(300) }).strict()).default({}),
  irreversible: z.enum(['confirm', 'deny', 'none']).default('confirm'), keepTabs: z.enum(['none', 'final', 'all']).default('final'), llm: z.enum(['handoff', 'none']).default('handoff'),
  budgets: z.object({ timeoutMs: z.number().int().min(1000).max(1800000).default(300000), maxSteps: z.number().int().min(1).max(300).default(120), maxJevRequests: z.number().int().min(1).max(300).default(80) }).strict().default({})
}).strict()
// Host secret manifest: {ref: {value, origins:[...]}}. Plaintext never enters
// Jev state, handoffs, results or traces.
function loadSecrets() {
  if (!process.env.JEV_SECRETS_MANIFEST) return {}
  try { return JSON.parse(readFileSync(process.env.JEV_SECRETS_MANIFEST, 'utf8')) } catch { throw new RunError('SECRET_UNAUTHORIZED', 'Cannot read the host secret manifest.') }
}
export function prepareTask(raw) {
  const parsed = startSchema.safeParse(raw)
  if (!parsed.success) throw new RunError('TASK', parsed.error.message)
  const task = parsed.data, url = new URL(task.startUrl)
  for (const origin of task.allowedOrigins) if (new URL(origin).origin !== origin) throw new RunError('TASK', 'allowedOrigins must be canonical origins.')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !task.allowedOrigins.includes(url.origin)) throw new RunError('TASK', 'startUrl must be inside allowedOrigins.')
  const secrets = loadSecrets(), inputs = {}
  for (const [id, v] of Object.entries(task.inputs)) {
    if (v.secretRef) {
      const s = secrets[v.secretRef]
      if (!s || typeof s.value !== 'string' || !Array.isArray(s.origins) || !s.origins.some(o => task.allowedOrigins.includes(o))) throw new RunError('SECRET_UNAUTHORIZED', `Secret ${v.secretRef} is not authorized for this task's origins.`)
      inputs[id] = { value: s.value, purpose: v.purpose, secret: true, origins: s.origins }
    } else inputs[id] = { ...v }
  }
  for (const [id, f] of Object.entries(task.files)) inputs[id] = { ...f }
  return { ...task, inputs }
}

const sessions = new Map()
// Final tab of this session's previous task; closed when the next task starts
// (keepTabs:'final' leaves it open only for reading the result).
let previousFinalTab = null
// Each call returns at the next handoff, at termination, or after waitMs.
function wait(session, waitMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { session.wake = null; resolve(view(session)) }, waitMs)
    session.wake = () => { clearTimeout(timer); session.wake = null; resolve(view(session)) }
    if (session.result || session.pending) session.wake()
  })
}
const view = s => s.result ? { taskId: s.id, ...s.result, tracePath: s.tracePath } : s.pending ? { status: 'needs_input', taskId: s.id, handoff: s.pending.request } : { status: 'running', taskId: s.id }

export async function startTask(raw, { host, ask = askJev, ledgerPath = process.env.JEV_PRODUCT_LEDGER ?? PRODUCT_LEDGER, traceDirectory = process.env.JEV_TASK_TRACE_DIR ?? '/tmp/jev-product/traces', waitMs = 50000, handoff } = {}) {
  const task = prepareTask(raw)
  const authorized = Object.values(task.inputs).some(i => i.fileId) ? loadAuthorizedFiles() : {}
  for (const i of Object.values(task.inputs)) if (i.fileId) authorizeFile(i.fileId, authorized)
  requireBudget(ledgerPath, task.budgets.maxJevRequests, PRODUCT_LIMIT)
  mkdirSync(traceDirectory, { recursive: true, mode: 0o700 })
  const id = `t_${randomUUID()}`, tracePath = join(traceDirectory, `${id}.jsonl`)
  const secretValues = Object.values(task.inputs).filter(i => i.secret).map(i => i.value)
  const redact = text => secretValues.reduce((t, v) => t.split(v).join('‹secret›'), text)
  const emit = event => {
    appendFileSync(tracePath, redact(JSON.stringify({ taskId: id, at: new Date().toISOString(), ...event })) + '\n', { mode: 0o600 })
    if (event.event === 'tab' && previous !== null && event.tabId !== previous) host.invoke('tabs', { action: 'close', tabId: previous }).catch(() => {})
  }
  // The previous task's final tab is closed only after this task's tab
  // exists, so the agent window never becomes empty (and never closes).
  const previous = task.keepTabs !== 'all' ? previousFinalTab : null
  if (previous !== null) previousFinalTab = null
  const controller = new AbortController(), session = { id, tracePath, controller, pending: null, result: null, wake: null }
  sessions.set(id, session)
  emit({ event: 'start', sourceSha: process.env.JEV_SOURCE_SHA ?? 'unknown', task: { ...task, inputs: Object.fromEntries(Object.entries(task.inputs).map(([k, v]) => [k, v.secret ? { ...v, value: '‹secret›' } : v])) } })
  const call = async (name, args, signal) => {
    signal?.throwIfAborted()
    // Only s1, navigate and tabs are used; tabs reads its target from params.
    const { tabId, ...params } = args
    return host.invoke(name, name === 'tabs' ? { ...params, tabId } : params, tabId)
  }
  const countedAsk = async (payload, options) => {
    const requestMetadata = { taskId: id, sourceSha: process.env.JEV_SOURCE_SHA ?? 'unknown', phase: 'browser_task', payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') }
    const onRequest = sequence => emit({ event: 'jev_request', sequence, payload })
    if (ask !== askJev) onRequest(reserveRequest(ledgerPath, requestMetadata, PRODUCT_LIMIT))
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await ask(payload, { ...options, ledgerPath, requestMetadata, requestLimit: PRODUCT_LIMIT, onRequest, validate: lenient })
        emit({ event: 'jev_response', answers: response.answers, usage: response.usage, model: response.model }); return response
      } catch (e) {
        emit({ event: 'jev_error', code: e.code, diagnostic: e.diagnostic, validation: e.validation, usage: e.usage })
        // A TCP connect timeout proves the request never left this host, so one
        // new attempt (separately reserved in the ledger) cannot double-send.
        if (attempt < 2 && e.diagnostic?.causeCode === 'UND_ERR_CONNECT_TIMEOUT') continue
        // Explicit overload responses (429/503/529) get one delayed attempt, as
        // an SDK would; each attempt is separately ledgered, never a loop.
        if (attempt === 0 && [429, 503, 529].includes(e.diagnostic?.httpStatus)) { await new Promise(r => setTimeout(r, 1000)); continue }
        throw e
      }
    }
  }
  const toCaller = handoff ?? (request => new Promise((resolve, reject) => {
    session.pending = { request: { handoffId: `h_${randomUUID()}`, ...request }, resolve, reject }
    session.wake?.()
  }))
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(task.budgets.timeoutMs)])
  // Warm DNS/TLS while the tab opens: an unauthenticated GET, not a Jev call.
  if (ask === askJev) fetch(process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai', { signal: AbortSignal.timeout(10000) }).catch(() => {})
  const files = fileId => authorizeFile(fileId, authorized)
  runTask(task, { call, ask: countedAsk, handoff: toCaller, emit, signal, files }).then(async result => {
    // Task tabs do not pile up: keep only the final one (or none / all).
    const close = task.keepTabs === 'all' ? [] : (result.taskTabs ?? []).filter(id => task.keepTabs === 'none' || id !== result.tabId)
    for (const id of close) await host.invoke('tabs', { action: 'close', tabId: id }).catch(() => {})
    if (task.keepTabs === 'final' && Number.isInteger(result.tabId)) previousFinalTab = result.tabId
    session.result = result; emit({ event: 'terminal', ...result, closedTabs: close }); session.wake?.()
    setTimeout(() => sessions.delete(id), 600000).unref()
  })
  return wait(session, waitMs)
}
export function continueTask({ taskId, handoffId, answer }, { waitMs = 50000 } = {}) {
  const s = sessions.get(taskId)
  if (!s) throw new RunError('NO_TASK', 'Unknown or expired taskId.')
  if (!s.pending || s.pending.request.handoffId !== handoffId) throw new RunError('NO_HANDOFF', 'No pending handoff with this id.')
  const { resolve } = s.pending
  s.pending = null; resolve(answer ?? {})
  return wait(s, waitMs)
}
export function statusTask({ taskId }, { waitMs = 0 } = {}) {
  const s = sessions.get(taskId)
  if (!s) throw new RunError('NO_TASK', 'Unknown or expired taskId.')
  return wait(s, waitMs)
}
export function cancelTask({ taskId }) {
  const s = sessions.get(taskId)
  if (!s) throw new RunError('NO_TASK', 'Unknown or expired taskId.')
  s.controller.abort(); s.pending?.reject(new RunError('CANCELLED', 'Task cancelled.')); s.pending = null
  return wait(s, 5000)
}
