import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { run, validateTask } from './core.mjs'
import { connectBrowser } from './mcp.mjs'

let browser
try {
  const { values } = parseArgs({ options: { task: { type: 'string' }, 'dry-run': { type: 'boolean' }, check: { type: 'boolean' }, help: { type: 'boolean' } } })
  if (values.help || (!values.task && !values.check)) {
    console.log('Usage: npm run jev -- --task examples/jev/task.json [--dry-run]\n       npm run jev -- --check\n--check lists browser tabs without calling Jev. --dry-run opens a new task tab and asks Jev but does not execute its chosen action.')
  } else {
    const task = values.task ? validateTask(JSON.parse(await readFile(values.task, 'utf8'))) : undefined
    if (!values.check && !process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is missing. Open a new shell.')
    const controller = new AbortController()
    const stop = () => controller.abort(new Error('Stopped by user.'))
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    browser = await connectBrowser()
    if (values.check) {
      const tabs = await browser.call('tabs', { action: 'list' }, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]))
      console.log(JSON.stringify(tabs, null, 2))
    } else {
      const result = await run(task, { call: browser.call, signal: controller.signal, dryRun: values['dry-run'], emit: event => { if (event.event !== 'observation') console.log(JSON.stringify(event)) } })
      console.log(JSON.stringify({ event: 'finished', ...result }))
      if (!['done', 'dry_run'].includes(result.status)) process.exitCode = 2
    }
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
  }
} catch (error) {
  console.error(JSON.stringify({ event: 'error', code: error.code ?? error.name, message: error.message }))
  process.exitCode = 1
} finally { await browser?.close() }
