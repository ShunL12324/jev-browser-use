// Mechanical replay ONLY: no live provider or API credentials are used here.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, cp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { connectBrowser } from '../../scripts/jev/mcp.mjs'
import { createS1Fixtures } from '../../scripts/jev/s1-fixtures.mjs'
import { runS1, adaptObservation, enumerate, validateS1Task, executionRequest, bindIntent } from '../../packages/bridge/src/jev/s1.mjs'
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? '/tmp/jev-browser-validation/node_modules/playwright/index.mjs').href)
const temp = await mkdtemp(join(tmpdir(), 's1-mechanical-')), root = fileURLToPath(new URL('../../', import.meta.url))
let context, browser, fixtures
function replay({ state, questions }) {
  let choice
  if (questions.value) choice = Object.keys(questions.value.criteria).find(k => k !== 'none')
  else {
    const entries = Object.entries(questions.operation.criteria)
    const pick = (op, name) => entries.find(([, c]) => c.operation === op && c.target?.name === name)?.[0]
    const field = state.observation.objects.find(o => ['City', 'Display name'].includes(o.name) && o.facts.value !== (o.name === 'City' ? 'Hangzhou' : 'River') && !o.facts.modalBlocked)
    choice = field ? pick('replace_text', field.name) : pick('activate', 'Deployment guide') ?? pick('activate', 'Open project Polaris') ?? pick('activate', 'Confirm save') ?? pick('activate', 'Review changes')
    if (!choice) choice = entries.find(([, c]) => c.operation === 'wait')[0]
  }
  return { model: 'mechanical-replay', usage: { input_tokens: 0 }, answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, q.type === 'noul' ? { type: 'noul', noul: 0 } : { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }])) }
}
try {
  const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening')
  process.env.BROWSER_USE_PORT = String(reservation.address().port); await new Promise(r => reservation.close(r)); process.env.JEV_ENABLE_S1 = '1'
  const extension = join(temp, 'extension'); await cp(join(root, 'packages/extension/dist'), extension, { recursive: true })
  let replacements = 0
  for (const name of await readdir(join(extension, 'assets'))) if (name.endsWith('.js')) {
    const path = join(extension, 'assets', name), text = await readFile(path, 'utf8'); replacements += (text.match(/\b17329\b/g) ?? []).length
    await writeFile(path, text.replace(/\b17329\b/g, process.env.BROWSER_USE_PORT))
  }
  assert.equal(replacements, 1)
  const fileBytes = Buffer.from('%PDF-1.4\nSynthetic S1 upload\n%%EOF')
  process.env.JEV_S1_FILES_MANIFEST = join(temp, 'authorized-files.json')
  await writeFile(process.env.JEV_S1_FILES_MANIFEST, JSON.stringify({ resume: { name: 'synthetic.pdf', mimeType: 'application/pdf', data: fileBytes.toString('base64'), sha256: createHash('sha256').update(fileBytes).digest('hex') } }))
  fixtures = await createS1Fixtures(); browser = await connectBrowser()
  context = await chromium.launchPersistentContext(join(temp, 'profile'), { channel: 'chromium', executablePath: process.env.CHROMIUM_EXECUTABLE ?? '/home/shun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  await (context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker'))
  const origin = 'http://127.0.0.1:17430'
  for (const kind of ['article', 'settings', 'workspace']) {
    const { id, task } = await (await fetch(`${origin}/new/${kind}`)).json(), trace = []
    const result = await runS1(task, { call: browser.call, ask: replay, emit: event => trace.push(event) })
    await writeFile(join(temp, `${kind}.json`), JSON.stringify({ result, trace }, null, 2))
    assert.equal(result.status, 'verified', JSON.stringify({ result, trace: trace.slice(-3) }))
    // Independent backend oracle does not flow into task or action selection.
    const oracle = await (await fetch(`${origin}/oracle/${id}`)).json(); assert.equal(oracle.passed, true)
    console.log(JSON.stringify({ event: 's1_mechanical_pass', kind, ...result, oracle: oracle.passed, liveJev: false }))
  }
  const { task } = await (await fetch(`${origin}/new/settings`)).json()
  const { tabId } = await browser.call('tabs', { action: 'new', url: 'about:blank' }); await browser.call('navigate', { tabId, url: task.startUrl })
  const observe = () => browser.call('s1', { tabId, action: 'observe', assertions: task.assertions })
  let raw = await observe(), observation = adaptObservation(raw, tabId), t = validateS1Task(task), set = enumerate(observation, t)
  const selected = set.candidates.find(c => c.operationId === 'replace_text' && c.targetId === observation.objects.find(o => o.name === 'City').id)
  const stale = executionRequest(bindIntent(observation, set, selected, 'city'), observation, t)
  const page = context.pages().find(p => p.url() === task.startUrl)
  await page.reload(); await page.waitForLoadState()
  assert.notEqual((await observe()).documentId, raw.documentId)
  assert.equal((await browser.call('s1', { tabId, ...stale })).code, 'PAGE_CHANGED')
  raw = await observe()
  const readonly = raw.objects.find(o => o.facts.readonly)
  assert.equal((await browser.call('s1', { tabId, action: 'execute', operation: 'replace_text', documentId: raw.documentId, url: raw.url, allowedOrigins: t.allowedOrigins, ref: readonly.ref, expected: readonly.facts, text: 'bad' })).code, 'UNREACHABLE')
  await page.locator('#review').click(); raw = await observe()
  assert.ok(raw.objects.find(o => o.facts.name === 'City').facts.modalBlocked)
  assert.ok(!enumerate(adaptObservation(raw, tabId), t).candidates.some(c => c.operationId === 'replace_text'))
  const background = raw.objects.find(o => o.facts.name === 'Review changes')
  assert.equal((await browser.call('s1', { tabId, action: 'execute', operation: 'activate', documentId: raw.documentId, url: raw.url, allowedOrigins: t.allowedOrigins, ref: background.ref, expected: background.facts })).code, 'UNREACHABLE')
  await page.locator('#cancel').click()
  // Same-document changes after parameter selection fail preconditions.
  raw = await observe(); const city = raw.objects.find(o => o.facts.name === 'City')
  await page.locator('#city').fill('Changed asynchronously')
  assert.equal((await browser.call('s1', { tabId, action: 'execute', operation: 'replace_text', documentId: raw.documentId, url: raw.url, allowedOrigins: t.allowedOrigins, ref: city.ref, expected: city.facts, text: 'bad' })).code, 'STALE_REF')
  const cut = await browser.call('s1', { tabId, action: 'observe', assertions: [], limit: 1 }); assert.ok(cut.snapshot.coverage.truncated)
  assert.throws(() => enumerate(adaptObservation(cut, tabId), t), { code: 'RESOURCE_LIMIT' })
  // A root that itself crosses an unsupported boundary must not prove absence.
  await page.evaluate(() => {
    const host = document.createElement('div'); host.id = 'shadow-root'; host.attachShadow({ mode: 'closed' }).innerHTML = '<button>Hidden boundary action</button>'; document.body.append(host)
    const frame = document.createElement('iframe'); frame.id = 'frame-root'; frame.srcdoc = '<button>Frame action</button>'; document.body.append(frame)
    const overlay = document.createElement('div'); overlay.id = 'overlay'; overlay.style.cssText = 'position:fixed;inset:0;background:white;z-index:99999'; document.body.append(overlay)
  })
  const absent = root => ({ id: root, scope: { frame: 'top', root: { kind: 'selector', css: '#' + root } }, subject: { kind: 'selector', css: 'button' }, read: 'exists', predicate: 'absent', freshness: 'current' })
  const scoped = await browser.call('s1', { tabId, action: 'observe', assertions: ['shadow-root', 'frame-root'].map(absent) })
  assert.ok(scoped.assertions.every(a => a.complete === false && a.reason === 'unsupported_scope'))
  const overlaid = scoped.objects.find(o => o.facts.name === 'Review changes')
  assert.equal((await browser.call('s1', { tabId, action: 'execute', operation: 'activate', documentId: scoped.documentId, url: scoped.url, allowedOrigins: t.allowedOrigins, ref: overlaid.ref, expected: overlaid.facts })).code, 'UNREACHABLE')
  await page.evaluate(() => {
    document.querySelector('#overlay').remove()
    const long = document.createElement('p'); long.textContent = 'Long passage '.repeat(50); document.body.append(long)
    for (const name of ['Duplicate action', 'Duplicate action']) { const b = document.createElement('button'); b.textContent = name; document.body.append(b) }
  })
  const partial = await observe(); assert.equal(partial.view.truncated, true)
  const ambiguous = adaptObservation(partial, tabId)
  assert.ok(ambiguous.objects.filter(o => o.name === 'Duplicate action').every(o => o.ambiguous))
  // Mechanical test fixture only. No page evaluation exists in the S1 runner.
  await page.evaluate(() => {
    document.body.innerHTML = `<main><fieldset><legend>Row 1</legend><label>Amount<input type="number"></label></fieldset><fieldset><legend>Row 2</legend><label>Amount<input type="number"></label></fieldset><label>Date<input type="date"></label><label>Location<select><option value="">Choose</option><option value="ca">Canada</option></select></label><label>Consent<input type="checkbox"></label><label>Remote<input type="radio" name="mode"></label><label>PDF<input type="file"></label><div role="option" tabindex="0">Custom option</div><output id="events"></output></main>`
    for (const el of document.querySelectorAll('input, select')) el.addEventListener('change', () => document.querySelector('#events').textContent += el.type + ';')
  })
  const controls = validateS1Task({ goal: 'Mechanical control checks', startUrl: task.startUrl, allowedOrigins: [origin], values: {
    amount: { text: '42', purpose: 'Second row amount', target: { role: 'textbox', name: 'Amount', context: 'Row 2' } },
    date: { text: '2027-02-15', purpose: 'Date', target: { role: 'textbox', name: 'Date' } },
    location: { text: 'ca', purpose: 'Location', target: { role: 'combobox', name: 'Location' } },
    consent: { text: 'true', purpose: 'Consent', target: { role: 'checkbox', name: 'Consent' } },
    remote: { text: 'true', purpose: 'Remote work', target: { role: 'radio', name: 'Remote' } }
  }, files: { attachment: { fileId: 'resume', purpose: 'Authorized synthetic PDF', target: { role: 'file', name: 'PDF' } } } })
  const prepared = async (op, valueId) => {
    const o = adaptObservation(await observe(), tabId), set = enumerate(o, controls)
    const c = set.candidates.find(c => c.operationId === op && (valueId ? c.domain?.[valueId] : true))
    assert.ok(c, `Missing ${op}:${valueId}`)
    return executionRequest(bindIntent(o, set, c, valueId), o, controls)
  }
  for (const [op, valueId] of [['replace_text', 'amount'], ['replace_text', 'date'], ['select_option', 'location'], ['set_checked', 'consent'], ['set_checked', 'remote'], ['upload_file', 'attachment'], ['activate']]) {
    const request = await prepared(op, valueId)
    if (op === 'upload_file') {
      await assert.rejects(() => browser.call('s1', { tabId, ...request, fileId: 'not-authorized' }), { code: 'FILE_UNAUTHORIZED' })
    }
    assert.equal((await browser.call('s1', { tabId, ...request })).execution, 'returned')
  }
  assert.deepEqual(await page.locator('input[type=number]').evaluateAll(els => els.map(el => el.value)), ['', '42'])
  assert.equal(await page.locator('input[type=date]').inputValue(), '2027-02-15')
  assert.equal(await page.locator('select').inputValue(), 'ca')
  assert.ok(await page.locator('input[type=checkbox]').isChecked())
  assert.ok(await page.locator('input[type=radio]').isChecked())
  const uploaded = await page.locator('input[type=file]').evaluate(async el => Array.from(new Uint8Array(await el.files[0].arrayBuffer())))
  assert.equal(createHash('sha256').update(Buffer.from(uploaded)).digest('hex'), createHash('sha256').update(fileBytes).digest('hex'))
  const staleCheck = { ...(await observe()) }
  const checkbox = staleCheck.objects.find(o => o.facts.nativeCheck)
  await page.locator('input[type=checkbox]').uncheck()
  assert.equal((await browser.call('s1', { tabId, action: 'execute', operation: 'set_checked', documentId: staleCheck.documentId, url: staleCheck.url, allowedOrigins: [origin], ref: checkbox.ref, expected: checkbox.facts, checked: true })).code, 'STALE_REF')
  console.log(JSON.stringify({ event: 's1_form_controls_pass', cases: ['container_binding', 'number', 'date', 'native_select', 'checkbox', 'radio', 'custom_option', 'real_file_hash', 'unauthorized_file', 'stale_checked_state'], liveJev: false }))
  console.log(JSON.stringify({ event: 's1_browser_negative_pass', cases: ['same_url_document', 'readonly', 'modal_background', 'parameter_stale', 'coverage_cut', 'scope_root_boundary', 'overlay', 'text_cut', 'duplicate_names'], liveJev: false }))
} finally {
  await browser?.close(); await context?.close(); if (fixtures) await new Promise(r => fixtures.close(r))
  // Keep compact traces as evidence, remove the isolated browser profile/assets.
  await rm(join(temp, 'profile'), { recursive: true, force: true }); await rm(join(temp, 'extension'), { recursive: true, force: true }); console.log(JSON.stringify({ evidenceDirectory: temp }))
}
