import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateS1Task, adaptObservation, enumerate, compile, bindIntent, executionRequest, verify, runS1 } from '../packages/bridge/src/jev/s1.mjs'
import { reserveRequest, requireBudget } from '../packages/bridge/src/jev/budget.mjs'
const origin = 'http://127.0.0.1:17430'
const task = () => validateS1Task({ goal: 'Set City to Hangzhou', startUrl: origin, allowedOrigins: [origin], values: { city: { text: 'Hangzhou', purpose: 'City', target: { role: 'textbox', name: 'City' } }, alias: { text: 'River', purpose: 'Display name', target: { role: 'textbox', name: 'Display name' } } } })
const object = (ref = 'e1', name = 'City') => ({ ref, facts: { name, role: 'textbox', tag: 'input', visible: true, disabled: false, readonly: false, modalBlocked: false, inert: false, nativeText: true, nativeActivate: false, value: 'London', shadowContext: false, nameTruncated: false } })
const raw = (objects = [object()]) => ({ documentId: 'd1', url: origin, capturedAt: new Date().toISOString(), view: { documentId: 'd1', content: '', truncated: false }, snapshot: { documentId: 'd1', coverage: { matched: objects.length, returned: objects.length, truncated: false } }, objects, assertions: [], scroll: { x: 0, y: 0 } })
const answer = (questions, picks = {}) => ({ usage: { input_tokens: 1 }, answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, q.type === 'noul' ? { type: 'noul', noul: 0 } : { type: 'choice', choice: picks[id] ?? Object.keys(q.criteria)[0], probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === (picks[id] ?? Object.keys(q.criteria)[0]) ? 1 : 0])) }])) })

test('S1 tasks reject executable/flow fields, invalid predicates and missing value purpose', () => {
  assert.throws(() => validateS1Task({ ...task(), steps: ['click'] }), { code: 'TASK' })
  assert.throws(() => validateS1Task({ ...task(), verifier: () => true }), { code: 'TASK' })
  assert.throws(() => validateS1Task({ ...task(), values: { city: 'Hangzhou' } }), { code: 'TASK' })
})
test('two-stage parameter domain is bound to target and observation', () => {
  const t = task(), o = adaptObservation(raw([object(), object('e2', 'Display name')]), 1), set = enumerate(o, t)
  const c = set.candidates.find(c => c.operationId === 'replace_text' && c.targetId === 'e1')
  assert.deepEqual(Object.keys(c.domain), ['city'])
  const q = compile(o, t, set, c).questions.value
  assert.deepEqual(Object.keys(q.criteria), ['city', 'none'])
  assert.throws(() => bindIntent(o, set, c, 'alias'), { code: 'BAD_VALUE_DOMAIN' })
  const intent = bindIntent(o, set, c, 'city')
  assert.equal(executionRequest(intent, o, t).text, 'Hangzhou')
  assert.throws(() => executionRequest(intent, { ...o, id: 'new' }, t), { code: 'STALE_INTENT' })
  assert.throws(() => executionRequest({ ...intent, targetId: 'e2' }, o, t), { code: 'BAD_VALUE_DOMAIN' })
})
test('coverage never silently truncates; legacy identity and 255+ handles fail closed', () => {
  const r = raw(); delete r.documentId
  assert.throws(() => adaptObservation(r, 1), { code: 'OBSERVATION' })
  const cut = raw(); cut.snapshot.coverage.truncated = true
  assert.throws(() => enumerate(adaptObservation(cut, 1), task()), { code: 'RESOURCE_LIMIT' })
  const dense = raw(Array.from({ length: 260 }, (_, i) => object(`e${i}`, `Field ${i}`)))
  assert.throws(() => enumerate(adaptObservation(dense, 1), task()), { code: 'RESOURCE_LIMIT' })
})
test('readonly, modal background, inert and nonnative text never get replace capability', () => {
  for (const facts of [{ readonly: true }, { modalBlocked: true }, { inert: true }, { nativeText: false }]) {
    const item = object(); Object.assign(item.facts, facts)
    assert.ok(!enumerate(adaptObservation(raw([item]), 1), task()).candidates.some(c => c.operationId === 'replace_text'))
  }
})
test('verifier requires scoped evidence, complete absence and automatic returned-operation freshness', () => {
  const a = { id: 'a', read: 'exists', predicate: 'absent', freshness: 'after_last_returned_operation' }
  const o = adaptObservation(raw(), 1)
  assert.equal(verify([a], o, 'op1').status, 'unknown')
  o.evidence = [{ id: 'evidence1', assertionId: 'a', documentId: 'd1', value: false, complete: true }]
  assert.equal(verify([a], o).status, 'unknown')
  assert.equal(verify([a], o, 'op1').status, 'verified')
  o.evidence[0].complete = false
  assert.equal(verify([a], o, 'op1').status, 'unknown')
  assert.equal(verify([], o, 'op1').status, 'unknown')
})
test('truncated text permits positive contains but never equals or negative absence', () => {
  const o = adaptObservation(raw(), 1); o.evidence = [{ id: 'e', assertionId: 'a', documentId: 'd1', value: 'visible prefix', complete: false }]
  assert.equal(verify([{ id: 'a', read: 'text', predicate: 'contains', expected: 'prefix', freshness: 'current' }], o).status, 'verified')
  assert.equal(verify([{ id: 'a', read: 'text', predicate: 'equals', expected: 'visible prefix', freshness: 'current' }], o).status, 'unknown')
})
async function simulate({ failure, maxRequests = 4 }) {
  let executions = 0, asks = 0
  const t = { ...task(), maxRequests }
  const result = await runS1(t, { call: async (name, args) => {
    if (name === 'tabs') return { tabId: 1 }
    if (name === 'navigate') return {}
    if (args.action === 'observe') return raw()
    executions++; if (failure === 'TIMEOUT') throw Object.assign(Error(), { code: 'TIMEOUT' })
    return { execution: 'not_sent', code: 'PAGE_CHANGED' }
  }, ask: async ({ questions }) => { asks++; return answer(questions) } })
  return { result, executions, asks }
}
test('timeout after dispatch is unknown and is never replayed', async () => {
  const s = await simulate({ failure: 'TIMEOUT' }); assert.equal(s.result.code, 'TIMEOUT'); assert.equal(s.executions, 1); assert.equal(s.asks, 2)
})
test('parameter request consumes separate budget; exhaustion prevents dispatch', async () => {
  const s = await simulate({ maxRequests: 1 }); assert.equal(s.result.code, 'RESOURCE_LIMIT'); assert.equal(s.executions, 0); assert.equal(s.asks, 1)
})
test('not_sent document changes recover only within request budget', async () => {
  const s = await simulate({ maxRequests: 4 }); assert.equal(s.result.code, 'RESOURCE_LIMIT'); assert.equal(s.executions, 2); assert.equal(s.asks, 4)
})
test('independent 30 attempt ledger is enforced centrally and incompatible with old limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 's1-budget-')), path = join(dir, 'ledger.json')
  try {
    requireBudget(path, 30, 30)
    for (let i = 0; i < 30; i++) reserveRequest(path, { phase: 'S1' }, 30)
    assert.throws(() => reserveRequest(path, {}, 30), { code: 'BUDGET_LIMIT' })
    assert.throws(() => requireBudget(path, 1, 30), { code: 'BUDGET_LIMIT' })
    assert.throws(() => reserveRequest(path, {}), { code: 'BUDGET_INVALID' })
    assert.equal(JSON.parse(readFileSync(path)).requests.length, 30)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('same-name same-context objects are unknown, not arbitrary targets', () => {
  const o = adaptObservation(raw([object('e1'), object('e2')]), 1)
  assert.ok(o.objects.every(o => o.ambiguous))
  assert.ok(enumerate(o, task()).candidates.every(c => !c.targetId))
})
test('missing disabled/modal facts never become positive capabilities', () => {
  const item = object(); delete item.facts.disabled
  assert.ok(enumerate(adaptObservation(raw([item]), 1), task()).candidates.every(c => !c.targetId))
})

test('S1 service counts failed usage only for centrally reserved sends', async () => {
  const { executeS1Run } = await import('../packages/bridge/dist/jev/s1-service.mjs')
  const dir = mkdtempSync(join(tmpdir(), 's1-service-'))
  const host = { invoke: async (name, params) => name === 'tabs' ? { tabId: 1 } : name === 's1' && params.action === 'observe' ? raw() : {} }
  try {
    for (const usage of [{ input_tokens: 123 }, undefined]) {
      const path = join(dir, `budget-${usage ? 'known' : 'unknown'}.json`)
      const result = await executeS1Run(task(), { host, ledgerPath: path, traceDirectory: dir, ask: async () => { throw Object.assign(Error(), { code: 'BAD_ANSWER', usage }) } })
      assert.equal(result.requests, 1); assert.equal(result.inputTokens, usage ? 123 : 0); assert.equal(result.unknownUsageRequests, usage ? 0 : 1)
    }
    const priorKey = process.env.TYPESAFE_API_KEY
    delete process.env.TYPESAFE_API_KEY
    try {
      const result = await executeS1Run(task(), { host, ledgerPath: join(dir, 'no-send.json'), traceDirectory: dir })
      assert.equal(result.code, 'NO_KEY'); assert.equal(result.requests, 0); assert.equal(result.unknownUsageRequests, 0)
    } finally { if (priorKey !== undefined) process.env.TYPESAFE_API_KEY = priorKey }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('ambiguous execution transport loss poisons the service gate without replay', async () => {
  const { executeS1Run } = await import('../packages/bridge/dist/jev/s1-service.mjs')
  const { createGate } = await import('../packages/bridge/dist/jev/service.mjs')
  const dir = mkdtempSync(join(tmpdir(), 's1-uncertain-')), gate = createGate()
  let executions = 0
  const host = { invoke: async (name, params) => {
    if (name === 'tabs') return { tabId: 1 }
    if (name !== 's1') return {}
    if (params.action === 'observe') return raw()
    executions++; throw Object.assign(Error(), { code: 'SEND_MESSAGE_FAILED' })
  } }
  try {
    const result = await gate.exclusive(() => executeS1Run(task(), { host, ledgerPath: join(dir, 'budget.json'), traceDirectory: dir, ask: async p => answer(p.questions), onUncertain: () => gate.poison() }))
    assert.equal(result.takeoverAllowed, false); assert.equal(executions, 1)
    await assert.rejects(() => gate.exclusive(async () => {}), { code: 'BUSY' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('actual MCP registration rejects unknown task flow fields before any host call', async () => {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const { registerS1 } = await import('../packages/bridge/dist/jev/s1-service.mjs')
  const { createGate } = await import('../packages/bridge/dist/jev/service.mjs')
  const server = new McpServer({ name: 's1-schema-test', version: '1' }), client = new Client({ name: 's1-schema-test', version: '1' })
  const old = process.env.JEV_ENABLE_S1; process.env.JEV_ENABLE_S1 = '1'
  let calls = 0
  registerS1(server, { host: { invoke: async () => { calls++; throw Error('Must not execute') } }, gate: createGate() })
  if (old === undefined) delete process.env.JEV_ENABLE_S1; else process.env.JEV_ENABLE_S1 = old
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(a), client.connect(b)])
    for (const bad of [{ ...task(), steps: ['click'] }, { ...task(), verifier: 'return true' }, { ...task(), assertions: [{ id: 'a', scope: { frame: 'top', root: { kind: 'selector', css: 'main' } }, subject: 'scope', read: 'exists', predicate: 'equals', expected: 'true', freshness: 'current' }] }]) {
      const result = await client.callTool({ name: 'jev_run_s1', arguments: bad })
      assert.equal(result.isError, true)
    }
    assert.equal(calls, 0)
  } finally { await client.close(); await server.close() }
})

test('complex limits are explicit; default S1 retains old limits', () => {
  assert.throws(() => validateS1Task({ ...task(), maxSteps: 13 }), { code: 'TASK' })
  const t = validateS1Task({ ...task(), profile: 'complex_forms', maxSteps: 160, maxRequests: 240, timeoutMs: 1800000, maxInputTokens: 2000000 })
  assert.equal(t.maxRequests, 240)
  assert.throws(() => validateS1Task({ ...t, maxRequests: 241 }), { code: 'TASK' })
})
test('repeated fields require a unique explicit container binding, including shared ancestors', () => {
  const a = object(), b = object('e2'); a.facts.context = ['History', 'Job 1']; b.facts.context = ['History', 'Job 2']
  const o = adaptObservation(raw([a, b]), 1)
  assert.ok(o.objects.every(o => !o.ambiguous))
  assert.ok(!enumerate(o, task()).candidates.some(c => c.operationId === 'replace_text'))
  for (const context of ['History', 'Missing']) {
    const t = task(); t.values.city.target.context = context
    assert.ok(!enumerate(o, t).candidates.some(c => c.operationId === 'replace_text'))
  }
  const t = task(); t.values.city.target.context = 'Job 2'
  const set = enumerate(o, t), c = set.candidates.find(c => c.operationId === 'replace_text')
  assert.equal(c.targetId, 'e2')
  assert.throws(() => executionRequest({ ...bindIntent(o, set, c, 'city'), targetId: 'e1' }, o, t), { code: 'BAD_VALUE_DOMAIN' })
})
test('registry binds enabled select options, checkbox boolean values and file IDs', () => {
  const item = object(); Object.assign(item.facts, { nativeText: false, nativeSelect: true, options: [{ value: 'Hangzhou', disabled: false }] })
  let o = adaptObservation(raw([item]), 1), set = enumerate(o, task())
  assert.equal(set.candidates.find(c => c.operationId === 'select_option').domain.city.text, 'Hangzhou')
  item.facts.options[0].disabled = true
  assert.ok(!enumerate(adaptObservation(raw([item]), 1), task()).candidates.some(c => c.operationId === 'select_option'))
  Object.assign(item.facts, { nativeSelect: false, nativeCheck: true, checked: false, inputType: 'checkbox' })
  const t = task(); t.values.city.text = 'true'; o = adaptObservation(raw([item]), 1); set = enumerate(o, t)
  const c = set.candidates.find(c => c.operationId === 'set_checked')
  assert.equal(executionRequest(bindIntent(o, set, c, 'city'), o, t).checked, true)
  Object.assign(item.facts, { nativeCheck: false, nativeFile: true })
  t.files = { resume: { fileId: 'authorized', purpose: 'Attachment', target: { name: 'City', role: 'textbox' } } }
  o = adaptObservation(raw([item]), 1); set = enumerate(o, t)
  const f = set.candidates.find(c => c.operationId === 'upload_file')
  assert.equal(executionRequest(bindIntent(o, set, f, 'resume'), o, t).fileId, 'authorized')
})
test('satisfied values and unreachable actions are excluded, scroll remains available', () => {
  const item = object(); item.facts.value = 'Hangzhou'
  assert.ok(!enumerate(adaptObservation(raw([item]), 1), task()).candidates.some(c => c.operationId === 'replace_text'))
  item.facts.value = 'London'; item.facts.centerReachable = false
  const set = enumerate(adaptObservation(raw([item]), 1), task())
  assert.ok(!set.candidates.some(c => c.operationId === 'replace_text'))
  assert.ok(set.candidates.some(c => c.operationId === 'scroll_into_view'))
})
test('parameter payload contains only selected target domain; action payload references compact targets', () => {
  const o = adaptObservation(raw(), 1), t = task(), set = enumerate(o, t)
  const c = set.candidates.find(c => c.operationId === 'replace_text')
  const payload = compile(o, t, set, c)
  assert.ok(!JSON.stringify(payload).includes('Display name'))
  assert.ok(!payload.state.observation)
  assert.deepEqual(compile(o, t, set).questions.operation.criteria[c.id].target, { id: 'e1', name: 'City' })
})
test('complex 240 budget is durable and incompatible with 30/100 ledgers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'complex-budget-')), path = join(dir, 'budget.json')
  try {
    for (let i = 0; i < 240; i++) reserveRequest(path, {}, 240)
    assert.throws(() => reserveRequest(path, {}, 240), { code: 'BUDGET_LIMIT' })
    assert.throws(() => requireBudget(path, 1, 30), { code: 'BUDGET_INVALID' })
    assert.throws(() => requireBudget(path, 1, 100), { code: 'BUDGET_INVALID' })
    assert.equal(JSON.parse(readFileSync(path)).requests.length, 240)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('host file authorization rejects unknown IDs, malformed bytes and mismatched hash', async () => {
  const { authorizeFile } = await import('../packages/bridge/dist/jev/s1-service.mjs')
  const { createHash } = await import('node:crypto')
  const data = Buffer.from('synthetic PDF')
  const file = { name: 'resume.pdf', mimeType: 'application/pdf', data: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex') }
  assert.equal(authorizeFile('resume', { resume: file }).data, file.data)
  assert.throws(() => authorizeFile('unknown', { resume: file }), { code: 'FILE_UNAUTHORIZED' })
  assert.throws(() => authorizeFile('resume', { resume: { ...file, sha256: '0'.repeat(64) } }), { code: 'FILE_UNAUTHORIZED' })
  assert.throws(() => authorizeFile('resume', { resume: { ...file, data: file.data + '\n' } }), { code: 'FILE_UNAUTHORIZED' })
})
test('complex singleton binding follows model-selected target and records model/browser timing', async () => {
  let asks = 0, executed
  const result = await runS1({ ...task(), profile: 'complex_forms', maxSteps: 1 }, {
    call: async (name, args) => {
      await new Promise(r => setTimeout(r, 2))
      if (name === 'tabs') return { tabId: 1 }
      if (name === 'navigate') return {}
      if (args.action === 'observe') return raw([object(), object('e2', 'Display name')])
      executed = args; return { execution: 'returned' }
    },
    ask: async ({ questions }) => {
      asks++; await new Promise(r => setTimeout(r, 2))
      const id = Object.entries(questions.operation.criteria).find(([, c]) => c.operation === 'replace_text' && c.target.id === 'e2')[0]
      return answer(questions, { operation: id })
    }
  })
  assert.equal(asks, 1); assert.equal(executed.ref, 'e2'); assert.equal(executed.text, 'River')
  assert.ok(result.timings.modelMs > 0 && result.timings.observationMs > 0 && result.timings.executionMs > 0)
  assert.ok(result.timings.totalMs >= result.timings.modelMs + result.timings.browserMs)
})
test('complex ambiguous domain and legacy singleton still ask parameter question; missing domain is absent', async () => {
  for (const [profile, multiple] of [['complex_forms', true], ['s1', false]]) {
    let asks = 0, executed
    const events = [], t = { ...task(), profile, maxSteps: 1 }
    if (multiple) t.values.city2 = { ...t.values.city, text: 'Paris' }
    const result = await runS1(t, {
      emit: e => events.push(e),
      call: async (name, args) => {
        if (name === 'tabs') return { tabId: 1 }
        if (name === 'navigate') return {}
        if (args.action === 'observe') return raw()
        executed = args; return { execution: 'returned' }
      },
      ask: async ({ questions }) => { asks++; return answer(questions) }
    })
    assert.equal(asks, 2); assert.equal(executed.text, 'Hangzhou')
    assert.equal(events.find(e => e.event === 'parameter_binding').method, 'model')
    assert.equal(result.status, 'step_limit')
  }
  const t = task(); t.values = {}
  assert.ok(!enumerate(adaptObservation(raw(), 1), t).candidates.some(c => c.operationId === 'replace_text'))
})
test('service rejects unapproved uploads and complex opt-in before navigation or budget reservation', async () => {
  const { executeS1Run, assertS1Origin } = await import('../packages/bridge/dist/jev/s1-service.mjs')
  let calls = 0
  const options = { host: { invoke: async () => { calls++ } }, authorizedFiles: {} }
  await assert.rejects(() => executeS1Run({ ...task(), files: { f: { fileId: '/etc/passwd', purpose: 'invalid', target: { name: 'PDF', role: 'file' } } } }, options), { code: 'FILE_UNAUTHORIZED' })
  const old = process.env.JEV_ENABLE_COMPLEX_FORMS; delete process.env.JEV_ENABLE_COMPLEX_FORMS
  try { await assert.rejects(() => executeS1Run({ ...task(), profile: 'complex_forms' }, options), { code: 'EXPERIMENT_DISABLED' }) }
  finally { if (old !== undefined) process.env.JEV_ENABLE_COMPLEX_FORMS = old }
  assert.equal(calls, 0)
  assert.throws(() => assertS1Origin('http://127.0.0.1:17431'), { code: 'EXPERIMENT_ORIGIN' })
  assert.doesNotThrow(() => assertS1Origin('http://127.0.0.1:17431', true))
  assert.throws(() => assertS1Origin('https://example.com', true), { code: 'EXPERIMENT_ORIGIN' })
})
