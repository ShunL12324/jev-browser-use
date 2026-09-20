import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const hash = text => createHash('sha256').update(text).digest().readUInt32BE(0)
export function makeScenario({ scenario = 'A', density = 8, seed = 'round1' } = {}) {
  if (!['A', 'B'].includes(scenario) || ![8, 64, 120, 180].includes(Number(density)) || !/^[\w-]{1,60}$/.test(seed)) throw new Error('Invalid scenario, density or seed')
  density = Number(density)
  // Search is one enabled candidate; each catalog row has one Open button.
  const count = scenario === 'A' ? density - 1 : 7
  const targetIndex = hash(seed) % count
  const records = Array.from({ length: count }, (_, i) => ({
    id: `record-${hash(`${seed}:${i}`).toString(16)}`,
    title: i === targetIndex ? 'Harbor release guide' : ['Harbor release notes', 'Harbor review guide', 'Harbour release guide', 'Harbor release guide'][i % 4],
    category: i === targetIndex ? 'Operations' : ['Research', 'Operations', 'Support'][i % 3],
    version: i === targetIndex ? 'v3' : `v${i % 2 + 1}`,
    displayName: '', reviewerName: ''
  }))
  return { scenario, density, seed, records, targetId: records[targetIndex].id }
}
export function oracle(session) {
  const saved = session.saved
  return { runId: session.runId, scenario: session.scenario, seed: session.seed, targetId: session.targetId,
    openedId: session.openedId, saved,
    passed: session.scenario === 'A' ? session.openedId === session.targetId : !!saved && saved.recordId === session.targetId && saved.displayName === 'River' && saved.reviewerName === 'Riley' && session.closedAfterSave }
}
export function taskFor(session, origin) {
  return { phase: 'J0', scenario: session.scenario, seed: session.seed,
    startUrl: `${origin}/session/${session.runId}`,
    goal: session.scenario === 'A' ? 'Open the Harbor release guide in Operations, version v3.' : 'Find the Harbor release guide in Operations, version v3. Edit Display name to River and Reviewer name to Riley, review and confirm the changes, save them, then close the editor to verify the persistent result.',
    values: session.scenario === 'A' ? {} : { display_name: 'River', reviewer_name: 'Riley' },
    expectedText: session.scenario === 'A' ? 'Opened: Harbor release guide | Operations | v3' : 'Saved display name: River; reviewer name: Riley',
    maxSteps: session.scenario === 'A' ? 4 : 12, timeoutMs: 120000, maxInputTokens: 100000 }
}
export async function createLab({ port = 17430 } = {}) {
  const html = await readFile(new URL('../../examples/jev-lab/index.html', import.meta.url))
  const sessions = new Map()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
    try {
      const body = async () => {
        let text = ''
        for await (const chunk of req) { text += chunk; if (text.length > 16000) throw new Error('Request too large') }
        return JSON.parse(text || '{}')
      }
      if (req.method === 'POST' && url.pathname === '/reset') {
        const config = await body(), session = { ...makeScenario(config), runId: randomUUID(), openedId: null, saved: null, closedAfterSave: false }
        sessions.set(session.runId, session)
        return json(200, { runId: session.runId, task: taskFor(session, `http://127.0.0.1:${server.address().port}`) })
      }
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Jev isolated lab</h1><p>Create an experiment with POST /reset. The returned task URL opens its isolated session.</p>'); return }
      const match = url.pathname.match(/^\/(session|api|oracle)\/([\w-]+)(?:\/(open|save|close))?$/)
      const session = match && sessions.get(match[2])
      if (!session) return json(404, { error: 'Unknown session; POST /reset first.' })
      const [, kind, , action] = match
      if (req.method === 'GET' && kind === 'session' && !action) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); return }
      if (req.method === 'GET' && kind === 'oracle' && !action) return json(200, oracle(session))
      if (req.method === 'GET' && kind === 'api' && !action) return json(200, { runId: session.runId, scenario: session.scenario, density: session.density, seed: session.seed, records: session.records, saved: session.saved })
      if (req.method !== 'POST' || kind !== 'api' || !action) return json(405, { error: 'Unsupported method' })
      const data = await body()
      if (action === 'open') {
        if (!session.records.some(r => r.id === data.recordId)) return json(400, { error: 'Unknown record' })
        session.openedId = data.recordId
        return json(200, { ok: true })
      }
      if (action === 'save') {
        if (!session.records.some(r => r.id === data.recordId) || typeof data.displayName !== 'string' || typeof data.reviewerName !== 'string' || !data.displayName.trim() || !data.reviewerName.trim()) return json(400, { error: 'Both names are required.' })
        await new Promise(resolve => setTimeout(resolve, 300))
        session.saved = { recordId: data.recordId, displayName: data.displayName, reviewerName: data.reviewerName }
        const record = session.records.find(r => r.id === data.recordId)
        Object.assign(record, { displayName: data.displayName, reviewerName: data.reviewerName })
        session.closedAfterSave = false
        return json(200, { ok: true })
      }
      if (action === 'close') { session.closedAfterSave = !!session.saved; return json(200, { ok: true }) }
    } catch { json(400, { error: 'Invalid fixture request' }) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return server
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await createLab()
  console.log('Isolated fixture: http://127.0.0.1:17430 — POST /reset creates a fresh run.')
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => server.close())
}
