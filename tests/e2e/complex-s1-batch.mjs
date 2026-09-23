// Mechanical form_batch plumbing replay; never a model benchmark or evidence of
// Jev decision quality. The real runS1 batch loop drives the real stdio MCP ->
// WebSocket -> extension -> DOM chain. A deterministic fake answerer reads each
// compiled payload at runtime (never refs recorded in advance): it accepts every
// offered binding and picks navigation by fixture-specific names. That script
// lives only in this test; the core has no fixture knowledge. No paid API.
import assert from 'node:assert/strict'
import { mkdtemp, cp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { connectBrowser } from '../../scripts/jev/mcp.mjs'
import { runS1, validateS1Task } from '../../packages/bridge/src/jev/s1.mjs'
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? '/tmp/jev-browser-validation/node_modules/playwright/index.mjs').href)
const temp = await mkdtemp(join(tmpdir(), 'complex-s1-batch-mechanical-')), root = fileURLToPath(new URL('../../', import.meta.url))
const origin = 'http://127.0.0.1:17431', events = []
let context, browser
try {
  const fixture = await (await fetch(origin + '/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: 'atlas', variant: 'standard' }) })).json()
  const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening')
  process.env.BROWSER_USE_PORT = String(reservation.address().port); await new Promise(r => reservation.close(r))
  process.env.JEV_ENABLE_S1 = '1'; process.env.JEV_ENABLE_COMPLEX_FORMS = '1'
  process.env.JEV_S1_FILES_MANIFEST = join(temp, 'files.json')
  await writeFile(process.env.JEV_S1_FILES_MANIFEST, JSON.stringify({ resume: { name: fixture.resume.name, mimeType: fixture.resume.type, data: (await readFile(fixture.resume.path)).toString('base64'), sha256: fixture.resume.sha256 } }))
  const extension = join(temp, 'extension'); await cp(join(root, 'packages/extension/dist'), extension, { recursive: true })
  for (const name of await readdir(join(extension, 'assets'))) if (name.endsWith('.js')) {
    const path = join(extension, 'assets', name); await writeFile(path, (await readFile(path, 'utf8')).replace(/\b17329\b/g, process.env.BROWSER_USE_PORT))
  }
  browser = await connectBrowser()
  context = await chromium.launchPersistentContext(join(temp, 'profile'), { channel: 'chromium', executablePath: process.env.CHROMIUM_EXECUTABLE ?? '/home/shun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  await (context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker'))
  const data = fixture.taskData, values = {}
  const field = (id, name, text, role = 'textbox', context) => { values[id] = { text: String(text), purpose: id, target: { name, role, ...(context ? { context } : {}) } } }
  for (const [key, name, role] of [['name', 'Full name'], ['email', 'Email'], ['phone', 'Phone'], ['country', 'Country', 'combobox'], ['city', 'City', 'combobox'], ['address', 'Street address'], ['postal', 'Postal code']]) field('personal.' + key, name, data.personal[key], role)
  field('preferences.mode', data.preferences.mode, true, 'radio', 'Work arrangement')
  for (const [key, name, role] of [['salary', 'Expected annual salary'], ['startDate', 'Available start date'], ['sponsorship', 'Require sponsorship', 'combobox'], ['visa', 'Visa category', 'combobox']]) field('preferences.' + key, name, data.preferences[key], role)
  for (const [i, row] of data.experience.entries()) for (const [key, name] of [['company', 'Company'], ['title', 'Job title'], ['start', 'Start date'], ['end', 'End date'], ['summary', 'Responsibilities']]) field(`experience.${i}.${key}`, name, row[key], 'textbox', `Work experience ${i + 1}`)
  for (const [key, name, role] of [['school', 'School'], ['degree', 'Degree', 'combobox'], ['subject', 'Subject'], ['year', 'Graduation year']]) field('education.0.' + key, name, data.education[0][key], role, 'Education 1')
  for (const [i, row] of data.skills.entries()) { field(`skills.${i}.name`, `Skill ${i + 1}`, row.name); field(`skills.${i}.level`, `Proficiency ${i + 1}`, row.level, 'combobox') }
  field('consent', 'I consent to processing this application', true, 'checkbox')
  const task = validateS1Task({ profile: 'complex_forms', decision: 'form_batch', goal: 'Mechanical only: complete synthetic application', startUrl: origin + fixture.url, allowedOrigins: [origin], values,
    files: { attachment: { fileId: 'resume', purpose: 'Synthetic PDF', target: { name: 'Résumé PDF', role: 'file' } } },
    assertions: [{ id: 'receipt', scope: { frame: 'top', root: { kind: 'selector', css: 'main' } }, subject: { kind: 'role_name', role: 'heading', name: 'Application received', exact: true }, read: 'text', predicate: 'equals', expected: 'Application received', freshness: 'after_last_returned_operation' }],
    maxSteps: 100, maxRequests: 60, timeoutMs: 600000, maxInputTokens: 2000000 })
  // Fixture-scripted navigation over the names visible in the compiled payload.
  const navigate = state => {
    const objects = state.observation.objects, named = name => objects.find(o => o.name === name)
    const waiting = Object.values(values).some(v => objects.some(o => o.name === v.target.name && o.role === v.target.role && o.facts.disabled && o.facts.value !== v.text))
    if (waiting) return 'wait'
    const option = objects.find(o => o.role === 'option' && o.name === data.preferences.role && o.facts.selected !== true)
    if (option) return option.name
    const trigger = objects.find(o => o.facts.hasPopup === 'listbox' && o.name.startsWith('Target role') && !o.name.endsWith(data.preferences.role))
    if (trigger) return trigger.name
    if (objects.some(o => o.name === 'Company') && objects.filter(o => o.name === 'Company').length < data.experience.length && named('Add work experience')) return 'Add work experience'
    return ['Confirm and submit', 'Submit application', 'Continue'].find(named) ?? 'none'
  }
  let requests = 0
  const ask = async ({ state, questions }) => {
    requests++
    const want = navigate(state)
    const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => {
      if (q.type === 'noul') return [id, { type: 'noul', noul: 0 }]
      const keys = Object.keys(q.criteria)
      const pick = id === 'next' ? keys.find(k => q.criteria[k].target?.name === want && q.criteria[k].operation === 'activate') ?? keys.find(k => q.criteria[k].operation === want) ?? 'none' : keys[0]
      return [id, { type: 'choice', choice: pick, probabilities: Object.fromEntries(keys.map(k => [k, k === pick ? 1 : 0])) }]
    }))
    return { answers, usage: { input_tokens: 0 } }
  }
  const start = performance.now()
  const result = await runS1(task, { call: (name, args, signal) => browser.call(name, args, signal), ask, emit: e => events.push(e) })
  let oracle
  for (let attempt = 0; attempt < 20; attempt++) {
    oracle = await (await fetch(origin + '/api/oracle/' + fixture.runId)).json()
    if (oracle.submitted) break
    await new Promise(r => setTimeout(r, 100))
  }
  const decisions = events.filter(e => e.event === 'batch_decision')
  const summary = { liveJev: false, mechanical: true, decision: 'form_batch', seed: 'atlas', variant: 'standard', status: result.status, code: result.code, totalMs: performance.now() - start, requests, steps: result.steps, timings: result.timings,
    bindingsAccepted: decisions.reduce((n, d) => n + d.accepted.length, 0), bindQuestions: decisions.reduce((n, d) => n + d.questions.bind, 0), maxPayloadBytes: Math.max(...decisions.map(d => d.payloadBytes)),
    batchStops: events.filter(e => e.event === 'batch_stopped').map(e => e.reason), correctFields: `${oracle.correctFields}/${oracle.totalFields}`, uploadCorrect: oracle.upload?.correct, oraclePassed: oracle.passed }
  await writeFile(join(temp, 'result.json'), JSON.stringify({ summary, oracle }, null, 2))
  assert.equal(result.status, 'verified', JSON.stringify(summary)); assert.equal(oracle.passed, true, JSON.stringify(oracle))
  // Radio/checkbox view lines carry checked state, never the "on" submission token.
  const contents = events.filter(e => e.event === 'observation').map(e => e.observation.content)
  assert.ok(contents.some(c => /radio: "Hybrid" \[e\d+\] \(unchecked\)/.test(c)) && contents.some(c => /radio: "Hybrid" \[e\d+\] \(checked\)/.test(c)))
  assert.ok(!contents.some(c => /(radio|checkbox)[^\n]*= "on"/.test(c)))
  console.log(JSON.stringify(summary))
} finally {
  await writeFile(join(temp, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'))
  await browser?.close(); await context?.close()
  await rm(join(temp, 'profile'), { recursive: true, force: true }); await rm(join(temp, 'extension'), { recursive: true, force: true })
  console.log(JSON.stringify({ evidenceDirectory: temp }))
}
