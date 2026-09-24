// Runs one browser_task (runner view JSON) in an isolated temp Chromium via
// the real MCP tool. Handoffs are answered by a scripted policy: confirm per
// --approve, text from the optional "texts" map (field label → text), all
// other open-ended handoffs declined. Real Jev calls use the product ledger.
//   node scripts/jev/task-run.mjs task.json [--approve] [--headful]
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { launchIsolated, runBrowserTask } from './task-browser.mjs'

const [path] = process.argv.slice(2).filter(a => !a.startsWith('--'))
const { texts = {}, ...task } = JSON.parse(await readFile(path, 'utf8'))
const approve = process.argv.includes('--approve')
const browser = await launchIsolated({ headless: !process.argv.includes('--headful') })
try {
  const started = performance.now()
  const run = await runBrowserTask(browser.tool, task, async h => h.kind === 'confirm' ? { approve } : h.kind === 'text' && texts[h.field?.label] ? { text: texts[h.field.label] } : {})
  const summary = { task: path, status: run.result.status, reason: run.result.reason ?? run.result.code, finalUrl: run.result.finalUrl, sessionId: run.result.sessionId,
    ...(run.result.items ? { items: run.result.items, skipped: run.result.skipped, visited: run.result.visited } : {}),
    e2eMs: performance.now() - started, metrics: run.result.metrics, handoffs: run.handoffs, tracePath: run.result.tracePath }
  await mkdir('/tmp/jev-product/runs', { recursive: true }); await writeFile(`/tmp/jev-product/runs/task-${Date.now()}.json`, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary))
} finally { await browser.close() }
