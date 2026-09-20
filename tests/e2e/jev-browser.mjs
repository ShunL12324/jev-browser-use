// Optional real extension test. Playwright is a test harness, not the browser driver
// used by the runner: all actions still traverse stdio MCP -> WS -> extension.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { once } from 'node:events'
import { run, askJev } from '../../scripts/jev/core.mjs'
import { connectBrowser } from '../../scripts/jev/mcp.mjs'

const live = process.argv.includes('--live')
if (live && !process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is required for --live.')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright')
const root = fileURLToPath(new URL('../../', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'jev-extension-'))
let context, browser, server
const oldPort = process.env.BROWSER_USE_PORT
try {
  const reservation = createNetServer().listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const port = reservation.address().port; await new Promise(r => reservation.close(r))
  process.env.BROWSER_USE_PORT = String(port)
  // Isolate the test from a user's extension/bridge, even during SW startup.
  const extension = join(temp, 'extension')
  await cp(join(root, 'packages/extension/dist'), extension, { recursive: true })
  let replacements = 0
  for (const f of await readdir(join(extension, 'assets'))) {
    if (!f.endsWith('.js')) continue
    const path = join(extension, 'assets', f), text = await readFile(path, 'utf8')
    const matches = text.match(/\b17329\b/g) ?? []
    if (matches.length) { replacements += matches.length; await writeFile(path, text.replace(/\b17329\b/g, String(port))) }
  }
  assert.equal(replacements, 1, 'Expected exactly one compiled default bridge port.')
  const html = await readFile(join(root, 'examples/jev/index.html'))
  server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html) }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/`
  browser = await connectBrowser()
  context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    channel: 'chromium', executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 10000 })
  assert.ok(worker.url().startsWith('chrome-extension://'))
  const task = JSON.parse(await readFile(join(root, 'examples/jev/task.json'), 'utf8'))
  task.startUrl = url
  const options = { call: browser.call, emit: e => console.log(JSON.stringify(e)) }
  if (process.argv.includes('--debug')) options.ask = async (payload, requestOptions) => { console.log(JSON.stringify({ debugState: payload.state })); const result = await askJev(payload, requestOptions); console.log(JSON.stringify({ debugAnswers: result.answers })); return result }
  if (!live) options.ask = async ({ state, questions }) => {
    const saved = state.page.content.includes(task.expectedText)
    const field = state.page.elements.find(e => e.role === 'textbox')
    const button = state.page.elements.find(e => e.role === 'button' && e.name === 'Save display name')
    assert.ok(field && button, 'Real DOM snapshot must contain labeled field and button.')
    const picks = { action: field.value === 'River' ? 'click' : 'type', click_target: button.ref, type_target: field.ref, type_value: 'display_name' }
    return { model: 'deterministic-test-fixture', usage: { input_tokens: 0 }, answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, q.type === 'noul' ? { type: 'noul', noul: id === 'goal_met' && saved ? 0.99 : 0.01 } : { type: 'choice', choice: picks[id], confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === picks[id] ? 1 : 0])) }])) }
  }
  const result = await run(task, options)
  assert.equal(result.status, 'done', JSON.stringify(result))
  const page = context.pages().find(p => p.url() === url)
  assert.ok(page, 'Task page exists in real browser.')
  assert.equal(await page.locator('#status').textContent(), task.expectedText)
  assert.equal(await page.locator('#name').inputValue(), 'River')
  console.log(JSON.stringify({ event: 'e2e_pass', liveJev: live, chromium: context.browser()?.version(), ...result }))
} finally {
  await browser?.close()
  await context?.close()
  if (server) await new Promise(r => server.close(r))
  await rm(temp, { recursive: true, force: true })
  if (oldPort === undefined) delete process.env.BROWSER_USE_PORT; else process.env.BROWSER_USE_PORT = oldPort
}
