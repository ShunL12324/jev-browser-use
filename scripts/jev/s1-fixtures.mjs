// Fixture routes and private server oracle are test assets, never runner inputs.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
const directory = new URL('../../examples/s1/', import.meta.url)
const role = (role, name) => ({ kind: 'role_name', role, name, exact: true })
const selector = css => ({ kind: 'selector', css })
const assertion = (id, root, subject, read, predicate, expected, freshness = 'current') => ({ id, scope: { frame: 'top', root }, subject, read, predicate, ...(expected === undefined ? {} : { expected }), freshness })
export function fixtureTask(kind, origin, id) {
  const common = { startUrl: `${origin}/run/${id}/${kind}`, allowedOrigins: [origin], maxRequests: 12 }
  if (kind === 'article') return { ...common, goal: 'Open the Deployment guide and read its release instructions.', assertions: [assertion('title', role('main', 'Article'), role('heading', 'Deployment guide'), 'text', 'equals', 'Deployment guide'), assertion('body', role('main', 'Article'), selector('p'), 'text', 'contains', 'promote the verified artifact')] }
  if (kind === 'settings') return { ...common, goal: 'Change City to Hangzhou and Display name to River. Review and confirm saving both changes.', values: { city: { text: 'Hangzhou', purpose: 'New city', target: { role: 'textbox', name: 'City' } }, alias: { text: 'River', purpose: 'New display name', target: { role: 'textbox', name: 'Display name' } } }, assertions: [assertion('city', role('region', 'Saved account'), selector('[name=city]'), 'value', 'equals', 'Hangzhou', 'after_last_returned_operation'), assertion('alias', role('region', 'Saved account'), selector('[name=alias]'), 'value', 'equals', 'River', 'after_last_returned_operation'), assertion('closed', role('main', 'Settings'), role('dialog', 'Confirm changes'), 'exists', 'absent', undefined, 'after_last_returned_operation')] }
  if (kind === 'workspace') return { ...common, goal: 'Open project Polaris and inspect its Ready status in Project details.', assertions: [assertion('project', role('region', 'Project details'), role('heading', 'Project Polaris'), 'text', 'equals', 'Project Polaris', 'after_last_returned_operation'), assertion('status', role('region', 'Project details'), selector('.status'), 'text', 'equals', 'Status: Ready', 'after_last_returned_operation')] }
  throw Error('Unknown fixture kind')
}
export async function createS1Fixtures({ port = 17430 } = {}) {
  const sessions = new Map()
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean)
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
    try {
      if (path[0] === 'new') {
        const id = randomUUID(), kind = path[1], origin = `http://127.0.0.1:${server.address().port}`
        const task = fixtureTask(kind, origin, id); sessions.set(id, { kind, saved: null, opened: null, article: false })
        return json({ id, task })
      }
      const session = sessions.get(path[1])
      if (!session) { res.writeHead(404); return res.end() }
      if (path[0] === 'oracle') return json({ passed: session.kind === 'article' ? session.article : session.kind === 'settings' ? session.saved?.city === 'Hangzhou' && session.saved?.alias === 'River' : session.opened === 'Polaris', ...session })
      if (path[0] !== 'run') { res.writeHead(404); return res.end() }
      const name = path[2]
      if (req.method === 'POST') {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 10000) throw Error('Body too large') }
        if (name === 'save') { await new Promise(r => setTimeout(r, 80)); session.saved = JSON.parse(body) }
        if (name === 'opened') session.opened = body
        return json({ ok: true })
      }
      if (name === 'article-result') session.article = true
      const filename = ['article', 'article-result', 'settings', 'workspace'].includes(name) ? name : 'article'
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(await readFile(new URL(`${filename}.html`, directory)))
    } catch { res.writeHead(400); res.end('Invalid fixture request') }
  })
  server.listen(port, '127.0.0.1'); await once(server, 'listening'); return server
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { const server = await createS1Fixtures(); console.log(`S1 fixtures listening at http://127.0.0.1:${server.address().port}`) }
