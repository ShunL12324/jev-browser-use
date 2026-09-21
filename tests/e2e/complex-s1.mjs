// Fixture-specific deterministic mechanical replay; never a model benchmark.
// All writes use the S1 registry/adapter. No eval, direct DOM fill, or paid API.
import assert from 'node:assert/strict'
import { mkdtemp, cp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { connectBrowser } from '../../scripts/jev/mcp.mjs'
import { adaptObservation, enumerate, validateS1Task, executionRequest, bindIntent } from '../../packages/bridge/src/jev/s1.mjs'
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? '/tmp/jev-browser-validation/node_modules/playwright/index.mjs').href)
const temp = await mkdtemp(join(tmpdir(), 'complex-s1-mechanical-')), root = fileURLToPath(new URL('../../', import.meta.url))
const origin = 'http://127.0.0.1:17431', trace = []
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
  const data = fixture.taskData, values = {}, queue = []
  const field = (id, name, text, role = 'textbox', context) => {
    values[id] = { text: String(text), purpose: id, target: { name, role, ...(context ? { context } : {}) } }
    queue.push({ valueId: id, name, role, context })
  }
  const activate = name => queue.push({ operation: 'activate', name })
  for (const [key, name, role] of [['name', 'Full name'], ['email', 'Email'], ['phone', 'Phone'], ['country', 'Country', 'combobox'], ['city', 'City', 'combobox'], ['address', 'Street address'], ['postal', 'Postal code']]) field('personal.' + key, name, data.personal[key], role)
  activate('Continue'); activate('Target role Choose role…'); activate(data.preferences.role)
  field('mode', data.preferences.mode, true, 'radio', 'Work arrangement')
  for (const [key, name, role] of [['salary', 'Expected annual salary'], ['startDate', 'Available start date'], ['sponsorship', 'Require sponsorship', 'combobox'], ['visa', 'Visa category', 'combobox']]) field('preferences.' + key, name, data.preferences[key], role)
  activate('Continue')
  for (const [i, row] of data.experience.entries()) {
    if (i) activate('Add work experience')
    for (const [key, name] of [['company', 'Company'], ['title', 'Job title'], ['start', 'Start date'], ['end', 'End date'], ['summary', 'Responsibilities']]) field(`experience.${i}.${key}`, name, row[key], 'textbox', `Work experience ${i + 1}`)
  }
  for (const [key, name, role] of [['school', 'School'], ['degree', 'Degree', 'combobox'], ['subject', 'Subject'], ['year', 'Graduation year']]) field('education.' + key, name, data.education[0][key], role, 'Education 1')
  activate('Continue')
  for (const [i, row] of data.skills.entries()) { field(`skill.${i}`, `Skill ${i + 1}`, row.name); field(`level.${i}`, `Proficiency ${i + 1}`, row.level, 'combobox') }
  queue.push({ valueId: 'attachment', name: 'Résumé PDF', role: 'file' })
  field('consent', 'I consent to processing this application', true, 'checkbox')
  activate('Continue'); activate('Submit application'); activate('Confirm and submit')
  const task = validateS1Task({ profile: 'complex_forms', goal: 'Mechanical only: complete synthetic application', startUrl: origin + fixture.url, allowedOrigins: [origin], values, files: { attachment: { fileId: 'resume', purpose: 'Synthetic PDF', target: { name: 'Résumé PDF', role: 'file' } } } })
  const start = performance.now(), { tabId } = await browser.call('tabs', { action: 'new', url: 'about:blank' })
  await browser.call('navigate', { tabId, url: task.startUrl })
  const observe = async () => adaptObservation(await browser.call('s1', { tabId, action: 'observe', assertions: [] }), tabId)
  for (const item of queue) {
    let done = false
    for (let attempt = 0; attempt < 15 && !done; attempt++) {
      const o = await observe(), set = enumerate(o, task)
      const target = o.objects.find(o => o.name === item.name && (!item.role || o.role === item.role) && (!item.context || o.facts.context?.includes(item.context)))
      const chosen = set.candidates.find(c => item.valueId ? c.domain?.[item.valueId] : c.operationId === item.operation && c.targetId === target?.id)
      const scroll = !chosen && target && set.candidates.find(c => c.operationId === 'scroll_into_view' && c.targetId === target.id)
      if (chosen || scroll) {
        const c = chosen || scroll, request = executionRequest(bindIntent(o, set, c, chosen ? item.valueId : undefined), o, task)
        const result = await browser.call('s1', { tabId, ...request })
        trace.push({ item, request, result })
        assert.ok(result.execution === 'returned' || ['STALE_REF', 'PAGE_CHANGED'].includes(result.code), JSON.stringify(result))
        if (chosen && result.execution === 'returned') done = true
      }
      if (!done) await new Promise(r => setTimeout(r, 160))
    }
    assert.ok(done, JSON.stringify({ missing: item, objects: (await observe()).objects }))
  }
  let oracle
  for (let attempt = 0; attempt < 20; attempt++) {
    oracle = await (await fetch(origin + '/api/oracle/' + fixture.runId)).json()
    if (oracle.submitted) break
    await new Promise(r => setTimeout(r, 100))
  }
  const result = { liveJev: false, seed: 'atlas', variant: 'standard', totalMs: performance.now() - start, adapterOperations: trace.length, oracle }
  await writeFile(join(temp, 'result.json'), JSON.stringify(result, null, 2)); assert.equal(oracle.passed, true, JSON.stringify(oracle))
  console.log(JSON.stringify(result))
} finally {
  await writeFile(join(temp, 'trace.json'), JSON.stringify(trace, null, 2))
  await browser?.close(); await context?.close()
  await rm(join(temp, 'profile'), { recursive: true, force: true }); await rm(join(temp, 'extension'), { recursive: true, force: true })
  console.log(JSON.stringify({ evidenceDirectory: temp }))
}
