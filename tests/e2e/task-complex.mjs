// browser_task on the complex React form with inputs only (no declared
// targets). Default: mechanical plumbing replay — the real loop and extension
// with a fixture-scripted fake Jev, no paid calls. --live: real Jev through
// the MCP browser_task tool and the product ledger. Fixture knowledge lives
// only in this test; the oracle is read independently after the run.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { launchIsolated, runBrowserTask } from '../../scripts/jev/task-browser.mjs'
import { runTask } from '../../packages/bridge/dist/agent/loop.mjs'
import { prepareTask } from '../../packages/bridge/dist/agent/task.mjs'

const live = process.argv.includes('--live'), seed = process.argv.find(a => a.startsWith('--seed='))?.slice(7) ?? 'atlas', variant = process.argv.find(a => a.startsWith('--variant='))?.slice(10) ?? 'standard'
const origin = 'http://127.0.0.1:17431', out = process.env.TASK_OUT ?? '/tmp/jev-product/runs'
const fixture = await (await fetch(origin + '/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed, variant }) })).json()
const d = fixture.taskData, inputs = {}, labels = {}
const add = (id, purpose, value, label, context) => { inputs[id] = { value: String(value), purpose }; labels[id] = [label, context] }
add('name', 'applicant full name', d.personal.name, 'Full name'); add('email', 'contact email address', d.personal.email, 'Email'); add('phone', 'phone number', d.personal.phone, 'Phone')
add('country', 'country of residence', d.personal.country, 'Country'); add('city', 'city of residence', d.personal.city, 'City'); add('address', 'street address', d.personal.address, 'Street address'); add('postal', 'postal code', d.personal.postal, 'Postal code')
add('mode', 'preferred work arrangement', d.preferences.mode, d.preferences.mode, 'Work arrangement'); add('salary', 'expected annual salary', d.preferences.salary, 'Expected annual salary'); add('start', 'earliest start date', d.preferences.startDate, 'Available start date')
add('sponsorship', 'requires visa sponsorship', d.preferences.sponsorship, 'Require sponsorship'); add('visa', 'visa category', d.preferences.visa, 'Visa category')
d.experience.forEach((r, i) => [['company', 'employer', 'Company'], ['title', 'job title', 'Job title'], ['start', 'start date', 'Start date'], ['end', 'end date', 'End date'], ['summary', 'responsibilities', 'Responsibilities']].forEach(([k, p, l]) => add(`job${i + 1}.${k}`, `work experience ${i + 1}: ${p}`, r[k], l, `Work experience ${i + 1}`)))
;[['school', 'school', 'School'], ['degree', 'degree', 'Degree'], ['subject', 'subject studied', 'Subject'], ['year', 'graduation year', 'Graduation year']].forEach(([k, p, l]) => add(`edu.${k}`, `education 1: ${p}`, d.education[0][k], l, 'Education 1'))
d.skills.forEach((r, i) => { add(`skill${i + 1}.name`, `skill ${i + 1} name`, r.name, `Skill ${i + 1}`); add(`skill${i + 1}.level`, `skill ${i + 1} proficiency`, r.level, `Proficiency ${i + 1}`) })
add('consent', 'consent to processing this application', 'true', 'I consent to processing this application')
const task = { goal: `Complete and submit this job application using the supplied details and the supplied résumé PDF. The requested target role is ${d.preferences.role}. Include all ${d.experience.length} work experiences and ${d.education.length} education record. Finish when an application receipt is shown.`,
  startUrl: origin + fixture.url, allowedOrigins: [origin], inputs, files: { resume: { fileId: 'resume', purpose: 'résumé PDF to attach' } }, irreversible: 'confirm', llm: 'handoff', budgets: { maxJevRequests: 40, maxSteps: 120, timeoutMs: 600000 } }
const files = { resume: { name: fixture.resume.name, mimeType: fixture.resume.type, data: (await readFile(fixture.resume.path)).toString('base64'), sha256: fixture.resume.sha256 } }
// Scripted caller: approves confirmations (the task asks to submit), declines
// open-ended questions so any such handoff is visible as a failure.
const answer = async h => h.kind === 'confirm' ? { approve: true } : {}
const browser = await launchIsolated({ files })
let run
try {
  if (live) run = await runBrowserTask(browser.tool, task, answer)
  else {
    // Fake Jev: binds by test-only label map; navigation by fixture names.
    const ask = async ({ state, questions }) => {
      const el = id => state.elements.find(e => e.id === id)
      const answers = {}, pick = (q, id) => ({ type: 'choice', choice: id, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === id ? 1 : 0])) })
      for (const [key, q] of Object.entries(questions)) {
        if (!key.startsWith('bind_')) continue
        const valueId = Object.keys(inputs).concat('resume').find(id => q.instructions.includes(JSON.stringify(id === 'resume' ? 'résumé PDF to attach' : inputs[id].purpose)))
        const [label, context] = labels[valueId] ?? ['Résumé PDF']
        answers[key] = pick(q, Object.keys(q.criteria).find(ref => ref !== 'not_now' && el(ref)?.name === label && (!context || el(ref).context?.includes(context))) ?? 'not_now')
      }
      const named = n => state.elements.find(e => e.name === n)
      const pending = Object.values(state.inputs).some(i => i.status === 'pending' && i.fieldsOnThisPage)
      const loading = state.elements.some(e => e.disabled && ['City', 'Visa category'].includes(e.name))
      const option = state.elements.find(e => e.role === 'option' && e.name === d.preferences.role && !e.selected)
      const trigger = state.elements.find(e => e.name.startsWith('Target role') && !e.name.endsWith(d.preferences.role))
      const rows = state.elements.filter(e => e.name === 'Company').length
      const target = option ?? trigger ?? (rows && rows < d.experience.length ? named('Add work experience') : null) ?? ['Confirm and submit', 'Submit application', 'Continue'].map(named).find(Boolean)
      const op = state.page.text.includes('Application received') ? 'DONE' : loading || pending ? 'WAIT' : target ? 'CLICK' : 'WAIT'
      answers.operation = pick(questions.operation, op)
      for (const [key, q] of Object.entries(questions)) if (key.startsWith('field_')) answers[key] = pick(q, 'keep')
      if (questions.text_value) answers.text_value = pick(questions.text_value, 'caller')
      for (const [key, q] of Object.entries(questions)) if (key.startsWith('target_')) answers[key] = pick(q, key === 'target_CLICK' && target ? target.id : Object.keys(q.criteria)[0])
      return { answers, usage: { input_tokens: 0 } }
    }
    const handoffs = []
    const events = []
    const result = await runTask(prepareTask(task), { emit: e => events.push(e), call: (name, args) => browser.call(name, args), ask, handoff: async h => { handoffs.push(h.kind); return answer(h) }, files: id => ({ name: files[id].name, mimeType: files[id].mimeType, data: files[id].data }) })
    run = { result, handoffs }
    await mkdir(out, { recursive: true }); await writeFile(`${out}/mechanical-events.jsonl`, events.map(e => JSON.stringify(e)).join('\n'))
  }
  let oracle
  for (let i = 0; i < 20; i++) { oracle = await (await fetch(`${origin}/api/oracle/${fixture.runId}`)).json(); if (oracle.submitted) break; await new Promise(r => setTimeout(r, 100)) }
  // Bind correctness from the trace (test-side label map): calibration input.
  const events = live ? (await readFile(run.result.tracePath, 'utf8')).trim().split('\n').map(l => JSON.parse(l)) : JSON.parse('[' + (await readFile(`${out}/mechanical-events.jsonl`, 'utf8')).trim().split('\n').join(',') + ']')
  const pOf = {}
  for (const e of events.filter(e => e.event === 'decision')) for (const a of e.accepted) pOf[a.valueId] = a.p
  const binds = events.filter(e => e.event === 'execute' && e.valueId).map(e => { const [label, context] = labels[e.valueId] ?? ['Résumé PDF']; return { valueId: e.valueId, p: pOf[e.valueId], correct: e.name === label && (!context || (e.context ?? []).includes(context)) } })
  const summary = { live, seed, variant, binds: { total: binds.length, correct: binds.filter(b => b.correct).length, wrong: binds.filter(b => !b.correct) }, status: run.result.status, reason: run.result.reason ?? run.result.code, correct: `${oracle.correctFields}/${oracle.totalFields}`, upload: oracle.upload?.correct, passed: oracle.passed, metrics: run.result.metrics, handoffs: run.handoffs, tracePath: run.result.tracePath }
  await mkdir(out, { recursive: true }); await writeFile(`${out}/complex-${seed}-${variant}-${Date.now()}.json`, JSON.stringify({ summary, oracle }, null, 2))
  console.log(JSON.stringify(summary))
  if (!live) assert.equal(oracle.passed, true, JSON.stringify(summary))
} finally { await browser.close() }
