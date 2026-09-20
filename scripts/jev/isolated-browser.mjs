// Browser lifecycle only. The tester's native MCP process owns WS port 17429.
import { mkdtemp, cp, readdir, readFile, writeFile, rm, mkdir, chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createServer, createConnection } from 'node:net'
import { once } from 'node:events'
import assert from 'node:assert/strict'

const control = process.env.JEV_BROWSER_CONTROL ?? '/tmp/jev-isolated-mcp-test/browser.sock'
if (process.argv.includes('--stop')) {
  const socket = createConnection(control)
  await once(socket, 'connect'); socket.end('stop')
  await once(socket, 'close')
  console.log('Isolated browser shutdown requested.')
} else {
  let context, temp, ownsControl = false, stopping = false
  const server = createServer(socket => {
    socket.once('data', data => { if (data.toString() === 'stop') { socket.end(); void cleanup() } else socket.destroy() })
  })
  async function cleanup() {
    if (stopping) return
    stopping = true
    try { await context?.close() } finally {
      if (ownsControl) { await new Promise(r => server.close(r)); await rm(control, { force: true }) }
      if (temp) await rm(temp, { recursive: true, force: true })
    }
  }
  try {
    await mkdir(resolve(control, '..'), { recursive: true, mode: 0o700 })
    server.listen(control); await once(server, 'listening'); ownsControl = true; await chmod(control, 0o600)
    temp = await mkdtemp(join(tmpdir(), 'jev-isolated-browser-'))
    const root = fileURLToPath(new URL('../../', import.meta.url)), extension = join(temp, 'extension')
    await cp(join(root, 'packages/extension/dist'), extension, { recursive: true })
    let replacements = 0
    for (const filename of await readdir(join(extension, 'assets'))) {
      if (!filename.endsWith('.js')) continue
      const path = join(extension, 'assets', filename), text = await readFile(path, 'utf8')
      replacements += (text.match(/\b17329\b/g) ?? []).length
      await writeFile(path, text.replace(/\b17329\b/g, '17429'))
    }
    assert.equal(replacements, 1, 'Expected exactly one compiled default WS port; abort rather than use 17329.')
    const modulePath = process.env.PLAYWRIGHT_MODULE ?? '/tmp/jev-browser-validation/node_modules/playwright/index.mjs'
    const { chromium } = await import(pathToFileURL(resolve(modulePath)).href)
    context = await chromium.launchPersistentContext(join(temp, 'profile'), {
      channel: 'chromium', executablePath: process.env.CHROMIUM_EXECUTABLE ?? '/home/shun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
      headless: true, viewport: { width: 1440, height: 1000 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    })
    if (stopping) { await context.close(); throw new Error('Stopped during browser startup.') }
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 })
    assert.ok(worker.url().startsWith('chrome-extension://'))
    console.log(JSON.stringify({ event: 'isolated_browser_ready', pid: process.pid, profile: join(temp, 'profile'), extension, bridgePort: 17429, control, note: 'No bridge started. Native MCP owns port 17429.' }))
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { void cleanup() })
    context.once('close', () => { void cleanup() })
  } catch (error) { await cleanup(); console.error(error.message); process.exitCode = 1 }
}
