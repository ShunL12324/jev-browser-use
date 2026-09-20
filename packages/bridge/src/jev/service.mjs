import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { run, validateTask, askJev, RunError } from './core.mjs'
import { requireBudget, reserveRequest, DEFAULT_LEDGER } from './budget.mjs'
import { reshapeParams } from '../schemas.js'

export function createGate() {
  let held = false, poisoned = false
  return {
    poison() { poisoned = true; held = true },
    async exclusive(fn) {
      if (held) throw new RunError('BUSY', poisoned ? 'Prior bridge operation has unknown completion. Close the isolated browser and restart the bridge before takeover.' : 'Another browser operation is in flight. Retry only after it finishes; no operation executed.')
      held = true
      try { return await fn() } catch (error) {
        if (['TIMEOUT', 'BRIDGE_DISCONNECT'].includes(error.code)) poisoned = true
        throw error
      } finally { held = poisoned }
    }
  }
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function executeRun(input, { host, signal, ask = askJev, ledgerPath = process.env.JEV_BUDGET_PATH ?? DEFAULT_LEDGER, traceDirectory = process.env.JEV_TRACE_DIR ?? '/tmp/jev-isolated-mcp-test/traces', sourceSha = process.env.JEV_SOURCE_SHA ?? 'unknown', onUncertain = () => {} }) {
  const runId = randomUUID(), startedAt = new Date().toISOString(), start = performance.now()
  const events = [], timingMs = { api: 0, observe: 0, execute: 0, wait: 0 }
  let uncertainInFlight = false
  let tabId, requests = 0, inputTokens = 0, knownUsageResponses = 0, steps = 0, tracePath, traceWriteError
  const record = event => {
    const entry = { runId, at: new Date().toISOString(), elapsedMs: performance.now() - start, ...event }
    events.push(entry)
    if (event.event === 'tab') tabId = event.tabId
    if (event.step) steps = event.step
    if (tracePath) {
      try { appendFileSync(tracePath, JSON.stringify(entry) + '\n', { mode: 0o600 }) } catch {
        traceWriteError = true
        if (event.event !== 'terminal') throw new RunError('TRACE_WRITE', 'Cannot persist run evidence; stopped before further work.')
      }
    }
  }
  let result
  try {
    const task = validateTask(input)
    const url = new URL(task.startUrl)
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '17430' || url.protocol !== 'http:') throw new RunError('EXPERIMENT_ORIGIN', 'jev_run is restricted to the isolated local fixture on port 17430.')
    if (task.maxSteps > 12 || task.timeoutMs > 120000) throw new RunError('EXPERIMENT_LIMIT', 'Experiment runs allow at most 12 decisions and 120000 ms per run.')
    requireBudget(ledgerPath, task.maxSteps)
    mkdirSync(traceDirectory, { recursive: true, mode: 0o700 })
    tracePath = join(traceDirectory, `${runId}.jsonl`)
    record({ event: 'start', sourceSha, mode: task.mode, phase: input.phase ?? 'J0', scenario: input.scenario ?? 'unspecified', seed: input.seed ?? 'unspecified', task })
    const call = async (name, args, runSignal) => {
      runSignal.throwIfAborted()
      const { params, tabId: targetTab } = reshapeParams(name, args)
      const clock = performance.now(), category = ['view', 'snapshot', 'inspect'].includes(name) ? 'observe' : name === 'wait_for' ? 'wait' : 'execute'
      record({ event: 'tool_started', tool: name, args })
      try {
        // Deliberately await host completion: abort/timeout must not release the
        // shared gate while an extension command could still mutate the page.
        const data = await host.invoke(name, params, targetTab)
        if (data?.ok === false) throw new RunError(data.code ?? 'BROWSER_ERROR', 'Extension tool failed.')
        record({ event: 'tool_finished', tool: name, outcome: 'returned_success', result: data })
        return data
      } catch (error) {
        if (['TIMEOUT', 'BRIDGE_DISCONNECT'].includes(error.code)) { uncertainInFlight = true; onUncertain() }
        record({ event: 'tool_finished', tool: name, outcome: 'error', code: error.code ?? error.name })
        throw error
      } finally { timingMs[category] += performance.now() - clock }
    }
    const countedAsk = async (payload, options) => {
      options.signal.throwIfAborted()
      // No authenticated network request is possible until this durable slot exists.
      const requestMetadata = { runId, mode: task.mode, phase: input.phase ?? 'J0', scenario: input.scenario, seed: input.seed, sourceSha, payloadHash: hash(payload) }
      let sequence
      const onRequest = reserved => {
        sequence = reserved; requests++
        record({ event: 'api_started', sequence, questionCount: Object.keys(payload.questions).length, stateHash: hash(payload.state), questionsHash: hash(payload.questions), payload })
      }
      // The real API reserves centrally, so standalone CLI/live diagnostics also
      // obey the same ledger. Injected offline providers emulate that boundary.
      if (ask !== askJev) onRequest(reserveRequest(ledgerPath, requestMetadata))
      const clock = performance.now()
      try {
        const response = await ask(payload, { ...options, ledgerPath, requestMetadata, onRequest })
        if (Number.isFinite(response.usage?.input_tokens) && response.usage.input_tokens >= 0) { inputTokens += response.usage.input_tokens; knownUsageResponses++ }
        record({ event: 'api_finished', sequence, model: response.model, usage: response.usage, answers: response.answers })
        return response
      } catch (error) {
        record({ event: 'api_error', sequence, code: error.code ?? error.name, diagnostic: error.diagnostic })
        throw error
      } finally { timingMs.api += performance.now() - clock }
    }
    result = await run(task, { call, ask: countedAsk, signal, emit: record })
  } catch (error) {
    result = { status: 'error', code: error.code ?? error.name, details: error.details, diagnostic: error.diagnostic, message: error instanceof RunError ? error.message : 'Run stopped; inspect the local trace for the failing stage.' }
  }
  const terminal = { ...result, runId, mode: input.mode ?? 'J0', sourceSha, tabId: result.tabId ?? tabId ?? null, steps: result.steps ?? steps, requests, inputTokens, unknownUsageRequests: requests - knownUsageResponses, startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - start, timingMs, tracePath: tracePath ?? null, verification: 'not_independently_verified', takeoverAllowed: !uncertainInFlight, handoff: result.status !== 'done' && !uncertainInFlight }
  record({ event: 'terminal', ...terminal })
  // Full snapshots/questions stay in the local trace. Native MCP gets bounded
  // decision/action evidence plus a path the independent reviewer can inspect.
  return { ...terminal, traceWriteError: !!traceWriteError, events: events.filter(e => ['tab', 'prepared', 'decision', 'api_error', 'terminal'].includes(e.event) || (e.event === 'tool_finished' && !['view', 'snapshot', 'inspect'].includes(e.tool))).map(e => e.event === 'tool_finished' ? { ...e, result: undefined } : e) }
}

export function registerJev(server, { host, gate }) {
  server.registerTool('jev_run', {
    title: 'Run a bounded Jev browser experiment',
    description: 'Run the Jev decision policy (default J0; J1 compact candidate references) in a new isolated fixture tab, using the same extension bridge as browser_* tools. Only localhost:17430. Synchronous; timeout may drain an in-flight command before returning. done is not independent verification. Inspect the resulting tab/oracle separately; host continuation is not Jev success.',
    inputSchema: {
      goal: z.string().min(1), startUrl: z.string().url(), values: z.record(z.string()).optional(), expectedText: z.string().min(1).optional(),
      maxSteps: z.number().int().min(1).max(12).default(12), timeoutMs: z.number().int().min(1000).max(120000).default(120000),
      maxInputTokens: z.number().int().min(1000).max(100000).default(100000),
      minProbability: z.number().positive().max(1).default(0.6), doneProbability: z.number().positive().max(1).default(0.9),
      mode: z.enum(['J0', 'J1']).default('J0'), phase: z.enum(['J0', 'J1']).default('J0'), scenario: z.enum(['A', 'B']), seed: z.string().min(1)
    }
  }, async (input, extra) => {
    try {
      const result = await gate.exclusive(() => executeRun(input, { host, signal: extra.signal, onUncertain: () => gate.poison() }))
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.status === 'error' }
    } catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'error', code: error.code ?? error.name, message: error.message }) }] } }
  })
}
