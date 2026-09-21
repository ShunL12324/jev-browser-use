import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { askJev, RunError } from './core.mjs'
import { requireBudget, reserveRequest } from './budget.mjs'
import { reshapeParams } from '../schemas.js'
import { runS1, validateS1Task, taskSchema, assertionSchema } from './s1.mjs'

export const S1_REQUEST_LIMIT = 30
export const S1_LEDGER = '/tmp/jev-generalization/s1-review/live-budget.json'
export function assertS1Origin(url) {
  const u = new URL(url)
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname) || u.port !== '17430' || u.username || u.password) throw new RunError('EXPERIMENT_ORIGIN', 'S1 entry is restricted to isolated localhost:17430.')
}
export async function executeS1Run(input, { host, signal, ask = askJev, ledgerPath = process.env.JEV_S1_BUDGET_PATH ?? S1_LEDGER, traceDirectory = process.env.JEV_S1_TRACE_DIR ?? '/tmp/jev-generalization/s1-review/traces', sourceSha = process.env.JEV_SOURCE_SHA ?? 'unknown', onUncertain = () => {} }) {
  const task = validateS1Task(input)
  assertS1Origin(task.startUrl); task.allowedOrigins.forEach(assertS1Origin)
  requireBudget(ledgerPath, task.maxRequests, S1_REQUEST_LIMIT)
  mkdirSync(traceDirectory, { recursive: true, mode: 0o700 })
  const runId = randomUUID(), tracePath = join(traceDirectory, `${runId}.jsonl`)
  let takeoverAllowed = true, requests = 0, inputTokens = 0, knownUsageResponses = 0
  const emit = event => appendFileSync(tracePath, JSON.stringify({ runId, at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 })
  emit({ event: 'start', sourceSha, protocol: 'S1-v0', task })
  const call = async (name, args, runSignal) => {
    runSignal.throwIfAborted()
    const shaped = name === 's1' ? { tabId: args.tabId, params: Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'tabId')) } : reshapeParams(name, args)
    emit({ event: 'tool_started', tool: name, args })
    try {
      const result = await host.invoke(name, shaped.params, shaped.tabId)
      emit({ event: 'tool_finished', tool: name, result }); return result
    } catch (e) {
      if (['TIMEOUT', 'BRIDGE_DISCONNECT'].includes(e.code) || name === 's1' && args.action === 'execute') { takeoverAllowed = false; onUncertain() }
      emit({ event: 'tool_error', tool: name, code: e.code }); throw e
    }
  }
  const countedAsk = async (payload, options) => {
    const requestMetadata = { runId, sourceSha, phase: 'S1', payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') }
    let reserved = false
    const countUsage = usage => { if (reserved && Number.isFinite(usage?.input_tokens) && usage.input_tokens >= 0) { inputTokens += usage.input_tokens; knownUsageResponses++ } }
    const onRequest = sequence => { reserved = true; requests++; emit({ event: 'api_started', sequence, payload }) }
    if (ask !== askJev) onRequest(reserveRequest(ledgerPath, requestMetadata, S1_REQUEST_LIMIT))
    try {
      const response = await ask(payload, { ...options, ledgerPath, requestMetadata, requestLimit: S1_REQUEST_LIMIT, onRequest })
      countUsage(response.usage)
      emit({ event: 'api_finished', answers: response.answers, usage: response.usage, model: response.model }); return response
    } catch (e) { countUsage(e.usage); emit({ event: 'api_error', code: e.code, diagnostic: e.diagnostic, usage: e.usage }); throw e }
  }
  const result = await runS1(task, { call, ask: countedAsk, signal, emit })
  const terminal = { ...result, requests, inputTokens, unknownUsageRequests: requests - knownUsageResponses, runId, sourceSha, tracePath, takeoverAllowed, verificationLevel: result.status === 'verified' ? 'declared_ui_assertions' : 'not_verified' }
  emit({ event: 'terminal', ...terminal }); return terminal
}
export function registerS1(server, { host, gate }) {
  if (process.env.JEV_ENABLE_S1 !== '1') return
  const wrap = fn => async (input, extra) => {
    try { const result = await gate.exclusive(() => fn(input, extra)); return { content: [{ type: 'text', text: JSON.stringify(result) }] } }
    catch (e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: e.code ?? 'S1_ERROR', message: e instanceof RunError ? e.message : 'S1 operation failed.' }) }] } }
  }
  server.registerTool('jev_run_s1', { description: 'Opt-in isolated S1 experiment. Shared 30-attempt budget. verified means declared UI assertions, not independent oracle or persistence.', inputSchema: taskSchema.shape }, wrap((input, extra) => executeS1Run(input, { host, signal: extra.signal, onUncertain: () => gate.poison() })))
  // Internal adapter access for offline mechanical tests. Never a model registry
  // escape hatch: S1 only enumerates its static operations.
  server.registerTool('browser_s1', { description: 'Internal isolated S1 adapter (top frame only).', inputSchema: {
    tabId: z.number().int(), action: z.enum(['observe', 'execute']), assertions: z.array(assertionSchema).optional(), limit: z.number().int().min(1).max(500).optional(),
    documentId: z.string().optional(), url: z.string().url().optional(), allowedOrigins: z.array(z.string().url()).optional(), operation: z.enum(['activate', 'replace_text', 'scroll_into_view', 'scroll_down', 'scroll_up', 'wait']).optional(), ref: z.string().optional(), expected: z.record(z.unknown()).optional(), text: z.string().max(4000).optional()
  } }, wrap(async input => {
    const { tabId, ...params } = input
    if (params.action === 'execute') {
      if (!params.documentId || !params.url || !params.allowedOrigins?.length) throw new RunError('TASK', 'Execution requires document and origin preconditions.')
      assertS1Origin(params.url); params.allowedOrigins.forEach(assertS1Origin)
    }
    params.assertions ??= []
    let result
    try { result = await host.invoke('s1', params, tabId) } catch (error) {
      if (params.action === 'execute') gate.poison()
      throw error
    }
    if (params.action === 'observe') assertS1Origin(result.url)
    return result
  }))
}
