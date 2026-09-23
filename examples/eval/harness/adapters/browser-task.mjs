// Product runner: our bridge (stdio MCP) + extension in an isolated temp
// Chromium, driven through the browser_task tool of docs/product/
// architecture.zh-CN.md §1.1 (start/continue/status). Harness-side handoff
// answers come from ctx.handoff (scripted/deny); open-ended kinds are declined,
// so these runs measure the "autonomous" column. Paid when the product calls
// Jev; the product ledger applies.
// Used for the T54 acceptance runs against the P1a browser_task.
import { cp, readdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { CHROMIUM, readPageState, proxyArgs } from '../browser.mjs'

// A declined open-ended handoff cancels the task; the cancel response carries
// the terminal metrics and trace, which must survive into the result.
export const declinedResult = (cancelled, pending, kind) => ({ ...pending, ...cancelled, status: 'blocked', declinedHandoff: kind })
const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })

export function createRunner({ bridge } = {}) {
  const root = bridge ?? process.env.BRIDGE_ROOT
  if (!root) throw new Error('Set --bridge or BRIDGE_ROOT to a built checkout (packages/bridge/dist, packages/extension/dist)')
  return {
    name: 'browser-task',
    evidence: 'agent',
    async run(view, ctx) {
      const { Client } = await import(`${root}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`)
      const { StdioClientTransport } = await import(`${root}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`)
      const temp = await mkdtemp(join(tmpdir(), 'eval-browser-task-')), port = String(await freePort()), handoffs = []
      let client, context
      try {
        // Extension copy with its bridge port rewritten to this run's port.
        const extension = join(temp, 'extension'); await cp(`${root}/packages/extension/dist`, extension, { recursive: true })
        for (const name of await readdir(join(extension, 'assets'))) if (name.endsWith('.js')) { const p = join(extension, 'assets', name); await writeFile(p, (await readFile(p, 'utf8')).replace(/\b17329\b/g, port)) }
        // Host-side manifests: secrets (origin-bound) and authorized files. Values never enter the task JSON.
        const secretsPath = join(temp, 'secrets.json'), filesPath = join(temp, 'files.json')
        await writeFile(secretsPath, JSON.stringify(Object.fromEntries(Object.entries(ctx.secrets).map(([ref, s]) => [ref, { value: s.value, origins: s.origins }]))), { mode: 0o600 })
        const files = {}
        for (const f of Object.values(ctx.files)) { const bytes = await readFile(f.hostPath); files[f.fileId] = { name: f.hostPath.split('/').at(-1), mimeType: 'application/pdf', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') } }
        await writeFile(filesPath, JSON.stringify(files), { mode: 0o600 })
        const env = { ...process.env, BROWSER_USE_PORT: port, JEV_SECRETS_MANIFEST: secretsPath, JEV_S1_FILES_MANIFEST: filesPath }
        client = new Client({ name: 'eval-harness', version: '1' })
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}/packages/bridge/dist/index.js`], env, stderr: 'inherit' }))
        context = await chromium.launchPersistentContext(join(temp, 'profile'), { executablePath: CHROMIUM, headless: true, viewport: { width: 1280, height: 900 }, args: [...proxyArgs(), `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
        await (context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker', { timeout: 15000 }))
        const call = async args => { const r = await client.callTool({ name: 'browser_task', arguments: args }, undefined, { timeout: view.budgets.timeoutMs + 60000 }); return JSON.parse(r.content.find(c => c.type === 'text').text) }
        let result = await call({ action: 'start', goal: view.goal, startUrl: view.startUrl, allowedOrigins: view.allowedOrigins, inputs: view.inputs, files: view.files, irreversible: view.irreversible, llm: 'handoff', budgets: { timeoutMs: view.budgets.timeoutMs, maxSteps: view.budgets.maxSteps } })
        while (result.status === 'running' || result.status === 'needs_input') {
          if (result.status === 'running') { await new Promise(r => setTimeout(r, 500)); result = await call({ action: 'status', taskId: result.taskId }); continue }
          const h = result.handoff, at = Date.now(), answer = await ctx.handoff(h)
          handoffs.push({ kind: h.kind, at, approve: answer.approve === true, declined: !!answer.declined, waitMs: Date.now() - at })
          if (answer.declined) { result = declinedResult(await call({ action: 'cancel', taskId: result.taskId }), result, h.kind); break }
          result = await call({ action: 'continue', taskId: result.taskId, handoffId: h.handoffId, answer })
        }
        const page = context.pages().find(p => p.url() === result.finalUrl) ?? context.pages().at(-1)
        const pageState = ctx.readPage && page ? await ctx.readPage(page) : page ? await readPageState(page).catch(() => null) : null
        return { status: result.status, answer: result.answer, finalUrl: result.finalUrl, handoffs, metrics: result.metrics ?? {}, tracePath: result.tracePath, pageState, declinedHandoff: result.declinedHandoff }
      } finally { await client?.close().catch(() => {}); await context?.close().catch(() => {}); await rm(temp, { recursive: true, force: true }) }
    }
  }
}
