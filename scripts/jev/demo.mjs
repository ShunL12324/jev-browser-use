import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
const html = await readFile(new URL('../../examples/jev/index.html', import.meta.url))
const server = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/') { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html)
})
server.on('error', e => { console.error(e.message); process.exitCode = 1 })
server.listen(17330, '127.0.0.1', () => console.log('Playground: http://localhost:17330/ — keep this terminal open.'))
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => server.close())
