// jev-ultrafast adapter (comparison runner). UNVERIFIED and paid: requires a
// working `uv` environment in JEV_ULTRAFAST_ROOT with browser-harness attached
// to a remote-debugging Chrome, TYPESAFE_API_KEY and, for TYPE_TEXT,
// TEXT_MODEL_API_KEY. It drives its own Chrome, so page-state oracles cannot
// read its page; only http/answer oracles and URL checks apply. It has no
// answer output, handoffs, uploads or secrets (see docs/eval.zh-CN.md).
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function createRunner() {
  const root = process.env.JEV_ULTRAFAST_ROOT ?? '/tmp/jev-ultrafast'
  const script = fileURLToPath(new URL('./jev_ultrafast_run.py', import.meta.url))
  return {
    name: 'jev-ultrafast',
    evidence: 'agent',
    async run(view) {
      if (Object.keys(view.inputs ?? {}).length || Object.keys(view.files ?? {}).length) return { status: 'unsupported', error: 'jev-ultrafast has no inputs/files/secrets channel', handoffs: [], metrics: {} }
      const out = await new Promise((resolve, reject) => {
        const child = spawn('uv', ['run', '--project', root, '--env-file', `${root}/.env`, 'python', script, '--url', view.startUrl, '--goal', view.goal], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], timeout: view.budgets.timeoutMs })
        let text = ''; child.stdout.on('data', d => { text += d })
        child.on('close', code => code === 0 ? resolve(text) : reject(new Error(`jev-ultrafast exited ${code}`)))
      })
      const r = JSON.parse(out.trim().split('\n').at(-1))
      return { status: r.status, finalUrl: r.finalUrl, handoffs: [], metrics: { agentMs: r.agentMs, jevRequests: r.jevRequests, jevInputTokens: r.jevInputTokens, jevUnknownUsage: r.jevUnknownUsage, llmRequests: r.llmRequests } }
    }
  }
}
