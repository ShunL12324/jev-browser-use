// Isolated temp-profile Chromium + extension copy + stdio bridge on a random
// port, for browser_task development and tests. Never the user's browser.
import { mkdtemp, cp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const pass = ['PATH', 'HOME', 'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'TYPESAFE_DEFAULT_MODEL', 'JEV_S1_FILES_MANIFEST', 'JEV_SECRETS_MANIFEST', 'JEV_PRODUCT_LEDGER', 'JEV_TASK_TRACE_DIR', 'JEV_SOURCE_SHA']
export async function launchIsolated({ files, headless = true } = {}) {
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? '/tmp/jev-browser-validation/node_modules/playwright/index.mjs').href)
  const temp = await mkdtemp(join(tmpdir(), 'jev-task-browser-'))
  const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const port = String(reservation.address().port); await new Promise(r => reservation.close(r))
  const extension = join(temp, 'extension'); await cp(join(root, 'packages/extension/dist'), extension, { recursive: true })
  for (const name of await readdir(join(extension, 'assets'))) if (name.endsWith('.js')) {
    const path = join(extension, 'assets', name); await writeFile(path, (await readFile(path, 'utf8')).replace(/\b17329\b/g, port))
  }
  const env = { BROWSER_USE_PORT: port, JEV_ENABLE_S1: '1', JEV_ENABLE_COMPLEX_FORMS: '1' }
  for (const k of pass) if (process.env[k]) env[k] = process.env[k]
  // DEV_PROXY=http://host:port routes this bridge's outbound fetch and this
  // Chromium through a proxy (per process only); loopback test sites bypass it.
  const proxy = process.env.DEV_PROXY
  if (proxy) Object.assign(env, { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: '127.0.0.1,localhost' })
  if (files) { env.JEV_S1_FILES_MANIFEST = join(temp, 'files.json'); await writeFile(env.JEV_S1_FILES_MANIFEST, JSON.stringify(files)) }
  const client = new Client({ name: 'jev-task-dev', version: '0.1.0' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'packages/bridge/dist/index.js')], env, stderr: 'ignore' })
  await client.connect(transport)
  const context = await chromium.launchPersistentContext(join(temp, 'profile'), { channel: 'chromium', executablePath: process.env.CHROMIUM_EXECUTABLE ?? '/home/shun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', headless, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, ...(proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=127.0.0.1;localhost;<-loopback>'] : [])] })
  await (context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker'))
  const tool = async (name, args, timeout = 120000) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout })
    const text = result.content.find(c => c.type === 'text').text
    let data; try { data = JSON.parse(text) } catch { throw Object.assign(new Error(text), { code: 'MCP_ERROR' }) }
    if (result.isError || data.ok === false) throw Object.assign(new Error(data.message ?? data.error?.message ?? 'tool failed'), { code: data.code ?? data.error?.code, data })
    return data
  }
  // Waits for the extension to connect before the first real call.
  for (let i = 0; i < 100; i++) { try { await tool('browser_tabs', { action: 'list' }, 2000); break } catch { await new Promise(r => setTimeout(r, 100)) } }
  const call = (name, args) => { const { tabId, ...rest } = args; return name === 's1' ? tool('browser_agent_page', { tabId, request: rest }) : tool(`browser_${name}`, args) }
  return { tool, call, context, temp, close: async () => { await client.close(); await context.close(); await rm(temp, { recursive: true, force: true }) } }
}
// Drives one browser_task through the MCP tool, answering handoffs with a
// caller-supplied function (scripted/deny/stub modes). Returns result + log.
export async function runBrowserTask(tool, task, answer) {
  const handoffs = []
  let r = await tool('browser_task', { action: 'start', ...task, waitMs: 100000 }, 130000)
  for (;;) {
    if (r.status === 'running') { r = await tool('browser_task', { action: 'status', taskId: r.taskId, waitMs: 100000 }, 130000); continue }
    if (r.status !== 'needs_input') return { result: r, handoffs }
    const started = performance.now(), response = await answer(r.handoff)
    handoffs.push({ kind: r.handoff.kind, question: r.handoff.question, response, callerMs: performance.now() - started })
    r = await tool('browser_task', { action: 'continue', taskId: r.taskId, handoffId: r.handoff.handoffId, answer: response, waitMs: 100000 }, 130000)
  }
}
